import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MemoryFields,
  MemoryJob,
  MemoryMessageSource,
  MemoryProductRef,
  MemorySource,
  MemorySummary,
  MerchantMemory,
  UpdateMemoryInput,
} from "../../../../shared/contracts.js";
import {
  MEMORY_ENTRY_LIMIT,
  MEMORY_SOURCE_MESSAGE_LIMIT,
  MEMORY_SOURCE_TEXT_LIMIT,
  MEMORY_SUMMARY_TEMPLATE_VERSION,
} from "../../../../shared/contracts.js";
import type { StoredMemoryJob } from "../../../infrastructure/sqlite/db-client.js";

type Row = Record<string, unknown>;
type Transact = <T>(operation: () => T) => T;

/** 为记忆正文和冻结来源计算一致的完整性摘要。 */
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 规范化人工记忆，允许停用过期记录但拒绝重新确认过期内容。 */
function fields(input: MemoryFields, now: string, inactive = false): MemoryFields {
  const title = input.title.trim();
  const content = input.content.trim();
  const expiry = input.expiresAt === null ? null : Date.parse(input.expiresAt);
  if (
    !title ||
    title.length > 120 ||
    !content ||
    content.length > 2000 ||
    !["PREFERENCE", "RULE", "FACT", "DECISION", "PROGRESS"].includes(input.kind) ||
    (expiry !== null &&
      (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.expiresAt ?? "") || !Number.isFinite(expiry)))
  )
    throw new Error("MEMORY_INPUT_INVALID");
  if (!inactive && expiry !== null && expiry <= Date.parse(now)) throw new Error("MEMORY_EXPIRED");
  return {
    title,
    content,
    kind: input.kind,
    expiresAt: expiry === null ? null : new Date(expiry).toISOString(),
    ...(input.subject && { subject: input.subject }),
    productBasis: input.productBasis ?? null,
  };
}

/** 在 SQLite Worker 内提供记忆版本、归档任务及提交事务。 */
export function createMemoryOperations(db: DatabaseSync, transact: Transact) {
  /** 发布时要求明确对象及当前商品依据；候选保留历史来源，但不能伪造商品归属。 */
  function validateSubject(merchantId: string, input: MemoryFields, publishing: boolean): void {
    const subject = input.subject;
    if (!subject) {
      if (publishing) throw new Error("MEMORY_SUBJECT_REQUIRED");
      return;
    }
    if (subject.kind === "MERCHANT") {
      if (input.productBasis) throw new Error("MEMORY_SUBJECT_INVALID");
      return;
    }
    if (subject.kind !== "PRODUCT" || !subject.productEntryId) throw new Error("MEMORY_SUBJECT_INVALID");
    const product = db
      .prepare(`SELECT e.status,e.revision,v.sha256 FROM merchant_catalog_entry e
      JOIN merchant_catalog_revision v ON v.entry_id=e.entry_id AND v.revision=e.revision
      WHERE e.merchant_id=? AND e.entry_id=? AND e.kind='PRODUCT'`)
      .get(merchantId, subject.productEntryId);
    if (!product || (publishing && product.status !== "ACTIVE")) throw new Error("PRODUCT_SOURCE_INVALID");
    const basis = input.productBasis;
    if (!basis) return;
    const version = db
      .prepare("SELECT sha256 FROM merchant_catalog_revision WHERE entry_id=? AND revision=?")
      .get(subject.productEntryId, basis.revision);
    if (basis.entryId !== subject.productEntryId || version?.sha256 !== basis.sha256)
      throw new Error("MEMORY_SUBJECT_INVALID");
    if (publishing && (product.revision !== basis.revision || product.sha256 !== basis.sha256))
      throw new Error("PRODUCT_SOURCE_CHANGED");
  }
  /** 验证活动商家存在，写入不能凭模型提供的 ID 创建归属。 */
  function requireMerchant(merchantId: string): void {
    if (!db.prepare("SELECT 1 FROM merchant WHERE merchant_id = ? AND status = 'ACTIVE'").get(merchantId))
      throw new Error("MERCHANT_NOT_FOUND");
  }

  /** 还原并校验不可变记忆版本和数据库归属。 */
  function record(row: Row): MerchantMemory {
    const body = JSON.parse(String(row.body_json)) as Omit<MerchantMemory, "sha256">;
    if (
      hash(body) !== row.sha256 ||
      body.memoryId !== row.memory_id ||
      body.merchantId !== row.merchant_id ||
      body.revision !== Number(row.revision)
    )
      throw new Error("MERCHANT_CONTEXT_INVALID");
    return { ...body, sha256: String(row.sha256) };
  }

  /** 读取明确商家和明确版本的记忆，供冻结快照恢复。 */
  function readMemoryVersion(merchantId: string, memoryId: string, revision: number): MerchantMemory {
    const row = db
      .prepare(`SELECT m.merchant_id, r.* FROM merchant_memory m JOIN merchant_memory_revision r
      ON r.memory_id = m.memory_id WHERE m.merchant_id = ? AND m.memory_id = ? AND r.revision = ?`)
      .get(merchantId, memoryId, revision) as Row | undefined;
    if (!row) throw new Error("MEMORY_NOT_FOUND");
    return record(row);
  }

  /** 列出商家当前版本，包含待确认和停用条目。 */
  function listMemories(merchantId: string): MerchantMemory[] {
    requireMerchant(merchantId);
    return (
      db
        .prepare(`SELECT m.merchant_id, r.* FROM merchant_memory m JOIN merchant_memory_revision r
      ON r.memory_id = m.memory_id AND r.revision = m.revision WHERE m.merchant_id = ? ORDER BY m.rowid DESC`)
        .all(merchantId) as Row[]
    ).map(record);
  }

  /** 在调用方事务中追加正文，历史版本不覆盖。 */
  function append(body: Omit<MerchantMemory, "sha256">): MerchantMemory {
    const digest = hash(body);
    db.prepare("INSERT INTO merchant_memory_revision VALUES (?, ?, ?, ?)").run(
      body.memoryId,
      body.revision,
      JSON.stringify(body),
      digest,
    );
    db.prepare("UPDATE merchant_memory SET revision = ? WHERE memory_id = ?").run(body.revision, body.memoryId);
    return { ...body, sha256: digest };
  }

  /** 创建有稳定来源键的条目，重入不重新激活已停用版本。 */
  function insert(
    merchantId: string,
    input: MemoryFields,
    tier: MerchantMemory["tier"],
    status: MerchantMemory["status"],
    source: MemorySource,
    originKey: string,
    now: string,
  ): MerchantMemory {
    requireMerchant(merchantId);
    const previous = db
      .prepare("SELECT memory_id, revision FROM merchant_memory WHERE origin_key = ? AND merchant_id = ?")
      .get(originKey, merchantId) as Row | undefined;
    if (previous) return readMemoryVersion(merchantId, String(previous.memory_id), Number(previous.revision));
    validateSubject(merchantId, input, status === "ACTIVE");
    if (
      listMemories(merchantId).filter((item) => item.status !== "INACTIVE" && (!item.expiresAt || item.expiresAt > now))
        .length >= MEMORY_ENTRY_LIMIT
    )
      throw new Error("MEMORY_LIMIT");
    const memoryId = `mem_${randomUUID()}`;
    db.prepare("INSERT INTO merchant_memory VALUES (?, ?, 1, ?)").run(memoryId, merchantId, originKey);
    return append({
      ...fields(input, now),
      memoryId,
      merchantId,
      tier,
      status,
      revision: 1,
      ...(status === "ACTIVE" && { review: { reviewer: "local-user" as const, reviewedAt: now } }),
      source,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** 复用已有命令幂等表，返回原结果并拒绝同键异参。 */
  function command<T>(key: string, kind: string, input: unknown, now: string, operation: () => T): T {
    const digest = hash(input);
    const previous = db.prepare("SELECT * FROM api_operation WHERE operation_key = ?").get(key) as Row | undefined;
    if (previous) {
      if (previous.kind !== kind || previous.request_hash !== digest) throw new Error("IDEMPOTENCY_CONFLICT");
      return JSON.parse(String(previous.result_json)) as T;
    }
    const result = operation();
    db.prepare(
      "INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(key, kind, JSON.stringify(result), digest, now);
    return result;
  }

  /** 校验总结来源哈希并生成不含私有模型配置的页面记录。 */
  function jobRecord(row: Row): StoredMemoryJob {
    const sources = JSON.parse(String(row.source_json)) as MemoryMessageSource[];
    if (hash(sources) !== row.source_hash) throw new Error("MEMORY_SOURCE_INVALID");
    return {
      jobId: String(row.job_id),
      templateVersion: String(row.template_version),
      sessionId: String(row.session_id),
      merchantId: String(row.merchant_id),
      status: row.status as MemoryJob["status"],
      attempt: Number(row.attempt),
      sourceHash: String(row.source_hash),
      sourceCount: sources.length,
      omittedCount: Number(row.omitted_count),
      truncatedCount: sources.filter((item) => item.truncated).length,
      errorCode: row.error_code ? String(row.error_code) : null,
      result: row.result_json ? (JSON.parse(String(row.result_json)) as MemorySummary) : null,
      sources,
      model: row.model_json ? (JSON.parse(String(row.model_json)) as StoredMemoryJob["model"]) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** 页面只接收任务状态和真实结果，模型地址与原文留在 Host。 */
  function publicJob(row: Row): MemoryJob {
    const { sources: _sources, model: _model, ...job } = jobRecord(row);
    return job;
  }

  /** 读取一个总结任务，后续写入须再次验证尝试号。 */
  function requiredJob(jobId: string): Row {
    const row = db.prepare("SELECT * FROM memory_job WHERE job_id = ?").get(jobId) as Row | undefined;
    if (!row) throw new Error("MEMORY_JOB_NOT_FOUND");
    return row;
  }

  return {
    listMemories,
    readMemoryVersion,
    /** 人工维护页保存即确认；同一命令重复提交复用原条目。 */
    createMemory: (merchantId: string, input: MemoryFields, key: string, now: string) =>
      transact(() =>
        command(key, "createMemory", { merchantId, input }, now, () =>
          insert(
            merchantId,
            input,
            "LONG",
            "ACTIVE",
            { kind: "HUMAN", sessionId: null, messageId: null, jobId: null, quote: input.content },
            key,
            now,
          ),
        ),
      ),
    /** 聊天保存意愿只生成待审核候选，不能绕过作用对象确认直接跨会话生效。 */
    rememberUser: (merchantId: string, sessionId: string, messageId: string, content: string, now: string) => {
      const match = /^记住[：:]\s*([\s\S]+)$/.exec(content.trim());
      if (!match) return;
      const value = (match[1] ?? "").trim();
      insert(
        merchantId,
        { title: value.slice(0, 60), content: value, kind: "RULE", expiresAt: null },
        "LONG",
        "CANDIDATE",
        { kind: "USER_MESSAGE", sessionId, messageId, jobId: null, quote: content },
        `message:${messageId}`,
        now,
      );
    },
    /** 版本 CAS 防止覆盖其他页面修改；来源永久保留。 */
    updateMemory: (merchantId: string, memoryId: string, input: UpdateMemoryInput, key: string, now: string) =>
      transact(() =>
        command(key, "updateMemory", { merchantId, memoryId, input }, now, () => {
          const row = db
            .prepare("SELECT revision FROM merchant_memory WHERE memory_id = ? AND merchant_id = ?")
            .get(memoryId, merchantId) as Row | undefined;
          if (!row) throw new Error("MEMORY_NOT_FOUND");
          if (Number(row.revision) !== input.expectedRevision) throw new Error("MEMORY_REVISION_CONFLICT");
          const previous = readMemoryVersion(merchantId, memoryId, input.expectedRevision);
          if (input.status === "ACTIVE") validateSubject(merchantId, input, true);
          const { sha256: _digest, ...body } = previous;
          if (
            input.status === "ACTIVE" &&
            (previous.status === "INACTIVE" || Boolean(previous.expiresAt && previous.expiresAt <= now)) &&
            listMemories(merchantId).filter(
              (item) => item.status !== "INACTIVE" && (!item.expiresAt || item.expiresAt > now),
            ).length >= MEMORY_ENTRY_LIMIT
          )
            throw new Error("MEMORY_LIMIT");
          return append({
            ...body,
            ...fields(input, now, input.status === "INACTIVE"),
            ...(input.status === "INACTIVE" &&
              !input.subject && { subject: previous.subject, productBasis: previous.productBasis }),
            status: input.status,
            review: input.status === "ACTIVE" ? { reviewer: "local-user", reviewedAt: now } : undefined,
            revision: previous.revision + 1,
            updatedAt: now,
          });
        }),
      ),
    /** 历史读取要求商家和条目同时匹配。 */
    memoryHistory: (merchantId: string, memoryId: string) => {
      const rows = db
        .prepare(`SELECT m.merchant_id, r.* FROM merchant_memory m JOIN merchant_memory_revision r ON r.memory_id = m.memory_id
        WHERE m.merchant_id = ? AND m.memory_id = ? ORDER BY r.revision DESC`)
        .all(merchantId, memoryId) as Row[];
      if (!rows.length) throw new Error("MEMORY_NOT_FOUND");
      return rows.map(record);
    },
    /** 原子归档并冻结有界会话文字，模型未配置时保存明确失败状态。 */
    archiveForMemory: (sessionId: string, model: StoredMemoryJob["model"], key: string, now: string) =>
      transact(() =>
        command(key, "archiveForMemory", { sessionId }, now, () => {
          const session = db.prepare("SELECT * FROM session WHERE session_id = ?").get(sessionId) as Row | undefined;
          if (!session) throw new Error("SESSION_NOT_FOUND");
          if (session.scope !== "MERCHANT") throw new Error("MEMORY_MERCHANT_REQUIRED");
          if (
            db
              .prepare(
                "SELECT 1 FROM agent_run WHERE session_id = ? AND status IN ('QUEUED','RUNNING','RECOVERING','WAITING_CONFIRMATION')",
              )
              .get(sessionId)
          )
            throw new Error("SESSION_RUN_ACTIVE");
          const existing = db
            .prepare("SELECT * FROM memory_job WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
            .get(sessionId) as Row | undefined;
          if (existing && session.lifecycle_status === "ARCHIVED") return publicJob(existing);
          const total = db
            .prepare(
              "SELECT COUNT(*) AS count FROM message m JOIN agent_run r ON r.run_id = m.run_id WHERE m.session_id = ? AND (m.role = 'user' OR r.status = 'SUCCEEDED')",
            )
            .get(sessionId) as Row;
          const rows = db
            .prepare(`SELECT m.* FROM message m JOIN agent_run r ON r.run_id = m.run_id
        WHERE m.session_id = ? AND (m.role = 'user' OR r.status = 'SUCCEEDED') ORDER BY m.rowid DESC LIMIT ?`)
            .all(sessionId, MEMORY_SOURCE_MESSAGE_LIMIT) as Row[];
          const sources: MemoryMessageSource[] = [];
          let remaining = MEMORY_SOURCE_TEXT_LIMIT;
          for (const row of rows) {
            if (remaining <= 0) break;
            const full = String((JSON.parse(String(row.content_json)) as { text?: string }).text ?? "");
            if (!full.trim() || !["user", "assistant"].includes(String(row.role))) continue;
            const text = full.slice(0, Math.min(3000, remaining));
            const scopeRow = db
              .prepare(`SELECT s.memory_scope_json FROM agent_run r JOIN merchant_context_snapshot s
              ON s.snapshot_id=json_extract(r.runtime_plan_json,'$.merchant.snapshotId') WHERE r.run_id=? AND s.merchant_id=?`)
              .get(String(row.run_id), String(session.owner_id));
            const sourceProduct = scopeRow?.memory_scope_json
              ? (JSON.parse(String(scopeRow.memory_scope_json)) as { product?: MemoryProductRef | null }).product
              : null;
            sources.push({
              messageId: String(row.message_id),
              role: row.role as "user" | "assistant",
              text,
              sha256: hash(full),
              truncated: text !== full,
              ...(sourceProduct && { product: sourceProduct }),
            });
            remaining -= text.length;
          }
          sources.reverse();
          db.prepare("UPDATE session SET lifecycle_status = 'ARCHIVED', updated_at = ? WHERE session_id = ?").run(
            now,
            sessionId,
          );
          const duplicate = db
            .prepare("SELECT * FROM memory_job WHERE session_id = ? AND source_hash = ? AND template_version = ?")
            .get(sessionId, hash(sources), MEMORY_SUMMARY_TEMPLATE_VERSION) as Row | undefined;
          if (duplicate) return publicJob(duplicate);
          const jobId = `mmj_${randomUUID()}`;
          const code = !sources.length ? "MEMORY_NO_MESSAGES" : !model ? "MODEL_NOT_CONFIGURED" : null;
          db.prepare(`INSERT INTO memory_job (job_id, session_id, merchant_id, status, source_json, source_hash, omitted_count, model_json, error_code, created_at, updated_at, template_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            jobId,
            sessionId,
            String(session.owner_id),
            code ? "FAILED" : "QUEUED",
            JSON.stringify(sources),
            hash(sources),
            Number(total.count) - sources.length,
            model ? JSON.stringify(model) : null,
            code,
            now,
            now,
            MEMORY_SUMMARY_TEMPLATE_VERSION,
          );
          return publicJob(requiredJob(jobId));
        }),
      ),
    /** 页面列出持久任务状态和覆盖范围。 */
    listMemoryJobs: (merchantId: string) =>
      (
        db
          .prepare("SELECT * FROM memory_job WHERE merchant_id = ? ORDER BY rowid DESC LIMIT 100")
          .all(merchantId) as Row[]
      ).map(publicJob),
    /** 用户重试使用原冻结来源，并明确记录新的模型配置。 */
    retryMemoryJob: (merchantId: string, jobId: string, model: StoredMemoryJob["model"], key: string, now: string) =>
      transact(() =>
        command(key, "retryMemoryJob", { merchantId, jobId }, now, () => {
          const row = requiredJob(jobId);
          if (row.merchant_id !== merchantId) throw new Error("MEMORY_JOB_NOT_FOUND");
          if (row.status !== "FAILED") throw new Error("MEMORY_JOB_CONFLICT");
          if (!model) throw new Error("MODEL_NOT_CONFIGURED");
          if (!jobRecord(row).sourceCount) throw new Error("MEMORY_NO_MESSAGES");
          db.prepare(
            "UPDATE memory_job SET status = 'QUEUED', model_json = ?, recovery_count = 0, error_code = NULL, updated_at = ? WHERE job_id = ?",
          ).run(JSON.stringify(model), now, jobId);
          return publicJob(requiredJob(jobId));
        }),
      ),
    /** 重启只自动恢复一次中断的纯模型总结，持久写入仍由幂等事务提交。 */
    recoverMemoryJobs: (now: string) => {
      db.prepare(`UPDATE memory_job SET status = CASE WHEN recovery_count < 1 THEN 'QUEUED' ELSE 'FAILED' END,
        error_code = 'MEMORY_INTERRUPTED', recovery_count = recovery_count + 1, updated_at = ? WHERE status = 'RUNNING'`).run(
        now,
      );
    },
    /** 原子领取任务并保存每次尝试的非秘密模型配置。 */
    claimMemoryJob: (now: string) =>
      transact(() => {
        const row = db.prepare("SELECT * FROM memory_job WHERE status = 'QUEUED' ORDER BY rowid LIMIT 1").get() as
          | Row
          | undefined;
        if (!row) return null;
        const attempts = JSON.parse(String(row.attempts_json)) as unknown[];
        attempts.push({
          attempt: Number(row.attempt) + 1,
          model: row.model_json ? JSON.parse(String(row.model_json)) : null,
          startedAt: now,
        });
        db.prepare(
          "UPDATE memory_job SET status = 'RUNNING', attempt = attempt + 1, attempts_json = ?, updated_at = ? WHERE job_id = ?",
        ).run(JSON.stringify(attempts), now, row.job_id as string);
        return jobRecord(requiredJob(String(row.job_id)));
      }),
    /** 原子提交总结和有用户原话的候选；过期尝试与重复完成不再写入。 */
    finishMemoryJob: (
      jobId: string,
      attempt: number,
      result: MemorySummary | null,
      errorCode: string | null,
      now: string,
    ) =>
      transact(() => {
        const row = requiredJob(jobId);
        if (row.status !== "RUNNING" || Number(row.attempt) !== attempt) return;
        const job = jobRecord(row);
        if (result && !errorCode) {
          if (
            !result.overview.trim() ||
            result.overview.length > 2500 ||
            result.items.length > 15 ||
            result.candidates.length > 5
          )
            throw new Error("MEMORY_RESULT_INVALID");
          // 模型只能引用冻结的文字，不能自行伪造用户原话或来源角色。
          for (const item of [...result.items, ...result.candidates]) {
            const source = job.sources.find((source) => source.messageId === item.messageId);
            if (!source || !item.quote.trim() || item.quote.length > 500 || !source.text.includes(item.quote))
              throw new Error("MEMORY_SOURCE_INVALID");
            if (("content" in item || item.kind === "USER_STATEMENT") && source.role !== "user")
              throw new Error("MEMORY_SOURCE_INVALID");
            if (
              !("content" in item) &&
              (item.text.length > 1000 || !["USER_STATEMENT", "AGENT_SUGGESTION", "OPEN_QUESTION"].includes(item.kind))
            )
              throw new Error("MEMORY_RESULT_INVALID");
            if (!("content" in item) && item.kind === "AGENT_SUGGESTION" && source.role !== "assistant")
              throw new Error("MEMORY_SOURCE_INVALID");
          }
          const summaryText = [
            result.overview,
            ...result.items.map((item) => `[${item.kind}] ${item.text}（${item.messageId}）`),
          ].join("\n");
          const onlyProduct = job.sources[0]?.product;
          const summaryProduct =
            onlyProduct &&
            job.sources.every(
              (item) =>
                item.product?.entryId === onlyProduct.entryId &&
                item.product.revision === onlyProduct.revision &&
                item.product.sha256 === onlyProduct.sha256,
            )
              ? onlyProduct
              : null;
          insert(
            job.merchantId,
            {
              title: "归档会话工作总结",
              content: summaryText.slice(0, 2000),
              kind: "PROGRESS",
              expiresAt: new Date(Date.parse(now) + 30 * 86400000).toISOString(),
              ...(summaryProduct && {
                subject: { kind: "PRODUCT" as const, productEntryId: summaryProduct.entryId },
                productBasis: summaryProduct,
              }),
            },
            "SHORT",
            "CANDIDATE",
            {
              kind: "SESSION_SUMMARY",
              sessionId: job.sessionId,
              messageId: null,
              jobId,
              quote: "模型归纳；用户陈述、助手建议和待解决问题分列，完整内容及原话见归档任务",
            },
            `summary:${jobId}`,
            now,
          );
          for (const [index, item] of result.candidates.entries()) {
            const source = job.sources.find((entry) => entry.messageId === item.messageId);
            const product = source?.product;
            if (item.subject?.kind === "PRODUCT" && product?.entryId !== item.subject.productEntryId)
              throw new Error("MEMORY_SOURCE_INVALID");
            insert(
              job.merchantId,
              {
                ...item,
                subject: product
                  ? { kind: "PRODUCT", productEntryId: product.entryId }
                  : item.subject?.kind === "MERCHANT"
                    ? item.subject
                    : undefined,
                productBasis: product ?? null,
              },
              "LONG",
              "CANDIDATE",
              {
                kind: "SESSION_SUMMARY",
                sessionId: job.sessionId,
                messageId: item.messageId,
                jobId,
                quote: item.quote,
              },
              `candidate:${jobId}:${index}`,
              now,
            );
          }
        }
        db.prepare(
          "UPDATE memory_job SET status = ?, result_json = ?, error_code = ?, updated_at = ? WHERE job_id = ?",
        ).run(
          result && !errorCode ? "SUCCEEDED" : "FAILED",
          result && !errorCode ? JSON.stringify(result) : null,
          errorCode,
          now,
          jobId,
        );
      }),
    /** 恢复会话只改变生命周期，已有记忆和归档来源保持不变。 */
    restoreSession: (sessionId: string, key: string, now: string) =>
      transact(() =>
        command(key, "restoreSession", { sessionId }, now, () => {
          const row = db.prepare("SELECT * FROM session WHERE session_id = ?").get(sessionId) as Row | undefined;
          if (!row) throw new Error("SESSION_NOT_FOUND");
          if (row.lifecycle_status !== "ARCHIVED") throw new Error("SESSION_NOT_ARCHIVED");
          db.prepare("UPDATE session SET lifecycle_status = 'ACTIVE', updated_at = ? WHERE session_id = ?").run(
            now,
            sessionId,
          );
          return {
            sessionId,
            scope: row.scope,
            ownerId: row.owner_id,
            title: row.title,
            lifecycleStatus: "ACTIVE",
            titleRevision: Number(row.title_revision),
            unreadCount: Number(
              (
                db
                  .prepare(`SELECT COUNT(*) AS count FROM message WHERE session_id = ?
              AND role = 'assistant' AND rowid > COALESCE((SELECT message_rowid FROM session_read_cursor WHERE session_id = ?), 0)`)
                  .get(sessionId, sessionId) as Row
              ).count,
            ),
            firstUnreadMessageId:
              ((
                db
                  .prepare(`SELECT message_id FROM message WHERE session_id = ? AND role = 'assistant'
              AND rowid > COALESCE((SELECT message_rowid FROM session_read_cursor WHERE session_id = ?), 0)
              ORDER BY rowid LIMIT 1`)
                  .get(sessionId, sessionId) as Row | undefined
              )?.message_id as string | undefined) ?? null,
            deletedAt: null,
            trashExpiresAt: null,
            modelAlias: row.model_alias,
            piSessionFile: row.pi_session_file,
            lastSeq: Number(row.last_seq),
            createdAt: row.created_at,
            updatedAt: now,
          };
        }),
      ),
  };
}

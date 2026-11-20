import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TextGenerationJobRecord } from "../../../../shared/contracts.js";
import type { ResearchReport } from "../../../../shared/research.js";
import type { TopicCreationInput } from "../../../../shared/topics.js";
import { assertResearchJobCurrent } from "../../research/infrastructure/research-agent-store.js";
import {
  freezeMerchantProfile,
  freezeTopicSource,
  validateTopicSource,
} from "../../research/infrastructure/topic-store.js";
import { readTaskContextForDraft } from "../../sessions/infrastructure/task-context-store.js";
import {
  buildContentPrompt,
  buildRevisionPrompt,
  PRODUCT_PROMOTION_HASH,
  PRODUCT_PROMOTION_VERSION,
} from "../application/content-template.js";
import { CONTENT_OUTPUT_VERSION, contentOutputInstruction, parseContentOutput } from "../domain/content-output.js";
import { assertPublicationRepairBasis } from "./publication-repair-source.js";

type Row = Record<string, unknown>;
const jobSelection = `SELECT j.*, (SELECT json_extract(m.content_json,'$.text') FROM message m
  WHERE m.session_id=j.session_id AND m.run_id=j.source_run_id AND m.role='assistant' ORDER BY m.rowid DESC LIMIT 1) AS assistant_text
  , (SELECT json_extract(root.source_json,'$.executionControl') FROM task_context c JOIN generation_job root ON root.job_id=c.root_job_id WHERE c.context_id=json_extract(j.source_json,'$.taskContext.contextId') AND c.session_id=j.session_id) AS execution_control_json FROM generation_job j`;

/** 还原文案任务的版本化输入与运行结果。 */
function textJob(row: Row): TextGenerationJobRecord {
  const source = row.source_json ? (JSON.parse(String(row.source_json)) as TextGenerationJobRecord["source"]) : null;
  const output =
    source?.conversation &&
    !source.repair &&
    row.purpose === "CONTENT" &&
    row.status === "READY_FOR_REVIEW" &&
    row.assistant_text
      ? parseContentOutput(String(row.assistant_text))
      : null;
  return {
    ...(source?.conversation
      ? {
          conversation: {
            instruction: source.conversation.instruction,
            reply: source.workflow?.reply || output?.reply || null,
            action: output?.action ?? null,
          },
        }
      : {}),
    executionControl: row.execution_control_json ? JSON.parse(String(row.execution_control_json)) : null,
    purpose: (row.purpose ?? "CONTENT") as TextGenerationJobRecord["purpose"],
    source,
    jobId: String(row.job_id),
    sessionId: String(row.session_id),
    merchantId: row.merchant_id === null ? null : String(row.merchant_id),
    intent: row.intent as TextGenerationJobRecord["intent"],
    kind: "TEXT",
    status: row.status as TextGenerationJobRecord["status"],
    title: String(row.title),
    prompt: String(row.prompt),
    modelId: String(row.model_id),
    inputHash: String(row.input_hash),
    templateId: row.template_id === null ? null : "PRODUCT_PROMOTION",
    templateVersion: row.template_version === null ? null : String(row.template_version),
    templateHash: row.template_hash === null ? null : String(row.template_hash),
    productEntryId: row.product_entry_id === null ? null : String(row.product_entry_id),
    productRevision: row.product_revision === null ? null : Number(row.product_revision),
    productHash: row.product_hash === null ? null : String(row.product_hash),
    targetDraftId: row.target_draft_id === null ? null : String(row.target_draft_id),
    targetRevision: row.target_revision === null ? null : Number(row.target_revision),
    targetHash: row.target_hash === null ? null : String(row.target_hash),
    sourceRunId: row.source_run_id === null ? null : String(row.source_run_id),
    resultDraftId: row.result_draft_id === null ? null : String(row.result_draft_id),
    errorCode: row.error_code === null ? null : String(row.error_code),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 将文案创作计划、Run 及草稿映射保存于同一素材任务事实源。 */
export function createTextGenerationOperations(
  db: DatabaseSync,
  transaction: <T>(operation: () => T) => T,
  getReport: (merchantId: string, reportId: string) => ResearchReport | null,
) {
  /** 读取当前会话可见的文案任务。 */
  function read(sessionId: string, jobId: string): TextGenerationJobRecord | null {
    const row = db
      .prepare(`${jobSelection} WHERE j.session_id = ? AND j.job_id = ? AND j.kind = 'TEXT'`)
      .get(sessionId, jobId) as Row | undefined;
    return row ? textJob(row) : null;
  }

  return {
    /** 按会话读取统一文字任务，供选题规划服务复用。 */
    readTextGenerationJob: read,
    /** 冻结商家商品版本和模板，再等待既有 Agent Run 调度。 */
    createTextGenerationJob: (
      id: string,
      sessionId: string,
      title: string,
      brief: string,
      productEntryId: string | null,
      targetDraftId: string | null,
      expectedRevision: number | null,
      modelId: string,
      key: string,
      now: string,
      topicCreation?: TopicCreationInput,
      freezeDraftTaskContext = true,
    ): TextGenerationJobRecord =>
      transaction(() => {
        if (!title.trim() || /[\r\n]/.test(title) || !brief.trim()) throw new Error("CONTENT_INPUT_INVALID");
        const requestHash = createHash("sha256")
          .update(
            JSON.stringify({
              sessionId,
              title,
              brief,
              productEntryId,
              targetDraftId,
              expectedRevision,
              modelId,
              topicCreation,
            }),
          )
          .digest("hex");
        const existing = db.prepare("SELECT * FROM generation_job WHERE request_key = ?").get(key) as Row | undefined;
        if (existing) {
          if (existing.kind !== "TEXT" || existing.request_hash !== requestHash)
            throw new Error("IDEMPOTENCY_CONFLICT");
          return textJob(existing);
        }
        const session = db
          .prepare("SELECT scope, owner_id, lifecycle_status FROM session WHERE session_id = ?")
          .get(sessionId) as Row | undefined;
        if (!session) throw new Error("SESSION_NOT_FOUND");
        if (session.lifecycle_status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
        if (topicCreation && targetDraftId) throw new Error("CONTENT_INPUT_INVALID");
        const original = targetDraftId
          ? (db
              .prepare(
                "SELECT * FROM generation_job WHERE session_id = ? AND result_draft_id = ? AND purpose = 'CONTENT' AND json_extract(source_json,'$.repair') IS NULL ORDER BY rowid LIMIT 1",
              )
              .get(sessionId, targetDraftId) as Row | undefined)
          : null;
        let source: TextGenerationJobRecord["source"] = topicCreation
          ? freezeTopicSource(db, sessionId, topicCreation, getReport)
          : original?.source_json
            ? JSON.parse(String(original.source_json))
            : null;
        if (targetDraftId && source) {
          const {
            parentConversationJobId: _parent,
            workflow: _workflow,
            taskContext: _oldContext,
            ...originalSource
          } = source;
          source = originalSource;
        }
        if (topicCreation?.templateId === "PRODUCT_PROMOTION" && !productEntryId)
          throw new Error("PRODUCT_SOURCE_INVALID");
        if (productEntryId && targetDraftId) throw new Error("CONTENT_INPUT_INVALID");
        const target = targetDraftId
          ? (db
              .prepare(`SELECT d.draft_id, d.current_revision, v.sha256, v.title, v.body
            FROM content_draft d JOIN content_revision v ON v.draft_id = d.draft_id AND v.revision = d.current_revision
            WHERE d.draft_id = ? AND d.session_id = ?`)
              .get(targetDraftId, sessionId) as Row | undefined)
          : null;
        if (targetDraftId && !target) throw new Error("CONTENT_DRAFT_NOT_FOUND");
        if (target && Number(target.current_revision) !== expectedRevision)
          throw new Error("CONTENT_REVISION_CONFLICT");
        // AI 改稿沿用原任务的商品历史版本，不能把商品库最新内容混入已审核稿的来源。
        const inheritedProductId = target ? original?.product_entry_id : null;
        const selectedProductId = productEntryId ?? (inheritedProductId ? String(inheritedProductId) : null);
        const product = selectedProductId
          ? (db
              .prepare(`SELECT e.entry_id, v.revision, v.name, v.detail, v.provenance, v.sha256
          FROM merchant_catalog_entry e JOIN merchant_catalog_revision v ON v.entry_id = e.entry_id
            AND v.revision = COALESCE(?, e.revision)
          WHERE e.entry_id = ? AND e.merchant_id = ? AND e.kind = 'PRODUCT' AND e.status = 'ACTIVE'`)
              .get(
                inheritedProductId ? Number(original?.product_revision) : null,
                selectedProductId,
                String(session.owner_id),
              ) as Row | undefined)
          : null;
        if (selectedProductId && (session.scope !== "MERCHANT" || !product)) throw new Error("PRODUCT_SOURCE_INVALID");
        if (inheritedProductId && product?.sha256 !== original?.product_hash) throw new Error("PRODUCT_SOURCE_CHANGED");
        const productSnapshot = product
          ? {
              entryId: String(product.entry_id),
              revision: Number(product.revision),
              sha256: String(product.sha256),
              name: String(product.name),
              detail: String(product.detail),
              provenance: String(product.provenance),
            }
          : null;
        const usesTemplate = !!product && (!topicCreation || topicCreation.templateId === "PRODUCT_PROMOTION");
        const template = target
          ? original?.template_id === "PRODUCT_PROMOTION"
            ? {
                templateId: "PRODUCT_PROMOTION" as const,
                version: String(original.template_version),
                sha256: String(original.template_hash),
              }
            : null
          : usesTemplate
            ? {
                templateId: "PRODUCT_PROMOTION" as const,
                version: PRODUCT_PROMOTION_VERSION,
                sha256: PRODUCT_PROMOTION_HASH,
              }
            : null;
        if (session.scope === "MERCHANT") {
          source = {
            ...source,
            profile: source?.profile ?? freezeMerchantProfile(db, String(session.owner_id)),
            product: productSnapshot,
            template,
            references: source?.references ?? [],
          };
        }
        if (target) {
          const taskContext = freezeDraftTaskContext
            ? readTaskContextForDraft(db, sessionId, targetDraftId as string)
            : null;
          source = {
            ...source,
            references: source?.references ?? [],
            conversation: { instruction: brief },
            ...(taskContext && { taskContext }),
          };
        }
        let prompt = target
          ? buildRevisionPrompt(brief, {
              draftId: String(target.draft_id),
              revision: Number(target.current_revision),
              sha256: String(target.sha256),
              title: String(target.title),
              body: String(target.body),
            })
          : buildContentPrompt(brief, productSnapshot, source, title);
        if (target && source) {
          const { taskContext: _context, parentConversationJobId: _parent, ...businessSource } = source;
          prompt += `\n\n沿用原创作来源与限制：${JSON.stringify(businessSource)}`;
        }
        prompt += `\n\n${contentOutputInstruction()}`;
        if (prompt.length > 50000) throw new Error("CONTENT_INPUT_INVALID");
        const inputHash = createHash("sha256").update(JSON.stringify({ title, prompt, modelId })).digest("hex");
        db.prepare(`INSERT INTO generation_job(job_id, session_id, merchant_id, intent, kind, status,
        title, prompt, input_hash, model_id, model_version, template_id, template_version, template_hash,
        product_entry_id, product_revision, product_hash, target_draft_id, target_revision, target_hash,
        request_key, request_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'TEXT', 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id,
          sessionId,
          session.scope === "MERCHANT" ? String(session.owner_id) : null,
          target ? "MODIFY" : "CREATE",
          title,
          prompt,
          inputHash,
          modelId,
          CONTENT_OUTPUT_VERSION,
          template?.templateId ?? null,
          template?.version ?? null,
          template?.sha256 ?? null,
          selectedProductId,
          productSnapshot?.revision ?? null,
          productSnapshot?.sha256 ?? null,
          targetDraftId,
          target ? Number(target.current_revision) : null,
          target ? String(target.sha256) : null,
          key,
          requestHash,
          now,
          now,
        );
        if (source)
          db.prepare("UPDATE generation_job SET source_json = ? WHERE job_id = ?").run(JSON.stringify(source), id);
        return read(sessionId, id) as TextGenerationJobRecord;
      }),

    /** 列出会话文案任务，供页面展示与断线恢复。 */
    listTextGenerationJobs: (sessionId: string): TextGenerationJobRecord[] =>
      (
        db
          .prepare(`${jobSelection} WHERE j.session_id = ? AND j.kind = 'TEXT' ORDER BY j.created_at DESC LIMIT 100`)
          .all(sessionId) as Row[]
      ).map(textJob),

    /** 为调度器寻找尚未受理或等待 Run 结果的任务。 */
    listPendingTextGenerationJobs: (): TextGenerationJobRecord[] =>
      (
        db
          .prepare(
            "SELECT * FROM generation_job WHERE kind = 'TEXT' AND status IN ('QUEUED','RUNNING') ORDER BY created_at LIMIT 100",
          )
          .all() as Row[]
      ).map(textJob),

    /** Run 受理前复核来源仍为冻结版本，拒绝悄悄改用新商品或草稿。 */
    validateTextGenerationSources: (sessionId: string, jobId: string): void => {
      const current = read(sessionId, jobId);
      if (!current) throw new Error("GENERATION_JOB_NOT_FOUND");
      const session = db.prepare("SELECT lifecycle_status FROM session WHERE session_id = ?").get(sessionId) as
        | Row
        | undefined;
      if (session?.lifecycle_status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
      if (current.source?.research || current.source?.researchContinuation)
        assertResearchJobCurrent(db, sessionId, jobId);
      if (current.source?.repair) assertPublicationRepairBasis(db, sessionId, current.source.repair);
      if (current.source) validateTopicSource(db, sessionId, current.source);
      if (
        current.source?.profile &&
        current.purpose !== "PUBLICATION_PLAN" &&
        current.purpose !== "PUBLICATION_REVIEW" &&
        current.intent === "CREATE" &&
        !current.source.creation?.allowStale
      ) {
        const merchant = db
          .prepare("SELECT profile_revision FROM merchant WHERE merchant_id=?")
          .get(current.merchantId) as Row | undefined;
        if (merchant?.profile_revision !== current.source.profile.revision) throw new Error("TOPIC_SOURCE_STALE");
      }
      if (current.productEntryId) {
        const row = db
          .prepare(`SELECT v.revision, e.status, v.sha256 FROM merchant_catalog_entry e
          JOIN merchant_catalog_revision v ON v.entry_id = e.entry_id AND v.revision = COALESCE(?, e.revision)
          WHERE e.entry_id = ? AND e.merchant_id = ?`)
          .get(
            current.intent === "MODIFY" ? current.productRevision : null,
            current.productEntryId,
            current.merchantId,
          ) as Row | undefined;
        if (
          row?.status !== "ACTIVE" ||
          Number(row.revision) !== current.productRevision ||
          row.sha256 !== current.productHash
        )
          throw new Error("PRODUCT_SOURCE_CHANGED");
      }
      if (current.targetDraftId) {
        const row = db
          .prepare(`SELECT d.current_revision, v.sha256 FROM content_draft d
          JOIN content_revision v ON v.draft_id = d.draft_id AND v.revision = d.current_revision
          WHERE d.draft_id = ? AND d.session_id = ?`)
          .get(current.targetDraftId, sessionId) as Row | undefined;
        if (!row || Number(row.current_revision) !== current.targetRevision || row.sha256 !== current.targetHash)
          throw new Error("CONTENT_REVISION_CONFLICT");
      }
    },

    /** 将已原子受理的会话 Run 关联到任务；同一 Run 不会重复登记。 */
    attachTextGenerationRun: (sessionId: string, jobId: string, runId: string, now: string): TextGenerationJobRecord =>
      transaction(() => {
        const current = read(sessionId, jobId);
        if (!current) throw new Error("GENERATION_JOB_NOT_FOUND");
        if (current.sourceRunId) {
          if (current.sourceRunId !== runId) throw new Error("GENERATION_JOB_STATE_CONFLICT");
          return current;
        }
        if (current.status !== "QUEUED") throw new Error("GENERATION_JOB_STATE_CONFLICT");
        const run = db.prepare("SELECT 1 FROM agent_run WHERE session_id = ? AND run_id = ?").get(sessionId, runId);
        if (!run) throw new Error("RUN_NOT_FOUND");
        db.prepare(
          "UPDATE generation_job SET status = 'RUNNING', source_run_id = ?, attempt = 1, updated_at = ? WHERE job_id = ?",
        ).run(runId, now, jobId);
        db.prepare(`INSERT INTO generation_step_attempt(job_id, step_key, attempt, input_hash, strategy_version, status, started_at)
        SELECT job_id, 'TEXT_RUN', 1, input_hash, model_version, 'RUNNING', ? FROM generation_job WHERE job_id = ?`).run(
          now,
          jobId,
        );
        return read(sessionId, jobId) as TextGenerationJobRecord;
      }),

    /** 找到该 Run 最终成功的助手回复，失败或取消时返回空。 */
    findTextGenerationReply: (sessionId: string, runId: string): string | null => {
      const row = db
        .prepare(
          "SELECT message_id FROM message WHERE session_id = ? AND run_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1",
        )
        .get(sessionId, runId) as Row | undefined;
      return row ? String(row.message_id) : null;
    },

    /** 草稿创建成功后登记任务结果，不将模型回复直接标为正式产物。 */
    completeTextGenerationJob: (
      sessionId: string,
      jobId: string,
      draftId: string,
      now: string,
    ): TextGenerationJobRecord =>
      transaction(() => {
        const current = read(sessionId, jobId);
        if (!current) throw new Error("GENERATION_JOB_NOT_FOUND");
        if (current.status === "READY_FOR_REVIEW") return current;
        if (current.status !== "RUNNING") throw new Error("GENERATION_JOB_STATE_CONFLICT");
        if (!db.prepare("SELECT 1 FROM content_draft WHERE draft_id = ? AND session_id = ?").get(draftId, sessionId))
          throw new Error("CONTENT_DRAFT_NOT_FOUND");
        db.prepare(
          "UPDATE generation_step_attempt SET status = 'SUCCEEDED', finished_at = ? WHERE job_id = ? AND step_key = 'TEXT_RUN' AND status = 'RUNNING'",
        ).run(now, jobId);
        db.prepare(
          "UPDATE generation_job SET status = 'READY_FOR_REVIEW', result_draft_id = ?, updated_at = ? WHERE job_id = ?",
        ).run(draftId, now, jobId);
        return read(sessionId, jobId) as TextGenerationJobRecord;
      }),

    /** 明确 Run 失败或输入不可恢复时结束任务并保留原因。 */
    failTextGenerationJob: (sessionId: string, jobId: string, code: string, now: string): TextGenerationJobRecord =>
      transaction(() => {
        const current = read(sessionId, jobId);
        if (!current) throw new Error("GENERATION_JOB_NOT_FOUND");
        if (current.status === "FAILED" || current.status === "READY_FOR_REVIEW") return current;
        if (current.source?.researchContinuation) {
          db.prepare(
            "UPDATE generation_job SET source_json=json_set(source_json,'$.delivery.state',?,'$.delivery.errorCode',?) WHERE job_id=? AND session_id=? AND json_extract(source_json,'$.delivery.summaryJobId')=?",
          ).run(
            code === "RESEARCH_SOURCE_SUPERSEDED" ? "SUPERSEDED" : "FAILED",
            code,
            current.source.researchContinuation.researchJobId,
            sessionId,
            jobId,
          );
        }
        if (current.purpose === "PUBLICATION_SUMMARY" && current.source?.summary) {
          // 旧投递失效与真正汇总失败分别收口，不能把已终止Job一直显示成等待交付。
          const superseded = [
            "ASYNC_RESULT_SUPERSEDED",
            "RUN_CANCELLED",
            "TEXT_RUN_CANCELLED",
            "SESSION_NOT_ACTIVE",
          ].includes(code);
          db.prepare(
            "UPDATE generation_job SET source_json=json_set(source_json,'$.delivery.state',?,'$.delivery.errorCode',?) WHERE job_id=? AND session_id=? AND json_extract(source_json,'$.delivery.summaryJobId')=?",
          ).run(superseded ? "SUPERSEDED" : "FAILED", code, current.source.summary.parentJobId, sessionId, jobId);
        }
        if (current.source?.workflow) {
          db.prepare("UPDATE generation_job SET source_json=? WHERE job_id=?").run(
            JSON.stringify({
              ...current.source,
              workflow: {
                ...current.source.workflow,
                state: "FAILED",
                errorCode: code,
                receipt: `本次未完成（${code}），原内容保留，可以继续对话调整要求。`,
              },
            }),
            jobId,
          );
        }
        db.prepare(
          "UPDATE generation_step_attempt SET status = 'FAILED', error_code = ?, finished_at = ? WHERE job_id = ? AND step_key = 'TEXT_RUN' AND status = 'RUNNING'",
        ).run(code, now, jobId);
        db.prepare("UPDATE generation_job SET status = 'FAILED', error_code = ?, updated_at = ? WHERE job_id = ?").run(
          code,
          now,
          jobId,
        );
        return read(sessionId, jobId) as TextGenerationJobRecord;
      }),
  };
}

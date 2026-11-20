import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import AjvModule from "ajv/dist/2020.js";
import type {
  ContentAnalysis,
  ContentAnalysisAttempt,
  ResearchAdoptInput,
  ResearchBatch,
  ResearchCandidate,
  ResearchEvidenceRef,
  ResearchLibraryItem,
  ResearchReport,
  ResearchSaveInput,
  ResearchScope,
} from "../../../../shared/research.js";
import {
  normalizedResearchTitle,
  researchAdoptSchema,
  researchSaveSchema,
  researchScopeSchema,
} from "../../../../shared/research.js";
import type { StoredMerchantContextSnapshot } from "../../../infrastructure/sqlite/db-client.js";
import { readRuntimePlan } from "../../../runtime/execution/runtime-plan.js";
import { renderResearchDocument } from "../application/research-report.js";

type Row = Record<string, unknown>;
type LibraryBody = Omit<ResearchLibraryItem, "sha256" | "stale">;
type BatchBody = Omit<ResearchBatch, "sha256" | "sourceRunStatus" | "stale">;
type ReportBody = Omit<ResearchReport, "sha256" | "sourceRunStatus" | "stale">;
const ajv = new AjvModule.default({ allErrors: true, strict: false });
const validateScope = ajv.compile<ResearchScope>(researchScopeSchema);
const validateSave = ajv.compile<ResearchSaveInput>(researchSaveSchema);
const validateAdopt = ajv.compile<ResearchAdoptInput>(researchAdoptSchema);
const kindByGoal = { KEYWORDS: "KEYWORD", TRENDS: "TREND", COMPETITORS: "COMPETITOR_DIFFERENCE" } as const;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** 话题未设置建议截止时按观察窗口限制来源寿命，避免一次采样无限期有效。 */
function candidateExpiry(candidate: ResearchCandidate, scope: ResearchScope): string | null {
  if (candidate.kind !== "TREND") return null;
  if (candidate.details.validUntil) return candidate.details.validUntil;
  const published = candidate.details.publishedAt ? Date.parse(candidate.details.publishedAt) : Number.NaN;
  if (!Number.isFinite(published)) throw new Error("RESEARCH_SOURCE_INVALID");
  return new Date(published + scope.windowDays * MILLISECONDS_PER_DAY).toISOString();
}

/** 稳定排序字段，使工具或 HTTP 重试不受 JSON 属性顺序影响。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** 计算研究输入和已保存版本的完整性摘要。 */
function checksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** 研究候选和用户采用记录共用原 Run，所有写入由 SQLite 事务串行处理。 */
export function createResearchOperations(
  db: DatabaseSync,
  transaction: <T>(operation: () => T) => T,
  getSnapshot: (id: string) => StoredMerchantContextSnapshot | null,
) {
  /** 检查会话仍由本商家持有；写入另要求活动状态。 */
  function requireSession(merchantId: string, sessionId: string, active: boolean): void {
    const row = db
      .prepare("SELECT scope, owner_id, lifecycle_status FROM session WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    if (row?.scope !== "MERCHANT" || row.owner_id !== merchantId) throw new Error("RESEARCH_NOT_FOUND");
    if (active && row.lifecycle_status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
  }

  /** 冻结前核对产品、人工线索和账号来源的归属，不允许通过 ID 扩大商家范围。 */
  function validateResearchScope(merchantId: string, input: unknown): ResearchScope {
    if (!validateScope(input)) throw new Error("RESEARCH_INPUT_INVALID");
    const scope = { ...input, focus: input.focus.trim() };
    for (const id of [...scope.catalogSourceIds, ...(scope.productId ? [scope.productId] : [])]) {
      const row = db
        .prepare("SELECT kind FROM merchant_catalog_entry WHERE entry_id = ? AND merchant_id = ? AND status = 'ACTIVE'")
        .get(id, merchantId) as Row | undefined;
      if (
        !row ||
        (id === scope.productId && row.kind !== "PRODUCT") ||
        (scope.catalogSourceIds.includes(id) && row.kind === "PRODUCT")
      )
        throw new Error("RESEARCH_SOURCE_INVALID");
    }
    for (const id of scope.linkSourceIds) {
      const row = db
        .prepare(`SELECT v.kind FROM merchant_platform_link l JOIN merchant_platform_link_revision v ON v.link_id = l.link_id AND v.revision = l.revision
        WHERE l.link_id = ? AND l.merchant_id = ? AND l.status = 'ACTIVE'`)
        .get(id, merchantId) as Row | undefined;
      if (!row || !["ACCOUNT", "REFERENCE"].includes(String(row.kind))) throw new Error("RESEARCH_SOURCE_INVALID");
    }
    return scope;
  }

  /** 按原快照比较当前档案和所选来源版本；资料变化只标记过时，不改写历史。 */
  function isStale(snapshotId: string): boolean {
    const snapshot = db.prepare("SELECT * FROM merchant_context_snapshot WHERE snapshot_id = ?").get(snapshotId) as
      | Row
      | undefined;
    if (!snapshot) throw new Error("RESEARCH_SOURCE_INVALID");
    const merchant = db
      .prepare("SELECT profile_revision FROM merchant WHERE merchant_id = ?")
      .get(String(snapshot.merchant_id)) as Row | undefined;
    if (!merchant || merchant.profile_revision !== snapshot.profile_revision) return true;
    const scope = snapshot.research_scope_json
      ? (JSON.parse(String(snapshot.research_scope_json)) as ResearchScope)
      : null;
    if (!scope) return false;
    const catalogRefs = JSON.parse(String(snapshot.catalog_refs_json ?? "[]")) as Array<{
      entryId: string;
      revision: number;
    }>;
    const linkRefs = JSON.parse(String(snapshot.link_refs_json)) as Array<{ linkId: string; revision: number }>;
    return (
      [...scope.catalogSourceIds, ...(scope.productId ? [scope.productId] : [])].some((id) => {
        const row = db.prepare("SELECT revision, status FROM merchant_catalog_entry WHERE entry_id = ?").get(id) as
          | Row
          | undefined;
        return row?.status !== "ACTIVE" || row.revision !== catalogRefs.find((ref) => ref.entryId === id)?.revision;
      }) ||
      scope.linkSourceIds.some((id) => {
        const row = db.prepare("SELECT revision, status FROM merchant_platform_link WHERE link_id = ?").get(id) as
          | Row
          | undefined;
        return row?.status !== "ACTIVE" || row.revision !== linkRefs.find((ref) => ref.linkId === id)?.revision;
      })
    );
  }

  /** 只还原正文 hash 正确且属于所请求商家的研究批次。 */
  function getResearchBatch(merchantId: string, batchId: string): ResearchBatch | null {
    const row = db
      .prepare(`SELECT b.*, r.status AS run_status, r.attempt AS run_attempt FROM merchant_research_batch b JOIN agent_run r ON r.run_id = b.run_id
      WHERE b.merchant_id = ? AND b.batch_id = ?`)
      .get(merchantId, batchId) as Row | undefined;
    if (!row) return null;
    const body = JSON.parse(String(row.body_json)) as BatchBody;
    if (checksum(body) !== row.sha256) throw new Error("RESEARCH_SOURCE_INVALID");
    return {
      ...body,
      sourceAttempt: body.sourceAttempt ?? 0,
      sha256: String(row.sha256),
      // 中断尝试留下的候选不能借后续尝试的成功状态进入采用库。
      sourceRunStatus: body.sourceAttempt === row.run_attempt ? String(row.run_status) : "INTERRUPTED",
      stale: isStale(body.snapshotId),
    };
  }

  /** 读取采用库的指定不可变版本，历史 Run 不会读到更新后的建议。 */
  function readResearchVersion(merchantId: string, itemId: string, revision?: number): ResearchLibraryItem | null {
    const row = db
      .prepare(`SELECT v.body_json, v.sha256 FROM merchant_research_item i JOIN merchant_research_revision v ON v.item_id = i.item_id
      AND v.revision = COALESCE(?, i.revision) WHERE i.merchant_id = ? AND i.item_id = ?`)
      .get(revision ?? null, merchantId, itemId) as Row | undefined;
    if (!row) return null;
    const body = JSON.parse(String(row.body_json)) as LibraryBody;
    if (checksum(body) !== row.sha256) throw new Error("RESEARCH_SOURCE_INVALID");
    let expiresAt = body.expiresAt;
    if (expiresAt === undefined) {
      const source = getResearchBatch(merchantId, body.sourceBatchId);
      if (!source) throw new Error("RESEARCH_SOURCE_INVALID");
      expiresAt = candidateExpiry(body.candidate, source.scope);
    }
    return { ...body, expiresAt, sha256: String(row.sha256), stale: isStale(body.snapshotId) };
  }

  /** 列出本商家的采用库，停用条目保留历史供旧快照读取。 */
  function listResearchLibrary(merchantId: string): ResearchLibraryItem[] {
    const rows = db
      .prepare("SELECT item_id FROM merchant_research_item WHERE merchant_id = ? ORDER BY rowid DESC")
      .all(merchantId) as Row[];
    return rows.map((row) => readResearchVersion(merchantId, String(row.item_id)) as ResearchLibraryItem);
  }

  /** 验证候选种类、必填文字和时间语义，保留无证据时的缺口结果。 */
  function validateCandidates(input: ResearchSaveInput, scope: ResearchScope, now: string): void {
    if (!input.candidates.length && !input.gaps.length) throw new Error("RESEARCH_INPUT_INVALID");
    const titles = new Set<string>();
    for (const candidate of input.candidates) {
      if (
        candidate.kind !== kindByGoal[scope.goal] ||
        !candidate.title.trim() ||
        !candidate.merchantRelevance.trim() ||
        !candidate.audience.trim() ||
        !candidate.contentAngle.trim()
      )
        throw new Error("RESEARCH_INPUT_INVALID");
      const title = normalizedResearchTitle(candidate.title);
      if (titles.has(title)) throw new Error("RESEARCH_INPUT_INVALID");
      titles.add(title);
      if (candidate.kind === "TREND") {
        const { publishedAt, validUntil } = candidate.details;
        if ([publishedAt, validUntil].some((date) => date !== null && !Number.isFinite(Date.parse(date))))
          throw new Error("RESEARCH_INPUT_INVALID");
        const publishedTime = publishedAt ? Date.parse(publishedAt) : Number.NaN;
        if (
          !publishedAt ||
          publishedTime > Date.parse(now) ||
          publishedTime < Date.parse(now) - scope.windowDays * MILLISECONDS_PER_DAY ||
          (validUntil && Date.parse(validUntil) < publishedTime)
        )
          throw new Error("RESEARCH_INPUT_INVALID");
      }
      if (candidate.kind === "COMPETITOR_DIFFERENCE") {
        const { ownEvidenceIds, competitorEvidenceIds } = candidate.details;
        if (
          [...ownEvidenceIds, ...competitorEvidenceIds].some((id) => !candidate.evidenceIds.includes(id)) ||
          ownEvidenceIds.some((id) => competitorEvidenceIds.includes(id))
        )
          throw new Error("RESEARCH_SOURCE_INVALID");
      }
    }
  }

  /** 检查证据是真正采集成功的本轮内容或冻结来源，形成不可变多证据引用。 */
  function evidenceRefs(
    input: ResearchSaveInput,
    snapshot: StoredMerchantContextSnapshot,
    runId: string,
  ): ResearchEvidenceRef[] {
    const allowed = new Set([
      ...(snapshot.catalog ?? [])
        .filter((item) => snapshot.researchScope?.catalogSourceIds.includes(item.entryId))
        .flatMap((item) => (item.evidenceId ? [item.evidenceId] : [])),
      ...(snapshot.researchLibrary ?? []).flatMap((item) => item.evidenceRefs.map((ref) => ref.evidenceId)),
    ]);
    return [...new Set(input.candidates.flatMap((item) => item.evidenceIds))].map((id) => {
      const row = db.prepare("SELECT * FROM merchant_public_evidence WHERE evidence_id = ?").get(id) as Row | undefined;
      if (
        !row ||
        row.merchant_id !== snapshot.merchantId ||
        row.status !== "COLLECTED" ||
        (row.run_id !== runId && !allowed.has(id))
      )
        throw new Error("RESEARCH_SOURCE_INVALID");
      const hash = createHash("sha256").update(String(row.visible_text)).digest("hex");
      if (hash !== row.visible_text_sha256) throw new Error("RESEARCH_SOURCE_INVALID");
      return { evidenceId: id, sha256: hash, sourceUrl: String(row.source_url), collectedAt: String(row.collected_at) };
    });
  }

  /** 对操作键保存实际结果，重复 HTTP 操作不重复采用或增加版本。 */
  function previousOperation(key: string, hash: string): ResearchLibraryItem | null {
    const row = db
      .prepare("SELECT kind, request_hash, result_json FROM api_operation WHERE operation_key = ?")
      .get(key) as Row | undefined;
    if (!row) return null;
    if (row.kind !== "adoptResearchCandidate" || row.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
    return JSON.parse(String(row.result_json)) as ResearchLibraryItem;
  }

  /** 核对被采用批次的全部证据仍完整，不允许损坏内容进入长期来源。 */
  function verifyBatchEvidence(batch: ResearchBatch): void {
    for (const ref of batch.evidenceRefs) {
      const row = db
        .prepare("SELECT merchant_id, status, visible_text FROM merchant_public_evidence WHERE evidence_id = ?")
        .get(ref.evidenceId) as Row | undefined;
      if (
        !row ||
        row.merchant_id !== batch.merchantId ||
        row.status !== "COLLECTED" ||
        createHash("sha256").update(String(row.visible_text)).digest("hex") !== ref.sha256
      )
        throw new Error("RESEARCH_SOURCE_INVALID");
    }
  }

  /** 按商家读取不可变报告并核对批次摘要，后续执行尝试不能改变来源身份。 */
  function getResearchReport(merchantId: string, reportId: string): ResearchReport | null {
    const row = db
      .prepare(`SELECT p.*, r.status AS run_status, r.attempt AS run_attempt
      FROM merchant_research_report p JOIN agent_run r ON r.run_id = p.run_id
      WHERE p.merchant_id = ? AND p.report_id = ?`)
      .get(merchantId, reportId) as Row | undefined;
    if (!row) return null;
    const body = JSON.parse(String(row.body_json)) as ReportBody;
    if (checksum(body) !== row.sha256 || body.merchantId !== merchantId) throw new Error("RESEARCH_SOURCE_INVALID");
    for (const ref of body.batchRefs) {
      const batch = getResearchBatch(merchantId, ref.batchId);
      if (
        !batch ||
        batch.sha256 !== ref.sha256 ||
        batch.runId !== body.runId ||
        batch.sourceAttempt !== body.sourceAttempt
      )
        throw new Error("RESEARCH_SOURCE_INVALID");
    }
    return {
      ...body,
      sha256: String(row.sha256),
      sourceRunStatus: body.sourceAttempt === row.run_attempt ? String(row.run_status) : "INTERRUPTED",
      stale: isStale(body.snapshotId),
    };
  }

  /** 在成功终态事务中合并本次尝试的候选，空提交也自动生成明确的缺口报告。 */
  function finalizeResearchReport(runId: string, now: string): ResearchReport | null {
    const run = db.prepare("SELECT * FROM agent_run WHERE run_id = ? AND status = 'SUCCEEDED'").get(runId) as
      | Row
      | undefined;
    if (!run?.runtime_plan_json) return null;
    const plan = readRuntimePlan(String(run.runtime_plan_json));
    if (plan?.session.scope !== "MERCHANT" || !("merchant" in plan) || !plan.merchant) return null;
    const snapshot = getSnapshot(plan.merchant.snapshotId);
    if (!snapshot?.researchScope) return null;
    if (snapshot.sha256 !== plan.merchant.sha256 || snapshot.merchantId !== plan.session.ownerId)
      throw new Error("RESEARCH_SOURCE_INVALID");
    const previous = db
      .prepare("SELECT report_id FROM merchant_research_report WHERE run_id = ? AND source_attempt = ?")
      .get(runId, Number(run.attempt)) as Row | undefined;
    if (previous) return getResearchReport(snapshot.merchantId, String(previous.report_id));
    const batchRows = db
      .prepare(`SELECT batch_id FROM merchant_research_batch
      WHERE run_id = ? AND json_extract(body_json, '$.sourceAttempt') = ? ORDER BY rowid`)
      .all(runId, Number(run.attempt)) as Row[];
    const batches = batchRows.map(
      (row) => getResearchBatch(snapshot.merchantId, String(row.batch_id)) as ResearchBatch,
    );
    for (const batch of batches) verifyBatchEvidence(batch);
    const document = renderResearchDocument({
      profile: snapshot.profile.fields,
      profileRevision: snapshot.profile.revision,
      scope: snapshot.researchScope,
      windowEnd: String(run.created_at),
      rows: batches.flatMap((batch) => batch.candidates.map((candidate) => ({ candidate, source: batch.batchId }))),
      coverage: batches.map((batch) => batch.coverage),
      gaps: batches.length
        ? batches.flatMap((batch) => batch.gaps)
        : ["本轮未提交结构化研究结果，没有可供后续自动复用的候选。"],
      evidenceRefs: batches.flatMap((batch) => batch.evidenceRefs),
      adopted: false,
      source: `${runId} / 第 ${run.attempt} 次执行 / 商家快照 ${snapshot.snapshotId}`,
    });
    const body: ReportBody = {
      ...document,
      reportId: `rsr_${randomUUID()}`,
      merchantId: snapshot.merchantId,
      sessionId: String(run.session_id),
      runId,
      sourceAttempt: Number(run.attempt),
      snapshotId: snapshot.snapshotId,
      profileRevision: snapshot.profile.revision,
      scope: snapshot.researchScope,
      batchRefs: batches.map((batch) => ({ batchId: batch.batchId, sha256: batch.sha256 })),
      createdAt: now,
    };
    db.prepare(`INSERT INTO merchant_research_report(report_id, merchant_id, session_id, run_id, source_attempt, snapshot_id, body_json, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      body.reportId,
      body.merchantId,
      body.sessionId,
      runId,
      body.sourceAttempt,
      body.snapshotId,
      JSON.stringify(body),
      checksum(body),
      now,
    );
    return getResearchReport(body.merchantId, body.reportId);
  }

  /** 为有冻结研究范围的会话受理分析；同会话后续补充沿用原分析对象。 */
  function acceptContentAnalysis(runId: string, now: string): void {
    const row = db.prepare("SELECT session_id, runtime_plan_json FROM agent_run WHERE run_id = ?").get(runId) as
      | Row
      | undefined;
    if (!row) return;
    const plan = readRuntimePlan(String(row.runtime_plan_json));
    if (plan?.session.scope !== "MERCHANT" || !("merchant" in plan) || !plan.merchant) return;
    const snapshot = getSnapshot(plan.merchant.snapshotId);
    if (!snapshot?.researchScope || snapshot.sha256 !== plan.merchant.sha256) return;
    const existing = db
      .prepare("SELECT analysis_id FROM merchant_content_analysis WHERE session_id = ?")
      .get(String(row.session_id)) as Row | undefined;
    if (existing) {
      db.prepare("UPDATE merchant_content_analysis SET status = 'QUEUED', updated_at = ? WHERE analysis_id = ?").run(
        now,
        String(existing.analysis_id),
      );
    } else {
      db.prepare(`INSERT INTO merchant_content_analysis
        (analysis_id, merchant_id, session_id, scope_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'QUEUED', ?, ?)`).run(
        `ana_${randomUUID()}`,
        snapshot.merchantId,
        String(row.session_id),
        JSON.stringify(snapshot.researchScope),
        now,
        now,
      );
    }
    const analysis = db
      .prepare("SELECT analysis_id FROM merchant_content_analysis WHERE session_id = ?")
      .get(String(row.session_id)) as Row;
    db.prepare(`INSERT INTO merchant_content_analysis_attempt
      (analysis_id, run_id, run_attempt, status, snapshot_id, snapshot_hash, source_refs_json, gaps_json, started_at)
      VALUES (?, ?, 0, 'QUEUED', ?, ?, '[]', '[]', ?)`).run(
      String(analysis.analysis_id),
      runId,
      snapshot.snapshotId,
      snapshot.sha256,
      now,
    );
  }

  /** Run 被领取时冻结本次执行尝试；重试保留旧尝试的中断记录。 */
  function startContentAnalysisAttempt(runId: string, now: string): void {
    if (db.prepare("SELECT 1 FROM generation_job WHERE source_run_id = ?").get(runId)) return;
    const row = db
      .prepare("SELECT session_id, attempt, runtime_plan_json FROM agent_run WHERE run_id = ?")
      .get(runId) as Row | undefined;
    if (!row) return;
    const analysis = db
      .prepare("SELECT analysis_id FROM merchant_content_analysis WHERE session_id = ?")
      .get(String(row.session_id)) as Row | undefined;
    if (!analysis) return;
    const plan = readRuntimePlan(String(row.runtime_plan_json));
    if (plan?.session.scope !== "MERCHANT" || !("merchant" in plan) || !plan.merchant)
      throw new Error("RESEARCH_SOURCE_INVALID");
    const snapshot = getSnapshot(plan.merchant.snapshotId);
    if (!snapshot?.researchScope || snapshot.sha256 !== plan.merchant.sha256)
      throw new Error("RESEARCH_SOURCE_INVALID");
    if (Number(row.attempt) === 1) {
      db.prepare(`UPDATE merchant_content_analysis_attempt SET run_attempt = 1, status = 'COLLECTING'
        WHERE run_id = ? AND run_attempt = 0`).run(runId);
    } else {
      db.prepare(`INSERT INTO merchant_content_analysis_attempt
        (analysis_id, run_id, run_attempt, status, snapshot_id, snapshot_hash, source_refs_json, gaps_json, started_at)
        VALUES (?, ?, ?, 'COLLECTING', ?, ?, '[]', '[]', ?)`).run(
        String(analysis.analysis_id),
        runId,
        Number(row.attempt),
        snapshot.snapshotId,
        snapshot.sha256,
        now,
      );
    }
    db.prepare("UPDATE merchant_content_analysis SET status = 'COLLECTING', updated_at = ? WHERE analysis_id = ?").run(
      now,
      String(analysis.analysis_id),
    );
  }

  /** 有结构化批次时推进到分析阶段，空结果仍由最终来源规则判定。 */
  function markContentAnalysisAnalyzing(runId: string, runAttempt: number, now: string): void {
    db.prepare(`UPDATE merchant_content_analysis_attempt SET status = 'ANALYZING'
      WHERE run_id = ? AND run_attempt = ? AND status = 'COLLECTING'`).run(runId, runAttempt);
    db.prepare(`UPDATE merchant_content_analysis SET status = 'ANALYZING', updated_at = ?
      WHERE analysis_id IN (SELECT analysis_id FROM merchant_content_analysis_attempt WHERE run_id = ? AND run_attempt = ?)`).run(
      now,
      runId,
      runAttempt,
    );
  }

  /** 以成功批次和缺口判定结果，失败、取消不会覆盖上次 READY 报告。 */
  function finishContentAnalysisAttempt(runId: string, status: string, errorCode: string | null, now: string): void {
    if (db.prepare("SELECT 1 FROM generation_job WHERE source_run_id = ?").get(runId)) return;
    const run = db.prepare("SELECT session_id, attempt FROM agent_run WHERE run_id = ?").get(runId) as Row | undefined;
    if (!run) return;
    const analysis = db
      .prepare("SELECT analysis_id, merchant_id FROM merchant_content_analysis WHERE session_id = ?")
      .get(String(run.session_id)) as Row | undefined;
    if (!analysis) return;
    const attempt = Number(run.attempt);
    const batches =
      status === "SUCCEEDED"
        ? (
            db
              .prepare(`SELECT batch_id FROM merchant_research_batch WHERE run_id = ?
        AND json_extract(body_json, '$.sourceAttempt') = ?`)
              .all(runId, attempt) as Row[]
          ).map((row) => getResearchBatch(String(analysis.merchant_id), String(row.batch_id)) as ResearchBatch)
        : [];
    const candidates = batches.reduce((count, batch) => count + batch.candidates.length, 0);
    const gaps = batches.length
      ? batches.flatMap((batch) => batch.gaps)
      : status === "SUCCEEDED"
        ? ["本轮未提交结构化研究结果，没有可供后续自动复用的候选。"]
        : [];
    const finalStatus: ContentAnalysis["status"] =
      status === "SUCCEEDED"
        ? candidates === 0
          ? "WAITING_INPUT"
          : gaps.length
            ? "PARTIAL"
            : "READY"
        : status === "CANCELLED"
          ? "CANCELLED"
          : "FAILED";
    const report =
      status === "SUCCEEDED"
        ? (db
            .prepare("SELECT report_id FROM merchant_research_report WHERE run_id = ? AND source_attempt = ?")
            .get(runId, attempt) as Row | undefined)
        : undefined;
    const refs = [
      ...new Map(batches.flatMap((batch) => batch.evidenceRefs).map((ref) => [ref.evidenceId, ref])).values(),
    ];
    db.prepare(`UPDATE merchant_content_analysis_attempt SET status = ?, source_refs_json = ?, gaps_json = ?,
      report_id = ?, error_code = ?, finished_at = ? WHERE run_id = ? AND run_attempt = ?`).run(
      finalStatus,
      JSON.stringify(refs),
      JSON.stringify(gaps),
      report?.report_id ? String(report.report_id) : null,
      errorCode,
      now,
      runId,
      attempt,
    );
    db.prepare(`UPDATE merchant_content_analysis SET status = ?,
      latest_ready_report_id = CASE WHEN ? = 'READY' THEN ? ELSE latest_ready_report_id END,
      updated_at = ? WHERE analysis_id = ?`).run(
      finalStatus,
      finalStatus,
      report?.report_id ? String(report.report_id) : null,
      now,
      String(analysis.analysis_id),
    );
  }

  /** 中断尝试保留原执行编号，下一次领取会新增一条尝试。 */
  function interruptContentAnalysisAttempt(
    runId: string,
    attempt: number,
    nextStatus: "QUEUED" | "FAILED" | "CANCELLED",
    now: string,
  ): void {
    db.prepare(`UPDATE merchant_content_analysis_attempt SET status = 'INTERRUPTED', error_code = 'HOST_INTERRUPTED', finished_at = ?
      WHERE run_id = ? AND run_attempt = ? AND status IN ('COLLECTING', 'ANALYZING')`).run(now, runId, attempt);
    db.prepare(`UPDATE merchant_content_analysis SET status = ?, updated_at = ? WHERE analysis_id IN
      (SELECT analysis_id FROM merchant_content_analysis_attempt WHERE run_id = ? AND run_attempt = ?)`).run(
      nextStatus,
      now,
      runId,
      attempt,
    );
  }

  /** 商家归属范围内列出分析及不可变尝试，供页面显示真实状态和缺口。 */
  function listContentAnalyses(merchantId: string, sessionId?: string): ContentAnalysis[] {
    const rows = db
      .prepare(`SELECT * FROM merchant_content_analysis WHERE merchant_id = ?
      AND (? IS NULL OR session_id = ?) ORDER BY updated_at DESC LIMIT 100`)
      .all(merchantId, sessionId ?? null, sessionId ?? null) as Row[];
    return rows.map((row) => {
      const attempts = db
        .prepare(`SELECT * FROM merchant_content_analysis_attempt WHERE analysis_id = ?
        ORDER BY rowid DESC LIMIT 50`)
        .all(String(row.analysis_id)) as Row[];
      return {
        analysisId: String(row.analysis_id),
        merchantId,
        sessionId: String(row.session_id),
        scope: JSON.parse(String(row.scope_json)) as ResearchScope,
        status: String(row.status) as ContentAnalysis["status"],
        latestReadyReportId: row.latest_ready_report_id ? String(row.latest_ready_report_id) : null,
        attempts: attempts.map(
          (item): ContentAnalysisAttempt => ({
            runId: String(item.run_id),
            runAttempt: Number(item.run_attempt),
            status: String(item.status) as ContentAnalysisAttempt["status"],
            snapshotId: String(item.snapshot_id),
            snapshotHash: String(item.snapshot_hash),
            sourceRefs: JSON.parse(String(item.source_refs_json)) as ResearchEvidenceRef[],
            gaps: JSON.parse(String(item.gaps_json)) as string[],
            reportId: item.report_id ? String(item.report_id) : null,
            errorCode: item.error_code ? String(item.error_code) : null,
            startedAt: String(item.started_at),
            finishedAt: item.finished_at ? String(item.finished_at) : null,
          }),
        ),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  return {
    acceptContentAnalysis,
    startContentAnalysisAttempt,
    markContentAnalysisAnalyzing,
    finishContentAnalysisAttempt,
    interruptContentAnalysisAttempt,
    listContentAnalyses,
    validateResearchScope,
    getResearchReport,
    finalizeResearchReport,
    /** 列出指定商家或会话的固定模板报告，历史研究不会在读取时被重写。 */
    listResearchReports: (merchantId: string, sessionId?: string): ResearchReport[] => {
      const rows = db
        .prepare(`SELECT report_id FROM merchant_research_report WHERE merchant_id = ? AND (? IS NULL OR session_id = ?)
        ORDER BY rowid DESC LIMIT 100`)
        .all(merchantId, sessionId ?? null, sessionId ?? null) as Row[];
      return rows.map((row) => getResearchReport(merchantId, String(row.report_id)) as ResearchReport);
    },
    listResearchLibrary,
    readResearchVersion,
    getResearchBatch,
    /** 商家页和会话面板读取同一组候选；失败 Run 的候选仍可查看但不能采用。 */
    listResearchBatches: (merchantId: string, sessionId?: string): ResearchBatch[] => {
      const rows = db
        .prepare(`SELECT batch_id FROM merchant_research_batch WHERE merchant_id = ? AND (? IS NULL OR session_id = ?)
        ORDER BY rowid DESC LIMIT 100`)
        .all(merchantId, sessionId ?? null, sessionId ?? null) as Row[];
      return rows.map((row) => getResearchBatch(merchantId, String(row.batch_id)) as ResearchBatch);
    },
    /** 主 Agent 只提交候选，不获得采用权限；同 Run/稳定键按内容幂等保存。 */
    saveResearchBatch: (sessionId: string, runId: string, input: ResearchSaveInput, now: string): ResearchBatch =>
      transaction(() => {
        if (!validateSave(input) || !input.batchKey.trim() || !input.coverage.trim())
          throw new Error("RESEARCH_INPUT_INVALID");
        const run = db.prepare("SELECT * FROM agent_run WHERE session_id = ? AND run_id = ?").get(sessionId, runId) as
          | Row
          | undefined;
        const plan = run ? readRuntimePlan(String(run.runtime_plan_json)) : null;
        if (
          plan?.session.scope !== "MERCHANT" ||
          !("merchant" in plan) ||
          !plan.merchant ||
          !plan.policy.allowedToolIds.includes("merchant_research_save")
        )
          throw new Error("RESEARCH_SOURCE_INVALID");
        requireSession(plan.session.ownerId, sessionId, true);
        const snapshot = getSnapshot(plan.merchant.snapshotId);
        if (
          !snapshot?.researchScope ||
          snapshot.sha256 !== plan.merchant.sha256 ||
          snapshot.merchantId !== plan.session.ownerId
        )
          throw new Error("RESEARCH_SOURCE_INVALID");
        validateCandidates(input, snapshot.researchScope, String(run?.created_at ?? now));
        const scopedBatchKey = `${run?.attempt}:${input.batchKey}`;
        const prior = db
          .prepare("SELECT batch_id FROM merchant_research_batch WHERE run_id = ? AND batch_key = ?")
          .get(runId, scopedBatchKey) as Row | undefined;
        if (prior) {
          const result = getResearchBatch(snapshot.merchantId, String(prior.batch_id)) as ResearchBatch;
          const savedInput = {
            batchKey: result.batchKey,
            coverage: result.coverage,
            gaps: result.gaps,
            candidates: result.candidates,
          };
          if (checksum(savedInput) !== checksum(input)) throw new Error("IDEMPOTENCY_CONFLICT");
          return result;
        }
        if (run?.status !== "RUNNING") throw new Error("RESEARCH_RUN_NOT_READY");
        const count = db
          .prepare(
            "SELECT COUNT(*) AS count FROM merchant_research_batch WHERE run_id = ? AND json_extract(body_json, '$.sourceAttempt') = ?",
          )
          .get(runId, Number(run.attempt)) as Row;
        if (Number(count.count) >= 5) throw new Error("RESEARCH_LIMIT_REACHED");
        const body: BatchBody = {
          ...input,
          batchId: `rsb_${randomUUID()}`,
          merchantId: snapshot.merchantId,
          sessionId,
          runId,
          sourceAttempt: Number(run.attempt),
          snapshotId: snapshot.snapshotId,
          profileRevision: snapshot.profile.revision,
          scope: snapshot.researchScope,
          evidenceRefs: evidenceRefs(input, snapshot, runId),
          createdAt: now,
        };
        db.prepare(
          "INSERT INTO merchant_research_batch(batch_id, merchant_id, session_id, run_id, snapshot_id, batch_key, body_json, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          body.batchId,
          body.merchantId,
          sessionId,
          runId,
          body.snapshotId,
          scopedBatchKey,
          JSON.stringify(body),
          checksum(body),
          now,
        );
        markContentAnalysisAnalyzing(runId, Number(run?.attempt), now);
        return getResearchBatch(body.merchantId, body.batchId) as ResearchBatch;
      }),
    /** 用户显式采用或更新一个候选；CAS、去重、证据和成功 Run 在同一事务核对。 */
    adoptResearchCandidate: (
      merchantId: string,
      batchId: string,
      input: ResearchAdoptInput,
      operationKey: string,
      now: string,
    ): ResearchLibraryItem =>
      transaction(() => {
        if (
          !validateAdopt(input) ||
          !input.title.trim() ||
          !input.merchantRelevance.trim() ||
          !input.contentAngle.trim()
        )
          throw new Error("RESEARCH_INPUT_INVALID");
        const hash = checksum({ merchantId, batchId, input });
        const previous = previousOperation(operationKey, hash);
        if (previous) return previous;
        const batch = getResearchBatch(merchantId, batchId);
        const source = batch?.candidates[input.candidateIndex];
        if (!batch || !source) throw new Error("RESEARCH_NOT_FOUND");
        requireSession(merchantId, batch.sessionId, true);
        if (batch.sourceRunStatus !== "SUCCEEDED") throw new Error("RESEARCH_RUN_NOT_READY");
        if (batch.stale && !input.allowStale) throw new Error("RESEARCH_STALE");
        verifyBatchEvidence(batch);
        const candidate: ResearchCandidate = {
          ...source,
          title: input.title.trim(),
          merchantRelevance: input.merchantRelevance.trim(),
          contentAngle: input.contentAngle.trim(),
        };
        const normalizedTitle = normalizedResearchTitle(candidate.title);
        const duplicate = db
          .prepare(
            "SELECT item_id FROM merchant_research_item WHERE merchant_id = ? AND kind = ? AND normalized_title = ?",
          )
          .get(merchantId, candidate.kind, normalizedTitle) as Row | undefined;
        const target = input.targetItemId ? readResearchVersion(merchantId, input.targetItemId) : null;
        if (
          (input.targetItemId && !target) ||
          (target && (target.revision !== input.expectedRevision || target.candidate.kind !== candidate.kind)) ||
          (!target && input.expectedRevision !== null)
        )
          throw new Error("RESEARCH_REVISION_CONFLICT");
        if (duplicate && duplicate.item_id !== target?.itemId) throw new Error("RESEARCH_DUPLICATE");
        if (!target) {
          const count = db
            .prepare("SELECT COUNT(*) AS count FROM merchant_research_item WHERE merchant_id = ?")
            .get(merchantId) as Row;
          if (Number(count.count) >= 500) throw new Error("RESEARCH_LIMIT_REACHED");
        }
        const body: LibraryBody = {
          itemId: target?.itemId ?? `rsi_${randomUUID()}`,
          merchantId,
          revision: (target?.revision ?? 0) + 1,
          status: "ACTIVE",
          candidate,
          sourceBatchId: batchId,
          sourceCandidateIndex: input.candidateIndex,
          snapshotId: batch.snapshotId,
          profileRevision: batch.profileRevision,
          evidenceRefs: batch.evidenceRefs.filter((ref) => candidate.evidenceIds.includes(ref.evidenceId)),
          adoptedAt: now,
          // 未给建议窗口的话题按原观察天数限制使用，不让一次采样无限期成为近期来源。
          expiresAt: candidateExpiry(candidate, batch.scope),
        };
        if (target)
          db.prepare(
            "UPDATE merchant_research_item SET normalized_title = ?, revision = ?, status = 'ACTIVE' WHERE item_id = ?",
          ).run(normalizedTitle, body.revision, body.itemId);
        else
          db.prepare(
            "INSERT INTO merchant_research_item(item_id, merchant_id, kind, normalized_title, revision, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')",
          ).run(body.itemId, merchantId, candidate.kind, normalizedTitle, body.revision);
        db.prepare(
          "INSERT INTO merchant_research_revision(item_id, revision, source_batch_id, body_json, sha256) VALUES (?, ?, ?, ?, ?)",
        ).run(body.itemId, body.revision, batchId, JSON.stringify(body), checksum(body));
        const result = readResearchVersion(merchantId, body.itemId) as ResearchLibraryItem;
        db.prepare(
          "INSERT INTO api_operation(operation_key, kind, result_json, request_hash, created_at) VALUES (?, 'adoptResearchCandidate', ?, ?, ?)",
        ).run(operationKey, JSON.stringify(result), hash, now);
        return result;
      }),
    /** 停用采用的建议并追加版本；原 Run 和旧快照仍能读取之前的采用版本。 */
    deactivateResearchItem: (merchantId: string, itemId: string, expectedRevision: number): ResearchLibraryItem =>
      transaction(() => {
        const item = readResearchVersion(merchantId, itemId);
        if (!item) throw new Error("RESEARCH_NOT_FOUND");
        if (item.status === "INACTIVE" && item.revision === expectedRevision + 1) return item;
        if (item.revision !== expectedRevision) throw new Error("RESEARCH_REVISION_CONFLICT");
        const { sha256: _hash, stale: _stale, ...previous } = item;
        const body: LibraryBody = { ...previous, revision: item.revision + 1, status: "INACTIVE" };
        db.prepare("UPDATE merchant_research_item SET revision = ?, status = 'INACTIVE' WHERE item_id = ?").run(
          body.revision,
          itemId,
        );
        db.prepare(
          "INSERT INTO merchant_research_revision(item_id, revision, source_batch_id, body_json, sha256) VALUES (?, ?, ?, ?, ?)",
        ).run(itemId, body.revision, item.sourceBatchId, JSON.stringify(body), checksum(body));
        return readResearchVersion(merchantId, itemId) as ResearchLibraryItem;
      }),
  };
}

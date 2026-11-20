import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type {
  AccountDiagnosisDraft,
  AccountDiagnosisEvidenceRef,
  ContextTokenMeasurement,
  DelegationInputSnapshot,
  DelegationRecord,
  DelegationTaskV2,
  MemoryProductRef,
  MemoryScope,
  MerchantCatalogEntry,
  MerchantCatalogInput,
  MerchantLinkInput,
  MerchantPlatformLink,
  MerchantProfileFields,
  UpdateMerchantLinkInput,
} from "../../../shared/contracts.js";
import type { ExpertTaskV3 } from "../../../shared/expert-contract.js";
import type { ResearchScope } from "../../../shared/research.js";
import type { ResearchMemorySnapshot } from "../../../shared/research-memory.js";
import type { CurrentTaskStatusRequest, TaskContextRef } from "../../../shared/task-context.js";
import type { TextTaskSource } from "../../../shared/topics.js";
import { createCapabilityOperations } from "../../modules/capabilities/infrastructure/capability-store.js";
import { createGenerationOperations } from "../../modules/media/infrastructure/generation-store.js";
import { isMemoryApplicable } from "../../modules/merchants/domain/memory-scope.js";
import { createMemoryEmbeddingOperations } from "../../modules/merchants/infrastructure/memory-embedding-store.js";
import { createMemoryOperations } from "../../modules/merchants/infrastructure/memory-store.js";
import { parsePublicationConversation } from "../../modules/publication/application/publication-conversation.js";
import { CONTENT_OUTPUT_VERSION, parseContentOutput } from "../../modules/publication/domain/content-output.js";
import { PUBLICATION_REPAIR_VERSION } from "../../modules/publication/domain/publication-repair.js";
import { createContentOperations } from "../../modules/publication/infrastructure/content-store.js";
import { createPublicationConversationOperations } from "../../modules/publication/infrastructure/publication-conversation-store.js";
import { assertPublicationExpertSource } from "../../modules/publication/infrastructure/publication-expert-source.js";
import { createPublicationReviewOperations } from "../../modules/publication/infrastructure/publication-review-store.js";
import { createPublicationOperations } from "../../modules/publication/infrastructure/publication-store.js";
import { createTextGenerationOperations } from "../../modules/publication/infrastructure/text-generation-store.js";
import type { CollectedPublicPage } from "../../modules/research/infrastructure/public-page-collector.js";
import {
  assertResearchJobCurrent,
  createResearchAgentOperations,
} from "../../modules/research/infrastructure/research-agent-store.js";
import { createResearchOperations } from "../../modules/research/infrastructure/research-store.js";
import { createTopicOperations } from "../../modules/research/infrastructure/topic-store.js";
import {
  assertAsyncResultCurrent,
  createAsyncResultOperations,
} from "../../modules/sessions/infrastructure/async-result-store.js";
import { readMainHistoryView, readTaskHistory } from "../../modules/sessions/infrastructure/main-history-store.js";
import { createRunContinuation } from "../../modules/sessions/infrastructure/run-continuation-store.js";
import {
  assertCurrentTaskContextForRun,
  createTaskContextOperations,
} from "../../modules/sessions/infrastructure/task-context-store.js";
import { createTaskExecutionOperations } from "../../modules/sessions/infrastructure/task-execution-store.js";
import { createWorkbenchOperations } from "../../modules/workbench/infrastructure/workbench-store.js";
import { parseAsyncResultSummary } from "../../runtime/execution/async-result-summary.js";
import {
  canonicalJson,
  createRuntimePlan,
  DEFAULT_SYSTEM_PROMPT,
  type RuntimePlanConfig,
  readRuntimePlan,
  type SystemPromptSetting,
  sha256,
} from "../../runtime/execution/runtime-plan.js";
import type { PiRuntimeEvent, RuntimeStateSnapshot } from "../../runtime/ports/pi-runtime-port.js";
import { MEMORY_TOOLSET_VERSION } from "../../runtime/tools/tool-catalog.js";
import { blocksToolReplay } from "../../runtime/tools/tool-replay-policy.js";
import type { StoredMerchantContextSnapshot } from "./db-client.js";
import { migrations } from "./migrations.js";

interface Request {
  id: number;
  name: string;
  args: unknown[];
}

interface Row {
  [key: string]: unknown;
}

// SQLite 同步 API 只在此 Worker 内运行；主线程通过消息调用 operations。
const db = new DatabaseSync(workerData.dbPath as string);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
db.exec("CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
// 每个迁移独立提交，失败时回滚当前版本并保留之前版本。
for (const migration of migrations) {
  const exists = db.prepare("SELECT 1 FROM schema_migration WHERE version = ?").get(migration.version);
  if (exists) continue;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)").run(
      migration.version,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
db.prepare(
  "INSERT OR IGNORE INTO global_system_prompt (id, content, revision, sha256, updated_at) VALUES (1, ?, 1, ?, ?)",
).run(DEFAULT_SYSTEM_PROMPT, sha256(DEFAULT_SYSTEM_PROMPT), new Date().toISOString());

/** 用 BEGIN IMMEDIATE 包裹写入，失败时回滚整笔操作。 */
function transaction<T>(operation: () => T): T {
  // 图文步骤需要把子任务受理与父来源绑定放在一起；嵌套模块用保存点局部回滚。
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT host_nested_write" : "BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec(nested ? "RELEASE host_nested_write" : "COMMIT");
    return result;
  } catch (error) {
    db.exec(nested ? "ROLLBACK TO host_nested_write; RELEASE host_nested_write" : "ROLLBACK");
    throw error;
  }
}

// 旧证据在 V12 迁移后补齐正文摘要；中断时下次启动继续处理未补齐的行。
const evidenceWithoutHash = db
  .prepare("SELECT evidence_id, visible_text FROM merchant_public_evidence WHERE visible_text_sha256 IS NULL")
  .all() as Row[];
if (evidenceWithoutHash.length) {
  transaction(() => {
    const update = db.prepare("UPDATE merchant_public_evidence SET visible_text_sha256 = ? WHERE evidence_id = ?");
    for (const row of evidenceWithoutHash) update.run(sha256(String(row.visible_text)), String(row.evidence_id));
  });
}

// V14 前的草稿保留原 ID/正文；将当时已保存且不可变的证据补为来源快照。
const diagnosisWithoutRefs = db
  .prepare("SELECT diagnosis_id, evidence_ids_json FROM account_diagnosis WHERE evidence_refs_json IS NULL")
  .all() as Row[];
if (diagnosisWithoutRefs.length) {
  transaction(() => {
    const evidenceQuery = db.prepare("SELECT * FROM merchant_public_evidence WHERE evidence_id = ?");
    const update = db.prepare("UPDATE account_diagnosis SET evidence_refs_json = ? WHERE diagnosis_id = ?");
    for (const row of diagnosisWithoutRefs) {
      const evidenceIds = JSON.parse(String(row.evidence_ids_json)) as string[];
      const refs = evidenceIds.flatMap((evidenceId) => {
        const evidenceRow = evidenceQuery.get(evidenceId) as Row | undefined;
        return evidenceRow ? [diagnosisEvidenceRef(publicEvidence(evidenceRow))] : [];
      });
      update.run(JSON.stringify(refs), String(row.diagnosis_id));
    }
  });
}

const workbenchStore = createWorkbenchOperations(db, transaction);
const capabilityStore = createCapabilityOperations(db, transaction);
const memoryStore = createMemoryOperations(db, transaction);
const asyncResultStore = createAsyncResultOperations(db, transaction);
const researchAgentStore = createResearchAgentOperations(db, transaction);
const taskExecutionStore = createTaskExecutionOperations(db, transaction);
const contentStore = createContentOperations(db, transaction);
const researchStore = createResearchOperations(db, transaction, merchantContextSnapshot);
const generationStore = createGenerationOperations(db, transaction);
const textGenerationStore = createTextGenerationOperations(db, transaction, researchStore.getResearchReport);
const publicationStore = createPublicationOperations(
  db,
  transaction,
  contentStore.getContentDraft,
  textGenerationStore.readTextGenerationJob,
);
const publicationReviewStore = createPublicationReviewOperations(
  db,
  transaction,
  publicationStore.getPublicationSnapshot,
  textGenerationStore.readTextGenerationJob,
);
const taskContextStore = createTaskContextOperations(db, {
  publication: publicationStore.getPublication,
  reviews: publicationReviewStore.getPublicationReviews,
});
const publicationConversationStore = createPublicationConversationOperations(db, transaction, {
  text: textGenerationStore,
  publication: publicationStore,
  review: publicationReviewStore,
  image: generationStore,
  catalog: listMerchantCatalog,
  context: taskContextStore,
});
const topicStore = createTopicOperations(
  db,
  transaction,
  researchStore.getResearchReport,
  researchStore.getResearchBatch,
  textGenerationStore.readTextGenerationJob,
);

/** 序列化持久化字段并保持统一 JSON 格式。 */
function json(value: unknown): string {
  return JSON.stringify(value);
}

/** 计算幂等请求内容哈希，识别同键异参。 */
function operationHash(value: unknown): string {
  return createHash("sha256").update(json(value)).digest("hex");
}

/** 将委派数据库行还原为公共记录。 */
function delegation(row: Row) {
  return {
    ...(row.research_memory_json
      ? { researchMemory: JSON.parse(String(row.research_memory_json)) as ResearchMemorySnapshot }
      : {}),
    delegationId: String(row.delegation_id),
    parentSessionId: String(row.parent_session_id),
    parentRunId: String(row.parent_run_id),
    taskKey: String(row.task_key),
    childSessionId: String(row.child_session_id),
    childRunId: String(row.child_run_id),
    targetExpertId: String(row.target_expert_id) as DelegationRecord["targetExpertId"],
    inputHash: String(row.input_hash),
    input: JSON.parse(String(row.input_json)) as DelegationRecord["input"],
    inputSnapshot: row.input_snapshot_json
      ? (JSON.parse(String(row.input_snapshot_json)) as DelegationRecord["inputSnapshot"])
      : null,
    status: row.status,
    questionText: row.question_text ? String(row.question_text) : null,
    answerText: row.answer_text ? String(row.answer_text) : null,
    result: row.result_json ? JSON.parse(String(row.result_json)) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    attempt: Number(row.attempt),
    resultSubmittedAt: row.result_submitted_at ? String(row.result_submitted_at) : null,
    parentAckAt: row.parent_ack_at ? String(row.parent_ack_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 读取全局系统提示词数据库行并还原类型。 */
function systemPrompt(): SystemPromptSetting {
  const row = db.prepare("SELECT * FROM global_system_prompt WHERE id = 1").get() as Row;
  return {
    content: String(row.content),
    revision: Number(row.revision),
    sha256: String(row.sha256),
    updatedAt: String(row.updated_at),
  };
}

/** 将商家主表记录映射为页面和运行时共用对象。 */
function merchant(row: Row) {
  return {
    merchantId: String(row.merchant_id),
    name: String(row.name),
    status: "ACTIVE" as const,
    profileRevision: Number(row.profile_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 将人工档案数据库行映射为可返回字段。 */
function merchantProfile(row: Row) {
  return {
    merchantId: String(row.merchant_id),
    revision: Number(row.revision),
    fields: JSON.parse(String(row.fields_json)) as MerchantProfileFields,
    sha256: String(row.sha256),
    createdAt: String(row.created_at),
  };
}

/** 将一版商品或选题来源还原为可核对归属的记录。 */
function merchantCatalogEntry(row: Row): MerchantCatalogEntry {
  const fields = {
    name: String(row.name),
    detail: String(row.detail),
    sourceUrl: row.source_url === null ? null : String(row.source_url),
    evidenceId: row.evidence_id === null ? null : String(row.evidence_id),
    observedAt: row.observed_at === null ? null : String(row.observed_at),
    provenance: String(row.provenance) as MerchantCatalogEntry["provenance"],
    status: String(row.status) as MerchantCatalogEntry["status"],
  };
  if (sha256(json(fields)) !== row.sha256) throw new Error("MERCHANT_CATALOG_INVALID");
  return {
    entryId: String(row.entry_id),
    merchantId: String(row.merchant_id),
    kind: String(row.kind) as MerchantCatalogEntry["kind"],
    revision: Number(row.revision),
    ...fields,
    sha256: String(row.sha256),
    createdAt: String(row.entry_created_at),
    updatedAt: String(row.created_at),
  };
}

/** 按商家和版本读取商品及选题线索，旧版供已受理 Run 继续使用。 */
function catalogVersion(merchantId: string, entryId: string, revision?: number): MerchantCatalogEntry | null {
  const row = db
    .prepare(`SELECT e.merchant_id, e.kind, e.created_at AS entry_created_at, v.*
    FROM merchant_catalog_entry e JOIN merchant_catalog_revision v ON v.entry_id = e.entry_id
    WHERE e.merchant_id = ? AND e.entry_id = ? AND v.revision = COALESCE(?, e.revision)`)
    .get(merchantId, entryId, revision ?? null) as Row | undefined;
  return row ? merchantCatalogEntry(row) : null;
}

/** 列出商家当前有效的商品和选题线索，其他商家记录永不混入。 */
function listMerchantCatalog(merchantId: string): MerchantCatalogEntry[] {
  return (
    db
      .prepare(`SELECT e.merchant_id, e.kind, e.created_at AS entry_created_at, v.*
    FROM merchant_catalog_entry e JOIN merchant_catalog_revision v ON v.entry_id = e.entry_id AND v.revision = e.revision
    WHERE e.merchant_id = ? AND e.status = 'ACTIVE' ORDER BY e.updated_at DESC, e.entry_id DESC`)
      .all(merchantId) as Row[]
  ).map(merchantCatalogEntry);
}

/** 规范化目录输入，并把公开证据的真实来源时间写入条目。 */
function catalogFields(merchantId: string, input: MerchantCatalogInput, status: "ACTIVE" | "INACTIVE") {
  const name = input.name.trim();
  const detail = input.detail.trim();
  let sourceUrl = input.sourceUrl?.trim() || null;
  const evidenceId = input.evidenceId?.trim() || null;
  let observedAt = input.observedAt || null;
  if (!name || name.length > 120 || detail.length > 2000) throw new Error("MERCHANT_CATALOG_INPUT_INVALID");
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("INVALID_URL");
      sourceUrl = url.toString();
    } catch {
      throw new Error("MERCHANT_CATALOG_INPUT_INVALID");
    }
  }
  if (observedAt && (!Number.isFinite(Date.parse(observedAt)) || observedAt.length > 40))
    throw new Error("MERCHANT_CATALOG_INPUT_INVALID");
  if (evidenceId) {
    const evidence = db
      .prepare(
        "SELECT merchant_id, status, source_url, collected_at FROM merchant_public_evidence WHERE evidence_id = ?",
      )
      .get(evidenceId) as Row | undefined;
    if (
      !evidence ||
      evidence.merchant_id !== merchantId ||
      evidence.status !== "COLLECTED" ||
      (sourceUrl && sourceUrl !== evidence.source_url)
    )
      throw new Error("MERCHANT_CATALOG_EVIDENCE_INVALID");
    sourceUrl = String(evidence.source_url);
    observedAt = String(evidence.collected_at);
  }
  const provenance: MerchantCatalogEntry["provenance"] =
    input.kind === "PRODUCT" || input.kind === "MERCHANT_UPDATE"
      ? "MERCHANT_CONFIRMED"
      : evidenceId
        ? "PUBLIC_EVIDENCE"
        : "USER_PROVIDED_LEAD";
  return { name, detail, sourceUrl, evidenceId, observedAt, provenance, status };
}

/** 将平台链接数据库行映射为公共对象。 */
function merchantLink(row: Row) {
  return {
    linkId: String(row.link_id),
    merchantId: String(row.merchant_id),
    revision: Number(row.revision),
    platform: String(row.platform),
    kind: row.kind as MerchantPlatformLink["kind"],
    url: String(row.url),
    label: String(row.label),
    status: row.status as MerchantPlatformLink["status"],
    collectionStatus: "UNFETCHED" as const,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 读取平台链接当前版本以便校验归属和版本。 */
function currentMerchantLink(linkId: string): Row | undefined {
  return db
    .prepare(`SELECT l.*, v.platform, v.kind, v.url, v.label
    FROM merchant_platform_link l JOIN merchant_platform_link_revision v
      ON v.link_id = l.link_id AND v.revision = l.revision
    WHERE l.link_id = ?`)
    .get(linkId) as Row | undefined;
}

/** 合并商家主表、档案与链接得到完整商家资料。 */
function merchantDetail(merchantId: string) {
  const row = db.prepare("SELECT * FROM merchant WHERE merchant_id = ? AND status = 'ACTIVE'").get(merchantId) as
    | Row
    | undefined;
  if (!row) return null;
  const profile = db
    .prepare("SELECT * FROM merchant_profile_revision WHERE merchant_id = ? AND revision = ?")
    .get(merchantId, row.profile_revision as number) as Row;
  const links = db
    .prepare(`SELECT l.*, v.platform, v.kind, v.url, v.label
    FROM merchant_platform_link l JOIN merchant_platform_link_revision v
      ON v.link_id = l.link_id AND v.revision = l.revision
    WHERE l.merchant_id = ? AND l.status = 'ACTIVE' ORDER BY l.rowid`)
    .all(merchantId) as Row[];
  return { merchant: merchant(row), profile: merchantProfile(profile), links: links.map(merchantLink) };
}

/** 在消息受理时持久化商家资料冻结快照。 */
function createMerchantContextSnapshot(
  merchantId: string,
  now: string,
  includeMemories: boolean,
  researchScope?: ResearchScope,
  memoryProduct: MemoryProductRef | null = null,
) {
  const detail = merchantDetail(merchantId);
  if (!detail) throw new Error("MERCHANT_NOT_FOUND");
  // 只保存版本引用；历史档案和链接版本保留，排队中的 Run 才能按受理时资料读取。
  const linkRefs = detail.links.map((link) => ({ linkId: link.linkId, revision: link.revision }));
  const catalogRefs = listMerchantCatalog(merchantId).map((item) => ({
    entryId: item.entryId,
    revision: item.revision,
    sha256: item.sha256,
  }));
  const snapshotId = `mcs_${randomUUID()}`;
  const memoryScope: MemoryScope = { version: 1, product: memoryProduct };
  if (researchScope) researchStore.validateResearchScope(merchantId, researchScope);
  const researchRefs = researchStore
    .listResearchLibrary(merchantId)
    .filter((item) => item.status === "ACTIVE" && (!item.expiresAt || Date.parse(item.expiresAt) > Date.parse(now)))
    .map((item) => ({ itemId: item.itemId, revision: item.revision, sha256: item.sha256, stale: item.stale }));
  const memoryRefs = includeMemories
    ? memoryStore
        .listMemories(merchantId)
        .filter((item) => item.status === "ACTIVE" && (!item.expiresAt || item.expiresAt > now))
        .filter((item) => isMemoryApplicable(item, memoryScope))
        .map((item) => ({ memoryId: item.memoryId, revision: item.revision, sha256: item.sha256 }))
    : undefined;
  const body = {
    merchantId,
    profileRevision: detail.profile.revision,
    linkRefs,
    diagnosisReportId: null,
    catalogRefs,
    ...(memoryRefs !== undefined && { memoryRefs }),
    ...(researchScope && { researchScope }),
    researchRefs,
    memoryScope,
  };
  const hash = sha256(json(body));
  db.prepare(`INSERT INTO merchant_context_snapshot
    (snapshot_id, merchant_id, profile_revision, link_refs_json, diagnosis_report_id, sha256, created_at, memory_refs_json, catalog_refs_json, research_scope_json, research_refs_json, memory_scope_json)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
    snapshotId,
    merchantId,
    detail.profile.revision,
    json(linkRefs),
    hash,
    now,
    memoryRefs === undefined ? null : json(memoryRefs),
    json(catalogRefs),
    researchScope ? json(researchScope) : null,
    json(researchRefs),
    json(memoryScope),
  );
  return { snapshotId, sha256: hash };
}

/** 还原冻结快照供 Run 使用。 */
function merchantContextSnapshot(snapshotId: string): StoredMerchantContextSnapshot | null {
  const snapshot = db.prepare("SELECT * FROM merchant_context_snapshot WHERE snapshot_id = ?").get(snapshotId) as
    | Row
    | undefined;
  if (!snapshot) return null;
  const merchantId = String(snapshot.merchant_id);
  const linkRefs = JSON.parse(String(snapshot.link_refs_json)) as Array<{ linkId: string; revision: number }>;
  // 旧快照保持原哈希与权限，不为旧 Run 补入新商家记忆。
  const memoryRefs =
    snapshot.memory_refs_json === null
      ? undefined
      : (JSON.parse(String(snapshot.memory_refs_json)) as Array<{
          memoryId: string;
          revision: number;
          sha256: string;
        }>);
  const catalogRefs =
    snapshot.catalog_refs_json === null
      ? undefined
      : (JSON.parse(String(snapshot.catalog_refs_json)) as Array<{
          entryId: string;
          revision: number;
          sha256: string;
        }>);
  const body = {
    merchantId,
    profileRevision: Number(snapshot.profile_revision),
    linkRefs,
    diagnosisReportId: snapshot.diagnosis_report_id ?? null,
    ...(catalogRefs !== undefined && { catalogRefs }),
    ...(memoryRefs !== undefined && { memoryRefs }),
    ...(snapshot.research_scope_json !== null && {
      researchScope: JSON.parse(String(snapshot.research_scope_json)) as ResearchScope,
    }),
    ...(snapshot.research_refs_json !== null && {
      researchRefs: JSON.parse(String(snapshot.research_refs_json)) as Array<{
        itemId: string;
        revision: number;
        sha256: string;
        stale: boolean;
      }>,
    }),
    ...(snapshot.memory_scope_json !== null && {
      memoryScope: JSON.parse(String(snapshot.memory_scope_json)) as MemoryScope,
    }),
  };
  if (sha256(json(body)) !== snapshot.sha256) throw new Error("MERCHANT_CONTEXT_INVALID");
  const profileRow = db
    .prepare("SELECT * FROM merchant_profile_revision WHERE merchant_id = ? AND revision = ?")
    .get(merchantId, body.profileRevision) as Row | undefined;
  if (!profileRow) throw new Error("MERCHANT_CONTEXT_MISSING");
  const profile = merchantProfile(profileRow);
  if (sha256(json(profile.fields)) !== profile.sha256) throw new Error("MERCHANT_CONTEXT_INVALID");
  const links = linkRefs.map(({ linkId, revision }) => {
    const row = db
      .prepare(`SELECT l.merchant_id, l.created_at AS link_created_at, v.* FROM merchant_platform_link l
      JOIN merchant_platform_link_revision v ON v.link_id = l.link_id
      WHERE l.link_id = ? AND v.revision = ? AND l.merchant_id = ?`)
      .get(linkId, revision, merchantId) as Row | undefined;
    if (!row) throw new Error("MERCHANT_CONTEXT_MISSING");
    const fields = {
      platform: String(row.platform),
      kind: String(row.kind),
      url: String(row.url),
      label: String(row.label),
    };
    if (sha256(json(fields)) !== row.sha256 || row.status !== "ACTIVE") throw new Error("MERCHANT_CONTEXT_INVALID");
    return merchantLink({ ...row, created_at: row.link_created_at, updated_at: row.created_at });
  });
  const memories = memoryRefs?.map((ref) => {
    const item = memoryStore.readMemoryVersion(merchantId, ref.memoryId, ref.revision);
    if (
      item.sha256 !== ref.sha256 ||
      item.status !== "ACTIVE" ||
      (item.expiresAt && item.expiresAt <= String(snapshot.created_at)) ||
      (body.memoryScope && !isMemoryApplicable(item, body.memoryScope))
    )
      throw new Error("MERCHANT_CONTEXT_INVALID");
    return item;
  });
  const catalog = catalogRefs?.map((ref) => {
    const item = catalogVersion(merchantId, ref.entryId, ref.revision);
    if (!item || item.sha256 !== ref.sha256 || item.status !== "ACTIVE") throw new Error("MERCHANT_CONTEXT_INVALID");
    return item;
  });
  const researchLibrary = body.researchRefs?.map((ref) => {
    const item = researchStore.readResearchVersion(merchantId, ref.itemId, ref.revision);
    if (!item || item.sha256 !== ref.sha256 || item.status !== "ACTIVE") throw new Error("MERCHANT_CONTEXT_INVALID");
    return { ...item, stale: ref.stale };
  });
  return {
    snapshotId,
    merchantId,
    sha256: String(snapshot.sha256),
    profile,
    links,
    ...(memories !== undefined && { memories }),
    ...(body.memoryScope && { memoryScope: body.memoryScope }),
    ...(catalog !== undefined && { catalog }),
    ...(body.researchScope && { researchScope: body.researchScope }),
    ...(researchLibrary !== undefined && { researchLibrary }),
  };
}

/** 将公开页面数据库行还原为带来源的证据记录。 */
function publicEvidence(row: Row) {
  const visibleText = String(row.visible_text);
  const visibleTextSha256 = String(row.visible_text_sha256 ?? "");
  if (visibleTextSha256 !== sha256(visibleText)) throw new Error("PUBLIC_EVIDENCE_INVALID");
  return {
    evidenceId: String(row.evidence_id),
    merchantId: row.merchant_id === null ? null : String(row.merchant_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    sourceUrl: String(row.source_url),
    finalUrl: row.final_url ? String(row.final_url) : null,
    title: String(row.title),
    visibleText,
    visibleTextSha256,
    accessMode: String(row.access_mode) as CollectedPublicPage["accessMode"],
    links: JSON.parse(String(row.links_json)) as Array<{ text: string; url: string }>,
    status: String(row.status) as CollectedPublicPage["status"],
    errorCode: row.error_code ? String(row.error_code) : null,
    collectedAt: String(row.collected_at),
    ...(Boolean(row.images_json && row.images_json !== "[]") && {
      images: JSON.parse(String(row.images_json)) as NonNullable<CollectedPublicPage["images"]>,
    }),
    ...(Boolean(row.image_capture_error) && { imageCaptureError: String(row.image_capture_error) }),
  };
}

/** 从证据记录提取不可变的诊断来源引用。 */
function diagnosisEvidenceRef(evidence: ReturnType<typeof publicEvidence>): AccountDiagnosisEvidenceRef {
  return {
    evidenceId: evidence.evidenceId,
    visibleTextSha256: evidence.visibleTextSha256,
    sourceUrl: evidence.sourceUrl,
    finalUrl: evidence.finalUrl,
    collectedAt: evidence.collectedAt,
    accessMode: evidence.accessMode,
  };
}

/** 还原账号诊断草稿及其版本、来源快照。 */
function accountDiagnosis(row: Row) {
  return {
    diagnosisId: String(row.diagnosis_id),
    merchantId: row.merchant_id === null ? null : String(row.merchant_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    profileRevision: row.profile_revision === null ? null : Number(row.profile_revision),
    version: Number(row.version),
    revisesDiagnosisId: row.revises_diagnosis_id === null ? null : String(row.revises_diagnosis_id),
    evidenceIds: JSON.parse(String(row.evidence_ids_json)) as string[],
    evidenceRefs: JSON.parse(String(row.evidence_refs_json ?? "[]")) as AccountDiagnosisEvidenceRef[],
    report: JSON.parse(String(row.report_json)) as AccountDiagnosisDraft,
    status: "DRAFT" as const,
    createdAt: String(row.created_at),
  };
}

/** 将已登记的公开资料报告行还原为共享记录。 */
function publicDiagnosisReport(row: Row) {
  return {
    reportId: String(row.report_id),
    merchantId: String(row.merchant_id),
    diagnosisId: String(row.diagnosis_id),
    sourceVersion: Number(row.source_version),
    artifactId: String(row.artifact_id),
    blobHash: String(row.blob_hash),
    createdAt: String(row.created_at),
  };
}

/** 确认证据写入 Run 与当前会话或商家归属一致。 */
function requireEvidenceRun(merchantId: string | null, sessionId: string, runId: string): void {
  const row = db
    .prepare(`SELECT s.session_id FROM session s JOIN agent_run r ON r.session_id = s.session_id
    WHERE s.session_id = ? AND s.lifecycle_status = 'ACTIVE'
      AND ((? IS NULL AND s.scope = 'NORMAL' AND s.owner_id = 'local')
        OR (? IS NOT NULL AND s.scope = 'MERCHANT' AND s.owner_id = ?))
      AND r.run_id = ? AND r.status = 'RUNNING' AND r.cancel_requested_at IS NULL`)
    .get(sessionId, merchantId, merchantId, merchantId, runId);
  if (!row) throw new Error("TOOL_MERCHANT_NOT_AUTHORIZED");
}

/** 按幂等键核验历史请求并返回可复用的结果。 */
function previousOperation(operationKey: string, kind: string, requestHash: string): unknown | null {
  // 同一个幂等键只能重放同类型、同内容的请求。
  const row = db
    .prepare("SELECT kind, result_json, request_hash FROM api_operation WHERE operation_key = ?")
    .get(operationKey) as Row | undefined;
  if (!row) return null;
  if (row.kind !== kind || (row.request_hash !== null && row.request_hash !== requestHash)) {
    throw new Error("IDEMPOTENCY_CONFLICT");
  }
  return JSON.parse(String(row.result_json));
}

/** 禁止在待清理 Blob 上登记新产物，避免删除与并发上传交错。 */
function requireBlobNotCollecting(hash: string): void {
  if (db.prepare("SELECT 1 FROM blob_gc WHERE blob_hash = ?").get(hash)) throw new Error("BLOB_GC_IN_PROGRESS");
}

/** 将会话数据库行还原为内部会话对象。 */
function session(row: Row) {
  const unread = db
    .prepare(`SELECT COUNT(*) AS count FROM message
    WHERE session_id = ? AND role = 'assistant' AND rowid > COALESCE(
      (SELECT message_rowid FROM session_read_cursor WHERE session_id = ?), 0)`)
    .get(String(row.session_id), String(row.session_id)) as Row;
  const firstUnread = db
    .prepare(`SELECT message_id FROM message
    WHERE session_id = ? AND role = 'assistant' AND rowid > COALESCE(
      (SELECT message_rowid FROM session_read_cursor WHERE session_id = ?), 0)
    ORDER BY rowid LIMIT 1`)
    .get(String(row.session_id), String(row.session_id)) as Row | undefined;
  return {
    sessionId: row.session_id,
    scope: row.scope,
    ownerId: row.owner_id,
    title: row.title,
    modelAlias: row.model_alias,
    piSessionFile: row.pi_session_file,
    lifecycleStatus: row.lifecycle_status,
    ...(row.research_scope_json ? { researchScope: JSON.parse(String(row.research_scope_json)) as ResearchScope } : {}),
    titleRevision: row.title_revision,
    unreadCount: Number(unread.count),
    firstUnreadMessageId: firstUnread ? String(firstUnread.message_id) : null,
    deletedAt: row.deleted_at,
    trashExpiresAt: row.trash_expires_at,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 将 Run 数据库行还原为公共运行状态。 */
function run(row: Row) {
  let plan: {
    schemaVersion?: number;
    modelAlias?: string;
    adapterVersion?: string;
    modelFingerprint?: string;
    model?: { modelId: string; configFingerprint: string };
    runtime?: { adapterVersion: string };
  };
  try {
    plan = JSON.parse(String(row.runtime_plan_json));
  } catch {
    plan = {};
  }
  if (!plan || typeof plan !== "object") plan = {};
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    status: row.status,
    attempt: row.attempt,
    modelAlias: (plan.schemaVersion ? plan.model?.modelId : plan.modelAlias) ?? "invalid",
    adapterVersion: plan.schemaVersion ? plan.runtime?.adapterVersion : plan.adapterVersion,
    modelFingerprint: plan.schemaVersion ? plan.model?.configFingerprint : plan.modelFingerprint,
    usage: row.usage_json ? JSON.parse(String(row.usage_json)) : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    cancelRequestedAt: row.cancel_requested_at,
    runtimeSnapshotRef: row.runtime_snapshot_ref,
    runtimeSnapshotHash: row.runtime_snapshot_hash ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 页面只展示任务意图和结果入口；完整冻结提示与结构化回复仍在原始消息中供运行和校验读取。 */
function taskPresentation(runId: string | null, role: string, text: string): string {
  if (!runId) return text;
  const job = db
    .prepare("SELECT purpose, title, source_json, model_version FROM generation_job WHERE source_run_id = ?")
    .get(runId) as Row | undefined;
  const source = job?.source_json ? JSON.parse(String(job.source_json)) : null;
  if (job?.purpose === "RESEARCH") return "";
  // 唤醒输入属于Host通知，助手的续执行答复仍在原聊天正常交付。
  if (job?.purpose === "RESEARCH_CONTINUATION") return role === "user" ? "" : text;
  if (job?.purpose === "PUBLICATION_SUMMARY") {
    if (role === "user") return "";
    try {
      return parseAsyncResultSummary(text);
    } catch {
      return "";
    }
  }
  // 后台编排的内部消息由持久结果卡展示，不能冒充用户又发了一条消息。
  const parentSource = source?.parentConversationJobId
    ? (db.prepare("SELECT source_json FROM generation_job WHERE job_id=?").get(source.parentConversationJobId) as
        | Row
        | undefined)
    : undefined;
  if (source?.originRunId || (parentSource && JSON.parse(String(parentSource.source_json)).originRunId)) return "";
  const conversation = source?.conversation;
  if (conversation && role === "user") return String(conversation.instruction);
  if (source?.repair)
    return role === "user" ? "请只修正当前审核选中的问题。" : "局部返修结果已返回，保存后交独立审核复审。";
  if (job?.purpose === "PUBLICATION_CHAT" && role === "assistant") {
    try {
      return parsePublicationConversation(text).reply;
    } catch {
      return "正在理解本次要求，执行进度请查看当前聊天的图文任务。";
    }
  }
  if (conversation && role === "assistant" && job?.model_version === CONTENT_OUTPUT_VERSION) {
    try {
      return parseContentOutput(text).reply ?? "本篇对话已返回，请在当前聊天或图文预览查看处理结果。";
    } catch {
      // 运行中的片段与失败的非法输出不能把原始JSON泄露成对话回复。
      return "正在处理本篇对话，最终结果请查看当前聊天的图文任务。";
    }
  }
  if (job?.purpose === "TOPIC_PLAN")
    return role === "user"
      ? "请根据本次商家资料或已选研究生成可编辑选题卡，保留来源和待核实项。"
      : "选题规划已返回。选题卡的保存状态和校验结果请查看下方选题面板。";
  if (job?.purpose === "PUBLICATION_REVIEW")
    return role === "user"
      ? "请独立核对当前图文并给出问题清单。"
      : "独立审核已返回，请在当前聊天的审核结果中核对适用版本。";
  if (job?.purpose === "PUBLICATION_PLAN")
    return role === "user"
      ? "请为这篇笔记规划配图和发布步骤。"
      : "配图与发布方案已返回。请在当前聊天或图文预览查看保存结果，制作图片并完成整套审核。";
  if (job?.model_version === CONTENT_OUTPUT_VERSION && role === "assistant")
    return "文案已返回，请在当前聊天或图文预览查看正文、内部说明与保存结果。";
  if ((job?.source_json || job?.model_version === CONTENT_OUTPUT_VERSION) && role === "user")
    return `请创作文案：${job.title}。使用已选选题、商品和本次明确授权的参考资料。`;
  return text;
}

/** 将消息数据库行还原为公共消息对象。 */
function message(row: Row) {
  const content = JSON.parse(String(row.content_json)) as { text: string; thinking?: string };
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    runId: row.run_id,
    role: row.role,
    content: taskPresentation(row.run_id ? String(row.run_id) : null, String(row.role), content.text),
    thinking: content.thinking ?? "",
    createdAt: row.created_at,
  };
}

/** 读取会话最近消息并支持向前分页。 */
function recentMessages(sessionId: string, limit: number, before: string | null) {
  // 优先使用消息 ID 游标；时间字符串游标保留给已有调用方。
  if (before?.startsWith("msg_")) {
    const cursor = db
      .prepare("SELECT rowid FROM message WHERE session_id = ? AND message_id = ?")
      .get(sessionId, before) as Row | undefined;
    if (!cursor) return [];
    const rows = db
      .prepare("SELECT * FROM message WHERE session_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
      .all(sessionId, cursor.rowid as number, limit);
    return (rows as Row[]).reverse().map(message);
  }
  const rows = before
    ? db
        .prepare("SELECT * FROM message WHERE session_id = ? AND created_at < ? ORDER BY rowid DESC LIMIT ?")
        .all(sessionId, before, limit)
    : db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT ?").all(sessionId, limit);
  return (rows as Row[]).reverse().map(message);
}

/** 汇总当前 Run 已持久化的思考增量。 */
function runThinking(runId: string): string {
  const attemptStart = runAttemptStartSeq(runId);
  const rows = db
    .prepare(
      "SELECT payload_json FROM runtime_event WHERE run_id = ? AND type = 'session.thinking.delta' AND seq > ? ORDER BY seq",
    )
    .all(runId, attemptStart) as Row[];
  return rows.map((row) => String((JSON.parse(String(row.payload_json)) as { text?: string }).text ?? "")).join("");
}

/** 找到当前 Run 尝试的起始事件序号。 */
function runAttemptStartSeq(runId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM runtime_event WHERE run_id = ? AND type IN ('session.execution.started', 'session.execution.retrying')",
    )
    .get(runId) as Row;
  return Number(row.seq);
}

/** 读取当前 Attempt 最新主会话计量，排除子专家及前次中断的用量。 */
function latestContextTokens(runId: string): ContextTokenMeasurement | null {
  const row = db
    .prepare(`SELECT payload_json FROM runtime_event
    WHERE run_id = ? AND seq > ? AND type = 'session.context.measured'
    AND json_extract(payload_json, '$.delegationId') IS NULL ORDER BY seq DESC LIMIT 1`)
    .get(runId, runAttemptStartSeq(runId)) as Row | undefined;
  return row ? (JSON.parse(String(row.payload_json)) as ContextTokenMeasurement) : null;
}

/** 将事件数据库行还原为公共运行事件。 */
function event(row: Row) {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(String(row.payload_json)),
    occurredAt: row.occurred_at,
  };
}

/** 按会话序号插入事件并维持顺序。 */
function insertEvent(
  sessionId: string,
  runId: string | null,
  eventId: string,
  type: string,
  payload: Record<string, unknown>,
  now: string,
) {
  if (type === "session.message.delta" && runId) {
    const job = db.prepare("SELECT purpose,model_version FROM generation_job WHERE source_run_id = ?").get(runId) as
      | Row
      | undefined;
    if (
      job?.purpose === "PUBLICATION_SUMMARY" ||
      job?.purpose === "RESEARCH" ||
      job?.purpose === "TOPIC_PLAN" ||
      job?.purpose === "PUBLICATION_PLAN" ||
      job?.purpose === "PUBLICATION_REVIEW" ||
      job?.purpose === "PUBLICATION_CHAT" ||
      job?.model_version === CONTENT_OUTPUT_VERSION ||
      job?.model_version === PUBLICATION_REPAIR_VERSION
    )
      payload = { ...payload, text: "" };
  }
  if (type === "session.message.completed")
    payload = { ...payload, text: taskPresentation(runId, "assistant", String(payload.text ?? "")) };
  // 序号和事件在同一事务内写入，供客户端检测缺失事件。
  db.prepare("UPDATE session SET last_seq = last_seq + 1, updated_at = ? WHERE session_id = ?").run(now, sessionId);
  const seq = Number((db.prepare("SELECT last_seq FROM session WHERE session_id = ?").get(sessionId) as Row).last_seq);
  db.prepare(
    "INSERT INTO runtime_event (event_id, session_id, run_id, seq, type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(eventId, sessionId, runId, seq, type, json(payload), now);
  return { eventId, sessionId, runId, seq, type, payload, occurredAt: now };
}

/** 校验运行事件或提交仍属于当前执行尝试，阻止旧回调污染恢复后的任务。 */
function requireRunAttempt(runId: string, expectedAttempt: number, sessionId?: string): void {
  const target = db.prepare("SELECT session_id, status, attempt FROM agent_run WHERE run_id = ?").get(runId) as
    | Row
    | undefined;
  if (
    target?.status !== "RUNNING" ||
    Number(target.attempt) !== expectedAttempt ||
    (sessionId && target.session_id !== sessionId)
  )
    throw new Error("RUN_ATTEMPT_STALE");
}

/** Worker 对外提供的数据库操作；复合写入在各自事务中完成。 */
const operations = {
  ...generationStore,
  ...textGenerationStore,
  ...topicStore,
  ...memoryStore,
  ...createMemoryEmbeddingOperations(db, transaction),
  ...capabilityStore,
  ...workbenchStore,
  ...taskExecutionStore,
  ...asyncResultStore,
  ...researchAgentStore,
  /** 从原Job和消息构建有界主历史导航。 */
  readMainHistoryView: (sessionId: string) => readMainHistoryView(db, sessionId),
  /** 分段回读同会话不可变任务来源和成功结果。 */
  readTaskHistory: (sessionId: string, jobId: string, section: "INPUT" | "RESULT", offset: number, limit: number) =>
    readTaskHistory(db, sessionId, jobId, section, offset, limit),
  ...contentStore,
  ...publicationStore,
  ...publicationReviewStore,
  ...publicationConversationStore,
  getTaskContextSnapshot: taskContextStore.getTaskContextSnapshot,
  getTaskContextView: taskContextStore.getTaskContextView,
  /** 只供内部委派恢复读取已持久化的子 Plan，不能改用当前配置重建。 */
  getDelegationPlan: (delegationId: string) => {
    const row = db.prepare("SELECT child_plan_json FROM delegation WHERE delegation_id=?").get(delegationId) as
      | Row
      | undefined;
    return row?.child_plan_json ? readRuntimePlan(String(row.child_plan_json)) : null;
  },
  /** 进度读取不授予权限，先校验主执行与可选子尝试仍持有本次冻结引用。 */
  getCurrentTaskStatus: (sessionId: string, request: CurrentTaskStatusRequest) =>
    transaction(() => {
      requireRunAttempt(request.runId, request.attempt, sessionId);
      const run = db
        .prepare("SELECT status,cancel_requested_at,runtime_plan_json FROM agent_run WHERE run_id=? AND session_id=?")
        .get(request.runId, sessionId) as Row;
      const plan = readRuntimePlan(String(run.runtime_plan_json));
      if (run.status !== "RUNNING" || run.cancel_requested_at) throw new Error("RUN_CANCELLED");
      if (!plan?.taskContext || canonicalJson(plan.taskContext) !== canonicalJson(request.taskContext))
        throw new Error("TASK_CONTEXT_SOURCE_INVALID");
      if (request.delegationId) {
        const child = db
          .prepare("SELECT status,attempt,parent_run_id FROM delegation WHERE delegation_id=? AND parent_session_id=?")
          .get(request.delegationId, sessionId) as Row | undefined;
        if (
          child?.parent_run_id !== request.runId ||
          !["RUNNING", "SUCCEEDED"].includes(String(child.status)) ||
          child.attempt !== request.delegationAttempt
        )
          throw new Error("DELEGATION_NOT_RUNNING");
      }
      return taskContextStore.getCurrentTaskStatus(sessionId, request.taskContext);
    }),
  ...researchStore,
  /** 关闭 SQLite 连接并完成 Worker 收尾。 */
  close: () => {
    db.close();
    return true;
  },
  /** 检查数据库完整性和已应用的迁移版本。 */
  health: () => ({
    quickCheck: (db.prepare("PRAGMA quick_check").get() as Row).quick_check,
    schemaVersion: migrations.at(-1)?.version ?? 0,
  }),
  getSystemPrompt: systemPrompt,
  /** 创建商家及初始人工档案。 */
  createMerchant: (merchantId: string, name: string, operationKey: string, now: string) =>
    transaction(() => {
      const normalized = name.trim();
      if (!normalized || normalized.length > 120) throw new Error("MERCHANT_INPUT_INVALID");
      const requestHash = operationHash({ name: normalized });
      const previous = previousOperation(operationKey, "createMerchant", requestHash);
      if (previous) return previous;
      const fields: MerchantProfileFields = {
        name: normalized,
        industry: "",
        serviceArea: "",
        products: "",
        audience: "",
        goals: "",
        voice: "",
        constraints: "",
      };
      db.prepare(
        "INSERT INTO merchant (merchant_id, name, status, created_at, updated_at) VALUES (?, ?, 'ACTIVE', ?, ?)",
      ).run(merchantId, normalized, now, now);
      db.prepare(`INSERT INTO merchant_profile_revision (merchant_id, revision, fields_json, sha256, created_at)
      VALUES (?, 1, ?, ?, ?)`).run(merchantId, json(fields), sha256(json(fields)), now);
      const result = merchantDetail(merchantId);
      db.prepare(`INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at)
      VALUES (?, 'createMerchant', ?, ?, ?)`).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 列出本机维护的商家摘要。 */
  listMerchants: () =>
    (db.prepare("SELECT * FROM merchant WHERE status = 'ACTIVE' ORDER BY updated_at DESC").all() as Row[]).map(
      merchant,
    ),
  getMerchant: merchantDetail,
  listMerchantCatalog,
  /** 在商家归属下保存一条人工商品或有来源的选题线索。 */
  createMerchantCatalogEntry: (
    merchantId: string,
    entryId: string,
    input: MerchantCatalogInput,
    operationKey: string,
    now: string,
  ) =>
    transaction(() => {
      if (!merchantDetail(merchantId)) throw new Error("MERCHANT_NOT_FOUND");
      const fields = catalogFields(merchantId, input, "ACTIVE");
      const requestHash = operationHash({ merchantId, kind: input.kind, fields });
      const previous = previousOperation(operationKey, "createMerchantCatalogEntry", requestHash);
      if (previous) return previous;
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM merchant_catalog_entry WHERE merchant_id = ? AND status = 'ACTIVE'")
        .get(merchantId) as Row;
      if (Number(count.count) >= 100) throw new Error("MERCHANT_CATALOG_LIMIT");
      db.prepare(`INSERT INTO merchant_catalog_entry
        (entry_id, merchant_id, kind, revision, status, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'ACTIVE', ?, ?)`).run(entryId, merchantId, input.kind, now, now);
      db.prepare(`INSERT INTO merchant_catalog_revision
        (entry_id, revision, name, detail, source_url, evidence_id, observed_at, provenance, status, sha256, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(
        entryId,
        fields.name,
        fields.detail,
        fields.sourceUrl,
        fields.evidenceId,
        fields.observedAt,
        fields.provenance,
        sha256(json(fields)),
        now,
      );
      const result = catalogVersion(merchantId, entryId);
      db.prepare(`INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at)
        VALUES (?, 'createMerchantCatalogEntry', ?, ?, ?)`).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 追加修订或停用商品/线索，旧版保留给已受理的任务。 */
  updateMerchantCatalogEntry: (
    merchantId: string,
    entryId: string,
    expectedRevision: number,
    input: MerchantCatalogInput,
    status: "ACTIVE" | "INACTIVE",
    operationKey: string,
    now: string,
  ) =>
    transaction(() => {
      const fields = catalogFields(merchantId, input, status);
      const requestHash = operationHash({ merchantId, entryId, expectedRevision, fields });
      const previous = previousOperation(operationKey, "updateMerchantCatalogEntry", requestHash);
      if (previous) return previous;
      const current = catalogVersion(merchantId, entryId);
      if (current?.status !== "ACTIVE") throw new Error("MERCHANT_CATALOG_NOT_FOUND");
      if (current.revision !== expectedRevision) throw new Error("MERCHANT_CATALOG_REVISION_CONFLICT");
      if (input.kind !== current.kind) throw new Error("MERCHANT_CATALOG_INPUT_INVALID");
      const revision = expectedRevision + 1;
      db.prepare(`INSERT INTO merchant_catalog_revision
        (entry_id, revision, name, detail, source_url, evidence_id, observed_at, provenance, status, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        entryId,
        revision,
        fields.name,
        fields.detail,
        fields.sourceUrl,
        fields.evidenceId,
        fields.observedAt,
        fields.provenance,
        status,
        sha256(json(fields)),
        now,
      );
      db.prepare("UPDATE merchant_catalog_entry SET revision = ?, status = ?, updated_at = ? WHERE entry_id = ?").run(
        revision,
        status,
        now,
        entryId,
      );
      const result = catalogVersion(merchantId, entryId);
      db.prepare(`INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at)
        VALUES (?, 'updateMerchantCatalogEntry', ?, ?, ?)`).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  getMerchantContextSnapshot: merchantContextSnapshot,
  /** 保存公开页面的原始可见内容与来源信息。 */
  createPublicEvidence: (
    evidenceId: string,
    merchantId: string | null,
    sessionId: string,
    runId: string,
    page: CollectedPublicPage,
  ) =>
    transaction(() => {
      requireEvidenceRun(merchantId, sessionId, runId);
      const existing = db
        .prepare("SELECT * FROM merchant_public_evidence WHERE run_id = ? AND source_url = ?")
        .get(runId, page.sourceUrl) as Row | undefined;
      if (existing) return publicEvidence(existing);
      const images = page.images ?? [];
      if (images.length > 3 || (images.length && !["COLLECTED", "LIMITED"].includes(page.status)))
        throw new Error("PUBLIC_IMAGE_INVALID");
      for (const image of images) {
        if (
          !/^art_[a-f0-9-]+$/.test(image.artifactId) ||
          !/^[a-f0-9]{64}$/.test(image.blobHash) ||
          image.mimeType !== "image/png" ||
          image.captureKind !== "PAGE_IMAGE_SCREENSHOT" ||
          !Number.isInteger(image.sizeBytes) ||
          image.sizeBytes <= 0 ||
          image.sizeBytes > 2 * 1024 * 1024
        )
          throw new Error("PUBLIC_IMAGE_INVALID");
        requireBlobNotCollecting(image.blobHash);
        db.prepare(`INSERT INTO artifact (artifact_id,session_id,kind,title,blob_hash,mime_type,size_bytes,status,created_at)
          VALUES (?,?,'public_reference_image',?,?,?,?,'READY',?)`).run(
          image.artifactId,
          sessionId,
          image.description.slice(0, 200),
          image.blobHash,
          image.mimeType,
          image.sizeBytes,
          page.collectedAt,
        );
      }
      db.prepare(`INSERT INTO merchant_public_evidence
      (evidence_id, merchant_id, session_id, run_id, source_url, final_url, title, visible_text,
        visible_text_sha256, access_mode, links_json, status, error_code, collected_at, images_json, image_capture_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        evidenceId,
        merchantId,
        sessionId,
        runId,
        page.sourceUrl,
        page.finalUrl,
        page.title,
        page.visibleText,
        sha256(page.visibleText),
        page.accessMode,
        json(page.links),
        page.status,
        page.errorCode,
        page.collectedAt,
        json(images),
        page.imageCaptureError ?? null,
      );
      return publicEvidence(
        db.prepare("SELECT * FROM merchant_public_evidence WHERE evidence_id = ?").get(evidenceId) as Row,
      );
    }),
  /** 按 ID 读取一条公开页面证据。 */
  getPublicEvidence: (evidenceId: string) => {
    const row = db.prepare("SELECT * FROM merchant_public_evidence WHERE evidence_id = ?").get(evidenceId) as
      | Row
      | undefined;
    return row ? publicEvidence(row) : null;
  },
  /** 读取当前 Run 对指定 URL 已生成的证据。 */
  getPublicEvidenceForRun: (runId: string, sourceUrl: string) => {
    const row = db
      .prepare("SELECT * FROM merchant_public_evidence WHERE run_id = ? AND source_url = ?")
      .get(runId, sourceUrl) as Row | undefined;
    return row ? publicEvidence(row) : null;
  },
  /** 读取指定商家的公开页面证据列表。 */
  listPublicEvidence: (merchantId: string) =>
    (
      db
        .prepare(
          "SELECT * FROM merchant_public_evidence WHERE merchant_id = ? ORDER BY collected_at DESC, rowid DESC LIMIT 50",
        )
        .all(merchantId) as Row[]
    ).map(publicEvidence),
  /** 验证证据引用与草稿版本后追加账号诊断 DRAFT。 */
  saveAccountDiagnosis: (
    diagnosisId: string,
    merchantId: string | null,
    sessionId: string,
    runId: string,
    profileRevision: number | null,
    evidenceIds: string[],
    revisesDiagnosisId: string | null,
    report: AccountDiagnosisDraft,
    now: string,
  ) =>
    transaction(() => {
      requireEvidenceRun(merchantId, sessionId, runId);
      const requestSha256 = operationHash({
        merchantId,
        sessionId,
        profileRevision,
        evidenceIds,
        revisesDiagnosisId,
        report,
      });
      const existing = db.prepare("SELECT * FROM account_diagnosis WHERE run_id = ?").get(runId) as Row | undefined;
      // 同一 Run 只能保存同一份草稿；重试复用原记录，异参必须报冲突。
      if (existing) {
        if (existing.request_sha256 && existing.request_sha256 !== requestSha256)
          throw new Error("DIAGNOSIS_REQUEST_CONFLICT");
        return accountDiagnosis(existing);
      }
      const uniqueEvidenceIds = [...new Set(evidenceIds)];
      if (
        !uniqueEvidenceIds.length ||
        uniqueEvidenceIds.length !== evidenceIds.length ||
        !report.findings.length ||
        !report.unknowns.length ||
        report.findings.some((finding) => !["OBSERVATION", "INFERENCE"].includes(finding.kind ?? ""))
      )
        throw new Error("DIAGNOSIS_INPUT_INVALID");
      let version = 1;
      // 修订只新增版本并限制单一后继，原草稿和来源快照保持不变。
      if (revisesDiagnosisId) {
        const previous = db.prepare("SELECT * FROM account_diagnosis WHERE diagnosis_id = ?").get(revisesDiagnosisId) as
          | Row
          | undefined;
        if (
          !previous ||
          (merchantId
            ? previous.merchant_id !== merchantId
            : previous.merchant_id !== null || previous.session_id !== sessionId)
        )
          throw new Error("DIAGNOSIS_REVISION_NOT_FOUND");
        if (db.prepare("SELECT 1 FROM account_diagnosis WHERE revises_diagnosis_id = ?").get(revisesDiagnosisId))
          throw new Error("DIAGNOSIS_REVISION_CONFLICT");
        version = Number(previous.version) + 1;
      }
      const evidenceRefs: AccountDiagnosisEvidenceRef[] = [];
      // 每条证据都重新验证归属和可见正文，不接受模型自行声称的来源。
      for (const evidenceId of uniqueEvidenceIds) {
        const evidenceRow = db
          .prepare("SELECT * FROM merchant_public_evidence WHERE evidence_id = ?")
          .get(evidenceId) as Row | undefined;
        const evidence = evidenceRow ? publicEvidence(evidenceRow) : null;
        if (
          !evidence ||
          (merchantId
            ? evidence.merchantId !== merchantId
            : evidence.merchantId !== null || evidence.sessionId !== sessionId) ||
          !["COLLECTED", "LIMITED"].includes(evidence.status) ||
          !evidence.visibleText.trim()
        )
          throw new Error("DIAGNOSIS_EVIDENCE_INVALID");
        evidenceRefs.push(diagnosisEvidenceRef(evidence));
      }
      for (const item of [...report.findings, ...report.actions]) {
        if (!item.evidenceIds.length || item.evidenceIds.some((id) => !uniqueEvidenceIds.includes(id)))
          throw new Error("DIAGNOSIS_EVIDENCE_INVALID");
      }
      db.prepare(`INSERT INTO account_diagnosis
      (diagnosis_id, merchant_id, session_id, run_id, profile_revision, version, revises_diagnosis_id,
       evidence_ids_json, evidence_refs_json, request_sha256, report_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`).run(
        diagnosisId,
        merchantId,
        sessionId,
        runId,
        profileRevision,
        version,
        revisesDiagnosisId,
        json(uniqueEvidenceIds),
        json(evidenceRefs),
        requestSha256,
        json(report),
        now,
      );
      return accountDiagnosis(
        db.prepare("SELECT * FROM account_diagnosis WHERE diagnosis_id = ?").get(diagnosisId) as Row,
      );
    }),
  /** 按 ID 读取账号诊断草稿及来源快照。 */
  getAccountDiagnosis: (diagnosisId: string) => {
    const row = db.prepare("SELECT * FROM account_diagnosis WHERE diagnosis_id = ?").get(diagnosisId) as
      | Row
      | undefined;
    return row ? accountDiagnosis(row) : null;
  },
  /** 读取指定商家的账号诊断草稿列表。 */
  listAccountDiagnoses: (merchantId: string) =>
    (
      db
        .prepare("SELECT * FROM account_diagnosis WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50")
        .all(merchantId) as Row[]
    ).map(accountDiagnosis),
  /** 在一个事务里核对不可变来源并登记报告与 Markdown Artifact。 */
  publishPublicDiagnosisReport: (
    reportId: string,
    artifactId: string,
    merchantId: string,
    diagnosisId: string,
    hash: string,
    size: number,
    now: string,
  ) =>
    transaction(() => {
      const source = db
        .prepare("SELECT * FROM account_diagnosis WHERE diagnosis_id = ? AND merchant_id = ?")
        .get(diagnosisId, merchantId) as Row | undefined;
      if (!source) throw new Error("DIAGNOSIS_NOT_FOUND");
      const existing = db.prepare("SELECT * FROM public_diagnosis_report WHERE diagnosis_id = ?").get(diagnosisId) as
        | Row
        | undefined;
      // 草稿 ID 对应一个固定导出版本；商家改名后重试仍返回首次登记的文件。
      if (existing) return publicDiagnosisReport(existing);
      const report = accountDiagnosis(source);
      if (
        report.status !== "DRAFT" ||
        !report.evidenceRefs.length ||
        report.evidenceRefs.some((ref) => !ref.visibleTextSha256) ||
        report.report.findings.some((finding) => !finding.kind)
      )
        throw new Error("PUBLIC_REPORT_SOURCE_INCOMPLETE");
      // 文件 Blob 已按 hash 发布；只在报告和产物两行同时成功时对用户展示。
      requireBlobNotCollecting(hash);
      db.prepare(`INSERT INTO artifact
        (artifact_id, session_id, kind, title, blob_hash, mime_type, size_bytes, status, created_at)
        VALUES (?, ?, 'public_diagnosis_report', ?, ?, 'text/markdown', ?, 'READY', ?)`).run(
        artifactId,
        report.sessionId,
        `公开资料诊断报告-v${report.version}.md`,
        hash,
        size,
        now,
      );
      db.prepare(`INSERT INTO public_diagnosis_report
        (report_id, merchant_id, diagnosis_id, source_version, artifact_id, blob_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(reportId, merchantId, diagnosisId, report.version, artifactId, hash, now);
      return publicDiagnosisReport(
        db.prepare("SELECT * FROM public_diagnosis_report WHERE report_id = ?").get(reportId) as Row,
      );
    }),
  /** 列出商家归属的公开资料报告版本。 */
  listPublicDiagnosisReports: (merchantId: string) =>
    (
      db
        .prepare("SELECT * FROM public_diagnosis_report WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 50")
        .all(merchantId) as Row[]
    ).map(publicDiagnosisReport),
  /** 下载前复核报告仍属于指定商家。 */
  getPublicDiagnosisReport: (merchantId: string, reportId: string) => {
    const row = db
      .prepare("SELECT * FROM public_diagnosis_report WHERE merchant_id = ? AND report_id = ?")
      .get(merchantId, reportId) as Row | undefined;
    return row ? publicDiagnosisReport(row) : null;
  },
  /** 列出普通会话归属的账号诊断草稿。 */
  listSessionAccountDiagnoses: (sessionId: string) =>
    (
      db
        .prepare("SELECT * FROM account_diagnosis WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50")
        .all(sessionId) as Row[]
    ).map(accountDiagnosis),
  /** 按版本更新人工确认的商家档案。 */
  updateMerchantProfile: (
    merchantId: string,
    expectedRevision: number,
    fields: MerchantProfileFields,
    operationKey: string,
    now: string,
  ) =>
    transaction(() => {
      const normalized = {
        name: fields.name.trim(),
        industry: fields.industry.trim(),
        serviceArea: fields.serviceArea.trim(),
        products: fields.products.trim(),
        audience: fields.audience.trim(),
        goals: fields.goals.trim(),
        voice: fields.voice.trim(),
        constraints: fields.constraints.trim(),
      };
      if (!normalized.name) throw new Error("MERCHANT_INPUT_INVALID");
      const requestHash = operationHash({ merchantId, expectedRevision, normalized });
      const previous = previousOperation(operationKey, "updateMerchantProfile", requestHash);
      if (previous) return previous;
      const current = merchantDetail(merchantId);
      if (!current) throw new Error("MERCHANT_NOT_FOUND");
      if (current.profile.revision !== expectedRevision) throw new Error("MERCHANT_REVISION_CONFLICT");
      const revision = expectedRevision + 1;
      db.prepare(`INSERT INTO merchant_profile_revision (merchant_id, revision, fields_json, sha256, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(merchantId, revision, json(normalized), sha256(json(normalized)), now);
      db.prepare("UPDATE merchant SET name = ?, profile_revision = ?, updated_at = ? WHERE merchant_id = ?").run(
        normalized.name,
        revision,
        now,
        merchantId,
      );
      const result = merchantDetail(merchantId);
      db.prepare(`INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at)
      VALUES (?, 'updateMerchantProfile', ?, ?, ?)`).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 保存商家提供的平台链接，不将其视为已采集证据。 */
  createMerchantLink: (
    merchantId: string,
    linkId: string,
    input: MerchantLinkInput,
    operationKey: string,
    now: string,
  ) =>
    transaction(() => {
      const fields = { platform: input.platform, kind: input.kind, url: input.url, label: input.label };
      const requestHash = operationHash({ merchantId, fields });
      const previous = previousOperation(operationKey, "createMerchantLink", requestHash);
      if (previous) return previous;
      if (!merchantDetail(merchantId)) throw new Error("MERCHANT_NOT_FOUND");
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM merchant_platform_link WHERE merchant_id = ? AND status = 'ACTIVE'")
        .get(merchantId) as Row;
      if (Number(count.count) >= 20) throw new Error("MERCHANT_LINK_LIMIT");
      db.prepare(`INSERT INTO merchant_platform_link (link_id, merchant_id, revision, status, created_at, updated_at)
      VALUES (?, ?, 1, 'ACTIVE', ?, ?)`).run(linkId, merchantId, now, now);
      db.prepare(`INSERT INTO merchant_platform_link_revision
      (link_id, revision, platform, kind, url, label, status, sha256, created_at)
      VALUES (?, 1, ?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(
        linkId,
        fields.platform,
        fields.kind,
        fields.url,
        fields.label,
        sha256(json(fields)),
        now,
      );
      const result = merchantLink(currentMerchantLink(linkId) as Row);
      db.prepare(`INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at)
      VALUES (?, 'createMerchantLink', ?, ?, ?)`).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 按版本修改已有平台链接。 */
  updateMerchantLink: (
    merchantId: string,
    linkId: string,
    input: UpdateMerchantLinkInput,
    operationKey: string,
    now: string,
  ) =>
    transaction(() => {
      const requestHash = operationHash({ merchantId, linkId, input });
      const previous = previousOperation(operationKey, "updateMerchantLink", requestHash);
      if (previous) return previous;
      const current = currentMerchantLink(linkId);
      if (!current || current.merchant_id !== merchantId || current.status !== "ACTIVE")
        throw new Error("MERCHANT_LINK_NOT_FOUND");
      if (Number(current.revision) !== input.expectedRevision) throw new Error("MERCHANT_REVISION_CONFLICT");
      const revision = input.expectedRevision + 1;
      const fields = { platform: input.platform, kind: input.kind, url: input.url, label: input.label };
      db.prepare(`INSERT INTO merchant_platform_link_revision
      (link_id, revision, platform, kind, url, label, status, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(
        linkId,
        revision,
        fields.platform,
        fields.kind,
        fields.url,
        fields.label,
        sha256(json(fields)),
        now,
      );
      db.prepare("UPDATE merchant_platform_link SET revision = ?, updated_at = ? WHERE link_id = ?").run(
        revision,
        now,
        linkId,
      );
      const result = merchantLink(currentMerchantLink(linkId) as Row);
      db.prepare(`INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at)
      VALUES (?, 'updateMerchantLink', ?, ?, ?)`).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 按版本停用平台链接并保留历史记录。 */
  disableMerchantLink: (
    merchantId: string,
    linkId: string,
    expectedRevision: number,
    operationKey: string,
    now: string,
  ) =>
    transaction(() => {
      const requestHash = operationHash({ merchantId, linkId, expectedRevision });
      const previous = previousOperation(operationKey, "disableMerchantLink", requestHash);
      if (previous) return previous;
      const current = currentMerchantLink(linkId);
      if (!current || current.merchant_id !== merchantId || current.status !== "ACTIVE")
        throw new Error("MERCHANT_LINK_NOT_FOUND");
      if (Number(current.revision) !== expectedRevision) throw new Error("MERCHANT_REVISION_CONFLICT");
      const revision = expectedRevision + 1;
      const fields = {
        platform: String(current.platform),
        kind: String(current.kind),
        url: String(current.url),
        label: String(current.label),
        status: "INACTIVE",
      };
      db.prepare(`INSERT INTO merchant_platform_link_revision
      (link_id, revision, platform, kind, url, label, status, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'INACTIVE', ?, ?)`).run(
        linkId,
        revision,
        fields.platform,
        fields.kind,
        fields.url,
        fields.label,
        sha256(json(fields)),
        now,
      );
      db.prepare(
        "UPDATE merchant_platform_link SET revision = ?, status = 'INACTIVE', updated_at = ? WHERE link_id = ?",
      ).run(revision, now, linkId);
      const result = merchantLink(currentMerchantLink(linkId) as Row);
      db.prepare(`INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at)
      VALUES (?, 'disableMerchantLink', ?, ?, ?)`).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 按预期版本更新全局系统提示词。 */
  updateSystemPrompt: (content: string, revision: number, operationKey: string, now: string) =>
    transaction(() => {
      const normalized = content.trim();
      if (!normalized || normalized.length > 20_000) throw new Error("SYSTEM_PROMPT_INVALID");
      const requestHash = operationHash({ content: normalized, revision });
      const previous = previousOperation(operationKey, "updateSystemPrompt", requestHash);
      if (previous) return previous;
      const current = systemPrompt();
      if (current.revision !== revision) throw new Error("SYSTEM_PROMPT_CONFLICT");
      db.prepare(
        "UPDATE global_system_prompt SET content = ?, revision = ?, sha256 = ?, updated_at = ? WHERE id = 1",
      ).run(normalized, revision + 1, sha256(normalized), now);
      const result = systemPrompt();
      db.prepare(
        "INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at) VALUES (?, 'updateSystemPrompt', ?, ?, ?)",
      ).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 创建普通会话并返回持久化记录。 */
  createSession: (
    id: string,
    title: string,
    modelAlias: string,
    adapterVersion: string,
    operationKey: string,
    now: string,
  ) =>
    transaction(() => {
      const requestHash = operationHash({ title });
      const previous = previousOperation(operationKey, "createSession", requestHash);
      if (previous) return previous;
      db.prepare(
        "INSERT INTO session (session_id, scope, owner_id, title, model_alias, pi_sdk_adapter_version, created_at, updated_at) VALUES (?, 'NORMAL', 'local', ?, ?, ?, ?, ?)",
      ).run(id, title, modelAlias, adapterVersion, now, now);
      const result = session(db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row);
      db.prepare(
        "INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at) VALUES (?, 'createSession', ?, ?, ?)",
      ).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 创建归属于指定商家的新会话。 */
  createMerchantSession: (
    id: string,
    merchantId: string,
    title: string,
    modelAlias: string,
    adapterVersion: string,
    operationKey: string,
    now: string,
    researchScope?: ResearchScope,
  ) =>
    transaction(() => {
      const requestHash = operationHash({ merchantId, title, ...(researchScope && { researchScope }) });
      const previous = previousOperation(operationKey, "createMerchantSession", requestHash);
      if (previous) return previous;
      if (!merchantDetail(merchantId)) throw new Error("MERCHANT_NOT_FOUND");
      const scope = researchScope ? researchStore.validateResearchScope(merchantId, researchScope) : null;
      db.prepare(`INSERT INTO session
      (session_id, scope, owner_id, title, model_alias, pi_sdk_adapter_version, created_at, updated_at)
      VALUES (?, 'MERCHANT', ?, ?, ?, ?, ?, ?)`).run(id, merchantId, title, modelAlias, adapterVersion, now, now);
      if (scope) db.prepare("UPDATE session SET research_scope_json = ? WHERE session_id = ?").run(json(scope), id);
      const result = session(db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row);
      db.prepare(`INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at)
      VALUES (?, 'createMerchantSession', ?, ?, ?)`).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 在无活动 Run 时将普通会话及其证据绑定到商家。 */
  bindSessionMerchant: (sessionId: string, merchantId: string, operationKey: string, now: string) =>
    transaction(() => {
      const requestHash = operationHash({ sessionId, merchantId });
      const previous = previousOperation(operationKey, "bindSessionMerchant", requestHash);
      if (previous) return previous;
      if (!merchantDetail(merchantId)) throw new Error("MERCHANT_NOT_FOUND");
      const current = db
        .prepare("SELECT * FROM session WHERE session_id = ? AND lifecycle_status = 'ACTIVE'")
        .get(sessionId) as Row | undefined;
      if (!current) throw new Error("SESSION_NOT_FOUND");
      if (current.scope === "MERCHANT" && current.owner_id !== merchantId) throw new Error("SESSION_MERCHANT_CONFLICT");
      if (current.scope === "NORMAL") {
        const activeRun = db
          .prepare(`SELECT 1 FROM agent_run WHERE session_id = ?
            AND status IN ('QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_CONFIRMATION') LIMIT 1`)
          .get(sessionId);
        if (activeRun) throw new Error("SESSION_RUN_ACTIVE");
        db.prepare("UPDATE session SET scope = 'MERCHANT', owner_id = ?, updated_at = ? WHERE session_id = ?").run(
          merchantId,
          now,
          sessionId,
        );
        db.prepare(
          "UPDATE merchant_public_evidence SET merchant_id = ? WHERE session_id = ? AND merchant_id IS NULL",
        ).run(merchantId, sessionId);
        db.prepare("UPDATE account_diagnosis SET merchant_id = ? WHERE session_id = ? AND merchant_id IS NULL").run(
          merchantId,
          sessionId,
        );
        db.prepare("UPDATE content_draft SET merchant_id = ? WHERE session_id = ? AND merchant_id IS NULL").run(
          merchantId,
          sessionId,
        );
        db.prepare("UPDATE generation_job SET merchant_id = ? WHERE session_id = ? AND merchant_id IS NULL").run(
          merchantId,
          sessionId,
        );
      }
      const result = session(db.prepare("SELECT * FROM session WHERE session_id = ?").get(sessionId) as Row);
      db.prepare(`INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at)
        VALUES (?, 'bindSessionMerchant', ?, ?, ?)`).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 列出工作台中的普通和商家会话。 */
  listSessions: () =>
    (
      db
        .prepare("SELECT * FROM session WHERE lifecycle_status != 'TRASHED' ORDER BY updated_at DESC LIMIT 100")
        .all() as Row[]
    ).map(session),
  /** 用更新时间和 ID 组成稳定游标，分页读取活动或回收站会话。 */
  listSessionPage: (status: "ACTIVE" | "TRASHED", cursor: string | null, limit: number) => {
    const parts = cursor?.split("|") ?? [];
    if (cursor && (parts.length !== 2 || !parts[0] || !parts[1])) throw new Error("SESSION_CURSOR_INVALID");
    const rows = db
      .prepare(`SELECT * FROM session WHERE lifecycle_status ${status === "ACTIVE" ? "!= 'TRASHED'" : "= 'TRASHED'"}
      AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND session_id < ?))
      ORDER BY updated_at DESC, session_id DESC LIMIT ?`)
      .all(parts[0] ?? null, parts[0] ?? null, parts[0] ?? null, parts[1] ?? null, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(session),
      nextCursor: rows.length > limit && last ? `${last.updated_at}|${last.session_id}` : null,
    };
  },
  /** 按 revision 修改会话标题，避免多窗口覆盖。 */
  renameSession: (id: string, title: string, expectedRevision: number, key: string, now: string) =>
    transaction(() => {
      const requestHash = operationHash({ id, title, expectedRevision });
      const previous = previousOperation(key, "renameSession", requestHash);
      if (previous) return previous;
      const current = db
        .prepare("SELECT * FROM session WHERE session_id = ? AND lifecycle_status != 'TRASHED'")
        .get(id) as Row | undefined;
      if (!current) throw new Error("SESSION_NOT_FOUND");
      if (Number(current.title_revision) !== expectedRevision) throw new Error("SESSION_REVISION_CONFLICT");
      db.prepare(
        "UPDATE session SET title = ?, title_revision = title_revision + 1, updated_at = ? WHERE session_id = ?",
      ).run(title, now, id);
      const result = session(db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row);
      db.prepare(
        "INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at) VALUES (?, 'renameSession', ?, ?, ?)",
      ).run(key, json(result), requestHash, now);
      return result;
    }),
  /** 普通会话归档只改变生命周期，不创建商家记忆任务。 */
  archiveNormalSession: (id: string, key: string, now: string) =>
    transaction(() => {
      const requestHash = operationHash({ id });
      const previous = previousOperation(key, "archiveNormalSession", requestHash);
      if (previous) return previous;
      const current = db
        .prepare("SELECT * FROM session WHERE session_id = ? AND scope = 'NORMAL' AND lifecycle_status = 'ACTIVE'")
        .get(id) as Row | undefined;
      if (!current) throw new Error("SESSION_NOT_ACTIVE");
      const active = db
        .prepare(
          "SELECT 1 FROM agent_run WHERE session_id = ? AND status IN ('QUEUED','RUNNING','RECOVERING','WAITING_CONFIRMATION') LIMIT 1",
        )
        .get(id);
      if (active) throw new Error("SESSION_RUN_ACTIVE");
      db.prepare("UPDATE session SET lifecycle_status = 'ARCHIVED', updated_at = ? WHERE session_id = ?").run(now, id);
      const result = session(db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row);
      db.prepare(
        "INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at) VALUES (?, 'archiveNormalSession', ?, ?, ?)",
      ).run(key, json(result), requestHash, now);
      return result;
    }),
  /** 预览移入回收站会影响的持久对象，不删除任何字节。 */
  sessionDeleteImpact: (id: string) => {
    const current = db.prepare("SELECT session_id FROM session WHERE session_id = ?").get(id);
    if (!current) throw new Error("SESSION_NOT_FOUND");
    /** 读取当前会话在指定事实表中的直接引用数量。 */
    const count = (table: string) =>
      Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(id) as Row).count);
    const activeRun = db
      .prepare(
        "SELECT 1 FROM agent_run WHERE session_id = ? AND status IN ('QUEUED','RUNNING','RECOVERING','WAITING_CONFIRMATION') LIMIT 1",
      )
      .get(id);
    const sharedMemories = db
      .prepare(
        "SELECT COUNT(*) AS count FROM merchant_memory_revision WHERE json_extract(body_json, '$.source.sessionId') = ?",
      )
      .get(id) as Row;
    return {
      sessionId: id,
      messages: count("message"),
      runs: count("agent_run"),
      artifacts: count("artifact"),
      evidence: count("merchant_public_evidence"),
      diagnoses: count("account_diagnosis"),
      reports: Number(
        (
          db
            .prepare(`SELECT COUNT(*) AS count FROM public_diagnosis_report WHERE diagnosis_id IN
        (SELECT diagnosis_id FROM account_diagnosis WHERE session_id = ?)`)
            .get(id) as Row
        ).count,
      ),
      delegations: Number(
        (db.prepare("SELECT COUNT(*) AS count FROM delegation WHERE parent_session_id = ?").get(id) as Row).count,
      ),
      checkpoints: count("context_checkpoint"),
      memoryJobs: count("memory_job"),
      sharedMemories: Number(sharedMemories.count),
      workPlans: count("work_plan"),
      publicationReviews: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM publication_review WHERE draft_id IN (SELECT draft_id FROM content_draft WHERE session_id=?)",
            )
            .get(id) as Row
        ).n,
      ),
      publicationRecords: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM publication_record WHERE draft_id IN (SELECT draft_id FROM content_draft WHERE session_id=?)",
            )
            .get(id) as Row
        ).n,
      ),
      activeRun: Boolean(activeRun),
    };
  },
  /** 将无活动 Run 的会话移入回收站，保留原状态供恢复。 */
  trashSession: (id: string, key: string, now: string, expiresAt: string) =>
    transaction(() => {
      const requestHash = operationHash({ id });
      const previous = previousOperation(key, "trashSession", requestHash);
      if (previous) return previous;
      const current = db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row | undefined;
      if (!current) throw new Error("SESSION_NOT_FOUND");
      if (current.lifecycle_status === "TRASHED") throw new Error("SESSION_ALREADY_TRASHED");
      const active = db
        .prepare(
          "SELECT 1 FROM agent_run WHERE session_id = ? AND status IN ('QUEUED','RUNNING','RECOVERING','WAITING_CONFIRMATION') LIMIT 1",
        )
        .get(id);
      if (active) throw new Error("SESSION_RUN_ACTIVE");
      if (
        db
          .prepare("SELECT 1 FROM generation_job WHERE session_id = ? AND status IN ('QUEUED','RUNNING') LIMIT 1")
          .get(id)
      )
        throw new Error("SESSION_RUN_ACTIVE");
      db.prepare(
        "UPDATE session SET lifecycle_status = 'TRASHED', trash_previous_status = ?, deleted_at = ?, trash_expires_at = ?, updated_at = ? WHERE session_id = ?",
      ).run(String(current.lifecycle_status), now, expiresAt, now, id);
      const result = session(db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row);
      db.prepare(
        "INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at) VALUES (?, 'trashSession', ?, ?, ?)",
      ).run(key, json(result), requestHash, now);
      return result;
    }),
  /** 从回收站恢复原有活动或归档状态及完整会话历史。 */
  restoreTrashedSession: (id: string, key: string, now: string) =>
    transaction(() => {
      const requestHash = operationHash({ id });
      const previous = previousOperation(key, "restoreTrashedSession", requestHash);
      if (previous) return previous;
      const current = db
        .prepare("SELECT * FROM session WHERE session_id = ? AND lifecycle_status = 'TRASHED'")
        .get(id) as Row | undefined;
      if (!current) throw new Error("SESSION_NOT_TRASHED");
      if (db.prepare("SELECT 1 FROM session_purge WHERE session_id = ? AND phase != 'FINALIZED'").get(id))
        throw new Error("SESSION_PURGE_IN_PROGRESS");
      db.prepare(
        "UPDATE session SET lifecycle_status = ?, trash_previous_status = NULL, deleted_at = NULL, trash_expires_at = NULL, updated_at = ? WHERE session_id = ?",
      ).run(current.trash_previous_status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE", now, id);
      const result = session(db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row);
      db.prepare(
        "INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at) VALUES (?, 'restoreTrashedSession', ?, ?, ?)",
      ).run(key, json(result), requestHash, now);
      return result;
    }),
  /** 冻结待永久删除会话的文件哈希并阻止仍被其他会话或记忆引用的删除。 */
  prepareSessionPurge: (id: string, now: string) =>
    transaction(() => {
      const existing = db.prepare("SELECT * FROM session_purge WHERE session_id = ?").get(id) as Row | undefined;
      if (existing)
        return {
          sessionId: id,
          phase: existing.phase,
          artifactHashes: JSON.parse(String(existing.artifact_hashes_json)) as string[],
        };
      const current = db.prepare("SELECT * FROM session WHERE session_id = ? AND lifecycle_status = 'TRASHED'").get(id);
      if (!current) throw new Error("SESSION_NOT_TRASHED");
      const active = db
        .prepare(
          "SELECT 1 FROM agent_run WHERE session_id = ? AND status IN ('QUEUED','RUNNING','RECOVERING','WAITING_CONFIRMATION') LIMIT 1",
        )
        .get(id);
      if (active) throw new Error("SESSION_RUN_ACTIVE");
      if (
        db
          .prepare("SELECT 1 FROM generation_job WHERE session_id = ? AND status IN ('QUEUED','RUNNING') LIMIT 1")
          .get(id)
      )
        throw new Error("SESSION_RUN_ACTIVE");
      const memory = db
        .prepare(
          "SELECT 1 FROM merchant_memory_revision WHERE json_extract(body_json, '$.source.sessionId') = ? LIMIT 1",
        )
        .get(id);
      const revision = db
        .prepare(`SELECT 1 FROM account_diagnosis d JOIN account_diagnosis parent
      ON d.revises_diagnosis_id = parent.diagnosis_id WHERE parent.session_id = ? AND d.session_id != ? LIMIT 1`)
        .get(id, id);
      const evidence = db
        .prepare(`SELECT 1 FROM account_diagnosis d, json_each(d.evidence_ids_json) ref
      WHERE d.session_id != ? AND ref.value IN (SELECT evidence_id FROM merchant_public_evidence WHERE session_id = ?) LIMIT 1`)
        .get(id, id);
      const report = db
        .prepare(`SELECT 1 FROM merchant_context_snapshot s WHERE s.diagnosis_report_id IN
      (SELECT report_id FROM public_diagnosis_report WHERE diagnosis_id IN
        (SELECT diagnosis_id FROM account_diagnosis WHERE session_id = ?)) LIMIT 1`)
        .get(id);
      const adoptedResearch = db
        .prepare(`SELECT 1 FROM merchant_research_revision v JOIN merchant_research_batch b ON b.batch_id = v.source_batch_id
        WHERE b.session_id = ? LIMIT 1`)
        .get(id);
      const researchEvidence = db
        .prepare(`SELECT 1 FROM merchant_research_batch b, json_each(b.body_json, '$.evidenceRefs') ref
        WHERE b.session_id != ? AND json_extract(ref.value, '$.evidenceId') IN (SELECT evidence_id FROM merchant_public_evidence WHERE session_id = ?) LIMIT 1`)
        .get(id, id);
      const catalogEvidence = db
        .prepare(`SELECT 1 FROM merchant_catalog_revision WHERE evidence_id IN
        (SELECT evidence_id FROM merchant_public_evidence WHERE session_id = ?) LIMIT 1`)
        .get(id);
      // 已采用建议或其他会话仍引用证据时不能删除来源；停用不抹除历史引用。
      if (memory || revision || evidence || report || adoptedResearch || researchEvidence || catalogEvidence)
        throw new Error("SESSION_PURGE_REFERENCED");
      const hashes = (db.prepare("SELECT DISTINCT blob_hash FROM artifact WHERE session_id = ?").all(id) as Row[]).map(
        (row) => String(row.blob_hash),
      );
      db.prepare(
        "INSERT INTO session_purge(session_id, phase, artifact_hashes_json, created_at, updated_at) VALUES (?, 'PREPARED', ?, ?, ?)",
      ).run(id, json(hashes), now, now);
      return { sessionId: id, phase: "PREPARED", artifactHashes: hashes };
    }),
  /** 列出断电前尚未清理完成的永久删除任务。 */
  listPendingSessionPurges: () =>
    db.prepare("SELECT session_id AS sessionId, phase FROM session_purge WHERE phase != 'FINALIZED'").all() as Row[],
  /** 找出超过回收期且尚未启动永久删除的会话。 */
  listExpiredTrashedSessions: (now: string) =>
    (
      db
        .prepare(`SELECT session_id FROM session
      WHERE lifecycle_status = 'TRASHED' AND trash_expires_at <= ?
        AND NOT EXISTS (SELECT 1 FROM session_purge WHERE session_purge.session_id = session.session_id)
      ORDER BY trash_expires_at LIMIT 100`)
        .all(now) as Row[]
    ).map((row) => String(row.session_id)),
  /** 文件已搬入安全暂存区后，按外键顺序删除会话及其内部引用。 */
  commitSessionPurge: (id: string, now: string) =>
    transaction(() => {
      const journal = db.prepare("SELECT * FROM session_purge WHERE session_id = ?").get(id) as Row | undefined;
      if (!journal) throw new Error("SESSION_PURGE_NOT_FOUND");
      if (journal.phase !== "PREPARED") return String(journal.phase);
      const current = db.prepare("SELECT lifecycle_status FROM session WHERE session_id = ?").get(id) as
        | Row
        | undefined;
      if (current?.lifecycle_status !== "TRASHED") throw new Error("SESSION_NOT_TRASHED");
      db.prepare(
        "DELETE FROM public_diagnosis_report WHERE diagnosis_id IN (SELECT diagnosis_id FROM account_diagnosis WHERE session_id = ?) OR artifact_id IN (SELECT artifact_id FROM artifact WHERE session_id = ?)",
      ).run(id, id);
      for (const table of ["delegation_instruction", "delegation_attempt"]) {
        db.prepare(
          `DELETE FROM ${table} WHERE delegation_id IN (SELECT delegation_id FROM delegation WHERE parent_session_id = ?)`,
        ).run(id);
      }
      db.prepare("DELETE FROM delegation WHERE parent_session_id = ?").run(id);
      db.prepare(
        "DELETE FROM merchant_topic_revision WHERE topic_id IN (SELECT topic_id FROM merchant_topic WHERE session_id = ?)",
      ).run(id);
      db.prepare("DELETE FROM merchant_topic WHERE session_id = ?").run(id);
      db.prepare(
        "DELETE FROM generation_step_attempt WHERE job_id IN (SELECT job_id FROM generation_job WHERE session_id = ?)",
      ).run(id);
      db.prepare(
        "DELETE FROM image_reconciliation WHERE job_id IN (SELECT job_id FROM generation_job WHERE session_id=?)",
      ).run(id);
      db.prepare(
        "DELETE FROM work_plan WHERE session_id=? OR draft_id IN (SELECT draft_id FROM content_draft WHERE session_id=?)",
      ).run(id, id);
      db.prepare(
        "DELETE FROM publication_record WHERE draft_id IN (SELECT draft_id FROM content_draft WHERE session_id=?)",
      ).run(id);
      db.prepare(
        "DELETE FROM merchant_media_reference WHERE artifact_id IN (SELECT artifact_id FROM artifact WHERE session_id=?)",
      ).run(id);
      db.prepare(
        "DELETE FROM task_context_revision WHERE context_id IN (SELECT context_id FROM task_context WHERE session_id=?)",
      ).run(id);
      db.prepare("DELETE FROM task_context WHERE session_id=?").run(id);
      db.prepare(
        "DELETE FROM publication_review WHERE draft_id IN (SELECT draft_id FROM content_draft WHERE session_id=?)",
      ).run(id);
      db.prepare("DELETE FROM generation_job WHERE session_id = ?").run(id);
      db.prepare(
        "DELETE FROM content_revision WHERE draft_id IN (SELECT draft_id FROM content_draft WHERE session_id = ?)",
      ).run(id);
      db.prepare(
        "DELETE FROM content_publication_export WHERE draft_id IN (SELECT draft_id FROM content_draft WHERE session_id=?)",
      ).run(id);
      db.prepare(
        "DELETE FROM content_publication WHERE draft_id IN (SELECT draft_id FROM content_draft WHERE session_id=?)",
      ).run(id);
      db.prepare("DELETE FROM content_draft WHERE session_id = ?").run(id);
      db.prepare(`DELETE FROM merchant_content_analysis_attempt WHERE analysis_id IN
        (SELECT analysis_id FROM merchant_content_analysis WHERE session_id = ?)`).run(id);
      db.prepare("DELETE FROM merchant_content_analysis WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM merchant_research_report WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM merchant_research_batch WHERE session_id = ?").run(id);
      for (const table of [
        "context_checkpoint",
        "runtime_attempt_snapshot",
        "memory_job",
        "account_diagnosis",
        "merchant_public_evidence",
        "artifact",
        "runtime_event",
        "message",
        "agent_run",
        "session_read_cursor",
      ]) {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(id);
      }
      const hashes = JSON.parse(String(journal.artifact_hashes_json)) as string[];
      for (const hash of hashes) {
        if (
          !db
            .prepare(
              "SELECT 1 FROM artifact WHERE blob_hash = ? UNION ALL SELECT 1 FROM merchant_media WHERE blob_hash = ? LIMIT 1",
            )
            .get(hash, hash)
        )
          db.prepare("INSERT OR IGNORE INTO blob_gc(blob_hash, session_id, created_at) VALUES (?, ?, ?)").run(
            hash,
            id,
            now,
          );
      }
      db.prepare("DELETE FROM api_operation WHERE instr(result_json, ?) > 0 OR instr(operation_key, ?) > 0").run(
        id,
        id,
      );
      db.prepare("DELETE FROM session WHERE session_id = ?").run(id);
      db.prepare("UPDATE session_purge SET phase = 'COMMITTED', updated_at = ? WHERE session_id = ?").run(now, id);
      return "COMMITTED";
    }),
  /** 读取本次永久删除已独占、仍待清理的 Blob。 */
  listSessionBlobGc: (id: string) =>
    (db.prepare("SELECT blob_hash FROM blob_gc WHERE session_id = ?").all(id) as Row[]).map((row) =>
      String(row.blob_hash),
    ),
  /** Blob 字节清理后删除收集锁；若出现新引用则拒绝释放。 */
  finishSessionBlobGc: (id: string, hash: string) =>
    transaction(() => {
      if (db.prepare("SELECT 1 FROM artifact WHERE blob_hash = ? LIMIT 1").get(hash))
        throw new Error("BLOB_GC_REFERENCED");
      db.prepare("DELETE FROM blob_gc WHERE session_id = ? AND blob_hash = ?").run(id, hash);
    }),
  /** 受管目录清理完毕后关闭永久删除日志。 */
  finalizeSessionPurge: (id: string, now: string) =>
    transaction(() => {
      const current = db.prepare("SELECT phase FROM session_purge WHERE session_id = ?").get(id) as Row | undefined;
      if (!current || !["COMMITTED", "FINALIZED"].includes(String(current.phase)))
        throw new Error("SESSION_PURGE_NOT_COMMITTED");
      if (db.prepare("SELECT 1 FROM blob_gc WHERE session_id = ? LIMIT 1").get(id))
        throw new Error("BLOB_GC_IN_PROGRESS");
      db.prepare("UPDATE session_purge SET phase = 'FINALIZED', updated_at = ? WHERE session_id = ?").run(now, id);
      return "FINALIZED";
    }),
  /** 以消息行号单调推进本机会话已读位置。 */
  markSessionRead: (id: string, messageId: string, now: string) =>
    transaction(() => {
      const row = db.prepare("SELECT rowid FROM message WHERE session_id = ? AND message_id = ?").get(id, messageId) as
        | Row
        | undefined;
      if (!row) throw new Error("MESSAGE_NOT_FOUND");
      db.prepare(`INSERT INTO session_read_cursor(session_id, message_rowid, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET message_rowid = MAX(message_rowid, excluded.message_rowid), updated_at = excluded.updated_at`).run(
        id,
        Number(row.rowid),
        now,
      );
      return session(db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row);
    }),
  /** 在当前用户可见的活动及归档会话中搜索持久消息。 */
  searchMessages: (query: string, merchantId: string | null, limit: number) => {
    // 三字以上的纯文字走 trigram 索引；短词和符号走精确子串扫描。
    const indexed = [...query].length >= 3 && /^[\p{L}\p{N}\s]+$/u.test(query);
    const condition = indexed ? "message_search MATCH ?" : "instr(lower(ms.body), lower(?)) > 0";
    const rows = db
      .prepare(`SELECT m.message_id, m.session_id, m.role, m.created_at, s.title, s.scope, s.owner_id,
      ms.body FROM message_search ms JOIN message m ON m.rowid = ms.rowid JOIN session s ON s.session_id = m.session_id
      WHERE s.lifecycle_status != 'TRASHED' AND ${condition}
        AND (? IS NULL OR (s.scope = 'MERCHANT' AND s.owner_id = ?))
      ORDER BY m.rowid DESC LIMIT ?`)
      .all(indexed ? `"${query}"` : query, merchantId, merchantId, limit) as Row[];
    return rows.map((row) => {
      const body = String(row.body);
      const index = body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      return {
        sessionId: row.session_id,
        sessionTitle: row.title,
        merchantId: row.scope === "MERCHANT" ? row.owner_id : null,
        messageId: row.message_id,
        role: row.role,
        excerpt: body.slice(Math.max(0, index - 50), Math.max(0, index - 50) + 180),
        createdAt: row.created_at,
      };
    });
  },
  /** 读取命中消息前后的持久历史，供页面精确定位。 */
  messagesAround: (sessionId: string, messageId: string, radius: number) => {
    const target = db
      .prepare("SELECT rowid FROM message WHERE session_id = ? AND message_id = ?")
      .get(sessionId, messageId) as Row | undefined;
    if (!target) throw new Error("MESSAGE_NOT_FOUND");
    const before = db
      .prepare("SELECT * FROM message WHERE session_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
      .all(sessionId, Number(target.rowid), radius) as Row[];
    const after = db
      .prepare("SELECT * FROM message WHERE session_id = ? AND rowid >= ? ORDER BY rowid LIMIT ?")
      .all(sessionId, Number(target.rowid), radius + 1) as Row[];
    return [...before.reverse(), ...after].map(message);
  },
  /** 读取指定会话及其当前归属。 */
  getSession: (id: string) => {
    const row = db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row | undefined;
    return row ? session(row) : null;
  },
  /** 读取断线恢复所需的会话、消息、Run 与事件快照。 */
  getSessionSnapshot: (id: string) => {
    const sessionRow = db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Row | undefined;
    if (!sessionRow) return null;
    const activeRow = db
      .prepare(`SELECT * FROM agent_run WHERE session_id = ?
      AND status IN ('QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_CONFIRMATION')
      ORDER BY CASE status WHEN 'RUNNING' THEN 0 ELSE 1 END, rowid LIMIT 1`)
      .get(id) as Row | undefined;
    const latestRow = db.prepare("SELECT * FROM agent_run WHERE session_id = ? ORDER BY rowid DESC LIMIT 1").get(id) as
      | Row
      | undefined;
    // 将活动 Run 已落库的增量拼回草稿，页面刷新后仍能看到进行中的回复。
    const deltas = activeRow
      ? (db
          .prepare(
            "SELECT payload_json FROM runtime_event WHERE run_id = ? AND type = 'session.message.delta' AND seq > ? ORDER BY seq",
          )
          .all(activeRow.run_id as string, runAttemptStartSeq(String(activeRow.run_id))) as Row[])
      : [];
    const visibleRunId = String((activeRow ?? latestRow)?.run_id ?? "");
    const committedRow = db
      .prepare("SELECT run_id FROM agent_run WHERE session_id = ? AND status = 'SUCCEEDED' ORDER BY rowid DESC LIMIT 1")
      .get(id) as Row | undefined;
    const committedContextTokens = committedRow ? latestContextTokens(String(committedRow.run_id)) : null;
    const contextTokens = activeRow
      ? (latestContextTokens(String(activeRow.run_id)) ?? committedContextTokens)
      : committedContextTokens;
    const toolEvents = visibleRunId
      ? (
          db
            .prepare(
              "SELECT * FROM runtime_event WHERE run_id = ? AND seq > ? AND type IN ('session.tool.started', 'session.tool.timeout', 'session.tool.completed', 'session.delegation.started', 'session.delegation.finished', 'session.delegation.question', 'session.delegation.answered', 'session.delegation.steered', 'session.compaction.started', 'session.compaction.finished', 'session.microcompact.completed', 'session.context.compressed') ORDER BY seq DESC LIMIT 100",
            )
            .all(visibleRunId, runAttemptStartSeq(visibleRunId)) as Row[]
        )
          .reverse()
          .map(event)
      : [];
    const sourceRow = visibleRunId
      ? (db
          .prepare(
            "SELECT payload_json FROM runtime_event WHERE run_id = ? AND type = 'session.context.resolved' ORDER BY seq DESC LIMIT 1",
          )
          .get(visibleRunId) as Row | undefined)
      : undefined;
    const readEvents = visibleRunId
      ? (db
          .prepare(
            "SELECT payload_json FROM runtime_event WHERE run_id = ? AND seq > ? AND type = 'session.tool.completed'",
          )
          .all(visibleRunId, runAttemptStartSeq(visibleRunId)) as Row[])
      : [];
    return {
      session: session(sessionRow),
      messages: recentMessages(id, 50, null),
      activeRun: activeRow ? run(activeRow) : null,
      latestRun: latestRow ? run(latestRow) : null,
      streamText: deltas
        .map((row) => String((JSON.parse(String(row.payload_json)) as { text?: string }).text ?? ""))
        .join(""),
      thinkingText: activeRow ? runThinking(String(activeRow.run_id)) : "",
      toolEvents,
      contextSummary: sourceRow ? JSON.parse(String(sourceRow.payload_json)) : null,
      contextTokens,
      committedContextTokens,
      attachmentReadCount: readEvents.filter((item) => {
        const payload = JSON.parse(String(item.payload_json)) as { toolName?: string; isError?: boolean };
        return payload.toolName === "read_uploaded_text" && payload.isError === false;
      }).length,
    };
  },
  /** 冻结消息与 Runtime Plan，写入排队 Run 后唤醒调度。 */
  acceptMessage: (
    sessionId: string,
    messageId: string,
    runId: string,
    content: string,
    clientTurnId: string,
    operationKey: string,
    planConfig: RuntimePlanConfig,
    artifactIds: string[] | undefined,
    eventId: string,
    now: string,
    generationJobId?: string,
    continueFromRunId?: string,
  ) =>
    transaction(() => {
      // 用户消息、Run、首个事件和幂等结果一起提交，避免出现孤立任务。
      const expertRole = planConfig.expertSelection ?? planConfig.expert?.role ?? null;
      const requestHash = operationHash({
        sessionId,
        content,
        clientTurnId,
        ...(artifactIds !== undefined ? { artifactIds: [...artifactIds].sort() } : {}),
        ...(expertRole && expertRole !== "coordinator" ? { expertRole } : {}),
        ...(generationJobId ? { generationJobId } : {}),
        ...(continueFromRunId ? { continueFromRunId } : {}),
      });
      const previous = previousOperation(operationKey, "sendMessage", requestHash);
      if (previous) return { ...(previous as object), event: null };
      const existing = db
        .prepare(`SELECT message.message_id, message.run_id, message.content_json, agent_run.runtime_plan_json
          FROM message JOIN agent_run ON agent_run.run_id = message.run_id
          WHERE message.session_id = ? AND message.client_turn_id = ?`)
        .get(sessionId, clientTurnId) as Row | undefined;
      if (existing) {
        const existingPlan = readRuntimePlan(String(existing.runtime_plan_json));
        const existingRole =
          existingPlan?.schemaVersion === 5 || existingPlan?.schemaVersion === 6
            ? "team"
            : existingPlan?.schemaVersion === 4
              ? (existingPlan.capabilities.expert?.role ?? null)
              : null;
        const isLegacyCoordinator =
          existingPlan?.session.scope === "MERCHANT" &&
          existingPlan.schemaVersion !== 4 &&
          existingPlan.schemaVersion !== 5 &&
          existingPlan.schemaVersion !== 6;
        if (
          (JSON.parse(String(existing.content_json)) as { text: string }).text !== content ||
          existingPlan?.continuation?.sourceRunId !== continueFromRunId ||
          JSON.stringify(
            (JSON.parse(String(existing.content_json)) as { artifactIds?: string[] }).artifactIds?.sort(),
          ) !== JSON.stringify(artifactIds?.slice().sort()) ||
          (existingRole !== expertRole && !(isLegacyCoordinator && expertRole === "coordinator"))
        ) {
          throw new Error("CLIENT_TURN_CONFLICT");
        }
        return {
          messageId: existing.message_id,
          runId: existing.run_id,
          operationId: existing.run_id,
          accepted: true,
          event: null,
        };
      }
      const target = db
        .prepare(
          "SELECT session_id, scope, owner_id, research_scope_json FROM session WHERE session_id = ? AND lifecycle_status = 'ACTIVE'",
        )
        .get(sessionId) as Row | undefined;
      if (!target) throw new Error("SESSION_NOT_FOUND");
      const predecessor = db
        .prepare(
          "SELECT run_id FROM agent_run WHERE session_id = ? AND status IN ('QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_CONFIRMATION') ORDER BY rowid DESC LIMIT 1",
        )
        .get(sessionId) as Row | undefined;
      // 幂等返回先于占用检查；忙碌请求不写消息、商家记忆或冻结计划。
      if (predecessor) throw new Error("SESSION_RUN_ACTIVE");
      const continuation = continueFromRunId
        ? createRunContinuation(
            db,
            sessionId,
            target.scope as "NORMAL" | "MERCHANT",
            String(target.owner_id),
            continueFromRunId,
          )
        : undefined;
      if (continuation && generationJobId) throw new Error("CONTINUATION_SOURCE_INVALID");
      let isPublicationReviewJob = false;
      let taskContext: TaskContextRef | undefined;
      let researchSourcePlan: ReturnType<typeof readRuntimePlan> = null;
      let memoryProduct: MemoryProductRef | null = null;
      if (generationJobId) {
        const job = db
          .prepare(
            "SELECT session_id, status, prompt, model_id, source_json, purpose, input_hash, target_draft_id FROM generation_job WHERE job_id = ? AND kind = 'TEXT'",
          )
          .get(generationJobId) as Row | undefined;
        if (
          !job ||
          job.session_id !== sessionId ||
          job.status !== "QUEUED" ||
          job.prompt !== content ||
          job.model_id !== planConfig.model.modelId
        )
          throw new Error("GENERATION_JOB_STATE_CONFLICT");
        const generationSource = job.source_json ? (JSON.parse(String(job.source_json)) as TextTaskSource) : null;
        const memoryDraftId =
          job.target_draft_id ?? generationSource?.publication?.draftId ?? generationSource?.workflow?.draftId;
        const draftSourceRow =
          !generationSource?.product && memoryDraftId
            ? db
                .prepare(`SELECT source_json FROM generation_job
          WHERE session_id=? AND result_draft_id=? AND purpose='CONTENT' AND json_extract(source_json,'$.repair') IS NULL ORDER BY rowid LIMIT 1`)
                .get(sessionId, String(memoryDraftId))
            : null;
        const productSource =
          generationSource?.product ??
          (draftSourceRow?.source_json
            ? (JSON.parse(String(draftSourceRow.source_json)) as TextTaskSource).product
            : null);
        if (productSource) {
          const product = catalogVersion(String(target.owner_id), productSource.entryId, productSource.revision);
          if (
            product?.kind !== "PRODUCT" ||
            product.status !== "ACTIVE" ||
            catalogVersion(String(target.owner_id), productSource.entryId)?.status !== "ACTIVE" ||
            product.sha256 !== productSource.sha256
          )
            throw new Error("PRODUCT_SOURCE_CHANGED");
          memoryProduct = { entryId: product.entryId, revision: product.revision, sha256: product.sha256 };
        }
        if (job.purpose === "PUBLICATION_SUMMARY") {
          if (!planConfig.executionPolicy?.summary || planConfig.toolIds.length)
            throw new Error("ASYNC_RESULT_INVALID");
          assertAsyncResultCurrent(db, sessionId, generationJobId);
        }
        isPublicationReviewJob = job.purpose === "PUBLICATION_REVIEW";
        if (generationSource?.research || generationSource?.researchContinuation) {
          assertResearchJobCurrent(db, sessionId, generationJobId);
          const source = generationSource;
          const origin = source.research ?? source.researchContinuation?.original;
          const originRun = origin
            ? db.prepare("SELECT runtime_plan_json FROM agent_run WHERE run_id=?").get(origin.originRunId)
            : null;
          researchSourcePlan = originRun ? readRuntimePlan(String(originRun.runtime_plan_json)) : null;
          if (
            researchSourcePlan?.schemaVersion !== 6 ||
            researchSourcePlan.planHash !== origin?.originPlanHash ||
            canonicalJson(planConfig.expertGroupV2) !== canonicalJson(researchSourcePlan.capabilities.expertGroup) ||
            planConfig.model.modelId !== researchSourcePlan.model.modelId ||
            planConfig.toolIds.some((id) => !researchSourcePlan?.policy.allowedToolIds.includes(id))
          )
            throw new Error("RESEARCH_SOURCE_INVALID");
        }
        const formalStep = planConfig.publicationExpert;
        if (
          formalStep &&
          (formalStep.jobId !== generationJobId ||
            formalStep.purpose !== job.purpose ||
            formalStep.inputHash !== job.input_hash ||
            formalStep.promptHash !== sha256(content))
        )
          throw new Error("PUBLICATION_EXPERT_INPUT_CHANGED");
        taskContext = job.source_json
          ? (JSON.parse(String(job.source_json)) as { taskContext?: TaskContextRef }).taskContext
          : undefined;
        if (taskContext) taskContextStore.getTaskContextSnapshot(sessionId, taskContext);
        if (job.source_json && !planConfig.model.imageInput) {
          const source = JSON.parse(String(job.source_json)) as { references: Array<{ mimeType: string }> };
          if (source.references.some((ref) => ref.mimeType.startsWith("image/")))
            throw new Error("TOPIC_IMAGE_UNAVAILABLE");
        }
        textGenerationStore.validateTextGenerationSources(sessionId, generationJobId);
      }
      if (planConfig.publicationExpert && !generationJobId) throw new Error("PUBLICATION_EXPERT_REQUIRED");
      // 受理瞬间冻结当前可用附件与商家资料；排队期间的修改不影响这轮输入。
      const artifacts = db
        .prepare(
          "SELECT artifact_id, blob_hash FROM artifact WHERE session_id = ? AND (kind = 'upload' OR (? = 1 AND kind='generated_image')) AND status = 'READY' ORDER BY artifact_id",
        )
        .all(sessionId, isPublicationReviewJob ? 1 : 0) as Row[];
      const readyArtifacts = new Map(artifacts.map((item) => [String(item.artifact_id), item]));
      if (artifactIds?.some((id) => !readyArtifacts.has(id))) throw new Error("MESSAGE_ARTIFACT_INVALID");
      const selectedArtifacts =
        artifactIds === undefined ? artifacts : artifactIds.map((id) => readyArtifacts.get(id) as Row);
      // 保存意愿仅建立待审核候选，不能直接进入本轮或后续记忆集合。
      if (target.scope === "MERCHANT" && planConfig.toolsetVersion >= MEMORY_TOOLSET_VERSION && !generationJobId)
        memoryStore.rememberUser(String(target.owner_id), sessionId, messageId, content, now);
      const merchantContext =
        target.scope === "MERCHANT"
          ? createMerchantContextSnapshot(
              String(target.owner_id),
              now,
              planConfig.toolsetVersion >= MEMORY_TOOLSET_VERSION,
              target.research_scope_json
                ? (JSON.parse(String(target.research_scope_json)) as ResearchScope)
                : undefined,
              memoryProduct,
            )
          : undefined;
      const plan = createRuntimePlan({
        runId,
        messageId,
        createdAt: now,
        sessionId,
        scope: target.scope as "NORMAL" | "MERCHANT",
        ownerId: String(target.owner_id),
        pendingPredecessorRunId: null,
        config: planConfig,
        prompt: researchSourcePlan
          ? {
              content: researchSourcePlan.instructions.systemPrompt,
              revision: researchSourcePlan.instructions.revision,
              sha256: researchSourcePlan.instructions.sha256,
              updatedAt: researchSourcePlan.createdAt,
            }
          : systemPrompt(),
        artifacts: selectedArtifacts.map((artifact) => ({
          artifactId: String(artifact.artifact_id),
          blobHash: String(artifact.blob_hash),
        })),
        merchantContext:
          researchSourcePlan?.schemaVersion === 6 && researchSourcePlan.merchant
            ? researchSourcePlan.merchant
            : merchantContext,
        continuation,
        taskContext,
      });
      db.prepare(
        "INSERT INTO message (message_id, session_id, run_id, role, content_json, client_turn_id, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?)",
      ).run(
        messageId,
        sessionId,
        runId,
        json({ text: content, ...(artifactIds !== undefined ? { artifactIds: [...artifactIds].sort() } : {}) }),
        clientTurnId,
        now,
      );
      db.prepare(
        "INSERT INTO agent_run (run_id, session_id, status, runtime_plan_json, created_at, updated_at) VALUES (?, ?, 'QUEUED', ?, ?, ?)",
      ).run(runId, sessionId, json(plan), now, now);
      if (!generationJobId) researchStore.acceptContentAnalysis(runId, now);
      if (generationJobId) {
        const source = db.prepare("SELECT input_hash FROM generation_job WHERE job_id = ?").get(generationJobId) as Row;
        db.prepare(
          "UPDATE generation_job SET status = 'RUNNING', source_run_id = ?, attempt = 1, updated_at = ? WHERE job_id = ?",
        ).run(runId, now, generationJobId);
        db.prepare(`INSERT INTO generation_step_attempt(job_id, step_key, attempt, input_hash, strategy_version, status, started_at)
          VALUES (?, 'TEXT_RUN', 1, ?, 'text-run-v1', 'RUNNING', ?)`).run(
          generationJobId,
          String(source.input_hash),
          now,
        );
      }
      const createdEvent = insertEvent(
        sessionId,
        runId,
        eventId,
        "session.message.accepted",
        { messageId, runId },
        now,
      );
      const result = { messageId, runId, operationId: runId, accepted: true };
      db.prepare(
        "INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at) VALUES (?, 'sendMessage', ?, ?, ?)",
      ).run(operationKey, json(result), requestHash, now);
      return { ...result, event: createdEvent };
    }),
  /** 将会话消息分页读取入口映射到同一份查询实现。 */
  listMessages: recentMessages,
  /** 按序号补拉当前会话的运行事件。 */
  listEvents: (sessionId: string, afterSeq: number, limit: number) =>
    (
      db
        .prepare("SELECT * FROM runtime_event WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
        .all(sessionId, afterSeq, limit) as Row[]
    ).map(event),
  /** 列出重启后需要重新唤醒的排队 Run。 */
  listQueuedRunIds: () =>
    (db.prepare("SELECT run_id FROM agent_run WHERE status = 'QUEUED' ORDER BY rowid").all() as Row[]).map((row) =>
      String(row.run_id),
    ),
  /** 列出仍被附件引用的 Blob 供恢复检查。 */
  listBlobReferences: () =>
    db
      .prepare(
        "SELECT DISTINCT blob_hash AS hash, size_bytes AS sizeBytes FROM artifact WHERE status='READY' UNION SELECT blob_hash AS hash,size_bytes AS sizeBytes FROM merchant_media",
      )
      .all(),

  /** 读取指定 Run 的状态和归属。 */
  getRun: (id: string) => {
    const row = db.prepare("SELECT * FROM agent_run WHERE run_id = ?").get(id) as Row | undefined;
    return row ? run(row) : null;
  },
  /** 读取消息受理时冻结的 Runtime Plan。 */
  getRunPlan: (id: string) => {
    const row = db.prepare("SELECT runtime_plan_json FROM agent_run WHERE run_id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return readRuntimePlan(String(row.runtime_plan_json));
  },
  /** 记录取消请求并生成可恢复的状态事件。 */
  requestRunCancellation: (runId: string, eventId: string, now: string) =>
    transaction(() => {
      const target = db.prepare("SELECT * FROM agent_run WHERE run_id = ?").get(runId) as Row | undefined;
      if (!target) throw new Error("RUN_NOT_FOUND");
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(String(target.status))) {
        return { run: run(target), events: [] };
      }
      if (target.cancel_requested_at) return { run: run(target), events: [] };
      const sessionId = String(target.session_id);
      if (target.status === "RUNNING") {
        db.prepare("UPDATE agent_run SET cancel_requested_at = ?, updated_at = ? WHERE run_id = ?").run(
          now,
          now,
          runId,
        );
        const requested = insertEvent(sessionId, runId, eventId, "session.execution.cancel.requested", {}, now);
        const updated = db.prepare("SELECT * FROM agent_run WHERE run_id = ?").get(runId) as Row;
        return { run: run(updated), events: [requested] };
      }
      db.prepare(
        "UPDATE agent_run SET status = 'CANCELLED', cancel_requested_at = ?, error_code = 'RUN_CANCELLED', error_message = '任务已取消', updated_at = ? WHERE run_id = ?",
      ).run(now, now, runId);
      researchStore.finishContentAnalysisAttempt(runId, "CANCELLED", "RUN_CANCELLED", now);
      const finished = insertEvent(
        sessionId,
        runId,
        eventId,
        "session.execution.finished",
        { status: "CANCELLED", errorCode: "RUN_CANCELLED", errorMessage: "任务已取消" },
        now,
      );
      const updated = db.prepare("SELECT * FROM agent_run WHERE run_id = ?").get(runId) as Row;
      return { run: run(updated), events: [finished] };
    }),
  /** 事务性领取下一条允许执行的 Run。 */
  claimNextRun: (now: string, occupiedSessionIds: string[] = []) =>
    transaction(() => {
      // 同一会话已有运行中任务时不领取后续 Run，保持对话上下文顺序。
      const row = db
        .prepare(`SELECT r.* FROM agent_run r WHERE r.status = 'QUEUED'
      AND NOT EXISTS (SELECT 1 FROM agent_run active WHERE active.session_id = r.session_id AND active.status = 'RUNNING')
      AND r.session_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY r.rowid LIMIT 1`)
        .get(json(occupiedSessionIds)) as Row | undefined;
      if (!row) return null;
      // 领取时固定输入快照；排队时前一条 Run 可能尚未提交。
      db.prepare(
        "UPDATE agent_run SET status = 'RUNNING', attempt = attempt + 1, runtime_snapshot_ref = (SELECT pi_session_file FROM session WHERE session_id = agent_run.session_id), runtime_snapshot_hash = (SELECT pi_session_hash FROM session WHERE session_id = agent_run.session_id), updated_at = ? WHERE run_id = ?",
      ).run(now, row.run_id as string);
      const executionPlan = readRuntimePlan(String(row.runtime_plan_json));
      if (executionPlan?.executionPolicy?.history === "ISOLATED")
        db.prepare("UPDATE agent_run SET runtime_snapshot_ref=NULL,runtime_snapshot_hash=NULL WHERE run_id=?").run(
          String(row.run_id),
        );
      researchStore.startContentAnalysisAttempt(row.run_id as string, now);
      return run(db.prepare("SELECT * FROM agent_run WHERE run_id = ?").get(row.run_id as string) as Row);
    }),
  /** 读取当前 Run 原始用户请求。 */
  getRunPrompt: (runId: string) => {
    const row = db
      .prepare("SELECT content_json FROM message WHERE run_id = ? AND role = 'user' ORDER BY created_at LIMIT 1")
      .get(runId) as Row | undefined;
    return row ? (JSON.parse(String(row.content_json)) as { text: string }).text : null;
  },
  /** 将运行事件追加到会话序列。 */
  appendEvent: (
    sessionId: string,
    runId: string,
    eventId: string,
    type: string,
    payload: Record<string, unknown>,
    now: string,
    expectedAttempt?: number,
  ) =>
    transaction(() => {
      if (expectedAttempt !== undefined) requireRunAttempt(runId, expectedAttempt, sessionId);
      return insertEvent(sessionId, runId, eventId, type, payload, now);
    }),
  /** 事务性保存 Pi 自动压缩 Attempt 与会话进度事件。 */
  recordCompactionEvent: (
    runId: string,
    detail: Extract<PiRuntimeEvent, { type: "compaction.started" | "compaction.finished" }>,
    eventId: string,
    now: string,
    expectedAttempt?: number,
  ) =>
    transaction(() => {
      if (expectedAttempt !== undefined) requireRunAttempt(runId, expectedAttempt);
      const target = db
        .prepare(
          "SELECT session_id, status, runtime_snapshot_ref, runtime_snapshot_hash, runtime_plan_json FROM agent_run WHERE run_id = ?",
        )
        .get(runId) as Row | undefined;
      if (target?.status !== "RUNNING") throw new Error("RUN_NOT_RUNNING");
      if (detail.type === "compaction.started") {
        const ordinal =
          Number(
            (
              db
                .prepare("SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM context_checkpoint WHERE run_id = ?")
                .get(runId) as Row
            ).ordinal,
          ) + 1;
        const source = target.runtime_snapshot_ref ? String(target.runtime_snapshot_ref) : null;
        const indexedSource = db
          .prepare(
            "SELECT source_snapshot_hash FROM runtime_attempt_snapshot WHERE run_id = ? AND attempt = (SELECT attempt FROM agent_run WHERE run_id = ?)",
          )
          .get(runId, runId) as Row | undefined;
        const knownHash = target.runtime_snapshot_hash ?? indexedSource?.source_snapshot_hash;
        const sourceHash = knownHash
          ? String(knownHash)
          : source
            ? createHash("sha256").update(readFileSync(source)).digest("hex")
            : null;
        const plan = readRuntimePlan(String(target.runtime_plan_json));
        const merchant = plan && "merchant" in plan ? plan.merchant : null;
        db.prepare(`INSERT INTO context_checkpoint
          (checkpoint_id, session_id, run_id, ordinal, status, reason, source_snapshot_ref,
           source_snapshot_hash, anchor_message_id, merchant_snapshot_id, merchant_snapshot_hash,
           summary_template_version, adapter_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          `cp_${randomUUID()}`,
          target.session_id as string,
          runId,
          ordinal,
          detail.reason,
          source,
          sourceHash,
          plan?.messageId ?? null,
          merchant?.snapshotId ?? null,
          merchant?.sha256 ?? null,
          plan?.runtime.adapterVersion?.includes(":compact-1") ? "host-business-v1" : "pi-default-0.87.1",
          plan?.runtime.adapterVersion ?? null,
          now,
          now,
        );
      } else {
        const pending = db
          .prepare(
            "SELECT checkpoint_id FROM context_checkpoint WHERE run_id = ? AND status = 'PENDING' ORDER BY ordinal DESC LIMIT 1",
          )
          .get(runId) as Row | undefined;
        if (!pending) {
          // Pi 的溢出重试耗尽分支可能只发 end；仍保存失败事件，不能因此丢失整轮回复。
          const ordinal =
            Number(
              (
                db
                  .prepare("SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM context_checkpoint WHERE run_id = ?")
                  .get(runId) as Row
              ).ordinal,
            ) + 1;
          db.prepare(`INSERT INTO context_checkpoint
            (checkpoint_id, session_id, run_id, ordinal, status, reason, error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'FAILED', ?, ?, ?, ?)`).run(
            `cp_${randomUUID()}`,
            target.session_id as string,
            runId,
            ordinal,
            detail.reason,
            detail.errorMessage ?? "COMPACTION_WITHOUT_START",
            now,
            now,
          );
        }
        const result = detail.result;
        if (pending)
          db.prepare(`UPDATE context_checkpoint SET status = ?, first_kept_entry_id = ?, summary = ?,
          summary_hash = ?, tokens_before = ?, estimated_tokens_after = ?, error_message = ?, updated_at = ?
          WHERE checkpoint_id = ?`).run(
            result ? "READY" : "FAILED",
            result?.firstKeptEntryId ?? null,
            result?.summary ?? null,
            result ? sha256(result.summary) : null,
            result?.tokensBefore ?? null,
            result?.estimatedTokensAfter ?? null,
            detail.errorMessage,
            now,
            pending.checkpoint_id as string,
          );
      }
      return insertEvent(
        String(target.session_id),
        runId,
        eventId,
        detail.type === "compaction.started" ? "session.compaction.started" : "session.compaction.finished",
        detail.type === "compaction.started"
          ? { reason: detail.reason }
          : {
              reason: detail.reason,
              status: detail.result ? "READY" : "FAILED",
              errorMessage: detail.errorMessage,
              willRetry: detail.willRetry,
            },
        now,
      );
    }),
  /** 在模型执行前登记工作文件，并在退出前记录实际落盘状态；旧 Attempt 不能覆盖新尝试。 */
  recordRunSnapshot: (runId: string, attempt: number, snapshot: RuntimeStateSnapshot, now: string) =>
    transaction(() => {
      requireRunAttempt(runId, attempt);
      const target = db
        .prepare("SELECT session_id, runtime_snapshot_ref, runtime_snapshot_hash FROM agent_run WHERE run_id = ?")
        .get(runId) as Row;
      const expectedVerification = !target.runtime_snapshot_ref
        ? "EMPTY"
        : target.runtime_snapshot_hash
          ? "VERIFIED"
          : "LEGACY_UNVERIFIED";
      if (
        !snapshot.sessionFile ||
        snapshot.fileExists !== Boolean(snapshot.sessionFileHash) ||
        snapshot.sourceVerification !== expectedVerification ||
        Boolean(snapshot.sourceSnapshotHash) !== Boolean(target.runtime_snapshot_ref)
      )
        throw new Error("PI_SESSION_SNAPSHOT_INVALID");
      const prior = db
        .prepare("SELECT working_snapshot_ref FROM runtime_attempt_snapshot WHERE run_id = ? AND attempt = ?")
        .get(runId, attempt) as Row | undefined;
      if (prior && prior.working_snapshot_ref !== snapshot.sessionFile) throw new Error("PI_SESSION_SNAPSHOT_INVALID");
      if (target.runtime_snapshot_hash && target.runtime_snapshot_hash !== snapshot.sourceSnapshotHash)
        throw new Error("PI_SESSION_HASH_MISMATCH");
      db.prepare(`INSERT INTO runtime_attempt_snapshot
        (run_id,attempt,session_id,source_snapshot_ref,source_snapshot_hash,source_verification,
         working_snapshot_ref,working_snapshot_hash,file_exists,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'PREPARED',?,?)
        ON CONFLICT(run_id,attempt) DO UPDATE SET working_snapshot_hash=excluded.working_snapshot_hash,
          file_exists=excluded.file_exists,updated_at=excluded.updated_at`).run(
        runId,
        attempt,
        String(target.session_id),
        target.runtime_snapshot_ref as string | null,
        snapshot.sourceSnapshotHash,
        snapshot.sourceVerification,
        snapshot.sessionFile,
        snapshot.sessionFileHash,
        snapshot.fileExists ? 1 : 0,
        now,
        now,
      );
    }),
  /** 读取主 Run 各次尝试的内部诊断索引，不将失败副本作为续执行历史。 */
  listRunSnapshots: (runId: string) =>
    db.prepare("SELECT * FROM runtime_attempt_snapshot WHERE run_id = ? ORDER BY attempt").all(runId),
  /** 事务性保存助手结果、终态和最后事件。 */
  finishRun: (
    runId: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    text: string | null,
    errorCode: string | null,
    errorMessage: string | null,
    sessionFile: string | null,
    usage: Record<string, number> | null,
    messageId: string,
    eventId: string,
    finishEventId: string,
    now: string,
    expectedAttempt?: number,
    expectedSnapshotHash?: string | null,
  ) =>
    transaction(() => {
      if (expectedAttempt !== undefined) requireRunAttempt(runId, expectedAttempt);
      const target = db.prepare("SELECT * FROM agent_run WHERE run_id = ?").get(runId) as Row | undefined;
      if (!target) throw new Error("RUN_NOT_FOUND");
      if (target.status !== "RUNNING") return [];
      // 取消意图先落库；即使模型同时返回成功，也不能再提交回复和快照。
      if (target.cancel_requested_at) {
        status = "CANCELLED";
        text = null;
        errorCode = "RUN_CANCELLED";
        errorMessage = "任务已取消";
        sessionFile = null;
      }
      // 模型返回与成功提交之间仍可能收到新要求；旧依据不能成为下一轮成功锚点。
      if (status === "SUCCEEDED") {
        try {
          assertCurrentTaskContextForRun(db, runId);
          const researchJob = db
            .prepare(
              "SELECT job_id FROM generation_job WHERE source_run_id=? AND (json_type(source_json,'$.research')='object' OR json_type(source_json,'$.researchContinuation')='object')",
            )
            .get(runId);
          if (researchJob) assertResearchJobCurrent(db, String(target.session_id), String(researchJob.job_id));
          assertPublicationExpertSource(db, runId, readRuntimePlan(String(target.runtime_plan_json)), text ?? "");
          const summary = db
            .prepare("SELECT job_id FROM generation_job WHERE source_run_id=? AND purpose='PUBLICATION_SUMMARY'")
            .get(runId);
          if (summary) {
            assertAsyncResultCurrent(db, String(target.session_id), String(summary.job_id));
            parseAsyncResultSummary(text ?? "");
          }
        } catch (error) {
          if (
            !(error instanceof Error) ||
            ![
              "INPUT_VERSION_STALE",
              "PUBLICATION_EXPERT_FAILED",
              "PUBLICATION_EXPERT_INCOMPLETE",
              "ASYNC_RESULT_SUPERSEDED",
              "ASYNC_RESULT_INVALID",
              "RESEARCH_SOURCE_SUPERSEDED",
              "RESEARCH_SOURCE_INVALID",
            ].includes(error.message)
          )
            throw error;
          status = "FAILED";
          text = null;
          sessionFile = null;
          errorCode = error.message;
          errorMessage =
            errorCode === "INPUT_VERSION_STALE"
              ? "任务要求已变化，本轮未写入新结果，请按最新要求继续"
              : errorCode === "ASYNC_RESULT_SUPERSEDED"
                ? "结果已被后续输入或新版本替代，本次不发送旧汇总"
                : errorCode === "ASYNC_RESULT_INVALID"
                  ? "结果汇总格式未通过校验，原成果保留"
                  : "本步骤未取得对应专家的有效提交，原成果保留，请查看子任务状态";
        }
      }
      if (status === "SUCCEEDED") {
        // 只在成功时推进会话快照；失败的副本不会污染后续对话。
        if (!sessionFile || text === null) throw new Error("RUN_RESULT_INCOMPLETE");
        let finalHash: string;
        try {
          finalHash = createHash("sha256").update(readFileSync(sessionFile)).digest("hex");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            throw new Error("PI_SESSION_FILE_MISSING");
          throw error;
        }
        if (expectedSnapshotHash && finalHash !== expectedSnapshotHash) throw new Error("PI_SESSION_HASH_MISMATCH");
        const working = db
          .prepare(
            "SELECT working_snapshot_ref, working_snapshot_hash FROM runtime_attempt_snapshot WHERE run_id = ? AND attempt = ?",
          )
          .get(runId, Number(target.attempt)) as Row | undefined;
        if (working && (working.working_snapshot_ref !== sessionFile || working.working_snapshot_hash !== finalHash))
          throw new Error("PI_SESSION_HASH_MISMATCH");
        if (readRuntimePlan(String(target.runtime_plan_json))?.executionPolicy?.history !== "ISOLATED")
          db.prepare(
            "UPDATE session SET pi_session_file = ?, pi_session_hash = ?, updated_at = ? WHERE session_id = ?",
          ).run(sessionFile, finalHash, now, target.session_id as string);
        db.prepare(`UPDATE context_checkpoint SET status = 'COMMITTED', final_snapshot_ref = ?,
          final_snapshot_hash = ?, updated_at = ? WHERE run_id = ? AND status = 'READY'`).run(
          sessionFile,
          finalHash,
          now,
          runId,
        );
      }
      if (status !== "SUCCEEDED")
        db.prepare(
          "UPDATE context_checkpoint SET status = 'ABORTED', updated_at = ? WHERE run_id = ? AND status IN ('PENDING', 'READY')",
        ).run(now, runId);
      db.prepare("UPDATE runtime_attempt_snapshot SET status = ?, updated_at = ? WHERE run_id = ? AND attempt = ?").run(
        status,
        now,
        runId,
        Number(target.attempt),
      );
      const thinking = status === "SUCCEEDED" ? runThinking(runId) : "";
      if (status === "SUCCEEDED" && text !== null) {
        db.prepare(
          "INSERT INTO message (message_id, session_id, run_id, role, content_json, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)",
        ).run(messageId, target.session_id as string, runId, json({ text, thinking }), now);
      }
      db.prepare(
        "UPDATE agent_run SET status = ?, error_code = ?, error_message = ?, usage_json = ?, updated_at = ? WHERE run_id = ?",
      ).run(status, errorCode, errorMessage, usage ? json(usage) : null, now, runId);
      // 报告与成功终态同事务提交；失败、取消和中断尝试不产生成功报告。
      // 素材/选题任务不是重新研究，不生成空报告或覆盖原分析状态。
      const generationRun = db.prepare("SELECT 1 FROM generation_job WHERE source_run_id = ?").get(runId);
      if (status === "SUCCEEDED" && !generationRun) researchStore.finalizeResearchReport(runId, now);
      researchStore.finishContentAnalysisAttempt(runId, status, errorCode, now);
      const completed =
        text !== null
          ? insertEvent(
              target.session_id as string,
              runId,
              eventId,
              "session.message.completed",
              { messageId, text, thinking },
              now,
            )
          : null;
      const finished = insertEvent(
        target.session_id as string,
        runId,
        finishEventId,
        "session.execution.finished",
        { status, errorCode, errorMessage, usage },
        now,
      );
      const events = completed ? [completed, finished] : [finished];
      if (status === "FAILED") {
        // 同会话排队任务依赖上一轮上下文，前一轮失败后一起标记失败。
        const dependentErrorCode = "PREVIOUS_RUN_FAILED";
        const dependentErrorMessage = "前一条消息执行失败，请重新发送";
        const queued = db
          .prepare("SELECT run_id FROM agent_run WHERE session_id = ? AND status = 'QUEUED' ORDER BY rowid")
          .all(target.session_id as string) as Row[];
        for (const item of queued) {
          db.prepare(
            "UPDATE agent_run SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ? WHERE run_id = ?",
          ).run(dependentErrorCode, dependentErrorMessage, now, item.run_id as string);
          events.push(
            insertEvent(
              target.session_id as string,
              item.run_id as string,
              `evt_${randomUUID()}`,
              "session.execution.finished",
              { status: "FAILED", errorCode: dependentErrorCode, errorMessage: dependentErrorMessage },
              now,
            ),
          );
        }
      }
      return events;
    }),
  /** 启动时扫描中断的 Run 并写入明确恢复结果。 */
  recoverInterrupted: (now: string) =>
    transaction(() => {
      db.prepare(`UPDATE context_checkpoint SET status = 'ABORTED', updated_at = ?
        WHERE status IN ('PENDING', 'READY') AND run_id IN
          (SELECT run_id FROM agent_run WHERE status = 'RUNNING')`).run(now);
      // 从上次成功快照重试；子任务只用只读工具和结构化提交，可按稳定键重建未提交尝试。
      const interrupted = db
        .prepare("SELECT run_id, session_id, attempt, cancel_requested_at FROM agent_run WHERE status = 'RUNNING'")
        .all() as Row[];
      const events = [];
      for (const item of interrupted) {
        const cancelled = Boolean(item.cancel_requested_at);
        // 已提交的专家结果可按 task_key 复用；存在外部采集或写入工具时绝不重放父轮。
        const startedTools = db
          .prepare(`SELECT json_extract(payload_json, '$.toolName') AS name
          FROM runtime_event WHERE run_id = ? AND type = 'session.tool.started'`)
          .all(item.run_id as string) as Row[];
        const unsafeTool = startedTools.some((tool) => blocksToolReplay(String(tool.name), "startup"));
        const working = db
          .prepare("SELECT working_snapshot_ref FROM runtime_attempt_snapshot WHERE run_id = ? AND attempt = ?")
          .get(String(item.run_id), Number(item.attempt)) as Row | undefined;
        if (working) {
          let hash: string | null = null;
          try {
            hash = createHash("sha256")
              .update(readFileSync(String(working.working_snapshot_ref)))
              .digest("hex");
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
          }
          // 强杀时可能未经过 finally；重新观测诊断文件，但不把它升级成成功历史。
          db.prepare(`UPDATE runtime_attempt_snapshot SET status = 'INTERRUPTED', working_snapshot_hash = ?,
            file_exists = ?, updated_at = ? WHERE run_id = ? AND attempt = ? AND status = 'PREPARED'`).run(
            hash,
            hash ? 1 : 0,
            now,
            String(item.run_id),
            Number(item.attempt),
          );
        }
        const retryable = !cancelled && !unsafeTool && Number(item.attempt) < 2;
        const pendingChildren = db
          .prepare(`SELECT * FROM delegation WHERE parent_run_id = ?
          AND status IN ('QUEUED', 'RUNNING', 'WAITING_INPUT')`)
          .all(item.run_id as string) as Row[];
        for (const child of pendingChildren)
          if (["RUNNING", "WAITING_INPUT"].includes(String(child.status)))
            db.prepare(`UPDATE delegation_attempt SET status = 'INTERRUPTED', finished_at = ?, error_code = 'HOST_INTERRUPTED'
              WHERE delegation_id = ? AND attempt = ? AND status IN ('RUNNING', 'WAITING_INPUT')`).run(
              now,
              child.delegation_id as string,
              Number(child.attempt),
            );
        if (retryable) {
          db.prepare(`UPDATE delegation SET status = 'QUEUED', updated_at = ? WHERE parent_run_id = ?
            AND status IN ('RUNNING', 'WAITING_INPUT')`).run(now, item.run_id as string);
        } else {
          const childStatus = cancelled ? "CANCELLED" : "FAILED";
          db.prepare(`UPDATE delegation SET status = ?, error_code = 'HOST_INTERRUPTED', updated_at = ?
            WHERE parent_run_id = ? AND status IN ('QUEUED', 'RUNNING', 'WAITING_INPUT')`).run(
            childStatus,
            now,
            item.run_id as string,
          );
          for (const child of pendingChildren)
            events.push(
              insertEvent(
                String(child.parent_session_id),
                String(child.parent_run_id),
                `evt_${randomUUID()}`,
                "session.delegation.finished",
                {
                  delegationId: child.delegation_id,
                  childRunId: child.child_run_id,
                  targetExpertId: child.target_expert_id,
                  status: childStatus,
                  errorCode: "HOST_INTERRUPTED",
                },
                now,
              ),
            );
        }
        const status = cancelled ? "CANCELLED" : retryable ? "QUEUED" : "FAILED";
        const errorCode = cancelled
          ? "RUN_CANCELLED"
          : retryable
            ? null
            : unsafeTool
              ? "RECOVERY_UNSAFE_TOOL"
              : "RECOVERY_RETRY_LIMIT";
        const errorMessage = cancelled
          ? "任务已取消"
          : retryable
            ? null
            : unsafeTool
              ? "任务曾调用采集或写入工具，无法安全自动重试；请检查已保存结果后继续"
              : "任务连续中断，请重新发送消息";
        db.prepare(
          "UPDATE agent_run SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE run_id = ?",
        ).run(status, errorCode, errorMessage, now, item.run_id as string);
        researchStore.interruptContentAnalysisAttempt(item.run_id as string, Number(item.attempt), status, now);
        events.push(
          insertEvent(
            item.session_id as string,
            item.run_id as string,
            `evt_${crypto.randomUUID()}`,
            retryable ? "session.execution.retrying" : "session.execution.finished",
            retryable ? { status, reason: "HOST_INTERRUPTED" } : { status, errorCode, errorMessage },
            now,
          ),
        );
        if (status !== "FAILED") continue;
        const queued = db
          .prepare("SELECT run_id FROM agent_run WHERE session_id = ? AND status = 'QUEUED' ORDER BY rowid")
          .all(item.session_id as string) as Row[];
        for (const dependent of queued) {
          db.prepare(
            "UPDATE agent_run SET status = 'FAILED', error_code = 'PREVIOUS_RUN_FAILED', error_message = '前一条消息执行失败，请重新发送', updated_at = ? WHERE run_id = ?",
          ).run(now, dependent.run_id as string);
          events.push(
            insertEvent(
              item.session_id as string,
              dependent.run_id as string,
              `evt_${crypto.randomUUID()}`,
              "session.execution.finished",
              { status: "FAILED", errorCode: "PREVIOUS_RUN_FAILED", errorMessage: "前一条消息执行失败，请重新发送" },
              now,
            ),
          );
        }
      }
      return events;
    }),
  /** 为父 Run 幂等保留唯一子任务。 */
  reserveDelegation: (
    delegationId: string,
    parentSessionId: string,
    parentRunId: string,
    childSessionId: string,
    childRunId: string,
    inputHash: string,
    input: DelegationTaskV2 | ExpertTaskV3,
    now: string,
  ) =>
    transaction(() => {
      const parent = db
        .prepare("SELECT status, session_id, runtime_plan_json, cancel_requested_at FROM agent_run WHERE run_id = ?")
        .get(parentRunId) as Row | undefined;
      if (parent?.status !== "RUNNING" || parent.session_id !== parentSessionId || parent.cancel_requested_at)
        throw new Error("DELEGATION_PARENT_UNAVAILABLE");
      const plan = readRuntimePlan(String(parent.runtime_plan_json));
      if ((plan?.schemaVersion !== 5 && plan?.schemaVersion !== 6) || plan.session.sessionId !== parentSessionId)
        throw new Error("DELEGATION_NOT_ALLOWED");
      const taskKey = plan.schemaVersion === 5 ? "legacy" : (input.taskKey ?? "legacy");
      if (plan.schemaVersion === 5 && input.taskKey) throw new Error("DELEGATION_NOT_ALLOWED");
      const existing = db
        .prepare("SELECT * FROM delegation WHERE parent_run_id = ? AND task_key = ?")
        .get(parentRunId, taskKey) as Row | undefined;
      if (existing) {
        if (existing.input_hash !== inputHash) throw new Error("DELEGATION_CONFLICT");
        return delegation(existing);
      }
      const count = Number(
        (db.prepare("SELECT COUNT(*) AS count FROM delegation WHERE parent_run_id = ?").get(parentRunId) as Row).count,
      );
      if (count >= (plan.schemaVersion === 5 ? 1 : 4)) throw new Error("DELEGATION_LIMIT_REACHED");
      db.prepare(`INSERT INTO delegation
      (delegation_id, parent_session_id, parent_run_id, task_key, child_session_id, child_run_id,
       target_expert_id, input_hash, input_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)`).run(
        delegationId,
        parentSessionId,
        parentRunId,
        taskKey,
        childSessionId,
        childRunId,
        input.targetExpertId,
        inputHash,
        json(input),
        now,
        now,
      );
      return delegation(db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row);
    }),
  /** 读取父 Run 对应的委派状态和结果。 */
  getDelegationForParentRun: (parentRunId: string) => {
    const row = db
      .prepare("SELECT * FROM delegation WHERE parent_run_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(parentRunId) as Row | undefined;
    return row ? delegation(row) : null;
  },
  /** 读取父 Run 的全部专家任务，按创建顺序展示和处理取消。 */
  listDelegationsForParentRun: (parentRunId: string) =>
    (
      db
        .prepare("SELECT * FROM delegation WHERE parent_run_id = ? ORDER BY created_at, delegation_id")
        .all(parentRunId) as Row[]
    ).map(delegation),
  /** 以稳定任务键读取当前任务，避免并行子 Agent 误读其他任务结果。 */
  getDelegationForTask: (parentRunId: string, taskKey: string) => {
    const row = db
      .prepare("SELECT * FROM delegation WHERE parent_run_id = ? AND task_key = ?")
      .get(parentRunId, taskKey) as Row | undefined;
    return row ? delegation(row) : null;
  },
  /** 仅取同会话且已成功提交的近期消息，按父消息 ID 截止。 */
  listRecentMessagesForDelegation: (sessionId: string, parentMessageId: string) => {
    const parent = db
      .prepare("SELECT rowid FROM message WHERE message_id = ? AND session_id = ?")
      .get(parentMessageId, sessionId) as Row | undefined;
    if (!parent) throw new Error("DELEGATION_PARENT_MESSAGE_MISSING");
    return (
      db
        .prepare(`SELECT m.message_id, m.role, m.content_json FROM message m
      JOIN agent_run r ON r.run_id = m.run_id
      WHERE m.session_id = ? AND m.rowid < ? AND r.status = 'SUCCEEDED'
      ORDER BY m.rowid DESC LIMIT 6`)
        .all(sessionId, parent.rowid as number) as Row[]
    )
      .reverse()
      .map((row) => {
        const content = JSON.parse(String(row.content_json)) as { text?: string };
        const fullText = content.text ?? "";
        return {
          id: String(row.message_id),
          role: String(row.role),
          sha256: sha256(fullText),
          excerpt: Array.from(fullText).slice(0, 240).join(""),
        };
      });
  },
  /** 按 ID 读取子任务，供用户回答与调整入口复核当前状态。 */
  getDelegation: (delegationId: string) => {
    const row = db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row | undefined;
    return row ? delegation(row) : null;
  },
  /** 读取原研究委派的工作记忆；空任务返回明确的初始版本。 */
  getResearchMemory: (delegationId: string): ResearchMemorySnapshot => {
    const row = db
      .prepare("SELECT target_expert_id,research_memory_json FROM delegation WHERE delegation_id=?")
      .get(delegationId);
    if (row?.target_expert_id !== "researcher") throw new Error("RESEARCH_DELEGATION_INVALID");
    return row.research_memory_json
      ? JSON.parse(String(row.research_memory_json))
      : {
          revision: 0,
          memory: { hypotheses: [], triedApproaches: [], openQuestions: [] },
          coveredToolCallIds: [],
        };
  },
  /** 同事务检查父子尝试、取消、会话与记忆版本，旧回调不能覆盖新研究状态。 */
  saveResearchMemory: (
    delegationId: string,
    attempt: number,
    parentAttempt: number,
    baseRevision: number,
    snapshot: ResearchMemorySnapshot,
  ): void =>
    transaction(() => {
      const row = db
        .prepare(`SELECT d.*,r.status parent_status,r.attempt parent_attempt,r.cancel_requested_at,s.lifecycle_status
      FROM delegation d JOIN agent_run r ON r.run_id=d.parent_run_id JOIN session s ON s.session_id=d.parent_session_id WHERE d.delegation_id=?`)
        .get(delegationId);
      if (
        row?.target_expert_id !== "researcher" ||
        row.status !== "RUNNING" ||
        row.attempt !== attempt ||
        row.parent_status !== "RUNNING" ||
        row.parent_attempt !== parentAttempt ||
        row.cancel_requested_at ||
        row.lifecycle_status !== "ACTIVE"
      )
        throw new Error("RESEARCH_DELEGATION_INVALID");
      if (row.research_memory_revision !== baseRevision || snapshot.revision !== baseRevision + 1)
        throw new Error("RESEARCH_MEMORY_REVISION_CONFLICT");
      if (JSON.stringify(snapshot.memory).length > 16000 || snapshot.coveredToolCallIds.length > 2048)
        throw new Error("RESEARCH_MEMORY_LIMIT");
      db.prepare("UPDATE delegation SET research_memory_json=?,research_memory_revision=? WHERE delegation_id=?").run(
        json(snapshot),
        snapshot.revision,
        delegationId,
      );
    }),
  /** 列出一条子任务的全部持久化尝试及中断原因。 */
  listDelegationAttempts: (delegationId: string) =>
    (
      db.prepare("SELECT * FROM delegation_attempt WHERE delegation_id = ? ORDER BY attempt").all(delegationId) as Row[]
    ).map((row) => ({
      attempt: Number(row.attempt),
      status: row.status,
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      errorCode: row.error_code ? String(row.error_code) : null,
    })),
  /** 读取本会话已保存的压缩检查点；不返回未授权会话的数据。 */
  listContextCheckpoints: (sessionId: string) =>
    (
      db
        .prepare(
          "SELECT * FROM context_checkpoint WHERE session_id = ? ORDER BY created_at DESC, ordinal DESC LIMIT 30",
        )
        .all(sessionId) as Row[]
    ).map((row) => ({
      checkpointId: String(row.checkpoint_id),
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      ordinal: Number(row.ordinal),
      status: row.status,
      reason: row.reason,
      anchorMessageId: row.anchor_message_id ? String(row.anchor_message_id) : null,
      merchantSnapshotId: row.merchant_snapshot_id ? String(row.merchant_snapshot_id) : null,
      merchantSnapshotHash: row.merchant_snapshot_hash ? String(row.merchant_snapshot_hash) : null,
      summaryTemplateVersion: String(row.summary_template_version),
      adapterVersion: row.adapter_version ? String(row.adapter_version) : null,
      sourceSnapshotHash: row.source_snapshot_hash ? String(row.source_snapshot_hash) : null,
      finalSnapshotHash: row.final_snapshot_hash ? String(row.final_snapshot_hash) : null,
      firstKeptEntryId: row.first_kept_entry_id ? String(row.first_kept_entry_id) : null,
      summary: row.summary ? String(row.summary) : null,
      summaryHash: row.summary_hash ? String(row.summary_hash) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      createdAt: String(row.created_at),
    })),
  /** 子 Agent 提问时暂停交接；相同已回答问题重入直接复用回答。 */
  askDelegation: (delegationId: string, question: string, now: string) =>
    transaction(() => {
      const row = db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row | undefined;
      if (!row || !["RUNNING", "WAITING_INPUT"].includes(String(row.status))) throw new Error("DELEGATION_NOT_RUNNING");
      if (row.question_text === question && row.answer_text) return delegation(row);
      if (row.status === "WAITING_INPUT" && row.question_text !== question)
        throw new Error("DELEGATION_QUESTION_CONFLICT");
      if (row.status === "RUNNING") {
        const version =
          Number(
            (
              db
                .prepare(
                  "SELECT COALESCE(MAX(version), 0) AS version FROM delegation_instruction WHERE delegation_id = ?",
                )
                .get(delegationId) as Row
            ).version,
          ) + 1;
        db.prepare(
          "INSERT INTO delegation_instruction (instruction_id, delegation_id, version, kind, content, created_at, delivered_at) VALUES (?, ?, ?, 'QUESTION', ?, ?, ?)",
        ).run(`ins_${randomUUID()}`, delegationId, version, question, now, now);
        db.prepare(
          "UPDATE delegation SET status = 'WAITING_INPUT', question_text = ?, answer_text = NULL, updated_at = ? WHERE delegation_id = ?",
        ).run(question, now, delegationId);
        db.prepare(
          "UPDATE delegation_attempt SET status = 'WAITING_INPUT' WHERE delegation_id = ? AND attempt = ? AND status = 'RUNNING'",
        ).run(delegationId, Number(row.attempt));
      }
      return delegation(db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row);
    }),
  /** 用户回答作为版本化输入事件保存，不修改原冻结任务单。 */
  answerDelegation: (delegationId: string, answer: string, now: string) =>
    transaction(() => {
      const row = db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row | undefined;
      if (!row?.question_text || !["WAITING_INPUT", "QUEUED"].includes(String(row.status)))
        throw new Error("DELEGATION_NOT_WAITING_INPUT");
      const parent = db.prepare("SELECT status FROM agent_run WHERE run_id = ?").get(row.parent_run_id as string) as
        | Row
        | undefined;
      if (!parent || !["QUEUED", "RUNNING"].includes(String(parent.status)))
        throw new Error("DELEGATION_PARENT_UNAVAILABLE");
      if (row.answer_text) throw new Error("DELEGATION_ALREADY_ANSWERED");
      const version =
        Number(
          (
            db
              .prepare(
                "SELECT COALESCE(MAX(version), 0) AS version FROM delegation_instruction WHERE delegation_id = ?",
              )
              .get(delegationId) as Row
          ).version,
        ) + 1;
      db.prepare(
        "INSERT INTO delegation_instruction (instruction_id, delegation_id, version, kind, content, created_at, delivered_at) VALUES (?, ?, ?, 'ANSWER', ?, ?, ?)",
      ).run(`ins_${randomUUID()}`, delegationId, version, answer, now, now);
      db.prepare(
        "UPDATE delegation SET answer_text = ?, status = CASE WHEN status = 'WAITING_INPUT' THEN 'RUNNING' ELSE 'QUEUED' END, updated_at = ? WHERE delegation_id = ?",
      ).run(answer, now, delegationId);
      if (row.status === "WAITING_INPUT")
        db.prepare(
          "UPDATE delegation_attempt SET status = 'RUNNING' WHERE delegation_id = ? AND attempt = ? AND status = 'WAITING_INPUT'",
        ).run(delegationId, Number(row.attempt));
      return delegation(db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row);
    }),
  /** 用户调整指令保存为追加事件，并由活动子 Agent 尝试实时接收。 */
  steerDelegation: (delegationId: string, content: string, now: string) =>
    transaction(() => {
      const row = db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row | undefined;
      if (!row || !["QUEUED", "RUNNING", "WAITING_INPUT"].includes(String(row.status)))
        throw new Error("DELEGATION_NOT_ACTIVE");
      const parent = db.prepare("SELECT status FROM agent_run WHERE run_id = ?").get(row.parent_run_id as string) as
        | Row
        | undefined;
      if (parent?.status !== "RUNNING") throw new Error("DELEGATION_PARENT_UNAVAILABLE");
      const version =
        Number(
          (
            db
              .prepare(
                "SELECT COALESCE(MAX(version), 0) AS version FROM delegation_instruction WHERE delegation_id = ?",
              )
              .get(delegationId) as Row
          ).version,
        ) + 1;
      db.prepare(
        "INSERT INTO delegation_instruction (instruction_id, delegation_id, version, kind, content, created_at) VALUES (?, ?, ?, 'STEER', ?, ?)",
      ).run(`ins_${randomUUID()}`, delegationId, version, content, now);
      return { delegation: delegation(row), version };
    }),
  /** 标记调整指令已经交给 Pi 的下一推理边界。 */
  markDelegationSteerDelivered: (delegationId: string, version: number, now: string) =>
    transaction(() => {
      const changed = db
        .prepare(
          "UPDATE delegation_instruction SET delivered_at = COALESCE(delivered_at, ?) WHERE delegation_id = ? AND version = ? AND kind = 'STEER'",
        )
        .run(now, delegationId, version);
      if (!changed.changes) throw new Error("DELEGATION_STEER_MISSING");
    }),
  /** 重启子尝试前读取所有追加输入，供新子会话重建受控任务包。 */
  listDelegationInstructions: (delegationId: string) =>
    db
      .prepare("SELECT version, kind, content FROM delegation_instruction WHERE delegation_id = ? ORDER BY version")
      .all(delegationId) as Row[],
  /** 父工具真正收到结果后记 ACK；重复交付同一结果可安全重入。 */
  acknowledgeDelegation: (delegationId: string, now: string) =>
    transaction(() => {
      db.prepare(
        "UPDATE delegation SET parent_ack_at = COALESCE(parent_ack_at, ?) WHERE delegation_id = ? AND status = 'SUCCEEDED'",
      ).run(now, delegationId);
      const row = db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row | undefined;
      if (!row) throw new Error("DELEGATION_NOT_FOUND");
      return delegation(row);
    }),
  /** 保存子任务实际授权输入和快照哈希。 */
  freezeDelegationInput: (delegationId: string, snapshot: DelegationInputSnapshot, childPlanJson: string) =>
    transaction(() => {
      const row = db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row | undefined;
      if (row?.status !== "QUEUED") throw new Error("DELEGATION_NOT_QUEUED");
      if (row.input_snapshot_json) {
        if (String(row.input_snapshot_json) !== json(snapshot) || String(row.child_plan_json) !== childPlanJson)
          throw new Error("DELEGATION_CONFLICT");
        return delegation(row);
      }
      db.prepare("UPDATE delegation SET input_snapshot_json = ?, child_plan_json = ? WHERE delegation_id = ?").run(
        json(snapshot),
        childPlanJson,
        delegationId,
      );
      return delegation(db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row);
    }),
  /** 把委派标记为正在运行。 */
  startDelegation: (delegationId: string, now: string) =>
    transaction(() => {
      const queued = db
        .prepare("SELECT input_json, input_snapshot_json FROM delegation WHERE delegation_id = ?")
        .get(delegationId) as Row | undefined;
      if (
        queued &&
        (JSON.parse(String(queued.input_json)) as { version?: number }).version === 2 &&
        !queued.input_snapshot_json
      )
        throw new Error("DELEGATION_INPUT_NOT_FROZEN");
      const changed = db
        .prepare(
          "UPDATE delegation SET status = 'RUNNING', attempt = attempt + 1, updated_at = ? WHERE delegation_id = ? AND status = 'QUEUED'",
        )
        .run(now, delegationId);
      const row = db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row | undefined;
      if (!row) throw new Error("DELEGATION_NOT_FOUND");
      if (changed.changes)
        db.prepare(
          "INSERT INTO delegation_attempt (delegation_id, attempt, status, started_at) VALUES (?, ?, 'RUNNING', ?)",
        ).run(delegationId, Number(row.attempt), now);
      return delegation(row);
    }),
  /** 先保存子 Agent 的结构化结果再交给父 Agent。 */
  submitDelegation: (
    delegationId: string,
    result: NonNullable<DelegationRecord["result"]>,
    now: string,
    expectedAttempt?: number,
    expectedParentAttempt?: number,
  ) =>
    transaction(() => {
      const row = db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row | undefined;
      if (row?.status !== "RUNNING") throw new Error("DELEGATION_NOT_RUNNING");
      if (expectedAttempt !== undefined && row.attempt !== expectedAttempt)
        throw new Error("DELEGATION_ATTEMPT_CHANGED");
      const parent = db
        .prepare("SELECT status,attempt,cancel_requested_at FROM agent_run WHERE run_id=?")
        .get(String(row.parent_run_id)) as Row | undefined;
      if (
        parent?.status !== "RUNNING" ||
        parent.cancel_requested_at ||
        (expectedParentAttempt !== undefined && parent.attempt !== expectedParentAttempt)
      )
        throw new Error("DELEGATION_PARENT_UNAVAILABLE");
      db.prepare(
        "UPDATE delegation SET status = 'SUCCEEDED', result_json = ?, result_submitted_at = ?, updated_at = ? WHERE delegation_id = ?",
      ).run(json(result), now, now, delegationId);
      db.prepare(
        "UPDATE delegation_attempt SET status = 'SUCCEEDED', finished_at = ? WHERE delegation_id = ? AND attempt = ? AND status = 'RUNNING'",
      ).run(now, delegationId, Number(row.attempt));
      return delegation(db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row);
    }),
  /** 以失败或取消终态收口未完成的委派。 */
  finishDelegation: (delegationId: string, status: "FAILED" | "CANCELLED", errorCode: string, now: string) =>
    transaction(() => {
      const active = db
        .prepare("SELECT attempt FROM delegation WHERE delegation_id = ? AND status IN ('RUNNING', 'WAITING_INPUT')")
        .get(delegationId) as Row | undefined;
      db.prepare(
        "UPDATE delegation SET status = ?, error_code = ?, updated_at = ? WHERE delegation_id = ? AND status IN ('QUEUED', 'RUNNING', 'WAITING_INPUT')",
      ).run(status, errorCode, now, delegationId);
      if (active)
        db.prepare(
          "UPDATE delegation_attempt SET status = ?, finished_at = ?, error_code = ? WHERE delegation_id = ? AND attempt = ? AND status IN ('RUNNING', 'WAITING_INPUT')",
        ).run(status, now, errorCode, delegationId, Number(active.attempt));
      const row = db.prepare("SELECT * FROM delegation WHERE delegation_id = ?").get(delegationId) as Row | undefined;
      if (!row) throw new Error("DELEGATION_NOT_FOUND");
      return delegation(row);
    }),
  /** 登记受管文件及其会话归属和 Blob 引用。 */
  createArtifact: (
    id: string,
    sessionId: string,
    title: string,
    hash: string,
    mime: string,
    size: number,
    operationKey: string,
    now: string,
  ) =>
    transaction(() => {
      const requestHash = operationHash({ sessionId, title, hash, mime, size });
      const previous = previousOperation(operationKey, "upload", requestHash);
      if (previous) return previous;
      requireBlobNotCollecting(hash);
      db.prepare(
        "INSERT INTO artifact (artifact_id, session_id, kind, title, blob_hash, mime_type, size_bytes, status, created_at) VALUES (?, ?, 'upload', ?, ?, ?, ?, 'READY', ?)",
      ).run(id, sessionId, title, hash, mime, size, now);
      const result = {
        artifactId: id,
        sessionId,
        kind: "upload",
        title,
        blobHash: hash,
        mimeType: mime,
        sizeBytes: size,
        status: "READY",
        createdAt: now,
      };
      db.prepare(
        "INSERT INTO api_operation (operation_key, kind, result_json, request_hash, created_at) VALUES (?, 'upload', ?, ?, ?)",
      ).run(operationKey, json(result), requestHash, now);
      return result;
    }),
  /** 读取指定附件的元数据和权限信息。 */
  getArtifact: (id: string) => {
    const row = db.prepare("SELECT * FROM artifact WHERE artifact_id = ?").get(id) as Row | undefined;
    return row
      ? {
          artifactId: row.artifact_id,
          sessionId: row.session_id,
          kind: row.kind,
          title: row.title,
          blobHash: row.blob_hash,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes,
          status: row.status,
        }
      : null;
  },
  /** 列出指定会话可见的附件。 */
  listArtifacts: (sessionId: string) =>
    db
      .prepare(
        "SELECT artifact_id AS artifactId, session_id AS sessionId, kind, title, blob_hash AS blobHash, mime_type AS mimeType, size_bytes AS sizeBytes, status FROM artifact WHERE session_id = ? AND kind = 'upload' ORDER BY created_at DESC LIMIT 100",
      )
      .all(sessionId),
};

parentPort?.on("message", (request: Request) => {
  try {
    const operation = operations[request.name as keyof typeof operations] as
      | ((...args: unknown[]) => unknown)
      | undefined;
    if (!operation) throw new Error("UNKNOWN_DB_OPERATION");
    const result = operation(...request.args);
    parentPort?.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});

import type { FromSchema } from "json-schema-to-ts";
import type { AcceptedExpertResultV3, AgentMaterialRef, ExpertTaskV3 } from "./expert-contract.js";
import { researchScopeSchema } from "./research.js";
import type { ResearchMemorySnapshot } from "./research-memory.js";
import type { TaskExecutionControl } from "./task-execution.js";
import type { TextTaskSource } from "./topics.js";

/** Host 和工作台共同遵守的 HTTP 数据契约版本。 */
export const CONTRACT_VERSION = 18;

export const EXPERT_ROLE_IDS = ["coordinator", "writer", "visual", "reviewer", "researcher"] as const;
export type ExpertRoleId = (typeof EXPERT_ROLE_IDS)[number];
export const EXPERT_SELECTION_IDS = [...EXPERT_ROLE_IDS, "team"] as const;
export const DEFAULT_PAIRING_CODE = "000000";
export const MAX_MANAGED_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
export type { CapabilityCatalog } from "./capabilities.js";
export interface XhsLoginState {
  status: "UNCONFIGURED" | "AWAITING_LOGIN" | "VERIFYING" | "READY";
  targetUrl: string | null;
}
export type ExpertSelectionId = (typeof EXPERT_SELECTION_IDS)[number];

export interface MerchantProfileFields {
  name: string;
  industry: string;
  serviceArea: string;
  products: string;
  audience: string;
  goals: string;
  voice: string;
  constraints: string;
}

export interface MerchantRecord {
  merchantId: string;
  name: string;
  status: "ACTIVE";
  profileRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantProfileRecord {
  merchantId: string;
  revision: number;
  fields: MerchantProfileFields;
  sha256: string;
  createdAt: string;
}

export type MerchantLinkKind = "ACCOUNT" | "SHOP" | "PRODUCT" | "CONTENT" | "REFERENCE";

export interface MerchantPlatformLink {
  linkId: string;
  merchantId: string;
  revision: number;
  platform: string;
  kind: MerchantLinkKind;
  url: string;
  label: string;
  status: "ACTIVE" | "INACTIVE";
  collectionStatus: "UNFETCHED";
  createdAt: string;
  updatedAt: string;
}

export interface MerchantDetail {
  merchant: MerchantRecord;
  profile: MerchantProfileRecord;
  links: MerchantPlatformLink[];
}

export type MerchantCatalogKind = "PRODUCT" | "KEYWORD" | "TREND" | "COMPETITOR" | "MERCHANT_UPDATE";

/** 商家人工维护的商品或选题线索；公开证据与人工陈述必须分开。 */
export interface MerchantCatalogEntry {
  entryId: string;
  merchantId: string;
  kind: MerchantCatalogKind;
  revision: number;
  status: "ACTIVE" | "INACTIVE";
  name: string;
  detail: string;
  sourceUrl: string | null;
  evidenceId: string | null;
  observedAt: string | null;
  provenance: "MERCHANT_CONFIRMED" | "USER_PROVIDED_LEAD" | "PUBLIC_EVIDENCE";
  sha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantCatalogInput {
  kind: MerchantCatalogKind;
  name: string;
  detail: string;
  sourceUrl: string | null;
  evidenceId: string | null;
  observedAt: string | null;
}

export const merchantCatalogSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "name", "detail", "sourceUrl", "evidenceId", "observedAt"],
  properties: {
    kind: { type: "string", enum: ["PRODUCT", "KEYWORD", "TREND", "COMPETITOR", "MERCHANT_UPDATE"] },
    name: { type: "string", minLength: 1, maxLength: 120 },
    detail: { type: "string", maxLength: 2000 },
    sourceUrl: { anyOf: [{ type: "string", maxLength: 2048 }, { type: "null" }] },
    evidenceId: { anyOf: [{ type: "string", maxLength: 80 }, { type: "null" }] },
    observedAt: { anyOf: [{ type: "string", maxLength: 40 }, { type: "null" }] },
  },
} as const;

export type MemoryKind = "PREFERENCE" | "RULE" | "FACT" | "DECISION" | "PROGRESS";
export const MEMORY_ENTRY_LIMIT = 100;
export const MEMORY_SOURCE_MESSAGE_LIMIT = 80;
export const MEMORY_SOURCE_TEXT_LIMIT = 18000;
export const MEMORY_SUMMARY_TEMPLATE_VERSION = "merchant-memory-v2";
export type MemorySubject = { kind: "MERCHANT" } | { kind: "PRODUCT"; productEntryId: string };
export interface MemoryProductRef {
  entryId: string;
  revision: number;
  sha256: string;
}
export interface MemoryScope {
  version: 1;
  product: MemoryProductRef | null;
}
export interface MemoryReview {
  reviewer: "local-user";
  reviewedAt: string;
}
export const memorySubjectSchema = {
  anyOf: [
    { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "MERCHANT" } } },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "productEntryId"],
      properties: { kind: { const: "PRODUCT" }, productEntryId: { type: "string", minLength: 1, maxLength: 80 } },
    },
  ],
} as const;
export const memoryProductRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entryId", "revision", "sha256"],
  properties: {
    entryId: { type: "string", minLength: 1, maxLength: 80 },
    revision: { type: "integer", minimum: 1 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
} as const;
export interface MemoryFields {
  title: string;
  content: string;
  kind: MemoryKind;
  expiresAt: string | null;
  subject?: MemorySubject;
  productBasis?: MemoryProductRef | null;
}
export interface MemorySource {
  kind: "HUMAN" | "USER_MESSAGE" | "SESSION_SUMMARY";
  sessionId: string | null;
  messageId: string | null;
  jobId: string | null;
  quote: string;
}
export interface MerchantMemory extends MemoryFields {
  review?: MemoryReview;
  memoryId: string;
  merchantId: string;
  tier: "SHORT" | "LONG";
  status: "ACTIVE" | "CANDIDATE" | "INACTIVE";
  revision: number;
  source: MemorySource;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}
export interface MemoryMessageSource {
  product?: MemoryProductRef;
  messageId: string;
  role: "user" | "assistant";
  text: string;
  sha256: string;
  truncated: boolean;
}
export interface MemorySummary {
  overview: string;
  items: Array<{
    kind: "USER_STATEMENT" | "AGENT_SUGGESTION" | "OPEN_QUESTION";
    text: string;
    messageId: string;
    quote: string;
  }>;
  candidates: Array<MemoryFields & { messageId: string; quote: string }>;
}
export interface MemoryJob {
  templateVersion: string;
  jobId: string;
  sessionId: string;
  merchantId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  attempt: number;
  sourceHash: string;
  sourceCount: number;
  omittedCount: number;
  truncatedCount: number;
  errorCode: string | null;
  result: MemorySummary | null;
  createdAt: string;
  updatedAt: string;
}
export const memoryFieldsSchema = {
  subject: memorySubjectSchema,
  productBasis: { anyOf: [memoryProductRefSchema, { type: "null" }] },
  title: { type: "string", minLength: 1, maxLength: 120 },
  content: { type: "string", minLength: 1, maxLength: 2000 },
  kind: { type: "string", enum: ["PREFERENCE", "RULE", "FACT", "DECISION", "PROGRESS"] },
  expiresAt: { anyOf: [{ type: "string", maxLength: 40 }, { type: "null" }] },
} as const;
export const createMemorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "content", "kind", "expiresAt", "subject"],
  properties: memoryFieldsSchema,
} as const;
export const updateMemorySchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "content", "kind", "expiresAt", "expectedRevision", "status"],
  properties: {
    ...memoryFieldsSchema,
    expectedRevision: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
  },
} as const;
export type UpdateMemoryInput = FromSchema<typeof updateMemorySchema>;

/** 页面中实际展示图片的截图引用；不是原图下载或图片使用授权。 */
export interface PublicPageEvidenceImage {
  artifactId: string;
  blobHash: string;
  mimeType: "image/png";
  sizeBytes: number;
  description: string;
  captureKind: "PAGE_IMAGE_SCREENSHOT";
}

export interface PublicPageEvidenceRecord {
  // 来源 URL、最终 URL、访问方式和正文摘要是后续诊断可追溯的最小证据边界。
  evidenceId: string;
  merchantId: string | null;
  sessionId: string;
  runId: string;
  sourceUrl: string;
  finalUrl: string | null;
  title: string;
  visibleText: string;
  visibleTextSha256: string;
  accessMode: "PUBLIC_UNAUTHENTICATED" | "USER_AUTHORIZED";
  links: Array<{ text: string; url: string }>;
  status: "COLLECTED" | "LIMITED" | "BLOCKED" | "FAILED";
  errorCode: string | null;
  collectedAt: string;
  images?: PublicPageEvidenceImage[];
  imageCaptureError?: string;
}

export interface AccountDiagnosisDraft {
  // 观察和推断必须逐条引用证据；未知项不能被模型补成商家事实。
  scope: string;
  summary: string;
  findings: Array<{ kind?: "OBSERVATION" | "INFERENCE"; point: string; evidenceIds: string[] }>;
  actions: Array<{ action: string; evidenceIds: string[] }>;
  unknowns: string[];
}

export interface AccountDiagnosisEvidenceRef {
  evidenceId: string;
  visibleTextSha256: string;
  sourceUrl: string;
  finalUrl: string | null;
  collectedAt: string;
  accessMode: PublicPageEvidenceRecord["accessMode"];
}

export interface AccountDiagnosisRecord {
  diagnosisId: string;
  merchantId: string | null;
  sessionId: string;
  runId: string;
  profileRevision: number | null;
  version: number;
  revisesDiagnosisId: string | null;
  evidenceIds: string[];
  evidenceRefs: AccountDiagnosisEvidenceRef[];
  report: AccountDiagnosisDraft;
  status: "DRAFT";
  createdAt: string;
}

export interface PublicDiagnosisReportRecord {
  reportId: string;
  merchantId: string;
  diagnosisId: string;
  sourceVersion: number;
  artifactId: string;
  blobHash: string;
  createdAt: string;
}

export const createMerchantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string", minLength: 1, maxLength: 120 } },
} as const;
export type CreateMerchantInput = FromSchema<typeof createMerchantSchema>;

export const updateMerchantProfileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "fields"],
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    fields: {
      type: "object",
      additionalProperties: false,
      required: ["name", "industry", "serviceArea", "products", "audience", "goals", "voice", "constraints"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        industry: { type: "string", maxLength: 300 },
        serviceArea: { type: "string", maxLength: 500 },
        products: { type: "string", maxLength: 2000 },
        audience: { type: "string", maxLength: 1000 },
        goals: { type: "string", maxLength: 1000 },
        voice: { type: "string", maxLength: 500 },
        constraints: { type: "string", maxLength: 2000 },
      },
    },
  },
} as const;
export type UpdateMerchantProfileInput = FromSchema<typeof updateMerchantProfileSchema>;

export const merchantLinkSchema = {
  type: "object",
  additionalProperties: false,
  required: ["platform", "kind", "url", "label"],
  properties: {
    platform: { type: "string", minLength: 1, maxLength: 60 },
    kind: { type: "string", enum: ["ACCOUNT", "SHOP", "PRODUCT", "CONTENT", "REFERENCE"] },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    label: { type: "string", maxLength: 120 },
  },
} as const;
export type MerchantLinkInput = FromSchema<typeof merchantLinkSchema>;

export const updateMerchantLinkSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "platform", "kind", "url", "label"],
  properties: {
    ...merchantLinkSchema.properties,
    expectedRevision: { type: "integer", minimum: 1 },
  },
} as const;
export type UpdateMerchantLinkInput = FromSchema<typeof updateMerchantLinkSchema>;

export interface AcceptedMessage {
  messageId: string;
  runId: string;
  operationId: string;
  accepted: boolean;
}

/** 新 Run 冻结的取消任务来源；只保留用户要求、可回读证据及待核实工具，不复用残缺回复。 */
export const MAX_CONTINUATION_REQUESTS = 8;
export const MAX_CONTINUATION_CHARACTERS = 100_000;
export const MAX_CONTINUATION_EVIDENCE_REFS = 20;

/** 一次明确选择接续的有界来源快照，随新 Run 的 Plan hash 固定。 */
export interface RunContinuationSnapshot {
  version: 1;
  sourceRunId: string;
  requests: Array<{ runId: string; messageId: string; content: string; sha256: string }>;
  evidenceRefs: Array<{ evidenceId: string; sha256: string }>;
  omittedEvidenceCount: number;
  uncertainToolIds: string[];
}

export interface DelegationTaskV2 {
  version: 2;
  taskKey?: string;
  targetExpertId: "writer" | "visual" | "reviewer" | "researcher";
  task: string;
  criteria: Array<{ id: string; text: string }>;
  inputRefs: Array<{ type: "uploaded_text" | "public_evidence"; id: string }>;
  contextSummary?: string;
  missingInformation?: string[];
  expectedOutput: "text_draft" | "text_report";
}

export interface DelegationContextPacket {
  version: 1;
  parentMessage: { id: string; sha256: string };
  recentMessages?: Array<{ id: string; role: "user" | "assistant"; sha256: string; excerpt: string }>;
  merchantSnapshot: { id: string; sha256: string } | null;
  readableResources: Array<{ type: "uploaded_text" | "public_evidence"; id: string; sha256: string }>;
  declaredMissingInformation: string[];
}

export interface DelegationInputSnapshot {
  version: 2;
  parentPlanHash: string;
  parentMessageId: string;
  parentPrompt: string;
  childPrompt: string;
  childPlanHash: string;
  merchantSnapshot: { id: string; sha256: string } | null;
  resources: Array<{ type: "uploaded_text" | "public_evidence"; id: string; sha256: string }>;
  expertSha256: string;
  skills: Array<{ name: string; sha256: string }>;
  allowedToolIds: string[];
  contextPacket?: DelegationContextPacket;
  materials?: Array<{ ref: AgentMaterialRef; text: string }>;
  contract?: { id: string; version: number; schemaHash: string };
}

export interface DelegationResultV2 {
  version: 2;
  output: { type: "text_draft" | "text_report"; title?: string; content: string };
  completion: "complete" | "partial";
  unmetCriterionIds: string[];
  notes: string[];
}

export interface DelegationRecord {
  researchMemory?: ResearchMemorySnapshot;
  delegationId: string;
  parentSessionId: string;
  parentRunId: string;
  taskKey: string;
  childSessionId: string;
  childRunId: string;
  targetExpertId: "writer" | "visual" | "reviewer" | "researcher";
  inputHash: string;
  input: { task: string; successCriteria: string } | DelegationTaskV2 | ExpertTaskV3;
  inputSnapshot: DelegationInputSnapshot | null;
  status: "QUEUED" | "RUNNING" | "WAITING_INPUT" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  questionText: string | null;
  answerText: string | null;
  result:
    | { finalText: string; structuredResult?: Record<string, unknown>; unmetCriteria: string[] }
    | DelegationResultV2
    | AcceptedExpertResultV3
    | null;
  errorCode: string | null;
  attempt: number;
  resultSubmittedAt: string | null;
  parentAckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationAttemptRecord {
  attempt: number;
  status: "RUNNING" | "WAITING_INPUT" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
}

/** 当前有效上下文的估算快照；最近一次 Provider 输入量单独保存，不作为累计占用。 */
export interface ContextTokenMeasurement {
  stage: "request" | "response" | "compression_before" | "compression_after" | "settled";
  estimator: "pi-chars-v1";
  estimatedTokens: number;
  contextWindow: number;
  usedPercent: number;
  remainingTokens: number;
  reserveTokens: number;
  remainingBeforeReserve: number;
  requestIndex: number;
  providerInputTokens: number | null;
  measuredAt: string;
}

/** 两次同口径估算的压缩比较；失败时不伪造压缩后长度。 */
export interface ContextCompressionMeasurement {
  kind: "MICROCOMPACT" | "AUTOCOMPACT";
  status: "COMPLETED" | "FAILED";
  before: ContextTokenMeasurement;
  after: ContextTokenMeasurement | null;
  savedTokens: number | null;
  savedPercent: number | null;
}

/** 工具正文清理的工作副本记录；最终保留状态由所属 Run 或专家 Attempt 决定。 */
export interface MicrocompactRecord {
  recordId: string;
  policyVersion: string;
  phase: "before_prompt" | "turn_end";
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  clearedResults: number;
  targetEntryIds: string[];
}

export interface ContextCheckpointRecord {
  checkpointId: string;
  sessionId: string;
  runId: string;
  ordinal: number;
  status: "PENDING" | "READY" | "COMMITTED" | "FAILED" | "ABORTED";
  reason: "manual" | "threshold" | "overflow";
  anchorMessageId: string | null;
  merchantSnapshotId: string | null;
  merchantSnapshotHash: string | null;
  summaryTemplateVersion: string;
  adapterVersion: string | null;
  sourceSnapshotHash: string | null;
  finalSnapshotHash: string | null;
  firstKeptEntryId: string | null;
  summary: string | null;
  summaryHash: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface ArtifactRecord {
  artifactId: string;
  sessionId: string;
  kind?:
    | "upload"
    | "public_diagnosis_report"
    | "content_markdown"
    | "generated_image"
    | "publication_zip"
    | "public_reference_image";
  title: string;
  blobHash: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
}

/** 图片任务冻结 Seedream 参数映射的版本，旧供应商任务不会被新适配器执行。 */
export const SEEDREAM_IMAGE_STRATEGY_VERSION = "seedream-images-v1";

/** 一次持久化的素材生成任务；图片修改始终产生新产物。 */
export interface GenerationJobRecord {
  jobId: string;
  sessionId: string;
  merchantId: string | null;
  intent: "CREATE" | "MODIFY";
  kind: "IMAGE";
  status: "QUEUED" | "RUNNING" | "READY_FOR_REVIEW" | "UNKNOWN_EXTERNAL" | "FAILED";
  prompt: string;
  inputHash: string;
  modelId: string;
  modelVersion: string;
  size: "1024x1024" | "1536x1024" | "1024x1536";
  quality: "low" | "medium" | "high";
  referenceArtifactId: string | null;
  referenceHash: string | null;
  resultArtifactId: string | null;
  providerRequestId: string | null;
  errorCode: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

/** 文案任务通过既有 Agent Run 执行，并将成功回复自动登记为可修订草稿。 */
export interface TextGenerationJobRecord {
  conversation?: { instruction: string; reply: string | null; action: "REVISE" | "REPLY" | null };
  executionControl?: TaskExecutionControl | null;
  purpose:
    | "CONTENT"
    | "TOPIC_PLAN"
    | "PUBLICATION_PLAN"
    | "PUBLICATION_REVIEW"
    | "PUBLICATION_CHAT"
    | "PUBLICATION_SUMMARY"
    | "RESEARCH"
    | "RESEARCH_CONTINUATION";
  source: TextTaskSource | null;
  jobId: string;
  sessionId: string;
  merchantId: string | null;
  intent: "CREATE" | "MODIFY";
  kind: "TEXT";
  status: "QUEUED" | "RUNNING" | "READY_FOR_REVIEW" | "FAILED";
  title: string;
  prompt: string;
  modelId: string;
  inputHash: string;
  templateId: "PRODUCT_PROMOTION" | null;
  templateVersion: string | null;
  templateHash: string | null;
  productEntryId: string | null;
  productRevision: number | null;
  productHash: string | null;
  targetDraftId: string | null;
  targetRevision: number | null;
  targetHash: string | null;
  sourceRunId: string | null;
  resultDraftId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 从一条成功的 Agent 回复提取的、可独立修订与审核的素材草稿。 */
export interface ContentDraftRecord {
  draftId: string;
  sessionId: string;
  merchantId: string | null;
  sourceMessageId: string;
  sourceRunId: string;
  currentRevision: number;
  approvedRevision: number | null;
  title: string;
  body: string;
  internalNotes?: string;
  sha256: string;
  artifactId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 素材草稿的一版不可变正文，审核登记的产物仍指向这一版。 */
export interface ContentRevisionRecord {
  draftId: string;
  revision: number;
  title: string;
  body: string;
  internalNotes?: string;
  sha256: string;
  author: "AGENT" | "USER";
  artifactId: string | null;
  createdAt: string;
}

/** 一次读取恢复会话展示所需的消息、Run 和未完成文本。 */
export interface SessionSnapshot {
  session: SessionRecord;
  messages: MessageRecord[];
  activeRun: RunRecord | null;
  latestRun: RunRecord | null;
  streamText: string;
  thinkingText: string;
  toolEvents: RuntimeEvent[];
  contextSummary: Record<string, unknown> | null;
  contextTokens: ContextTokenMeasurement | null;
  committedContextTokens: ContextTokenMeasurement | null;
  attachmentReadCount: number;
}

/** 启动时发现的未完成任务和文件异常，供只读排障接口展示。 */
export interface RecoveryReport {
  scannedAt: string;
  interruptedRunIds: string[];
  queuedRunIds: string[];
  stagingFiles: Array<{ name: string; sizeBytes: number; modifiedAt: string; kind: "file" | "unexpected" }>;
  blobIssues: Array<{ hash: string; reason: "MISSING" | "SIZE_MISMATCH" | "HASH_MISMATCH" | "INVALID_PATH" }>;
  items: Array<{
    resourceKind: "run" | "staging" | "blob";
    resourceId: string;
    disposition: "RETRY" | "RECONCILE" | "MANUAL" | "FAILED";
    reason: string;
  }>;
}

export interface ApiError {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
}

// JSON Schema 同时供接口校验和 TypeScript 类型推导使用。
export const sessionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sessionId",
    "scope",
    "ownerId",
    "title",
    "modelAlias",
    "lifecycleStatus",
    "titleRevision",
    "unreadCount",
    "firstUnreadMessageId",
    "lastSeq",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    researchScope: researchScopeSchema,
    sessionId: { type: "string" },
    scope: { type: "string", enum: ["NORMAL", "MERCHANT"] },
    ownerId: { type: "string" },
    title: { type: "string" },
    modelAlias: { type: "string" },
    lifecycleStatus: { type: "string", enum: ["ACTIVE", "ARCHIVED", "TRASHED"] },
    titleRevision: { type: "integer", minimum: 1 },
    unreadCount: { type: "integer", minimum: 0 },
    firstUnreadMessageId: { anyOf: [{ type: "string" }, { type: "null" }] },
    deletedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    trashExpiresAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    lastSeq: { type: "integer", minimum: 0 },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
} as const;
export type SessionRecord = FromSchema<typeof sessionSchema>;
export type SessionScope = SessionRecord["scope"];

/** 游标分页的会话列表，nextCursor 为空表示已到末页。 */
export interface SessionPage {
  items: SessionRecord[];
  nextCursor: string | null;
}

/** 关键词命中消息及其会话归属，点击时用消息 ID 定位。 */
export interface MessageSearchHit {
  sessionId: string;
  sessionTitle: string;
  merchantId: string | null;
  messageId: string;
  role: "user" | "assistant";
  excerpt: string;
  createdAt: string;
}

/** 删除前展示仍被会话持有的对象数量。 */
export interface SessionDeleteImpact {
  sessionId: string;
  messages: number;
  runs: number;
  artifacts: number;
  evidence: number;
  diagnoses: number;
  reports: number;
  delegations: number;
  checkpoints: number;
  memoryJobs: number;
  sharedMemories: number;
  workPlans: number;
  publicationReviews: number;
  publicationRecords: number;
  activeRun: boolean;
}

export const bindSessionMerchantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["merchantId"],
  properties: { merchantId: { type: "string", minLength: 1 } },
} as const;
export type BindSessionMerchantInput = FromSchema<typeof bindSessionMerchantSchema>;

export const messageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["messageId", "sessionId", "runId", "role", "content", "createdAt"],
  properties: {
    messageId: { type: "string" },
    sessionId: { type: "string" },
    runId: { anyOf: [{ type: "string" }, { type: "null" }] },
    role: { type: "string", enum: ["user", "assistant"] },
    content: { type: "string" },
    thinking: { type: "string" },
    createdAt: { type: "string" },
  },
} as const;
export type MessageRecord = FromSchema<typeof messageSchema>;

export const modelUsageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"],
  properties: {
    inputTokens: { type: "integer", minimum: 0 },
    outputTokens: { type: "integer", minimum: 0 },
    cacheReadTokens: { type: "integer", minimum: 0 },
    cacheWriteTokens: { type: "integer", minimum: 0 },
    totalTokens: { type: "integer", minimum: 0 },
    reasoningTokens: { type: "integer", minimum: 0 },
  },
} as const;
export type ModelUsageSummary = FromSchema<typeof modelUsageSchema>;

/** Run 的状态和模型方案由 Host 持久化，前端只读取执行结果。 */
export const runSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "runId",
    "sessionId",
    "status",
    "attempt",
    "modelAlias",
    "errorCode",
    "errorMessage",
    "cancelRequestedAt",
    "runtimeSnapshotRef",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    runId: { type: "string" },
    sessionId: { type: "string" },
    status: {
      type: "string",
      enum: ["QUEUED", "RUNNING", "RECOVERING", "WAITING_CONFIRMATION", "SUCCEEDED", "FAILED", "CANCELLED"],
    },
    attempt: { type: "integer", minimum: 0 },
    modelAlias: { type: "string" },
    adapterVersion: { type: "string" },
    modelFingerprint: { type: "string" },
    usage: { anyOf: [modelUsageSchema, { type: "null" }] },
    errorCode: { anyOf: [{ type: "string" }, { type: "null" }] },
    errorMessage: { anyOf: [{ type: "string" }, { type: "null" }] },
    cancelRequestedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    runtimeSnapshotRef: { anyOf: [{ type: "string" }, { type: "null" }] },
    runtimeSnapshotHash: { anyOf: [{ type: "string" }, { type: "null" }] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
} as const;
export type RunRecord = FromSchema<typeof runSchema>;
export type RunStatus = RunRecord["status"];

/** 每个会话的 seq 单调递增，用于断线补发和缺口检测。 */
export const runtimeEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId", "sessionId", "runId", "seq", "type", "occurredAt", "payload"],
  properties: {
    eventId: { type: "string" },
    sessionId: { type: "string" },
    runId: { anyOf: [{ type: "string" }, { type: "null" }] },
    seq: { type: "integer", minimum: 0 },
    type: { type: "string" },
    occurredAt: { type: "string" },
    payload: { type: "object", required: [], additionalProperties: true },
  },
} as const;
export type RuntimeEvent = FromSchema<typeof runtimeEventSchema>;

export const createSessionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;
export type CreateSessionInput = FromSchema<typeof createSessionSchema>;

export const sendMessageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "clientTurnId"],
  properties: {
    content: { type: "string", minLength: 1, maxLength: 100_000 },
    clientTurnId: { type: "string", minLength: 1, maxLength: 128 },
    continueFromRunId: { type: "string", pattern: "^run_[A-Za-z0-9-]+$" },
    expertRole: { type: "string", enum: EXPERT_SELECTION_IDS },
    artifactIds: {
      type: "array",
      maxItems: 50,
      uniqueItems: true,
      items: { type: "string", pattern: "^art_[A-Za-z0-9-]+$" },
    },
  },
} as const;
export type SendMessageInput = FromSchema<typeof sendMessageSchema>;

export const pairingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", pattern: "^[0-9]{6}$" },
  },
} as const;
export type PairingInput = FromSchema<typeof pairingSchema>;

export interface ModelAvailability {
  configured: boolean;
  alias: string | null;
  reason: string | null;
  imageInput?: boolean;
}

export interface SystemPromptSetting {
  content: string;
  revision: number;
  sha256: string;
  updatedAt: string;
  defaultContent: string;
}

export const updateSystemPromptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "revision"],
  properties: {
    content: { type: "string", minLength: 1, maxLength: 20_000 },
    revision: { type: "integer", minimum: 1 },
  },
} as const;
export type UpdateSystemPromptInput = FromSchema<typeof updateSystemPromptSchema>;

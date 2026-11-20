import type { FromSchema } from "json-schema-to-ts";

export const researchScopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "focus", "windowDays", "productId", "catalogSourceIds", "linkSourceIds"],
  properties: {
    goal: { enum: ["KEYWORDS", "TRENDS", "COMPETITORS"] },
    focus: { type: "string", maxLength: 500 },
    windowDays: { type: "integer", minimum: 1, maximum: 365 },
    productId: { anyOf: [{ type: "string", minLength: 1, maxLength: 100 }, { type: "null" }] },
    catalogSourceIds: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 100 },
      uniqueItems: true,
      maxItems: 30,
    },
    linkSourceIds: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 100 },
      uniqueItems: true,
      maxItems: 20,
    },
  },
} as const;
export type ResearchScope = FromSchema<typeof researchScopeSchema>;

const evidenceIdsSchema = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 100 },
  minItems: 1,
  maxItems: 20,
  uniqueItems: true,
} as const;
const nullableDateSchema = { anyOf: [{ type: "string", minLength: 1, maxLength: 40 }, { type: "null" }] } as const;
const candidateFields = {
  title: { type: "string", minLength: 1, maxLength: 120 },
  merchantRelevance: { type: "string", minLength: 1, maxLength: 1000 },
  audience: { type: "string", minLength: 1, maxLength: 500 },
  contentAngle: { type: "string", minLength: 1, maxLength: 1000 },
  evidenceIds: evidenceIdsSchema,
  cautions: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, maxItems: 10 },
} as const;
const candidateRequired = [
  "kind",
  "title",
  "merchantRelevance",
  "audience",
  "contentAngle",
  "evidenceIds",
  "cautions",
  "details",
] as const;
export const researchCandidateSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: candidateRequired,
      properties: {
        ...candidateFields,
        kind: { const: "KEYWORD" },
        details: {
          type: "object",
          additionalProperties: false,
          required: ["category", "intent", "priority"],
          properties: {
            category: { type: "string", minLength: 1, maxLength: 80 },
            intent: { enum: ["AWARENESS", "COMPARISON", "ACTION"] },
            priority: { enum: ["P0", "P1", "P2"] },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: candidateRequired,
      properties: {
        ...candidateFields,
        kind: { const: "TREND" },
        details: {
          type: "object",
          additionalProperties: false,
          required: ["publishedAt", "validUntil"],
          properties: { publishedAt: nullableDateSchema, validUntil: nullableDateSchema },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: candidateRequired,
      properties: {
        ...candidateFields,
        kind: { const: "COMPETITOR_DIFFERENCE" },
        details: {
          type: "object",
          additionalProperties: false,
          required: ["dimension", "observation", "ownEvidenceIds", "competitorEvidenceIds"],
          properties: {
            dimension: { type: "string", minLength: 1, maxLength: 120 },
            observation: { type: "string", minLength: 1, maxLength: 1500 },
            ownEvidenceIds: evidenceIdsSchema,
            competitorEvidenceIds: evidenceIdsSchema,
          },
        },
      },
    },
  ],
} as const;
export type ResearchCandidate = FromSchema<typeof researchCandidateSchema>;

export const researchSaveSchema = {
  type: "object",
  additionalProperties: false,
  required: ["batchKey", "coverage", "gaps", "candidates"],
  properties: {
    batchKey: { type: "string", minLength: 1, maxLength: 80 },
    coverage: { type: "string", minLength: 1, maxLength: 2000 },
    gaps: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, maxItems: 20 },
    candidates: { type: "array", items: researchCandidateSchema, maxItems: 20 },
  },
} as const;
export type ResearchSaveInput = FromSchema<typeof researchSaveSchema>;

/** 研究来源引用固定原文摘要与采集时间，不随后续采集变化。 */
export interface ResearchEvidenceRef {
  evidenceId: string;
  sha256: string;
  sourceUrl: string;
  collectedAt: string;
}

/** 一次 Run 提交的不可变研究候选，只有成功 Run 的结果可采用。 */
export interface ResearchBatch extends ResearchSaveInput {
  batchId: string;
  merchantId: string;
  sessionId: string;
  runId: string;
  sourceAttempt: number;
  snapshotId: string;
  profileRevision: number;
  scope: ResearchScope;
  evidenceRefs: ResearchEvidenceRef[];
  sha256: string;
  createdAt: string;
  sourceRunStatus: string;
  stale: boolean;
}

/** Host 使用固定版本模板生成的研究文档，文字与结构化来源保持对应。 */
export interface ResearchDocument {
  templateVersion: 1;
  title: string;
  markdown: string;
}

/** 成功研究 Run 自动生成的不可变报告；报告生成不代表候选已被采用。 */
export interface ResearchReport extends ResearchDocument {
  reportId: string;
  merchantId: string;
  sessionId: string;
  runId: string;
  sourceAttempt: number;
  snapshotId: string;
  profileRevision: number;
  scope: ResearchScope;
  batchRefs: Array<{ batchId: string; sha256: string }>;
  createdAt: string;
  sha256: string;
  sourceRunStatus: string;
  stale: boolean;
}

/** 一次研究会话的内容分析进度；每轮用户补充和运行重试均保留独立尝试。 */
export interface ContentAnalysis {
  analysisId: string;
  merchantId: string;
  sessionId: string;
  scope: ResearchScope;
  status: "QUEUED" | "COLLECTING" | "ANALYZING" | "READY" | "PARTIAL" | "WAITING_INPUT" | "FAILED" | "CANCELLED";
  latestReadyReportId: string | null;
  attempts: ContentAnalysisAttempt[];
  createdAt: string;
  updatedAt: string;
}

/** 固定一次 Run 执行的来源、缺口与结果，旧尝试不能被新尝试覆盖。 */
export interface ContentAnalysisAttempt {
  runId: string;
  runAttempt: number;
  status: ContentAnalysis["status"] | "INTERRUPTED";
  snapshotId: string;
  snapshotHash: string;
  sourceRefs: ResearchEvidenceRef[];
  gaps: string[];
  reportId: string | null;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 用户采用的商家研究建议；采用不把模型推断变为商家确认事实。 */
export interface ResearchLibraryItem {
  itemId: string;
  merchantId: string;
  revision: number;
  status: "ACTIVE" | "INACTIVE";
  candidate: ResearchCandidate;
  sourceBatchId: string;
  sourceCandidateIndex: number;
  snapshotId: string;
  profileRevision: number;
  evidenceRefs: ResearchEvidenceRef[];
  sha256: string;
  adoptedAt: string;
  expiresAt: string | null;
  stale: boolean;
}

export const researchAdoptSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "candidateIndex",
    "title",
    "merchantRelevance",
    "contentAngle",
    "targetItemId",
    "expectedRevision",
    "allowStale",
  ],
  properties: {
    candidateIndex: { type: "integer", minimum: 0, maximum: 19 },
    title: candidateFields.title,
    merchantRelevance: candidateFields.merchantRelevance,
    contentAngle: candidateFields.contentAngle,
    targetItemId: { anyOf: [{ type: "string", minLength: 1, maxLength: 100 }, { type: "null" }] },
    expectedRevision: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    allowStale: { type: "boolean" },
  },
} as const;
export type ResearchAdoptInput = FromSchema<typeof researchAdoptSchema>;

/** 将同类词条的空白和大小写规范化，用于重复提示和并发去重。 */
export function normalizedResearchTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

import type { FromSchema } from "json-schema-to-ts";
import type { MerchantProfileFields } from "./contracts.js";
import type { PublicationReview, ReviewBindingV2 } from "./publication.js";
import type { PublicationConversationFlow } from "./publication-conversation.js";
import type { PublicationRepairBasis } from "./publication-repair.js";
import type { ResearchEvidenceRef, ResearchReport } from "./research.js";
import type { BackgroundResearchSource, ResearchContinuationSource } from "./research-agent.js";
import type { TaskContextRef, TaskRequirement } from "./task-context.js";
import type { TaskExecutionControl } from "./task-execution.js";

const shortText = { type: "string", minLength: 1, maxLength: 500 } as const;
export const topicFieldsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "audience", "angle", "format", "merchantRelevance", "evidenceIds", "materials", "cautions"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    audience: shortText,
    angle: { type: "string", minLength: 1, maxLength: 1000 },
    format: shortText,
    merchantRelevance: { type: "string", minLength: 1, maxLength: 1000 },
    evidenceIds: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 100 },
      minItems: 0,
      maxItems: 20,
      uniqueItems: true,
    },
    materials: { type: "array", items: shortText, maxItems: 10 },
    cautions: { type: "array", items: shortText, maxItems: 20 },
  },
} as const;
export type TopicFields = FromSchema<typeof topicFieldsSchema>;
export const topicOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topics"],
  properties: { topics: { type: "array", items: topicFieldsSchema, minItems: 1, maxItems: 5 } },
} as const;
export const topicPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["allowStale"],
  anyOf: [{ required: ["reportId", "reportHash"] }, { required: ["brief"] }],
  properties: {
    brief: { type: "string", minLength: 1, maxLength: 8000 },
    reportId: { type: "string", minLength: 1, maxLength: 100 },
    reportHash: { type: "string", minLength: 64, maxLength: 64 },
    allowStale: { type: "boolean" },
  },
} as const;
/** 选题可来自成功研究或明确的本次商家创作目标。 */
export interface TopicPlanInput {
  reportId?: string;
  reportHash?: string;
  brief?: string;
  allowStale: boolean;
}
export const topicUpdateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "status", "fields"],
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    status: { enum: ["ACTIVE", "INACTIVE"] },
    fields: topicFieldsSchema,
  },
} as const;
export type TopicUpdateInput = FromSchema<typeof topicUpdateSchema>;
const artifactIds = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 100 },
  uniqueItems: true,
  maxItems: 5,
} as const;
export const topicCreationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "topicId",
    "topicRevision",
    "templateId",
    "styleMode",
    "styleBrief",
    "channel",
    "textArtifactIds",
    "imageArtifactIds",
    "allowStale",
  ],
  properties: {
    topicId: { type: "string", minLength: 1, maxLength: 100 },
    topicRevision: { type: "integer", minimum: 1 },
    templateId: { enum: ["FREE", "PRODUCT_PROMOTION"] },
    styleMode: { enum: ["NONE", "KEEP", "NEW"] },
    styleBrief: { type: "string", maxLength: 2000 },
    channel: { type: "string", minLength: 1, maxLength: 100 },
    textArtifactIds: artifactIds,
    imageArtifactIds: artifactIds,
    allowStale: { type: "boolean" },
  },
} as const;
export type TopicCreationInput = FromSchema<typeof topicCreationSchema>;

/** 可编辑选题的当前版本；状态只表示是否可选，不表示已排期或已发布。 */
export interface TopicCard extends TopicFields {
  topicId: string;
  merchantId: string;
  sessionId: string;
  revision: number;
  status: "ACTIVE" | "INACTIVE";
  sha256: string;
  planningJobId: string;
  sourceReportId: string | null;
  sourceReportHash: string | null;
  sourceProfileRevision: number;
  expiresAt: string | null;
  evidenceRefs: ResearchEvidenceRef[];
  sourceCautions: string[];
  sourceProfile?: { merchantId: string; revision: number; fields: MerchantProfileFields; sha256: string };
  createdAt: string;
}

/** 任务固定的研究、选题及参考资料；历史任务不随编辑漂移。 */
export interface TextTaskSource {
  research?: BackgroundResearchSource;
  researchContinuation?: ResearchContinuationSource;
  researchRootJobId?: string;
  researchContext?: string;
  taskContext?: TaskContextRef;
  workflow?: PublicationConversationFlow;
  executionControl?: TaskExecutionControl;
  asyncSummaryVersion?: 1;
  asyncSummaryUserMessageId?: string | null;
  delivery?: {
    key: string;
    summaryJobId: string;
    state: "PENDING" | "DELIVERED" | "SUPERSEDED" | "FAILED";
    summary?: string;
    errorCode?: string;
  };
  summary?: { parentJobId: string; basisHash: string; userMessageId: string | null; facts: Record<string, unknown> };
  parentConversationJobId?: string;
  originRunId?: string;
  conversation?: { instruction: string; intentProtocol?: 1 };
  planningImageCount?: number;
  repair?: PublicationRepairBasis;
  expiresAt?: string | null;
  report?: ResearchReport;
  profile?: { merchantId: string; revision: number; fields: MerchantProfileFields; sha256: string };
  planningBrief?: string;
  review?: {
    formatVersion?: 3;
    previousReview?: { reviewId: string; sha256: string; issues: PublicationReview["issues"] };
    snapshotHash: string;
    comparedImages: number;
    totalImages: number;
    binding?: ReviewBindingV2;
    requirements?: TaskRequirement[];
    evidenceRefs?: string[];
  };
  publication?: { draftId: string; draftRevision: number; publicationRevision: number };
  topic?: TopicCard;
  creation?: TopicCreationInput;
  product?: ProductContentSnapshot | null;
  template?: { templateId: "PRODUCT_PROMOTION"; version: string; sha256: string } | null;
  references: Array<{ artifactId: string; blobHash: string; mimeType: string }>;
}

/** 文案任务实际使用的商品内容，与商品库后续修订分开保存。 */
export interface ProductContentSnapshot {
  entryId: string;
  revision: number;
  sha256: string;
  name: string;
  detail: string;
  provenance: string;
}

import type { ArtifactRecord, ContentDraftRecord, TextGenerationJobRecord } from "./contracts.js";
import type { TextTaskSource } from "./topics.js";

/** 一张发布配图的编排；生成任务与最终采用图片分开保存。 */
export interface PublicationImage {
  slotId: string;
  title: string;
  prompt: string;
  artifactId: string | null;
  jobId: string | null;
}

/** 一篇笔记的可编辑图文编排，正文沿用已有草稿版本。 */
export interface PublicationFields {
  instructions: string;
  visualStyle: string;
  images: PublicationImage[];
}

/** 本次编辑所见的编排版本；修改必须携带此版本。 */
export interface PublicationRecord extends PublicationFields {
  draftId: string;
  revision: number;
  updatedAt: string;
}

/** 某次用户确认后固定的图文发布包，不随后续编辑漂移。 */
export interface PublicationExport {
  exportId: string;
  artifactId: string;
  draftRevision: number;
  publicationRevision: number;
  snapshotHash: string;
  createdAt: string;
}

/** 发布包编辑器读取的同会话持久事实。 */
export interface PublicationDetail {
  source: TextTaskSource | null;
  planningJob: TextGenerationJobRecord | null;
  draft: ContentDraftRecord;
  publication: PublicationRecord;
  exports: PublicationExport[];
  images: ArtifactRecord[];
}

/** 付费图片请求绑定的笔记与编排版本。 */
export interface PublicationImageTarget {
  draftId: string;
  draftRevision: number;
  publicationRevision: number;
  slotId: string;
}

export const publicationFieldsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["instructions", "visualStyle", "images"],
  properties: {
    instructions: { type: "string", maxLength: 8000 },
    visualStyle: { type: "string", maxLength: 2000 },
    images: {
      type: "array",
      maxItems: 9,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slotId", "title", "prompt", "artifactId", "jobId"],
        properties: {
          slotId: { type: "string", minLength: 1, maxLength: 80 },
          title: { type: "string", minLength: 1, maxLength: 120 },
          prompt: { type: "string", maxLength: 4000 },
          artifactId: { type: ["string", "null"], maxLength: 80 },
          jobId: { type: ["string", "null"], maxLength: 80 },
        },
      },
    },
  },
} as const;
export const publicationTargetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["draftId", "draftRevision", "publicationRevision", "slotId"],
  properties: {
    draftId: { type: "string", minLength: 1, maxLength: 80 },
    draftRevision: { type: "integer", minimum: 1 },
    publicationRevision: { type: "integer", minimum: 0 },
    slotId: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

/** 打包前固定的正文、编排、实际来源与图片元数据。 */
export interface PublicationSnapshot {
  draft: ContentDraftRecord;
  publication: PublicationRecord;
  images: ArtifactRecord[];
  source: TextTaskSource | null;
}

export const publicationPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["visualStyle", "instructions", "images"],
  properties: {
    visualStyle: { type: "string", minLength: 1, maxLength: 2000 },
    instructions: { type: "string", minLength: 1, maxLength: 8000 },
    images: {
      type: "array",
      minItems: 1,
      maxItems: 9,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "prompt"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          prompt: { type: "string", minLength: 1, maxLength: 4000 },
        },
      },
    },
  },
} as const;

/** 独立审核意见绑定固定图文快照，修改后只能作为历史参考。 */
export interface PublicationReview {
  version?: 2 | 3;
  previousReviewId?: string;
  previousIssueChecks?: PreviousIssueCheck[];
  binding?: ReviewBindingV2;
  requirementChecks?: ReviewRequirementCheck[];
  applicability?: "CURRENT" | "HISTORICAL" | "UNKNOWN";
  reviewId: string;
  jobId: string;
  draftId: string;
  draftRevision: number;
  publicationRevision: number;
  snapshotHash: string;
  verdict: "PASS" | "CHANGES_REQUIRED" | "LIMITED";
  summary: string;
  issues: Array<{
    issueId?: string;
    severity: "BLOCKER" | "WARNING" | "SUGGESTION";
    target: "COPY" | "IMAGE" | "INSTRUCTIONS" | "FACT";
    detail: string;
    suggestion: string;
    slotId: string | null;
  }>;
  comparedImages: number;
  totalImages: number;
  modelId: string;
  createdAt: string;
}
export const publicationReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "issues"],
  properties: {
    verdict: { enum: ["PASS", "CHANGES_REQUIRED", "LIMITED"] },
    summary: { type: "string", minLength: 1, maxLength: 3000 },
    issues: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "target", "detail", "suggestion", "slotId"],
        properties: {
          severity: { enum: ["BLOCKER", "WARNING", "SUGGESTION"] },
          target: { enum: ["COPY", "IMAGE", "INSTRUCTIONS", "FACT"] },
          detail: { type: "string", minLength: 1, maxLength: 1000 },
          suggestion: { type: "string", maxLength: 1000 },
          slotId: { type: ["string", "null"], maxLength: 80 },
        },
      },
    },
  },
} as const;

/** 审核固定依据由 Host 生成，要求或规则变化后旧结果只能作为历史参考。 */
export interface ReviewBindingV2 {
  version: 2;
  draftId: string;
  draftRevision: number;
  draftHash: string;
  publicationRevision: number;
  publicationHash: string;
  imageRefs: Array<{ slotId: string; artifactId: string; sha256: string }>;
  requirementsDigest: string;
  reviewerContractHash: string;
  rulesHash: string;
}

/** 每条有效要求恰好一次的核验，证据仅可引用本次真实输入。 */
export interface ReviewRequirementCheck {
  requirementId: string;
  status: "MET" | "UNMET" | "UNCERTAIN";
  evidenceRefs: string[];
  explanation: string;
  issueIds: string[];
}

/** 新审核模型输出不含 Host 身份、授权、hash 或真实图片覆盖声明。 */
export interface ReviewJudgmentV2 {
  version: 2;
  verdict: PublicationReview["verdict"];
  summary: string;
  issues: Array<PublicationReview["issues"][number] & { issueId: string }>;
  requirementChecks: ReviewRequirementCheck[];
}

export const publicationReviewV2Schema = {
  ...publicationReviewSchema,
  required: ["version", "verdict", "summary", "issues", "requirementChecks"],
  properties: {
    ...publicationReviewSchema.properties,
    version: { const: 2 },
    issues: {
      ...publicationReviewSchema.properties.issues,
      items: {
        ...publicationReviewSchema.properties.issues.items,
        required: [...publicationReviewSchema.properties.issues.items.required, "issueId"],
        properties: {
          ...publicationReviewSchema.properties.issues.items.properties,
          issueId: { type: "string", minLength: 1, maxLength: 80 },
        },
      },
    },
    requirementChecks: {
      type: "array",
      maxItems: 96,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "status", "evidenceRefs", "explanation", "issueIds"],
        properties: {
          requirementId: { type: "string", minLength: 1, maxLength: 100 },
          status: { enum: ["MET", "UNMET", "UNCERTAIN"] },
          evidenceRefs: {
            type: "array",
            maxItems: 20,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 160 },
          },
          explanation: { type: "string", minLength: 1, maxLength: 1000 },
          issueIds: {
            type: "array",
            maxItems: 40,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
      },
    },
  },
} as const;

/** 旧问题只由独立复审逐项判定；修改回执本身不能关闭问题。 */
export interface PreviousIssueCheck {
  issueId: string;
  status: "RESOLVED" | "REMAINING" | "UNCERTAIN";
  explanation: string;
  evidenceRefs: string[];
}

/** V3 复审保留 V2 要求核验，并额外完整回查被冻结的旧问题。 */
export interface ReviewJudgmentV3 extends Omit<ReviewJudgmentV2, "version"> {
  version: 3;
  previousIssueChecks: PreviousIssueCheck[];
}

export const publicationReviewV3Schema = {
  ...publicationReviewV2Schema,
  required: [...publicationReviewV2Schema.required, "previousIssueChecks"],
  properties: {
    ...publicationReviewV2Schema.properties,
    version: { const: 3 },
    previousIssueChecks: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issueId", "status", "explanation", "evidenceRefs"],
        properties: {
          issueId: { type: "string", minLength: 1, maxLength: 80 },
          status: { enum: ["RESOLVED", "REMAINING", "UNCERTAIN"] },
          explanation: { type: "string", minLength: 1, maxLength: 1000 },
          evidenceRefs: publicationReviewV2Schema.properties.requirementChecks.items.properties.evidenceRefs,
        },
      },
    },
  },
} as const;

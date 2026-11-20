import type { PublicationFields } from "./publication.js";
import { taskContextDeltaSchema } from "./task-context.js";

/** 单一输入入口可新建一篇，或以双版本继续已有稿件。 */
export interface PublicationConversationInput {
  message: string;
  originRunId?: string;
  rootJobId?: string;
  draftId?: string;
  draftRevision?: number;
  publicationRevision?: number;
}

/** Agent 可提出的图文操作；权限、费用与最终确认由 Host 决定。 */
export interface PublicationAction {
  kind:
    | "WRITE_COPY"
    | "PLAN_IMAGES"
    | "MAKE_IMAGES"
    | "USE_IMAGE"
    | "UPDATE_PUBLICATION"
    | "REPAIR"
    | "REPAIR_COPY"
    | "REPAIR_PUBLICATION"
    | "REVIEW"
    | "FINISH"
    | "IMAGE"
    | "CONFIRM";
  reviewId?: string;
  issueIds?: string[];
  autoRepair?: boolean;
  brief?: string;
  title?: string;
  productEntryId?: string;
  imageCount?: number;
  slotIndex?: number;
  artifactId?: string;
  instructions?: string;
  visualStyle?: string;
  imageEdits?: Array<{ slotIndex: number; title?: string; prompt?: string }>;
}

/** 持久对话执行位置；不以浏览器存活或模型自述作为操作成功依据。 */
export interface PublicationConversationFlow {
  state:
    | "ROUTING"
    | "RUNNING"
    | "WAITING_IMAGE_CONFIRMATION"
    | "WAITING_FINAL_CONFIRMATION"
    | "DONE"
    | "FAILED"
    | "SUPERSEDED";
  intent?: "STANDARD" | "REVIEW_REPAIR";
  reply: string;
  receipt: string;
  completed: string[];
  steps: PublicationAction[];
  cursor: number;
  draftId: string | null;
  draftRevision: number | null;
  publicationRevision: number;
  repairRounds?: number;
  repairHistory?: Array<{ reviewId: string; issueIds: string[]; childJobIds: string[]; recheckJobId?: string }>;
  childJobId?: string;
  errorCode?: string;
  exportArtifactId?: string;
  imageRequest?: {
    approvalId: string;
    modelId: string;
    slotId: string;
    prompt: string;
    referenceArtifactId: string | null;
    fields: PublicationFields;
    approved: boolean;
  };
}

export const publicationConversationOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "actions"],
  properties: {
    intent: { enum: ["STANDARD", "REVIEW_REPAIR"] },
    reply: { type: "string", minLength: 1, maxLength: 4000 },
    contextDelta: taskContextDeltaSchema,
    actions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: {
            enum: [
              "WRITE_COPY",
              "PLAN_IMAGES",
              "MAKE_IMAGES",
              "USE_IMAGE",
              "UPDATE_PUBLICATION",
              "REVIEW",
              "REPAIR",
              "FINISH",
            ],
          },
          reviewId: { type: "string", minLength: 1, maxLength: 100 },
          issueIds: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 80 },
          },
          brief: { type: "string", minLength: 1, maxLength: 2000 },
          title: { type: "string", minLength: 1, maxLength: 120 },
          productEntryId: { type: "string", minLength: 1, maxLength: 100 },
          imageCount: { type: "integer", minimum: 1, maximum: 9 },
          slotIndex: { type: "integer", minimum: 1, maximum: 9 },
          artifactId: { type: "string", minLength: 1, maxLength: 100 },
          instructions: { type: "string", minLength: 1, maxLength: 8000 },
          visualStyle: { type: "string", minLength: 1, maxLength: 2000 },
          imageEdits: {
            type: "array",
            minItems: 1,
            maxItems: 9,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["slotIndex"],
              properties: {
                slotIndex: { type: "integer", minimum: 1, maximum: 9 },
                title: { type: "string", minLength: 1, maxLength: 120 },
                prompt: { type: "string", minLength: 1, maxLength: 4000 },
              },
            },
          },
        },
      },
    },
  },
} as const;

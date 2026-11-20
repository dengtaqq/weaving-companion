import type { ContentDraftRecord } from "./contracts.js";
import type { PublicationRecord, PublicationReview } from "./publication.js";

/** 局部返修只接受当前审核的明确问题及冻结双版本，不由模型扩大修改范围。 */
export interface PublicationRepairBasis {
  version: 1;
  reviewId: string;
  reviewHash: string;
  scope: "COPY" | "PUBLICATION";
  issues: Array<PublicationReview["issues"][number] & { issueId: string }>;
  draft: ContentDraftRecord;
  publication: PublicationRecord;
}

/** 文本补丁以唯一原文定位；不含图片、任务或版本的可写身份字段。 */
export interface PublicationRepairOutput {
  changes: Array<{
    issueIds: string[];
    field: "title" | "body" | "internalNotes" | "instructions" | "visualStyle" | "imageTitle" | "imagePrompt";
    slotId: string | null;
    expectedText: string;
    replacementText: string;
  }>;
}

export const publicationRepairSchema = {
  type: "object",
  additionalProperties: false,
  required: ["changes"],
  properties: {
    changes: {
      type: "array",
      minItems: 0,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issueIds", "field", "slotId", "expectedText", "replacementText"],
        properties: {
          issueIds: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 80 },
          },
          field: {
            enum: ["title", "body", "internalNotes", "instructions", "visualStyle", "imageTitle", "imagePrompt"],
          },
          slotId: { type: ["string", "null"], maxLength: 80 },
          expectedText: { type: "string", minLength: 1, maxLength: 8000 },
          replacementText: { type: "string", maxLength: 8000 },
        },
      },
    },
  },
} as const;

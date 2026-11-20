/** 人工工作排期，只记录计划，不在后台自动发起任务或发布。 */
export interface WorkPlan {
  planId: string;
  merchantId: string;
  sessionId: string | null;
  draftId: string | null;
  title: string;
  scheduledFor: string;
  status: "TODO" | "DONE" | "CANCELLED";
  note: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export type WorkPlanFields = Pick<
  WorkPlan,
  "merchantId" | "sessionId" | "draftId" | "title" | "scheduledFor" | "status" | "note"
>;
/** 从实际任务/草稿/交付记录计算的工作进度，不能由模型直接写完成。 */
export interface ContentTaskSummary {
  draftId: string | null;
  jobId: string | null;
  sessionId: string;
  merchantId: string | null;
  merchantName: string;
  title: string;
  stage: "TOPIC" | "COPY" | "IMAGES" | "REVIEW" | "DELIVERY" | "PUBLISHED";
  status: "WORKING" | "FAILED" | "READY";
  errorCode: string | null;
  updatedAt: string;
  publicationRecord?: PublicationRecordLink | null;
  draftRevision: number | null;
  publicationRevision: number | null;
}
/** 仪表盘读取的事实来源，刷新后仍可回到已有任务。 */
export interface WorkbenchBoard {
  plans: WorkPlan[];
  tasks: ContentTaskSummary[];
  stats: { running: number; failed: number; merchants: number; products: number };
}
/** 商家维护的受管实拍/品牌素材；引用到会话时显式登记副本。 */
export interface MerchantMedia {
  mediaId: string;
  merchantId: string;
  productEntryId: string | null;
  title: string;
  blobHash: string;
  mimeType: string;
  sizeBytes: number;
  status: "ACTIVE" | "INACTIVE";
  revision: number;
  createdAt: string;
  updatedAt: string;
}
/** 发布由用户在外部平台完成后人工登记，不作为外部成功回执。 */
export interface PublicationRecordLink {
  recordId: string;
  draftId: string;
  artifactId: string;
  url: string;
  publishedAt: string;
  note: string;
  metrics: { likes: number | null; favorites: number | null; comments: number | null };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

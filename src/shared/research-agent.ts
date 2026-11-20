import type { AgentMaterialRef, ExpertTaskV3 } from "./expert-contract.js";

/** 后台研究受理回执；任务排队不表示研究完成或结果已交付。 */
export interface BackgroundResearchReceipt {
  kind: "background_research";
  jobId: string;
  status: "QUEUED" | "RUNNING" | "READY_FOR_REVIEW" | "FAILED";
  notice: string;
}

/** 研究交接保留原父轮、用户代际和精确输入，续执行不冒充新用户请求。 */
export interface BackgroundResearchSource {
  originRunId: string;
  originMessageId: string;
  originPlanHash: string;
  latestUserMessageId: string;
  task: ExpertTaskV3;
  materials: Array<{ ref: AgentMaterialRef; text: string }>;
}

/** 续执行消费原研究任务的成功结果；唯一任务键覆盖受理和重启窗口。 */
export interface ResearchContinuationSource {
  researchJobId: string;
  delegationId: string;
  resultHash: string;
  original: BackgroundResearchSource;
}

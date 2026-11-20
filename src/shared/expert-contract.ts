/** 可核实的材料引用；专家结果是委派记录中的文本，不冒充已审核草稿或 Artifact。 */
export interface AgentMaterialRef {
  kind: "uploaded_text" | "public_evidence" | "content_draft" | "artifact" | "expert_result";
  id: string;
  revision: number | null;
  sha256: string;
}

/** 正式内容步骤在父 Run 受理时固定分工，历史 Run 缺省时保持原行为。 */
export interface PublicationExpertStep {
  jobId: string;
  purpose: "CONTENT" | "PUBLICATION_PLAN" | "PUBLICATION_REVIEW" | "RESEARCH";
  targetExpertId: ExpertTaskV3["targetExpertId"];
  contractId: string;
  inputHash: string;
  promptHash: string;
  instructions: string;
  researchTask?: ExpertTaskV3;
}

/** 新版固定角色调用契约，Host 选择 Schema，模型只填获准的参数和材料。 */
export interface ExpertTaskV3 {
  version: 3;
  executionMode?: "dependent" | "background";
  taskKey: string;
  targetExpertId: "writer" | "visual" | "reviewer" | "researcher";
  task: string;
  criteria: Array<{ id: string; text: string }>;
  inputRefs: AgentMaterialRef[];
  contextSummary: string | null;
  missingInformation: string[];
  contractId: string;
  contractVersion: number;
  payload: Record<string, unknown>;
}

/** 专业结果的质量与执行提交分开；部分完成和需要补充信息不会伪装为质量通过。 */
export interface ExpertSubmissionV3 {
  version: 3;
  summary: string;
  outcome: "READY" | "PARTIAL" | "NEEDS_INPUT";
  structuredResult: Record<string, unknown>;
  materialRefs: AgentMaterialRef[];
  unmetCriterionIds: string[];
  questions: Array<{ id: string; text: string }>;
}

/** Host 接纳元数据和兼容展示投影；resultHash 只计算 submission，时间不进入材料内容 hash。 */
export interface AcceptedExpertResultV3 {
  version: 3;
  delegationId: string;
  childRunId: string;
  attempt: number;
  contractId: string;
  contractVersion: number;
  inputHash: string;
  resultHash: string;
  submission: ExpertSubmissionV3;
  acceptedAt: string;
  resultRef: AgentMaterialRef;
  output: { type: "text_draft" | "text_report"; title?: string; content: string };
  completion: "complete" | "partial";
  unmetCriterionIds: string[];
}

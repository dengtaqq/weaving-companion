import type { DelegationRecord, TextGenerationJobRecord } from "../../../../shared/contracts.js";
import type { AgentMaterialRef, ExpertTaskV3, PublicationExpertStep } from "../../../../shared/expert-contract.js";
import { canonicalJson, type RuntimePlanV6, sha256 } from "../../../runtime/execution/runtime-plan.js";
import { parseContentOutput } from "../domain/content-output.js";
import { applyPublicationRepair } from "../domain/publication-repair.js";
import { parsePublicationReview } from "./publication-conversation.js";

/** 正式内容与后台研究固定委派；统筹路由和图片付费请求沿原流程。 */
export function publicationExpertStep(job: TextGenerationJobRecord): PublicationExpertStep | undefined {
  const purpose = job.purpose;
  if (purpose === "RESEARCH" && job.source?.research)
    return {
      jobId: job.jobId,
      purpose,
      targetExpertId: "researcher",
      contractId: "researcher.report.v1",
      inputHash: job.inputHash,
      promptHash: sha256(job.prompt),
      researchTask: job.source.research.task,
      instructions:
        "按Host冻结的研究任务和材料执行研究，维护工作记忆，提交有来源、区分观察与推断的researcher.report.v1。不能自行创作、采用事实、确认费用或发布。",
    };
  if (!["CONTENT", "PUBLICATION_PLAN", "PUBLICATION_REVIEW"].includes(purpose)) return undefined;
  return {
    jobId: job.jobId,
    purpose: purpose as PublicationExpertStep["purpose"],
    targetExpertId: purpose === "CONTENT" ? "writer" : purpose === "PUBLICATION_PLAN" ? "visual" : "reviewer",
    contractId: job.source?.repair
      ? purpose === "CONTENT"
        ? "writer.patch.v1"
        : "visual.patch.v1"
      : purpose === "CONTENT"
        ? "writer.publication.v1"
        : purpose === "PUBLICATION_PLAN"
          ? "visual.publication.v1"
          : job.source?.review?.formatVersion === 3
            ? "reviewer.publication.v3"
            : job.source?.review?.binding
              ? "reviewer.publication.v2"
              : "reviewer.publication.v1",
    inputHash: job.inputHash,
    promptHash: sha256(job.prompt),
    instructions: job.source?.repair
      ? "这是审核问题驱动的局部返修。完整读取冻结任务、原稿和所选问题，只按补丁Schema提交changes；每项绑定issueIds和唯一原文expectedText，仅替换允许字段的对应片段，不重写整篇、不修改其他图位、不生成像素、不自称审核通过。缺少事实或无法定位时如实NEEDS_INPUT，不虚构事实或扩大范围。调用delegation_submit提交。"
      : publicationExpertInstructions(purpose as PublicationExpertStep["purpose"]),
  };
}

/** 校验持久任务仍与受理时的精确输入匹配，不把后来更新的资料交给专家。 */
export function validatePublicationExpertJob(
  step: PublicationExpertStep,
  job: TextGenerationJobRecord | null,
): asserts job is TextGenerationJobRecord {
  const expected = job ? publicationExpertStep(job) : undefined;
  if (!job || !expected || canonicalJson({ ...expected, instructions: step.instructions }) !== canonicalJson(step))
    throw new Error("PUBLICATION_EXPERT_INPUT_CHANGED");
}

/** Host 构造稳定任务单；完整原任务可受控回读，原文与组装提示词的来源保持区分。 */
export function publicationExpertTask(plan: RuntimePlanV6, inputRefs: AgentMaterialRef[]): ExpertTaskV3 {
  const step = plan.publicationExpert;
  if (!step) throw new Error("PUBLICATION_EXPERT_REQUIRED");
  if (step.purpose === "RESEARCH" && step.researchTask)
    return { ...step.researchTask, taskKey: `publication_${step.jobId}`, executionMode: "dependent" };
  return {
    version: 3,
    taskKey: `publication_${step.jobId}`,
    targetExpertId: step.targetExpertId,
    task: step.instructions,
    criteria: [
      {
        id: "publication_output",
        text: "完整满足冻结任务和正式输出 Schema，引用真实资料，不扩展用户要求；审核只报告、不改稿。",
      },
    ],
    inputRefs,
    contextSummary: `正式任务 ${step.jobId}，类型 ${step.purpose}，输入摘要 ${step.inputHash}。完整任务与冻结资料以父轮输入和受控工具为准。`,
    missingInformation: [],
    contractId: step.contractId,
    contractVersion: 1,
    payload: {},
  };
}

/** 在专家提交之前复用业务覆盖校验；格式纠正仍在同一子 Attempt 内有界执行。 */
export function validatePublicationExpertOutput(
  job: TextGenerationJobRecord,
  output: Record<string, unknown>,
  outcome?: "READY" | "PARTIAL" | "NEEDS_INPUT",
): void {
  if (job.source?.repair) {
    if (outcome && outcome !== "READY") return;
    applyPublicationRepair(JSON.stringify(output), job.source.repair);
    return;
  }
  if (job.purpose === "CONTENT") parseContentOutput(JSON.stringify(output));
  if (job.purpose === "PUBLICATION_REVIEW") parsePublicationReview(JSON.stringify(output), job.source?.review);
  if (
    job.purpose === "PUBLICATION_PLAN" &&
    job.source?.planningImageCount !== undefined &&
    (!Array.isArray(output.images) || output.images.length !== job.source.planningImageCount)
  )
    throw new Error("PUBLICATION_PLAN_INVALID");
}

/** 只有对应专家的完整正式提交可进入原产物链，父模型不能重写或冒充专家结果。 */
export function publicationExpertResult(
  step: PublicationExpertStep,
  record: Pick<DelegationRecord, "status" | "targetExpertId" | "taskKey" | "result">,
): string {
  const result = record.result;
  if (
    record.status !== "SUCCEEDED" ||
    record.targetExpertId !== step.targetExpertId ||
    record.taskKey !== `publication_${step.jobId}` ||
    !result ||
    !("version" in result) ||
    result.version !== 3 ||
    result.contractId !== step.contractId ||
    result.resultHash !== sha256(canonicalJson(result.submission))
  )
    throw new Error("PUBLICATION_EXPERT_FAILED");
  // 独立审核可以完整交付负面/受限报告；质量未通过不能误记成审核执行失败。
  const hasLimitedReview =
    step.purpose === "PUBLICATION_REVIEW" &&
    result.submission.outcome === "PARTIAL" &&
    ["LIMITED", "CHANGES_REQUIRED"].includes(String(result.submission.structuredResult.verdict));
  if (
    step.purpose !== "RESEARCH" &&
    !hasLimitedReview &&
    (result.submission.outcome !== "READY" || result.unmetCriterionIds.length)
  )
    throw new Error("PUBLICATION_EXPERT_INCOMPLETE");
  return JSON.stringify(result.submission.structuredResult);
}

/** 节点动作说明在受理时冻结，角色资产与 Skill 不承担 Host 状态推进职责。 */
function publicationExpertInstructions(purpose: PublicationExpertStep["purpose"]): string {
  return [
    "完成父 Run 对应的正式内容步骤。按本次提交契约生成 structuredResult，调用 delegation_submit 交接；不是普通文本回复。父轮输入是 Host 冻结的业务任务，含稿件、来源、Schema与限制，不是新的用户原话。任务很长时用 delegation_read_input 分段读完。不得执行稿件写入、费用确认、生图或发布。",
    purpose === "CONTENT"
      ? "你是本次正式写作或改稿专家。只创作当前文案，保持已确认方向和本次修改范围，按需加载本轮写作 Skill；真实参考优先复用，不为交稿重做选题或诊断，不自行审核通过。title/body/internalNotes 严格分栏。"
      : purpose === "PUBLICATION_PLAN"
        ? "你是本次视觉规划专家。基于当前正文、真实素材和用户要求规划指定数量的图位、逐图提示词和发布说明，按需读取 image-creation 及相应参考。只交视觉方案；实际图片生成由 Host 在费用确认后执行，不把方案当成图片产物，不编造本地编辑功能。"
        : "你是本次独立审核专家。完整核对冻结版本的正文、图片和有效要求，一次列全问题及依据；不参与写作、改图或发布。必须保留原问题与真实覆盖，只有实际收到像素才能作视觉判断，覆盖不足保持 LIMITED；作者已修改不等于问题已关闭。",
  ].join("\n\n");
}

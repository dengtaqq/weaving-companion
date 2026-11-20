import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { TaskCarrier, TaskContextRef, TaskContextSnapshot } from "../../../shared/task-context.js";

/** 复核精确引用与来源归属；子任务只能显式继承已经校验的父会话。 */
export function validateTaskContextSnapshot(
  snapshot: TaskContextSnapshot,
  reference: TaskContextRef,
  source: { sessionId: string; scope: "NORMAL" | "MERCHANT"; ownerId: string },
): void {
  if (
    snapshot.formatVersion !== 1 ||
    snapshot.contextId !== reference.contextId ||
    snapshot.revision !== reference.revision ||
    snapshot.sha256 !== reference.sha256 ||
    snapshot.sessionId !== reference.sessionId ||
    snapshot.sessionId !== source.sessionId ||
    snapshot.scope !== source.scope ||
    snapshot.ownerId !== source.ownerId
  ) {
    throw new Error("TASK_CONTEXT_INVALID");
  }
}

/** 按专家职责缩小成果索引，所有仍生效的要求和未整理原话继续完整保留。 */
export function taskContextCarriers(snapshot: TaskContextSnapshot, role: string | null): TaskCarrier[] {
  if (role === "writer") return snapshot.carriers.filter((item) => item.kind !== "IMAGE" && item.kind !== "EXPORT");
  if (role === "visual") return snapshot.carriers.filter((item) => item.kind !== "EXPORT" && item.kind !== "RESEARCH");
  return snapshot.carriers;
}

/** 生成每次推理重新注入的续执行视图，不复制成果正文、不扩充工具授权。 */
export function buildTaskContextBrief(snapshot: TaskContextSnapshot, role: string | null): string {
  return JSON.stringify({
    type: "task_context",
    formatVersion: snapshot.formatVersion,
    contextId: snapshot.contextId,
    revision: snapshot.revision,
    sha256: snapshot.sha256,
    sourceSessionId: snapshot.sessionId,
    draftId: snapshot.draftId,
    requirements: snapshot.requirements.filter((item) => item.status === "ACTIVE"),
    pendingSources: snapshot.pendingSources,
    carriers: taskContextCarriers(snapshot, role),
    remainingWork: snapshot.remainingWork,
    note: "Host 冻结的任务续执行视图。未被明确替换或撤回的有效要求继续适用；pendingSources 是尚未完成结构化整理的用户原话，不可遗漏。成果的存在、适用性、审核和外部成功分别表达；历史审核不证明当前版本通过。成果状态和待办仅代表受理时快照，后续真实回执优先。读取须遵守本轮工具和来源授权，索引不新增权限。",
  });
}

/** 对无法通过历史压缩缩小的必要要求显式报容量问题，禁止截断后伪装完整。 */
export function assertTaskContextBudget(brief: string, contextWindow: number, maxTokens: number): void {
  const tokens = estimateTokens({ role: "user", content: brief, timestamp: 0 });
  if (tokens >= contextWindow - maxTokens - 512) throw new Error("TASK_CONTEXT_BUDGET_EXCEEDED");
}

/** 临时任务视图不会进入 Pi 历史，单独记录它占用的预算，避免把它当成可折叠历史。 */
export interface TaskContextTokenBudget {
  additionalTokens: number;
  summaryInstructionTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

/** 为任务视图、摘要提示词及模型输出保留空间，近期历史不能挤占这些必要输入。 */
export function taskContextTokenBudget(input: {
  brief: string;
  summaryInstructions: string;
  contextWindow: number;
  maxTokens: number;
  baseReserveTokens: number;
  baseKeepRecentTokens: number;
}): TaskContextTokenBudget {
  const additionalTokens = estimateTokens({ role: "user", content: input.brief, timestamp: 0 });
  const summaryInstructionTokens = estimateTokens({ role: "user", content: input.summaryInstructions, timestamp: 0 });
  // SDK 0.87 的摘要格式、系统指令与 transcript 包装也占输入空间，不属于任务视图。
  const sdkSummaryPromptReserveTokens = 1024;
  const reserveTokens = Math.max(
    input.baseReserveTokens + additionalTokens,
    input.maxTokens + summaryInstructionTokens + sdkSummaryPromptReserveTokens,
  );
  const historyBudget = input.contextWindow - reserveTokens;
  if (historyBudget < 512) throw new Error("TASK_CONTEXT_BUDGET_EXCEEDED");
  return {
    additionalTokens,
    summaryInstructionTokens,
    reserveTokens,
    keepRecentTokens: Math.min(input.baseKeepRecentTokens, Math.max(256, Math.floor(historyBudget / 2))),
  };
}

/** 固定迭代摘要规则，只传任务身份；要求正文仍由 Host 独立重新注入。 */
export function taskContextCompactionInstructions(base: string, snapshot: TaskContextSnapshot): string {
  return `${base}\n任务上下文 ${snapshot.contextId} r${snapshot.revision}（${snapshot.sha256}）由 Host 在每次推理独立注入，不改写其中要求或宣称业务成功。沿用 previousSummary 中未改变的成果身份、版本、来源与条件；只更新本次待折叠历史明确改变的部分。保留新的任务相关结论及其精确来源、未知结果和未解决事项，不能只保留回读指针而丢掉已有分析。拆分回合的前缀不能被当成完整交付。`;
}

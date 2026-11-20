/** 同一根任务共享的执行额度，执行计数与账单金额明确区分。 */
export interface TaskExecutionLimits {
  modelCalls: number;
  toolCalls: number;
  steps: number;
  images: number;
  summaryCalls: number;
  activeMs: number;
}

/** 原任务的控制元数据，不复制稿件、图片或业务状态。 */
export interface TaskExecutionControl {
  version: 1;
  rootJobId: string;
  revision: number;
  state: "ACTIVE" | "PAUSED";
  reason: string | null;
  limits: TaskExecutionLimits;
  usage: TaskExecutionLimits & {
    reservedMs: number;
    reportedTokens: number;
    unknownUsages: number;
    estimatedIntervals: number;
  };
  updatedAt: string;
}

/** 单次调用的持久预留；scope 区分主、子与恢复 Attempt。 */
export interface TaskBudgetActor {
  runId: string;
  attempt: number;
  delegationId?: string;
  childAttempt?: number;
}

export type TaskBudgetKind = "modelCalls" | "toolCalls" | "steps" | "images" | "summaryCalls";

/** 精确定位一次已冻结的任务上下文；引用本身不授予资料读取权限。 */
export interface TaskContextRef {
  contextId: string;
  revision: number;
  sha256: string;
  sessionId: string;
}

/** 尚未整理的真实用户来源；组装后的模型提示词不属于用户原话。 */
export interface TaskContextSource {
  kind: "GENERATION_REQUEST" | "MESSAGE";
  id: string;
  sha256: string;
  text: string;
}

/** 跨轮次维护的要求，原话存在不等于模型对原话的解释一定正确。 */
export interface TaskRequirement {
  requirementId: string;
  kind: "GOAL" | "CONSTRAINT" | "OPEN_QUESTION";
  text: string;
  status: "ACTIVE" | "SUPERSEDED" | "RESOLVED";
  source: Omit<TaskContextSource, "text"> & { quote: string };
  replacesId?: string;
}

/** 模型只能提出有用户来源的要求变更，不能写入业务成功状态或权限。 */
export interface TaskContextDelta {
  baseRevision: number;
  processedSourceIds: string[];
  changes: Array<{
    operation: "ADD" | "REPLACE" | "RESOLVE";
    targetId?: string;
    kind: TaskRequirement["kind"];
    text: string;
    sourceId: string;
    quote: string;
  }>;
}

/** 从既有事实源生成的成果引用，读取、适用与确认状态分别表达。 */
export interface TaskCarrier {
  id: string;
  kind: "DRAFT" | "PUBLICATION" | "IMAGE" | "REVIEW" | "EXPORT" | "RESEARCH";
  title: string;
  revision: number | null;
  sha256: string | null;
  readability: "AVAILABLE" | "UNAVAILABLE";
  applicability: "CURRENT" | "HISTORICAL" | "NEEDS_REVIEW";
  approval: "PENDING" | "APPROVED" | "NOT_APPLICABLE";
  progress: string;
  reason: string | null;
}

/** 不可变任务输入；成果仅保存引用和使用条件，业务对象仍由原模块维护。 */
export interface TaskContextSnapshot {
  formatVersion: 1;
  contextId: string;
  revision: number;
  sessionId: string;
  scope: "NORMAL" | "MERCHANT";
  ownerId: string;
  rootJobId: string;
  draftId: string | null;
  requirements: TaskRequirement[];
  pendingSources: TaskContextSource[];
  carriers: TaskCarrier[];
  remainingWork: string[];
  sha256: string;
}

/** 页面查询使用当前业务事实，运行输入仍读取上方精确冻结快照。 */
export interface TaskContextView {
  snapshot: TaskContextSnapshot;
  draftId: string | null;
  carriers: TaskCarrier[];
  remainingWork: string[];
  workflowState: string | null;
  currentStatus?: CurrentTaskStatus;
}

/** 一次模型请求观察到的只读业务进度；不改变冻结要求或资料授权。 */
export interface CurrentTaskStatus {
  version: 1;
  contextId: string;
  frozenRequirementsDigest: string;
  latestRequirementsDigest: string;
  basisStatus: "CURRENT" | "SUPERSEDED";
  draftId: string | null;
  draftRevision: number | null;
  publicationRevision: number | null;
  workflowJobId: string | null;
  workflowState: string | null;
  carriers: TaskCarrier[];
  remainingWork: string[];
  observedSeq: number;
  observedAt: string;
}

/** Host 注入执行身份；子专家同时固定其委派尝试，模型不能自行构造读取授权。 */
export interface CurrentTaskStatusRequest {
  runId: string;
  attempt: number;
  taskContext: TaskContextRef;
  delegationId?: string;
  delegationAttempt?: number;
}

export const taskContextDeltaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["baseRevision", "processedSourceIds", "changes"],
  properties: {
    baseRevision: { type: "integer", minimum: 1 },
    processedSourceIds: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
    changes: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["operation", "kind", "text", "sourceId", "quote"],
        properties: {
          operation: { enum: ["ADD", "REPLACE", "RESOLVE"] },
          targetId: { type: "string", minLength: 1, maxLength: 100 },
          kind: { enum: ["GOAL", "CONSTRAINT", "OPEN_QUESTION"] },
          text: { type: "string", minLength: 1, maxLength: 1000 },
          sourceId: { type: "string", minLength: 1, maxLength: 100 },
          quote: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
  },
} as const;

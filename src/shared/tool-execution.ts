/** Host 注册并随 Run 冻结的策略；声明超时即承诺响应取消并等待自身资源退出。 */
export interface ToolExecutionPolicy {
  timeoutMs: number;
  timeoutResult: "FAILED" | "UNKNOWN";
}

/** 工具实际执行结果；超时通知不代表底层能力已退出。 */
export interface ToolExecutionSummary {
  outcome: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "LIMITED" | "BLOCKED";
  elapsedMs: number;
  errorCode?: string;
  resultUnknown?: boolean;
}

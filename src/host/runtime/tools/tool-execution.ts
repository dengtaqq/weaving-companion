import type { ToolExecutionPolicy, ToolExecutionSummary } from "../../../shared/tool-execution.js";
import { type HostToolDefinition, type HostToolResult, isToolExecutionPolicy } from "./host-tool.js";

/** 读取 Host 结果摘要；不接受非法状态或耗时，避免错误元数据污染事件与页面。 */
export function toolExecutionSummary(result: unknown): ToolExecutionSummary | undefined {
  if (!result || typeof result !== "object" || !("details" in result)) return undefined;
  const details = result.details;
  if (!details || typeof details !== "object" || !("execution" in details)) return undefined;
  const summary = details.execution as ToolExecutionSummary | undefined;
  if (
    !summary ||
    !["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LIMITED", "BLOCKED"].includes(summary.outcome) ||
    !Number.isFinite(summary.elapsedMs) ||
    summary.elapsedMs < 0 ||
    (summary.errorCode !== undefined && typeof summary.errorCode !== "string") ||
    (summary.resultUnknown !== undefined && typeof summary.resultUnknown !== "boolean")
  )
    return undefined;
  return summary;
}

/** 返回通用错误回执；未知结果保留核对提示，不由超时推断外部执行失败。 */
function failedResult(execution: ToolExecutionSummary): HostToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ...execution,
          note: execution.resultUnknown
            ? "本次调用结果未知，请核对原请求回执；不得自动重复外部操作。其他工具的结果保留。"
            : "本次工具调用未成功完成；其他工具的结果保留。Host 未自动重试。",
        }),
      },
    ],
    details: { execution },
  };
}

/** 按冻结策略执行任意工具；未接入者沿原逻辑，超时者须等 execute 与资源清理真正结束。 */
export async function executeTool(
  tool: HostToolDefinition,
  args: Parameters<HostToolDefinition["execute"]>,
  policy: ToolExecutionPolicy | undefined,
  onTimeout: () => void,
): Promise<HostToolResult> {
  if (!policy) return tool.execute(...args);
  if (
    !isToolExecutionPolicy(policy) ||
    !isToolExecutionPolicy(tool.executionPolicy) ||
    policy.timeoutResult !== tool.executionPolicy.timeoutResult
  )
    throw new Error("TOOL_EXECUTION_POLICY_CHANGED");
  const startedAt = performance.now();
  const parentSignal = args[2];
  if (parentSignal?.aborted) throw new Error("TOOL_ABORTED");
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    if (signal.aborted) return;
    timedOut = true;
    controller.abort();
    onTimeout();
  }, policy.timeoutMs);
  let result: HostToolResult;
  try {
    result = await tool.execute(args[0], args[1], signal, args[3], args[4]);
  } catch (error) {
    const errorCode =
      error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "TOOL_EXECUTION_FAILED";
    result = failedResult({
      outcome: "FAILED",
      elapsedMs: 0,
      errorCode,
      ...(policy.timeoutResult === "UNKNOWN" && { resultUnknown: true }),
    });
  } finally {
    clearTimeout(timer);
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  const uncertainty = policy.timeoutResult === "UNKNOWN" ? { resultUnknown: true } : {};
  // 父取消优先；晚到成功不能覆盖超时；未知结果不升级为确定失败。
  if (parentSignal?.aborted)
    return failedResult({ outcome: "CANCELLED", elapsedMs, errorCode: "TOOL_ABORTED", ...uncertainty });
  if (timedOut) return failedResult({ outcome: "TIMED_OUT", elapsedMs, errorCode: "TOOL_TIMEOUT", ...uncertainty });
  const execution = toolExecutionSummary(result) ?? {
    ...(tool.summarizeResult?.(result) ?? { outcome: "SUCCEEDED" }),
    elapsedMs,
  };
  const details = result.details && typeof result.details === "object" ? result.details : {};
  return { ...result, details: { ...details, execution: { ...execution, elapsedMs } } };
}

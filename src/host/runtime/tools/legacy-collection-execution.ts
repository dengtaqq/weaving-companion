// 仅兼容冻结为 tool-timeout-1 的历史 Run；新 Run 使用声明式执行器，不再按工具名称分派。
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionSummary } from "../../../shared/tool-execution.js";

export const COLLECTION_TOOL_TIMEOUT_MS = 60_000;
const COLLECTION_TOOLS = new Set(["public_page_collect", "merchant_source_collect", "xhs_public_search"]);
type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

/** 只隔离已支持取消清理的公开采集，不给写入、委派或付费操作套用读取时限。 */
export function isCollectionTool(name: string): boolean {
  return COLLECTION_TOOLS.has(name);
}

/** 从 Host 附加的结果元数据读取工具状态，供 SDK 错误标记与持久事件共用。 */
export function toolExecutionSummary(result: unknown): ToolExecutionSummary | undefined {
  if (!result || typeof result !== "object" || !("details" in result)) return undefined;
  const details = result.details;
  if (!details || typeof details !== "object" || !("execution" in details)) return undefined;
  return details.execution as ToolExecutionSummary | undefined;
}

/** 将公开采集的业务状态映射为工具状态，部分可用证据不能误记为全部成功。 */
function collectionSummary(result: ToolResult, elapsedMs: number): ToolExecutionSummary {
  const details = result.details as { status?: string } | undefined;
  let data: { status?: string; errorCode?: string; notes?: Array<{ status?: string }> } = details ?? {};
  try {
    const text = result.content.find((part) => part.type === "text");
    if (text?.type === "text") data = JSON.parse(text.text);
  } catch {
    // 无结构化业务回执时保留正常执行语义，不把任意文本猜作失败。
  }
  const status = data?.status ?? details?.status;
  const outcome = status === "FAILED" || status === "BLOCKED" || status === "LIMITED" ? status : "SUCCEEDED";
  if (outcome === "SUCCEEDED" && Array.isArray(data?.notes) && data.notes.some((note) => note.status !== "COLLECTED"))
    return { outcome: "LIMITED", elapsedMs, errorCode: "COLLECTION_PARTIAL" };
  return { outcome, elapsedMs, ...(data?.errorCode && { errorCode: data.errorCode }) };
}

/** 返回明确失败回执；只有实际调用及其清理结束后才允许 SDK 继续下一轮。 */
function failedResult(summary: ToolExecutionSummary): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ...summary,
          note: "本次采集未成功完成；保留其他已取得证据，不得声称已读取缺失正文。Host 未自动重试。",
        }),
      },
    ],
    details: { execution: summary },
  };
}

/** 单次采集超时仅取消自己的信号；等待底层退出，禁止 race 返回后遗留旧调用。 */
export async function executeCollectionTool(
  tool: ToolDefinition,
  args: Parameters<ToolDefinition["execute"]>,
  onTimeout: () => void,
  timeoutMs = COLLECTION_TOOL_TIMEOUT_MS,
): Promise<ToolResult> {
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
  }, timeoutMs);
  let result: ToolResult;
  try {
    result = await tool.execute(args[0], args[1], signal, args[3], args[4]);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "TOOL_EXECUTION_FAILED";
    result = failedResult({ outcome: "FAILED", elapsedMs: 0, errorCode: code });
  } finally {
    clearTimeout(timer);
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  // 父取消优先于工具超时；超时后的晚到成功也不能覆盖本次失败。
  if (parentSignal?.aborted) return failedResult({ outcome: "CANCELLED", elapsedMs, errorCode: "TOOL_ABORTED" });
  if (timedOut) return failedResult({ outcome: "TIMED_OUT", elapsedMs, errorCode: "TOOL_TIMEOUT" });
  const execution = toolExecutionSummary(result) ?? collectionSummary(result, elapsedMs);
  execution.elapsedMs = elapsedMs;
  const details = result.details && typeof result.details === "object" ? result.details : {};
  return { ...result, details: { ...details, execution } };
}

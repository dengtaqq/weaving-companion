import type { HostToolRegistration, HostToolResult, ToolResultSummary } from "../../../runtime/tools/host-tool.js";

const COLLECTION_TIMEOUT_MS = 60_000;

/** 采集工具在注册处选择通用执行能力；具体业务结果解释留在 research。 */
export const RESEARCH_TOOL_REGISTRATIONS = {
  publicPage: {
    name: "public_page_collect",
    executionPolicy: { timeoutMs: COLLECTION_TIMEOUT_MS, timeoutResult: "FAILED" },
    summarizeResult: summarizeCollectionResult,
  },
  merchantSource: {
    name: "merchant_source_collect",
    executionPolicy: { timeoutMs: COLLECTION_TIMEOUT_MS, timeoutResult: "FAILED" },
    summarizeResult: summarizeCollectionResult,
  },
  search: {
    name: "xhs_public_search",
    executionPolicy: { timeoutMs: COLLECTION_TIMEOUT_MS, timeoutResult: "FAILED" },
    summarizeResult: summarizeCollectionResult,
  },
} satisfies Record<string, HostToolRegistration>;

/** 仅解释本模块的采集回执，保留失败、受限和子笔记部分可用的区别。 */
export function summarizeCollectionResult(result: HostToolResult): ToolResultSummary {
  const details = result.details as { status?: string } | undefined;
  let data: { status?: string; errorCode?: string; notes?: Array<{ status?: string }> } = details ?? {};
  try {
    const text = result.content.find((part) => part.type === "text");
    if (text?.type === "text") data = JSON.parse(text.text);
  } catch {
    // 无结构化回执时沿正常执行语义，不从任意文本推测采集失败。
  }
  const status = data?.status ?? details?.status;
  const outcome = status === "FAILED" || status === "BLOCKED" || status === "LIMITED" ? status : "SUCCEEDED";
  if (outcome === "SUCCEEDED" && Array.isArray(data?.notes) && data.notes.some((note) => note.status !== "COLLECTED"))
    return { outcome: "LIMITED", errorCode: "COLLECTION_PARTIAL" };
  return { outcome, ...(data?.errorCode && { errorCode: data.errorCode }) };
}

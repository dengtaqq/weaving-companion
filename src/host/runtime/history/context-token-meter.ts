import { getCurrentSystemMessage, type Usage } from "@earendil-works/pi-ai";
import { type convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ContextCompressionMeasurement, ContextTokenMeasurement } from "../../../shared/contracts.js";

type ContextMessage = Parameters<typeof convertToLlm>[0][number];

export interface ContextTokenOptions {
  contextWindow: number;
  reserveTokens: number;
  requestIndex: number;
  stage: ContextTokenMeasurement["stage"];
  providerInputTokens?: number | null;
}

/** 共用 Pi 字符/图片启发式估算；折叠系统增量后计入当前提示词和工具定义。 */
export function estimateContextTokens(messages: readonly ContextMessage[]): number {
  const system = getCurrentSystemMessage(messages.filter((message) => message.role === "system"));
  return messages.reduce(
    (tokens, message) => tokens + (message.role === "system" ? 0 : estimateTokens(message)),
    system ? estimateTokens(system) : 0,
  );
}

/** 为上下文长度生成统一窗口指标；保留超出 100% 的占比以暴露溢出。 */
export function measureContextTokens(estimatedTokens: number, options: ContextTokenOptions): ContextTokenMeasurement {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0 || options.contextWindow <= 0)
    throw new Error("CONTEXT_TOKENS_INVALID");
  const tokens = Math.ceil(estimatedTokens);
  return {
    stage: options.stage,
    estimator: "pi-chars-v1",
    estimatedTokens: tokens,
    contextWindow: options.contextWindow,
    usedPercent: Math.round((tokens / options.contextWindow) * 10000) / 100,
    remainingTokens: Math.max(0, options.contextWindow - tokens),
    reserveTokens: options.reserveTokens,
    remainingBeforeReserve: Math.max(0, options.contextWindow - options.reserveTokens - tokens),
    requestIndex: options.requestIndex,
    providerInputTokens: options.providerInputTokens ?? null,
    measuredAt: new Date().toISOString(),
  };
}

/** 仅提取 SDK 报告的本次输入量；输出与累计 totalTokens 不作为当前上下文输入。 */
export function reportedContextInput(usage: Usage): number | null {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return Number.isFinite(input) && input > 0 ? input : null;
}

/** 按相同估算器构建前后比较，允许结果变大时显示负节省。 */
export function compareContextTokens(
  kind: ContextCompressionMeasurement["kind"],
  before: ContextTokenMeasurement,
  after: ContextTokenMeasurement | null,
): ContextCompressionMeasurement {
  const savedTokens = after ? before.estimatedTokens - after.estimatedTokens : null;
  return {
    kind,
    status: after ? "COMPLETED" : "FAILED",
    before,
    after,
    savedTokens,
    savedPercent:
      savedTokens !== null && before.estimatedTokens > 0
        ? Math.round((savedTokens / before.estimatedTokens) * 10000) / 100
        : null,
  };
}

/** 向 Host 标准输出打印脱敏计量日志；不包含消息、工具正文、地址或密钥。 */
export function logContextTokens(
  scope: { sessionId: string; runId: string },
  value: ContextTokenMeasurement | ContextCompressionMeasurement,
): void {
  const tag = "kind" in value ? "context_compression" : "context_tokens";
  process.stdout.write(`[${tag}] ${JSON.stringify({ ...scope, ...value })}\n`);
}

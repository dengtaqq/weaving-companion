import type {
  ContextCompressionMeasurement,
  ContextTokenMeasurement,
  MicrocompactRecord,
  ModelUsageSummary,
} from "../../../shared/contracts.js";
import type { ToolExecutionSummary } from "../../../shared/tool-execution.js";
import type { ResolvedRunContext } from "../context/context-assembler.js";

/** 一次 Run 的所有已解析输入由 Context Assembler 统一提供。 */
export type RuntimeStartInput = ResolvedRunContext;

export type PiRuntimeEvent =
  | {
      type: "task.status.observed";
      contextId: string;
      frozenRevision: number;
      observedSeq: number;
      projectionHash: string;
      basisStatus: "CURRENT" | "SUPERSEDED";
    }
  | { type: "text.delta"; text: string }
  | { type: "thinking.delta"; text: string }
  | { type: "microcompact.completed"; record: MicrocompactRecord }
  | { type: "context.measured"; measurement: ContextTokenMeasurement }
  | { type: "context.compressed"; measurement: ContextCompressionMeasurement }
  | { type: "compaction.started"; reason: "manual" | "threshold" | "overflow" }
  | {
      type: "compaction.finished";
      reason: "manual" | "threshold" | "overflow";
      result: { summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter?: number } | null;
      errorMessage: string | null;
      willRetry: boolean;
    }
  | { type: "tool.started"; toolCallId: string; toolName: string; skill?: SkillRead }
  | { type: "tool.timeout"; toolCallId: string; toolName: string }
  | {
      type: "tool.completed";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      skill?: SkillRead;
      execution?: ToolExecutionSummary;
    };

export interface SkillRead {
  name: string;
  path: string;
  sha256: string;
}

export interface RuntimeStateSnapshot {
  sessionFile: string | null;
  sessionFileHash: string | null;
  fileExists: boolean;
  sourceSnapshotHash: string | null;
  sourceVerification: "EMPTY" | "VERIFIED" | "LEGACY_UNVERIFIED";
  adapterVersion: string;
}

export interface RuntimeReply {
  text: string;
  usage: ModelUsageSummary | null;
}

/** 调度器与 Pi SDK 的边界，事件回调必须完成后才算本轮回复完成。 */
export interface PiRuntimePort {
  /** 按冻结输入初始化本轮 Pi 会话与受控工具。 */
  start(
    input: RuntimeStartInput,
    onSnapshotPrepared?: (snapshot: RuntimeStateSnapshot) => Promise<void>,
  ): Promise<void>;
  /** 运行时接口：向当前 Pi 会话发送本轮输入并转发运行事件。 */
  prompt(text: string, onEvent: (event: PiRuntimeEvent) => Promise<void>): Promise<RuntimeReply>;
  /** 运行时接口：读取 Pi 会话快照以便恢复或持久化。 */
  getState(): Promise<RuntimeStateSnapshot>;
  /** 运行时接口：等待 Pi 会话停止处理当前请求。 */
  waitForIdle(): Promise<void>;
  /** 运行时接口：请求终止当前 Pi 会话执行。 */
  abort(reason?: string): Promise<void>;
  /** 运行时接口：在需要时压缩 Pi 会话历史。 */
  compact(instructions?: string): Promise<void>;
  /** 释放本轮 Pi 会话资源。 */
  stop(): Promise<void>;
}

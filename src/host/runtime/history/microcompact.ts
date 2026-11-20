import { createHash, randomUUID } from "node:crypto";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateTokens, type ProjectedSessionEntry, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { MicrocompactRecord } from "../../../shared/contracts.js";
import { estimateContextTokens } from "./context-token-meter.js";

export const MICROCOMPACT_POLICY_VERSION = "microcompact-v1";
export const MICROCOMPACT_AUDIT_TYPE = "host_microcompact";
const KEEP_RECENT_TOOL_TURNS = 3;
const MIN_SAVED_TOKENS = 1024;
const MAX_EDITS = 64;

export type MicrocompactSource =
  | { kind: "upload"; artifactId: string; blobHash: string; offset: number; nextOffset: number }
  | { kind: "evidence"; evidenceId: string; sha256: string; offset: number; nextOffset: number }
  | { kind: "skill"; name: string; path: string; sha256: string }
  | { kind: "expert"; role: string; groupId: string; sharedSha256: string; promptSha256: string };

interface ReadMetadata {
  version: 1;
  source: MicrocompactSource;
  contentHash: string;
}

export interface MicrocompactInput {
  entries: readonly ProjectedSessionEntry[];
  contextWindow: number;
  reserveTokens: number;
  additionalTokens: number;
  phase: MicrocompactRecord["phase"];
  /** 按本轮冻结权限复核来源；越界来源不参与清理。 */
  access(source: MicrocompactSource): Promise<"AVAILABLE" | "UNAVAILABLE" | "OUT_OF_SCOPE">;
}

export interface MicrocompactPlan {
  drafts: SessionBoundaryDraft[];
  record: MicrocompactRecord;
}

/** 对正文内容块计算稳定摘要，防止已编辑内容或伪造引用再次进入候选集合。 */
function contentHash(content: ToolResultMessage["content"]): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** 为 Host 成功的只读工具结果登记来源，元数据本身不发送给模型。 */
export function microcompactReadMetadata(source: MicrocompactSource, text: string): { microcompact: ReadMetadata } {
  return { microcompact: { version: 1, source, contentHash: contentHash([{ type: "text", text }]) } };
}

/** 检查从快照恢复的对象，避免未知或旧格式元数据扩大清理范围。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验标识及版本字段长度，不接受正文内声明的清理策略。 */
function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/** 校验来源版本摘要格式。 */
function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** 校验本项目四类工具的精确来源形状和有界读取区间。 */
function validSource(value: unknown): value is MicrocompactSource {
  if (!isObject(value)) return false;
  if (value.kind === "skill") return validText(value.name) && validText(value.path) && validHash(value.sha256);
  if (value.kind === "expert")
    return (
      ["writer", "visual", "reviewer"].includes(String(value.role)) &&
      validText(value.groupId) &&
      validHash(value.sharedSha256) &&
      validHash(value.promptSha256)
    );
  if (
    !Number.isSafeInteger(value.offset) ||
    !Number.isSafeInteger(value.nextOffset) ||
    Number(value.offset) < 0 ||
    Number(value.nextOffset) <= Number(value.offset) ||
    Number(value.nextOffset) - Number(value.offset) > 12000
  )
    return false;
  if (value.kind === "upload") return validText(value.artifactId) && validHash(value.blobHash);
  return value.kind === "evidence" && validText(value.evidenceId) && validHash(value.sha256);
}

/** 仅接受工具名匹配且正文未被编辑的 Host 来源元数据。 */
function readMetadata(message: ToolResultMessage): ReadMetadata | null {
  if (message.isError || !isObject(message.details) || !isObject(message.details.microcompact)) return null;
  const metadata = message.details.microcompact;
  if (metadata.version !== 1 || !validSource(metadata.source) || metadata.contentHash !== contentHash(message.content))
    return null;
  const tools = {
    upload: "read_uploaded_text",
    evidence: "evidence_get",
    skill: "read_skill",
    expert: "read_expert_method",
  };
  if (tools[metadata.source.kind] !== message.toolName) return null;
  return metadata as unknown as ReadMetadata;
}

/** 为仍获准的同一版本来源构建现有读取工具参数。 */
function rereadArguments(source: MicrocompactSource): Record<string, string | number> {
  switch (source.kind) {
    case "upload":
      return { artifactId: source.artifactId, offset: source.offset, limit: source.nextOffset - source.offset };
    case "evidence":
      return { evidenceId: source.evidenceId, offset: source.offset, limit: source.nextOffset - source.offset };
    case "skill":
      return source.path === "SKILL.md" ? { name: source.name } : { name: source.name, reference: source.path };
    case "expert":
      return { role: source.role };
  }
}

/** 估算当前实际投影；只计最新系统状态，不复用清理前的 Provider 用量。 */
export function estimateMicrocompactTokens(entries: readonly ProjectedSessionEntry[]): number {
  return estimateContextTokens(entries.flatMap((entry) => entry.messages));
}

/** 从有效历史保护最近三批工具调用；多工具并行批次整体保留。 */
function protectedResults(entries: readonly ProjectedSessionEntry[]): Set<string> {
  const protectedIds = new Set<string>();
  let batch: string[] = [];
  let kept = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    for (const message of entry.messages) {
      if (message.role === "toolResult") batch.push(entry.sourceEntry.id);
      if (message.role === "assistant" && message.content.some((part) => part.type === "toolCall") && batch.length) {
        for (const id of batch) protectedIds.add(id);
        batch = [];
        if (++kept === KEEP_RECENT_TOOL_TURNS) return protectedIds;
      }
    }
  }
  // 无法配对的尾部结果一律保护，不通过清理修补历史结构。
  for (const id of batch) protectedIds.add(id);
  return protectedIds;
}

/** 在压力阈值下按时间顺序生成引用编辑；不删消息、不调用模型、不改变授权。 */
export async function planMicrocompact(input: MicrocompactInput): Promise<MicrocompactPlan | null> {
  const budget = input.contextWindow - input.reserveTokens;
  if (budget <= 0) return null;
  const before = estimateMicrocompactTokens(input.entries) + input.additionalTokens;
  if (before < budget * 0.8) return null;
  const protectedIds = protectedResults(input.entries);
  const drafts: SessionBoundaryDraft[] = [];
  const targets: string[] = [];
  let after = before;
  for (const entry of input.entries) {
    if (protectedIds.has(entry.sourceEntry.id) || entry.messages.length !== 1) continue;
    const message = entry.messages[0];
    if (message?.role !== "toolResult") continue;
    const metadata = readMetadata(message);
    if (!metadata) continue;
    const access = await input.access(metadata.source);
    if (access === "OUT_OF_SCOPE") continue;
    const text = JSON.stringify({
      type: "tool_content_reference",
      policyVersion: MICROCOMPACT_POLICY_VERSION,
      source: metadata.source,
      contentRemoved: true,
      rereadStatus: access,
      ...(access === "AVAILABLE"
        ? { reread: { tool: message.toolName, arguments: rereadArguments(metadata.source) } }
        : { note: "历史版本本轮不可回读；不得用当前版本冒充原版本或重新执行外部操作。" }),
    });
    const content: ToolResultMessage["content"] = [{ type: "text", text }];
    const saved = estimateTokens(message) - estimateTokens({ ...message, content });
    if (saved <= 0) continue;
    drafts.push({ type: "context_edit", targetId: entry.sourceEntry.id, replacement: { content } });
    targets.push(entry.sourceEntry.id);
    after -= saved;
    if (after <= budget * 0.65 || targets.length === MAX_EDITS) break;
  }
  if (before - after < MIN_SAVED_TOKENS) return null;
  const record: MicrocompactRecord = {
    recordId: `mc_${randomUUID()}`,
    policyVersion: MICROCOMPACT_POLICY_VERSION,
    phase: input.phase,
    estimatedTokensBefore: before,
    estimatedTokensAfter: after,
    estimatedTokensSaved: before - after,
    clearedResults: targets.length,
    targetEntryIds: targets,
  };
  drafts.push({ type: "custom", customType: MICROCOMPACT_AUDIT_TYPE, data: record });
  return { drafts, record };
}

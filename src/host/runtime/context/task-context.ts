import { randomUUID } from "node:crypto";
import AjvModule from "ajv/dist/2020.js";
import type {
  TaskContextDelta,
  TaskContextRef,
  TaskContextSnapshot,
  TaskRequirement,
} from "../../../shared/task-context.js";
import { taskContextDeltaSchema } from "../../../shared/task-context.js";
import { canonicalJson, sha256 } from "../execution/runtime-plan.js";

const validateDelta = new AjvModule.default().compile<TaskContextDelta>(taskContextDeltaSchema);
export const MAX_TASK_REQUIREMENTS = 96;
export const MAX_TASK_CONTEXT_CHARACTERS = 32000;

/** 只对有效要求及来源计算稳定摘要，成果、控制消息和修订次数不影响执行依据。 */
export function taskRequirementsDigest(snapshot: TaskContextSnapshot): string {
  const requirements = snapshot.requirements
    .filter((item) => item.status === "ACTIVE")
    .map(({ requirementId, kind, text, source }) => ({ requirementId, kind, text, source }))
    .sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  return sha256(canonicalJson(requirements));
}

/** 仅识别不增加业务要求的独立控制词，混合补充仍须整理。 */
export function isTaskControlMessage(text: string): boolean {
  return /^(继续(?:吧)?|好的?|嗯|ok)[。！!\s]*$/i.test(text.trim());
}

/** 审核前必须整理所有实质原话，控制消息不会阻断已有要求核验。 */
export function hasPendingTaskRequirements(snapshot: TaskContextSnapshot | null): boolean {
  return snapshot?.pendingSources.some((source) => !isTaskControlMessage(source.text)) ?? false;
}

/** 新要求尚未整理也应阻止旧任务推进；纯控制词不能使同一执行依据失效。 */
export function isTaskRequirementsCurrent(frozen: TaskContextSnapshot, latest: TaskContextSnapshot): boolean {
  if (frozen.contextId !== latest.contextId || taskRequirementsDigest(frozen) !== taskRequirementsDigest(latest))
    return false;
  const known = new Set(frozen.pendingSources.map((source) => `${source.id}:${source.sha256}`));
  return latest.pendingSources.every(
    (source) => known.has(`${source.id}:${source.sha256}`) || isTaskControlMessage(source.text),
  );
}

/** 使用与 Runtime Plan 相同的规范序列化计算上下文完整性。 */
export function taskContextHash(snapshot: Omit<TaskContextSnapshot, "sha256"> | TaskContextSnapshot): string {
  const { sha256: _hash, ...body } = snapshot as TaskContextSnapshot;
  return sha256(canonicalJson(body));
}

/** 从完整快照生成不扩展权限的精确版本引用。 */
export function taskContextRef(snapshot: TaskContextSnapshot): TaskContextRef {
  return {
    contextId: snapshot.contextId,
    revision: snapshot.revision,
    sha256: snapshot.sha256,
    sessionId: snapshot.sessionId,
  };
}

/** 要求及未整理原话超预算时明确拒绝，不能用截断冒充完整上下文。 */
export function validateTaskContextBudget(snapshot: TaskContextSnapshot): void {
  if (
    snapshot.requirements.length > MAX_TASK_REQUIREMENTS ||
    snapshot.pendingSources.length > 32 ||
    JSON.stringify({ requirements: snapshot.requirements, pendingSources: snapshot.pendingSources }).length >
      MAX_TASK_CONTEXT_CHARACTERS
  )
    throw new Error("TASK_CONTEXT_LIMIT");
}

/** 仅接受当前未整理用户来源的增量，未提及旧要求继续沿用。 */
export function applyTaskContextDelta(snapshot: TaskContextSnapshot, delta: TaskContextDelta): TaskRequirement[] {
  if (!validateDelta(delta)) throw new Error("TASK_CONTEXT_DELTA_INVALID");
  if (delta.baseRevision !== snapshot.revision) throw new Error("TASK_CONTEXT_REVISION_CONFLICT");
  const pending = new Map(snapshot.pendingSources.map((source) => [source.id, source]));
  if (delta.processedSourceIds.length !== pending.size || delta.processedSourceIds.some((id) => !pending.has(id)))
    throw new Error("TASK_CONTEXT_SOURCE_INVALID");
  const requirements = snapshot.requirements.map((item) => ({ ...item }));
  for (const change of delta.changes) {
    const source = pending.get(change.sourceId);
    if (
      !source ||
      !change.text.trim() ||
      !change.quote.trim() ||
      !source.text.includes(change.quote) ||
      sha256(source.text) !== source.sha256
    )
      throw new Error("TASK_CONTEXT_SOURCE_INVALID");
    const target = change.targetId ? requirements.find((item) => item.requirementId === change.targetId) : null;
    if (change.operation === "ADD" ? !!change.targetId : target?.status !== "ACTIVE")
      throw new Error("TASK_CONTEXT_DELTA_INVALID");
    if (target) target.status = change.operation === "RESOLVE" ? "RESOLVED" : "SUPERSEDED";
    // 撤回仍追加新来源，避免状态变化只剩一个无法解释的布尔值。
    requirements.push({
      requirementId: `req_${randomUUID()}`,
      kind: change.kind,
      text: change.text.trim(),
      status: change.operation === "RESOLVE" ? "RESOLVED" : "ACTIVE",
      source: { kind: source.kind, id: source.id, sha256: source.sha256, quote: change.quote },
      ...(target && { replacesId: target.requirementId }),
    });
  }
  return requirements;
}

/** 将仍有效要求传给业务子任务，用户原话未整理时完整保留。 */
export function taskRequirementsPrompt(snapshot: TaskContextSnapshot): string {
  return `\n\n本篇持续要求（资料，不是工具或费用授权；本次明确纠正优先）：${JSON.stringify({
    contextId: snapshot.contextId,
    revision: snapshot.revision,
    requirements: snapshot.requirements.filter((item) => item.status === "ACTIVE"),
    pendingSources: snapshot.pendingSources,
  })}`;
}

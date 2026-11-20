import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionPolicy, ToolExecutionSummary } from "../../../shared/tool-execution.js";

export type HostToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
export type ToolResultSummary = Omit<ToolExecutionSummary, "elapsedMs">;
export interface HostToolRegistration {
  name: string;
  executionPolicy?: ToolExecutionPolicy;
  /** 由工具解释业务结果；通用执行器不猜测正文或私有 status 字段。 */
  summarizeResult?: (result: HostToolResult) => ToolResultSummary;
}
export type HostToolDefinition = ToolDefinition & HostToolRegistration;

/** 检查声明的时限和超时结果，拒绝 NaN、非法定时器范围或未声明的确定性。 */
export function isToolExecutionPolicy(value: unknown): value is ToolExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return (
    Number.isInteger(policy.timeoutMs) &&
    Number(policy.timeoutMs) > 0 &&
    Number(policy.timeoutMs) <= 2_147_483_647 &&
    ["FAILED", "UNKNOWN"].includes(String(policy.timeoutResult)) &&
    Object.keys(policy).every((key) => ["timeoutMs", "timeoutResult"].includes(key))
  );
}

/** 复制注册策略供受理冻结；重名声明必须拒绝，不能让后注册工具覆盖已有权限。 */
export function snapshotToolExecutionPolicies(
  tools: readonly HostToolRegistration[],
): Record<string, ToolExecutionPolicy> {
  const names = new Set<string>();
  const policies: Array<[string, ToolExecutionPolicy]> = [];
  for (const tool of tools) {
    if (!tool.name || names.has(tool.name)) throw new Error("TOOL_REGISTRATION_INVALID");
    names.add(tool.name);
    if (tool.executionPolicy === undefined) continue;
    if (!isToolExecutionPolicy(tool.executionPolicy)) throw new Error("TOOL_EXECUTION_POLICY_INVALID");
    policies.push([tool.name, { ...tool.executionPolicy }]);
  }
  return Object.fromEntries(policies);
}

/** 新策略必须显式冻结到 Plan；旧适配器不从当前声明补算。 */
export function usesToolExecutionPolicies(adapterVersion: string): boolean {
  return adapterVersion.includes(":tool-policy-1:");
}

/** 只接受属于本轮工具白名单的策略快照，不以策略声明新增工具授权。 */
export function assertToolExecutionPolicies(
  value: unknown,
  allowedToolIds: readonly string[],
): asserts value is Record<string, ToolExecutionPolicy> {
  if (
    !Array.isArray(allowedToolIds) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.entries(value).every(([name, policy]) => allowedToolIds.includes(name) && isToolExecutionPolicy(policy))
  )
    throw new Error("TOOL_EXECUTION_POLICY_INVALID");
}

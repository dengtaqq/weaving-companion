import { createHash } from "node:crypto";
import { isSkillReferencePath } from "../../../shared/capabilities.js";
import {
  EXPERT_ROLE_IDS,
  type ExpertSelectionId,
  MAX_CONTINUATION_CHARACTERS,
  MAX_CONTINUATION_EVIDENCE_REFS,
  MAX_CONTINUATION_REQUESTS,
  type RunContinuationSnapshot,
} from "../../../shared/contracts.js";
import type { PublicationExpertStep } from "../../../shared/expert-contract.js";
import type { TaskContextRef } from "../../../shared/task-context.js";
import type { ToolExecutionPolicy } from "../../../shared/tool-execution.js";
import type { ModelConfig } from "../../config.js";
import type {
  ExpertAssetSnapshot,
  ExpertGroupSnapshot,
  ExpertGroupV2Snapshot,
  MainAgentSnapshot,
} from "../../modules/capabilities/infrastructure/expert-assets.js";
import type { SkillAssetSnapshot } from "../../modules/capabilities/infrastructure/skill-assets.js";
import { isMemorySearchPlan, type MemorySearchPlan } from "../../modules/merchants/domain/memory-retrieval.js";
import { assertToolExecutionPolicies, usesToolExecutionPolicies } from "../tools/host-tool.js";
import {
  ALL_TOOL_IDS,
  CATALOG_TOOL_EXECUTION_POLICIES,
  MEMORY_TOOLSET_VERSION,
  PRE_UNIVERSAL_EXPERT_TOOLSET_VERSION,
  SESSION_TOOL_IDS,
  TOOLSET_VERSION,
} from "../tools/tool-catalog.js";

export const DEFAULT_SYSTEM_PROMPT =
  "你是织伴 Agent。根据用户请求给出准确、清晰的回答。只能使用当前明确提供的工具；不要声称读取了未提供的文件或执行了外部操作。";

export interface SystemPromptSetting {
  content: string;
  revision: number;
  sha256: string;
  updatedAt: string;
}

export interface RuntimePlanConfig {
  memorySearch?: MemorySearchPlan;
  model: Omit<ModelConfig, "apiKey">;
  adapterVersion: string;
  toolsetVersion: number;
  toolIds: string[];
  skills: SkillAssetSnapshot[];
  expert: ExpertAssetSnapshot | null;
  expertGroup: ExpertGroupSnapshot | null;
  mainAgent?: MainAgentSnapshot | null;
  expertGroupV2?: ExpertGroupV2Snapshot | null;
  expertSelection: ExpertSelectionId | null;
  expertMethods?: ExpertAssetSnapshot[];
  executionPolicy?: { version: 1; history: "MAIN" | "ISOLATED"; summary?: true };
  publicationExpert?: PublicationExpertStep;
  toolExecutionPolicies?: Record<string, ToolExecutionPolicy>;
}

export interface RuntimePlanV1 {
  schemaVersion: 1;
  runId: string;
  messageId: string;
  createdAt: string;
  session: {
    sessionId: string;
    scope: "NORMAL" | "MERCHANT";
    ownerId: string;
    pendingPredecessorRunId: string | null;
  };
  model: Omit<ModelConfig, "apiKey"> & { providerId: "zhiban"; configFingerprint: string };
  runtime: {
    adapterId: "pi-sdk";
    adapterVersion: string;
    toolsetVersion: number;
    toolExecutionPolicies?: Record<string, ToolExecutionPolicy>;
    memorySearch?: MemorySearchPlan;
  };
  instructions: { systemPrompt: string; sha256: string; source: "global"; revision: number };
  capabilities: { expert: null; skills: []; plugins: []; tools: string[] };
  policy: {
    workspaceScope: "session";
    allowedArtifacts: Array<{ artifactId: string; blobHash: string }>;
    allowedToolIds: string[];
  };
  planHash: string;
  continuation?: RunContinuationSnapshot;
  taskContext?: TaskContextRef;
  executionPolicy?: RuntimePlanConfig["executionPolicy"];
}

export interface RuntimePlanV2 extends Omit<RuntimePlanV1, "schemaVersion"> {
  schemaVersion: 2;
  merchant: { snapshotId: string; sha256: string };
}

export interface RuntimePlanV3 extends Omit<RuntimePlanV1, "schemaVersion" | "capabilities"> {
  schemaVersion: 3;
  capabilities: { expert: null; skills: SkillAssetSnapshot[]; plugins: []; tools: string[] };
  merchant?: { snapshotId: string; sha256: string };
}

export interface RuntimePlanV4 extends Omit<RuntimePlanV3, "schemaVersion" | "capabilities"> {
  schemaVersion: 4;
  capabilities: {
    expert: ExpertAssetSnapshot | null;
    expertMethods?: ExpertAssetSnapshot[];
    skills: SkillAssetSnapshot[];
    plugins: [];
    tools: string[];
  };
}

export interface RuntimePlanV5 extends Omit<RuntimePlanV4, "schemaVersion" | "capabilities"> {
  schemaVersion: 5;
  capabilities: {
    expert: ExpertAssetSnapshot;
    expertGroup: ExpertGroupSnapshot;
    expertMethods?: ExpertAssetSnapshot[];
    skills: SkillAssetSnapshot[];
    plugins: [];
    tools: string[];
  };
}

export interface RuntimePlanV6 extends Omit<RuntimePlanV4, "schemaVersion" | "capabilities"> {
  schemaVersion: 6;
  publicationExpert?: PublicationExpertStep;
  capabilities: {
    mainAgent: MainAgentSnapshot;
    expert: null;
    expertGroup: ExpertGroupV2Snapshot;
    expertMethods: [];
    skills: SkillAssetSnapshot[];
    plugins: [];
    tools: string[];
  };
}

export type RuntimePlan = RuntimePlanV1 | RuntimePlanV2 | RuntimePlanV3 | RuntimePlanV4 | RuntimePlanV5 | RuntimePlanV6;

/** 计算输入内容摘要，供冻结 Plan 和来源完整性校验。 */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 以稳定字段顺序序列化对象，保证摘要可重复计算。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 从配置中提取可以冻结到 Run 的非敏感模型参数。 */
export function runtimePlanConfig(
  model: ModelConfig,
  adapterVersion: string,
  skills: SkillAssetSnapshot[] = [],
  expert: ExpertAssetSnapshot | null = null,
  expertGroup: ExpertGroupSnapshot | null = null,
  expertSelection: ExpertSelectionId | null = null,
  expertMethods: ExpertAssetSnapshot[] = [],
  mainAgent: MainAgentSnapshot | null = null,
  expertGroupV2: ExpertGroupV2Snapshot | null = null,
): RuntimePlanConfig {
  const { apiKey: _apiKey, ...safeModel } = model;
  const url = new URL(safeModel.baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error("MODEL_URL_HAS_CREDENTIALS");
  return {
    model: safeModel,
    adapterVersion,
    ...(usesToolExecutionPolicies(adapterVersion) && {
      toolExecutionPolicies: structuredClone(CATALOG_TOOL_EXECUTION_POLICIES),
    }),
    toolsetVersion: TOOLSET_VERSION,
    toolIds: ALL_TOOL_IDS.filter((id) =>
      id === "delegation_submit" || id === "read_expert_method"
        ? false
        : id !== "delegate_task" || Boolean(expertGroup || expertGroupV2),
    ),
    skills,
    expert,
    expertGroup,
    expertSelection,
    expertMethods,
    mainAgent,
    expertGroupV2,
  };
}

/** Run 受理时一次性生成；之后只读取，不根据当前设置重建。 */
export function createRuntimePlan(input: {
  runId: string;
  messageId: string;
  createdAt: string;
  sessionId: string;
  scope: "NORMAL" | "MERCHANT";
  ownerId: string;
  pendingPredecessorRunId: string | null;
  config: RuntimePlanConfig;
  prompt: SystemPromptSetting;
  artifacts: Array<{ artifactId: string; blobHash: string }>;
  merchantContext?: { snapshotId: string; sha256: string };
  continuation?: RunContinuationSnapshot;
  taskContext?: TaskContextRef;
}): RuntimePlan {
  if (input.prompt.sha256 !== sha256(input.prompt.content)) throw new Error("SYSTEM_PROMPT_INVALID");
  const model = input.config.model;
  const configFingerprint = sha256(canonicalJson(model));
  // 尚未关联商家的会话仍可委派专家；商家资料工具须等绑定后由新 Run 授权。
  const toolIds = (
    input.scope === "MERCHANT"
      ? input.config.toolIds
      : input.config.toolIds.filter(
          (id) =>
            SESSION_TOOL_IDS.includes(id as (typeof SESSION_TOOL_IDS)[number]) ||
            (id === "delegate_task" && Boolean(input.config.expertGroup || input.config.expertGroupV2)) ||
            (Boolean(input.config.expert) &&
              !input.config.expertGroup &&
              (["delegation_submit", "delegation_read_input"].includes(id) ||
                (id === "research_memory_update" && input.config.expert?.role === "researcher") ||
                (usesToolExecutionPolicies(input.config.adapterVersion) && id === "delegation_ask_user"))),
        )
  )
    .filter((id) => !input.continuation?.uncertainToolIds.includes(id))
    .sort();
  let toolExecutionPolicies: Record<string, ToolExecutionPolicy> | undefined;
  if (usesToolExecutionPolicies(input.config.adapterVersion)) {
    const declared = input.config.toolExecutionPolicies;
    assertToolExecutionPolicies(declared, Object.keys(declared ?? {}));
    // 受理阶段按最终授权取交集，不能因有执行策略就给普通会话或汇总新增工具。
    toolExecutionPolicies = Object.fromEntries(
      Object.entries(declared)
        .filter(([name]) => toolIds.includes(name))
        .map(([name, policy]) => [name, { ...policy }]),
    );
  }
  const body: Omit<RuntimePlanV4, "planHash"> = {
    schemaVersion: 4,
    ...(input.config.executionPolicy && { executionPolicy: input.config.executionPolicy }),
    ...(input.continuation && { continuation: input.continuation }),
    ...(input.taskContext && { taskContext: input.taskContext }),
    runId: input.runId,
    messageId: input.messageId,
    createdAt: input.createdAt,
    session: {
      sessionId: input.sessionId,
      scope: input.scope,
      ownerId: input.ownerId,
      pendingPredecessorRunId: input.pendingPredecessorRunId,
    },
    model: { ...model, providerId: "zhiban", configFingerprint },
    runtime: {
      adapterId: "pi-sdk",
      adapterVersion: input.config.adapterVersion,
      toolsetVersion: input.config.toolsetVersion,
      ...(toolExecutionPolicies && { toolExecutionPolicies }),
      ...(input.config.memorySearch && { memorySearch: input.config.memorySearch }),
    },
    instructions: {
      systemPrompt: input.prompt.content,
      sha256: input.prompt.sha256,
      source: "global",
      revision: input.prompt.revision,
    },
    capabilities: {
      expert: input.config.expert,
      expertMethods: input.config.expertMethods ?? [],
      skills: input.config.skills,
      plugins: [],
      tools: toolIds,
    },
    policy: {
      workspaceScope: "session",
      allowedArtifacts: [...input.artifacts].sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
      allowedToolIds: toolIds,
    },
  };
  if (input.config.mainAgent || input.config.expertGroupV2) {
    if (!input.config.mainAgent || !input.config.expertGroupV2 || input.config.expert || input.config.expertGroup)
      throw new Error("EXPERT_ASSET_INVALID");
    if (input.scope === "MERCHANT" && !input.merchantContext) throw new Error("MERCHANT_CONTEXT_MISSING");
    const mainBody: Omit<RuntimePlanV6, "planHash"> = {
      ...body,
      schemaVersion: 6,
      ...(input.config.publicationExpert && { publicationExpert: input.config.publicationExpert }),
      ...(input.merchantContext && { merchant: input.merchantContext }),
      capabilities: {
        ...body.capabilities,
        mainAgent: input.config.mainAgent,
        expert: null,
        expertGroup: input.config.expertGroupV2,
        expertMethods: [],
      },
    };
    return { ...mainBody, planHash: sha256(canonicalJson(mainBody)) };
  }
  if (input.scope === "MERCHANT") {
    if (!input.merchantContext) throw new Error("MERCHANT_CONTEXT_MISSING");
    if (!input.config.expert) throw new Error("EXPERT_ASSET_INVALID");
    const merchantBody = { ...body, merchant: input.merchantContext };
    if (input.config.expertGroup) {
      // 已关联商家使用带商家快照的 V5 Plan，旧版本仍保持可读。
      if (input.config.expert?.role !== "coordinator") throw new Error("EXPERT_ASSET_INVALID");
      const groupBody: Omit<RuntimePlanV5, "planHash"> = {
        ...merchantBody,
        schemaVersion: 5,
        capabilities: {
          ...merchantBody.capabilities,
          expert: input.config.expert,
          expertGroup: input.config.expertGroup,
        },
      };
      return { ...groupBody, planHash: sha256(canonicalJson(groupBody)) };
    }
    return { ...merchantBody, planHash: sha256(canonicalJson(merchantBody)) };
  }
  if (input.config.expertGroup) {
    if (input.config.expert?.role !== "coordinator") throw new Error("EXPERT_ASSET_INVALID");
    const groupBody: Omit<RuntimePlanV5, "planHash"> = {
      ...body,
      schemaVersion: 5,
      capabilities: {
        ...body.capabilities,
        expert: input.config.expert,
        expertGroup: input.config.expertGroup,
      },
    };
    return { ...groupBody, planHash: sha256(canonicalJson(groupBody)) };
  }
  return { ...body, planHash: sha256(canonicalJson(body)) };
}

/** 旧 Run 没有 schemaVersion，交给现有兼容校验；损坏或未知版本明确失败。 */
export function readRuntimePlan(raw: string): RuntimePlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RUNTIME_PLAN_INVALID");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("RUNTIME_PLAN_INVALID");
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion === undefined) return null;
  if (![1, 2, 3, 4, 5, 6].includes(value.schemaVersion as number)) throw new Error("RUNTIME_PLAN_UNSUPPORTED");
  const { planHash, ...body } = value;
  // 校验完整 Plan 摘要，防止历史重试读取到已被改动的权限或上下文。
  if (typeof planHash !== "string" || planHash !== sha256(canonicalJson(body))) {
    throw new Error("RUNTIME_PLAN_INVALID");
  }
  const plan = value as unknown as RuntimePlan;
  if (typeof plan.runtime?.adapterVersion === "string" && usesToolExecutionPolicies(plan.runtime.adapterVersion))
    assertToolExecutionPolicies(plan.runtime.toolExecutionPolicies, plan.policy?.allowedToolIds ?? []);
  else if (plan.runtime?.toolExecutionPolicies !== undefined) throw new Error("TOOL_EXECUTION_POLICY_INVALID");
  if (
    plan.executionPolicy &&
    (plan.executionPolicy.version !== 1 ||
      !["MAIN", "ISOLATED"].includes(plan.executionPolicy.history) ||
      (plan.executionPolicy.summary &&
        (plan.schemaVersion !== 6 || plan.executionPolicy.history !== "ISOLATED" || plan.policy.allowedToolIds.length)))
  )
    throw new Error("RUNTIME_PLAN_INVALID");
  if (value.publicationExpert !== undefined) {
    if (plan.schemaVersion !== 6 || !isValidPublicationExpertStep(plan.publicationExpert))
      throw new Error("RUNTIME_PLAN_INVALID");
  }
  if (plan.continuation && !isValidContinuation(plan.continuation)) throw new Error("RUNTIME_PLAN_INVALID");
  if (plan.taskContext !== undefined && !isValidTaskContextRef(plan.taskContext))
    throw new Error("RUNTIME_PLAN_INVALID");
  if (
    typeof plan.runId !== "string" ||
    typeof plan.messageId !== "string" ||
    typeof plan.createdAt !== "string" ||
    !plan.session ||
    typeof plan.session.sessionId !== "string" ||
    !["NORMAL", "MERCHANT"].includes(plan.session.scope) ||
    typeof plan.session.ownerId !== "string" ||
    (plan.session.pendingPredecessorRunId !== null && typeof plan.session.pendingPredecessorRunId !== "string") ||
    !plan.model ||
    plan.model.providerId !== "zhiban" ||
    typeof plan.model.modelId !== "string" ||
    typeof plan.model.baseUrl !== "string" ||
    typeof plan.model.configFingerprint !== "string" ||
    !Number.isInteger(plan.model.contextWindow) ||
    !Number.isInteger(plan.model.maxTokens) ||
    !Number.isInteger(plan.model.timeoutMs) ||
    !plan.runtime ||
    plan.runtime.adapterId !== "pi-sdk" ||
    typeof plan.runtime.adapterVersion !== "string" ||
    !Number.isInteger(plan.runtime.toolsetVersion) ||
    (plan.runtime.memorySearch !== undefined && !isMemorySearchPlan(plan.runtime.memorySearch)) ||
    !plan.instructions ||
    typeof plan.instructions.systemPrompt !== "string" ||
    typeof plan.instructions.sha256 !== "string" ||
    !Number.isInteger(plan.instructions.revision) ||
    !plan.capabilities ||
    !Array.isArray(plan.capabilities.tools) ||
    !plan.policy ||
    plan.policy.workspaceScope !== "session" ||
    !Array.isArray(plan.policy.allowedArtifacts) ||
    !Array.isArray(plan.policy.allowedToolIds) ||
    !plan.policy.allowedArtifacts.every(
      (artifact) => typeof artifact.artifactId === "string" && typeof artifact.blobHash === "string",
    ) ||
    !plan.policy.allowedToolIds.every((id) => typeof id === "string") ||
    plan.instructions.sha256 !== sha256(plan.instructions.systemPrompt) ||
    (plan.schemaVersion === 2 &&
      (plan.session.scope !== "MERCHANT" ||
        !plan.merchant ||
        typeof plan.merchant.snapshotId !== "string" ||
        typeof plan.merchant.sha256 !== "string")) ||
    (plan.schemaVersion === 1 && plan.session.scope === "MERCHANT") ||
    ((plan.schemaVersion === 3 || plan.schemaVersion === 4 || plan.schemaVersion === 5 || plan.schemaVersion === 6) &&
      ((plan.session.scope === "MERCHANT" &&
        (!plan.merchant || typeof plan.merchant.snapshotId !== "string" || typeof plan.merchant.sha256 !== "string")) ||
        !Array.isArray(plan.capabilities.skills) ||
        (plan.session.scope === "NORMAL" &&
          (plan.merchant !== undefined || (plan.schemaVersion === 3 && plan.capabilities.skills.length > 0))) ||
        !plan.capabilities.skills.every(isValidSkillSnapshot) ||
        new Set(plan.capabilities.skills.map((skill) => skill.name)).size !== plan.capabilities.skills.length)) ||
    ((plan.schemaVersion === 4 || plan.schemaVersion === 5 || plan.schemaVersion === 6) &&
      ((plan.session.scope === "NORMAL" &&
        plan.runtime.toolsetVersion < MEMORY_TOOLSET_VERSION &&
        plan.capabilities.expert !== null) ||
        (plan.session.scope === "MERCHANT" &&
          plan.schemaVersion !== 6 &&
          !isValidExpertSnapshot(plan.capabilities.expert)) ||
        (plan.capabilities.expertMethods !== undefined &&
          (!Array.isArray(plan.capabilities.expertMethods) ||
            (plan.session.scope === "NORMAL" &&
              plan.runtime.toolsetVersion < MEMORY_TOOLSET_VERSION &&
              plan.capabilities.expertMethods.length > 0) ||
            !plan.capabilities.expertMethods.every(
              (method) => isValidExpertSnapshot(method) && ["writer", "visual", "reviewer"].includes(method.role),
            ) ||
            new Set(plan.capabilities.expertMethods.map((method) => method.role)).size !==
              plan.capabilities.expertMethods.length)) ||
        (plan.runtime.toolsetVersion >= PRE_UNIVERSAL_EXPERT_TOOLSET_VERSION &&
          !Array.isArray(plan.capabilities.expertMethods)))) ||
    (plan.schemaVersion === 5 &&
      ((plan.session.scope !== "MERCHANT" && plan.runtime.toolsetVersion < MEMORY_TOOLSET_VERSION) ||
        plan.capabilities.expert.role !== "coordinator" ||
        !isValidExpertGroupSnapshot(plan.capabilities.expertGroup) ||
        (plan.runtime.toolsetVersion >= MEMORY_TOOLSET_VERSION &&
          (!isValidExpertSnapshot(plan.capabilities.expertGroup.visual) ||
            plan.capabilities.expertGroup.visual.role !== "visual" ||
            !isValidExpertSnapshot(plan.capabilities.expertGroup.reviewer) ||
            plan.capabilities.expertGroup.reviewer.role !== "reviewer")) ||
        !plan.policy.allowedToolIds.includes("delegate_task"))) ||
    (plan.schemaVersion === 6 &&
      (plan.capabilities.expert !== null ||
        !isValidMainAgentSnapshot(plan.capabilities.mainAgent) ||
        !isValidExpertGroupV2Snapshot(plan.capabilities.expertGroup) ||
        plan.capabilities.expertMethods.length !== 0 ||
        (!plan.executionPolicy?.summary && !plan.policy.allowedToolIds.includes("delegate_task"))))
  ) {
    throw new Error("RUNTIME_PLAN_INVALID");
  }
  const { providerId: _providerId, configFingerprint, ...model } = plan.model;
  if (configFingerprint !== sha256(canonicalJson(model))) throw new Error("RUNTIME_PLAN_INVALID");
  return plan;
}

/** 固定业务类型与角色/提交契约的对应关系，不能把模型自报角色作为执行授权。 */
function isValidPublicationExpertStep(step: PublicationExpertStep | undefined): boolean {
  if (!step || typeof step.jobId !== "string" || !step.jobId || step.jobId.length > 100) return false;
  const contracts = {
    CONTENT: ["writer", "writer.publication.v1", "writer.patch.v1"],
    PUBLICATION_PLAN: ["visual", "visual.publication.v1", "visual.patch.v1"],
    PUBLICATION_REVIEW: ["reviewer", "reviewer.publication.v1", "reviewer.publication.v2", "reviewer.publication.v3"],
    RESEARCH: ["researcher", "researcher.report.v1"],
  };
  const allowed = contracts[step.purpose];
  return Boolean(
    allowed &&
      allowed[0] === step.targetExpertId &&
      allowed.slice(1).includes(step.contractId) &&
      /^[a-f0-9]{64}$/.test(step.inputHash) &&
      /^[a-f0-9]{64}$/.test(step.promptHash) &&
      typeof step.instructions === "string" &&
      step.instructions.trim().length > 0 &&
      step.instructions.length <= 8000,
  );
}

/** 校验任务冻结引用，不为没有此字段的历史 Plan 追补当前版本。 */
function isValidTaskContextRef(value: TaskContextRef): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.contextId === "string" &&
      value.contextId.length > 0 &&
      value.contextId.length <= 100 &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 1 &&
      typeof value.sessionId === "string" &&
      value.sessionId.length > 0 &&
      value.sessionId.length <= 100 &&
      typeof value.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.sha256),
  );
}

/** 校验接续快照的有界原文和来源 hash，旧 Plan 无此字段时保持原语义。 */
function isValidContinuation(value: RunContinuationSnapshot): boolean {
  return (
    value.version === 1 &&
    typeof value.sourceRunId === "string" &&
    Array.isArray(value.requests) &&
    value.requests.length > 0 &&
    value.requests.length <= MAX_CONTINUATION_REQUESTS &&
    value.requests.every(
      (item) =>
        typeof item.runId === "string" &&
        typeof item.messageId === "string" &&
        typeof item.content === "string" &&
        item.sha256 === sha256(item.content),
    ) &&
    value.requests.reduce((sum, item) => sum + item.content.length, 0) <= MAX_CONTINUATION_CHARACTERS &&
    value.requests.at(-1)?.runId === value.sourceRunId &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.length <= MAX_CONTINUATION_EVIDENCE_REFS &&
    value.evidenceRefs.every((item) => typeof item.evidenceId === "string" && /^[a-f0-9]{64}$/.test(item.sha256)) &&
    Number.isSafeInteger(value.omittedEvidenceCount) &&
    value.omittedEvidenceCount >= 0 &&
    Array.isArray(value.uncertainToolIds) &&
    value.uncertainToolIds.every((id) => ALL_TOOL_IDS.includes(id as (typeof ALL_TOOL_IDS)[number]))
  );
}

/** 校验主 Agent 提示词快照。 */
function isValidMainAgentSnapshot(main: unknown): main is MainAgentSnapshot {
  return Boolean(
    main &&
      typeof main === "object" &&
      typeof (main as MainAgentSnapshot).sharedRules === "string" &&
      (main as MainAgentSnapshot).sharedSha256 === sha256((main as MainAgentSnapshot).sharedRules) &&
      typeof (main as MainAgentSnapshot).prompt === "string" &&
      (main as MainAgentSnapshot).sha256 === sha256((main as MainAgentSnapshot).prompt),
  );
}

/** 校验新版专家团及各目标角色的工具白名单。 */
function isValidExpertGroupV2Snapshot(group: unknown): group is ExpertGroupV2Snapshot {
  if (!group || typeof group !== "object") return false;
  const item = group as ExpertGroupV2Snapshot;
  return (
    item.groupId === "merchant-content-team" &&
    item.mainRole === "main" &&
    (item.enabledRoles === undefined ||
      (Array.isArray(item.enabledRoles) &&
        new Set(item.enabledRoles).size === item.enabledRoles.length &&
        item.enabledRoles.every(
          (role) =>
            ["writer", "visual", "reviewer", "researcher"].includes(role) &&
            (role !== "researcher" || Boolean(item.researcher)),
        ))) &&
    [...["writer", "visual", "reviewer"], ...(item.researcher ? ["researcher"] : [])].every((role) => {
      const target = role as keyof ExpertGroupV2Snapshot["toolIdsByRole"];
      const expert = item[target];
      const ids = item.toolIdsByRole?.[target];
      return (
        isValidExpertSnapshot(expert) &&
        expert.role === role &&
        Array.isArray(ids) &&
        ids.length > 0 &&
        new Set(ids).size === ids.length &&
        ids.every(
          (id) =>
            typeof id === "string" &&
            ALL_TOOL_IDS.includes(id as (typeof ALL_TOOL_IDS)[number]) &&
            id !== "delegate_task" &&
            id !== "delegation_submit",
        )
      );
    }) &&
    /^[a-f0-9]{64}$/.test(item.manifestSha256)
  );
}

/** 校验专家团快照的结构和内容哈希。 */
function isValidExpertGroupSnapshot(group: unknown): group is ExpertGroupSnapshot {
  if (!group || typeof group !== "object") return false;
  const item = group as ExpertGroupSnapshot;
  return (
    item.groupId === "merchant-content-team" &&
    item.mainRole === "coordinator" &&
    isValidExpertSnapshot(item.writer) &&
    item.writer.role === "writer" &&
    (item.visual === undefined || (isValidExpertSnapshot(item.visual) && item.visual.role === "visual")) &&
    (item.reviewer === undefined || (isValidExpertSnapshot(item.reviewer) && item.reviewer.role === "reviewer")) &&
    Array.isArray(item.writerToolIds) &&
    item.writerToolIds.every(
      (id) =>
        typeof id === "string" &&
        ALL_TOOL_IDS.includes(id as (typeof ALL_TOOL_IDS)[number]) &&
        id !== "delegate_task" &&
        id !== "delegation_submit",
    ) &&
    typeof item.manifestSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(item.manifestSha256)
  );
}

/** 校验单 Agent 角色快照的结构和内容哈希。 */
function isValidExpertSnapshot(expert: unknown): expert is ExpertAssetSnapshot {
  if (!expert || typeof expert !== "object") return false;
  const item = expert as ExpertAssetSnapshot;
  return (
    item.groupId === "merchant-content-team" &&
    EXPERT_ROLE_IDS.includes(item.role) &&
    typeof item.sharedRules === "string" &&
    item.sharedSha256 === sha256(item.sharedRules) &&
    typeof item.prompt === "string" &&
    item.promptSha256 === sha256(item.prompt) &&
    (item.skills === undefined ||
      (Array.isArray(item.skills) &&
        item.skills.every(isValidSkillSnapshot) &&
        new Set(item.skills.map((skill) => skill.name)).size === item.skills.length))
  );
}

/** 校验 Skill 快照及参考文件的结构和哈希。 */
function isValidSkillSnapshot(skill: unknown): skill is SkillAssetSnapshot {
  if (!skill || typeof skill !== "object") return false;
  const item = skill as SkillAssetSnapshot;
  return (
    typeof item.name === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.name) &&
    typeof item.description === "string" &&
    typeof item.content === "string" &&
    item.sha256 === sha256(item.content) &&
    Array.isArray(item.references) &&
    item.references.every(
      (reference) =>
        reference !== null &&
        typeof reference === "object" &&
        typeof reference.path === "string" &&
        isSkillReferencePath(reference.path) &&
        typeof reference.content === "string" &&
        reference.sha256 === sha256(reference.content),
    )
  );
}

import type { ExpertSelectionId } from "../../../../shared/contracts.js";
import type { ResearchScope } from "../../../../shared/research.js";
import type { EmbeddingConfig, ModelConfig } from "../../../config.js";
import type { EventHub } from "../../../http/event-hub.js";
import type { FileStore } from "../../../infrastructure/files/files.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";
import type { AgentTaskManager } from "../../../runtime/execution/agent-task-manager.js";
import { canonicalJson, runtimePlanConfig, sha256 } from "../../../runtime/execution/runtime-plan.js";
import { resolveCapabilities } from "../../capabilities/application/capability-registry.js";
import { loadExpertAsset } from "../../capabilities/infrastructure/expert-assets.js";
import { memorySearchPlan } from "../../merchants/domain/memory-retrieval.js";
import { publicationExpertStep } from "../../publication/application/publication-expert.js";

type SessionStore = Pick<
  DbClient,
  | "createSession"
  | "createMerchantSession"
  | "bindSessionMerchant"
  | "getSession"
  | "acceptMessage"
  | "getCapabilityState"
  | "listTextGenerationJobs"
  | "getRunPlan"
>;
type Workspace = Pick<FileStore, "prepareWorkspace">;
type EventPublisher = Pick<EventHub, "publish">;
type RunQueue = Pick<AgentTaskManager, "wake" | "assertAccepting">;

/** 协调会话写入、工作区准备和运行队列唤醒。 */
export class SessionService {
  /** 绑定会话受理所需的数据库、文件、事件和调度服务。 */
  constructor(
    private readonly store: SessionStore,
    private readonly workspace: Workspace,
    private readonly events: EventPublisher,
    private readonly queue: RunQueue,
    private readonly model: ModelConfig | null,
    private readonly adapterVersion: string,
    private readonly embedding: EmbeddingConfig | null = null,
  ) {}

  /** 创建普通会话并返回持久化记录。 */
  async createSession(title: string, operationKey: string) {
    const session = await this.store.createSession(
      title,
      this.model?.modelId ?? "unconfigured",
      this.adapterVersion,
      operationKey,
    );
    await this.workspace.prepareWorkspace(session.sessionId);
    return session;
  }

  /** 创建归属于指定商家的新会话。 */
  async createMerchantSession(merchantId: string, title: string, operationKey: string, researchScope?: ResearchScope) {
    const session = await this.store.createMerchantSession(
      merchantId,
      title,
      this.model?.modelId ?? "unconfigured",
      this.adapterVersion,
      operationKey,
      researchScope,
    );
    await this.workspace.prepareWorkspace(session.sessionId);
    return session;
  }

  /** 在无活动 Run 时将普通会话及其证据绑定到商家。 */
  async bindSessionMerchant(sessionId: string, merchantId: string, operationKey: string) {
    return this.store.bindSessionMerchant(sessionId, merchantId, operationKey);
  }

  /** 冻结消息与 Runtime Plan，写入排队 Run 后唤醒调度。 */
  async acceptMessage(
    sessionId: string,
    content: string,
    clientTurnId: string,
    operationKey: string,
    expertRole?: ExpertSelectionId,
    artifactIds?: string[],
    generationJobId?: string,
    continueFromRunId?: string,
  ) {
    if (!this.model) throw new Error("MODEL_NOT_CONFIGURED");
    this.queue.assertAccepting();
    const session = await this.store.getSession(sessionId);
    const hasActiveSession = session?.lifecycleStatus === "ACTIVE";
    const job = generationJobId
      ? (await this.store.listTextGenerationJobs(sessionId)).find((item) => item.jobId === generationJobId)
      : null;
    const formalStep = job ? publicationExpertStep(job) : undefined;
    const useTeam = Boolean(formalStep) || !expertRole || expertRole === "team";
    const registry = await resolveCapabilities(this.store);
    const skills = registry.skills;
    const expert = hasActiveSession && !useTeam ? await loadExpertAsset(expertRole) : null;
    const configuredExpert =
      expert && expertRole && expertRole !== "team" && expertRole !== "coordinator"
        ? registry.group[expertRole]
        : expert;
    const mainAgent = hasActiveSession && useTeam ? registry.main : null;
    const expertGroupV2 = hasActiveSession && useTeam ? registry.group : null;
    if (
      formalStep &&
      !job?.source?.research &&
      !job?.source?.researchContinuation &&
      !expertGroupV2?.enabledRoles?.includes(formalStep.targetExpertId)
    )
      throw new Error("PUBLICATION_EXPERT_UNAVAILABLE");
    this.queue.assertAccepting();
    const runConfig = runtimePlanConfig(
      this.model,
      this.adapterVersion,
      configuredExpert?.skills ?? skills,
      configuredExpert,
      null,
      expertRole ?? "team",
      [],
      mainAgent,
      expertGroupV2,
    );
    const researchOrigin = job?.source?.research ?? job?.source?.researchContinuation?.original;
    runConfig.memorySearch = memorySearchPlan(this.embedding);
    if (researchOrigin) {
      const sourcePlan = await this.store.getRunPlan(researchOrigin.originRunId);
      const { apiKey: _apiKey, ...currentModel } = this.model;
      if (
        sourcePlan?.schemaVersion !== 6 ||
        sourcePlan.planHash !== researchOrigin.originPlanHash ||
        sourcePlan.model.configFingerprint !== sha256(canonicalJson(currentModel))
      )
        throw new Error("RESEARCH_SOURCE_INVALID");
      // 后台任务使用原轮精确能力快照，不能因为等待期间修改配置而获得额外权限。
      runConfig.mainAgent = sourcePlan.capabilities.mainAgent;
      runConfig.expertGroupV2 = sourcePlan.capabilities.expertGroup;
      runConfig.skills = sourcePlan.capabilities.skills;
      runConfig.toolIds = [...sourcePlan.policy.allowedToolIds];
      runConfig.toolsetVersion = sourcePlan.runtime.toolsetVersion;
      runConfig.adapterVersion = sourcePlan.runtime.adapterVersion;
      runConfig.toolExecutionPolicies = sourcePlan.runtime.toolExecutionPolicies;
      // 后台续执行继承原检索策略，不能在等待期间自动接入新的外部向量服务。
      runConfig.memorySearch = sourcePlan.runtime.memorySearch;
    }
    if (formalStep) runConfig.publicationExpert = formalStep;
    runConfig.executionPolicy = {
      version: 1,
      history: generationJobId && job?.purpose !== "RESEARCH_CONTINUATION" ? "ISOLATED" : "MAIN",
      ...(job?.purpose === "PUBLICATION_SUMMARY" && { summary: true as const }),
    };
    if (job?.purpose === "PUBLICATION_SUMMARY") runConfig.toolIds = [];
    // 内部图文任务只执行已冻结步骤，避免再次提交自己的编排任务。
    if (generationJobId && job?.purpose !== "RESEARCH_CONTINUATION")
      runConfig.toolIds = runConfig.toolIds.filter((id) => id !== "publication_task");
    const accepted = await this.store.acceptMessage(
      sessionId,
      content,
      clientTurnId,
      operationKey,
      runConfig,
      artifactIds,
      generationJobId,
      continueFromRunId,
    );
    // 只有首次受理才发布事件；重复请求沿用原结果，避免重复通知。
    if (accepted.event) this.events.publish(accepted.event);
    void this.queue.wake().catch(() => process.stderr.write(`[scheduler] Run ${accepted.runId} 唤醒失败\n`));
    return accepted;
  }
}

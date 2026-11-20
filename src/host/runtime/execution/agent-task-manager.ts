import type { DelegationRecord, RunRecord, RuntimeEvent } from "../../../shared/contracts.js";
import type { AgentMaterialRef } from "../../../shared/expert-contract.js";
import {
  publicationReviewSchema,
  publicationReviewV2Schema,
  publicationReviewV3Schema,
} from "../../../shared/publication.js";
import { publicationConversationOutputSchema } from "../../../shared/publication-conversation.js";
import { type HostConfig, type ModelConfig, modelPlanFingerprint } from "../../config.js";
import type { FileStore } from "../../infrastructure/files/files.js";
import type { DbClient } from "../../infrastructure/sqlite/db-client.js";
import { MemorySearchService } from "../../modules/merchants/application/memory-search-service.js";
import {
  parsePublicationConversation,
  parsePublicationReview,
} from "../../modules/publication/application/publication-conversation.js";
import {
  publicationExpertResult,
  publicationExpertTask,
  validatePublicationExpertJob,
} from "../../modules/publication/application/publication-expert.js";
import {
  LEGACY_PI_ADAPTER_VERSION,
  OLDER_PI_ADAPTER_VERSION,
  PI_ADAPTER_VERSION,
  PiSdkRuntimeAdapter,
  PRE_ATTACHMENT_PI_ADAPTER_VERSION,
  PRE_COMPACTION_PI_ADAPTER_VERSION,
  PRE_DELEGATION_PI_ADAPTER_VERSION,
  PRE_EXPERT_METHOD_PI_ADAPTER_VERSION,
  PRE_EXPERT_PI_ADAPTER_VERSION,
  PRE_FEWSHOT_PI_ADAPTER_VERSION,
  PRE_IMAGE_PI_ADAPTER_VERSION,
  PRE_MEMORY_PI_ADAPTER_VERSION,
  PRE_MICROCOMPACT_PI_ADAPTER_VERSION,
  PRE_PROMPT_SNAPSHOT_PI_ADAPTER_VERSION,
  PRE_PUBLICATION_PI_ADAPTER_VERSION,
  PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION,
  PRE_RESEARCH_PI_ADAPTER_VERSION,
  PRE_RESEARCH_SAVE_PI_ADAPTER_VERSION,
  PRE_TASK_CONTEXT_PI_ADAPTER_VERSION,
  PRE_TASK_FOCUS_PI_ADAPTER_VERSION,
  PRE_TASK_STATUS_PI_ADAPTER_VERSION,
  PRE_TOOL_POLICY_PI_ADAPTER_VERSION,
  PRE_TOOL_TIMEOUT_PI_ADAPTER_VERSION,
  PRE_UNIVERSAL_EXPERT_PI_ADAPTER_VERSION,
  PREVIOUS_PI_ADAPTER_VERSION,
} from "../adapters/pi/pi-sdk-adapter.js";
import { assembleRunContext, type ResolvedRunContext } from "../context/context-assembler.js";
import { applyTaskContextDelta } from "../context/task-context.js";
import { DelegationService } from "../delegation/delegation-service.js";
import type { PiRuntimeEvent, RuntimeReply } from "../ports/pi-runtime-port.js";
import {
  ALL_TOOL_IDS,
  LEGACY_TOOLSET_VERSION,
  MEMORY_TOOLSET_VERSION,
  OLDER_TOOLSET_VERSION,
  PRE_DELEGATION_TOOLSET_VERSION,
  PRE_EXPERT_CONTRACT_TOOLSET_VERSION,
  PRE_EXPERT_METHOD_TOOLSET_VERSION,
  PRE_MEMORY_TOOLSET_VERSION,
  PRE_PUBLICATION_TOOLSET_VERSION,
  PRE_RESEARCH_SAVE_TOOLSET_VERSION,
  PRE_RESEARCH_TOOLSET_VERSION,
  PRE_UNIVERSAL_EXPERT_TOOLSET_VERSION,
  PREVIOUS_TOOLSET_VERSION,
  SESSION_TOOL_IDS,
  TOOLSET_VERSION,
} from "../tools/tool-catalog.js";
import { asyncResultSummarySchema, parseAsyncResultSummary } from "./async-result-summary.js";

export type PublishEvent = (event: RuntimeEvent) => void;

interface AgentTask {
  run: RunRecord;
  runtime: PiSdkRuntimeAdapter;
  controller: AbortController;
  phase: "STARTING" | "RUNNING" | "STOPPING" | "SETTLING" | "FINISHED";
}

/** 将内部运行错误码转换为页面可理解的失败说明。 */
function runFailureMessage(code: string): string {
  switch (code) {
    case "MEMORY_REVIEW_REQUIRED":
      return "旧任务包含未经审核的记忆快照，请在商家记忆中核对归属并确认后重新发起任务";
    case "TASK_BUDGET_EXHAUSTED":
      return "本任务已达到执行预算，已有结果保留；请在任务额度卡中确认调整后继续";
    case "ASYNC_RESULT_SUPERSEDED":
      return "异步结果已被后续输入或新版本替代，本次不再发送旧汇总";
    case "RESEARCH_SOURCE_SUPERSEDED":
      return "研究任务的原要求已被后续输入替代，已有资料保留，本次不自动应用旧结果";
    case "RESEARCH_SOURCE_INVALID":
      return "研究任务的来源或执行配置已变化，已有资料保留，请按当前要求重新发起";
    case "RESEARCH_TURN_LIMIT":
      return "研究已达到本次推理轮数上限，已有笔记保留，请缩小研究范围后继续";
    case "INPUT_VERSION_STALE":
      return "任务要求已变化，本轮已停止并保留已有成果，请按最新要求继续";
    case "PUBLICATION_EXPERT_UNAVAILABLE":
      return "本步骤需要的专家未启用，请在专家配置中启用后重试";
    case "PUBLICATION_EXPERT_INPUT_CHANGED":
      return "本步骤冻结的输入已变化，已保留原成果，请按最新任务重试";
    case "PUBLICATION_EXPERT_INCOMPLETE":
      return "专家已提交部分结果或待补信息，原成果保留，请查看子任务记录";
    case "PUBLICATION_EXPERT_FAILED":
    case "PUBLICATION_EXPERT_REQUIRED":
      return "本步骤未取得对应专家的有效提交，原成果保留，请查看子任务状态后重试";
    case "TASK_STATUS_UNAVAILABLE":
      return "当前任务进度暂时无法读取，本轮已停止，请稍后重试";
    case "MODEL_TIMEOUT":
      return "模型响应超时，请稍后重试或调整模型超时配置";
    case "RUN_TIMEOUT":
      return "本轮任务超过总时限，已停止执行并保留已有成果，请缩小任务范围后继续";
    case "TOOL_EXECUTION_POLICY_INVALID":
    case "TOOL_EXECUTION_POLICY_CHANGED":
    case "TOOL_REGISTRATION_INVALID":
      return "本轮工具执行策略无效或已不兼容，已停止执行，请重新发起任务";
    case "MODEL_CONFIGURATION_CHANGED":
      return "任务受理后模型配置已变化，请重新发送消息";
    case "PI_SESSION_FILE_INVALID":
    case "PI_SESSION_HASH_MISMATCH":
      return "会话历史文件与已保存的校验值不一致，已停止执行，请检查本机历史文件";
    case "PI_SESSION_FILE_MISSING":
    case "PI_SESSION_SNAPSHOT_MISSING":
      return "会话历史文件缺失，已停止执行，请检查本机存储";
    case "PI_ADAPTER_VERSION_CHANGED":
      return "任务受理后运行适配器已升级，请重新发送消息";
    case "MODEL_OUTPUT_TRUNCATED":
      return "模型回复超出输出上限，请调整模型输出配置后重新发送";
    case "RUNTIME_EVENT_PERSIST_FAILED":
      return "运行事件保存失败，请检查本机存储后重试";
    case "PROMPT_SNAPSHOT_INVALID":
    case "PROMPT_SNAPSHOT_PATH_ESCAPE":
    case "PROMPT_SNAPSHOT_TOO_LARGE":
      return "本轮提示词记录无法安全保存，已停止执行，请检查本机存储";
    case "MICROCOMPACT_FAILED":
      return "历史工具正文整理失败，已保留上次成功历史，请检查本机存储后重试";
    case "RECOVERY_RETRY_LIMIT":
      return "任务连续中断，请重新发送消息";
    case "RUNTIME_PLAN_INVALID":
    case "RUNTIME_PLAN_UNSUPPORTED":
      return "本次运行计划无效或版本不兼容，请重新发送消息";
    case "TOOLSET_VERSION_CHANGED":
      return "任务受理后工具版本已变化，请重新发送消息";
    case "PREVIOUS_RUN_FAILED":
      return "前一条消息没有成功完成，请重新发送消息";
    case "DELEGATION_INTERRUPTED":
      return "委派期间运行中断；可查看已保存的委派结果后重新发送消息";
    case "MERCHANT_CONTEXT_MISSING":
    case "MERCHANT_CONTEXT_INVALID":
      return "商家上下文不可用，请重新发送消息";
    case "TASK_CONTEXT_MISSING":
    case "TASK_CONTEXT_NOT_FOUND":
    case "TASK_CONTEXT_INVALID":
    case "TASK_CONTEXT_SOURCE_INVALID":
      return "本轮冻结的任务上下文不可用，请重新发送消息";
    case "TASK_CONTEXT_BUDGET_EXCEEDED":
      return "任务要求和待整理原话超过本轮模型容量，请缩小本次任务范围或调整模型上下文窗口";
    case "RUN_CONTEXT_ARTIFACT_INVALID":
      return "本轮已授权的附件不可用，请检查文件后重新发送消息";
    default:
      return "模型执行失败，请检查模型配置或稍后重试";
  }
}

/** 按会话管理主任务的注册、执行、取消、退出等待与持久收口。 */
export class AgentTaskManager {
  private readonly db: DbClient;
  private readonly files: FileStore;
  private readonly config: HostConfig;
  private readonly publish: PublishEvent;
  private readonly tasksByRunId = new Map<string, AgentTask>();
  private readonly tasksBySessionId = new Map<string, AgentTask>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly delegations: DelegationService | null;
  private readonly memorySearch: MemorySearchService;
  private timer: NodeJS.Timeout | null = null;
  private pollingTask: Promise<void> | null = null;
  private wakeRequested = false;
  private stopping = false;

  /** 绑定 Run 存储、文件、模型配置与事件推送入口。 */
  constructor(db: DbClient, files: FileStore, config: HostConfig, publish: PublishEvent) {
    this.db = db;
    this.files = files;
    this.config = config;
    this.publish = publish;
    this.memorySearch = new MemorySearchService(db, config.embedding);
    this.delegations = config.model ? new DelegationService(db, files, config.model, publish, this.memorySearch) : null;
  }

  /** 启动队列轮询并恢复可运行任务。 */
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.delegations?.start();
    this.timer = setInterval(() => void this.wake().catch((error: unknown) => this.logPollingError(error)), 1000);
    void this.wake().catch((error: unknown) => this.logPollingError(error));
  }

  /** 将用户回答交给持久化的专家任务。 */
  async answerDelegation(delegationId: string, answer: string): Promise<DelegationRecord> {
    if (!this.delegations) throw new Error("DELEGATION_NOT_AVAILABLE");
    return this.delegations.answer(delegationId, answer);
  }

  /** 将用户调整指令交给正在执行的专家任务。 */
  async steerDelegation(delegationId: string, instruction: string): Promise<void> {
    if (!this.delegations) throw new Error("DELEGATION_NOT_AVAILABLE");
    await this.delegations.steer(delegationId, instruction);
  }

  /** 终止指定专家任务并保留已提交记录。 */
  async cancelDelegation(delegationId: string): Promise<DelegationRecord> {
    if (!this.delegations) throw new Error("DELEGATION_NOT_AVAILABLE");
    const record = await this.db.getDelegation(delegationId);
    if (!record) throw new Error("DELEGATION_NOT_FOUND");
    // 用户终止专家步骤时一并取消父轮；已提交子结果保留，但父轮不能误显示正常完成。
    await this.cancel(record.parentRunId);
    return (await this.db.getDelegation(delegationId)) ?? record;
  }

  /** 停止当前服务并等待活动资源收尾。 */
  async stop(): Promise<void> {
    this.beginStop();
    await this.pollingTask?.catch((error: unknown) => this.logPollingError(error));
    for (const task of this.tasksByRunId.values()) this.abortTask(task);
    await this.delegations?.stop();
    await Promise.allSettled([...this.tasks]);
  }

  /** 在 HTTP 入口关闭前阻止领取新任务，区分 Host 退出与用户取消。 */
  beginStop(): void {
    this.stopping = true;
    this.delegations?.beginStop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const task of this.tasksByRunId.values()) this.abortTask(task);
  }

  /** 在 Host 开始退出后拒绝新消息，避免受理一个本次启动不会执行的任务。 */
  assertAccepting(): void {
    if (this.stopping) throw new Error("HOST_STOPPING");
  }

  /** 保存准备阶段的取消信号，并通知已经启动的 Pi 会话退出。 */
  private abortTask(task: AgentTask): void {
    if (task.phase === "FINISHED") return;
    task.phase = "STOPPING";
    task.controller.abort();
    void task.runtime.abort().catch((error: unknown) => {
      if (error instanceof Error && error.message === "PI_SESSION_NOT_STARTED") return;
      process.stderr.write(`[run ${task.run.runId}] 取消信号发送失败\n`);
    });
  }

  /** 持久化 Run 取消意图并通知活动 Pi 会话和子委派。 */
  async cancel(runId: string): Promise<{ run: RunRecord; changed: boolean }> {
    const result = await this.db.requestRunCancellation(runId);
    for (const event of result.events) this.publish(event);
    if (result.run.cancelRequestedAt) {
      const task = this.tasksByRunId.get(runId);
      if (task) this.abortTask(task);
      // HTTP 回执只表示取消意图已保存；退出等待由任务收尾负责，避免停止接口挂住。
      void this.delegations?.cancelForParentRun(runId).catch(() => {
        process.stderr.write(`[run ${runId}] 子任务取消传播失败\n`);
      });
    }
    return { run: result.run, changed: result.events.length > 0 };
  }

  /** 通知调度器立即检查队列中的 Run。 */
  wake(): Promise<void> {
    // 合并同时到来的唤醒，避免重复轮询和竞争领取。
    if (this.pollingTask) {
      this.wakeRequested = true;
      return this.pollingTask;
    }
    const model = this.config.model;
    if (this.stopping || !model) return Promise.resolve();
    const task = this.pollQueuedRuns(model);
    this.pollingTask = task;
    /** 清除当前轮询计时器，避免停止后重复调度。 */
    const clearPollingTask = () => {
      this.pollingTask = null;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        void this.wake().catch((error: unknown) => this.logPollingError(error));
      }
    };
    void task.then(clearPollingTask, clearPollingTask);
    return task;
  }

  /** 领取各会话待运行任务并维持同会话串行执行。 */
  private async pollQueuedRuns(model: ModelConfig): Promise<void> {
    // 同会话串行由数据库保证；不同会话和子任务不设全局并发上限。
    while (!this.stopping) {
      const run = await this.db.claimNextRun([...this.tasksBySessionId.keys()]);
      if (!run) break;
      const delegations = this.delegations;
      const runtime = new PiSdkRuntimeAdapter(model, `${this.files.root}/runtime/pi-agent`, this.db, this.files, {
        memorySearch: this.memorySearch,
        /** 主会话读取有界成果导航，原内部历史保留回读。 */
        mainHistory: () => this.db.readMainHistoryView(run.sessionId),
        executionBudget: {
          /** 模型和工具外发前预留同根额度。 */
          reserve: (kind, key) => this.db.reserveTaskExecution({ runId: run.runId, attempt: run.attempt }, kind, key),
          /** 按原调用键结算真实或未知用量。 */
          settle: (key, tokens) => this.db.settleTaskExecution({ runId: run.runId, attempt: run.attempt }, key, tokens),
        },
        imageModelId: this.config.image?.modelId ?? null,
        delegateTask: delegations
          ? (input, signal) => delegations.delegate(run.sessionId, run.runId, input, signal)
          : undefined,
      });
      const activation: AgentTask = { run, runtime, controller: new AbortController(), phase: "STARTING" };
      // 在任何异步上下文准备之前注册；准备中取消仍保留在 controller 中。
      this.tasksByRunId.set(run.runId, activation);
      this.tasksBySessionId.set(run.sessionId, activation);
      const task = this.execute(activation)
        .catch((error: unknown) => {
          process.stderr.write(
            `[run ${run.runId}] 持久化失败：${error instanceof Error ? error.message : String(error)}\n`,
          );
        })
        .finally(() => {
          // 收尾或提交异常时保留注册与 DB 占用，阻止尚未退出的执行树与新任务重叠。
          if (activation.phase === "FINISHED") {
            this.tasksByRunId.delete(run.runId);
            if (this.tasksBySessionId.get(run.sessionId) === activation) this.tasksBySessionId.delete(run.sessionId);
          }
          this.tasks.delete(task);
          void this.wake().catch((error: unknown) => this.logPollingError(error));
        });
      this.tasks.add(task);
    }
  }

  /** 记录调度轮询失败而不中断后续轮询。 */
  private logPollingError(error: unknown): void {
    process.stderr.write(`[scheduler] 领取 Run 失败：${error instanceof Error ? error.message : String(error)}\n`);
  }

  /** 领取冻结的 Run，执行 Pi 会话并保存结果或失败终态。 */
  private async execute(task: AgentTask): Promise<void> {
    const { run, runtime } = task;
    let answer: RuntimeReply | null = null;
    let sessionFile: string | null = null;
    let sessionFileHash: string | null = null;
    let failureCode: string | null = null;
    try {
      if (task.controller.signal.aborted) throw new Error("RUN_CANCELLED");
      const plan = await this.db.getRunPlan(run.runId);
      if (plan) {
        // 排队 Run 必须使用受理时冻结的配置；当前密钥只能发送给原定的服务地址。
        if (plan.runId !== run.runId || plan.session.sessionId !== run.sessionId)
          throw new Error("RUNTIME_PLAN_INVALID");
        // 不把当前 Provider 的密钥发送到旧 Plan 记录的其他服务地址。
        if (plan.model.baseUrl !== this.config.model?.baseUrl) throw new Error("MODEL_CONFIGURATION_CHANGED");
        const isLegacy =
          plan.schemaVersion === 1 &&
          plan.runtime.adapterVersion === LEGACY_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === LEGACY_TOOLSET_VERSION;
        const isPrevious =
          plan.runtime.adapterVersion === PREVIOUS_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PREVIOUS_TOOLSET_VERSION;
        const isOlder =
          plan.runtime.adapterVersion === OLDER_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === OLDER_TOOLSET_VERSION;
        const isPreExpert =
          plan.schemaVersion === 3 &&
          plan.runtime.adapterVersion === PRE_EXPERT_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_DELEGATION_TOOLSET_VERSION;
        const isPreDelegation =
          plan.schemaVersion === 4 &&
          plan.runtime.adapterVersion === PRE_DELEGATION_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_DELEGATION_TOOLSET_VERSION;
        const isPreAttachment =
          plan.runtime.adapterVersion === PRE_ATTACHMENT_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_EXPERT_METHOD_TOOLSET_VERSION;
        const isPreExpertMethod =
          plan.runtime.adapterVersion === PRE_EXPERT_METHOD_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_EXPERT_METHOD_TOOLSET_VERSION;
        const isPreUniversalExpert =
          plan.runtime.adapterVersion === PRE_UNIVERSAL_EXPERT_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_UNIVERSAL_EXPERT_TOOLSET_VERSION;
        const isPreCompaction =
          plan.runtime.adapterVersion === PRE_COMPACTION_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_MEMORY_TOOLSET_VERSION;
        const isPreMemory =
          plan.runtime.adapterVersion === PRE_MEMORY_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_MEMORY_TOOLSET_VERSION;
        const isPreImage =
          plan.runtime.adapterVersion === PRE_IMAGE_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === MEMORY_TOOLSET_VERSION;
        const isPreMicrocompact =
          plan.runtime.adapterVersion === PRE_MICROCOMPACT_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === MEMORY_TOOLSET_VERSION;
        // 旧 V11 Run 的允许工具列表已冻结，升级 V12 后仍按原列表恢复，不能额外获得商品目录。
        const isPreCatalog =
          plan.runtime.adapterVersion === PRE_RESEARCH_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === MEMORY_TOOLSET_VERSION;
        const isPreResearch =
          plan.runtime.adapterVersion === PRE_RESEARCH_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_RESEARCH_TOOLSET_VERSION;
        const isPreResearchSave =
          plan.runtime.adapterVersion === PRE_RESEARCH_SAVE_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_RESEARCH_SAVE_TOOLSET_VERSION;
        const isPrePublication =
          plan.runtime.adapterVersion === PRE_PUBLICATION_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_PUBLICATION_TOOLSET_VERSION;
        const isPreTaskContext =
          plan.runtime.adapterVersion === PRE_TASK_CONTEXT_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_PUBLICATION_TOOLSET_VERSION;
        const isPreTaskFocus =
          plan.runtime.adapterVersion === PRE_TASK_FOCUS_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_PUBLICATION_TOOLSET_VERSION;
        const isPreTaskStatus =
          plan.runtime.adapterVersion === PRE_TASK_STATUS_PI_ADAPTER_VERSION &&
          plan.runtime.toolsetVersion === PRE_EXPERT_CONTRACT_TOOLSET_VERSION;
        if (
          !isLegacy &&
          !isOlder &&
          !isPrevious &&
          !isPreExpert &&
          !isPreDelegation &&
          !isPreAttachment &&
          !isPreExpertMethod &&
          !isPreUniversalExpert &&
          !isPreCompaction &&
          !isPreMemory &&
          !isPreImage &&
          !isPreMicrocompact &&
          !isPreCatalog &&
          !isPreResearch &&
          !isPreResearchSave &&
          !isPrePublication &&
          !isPreTaskFocus &&
          !isPreTaskContext &&
          !isPreTaskStatus &&
          plan.runtime.adapterVersion !== PRE_PROMPT_SNAPSHOT_PI_ADAPTER_VERSION &&
          plan.runtime.adapterVersion !== PRE_TOOL_TIMEOUT_PI_ADAPTER_VERSION &&
          plan.runtime.adapterVersion !== PRE_TOOL_POLICY_PI_ADAPTER_VERSION &&
          plan.runtime.adapterVersion !== PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION &&
          plan.runtime.adapterVersion !== PRE_FEWSHOT_PI_ADAPTER_VERSION &&
          plan.runtime.adapterVersion !== PI_ADAPTER_VERSION
        )
          throw new Error("PI_ADAPTER_VERSION_CHANGED");
        if (
          !isLegacy &&
          !isOlder &&
          !isPrevious &&
          !isPreExpert &&
          !isPreDelegation &&
          !isPreAttachment &&
          !isPreExpertMethod &&
          !isPreUniversalExpert &&
          !isPreCompaction &&
          !isPreMemory &&
          !isPreImage &&
          !isPreMicrocompact &&
          !isPreCatalog &&
          !isPreResearch &&
          !isPreResearchSave &&
          !isPrePublication &&
          !isPreTaskFocus &&
          !isPreTaskContext &&
          !isPreTaskStatus &&
          plan.runtime.toolsetVersion !== TOOLSET_VERSION
        )
          throw new Error("TOOLSET_VERSION_CHANGED");
        const availableTools: readonly string[] =
          plan.session.scope === "NORMAL"
            ? plan.schemaVersion === 5 || plan.schemaVersion === 6
              ? [...SESSION_TOOL_IDS, "delegate_task"]
              : SESSION_TOOL_IDS
            : isLegacy || isOlder
              ? ALL_TOOL_IDS.filter((id) =>
                  [
                    "session_context",
                    "list_uploaded_files",
                    "read_uploaded_text",
                    "merchant_profile_get",
                    "merchant_links_list",
                  ].includes(id),
                )
              : isPrevious
                ? ALL_TOOL_IDS.filter(
                    (id) =>
                      ![
                        "public_page_collect",
                        "evidence_get",
                        "account_diagnosis_save",
                        "account_diagnosis_get",
                      ].includes(id),
                  )
                : ALL_TOOL_IDS.filter(
                    (id) =>
                      id !== "delegation_submit" && ([5, 6].includes(plan.schemaVersion) || id !== "delegate_task"),
                  );
        if (
          plan.policy.allowedToolIds.some(
            (id) =>
              !availableTools.includes(id) ||
              (id === "read_expert_method" && plan.runtime.toolsetVersion < PRE_UNIVERSAL_EXPERT_TOOLSET_VERSION) ||
              (id.startsWith("merchant_memory_") && plan.runtime.toolsetVersion < MEMORY_TOOLSET_VERSION) ||
              (id === "merchant_catalog_get" && plan.runtime.toolsetVersion < PRE_RESEARCH_TOOLSET_VERSION) ||
              (["xhs_public_search", "merchant_source_collect"].includes(id) &&
                plan.runtime.toolsetVersion < PRE_RESEARCH_SAVE_TOOLSET_VERSION) ||
              (["merchant_research_save", "merchant_research_get"].includes(id) &&
                plan.runtime.toolsetVersion < PRE_PUBLICATION_TOOLSET_VERSION) ||
              (id === "publication_task" && plan.runtime.toolsetVersion < PRE_EXPERT_CONTRACT_TOOLSET_VERSION),
          )
        )
          throw new Error("TOOLSET_VERSION_CHANGED");
        // 同会话后一轮的历史依赖前一轮成功；失败时不使用不完整的 Pi 快照。
        if (plan.session.pendingPredecessorRunId) {
          const predecessor = await this.db.getRun(plan.session.pendingPredecessorRunId);
          if (predecessor?.status !== "SUCCEEDED") throw new Error("PREVIOUS_RUN_FAILED");
        }
      } else {
        // 历史 Run 仅在当前模型和工具版本仍匹配时沿用旧格式。
        if (run.modelAlias !== this.config.model?.modelId) throw new Error("MODEL_CONFIGURATION_CHANGED");
        if (
          run.adapterVersion &&
          ![
            PI_ADAPTER_VERSION,
            PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION,
            PRE_TOOL_TIMEOUT_PI_ADAPTER_VERSION,
            PRE_TOOL_POLICY_PI_ADAPTER_VERSION,
            PRE_FEWSHOT_PI_ADAPTER_VERSION,
            PRE_PROMPT_SNAPSHOT_PI_ADAPTER_VERSION,
            PRE_TASK_STATUS_PI_ADAPTER_VERSION,
            PRE_TASK_CONTEXT_PI_ADAPTER_VERSION,
            PRE_PUBLICATION_PI_ADAPTER_VERSION,
            PRE_TASK_FOCUS_PI_ADAPTER_VERSION,
            PRE_MICROCOMPACT_PI_ADAPTER_VERSION,
            PRE_IMAGE_PI_ADAPTER_VERSION,
            PRE_ATTACHMENT_PI_ADAPTER_VERSION,
            PRE_EXPERT_METHOD_PI_ADAPTER_VERSION,
            PRE_UNIVERSAL_EXPERT_PI_ADAPTER_VERSION,
            PRE_DELEGATION_PI_ADAPTER_VERSION,
            PRE_EXPERT_PI_ADAPTER_VERSION,
            PREVIOUS_PI_ADAPTER_VERSION,
            OLDER_PI_ADAPTER_VERSION,
            LEGACY_PI_ADAPTER_VERSION,
          ].includes(run.adapterVersion)
        )
          throw new Error("PI_ADAPTER_VERSION_CHANGED");
        if (
          run.modelFingerprint &&
          this.config.model &&
          run.modelFingerprint !== modelPlanFingerprint(this.config.model)
        )
          throw new Error("MODEL_CONFIGURATION_CHANGED");
      }
      const prompt = await this.db.getRunPrompt(run.runId);
      const session = await this.db.getSession(run.sessionId);
      if (!prompt || !session) throw new Error("RUN_INPUT_MISSING");
      if (plan && (plan.session.scope !== session.scope || plan.session.ownerId !== session.ownerId))
        throw new Error("RUNTIME_PLAN_INVALID");
      const workspace = await this.files.prepareWorkspace(run.sessionId);
      const context = await assembleRunContext(this.db, this.files, run, session, plan, prompt, workspace);
      if (task.controller.signal.aborted) throw new Error("RUN_CANCELLED");
      await runtime.start(context, async (snapshot) => {
        await this.db.recordRunSnapshot(run.runId, run.attempt, snapshot);
        this.publish(
          await this.db.appendEvent(
            run.sessionId,
            run.runId,
            "session.snapshot.prepared",
            {
              sourceVerification: snapshot.sourceVerification,
              fileExists: snapshot.fileExists,
            },
            run.attempt,
          ),
        );
      });
      if (this.stopping) throw new Error("RUN_INTERRUPTED");
      if (task.controller.signal.aborted || (await this.db.getRun(run.runId))?.cancelRequestedAt)
        throw new Error("RUN_CANCELLED");
      task.phase = "RUNNING";
      this.publish(
        await this.db.appendEvent(
          run.sessionId,
          run.runId,
          "session.context.resolved",
          context.sourceSummary,
          run.attempt,
        ),
      );
      this.publish(
        await this.db.appendEvent(
          run.sessionId,
          run.runId,
          "session.execution.started",
          { runId: run.runId },
          run.attempt,
        ),
      );
      if (plan?.schemaVersion === 6 && plan.publicationExpert) {
        answer = await this.executePublicationExpert(task, context);
      } else {
        answer = await runtime.prompt(context.userPrompt, async (event) =>
          this.publish(await this.persistRuntimeEvent(run, event)),
        );
        answer = await this.repairPublicationOutput(task, context, answer);
      }
      if (this.stopping) throw new Error("RUN_INTERRUPTED");
      const state = await runtime.getState();
      if (!state.fileExists || !state.sessionFile) throw new Error("PI_SESSION_SNAPSHOT_MISSING");
      sessionFile = state.sessionFile;
    } catch (error) {
      failureCode = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PI_RUNTIME_FAILED";
    } finally {
      task.phase = "SETTLING";
      // 先等执行树真正退出再提交终态；无法退出时保留数据库与内存的会话占用。
      if (failureCode || task.controller.signal.aborted || this.stopping)
        await this.delegations?.cancelForParentRun(run.runId, this.stopping);
      await this.delegations?.waitForParentRun(run.runId);
      try {
        // prompt 与委派退出后再读实际文件；失败副本也登记，但永不推进成功锚点。
        const snapshot = await runtime.getState();
        if (snapshot.sessionFile) {
          await this.db.recordRunSnapshot(run.runId, run.attempt, snapshot);
          sessionFileHash = snapshot.sessionFileHash;
          if (!snapshot.fileExists) failureCode ??= "PI_SESSION_SNAPSHOT_MISSING";
        }
      } catch (error) {
        failureCode ??= error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PI_RUNTIME_FAILED";
      } finally {
        await runtime.stop();
      }
    }
    // Host 正常退出保留 RUNNING，下一次启动按副作用与成功快照判断恢复方式。
    if (this.stopping) {
      task.phase = "FINISHED";
      return;
    }
    if (failureCode) {
      const job = (await this.db.listTextGenerationJobs(run.sessionId)).find((item) => item.sourceRunId === run.runId);
      if (job && (await this.db.getTaskExecutionControl(run.sessionId, job.jobId))?.state === "PAUSED")
        failureCode = "TASK_BUDGET_EXHAUSTED";
    }
    let events: RuntimeEvent[];
    try {
      events = await this.db.finishRun(
        run.runId,
        failureCode ? "FAILED" : "SUCCEEDED",
        failureCode ? null : (answer?.text ?? null),
        failureCode,
        failureCode ? runFailureMessage(failureCode) : null,
        failureCode ? null : sessionFile,
        answer?.usage ?? null,
        run.attempt,
        sessionFileHash,
      );
    } catch (error) {
      if (!(error instanceof Error) || !["PI_SESSION_HASH_MISMATCH", "PI_SESSION_FILE_MISSING"].includes(error.message))
        throw error;
      // 提交校验失败的事务已回滚；明确失败，避免留下可被自动重试的成功候选。
      failureCode = error.message;
      events = await this.db.finishRun(
        run.runId,
        "FAILED",
        null,
        failureCode,
        runFailureMessage(failureCode),
        null,
        answer?.usage ?? null,
        run.attempt,
      );
    }
    task.phase = "FINISHED";
    for (const event of events) this.publish(event);
    if (failureCode) process.stderr.write(`[run ${run.runId}] ${failureCode}\n`);
  }

  /** 正式步骤由 Host 固定委派，沿原父 Run 提交专家结果并保留完整子生命周期。 */
  private async executePublicationExpert(task: AgentTask, context: ResolvedRunContext): Promise<RuntimeReply> {
    const plan = context.plan;
    if (plan?.schemaVersion !== 6 || !plan.publicationExpert || !this.delegations)
      throw new Error("PUBLICATION_EXPERT_REQUIRED");
    const job = (await this.db.listTextGenerationJobs(task.run.sessionId)).find(
      (item) => item.jobId === plan.publicationExpert?.jobId,
    );
    validatePublicationExpertJob(plan.publicationExpert, job ?? null);
    const refs: AgentMaterialRef[] = [];
    if (job?.source?.researchContinuation && plan.publicationExpert.purpose !== "RESEARCH") {
      const research = await this.db.getDelegation(job.source.researchContinuation.delegationId);
      const result = research?.result;
      if (
        !result ||
        !("version" in result) ||
        result.version !== 3 ||
        result.resultHash !== job.source.researchContinuation.resultHash
      )
        throw new Error("RESEARCH_SOURCE_INVALID");
      refs.push(...result.submission.materialRefs.filter((ref) => ref.kind === "public_evidence"));
    }
    for (const allowed of plan.policy.allowedArtifacts) {
      const artifact = await this.db.getArtifact(allowed.artifactId);
      if (artifact?.mimeType === "text/plain")
        refs.push({ kind: "uploaded_text", id: artifact.artifactId, revision: null, sha256: allowed.blobHash });
    }
    const record = await this.delegations.delegate(
      task.run.sessionId,
      task.run.runId,
      publicationExpertTask(plan, refs),
      task.controller.signal,
    );
    if ("kind" in record) throw new Error("PUBLICATION_EXPERT_REQUIRED");
    if (this.stopping) throw new Error("RUN_INTERRUPTED");
    if (task.controller.signal.aborted) throw new Error("RUN_CANCELLED");
    const text = publicationExpertResult(plan.publicationExpert, record);
    return task.runtime.recordExpertResult(context.userPrompt, text, record.delegationId, async (event) =>
      this.publish(await this.persistRuntimeEvent(task.run, event)),
    );
  }

  /** 每个Attempt有限纠正尚未提交的图文规划/审核结构，不重试图片或放宽来源校验。 */
  private async repairPublicationOutput(
    task: AgentTask,
    context: ResolvedRunContext,
    answer: RuntimeReply,
  ): Promise<RuntimeReply> {
    const job = (await this.db.listTextGenerationJobs(task.run.sessionId)).find(
      (item) => item.sourceRunId === task.run.runId,
    );
    if (!job) return answer;
    if (job.purpose === "PUBLICATION_SUMMARY") {
      try {
        parseAsyncResultSummary(answer.text);
        return answer;
      } catch {
        const corrected = await task.runtime.prompt(
          `上一份汇总未交付，只修正JSON格式：${JSON.stringify(asyncResultSummarySchema)}。保持原冻结结果与未解决事项，不调用工具、不重做任务。`,
          async (event) => this.publish(await this.persistRuntimeEvent(task.run, event)),
        );
        parseAsyncResultSummary(corrected.text);
        return this.accumulateReplyUsage(answer, corrected);
      }
    }
    if (!["PUBLICATION_CHAT", "PUBLICATION_REVIEW"].includes(job.purpose)) return answer;
    const isConversation = job.purpose === "PUBLICATION_CHAT";
    for (let correction = 0; correction <= 2; correction += 1) {
      try {
        if (isConversation) {
          const decision = parsePublicationConversation(
            answer.text,
            Boolean(context.taskContext),
            job.source?.conversation?.intentProtocol === 1,
          );
          if (context.taskContext && decision.contextDelta)
            applyTaskContextDelta(context.taskContext, decision.contextDelta);
        } else parsePublicationReview(answer.text, job.source?.review);
        return answer;
      } catch (error) {
        const code = error instanceof Error ? error.message : "PUBLICATION_CONVERSATION_INVALID";
        if (
          correction === 2 ||
          ![
            "PUBLICATION_CONVERSATION_INVALID",
            "PUBLICATION_REVIEW_INVALID",
            "REVIEW_REQUIREMENT_COVERAGE_INVALID",
            "REVIEW_PREVIOUS_ISSUES_INVALID",
            "TASK_CONTEXT_DELTA_INVALID",
            "TASK_CONTEXT_SOURCE_INVALID",
            "TASK_CONTEXT_REVISION_CONFLICT",
          ].includes(code)
        )
          throw error;
        if (this.stopping || task.controller.signal.aborted) throw new Error("RUN_CANCELLED");
        process.stderr.write(`[publication ${task.run.runId}] 路由校验${code}，纠正${correction + 1}/2\n`);
        const next = await task.runtime.prompt(
          [
            `上一份计划未执行，Host校验失败：${code}。只修正并重发完整JSON，不调用工具、不修改稿件、不生成图片。`,
            `严格使用Schema：${JSON.stringify(isConversation ? publicationConversationOutputSchema : job.source?.review?.formatVersion === 3 ? publicationReviewV3Schema : job.source?.review?.binding ? publicationReviewV2Schema : publicationReviewSchema)}`,
            isConversation
              ? "必须声明intent：针对审核意见返修选REVIEW_REPAIR，只用REPAIR（必要时接FINISH），不手工UPDATE_PUBLICATION再REVIEW，不整篇覆盖。普通编辑/纯审核选STANDARD。contextDelta.kind仅可GOAL、CONSTRAINT、OPEN_QUESTION，不能FACT。quote逐字复制pendingSources中相应source.text的连续原文；不能取自主Agent摘要。撤回或替换旧要求用正确targetId。不得通过删除用户要求或伪造已确认来绕过校验。"
              : "只纠正审核JSON结构和要求覆盖，逐项核验所有有效要求，引用真实证据，删除Schema外的额外字段；保留原已识别问题及严重程度，不降低审核结论，不宣称读取未提供的像素。不要输出contextDelta或actions。",
            isConversation
              ? `本轮冻结上下文：${JSON.stringify(context.taskContext)}。有此上下文时contextDelta必须填写，baseRevision用其revision，processedSourceIds完整列出pendingSources的id。原任务和已验证动作意图保持不变。`
              : `本次真实审核覆盖：${JSON.stringify(job.source?.review)}。仍遵守最初冻结的审核资料与图像覆盖，不能借格式修复绕过覆盖限制。`,
          ].join("\n\n"),
          async (event) => this.publish(await this.persistRuntimeEvent(task.run, event)),
        );
        answer = this.accumulateReplyUsage(answer, next);
      }
    }
    return answer;
  }

  /** 有界纠正同样消耗模型，累计原Run用量而非只保留最后一次回答。 */
  private accumulateReplyUsage(previous: RuntimeReply, next: RuntimeReply): RuntimeReply {
    if (!previous.usage || !next.usage) return { text: next.text, usage: previous.usage ?? next.usage };
    const usage = { ...previous.usage };
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const)
      usage[key] += next.usage[key];
    if (usage.reasoningTokens !== undefined || next.usage.reasoningTokens !== undefined)
      usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (next.usage.reasoningTokens ?? 0);
    return { text: next.text, usage };
  }

  /** 先持久化 Pi 事件再推送，确保断线后可以补拉。 */
  private async persistRuntimeEvent(run: RunRecord, event: PiRuntimeEvent): Promise<RuntimeEvent> {
    if (event.type === "task.status.observed")
      return this.db.appendEvent(run.sessionId, run.runId, "session.task.status.observed", { ...event }, run.attempt);
    if (event.type === "context.measured" || event.type === "context.compressed")
      return this.db.appendEvent(
        run.sessionId,
        run.runId,
        event.type === "context.measured" ? "session.context.measured" : "session.context.compressed",
        { ...event.measurement },
        run.attempt,
      );
    if (event.type === "microcompact.completed")
      return this.db.appendEvent(
        run.sessionId,
        run.runId,
        "session.microcompact.completed",
        { ...event.record },
        run.attempt,
      );
    if (event.type === "compaction.started" || event.type === "compaction.finished")
      return this.db.recordCompactionEvent(run.runId, event, run.attempt);
    if (event.type === "text.delta") {
      return this.db.appendEvent(run.sessionId, run.runId, "session.message.delta", { text: event.text }, run.attempt);
    }
    if (event.type === "thinking.delta") {
      return this.db.appendEvent(run.sessionId, run.runId, "session.thinking.delta", { text: event.text }, run.attempt);
    }
    if (event.type === "tool.timeout")
      return this.db.appendEvent(
        run.sessionId,
        run.runId,
        "session.tool.timeout",
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          errorCode: "TOOL_TIMEOUT",
        },
        run.attempt,
      );
    if (event.type === "tool.started") {
      return this.db.appendEvent(
        run.sessionId,
        run.runId,
        "session.tool.started",
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.skill && {
            skillName: event.skill.name,
            skillPath: event.skill.path,
            skillSha256: event.skill.sha256,
          }),
        },
        run.attempt,
      );
    }
    return this.db.appendEvent(
      run.sessionId,
      run.runId,
      "session.tool.completed",
      {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        ...(event.execution && { execution: event.execution }),
        ...(event.skill && {
          skillName: event.skill.name,
          skillPath: event.skill.path,
          skillSha256: event.skill.sha256,
        }),
      },
      run.attempt,
    );
  }
}

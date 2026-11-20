import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { AssistantMessage, CredentialStore, ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ContextEvent,
  compact,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  estimateTokens,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { ContextTokenMeasurement, MicrocompactRecord, ModelUsageSummary } from "../../../../shared/contracts.js";
import type { CurrentTaskStatus } from "../../../../shared/task-context.js";
import type { TaskBudgetKind } from "../../../../shared/task-execution.js";
import type { ToolExecutionPolicy } from "../../../../shared/tool-execution.js";
import type { ModelConfig } from "../../../config.js";
import { FileStore } from "../../../infrastructure/files/files.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";
import type { SkillAssetSnapshot } from "../../../modules/capabilities/infrastructure/skill-assets.js";
import { prepareImageInput } from "../../../modules/media/infrastructure/image-input.js";
import type { MemorySearchService } from "../../../modules/merchants/application/memory-search-service.js";
import { projectMemoryHistory } from "../../../modules/merchants/domain/memory-scope.js";
import type { PublicationToolStore } from "../../../modules/publication/interfaces/publication-tool.js";
import { assembleSystemPrompt, createPromptSnapshot } from "../../context/prompt-assembly.js";
import {
  assertTaskContextBudget,
  type TaskContextTokenBudget,
  taskContextCarriers,
  taskContextCompactionInstructions,
  taskContextTokenBudget,
} from "../../context/task-context-projection.js";
import { buildContinuationContext, buildTaskFocusContext } from "../../context/task-focus.js";
import type { ResearchMemoryController } from "../../delegation/research-memory.js";
import { RuntimeDeadline } from "../../execution/runtime-deadline.js";
import {
  compareContextTokens,
  estimateContextTokens,
  logContextTokens,
  measureContextTokens,
  reportedContextInput,
} from "../../history/context-token-meter.js";
import { type MainHistoryView, projectMainHistory } from "../../history/main-history.js";
import { MICROCOMPACT_AUDIT_TYPE, type MicrocompactSource, planMicrocompact } from "../../history/microcompact.js";
import type {
  PiRuntimeEvent,
  PiRuntimePort,
  RuntimeReply,
  RuntimeStartInput,
  RuntimeStateSnapshot,
  SkillRead,
} from "../../ports/pi-runtime-port.js";
import {
  assertToolExecutionPolicies,
  type HostToolDefinition,
  snapshotToolExecutionPolicies,
} from "../../tools/host-tool.js";
import { executeCollectionTool, isCollectionTool } from "../../tools/legacy-collection-execution.js";
import {
  createSessionTools,
  type DelegateTaskHandler,
  PRE_EXPERT_CONTRACT_TOOLSET_VERSION,
  PRE_EXPERT_METHOD_TOOLSET_VERSION,
  PRE_MEMORY_TOOLSET_VERSION,
  PRE_PUBLICATION_TOOLSET_VERSION,
  PRE_RESEARCH_SAVE_TOOLSET_VERSION,
  PRE_RESEARCH_TOOLSET_VERSION,
  PRE_UNIVERSAL_EXPERT_TOOLSET_VERSION,
  TOOLSET_VERSION,
} from "../../tools/tool-catalog.js";
import { executeTool, toolExecutionSummary } from "../../tools/tool-execution.js";
import { blocksToolReplay } from "../../tools/tool-replay-policy.js";

export const PRE_COMPACTION_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_MEMORY_TOOLSET_VERSION}:experts-4:attachments-1`;
export const PRE_MEMORY_PI_ADAPTER_VERSION = `${PRE_COMPACTION_PI_ADAPTER_VERSION}:compact-1`;
export const PRE_IMAGE_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_RESEARCH_TOOLSET_VERSION}:experts-4:attachments-1:compact-1`;
export const PRE_MICROCOMPACT_PI_ADAPTER_VERSION = `${PRE_IMAGE_PI_ADAPTER_VERSION}:images-1`;
export const PRE_RESEARCH_PI_ADAPTER_VERSION = `${PRE_IMAGE_PI_ADAPTER_VERSION}:microcompact-1:images-1`;
export const PRE_RESEARCH_SAVE_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_RESEARCH_SAVE_TOOLSET_VERSION}:experts-4:attachments-1:compact-1:microcompact-1:images-1`;
export const PRE_TASK_FOCUS_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_PUBLICATION_TOOLSET_VERSION}:experts-4:attachments-1:compact-1:microcompact-1:images-1`;
export const PRE_TASK_CONTEXT_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_PUBLICATION_TOOLSET_VERSION}:experts-4:attachments-1:compact-1:microcompact-1:task-focus-1:images-1`;
export const PRE_PUBLICATION_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_PUBLICATION_TOOLSET_VERSION}:experts-4:attachments-1:compact-1:microcompact-1:task-focus-1:task-context-1:images-1`;
export const PRE_TASK_STATUS_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_EXPERT_CONTRACT_TOOLSET_VERSION}:experts-4:attachments-1:compact-1:microcompact-1:task-focus-1:task-context-1:images-1`;
export const PRE_PROMPT_SNAPSHOT_PI_ADAPTER_VERSION = `${VERSION}:tools-${TOOLSET_VERSION}:experts-4:attachments-1:compact-1:microcompact-1:task-focus-1:task-context-1:task-status-1:images-1`;
export const PRE_TOOL_TIMEOUT_PI_ADAPTER_VERSION = PRE_PROMPT_SNAPSHOT_PI_ADAPTER_VERSION.replace(
  ":images-1",
  ":prompt-assembly-1:images-1",
);
export const PRE_TOOL_POLICY_PI_ADAPTER_VERSION = PRE_TOOL_TIMEOUT_PI_ADAPTER_VERSION.replace(
  ":images-1",
  ":tool-timeout-1:images-1",
);
export const PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION = PRE_TOOL_POLICY_PI_ADAPTER_VERSION.replace(
  ":images-1",
  ":tool-policy-1:images-1",
);
export const PRE_FEWSHOT_PI_ADAPTER_VERSION = `${PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION}:research-agent-1`;
export const PI_ADAPTER_VERSION = `${PRE_FEWSHOT_PI_ADAPTER_VERSION}:fewshot-1`;
export const HOST_COMPACTION_TEMPLATE_VERSION = "host-business-v1";
const TASK_STATUS_RESERVE_TOKENS = 4096;
const HOST_COMPACTION_INSTRUCTIONS =
  "保留用户明确目标和约束；商家人工确认事实须标明来源 ID 与版本，模型推断须单独标为推断；保留授权附件、证据及专家结果的 ID、哈希和未满足条件；保留待回答问题与当前未完成步骤。记忆必须保留商家或商品归属、商品 ID、依据版本和审核状态，不能把某商品约束改写为商家通用规则；历史对话或摘要不代表当前记忆授权，使用前须按本轮工具核对。旧授权不能写成当前授权，来源不明时明确标未知。不要包含凭证。";
export const PRE_UNIVERSAL_EXPERT_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_UNIVERSAL_EXPERT_TOOLSET_VERSION}:experts-3:attachments-1`;
export const PRE_EXPERT_METHOD_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_EXPERT_METHOD_TOOLSET_VERSION}:experts-2:attachments-1`;
export const PRE_ATTACHMENT_PI_ADAPTER_VERSION = `${VERSION}:tools-${PRE_EXPERT_METHOD_TOOLSET_VERSION}:experts-2`;
export const PRE_DELEGATION_PI_ADAPTER_VERSION = `${VERSION}:tools-5:experts-1`;
export const PRE_EXPERT_PI_ADAPTER_VERSION = `${VERSION}:tools-5`;
export const PREVIOUS_PI_ADAPTER_VERSION = `${VERSION}:tools-4`;
export const OLDER_PI_ADAPTER_VERSION = `${VERSION}:tools-3`;
export const LEGACY_PI_ADAPTER_VERSION = `${VERSION}:tools-2`;

// 模型凭证由 Host 显式注入，Pi 不再从用户目录读取其他账号。
const emptyCredentials: CredentialStore = {
  /** Pi 不从外部凭证仓库读取模型密钥，由 Host 显式注入。 */
  read: async () => undefined,
  /** 不向 Pi 暴露本机已有的 Provider 凭证列表。 */
  list: async () => [],
  /** 接受本轮内存更新结果，但不持久化 Pi 提供的凭证。 */
  modify: async (_providerId, update) => update(undefined),
  /** 忽略 Pi 的凭证删除请求，不触碰 Host 保存的密钥。 */
  delete: async () => {},
};

/** 累加模型实际报告的用量并标记数据来源。 */
function addReportedUsage(summary: ModelUsageSummary, reported: Usage): boolean {
  const tokens = reported.input + reported.output + reported.cacheRead + reported.cacheWrite;
  if (tokens === 0 && reported.totalTokens === 0) return false;
  summary.inputTokens += reported.input;
  summary.outputTokens += reported.output;
  summary.cacheReadTokens += reported.cacheRead;
  summary.cacheWriteTokens += reported.cacheWrite;
  summary.totalTokens += reported.totalTokens || tokens;
  if (reported.reasoning !== undefined) summary.reasoningTokens = (summary.reasoningTokens ?? 0) + reported.reasoning;
  return true;
}

/** 将 Pi 会话封装为单个 Run 的文本模型执行器。 */
export class PiSdkRuntimeAdapter implements PiRuntimePort {
  private budgetSequence = 0;
  private modelBudgetKey: string | null = null;
  private budgetPending = Promise.resolve();
  private readonly executionBudget?: {
    reserve: (kind: TaskBudgetKind, key: string) => Promise<boolean>;
    settle: (key: string, tokens: number | null) => Promise<void>;
  };
  private readonly mainHistory?: () => Promise<MainHistoryView>;
  private taskStatusFailure: Error | null = null;
  private observedTaskStatus: CurrentTaskStatus | null = null;
  private session: AgentSession | null = null;
  private abortRequested = false;
  private unsafeToolStarted = false;
  private toolStartPersisted: (() => Promise<void>) | null = null;
  private workingSessionFile: string | null = null;
  private sourceSnapshotHash: string | null = null;
  private sourceVerification: RuntimeStateSnapshot["sourceVerification"] = "EMPTY";
  private sessionDir: string | null = null;
  private modelConfig: ModelConfig;
  private readonly agentDir: string;
  private readonly sessionStore: PublicationToolStore &
    Pick<
      DbClient,
      | "getSession"
      | "listArtifacts"
      | "getArtifact"
      | "createPublicEvidence"
      | "getPublicEvidence"
      | "getPublicEvidenceForRun"
      | "listAccountDiagnoses"
      | "listSessionAccountDiagnoses"
      | "getAccountDiagnosis"
      | "saveAccountDiagnosis"
      | "saveResearchBatch"
    >;
  private readonly files: Pick<FileStore, "readBlob" | "putBlob" | "root">;
  private skills: readonly SkillAssetSnapshot[] = [];
  private promptImages: ImageContent[] = [];
  private startInput: RuntimeStartInput | null = null;
  private reserveTokens = 0;
  private taskContextBudget: TaskContextTokenBudget | null = null;
  private microcompactFailure = false;
  private readonly emittedMicrocompactIds = new Set<string>();
  private contextEvents: ((event: PiRuntimeEvent) => void) | null = null;
  private requestIndex = 0;
  private pendingPromptTokens = 0;
  private lastProviderInput: number | null = null;
  private readonly imageModelId: string | null;
  private readonly toolSessionId: string | null;
  private readonly toolRunId: string | null;
  private readonly toolUserPrompt: string | null;
  private readonly extraTools: HostToolDefinition[];
  private readonly delegateTask: DelegateTaskHandler | undefined;
  private readonly allowedEvidenceIds: readonly string[] | null;
  private readonly disableDeepSeekThinking: boolean;
  private readonly researchMemory: ResearchMemoryController | undefined;
  private readonly memorySearch: MemorySearchService | undefined;

  /** 配置 Pi SDK 适配器使用的模型、目录和工具工厂。 */
  constructor(
    modelConfig: ModelConfig,
    agentDir: string,
    sessionStore: PublicationToolStore &
      Pick<
        DbClient,
        | "getSession"
        | "listArtifacts"
        | "getArtifact"
        | "createPublicEvidence"
        | "getPublicEvidence"
        | "getPublicEvidenceForRun"
        | "listAccountDiagnoses"
        | "listSessionAccountDiagnoses"
        | "getAccountDiagnosis"
        | "saveAccountDiagnosis"
        | "saveResearchBatch"
      >,
    files: Pick<FileStore, "readBlob" | "putBlob" | "root">,
    options: {
      executionBudget?: PiSdkRuntimeAdapter["executionBudget"];
      mainHistory?: () => Promise<MainHistoryView>;
      imageModelId?: string | null;
      toolSessionId?: string;
      toolRunId?: string;
      toolUserPrompt?: string;
      extraTools?: HostToolDefinition[];
      delegateTask?: DelegateTaskHandler;
      allowedEvidenceIds?: readonly string[];
      disableDeepSeekThinking?: boolean;
      researchMemory?: ResearchMemoryController;
      memorySearch?: MemorySearchService;
    } = {},
  ) {
    this.executionBudget = options.executionBudget;
    this.mainHistory = options.mainHistory;
    this.modelConfig = modelConfig;
    this.agentDir = agentDir;
    this.sessionStore = sessionStore;
    this.files = files;
    this.imageModelId = options.imageModelId ?? null;
    this.toolSessionId = options.toolSessionId ?? null;
    this.toolRunId = options.toolRunId ?? null;
    this.toolUserPrompt = options.toolUserPrompt ?? null;
    this.extraTools = options.extraTools ?? [];
    this.delegateTask = options.delegateTask;
    this.allowedEvidenceIds = options.allowedEvidenceIds ?? null;
    this.disableDeepSeekThinking = options.disableDeepSeekThinking === true;
    this.researchMemory = options.researchMemory;
    this.memorySearch = options.memorySearch;
  }

  /** 按冻结 Plan 初始化 Pi 会话、权限工具和历史快照。 */
  async start(
    input: RuntimeStartInput,
    onSnapshotPrepared?: (snapshot: RuntimeStateSnapshot) => Promise<void>,
  ): Promise<void> {
    this.budgetSequence = 0;
    this.modelBudgetKey = null;
    this.budgetPending = Promise.resolve();
    this.abortRequested = false;
    this.unsafeToolStarted = false;
    this.workingSessionFile = null;
    this.sourceSnapshotHash = null;
    this.sourceVerification = "EMPTY";
    this.startInput = input;
    this.microcompactFailure = false;
    this.emittedMicrocompactIds.clear();
    this.requestIndex = 0;
    this.pendingPromptTokens = 0;
    this.lastProviderInput = null;
    const hasMerchantPlan =
      input.plan?.schemaVersion === 2 ||
      ((input.plan?.schemaVersion === 3 ||
        input.plan?.schemaVersion === 4 ||
        input.plan?.schemaVersion === 5 ||
        input.plan?.schemaVersion === 6) &&
        Boolean(input.plan.merchant));
    if (hasMerchantPlan && !input.merchantContext) throw new Error("MERCHANT_CONTEXT_MISSING");
    if (!hasMerchantPlan && input.merchantContext) throw new Error("MERCHANT_CONTEXT_INVALID");
    if (input.plan) {
      const { providerId: _providerId, configFingerprint: _fingerprint, ...model } = input.plan.model;
      this.modelConfig = { ...model, apiKey: this.modelConfig.apiKey };
    }
    this.promptImages = [];
    if (this.modelConfig.imageInput && input.plan?.runtime.adapterVersion.split(":").includes("images-1")) {
      const selected = input.allowedArtifacts ?? [];
      for (const allowed of selected) {
        const artifact = await this.sessionStore.getArtifact(allowed.artifactId);
        if (
          !artifact ||
          artifact.sessionId !== (this.toolSessionId ?? input.sessionId) ||
          !["upload", "generated_image"].includes(artifact.kind ?? "") ||
          artifact.status !== "READY" ||
          artifact.blobHash !== allowed.blobHash
        )
          throw new Error("RUN_CONTEXT_INVALID");
        if (!["image/png", "image/jpeg", "image/webp"].includes(artifact.mimeType)) continue;
        if (this.promptImages.length >= 5) throw new Error("IMAGE_INPUT_LIMIT");
        const prepared = await prepareImageInput(await this.files.readBlob(artifact.blobHash), artifact.mimeType);
        this.promptImages.push({ type: "image", data: prepared.bytes.toString("base64"), mimeType: prepared.mimeType });
      }
    }
    await mkdir(input.workspace, { recursive: true, mode: 0o700 });
    await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    const sessionDir = join(this.agentDir, "sessions", input.sessionId);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    // 在副本上运行；成功后才把新快照注册到数据库，失败时保留旧上下文。
    this.sessionDir = sessionDir;
    const sessionFile = input.historySnapshotRef
      ? await this.copySessionFile(
          await this.managedSessionFile(input.historySnapshotRef, sessionDir),
          sessionDir,
          input.historySnapshotHash,
        )
      : null;
    // 先登记副本再让 SDK 读取；新会话首个助手条目前可能尚无文件。
    this.workingSessionFile = sessionFile;
    if (sessionFile) await onSnapshotPrepared?.(await this.getState());
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, sessionDir, input.workspace)
      : SessionManager.create(input.workspace, sessionDir);
    this.workingSessionFile = sessionManager.getSessionFile() ?? null;
    if (!sessionFile) await onSnapshotPrepared?.(await this.getState());

    // 扩展和用户目录资源仍关闭；工具仅从 Host 的目录显式登记。
    // 把压缩阈值和近期原文预算固定为当前模型窗口的比例，避免依赖 Pi 默认值漂移。
    this.reserveTokens = Math.max(this.modelConfig.maxTokens + 512, Math.floor(this.modelConfig.contextWindow / 6));
    const baseKeepRecentTokens = Math.max(512, Math.floor(this.modelConfig.contextWindow / 4));
    const summaryInstructions = input.taskContext
      ? taskContextCompactionInstructions(HOST_COMPACTION_INSTRUCTIONS, input.taskContext)
      : HOST_COMPACTION_INSTRUCTIONS;
    this.taskContextBudget = input.taskContextBrief
      ? taskContextTokenBudget({
          brief: input.taskContextBrief,
          summaryInstructions,
          contextWindow: this.modelConfig.contextWindow,
          maxTokens: this.modelConfig.maxTokens,
          baseReserveTokens: this.reserveTokens + (input.currentTaskStatus ? TASK_STATUS_RESERVE_TOKENS : 0),
          baseKeepRecentTokens,
        })
      : null;
    // SDK 的历史阈值须扣除临时视图；meter/Microcompact 已计入视图，继续使用基础 reserve 避免重复计量。
    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: this.taskContextBudget?.reserveTokens ?? this.reserveTokens,
        keepRecentTokens: this.taskContextBudget?.keepRecentTokens ?? baseKeepRecentTokens,
      },
    });
    const mainHistory = input.plan?.executionPolicy?.history === "MAIN" ? await this.mainHistory?.() : undefined;
    let compactionModel: Model<"openai-completions"> | null = null;
    const useBusinessSummary = [
      PI_ADAPTER_VERSION,
      PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION,
      PRE_TOOL_POLICY_PI_ADAPTER_VERSION,
      PRE_TOOL_TIMEOUT_PI_ADAPTER_VERSION,
      PRE_PROMPT_SNAPSHOT_PI_ADAPTER_VERSION,
      PRE_TASK_STATUS_PI_ADAPTER_VERSION,
      PRE_TASK_CONTEXT_PI_ADAPTER_VERSION,
      PRE_TASK_FOCUS_PI_ADAPTER_VERSION,
      PRE_MICROCOMPACT_PI_ADAPTER_VERSION,
      PRE_IMAGE_PI_ADAPTER_VERSION,
      PRE_MEMORY_PI_ADAPTER_VERSION,
    ].includes(input.plan?.runtime.adapterVersion ?? "");
    const compactionExtension: InlineExtension = {
      name: "host-overflow-guard",
      /** 在自动压缩前固定业务摘要指令并阻止有副作用的溢出重放。 */
      factory: (pi) => {
        pi.on("session_before_compact", async (event) => {
          // Pi 溢出重试可能重放本轮工具；已触发写入/采集时终止重试并交由 Host 对账。
          if (event.reason === "overflow" && event.willRetry && this.unsafeToolStarted) return { cancel: true };
          if (!useBusinessSummary) return;
          if (!compactionModel) throw new Error("COMPACTION_MODEL_MISSING");
          /** 压缩可能分别汇总历史和半轮前缀；每个真实请求及 SDK 重试各自预留、结算。 */
          const budgetedSummaryStream: NonNullable<Parameters<typeof compact>[7]> = async (model, context, options) => {
            let key: string | null;
            try {
              key = await this.reserveBudget("modelCalls");
            } catch (error) {
              throw this.stopForTaskStatusFailure(input, error);
            }
            const stream = streamSimple(model, context, options);
            const settled = stream
              .result()
              .then(
                async (response) => {
                  if (key) await this.executionBudget?.settle(key, response.usage?.totalTokens ?? null);
                  return response;
                },
                async (error) => {
                  if (key) await this.executionBudget?.settle(key, null);
                  throw error;
                },
              )
              .catch((error) => {
                throw this.stopForTaskStatusFailure(input, error);
              });
            stream.result = () => settled;
            return stream;
          };
          const result = await compact(
            {
              ...event.preparation,
              messagesToSummarize: projectMemoryHistory(
                mainHistory
                  ? projectMainHistory(event.preparation.messagesToSummarize, mainHistory, false)
                  : event.preparation.messagesToSummarize,
                input.merchantContext?.snapshot.memories ?? [],
              ),
              turnPrefixMessages: projectMemoryHistory(
                mainHistory
                  ? projectMainHistory(event.preparation.turnPrefixMessages, mainHistory, false)
                  : event.preparation.turnPrefixMessages,
                input.merchantContext?.snapshot.memories ?? [],
              ),
            },
            compactionModel,
            this.modelConfig.apiKey,
            undefined,
            input.taskContext
              ? `${summaryInstructions}${event.customInstructions ? `\n用户压缩要求：${event.customInstructions}` : ""}`
              : HOST_COMPACTION_INSTRUCTIONS,
            event.signal,
            "off",
            budgetedSummaryStream,
            undefined,
            settingsManager.getRetrySettings(),
          );
          return {
            compaction: input.taskContext
              ? {
                  ...result,
                  details: {
                    ...(result.details && typeof result.details === "object" ? result.details : {}),
                    hostTaskContext: {
                      formatVersion: 1,
                      reference: input.plan?.taskContext,
                      budget: this.taskContextBudget,
                      firstKeptEntryId: event.preparation.firstKeptEntryId,
                      summarizedMessageCount: event.preparation.messagesToSummarize.length,
                      turnPrefixMessageCount: event.preparation.turnPrefixMessages.length,
                      isSplitTurn: event.preparation.isSplitTurn,
                    },
                  },
                }
              : result,
          };
        });
      },
    };
    const system = assembleSystemPrompt(input, this.isTaskFocusEnabled());
    const loader = new DefaultResourceLoader({
      cwd: input.workspace,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: system.text,
      extensionFactories: [
        compactionExtension,
        {
          name: "host-main-history-and-budget",
          /** 主历史只投影已识别内部回合；请求额度必须持久预留后才能外发。 */
          factory: (pi) => {
            pi.on("tool_result", async (event) => {
              await this.researchMemory?.observe(event);
              if (!this.isToolTimeoutEnabled()) return;
              const execution = toolExecutionSummary(event);
              if (
                execution &&
                (execution.resultUnknown || ["FAILED", "TIMED_OUT", "CANCELLED", "BLOCKED"].includes(execution.outcome))
              )
                return { isError: true };
            });
            pi.on("context", (event) => {
              const messages: ContextEvent["messages"] = this.researchMemory
                ? this.researchMemory.project(event.messages)
                : mainHistory
                  ? [
                      ...projectMainHistory(event.messages, mainHistory),
                      {
                        role: "custom",
                        customType: "host_task_receipts",
                        content: JSON.stringify({
                          note: "Host持久任务回执，不是用户新要求；原输入和结果可按jobId受控回读，不为汇报重做业务。",
                          receipts: mainHistory.receipts,
                        }),
                        display: false,
                        timestamp: Date.now(),
                      },
                    ]
                  : event.messages;
              return { messages: projectMemoryHistory(messages, input.merchantContext?.snapshot.memories ?? []) };
            });
            pi.on("before_provider_request", async (event) => {
              try {
                this.researchMemory?.assertRequestBudget();
                await this.budgetPending;
                this.modelBudgetKey = await this.reserveBudget("modelCalls");
              } catch (error) {
                throw this.stopForTaskStatusFailure(input, error);
              }
              // 归档总结显式关闭 DeepSeek 默认思考；SDK thinkingLevel=off 本身不会发送该服务所需字段。
              if (
                this.disableDeepSeekThinking &&
                event.payload &&
                typeof event.payload === "object" &&
                !Array.isArray(event.payload)
              )
                return { ...event.payload, thinking: { type: "disabled" } };
            });
          },
        },
        {
          name: "host-microcompact",
          /** 在完整工具批次结束后追加历史编辑，先于 Pi 下一次阈值判断。 */
          factory: (pi) => {
            pi.on("turn_end", async (event) => {
              if (!this.isMicrocompactEnabled() || event.outcome !== "completed") return;
              try {
                const plan = await planMicrocompact({
                  entries: event.context.contextEntries,
                  contextWindow: this.modelConfig.contextWindow,
                  reserveTokens: this.reserveTokens,
                  additionalTokens: this.injectedContextTokens(),
                  phase: "turn_end",
                  access: this.microcompactAccess.bind(this),
                });
                // 不请求继续执行；普通工具循环及 Autocompact 仍由 Pi 控制。
                if (plan) return { entries: [...event.entries, ...plan.drafts] };
              } catch {
                // SDK 会吞掉扩展异常；显式记录失败，避免把未完成的清理当成功快照提交。
                this.microcompactFailure = true;
                void this.session?.abort().catch(() => {});
              }
            });
          },
        },
        ...(input.merchantContext || input.attachmentIndex || input.taskContextBrief
          ? [
              {
                name: input.attachmentIndex || input.taskContextBrief ? "run-context" : "merchant-context",
                hidden: true,
                /** 注册每次模型请求的商家简介、附件索引和固定任务视图注入钩子。 */
                factory: (pi: ExtensionAPI) => {
                  const brief = [input.merchantContext?.brief, input.attachmentIndex, input.taskContextBrief]
                    .filter(Boolean)
                    .join("\n");
                  // 每次模型请求临时注入本轮来源，避免把资料写进 Pi 历史并影响后续 Run。
                  pi.on("context", async (event) => {
                    const observedBrief = await this.currentTaskContextBrief(input, brief);
                    const messages = [...event.messages];
                    let lastUserIndex = -1;
                    for (let index = messages.length - 1; index >= 0; index--) {
                      if (messages[index]?.role === "user") {
                        lastUserIndex = index;
                        break;
                      }
                    }
                    messages.splice(lastUserIndex < 0 ? 0 : lastUserIndex, 0, {
                      role: "custom",
                      customType: input.attachmentIndex || input.taskContextBrief ? "run_context" : "merchant_context",
                      content: observedBrief,
                      display: false,
                      timestamp: Date.now(),
                    });
                    return { messages };
                  });
                },
              },
            ]
          : []),
        {
          name: "host-task-focus",
          /** 在每次模型请求中恢复本轮目标提醒，不追加到持久历史或触发额外推理。 */
          factory: (pi) => {
            pi.on("context", (event) => {
              if (!this.isTaskFocusEnabled()) return;
              return {
                messages: [
                  ...event.messages,
                  {
                    role: "custom",
                    customType: "run_task_focus",
                    content: this.taskFocusContext(event.messages),
                    display: false,
                    timestamp: Date.now(),
                  },
                ],
              };
            });
          },
        },
        {
          name: "host-context-meter",
          /** 在全部 context 注入完成且 Pi 恢复系统/工具定义后记录每次实际请求的估算。 */
          factory: (pi) => {
            pi.on("context_with_system", (event) => {
              this.requestIndex++;
              this.pendingPromptTokens = 0;
              this.lastProviderInput = null;
              this.contextEvents?.({
                type: "context.measured",
                measurement: this.tokenMeasurement(estimateContextTokens(event.messages), "request"),
              });
            });
          },
        },
      ],
    });
    await loader.reload();
    // 装载失败就终止商家 Run，不能在缺少资料的情况下继续生成。
    if (loader.getExtensions().errors.length) throw new Error("RUN_CONTEXT_INVALID");

    const modelRuntime = await ModelRuntime.create({
      credentials: emptyCredentials,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider("zhiban", {
      name: "织伴配置模型",
      baseUrl: this.modelConfig.baseUrl,
      api: "openai-completions",
      apiKey: this.modelConfig.apiKey,
      models: [
        {
          id: this.modelConfig.modelId,
          name: this.modelConfig.modelId,
          reasoning: false,
          input: this.modelConfig.imageInput ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: this.modelConfig.contextWindow,
          maxTokens: this.modelConfig.maxTokens,
        },
      ],
    });
    const model = modelRuntime.getModel("zhiban", this.modelConfig.modelId) as Model<"openai-completions"> | undefined;
    if (!model) throw new Error("PI_MODEL_REGISTRATION_FAILED");
    compactionModel = model;
    for (const entry of sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === MICROCOMPACT_AUDIT_TYPE)
        this.emittedMicrocompactIds.add(entry.id);
    }
    if (input.plan?.continuation) {
      // 只追加来源明确的用户要求和证据索引，不把取消工作文件或残缺助手回复当成功历史。
      sessionManager.appendCustomMessageEntry(
        "cancelled_task_context",
        buildContinuationContext(input.plan.continuation),
        false,
      );
    }
    const registeredTools = [
      ...createSessionTools(
        this.sessionStore,
        this.files,
        this.toolSessionId ?? input.sessionId,
        input.allowedArtifacts,
        input.allowedToolIds,
        input.merchantContext?.snapshot ?? null,
        input.skills,
        input.expertMethods,
        this.toolRunId ?? input.plan?.runId ?? null,
        this.delegateTask,
        this.allowedEvidenceIds,
        this.toolUserPrompt ??
          [...(input.plan?.continuation?.requests.map((item) => item.content) ?? []), input.userPrompt].join("\n\n"),
        this.files.root,
        {
          modelId: this.modelConfig.modelId,
          imageModelId: this.imageModelId,
          toolsetVersion: input.plan?.runtime.toolsetVersion,
          historyReadEnabled: input.plan?.executionPolicy?.history === "MAIN",
          imageInput: this.modelConfig.imageInput,
          researchImagesEnabled: Boolean(input.plan?.runtime.adapterVersion.split(":").includes("research-agent-1")),
        },
        input.plan?.runtime.memorySearch
          ? {
              plan: input.plan.runtime.memorySearch,
              service: this.memorySearch,
              budget: {
                /** 向量外发沿用原任务额度与取消状态，不能绕过暂停继续请求。 */
                reserve: async () => {
                  try {
                    await this.readCurrentTaskStatus(input);
                    await this.budgetPending;
                    return await this.reserveBudget("modelCalls", "merchant_memory_search");
                  } catch (error) {
                    throw this.stopForTaskStatusFailure(input, error);
                  }
                },
                /** 按真实请求预留键结算向量使用量，失败时保留任务状态错误。 */
                settle: async (key, tokens) => {
                  try {
                    await this.executionBudget?.settle(key, tokens);
                  } catch (error) {
                    throw this.stopForTaskStatusFailure(input, error);
                  }
                },
              },
            }
          : undefined,
      ),
      ...this.extraTools,
    ];
    const frozenPolicies = this.isToolPolicyEnabled() ? input.plan?.runtime.toolExecutionPolicies : undefined;
    if (this.isToolPolicyEnabled()) {
      assertToolExecutionPolicies(frozenPolicies, input.allowedToolIds);
      // 只有注册且获准的工具才可接入；旧策略的时间值沿冻结值，确定性契约变更则拒绝。
      snapshotToolExecutionPolicies(registeredTools);
      for (const [name, policy] of Object.entries(frozenPolicies)) {
        const declared = registeredTools.find((tool) => tool.name === name)?.executionPolicy;
        if (!declared || declared.timeoutResult !== policy.timeoutResult)
          throw new Error("TOOL_EXECUTION_POLICY_CHANGED");
      }
      if (this.extraTools.some((tool) => !input.allowedToolIds.includes(tool.name)))
        throw new Error("TOOL_NOT_AUTHORIZED");
    }
    const customTools = registeredTools.map(
      (tool): ToolDefinition => ({
        ...tool,
        /** 工具开始事件落库后才调用实际能力，避免中断窗口中丢失副作用标记。 */
        execute: async (...args) => {
          await this.toolStartPersisted?.();
          await this.readCurrentTaskStatus(input);
          await this.budgetPending;
          const budgetKey = await this.reserveBudget("toolCalls", tool.name);
          try {
            if (this.isToolPolicyEnabled())
              return await executeTool(
                tool,
                args,
                frozenPolicies && Object.hasOwn(frozenPolicies, tool.name) ? frozenPolicies[tool.name] : undefined,
                () => {
                  this.contextEvents?.({ type: "tool.timeout", toolCallId: args[0], toolName: tool.name });
                },
              );
            if (
              input.plan?.runtime.adapterVersion === PRE_TOOL_POLICY_PI_ADAPTER_VERSION &&
              isCollectionTool(tool.name)
            )
              return await executeCollectionTool(tool, args, () => {
                this.contextEvents?.({ type: "tool.timeout", toolCallId: args[0], toolName: tool.name });
              });
            return await tool.execute(...args);
          } finally {
            if (budgetKey) await this.executionBudget?.settle(budgetKey, null);
          }
        },
      }),
    );
    const result = await createAgentSession({
      cwd: input.workspace,
      agentDir: this.agentDir,
      modelRuntime,
      model,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      noTools: "builtin",
      tools: customTools.map((tool) => tool.name),
      customTools,
      thinkingLevel: "off",
    });
    this.session = result.session;
    // 使用 SDK 最终有效文本留档；仅记录已受理 Attempt，准备完成不表示模型请求成功。
    if (input.attempt) {
      await new FileStore(this.files.root).savePromptSnapshot(
        createPromptSnapshot(
          input,
          system,
          customTools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          this.session.systemPrompt,
        ),
      );
    }
    // 每轮显式启用 Pi 阈值压缩；Checkpoint 由 Host 记录并随成功 Run 提交。
    this.session.setAutoCompactionEnabled(true);
    this.sessionDir = sessionDir;
    this.skills = input.skills;
  }

  /** 向当前 Pi 会话发送本轮输入并转发运行事件。 */
  async prompt(text: string, onEvent: (event: PiRuntimeEvent) => Promise<void>): Promise<RuntimeReply> {
    const session = this.requiredSession();
    const input = this.startInput;
    if (!input) throw new Error("RUN_CONTEXT_INVALID");
    this.pendingPromptTokens = estimateTokens({
      role: "user",
      content: [{ type: "text", text }, ...this.promptImages],
      timestamp: 0,
    });
    let compactionBefore: ContextTokenMeasurement | null = null;
    let pending = Promise.resolve();
    let eventFailure: unknown = null;
    let completedAssistant: AssistantMessage | undefined;
    const usage: ModelUsageSummary = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    };
    let hasReportedUsage = false;
    const skillCalls = new Map<string, SkillRead>();
    let timedOut = false;
    let timeoutCode = "MODEL_TIMEOUT";
    let rejectDeadline: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const runtimeDeadline = new RuntimeDeadline(this.modelConfig.timeoutMs, this.isToolTimeoutEnabled(), (code) => {
      timedOut = true;
      timeoutCode = code;
      rejectDeadline(new Error(code));
      void session.abort().catch(() => {});
    });
    // 串行转发增量事件，避免异步落库打乱事件顺序。
    const forward = (event: PiRuntimeEvent) => {
      pending = pending.then(async () => {
        if (eventFailure) return;
        try {
          await onEvent(event);
          if ((event.type === "context.measured" || event.type === "context.compressed") && this.startInput)
            logContextTokens({ sessionId: this.startInput.sessionId, runId: this.startInput.runId }, event.measurement);
        } catch (error) {
          eventFailure = error;
          void session.abort().catch(() => {});
        }
      });
    };
    this.contextEvents = forward;
    // SDK 先发出 tool_execution_start，再调用工具；写入失败时禁止继续外部调用。
    this.toolStartPersisted = async () => {
      await pending;
      if (eventFailure) throw new Error("RUNTIME_EVENT_PERSIST_FAILED");
      if (this.taskStatusFailure) throw this.taskStatusFailure;
      if (timedOut || this.abortRequested) throw new Error("TOOL_ABORTED");
    };
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      // Boundary 草稿已经写入 Pi 后才转发记录；不把扩展提出的计划当作执行回执。
      if (["turn_end", "compaction_start", "compaction_end"].includes(event.type)) {
        this.forwardMicrocompactRecords(forward);
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        forward({ type: "text.delta", text: event.assistantMessageEvent.delta });
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        forward({ type: "thinking.delta", text: event.assistantMessageEvent.delta });
      } else if (event.type === "tool_execution_start") {
        runtimeDeadline?.toolStarted(event.toolCallId);
        if (blocksToolReplay(event.toolName, "overflow")) this.unsafeToolStarted = true;
        const skill = event.toolName === "read_skill" ? this.skillRead(event.args) : undefined;
        if (skill) skillCalls.set(event.toolCallId, skill);
        forward({ type: "tool.started", toolCallId: event.toolCallId, toolName: event.toolName, skill });
      } else if (event.type === "tool_execution_end") {
        runtimeDeadline?.toolCompleted(event.toolCallId);
        const skill = skillCalls.get(event.toolCallId);
        skillCalls.delete(event.toolCallId);
        forward({
          type: "tool.completed",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          ...(this.isToolTimeoutEnabled() && { execution: toolExecutionSummary(event.result) }),
          skill,
        });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        completedAssistant = event.message;
        this.settleModelBudget(event.message.usage?.totalTokens ?? null);
        if (addReportedUsage(usage, event.message.usage)) hasReportedUsage = true;
        this.lastProviderInput = reportedContextInput(event.message.usage);
        // public message_end 先于 SDK 持久化助手条目，计量时仅在此处补入当前回复一次。
        forward({ type: "context.measured", measurement: this.currentTokenMeasurement("response", event.message) });
      } else if (event.type === "compaction_start") {
        compactionBefore = this.currentTokenMeasurement("compression_before");
        forward({ type: "context.measured", measurement: compactionBefore });
        forward({ type: "compaction.started", reason: event.reason });
      } else if (event.type === "compaction_end") {
        // SDK 已合并主摘要与拆分回合前缀摘要的用量，两者均属于本轮实际成本。
        if (event.result?.usage && addReportedUsage(usage, event.result.usage)) hasReportedUsage = true;
        this.lastProviderInput = null;
        const after = event.result ? this.currentTokenMeasurement("compression_after") : null;
        if (compactionBefore) {
          forward({
            type: "context.compressed",
            measurement: compareContextTokens("AUTOCOMPACT", compactionBefore, after),
          });
          if (after) forward({ type: "context.measured", measurement: after });
          compactionBefore = null;
        }
        forward({
          type: "compaction.finished",
          reason: event.reason,
          result: event.result
            ? {
                summary: event.result.summary,
                firstKeptEntryId: event.result.firstKeptEntryId,
                tokensBefore: event.result.tokensBefore,
                estimatedTokensAfter: event.result.estimatedTokensAfter,
              }
            : null,
          errorMessage: event.errorMessage ?? null,
          willRetry: event.willRetry,
        });
      }
    });
    let promptTask: Promise<void> | null = null;
    try {
      promptTask = (async () => {
        await this.readCurrentTaskStatus(input);
        await this.microcompactBeforePrompt(text);
        this.forwardMicrocompactRecords(forward);
        if (timedOut) return;
        if (this.abortRequested) throw new Error("RUN_CANCELLED");
        await session.prompt(text, this.promptImages.length ? { images: this.promptImages } : undefined);
      })();
      await Promise.race([promptTask, deadline]);
      this.forwardMicrocompactRecords(forward);
      forward({ type: "context.measured", measurement: this.currentTokenMeasurement("settled") });
      runtimeDeadline?.stop();
      await pending;
      if (eventFailure) throw new Error("RUNTIME_EVENT_PERSIST_FAILED");
      if (this.taskStatusFailure) throw this.taskStatusFailure;
      if (this.microcompactFailure) throw new Error("MICROCOMPACT_FAILED");
      const reply = completedAssistant;
      // 只有完整、正常结束的文本回复才写入会话历史。
      if (!reply) throw new Error("MODEL_RESPONSE_MISSING");
      if (reply.stopReason === "error") throw new Error("MODEL_PROVIDER_FAILED");
      if (reply.stopReason === "length") throw new Error("MODEL_OUTPUT_TRUNCATED");
      if (reply.stopReason !== "stop") throw new Error("MODEL_RESPONSE_INCOMPLETE");
      const answer = reply.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      if (!answer) throw new Error("EMPTY_MODEL_RESPONSE");
      return { text: answer, usage: hasReportedUsage ? usage : null };
    } catch (error) {
      if (eventFailure) throw new Error("RUNTIME_EVENT_PERSIST_FAILED");
      if (this.taskStatusFailure) throw this.taskStatusFailure;
      if (timedOut) throw new Error(timeoutCode);
      throw error;
    } finally {
      runtimeDeadline?.stop();
      // 超时的 race 结束不代表 SDK/工具退出；订阅保留到执行及事件写入全部完成。
      await promptTask?.catch(() => {});
      await session.waitForIdle();
      await pending;
      this.settleModelBudget(null);
      await this.budgetPending;
      unsubscribe();
      this.contextEvents = null;
      this.toolStartPersisted = null;
    }
  }

  /** 每次实际模型/工具调用使用独立键；数据库拒绝后不以新任务绕过额度。 */
  private async reserveBudget(kind: TaskBudgetKind, toolName?: string): Promise<string | null> {
    if (!this.executionBudget) return null;
    const key = `${kind}:${++this.budgetSequence}${toolName ? `:${toolName}` : ""}`;
    if (!(await this.executionBudget.reserve(kind, key))) throw new Error("TASK_BUDGET_EXHAUSTED");
    return key;
  }

  /** 模型完成事件按顺序结算；无报告和失败请求保留未知用量标记。 */
  private settleModelBudget(tokens: number | null): void {
    const key = this.modelBudgetKey;
    if (!key) return;
    this.modelBudgetKey = null;
    this.budgetPending = this.budgetPending
      .then(async () => {
        await this.executionBudget?.settle(key, tokens);
      })
      .catch((error) => {
        if (this.startInput) this.stopForTaskStatusFailure(this.startInput, error);
      });
  }

  /** SDK 会吞 context hook 异常；读取失败同时中止会话并让 Host 收口失败，禁止旧视图降级执行。 */
  private async readCurrentTaskStatus(input: RuntimeStartInput) {
    if (!input.currentTaskStatus) return null;
    try {
      const status = await input.currentTaskStatus();
      if (status.basisStatus !== "CURRENT") throw new Error("INPUT_VERSION_STALE");
      this.observedTaskStatus = status;
      return status;
    } catch (error) {
      throw this.stopForTaskStatusFailure(input, error);
    }
  }

  /** 只读进度连同观察证据入库后才注入，超预算或持久化失败也不能降级为旧视图。 */
  private async currentTaskContextBrief(input: RuntimeStartInput, brief: string): Promise<string> {
    if (!input.currentTaskStatus) return brief;
    try {
      const status = await this.readCurrentTaskStatus(input);
      if (!status || !input.taskContext) throw new Error("TASK_CONTEXT_INVALID");
      const projected = {
        ...status,
        carriers: taskContextCarriers({ ...input.taskContext, carriers: status.carriers }, input.expert?.role ?? null),
      };
      const observed = `${brief}\n${JSON.stringify({ type: "current_task_status", ...projected, note: "只读最新进度，不变更冻结要求、输入或工具权限。新成果不等于已审核通过。" })}`;
      assertTaskContextBudget(observed, this.modelConfig.contextWindow, this.modelConfig.maxTokens);
      this.contextEvents?.({
        type: "task.status.observed",
        contextId: status.contextId,
        frozenRevision: input.taskContext.revision,
        observedSeq: status.observedSeq,
        projectionHash: createHash("sha256").update(JSON.stringify(projected)).digest("hex"),
        basisStatus: status.basisStatus,
      });
      await this.toolStartPersisted?.();
      return observed;
    } catch (error) {
      throw this.stopForTaskStatusFailure(input, error);
    }
  }

  /** 钩子异常不能只记日志继续请求，保留首个原因并中止在途 SDK 循环。 */
  private stopForTaskStatusFailure(input: RuntimeStartInput, error: unknown): Error {
    if (this.taskStatusFailure) return this.taskStatusFailure;
    this.taskStatusFailure = error instanceof Error ? error : new Error("TASK_STATUS_UNAVAILABLE");
    this.session?.abortCompaction();
    void this.session?.abort().catch((failure: unknown) => {
      process.stderr.write(
        `[task-status ${input.runId}] 终止失败：${failure instanceof Error ? failure.message : "UNKNOWN"}\n`,
      );
    });
    return this.taskStatusFailure;
  }

  /** 读取 Pi 会话快照以便恢复或持久化。 */
  async getState(): Promise<RuntimeStateSnapshot> {
    const file = this.workingSessionFile;
    let hash: string | null = null;
    if (file) {
      try {
        const managed = await this.managedSessionFile(file, this.requiredSessionDir());
        hash = createHash("sha256")
          .update(await readFile(managed))
          .digest("hex");
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "PI_SESSION_FILE_MISSING") throw error;
      }
    }
    return {
      sessionFile: file,
      sessionFileHash: hash,
      fileExists: hash !== null,
      sourceSnapshotHash: this.sourceSnapshotHash,
      sourceVerification: this.sourceVerification,
      adapterVersion: this.startInput?.plan?.runtime.adapterVersion ?? PI_ADAPTER_VERSION,
    };
  }

  /** 等待 Pi 会话停止处理当前请求。 */
  async waitForIdle(): Promise<void> {
    await this.requiredSession().waitForIdle();
  }

  /** 请求终止当前 Pi 会话执行。 */
  async abort(): Promise<void> {
    this.abortRequested = true;
    await this.requiredSession().abort();
  }

  /** 在需要时压缩 Pi 会话历史。 */
  async compact(instructions?: string): Promise<void> {
    await this.requiredSession().compact(instructions);
  }

  /** 把已接纳专家结果记入父历史；不伪造模型调用或让父模型重写正式内容。 */
  async recordExpertResult(
    prompt: string,
    text: string,
    delegationId: string,
    onEvent: (event: PiRuntimeEvent) => Promise<void>,
  ): Promise<RuntimeReply> {
    const input = this.startInput;
    if (!input || this.abortRequested) throw new Error("RUN_CANCELLED");
    this.contextEvents = onEvent;
    await this.readCurrentTaskStatus(input);
    if (this.abortRequested) throw new Error("RUN_CANCELLED");
    const manager = this.requiredSession().sessionManager;
    manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
    manager.appendCustomEntry("host_publication_expert_result", { delegationId });
    // SDK 在首条 assistant 才落盘；明确标识 Host 接纳投影，不冒充一次 Provider 请求或计入模型用量。
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "host",
      model: "accepted-expert-result",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    await onEvent({ type: "context.measured", measurement: this.currentTokenMeasurement("settled") });
    return { text, usage: null };
  }

  /** 将用户追加指令排入当前子 Agent 的下一步推理。 */
  async steer(text: string): Promise<void> {
    await this.requiredSession().steer(text);
  }

  /** 释放当前 Run 的 Pi 会话和事件订阅。 */
  async stop(): Promise<void> {
    // dispose 只发出中止且解除订阅，必须先等待执行退出以防旧工具继续运行。
    if (this.session) {
      await this.session.abort();
      await this.session.waitForIdle();
    }
    this.session?.dispose();
    this.session = null;
    this.sessionDir = null;
    this.skills = [];
    this.promptImages = [];
    this.startInput = null;
    this.taskContextBudget = null;
  }

  /** 只为冻结为新版适配器的 Run 开启清理，旧 Run 重试保持原行为。 */
  private isMicrocompactEnabled(): boolean {
    return [
      PI_ADAPTER_VERSION,
      PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION,
      PRE_TOOL_POLICY_PI_ADAPTER_VERSION,
      PRE_TOOL_TIMEOUT_PI_ADAPTER_VERSION,
      PRE_PROMPT_SNAPSHOT_PI_ADAPTER_VERSION,
      PRE_TASK_STATUS_PI_ADAPTER_VERSION,
      PRE_TASK_CONTEXT_PI_ADAPTER_VERSION,
      PRE_TASK_FOCUS_PI_ADAPTER_VERSION,
    ].includes(this.startInput?.plan?.runtime.adapterVersion ?? "");
  }

  /** 仅对冻结为任务提醒版本的 Run 启用持续注入，旧任务恢复保持原输入。 */
  private isTaskFocusEnabled(): boolean {
    return [
      PI_ADAPTER_VERSION,
      PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION,
      PRE_TOOL_POLICY_PI_ADAPTER_VERSION,
      PRE_TOOL_TIMEOUT_PI_ADAPTER_VERSION,
      PRE_PROMPT_SNAPSHOT_PI_ADAPTER_VERSION,
      PRE_TASK_STATUS_PI_ADAPTER_VERSION,
      PRE_TASK_CONTEXT_PI_ADAPTER_VERSION,
    ].includes(this.startInput?.plan?.runtime.adapterVersion ?? "");
  }

  /** 单工具时限和计时隔离仅对本版本新受理的 Run 生效，旧 Plan 不补算。 */
  private isToolTimeoutEnabled(): boolean {
    return [PI_ADAPTER_VERSION, PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION, PRE_TOOL_POLICY_PI_ADAPTER_VERSION].includes(
      this.startInput?.plan?.runtime.adapterVersion ?? "",
    );
  }

  /** 只对新版本读取冻结策略；历史白名单策略单独兼容，不迁入当前声明。 */
  private isToolPolicyEnabled(): boolean {
    return [PI_ADAPTER_VERSION, PRE_RESEARCH_AGENT_PI_ADAPTER_VERSION].includes(
      this.startInput?.plan?.runtime.adapterVersion ?? "",
    );
  }

  /** 子 Plan 受理时冻结额外注册工具的策略，不让执行阶段临时读取当前默认值。 */
  getExtraToolExecutionPolicies(): Record<string, ToolExecutionPolicy> {
    return snapshotToolExecutionPolicies(this.extraTools);
  }

  /** 从本轮已受理原文构建提醒，专家使用自己的冻结任务单而不是父会话全文。 */
  private taskFocusContext(messages: ContextEvent["messages"]): string {
    const input = this.startInput;
    return buildTaskFocusContext(
      input?.userPrompt ?? "",
      input?.plan?.messageId ?? null,
      messages,
      input?.plan?.continuation,
      input?.plan?.taskContext,
    );
  }

  /** 为未写入历史的简介、附件索引和任务提醒预留空间，待发原文不重复估算。 */
  private injectedContextTokens(pendingPrompt?: string): number {
    const messages = this.requiredSession().sessionManager.buildSessionProjection().messages;
    const focusMessages: ContextEvent["messages"] = pendingPrompt
      ? [...messages, { role: "user", content: pendingPrompt, timestamp: 0 }]
      : messages;
    const content = [
      this.startInput?.merchantContext?.brief,
      this.startInput?.attachmentIndex,
      this.startInput?.taskContextBrief,
      this.observedTaskStatus ? JSON.stringify(this.observedTaskStatus) : null,
      this.isTaskFocusEnabled() ? this.taskFocusContext(focusMessages) : null,
    ]
      .filter(Boolean)
      .join("\n");
    return content ? estimateTokens({ role: "user", content, timestamp: 0 }) : 0;
  }

  /** 在 SDK prompt 的首次阈值判断前清理工作副本，原成功快照不变。 */
  private async microcompactBeforePrompt(text: string): Promise<void> {
    if (!this.isMicrocompactEnabled()) return;
    const manager = this.requiredSession().sessionManager;
    const plan = await planMicrocompact({
      entries: manager.buildSessionProjection().entries,
      contextWindow: this.modelConfig.contextWindow,
      reserveTokens: this.reserveTokens,
      additionalTokens:
        this.injectedContextTokens(text) +
        estimateTokens({
          role: "user",
          content: [{ type: "text", text }, ...this.promptImages],
          timestamp: 0,
        }),
      phase: "before_prompt",
      access: this.microcompactAccess.bind(this),
    });
    if (!plan) return;
    for (const draft of plan.drafts) {
      if (draft.type === "context_edit") manager.appendContextEdit(draft.targetId, draft.replacement);
      if (draft.type === "custom") manager.appendCustomEntry(draft.customType, draft.data);
    }
  }

  /** 只转发本次工作副本已追加的审计记录，恢复时不重发历史记录。 */
  private drainMicrocompactRecords(): MicrocompactRecord[] {
    const records: MicrocompactRecord[] = [];
    for (const entry of this.requiredSession().sessionManager.getBranch()) {
      if (
        entry.type !== "custom" ||
        entry.customType !== MICROCOMPACT_AUDIT_TYPE ||
        this.emittedMicrocompactIds.has(entry.id)
      )
        continue;
      this.emittedMicrocompactIds.add(entry.id);
      records.push(entry.data as MicrocompactRecord);
    }
    return records;
  }

  /** 为统一估算生成窗口、占比、剩余空间与独立的最近 Provider 输入报告。 */
  private tokenMeasurement(tokens: number, stage: ContextTokenMeasurement["stage"]): ContextTokenMeasurement {
    return measureContextTokens(tokens, {
      contextWindow: this.modelConfig.contextWindow,
      reserveTokens: this.reserveTokens,
      requestIndex: this.requestIndex,
      stage,
      providerInputTokens: this.lastProviderInput,
    });
  }

  /** 估算有效工作历史并补齐临时注入；清理后不复用旧模型用量。 */
  private currentTokenMeasurement(
    stage: ContextTokenMeasurement["stage"],
    response?: AssistantMessage,
  ): ContextTokenMeasurement {
    const messages = this.requiredSession().sessionManager.buildSessionProjection().messages;
    const tokens =
      estimateContextTokens(response ? [...messages, response] : messages) +
      this.injectedContextTokens() +
      this.pendingPromptTokens;
    return this.tokenMeasurement(tokens, stage);
  }

  /** 转发实际落盘的工具清理及统一前后比较，保持与摘要压缩相同的日志口径。 */
  private forwardMicrocompactRecords(forward: (event: PiRuntimeEvent) => void): void {
    for (const record of this.drainMicrocompactRecords()) {
      this.lastProviderInput = null;
      forward({ type: "microcompact.completed", record });
      const before = this.tokenMeasurement(record.estimatedTokensBefore, "compression_before");
      const after = this.tokenMeasurement(record.estimatedTokensAfter, "compression_after");
      forward({ type: "context.compressed", measurement: compareContextTokens("MICROCOMPACT", before, after) });
      forward({ type: "context.measured", measurement: after });
    }
  }

  /** 复核本轮归属、工具白名单及来源版本，不让引用重新授予读取权限。 */
  private async microcompactAccess(source: MicrocompactSource): Promise<"AVAILABLE" | "UNAVAILABLE" | "OUT_OF_SCOPE"> {
    const input = this.startInput;
    if (!input) return "OUT_OF_SCOPE";
    const sessionId = this.toolSessionId ?? input.sessionId;
    const session = await this.sessionStore.getSession(sessionId);
    if (session?.lifecycleStatus !== "ACTIVE") return "OUT_OF_SCOPE";
    const merchantId = input.merchantContext?.snapshot.merchantId ?? null;
    if (
      merchantId
        ? session.scope !== "MERCHANT" || session.ownerId !== merchantId
        : session.scope !== "NORMAL" || session.ownerId !== "local"
    )
      return "OUT_OF_SCOPE";
    const tools = {
      upload: "read_uploaded_text",
      evidence: "evidence_get",
      skill: "read_skill",
      expert: "read_expert_method",
    };
    const allowed = input.allowedToolIds.includes(tools[source.kind]);
    if (source.kind === "upload") {
      const artifact = await this.sessionStore.getArtifact(source.artifactId);
      if (!artifact || artifact.sessionId !== sessionId || artifact.kind !== "upload") return "OUT_OF_SCOPE";
      return allowed &&
        artifact.status === "READY" &&
        artifact.blobHash === source.blobHash &&
        artifact.mimeType === "text/plain" &&
        artifact.sizeBytes <= 2 * 1024 * 1024 &&
        input.allowedArtifacts?.some(
          (item) => item.artifactId === source.artifactId && item.blobHash === source.blobHash,
        )
        ? "AVAILABLE"
        : "UNAVAILABLE";
    }
    if (source.kind === "evidence") {
      const evidence = await this.sessionStore.getPublicEvidence(source.evidenceId);
      if (!evidence || (merchantId ? evidence.merchantId !== merchantId : evidence.sessionId !== sessionId))
        return "OUT_OF_SCOPE";
      return allowed &&
        evidence.visibleTextSha256 === source.sha256 &&
        (!this.allowedEvidenceIds || this.allowedEvidenceIds.includes(source.evidenceId))
        ? "AVAILABLE"
        : "UNAVAILABLE";
    }
    if (source.kind === "skill") {
      const skill = input.skills.find((item) => item.name === source.name);
      const version = source.path === "SKILL.md" ? skill : skill?.references.find((item) => item.path === source.path);
      return allowed && version?.sha256 === source.sha256 ? "AVAILABLE" : "UNAVAILABLE";
    }
    const method = input.expertMethods.find((item) => item.role === source.role && item.groupId === source.groupId);
    return allowed && method?.sharedSha256 === source.sharedSha256 && method.promptSha256 === source.promptSha256
      ? "AVAILABLE"
      : "UNAVAILABLE";
  }

  /** 识别本轮 Skill 读取调用并提取其名称和引用路径。 */
  private skillRead(args: unknown): SkillRead | undefined {
    if (!args || typeof args !== "object") return undefined;
    const { name, reference } = args as Record<string, unknown>;
    if (typeof name !== "string" || (reference !== undefined && typeof reference !== "string")) return undefined;
    const skill = this.skills.find((item) => item.name === name);
    if (!skill) return undefined;
    const source = reference ? skill.references.find((item) => item.path === reference) : skill;
    if (!source) return undefined;
    return { name, path: reference || "SKILL.md", sha256: source.sha256 };
  }

  /** 取得已启动的 Pi 会话，否则显式报错。 */
  private requiredSession(): AgentSession {
    if (!this.session) throw new Error("PI_SESSION_NOT_STARTED");
    return this.session;
  }

  /** 取得受管 Pi 会话目录，避免读写任意路径。 */
  private requiredSessionDir(): string {
    if (!this.sessionDir) throw new Error("PI_SESSION_NOT_STARTED");
    return this.sessionDir;
  }

  /** 验证 Pi 快照路径仍位于当前会话受管目录。 */
  private async managedSessionFile(file: string, sessionDir: string): Promise<string> {
    // 同时检查字面路径和真实路径，阻止通过符号链接逃出会话目录。
    const path = resolve(file);
    if (dirname(path) !== resolve(sessionDir)) throw new Error("PI_SESSION_PATH_ESCAPE");
    try {
      const info = await lstat(path);
      const directory = await realpath(sessionDir);
      const actual = await realpath(path);
      if (!info.isFile() || !actual.startsWith(`${directory}${sep}`)) throw new Error("PI_SESSION_PATH_ESCAPE");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error("PI_SESSION_FILE_MISSING");
      }
      throw error;
    }
    return path;
  }

  /** 将 Pi 快照复制到本轮受管目录以保留恢复状态。 */
  private async copySessionFile(file: string, sessionDir: string, expectedHash: string | null): Promise<string> {
    // 校验与写副本使用同一份字节，避免校验后重新读取导致文件替换窗口。
    const bytes = await readFile(file);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (expectedHash && hash !== expectedHash) throw new Error("PI_SESSION_HASH_MISMATCH");
    // SDK 会跳过损坏行，甚至重建会话；受管恢复必须显式拒绝这些输入。
    try {
      const entries = bytes
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (entries[0]?.type !== "session" || entries.some((entry) => !entry || typeof entry.type !== "string"))
        throw new Error("PI_SESSION_FILE_INVALID");
    } catch {
      throw new Error("PI_SESSION_FILE_INVALID");
    }
    this.sourceSnapshotHash = hash;
    this.sourceVerification = expectedHash ? "VERIFIED" : "LEGACY_UNVERIFIED";
    const copy = join(sessionDir, `run_${randomUUID()}.jsonl`);
    await writeFile(copy, bytes, { flag: "wx", mode: 0o600 });
    return copy;
  }
}

import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type {
  DelegationContextPacket,
  DelegationInputSnapshot,
  DelegationRecord,
  DelegationTaskV2,
  RuntimeEvent,
  TextGenerationJobRecord,
} from "../../../shared/contracts.js";
import type { AcceptedExpertResultV3, ExpertSubmissionV3, ExpertTaskV3 } from "../../../shared/expert-contract.js";
import type { BackgroundResearchReceipt } from "../../../shared/research-agent.js";
import type { ToolExecutionPolicy } from "../../../shared/tool-execution.js";
import type { ModelConfig } from "../../config.js";
import type { FileStore } from "../../infrastructure/files/files.js";
import type { DbClient } from "../../infrastructure/sqlite/db-client.js";
import type { MemorySearchService } from "../../modules/merchants/application/memory-search-service.js";
import {
  validatePublicationExpertJob,
  validatePublicationExpertOutput,
} from "../../modules/publication/application/publication-expert.js";
import { PiSdkRuntimeAdapter } from "../adapters/pi/pi-sdk-adapter.js";
import { assembleMerchantContext, resolveRunContext } from "../context/context-assembler.js";
import { buildContinuationContext } from "../context/task-focus.js";
import {
  canonicalJson,
  createRuntimePlan,
  type RuntimePlanV5,
  type RuntimePlanV6,
  sha256,
} from "../execution/runtime-plan.js";
import type { PiRuntimeEvent } from "../ports/pi-runtime-port.js";
import type { HostToolDefinition } from "../tools/host-tool.js";
import { type DelegateTaskInput, TOOLSET_VERSION } from "../tools/tool-catalog.js";
import {
  expertContract,
  expertContractFewShotExamples,
  expertSubmissionV3Schema,
  expertTaskView,
  validateExpertSubmission,
} from "./expert-contracts.js";
import { ResearchMemoryController } from "./research-memory.js";

const submitSchema = Type.Object({
  version: Type.Literal(2),
  output: Type.Object({
    type: Type.Union([Type.Literal("text_draft"), Type.Literal("text_report")]),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    content: Type.String({ minLength: 1, maxLength: 30000 }),
  }),
  unmetCriterionIds: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20 }),
  notes: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 }),
});
const legacyReadInputSchema = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
});
const readInputSchema = Type.Object({
  ...legacyReadInputSchema.properties,
  materialId: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 100,
      description: "只用于材料索引中实际列出的材料ID；读取完整父轮任务原文时必须省略，不填消息ID、input或任务ID。",
    }),
  ),
});
const askUserSchema = Type.Object({ question: Type.String({ minLength: 1, maxLength: 1000 }) });

interface ActiveDelegation {
  parentRunId: string;
  runtime: PiSdkRuntimeAdapter;
  promise: Promise<DelegationRecord>;
  started: boolean;
}

type ParentDelegationPlan = RuntimePlanV5 | RuntimePlanV6;

/** 持久化委派事实由 Host 管理；Pi 只决定是否调用工具及提交内容。 */
export class DelegationService {
  private readonly active = new Map<string, ActiveDelegation>();
  private stopping = false;

  /** 绑定父 Run 和子 Agent 的存储、执行与事件依赖。 */
  constructor(
    private readonly db: DbClient,
    private readonly files: FileStore,
    private readonly model: ModelConfig,
    private readonly publish: (event: RuntimeEvent) => void,
    private readonly memorySearch?: MemorySearchService,
  ) {}

  /** 允许新委派任务进入服务。 */
  start(): void {
    this.stopping = false;
  }

  /** 验证父 Run 的任务单，冻结输入后启动目标专家子 Agent。 */
  async delegate(
    parentSessionId: string,
    parentRunId: string,
    input: DelegateTaskInput,
    signal?: AbortSignal,
  ): Promise<DelegationRecord | BackgroundResearchReceipt> {
    if (signal?.aborted || this.stopping) throw new Error("DELEGATION_CANCELLED");
    const [plan, session, parentPrompt, parentRun] = await Promise.all([
      this.db.getRunPlan(parentRunId),
      this.db.getSession(parentSessionId),
      this.db.getRunPrompt(parentRunId),
      this.db.getRun(parentRunId),
    ]);
    if (
      (plan?.schemaVersion !== 5 && plan?.schemaVersion !== 6) ||
      !session ||
      !parentPrompt ||
      parentRun?.status !== "RUNNING" ||
      parentRun.sessionId !== parentSessionId ||
      plan.session.sessionId !== parentSessionId ||
      plan.session.scope !== session.scope ||
      plan.session.ownerId !== session.ownerId ||
      !plan.capabilities.expertGroup[input.targetExpertId] ||
      (plan.schemaVersion === 6 &&
        plan.capabilities.expertGroup.enabledRoles &&
        !plan.capabilities.expertGroup.enabledRoles.includes(input.targetExpertId))
    ) {
      throw new Error("DELEGATION_NOT_ALLOWED");
    }
    const merchantContext = await assembleMerchantContext(this.db, plan, session);
    const formalStep = plan.schemaVersion === 6 ? plan.publicationExpert : undefined;
    const formalJob = formalStep
      ? (await this.db.listTextGenerationJobs(parentSessionId)).find((item) => item.jobId === formalStep.jobId)
      : undefined;
    if (formalStep) {
      validatePublicationExpertJob(formalStep, formalJob ?? null);
      if (
        input.version !== 3 ||
        input.targetExpertId !== formalStep.targetExpertId ||
        input.contractId !== formalStep.contractId ||
        input.taskKey !== `publication_${formalStep.jobId}`
      )
        throw new Error("PUBLICATION_EXPERT_REQUIRED");
    }
    if (input.version === 3 && (plan.schemaVersion !== 6 || plan.runtime.toolsetVersion < TOOLSET_VERSION))
      throw new Error("EXPERT_CONTRACT_INVALID");
    const task = expertTaskView(input);
    this.validateTask(task);
    const inputHash = sha256(JSON.stringify({ planHash: plan.planHash, input }));
    const taskKey = plan.schemaVersion === 5 ? "legacy" : (input.taskKey ?? "legacy");
    const previous = await this.db.getDelegationForTask(parentRunId, taskKey);
    if (previous && previous.inputHash !== inputHash) throw new Error("DELEGATION_CONFLICT");
    if (previous?.status === "SUCCEEDED") return this.db.acknowledgeDelegation(previous.delegationId);
    if (previous?.status === "FAILED" || previous?.status === "CANCELLED") return previous;
    const resources = formalJob?.source?.research
      ? formalJob.source.research.materials
          .filter((item) => item.ref.kind === "uploaded_text" || item.ref.kind === "public_evidence")
          .map((item) => ({
            type: item.ref.kind as "uploaded_text" | "public_evidence",
            id: item.ref.id,
            sha256: item.ref.sha256,
          }))
      : await this.resolveResources(parentSessionId, session.scope === "MERCHANT" ? session.ownerId : null, plan, task);
    const materials =
      input.version === 3
        ? (previous?.inputSnapshot?.materials ??
          formalJob?.source?.research?.materials ??
          (await this.resolveMaterials(parentSessionId, parentRunId, plan, input, resources)))
        : [];
    if (input.version === 3 && input.executionMode === "background")
      return this.db.createBackgroundResearch(parentSessionId, parentRunId, input, materials);
    if (input.targetExpertId === "researcher" && input.version !== 3) throw new Error("EXPERT_CONTRACT_INVALID");
    if (previous?.inputSnapshot && JSON.stringify(resources) !== JSON.stringify(previous.inputSnapshot.resources))
      throw new Error("DELEGATION_RESOURCE_CHANGED");
    const contextPacket =
      previous?.inputSnapshot?.contextPacket ??
      (plan.schemaVersion === 6 ? await this.contextPacket(task, parentPrompt, plan, resources) : null);
    const childPrompt =
      previous?.inputSnapshot?.childPrompt ??
      this.childPrompt(task, parentPrompt, plan, contextPacket, input.version) +
        (input.version === 3
          ? this.contractPrompt(input, materials, plan.runtime.adapterVersion.split(":").includes("fewshot-1"))
          : "");
    if (
      input.version === 3 &&
      this.estimatedTokens(childPrompt) > Math.floor((plan.model.contextWindow - plan.model.maxTokens) / 2)
    )
      throw new Error("DELEGATION_CONTEXT_BUDGET_LOW");
    // 父 Run 对应的委派先在数据库占位；同一任务重入只复用已保存记录。
    const record = await this.db.reserveDelegation(parentSessionId, parentRunId, inputHash, input);
    if (signal?.aborted || this.stopping) throw new Error("DELEGATION_CANCELLED");
    if (record.status === "SUCCEEDED") return this.db.acknowledgeDelegation(record.delegationId);
    if (record.status === "FAILED" || record.status === "CANCELLED") return record;
    const running = this.active.get(record.delegationId);
    if (running) return this.deliver(await running.promise);
    if (record.status === "RUNNING")
      return this.db.finishDelegation(record.delegationId, "FAILED", "DELEGATION_ORPHANED");

    const researchMemory =
      input.version === 3 && input.targetExpertId === "researcher"
        ? new ResearchMemoryController(
            this.db,
            record,
            parentRun.attempt,
            await this.db.getResearchMemory(record.delegationId),
            materials.map((item) => item.ref),
            session.scope === "MERCHANT" ? session.ownerId : null,
          )
        : undefined;
    const runtime = new PiSdkRuntimeAdapter(this.model, `${this.files.root}/runtime/pi-agent`, this.db, this.files, {
      memorySearch: this.memorySearch,
      researchMemory,
      executionBudget: {
        /** 子Attempt共享父任务额度并保留独立调用键。 */
        reserve: (kind, key) =>
          this.db.reserveTaskExecution(
            {
              runId: parentRunId,
              attempt: parentRun.attempt,
              delegationId: record.delegationId,
              childAttempt: record.attempt + 1,
            },
            kind,
            key,
          ),
        /** 子用量回写原预留，重复交接不重复计数。 */
        settle: (key, tokens) =>
          this.db.settleTaskExecution(
            {
              runId: parentRunId,
              attempt: parentRun.attempt,
              delegationId: record.delegationId,
              childAttempt: record.attempt + 1,
            },
            key,
            tokens,
          ),
      },
      toolSessionId: parentSessionId,
      ...(researchMemory && {
        toolRunId: parentRunId,
        // 链接授权只读取真实用户原文，模型任务单和研究摘要里的URL不新增采集权限。
        toolUserPrompt: formalJob?.source?.research
          ? ((await this.db.getRunPrompt(formalJob.source.research.originRunId)) ?? "")
          : parentPrompt,
      }),
      extraTools: [
        input.version === 3
          ? this.submitContractTool(record, input, materials, parentRun.attempt, formalJob, researchMemory)
          : this.submitTool(record, parentRun.attempt),
        this.readInputTool(record.delegationId, parentPrompt, plan.messageId, input.version === 3),
        this.askUserTool(record),
        ...(researchMemory ? [researchMemory.tool()] : []),
      ],
      ...(researchMemory
        ? {}
        : { allowedEvidenceIds: resources.filter((ref) => ref.type === "public_evidence").map((ref) => ref.id) }),
    });
    const promise = this.execute(
      record,
      plan,
      parentPrompt,
      childPrompt,
      contextPacket,
      resources,
      merchantContext,
      runtime,
      parentRun.attempt,
      materials,
      signal,
    ).then((finished) => {
      // 清理异常保留活动句柄，父任务必须观察到拒绝并继续占用会话。
      this.active.delete(record.delegationId);
      return finished;
    });
    this.active.set(record.delegationId, { parentRunId, runtime, promise, started: false });
    return this.deliver(await promise);
  }

  /** 子任务提交后记录 Host 向父工具交付结果的 ACK。 */
  private async deliver(record: DelegationRecord): Promise<DelegationRecord> {
    return record.status === "SUCCEEDED" ? this.db.acknowledgeDelegation(record.delegationId) : record;
  }

  /** 在用户回答专家问题后唤醒原子任务；运行中子 Agent 由工具等待循环继续。 */
  async answer(delegationId: string, answer: string): Promise<DelegationRecord> {
    const record = await this.db.answerDelegation(delegationId, answer);
    await this.emit(record, "session.delegation.answered", { status: record.status });
    return record;
  }

  /** 持久化用户调整，并将其送入正在推理的子 Agent。 */
  async steer(delegationId: string, instruction: string): Promise<void> {
    const active = this.active.get(delegationId);
    if (!active?.started) throw new Error("DELEGATION_NOT_RUNNING");
    const { delegation, version } = await this.db.steerDelegation(delegationId, instruction);
    await active.runtime.steer(`用户调整指令 v${version}：${instruction}`);
    await this.db.markDelegationSteerDelivered(delegationId, version);
    await this.emit(delegation, "session.delegation.steered", { version });
  }

  /** 将父 Run 的取消传播给对应子 Agent。 */
  async cancelForParentRun(parentRunId: string, interrupted = false): Promise<void> {
    for (const record of await this.db.listDelegationsForParentRun(parentRunId)) {
      // Host 正常退出保留子任务持久状态，启动恢复再判定是否安全重排。
      if (!interrupted && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(record.status))
        await this.db.finishDelegation(record.delegationId, "CANCELLED", "PARENT_CANCELLED");
      await this.active
        .get(record.delegationId)
        ?.runtime.abort()
        .catch(() => {});
    }
  }

  /** 等待父 Run 的所有活动子任务连同运行资源收尾。 */
  async waitForParentRun(parentRunId: string): Promise<void> {
    const children = [...this.active.values()].filter((item) => item.parentRunId === parentRunId);
    // 执行失败已转换为子任务状态；仍抛出的资源清理/存储错误必须阻止父轮释放占用。
    await Promise.all(children.map((item) => item.promise));
  }

  /** 停止当前服务并等待活动资源收尾。 */
  async stop(): Promise<void> {
    this.beginStop();
    await Promise.allSettled([...this.active.values()].map(({ runtime }) => runtime.abort()));
    await Promise.allSettled([...this.active.values()].map(({ promise }) => promise));
  }

  /** 先阻止子任务把 Host 正常退出误判为用户取消。 */
  beginStop(): void {
    this.stopping = true;
  }

  /** 运行已冻结的专家子 Agent 并处理取消与结果。 */
  private async execute(
    record: DelegationRecord,
    parentPlan: ParentDelegationPlan,
    parentPrompt: string,
    childPrompt: string,
    contextPacket: DelegationContextPacket | null,
    resources: DelegationInputSnapshot["resources"],
    merchantContext: Awaited<ReturnType<typeof assembleMerchantContext>>,
    runtime: PiSdkRuntimeAdapter,
    parentAttempt: number,
    materials: NonNullable<DelegationInputSnapshot["materials"]>,
    signal?: AbortSignal,
  ): Promise<DelegationRecord> {
    /** 在父任务取消或失败时中止活动子 Agent。 */
    const abortChild = () => {
      void runtime.abort().catch(() => {});
    };
    signal?.addEventListener("abort", abortChild, { once: true });
    try {
      if (signal?.aborted) throw new Error("DELEGATION_CANCELLED");
      const childPlan = record.inputSnapshot
        ? await this.db.getDelegationPlan(record.delegationId)
        : this.childPlan(record, parentPlan, resources, runtime.getExtraToolExecutionPolicies());
      if (!childPlan) throw new Error("DELEGATION_CHILD_PLAN_CHANGED");
      // 委派只加载父轮受理时的精确版本；不能读取同稿件后来补充的最新要求。
      const taskContext = parentPlan.taskContext
        ? await this.db.getTaskContextSnapshot(record.parentSessionId, parentPlan.taskContext)
        : null;
      const snapshot = this.inputSnapshot(
        record,
        parentPlan,
        parentPrompt,
        childPrompt,
        childPlan,
        resources,
        contextPacket,
      );
      if (
        record.inputSnapshot?.childPlanHash !== undefined &&
        record.inputSnapshot.childPlanHash !== childPlan.planHash
      )
        throw new Error("DELEGATION_CHILD_PLAN_CHANGED");
      if ("version" in record.input && record.input.version === 3) {
        snapshot.materials = materials;
        snapshot.contract = {
          id: record.input.contractId,
          version: record.input.contractVersion,
          schemaHash: sha256(canonicalJson(expertContract(record.targetExpertId, record.input.contractId))),
        };
      }
      // 子 Agent 启动前先固定可见输入，失败或重启后仍能解释它实际看到了什么。
      if (!record.inputSnapshot)
        await this.db.freezeDelegationInput(record.delegationId, snapshot, JSON.stringify(childPlan));
      const waitingForAnswer = Boolean(record.questionText && !record.answerText);
      if (waitingForAnswer) {
        await this.emit(record, "session.delegation.started", { status: "WAITING_INPUT" });
        await this.emit(record, "session.delegation.question", {
          question: record.questionText,
          status: "WAITING_INPUT",
        });
      }
      if (waitingForAnswer) await this.waitForAnswer(record.delegationId, signal);
      const instructions = await this.db.listDelegationInstructions(record.delegationId);
      const started = await this.db.startDelegation(record.delegationId);
      if (started.status !== "RUNNING") return started;
      if (!waitingForAnswer) await this.emit(record, "session.delegation.started", { status: "RUNNING" });
      const taskRef = parentPlan.taskContext;
      const context = resolveRunContext({
        runId: record.childRunId,
        attempt: started.attempt,
        sessionId: record.childSessionId,
        workspace: await this.files.prepareWorkspace(record.childSessionId),
        historySnapshotRef: null,
        userPrompt: instructions.length
          ? `${childPrompt}\n\n用户追加输入（版本化记录）：${instructions.map((item) => `${item.kind} v${item.version}: ${item.content}`).join("；")}`
          : childPrompt,
        plan: childPlan,
        merchantContext,
        taskContext,
        taskContextSourceSessionId: record.parentSessionId,
        ...(taskRef &&
          parentPlan.runtime.adapterVersion.includes(":task-status-1:") && {
            /** 父子 Attempt 同时校验，不能由旧子尝试读取新父轮授权。 */
            currentTaskStatus: async () => {
              return this.db.getCurrentTaskStatus(record.parentSessionId, {
                runId: record.parentRunId,
                attempt: parentAttempt,
                taskContext: taskRef,
                delegationId: record.delegationId,
                delegationAttempt: started.attempt,
              });
            },
          }),
      });
      await runtime.start(context);
      const active = this.active.get(record.delegationId);
      if (active) active.started = true;
      if (
        signal?.aborted ||
        this.stopping ||
        (await this.db.getDelegationForTask(record.parentRunId, record.taskKey))?.status !== "RUNNING"
      ) {
        throw new Error("DELEGATION_CANCELLED");
      }
      await runtime.prompt(context.userPrompt, async (event) => this.emitChildToolEvent(started, event, parentAttempt));
      // 普通文本回复不是交接结果；必须由提交工具先把结构化结果落库。
      const submitted = await this.db.getDelegationForTask(record.parentRunId, record.taskKey);
      if (submitted?.status !== "SUCCEEDED") throw new Error("DELEGATION_RESULT_MISSING");
      await this.emit(submitted, "session.delegation.finished", { status: submitted.status });
      return submitted;
    } catch (error) {
      const submitted = await this.db.getDelegationForTask(record.parentRunId, record.taskKey);
      // 正常退出保留子任务原状态，启动对账会决定重试；不能把等待用户回答误记为失败。
      if (this.stopping && submitted) return submitted;
      // 提交成功后即使事件发送中断，也保留已提交事实而不改写为失败。
      if (submitted?.status === "SUCCEEDED") {
        await this.emit(submitted, "session.delegation.finished", { status: submitted.status });
        return submitted;
      }
      const cancelled = signal?.aborted || submitted?.status === "CANCELLED";
      const code =
        error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "DELEGATION_RUNTIME_FAILED";
      const finished = await this.db.finishDelegation(record.delegationId, cancelled ? "CANCELLED" : "FAILED", code);
      await this.emit(finished, "session.delegation.finished", {
        status: finished.status,
        errorCode: finished.errorCode,
      });
      return finished;
    } finally {
      signal?.removeEventListener("abort", abortChild);
      await runtime.stop();
    }
  }

  /** 等待持久化回答，取消或 Host 停止时结束等待。 */
  private async waitForAnswer(delegationId: string, signal?: AbortSignal): Promise<DelegationRecord> {
    while (!this.stopping && !signal?.aborted) {
      const record = await this.db.getDelegation(delegationId);
      if (!record || ["CANCELLED", "FAILED"].includes(record.status)) throw new Error("DELEGATION_CANCELLED");
      if (record.answerText) return record;
      await delay(500);
    }
    throw new Error("DELEGATION_CANCELLED");
  }

  /** 将固定专业契约与获准材料索引补入子任务，不把模型摘要当成事实。 */
  private contractPrompt(
    input: ExpertTaskV3,
    materials: NonNullable<DelegationInputSnapshot["materials"]>,
    useFewShot: boolean,
  ): string {
    const contract = expertContract(input.targetExpertId, input.contractId);
    const examples = useFewShot ? expertContractFewShotExamples(input.targetExpertId, input.contractId) : [];
    const fewShotPrompt = useFewShot
      ? `Few-shot示例（输入payload→输出structuredResult；仅示范字段映射和判断边界。内容均为虚构，不是本次任务事实或证据，不得复用示例中的实体、结论或ID）：${JSON.stringify(examples)}。`
      : "";
    const prompt = `\n\n正式提交协议使用 version=3。契约：${JSON.stringify(contract)}。专业参数：${JSON.stringify(input.payload)}。${fewShotPrompt}材料索引：${JSON.stringify(materials.map((item) => item.ref))}。正文/专家结果用 delegation_read_input 的 materialId 读取冻结文本；附件和公开证据仍通过对应受控工具读取。structuredResult 须满足上述 output Schema；summary/outcome/materialRefs/unmetCriterionIds/questions 均按提交工具 Schema 提供。READY必须questions=[]且unmetCriterionIds=[]，可选后续建议放summary或契约允许的内部说明；必要事实缺失且无法完成时用NEEDS_INPUT并列问题。提交成功后结束本次任务，不再次提交或修改已接纳结果；失败时按工具返回的具体约束修正。只能返回已有材料引用，不编造 Artifact 或已确认草稿。`;
    if (prompt.length > 16000) throw new Error("DELEGATION_CONTEXT_BUDGET_LOW");
    return prompt;
  }

  /** 从父权限、冻结稿件或同父正式结果取材料；模型自报的路径和 hash 不能授予读取权。 */
  private async resolveMaterials(
    sessionId: string,
    parentRunId: string,
    plan: ParentDelegationPlan,
    input: ExpertTaskV3,
    resources: DelegationInputSnapshot["resources"],
  ): Promise<NonNullable<DelegationInputSnapshot["materials"]>> {
    const materials: NonNullable<DelegationInputSnapshot["materials"]> = [];
    for (const ref of input.inputRefs) {
      if (ref.kind === "uploaded_text" || ref.kind === "public_evidence") {
        const source = resources.find((item) => item.type === ref.kind && item.id === ref.id);
        if (source?.sha256 !== ref.sha256 || ref.revision !== null) throw new Error("RESULT_SOURCE_INVALID");
        if (
          ref.kind === "uploaded_text" &&
          createHash("sha256")
            .update(await this.files.readBlob(ref.sha256))
            .digest("hex") !== ref.sha256
        )
          throw new Error("RESULT_SOURCE_INVALID");
        materials.push({ ref, text: "通过本次获准资料读取工具回读正文。" });
        continue;
      }
      if (ref.kind === "expert_result") {
        const source = await this.db.getDelegation(ref.id);
        const result = source?.result;
        if (
          source?.parentRunId !== parentRunId ||
          source.parentSessionId !== sessionId ||
          source.status !== "SUCCEEDED" ||
          !result ||
          !("version" in result) ||
          result.version !== 3 ||
          result.resultHash !== ref.sha256 ||
          result.attempt !== ref.revision ||
          sha256(canonicalJson(result.submission)) !== ref.sha256
        )
          throw new Error("RESULT_SOURCE_INVALID");
        materials.push({ ref, text: JSON.stringify(result.submission) });
        continue;
      }
      if (ref.kind === "content_draft") {
        const snapshot = plan.taskContext ? await this.db.getTaskContextSnapshot(sessionId, plan.taskContext) : null;
        const hasFrozenDraftAccess =
          snapshot?.carriers.some(
            (item) =>
              item.kind === "DRAFT" &&
              item.id === ref.id &&
              item.revision === ref.revision &&
              item.sha256 === ref.sha256,
          ) ?? false;
        const canReadCurrentDraft = plan.policy.allowedToolIds.includes("publication_task");
        // 普通父轮沿已有 STATUS 读取权限；内部业务父轮沿冻结引用读取，二者均不向子轮授予编排工具。
        if (!hasFrozenDraftAccess && !canReadCurrentDraft) throw new Error("DELEGATION_RESOURCE_NOT_AUTHORIZED");
        const source = await this.db.getContentDraft(sessionId, ref.id);
        if (!hasFrozenDraftAccess && source?.draft.currentRevision !== ref.revision)
          throw new Error("RESULT_SOURCE_INVALID");
        const revision = source?.revisions.find((item) => item.revision === ref.revision && item.sha256 === ref.sha256);
        if (!revision) throw new Error("RESULT_SOURCE_INVALID");
        materials.push({
          ref,
          text: JSON.stringify({ title: revision.title, body: revision.body, internalNotes: revision.internalNotes }),
        });
        continue;
      }
      const artifact = await this.db.getArtifact(ref.id);
      if (
        !plan.policy.allowedArtifacts.some((item) => item.artifactId === ref.id && item.blobHash === ref.sha256) ||
        artifact?.sessionId !== sessionId ||
        artifact.status !== "READY" ||
        artifact.mimeType !== "text/plain" ||
        artifact.sizeBytes > 2 * 1024 * 1024 ||
        ref.revision !== null ||
        !plan.policy.allowedToolIds.includes("read_uploaded_text") ||
        !this.allowedChildTools(plan, input.targetExpertId).includes("read_uploaded_text")
      )
        throw new Error("RESULT_SOURCE_INVALID");
      const bytes = await this.files.readBlob(artifact.blobHash);
      if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("RESULT_SOURCE_INVALID");
      materials.push({ ref, text: bytes.toString("utf8") });
    }
    if (JSON.stringify(materials).length > 120000) throw new Error("DELEGATION_CONTEXT_BUDGET_LOW");
    return materials;
  }

  /** 新提交沿同一 delegation 记录保存；结果引用由 Host 根据实际接纳记录生成。 */
  private submitContractTool(
    record: DelegationRecord,
    input: ExpertTaskV3,
    materials: NonNullable<DelegationInputSnapshot["materials"]>,
    parentAttempt: number,
    formalJob?: TextGenerationJobRecord,
    researchMemory?: ResearchMemoryController,
  ): HostToolDefinition {
    let invalidSubmissions = 0;
    /** 成功回执始终引用已落库结果，重复提交不覆盖原稿或重新消耗纠正次数。 */
    const receipt = (saved: DelegationRecord) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            delegationId: saved.delegationId,
            status: saved.status,
            resultRef: saved.result && "resultRef" in saved.result ? saved.result.resultRef : null,
            notice: "专家结果已保存，请结束本次任务；重复提交复用此结果，不更新原结果。",
          }),
        },
      ],
      details: { delegationId: saved.delegationId, status: saved.status },
    });
    return {
      name: "delegation_submit",
      label: "提交专家结果",
      description: "按本次固定角色契约提交专业结果和未满足条件；执行提交成功不代表业务质量通过。",
      parameters: Type.Object(
        {
          ...expertSubmissionV3Schema.properties,
          structuredResult: expertContract(input.targetExpertId, input.contractId).output,
        },
        { additionalProperties: false },
      ),
      /** 校验固定 Schema 和来源白名单，带子 Attempt 保存结构化结果与兼容展示文本。 */
      execute: async (_toolCallId, params, signal) => {
        if (signal?.aborted) throw new Error("DELEGATION_CANCELLED");
        const current = await this.db.getDelegation(record.delegationId);
        if (current?.status === "SUCCEEDED") {
          // 只复用当前父子尝试的持久成功结果；旧 Attempt 或父取消不能借重试获取成功回执。
          const parent = await this.db.getRun(record.parentRunId);
          if (current.attempt !== record.attempt + 1) throw new Error("DELEGATION_ATTEMPT_CHANGED");
          if (parent?.status !== "RUNNING" || parent.attempt !== parentAttempt || parent.cancelRequestedAt)
            throw new Error("DELEGATION_PARENT_UNAVAILABLE");
          return receipt(current);
        }
        let submission = params as ExpertSubmissionV3;
        try {
          validateExpertSubmission(
            input,
            submission,
            researchMemory?.materialRefs() ?? materials.map((item) => item.ref),
          );
          if (researchMemory) {
            const references = researchMemory.materialRefs();
            const known = new Set(references.map((ref) => ref.id));
            const findings = submission.structuredResult.findings as Array<{ area?: string; evidenceIds: string[] }>;
            researchMemory.assertImageFindings(findings);
            const focusAreas = input.payload.focusAreas as string[] | undefined;
            if (
              submission.outcome === "READY" &&
              focusAreas?.some((area) => !findings.some((finding) => finding.area === area))
            )
              throw new Error(
                "EXPERT_CONTRACT_INVALID: READY必须覆盖focusAreas；缺少图片或证据时提交PARTIAL并列出unknowns。",
              );
            if (findings.some((finding) => finding.evidenceIds.some((id) => !known.has(id))))
              throw new Error("RESULT_SOURCE_INVALID");
            const used = new Set(findings.flatMap((finding) => finding.evidenceIds));
            const refs = new Map(submission.materialRefs.map((ref) => [ref.id, ref]));
            for (const ref of references) if (used.has(ref.id)) refs.set(ref.id, ref);
            if (refs.size > 20) throw new Error("RESULT_SOURCE_LIMIT");
            submission = { ...submission, materialRefs: [...refs.values()] };
          }
          if (formalJob) validatePublicationExpertOutput(formalJob, submission.structuredResult, submission.outcome);
        } catch (error) {
          // 同一固定输入最多纠正两次；不能让反复非法提交无限消耗模型或变相更换材料。
          invalidSubmissions += 1;
          if (invalidSubmissions > 2)
            void this.active
              .get(record.delegationId)
              ?.runtime.abort()
              .catch(() => {
                process.stderr.write(`[delegation ${record.delegationId}] 非法提交后终止失败\n`);
              });
          throw error;
        }
        const resultHash = sha256(canonicalJson(submission));
        const attempt = record.attempt + 1;
        const result: AcceptedExpertResultV3 = {
          version: 3,
          delegationId: record.delegationId,
          childRunId: record.childRunId,
          attempt,
          contractId: input.contractId,
          contractVersion: input.contractVersion,
          inputHash: record.inputHash,
          resultHash,
          submission,
          acceptedAt: new Date().toISOString(),
          resultRef: { kind: "expert_result", id: record.delegationId, revision: attempt, sha256: resultHash },
          output:
            input.targetExpertId === "writer"
              ? {
                  type: "text_draft",
                  title:
                    input.contractId === "writer.patch.v1" ? "局部返修补丁" : String(submission.structuredResult.title),
                  content:
                    input.contractId === "writer.patch.v1"
                      ? JSON.stringify(submission.structuredResult)
                      : String(submission.structuredResult.body),
                }
              : { type: "text_report", content: JSON.stringify(submission.structuredResult) },
          completion: submission.outcome === "READY" ? "complete" : "partial",
          unmetCriterionIds: submission.unmetCriterionIds,
        };
        const saved = await this.db.submitDelegation(record.delegationId, result, attempt, parentAttempt);
        return receipt(saved);
      },
    };
  }

  /** 检查委派目标、验收条件和任务单长度是否符合契约。 */
  private validateTask(input: DelegationTaskV2): void {
    if (
      input.version !== 2 ||
      (input.taskKey !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.taskKey)) ||
      !["writer", "visual", "reviewer", "researcher"].includes(input.targetExpertId) ||
      input.expectedOutput !== (input.targetExpertId === "writer" ? "text_draft" : "text_report") ||
      !input.task.trim() ||
      !input.criteria.length ||
      input.criteria.some((criterion) => !criterion.id.trim() || !criterion.text.trim()) ||
      (input.contextSummary !== undefined && !input.contextSummary.trim()) ||
      (input.missingInformation !== undefined &&
        (input.missingInformation.length > 10 ||
          input.missingInformation.some((item) => !item.trim() || item.length > 300)))
    )
      throw new Error("DELEGATION_INPUT_INVALID");
    if (new Set(input.criteria.map((criterion) => criterion.id)).size !== input.criteria.length)
      throw new Error("DELEGATION_CRITERIA_DUPLICATE");
    if (new Set(input.inputRefs.map((ref) => `${ref.type}:${ref.id}`)).size !== input.inputRefs.length)
      throw new Error("DELEGATION_RESOURCE_DUPLICATE");
  }

  /** 只解析父 Run 已授权的附件与公开证据引用。 */
  private async resolveResources(
    parentSessionId: string,
    merchantId: string | null,
    plan: ParentDelegationPlan,
    input: DelegationTaskV2,
  ): Promise<DelegationInputSnapshot["resources"]> {
    return Promise.all(
      input.inputRefs.map(async (ref) => {
        if (ref.type === "uploaded_text") {
          // 只接受父 Run 冻结清单中的 READY 文本附件，并复核 Blob 摘要。
          if (
            !this.allowedChildTools(plan, input.targetExpertId).includes("read_uploaded_text") ||
            !plan.policy.allowedToolIds.includes("read_uploaded_text")
          )
            throw new Error("DELEGATION_RESOURCE_NOT_AUTHORIZED");
          const allowed = plan.policy.allowedArtifacts.find((artifact) => artifact.artifactId === ref.id);
          const artifact = await this.db.getArtifact(ref.id);
          if (
            !allowed ||
            artifact?.sessionId !== parentSessionId ||
            artifact.status !== "READY" ||
            artifact.mimeType !== "text/plain" ||
            artifact.sizeBytes > 2 * 1024 * 1024 ||
            artifact.blobHash !== allowed.blobHash
          )
            throw new Error("DELEGATION_RESOURCE_NOT_AUTHORIZED");
          return { type: ref.type, id: ref.id, sha256: artifact.blobHash };
        }
        if (
          !this.allowedChildTools(plan, input.targetExpertId).includes("evidence_get") ||
          !plan.policy.allowedToolIds.includes("evidence_get")
        )
          throw new Error("DELEGATION_RESOURCE_NOT_AUTHORIZED");
        const evidence = await this.db.getPublicEvidence(ref.id);
        // 公开证据按商家归属和实际采集状态授权，不能只凭模型提供的 ID。
        if (
          !evidence ||
          (merchantId
            ? evidence.merchantId !== merchantId
            : evidence.merchantId !== null || evidence.sessionId !== parentSessionId) ||
          !["COLLECTED", "LIMITED"].includes(evidence.status)
        )
          throw new Error("DELEGATION_RESOURCE_NOT_AUTHORIZED");
        return { type: ref.type, id: ref.id, sha256: sha256(JSON.stringify(evidence)) };
      }),
    );
  }

  /** 构造独立子 Run 的冻结模型、工具和来源计划。 */
  private childPlan(
    record: DelegationRecord,
    parent: ParentDelegationPlan,
    resources: DelegationInputSnapshot["resources"],
    extraToolExecutionPolicies: Record<string, ToolExecutionPolicy>,
  ) {
    const { providerId: _providerId, configFingerprint: _fingerprint, ...model } = parent.model;
    const hasUploadedText = resources.some((ref) => ref.type === "uploaded_text");
    const hasPublicEvidence = resources.some((ref) => ref.type === "public_evidence");
    const childToolIds = this.allowedChildTools(parent, record.targetExpertId).filter(
      (id) =>
        id !== "publication_task" &&
        parent.policy.allowedToolIds.includes(id) &&
        (hasUploadedText || !["list_uploaded_files", "read_uploaded_text"].includes(id)) &&
        (hasPublicEvidence || record.targetExpertId === "researcher" || id !== "evidence_get"),
    );
    if (record.targetExpertId === "researcher" && "version" in record.input && record.input.version === 3) {
      const required = (record.input.payload.requiredToolIds ?? []) as string[];
      const missing = required.filter((id) => !childToolIds.includes(id));
      if (missing.length) throw new Error("RESEARCH_CAPABILITY_UNAVAILABLE");
    }
    return createRuntimePlan({
      runId: record.childRunId,
      messageId: `msg_${record.childRunId.slice(4)}`,
      createdAt: record.createdAt,
      sessionId: record.childSessionId,
      scope: parent.session.scope,
      ownerId: parent.session.ownerId,
      pendingPredecessorRunId: null,
      config: {
        model,
        adapterVersion: parent.runtime.adapterVersion,
        memorySearch: parent.runtime.memorySearch,
        toolsetVersion: parent.runtime.toolsetVersion,
        ...(parent.runtime.toolExecutionPolicies && {
          toolExecutionPolicies: { ...parent.runtime.toolExecutionPolicies, ...extraToolExecutionPolicies },
        }),
        toolIds: [
          ...childToolIds,
          "delegation_submit",
          "delegation_read_input",
          "delegation_ask_user",
          ...(record.targetExpertId === "researcher" ? ["research_memory_update"] : []),
        ],
        skills: parent.capabilities.expertGroup[record.targetExpertId]?.skills ?? parent.capabilities.skills,
        expert: parent.capabilities.expertGroup[record.targetExpertId] ?? null,
        expertGroup: null,
        expertSelection: record.targetExpertId,
        expertMethods: [],
      },
      prompt: {
        content: parent.instructions.systemPrompt,
        revision: parent.instructions.revision,
        sha256: parent.instructions.sha256,
        updatedAt: parent.createdAt,
      },
      // 正式步骤的图片已由任务受理冻结；审核子轮必须获得同一批真实像素，否则覆盖声明不成立。
      artifacts:
        parent.schemaVersion === 6 && parent.publicationExpert
          ? parent.policy.allowedArtifacts
          : parent.policy.allowedArtifacts.filter((artifact) =>
              resources.some((ref) => ref.type === "uploaded_text" && ref.id === artifact.artifactId),
            ),
      ...(parent.merchant && { merchantContext: parent.merchant }),
      ...(parent.taskContext && { taskContext: parent.taskContext }),
    });
  }

  /** 按预算组装写作子 Agent 的指令和验收条件。 */
  private childPrompt(
    input: DelegationTaskV2,
    parentPrompt: string,
    parentPlan: ParentDelegationPlan,
    contextPacket: DelegationContextPacket | null,
    version: 2 | 3 = 2,
  ): string {
    const base = [
      `你是独立${input.targetExpertId}子 Agent。只完成本次子任务，不继续委派；缺少事实时明确列为待用户补充，不编造商家资料或图片生成结果。`,
      `专家任务：${input.task}`,
      ...(parentPlan.continuation ? [buildContinuationContext(parentPlan.continuation)] : []),
      `验收条件：${input.criteria.map((item) => `${item.id}: ${item.text}`).join("；")}`,
      `指定资料：${input.inputRefs.map((ref) => `${ref.type}:${ref.id}`).join("、") || "无"}`,
      ...(contextPacket
        ? [
            `Host 核实归属和哈希的来源包：${JSON.stringify(contextPacket)}。recentMessages 中 assistant 片段是模型输出，不代表商家已确认事实；declaredMissingInformation 是主 Agent 声明的待补项。缺资料时先完成可做部分，并标出未满足条件。`,
          ]
        : input.missingInformation?.length
          ? [`主 Agent 声明的待补信息（未经核实）：${input.missingInformation.join("；")}`]
          : []),
      `关键事实无法判断时可用 delegation_ask_user 向用户提问；拿到回答后继续。完成后调用 delegation_submit 提交${version === 3 ? "契约规定的 structuredResult" : input.expectedOutput}和未满足的验收条件 ID；普通回复不能替代提交。`,
    ].join("\n\n");
    const available = parentPlan.model.contextWindow - parentPlan.model.maxTokens;
    const reserve = Math.min(4096, Math.floor(available / 3));
    const budget = Math.min(8192, Math.floor((available - reserve) / 2));
    if (budget < 512) throw new Error("DELEGATION_CONTEXT_BUDGET_LOW");
    const background = input.contextSummary ? `\n\n主 Agent 提供的背景摘要（未经核实）：${input.contextSummary}` : "";
    const sourceLabel =
      parentPlan.schemaVersion === 6 && parentPlan.publicationExpert
        ? `Host 冻结的正式节点输入（消息 ${parentPlan.messageId}；其中组装说明不是用户原话）`
        : `父轮用户请求原文（消息 ${parentPlan.messageId}）`;
    const full = `${base}${background}\n\n${sourceLabel}：${parentPrompt}`;
    if (this.estimatedTokens(full) <= budget) return full;
    // 超预算时摘要只作导航，子 Agent 仍可用受控工具分段核对原文。
    if (!input.contextSummary) throw new Error("DELEGATION_SUMMARY_REQUIRED");
    const summary = `${base}${background}\n\n父轮用户请求原文见 delegation_read_input，来源消息 ${parentPlan.messageId}；涉及事实或限制时按需回读原文。`;
    if (this.estimatedTokens(summary) > budget) throw new Error("DELEGATION_CONTEXT_BUDGET_LOW");
    const characters = Array.from(parentPrompt);
    let excerptLength = Math.min(1200, Math.floor(characters.length / 2));
    while (excerptLength > 0) {
      const excerpt = `\n\n原文开头：${characters.slice(0, excerptLength).join("")}\n原文结尾：${characters.slice(-excerptLength).join("")}`;
      if (this.estimatedTokens(summary + excerpt) <= budget) return summary + excerpt;
      excerptLength = Math.floor(excerptLength / 2);
    }
    return summary;
  }

  /** 保守估计文本令牌数，控制子任务输入预算。 */
  private estimatedTokens(value: string): number {
    const sdkEstimate = estimateTokens({ role: "user", content: value, timestamp: 0 });
    const unicodeEstimate = Array.from(value).reduce(
      (sum, character) => sum + (character.charCodeAt(0) > 127 ? 1 : 0.25),
      0,
    );
    return Math.max(sdkEstimate, Math.ceil(unicodeEstimate));
  }

  /** 冻结委派时实际可见的用户原文、摘要和引用。 */
  private inputSnapshot(
    record: DelegationRecord,
    parent: ParentDelegationPlan,
    parentPrompt: string,
    childPrompt: string,
    childPlan: ReturnType<DelegationService["childPlan"]>,
    resources: DelegationInputSnapshot["resources"],
    contextPacket: DelegationContextPacket | null,
  ): DelegationInputSnapshot {
    const expert = parent.capabilities.expertGroup[record.targetExpertId];
    if (!expert) throw new Error("DELEGATION_NOT_ALLOWED");
    return {
      version: 2,
      parentPlanHash: parent.planHash,
      parentMessageId: parent.messageId,
      parentPrompt,
      childPrompt,
      childPlanHash: childPlan.planHash,
      merchantSnapshot: parent.merchant ? { id: parent.merchant.snapshotId, sha256: parent.merchant.sha256 } : null,
      resources,
      expertSha256: sha256(`${expert.sharedSha256}:${expert.promptSha256}`),
      skills: (expert?.skills ?? parent.capabilities.skills).map((skill) => ({
        name: skill.name,
        sha256: skill.sha256,
      })),
      allowedToolIds: childPlan.policy.allowedToolIds,
      ...(contextPacket && { contextPacket }),
    };
  }

  /** 由 Host 根据已校验的父 Plan 和资源构造有界、可追溯的子任务来源包。 */
  private async contextPacket(
    input: DelegationTaskV2,
    parentPrompt: string,
    plan: ParentDelegationPlan,
    resources: DelegationInputSnapshot["resources"],
  ): Promise<DelegationContextPacket> {
    return {
      version: 1,
      parentMessage: { id: plan.messageId, sha256: sha256(parentPrompt) },
      recentMessages: await this.db.listRecentMessagesForDelegation(plan.session.sessionId, plan.messageId),
      merchantSnapshot: plan.merchant ? { id: plan.merchant.snapshotId, sha256: plan.merchant.sha256 } : null,
      readableResources: resources,
      declaredMissingInformation: input.missingInformation ?? [],
    };
  }

  /** 旧 Plan 沿用共同白名单，新 Plan 使用目标角色的独立白名单。 */
  private allowedChildTools(plan: ParentDelegationPlan, role: DelegationTaskV2["targetExpertId"]): string[] {
    return plan.schemaVersion === 6
      ? (plan.capabilities.expertGroup.toolIdsByRole[role] ?? [])
      : plan.capabilities.expertGroup.writerToolIds;
  }

  /** 构造子 Agent 分段回读原文或 V3 固定材料的受控工具，旧协议保持原 Schema。 */
  private readInputTool(
    delegationId: string,
    parentPrompt: string,
    messageId: string,
    allowMaterials = false,
  ): HostToolDefinition {
    return {
      name: "delegation_read_input",
      label: "回读委派原文",
      description:
        "按字符范围读取本次冻结父轮输入；读原文只传offset/limit，省略materialId。materialId仅接受本次材料索引的真实ID，消息ID不是材料ID；摘要不能替代原文。",
      promptSnippet: "读取本次委派的原始用户请求",
      parameters: allowMaterials ? readInputSchema : legacyReadInputSchema,
      /** 仅返回本次冻结原文或已分配材料片段，V2 不开放材料读取。 */
      execute: async (_toolCallId, params: Static<typeof readInputSchema>, signal) => {
        if (signal?.aborted) throw new Error("DELEGATION_CANCELLED");
        if (params.materialId && !allowMaterials) throw new Error("RESULT_SOURCE_INVALID");
        const material = params.materialId
          ? (await this.db.getDelegation(delegationId))?.inputSnapshot?.materials?.find(
              (item) => item.ref.id === params.materialId,
            )
          : null;
        if (params.materialId && !material) throw new Error("RESULT_SOURCE_INVALID");
        const characters = Array.from(material?.text ?? parentPrompt);
        const offset = Math.min(params.offset ?? 0, characters.length);
        const nextOffset = Math.min(offset + (params.limit ?? 12000), characters.length);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                delegationId,
                messageId,
                offset,
                nextOffset,
                totalCharacters: characters.length,
                text: characters.slice(offset, nextOffset).join(""),
              }),
            },
          ],
          details: { delegationId, messageId, offset, nextOffset },
        };
      },
    };
  }

  /** 子 Agent 可显式暂停并向当前用户索取一个缺失事实。 */
  private askUserTool(record: DelegationRecord): HostToolDefinition {
    return {
      name: "delegation_ask_user",
      label: "向用户提问",
      description: "必要事实缺失时暂停当前专家任务，等待用户在会话中回答。",
      promptSnippet: "只在缺少关键事实无法继续时使用",
      parameters: askUserSchema,
      /** 将问题持久化并等待同一子任务的版本化回答。 */
      execute: async (_toolCallId, params: Static<typeof askUserSchema>, signal) => {
        const asked = await this.db.askDelegation(record.delegationId, params.question.trim());
        await this.emit(asked, "session.delegation.question", { question: asked.questionText, status: asked.status });
        const answered = asked.answerText ? asked : await this.waitForAnswer(record.delegationId, signal);
        return {
          content: [{ type: "text", text: `用户回答：${answered.answerText}` }],
          details: { delegationId: record.delegationId, answerRecorded: true },
        };
      },
    };
  }

  /** 构造子 Agent 结构化提交工具并保存真实结果。 */
  private submitTool(record: DelegationRecord, parentAttempt: number): HostToolDefinition {
    return {
      name: "delegation_submit",
      label: "提交专家结果",
      description: "提交本次任务要求的文本草稿或报告、未满足的验收条件 ID 和备注；提交后结束本轮。",
      promptSnippet: "提交最终专家结果",
      parameters: submitSchema,
      /** 校验并持久化子 Agent 提交的草稿与验收状态。 */
      execute: async (_toolCallId, params: Static<typeof submitSchema>, signal) => {
        if (signal?.aborted) throw new Error("DELEGATION_CANCELLED");
        if (!("version" in record.input) || record.input.version !== 2) throw new Error("DELEGATION_INPUT_UNSUPPORTED");
        if (!params.output.content.trim()) throw new Error("DELEGATION_RESULT_INVALID");
        if (params.output.type !== record.input.expectedOutput) throw new Error("DELEGATION_RESULT_INVALID");
        const criterionIds = new Set(record.input.criteria.map((criterion) => criterion.id));
        if (
          new Set(params.unmetCriterionIds).size !== params.unmetCriterionIds.length ||
          params.unmetCriterionIds.some((id) => !criterionIds.has(id))
        )
          throw new Error("DELEGATION_CRITERIA_INVALID");
        const result = await this.db.submitDelegation(
          record.delegationId,
          {
            version: 2,
            output: {
              type: params.output.type,
              ...(params.output.title && { title: params.output.title }),
              content: params.output.content,
            },
            completion: params.unmetCriterionIds.length ? "partial" : "complete",
            unmetCriterionIds: params.unmetCriterionIds,
            notes: params.notes,
          },
          record.attempt + 1,
          parentAttempt,
        );
        return {
          content: [
            { type: "text", text: JSON.stringify({ delegationId: record.delegationId, status: result.status }) },
          ],
          details: { delegationId: record.delegationId, status: result.status },
        };
      },
    };
  }

  // 子 Run 不进入普通 Run 调度表，工具事件挂在父会话上供实时推送与刷新回放。
  private async emitChildToolEvent(
    record: DelegationRecord,
    event: PiRuntimeEvent,
    parentAttempt: number,
  ): Promise<void> {
    /** SDK 回调绑定原父 Attempt，晚到事件不能落入重试后的父轮。 */
    const emit = (type: string, details: Record<string, unknown>) => this.emit(record, type, details, parentAttempt);
    if (event.type === "task.status.observed") {
      await emit("session.task.status.observed", {
        ...event,
        attempt: record.attempt,
        snapshotScope: "CHILD_ATTEMPT",
      });
      return;
    }
    if (event.type === "context.measured" || event.type === "context.compressed") {
      await emit(event.type === "context.measured" ? "session.context.measured" : "session.context.compressed", {
        ...event.measurement,
        attempt: record.attempt,
        snapshotScope: "CHILD_ATTEMPT",
      });
      return;
    }
    if (event.type === "microcompact.completed") {
      await emit("session.microcompact.completed", {
        ...event.record,
        attempt: record.attempt,
        snapshotScope: "CHILD_ATTEMPT",
      });
      return;
    }
    if (event.type === "tool.timeout") {
      await emit("session.tool.timeout", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        errorCode: "TOOL_TIMEOUT",
      });
      return;
    }
    if (event.type !== "tool.started" && event.type !== "tool.completed") return;
    await emit(event.type === "tool.started" ? "session.tool.started" : "session.tool.completed", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.type === "tool.completed" && { isError: event.isError }),
      ...(event.type === "tool.completed" && event.execution && { execution: event.execution }),
      ...(event.skill && {
        skillName: event.skill.name,
        skillPath: event.skill.path,
        skillSha256: event.skill.sha256,
      }),
    });
  }

  /** 持久化委派生命周期事件并推送给页面。 */
  private async emit(
    record: DelegationRecord,
    type: string,
    details: Record<string, unknown>,
    expectedParentAttempt?: number,
  ): Promise<void> {
    this.publish(
      await this.db.appendEvent(
        record.parentSessionId,
        record.parentRunId,
        type,
        {
          delegationId: record.delegationId,
          childRunId: record.childRunId,
          targetExpertId: record.targetExpertId,
          ...details,
        },
        expectedParentAttempt,
      ),
    );
  }
}

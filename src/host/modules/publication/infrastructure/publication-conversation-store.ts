import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  GenerationJobRecord,
  MerchantCatalogEntry,
  TextGenerationJobRecord,
} from "../../../../shared/contracts.js";
import type { PublicationDetail, PublicationFields, PublicationReview } from "../../../../shared/publication.js";
import type {
  PublicationAction,
  PublicationConversationFlow,
  PublicationConversationInput,
} from "../../../../shared/publication-conversation.js";
import { type PublicationRepairBasis, publicationRepairSchema } from "../../../../shared/publication-repair.js";
import type { TextTaskSource } from "../../../../shared/topics.js";
import { taskContextRef, taskRequirementsPrompt } from "../../../runtime/context/task-context.js";
import { canonicalJson, sha256 } from "../../../runtime/execution/runtime-plan.js";
import type { createGenerationOperations } from "../../media/infrastructure/generation-store.js";
import { freezeMerchantProfile } from "../../research/infrastructure/topic-store.js";
import type { createTaskContextOperations } from "../../sessions/infrastructure/task-context-store.js";
import {
  createTaskExecutionOperations,
  enableExistingTaskExecution,
  initialTaskExecution,
} from "../../sessions/infrastructure/task-execution-store.js";
import {
  PUBLICATION_CONVERSATION_VERSION,
  parsePublicationConversation,
  publicationConversationPrompt,
} from "../application/publication-conversation.js";
import { PUBLICATION_REPAIR_VERSION } from "../domain/publication-repair.js";
import {
  REVIEW_CONTRACT_HASH,
  REVIEW_RECHECK_CONTRACT_HASH,
  REVIEW_RULES_HASH,
} from "./publication-review-contract.js";
import type { createPublicationReviewOperations } from "./publication-review-store.js";
import { type createPublicationOperations, publicationHash } from "./publication-store.js";
import type { createTextGenerationOperations } from "./text-generation-store.js";

type Row = Record<string, unknown>;
type Stores = {
  text: ReturnType<typeof createTextGenerationOperations>;
  publication: ReturnType<typeof createPublicationOperations>;
  review: ReturnType<typeof createPublicationReviewOperations>;
  image: ReturnType<typeof createGenerationOperations>;
  catalog: (merchantId: string) => MerchantCatalogEntry[];
  context: ReturnType<typeof createTaskContextOperations>;
};

/** 将 Agent 操作计划接到既有持久任务；步骤键固定，进程中断不会重复外发。 */
export function createPublicationConversationOperations(
  db: DatabaseSync,
  transaction: <T>(operation: () => T) => T,
  stores: Stores,
) {
  const execution = createTaskExecutionOperations(db, transaction);
  /** 复核活动会话，任务ID或稿件ID不能授予跨会话访问权。 */
  function activeSession(sessionId: string): Row {
    const session = db.prepare("SELECT * FROM session WHERE session_id=?").get(sessionId) as Row | undefined;
    if (!session) throw new Error("SESSION_NOT_FOUND");
    if (session.lifecycle_status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    return session;
  }

  /** 普通聊天只引用本轮真实原话与冻结授权，模型组装要求不升级为用户事实。 */
  function chatOrigin(sessionId: string, runId?: string) {
    if (!runId) return null;
    const run = db.prepare("SELECT * FROM agent_run WHERE run_id=? AND session_id=?").get(runId, sessionId) as
      | Row
      | undefined;
    const plan = run ? JSON.parse(String(run.runtime_plan_json)) : null;
    if (run?.status !== "RUNNING" || !plan?.policy.allowedToolIds.includes("publication_task"))
      throw new Error("TOOL_PUBLICATION_NOT_ALLOWED");
    const user = db.prepare("SELECT content_json FROM message WHERE run_id=? AND role='user'").get(runId) as
      | Row
      | undefined;
    if (!user) throw new Error("RUN_INPUT_MISSING");
    const history = (
      db
        .prepare(
          "SELECT m.role,m.content_json FROM message m LEFT JOIN generation_job g ON g.source_run_id=m.run_id WHERE m.session_id=? AND m.created_at<=? AND g.job_id IS NULL ORDER BY m.created_at DESC LIMIT 12",
        )
        .all(sessionId, String(run.created_at)) as Row[]
    )
      .reverse()
      .map((item) => ({
        role: item.role,
        text: String(JSON.parse(String(item.content_json)).text ?? "").slice(0, 2000),
      }));
    const references = (plan.policy.allowedArtifacts as Array<{ artifactId: string; blobHash: string }>).map((ref) => {
      const artifact = db
        .prepare("SELECT * FROM artifact WHERE artifact_id=? AND session_id=? AND status='READY' AND blob_hash=?")
        .get(ref.artifactId, sessionId, ref.blobHash) as Row | undefined;
      if (!artifact) throw new Error("RUN_CONTEXT_ARTIFACT_INVALID");
      return { artifactId: ref.artifactId, blobHash: ref.blobHash, mimeType: String(artifact.mime_type) };
    });
    const internal = db
      .prepare("SELECT source_json FROM generation_job WHERE source_run_id=? AND purpose='RESEARCH_CONTINUATION'")
      .get(runId);
    const research = internal?.source_json
      ? (JSON.parse(String(internal.source_json)) as TextTaskSource).researchContinuation
      : null;
    const original = research
      ? db
          .prepare("SELECT content_json FROM message WHERE message_id=? AND run_id=? AND session_id=?")
          .get(research.original.originMessageId, research.original.originRunId, sessionId)
      : null;
    if (research && !original) throw new Error("RESEARCH_SOURCE_INVALID");
    // 研究唤醒中的Host说明和专业判断不升级为用户原话；研究结果作为单独资料继续传递。
    return {
      userText: String(JSON.parse(String((original ?? user).content_json)).text ?? ""),
      history,
      references,
      ...(research && {
        researchRootJobId: research.researchJobId,
        researchContinuation: research,
        researchContext: String(JSON.parse(String(user.content_json)).text),
      }),
    };
  }

  /** 读取本会话的对话任务及其持久步骤。 */
  function requireJob(sessionId: string, jobId: string): TextGenerationJobRecord {
    const job = stores.text.readTextGenerationJob(sessionId, jobId);
    if (job?.purpose !== "PUBLICATION_CHAT" || !job.source?.workflow) throw new Error("GENERATION_JOB_NOT_FOUND");
    return job;
  }

  /** 同一写入保存执行位置和展示回执，状态不依赖页面轮询。 */
  function save(job: TextGenerationJobRecord, flow: PublicationConversationFlow, now: string): void {
    const stored = JSON.parse(
      String((db.prepare("SELECT source_json FROM generation_job WHERE job_id=?").get(job.jobId) as Row).source_json),
    ) as TextTaskSource;
    const source = {
      ...stored,
      ...job.source,
      executionControl: stored.executionControl,
      delivery: stored.delivery,
      workflow: flow,
    };
    db.prepare(
      "UPDATE generation_job SET source_json=?,result_draft_id=?,updated_at=?,error_code=? WHERE job_id=?",
    ).run(JSON.stringify(source), flow.draftId, now, flow.errorCode ?? null, job.jobId);
  }

  /** 校验下一步仍操作上一步固定的正文与编排，外部编辑不能被静默覆盖。 */
  function expectedDetail(job: TextGenerationJobRecord, flow: PublicationConversationFlow): PublicationDetail {
    activeSession(job.sessionId);
    if (!flow.draftId) throw new Error("CONTENT_DRAFT_NOT_FOUND");
    const detail = stores.publication.getPublication(job.sessionId, flow.draftId);
    if (detail.draft.currentRevision !== flow.draftRevision || detail.publication.revision !== flow.publicationRevision)
      throw new Error("PUBLICATION_REVISION_CONFLICT");
    return detail;
  }

  /** 步骤受理前优先查询稳定键，覆盖已写子任务但尚未保存父位置的中断窗口。 */
  function existingChild(
    job: TextGenerationJobRecord,
    key: string,
  ): TextGenerationJobRecord | GenerationJobRecord | null {
    const row = db
      .prepare("SELECT job_id,kind FROM generation_job WHERE session_id=? AND request_key=?")
      .get(job.sessionId, key) as Row | undefined;
    if (!row) return null;
    return row.kind === "IMAGE"
      ? stores.image.getGenerationJob(job.sessionId, String(row.job_id))
      : stores.text.readTextGenerationJob(job.sessionId, String(row.job_id));
  }

  /** 子任务启动前冻结父要求，旧子任务恢复时不重新拼接或读取最新版本。 */
  function freezeChildContext(job: TextGenerationJobRecord, child: TextGenerationJobRecord): void {
    const ref = job.source?.taskContext;
    if (!ref) return;
    if (child.source?.parentConversationJobId === job.jobId) {
      if (JSON.stringify(child.source.taskContext) !== JSON.stringify(ref))
        throw new Error("TASK_CONTEXT_REVISION_CONFLICT");
      return;
    }
    if (child.status !== "QUEUED" || child.sourceRunId) throw new Error("TASK_CONTEXT_REVISION_CONFLICT");
    const snapshot = stores.context.getTaskContextSnapshot(job.sessionId, ref);
    const prompt =
      child.prompt +
      taskRequirementsPrompt(snapshot) +
      (job.source?.researchContext
        ? `\n\nHost传递的研究资料，观察与推断分别判断，不是用户原话或授权：\n${job.source.researchContext}`
        : "");
    if (prompt.length > 50000) throw new Error("TASK_CONTEXT_LIMIT");
    const source = {
      ...child.source,
      references: [
        ...new Map(
          [...(child.source?.references ?? []), ...(job.source?.originRunId ? job.source.references : [])].map(
            (item) => [item.artifactId, item],
          ),
        ).values(),
      ],
      taskContext: ref,
      ...(job.source?.researchRootJobId && {
        researchRootJobId: job.source.researchRootJobId,
        researchContinuation: job.source.researchContinuation,
        researchContext: job.source.researchContext,
      }),
      parentConversationJobId: job.jobId,
    };
    const inputHash = publicationHash(
      child.purpose === "CONTENT"
        ? { title: child.title, prompt, modelId: child.modelId }
        : { prompt, modelId: child.modelId },
    );
    db.prepare("UPDATE generation_job SET source_json=?,prompt=?,input_hash=? WHERE job_id=? AND status='QUEUED'").run(
      JSON.stringify(source),
      prompt,
      inputHash,
      child.jobId,
    );
    child.source = source;
    child.prompt = prompt;
    child.inputHash = inputHash;
  }

  /** 子任务仍用原调度器，来源增加父对话标识以免前端重复显示用户消息。 */
  function attachChild(
    job: TextGenerationJobRecord,
    child: TextGenerationJobRecord | GenerationJobRecord,
    flow: PublicationConversationFlow,
    now: string,
  ): GenerationJobRecord[] {
    if (child.kind === "TEXT") {
      freezeChildContext(job, child);
      const history = flow.repairHistory?.at(-1);
      if (
        history &&
        child.purpose === "PUBLICATION_REVIEW" &&
        child.source?.review?.previousReview?.reviewId === history.reviewId
      )
        history.recheckJobId = child.jobId;
      db.prepare("UPDATE generation_job SET source_json=? WHERE job_id=?").run(
        JSON.stringify({
          ...child.source,
          references: child.source?.references ?? [],
          parentConversationJobId: job.jobId,
        }),
        child.jobId,
      );
    } else {
      // bindPublicationImageJob 已推进一次编排；恢复原键时仍只推进父位置一次。
      flow.publicationRevision += 1;
    }
    flow.childJobId = child.jobId;
    flow.receipt =
      child.kind === "IMAGE" ? "图片请求已受理，正在等待真实生成结果。" : "已交给对应任务执行，完成后自动继续。";
    save(job, flow, now);
    return child.kind === "IMAGE" && child.status === "QUEUED" ? [child] : [];
  }

  /** 完成当前步骤，保留实际结果说明供刷新及后续对话读取。 */
  function nextStep(flow: PublicationConversationFlow, receipt: string): void {
    flow.completed.push(receipt);
    flow.receipt = receipt;
    flow.cursor += 1;
    delete flow.childJobId;
    delete flow.imageRequest;
    if (flow.cursor >= flow.steps.length) flow.state = "DONE";
  }

  /** 图像结果须属于绑定任务与同一图位；自动放入预览，最终仍由用户确认整套。 */
  function adoptGeneratedImage(
    job: TextGenerationJobRecord,
    flow: PublicationConversationFlow,
    child: GenerationJobRecord,
    key: string,
    now: string,
  ): void {
    if (!flow.imageRequest || !child.resultArtifactId || !flow.draftId) throw new Error("PUBLICATION_IMAGE_INVALID");
    const prior = db.prepare("SELECT result_json FROM api_operation WHERE operation_key=?").get(key) as Row | undefined;
    if (prior) {
      const saved = JSON.parse(String(prior.result_json));
      const current = stores.publication.getPublication(job.sessionId, flow.draftId);
      if (current.draft.currentRevision !== flow.draftRevision || current.publication.revision !== saved.revision)
        throw new Error("PUBLICATION_REVISION_CONFLICT");
      flow.publicationRevision = saved.revision;
      return;
    }
    const detail = expectedDetail(job, flow);
    if (
      !detail.publication.images.some((slot) => slot.slotId === flow.imageRequest?.slotId && slot.jobId === child.jobId)
    )
      throw new Error("PUBLICATION_IMAGE_INVALID");
    const fields = flow.imageRequest.fields;
    const saved = stores.publication.savePublication(
      job.sessionId,
      flow.draftId,
      flow.publicationRevision,
      {
        ...fields,
        images: fields.images.map((slot) =>
          slot.slotId === flow.imageRequest?.slotId
            ? { ...slot, jobId: child.jobId, artifactId: child.resultArtifactId }
            : slot,
        ),
      },
      key,
      now,
    );
    flow.publicationRevision = saved.revision;
  }

  /** 收取已落库子任务回执，不以模型的“已完成”代替正文、图片或审核结果。 */
  function finishChild(job: TextGenerationJobRecord, flow: PublicationConversationFlow, now: string): void {
    const step = flow.steps[flow.cursor];
    if (!step || !flow.childJobId) throw new Error("PUBLICATION_CONVERSATION_INVALID");
    const child =
      step.kind === "IMAGE"
        ? stores.image.getGenerationJob(job.sessionId, flow.childJobId)
        : stores.text.readTextGenerationJob(job.sessionId, flow.childJobId);
    if (!child) throw new Error("GENERATION_JOB_NOT_FOUND");
    if (["QUEUED", "RUNNING"].includes(child.status)) return;
    if (child.status === "FAILED" || child.status === "UNKNOWN_EXTERNAL")
      throw new Error(
        child.status === "UNKNOWN_EXTERNAL"
          ? "PUBLICATION_IMAGE_UNKNOWN"
          : (child.errorCode ?? "GENERATION_JOB_FAILED"),
      );
    if (child.kind === "IMAGE") {
      adoptGeneratedImage(job, flow, child, `chat:${job.jobId}:${flow.cursor}:adopt`, now);
      nextStep(flow, "新配图已放入本篇预览，旧文件及历史发布包保留。");
    } else if (step.kind === "WRITE_COPY") {
      if (!child.resultDraftId) throw new Error("CONTENT_DRAFT_NOT_FOUND");
      const detail = stores.publication.getPublication(job.sessionId, child.resultDraftId);
      const expectedRevision =
        child.targetRevision === null ? 1 : child.targetRevision + (child.conversation?.action === "REPLY" ? 0 : 1);
      if (detail.draft.currentRevision !== expectedRevision || detail.publication.revision !== flow.publicationRevision)
        throw new Error("PUBLICATION_REVISION_CONFLICT");
      if (job.source?.taskContext)
        stores.context.bindTaskContextDraft(job.sessionId, job.source.taskContext, child.resultDraftId);
      flow.draftId = child.resultDraftId;
      flow.draftRevision = detail.draft.currentRevision;
      nextStep(
        flow,
        child.conversation?.action === "REPLY" ? "已回复，当前文案没有修改。" : "本篇文案已保存，预览已更新。",
      );
    } else if (step.kind === "REPAIR_COPY" || step.kind === "REPAIR_PUBLICATION") {
      if (step.kind === "REPAIR_COPY") flow.draftRevision = (flow.draftRevision ?? 0) + 1;
      else flow.publicationRevision += 1;
      expectedDetail(job, flow);
      nextStep(
        flow,
        step.kind === "REPAIR_COPY"
          ? "写作专家已保存局部文案修订，待独立复审确认问题。"
          : "视觉专家已保存局部说明及图位修订，其他图片保留，待独立复审。",
      );
    } else if (step.kind === "PLAN_IMAGES") {
      flow.publicationRevision += 1;
      expectedDetail(job, flow);
      nextStep(flow, "配图方案和发布说明已保存。");
    } else {
      expectedDetail(job, flow);
      const review = stores.review
        .getPublicationReviews(job.sessionId, flow.draftId as string)
        .reviews.find((item) => item.jobId === child.jobId);
      if (!review) throw new Error("PUBLICATION_REVIEW_INVALID");
      if (review.binding && review.applicability !== "CURRENT") throw new Error("INPUT_VERSION_STALE");
      nextStep(
        flow,
        review.verdict === "LIMITED"
          ? "独立审核已完成，图片覆盖有限，最终确认时仍需人工补查。"
          : review.verdict === "CHANGES_REQUIRED"
            ? "审核发现必须修改的问题，请看审核意见并继续告诉我怎么改。"
            : "独立审核已完成，请确认整套图文。",
      );
      if (review.verdict === "CHANGES_REQUIRED") {
        const remainingIds = step.issueIds
          ? review.issues
              .filter((issue) => step.issueIds?.includes(issue.issueId ?? ""))
              .map((issue) => issue.issueId as string)
          : undefined;
        if (step.autoRepair && (flow.repairRounds ?? 0) < 2 && (!remainingIds || remainingIds.length)) {
          flow.steps.splice(flow.cursor, 0, {
            kind: "REPAIR",
            reviewId: review.reviewId,
            ...(remainingIds && { issueIds: remainingIds }),
          });
          flow.state = "RUNNING";
          flow.receipt = "审核发现必改项，正在按问题范围安排局部返修和复审。";
        } else {
          flow.state = "DONE";
          flow.receipt =
            (flow.repairRounds ?? 0) >= 2
              ? "已完成两轮局部返修与复审，仍有必改项。请查看剩余问题并补充资料或调整要求。"
              : "审核发现必改项。可以说‘按审核意见修改’，再交独立复审。";
        }
      }
    }
    save(job, flow, now);
  }

  /** 用已保存状态展开“继续完成”，不由模型伪造缺图或审核通过。 */
  function expandSteps(flow: PublicationConversationFlow, steps: PublicationAction[]): void {
    flow.steps.splice(flow.cursor, 1, ...steps);
    if (flow.steps.length > 30) throw new Error("PUBLICATION_CONVERSATION_INVALID");
  }

  /** 冻结具体付费请求；模型只能提出制作要求，不能代替用户授权。 */
  function prepareImage(
    job: TextGenerationJobRecord,
    flow: PublicationConversationFlow,
    step: PublicationAction,
    modelId: string | null,
    now: string,
  ): void {
    if (!modelId) throw new Error("IMAGE_PROVIDER_NOT_CONFIGURED");
    const detail = expectedDetail(job, flow);
    const slot = detail.publication.images[(step.slotIndex ?? 1) - 1];
    if (!slot?.prompt.trim()) throw new Error("PUBLICATION_IMAGE_INVALID");
    const prior = slot.jobId ? stores.image.getGenerationJob(job.sessionId, slot.jobId) : null;
    if (prior?.status === "UNKNOWN_EXTERNAL") throw new Error("PUBLICATION_IMAGE_UNKNOWN");
    if (prior && ["QUEUED", "RUNNING"].includes(prior.status)) throw new Error("PUBLICATION_IMAGE_PENDING");
    const fields: PublicationFields = {
      instructions: detail.publication.instructions,
      visualStyle: detail.publication.visualStyle,
      images: detail.publication.images.map((image) =>
        image.slotId === slot.slotId && step.brief?.trim() ? { ...image, prompt: step.brief.trim() } : image,
      ),
    };
    flow.imageRequest = {
      approvalId: randomUUID(),
      modelId,
      slotId: slot.slotId,
      referenceArtifactId: slot.artifactId,
      fields,
      approved: false,
      prompt: `本张最新画面要求（有冲突时优先于原整套风格）：${step.brief?.trim() || slot.prompt}\n原整套风格仅供参考：${fields.visualStyle}\n\n以下是本篇第${flow.draftRevision}版文案，只用已确认信息作图，不自行增加价格或服务承诺：\n${detail.draft.title}\n${detail.draft.body}`,
    };
    if (job.source?.taskContext) {
      flow.imageRequest.prompt += taskRequirementsPrompt(
        stores.context.getTaskContextSnapshot(job.sessionId, job.source.taskContext),
      );
      if (flow.imageRequest.prompt.length > 50000) throw new Error("TASK_CONTEXT_LIMIT");
    }
    flow.state = "WAITING_IMAGE_CONFIRMATION";
    flow.receipt = `已准备第${step.slotIndex ?? 1}张图片，请确认本次费用后继续。`;
    save(job, flow, now);
  }

  /** 执行无外部模型调用的图片采用，稳定操作键覆盖保存后进程中断。 */
  function adoptSelectedImage(
    job: TextGenerationJobRecord,
    flow: PublicationConversationFlow,
    step: PublicationAction,
    key: string,
    now: string,
  ): void {
    const prior = db.prepare("SELECT result_json FROM api_operation WHERE operation_key=?").get(key) as Row | undefined;
    if (prior) {
      const saved = JSON.parse(String(prior.result_json));
      const detail = stores.publication.getPublication(job.sessionId, flow.draftId as string);
      if (detail.draft.currentRevision !== flow.draftRevision || detail.publication.revision !== saved.revision)
        throw new Error("PUBLICATION_REVISION_CONFLICT");
      flow.publicationRevision = saved.revision;
    } else {
      const detail = expectedDetail(job, flow);
      const index = (step.slotIndex ?? 1) - 1;
      if (!detail.publication.images[index] || !detail.images.some((item) => item.artifactId === step.artifactId))
        throw new Error("PUBLICATION_IMAGE_INVALID");
      const saved = stores.publication.savePublication(
        job.sessionId,
        flow.draftId as string,
        flow.publicationRevision,
        {
          ...detail.publication,
          images: detail.publication.images.map((slot, i) =>
            i === index ? { ...slot, artifactId: step.artifactId as string, jobId: null } : slot,
          ),
        },
        key,
        now,
      );
      flow.publicationRevision = saved.revision;
    }
    nextStep(flow, "已将选中的图片放入本篇预览。");
    save(job, flow, now);
  }

  /** 仅更新发布说明和整体风格，保留已采用图片及正文；原操作键可恢复保存后的中断。 */
  function updatePublicationText(
    job: TextGenerationJobRecord,
    flow: PublicationConversationFlow,
    step: PublicationAction,
    key: string,
    now: string,
  ): void {
    const prior = db.prepare("SELECT result_json FROM api_operation WHERE operation_key=?").get(key) as Row | undefined;
    if (prior) {
      const saved = JSON.parse(String(prior.result_json));
      const detail = stores.publication.getPublication(job.sessionId, flow.draftId as string);
      if (detail.draft.currentRevision !== flow.draftRevision || detail.publication.revision !== saved.revision)
        throw new Error("PUBLICATION_REVISION_CONFLICT");
      flow.publicationRevision = saved.revision;
    } else {
      const detail = expectedDetail(job, flow);
      const changes = step.imageEdits ?? [];
      if (
        new Set(changes.map((image) => image.slotIndex)).size !== changes.length ||
        changes.some((image) => !detail.publication.images[image.slotIndex - 1])
      )
        throw new Error("PUBLICATION_IMAGE_INVALID");
      const images = detail.publication.images.map((image, index) => {
        const change = changes.find((item) => item.slotIndex === index + 1);
        if (!change) return image;
        const pending = image.jobId ? stores.image.getGenerationJob(job.sessionId, image.jobId) : null;
        if (pending && ["QUEUED", "RUNNING", "UNKNOWN_EXTERNAL"].includes(pending.status))
          throw new Error("PUBLICATION_IMAGE_PENDING");
        return { ...image, title: change.title?.trim() ?? image.title, prompt: change.prompt?.trim() ?? image.prompt };
      });
      const saved = stores.publication.savePublication(
        job.sessionId,
        flow.draftId as string,
        flow.publicationRevision,
        {
          ...detail.publication,
          instructions: step.instructions?.trim() ?? detail.publication.instructions,
          visualStyle: step.visualStyle?.trim() ?? detail.publication.visualStyle,
          images,
        },
        key,
        now,
      );
      flow.publicationRevision = saved.revision;
    }
    nextStep(flow, "发布说明和视觉要求已更新，已采用图片与文案保留。");
    save(job, flow, now);
  }

  /** 读取同篇真实审核，不允许使用历史结果覆盖当前内容或引用其他会话问题。 */
  function repairReview(
    job: TextGenerationJobRecord,
    flow: PublicationConversationFlow,
    reviewId?: string,
  ): PublicationReview {
    if (!flow.draftId) throw new Error("CONTENT_DRAFT_NOT_FOUND");
    const reviews = stores.review.getPublicationReviews(job.sessionId, flow.draftId).reviews;
    const review = reviewId
      ? reviews.find((item) => item.reviewId === reviewId)
      : (reviews.find((item) => item.applicability === "CURRENT") ?? reviews[0]);
    if (!review?.binding || review.issues.some((issue) => !issue.issueId))
      throw new Error("PUBLICATION_REPAIR_REVIEW_INVALID");
    return review;
  }

  /** 显式返修或交付流程只选必改项；像素问题另走原费用确认，复审前不宣布解决。 */
  function expandRepair(
    job: TextGenerationJobRecord,
    flow: PublicationConversationFlow,
    step: PublicationAction,
    detail: PublicationDetail,
  ): void {
    const review = repairReview(job, flow, step.reviewId);
    // 新增“保持其他内容”等要求会使旧结论过期，但同一内容的问题仍可作为返修输入；复审必须使用最新要求。
    const snapshot = stores.publication.getPublicationSnapshot(
      job.sessionId,
      detail.draft.draftId,
      detail.draft.currentRevision,
      detail.publication.revision,
    );
    if (
      publicationHash(snapshot) !== review.snapshotHash ||
      review.binding?.rulesHash !== REVIEW_RULES_HASH ||
      review.binding.reviewerContractHash !==
        (review.version === 3 ? REVIEW_RECHECK_CONTRACT_HASH : REVIEW_CONTRACT_HASH)
    )
      throw new Error("PUBLICATION_REPAIR_SOURCE_CHANGED");
    if ((flow.repairRounds ?? 0) >= 2) throw new Error("PUBLICATION_REPAIR_LIMIT");
    const mandatoryIds = new Set(
      review.requirementChecks?.filter((check) => check.status === "UNMET").flatMap((check) => check.issueIds) ?? [],
    );
    const issues = step.issueIds
      ? review.issues.filter((issue) => step.issueIds?.includes(issue.issueId ?? ""))
      : review.issues.filter((issue) => issue.severity === "BLOCKER" || mandatoryIds.has(issue.issueId ?? ""));
    if (!issues.length || (step.issueIds && issues.length !== step.issueIds.length))
      throw new Error("PUBLICATION_REPAIR_REVIEW_INVALID");
    if (
      issues.some(
        (issue) =>
          issue.target === "IMAGE" &&
          (!issue.slotId || !detail.publication.images.some((image) => image.slotId === issue.slotId)),
      )
    )
      throw new Error("PUBLICATION_REPAIR_SCOPE_INVALID");
    const copy = issues
      .filter((issue) => issue.target === "COPY" || issue.target === "FACT")
      .map((issue) => issue.issueId as string);
    const visual = issues
      .filter((issue) => issue.target === "INSTRUCTIONS" || issue.target === "IMAGE")
      .map((issue) => issue.issueId as string);
    const imageSlots = [...new Set(issues.filter((issue) => issue.target === "IMAGE").map((issue) => issue.slotId))];
    flow.repairRounds = (flow.repairRounds ?? 0) + 1;
    flow.repairHistory = [
      ...(flow.repairHistory ?? []),
      { reviewId: review.reviewId, issueIds: issues.map((issue) => issue.issueId as string), childJobIds: [] },
    ];
    expandSteps(flow, [
      ...(copy.length ? [{ kind: "REPAIR_COPY" as const, reviewId: review.reviewId, issueIds: copy }] : []),
      ...(visual.length ? [{ kind: "REPAIR_PUBLICATION" as const, reviewId: review.reviewId, issueIds: visual }] : []),
      ...imageSlots.map((slotId) => ({
        kind: "IMAGE" as const,
        slotIndex: detail.publication.images.findIndex((image) => image.slotId === slotId) + 1,
      })),
      {
        kind: "REVIEW",
        reviewId: review.reviewId,
        autoRepair: true,
        ...(step.issueIds && { issueIds: step.issueIds }),
      },
    ]);
    flow.state = "RUNNING";
    flow.receipt = "已按当前审核问题安排局部返修，修改后交审核专家逐项复查。";
  }

  /** 复用原文字任务，仅冻结补丁契约与原稿；产物仍由原 CAS 修订和编排写入链保存。 */
  function createRepairChild(
    job: TextGenerationJobRecord,
    flow: PublicationConversationFlow,
    step: PublicationAction,
    detail: PublicationDetail,
    key: string,
    now: string,
  ): TextGenerationJobRecord {
    const review = repairReview(job, flow, step.reviewId);
    const issues = review.issues.filter((issue) => step.issueIds?.includes(issue.issueId ?? ""));
    if (!issues.length || issues.length !== step.issueIds?.length) throw new Error("PUBLICATION_REPAIR_REVIEW_INVALID");
    const { applicability: _applicability, ...savedReview } = review;
    const basis: PublicationRepairBasis = {
      version: 1,
      reviewId: review.reviewId,
      reviewHash: sha256(canonicalJson(savedReview)),
      scope: step.kind === "REPAIR_COPY" ? "COPY" : "PUBLICATION",
      issues: issues as PublicationRepairBasis["issues"],
      draft: detail.draft,
      publication: detail.publication,
    };
    const child =
      step.kind === "REPAIR_COPY"
        ? stores.text.createTextGenerationJob(
            `gen_${randomUUID()}`,
            job.sessionId,
            detail.draft.title,
            "只按冻结审核问题局部返修",
            null,
            flow.draftId,
            flow.draftRevision,
            job.modelId,
            key,
            now,
            undefined,
            false,
          )
        : stores.publication.createPublicationPlanningJob(
            `gen_${randomUUID()}`,
            job.sessionId,
            detail.draft.draftId,
            detail.draft.currentRevision,
            detail.publication.revision,
            "只按冻结审核问题局部返修",
            job.modelId,
            key,
            now,
            detail.publication.images.length || 1,
            false,
          );
    const prompt = [
      "你负责当前审核问题的局部返修。只输出补丁JSON，Host校验并保存新版本后交独立审核专家复审。不得改写整篇或修改未选问题。",
      JSON.stringify(publicationRepairSchema),
      "COPY只允许title/body/internalNotes；PUBLICATION只允许instructions/visualStyle或所选IMAGE问题对应slotId的imageTitle/imagePrompt。expectedText必须是该字段中唯一出现的连续原文，不使用全文重写；多个片段不得重叠。issueIds仅引用下方所选问题并完整覆盖。FACT缺乏证据时只能删除无依据断言或提交NEEDS_INPUT，不编造事实，不删除用户有效要求来过审。保持其他内容、图位、图片、顺序不变；图片像素将另走费用确认，不能把提示词修改宣称为图片已修复。",
      JSON.stringify({ repair: basis, source: child.source, userInstruction: job.source?.conversation?.instruction }),
    ].join("\n\n");
    if (prompt.length > 50000) throw new Error("PUBLICATION_INPUT_INVALID");
    child.source = { ...child.source, references: child.source?.references ?? [], repair: basis };
    child.prompt = prompt;
    child.inputHash = publicationHash(
      child.purpose === "CONTENT"
        ? { title: child.title, prompt, modelId: child.modelId }
        : { prompt, modelId: child.modelId },
    );
    db.prepare(
      "UPDATE generation_job SET source_json=?,prompt=?,input_hash=?,model_version=? WHERE job_id=? AND status='QUEUED'",
    ).run(JSON.stringify(child.source), prompt, child.inputHash, PUBLICATION_REPAIR_VERSION, child.jobId);
    const history = flow.repairHistory?.at(-1);
    if (history) history.childJobIds.push(child.jobId);
    return child;
  }

  /** 按固定步骤提交既有文字/图片任务；已受理步骤先回读，不重新取最新版本拼参数。 */
  function startStep(
    job: TextGenerationJobRecord,
    flow: PublicationConversationFlow,
    imageModelId: string | null,
    imageInput: boolean,
    now: string,
  ): GenerationJobRecord[] {
    const step = flow.steps[flow.cursor];
    if (!step) {
      flow.state = "DONE";
      save(job, flow, now);
      return [];
    }
    const key = `chat:${job.jobId}:${flow.cursor}`;
    const prior = existingChild(job, key);
    if (prior) return attachChild(job, prior, flow, now);
    if (!execution.reservePublicationExecution(job.sessionId, job.jobId, "steps", key, now)) return [];
    if (step.kind === "USE_IMAGE") {
      adoptSelectedImage(job, flow, step, key, now);
      return [];
    }
    if (step.kind === "UPDATE_PUBLICATION") {
      updatePublicationText(job, flow, step, key, now);
      return [];
    }
    const detail = flow.draftId ? expectedDetail(job, flow) : null;
    if (step.kind === "WRITE_COPY") {
      if (
        !detail &&
        job.source?.profile &&
        freezeMerchantProfile(db, job.source.profile.merchantId).sha256 !== job.source.profile.sha256
      )
        throw new Error("TOPIC_SOURCE_STALE");
      const productId = detail ? null : (step.productEntryId ?? null);
      const catalog = job.merchantId ? stores.catalog(job.merchantId) : [];
      const frozenProducts =
        (job.source as TextTaskSource & { conversationProducts?: MerchantCatalogEntry[] }).conversationProducts ?? [];
      if (
        productId &&
        (!frozenProducts.some((item) => item.entryId === productId) ||
          !catalog.some(
            (item) =>
              item.entryId === productId &&
              frozenProducts.some((old) => old.entryId === productId && old.sha256 === item.sha256),
          ))
      )
        throw new Error("PRODUCT_SOURCE_CHANGED");
      const child = stores.text.createTextGenerationJob(
        `gen_${randomUUID()}`,
        job.sessionId,
        detail?.draft.title ?? step.title ?? job.title,
        step.brief ?? job.source?.conversation?.instruction ?? "",
        productId,
        flow.draftId,
        flow.draftRevision,
        job.modelId,
        key,
        now,
        undefined,
        false,
      );
      return attachChild(job, child, flow, now);
    }
    if (!detail) throw new Error("CONTENT_DRAFT_NOT_FOUND");
    if (step.kind === "PLAN_IMAGES")
      return attachChild(
        job,
        stores.publication.createPublicationPlanningJob(
          `gen_${randomUUID()}`,
          job.sessionId,
          detail.draft.draftId,
          detail.draft.currentRevision,
          detail.publication.revision,
          step.brief ?? "只为当前这一篇规划",
          job.modelId,
          key,
          now,
          step.imageCount ?? 1,
          false,
        ),
        flow,
        now,
      );
    if (step.kind === "REPAIR") {
      expandRepair(job, flow, step, detail);
      save(job, flow, now);
      return [];
    }
    if (step.kind === "REPAIR_COPY" || step.kind === "REPAIR_PUBLICATION")
      return attachChild(job, createRepairChild(job, flow, step, detail, key, now), flow, now);
    if (step.kind === "REVIEW")
      return attachChild(
        job,
        stores.review.createPublicationReviewJob(
          `gen_${randomUUID()}`,
          job.sessionId,
          detail.draft.draftId,
          detail.draft.currentRevision,
          detail.publication.revision,
          job.modelId,
          imageInput,
          key,
          now,
          false,
          job.source?.taskContext,
          step.reviewId,
        ),
        flow,
        now,
      );
    if (step.kind === "FINISH") {
      expandSteps(flow, [
        ...(detail.publication.images.length
          ? []
          : [{ kind: "PLAN_IMAGES" as const, brief: "为当前这一篇规划一张封面和发布说明", imageCount: 1 }]),
        { kind: "MAKE_IMAGES", brief: "按当前方案制作尚缺配图" },
        { kind: "REVIEW", autoRepair: true },
        { kind: "CONFIRM" },
      ]);
    } else if (step.kind === "MAKE_IMAGES") {
      if (!detail.publication.images.length)
        expandSteps(flow, [{ kind: "PLAN_IMAGES", brief: step.brief ?? "规划一张封面", imageCount: 1 }, step]);
      else {
        if (step.slotIndex && !detail.publication.images[step.slotIndex - 1])
          throw new Error("PUBLICATION_IMAGE_INVALID");
        const steps = detail.publication.images.flatMap((slot, i) =>
          (step.slotIndex ? step.slotIndex === i + 1 : !slot.artifactId)
            ? [{ kind: "IMAGE" as const, slotIndex: i + 1, brief: step.brief }]
            : [],
        );
        if (steps.length) expandSteps(flow, steps);
        else nextStep(flow, "当前配图已齐全，无需重复生成。");
      }
    } else if (step.kind === "IMAGE") {
      if (!flow.imageRequest) {
        prepareImage(job, flow, step, imageModelId, now);
        return [];
      }
      if (!flow.imageRequest.approved || flow.imageRequest.modelId !== imageModelId)
        throw new Error("PUBLICATION_APPROVAL_INVALID");
      if (!execution.reservePublicationExecution(job.sessionId, job.jobId, "images", key, now)) return [];
      return attachChild(
        job,
        stores.image.createImageJob(
          `img_${randomUUID()}`,
          job.sessionId,
          flow.imageRequest.prompt,
          imageModelId,
          "1024x1536",
          "medium",
          flow.imageRequest.referenceArtifactId,
          key,
          now,
          {
            draftId: detail.draft.draftId,
            draftRevision: detail.draft.currentRevision,
            publicationRevision: detail.publication.revision,
            slotId: flow.imageRequest.slotId,
          },
        ),
        flow,
        now,
      );
    } else if (step.kind === "CONFIRM") {
      stores.publication.getPublicationSnapshot(
        job.sessionId,
        detail.draft.draftId,
        detail.draft.currentRevision,
        detail.publication.revision,
      );
      flow.state = "WAITING_FINAL_CONFIRMATION";
      flow.receipt = "图文与独立审核已准备好。请核对预览和审核意见，确认后生成并下载发布包。";
    }
    save(job, flow, now);
    return [];
  }

  return {
    /** 冻结用户原话和可见状态，仅创建意图任务，不在入口直接修改稿件或付费。 */
    createPublicationConversation: (
      id: string,
      sessionId: string,
      input: PublicationConversationInput,
      modelId: string,
      imageModelId: string | null,
      key: string,
      now: string,
    ): TextGenerationJobRecord =>
      transaction(() => {
        const hash = publicationHash({ sessionId, input, modelId });
        const prior = db.prepare("SELECT job_id,request_hash FROM generation_job WHERE request_key=?").get(key) as
          | Row
          | undefined;
        if (prior) {
          if (prior.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
          return requireJob(sessionId, String(prior.job_id));
        }
        const session = activeSession(sessionId);
        const origin = chatOrigin(sessionId, input.originRunId);
        const active = db
          .prepare(
            "SELECT 1 FROM generation_job WHERE session_id=? AND purpose='PUBLICATION_CHAT' AND (status IN ('QUEUED','RUNNING') OR json_extract(source_json,'$.workflow.state')='RUNNING')",
          )
          .get(sessionId);
        if (active) throw new Error("PUBLICATION_CONVERSATION_PENDING");
        const rootView = input.rootJobId
          ? stores.context.getTaskContextView(sessionId, undefined, input.rootJobId)
          : null;
        const draftId = input.draftId ?? rootView?.carriers.find((item) => item.kind === "DRAFT")?.id;
        const detail = draftId ? stores.publication.getPublication(sessionId, draftId) : null;
        if (
          detail &&
          input.draftId &&
          (detail.draft.currentRevision !== input.draftRevision ||
            detail.publication.revision !== input.publicationRevision)
        )
          throw new Error("PUBLICATION_REVISION_CONFLICT");
        if (!input.message.trim() || input.message.length > 2000) throw new Error("PUBLICATION_INPUT_INVALID");
        const merchantId = session.scope === "MERCHANT" ? String(session.owner_id) : null;
        const profile = merchantId ? freezeMerchantProfile(db, merchantId) : null;
        const products = merchantId
          ? stores
              .catalog(merchantId)
              .filter((item) => item.kind === "PRODUCT")
              .slice(0, 30)
          : [];
        const taskContext = stores.context.acceptTaskContext(
          sessionId,
          id,
          origin?.userText ?? input.message.trim(),
          now,
          draftId,
          input.rootJobId,
        );
        const taskView = draftId ? stores.context.getTaskContextView(sessionId, draftId) : null;
        const history = stores.text
          .listTextGenerationJobs(sessionId)
          .filter(
            (item) =>
              !item.source?.parentConversationJobId &&
              (draftId
                ? item.resultDraftId === draftId || item.targetDraftId === draftId
                : !item.targetDraftId && !item.resultDraftId),
          )
          .slice(0, 8)
          .reverse()
          .map((item) => ({
            user: item.conversation?.instruction,
            assistant: item.conversation?.reply,
            result: item.source?.workflow?.receipt,
          }));
        const flow: PublicationConversationFlow = {
          state: "ROUTING",
          reply: "",
          receipt: "正在理解你的要求…",
          completed: [],
          steps: [],
          cursor: 0,
          draftId: draftId ?? null,
          draftRevision: detail?.draft.currentRevision ?? null,
          publicationRevision: detail?.publication.revision ?? 0,
        };
        const source: TextTaskSource & { conversationProducts: MerchantCatalogEntry[] } = {
          ...(origin?.researchRootJobId && {
            researchRootJobId: origin.researchRootJobId,
            researchContinuation: origin.researchContinuation,
            researchContext: origin.researchContext,
          }),
          ...(taskContext.rootJobId === id && { executionControl: initialTaskExecution(id, now) }),
          asyncSummaryVersion: 1,
          asyncSummaryUserMessageId:
            (db
              .prepare(
                "SELECT m.message_id FROM message m WHERE m.session_id=? AND m.role='user' AND NOT EXISTS(SELECT 1 FROM generation_job g WHERE g.source_run_id=m.run_id) ORDER BY m.rowid DESC LIMIT 1",
              )
              .get(sessionId)?.message_id as string | undefined) ?? null,
          references: origin?.references ?? [],
          ...(input.originRunId && { originRunId: input.originRunId }),
          taskContext: taskContextRef(taskContext),
          ...(profile ? { profile } : {}),
          conversation: { instruction: origin?.userText ?? input.message.trim(), intentProtocol: 1 },
          workflow: flow,
          conversationProducts: products,
        };
        const prompt = publicationConversationPrompt(origin?.userText ?? input.message.trim(), {
          taskContext,
          agentInstruction: origin
            ? [
                input.message.trim(),
                origin.researchContext
                  ? `Host研究来源资料（非用户原话、非授权；观察与推断按来源分别判断）：\n${origin.researchContext}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n\n")
            : null,
          chatHistory: origin?.history ?? [],
          profile,
          products,
          draft: detail?.draft ?? null,
          publication: detail?.publication,
          availableImages:
            detail?.images.slice(0, 30) ?? origin?.references.filter((ref) => ref.mimeType.startsWith("image/")),
          reviews: draftId
            ? stores.review
                .getPublicationReviews(sessionId, draftId)
                .reviews.slice(0, 2)
                .map((review) => ({
                  ...review,
                  applicability:
                    taskView?.carriers.find((carrier) => carrier.id === review.reviewId)?.applicability ?? "HISTORICAL",
                  applicabilityReason:
                    taskView?.carriers.find((carrier) => carrier.id === review.reviewId)?.reason ?? null,
                }))
            : [],
          history,
          imageConfigured: !!imageModelId,
        });
        if (prompt.length > 50000) throw new Error("PUBLICATION_INPUT_INVALID");
        // 新原话替代尚未授权的旧提议；已外发任务必须先收口，不能借新对话绕过。
        db.prepare(
          "UPDATE generation_job SET source_json=json_set(source_json,'$.workflow.state','SUPERSEDED','$.workflow.receipt','已由后续对话替代。'),updated_at=? WHERE session_id=? AND purpose='PUBLICATION_CHAT' AND json_extract(source_json,'$.workflow.state') IN ('WAITING_IMAGE_CONFIRMATION','WAITING_FINAL_CONFIRMATION')",
        ).run(now, sessionId);
        db.prepare(
          `INSERT INTO generation_job(job_id,session_id,merchant_id,intent,kind,status,title,prompt,input_hash,model_id,model_version,purpose,source_json,target_draft_id,target_revision,target_hash,request_key,request_hash,created_at,updated_at) VALUES (?,?,?,?,'TEXT','QUEUED',?,?,?,?,?,'PUBLICATION_CHAT',?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          sessionId,
          merchantId,
          detail ? "MODIFY" : "CREATE",
          detail?.draft.title ?? input.message.slice(0, 80),
          prompt,
          publicationHash({ prompt, modelId }),
          modelId,
          PUBLICATION_CONVERSATION_VERSION,
          JSON.stringify(source),
          draftId ?? null,
          detail?.draft.currentRevision ?? null,
          detail?.draft.sha256 ?? null,
          key,
          hash,
          now,
          now,
        );
        if (taskContext.rootJobId !== id) enableExistingTaskExecution(db, taskContext.rootJobId, now);
        return requireJob(sessionId, id);
      }),

    /** 真实成功路由 Run 才能发布步骤计划；纯回复不产生任何正文修订。 */
    completePublicationConversation: (sessionId: string, jobId: string, now: string): TextGenerationJobRecord =>
      transaction(() => {
        const job = requireJob(sessionId, jobId);
        if (job.status === "READY_FOR_REVIEW") return job;
        const run = db
          .prepare("SELECT status FROM agent_run WHERE run_id=? AND session_id=?")
          .get(job.sourceRunId, sessionId) as Row | undefined;
        if (job.status !== "RUNNING" || run?.status !== "SUCCEEDED") throw new Error("GENERATION_JOB_STATE_CONFLICT");
        const message = db
          .prepare(
            "SELECT content_json FROM message WHERE run_id=? AND session_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1",
          )
          .get(job.sourceRunId, sessionId) as Row | undefined;
        const decision = parsePublicationConversation(
          String(JSON.parse(String(message?.content_json)).text),
          Boolean(job.source?.taskContext),
          job.source?.conversation?.intentProtocol === 1,
        );
        if (job.source?.taskContext) {
          if (!decision.contextDelta) throw new Error("TASK_CONTEXT_DELTA_INVALID");
          const snapshot = stores.context.commitTaskContext(
            sessionId,
            job.source.taskContext,
            decision.contextDelta,
            now,
          );
          job.source = { ...job.source, taskContext: taskContextRef(snapshot) };
        }
        const flow = job.source?.workflow as PublicationConversationFlow;
        flow.intent = decision.intent;
        flow.reply = decision.reply;
        flow.steps = decision.actions;
        flow.state = decision.actions.length ? "RUNNING" : "DONE";
        flow.receipt = decision.actions.length ? "已理解要求，正在执行。" : "";
        save(job, flow, now);
        db.prepare("UPDATE generation_job SET status='READY_FOR_REVIEW' WHERE job_id=?").run(jobId);
        db.prepare(
          "UPDATE generation_step_attempt SET status='SUCCEEDED',finished_at=? WHERE job_id=? AND step_key='TEXT_RUN'",
        ).run(now, jobId);
        return requireJob(sessionId, jobId);
      }),

    /** 枚举正在执行的对话，等待用户确认时不自动推进。 */
    listRunnablePublicationConversations: (): Array<{ sessionId: string; jobId: string }> =>
      (
        db
          .prepare(
            "SELECT session_id,job_id FROM generation_job WHERE purpose='PUBLICATION_CHAT' AND status='READY_FOR_REVIEW' AND json_extract(source_json,'$.workflow.state')='RUNNING' ORDER BY created_at",
          )
          .all() as Row[]
      ).map((row) => ({ sessionId: String(row.session_id), jobId: String(row.job_id) })),

    /** 每次只推进一个持久步骤，失败保留当前稿和已完成结果，不自动重试付费请求。 */
    advancePublicationConversation: (
      sessionId: string,
      jobId: string,
      imageModelId: string | null,
      imageInput: boolean,
      now: string,
    ): GenerationJobRecord[] => {
      const job = requireJob(sessionId, jobId);
      let flow = job.source?.workflow as PublicationConversationFlow;
      if (flow.state !== "RUNNING" || execution.getTaskExecutionControl(sessionId, jobId)?.state === "PAUSED")
        return [];
      try {
        activeSession(sessionId);
        return transaction(() => {
          if (flow.childJobId) {
            finishChild(job, flow, now);
            return [];
          }
          return startStep(job, flow, imageModelId, imageInput, now);
        });
      } catch (error) {
        // 子任务与父位置已一起回滚；错误回执从持久父状态重建，不能保存半途内存进展。
        flow = requireJob(sessionId, jobId).source?.workflow as PublicationConversationFlow;
        flow.state = "FAILED";
        flow.errorCode = error instanceof Error ? error.message : "PUBLICATION_CONVERSATION_FAILED";
        flow.receipt =
          flow.errorCode === "PUBLICATION_IMAGE_UNKNOWN"
            ? "上次图片请求结果未知，请先核对原请求；不会自动重发。"
            : flow.errorCode === "IMAGE_PROVIDER_NOT_CONFIGURED"
              ? "图片服务尚未配置。可以上传图片后通过对话采用，或配置服务后重新提出制作要求。"
              : flow.errorCode === "PUBLICATION_REVISION_CONFLICT"
                ? "稿件已在别处变化，已停止后续操作。请读取最新版本后继续。"
                : `这一步未完成（${flow.errorCode}），已完成内容保留，可继续对话调整要求。`;
        transaction(() => {
          save(job, flow, now);
          db.prepare("UPDATE generation_job SET status='FAILED' WHERE job_id=?").run(jobId);
        });
        return [];
      }
    },

    /** 只有来自确认按钮的具体请求授权才允许制作图片，过时提议不能重放。 */
    approvePublicationConversationImage: (
      sessionId: string,
      jobId: string,
      approvalId: string,
      draftRevision: number,
      publicationRevision: number,
      now: string,
    ): TextGenerationJobRecord =>
      transaction(() => {
        const job = requireJob(sessionId, jobId);
        const flow = job.source?.workflow as PublicationConversationFlow;
        if (flow.imageRequest?.approvalId === approvalId && flow.imageRequest.approved && flow.state !== "SUPERSEDED")
          return job;
        if (
          flow.state !== "WAITING_IMAGE_CONFIRMATION" ||
          flow.imageRequest?.approvalId !== approvalId ||
          flow.draftRevision !== draftRevision ||
          flow.publicationRevision !== publicationRevision
        )
          throw new Error("PUBLICATION_APPROVAL_INVALID");
        expectedDetail(job, flow);
        flow.imageRequest.approved = true;
        flow.state = "RUNNING";
        flow.receipt = "已确认本次图片费用，开始制作。";
        save(job, flow, now);
        return requireJob(sessionId, jobId);
      }),
  };
}

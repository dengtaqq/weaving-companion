import type { GenerationJobRecord } from "../../../../shared/contracts.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";
import type { SessionService } from "../../sessions/application/session-service.js";

/** 将持久文案任务接入既有 Agent Run，并在成功后自动提取可审核草稿。 */
export class TextGenerationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  /** 保留原有 Run/专家调度能力，仅管理任务与 Run 之间的状态。 */
  constructor(
    private readonly db: DbClient,
    private readonly sessions: SessionService,
    private readonly modelId: string | null,
    private readonly conversation?: {
      imageModelId: string | null;
      imageInput: boolean;
      enqueue: (job: GenerationJobRecord) => void;
    },
  ) {}

  /** 启动恢复扫描及轮询，页面断线不影响文案任务继续运行。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 2000);
    void this.tick();
  }

  /** 停止新增调度；已受理 Run 由 AgentTaskManager 自己收尾。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 为新任务立即触发一次调度尝试。 */
  wake(): void {
    void this.tick();
  }

  /** 按冻结任务 ID 恢复受理、查询 Run 终态并创建版本化草稿。 */
  private async tick(): Promise<void> {
    if (this.busy || !this.timer) return;
    this.busy = true;
    try {
      await this.db.reconcileTaskExecution();
      if (this.modelId) await this.db.prepareAsyncResultSummaries(this.modelId);
      const jobs = await this.db.listPendingTextGenerationJobs();
      for (const job of jobs) {
        try {
          if (job.status === "QUEUED") {
            if (!this.modelId) continue;
            if (
              job.purpose !== "PUBLICATION_SUMMARY" &&
              (await this.db.getTaskExecutionControl(job.sessionId, job.jobId))?.state === "PAUSED"
            )
              continue;
            if (job.source?.originRunId) {
              const origin = await this.db.getRun(job.source.originRunId);
              // 主聊天成功交接后才开始后台任务；取消、失败或崩溃不能留下孤立执行。
              if (!origin || origin.sessionId !== job.sessionId || ["FAILED", "CANCELLED"].includes(origin.status)) {
                await this.db.failTextGenerationJob(job.sessionId, job.jobId, "PUBLICATION_ORIGIN_FAILED");
                continue;
              }
              if (origin.status !== "SUCCEEDED") continue;
            }
            if (
              job.sourceRunId ||
              job.prompt.length > 50000 ||
              job.prompt.length === 0 ||
              job.modelId !== this.modelId
            ) {
              await this.db.failTextGenerationJob(job.sessionId, job.jobId, "TEXT_MODEL_UNAVAILABLE");
              continue;
            }
            await this.db.validateTextGenerationSources(job.sessionId, job.jobId);
            const accepted = await this.sessions.acceptMessage(
              job.sessionId,
              job.prompt,
              job.jobId,
              `text-job:${job.jobId}`,
              job.purpose === "PUBLICATION_REVIEW" ? "reviewer" : undefined,
              job.source
                ? job.source.references.map((ref) => ref.artifactId)
                : job.purpose === "TOPIC_PLAN"
                  ? []
                  : undefined,
              job.jobId,
            );
            await this.db.attachTextGenerationRun(job.sessionId, job.jobId, accepted.runId);
            continue;
          }
          if (!job.sourceRunId) {
            await this.db.failTextGenerationJob(job.sessionId, job.jobId, "TEXT_RUN_MISSING");
            continue;
          }
          const run = await this.db.getRun(job.sourceRunId);
          if (!run || run.sessionId !== job.sessionId) {
            await this.db.failTextGenerationJob(job.sessionId, job.jobId, "TEXT_RUN_MISSING");
          } else if (run.status === "SUCCEEDED") {
            if (job.purpose === "RESEARCH" || job.purpose === "RESEARCH_CONTINUATION") {
              await this.db.completeResearchJob(job.sessionId, job.jobId);
              continue;
            }
            if (job.purpose === "PUBLICATION_SUMMARY") {
              await this.db.completeAsyncResultSummary(job.sessionId, job.jobId);
              continue;
            }
            if (job.purpose === "PUBLICATION_CHAT") {
              await this.db.completePublicationConversation(job.sessionId, job.jobId);
              continue;
            }
            if (job.purpose === "TOPIC_PLAN") {
              await this.db.completeTopicPlanningJob(job.sessionId, job.jobId);
              continue;
            }
            if (job.purpose === "PUBLICATION_REVIEW") {
              await this.db.completePublicationReviewJob(job.sessionId, job.jobId);
              continue;
            }
            if (job.purpose === "PUBLICATION_PLAN") {
              await this.db.completePublicationPlanningJob(job.sessionId, job.jobId);
              continue;
            }
            const replyId = await this.db.findTextGenerationReply(job.sessionId, run.runId);
            if (!replyId) {
              await this.db.failTextGenerationJob(job.sessionId, job.jobId, "TEXT_REPLY_MISSING");
              continue;
            }
            const draft =
              job.intent === "MODIFY" && job.targetDraftId && job.targetRevision !== null
                ? await this.db.applyGeneratedRevision(
                    job.sessionId,
                    job.targetDraftId,
                    job.targetRevision,
                    replyId,
                    `text-job:${job.jobId}`,
                  )
                : await this.db.createContentDraft(job.sessionId, replyId, job.title, `text-job:${job.jobId}`);
            await this.db.completeTextGenerationJob(job.sessionId, job.jobId, draft.draftId);
          } else if (run.status === "FAILED" || run.status === "CANCELLED") {
            await this.db.failTextGenerationJob(
              job.sessionId,
              job.jobId,
              job.purpose === "PUBLICATION_SUMMARY" && run.errorCode ? run.errorCode : `TEXT_RUN_${run.status}`,
            );
          }
        } catch (error) {
          if (error instanceof Error && error.message === "SESSION_RUN_ACTIVE") continue;
          if (
            error instanceof Error &&
            [
              "TASK_BUDGET_EXHAUSTED",
              "ASYNC_RESULT_INVALID",
              "ASYNC_RESULT_SUPERSEDED",
              "RESEARCH_SOURCE_SUPERSEDED",
              "RESEARCH_SOURCE_INVALID",
              "RESEARCH_CONTEXT_LIMIT",
              "RESEARCH_RESULT_MISSING",
              "PUBLICATION_REPAIR_INVALID",
              "PUBLICATION_REPAIR_SCOPE_INVALID",
              "PUBLICATION_REPAIR_INCOMPLETE",
              "PUBLICATION_REPAIR_ANCHOR_INVALID",
              "PUBLICATION_REPAIR_NO_PROGRESS",
              "PUBLICATION_REPAIR_SOURCE_CHANGED",
              "PUBLICATION_REPAIR_REVIEW_INVALID",
              "REVIEW_PREVIOUS_ISSUES_INVALID",
              "PUBLICATION_REVIEW_INVALID",
              "PUBLICATION_REVIEW_SOURCE_INVALID",
              "PUBLICATION_PLAN_INVALID",
              "PUBLICATION_REVISION_CONFLICT",
              "PUBLICATION_INPUT_INVALID",
              "PUBLICATION_IMAGE_PENDING",
              "CONTENT_INPUT_INVALID",
              "CONTENT_OUTPUT_INVALID",
              "CONTENT_SOURCE_INVALID",
              "CONTENT_REVISION_CONFLICT",
              "PRODUCT_SOURCE_CHANGED",
              "SESSION_NOT_ACTIVE",
              "TOPIC_NOT_FOUND",
              "TOPIC_REVISION_CONFLICT",
              "TOPIC_REFERENCE_INVALID",
              "TOPIC_SOURCE_INVALID",
              "TOPIC_SOURCE_STALE",
              "PUBLICATION_REVISION_CONFLICT",
              "PUBLICATION_PLAN_INVALID",
              "PUBLICATION_CONVERSATION_INVALID",
              "TASK_CONTEXT_LIMIT",
              "TASK_CONTEXT_NOT_FOUND",
              "TASK_CONTEXT_SOURCE_INVALID",
              "TASK_CONTEXT_DELTA_INVALID",
              "TASK_CONTEXT_REVISION_CONFLICT",
              "TASK_CONTEXT_REQUIREMENTS_PENDING",
              "INPUT_VERSION_STALE",
              "PUBLICATION_REVIEW_INVALID",
              "PUBLICATION_REVIEW_SOURCE_INVALID",
              "PUBLICATION_EXPERT_UNAVAILABLE",
              "PUBLICATION_EXPERT_INPUT_CHANGED",
              "PUBLICATION_EXPERT_REQUIRED",
              "PUBLICATION_NOT_FOUND",
              "TOPIC_OUTPUT_INVALID",
              "TOPIC_SOURCE_EXPIRED",
              "TOPIC_IMAGE_UNAVAILABLE",
            ].includes(error.message)
          ) {
            await this.db.failTextGenerationJob(job.sessionId, job.jobId, error.message);
            continue;
          }
          process.stderr.write(
            `[generation] 文案任务 ${job.jobId} 等待恢复：${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      if (this.conversation) {
        for (const item of await this.db.listRunnablePublicationConversations()) {
          const images = await this.db.advancePublicationConversation(
            item.sessionId,
            item.jobId,
            this.conversation.imageModelId,
            this.conversation.imageInput,
          );
          for (const image of images) this.conversation.enqueue(image);
        }
      }
    } catch (error) {
      process.stderr.write(
        `[generation] 文案任务扫描失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      this.busy = false;
    }
  }
}

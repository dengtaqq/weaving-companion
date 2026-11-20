import { type GenerationJobRecord, SEEDREAM_IMAGE_STRATEGY_VERSION } from "../../../../shared/contracts.js";
import type { FileStore } from "../../../infrastructure/files/files.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";
import { prepareImageInput } from "../infrastructure/image-input.js";
import { ImageMediaError, type ImageMediaPort } from "../infrastructure/image-media-port.js";

/** 领取并执行持久图片任务；付费调用之后的任何不确定性都保持可对账。 */
export class GenerationService {
  private readonly active = new Map<string, Promise<void>>();
  private stopping = false;

  /** 保存任务依赖；Provider 未配置时入口不提交任务。 */
  constructor(
    private readonly db: DbClient,
    private readonly files: FileStore,
    private readonly provider: ImageMediaPort | null,
    private readonly configuredModel: string | null,
  ) {}

  /** Host 重启时仅恢复尚未向 Provider 发出的任务。 */
  async start(): Promise<{ unknown: number }> {
    const recovered = await this.db.recoverGenerationJobs();
    for (const job of recovered.queued) this.enqueue(job);
    return { unknown: recovered.unknown };
  }

  /** 接收受理后任务；同一个任务在进程中最多运行一次。 */
  enqueue(job: GenerationJobRecord): void {
    if (this.stopping || !this.provider || job.status !== "QUEUED" || this.active.has(job.jobId)) return;
    const task = this.execute(job).finally(() => this.active.delete(job.jobId));
    this.active.set(job.jobId, task);
  }

  /** 等待已发出的请求完成或超时，避免关闭数据库时丢失回执。 */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.active.values());
  }

  /** 在持久 claim 后读取冻结参考图、调用供应商并登记受管结果。 */
  private async execute(accepted: GenerationJobRecord): Promise<void> {
    let job: GenerationJobRecord;
    try {
      // 先持久领取任务；若任务已被取消、被其他执行器领取或状态已变化，就不重复执行。
      job = await this.db.claimGenerationJob(accepted.sessionId, accepted.jobId);
      if (job.status !== "RUNNING") return;
    } catch {
      return;
    }
    // 标记是否越过外部调用边界，用于区分可确定失败与结果未知的外部副作用。
    let providerStarted = false;
    let providerRequestId: string | null = null;
    try {
      // 任务保存了受理时的模型和策略版本；配置变更后不能用新配置代跑旧任务。
      if (
        !this.provider ||
        job.modelId !== this.configuredModel ||
        job.modelVersion !== SEEDREAM_IMAGE_STRATEGY_VERSION
      )
        throw new ImageMediaError("IMAGE_MODEL_CHANGED", false);
      let reference: { mimeType: string; bytes: Buffer } | undefined;
      if (job.referenceArtifactId && job.referenceHash) {
        const artifact = await this.db.getArtifact(job.referenceArtifactId);
        // 按会话归属、内容哈希和 READY 状态复核冻结素材，避免读取被替换或失效的图片。
        if (
          artifact?.sessionId !== job.sessionId ||
          artifact.blobHash !== job.referenceHash ||
          artifact.status !== "READY"
        )
          throw new ImageMediaError("IMAGE_REFERENCE_CHANGED", false);
        reference = await prepareImageInput(await this.files.readBlob(job.referenceHash), artifact.mimeType);
      }
      // 在发出请求前设置标记：调用超时也可能已被供应商受理，不能当作确定失败后盲目重试。
      providerStarted = true;
      const result = await this.provider.submit(job, reference);
      providerRequestId = result.providerRequestId;
      const blob = await this.files.putBlob(result.bytes);
      // 先保存结果文件，再登记任务完成，确保成功状态始终指向已受管的图片内容。
      await this.db.completeGenerationJob(
        job.sessionId,
        job.jobId,
        blob.hash,
        blob.size,
        result.mimeType,
        providerRequestId,
      );
    } catch (error) {
      const known = error instanceof ImageMediaError ? error : null;
      // 外发后遇到不确定错误时保留 UNKNOWN_EXTERNAL，避免重发造成重复生成或重复计费。
      const status = providerStarted && (!known || known.unknownExternal) ? "UNKNOWN_EXTERNAL" : "FAILED";
      const code = known?.code ?? (providerStarted ? "IMAGE_RESULT_PERSISTENCE_UNKNOWN" : "IMAGE_INPUT_UNAVAILABLE");
      await this.db
        .finishGenerationJob(job.sessionId, job.jobId, status, code, known?.providerRequestId ?? providerRequestId)
        .catch(() => {
          process.stderr.write(`[generation] ${job.jobId} 无法保存失败状态\n`);
        });
    }
  }
}

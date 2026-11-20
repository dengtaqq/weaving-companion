import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type GenerationJobRecord,
  MAX_MANAGED_IMAGE_BYTES,
  SEEDREAM_IMAGE_STRATEGY_VERSION,
} from "../../../../shared/contracts.js";

import type { PublicationImageTarget } from "../../../../shared/publication.js";
import { bindPublicationImageJob } from "../../publication/infrastructure/publication-store.js";

type Row = Record<string, unknown>;

/** 将 SQLite 行转换为对外可见的素材任务。 */
function job(row: Row): GenerationJobRecord {
  return {
    jobId: String(row.job_id),
    sessionId: String(row.session_id),
    merchantId: row.merchant_id === null ? null : String(row.merchant_id),
    intent: row.intent as GenerationJobRecord["intent"],
    kind: "IMAGE",
    status: row.status as GenerationJobRecord["status"],
    prompt: String(row.prompt),
    inputHash: String(row.input_hash),
    modelId: String(row.model_id),
    modelVersion: String(row.model_version),
    size: row.size as GenerationJobRecord["size"],
    quality: row.quality as GenerationJobRecord["quality"],
    referenceArtifactId: row.reference_artifact_id === null ? null : String(row.reference_artifact_id),
    referenceHash: row.reference_hash === null ? null : String(row.reference_hash),
    resultArtifactId: row.result_artifact_id === null ? null : String(row.result_artifact_id),
    providerRequestId: row.provider_request_id === null ? null : String(row.provider_request_id),
    errorCode: row.error_code === null ? null : String(row.error_code),
    attempt: Number(row.attempt),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 在 DB Worker 中维持图片任务的归属、输入快照、状态转换与产物原子登记。 */
export function createGenerationOperations(db: DatabaseSync, transaction: <T>(operation: () => T) => T) {
  /** 读取本会话持有的任务；任务 ID 不授予跨会话访问权。 */
  function read(sessionId: string, jobId: string): GenerationJobRecord | null {
    const row = db
      .prepare("SELECT * FROM generation_job WHERE session_id = ? AND job_id = ? AND kind = 'IMAGE'")
      .get(sessionId, jobId) as Row | undefined;
    return row ? job(row) : null;
  }

  return {
    /** 冻结一次显式确认费用的请求；相同请求键只返回同一任务。 */
    createImageJob: (
      id: string,
      sessionId: string,
      prompt: string,
      modelId: string,
      size: GenerationJobRecord["size"],
      quality: GenerationJobRecord["quality"],
      referenceArtifactId: string | null,
      requestKey: string,
      now: string,
      publication?: PublicationImageTarget,
    ): GenerationJobRecord =>
      transaction(() => {
        const requestHash = createHash("sha256")
          .update(JSON.stringify({ sessionId, prompt, modelId, size, quality, referenceArtifactId, publication }))
          .digest("hex");
        const existing = db.prepare("SELECT * FROM generation_job WHERE request_key = ?").get(requestKey) as
          | Row
          | undefined;
        if (existing) {
          if (existing.kind !== "IMAGE" || existing.request_hash !== requestHash)
            throw new Error("IDEMPOTENCY_CONFLICT");
          return job(existing);
        }
        const session = db
          .prepare("SELECT scope, owner_id, lifecycle_status FROM session WHERE session_id = ?")
          .get(sessionId) as Row | undefined;
        if (!session) throw new Error("SESSION_NOT_FOUND");
        if (session.lifecycle_status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
        const reference = referenceArtifactId
          ? (db
              .prepare("SELECT * FROM artifact WHERE artifact_id = ? AND session_id = ?")
              .get(referenceArtifactId, sessionId) as Row | undefined)
          : null;
        if (
          referenceArtifactId &&
          (reference?.status !== "READY" ||
            !["image/png", "image/jpeg", "image/webp"].includes(String(reference.mime_type)) ||
            Number(reference.size_bytes) > MAX_MANAGED_IMAGE_BYTES)
        )
          throw new Error("IMAGE_REFERENCE_INVALID");
        if (publication) bindPublicationImageJob(db, sessionId, publication, id, now);
        const referenceHash = reference ? String(reference.blob_hash) : null;
        const inputHash = createHash("sha256")
          .update(JSON.stringify({ sessionId, prompt, modelId, size, quality, referenceArtifactId, referenceHash }))
          .digest("hex");
        db.prepare(`INSERT INTO generation_job(job_id, session_id, merchant_id, intent, kind, status,
        prompt, input_hash, model_id, model_version, size, quality, reference_artifact_id,
        reference_hash, request_key, request_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'IMAGE', 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id,
          sessionId,
          session.scope === "MERCHANT" ? String(session.owner_id) : null,
          reference ? "MODIFY" : "CREATE",
          prompt,
          inputHash,
          modelId,
          SEEDREAM_IMAGE_STRATEGY_VERSION,
          size,
          quality,
          referenceArtifactId,
          referenceHash,
          requestKey,
          requestHash,
          now,
          now,
        );
        return read(sessionId, id) as GenerationJobRecord;
      }),

    /** 列出本会话任务，包括结果未知的付费请求。 */
    listGenerationJobs: (sessionId: string): GenerationJobRecord[] =>
      (
        db
          .prepare(
            "SELECT * FROM generation_job WHERE session_id = ? AND kind = 'IMAGE' ORDER BY created_at DESC LIMIT 100",
          )
          .all(sessionId) as Row[]
      ).map(job),

    /** 读取任务当前状态。 */
    getGenerationJob: read,

    /** 只领取从未外发的任务；先登记 attempt 再允许 Provider 调用。 */
    claimGenerationJob: (sessionId: string, jobId: string, now: string): GenerationJobRecord =>
      transaction(() => {
        const current = read(sessionId, jobId);
        if (!current) throw new Error("GENERATION_JOB_NOT_FOUND");
        if (current.status !== "QUEUED") return current;
        db.prepare("UPDATE generation_job SET status = 'RUNNING', attempt = 1, updated_at = ? WHERE job_id = ?").run(
          now,
          jobId,
        );
        db.prepare(`INSERT INTO generation_step_attempt
        (job_id, step_key, attempt, input_hash, strategy_version, status, started_at)
        VALUES (?, 'IMAGE_PROVIDER', 1, ?, ?, 'RUNNING', ?)`).run(jobId, current.inputHash, current.modelVersion, now);
        return read(sessionId, jobId) as GenerationJobRecord;
      }),

    /** Provider 回执和已校验 Blob 同事务登记，任务才可进入待审核。 */
    completeGenerationJob: (
      sessionId: string,
      jobId: string,
      artifactId: string,
      hash: string,
      size: number,
      mime: string,
      providerRequestId: string | null,
      now: string,
    ): GenerationJobRecord =>
      transaction(() => {
        const current = read(sessionId, jobId);
        if (!current) throw new Error("GENERATION_JOB_NOT_FOUND");
        if (current.status !== "RUNNING") throw new Error("GENERATION_JOB_STATE_CONFLICT");
        if (db.prepare("SELECT 1 FROM blob_gc WHERE blob_hash = ?").get(hash)) throw new Error("BLOB_GC_IN_PROGRESS");
        const title = `生成图片-${jobId.slice(-8)}.png`;
        db.prepare(`INSERT INTO artifact(artifact_id, session_id, kind, title, blob_hash, mime_type, size_bytes, status, created_at)
        VALUES (?, ?, 'generated_image', ?, ?, ?, ?, 'READY', ?)`).run(
          artifactId,
          sessionId,
          title,
          hash,
          mime,
          size,
          now,
        );
        db.prepare(
          "UPDATE generation_step_attempt SET status = 'SUCCEEDED', provider_request_id = ?, output_artifact_id = ?, finished_at = ? WHERE job_id = ? AND step_key = 'IMAGE_PROVIDER' AND attempt = 1",
        ).run(providerRequestId, artifactId, now, jobId);
        db.prepare(
          "UPDATE generation_job SET status = 'READY_FOR_REVIEW', result_artifact_id = ?, provider_request_id = ?, updated_at = ? WHERE job_id = ?",
        ).run(artifactId, providerRequestId, now, jobId);
        return read(sessionId, jobId) as GenerationJobRecord;
      }),

    /** 明确失败或结果未知均保留 attempt；未知结果禁止自动重发。 */
    finishGenerationJob: (
      sessionId: string,
      jobId: string,
      status: "FAILED" | "UNKNOWN_EXTERNAL",
      errorCode: string,
      providerRequestId: string | null,
      now: string,
    ): GenerationJobRecord =>
      transaction(() => {
        const current = read(sessionId, jobId);
        if (!current) throw new Error("GENERATION_JOB_NOT_FOUND");
        if (current.status !== "RUNNING") return current;
        db.prepare(
          "UPDATE generation_step_attempt SET status = ?, error_code = ?, provider_request_id = ?, finished_at = ? WHERE job_id = ? AND step_key = 'IMAGE_PROVIDER' AND attempt = 1",
        ).run(status, errorCode, providerRequestId, now, jobId);
        db.prepare(
          "UPDATE generation_job SET status = ?, error_code = ?, provider_request_id = ?, updated_at = ? WHERE job_id = ?",
        ).run(status, errorCode, providerRequestId, now, jobId);
        return read(sessionId, jobId) as GenerationJobRecord;
      }),

    /** 崩溃恢复时只重新执行未领取的任务，已外发的任务转人工对账。 */
    recoverGenerationJobs: (now: string): { queued: GenerationJobRecord[]; unknown: number } =>
      transaction(() => {
        const running = db
          .prepare("SELECT session_id, job_id FROM generation_job WHERE kind = 'IMAGE' AND status = 'RUNNING'")
          .all() as Row[];
        for (const item of running) {
          db.prepare(
            "UPDATE generation_step_attempt SET status = 'UNKNOWN_EXTERNAL', error_code = 'HOST_INTERRUPTED', finished_at = ? WHERE job_id = ? AND status = 'RUNNING'",
          ).run(now, String(item.job_id));
          db.prepare(
            "UPDATE generation_job SET status = 'UNKNOWN_EXTERNAL', error_code = 'HOST_INTERRUPTED', updated_at = ? WHERE job_id = ?",
          ).run(now, String(item.job_id));
        }
        return {
          queued: (
            db
              .prepare("SELECT * FROM generation_job WHERE kind = 'IMAGE' AND status = 'QUEUED' ORDER BY created_at")
              .all() as Row[]
          ).map(job),
          unknown: running.length,
        };
      }),
  };
}

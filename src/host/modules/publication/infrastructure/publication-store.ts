import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import AjvModule from "ajv/dist/2020.js";
import {
  type ArtifactRecord,
  type ContentDraftRecord,
  MAX_MANAGED_IMAGE_BYTES,
  type TextGenerationJobRecord,
} from "../../../../shared/contracts.js";
import {
  type PublicationDetail,
  type PublicationExport,
  type PublicationFields,
  type PublicationImageTarget,
  type PublicationRecord,
  publicationFieldsSchema,
  publicationPlanSchema,
} from "../../../../shared/publication.js";
import type { TextTaskSource } from "../../../../shared/topics.js";
import {
  assertCurrentTaskContextForRun,
  readTaskContextForDraft,
} from "../../sessions/infrastructure/task-context-store.js";
import { applyPublicationRepair } from "../domain/publication-repair.js";
import { assertPublicationRepairBasis } from "./publication-repair-source.js";

type Row = Record<string, unknown>;
const validatePlan = new AjvModule.default().compile<{
  visualStyle: string;
  instructions: string;
  images: Array<{ title: string; prompt: string }>;
}>(publicationPlanSchema);
const validateFields = new AjvModule.default().compile<PublicationFields>(publicationFieldsSchema);

/** 计算整个待交付快照的稳定摘要，导出提交前再次复核。 */
export function publicationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 读取编排；旧草稿可从空编排开始，不通过 GET 隐式写入。 */
export function readPublication(db: DatabaseSync, draftId: string): PublicationRecord {
  const row = db.prepare("SELECT * FROM content_publication WHERE draft_id = ?").get(draftId) as Row | undefined;
  return row
    ? {
        ...JSON.parse(String(row.body_json)),
        draftId,
        revision: Number(row.revision),
        updatedAt: String(row.updated_at),
      }
    : { draftId, revision: 0, instructions: "", visualStyle: "", images: [], updatedAt: "" };
}

/** 追加编排版本；所有调用方先在同一事务中完成 CAS 和归属校验。 */
function writePublication(
  db: DatabaseSync,
  current: PublicationRecord,
  fields: PublicationFields,
  now: string,
): PublicationRecord {
  const next = { ...fields, draftId: current.draftId, revision: current.revision + 1, updatedAt: now };
  db.prepare(`INSERT INTO content_publication(draft_id, revision, body_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(draft_id) DO UPDATE SET revision=excluded.revision, body_json=excluded.body_json, updated_at=excluded.updated_at`).run(
    next.draftId,
    next.revision,
    JSON.stringify({ instructions: fields.instructions, visualStyle: fields.visualStyle, images: fields.images }),
    now,
  );
  return next;
}

/** 把真实导出回执关联到等待确认的同一双版本对话。 */
function finishConversationExport(
  db: DatabaseSync,
  sessionId: string,
  draftId: string,
  draftRevision: number,
  publicationRevision: number,
  artifactId: string,
  now: string,
): void {
  db.prepare(`UPDATE generation_job SET source_json=json_set(source_json,'$.workflow.state','DONE','$.workflow.exportArtifactId',?,'$.workflow.receipt','发布包已生成，可以下载。'),updated_at=?
    WHERE session_id=? AND purpose='PUBLICATION_CHAT' AND json_extract(source_json,'$.workflow.state')='WAITING_FINAL_CONFIRMATION'
    AND json_extract(source_json,'$.workflow.draftId')=? AND json_extract(source_json,'$.workflow.draftRevision')=? AND json_extract(source_json,'$.workflow.publicationRevision')=?`).run(
    artifactId,
    now,
    sessionId,
    draftId,
    draftRevision,
    publicationRevision,
  );
}

/** 在图片任务受理事务内绑定笔记槽位，阻止重复外发及过时正文生图。 */
export function bindPublicationImageJob(
  db: DatabaseSync,
  sessionId: string,
  target: PublicationImageTarget,
  jobId: string,
  now: string,
): void {
  const draft = db
    .prepare(`SELECT d.current_revision, s.lifecycle_status FROM content_draft d JOIN session s ON s.session_id=d.session_id
    WHERE d.draft_id=? AND d.session_id=?`)
    .get(target.draftId, sessionId) as Row | undefined;
  if (draft?.lifecycle_status !== "ACTIVE") throw new Error("PUBLICATION_NOT_FOUND");
  const publication = readPublication(db, target.draftId);
  if (draft.current_revision !== target.draftRevision || publication.revision !== target.publicationRevision)
    throw new Error("PUBLICATION_REVISION_CONFLICT");
  const slot = publication.images.find((item) => item.slotId === target.slotId);
  if (!slot) throw new Error("PUBLICATION_IMAGE_INVALID");
  if (slot.jobId) {
    const prior = db
      .prepare("SELECT status FROM generation_job WHERE job_id=? AND session_id=?")
      .get(slot.jobId, sessionId) as Row | undefined;
    if (prior && ["QUEUED", "RUNNING", "UNKNOWN_EXTERNAL"].includes(String(prior.status)))
      throw new Error("PUBLICATION_IMAGE_PENDING");
  }
  writePublication(
    db,
    publication,
    {
      ...publication,
      images: publication.images.map((item) => (item.slotId === slot.slotId ? { ...item, jobId } : item)),
    },
    now,
  );
}

/** 管理一篇笔记的图片编排、明确确认的交付版本及同会话图片引用。 */
export function createPublicationOperations(
  db: DatabaseSync,
  transaction: <T>(operation: () => T) => T,
  getDraft: (sessionId: string, draftId: string) => { draft: ContentDraftRecord } | null,
  readJob: (sessionId: string, jobId: string) => TextGenerationJobRecord | null,
) {
  /** 把 SQLite 图片行映射为受管文件元数据。 */
  function artifact(row: Row): ArtifactRecord {
    return {
      artifactId: String(row.artifact_id),
      sessionId: String(row.session_id),
      kind: row.kind as ArtifactRecord["kind"],
      title: String(row.title),
      blobHash: String(row.blob_hash),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      status: String(row.status),
    };
  }
  /** 读取同会话草稿，写操作同时检查会话仍活动。 */
  function requireDraft(sessionId: string, draftId: string, writable = false): ContentDraftRecord {
    const draft = getDraft(sessionId, draftId)?.draft;
    if (!draft) throw new Error("PUBLICATION_NOT_FOUND");
    if (writable) {
      const session = db.prepare("SELECT lifecycle_status FROM session WHERE session_id=?").get(sessionId) as Row;
      if (session.lifecycle_status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    }
    return draft;
  }
  /** 列出真正可用于这篇笔记的图片，上传与生成结果遵守同一归属边界。 */
  function images(sessionId: string): ArtifactRecord[] {
    return (
      db
        .prepare(`SELECT * FROM artifact WHERE session_id=? AND status='READY' AND kind IN ('upload','generated_image')
      AND mime_type IN ('image/png','image/jpeg','image/webp') AND size_bytes <= ? ORDER BY created_at DESC`)
        .all(sessionId, MAX_MANAGED_IMAGE_BYTES) as Row[]
    ).map(artifact);
  }
  /** 校验采用图片和任务引用，不接受跨会话或不受管的图片地址。 */
  function validateReferences(sessionId: string, fields: PublicationFields): void {
    if (
      !validateFields({ instructions: fields.instructions, visualStyle: fields.visualStyle, images: fields.images }) ||
      new Set(fields.images.map((item) => item.slotId)).size !== fields.images.length
    )
      throw new Error("PUBLICATION_INPUT_INVALID");
    const allowed = new Set(images(sessionId).map((item) => item.artifactId));
    for (const image of fields.images) {
      if (!image.title.trim() || (image.artifactId && !allowed.has(image.artifactId)))
        throw new Error("PUBLICATION_IMAGE_INVALID");
      if (
        image.jobId &&
        !db
          .prepare("SELECT 1 FROM generation_job WHERE job_id=? AND session_id=? AND kind='IMAGE'")
          .get(image.jobId, sessionId)
      )
        throw new Error("PUBLICATION_IMAGE_INVALID");
    }
  }
  /** 读取最初创作的固定来源，AI 修订继承这一份事实与模板。 */
  function source(sessionId: string, draftId: string): TextTaskSource | null {
    const row = db
      .prepare(
        "SELECT source_json FROM generation_job WHERE session_id=? AND result_draft_id=? AND purpose='CONTENT' AND json_extract(source_json,'$.repair') IS NULL ORDER BY rowid LIMIT 1",
      )
      .get(sessionId, draftId) as Row | undefined;
    return row?.source_json ? JSON.parse(String(row.source_json)) : null;
  }
  /** 只读取这篇笔记最新的图位规划任务。 */
  function planningJob(sessionId: string, draftId: string): TextGenerationJobRecord | null {
    const row = db
      .prepare(
        "SELECT job_id FROM generation_job WHERE session_id=? AND target_draft_id=? AND purpose='PUBLICATION_PLAN' ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId, draftId) as Row | undefined;
    return row ? readJob(sessionId, String(row.job_id)) : null;
  }
  /** 未知或仍运行的付费请求必须保持绑定，不能通过删图位或重新规划绕过重试保护。 */
  function requirePendingImagesRetained(sessionId: string, current: PublicationRecord, next: PublicationFields): void {
    for (const image of current.images) {
      if (!image.jobId) continue;
      const job = db
        .prepare("SELECT status FROM generation_job WHERE job_id=? AND session_id=?")
        .get(image.jobId, sessionId) as Row | undefined;
      if (!job || !["QUEUED", "RUNNING", "UNKNOWN_EXTERNAL"].includes(String(job.status))) continue;
      if (!next.images.some((item) => item.slotId === image.slotId && item.jobId === image.jobId))
        throw new Error("PUBLICATION_IMAGE_PENDING");
    }
  }
  /** 读取用户将要确认的完整图文快照，正文和所有图片均须可用。 */
  function snapshot(sessionId: string, draftId: string, draftRevision: number, publicationRevision: number) {
    const draft = requireDraft(sessionId, draftId, true);
    const publication = readPublication(db, draftId);
    if (draft.currentRevision !== draftRevision || publication.revision !== publicationRevision)
      throw new Error("PUBLICATION_REVISION_CONFLICT");
    validateReferences(sessionId, publication);
    if (!publication.images.length || publication.images.some((item) => !item.artifactId))
      throw new Error("PUBLICATION_IMAGES_REQUIRED");
    const available = images(sessionId);
    return {
      draft,
      publication,
      source: source(sessionId, draftId),
      images: publication.images.map(
        (item) => available.find((file) => file.artifactId === item.artifactId) as ArtifactRecord,
      ),
    };
  }
  return {
    /** 按固定正文创建图位与发布说明规划；不自动外发生图。 */
    createPublicationPlanningJob: (
      id: string,
      sessionId: string,
      draftId: string,
      draftRevision: number,
      publicationRevision: number,
      brief: string,
      modelId: string,
      key: string,
      now: string,
      imageCount?: number,
      freezeDraftTaskContext = true,
    ): TextGenerationJobRecord =>
      transaction(() => {
        const requestedImages = imageCount ?? 1;
        if (!Number.isInteger(requestedImages) || requestedImages < 1 || requestedImages > 9)
          throw new Error("PUBLICATION_INPUT_INVALID");
        const requestHash = publicationHash({
          sessionId,
          draftId,
          draftRevision,
          publicationRevision,
          brief,
          modelId,
          ...(imageCount === undefined ? {} : { imageCount }),
        });
        const prior = db.prepare("SELECT * FROM generation_job WHERE request_key=?").get(key) as Row | undefined;
        if (prior) {
          if (prior.request_hash !== requestHash || prior.purpose !== "PUBLICATION_PLAN")
            throw new Error("IDEMPOTENCY_CONFLICT");
          return readJob(sessionId, String(prior.job_id)) as TextGenerationJobRecord;
        }
        const draft = requireDraft(sessionId, draftId, true);
        const publication = readPublication(db, draftId);
        if (draft.currentRevision !== draftRevision || publication.revision !== publicationRevision)
          throw new Error("PUBLICATION_REVISION_CONFLICT");
        if (["QUEUED", "RUNNING"].includes(planningJob(sessionId, draftId)?.status ?? ""))
          throw new Error("PUBLICATION_IMAGE_PENDING");
        requirePendingImagesRetained(sessionId, publication, { ...publication, images: [] });
        const taskContext = freezeDraftTaskContext ? readTaskContextForDraft(db, sessionId, draftId) : null;
        const originalSource = source(sessionId, draftId);
        // 新规划是独立任务；原创作的父工作流与旧上下文不能覆盖本次冻结输入。
        const {
          taskContext: _oldContext,
          parentConversationJobId: _oldParent,
          workflow: _oldWorkflow,
          ...creationSource
        } = originalSource ?? {};
        const frozen: TextTaskSource = {
          ...creationSource,
          ...(taskContext && { taskContext }),
          references: [],
          publication: { draftId, draftRevision, publicationRevision },
          planningImageCount: requestedImages,
          conversation: { instruction: brief || `为这一篇规划${requestedImages}张配图` },
        };
        const prompt = [
          `只为当前这一篇小红书笔记规划${requestedImages}张图片和发布说明，images必须恰好${requestedImages}项，不额外扩展内页、多篇笔记或整组素材。默认每篇1张封面，只有用户显式增加张数才增加配图。按需使用image-creation Skill或视觉专家。只输出下列Schema约定的JSON；这一步不生成图片，不宣称已有实拍或已发布。`,
          "本工作台的实际操作是：在配图步骤上传或从商家素材库选图、逐图确认费用后发起AI生图/改图、选择采用、保存编排、整套审核、下载ZIP。图片服务可用性以页面配置状态为准；你本轮只做文字方案，不能据此声称系统未接入生图。工作台没有自由画布或文字叠加编辑器，需要手工排字时说明在外部工具排版后上传最终图片，不能让用户寻找不存在的功能。发布说明不必抄写内部资料ID或断言当前服务不可用。",
          JSON.stringify(publicationPlanSchema),
          "每张提示写清用途、构图、需要的文字、固定尺寸1280×1920（比例2:3）和必须保留的真实事实。需要真实商品或门店时标明需要实拍，不伪造实际记录。发布说明必须有图片顺序、复制文案、门店信息核对、平台预览和人工发布步骤，未确认信息列为待补。说明中的标题/正文统一指向发布包文案.txt，不重复复制具体文案，以免后续改稿过期；只列使用说明，不声称已生成或已发布。",
          `以下是固定的资料数据：${JSON.stringify({ title: draft.title, body: draft.body, source: frozen, currentStyle: publication.visualStyle })}`,
          `本次要求：${brief || "与正文一致、自然具体，实拍优先"}`,
        ].join("\n\n");
        if (prompt.length > 50000) throw new Error("PUBLICATION_INPUT_INVALID");
        db.prepare(`INSERT INTO generation_job(job_id,session_id,merchant_id,intent,kind,status,title,prompt,input_hash,model_id,model_version,purpose,source_json,target_draft_id,target_revision,target_hash,request_key,request_hash,created_at,updated_at)
        VALUES (?,?,?,'CREATE','TEXT','QUEUED',?,?,?,?,?,'PUBLICATION_PLAN',?,?,?,?,?,?,?,?)`).run(
          id,
          sessionId,
          draft.merchantId,
          `${draft.title} · 图位规划`,
          prompt,
          publicationHash({ prompt, modelId }),
          modelId,
          "publication-plan-v3",
          JSON.stringify(frozen),
          draftId,
          draftRevision,
          draft.sha256,
          key,
          requestHash,
          now,
          now,
        );
        return readJob(sessionId, id) as TextGenerationJobRecord;
      }),
    /** 校验真实成功 Run 的 JSON 后原子保存图位；版本变化时保留现有编排。 */
    completePublicationPlanningJob: (sessionId: string, jobId: string, now: string): TextGenerationJobRecord =>
      transaction(() => {
        const job = readJob(sessionId, jobId);
        if (job?.purpose !== "PUBLICATION_PLAN" || !job.source?.publication)
          throw new Error("PUBLICATION_INPUT_INVALID");
        if (job.status === "READY_FOR_REVIEW") return job;
        if (job.sourceRunId) assertCurrentTaskContextForRun(db, job.sourceRunId);
        const target = job.source.publication;
        const draft = requireDraft(sessionId, target.draftId, true);
        const current = readPublication(db, target.draftId);
        if (draft.currentRevision !== target.draftRevision || current.revision !== target.publicationRevision)
          throw new Error("PUBLICATION_REVISION_CONFLICT");
        const run = db
          .prepare("SELECT status FROM agent_run WHERE run_id=? AND session_id=?")
          .get(job.sourceRunId, sessionId) as Row | undefined;
        if (job.status !== "RUNNING" || run?.status !== "SUCCEEDED") throw new Error("GENERATION_JOB_STATE_CONFLICT");
        const reply = db
          .prepare(
            "SELECT content_json FROM message WHERE run_id=? AND session_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1",
          )
          .get(job.sourceRunId, sessionId) as Row | undefined;
        if (job.source.repair) {
          if (job.source.repair.scope !== "PUBLICATION") throw new Error("PUBLICATION_REPAIR_SCOPE_INVALID");
          assertPublicationRepairBasis(db, sessionId, job.source.repair);
          const fields = applyPublicationRepair(
            String(JSON.parse(String(reply?.content_json)).text),
            job.source.repair,
          ).publication;
          const { instructions, visualStyle, images } = fields;
          if (!validateFields({ instructions, visualStyle, images })) throw new Error("PUBLICATION_INPUT_INVALID");
          validateReferences(sessionId, fields);
          for (const image of fields.images) {
            const prior = current.images.find((slot) => slot.slotId === image.slotId);
            if (!prior?.jobId || (prior.title === image.title && prior.prompt === image.prompt)) continue;
            const pending = db
              .prepare("SELECT status FROM generation_job WHERE job_id=? AND session_id=?")
              .get(prior.jobId, sessionId) as Row | undefined;
            if (pending && ["QUEUED", "RUNNING", "UNKNOWN_EXTERNAL"].includes(String(pending.status)))
              throw new Error("PUBLICATION_IMAGE_PENDING");
          }
          requirePendingImagesRetained(sessionId, current, fields);
          writePublication(
            db,
            current,
            { instructions: fields.instructions, visualStyle: fields.visualStyle, images: fields.images },
            now,
          );
        } else {
          let output: unknown;
          try {
            output = JSON.parse(
              String(JSON.parse(String(reply?.content_json)).text)
                .trim()
                .replace(/^```(?:json)?\s*/, "")
                .replace(/\s*```$/, ""),
            );
          } catch {
            throw new Error("PUBLICATION_PLAN_INVALID");
          }
          if (
            !validatePlan(output) ||
            !output.visualStyle.trim() ||
            !output.instructions.trim() ||
            output.images.some((item) => !item.title.trim() || !item.prompt.trim())
          )
            throw new Error("PUBLICATION_PLAN_INVALID");
          if (job.source.planningImageCount !== undefined && output.images.length !== job.source.planningImageCount)
            throw new Error("PUBLICATION_PLAN_INVALID");
          writePublication(
            db,
            current,
            {
              ...output,
              images: output.images.map((item) => ({ ...item, slotId: randomUUID(), artifactId: null, jobId: null })),
            },
            now,
          );
        }
        db.prepare(
          "UPDATE generation_job SET status='READY_FOR_REVIEW', result_draft_id=?, updated_at=? WHERE job_id=?",
        ).run(target.draftId, now, jobId);
        db.prepare(
          "UPDATE generation_step_attempt SET status='SUCCEEDED', finished_at=? WHERE job_id=? AND step_key='TEXT_RUN'",
        ).run(now, jobId);
        return readJob(sessionId, jobId) as TextGenerationJobRecord;
      }),
    /** 读取持久图文任务与规划回执，刷新不依赖页面临时状态。 */
    getPublication: (sessionId: string, draftId: string): PublicationDetail => ({
      source: source(sessionId, draftId),
      planningJob: planningJob(sessionId, draftId),
      draft: requireDraft(sessionId, draftId),
      publication: readPublication(db, draftId),
      images: images(sessionId),
      exports: (
        db
          .prepare("SELECT * FROM content_publication_export WHERE draft_id=? ORDER BY created_at DESC")
          .all(draftId) as Row[]
      ).map(
        (row): PublicationExport => ({
          exportId: String(row.export_id),
          artifactId: String(row.artifact_id),
          draftRevision: Number(row.draft_revision),
          publicationRevision: Number(row.publication_revision),
          snapshotHash: String(row.snapshot_hash),
          createdAt: String(row.created_at),
        }),
      ),
    }),
    /** 按预期版本保存配图顺序和发布说明，响应丢失可沿原键重试。 */
    savePublication: (
      sessionId: string,
      draftId: string,
      expectedRevision: number,
      fields: PublicationFields,
      key: string,
      now: string,
    ): PublicationRecord =>
      transaction(() => {
        const requestHash = publicationHash({ sessionId, draftId, expectedRevision, fields });
        const previous = db
          .prepare("SELECT request_hash, result_json FROM api_operation WHERE operation_key=?")
          .get(key) as Row | undefined;
        if (previous) {
          if (previous.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
          return JSON.parse(String(previous.result_json));
        }
        requireDraft(sessionId, draftId, true);
        const current = readPublication(db, draftId);
        if (current.revision !== expectedRevision) throw new Error("PUBLICATION_REVISION_CONFLICT");
        validateReferences(sessionId, fields);
        requirePendingImagesRetained(sessionId, current, fields);
        const next = writePublication(db, current, fields, now);
        db.prepare(
          "INSERT INTO api_operation(operation_key,kind,result_json,request_hash,created_at) VALUES (?,'publication.save',?,?,?)",
        ).run(key, JSON.stringify(next), requestHash, now);
        return next;
      }),
    /** 导出构建前取得完整的同版本快照。 */
    getPublicationSnapshot: snapshot,
    /** 在一笔事务中再次核对版本和来源，再登记真实 ZIP Blob 与交付版本。 */
    completePublicationExport: (
      sessionId: string,
      draftId: string,
      draftRevision: number,
      publicationRevision: number,
      snapshotHash: string,
      exportId: string,
      artifactId: string,
      blobHash: string,
      size: number,
      now: string,
    ): PublicationExport =>
      transaction(() => {
        const current = snapshot(sessionId, draftId, draftRevision, publicationRevision);
        if (publicationHash(current) !== snapshotHash) throw new Error("PUBLICATION_REVISION_CONFLICT");
        const old = db
          .prepare(
            "SELECT * FROM content_publication_export WHERE draft_id=? AND draft_revision=? AND publication_revision=?",
          )
          .get(draftId, draftRevision, publicationRevision) as Row | undefined;
        if (old) {
          finishConversationExport(
            db,
            sessionId,
            draftId,
            draftRevision,
            publicationRevision,
            String(old.artifact_id),
            now,
          );
          return {
            exportId: String(old.export_id),
            artifactId: String(old.artifact_id),
            draftRevision,
            publicationRevision,
            snapshotHash: String(old.snapshot_hash),
            createdAt: String(old.created_at),
          };
        }
        if (db.prepare("SELECT 1 FROM blob_gc WHERE blob_hash=?").get(blobHash)) throw new Error("BLOB_GC_IN_PROGRESS");
        db.prepare(
          "INSERT INTO artifact(artifact_id,session_id,kind,title,blob_hash,mime_type,size_bytes,status,created_at) VALUES (?,?,'publication_zip',?,?, 'application/zip',?,'READY',?)",
        ).run(artifactId, sessionId, `${current.draft.title}-图文发布包.zip`, blobHash, size, now);
        db.prepare(
          "INSERT INTO content_publication_export(export_id,draft_id,artifact_id,draft_revision,publication_revision,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?)",
        ).run(exportId, draftId, artifactId, draftRevision, publicationRevision, snapshotHash, now);
        // 只有真实ZIP登记成功才收口最终确认卡；模型和页面不能提前标记交付完成。
        finishConversationExport(db, sessionId, draftId, draftRevision, publicationRevision, artifactId, now);
        return { exportId, artifactId, draftRevision, publicationRevision, snapshotHash, createdAt: now };
      }),
  };
}

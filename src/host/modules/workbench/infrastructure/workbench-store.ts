import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type ArtifactRecord, MAX_MANAGED_IMAGE_BYTES } from "../../../../shared/contracts.js";
import type {
  ContentTaskSummary,
  MerchantMedia,
  PublicationRecordLink,
  WorkbenchBoard,
  WorkPlan,
  WorkPlanFields,
} from "../../../../shared/workbench.js";

type Row = Record<string, unknown>;

/** 保存人工计划、商家素材与发布登记，并从真实任务计算仪表盘状态。 */
export function createWorkbenchOperations(db: DatabaseSync, transaction: <T>(operation: () => T) => T) {
  /** 同一命令重试返回原回执，同键异参拒绝写入。 */
  function mutation<T>(key: string, input: unknown, now: string, execute: () => T): T {
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return transaction(() => {
      const prior = db
        .prepare("SELECT kind,request_hash,result_json FROM api_operation WHERE operation_key=?")
        .get(key) as Row | undefined;
      if (prior) {
        if (prior.kind !== "workbench.write" || prior.request_hash !== hash) throw Error("IDEMPOTENCY_CONFLICT");
        return JSON.parse(String(prior.result_json));
      }
      const result = execute();
      db.prepare(
        "INSERT INTO api_operation(operation_key,kind,request_hash,result_json,created_at) VALUES (?,'workbench.write',?,?,?)",
      ).run(key, hash, JSON.stringify(result), now);
      return result;
    });
  }
  /** 校验商家存在；会话或商品不能通过 ID 混入其他商家。 */
  function requireMerchant(merchantId: string): void {
    if (!db.prepare("SELECT 1 FROM merchant WHERE merchant_id=? AND status='ACTIVE'").get(merchantId))
      throw Error("MERCHANT_NOT_FOUND");
  }
  /** 把素材行转换成公共元数据，不暴露磁盘路径。 */
  function media(row: Row): MerchantMedia {
    return {
      mediaId: String(row.media_id),
      merchantId: String(row.merchant_id),
      productEntryId: row.product_entry_id ? String(row.product_entry_id) : null,
      title: String(row.title),
      blobHash: String(row.blob_hash),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      status: row.status as MerchantMedia["status"],
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  /** 读取排期所见版本，编辑保留 CAS 边界。 */
  function plan(row: Row): WorkPlan {
    return { ...JSON.parse(String(row.body_json)), revision: Number(row.revision), updatedAt: String(row.updated_at) };
  }
  /** 验证人工计划的日期及资料归属，不把关联会话当成授权扩展。 */
  function validatePlan(fields: WorkPlanFields): void {
    requireMerchant(fields.merchantId);
    if (
      !fields.title.trim() ||
      fields.title.length > 120 ||
      fields.note.length > 2000 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fields.scheduledFor) ||
      Number.isNaN(Date.parse(`${fields.scheduledFor}T12:00:00Z`)) ||
      new Date(`${fields.scheduledFor}T12:00:00Z`).toISOString().slice(0, 10) !== fields.scheduledFor ||
      !["TODO", "DONE", "CANCELLED"].includes(fields.status)
    )
      throw Error("WORKBENCH_INPUT_INVALID");
    if (
      fields.sessionId &&
      !db
        .prepare(
          "SELECT 1 FROM session WHERE session_id=? AND scope='MERCHANT' AND owner_id=? AND lifecycle_status!='TRASHED'",
        )
        .get(fields.sessionId, fields.merchantId)
    )
      throw Error("WORKBENCH_SOURCE_INVALID");
    if (
      fields.draftId &&
      (!fields.sessionId ||
        !db
          .prepare("SELECT 1 FROM content_draft WHERE draft_id=? AND session_id=? AND merchant_id=?")
          .get(fields.draftId, fields.sessionId, fields.merchantId))
    )
      throw Error("WORKBENCH_SOURCE_INVALID");
  }
  /** 批量读取当前稿件版本的各类最新任务，旧版本失败不阻塞当前稿件。 */
  function currentDraftActivities(): Map<string, Row[]> {
    const jobs = db
      .prepare(`
      SELECT j.*,d.draft_id AS activity_draft_id,j.rowid AS activity_order
      FROM generation_job j JOIN content_draft d ON d.draft_id=j.target_draft_id AND d.session_id=j.session_id
      LEFT JOIN content_publication p ON p.draft_id=d.draft_id
      WHERE j.kind='TEXT' AND j.target_revision=d.current_revision
      AND (j.purpose='CONTENT' OR json_extract(j.source_json,'$.publication.publicationRevision')=COALESCE(p.revision,0))
      UNION ALL
      SELECT j.*,p.draft_id AS activity_draft_id,j.rowid AS activity_order
      FROM content_publication p,json_each(p.body_json,'$.images') slot
      JOIN generation_job j ON j.job_id=json_extract(slot.value,'$.jobId') AND j.kind='IMAGE'
      ORDER BY activity_order DESC`)
      .all() as Row[];
    const latest = new Map<string, Map<string, Row>>();
    for (const job of jobs) {
      const id = String(job.activity_draft_id);
      const channels = latest.get(id) ?? new Map<string, Row>();
      const channel = job.kind === "IMAGE" ? String(job.job_id) : String(job.purpose);
      if (!channels.has(channel)) channels.set(channel, job);
      latest.set(id, channels);
    }
    return new Map(Array.from(latest, ([id, channels]) => [id, Array.from(channels.values())]));
  }

  /** 以实际草稿和同版本交付计算内容阶段，修改后自动回到待审核阶段。 */
  function contentTasks(merchantId?: string): ContentTaskSummary[] {
    const rows = db
      .prepare(`SELECT d.draft_id,d.session_id,d.merchant_id,d.current_revision,v.title,p.revision AS publication_revision,p.body_json,m.name AS merchant_name,d.updated_at,
      (SELECT artifact_id FROM content_publication_export e WHERE e.draft_id=d.draft_id AND e.draft_revision=d.current_revision AND e.publication_revision=p.revision LIMIT 1) AS export_artifact,
      (SELECT export_artifact_id FROM publication_record r WHERE r.draft_id=d.draft_id) AS posted_artifact, (SELECT body_json FROM publication_record r WHERE r.draft_id=d.draft_id) AS posted_json
      FROM content_draft d JOIN content_revision v ON v.draft_id=d.draft_id AND v.revision=d.current_revision JOIN session s ON s.session_id=d.session_id LEFT JOIN merchant m ON m.merchant_id=d.merchant_id LEFT JOIN content_publication p ON p.draft_id=d.draft_id
      WHERE s.lifecycle_status!='TRASHED' AND (? IS NULL OR d.merchant_id=?) ORDER BY d.updated_at DESC LIMIT 300`)
      .all(merchantId ?? null, merchantId ?? null) as Row[];
    const activities = currentDraftActivities();
    const tasks: ContentTaskSummary[] = rows.map((row) => {
      const jobs = activities.get(String(row.draft_id)) ?? [];
      const activity =
        jobs.find((job) => job.status === "UNKNOWN_EXTERNAL") ??
        jobs.find((job) => ["QUEUED", "RUNNING"].includes(String(job.status))) ??
        jobs.find((job) => job.status === "FAILED");
      const publication = row.body_json ? JSON.parse(String(row.body_json)) : { images: [] };
      const allSelected =
        publication.images.length > 0 &&
        publication.images.every((image: { artifactId: string | null }) => !!image.artifactId);
      const stage: ContentTaskSummary["stage"] = activity
        ? activity.kind === "IMAGE" || activity.purpose === "PUBLICATION_PLAN"
          ? "IMAGES"
          : activity.purpose === "PUBLICATION_REVIEW"
            ? "REVIEW"
            : "COPY"
        : row.export_artifact
          ? row.export_artifact === row.posted_artifact
            ? "PUBLISHED"
            : "DELIVERY"
          : allSelected
            ? "REVIEW"
            : publication.images.length
              ? "IMAGES"
              : "COPY";
      return {
        publicationRecord: row.posted_json ? JSON.parse(String(row.posted_json)) : null,
        draftId: String(row.draft_id),
        jobId: activity ? String(activity.job_id) : null,
        sessionId: String(row.session_id),
        merchantId: row.merchant_id ? String(row.merchant_id) : null,
        merchantName: row.merchant_name ? String(row.merchant_name) : "普通会话",
        title: String(row.title),
        stage,
        status: activity ? (["QUEUED", "RUNNING"].includes(String(activity.status)) ? "WORKING" : "FAILED") : "READY",
        errorCode:
          activity?.status === "UNKNOWN_EXTERNAL"
            ? "UNKNOWN_EXTERNAL"
            : activity?.error_code
              ? String(activity.error_code)
              : null,
        updatedAt: [
          String(row.updated_at),
          String(activity?.updated_at ?? ""),
          row.posted_json ? String(JSON.parse(String(row.posted_json)).updatedAt) : "",
        ]
          .sort()
          .at(-1) as string,
        draftRevision: Number(row.current_revision),
        publicationRevision: Number(row.publication_revision ?? 0),
      };
    });
    const pending = db
      .prepare(
        `SELECT j.*,m.name AS merchant_name FROM generation_job j JOIN session s ON s.session_id=j.session_id LEFT JOIN merchant m ON m.merchant_id=j.merchant_id WHERE j.kind='TEXT' AND j.purpose IN ('CONTENT','TOPIC_PLAN') AND j.result_draft_id IS NULL AND j.target_draft_id IS NULL AND s.lifecycle_status!='TRASHED' AND (? IS NULL OR j.merchant_id=?) ORDER BY j.updated_at DESC LIMIT 100`,
      )
      .all(merchantId ?? null, merchantId ?? null) as Row[];
    for (const row of pending)
      tasks.push({
        draftId: null,
        jobId: String(row.job_id),
        sessionId: String(row.session_id),
        merchantId: row.merchant_id ? String(row.merchant_id) : null,
        merchantName: row.merchant_name ? String(row.merchant_name) : "普通会话",
        title: String(row.title ?? "选题任务"),
        stage: row.purpose === "TOPIC_PLAN" ? "TOPIC" : "COPY",
        status: row.status === "FAILED" ? "FAILED" : row.status === "READY_FOR_REVIEW" ? "READY" : "WORKING",
        errorCode: row.error_code ? String(row.error_code) : null,
        updatedAt: String(row.updated_at),
        draftRevision: null,
        publicationRevision: null,
      });
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return {
    /** 仪表盘汇总始终来自数据库，人工排期和真实执行状态分开。 */
    getWorkbenchBoard: (from: string, to: string, merchantId?: string): WorkbenchBoard => {
      const plans = (
        db
          .prepare(
            "SELECT * FROM work_plan WHERE scheduled_for>=? AND scheduled_for<=? AND status!='CANCELLED' AND (? IS NULL OR merchant_id=?) ORDER BY scheduled_for,created_at",
          )
          .all(from, to, merchantId ?? null, merchantId ?? null) as Row[]
      ).map(plan);
      const tasks = contentTasks(merchantId);
      return {
        plans,
        tasks,
        stats: {
          running: Number(
            (
              db
                .prepare("SELECT count(*) AS n FROM agent_run WHERE status IN ('QUEUED','RUNNING','RECOVERING')")
                .get() as Row
            ).n,
          ),
          failed: tasks.filter((task) => task.status === "FAILED").length,
          merchants: Number((db.prepare("SELECT count(*) AS n FROM merchant").get() as Row).n),
          products: Number(
            (
              db
                .prepare("SELECT count(*) AS n FROM merchant_catalog_entry WHERE kind='PRODUCT' AND status='ACTIVE'")
                .get() as Row
            ).n,
          ),
        },
      };
    },
    /** 人工新增或编辑一个计划，不调度自动任务。 */
    saveWorkPlan: (
      planId: string,
      expectedRevision: number,
      fields: WorkPlanFields,
      key: string,
      now: string,
    ): WorkPlan =>
      mutation(key, { planId, expectedRevision, fields }, now, () => {
        validatePlan(fields);
        const row = db.prepare("SELECT * FROM work_plan WHERE plan_id=?").get(planId) as Row | undefined;
        if (Number(row?.revision ?? 0) !== expectedRevision) throw Error("WORKBENCH_REVISION_CONFLICT");
        if (row && String(row.merchant_id) !== fields.merchantId) throw Error("WORKBENCH_SOURCE_INVALID");
        const next = {
          ...fields,
          planId,
          revision: expectedRevision + 1,
          createdAt: row ? String(row.created_at) : now,
          updatedAt: now,
        };
        db.prepare(
          "INSERT INTO work_plan(plan_id,merchant_id,session_id,draft_id,scheduled_for,status,revision,body_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(plan_id) DO UPDATE SET session_id=excluded.session_id,draft_id=excluded.draft_id,scheduled_for=excluded.scheduled_for,status=excluded.status,revision=excluded.revision,body_json=excluded.body_json,updated_at=excluded.updated_at",
        ).run(
          planId,
          fields.merchantId,
          fields.sessionId,
          fields.draftId,
          fields.scheduledFor,
          fields.status,
          next.revision,
          JSON.stringify(next),
          next.createdAt,
          now,
        );
        return next;
      }),
    /** 按商家列出实拍和品牌素材，可显式筛选商品。 */
    listMerchantMedia: (merchantId: string, productEntryId?: string): MerchantMedia[] => {
      requireMerchant(merchantId);
      return (
        db
          .prepare(
            "SELECT * FROM merchant_media WHERE merchant_id=? AND (? IS NULL OR product_entry_id=?) ORDER BY updated_at DESC",
          )
          .all(merchantId, productEntryId ?? null, productEntryId ?? null) as Row[]
      ).map(media);
    },
    /** 注册实际已落地的图片 Blob，商品归属和 GC 锁在同事务校验。 */
    createMerchantMedia: (
      merchantId: string,
      productEntryId: string | null,
      title: string,
      hash: string,
      mime: string,
      size: number,
      key: string,
      now: string,
    ): MerchantMedia =>
      mutation(key, { merchantId, productEntryId, title, hash, mime, size }, now, () => {
        requireMerchant(merchantId);
        if (
          productEntryId &&
          !db
            .prepare(
              "SELECT 1 FROM merchant_catalog_entry WHERE entry_id=? AND merchant_id=? AND kind='PRODUCT' AND status='ACTIVE'",
            )
            .get(productEntryId, merchantId)
        )
          throw Error("WORKBENCH_SOURCE_INVALID");
        if (
          !title.trim() ||
          title.length > 160 ||
          !["image/png", "image/jpeg", "image/webp"].includes(mime) ||
          size <= 0 ||
          size > 8388608
        )
          throw Error("WORKBENCH_INPUT_INVALID");
        if (db.prepare("SELECT 1 FROM blob_gc WHERE blob_hash=?").get(hash)) throw Error("BLOB_GC_IN_PROGRESS");
        const id = `media_${randomUUID()}`;
        db.prepare(
          "INSERT INTO merchant_media(media_id,merchant_id,product_entry_id,title,blob_hash,mime_type,size_bytes,status,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'ACTIVE',1,?,?)",
        ).run(id, merchantId, productEntryId, title, hash, mime, size, now, now);
        return media(db.prepare("SELECT * FROM merchant_media WHERE media_id=?").get(id) as Row);
      }),
    /** 启停素材保留历史文件，会话已明确引用的副本继续有效。 */
    updateMerchantMedia: (
      merchantId: string,
      mediaId: string,
      revision: number,
      status: MerchantMedia["status"],
      key: string,
      now: string,
    ): MerchantMedia =>
      mutation(key, { merchantId, mediaId, revision, status }, now, () => {
        const row = db
          .prepare("SELECT * FROM merchant_media WHERE media_id=? AND merchant_id=?")
          .get(mediaId, merchantId) as Row | undefined;
        if (!row) throw Error("WORKBENCH_NOT_FOUND");
        if (Number(row.revision) !== revision) throw Error("WORKBENCH_REVISION_CONFLICT");
        if (!["ACTIVE", "INACTIVE"].includes(status)) throw Error("WORKBENCH_INPUT_INVALID");
        db.prepare("UPDATE merchant_media SET status=?,revision=revision+1,updated_at=? WHERE media_id=?").run(
          status,
          now,
          mediaId,
        );
        return media(db.prepare("SELECT * FROM merchant_media WHERE media_id=?").get(mediaId) as Row);
      }),
    /** 显式把所选商家素材登记进当前商家会话，普通或跨商家会话拒绝。 */
    importMerchantMedia: (sessionId: string, mediaIds: string[], key: string, now: string): ArtifactRecord[] =>
      mutation(key, { sessionId, mediaIds }, now, () => {
        const session = db
          .prepare("SELECT * FROM session WHERE session_id=? AND lifecycle_status='ACTIVE' AND scope='MERCHANT'")
          .get(sessionId) as Row | undefined;
        if (!session) throw Error("WORKBENCH_SOURCE_INVALID");
        if (!mediaIds.length || mediaIds.length > 9 || new Set(mediaIds).size !== mediaIds.length)
          throw Error("WORKBENCH_INPUT_INVALID");
        return mediaIds.map((id) => {
          const row = db
            .prepare("SELECT * FROM merchant_media WHERE media_id=? AND merchant_id=? AND status='ACTIVE'")
            .get(id, session.owner_id as string) as Row | undefined;
          if (!row) throw Error("WORKBENCH_SOURCE_INVALID");
          if (db.prepare("SELECT 1 FROM blob_gc WHERE blob_hash=?").get(String(row.blob_hash)))
            throw Error("BLOB_GC_IN_PROGRESS");
          const existing = db
            .prepare(
              "SELECT a.* FROM merchant_media_reference r JOIN artifact a ON a.artifact_id=r.artifact_id WHERE r.media_id=? AND a.session_id=? AND a.status='READY'",
            )
            .get(id, sessionId) as Row | undefined;
          const artifactId = existing ? String(existing.artifact_id) : `art_${randomUUID()}`;
          if (!existing) {
            db.prepare(
              "INSERT INTO artifact(artifact_id,session_id,kind,title,blob_hash,mime_type,size_bytes,status,created_at) VALUES (?,?,'upload',?,?,?,?,'READY',?)",
            ).run(
              artifactId,
              sessionId,
              `商家素材·${row.title}`,
              String(row.blob_hash),
              String(row.mime_type),
              Number(row.size_bytes),
              now,
            );
            db.prepare("INSERT INTO merchant_media_reference(artifact_id,media_id) VALUES (?,?)").run(artifactId, id);
          }
          return {
            artifactId,
            sessionId,
            kind: "upload",
            title: existing ? String(existing.title) : `商家素材·${row.title}`,
            blobHash: String(row.blob_hash),
            mimeType: String(row.mime_type),
            sizeBytes: Number(row.size_bytes),
            status: "READY",
          };
        });
      }),
    /** 对固定交付包登记用户在外部发布的信息，不自动确认平台发布成功。 */
    savePublicationRecord: (
      sessionId: string,
      draftId: string,
      artifactId: string,
      url: string,
      publishedAt: string,
      note: string,
      metrics: PublicationRecordLink["metrics"],
      expectedRevision: number,
      key: string,
      now: string,
    ): PublicationRecordLink =>
      mutation(key, { sessionId, draftId, artifactId, url, publishedAt, note, metrics, expectedRevision }, now, () => {
        const row = db
          .prepare(
            "SELECT d.session_id,s.lifecycle_status FROM content_draft d JOIN session s ON s.session_id=d.session_id JOIN content_publication_export e ON e.draft_id=d.draft_id WHERE d.draft_id=? AND e.artifact_id=?",
          )
          .get(draftId, artifactId) as Row | undefined;
        if (row?.session_id !== sessionId || row.lifecycle_status !== "ACTIVE") throw Error("WORKBENCH_SOURCE_INVALID");
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw Error("WORKBENCH_INPUT_INVALID");
        }
        if (
          parsed.protocol !== "https:" ||
          parsed.username ||
          parsed.password ||
          url.length > 2048 ||
          !Number.isFinite(Date.parse(publishedAt)) ||
          note.length > 2000 ||
          Object.values(metrics).some(
            (value) => value !== null && (!Number.isInteger(value) || value < 0 || value > 1000000000),
          )
        )
          throw Error("WORKBENCH_INPUT_INVALID");
        const old = db.prepare("SELECT * FROM publication_record WHERE draft_id=?").get(draftId) as Row | undefined;
        if (Number(old?.revision ?? 0) !== expectedRevision) throw Error("WORKBENCH_REVISION_CONFLICT");
        const next = {
          recordId: old ? String(old.record_id) : `post_${randomUUID()}`,
          draftId,
          artifactId,
          url: parsed.toString(),
          publishedAt,
          note,
          metrics,
          revision: expectedRevision + 1,
          createdAt: old ? String(old.created_at) : now,
          updatedAt: now,
        };
        db.prepare(
          "INSERT INTO publication_record(record_id,draft_id,export_artifact_id,revision,body_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(draft_id) DO UPDATE SET export_artifact_id=excluded.export_artifact_id,revision=excluded.revision,body_json=excluded.body_json,updated_at=excluded.updated_at",
        ).run(next.recordId, draftId, artifactId, next.revision, JSON.stringify(next), next.createdAt, now);
        return next;
      }),
    /** 读取人工发布登记，明确区别于 Provider 回执。 */
    getPublicationRecord: (sessionId: string, draftId: string): PublicationRecordLink | null => {
      const row = db
        .prepare(
          "SELECT r.body_json FROM publication_record r JOIN content_draft d ON d.draft_id=r.draft_id WHERE d.session_id=? AND d.draft_id=?",
        )
        .get(sessionId, draftId) as Row | undefined;
      return row ? JSON.parse(String(row.body_json)) : null;
    },
    /** 人工对账仅在未知状态允许一次，采用真实同会话文件或明确登记没有可用结果。 */
    reconcileImageJob: (
      sessionId: string,
      jobId: string,
      resolution: "NO_RESULT" | "ADOPT_IMAGE",
      artifactId: string | null,
      note: string,
      key: string,
      now: string,
    ) =>
      mutation(key, { sessionId, jobId, resolution, artifactId, note }, now, () => {
        const job = db
          .prepare(
            "SELECT j.* FROM generation_job j JOIN session s ON s.session_id=j.session_id WHERE j.job_id=? AND j.session_id=? AND j.kind='IMAGE' AND s.lifecycle_status='ACTIVE'",
          )
          .get(jobId, sessionId) as Row | undefined;
        if (job?.status !== "UNKNOWN_EXTERNAL") throw Error("WORKBENCH_STATE_CONFLICT");
        if (note.trim().length < 5 || note.length > 2000 || !["NO_RESULT", "ADOPT_IMAGE"].includes(resolution))
          throw Error("WORKBENCH_INPUT_INVALID");
        if (
          resolution === "ADOPT_IMAGE" &&
          !db
            .prepare(
              "SELECT 1 FROM artifact WHERE artifact_id=? AND session_id=? AND status='READY' AND kind IN ('upload','generated_image') AND mime_type IN ('image/png','image/jpeg','image/webp') AND size_bytes<=?",
            )
            .get(artifactId, sessionId, MAX_MANAGED_IMAGE_BYTES)
        )
          throw Error("WORKBENCH_SOURCE_INVALID");
        if (resolution === "NO_RESULT" && artifactId) throw Error("WORKBENCH_INPUT_INVALID");
        const status = resolution === "NO_RESULT" ? "FAILED" : "READY_FOR_REVIEW";
        const code = resolution === "NO_RESULT" ? "USER_CONFIRMED_NO_RESULT" : "USER_ADOPTED_IMAGE";
        db.prepare(
          "INSERT INTO image_reconciliation(job_id,resolution,artifact_id,note,prior_error_code,provider_request_id,created_at) VALUES (?,?,?,?,?,?,?)",
        ).run(
          jobId,
          resolution,
          artifactId,
          note,
          job.error_code as string | null,
          job.provider_request_id as string | null,
          now,
        );
        db.prepare(
          "UPDATE generation_job SET status=?,result_artifact_id=?,error_code=?,updated_at=? WHERE job_id=?",
        ).run(status, artifactId, code, now, jobId);
        db.prepare(
          "UPDATE generation_step_attempt SET status=?,output_artifact_id=?,error_code=?,finished_at=? WHERE job_id=? AND step_key='IMAGE_PROVIDER'",
        ).run(resolution === "NO_RESULT" ? "FAILED" : "SUCCEEDED", artifactId, code, now, jobId);
        return { jobId, status, resolution, note, artifactId };
      }),
  };
}

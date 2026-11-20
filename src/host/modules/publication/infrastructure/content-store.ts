import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContentDraftRecord, ContentRevisionRecord } from "../../../../shared/contracts.js";
import type { TextTaskSource } from "../../../../shared/topics.js";
import { assertCurrentTaskContextForRun } from "../../sessions/infrastructure/task-context-store.js";
import { CONTENT_OUTPUT_VERSION, parseContentOutput } from "../domain/content-output.js";
import { applyPublicationRepair } from "../domain/publication-repair.js";
import { renderContentMarkdown } from "./content-markdown.js";
import { assertPublicationRepairBasis } from "./publication-repair-source.js";

type Row = Record<string, unknown>;

/** 提供素材草稿的版本、审核和来源读写，所有写操作由调用方传入事务封装。 */
export function createContentOperations(db: DatabaseSync, transaction: <T>(operation: () => T) => T) {
  /** 把数据库当前版及其来源字段还原为共享契约。 */
  function currentDraft(row: Row): ContentDraftRecord {
    return {
      draftId: String(row.draft_id),
      sessionId: String(row.session_id),
      merchantId: row.merchant_id === null ? null : String(row.merchant_id),
      sourceMessageId: String(row.source_message_id),
      sourceRunId: String(row.source_run_id),
      currentRevision: Number(row.current_revision),
      approvedRevision: row.approved_revision === null ? null : Number(row.approved_revision),
      title: String(row.title),
      body: String(row.body),
      internalNotes: String(row.internal_notes ?? ""),
      sha256: String(row.sha256),
      artifactId: row.artifact_id === null ? null : String(row.artifact_id),
      createdAt: String(row.draft_created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** 只读取指定会话持有的草稿，避免跨会话 ID 绕过归属。 */
  function readDraft(sessionId: string, draftId: string): ContentDraftRecord | null {
    const row = db
      .prepare(`SELECT d.*, d.created_at AS draft_created_at, v.title, v.body, v.internal_notes, v.sha256, v.artifact_id
      FROM content_draft d JOIN content_revision v ON v.draft_id = d.draft_id AND v.revision = d.current_revision
      WHERE d.session_id = ? AND d.draft_id = ?`)
      .get(sessionId, draftId) as Row | undefined;
    return row ? currentDraft(row) : null;
  }

  /** 修改和审核仅允许活动会话，归档或回收后的草稿仍可只读查看。 */
  function requireActiveSession(sessionId: string): void {
    const row = db.prepare("SELECT lifecycle_status FROM session WHERE session_id = ?").get(sessionId) as
      | Row
      | undefined;
    if (!row) throw new Error("SESSION_NOT_FOUND");
    if (row.lifecycle_status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
  }

  /** 生成请求内容摘要以检查同一幂等键是否被重用。 */
  function requestHash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  /** 读取本模块已提交的幂等结果。 */
  function previous(key: string, kind: string, hash: string): unknown | null {
    const row = db
      .prepare("SELECT kind, result_json, request_hash FROM api_operation WHERE operation_key = ?")
      .get(key) as Row | undefined;
    if (!row) return null;
    if (row.kind !== kind || row.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
    return JSON.parse(String(row.result_json));
  }

  /** 同事务保存操作结果，重试不会重复写草稿或产物。 */
  function remember(key: string, kind: string, hash: string, value: unknown, now: string): void {
    db.prepare(
      "INSERT INTO api_operation(operation_key, kind, result_json, request_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(key, kind, JSON.stringify(value), hash, now);
  }

  /** 规范用户编辑内容，拒绝空正文或过大的草稿。 */
  function fields(title: string, body: string) {
    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    if (!cleanTitle || cleanTitle.length > 120 || /[\r\n]/.test(cleanTitle) || !cleanBody || cleanBody.length > 50000)
      throw new Error("CONTENT_INPUT_INVALID");
    return { title: cleanTitle, body: cleanBody, sha256: requestHash({ title: cleanTitle, body: cleanBody }) };
  }

  /** 只对明确冻结新版输出协议的 Run 解码，历史文字任务保持原样。 */
  function generatedFields(runId: string, title: string, text: string) {
    assertCurrentTaskContextForRun(db, runId);
    const job = db
      .prepare(
        "SELECT model_version,source_json,session_id FROM generation_job WHERE source_run_id=? AND purpose='CONTENT'",
      )
      .get(runId) as Row | undefined;
    const source = job?.source_json ? (JSON.parse(String(job.source_json)) as TextTaskSource) : null;
    if (source?.repair) {
      if (source.repair.scope !== "COPY") throw new Error("PUBLICATION_REPAIR_SCOPE_INVALID");
      assertPublicationRepairBasis(db, String(job?.session_id), source.repair);
      const patched = applyPublicationRepair(text, source.repair).draft;
      if ((patched.internalNotes?.length ?? 0) > 3000) throw new Error("CONTENT_INPUT_INVALID");
      return { ...fields(patched.title, patched.body), internalNotes: patched.internalNotes ?? "", action: undefined };
    }
    const output =
      job?.model_version === CONTENT_OUTPUT_VERSION
        ? parseContentOutput(text)
        : { title, body: text, internalNotes: "" };
    return {
      ...fields(output.title, output.body),
      internalNotes: output.internalNotes,
      action: "action" in output ? output.action : undefined,
    };
  }

  return {
    /** 按会话列出素材草稿；普通和商家会话共用同一状态底座。 */
    listContentDrafts: (sessionId: string): ContentDraftRecord[] =>
      (
        db
          .prepare(`SELECT d.*, d.created_at AS draft_created_at, v.title, v.body, v.internal_notes, v.sha256, v.artifact_id
        FROM content_draft d JOIN content_revision v ON v.draft_id = d.draft_id AND v.revision = d.current_revision
        WHERE d.session_id = ? ORDER BY d.updated_at DESC LIMIT 100`)
          .all(sessionId) as Row[]
      ).map(currentDraft),

    /** 读取一份草稿和不可变的全部修订历史。 */
    getContentDraft: (sessionId: string, draftId: string) => {
      const draft = readDraft(sessionId, draftId);
      if (!draft) return null;
      const revisions = (
        db.prepare("SELECT * FROM content_revision WHERE draft_id = ? ORDER BY revision DESC").all(draftId) as Row[]
      ).map(
        (row): ContentRevisionRecord => ({
          draftId,
          revision: Number(row.revision),
          title: String(row.title),
          body: String(row.body),
          internalNotes: String(row.internal_notes ?? ""),
          sha256: String(row.sha256),
          author: row.author as "AGENT" | "USER",
          artifactId: row.artifact_id === null ? null : String(row.artifact_id),
          createdAt: String(row.created_at),
        }),
      );
      return { draft, revisions };
    },

    /** 只从本会话成功 Run 的助手消息生成可编辑草稿。 */
    createContentDraft: (
      sessionId: string,
      messageId: string,
      title: string,
      draftId: string,
      key: string,
      now: string,
    ) =>
      transaction(() => {
        const hash = requestHash({ sessionId, messageId, title });
        const cached = previous(key, "createContentDraft", hash);
        if (cached) return cached as ContentDraftRecord;
        const source = db
          .prepare(`SELECT m.content_json, m.run_id, s.scope, s.owner_id
          FROM message m JOIN agent_run r ON r.run_id = m.run_id
          JOIN session s ON s.session_id = m.session_id
          WHERE m.message_id = ? AND m.session_id = ? AND m.role = 'assistant'
          AND r.status = 'SUCCEEDED' AND s.lifecycle_status = 'ACTIVE'`)
          .get(messageId, sessionId) as Row | undefined;
        if (!source) throw new Error("CONTENT_SOURCE_INVALID");
        const existing = db.prepare("SELECT draft_id FROM content_draft WHERE source_message_id = ?").get(messageId) as
          | Row
          | undefined;
        if (existing) {
          const draft = readDraft(sessionId, String(existing.draft_id));
          if (!draft) throw new Error("CONTENT_DRAFT_NOT_FOUND");
          remember(key, "createContentDraft", hash, draft, now);
          return draft;
        }
        const content = JSON.parse(String(source.content_json)) as { text?: unknown };
        const input = generatedFields(
          String(source.run_id),
          title,
          typeof content.text === "string" ? content.text : "",
        );
        if (input.action === "REPLY") throw new Error("CONTENT_OUTPUT_INVALID");
        const merchantId = source.scope === "MERCHANT" ? String(source.owner_id) : null;
        db.prepare(`INSERT INTO content_draft
          (draft_id, session_id, merchant_id, source_message_id, source_run_id, current_revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(
          draftId,
          sessionId,
          merchantId,
          messageId,
          String(source.run_id),
          now,
          now,
        );
        db.prepare(`INSERT INTO content_revision(draft_id, revision, title, body, sha256, internal_notes, author, created_at)
          VALUES (?, 1, ?, ?, ?, ?, 'AGENT', ?)`).run(
          draftId,
          input.title,
          input.body,
          input.sha256,
          input.internalNotes,
          now,
        );
        const result = readDraft(sessionId, draftId) as ContentDraftRecord;
        remember(key, "createContentDraft", hash, result, now);
        return result;
      }),

    /** 以 CAS 追加用户修订；旧版和已审核版保持不变。 */
    reviseContentDraft: (
      sessionId: string,
      draftId: string,
      expectedRevision: number,
      title: string,
      body: string,
      key: string,
      now: string,
    ) =>
      transaction(() => {
        const input = fields(title, body);
        const hash = requestHash({ sessionId, draftId, expectedRevision, input });
        const cached = previous(key, "reviseContentDraft", hash);
        if (cached) return cached as ContentDraftRecord;
        requireActiveSession(sessionId);
        const draft = readDraft(sessionId, draftId);
        if (!draft) throw new Error("CONTENT_DRAFT_NOT_FOUND");
        if (draft.currentRevision !== expectedRevision) throw new Error("CONTENT_REVISION_CONFLICT");
        const next = expectedRevision + 1;
        db.prepare(`INSERT INTO content_revision(draft_id, revision, title, body, sha256, internal_notes, author, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'USER', ?)`).run(
          draftId,
          next,
          input.title,
          input.body,
          input.sha256,
          draft.internalNotes ?? "",
          now,
        );
        db.prepare("UPDATE content_draft SET current_revision = ?, updated_at = ? WHERE draft_id = ?").run(
          next,
          now,
          draftId,
        );
        const result = readDraft(sessionId, draftId) as ContentDraftRecord;
        remember(key, "reviseContentDraft", hash, result, now);
        return result;
      }),

    /** 仅用同会话成功 Run 的回复追加 AI 修订，不覆盖原稿或人工审核版。 */
    applyGeneratedRevision: (
      sessionId: string,
      draftId: string,
      expectedRevision: number,
      sourceMessageId: string,
      key: string,
      now: string,
    ) =>
      transaction(() => {
        const hash = requestHash({ sessionId, draftId, expectedRevision, sourceMessageId });
        const cached = previous(key, "applyGeneratedRevision", hash);
        if (cached) return cached as ContentDraftRecord;
        requireActiveSession(sessionId);
        const draft = readDraft(sessionId, draftId);
        if (!draft) throw new Error("CONTENT_DRAFT_NOT_FOUND");
        if (draft.currentRevision !== expectedRevision) throw new Error("CONTENT_REVISION_CONFLICT");
        const source = db
          .prepare(`SELECT m.content_json,m.run_id FROM message m JOIN agent_run r ON r.run_id = m.run_id
        WHERE m.message_id = ? AND m.session_id = ? AND m.role = 'assistant' AND r.status = 'SUCCEEDED'`)
          .get(sourceMessageId, sessionId) as Row | undefined;
        if (!source) throw new Error("CONTENT_SOURCE_INVALID");
        const content = JSON.parse(String(source.content_json)) as { text?: unknown };
        const input = generatedFields(
          String(source.run_id),
          draft.title,
          typeof content.text === "string" ? content.text : "",
        );
        if (input.action === "REPLY") {
          // 提问的成功回执仍可追溯到原版本，但不能凭一次回答制造正文修订。
          remember(key, "applyGeneratedRevision", hash, draft, now);
          return draft;
        }
        const next = expectedRevision + 1;
        db.prepare(`INSERT INTO content_revision(draft_id, revision, title, body, sha256, internal_notes, author, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'AGENT', ?)`).run(
          draftId,
          next,
          input.title,
          input.body,
          input.sha256,
          input.internalNotes,
          now,
        );
        db.prepare("UPDATE content_draft SET current_revision = ?, updated_at = ? WHERE draft_id = ?").run(
          next,
          now,
          draftId,
        );
        const result = readDraft(sessionId, draftId) as ContentDraftRecord;
        remember(key, "applyGeneratedRevision", hash, result, now);
        return result;
      }),

    /** 核对待审版本与 Blob，原子登记用户审核后的正式 Markdown Artifact。 */
    approveContentDraft: (
      sessionId: string,
      draftId: string,
      expectedRevision: number,
      artifactId: string,
      blobHash: string,
      size: number,
      key: string,
      now: string,
    ) =>
      transaction(() => {
        const hash = requestHash({ sessionId, draftId, expectedRevision });
        const cached = previous(key, "approveContentDraft", hash);
        if (cached) return cached as ContentDraftRecord;
        requireActiveSession(sessionId);
        const draft = readDraft(sessionId, draftId);
        if (!draft) throw new Error("CONTENT_DRAFT_NOT_FOUND");
        if (draft.currentRevision !== expectedRevision) throw new Error("CONTENT_REVISION_CONFLICT");
        if (draft.artifactId) {
          remember(key, "approveContentDraft", hash, draft, now);
          return draft;
        }
        const bytes = renderContentMarkdown(draft.title, draft.body);
        if (createHash("sha256").update(bytes).digest("hex") !== blobHash || bytes.length !== size)
          throw new Error("CONTENT_BLOB_INVALID");
        if (db.prepare("SELECT 1 FROM blob_gc WHERE blob_hash = ?").get(blobHash))
          throw new Error("BLOB_GC_IN_PROGRESS");
        db.prepare(`INSERT INTO artifact(artifact_id, session_id, kind, title, blob_hash, mime_type,
          size_bytes, status, created_at) VALUES (?, ?, 'content_markdown', ?, ?, 'text/markdown', ?, 'READY', ?)`).run(
          artifactId,
          sessionId,
          `${draft.title}.md`,
          blobHash,
          size,
          now,
        );
        db.prepare("UPDATE content_revision SET artifact_id = ? WHERE draft_id = ? AND revision = ?").run(
          artifactId,
          draftId,
          expectedRevision,
        );
        db.prepare("UPDATE content_draft SET approved_revision = ?, updated_at = ? WHERE draft_id = ?").run(
          expectedRevision,
          now,
          draftId,
        );
        const result = readDraft(sessionId, draftId) as ContentDraftRecord;
        remember(key, "approveContentDraft", hash, result, now);
        return result;
      }),
  };
}

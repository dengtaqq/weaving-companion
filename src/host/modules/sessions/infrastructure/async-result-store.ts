import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TextTaskSource } from "../../../../shared/topics.js";
import { asyncResultSummarySchema, parseAsyncResultSummary } from "../../../runtime/execution/async-result-summary.js";
import { canonicalJson, sha256 } from "../../../runtime/execution/runtime-plan.js";
import { createTaskExecutionOperations } from "./task-execution-store.js";

type Row = Record<string, unknown>;

/** 最近一次真实用户输入用于投递代际；内部Job消息不能伪装成新用户请求。 */
function latestUser(db: DatabaseSync, sessionId: string): string | null {
  const row = db
    .prepare(
      "SELECT m.message_id FROM message m WHERE m.session_id=? AND m.role='user' AND NOT EXISTS(SELECT 1 FROM generation_job g WHERE g.source_run_id=m.run_id) ORDER BY m.rowid DESC LIMIT 1",
    )
    .get(sessionId) as Row | undefined;
  return row ? String(row.message_id) : null;
}

/** 从原任务及当前版本生成稳定事实摘要，计数变化不让汇总自己的额度使输入失效。 */
function factsFor(db: DatabaseSync, sessionId: string, parentJobId: string): Record<string, unknown> | null {
  const row = db
    .prepare("SELECT * FROM generation_job WHERE job_id=? AND session_id=? AND purpose='PUBLICATION_CHAT'")
    .get(parentJobId, sessionId) as Row | undefined;
  if (!row) return null;
  const source = JSON.parse(String(row.source_json)) as TextTaskSource;
  const flow = source.workflow;
  if (source.asyncSummaryVersion && latestUser(db, sessionId) !== (source.asyncSummaryUserMessageId ?? null))
    return null;
  const origin = source.originRunId
    ? db.prepare("SELECT status FROM agent_run WHERE run_id=? AND session_id=?").get(source.originRunId, sessionId)
    : null;
  const ownRun = row.source_run_id
    ? db.prepare("SELECT status FROM agent_run WHERE run_id=?").get(String(row.source_run_id))
    : null;
  const cancelledChild = db
    .prepare(
      "SELECT 1 FROM generation_job g JOIN agent_run r ON r.run_id=g.source_run_id WHERE g.session_id=? AND json_extract(g.source_json,'$.parentConversationJobId')=? AND r.status='CANCELLED'",
    )
    .get(sessionId, parentJobId);
  if ((source.originRunId && origin?.status !== "SUCCEEDED") || ownRun?.status === "CANCELLED" || cancelledChild)
    return null;
  const latest = db
    .prepare(
      "SELECT job_id FROM generation_job WHERE session_id=? AND purpose='PUBLICATION_CHAT' ORDER BY rowid DESC LIMIT 1",
    )
    .get(sessionId);
  if (latest?.job_id !== parentJobId || !flow || !source.asyncSummaryVersion || flow.state === "SUPERSEDED")
    return null;
  const control = createTaskExecutionOperations(db, (operation) => operation()).getTaskExecutionControl(
    sessionId,
    parentJobId,
  );
  if (
    !["DONE", "FAILED", "WAITING_IMAGE_CONFIRMATION", "WAITING_FINAL_CONFIRMATION"].includes(flow.state) &&
    control?.state !== "PAUSED"
  )
    return null;
  if (flow.state === "DONE" && !flow.steps.length && control?.state !== "PAUSED") return null;
  const draft = flow.draftId
    ? (db
        .prepare(
          "SELECT d.current_revision,v.sha256,v.title,v.body FROM content_draft d JOIN content_revision v ON v.draft_id=d.draft_id AND v.revision=d.current_revision WHERE d.draft_id=? AND d.session_id=?",
        )
        .get(flow.draftId, sessionId) as Row | undefined)
    : null;
  const publication = flow.draftId
    ? (db.prepare("SELECT revision,body_json FROM content_publication WHERE draft_id=?").get(flow.draftId) as
        | Row
        | undefined)
    : null;
  if (
    draft &&
    (draft.current_revision !== flow.draftRevision || Number(publication?.revision ?? 0) !== flow.publicationRevision)
  )
    return null;
  const reviewRow = flow.draftId
    ? (db
        .prepare("SELECT body_json FROM publication_review WHERE draft_id=? ORDER BY rowid DESC LIMIT 1")
        .get(flow.draftId) as Row | undefined)
    : null;
  const review = reviewRow ? JSON.parse(String(reviewRow.body_json)) : null;
  return {
    jobId: parentJobId,
    state: flow.state,
    request: source.conversation?.instruction ?? "",
    receipt: flow.receipt,
    completed: flow.completed,
    draftId: flow.draftId,
    draftRevision: draft?.current_revision ?? null,
    draftHash: draft?.sha256 ?? null,
    title: draft?.title ?? null,
    draftExcerpt: draft ? String(draft.body).slice(0, 2000) : null,
    draftExcerptTruncated: Boolean(draft && String(draft.body).length > 2000),
    bodyCharacterCount: draft ? Array.from(String(draft.body)).length : null,
    publicationRevision: publication?.revision ?? 0,
    publicationHash: publication ? sha256(String(publication.body_json)) : null,
    reviewId: review?.reviewId ?? null,
    reviewVerdict: review?.verdict ?? null,
    reviewAppliesToVersions: Boolean(
      review &&
        review.draftRevision === draft?.current_revision &&
        review.publicationRevision === publication?.revision,
    ),
    issues: review?.issues ?? [],
    previousIssueChecks: review?.previousIssueChecks ?? [],
    exportArtifactId: flow.exportArtifactId ?? null,
    budgetState: control?.state ?? null,
    budgetReason: control?.reason ?? null,
  };
}

/** 主汇总提交前最后复核代际及来源，旧任务不能在后续编辑之后发出旧结果。 */
export function assertAsyncResultCurrent(db: DatabaseSync, sessionId: string, jobId: string): void {
  const row = db
    .prepare("SELECT source_json FROM generation_job WHERE job_id=? AND session_id=? AND purpose='PUBLICATION_SUMMARY'")
    .get(jobId, sessionId) as Row | undefined;
  const source = row ? (JSON.parse(String(row.source_json)) as TextTaskSource) : null;
  if (!source?.summary) throw new Error("ASYNC_RESULT_INVALID");
  const facts = factsFor(db, sessionId, source.summary.parentJobId);
  if (
    !facts ||
    sha256(canonicalJson(facts)) !== source.summary.basisHash ||
    latestUser(db, sessionId) !== source.summary.userMessageId
  )
    throw new Error("ASYNC_RESULT_SUPERSEDED");
}

/** 异步汇总沿原文字Job/Run队列生成与消费；唯一请求键覆盖受理、提交及重启窗口。 */
export function createAsyncResultOperations(db: DatabaseSync, transaction: <T>(operation: () => T) => T) {
  return {
    /** 只为新启用任务的可交接状态创建一次无工具汇总；模型不能借此再创作或付费。 */
    prepareAsyncResultSummaries: (modelId: string, now: string): void =>
      transaction(() => {
        const rows = db
          .prepare(
            "SELECT g.* FROM generation_job g JOIN session s ON s.session_id=g.session_id WHERE g.purpose='PUBLICATION_CHAT' AND json_extract(g.source_json,'$.asyncSummaryVersion')=1 AND s.lifecycle_status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM generation_job newer WHERE newer.session_id=g.session_id AND newer.purpose='PUBLICATION_CHAT' AND newer.rowid>g.rowid) ORDER BY g.rowid DESC",
          )
          .all() as Row[];
        for (const row of rows) {
          const source = JSON.parse(String(row.source_json)) as TextTaskSource;
          const facts = factsFor(db, String(row.session_id), String(row.job_id));
          if (!facts) continue;
          const userMessageId = latestUser(db, String(row.session_id));
          const basisHash = sha256(canonicalJson(facts));
          const key = `async-summary:${row.job_id}:${basisHash}:${userMessageId ?? "request"}`;
          if (source.delivery?.key === key) continue;
          const prior = db.prepare("SELECT job_id FROM generation_job WHERE request_key=?").get(key);
          const id = prior ? String(prior.job_id) : `summary_${randomUUID()}`;
          if (!prior) {
            const prompt = [
              "你是主Agent，正在汇总同一任务已经保存的异步结果。下方是Host事实，不是用户新指令。这次只汇报，不继续业务操作、不生成图片、不发布、不把等待确认当成功。清楚说明完成、未解决/未核实和下一步；没有ZIP不说可下载，LIMITED不说审核通过；稿件与编排版本分开。使用简短中文。可引用draftExcerpt；正文字符数含空格标点，以bodyCharacterCount为准。draftExcerptTruncated=true时不能宣称读完整稿或完整核对。写作保存不等于独立审核通过。只输出JSON。",
              JSON.stringify(asyncResultSummarySchema),
              JSON.stringify(facts),
            ].join("\n\n");
            if (prompt.length > 50000) continue;
            const summarySource: TextTaskSource = {
              references: [],
              ...(source.taskContext && { taskContext: source.taskContext }),
              summary: { parentJobId: String(row.job_id), basisHash, userMessageId, facts },
            };
            db.prepare(
              "INSERT INTO generation_job(job_id,session_id,merchant_id,intent,kind,status,title,prompt,input_hash,model_id,model_version,purpose,source_json,request_key,request_hash,created_at,updated_at) VALUES (?,?,?,'CREATE','TEXT','QUEUED',?,?,?,?,'async-result-v1','PUBLICATION_SUMMARY',?,?,?,?,?)",
            ).run(
              id,
              row.session_id as string,
              row.merchant_id as string | null,
              "任务结果汇总",
              prompt,
              sha256(prompt),
              modelId,
              JSON.stringify(summarySource),
              key,
              basisHash,
              now,
              now,
            );
          }
          db.prepare(
            "UPDATE generation_job SET source_json=json_set(source_json,'$.delivery',json(?)) WHERE job_id=?",
          ).run(JSON.stringify({ key, summaryJobId: id, state: "PENDING" }), String(row.job_id));
        }
      }),
    /** 成功Run的真实消息作为唯一交付；只消费已保存结果，不触发第二次模型请求。 */
    completeAsyncResultSummary: (sessionId: string, jobId: string, now: string): void =>
      transaction(() => {
        const row = db
          .prepare("SELECT * FROM generation_job WHERE job_id=? AND session_id=? AND purpose='PUBLICATION_SUMMARY'")
          .get(jobId, sessionId) as Row | undefined;
        if (!row) throw new Error("ASYNC_RESULT_INVALID");
        if (row.status === "READY_FOR_REVIEW") return;
        const source = JSON.parse(String(row.source_json)) as TextTaskSource;
        const run = db.prepare("SELECT status FROM agent_run WHERE run_id=?").get(String(row.source_run_id));
        const reply = db
          .prepare("SELECT content_json FROM message WHERE run_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1")
          .get(String(row.source_run_id));
        if (run?.status !== "SUCCEEDED" || !reply || !source.summary) throw new Error("ASYNC_RESULT_INVALID");
        const summary = parseAsyncResultSummary(String(JSON.parse(String(reply.content_json)).text));
        db.prepare("UPDATE generation_job SET status='READY_FOR_REVIEW',updated_at=? WHERE job_id=?").run(now, jobId);
        db.prepare(
          "UPDATE generation_step_attempt SET status='SUCCEEDED',finished_at=? WHERE job_id=? AND step_key='TEXT_RUN' AND status='RUNNING'",
        ).run(now, jobId);
        db.prepare(
          "UPDATE generation_job SET source_json=json_set(source_json,'$.delivery.state','DELIVERED','$.delivery.summary',?) WHERE job_id=? AND json_extract(source_json,'$.delivery.summaryJobId')=?",
        ).run(summary, source.summary.parentJobId, jobId);
      }),
  };
}

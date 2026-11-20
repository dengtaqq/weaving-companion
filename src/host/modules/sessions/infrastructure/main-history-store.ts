import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "../../../runtime/execution/runtime-plan.js";
import type { MainHistoryView } from "../../../runtime/history/main-history.js";

/** 原Job与消息仍是事实源，只生成主模型所需的有界成果导航。 */
export function readMainHistoryView(db: DatabaseSync, sessionId: string): MainHistoryView {
  const prompts = db
    .prepare(
      "SELECT g.prompt FROM generation_job g JOIN agent_run r ON r.run_id=g.source_run_id WHERE g.session_id=? AND g.kind='TEXT' AND COALESCE(json_extract(r.runtime_plan_json,'$.executionPolicy.history'),'LEGACY')!='ISOLATED'",
    )
    .all(sessionId);
  const internalPromptHashes = prompts.map((row) => sha256(String(row.prompt)));
  const internal = new Set(internalPromptHashes);
  const protectedUserHashes = db
    .prepare(
      "SELECT m.content_json FROM message m WHERE m.session_id=? AND m.role='user' AND NOT EXISTS(SELECT 1 FROM generation_job g WHERE g.source_run_id=m.run_id)",
    )
    .all(sessionId)
    .map((row) => sha256(String(JSON.parse(String(row.content_json)).text)))
    .filter((hash) => internal.has(hash));
  const rows = db
    .prepare(
      "SELECT job_id,purpose,status,result_draft_id,json_extract(source_json,'$.workflow.receipt') receipt,json_extract(source_json,'$.delivery.summary') summary FROM generation_job WHERE session_id=? AND kind='TEXT' AND purpose!='PUBLICATION_SUMMARY' AND json_extract(source_json,'$.parentConversationJobId') IS NULL ORDER BY rowid DESC LIMIT 8",
    )
    .all(sessionId);
  return {
    internalPromptHashes,
    protectedUserHashes,
    receipts: rows.map((row) => ({
      jobId: String(row.job_id),
      purpose: String(row.purpose),
      status: String(row.status),
      draftId: row.result_draft_id ? String(row.result_draft_id) : null,
      receipt: String(row.receipt ?? "").slice(0, 500),
      summary: row.summary ? String(row.summary).slice(0, 1600) : null,
    })),
  };
}

/** 分段回读本会话持久Job原输入或成功结果，不能从ID获得跨会话读取权限。 */
export function readTaskHistory(
  db: DatabaseSync,
  sessionId: string,
  jobId: string,
  section: "INPUT" | "RESULT",
  offset: number,
  limit: number,
) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12000)
    throw new Error("TASK_HISTORY_RANGE_INVALID");
  const row = db
    .prepare(
      "SELECT g.*,s.lifecycle_status FROM generation_job g JOIN session s ON s.session_id=g.session_id WHERE g.session_id=? AND g.job_id=? AND g.kind='TEXT'",
    )
    .get(sessionId, jobId);
  if (row?.lifecycle_status !== "ACTIVE") throw new Error("GENERATION_JOB_NOT_FOUND");
  const result =
    section === "RESULT"
      ? db
          .prepare(
            "SELECT m.content_json FROM message m JOIN agent_run r ON r.run_id=m.run_id WHERE m.run_id=? AND m.session_id=? AND m.role='assistant' AND r.status='SUCCEEDED' ORDER BY m.rowid DESC LIMIT 1",
          )
          .get(String(row.source_run_id), sessionId)
      : null;
  const text =
    section === "INPUT" ? String(row.prompt) : result ? String(JSON.parse(String(result.content_json)).text) : null;
  if (text === null) throw new Error("TASK_HISTORY_RESULT_UNAVAILABLE");
  return {
    jobId,
    purpose: String(row.purpose),
    section,
    sha256: sha256(text),
    offset,
    totalLength: text.length,
    nextOffset: offset + limit < text.length ? offset + limit : null,
    text: text.slice(offset, offset + limit),
    note: "原始持久Job记录；INPUT包含Host组装说明，不等于用户逐字原话；RESULT为该成功Run的结果，不自动代表当前版本或审核通过。",
  };
}

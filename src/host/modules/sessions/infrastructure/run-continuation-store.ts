import type { DatabaseSync } from "node:sqlite";
import {
  MAX_CONTINUATION_CHARACTERS,
  MAX_CONTINUATION_EVIDENCE_REFS,
  MAX_CONTINUATION_REQUESTS,
  type RunContinuationSnapshot,
} from "../../../../shared/contracts.js";
import { readRuntimePlan, sha256 } from "../../../runtime/execution/runtime-plan.js";

const EXTERNAL_TOOL_IDS = [
  "public_page_collect",
  "xhs_public_search",
  "merchant_source_collect",
  "account_diagnosis_save",
];

/** 在消息受理事务内冻结最近已取消任务，拒绝跨会话、旧来源和归属变化。 */
export function createRunContinuation(
  db: DatabaseSync,
  sessionId: string,
  scope: "NORMAL" | "MERCHANT",
  ownerId: string,
  sourceRunId: string,
): RunContinuationSnapshot {
  if (
    db
      .prepare("SELECT 1 FROM generation_job WHERE source_run_id=? AND session_id=? AND purpose='PUBLICATION_SUMMARY'")
      .get(sourceRunId, sessionId)
  )
    throw new Error("CONTINUATION_SOURCE_INVALID");
  const latest = db
    .prepare("SELECT run_id, status, runtime_plan_json FROM agent_run WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(sessionId);
  if (latest?.run_id !== sourceRunId || latest.status !== "CANCELLED") throw new Error("CONTINUATION_SOURCE_INVALID");
  const sourcePlan = readRuntimePlan(String(latest.runtime_plan_json));
  if (sourcePlan && (sourcePlan.session.scope !== scope || sourcePlan.session.ownerId !== ownerId))
    throw new Error("CONTINUATION_SOURCE_INVALID");
  const message = db
    .prepare("SELECT message_id, content_json FROM message WHERE session_id = ? AND run_id = ? AND role = 'user'")
    .get(sessionId, sourceRunId);
  if (!message) throw new Error("CONTINUATION_SOURCE_INVALID");
  const content = (JSON.parse(String(message.content_json)) as { text: string }).text;
  const requests = [
    ...(sourcePlan?.continuation?.requests ?? []),
    { runId: sourceRunId, messageId: String(message.message_id), content, sha256: sha256(content) },
  ];
  if (
    requests.length > MAX_CONTINUATION_REQUESTS ||
    requests.reduce((total, item) => total + item.content.length, 0) > MAX_CONTINUATION_CHARACTERS
  )
    throw new Error("CONTINUATION_CONTEXT_LIMIT");
  const runIds = JSON.stringify(requests.map((item) => item.runId));
  // 只列有持久正文且归属相符的公开证据；旧附件和商家快照不随接续重新授权。
  const evidence = db
    .prepare(`SELECT evidence_id, visible_text, visible_text_sha256 FROM merchant_public_evidence
      WHERE session_id = ? AND run_id IN (SELECT value FROM json_each(?)) AND status = 'COLLECTED'
      AND (merchant_id = ? OR (? = 'NORMAL' AND merchant_id IS NULL)) ORDER BY rowid`)
    .all(sessionId, runIds, scope === "MERCHANT" ? ownerId : null, scope);
  for (const item of evidence)
    if (sha256(String(item.visible_text)) !== item.visible_text_sha256) throw new Error("CONTINUATION_SOURCE_INVALID");
  // 开始过但没有成功结束回执的外部工具结果不确定，新 Run 不得自动重放该类调用。
  const uncertainToolIds = EXTERNAL_TOOL_IDS.filter((toolId) =>
    Boolean(
      db
        .prepare(`SELECT 1 FROM runtime_event started
          WHERE started.run_id IN (SELECT value FROM json_each(?)) AND started.type = 'session.tool.started'
          AND json_extract(started.payload_json, '$.toolName') = ?
          AND json_extract(started.payload_json, '$.delegationId') IS NULL
          AND NOT EXISTS (SELECT 1 FROM runtime_event completed WHERE completed.run_id = started.run_id
            AND completed.type = 'session.tool.completed' AND completed.seq > started.seq
            AND json_extract(completed.payload_json, '$.toolCallId') = json_extract(started.payload_json, '$.toolCallId')
            AND json_extract(completed.payload_json, '$.toolName') = json_extract(started.payload_json, '$.toolName')
            AND json_extract(completed.payload_json, '$.delegationId') IS NULL
            AND json_extract(completed.payload_json, '$.isError') = 0)
          LIMIT 1`)
        .get(runIds, toolId),
    ),
  );
  return {
    version: 1,
    sourceRunId,
    requests,
    evidenceRefs: evidence.slice(0, MAX_CONTINUATION_EVIDENCE_REFS).map((item) => ({
      evidenceId: String(item.evidence_id),
      sha256: String(item.visible_text_sha256),
    })),
    omittedEvidenceCount: Math.max(0, evidence.length - MAX_CONTINUATION_EVIDENCE_REFS),
    uncertainToolIds,
  };
}

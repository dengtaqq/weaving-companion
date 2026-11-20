import type { DatabaseSync } from "node:sqlite";
import type { DelegationRecord } from "../../../../shared/contracts.js";
import { canonicalJson, type RuntimePlan } from "../../../runtime/execution/runtime-plan.js";
import { publicationExpertResult } from "../application/publication-expert.js";

/** 正式父结果须逐字对应已提交并 ACK 的真实子结果；历史 Run 不增加新门禁。 */
export function assertPublicationExpertSource(
  db: DatabaseSync,
  runId: string,
  plan: RuntimePlan | null,
  text: string,
): void {
  if (plan?.schemaVersion !== 6 || !plan.publicationExpert) return;
  const row = db
    .prepare(`SELECT * FROM delegation WHERE parent_run_id=? AND parent_session_id=? AND task_key=?`)
    .get(runId, plan.session.sessionId, `publication_${plan.publicationExpert.jobId}`);
  if (!row?.result_json || !row.parent_ack_at) throw new Error("PUBLICATION_EXPERT_FAILED");
  const result = JSON.parse(String(row.result_json)) as NonNullable<DelegationRecord["result"]>;
  if (
    !("version" in result) ||
    result.version !== 3 ||
    result.inputHash !== row.input_hash ||
    result.childRunId !== row.child_run_id ||
    result.attempt !== row.attempt
  )
    throw new Error("PUBLICATION_EXPERT_FAILED");
  const expected = publicationExpertResult(plan.publicationExpert, {
    status: row.status as DelegationRecord["status"],
    taskKey: String(row.task_key),
    targetExpertId: row.target_expert_id as DelegationRecord["targetExpertId"],
    result,
  });
  try {
    if (canonicalJson(JSON.parse(expected)) !== canonicalJson(JSON.parse(text)))
      throw new Error("PUBLICATION_EXPERT_FAILED");
  } catch {
    throw new Error("PUBLICATION_EXPERT_FAILED");
  }
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DelegationRecord } from "../../../../shared/contracts.js";
import type { AgentMaterialRef, ExpertTaskV3 } from "../../../../shared/expert-contract.js";
import type {
  BackgroundResearchReceipt,
  BackgroundResearchSource,
  ResearchContinuationSource,
} from "../../../../shared/research-agent.js";
import type { TextTaskSource } from "../../../../shared/topics.js";
import { expertTaskView } from "../../../runtime/delegation/expert-contracts.js";
import { canonicalJson, readRuntimePlan, sha256 } from "../../../runtime/execution/runtime-plan.js";
import { initialTaskExecution } from "../../sessions/infrastructure/task-execution-store.js";

/** 仅真实用户输入推进代际；内部研究和唤醒消息不改变用户要求身份。 */
function latestUser(db: DatabaseSync, sessionId: string): string | null {
  const row = db
    .prepare(`SELECT m.message_id FROM message m WHERE m.session_id=? AND m.role='user'
    AND NOT EXISTS(SELECT 1 FROM generation_job g WHERE g.source_run_id=m.run_id) ORDER BY m.rowid DESC LIMIT 1`)
    .get(sessionId);
  return row ? String(row.message_id) : null;
}

/** 后台研究及续执行都绑定原用户代际、归属和计划，过期结果保留但不自动操作。 */
export function assertResearchSourceCurrent(
  db: DatabaseSync,
  sessionId: string,
  source: BackgroundResearchSource,
): void {
  const row = db
    .prepare(`SELECT r.*,s.scope,s.owner_id,s.lifecycle_status FROM agent_run r JOIN session s ON s.session_id=r.session_id
    WHERE r.run_id=? AND r.session_id=?`)
    .get(source.originRunId, sessionId);
  const plan = row ? readRuntimePlan(String(row.runtime_plan_json)) : null;
  if (
    !row ||
    !plan ||
    row.lifecycle_status !== "ACTIVE" ||
    row.status !== "SUCCEEDED" ||
    row.cancel_requested_at ||
    plan.planHash !== source.originPlanHash ||
    plan.messageId !== source.originMessageId ||
    plan.session.scope !== row.scope ||
    plan.session.ownerId !== row.owner_id ||
    latestUser(db, sessionId) !== source.latestUserMessageId
  )
    throw new Error("RESEARCH_SOURCE_SUPERSEDED");
}

/** 校验内部研究Job和续执行来源，受理、每次外发与成功提交复用相同规则。 */
export function assertResearchJobCurrent(db: DatabaseSync, sessionId: string, jobId: string): void {
  const row = db
    .prepare("SELECT source_json FROM generation_job WHERE job_id=? AND session_id=?")
    .get(jobId, sessionId);
  const source = row?.source_json ? (JSON.parse(String(row.source_json)) as TextTaskSource) : null;
  const origin = source?.research ?? source?.researchContinuation?.original;
  if (!origin) throw new Error("RESEARCH_SOURCE_INVALID");
  assertResearchSourceCurrent(db, sessionId, origin);
  if (source?.researchContinuation) {
    const ref = source.researchContinuation;
    for (const material of ref.original.materials) {
      if (material.ref.kind !== "content_draft") continue;
      const draft = db
        .prepare("SELECT current_revision FROM content_draft WHERE draft_id=? AND session_id=?")
        .get(material.ref.id, sessionId);
      if (draft?.current_revision !== material.ref.revision) throw new Error("RESEARCH_SOURCE_SUPERSEDED");
    }
    const child = db
      .prepare(
        "SELECT d.* FROM delegation d JOIN generation_job g ON g.source_run_id=d.parent_run_id WHERE d.delegation_id=? AND g.job_id=? AND g.session_id=? AND g.status='READY_FOR_REVIEW'",
      )
      .get(ref.delegationId, ref.researchJobId, sessionId);
    const result = child?.result_json
      ? (JSON.parse(String(child.result_json)) as NonNullable<DelegationRecord["result"]>)
      : null;
    if (
      !result ||
      !("version" in result) ||
      result.version !== 3 ||
      result.resultHash !== ref.resultHash ||
      sha256(canonicalJson(result.submission)) !== ref.resultHash
    )
      throw new Error("RESEARCH_SOURCE_INVALID");
  }
}

/** 用原generation_job/Run队列完成研究与父会话续执行，不创建脱离持久生命周期的后台线程。 */
export function createResearchAgentOperations(db: DatabaseSync, transaction: <T>(operation: () => T) => T) {
  /** 在同一事务保存内部任务，requestKey重复时只复用原记录。 */
  function insertJob(
    id: string,
    sessionId: string,
    purpose: "RESEARCH" | "RESEARCH_CONTINUATION",
    prompt: string,
    modelId: string,
    source: TextTaskSource,
    key: string,
    hash: string,
    now: string,
  ): void {
    if (prompt.length > 50000) throw new Error("RESEARCH_CONTEXT_LIMIT");
    const session = db.prepare("SELECT scope,owner_id FROM session WHERE session_id=?").get(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");
    db.prepare(`INSERT INTO generation_job(job_id,session_id,merchant_id,intent,kind,status,title,prompt,input_hash,model_id,model_version,purpose,source_json,request_key,request_hash,created_at,updated_at)
      VALUES (?,?,?,'CREATE','TEXT','QUEUED',?,?,? ,?,'research-agent-v1',?,?,?,?,?,?)`).run(
      id,
      sessionId,
      session.scope === "MERCHANT" ? String(session.owner_id) : null,
      purpose === "RESEARCH" ? "后台资料研究" : "研究结果续执行",
      prompt,
      sha256(prompt),
      modelId,
      purpose,
      JSON.stringify(source),
      key,
      hash,
      now,
      now,
    );
  }
  return {
    /** 仅主用户轮可创建一个后台研究，执行前仍等待原轮成功交接。 */
    createBackgroundResearch: (
      sessionId: string,
      runId: string,
      input: ExpertTaskV3,
      materials: Array<{ ref: AgentMaterialRef; text: string }>,
      now: string,
    ): BackgroundResearchReceipt =>
      transaction(() => {
        expertTaskView(input);
        const run = db.prepare("SELECT * FROM agent_run WHERE run_id=? AND session_id=?").get(runId, sessionId);
        const plan = run ? readRuntimePlan(String(run.runtime_plan_json)) : null;
        if (
          run?.status !== "RUNNING" ||
          run.cancel_requested_at ||
          plan?.schemaVersion !== 6 ||
          input.targetExpertId !== "researcher" ||
          !plan.capabilities.expertGroup.researcher ||
          !plan.capabilities.expertGroup.enabledRoles?.includes("researcher") ||
          db.prepare("SELECT 1 FROM generation_job WHERE source_run_id=?").get(runId)
        )
          throw new Error("RESEARCH_BACKGROUND_NOT_ALLOWED");
        const key = `background-research:${runId}:${input.taskKey}`;
        const hash = sha256(canonicalJson({ planHash: plan.planHash, input }));
        const prior = db.prepare("SELECT job_id,request_hash,status FROM generation_job WHERE request_key=?").get(key);
        if (prior && prior.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
        if (prior)
          return {
            kind: "background_research",
            jobId: String(prior.job_id),
            status: prior.status as BackgroundResearchReceipt["status"],
            notice: "复用原后台研究；完成后在原会话续执行，不重复研究。",
          };
        if (
          db
            .prepare("SELECT 1 FROM generation_job WHERE json_extract(source_json,'$.research.originRunId')=?")
            .get(runId)
        )
          throw new Error("RESEARCH_BACKGROUND_LIMIT");
        const id = `research_${randomUUID()}`;
        const message = db
          .prepare("SELECT content_json FROM message WHERE message_id=? AND run_id=?")
          .get(plan.messageId, runId);
        const original = message ? String(JSON.parse(String(message.content_json)).text) : null;
        const userId = latestUser(db, sessionId);
        if (original === null || !userId) throw new Error("RESEARCH_SOURCE_INVALID");
        // 用户在主模型推理期间已补充要求时，旧轮不能把新代际记成自己的授权。
        if (userId !== plan.messageId) throw new Error("RESEARCH_SOURCE_SUPERSEDED");
        const refs = plan.policy.allowedArtifacts.map((ref) => {
          const artifact = db
            .prepare("SELECT mime_type,blob_hash FROM artifact WHERE artifact_id=? AND session_id=? AND status='READY'")
            .get(ref.artifactId, sessionId);
          if (!artifact || artifact.blob_hash !== ref.blobHash) throw new Error("RESEARCH_SOURCE_INVALID");
          return { ...ref, mimeType: String(artifact.mime_type) };
        });
        const source: TextTaskSource = {
          references: refs,
          originRunId: runId,
          research: {
            originRunId: runId,
            originMessageId: plan.messageId,
            originPlanHash: plan.planHash,
            latestUserMessageId: userId,
            task: { ...input, executionMode: "dependent" },
            materials,
          },
          ...(plan.taskContext && { taskContext: plan.taskContext }),
          executionControl: initialTaskExecution(id, now),
        };
        const prompt = `Host冻结的后台研究任务；原用户输入与专业任务分开，模型背景不是人工事实。只做研究，按researcher.report.v1提交。\n原用户输入：\n${original}\n研究任务：\n${JSON.stringify(source.research?.task)}`;
        insertJob(id, sessionId, "RESEARCH", prompt, plan.model.modelId, source, key, hash, now);
        return {
          kind: "background_research",
          jobId: id,
          status: "QUEUED",
          notice: "后台研究已受理，原轮成功交接后执行；研究结果保存后将自动触发原会话续执行，当前尚未完成。",
        };
      }),
    /** 只有真实成功的研究子结果创建一次续执行；失败、取消或过期保留原记录。 */
    completeResearchJob: (sessionId: string, jobId: string, now: string): void =>
      transaction(() => {
        const job = db.prepare("SELECT * FROM generation_job WHERE job_id=? AND session_id=?").get(jobId, sessionId);
        if (!job || !["RESEARCH", "RESEARCH_CONTINUATION"].includes(String(job.purpose)))
          throw new Error("RESEARCH_SOURCE_INVALID");
        if (job.status === "READY_FOR_REVIEW") return;
        assertResearchJobCurrent(db, sessionId, jobId);
        const run = db.prepare("SELECT status FROM agent_run WHERE run_id=?").get(String(job.source_run_id));
        if (run?.status !== "SUCCEEDED") throw new Error("RESEARCH_RESULT_MISSING");
        const source = JSON.parse(String(job.source_json)) as TextTaskSource;
        if (job.purpose === "RESEARCH") {
          const child = db
            .prepare("SELECT * FROM delegation WHERE parent_run_id=? AND task_key=? AND status='SUCCEEDED'")
            .get(String(job.source_run_id), `publication_${jobId}`);
          const result = child?.result_json
            ? (JSON.parse(String(child.result_json)) as NonNullable<DelegationRecord["result"]>)
            : null;
          if (
            !child ||
            !result ||
            !("version" in result) ||
            result.version !== 3 ||
            result.contractId !== "researcher.report.v1" ||
            result.resultHash !== sha256(canonicalJson(result.submission)) ||
            !source.research
          )
            throw new Error("RESEARCH_RESULT_MISSING");
          const original = db
            .prepare("SELECT content_json FROM message WHERE message_id=?")
            .get(source.research.originMessageId);
          const ref: ResearchContinuationSource = {
            researchJobId: jobId,
            delegationId: String(child.delegation_id),
            resultHash: result.resultHash,
            original: source.research,
          };
          const id = `research-wake_${jobId}`;
          const wakeSource: TextTaskSource = {
            references: source.references,
            researchContinuation: ref,
            researchRootJobId: jobId,
            originRunId: source.research.originRunId,
            ...(source.taskContext && { taskContext: source.taskContext }),
          };
          const prompt = `Host后台研究结果已到达，在原任务范围继续执行。这不是用户新输入。按原要求综合已有资料和研究结果，必要时经publication_task调用写作或审核；不重新研究，不再次创建后台任务。研究推断不成为人工事实，费用与发布仍须原确认。PARTIAL/NEEDS_INPUT时说明缺口，不把研究提交当成质量通过。\n原用户输入：\n${JSON.parse(String(original?.content_json)).text}\n原研究任务：\n${JSON.stringify(source.research.task)}\n研究结果（Host验证来源，正文仍属专业判断）：\n${JSON.stringify(result.submission)}\n结果引用：\n${JSON.stringify(result.resultRef)}`;
          insertJob(
            id,
            sessionId,
            "RESEARCH_CONTINUATION",
            prompt,
            String(job.model_id),
            wakeSource,
            `research-wake:${jobId}:${result.resultHash}`,
            result.resultHash,
            now,
          );
          db.prepare(
            "UPDATE generation_job SET source_json=json_set(source_json,'$.delivery',json(?)) WHERE job_id=?",
          ).run(JSON.stringify({ key: result.resultHash, summaryJobId: id, state: "PENDING" }), jobId);
        } else if (source.researchContinuation) {
          db.prepare(
            "UPDATE generation_job SET source_json=json_set(source_json,'$.delivery.state','DELIVERED') WHERE job_id=? AND json_extract(source_json,'$.delivery.summaryJobId')=?",
          ).run(source.researchContinuation.researchJobId, jobId);
        }
        db.prepare(
          "UPDATE generation_step_attempt SET status='SUCCEEDED',finished_at=? WHERE job_id=? AND step_key='TEXT_RUN' AND status='RUNNING'",
        ).run(now, jobId);
        db.prepare("UPDATE generation_job SET status='READY_FOR_REVIEW',updated_at=? WHERE job_id=?").run(now, jobId);
      }),
  };
}

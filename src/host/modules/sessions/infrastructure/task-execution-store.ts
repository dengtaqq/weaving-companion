import type { DatabaseSync } from "node:sqlite";
import type {
  TaskBudgetActor,
  TaskBudgetKind,
  TaskExecutionControl,
  TaskExecutionLimits,
} from "../../../../shared/task-execution.js";
import { blocksToolReplay } from "../../../runtime/tools/tool-replay-policy.js";
import { assertResearchJobCurrent } from "../../research/infrastructure/research-agent-store.js";

type Row = Record<string, unknown>;
export const DEFAULT_TASK_LIMITS: TaskExecutionLimits = {
  modelCalls: 48,
  toolCalls: 96,
  steps: 40,
  images: 9,
  summaryCalls: 12,
  activeMs: 1200000,
};

/** 初始化新根任务共享额度；旧任务由显式继续入口补记可观察消耗。 */
export function initialTaskExecution(rootJobId: string, now: string): TaskExecutionControl {
  return {
    version: 1,
    rootJobId,
    revision: 1,
    state: "ACTIVE",
    reason: null,
    limits: { ...DEFAULT_TASK_LIMITS },
    usage: {
      modelCalls: 0,
      toolCalls: 0,
      steps: 0,
      images: 0,
      summaryCalls: 0,
      activeMs: 0,
      reservedMs: 0,
      reportedTokens: 0,
      unknownUsages: 0,
      estimatedIntervals: 0,
    },
    updatedAt: now,
  };
}

/** 旧根任务在用户新一轮明确继续时启用额度，按原事件补记可见调用和保守时长上界。 */
export function enableExistingTaskExecution(db: DatabaseSync, rootJobId: string, now: string): void {
  const root = db.prepare("SELECT session_id,source_json FROM generation_job WHERE job_id=?").get(rootJobId);
  if (!root || JSON.parse(String(root.source_json ?? "null"))?.executionControl) return;
  const control = initialTaskExecution(rootJobId, now);
  const events = db
    .prepare(
      "SELECT e.type,e.payload_json FROM runtime_event e JOIN generation_job g ON g.source_run_id=e.run_id JOIN task_context c ON c.context_id=json_extract(g.source_json,'$.taskContext.contextId') WHERE c.root_job_id=?",
    )
    .all(rootJobId);
  control.usage.modelCalls = events.filter(
    (row) => row.type === "session.context.measured" && JSON.parse(String(row.payload_json)).stage === "request",
  ).length;
  control.usage.toolCalls = events.filter((row) => row.type === "session.tool.started").length;
  control.usage.steps = Number(
    db
      .prepare(
        "SELECT COUNT(*) n FROM generation_job g JOIN task_context c ON c.context_id=json_extract(g.source_json,'$.taskContext.contextId') WHERE c.root_job_id=? AND json_extract(g.source_json,'$.parentConversationJobId') IS NOT NULL",
      )
      .get(rootJobId)?.n ?? 0,
  );
  const task = db.prepare("SELECT draft_id FROM task_context WHERE root_job_id=?").get(rootJobId);
  if (task?.draft_id)
    control.usage.images = Number(
      db
        .prepare("SELECT COUNT(*) n FROM generation_job WHERE session_id=? AND target_draft_id=? AND kind='IMAGE'")
        .get(String(root.session_id), String(task.draft_id))?.n ?? 0,
    );
  control.usage.unknownUsages = control.usage.modelCalls;
  control.usage.estimatedIntervals = control.usage.modelCalls;
  control.usage.activeMs = control.usage.modelCalls * 120000;
  const exceeded = (Object.keys(DEFAULT_TASK_LIMITS) as Array<keyof TaskExecutionLimits>).find(
    (key) => control.usage[key] >= control.limits[key],
  );
  if (exceeded) {
    control.state = "PAUSED";
    control.reason = exceeded;
  }
  db.prepare(
    "UPDATE generation_job SET source_json=json_set(source_json,'$.executionControl',json(?)) WHERE job_id=?",
  ).run(JSON.stringify(control), rootJobId);
}

/** 复用根Job JSON、原操作幂等账本和Run/Attempt，在Worker事务内维护预算。 */
export function createTaskExecutionOperations(db: DatabaseSync, transaction: <T>(operation: () => T) => T) {
  /** 从同会话任务上下文定位根任务，任意Job ID不能获得其他会话的额度。 */
  function root(sessionId: string, jobId: string): { row: Row; control: TaskExecutionControl } | null {
    const row = db
      .prepare(
        `WITH RECURSIVE lineage AS (
          SELECT j.*,0 depth FROM generation_job j WHERE j.job_id=? AND j.session_id=?
          UNION ALL SELECT parent.*,l.depth+1 FROM lineage l
          LEFT JOIN task_context c ON c.context_id=json_extract(l.source_json,'$.taskContext.contextId') AND c.session_id=l.session_id
          JOIN generation_job parent ON parent.session_id=l.session_id AND parent.job_id=COALESCE(json_extract(l.source_json,'$.researchRootJobId'),c.root_job_id,l.job_id)
          WHERE parent.job_id!=l.job_id AND l.depth<16
        ) SELECT * FROM lineage ORDER BY depth DESC LIMIT 1`,
      )
      .get(jobId, sessionId) as Row | undefined;
    const control = row?.source_json
      ? (JSON.parse(String(row.source_json)).executionControl as TaskExecutionControl | undefined)
      : undefined;
    return row && control ? { row, control } : null;
  }

  /** 只更新控制字段，不覆盖同事务中刚保存的工作流或异步交接位置。 */
  function save(control: TaskExecutionControl, now: string): void {
    control.revision++;
    control.updatedAt = now;
    db.prepare(
      "UPDATE generation_job SET source_json=json_set(source_json,'$.executionControl',json(?)) WHERE job_id=?",
    ).run(JSON.stringify(control), control.rootJobId);
  }

  /** 读取精确父子Attempt与取消意图，阻止晚到子回调继续消费额度。 */
  function actorJob(actor: TaskBudgetActor): Row {
    const run = db
      .prepare(
        "SELECT r.*,g.job_id,g.purpose,g.source_json task_source_json FROM agent_run r LEFT JOIN generation_job g ON g.source_run_id=r.run_id WHERE r.run_id=?",
      )
      .get(actor.runId) as Row | undefined;
    if (run?.status !== "RUNNING" || run.attempt !== actor.attempt || run.cancel_requested_at)
      throw new Error("TASK_BUDGET_ACTOR_INVALID");
    const source = run.task_source_json ? JSON.parse(String(run.task_source_json)) : null;
    if (run.job_id && (source?.research || source?.researchContinuation))
      assertResearchJobCurrent(db, String(run.session_id), String(run.job_id));
    if (actor.delegationId) {
      const child = db
        .prepare("SELECT status,attempt,parent_run_id FROM delegation WHERE delegation_id=?")
        .get(actor.delegationId) as Row | undefined;
      if (
        !child ||
        child.parent_run_id !== actor.runId ||
        child.attempt !== actor.childAttempt ||
        !["RUNNING", "SUCCEEDED"].includes(String(child.status))
      )
        throw new Error("TASK_BUDGET_ACTOR_INVALID");
    }
    return run;
  }

  /** 同一稳定调用键只预留一次；额度不足先持久暂停，再由调用方停止执行。 */
  function reserve(
    sessionId: string,
    jobId: string,
    kind: TaskBudgetKind,
    key: string,
    reservedMs: number,
    now: string,
    actor?: TaskBudgetActor,
  ): boolean {
    const target = root(sessionId, jobId);
    if (!target) return true;
    const previous = db.prepare("SELECT result_json FROM api_operation WHERE operation_key=?").get(key) as
      | Row
      | undefined;
    if (previous) {
      const record = JSON.parse(String(previous.result_json));
      if (record.rootJobId !== target.control.rootJobId || record.kind !== kind)
        throw new Error("IDEMPOTENCY_CONFLICT");
      return true;
    }
    const { control } = target;
    // 汇总单独保留有限额度，使业务预算耗尽后仍可解释停止原因；不会恢复业务额度。
    const summary = kind === "summaryCalls";
    if (
      (!summary && control.state === "PAUSED") ||
      control.usage[kind] >= control.limits[kind] ||
      (!summary && control.usage.activeMs + control.usage.reservedMs + reservedMs > control.limits.activeMs)
    ) {
      if (!summary || control.usage[kind] >= control.limits[kind]) {
        control.state = "PAUSED";
        control.reason = control.usage[kind] >= control.limits[kind] ? kind : "activeMs";
        save(control, now);
      }
      return false;
    }
    control.usage[kind]++;
    control.usage.reservedMs += reservedMs;
    const record = {
      rootJobId: control.rootJobId,
      sessionId,
      jobId,
      kind,
      actor,
      startedAt: now,
      reservedMs,
      settled: reservedMs === 0 && kind !== "modelCalls" && kind !== "summaryCalls",
    };
    db.prepare(
      "INSERT INTO api_operation(operation_key,kind,result_json,request_hash,created_at) VALUES (?,'task.budget',?,'v1',?)",
    ).run(key, JSON.stringify(record), now);
    save(control, now);
    return true;
  }

  /** 结算已预留调用；中断用预留上界记账并标注估计，不把未知用量记成零账单。 */
  function settle(key: string, now: string, tokens: number | null, estimated = false): void {
    const row = db
      .prepare("SELECT result_json FROM api_operation WHERE operation_key=? AND kind='task.budget'")
      .get(key) as Row | undefined;
    if (!row) return;
    const record = JSON.parse(String(row.result_json));
    if (record.settled) return;
    const target = root(record.sessionId, record.rootJobId);
    if (!target) return;
    const { control } = target;
    const duration = estimated ? record.reservedMs : Math.max(0, Date.parse(now) - Date.parse(record.startedAt));
    control.usage.reservedMs = Math.max(0, control.usage.reservedMs - record.reservedMs);
    control.usage.activeMs += duration;
    if (record.kind === "modelCalls" || record.kind === "summaryCalls") {
      if (tokens !== null && Number.isFinite(tokens) && tokens > 0) control.usage.reportedTokens += tokens;
      else control.usage.unknownUsages++;
    }
    if (estimated) control.usage.estimatedIntervals++;
    db.prepare("UPDATE api_operation SET result_json=? WHERE operation_key=?").run(
      JSON.stringify({ ...record, settled: true, duration, tokens, estimated }),
      key,
    );
    save(control, now);
  }

  return {
    /** 读取当前共享额度，历史未启用任务返回null。 */
    getTaskExecutionControl: (sessionId: string, jobId: string) => root(sessionId, jobId)?.control ?? null,
    /** 在SDK请求或工具执行前原子预留；父子使用同一根任务。 */
    reserveTaskExecution: (actor: TaskBudgetActor, kind: TaskBudgetKind, callKey: string, now: string): boolean =>
      transaction(() => {
        const run = actorJob(actor);
        if (!run.job_id) return true;
        const milliseconds =
          kind === "modelCalls" ||
          (kind === "toolCalls" &&
            !["delegate_task", "delegation_submit", "delegation_ask_user"].some((name) => callKey.endsWith(`:${name}`)))
            ? Number(JSON.parse(String(run.runtime_plan_json)).model.timeoutMs)
            : 0;
        const budgetKind = run.purpose === "PUBLICATION_SUMMARY" && kind === "modelCalls" ? "summaryCalls" : kind;
        return reserve(
          String(run.session_id),
          String(run.job_id),
          budgetKind,
          `task-budget:${run.session_id}:${actor.runId}:${actor.attempt}:${actor.delegationId ?? "main"}:${actor.childAttempt ?? 0}:${callKey}`,
          budgetKind === "summaryCalls" ? 0 : milliseconds,
          now,
          actor,
        );
      }),
    /** 用同一Actor和调用键结算，重复或晚到结算不增加消耗。 */
    settleTaskExecution: (actor: TaskBudgetActor, callKey: string, tokens: number | null, now: string): void =>
      transaction(() =>
        settle(
          `task-budget:${db.prepare("SELECT session_id FROM agent_run WHERE run_id=?").get(actor.runId)?.session_id}:${actor.runId}:${actor.attempt}:${actor.delegationId ?? "main"}:${actor.childAttempt ?? 0}:${callKey}`,
          now,
          tokens,
        ),
      ),
    /** 工作流已有子任务优先复用；只有新步骤或新图片请求才占用一次额度。 */
    reservePublicationExecution: (
      sessionId: string,
      jobId: string,
      kind: "steps" | "images",
      key: string,
      now: string,
    ) => transaction(() => reserve(sessionId, jobId, kind, `task-budget:${sessionId}:${key}:${kind}`, 0, now)),
    /** 重启/取消后的未结算调用按预留上界收口，停止等待时间不计为真实执行时间。 */
    reconcileTaskExecution: (now: string) =>
      transaction(() => {
        const rows = db
          .prepare(
            "SELECT operation_key,result_json FROM api_operation WHERE kind='task.budget' AND json_extract(result_json,'$.settled')=0",
          )
          .all() as Row[];
        for (const row of rows) {
          const record = JSON.parse(String(row.result_json));
          const actor = record.actor as TaskBudgetActor | undefined;
          if (!actor) continue;
          const run = db.prepare("SELECT status,attempt FROM agent_run WHERE run_id=?").get(actor.runId) as
            | Row
            | undefined;
          if (run?.status !== "RUNNING" || run.attempt !== actor.attempt)
            settle(String(row.operation_key), now, null, true);
        }
      }),
    /** 仅显式用户命令可提高额度并恢复原预算失败的Run；旧游标/输入/Attempt历史保留。 */
    resumeTaskExecution: (
      sessionId: string,
      jobId: string,
      revision: number,
      limits: TaskExecutionLimits,
      key: string,
      now: string,
    ) =>
      transaction(() => {
        const prior = db.prepare("SELECT request_hash,result_json FROM api_operation WHERE operation_key=?").get(key) as
          | Row
          | undefined;
        const hash = JSON.stringify({ sessionId, jobId, revision, limits });
        if (prior) {
          if (prior.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
          return JSON.parse(String(prior.result_json)) as TaskExecutionControl;
        }
        const target = root(sessionId, jobId);
        const session = db.prepare("SELECT lifecycle_status FROM session WHERE session_id=?").get(sessionId);
        if (!target || session?.lifecycle_status !== "ACTIVE") throw new Error("TASK_BUDGET_NOT_FOUND");
        const { control } = target;
        if (control.revision !== revision || control.state !== "PAUSED")
          throw new Error("TASK_BUDGET_REVISION_CONFLICT");
        if (
          Object.keys(DEFAULT_TASK_LIMITS).some(
            (name) =>
              !Number.isSafeInteger(limits[name as keyof TaskExecutionLimits]) ||
              limits[name as keyof TaskExecutionLimits] < control.usage[name as keyof TaskExecutionLimits] ||
              limits[name as keyof TaskExecutionLimits] >
                Math.max(
                  DEFAULT_TASK_LIMITS[name as keyof TaskExecutionLimits] * 10,
                  control.usage[name as keyof TaskExecutionLimits] +
                    DEFAULT_TASK_LIMITS[name as keyof TaskExecutionLimits],
                ),
          )
        )
          throw new Error("TASK_BUDGET_LIMIT_INVALID");
        const unsafe = db
          .prepare(
            "SELECT e.payload_json FROM runtime_event e JOIN agent_run r ON r.run_id=e.run_id JOIN generation_job g ON g.source_run_id=r.run_id JOIN task_context c ON c.context_id=json_extract(g.source_json,'$.taskContext.contextId') WHERE c.root_job_id=? AND r.status='FAILED' AND r.error_code='TASK_BUDGET_EXHAUSTED' AND e.type='session.tool.started'",
          )
          .all(control.rootJobId) as Row[];
        if (unsafe.some((row) => blocksToolReplay(String(JSON.parse(String(row.payload_json)).toolName), "startup")))
          throw new Error("TASK_BUDGET_RECONCILE_REQUIRED");
        if (
          db
            .prepare(
              "SELECT 1 FROM agent_run WHERE session_id=? AND status IN ('RUNNING','QUEUED','RECOVERING','WAITING_CONFIRMATION')",
            )
            .get(sessionId)
        )
          throw new Error("SESSION_RUN_ACTIVE");
        control.limits = { ...limits };
        control.state = "ACTIVE";
        control.reason = null;
        save(control, now);
        const jobs = db
          .prepare(
            "SELECT g.* FROM generation_job g JOIN task_context c ON c.context_id=json_extract(g.source_json,'$.taskContext.contextId') WHERE c.root_job_id=? AND g.session_id=?",
          )
          .all(control.rootJobId, sessionId) as Row[];
        for (const job of jobs) {
          const run = job.source_run_id
            ? (db.prepare("SELECT status,error_code FROM agent_run WHERE run_id=?").get(String(job.source_run_id)) as
                | Row
                | undefined)
            : undefined;
          if (run?.status !== "FAILED" || run.error_code !== "TASK_BUDGET_EXHAUSTED") continue;
          db.prepare("UPDATE agent_run SET status='QUEUED',error_code=NULL,error_message=NULL WHERE run_id=?").run(
            String(job.source_run_id),
          );
          db.prepare(
            "UPDATE delegation SET status='QUEUED',error_code=NULL WHERE parent_run_id=? AND status='FAILED'",
          ).run(String(job.source_run_id));
          db.prepare("UPDATE generation_job SET status='RUNNING',error_code=NULL,attempt=attempt+1 WHERE job_id=?").run(
            String(job.job_id),
          );
          db.prepare(
            "INSERT INTO generation_step_attempt(job_id,step_key,attempt,input_hash,strategy_version,status,started_at) SELECT job_id,'TEXT_RUN',(SELECT COALESCE(MAX(attempt),0)+1 FROM generation_step_attempt WHERE job_id=? AND step_key='TEXT_RUN'),input_hash,model_version,'RUNNING',? FROM generation_job WHERE job_id=?",
          ).run(String(job.job_id), now, String(job.job_id));
          if (job.purpose === "PUBLICATION_CHAT")
            db.prepare(
              "UPDATE generation_job SET source_json=json_set(source_json,'$.workflow.state','ROUTING') WHERE job_id=?",
            ).run(String(job.job_id));
        }
        db.prepare(
          "INSERT INTO api_operation(operation_key,kind,result_json,request_hash,created_at) VALUES (?,'task.resume',?,?,?)",
        ).run(key, JSON.stringify(control), hash, now);
        return control;
      }),
  };
}

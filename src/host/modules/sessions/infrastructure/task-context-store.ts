import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PublicationDetail, PublicationReview } from "../../../../shared/publication.js";
import type { PublicationAction, PublicationConversationFlow } from "../../../../shared/publication-conversation.js";
import type {
  CurrentTaskStatus,
  TaskCarrier,
  TaskContextDelta,
  TaskContextRef,
  TaskContextSnapshot,
  TaskContextView,
} from "../../../../shared/task-context.js";
import {
  applyTaskContextDelta,
  isTaskRequirementsCurrent,
  taskContextHash,
  taskContextRef,
  taskRequirementsDigest,
  validateTaskContextBudget,
} from "../../../runtime/context/task-context.js";
import { readRuntimePlan, sha256 } from "../../../runtime/execution/runtime-plan.js";

type Row = Record<string, unknown>;

/** 正式业务接纳处复核新 Plan 的要求，封闭模型返回后到落库前的竞态窗口。 */
export function assertCurrentTaskContextForRun(db: DatabaseSync, runId: string): void {
  const run = db.prepare("SELECT runtime_plan_json FROM agent_run WHERE run_id=?").get(runId) as Row | undefined;
  const plan = run?.runtime_plan_json ? readRuntimePlan(String(run.runtime_plan_json)) : null;
  if (!plan?.taskContext || !plan.runtime.adapterVersion.includes(":task-status-1:")) return;
  const ref = plan.taskContext;
  const rows = db
    .prepare(`SELECT r.revision,r.body_json,r.sha256 FROM task_context_revision r
    JOIN task_context c ON c.context_id=r.context_id WHERE c.context_id=? AND c.session_id=?
    AND r.revision IN (?,c.current_revision) ORDER BY r.revision`)
    .all(ref.contextId, ref.sessionId, ref.revision) as Row[];
  const frozen = rows.find((item) => item.revision === ref.revision);
  const latest = rows.at(-1);
  if (!frozen || !latest || frozen.sha256 !== ref.sha256) throw new Error("TASK_CONTEXT_SOURCE_INVALID");
  const base = JSON.parse(String(frozen.body_json)) as TaskContextSnapshot;
  const current = JSON.parse(String(latest.body_json)) as TaskContextSnapshot;
  if (taskContextHash(base) !== ref.sha256 || taskContextHash(current) !== latest.sha256)
    throw new Error("TASK_CONTEXT_SOURCE_INVALID");
  if (!isTaskRequirementsCurrent(base, current)) throw new Error("INPUT_VERSION_STALE");
}
const actionLabels: Record<PublicationAction["kind"], string> = {
  REPAIR: "按审核局部返修并复审",
  REPAIR_COPY: "局部修订文案",
  REPAIR_PUBLICATION: "局部修订发布说明及图位",
  WRITE_COPY: "撰写或修改文案",
  PLAN_IMAGES: "规划配图",
  MAKE_IMAGES: "制作尚缺配图",
  USE_IMAGE: "采用指定图片",
  UPDATE_PUBLICATION: "调整配图与发布说明",
  REVIEW: "独立审核图文",
  FINISH: "完成整套图文",
  IMAGE: "制作当前配图",
  CONFIRM: "确认整套图文",
};
interface TaskContextReaders {
  /** 读取同会话当前图文，业务状态仍由原事实源维护。 */
  publication(sessionId: string, draftId: string): PublicationDetail;
  /** 读取同稿件历史审核，供明确计算当前适用性。 */
  reviews(sessionId: string, draftId: string): { reviews: PublicationReview[] };
}

/** 在新业务任务受理时固定该稿件的当前要求，后续重试不再读取最新版。 */
export function readTaskContextForDraft(db: DatabaseSync, sessionId: string, draftId: string): TaskContextRef | null {
  const row = db
    .prepare(`SELECT c.context_id,c.current_revision,r.body_json,r.sha256,s.scope,s.owner_id
    FROM task_context c JOIN task_context_revision r ON r.context_id=c.context_id AND r.revision=c.current_revision
    JOIN session s ON s.session_id=c.session_id WHERE c.session_id=? AND c.draft_id=?`)
    .get(sessionId, draftId) as Row | undefined;
  if (!row) return null;
  const snapshot = JSON.parse(String(row.body_json)) as TaskContextSnapshot;
  if (
    snapshot.sessionId !== sessionId ||
    snapshot.scope !== row.scope ||
    snapshot.ownerId !== row.owner_id ||
    snapshot.sha256 !== row.sha256 ||
    taskContextHash(snapshot) !== row.sha256
  )
    throw new Error("TASK_CONTEXT_SOURCE_INVALID");
  return taskContextRef(snapshot);
}

/** 持久化同稿件要求及精确版本，成果和执行进度只生成引用投影。 */
export function createTaskContextOperations(db: DatabaseSync, readers: TaskContextReaders) {
  /** 同时校验会话生命周期与上下文归属，ID 本身不授予跨会话访问。 */
  function session(sessionId: string): Row {
    const row = db.prepare("SELECT * FROM session WHERE session_id=?").get(sessionId) as Row | undefined;
    if (!row || row.lifecycle_status === "TRASHED") throw new Error("SESSION_NOT_FOUND");
    return row;
  }

  /** 读取并复核不可变正文、hash 和当前会话归属。 */
  function getTaskContextSnapshot(sessionId: string, ref: TaskContextRef): TaskContextSnapshot {
    const owner = session(sessionId);
    if (ref.sessionId !== sessionId) throw new Error("TASK_CONTEXT_SOURCE_INVALID");
    const row = db
      .prepare(`SELECT r.body_json,r.sha256 FROM task_context_revision r JOIN task_context c
      ON c.context_id=r.context_id WHERE c.context_id=? AND c.session_id=? AND r.revision=?`)
      .get(ref.contextId, sessionId, ref.revision) as Row | undefined;
    if (!row) throw new Error("TASK_CONTEXT_NOT_FOUND");
    const snapshot = JSON.parse(String(row.body_json)) as TaskContextSnapshot;
    if (
      row.sha256 !== ref.sha256 ||
      snapshot.sha256 !== ref.sha256 ||
      taskContextHash(snapshot) !== ref.sha256 ||
      snapshot.contextId !== ref.contextId ||
      snapshot.revision !== ref.revision ||
      snapshot.sessionId !== sessionId ||
      snapshot.scope !== owner.scope ||
      snapshot.ownerId !== owner.owner_id
    )
      throw new Error("TASK_CONTEXT_SOURCE_INVALID");
    return snapshot;
  }

  /** 读取当前已提交版本，历史 Run 始终通过精确引用读取旧版。 */
  function current(contextId: string, sessionId: string): TaskContextSnapshot {
    const row = db
      .prepare(`SELECT c.current_revision,r.sha256 FROM task_context c JOIN task_context_revision r
      ON r.context_id=c.context_id AND r.revision=c.current_revision WHERE c.context_id=? AND c.session_id=?`)
      .get(contextId, sessionId) as Row | undefined;
    if (!row) throw new Error("TASK_CONTEXT_NOT_FOUND");
    return getTaskContextSnapshot(sessionId, {
      contextId,
      revision: Number(row.current_revision),
      sha256: String(row.sha256),
      sessionId,
    });
  }

  /** 在调用方事务内追加版本并检查基准，避免不同补充相互覆盖。 */
  function append(snapshot: TaskContextSnapshot, expectedRevision: number, now: string): TaskContextSnapshot {
    validateTaskContextBudget(snapshot);
    snapshot.sha256 = taskContextHash(snapshot);
    const result = db
      .prepare(
        "UPDATE task_context SET current_revision=?,updated_at=? WHERE context_id=? AND session_id=? AND current_revision=?",
      )
      .run(snapshot.revision, now, snapshot.contextId, snapshot.sessionId, expectedRevision);
    if (result.changes !== 1) throw new Error("TASK_CONTEXT_REVISION_CONFLICT");
    db.prepare(
      "INSERT INTO task_context_revision(context_id,revision,body_json,sha256,created_at) VALUES (?,?,?,?,?)",
    ).run(snapshot.contextId, snapshot.revision, JSON.stringify(snapshot), snapshot.sha256, now);
    return snapshot;
  }

  /** 根据明确稿件或已受理任务找归属，不按最近一次任务猜测。 */
  function locate(sessionId: string, draftId?: string, rootJobId?: string): string | null {
    session(sessionId);
    if (draftId && !db.prepare("SELECT 1 FROM content_draft WHERE draft_id=? AND session_id=?").get(draftId, sessionId))
      throw new Error("PUBLICATION_NOT_FOUND");
    let contextId: string | null = null;
    if (draftId) {
      const row = db
        .prepare("SELECT context_id FROM task_context WHERE session_id=? AND draft_id=?")
        .get(sessionId, draftId) as Row | undefined;
      contextId = row ? String(row.context_id) : null;
    }
    if (rootJobId) {
      const row = db
        .prepare(
          "SELECT source_json FROM generation_job WHERE session_id=? AND job_id=? AND purpose='PUBLICATION_CHAT'",
        )
        .get(sessionId, rootJobId) as Row | undefined;
      if (!row) throw new Error("TASK_CONTEXT_NOT_FOUND");
      const ref = (JSON.parse(String(row.source_json)) as { taskContext?: TaskContextRef }).taskContext;
      if (!ref || (contextId && ref.contextId !== contextId)) throw new Error("TASK_CONTEXT_SOURCE_INVALID");
      getTaskContextSnapshot(sessionId, ref);
      const bound = db
        .prepare("SELECT draft_id FROM task_context WHERE context_id=? AND session_id=?")
        .get(ref.contextId, sessionId) as Row;
      if (draftId && bound.draft_id !== draftId) throw new Error("TASK_CONTEXT_SOURCE_INVALID");
      contextId = ref.contextId;
    }
    return contextId;
  }

  /** 当前稿件和图位共同决定审核适用性，旧审核仍可作为历史记录读取。 */
  function reviewCarrier(review: PublicationReview, detail: PublicationDetail): TaskCarrier {
    const applicable =
      review.draftRevision === detail.draft.currentRevision &&
      review.publicationRevision === detail.publication.revision &&
      review.applicability === "CURRENT";
    return {
      id: review.reviewId,
      kind: "REVIEW",
      title: "图文审核",
      revision: review.draftRevision,
      sha256: review.snapshotHash,
      readability: "AVAILABLE",
      applicability: applicable ? "CURRENT" : "HISTORICAL",
      approval: "NOT_APPLICABLE",
      progress:
        review.verdict === "PASS" ? "本次审核通过" : review.verdict === "LIMITED" ? "审核覆盖有限" : "审核要求修改",
      reason: applicable
        ? null
        : !review.binding
          ? "旧审核没有要求与规则绑定，不能证明当前逐项通过"
          : `仅覆盖原要求与正文第${review.draftRevision}版、编排第${review.publicationRevision}版`,
    };
  }

  /** 从真实草稿、编排、图片、审核和导出引用组装有界成果索引。 */
  function carriers(sessionId: string, draftId: string | null): TaskCarrier[] {
    if (!draftId) return [];
    const detail = readers.publication(sessionId, draftId);
    const result: TaskCarrier[] = [
      {
        id: draftId,
        kind: "DRAFT",
        title: detail.draft.title,
        revision: detail.draft.currentRevision,
        sha256: detail.draft.sha256,
        readability: "AVAILABLE",
        applicability: "CURRENT",
        approval: detail.draft.approvedRevision === detail.draft.currentRevision ? "APPROVED" : "PENDING",
        progress: "正文已保存",
        reason: null,
      },
      {
        id: draftId,
        kind: "PUBLICATION",
        title: "配图编排",
        revision: detail.publication.revision,
        sha256: null,
        readability: "AVAILABLE",
        applicability: "CURRENT",
        approval: "PENDING",
        progress: `${detail.publication.images.length}个图位`,
        reason: null,
      },
    ];
    for (const slot of detail.publication.images) {
      const image = slot.artifactId ? detail.images.find((item) => item.artifactId === slot.artifactId) : null;
      const job = slot.jobId
        ? (db.prepare("SELECT status FROM generation_job WHERE job_id=? AND session_id=?").get(slot.jobId, sessionId) as
            | Row
            | undefined)
        : null;
      const unknown = job?.status === "UNKNOWN_EXTERNAL";
      result.push({
        id: slot.artifactId ?? slot.jobId ?? slot.slotId,
        kind: "IMAGE",
        title: slot.title,
        revision: null,
        sha256: image?.blobHash ?? null,
        readability: image ? "AVAILABLE" : "UNAVAILABLE",
        applicability: image ? "CURRENT" : "NEEDS_REVIEW",
        approval: "PENDING",
        progress: image
          ? "图片已登记，读取时仍核验文件"
          : unknown
            ? "外部生成结果未知"
            : job
              ? `生成任务：${String(job.status)}`
              : "尚无图片",
        reason: unknown ? "须按已有对账流程核实，不能自动重发" : image ? null : "尚无可用图片回执",
      });
    }
    result.push(
      ...readers
        .reviews(sessionId, draftId)
        .reviews.slice(0, 2)
        .map((item) => reviewCarrier(item, detail)),
    );
    for (const item of detail.exports.slice(0, 3))
      result.push({
        id: item.artifactId,
        kind: "EXPORT",
        title: "固定版本发布包",
        revision: item.draftRevision,
        sha256: item.snapshotHash,
        readability: "AVAILABLE",
        applicability:
          item.draftRevision === detail.draft.currentRevision &&
          item.publicationRevision === detail.publication.revision
            ? "CURRENT"
            : "HISTORICAL",
        approval: "APPROVED",
        progress: "已登记交付文件；不代表已向外发布",
        reason: null,
      });
    return result;
  }

  /** 待办只从持久工作流和目标状态派生，模型的口头完成不会清除工作。 */
  function progress(
    sessionId: string,
    contextId: string,
    draftId: string | null,
  ): { remainingWork: string[]; workflowState: string | null } {
    const row = db
      .prepare(`SELECT source_json FROM generation_job WHERE session_id=? AND purpose='PUBLICATION_CHAT'
      AND json_extract(source_json,'$.taskContext.contextId')=? ORDER BY rowid DESC LIMIT 1`)
      .get(sessionId, contextId) as Row | undefined;
    const flow = row
      ? (JSON.parse(String(row.source_json)) as { workflow?: PublicationConversationFlow }).workflow
      : null;
    const work: string[] = [];
    if (flow?.state === "WAITING_IMAGE_CONFIRMATION") work.push("等待用户确认本次图片费用");
    if (flow?.state === "WAITING_FINAL_CONFIRMATION") work.push("等待用户最终确认整套图文");
    if (flow?.state === "FAILED")
      work.push(
        flow.errorCode === "PUBLICATION_IMAGE_UNKNOWN"
          ? "核实外部图片结果，禁止自动重发"
          : "处理尚未完成的步骤，请查看本篇任务回执",
      );
    if (flow?.state === "RUNNING")
      work.push(
        ...flow.steps
          .slice(flow.cursor)
          .map((step) => `待执行：${actionLabels[step.kind]}${step.brief ? `（${step.brief}）` : ""}`),
      );
    if (draftId) {
      const detail = readers.publication(sessionId, draftId);
      if (detail.publication.images.some((item) => !item.artifactId))
        work.push("补齐尚无可用结果的配图，未知结果先对账");
      const applicable = readers
        .reviews(sessionId, draftId)
        .reviews.find(
          (item) =>
            item.draftRevision === detail.draft.currentRevision &&
            item.publicationRevision === detail.publication.revision &&
            item.applicability === "CURRENT",
        );
      if (!applicable) work.push("当前图文尚无匹配版本的独立审核");
      else if (applicable.verdict !== "PASS")
        work.push(applicable.verdict === "LIMITED" ? "人工补查独立审核未覆盖部分" : "处理独立审核提出的修改事项");
    }
    return { remainingWork: work, workflowState: flow?.state ?? null };
  }

  /** 受理事务内记录原话并冻结成果；失败或取消后原话仍保留待整理。 */
  function acceptTaskContext(
    sessionId: string,
    jobId: string,
    instruction: string,
    now: string,
    draftId?: string,
    rootJobId?: string,
  ): TaskContextSnapshot {
    const owner = session(sessionId);
    if (owner.lifecycle_status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");
    const existing = locate(sessionId, draftId, rootJobId);
    let base: TaskContextSnapshot;
    if (existing) base = current(existing, sessionId);
    else {
      const contextId = `ctx_${randomUUID()}`;
      db.prepare(
        "INSERT INTO task_context(context_id,session_id,root_job_id,draft_id,current_revision,created_at,updated_at) VALUES (?,?,?,?,0,?,?)",
      ).run(contextId, sessionId, jobId, draftId ?? null, now, now);
      base = {
        formatVersion: 1,
        contextId,
        revision: 0,
        sessionId,
        scope: owner.scope as "NORMAL" | "MERCHANT",
        ownerId: String(owner.owner_id),
        rootJobId: jobId,
        draftId: draftId ?? null,
        requirements: [],
        pendingSources: [],
        carriers: [],
        remainingWork: [],
        sha256: "",
      };
    }
    const binding = db.prepare("SELECT draft_id FROM task_context WHERE context_id=?").get(base.contextId) as Row;
    const targetDraftId = binding.draft_id ? String(binding.draft_id) : null;
    if (targetDraftId && draftId !== targetDraftId) throw new Error("TASK_CONTEXT_SOURCE_INVALID");
    return append(
      {
        ...base,
        revision: base.revision + 1,
        draftId: targetDraftId,
        pendingSources: [
          ...base.pendingSources,
          { kind: "GENERATION_REQUEST", id: jobId, text: instruction, sha256: sha256(instruction) },
        ],
        carriers: carriers(sessionId, targetDraftId),
        remainingWork: progress(sessionId, base.contextId, targetDraftId).remainingWork,
      },
      base.revision,
      now,
    );
  }

  /** 路由成功后与操作计划同事务提交要求增量，避免未验证计划触发副作用。 */
  function commitTaskContext(
    sessionId: string,
    ref: TaskContextRef,
    delta: TaskContextDelta,
    now: string,
  ): TaskContextSnapshot {
    const snapshot = getTaskContextSnapshot(sessionId, ref);
    if (current(ref.contextId, sessionId).revision !== ref.revision) throw new Error("TASK_CONTEXT_REVISION_CONFLICT");
    return append(
      {
        ...snapshot,
        revision: snapshot.revision + 1,
        requirements: applyTaskContextDelta(snapshot, delta),
        pendingSources: [],
      },
      snapshot.revision,
      now,
    );
  }

  /** 草稿成功落库后建立同会话关联，不改变历史快照内容。 */
  function bindTaskContextDraft(sessionId: string, ref: TaskContextRef, draftId: string): void {
    const snapshot = getTaskContextSnapshot(sessionId, ref);
    readers.publication(sessionId, draftId);
    const result = db
      .prepare(
        "UPDATE task_context SET draft_id=? WHERE context_id=? AND session_id=? AND (draft_id IS NULL OR draft_id=?)",
      )
      .run(draftId, snapshot.contextId, sessionId, draftId);
    if (result.changes !== 1) throw new Error("TASK_CONTEXT_SOURCE_INVALID");
  }

  /** 页面读取当前成果状态，Run 继续使用不可变快照以免输入漂移。 */
  function getTaskContextView(sessionId: string, draftId?: string, rootJobId?: string): TaskContextView | null {
    const contextId = locate(sessionId, draftId, rootJobId);
    if (!contextId) return null;
    const snapshot = current(contextId, sessionId);
    const currentStatus = getCurrentTaskStatus(sessionId, taskContextRef(snapshot));
    return {
      snapshot,
      draftId: currentStatus.draftId,
      carriers: currentStatus.carriers,
      remainingWork: currentStatus.remainingWork,
      workflowState: currentStatus.workflowState,
      currentStatus,
    };
  }

  /** 从原领域事实读取当前进度，保持冻结要求与实际成果两个视图独立。 */
  function getCurrentTaskStatus(sessionId: string, ref: TaskContextRef): CurrentTaskStatus {
    const frozen = getTaskContextSnapshot(sessionId, ref);
    const latest = current(ref.contextId, sessionId);
    const row = db
      .prepare("SELECT draft_id FROM task_context WHERE context_id=? AND session_id=?")
      .get(ref.contextId, sessionId) as Row;
    const draftId = row.draft_id ? String(row.draft_id) : null;
    const detail = draftId ? readers.publication(sessionId, draftId) : null;
    const workflow = db
      .prepare(`SELECT job_id FROM generation_job WHERE session_id=? AND purpose='PUBLICATION_CHAT'
      AND json_extract(source_json,'$.taskContext.contextId')=? ORDER BY rowid DESC LIMIT 1`)
      .get(sessionId, ref.contextId) as Row | undefined;
    const event = db
      .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM runtime_event WHERE session_id=?")
      .get(sessionId) as Row;
    return {
      version: 1,
      contextId: ref.contextId,
      frozenRequirementsDigest: taskRequirementsDigest(frozen),
      latestRequirementsDigest: taskRequirementsDigest(latest),
      basisStatus: isTaskRequirementsCurrent(frozen, latest) ? "CURRENT" : "SUPERSEDED",
      draftId,
      draftRevision: detail?.draft.currentRevision ?? null,
      publicationRevision: detail?.publication.revision ?? null,
      workflowJobId: workflow ? String(workflow.job_id) : null,
      ...progress(sessionId, ref.contextId, draftId),
      carriers: carriers(sessionId, draftId),
      observedSeq: Number(event.seq),
      observedAt: new Date().toISOString(),
    };
  }

  return {
    getTaskContextSnapshot,
    getTaskContextView,
    getCurrentTaskStatus,
    acceptTaskContext,
    commitTaskContext,
    bindTaskContextDraft,
  };
}

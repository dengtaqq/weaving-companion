import type { DatabaseSync } from "node:sqlite";
import {
  type PublicationSnapshot,
  publicationReviewV2Schema,
  publicationReviewV3Schema,
} from "../../../../shared/publication.js";
import type { TaskContextRef, TaskContextSnapshot } from "../../../../shared/task-context.js";
import type { TextTaskSource } from "../../../../shared/topics.js";
import {
  hasPendingTaskRequirements,
  isTaskRequirementsCurrent,
  taskContextHash,
  taskRequirementsDigest,
} from "../../../runtime/context/task-context.js";
import { canonicalJson, sha256 } from "../../../runtime/execution/runtime-plan.js";

export const PUBLICATION_REVIEW_VERSION = "publication-review-v2:requirements-1";
export const PUBLICATION_REVIEW_RULES =
  "逐项核验有效要求，事实和推断分开；未读取像素不得声称看图；未满足要求必须修改，无法确定或图片覆盖不足保持LIMITED；审核不替代费用、人工确认或外部发布回执。";
export const REVIEW_RULES_HASH = sha256(PUBLICATION_REVIEW_RULES);
export const REVIEW_RECHECK_CONTRACT_HASH = sha256(canonicalJson(publicationReviewV3Schema));
export const REVIEW_CONTRACT_HASH = sha256(canonicalJson(publicationReviewV2Schema));

/** 读取精确任务依据或其当前版，仅在同会话归属和正文 hash 有效时返回。 */
export function readReviewTaskContext(
  db: DatabaseSync,
  sessionId: string,
  ref: TaskContextRef | null,
  latest = false,
): TaskContextSnapshot | null {
  if (!ref) return null;
  if (ref.sessionId !== sessionId) throw new Error("TASK_CONTEXT_SOURCE_INVALID");
  const row = db
    .prepare(`SELECT r.body_json,r.sha256 FROM task_context c JOIN task_context_revision r
    ON r.context_id=c.context_id AND r.revision=${latest ? "c.current_revision" : "?"}
    WHERE c.context_id=? AND c.session_id=?`)
    .get(...(latest ? [ref.contextId, sessionId] : [ref.revision, ref.contextId, sessionId])) as
    | { body_json: string; sha256: string }
    | undefined;
  if (!row || (!latest && row.sha256 !== ref.sha256)) throw new Error("TASK_CONTEXT_SOURCE_INVALID");
  const snapshot = JSON.parse(row.body_json) as TaskContextSnapshot;
  if (
    taskContextHash(snapshot) !== row.sha256 ||
    snapshot.sessionId !== sessionId ||
    snapshot.contextId !== ref.contextId
  )
    throw new Error("TASK_CONTEXT_SOURCE_INVALID");
  return snapshot;
}

/** Host 冻结正文、编排、真实图片引用、要求摘要和规则；图片核验证据仅限实际入模白名单。 */
export function freezeReviewBinding(
  snapshot: PublicationSnapshot,
  task: TaskContextSnapshot | null,
  comparedImages: number,
  formatVersion?: 3,
): NonNullable<TextTaskSource["review"]> {
  if (hasPendingTaskRequirements(task)) throw new Error("TASK_CONTEXT_REQUIREMENTS_PENDING");
  const requirements = task?.requirements.filter((item) => item.status === "ACTIVE") ?? [];
  const imageRefs = snapshot.publication.images.map((slot) => {
    const image = snapshot.images.find((item) => item.artifactId === slot.artifactId);
    if (!slot.artifactId || !image) throw new Error("PUBLICATION_REVIEW_SOURCE_INVALID");
    return { slotId: slot.slotId, artifactId: slot.artifactId, sha256: image.blobHash };
  });
  return {
    ...(formatVersion && { formatVersion }),
    snapshotHash: sha256(JSON.stringify(snapshot)),
    comparedImages,
    totalImages: snapshot.images.length,
    binding: {
      version: 2,
      draftId: snapshot.draft.draftId,
      draftRevision: snapshot.draft.currentRevision,
      draftHash: snapshot.draft.sha256,
      publicationRevision: snapshot.publication.revision,
      publicationHash: sha256(JSON.stringify(snapshot.publication)),
      imageRefs,
      requirementsDigest: task ? taskRequirementsDigest(task) : sha256(canonicalJson([])),
      reviewerContractHash: formatVersion === 3 ? REVIEW_RECHECK_CONTRACT_HASH : REVIEW_CONTRACT_HASH,
      rulesHash: REVIEW_RULES_HASH,
    },
    requirements,
    evidenceRefs: [
      `draft:${snapshot.draft.draftId}:${snapshot.draft.currentRevision}`,
      `publication:${snapshot.draft.draftId}:${snapshot.publication.revision}`,
      ...imageRefs.slice(0, comparedImages).map((ref) => `image:${ref.artifactId}`),
      ...requirements.map((item) => `source:${item.source.id}`),
    ].filter((ref, index, all) => all.indexOf(ref) === index),
  };
}

/** 查询时重新判断要求、待整理补充和规则适用性，不改写旧审核正文。 */
export function isReviewBasisCurrent(
  db: DatabaseSync,
  sessionId: string,
  ref: TaskContextRef | null,
  digest: string,
): boolean {
  const frozen = readReviewTaskContext(db, sessionId, ref);
  const latest = readReviewTaskContext(db, sessionId, ref, true);
  // 旧报告也须重新判断，不能因未整理原话已在冻结版中就把漏检报告标为当前通过。
  if (hasPendingTaskRequirements(frozen) || hasPendingTaskRequirements(latest)) return false;
  return frozen && latest
    ? taskRequirementsDigest(latest) === digest && isTaskRequirementsCurrent(frozen, latest)
    : digest === sha256(canonicalJson([]));
}

import type { DatabaseSync } from "node:sqlite";
import type { PublicationRepairBasis } from "../../../../shared/publication-repair.js";
import { canonicalJson, sha256 } from "../../../runtime/execution/runtime-plan.js";

/** 补丁提交前复核原审核及当前双版本，防止后台人工编辑被旧补丁覆盖。 */
export function assertPublicationRepairBasis(db: DatabaseSync, sessionId: string, basis: PublicationRepairBasis): void {
  const review = db
    .prepare(
      "SELECT r.body_json FROM publication_review r JOIN content_draft d ON d.draft_id=r.draft_id WHERE r.review_id=? AND d.session_id=? AND d.draft_id=?",
    )
    .get(basis.reviewId, sessionId, basis.draft.draftId) as { body_json: string } | undefined;
  const draft = db
    .prepare(
      "SELECT d.current_revision,v.title,v.body,v.internal_notes,v.sha256 FROM content_draft d JOIN content_revision v ON v.draft_id=d.draft_id AND v.revision=d.current_revision WHERE d.draft_id=? AND d.session_id=?",
    )
    .get(basis.draft.draftId, sessionId) as Record<string, unknown> | undefined;
  const publication = db
    .prepare("SELECT revision,body_json,updated_at FROM content_publication WHERE draft_id=?")
    .get(basis.draft.draftId) as { revision: number; body_json: string; updated_at: string } | undefined;
  const frozenFields = {
    instructions: basis.publication.instructions,
    visualStyle: basis.publication.visualStyle,
    images: basis.publication.images,
  };
  if (
    !review ||
    sha256(canonicalJson(JSON.parse(review.body_json))) !== basis.reviewHash ||
    !draft ||
    draft.current_revision !== basis.draft.currentRevision ||
    draft.sha256 !== basis.draft.sha256 ||
    draft.title !== basis.draft.title ||
    draft.body !== basis.draft.body ||
    String(draft.internal_notes ?? "") !== String(basis.draft.internalNotes ?? "") ||
    !publication ||
    publication.revision !== basis.publication.revision ||
    publication.updated_at !== basis.publication.updatedAt ||
    canonicalJson(JSON.parse(publication.body_json)) !== canonicalJson(frozenFields)
  )
    throw new Error("PUBLICATION_REPAIR_SOURCE_CHANGED");
}

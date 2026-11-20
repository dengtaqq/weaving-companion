import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TextGenerationJobRecord } from "../../../../shared/contracts.js";
import {
  type PublicationReview,
  type PublicationSnapshot,
  publicationReviewV2Schema,
  publicationReviewV3Schema,
} from "../../../../shared/publication.js";
import type { TaskContextRef } from "../../../../shared/task-context.js";
import type { TextTaskSource } from "../../../../shared/topics.js";
import { readRuntimePlan } from "../../../runtime/execution/runtime-plan.js";
import { readTaskContextForDraft } from "../../sessions/infrastructure/task-context-store.js";
import { parsePublicationReview } from "../application/publication-conversation.js";
import { assertPublicationExpertSource } from "./publication-expert-source.js";
import {
  freezeReviewBinding,
  isReviewBasisCurrent,
  PUBLICATION_REVIEW_RULES,
  PUBLICATION_REVIEW_VERSION,
  REVIEW_CONTRACT_HASH,
  REVIEW_RECHECK_CONTRACT_HASH,
  REVIEW_RULES_HASH,
  readReviewTaskContext,
} from "./publication-review-contract.js";
import { publicationHash } from "./publication-store.js";

type Row = Record<string, unknown>;

/** 为固定图文建立独立审核任务，真正的审核角色成功回执才可保存意见。 */
export function createPublicationReviewOperations(
  db: DatabaseSync,
  transaction: <T>(operation: () => T) => T,
  getSnapshot: (
    sessionId: string,
    draftId: string,
    draftRevision: number,
    publicationRevision: number,
  ) => PublicationSnapshot,
  readJob: (sessionId: string, jobId: string) => TextGenerationJobRecord | null,
) {
  /** 读取最新审核任务，刷新或重启后仍可继续等待。 */
  function reviewJob(sessionId: string, draftId: string): TextGenerationJobRecord | null {
    const row = db
      .prepare(
        "SELECT job_id FROM generation_job WHERE session_id=? AND target_draft_id=? AND purpose='PUBLICATION_REVIEW' ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId, draftId) as Row | undefined;
    return row ? readJob(sessionId, String(row.job_id)) : null;
  }
  return {
    /** 冻结双版本和可见像素覆盖范围，不把无法读取的图片伪装为已审核。 */
    createPublicationReviewJob: (
      id: string,
      sessionId: string,
      draftId: string,
      draftRevision: number,
      publicationRevision: number,
      modelId: string,
      imageInput: boolean,
      key: string,
      now: string,
      freezeDraftTaskContext = true,
      inheritedTaskContext?: TaskContextRef,
      previousReviewId?: string,
    ): TextGenerationJobRecord =>
      transaction(() => {
        const requestHash = publicationHash({
          sessionId,
          draftId,
          draftRevision,
          publicationRevision,
          modelId,
          imageInput,
          ...(previousReviewId && { previousReviewId }),
        });
        const prior = db.prepare("SELECT * FROM generation_job WHERE request_key=?").get(key) as Row | undefined;
        if (prior) {
          if (prior.request_hash !== requestHash || prior.purpose !== "PUBLICATION_REVIEW")
            throw Error("IDEMPOTENCY_CONFLICT");
          return readJob(sessionId, String(prior.job_id)) as TextGenerationJobRecord;
        }
        if (["QUEUED", "RUNNING"].includes(reviewJob(sessionId, draftId)?.status ?? ""))
          throw Error("PUBLICATION_REVIEW_PENDING");
        const snapshot = getSnapshot(sessionId, draftId, draftRevision, publicationRevision);
        const selected = imageInput ? snapshot.images.slice(0, 5) : [];
        const references = [
          ...new Map(
            selected.map((image) => [
              image.artifactId,
              { artifactId: image.artifactId, blobHash: image.blobHash, mimeType: image.mimeType },
            ]),
          ).values(),
        ];
        const taskContext = freezeDraftTaskContext
          ? readTaskContextForDraft(db, sessionId, draftId)
          : (inheritedTaskContext ?? null);
        const requirements = readReviewTaskContext(db, sessionId, taskContext);
        const review = freezeReviewBinding(snapshot, requirements, selected.length, previousReviewId ? 3 : undefined);
        if (previousReviewId) {
          const prior = db
            .prepare("SELECT body_json FROM publication_review WHERE review_id=? AND draft_id=?")
            .get(previousReviewId, draftId) as Row | undefined;
          const previous = prior ? (JSON.parse(String(prior.body_json)) as PublicationReview) : null;
          if (!previous?.binding || previous.issues.some((issue) => !issue.issueId))
            throw new Error("PUBLICATION_REPAIR_REVIEW_INVALID");
          review.previousReview = {
            reviewId: previousReviewId,
            sha256: publicationHash(previous),
            issues: previous.issues,
          };
        }
        const source: TextTaskSource = {
          ...(taskContext && { taskContext }),
          references,
          publication: { draftId, draftRevision, publicationRevision },
          review,
        };
        const prompt = [
          "你在独立的稿件审核角色中检查这一版完整图文。不得生成或修改原稿，不执行发布。只输出符合以下Schema的JSON。",
          JSON.stringify(previousReviewId ? publicationReviewV3Schema : publicationReviewV2Schema),
          PUBLICATION_REVIEW_RULES,
          ...(review.previousReview
            ? [
                "这是返修后的独立复审。previousIssueChecks对previousReview.issues每条原issueId恰好检查一次：RESOLVED须有当前版本实际证据，REMAINING/UNCERTAIN须在issues保留相同ID、严重程度、目标及图位。涉及IMAGE的问题只有实际读取对应图位像素才能RESOLVED；改了提示词不代表图片已修好。作者补丁和自查不能代替复审。",
                JSON.stringify({ previousReview: review.previousReview }),
              ]
            : []),
          `对下方requirements每个有效ID恰好核验一次，requirementChecks不能遗漏、重复或新增ID。MET/UNMET均给实际证据和解释，UNMET关联issues中唯一issueId。无法确定写UNCERTAIN并说明缺口。evidenceRefs只可从下方白名单逐字选取；未附图片不能引用其image证据。问题issueId在本次报告内唯一。`,
          JSON.stringify({ requirements: review.requirements, evidenceRefs: review.evidenceRefs }),
          `核对事实、价格/功效/优惠承诺、标题/正文/话题、图文一致性、图片顺序和发布说明是否可照做。区分必须修改、警告和建议；缺证据明确说待核实，勿把推断当商家事实。图片像素仅覆盖前${selected.length}/${snapshot.images.length}张；未附图片不能声称看过，覆盖不全必须 verdict=LIMITED。`,
          "文案版本与配图编排版本分别以 draftRevision、publicationRevision 为准，不能混称。按商家原文检查，不因出现‘热饮’就推断‘只提供热饮’；确有歧义时给修改建议，不把未陈述的排他承诺当成已出现的事实。",
          "审核发生在最终确认和打包之前，此时没有ZIP是正常状态，不能据此阻断。最终Host固定生成文案.txt、按序图片、发布说明.md、版本清单.json；不包含独立审核意见文件，审核意见在工作台查看。说明若声称包含其他文件，应建议修正。",
          JSON.stringify({
            draftId,
            draftRevision,
            publicationRevision,
            title: snapshot.draft.title,
            body: snapshot.draft.body,
            publication: snapshot.publication,
            frozenSource: snapshot.source,
          }),
        ].join("\n\n");
        if (prompt.length > 50000) throw Error("PUBLICATION_INPUT_INVALID");
        db.prepare(
          `INSERT INTO generation_job(job_id,session_id,merchant_id,intent,kind,status,title,prompt,input_hash,model_id,model_version,purpose,source_json,target_draft_id,target_revision,target_hash,request_key,request_hash,created_at,updated_at) VALUES (?,?,?,'CREATE','TEXT','QUEUED',?,?,?,?,?,'PUBLICATION_REVIEW',?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          sessionId,
          snapshot.draft.merchantId,
          `${snapshot.draft.title} · 独立审核`,
          prompt,
          publicationHash({ prompt, modelId }),
          modelId,
          previousReviewId ? "publication-review-v3:repair-1" : PUBLICATION_REVIEW_VERSION,
          JSON.stringify(source),
          draftId,
          draftRevision,
          snapshot.draft.sha256,
          key,
          requestHash,
          now,
          now,
        );
        return readJob(sessionId, id) as TextGenerationJobRecord;
      }),
    /** 保存成功审核 Run 的结构化意见，覆盖不足和阻断项由 Host 再次收窄。 */
    completePublicationReviewJob: (sessionId: string, jobId: string, now: string): TextGenerationJobRecord =>
      transaction(() => {
        const job = readJob(sessionId, jobId);
        if (job?.purpose !== "PUBLICATION_REVIEW" || !job.source?.review || !job.source.publication)
          throw Error("PUBLICATION_REVIEW_INVALID");
        if (job.status === "READY_FOR_REVIEW") return job;
        const target = job.source.publication;
        const snapshot = getSnapshot(sessionId, target.draftId, target.draftRevision, target.publicationRevision);
        if (publicationHash(snapshot) !== job.source.review.snapshotHash) throw Error("PUBLICATION_REVISION_CONFLICT");
        const run = db
          .prepare("SELECT status,runtime_plan_json FROM agent_run WHERE run_id=? AND session_id=?")
          .get(job.sourceRunId, sessionId) as Row | undefined;
        const plan = run ? readRuntimePlan(String(run.runtime_plan_json)) : null;
        if (
          job.status !== "RUNNING" ||
          run?.status !== "SUCCEEDED" ||
          !plan ||
          plan.schemaVersion < 4 ||
          (plan.capabilities.expert?.role !== "reviewer" &&
            !(
              plan.schemaVersion === 6 &&
              plan.publicationExpert?.purpose === "PUBLICATION_REVIEW" &&
              plan.publicationExpert.jobId === job.jobId &&
              plan.publicationExpert.targetExpertId === "reviewer"
            ))
        )
          throw Error("PUBLICATION_REVIEW_SOURCE_INVALID");
        const reply = db
          .prepare(
            "SELECT content_json FROM message WHERE run_id=? AND session_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1",
          )
          .get(job.sourceRunId, sessionId) as Row | undefined;
        if (job.source.review.binding) {
          const expected = freezeReviewBinding(
            snapshot,
            readReviewTaskContext(db, sessionId, job.source.taskContext ?? null),
            job.source.review.comparedImages,
            job.source.review.formatVersion,
          );
          if (
            publicationHash(expected.binding) !== publicationHash(job.source.review.binding) ||
            publicationHash(expected.requirements) !== publicationHash(job.source.review.requirements) ||
            publicationHash(expected.evidenceRefs) !== publicationHash(job.source.review.evidenceRefs)
          )
            throw Error("PUBLICATION_REVIEW_SOURCE_INVALID");
        }
        const previous = job.source.review.previousReview;
        if (previous) {
          const prior = db
            .prepare("SELECT body_json FROM publication_review WHERE review_id=? AND draft_id=?")
            .get(previous.reviewId, target.draftId) as Row | undefined;
          const body = prior ? (JSON.parse(String(prior.body_json)) as PublicationReview) : null;
          if (
            !body ||
            publicationHash(body) !== previous.sha256 ||
            publicationHash(body.issues) !== publicationHash(previous.issues)
          )
            throw new Error("PUBLICATION_REPAIR_REVIEW_INVALID");
        }
        const text = String(JSON.parse(String(reply?.content_json)).text);
        assertPublicationExpertSource(db, String(job.sourceRunId), plan, text);
        const output = parsePublicationReview(text, job.source.review);
        if (
          output.issues.some(
            (issue) => issue.slotId && !snapshot.publication.images.some((image) => image.slotId === issue.slotId),
          )
        )
          throw Error("PUBLICATION_REVIEW_INVALID");
        const verdict =
          output.issues.some((issue) => issue.severity === "BLOCKER") ||
          output.requirementChecks?.some((check) => check.status === "UNMET")
            ? "CHANGES_REQUIRED"
            : job.source.review.comparedImages < job.source.review.totalImages ||
                output.requirementChecks?.some((check) => check.status === "UNCERTAIN") ||
                output.previousIssueChecks?.some((check) => check.status === "UNCERTAIN")
              ? "LIMITED"
              : output.verdict;
        const result: PublicationReview = {
          ...output,
          verdict,
          reviewId: `review_${randomUUID()}`,
          jobId,
          draftId: target.draftId,
          draftRevision: target.draftRevision,
          publicationRevision: target.publicationRevision,
          snapshotHash: job.source.review.snapshotHash,
          comparedImages: job.source.review.comparedImages,
          totalImages: job.source.review.totalImages,
          ...(job.source.review.binding && { binding: job.source.review.binding }),
          ...(job.source.review.previousReview && { previousReviewId: job.source.review.previousReview.reviewId }),
          modelId: job.modelId,
          createdAt: now,
        };
        db.prepare(
          "INSERT INTO publication_review(review_id,draft_id,job_id,draft_revision,publication_revision,body_json,created_at) VALUES (?,?,?,?,?,?,?)",
        ).run(
          result.reviewId,
          result.draftId,
          jobId,
          result.draftRevision,
          result.publicationRevision,
          JSON.stringify(result),
          now,
        );
        db.prepare(
          "UPDATE generation_job SET status='READY_FOR_REVIEW',result_draft_id=?,updated_at=? WHERE job_id=?",
        ).run(target.draftId, now, jobId);
        db.prepare(
          "UPDATE generation_step_attempt SET status='SUCCEEDED',finished_at=? WHERE job_id=? AND step_key='TEXT_RUN'",
        ).run(now, jobId);
        return readJob(sessionId, jobId) as TextGenerationJobRecord;
      }),
    /** 审核历史随版本保留，界面必须判断是否仍适用于当前图文。 */
    getPublicationReviews: (
      sessionId: string,
      draftId: string,
    ): { reviews: PublicationReview[]; job: TextGenerationJobRecord | null } => {
      if (!db.prepare("SELECT 1 FROM content_draft WHERE draft_id=? AND session_id=?").get(draftId, sessionId))
        throw Error("PUBLICATION_NOT_FOUND");
      return {
        reviews: (
          db
            .prepare("SELECT body_json FROM publication_review WHERE draft_id=? ORDER BY rowid DESC LIMIT 30")
            .all(draftId) as Row[]
        ).map((row) => {
          const review = JSON.parse(String(row.body_json)) as PublicationReview;
          if (!review.binding) return { ...review, applicability: "UNKNOWN" as const };
          const job = readJob(sessionId, review.jobId);
          const current = db
            .prepare("SELECT current_revision FROM content_draft WHERE draft_id=? AND session_id=?")
            .get(draftId, sessionId) as Row;
          const layout = db.prepare("SELECT revision FROM content_publication WHERE draft_id=?").get(draftId) as
            | Row
            | undefined;
          const applicable =
            current.current_revision === review.draftRevision &&
            layout?.revision === review.publicationRevision &&
            review.binding.rulesHash === REVIEW_RULES_HASH &&
            review.binding.reviewerContractHash ===
              (review.version === 3 ? REVIEW_RECHECK_CONTRACT_HASH : REVIEW_CONTRACT_HASH) &&
            Boolean(job?.source?.taskContext || !readTaskContextForDraft(db, sessionId, draftId)) &&
            isReviewBasisCurrent(db, sessionId, job?.source?.taskContext ?? null, review.binding.requirementsDigest);
          return { ...review, applicability: applicable ? ("CURRENT" as const) : ("HISTORICAL" as const) };
        }),
        job: reviewJob(sessionId, draftId),
      };
    },
  };
}

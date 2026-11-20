import { useEffect, useState } from "react";
import type { TextGenerationJobRecord } from "../../../shared/contracts.js";
import type { PublicationDetail, PublicationReview } from "../../../shared/publication.js";
import * as api from "../../api/client.js";
import { AssistantMarkdown } from "../../components/assistant-markdown.js";
import { ConversationApproval, ConversationReview, TaskExecutionCard } from "./content-conversation.js";
import { PublicationPreview } from "./publication-preview.js";

/** 普通聊天原地展示持久任务、实际成品和确认卡，不增加第二个输入框。 */
export function ChatPublicationResults({
  sessionId,
  disabled,
  onProgress,
}: {
  sessionId: string;
  disabled: boolean;
  onProgress?: () => void;
}) {
  const [jobs, setJobs] = useState<TextGenerationJobRecord[]>([]);
  const [researchJobs, setResearchJobs] = useState<TextGenerationJobRecord[]>([]);
  const [detail, setDetail] = useState<PublicationDetail | null>(null);
  const [review, setReview] = useState<PublicationReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let loading = false;
    /** 定期从Host恢复状态，页面刷新不会重复创建图片或丢失待确认请求。 */
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const all = await api.listTextGenerationJobs(sessionId);
        const next = all
          .filter((job) => job.purpose === "PUBLICATION_CHAT" && job.source?.originRunId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        const draftId = next[0]?.source?.workflow?.draftId;
        const [publication, reviews] = draftId
          ? await Promise.all([api.getPublication(sessionId, draftId), api.getPublicationReviews(sessionId, draftId)])
          : [null, null];
        if (!alive) return;
        setJobs(next);
        setResearchJobs(all.filter((job) => job.purpose === "RESEARCH").slice(0, 3));
        setDetail(publication);
        setReview(
          reviews?.reviews.find(
            (item) =>
              item.draftRevision === publication?.draft.currentRevision &&
              item.publicationRevision === publication?.publication.revision &&
              item.applicability === "CURRENT",
          ),
        );
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  /** 用户只确认卡片中冻结的单张请求，成功后查询原任务而不另发生成。 */
  async function approveImage(job: TextGenerationJobRecord): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await api.approvePublicationConversationImage(sessionId, job);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  /** 最终人工确认后导出当前双版本；旧卡片不能确认后续修改。 */
  async function confirmExport(job: TextGenerationJobRecord): Promise<void> {
    const flow = job.source?.workflow;
    if (!flow?.draftId || !flow.draftRevision || flow.state !== "WAITING_FINAL_CONFIRMATION") return;
    setBusy(true);
    setError("");
    try {
      await api.exportPublication(sessionId, flow.draftId, flow.draftRevision, flow.publicationRevision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const latest = jobs[0];
  const publicationProgress = latest
    ? `${latest.jobId}:${latest.source?.workflow?.state}:${latest.source?.workflow?.receipt}:${detail?.draft.currentRevision}:${detail?.publication.revision}`
    : "";
  const progress = `${publicationProgress}:${researchJobs.map((job) => `${job.jobId}:${job.status}:${job.source?.delivery?.state}`).join(":")}`;
  useEffect(() => {
    if (progress) onProgress?.();
  }, [progress, onProgress]);
  if (!latest && !researchJobs.length) return null;
  const flow = latest?.source?.workflow;
  return (
    <>
      {researchJobs.map((job) => (
        <section key={job.jobId} className="content-chat-receipt" aria-label="资料研究任务" aria-live="polite">
          <strong>资料研究</strong>
          <p>
            {job.status === "FAILED"
              ? "本次研究未完成，已保留任务记录。"
              : job.status === "QUEUED"
                ? "研究已受理，等待执行。"
                : job.status === "RUNNING"
                  ? "研究专家正在核对资料与证据。"
                  : job.source?.delivery?.state === "DELIVERED"
                    ? "研究结果已交接，助手已继续处理原任务。"
                    : job.source?.delivery?.state === "SUPERSEDED"
                      ? "需求已变化，原研究结果保留，未自动应用。"
                      : job.source?.delivery?.state === "FAILED"
                        ? "研究结果已保存，后续处理未完成。"
                        : "研究结果已保存，等待助手继续处理。"}
          </p>
        </section>
      ))}
      {latest && (
        <section className="chat-publication-results" aria-label="聊天中的图文任务" aria-live="polite">
          <h2>本篇图文</h2>
          <p>继续在下方说“改文案”“换封面”或“审核并准备下载”。</p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="content-chat-receipt">
            <strong>
              {latest.executionControl?.state === "PAUSED"
                ? "任务达到执行额度，已暂停，已有成果保留。"
                : flow?.receipt || "已受理，正在处理…"}
            </strong>
            {flow?.reply && <AssistantMarkdown content={flow.reply} />}
            {!!flow?.completed.length && (
              <ul>
                {[...new Set(flow.completed)].map((receipt) => (
                  <li key={receipt}>{receipt}</li>
                ))}
              </ul>
            )}
            {flow?.state === "FAILED" && <p>这次未完成：{flow.errorCode}。已有结果保留，可以继续说明修改要求。</p>}
          </div>
          {flow?.imageRequest?.referenceArtifactId &&
            ["WAITING_IMAGE_CONFIRMATION", "RUNNING"].includes(flow.state) && (
              <p className="muted">当前预览保留上一版配图，本次修改完成后自动替换。</p>
            )}
          {detail && (
            <PublicationPreview
              sessionId={sessionId}
              title={detail.draft.title}
              body={detail.draft.body}
              images={detail.publication.images}
              dirty={false}
              detail={detail}
              deliveryDisabled={disabled || busy || ["QUEUED", "RUNNING"].includes(latest.status)}
              review={review}
            />
          )}
          <TaskExecutionCard sessionId={sessionId} job={latest} disabled={disabled || busy} />
          {review && <ConversationReview review={review} />}
          <ConversationApproval
            key={`${latest.jobId}:${flow?.state}:${flow?.draftRevision}:${flow?.publicationRevision}`}
            job={latest}
            disabled={disabled || busy}
            onApproveImage={approveImage}
            onConfirmExport={confirmExport}
            review={review}
          />
          {flow?.exportArtifactId && (
            <div className="publication-delivery">
              <a className="primary-button" href={api.publicationDownloadUrl(sessionId, flow.exportArtifactId)}>
                下载本版发布包 ZIP
              </a>
            </div>
          )}
        </section>
      )}
    </>
  );
}

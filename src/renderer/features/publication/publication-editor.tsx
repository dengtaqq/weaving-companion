import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { GenerationJobRecord, TextGenerationJobRecord } from "../../../shared/contracts.js";
import type {
  PublicationDetail,
  PublicationFields,
  PublicationImage,
  PublicationReview,
} from "../../../shared/publication.js";
import * as api from "../../api/client.js";
import { AssistantMarkdown } from "../../components/assistant-markdown.js";
import { MediaPicker } from "../merchants/media-library.js";
import { ContentConversation, PreviousIssueChecks } from "./content-conversation.js";
import { ImageReconcileModal } from "./image-reconcile-modal.js";
import { PublicationPreview } from "./publication-preview.js";
import { PublicationRecordForm } from "./publication-record-form.js";

/** 从服务端编排中只提取可编辑字段。 */
function editableFields(detail: PublicationDetail): PublicationFields {
  return {
    instructions: detail.publication.instructions,
    visualStyle: detail.publication.visualStyle,
    images: detail.publication.images,
  };
}

/** 规划未完成前保留空图位，避免把固定样例当成按正文生成的方案。 */
function initialFields(detail: PublicationDetail): PublicationFields {
  return editableFields(detail);
}

const imageStatus = {
  QUEUED: "等待生成",
  RUNNING: "生成中",
  READY_FOR_REVIEW: "待选择采用",
  UNKNOWN_EXTERNAL: "结果未知，请先核对原请求",
  FAILED: "生成失败",
};

/** 围绕同一草稿完成文案修改、逐图创作、整套审核和版本化 ZIP 交付。 */
export function PublicationEditor({
  sessionId,
  draftId,
  provider,
  modelConfigured,
  writable,
  merchantId,
}: {
  sessionId: string;
  draftId: string;
  provider: string;
  modelConfigured: boolean;
  writable: boolean;
  merchantId?: string;
}) {
  const [step, setStep] = useState(2);
  const [planBrief, setPlanBrief] = useState("");
  const [imageCount, setImageCount] = useState(1);
  const [conversationJobs, setConversationJobs] = useState<TextGenerationJobRecord[]>([]);
  const conversation = useRef<HTMLDivElement>(null);
  const seenConversation = useRef("");
  const awaitedPlan = useRef<string | null>(null);
  const [detail, setDetail] = useState<PublicationDetail | null>(null);
  const [fields, setFields] = useState<PublicationFields | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [manualTextOpen, setManualTextOpen] = useState(false);
  const [jobs, setJobs] = useState<GenerationJobRecord[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [checks, setChecks] = useState<boolean[]>([false, false, false, false]);
  const reviewed = checks.every(Boolean);
  /** 每次编辑清除全部人工检查项，避免沿用旧版确认。 */
  const setReviewed = useCallback((value: boolean) => {
    setChecks([value, value, value, value]);
  }, []);
  const [reviews, setReviews] = useState<PublicationReview[]>([]);
  const [reviewJob, setReviewJob] = useState<TextGenerationJobRecord | null>(null);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [reconcile, setReconcile] = useState<GenerationJobRecord | null>(null);
  const [revisionJob, setRevisionJob] = useState<TextGenerationJobRecord | null>(null);
  const awaitedRevision = useRef<string | null>(null);
  const hasLocalEdits = useRef(false);
  const [newerDraft, setNewerDraft] = useState(false);
  const loadedDetail = useRef(detail);
  loadedDetail.current = detail;
  const pending = useRef(new Map<string, string>());
  const localEditKey = `zhiban:publication-edit:${sessionId}:${draftId}`;

  /** 在请求回执前保留稳定命令键，避免网络重试重复生成付费图片。 */
  function commandKey(signature: string): string {
    if (!pending.current.has(signature)) pending.current.set(signature, crypto.randomUUID());
    return pending.current.get(signature) as string;
  }

  /** 显式重新读取已保存版本，不在后台轮询时覆盖用户编辑。 */
  async function reload() {
    const next = await api.getPublication(sessionId, draftId);
    setDetail(next);
    setFields(initialFields(next));
    setTitle(next.draft.title);
    setBody(next.draft.body);
    setReviewed(false);
    setNewerDraft(false);
  }

  useEffect(() => {
    let active = true;
    void api
      .getPublication(sessionId, draftId)
      .then((next) => {
        if (!active) return;
        setDetail(next);
        if (next.planningJob && ["QUEUED", "RUNNING"].includes(next.planningJob.status))
          awaitedPlan.current = next.planningJob.jobId;
        setFields(initialFields(next));
        setTitle(next.draft.title);
        setBody(next.draft.body);
        setStep(
          next.exports.some(
            (item) =>
              item.draftRevision === next.draft.currentRevision &&
              item.publicationRevision === next.publication.revision,
          )
            ? 5
            : next.publication.images.length
              ? 3
              : 2,
        );
        try {
          const stored = sessionStorage.getItem(localEditKey);
          if (stored) {
            const edit = JSON.parse(stored) as {
              title: string;
              body: string;
              fields: PublicationFields;
              draftRevision: number;
              publicationRevision: number;
            };
            if (typeof edit.title === "string" && typeof edit.body === "string" && Array.isArray(edit.fields?.images)) {
              setTitle(edit.title);
              setBody(edit.body);
              setManualTextOpen(edit.title !== next.draft.title || edit.body !== next.draft.body);
              setFields(edit.fields);
              setNewerDraft(
                edit.draftRevision !== next.draft.currentRevision ||
                  edit.publicationRevision !== next.publication.revision,
              );
              setNotice(
                "已恢复本标签页尚未保存的编辑，请核对后保存。若服务器已有新版本，请先复制本地内容再读取最新版本。",
              );
            }
          }
        } catch {
          sessionStorage.removeItem(localEditKey);
        }
      })
      .catch((error: unknown) => {
        if (active) setNotice(String(error));
      });
    return () => {
      active = false;
    };
  }, [sessionId, draftId, localEditKey]);

  useEffect(() => {
    let active = true;
    /** 只补充图片结果和交付历史，保留本地尚未保存的文案与编排。 */
    async function poll() {
      try {
        const [nextJobs, next, reviewState, textJobs] = await Promise.all([
          api.listGenerationJobs(sessionId),
          api.getPublication(sessionId, draftId),
          api.getPublicationReviews(sessionId, draftId),
          api.listTextGenerationJobs(sessionId),
        ]);
        if (!active) return;
        setJobs(nextJobs);
        setReviews(reviewState.reviews);
        setReviewJob(reviewState.job);
        setConversationJobs(textJobs);
        const current = loadedDetail.current;
        if (!current) return;
        const chat = textJobs.find(
          (item) =>
            item.purpose === "PUBLICATION_CHAT" && (item.targetDraftId === draftId || item.resultDraftId === draftId),
        );
        const flow = chat?.source?.workflow;
        // 仅采用本次持久步骤已确认的版本；外部改动或本地输入仍须用户核对。
        if (
          flow &&
          !["ROUTING", "SUPERSEDED"].includes(flow.state) &&
          flow.draftRevision === next.draft.currentRevision &&
          flow.publicationRevision === next.publication.revision &&
          !hasLocalEdits.current
        ) {
          const token = `${chat.jobId}:${flow.state}:${flow.cursor}:${flow.draftRevision}:${flow.publicationRevision}`;
          if (seenConversation.current !== token) {
            seenConversation.current = token;
            setNotice(flow.receipt);
            if (flow.state === "WAITING_FINAL_CONFIRMATION") setStep(4);
            else if (flow.exportArtifactId) setStep(5);
          }
          if (
            next.draft.currentRevision !== current.draft.currentRevision ||
            next.publication.revision !== current.publication.revision
          )
            setReviewed(false);
          setDetail(next);
          setFields(editableFields(next));
          setTitle(next.draft.title);
          setBody(next.draft.body);
          setNewerDraft(false);
          return;
        }
        const revision = textJobs.find((item) => item.purpose === "CONTENT" && item.targetDraftId === draftId);
        setRevisionJob(revision ?? null);
        if (
          revision?.jobId === awaitedRevision.current &&
          revision.status === "READY_FOR_REVIEW" &&
          revision.conversation?.action === "REPLY"
        ) {
          awaitedRevision.current = null;
          setNotice("AI 已回复，本次对话没有修改文案。可继续讨论或提出修改要求。");
        }
        if (revision && ["QUEUED", "RUNNING"].includes(revision.status)) awaitedRevision.current = revision.jobId;
        // 只接收这次修改的直接后继版本；有本地编辑或他处新版本时交由用户核对。
        if (
          revision?.jobId === awaitedRevision.current &&
          revision?.status === "READY_FOR_REVIEW" &&
          revision.conversation?.action !== "REPLY" &&
          revision.resultDraftId === draftId &&
          next.draft.currentRevision === (revision.targetRevision ?? 0) + 1 &&
          next.draft.currentRevision !== current.draft.currentRevision &&
          next.publication.revision === current.publication.revision &&
          !hasLocalEdits.current
        ) {
          awaitedRevision.current = null;
          setDetail(next);
          setFields(editableFields(next));
          setTitle(next.draft.title);
          setBody(next.draft.body);
          setNewerDraft(false);
          setReviewed(false);
          setNotice("AI 修改已完成，预览已更新。请查看新文案，再继续配图或审核。");
          return;
        }
        if (next.draft.currentRevision !== current.draft.currentRevision) setNewerDraft(true);
        if (
          next.publication.revision !== current.publication.revision &&
          awaitedPlan.current === next.planningJob?.jobId &&
          next.planningJob?.status === "READY_FOR_REVIEW"
        ) {
          awaitedPlan.current = null;
          setDetail(next);
          setFields(editableFields(next));
          setReviewed(false);
          setNotice("图位、逐图提示与发布说明已保存，请逐张核对并制作图片。");
        } else {
          if (next.publication.revision !== current.publication.revision) setNewerDraft(true);
          setDetail({ ...current, images: next.images, exports: next.exports, planningJob: next.planningJob });
        }
      } catch (error) {
        if (active) setNotice(String(error));
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId, draftId, setReviewed]);

  const textDirty = !!detail && (title !== detail.draft.title || body !== detail.draft.body);
  const layoutDirty = !!detail && !!fields && JSON.stringify(fields) !== JSON.stringify(editableFields(detail));
  const planPending = !!detail?.planningJob && ["QUEUED", "RUNNING"].includes(detail.planningJob.status);
  const revisionPending = !!revisionJob && ["QUEUED", "RUNNING"].includes(revisionJob.status);
  const conversationPending = conversationJobs.some(
    (job) =>
      job.purpose === "PUBLICATION_CHAT" &&
      (["QUEUED", "RUNNING"].includes(job.status) || job.source?.workflow?.state === "RUNNING"),
  );
  const disabled = busy || !writable || planPending || revisionPending || conversationPending || newerDraft;
  hasLocalEdits.current = textDirty || layoutDirty;

  useEffect(() => {
    if (!detail || !fields) return;
    try {
      if (textDirty || layoutDirty)
        sessionStorage.setItem(
          localEditKey,
          JSON.stringify({
            title,
            body,
            fields,
            draftRevision: detail.draft.currentRevision,
            publicationRevision: detail.publication.revision,
          }),
        );
      else sessionStorage.removeItem(localEditKey);
    } catch {
      /* 标签页存储满时继续保留内存编辑，由离开提示保护。 */
    }
  }, [detail, fields, title, body, localEditKey, textDirty, layoutDirty]);

  useEffect(() => {
    if (!textDirty && !layoutDirty) return;
    /** 刷新或关闭页面前提醒保留未保存的编辑。 */
    function warnBeforeLeave(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [textDirty, layoutDirty]);

  /** Agent 先交结构化图位与发布步骤；生成实际像素仍逐张确认费用。 */
  async function planImages(brief = planBrief): Promise<boolean> {
    if (!detail || disabled || textDirty || layoutDirty || !modelConfigured) return false;
    if (
      fields?.images.some((image) => image.artifactId || image.jobId) &&
      !window.confirm("重新规划会替换当前图位与提示，现有图片文件和历史交付保留。继续重新规划？")
    )
      return false;
    const signature = JSON.stringify({
      draftId,
      draftRevision: detail.draft.currentRevision,
      publicationRevision: detail.publication.revision,
      brief,
      imageCount,
    });
    setBusy(true);
    setReviewed(false);
    try {
      const job = await api.planPublication(
        sessionId,
        draftId,
        detail.draft.currentRevision,
        detail.publication.revision,
        brief,
        commandKey(signature),
        imageCount,
      );
      pending.current.delete(signature);
      awaitedPlan.current = job.jobId;
      setDetail({ ...detail, planningJob: job });
      setConversationJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      setStep(3);
      setNotice("Agent 正在按当前正文规划图位与发布说明，这一步不会自动付费生图。");
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 把当前任务实拍图上传为受管素材，之后由用户选择放入具体图位。 */
  async function uploadImage(file: File | undefined) {
    if (!file || disabled || !detail) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setNotice("请选择不超过 8 MB 的 PNG/JPEG/WebP 图片。");
      return;
    }
    setBusy(true);
    try {
      await api.uploadReferenceFile(sessionId, file);
      const next = await api.getPublication(sessionId, draftId);
      setDetail({ ...detail, images: next.images });
      setNotice("实拍图已上传，请在需要的图位选择采用。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 保存用户改稿为新版本，旧交付继续指向旧版本。 */
  async function saveText() {
    if (!detail || disabled || !textDirty) return;
    setBusy(true);
    setReviewed(false);
    try {
      const draft = await api.reviseContentDraft(sessionId, draftId, detail.draft.currentRevision, title, body);
      setDetail({ ...detail, draft });
      setNotice("文案新版本已保存，请复核配图与发布说明。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 保存配图选择、顺序与发布说明，冲突时保留用户输入。 */
  async function saveLayout() {
    if (!detail || !fields || disabled) return;
    setBusy(true);
    setReviewed(false);
    const signature = JSON.stringify({ revision: detail.publication.revision, fields });
    try {
      const publication = await api.savePublication(
        sessionId,
        draftId,
        detail.publication.revision,
        fields,
        commandKey(signature),
      );
      pending.current.delete(signature);
      setDetail({ ...detail, publication });
      setFields({
        instructions: publication.instructions,
        visualStyle: publication.visualStyle,
        images: publication.images,
      });
      setNotice("图片编排与发布说明已保存。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 只更新指定图片位置，其他已完成图片保持不变。 */
  function editImage(slotId: string, change: Partial<PublicationImage>) {
    if (!fields) return;
    setFields({
      ...fields,
      images: fields.images.map((image) => (image.slotId === slotId ? { ...image, ...change } : image)),
    });
    setReviewed(false);
  }

  /** 调整交付图片顺序，第一张始终作为封面。 */
  function moveImage(index: number, direction: number) {
    if (!fields || index + direction < 0 || index + direction >= fields.images.length) return;
    const images = [...fields.images];
    [images[index], images[index + direction]] = [
      images[index + direction] as PublicationImage,
      images[index] as PublicationImage,
    ];
    setFields({ ...fields, images });
    setReviewed(false);
  }

  /** 将已保存的正文与视觉要求绑定到这张图，显式确认后才发起付费任务。 */
  async function generateImage(image: PublicationImage) {
    if (!detail || !fields || disabled || textDirty || layoutDirty || !costConfirmed || !image.prompt.trim()) return;
    const input = {
      prompt: `${fields.visualStyle ? `整套视觉风格：${fields.visualStyle}\n` : ""}${image.prompt}`,
      size: "1024x1536" as const,
      quality: "medium" as const,
      ...(image.artifactId ? { referenceArtifactId: image.artifactId } : {}),
      costConfirmed: true as const,
      publication: {
        draftId,
        draftRevision: detail.draft.currentRevision,
        publicationRevision: detail.publication.revision,
        slotId: image.slotId,
      },
    };
    const signature = JSON.stringify(input);
    setBusy(true);
    setReviewed(false);
    try {
      await api.createImageJob(sessionId, input, commandKey(signature));
      pending.current.delete(signature);
      setCostConfirmed(false);
      const next = await api.getPublication(sessionId, draftId);
      setDetail(next);
      setFields(editableFields(next));
      setNotice("本张图片任务已受理，完成后可预览并选择采用。其他图片保持原样。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 单一对话入口把自然语言交给Host路由，前端不猜测或切换操作模式。 */
  async function sendConversation(message: string): Promise<boolean> {
    if (!detail || disabled || textDirty || layoutDirty || !message.trim() || !modelConfigured) return false;
    const input = {
      message,
      draftId,
      draftRevision: detail.draft.currentRevision,
      publicationRevision: detail.publication.revision,
    };
    const signature = JSON.stringify(input);
    setBusy(true);
    try {
      const job = await api.sendPublicationConversation(sessionId, input, commandKey(signature));
      setConversationJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      pending.current.delete(signature);
      setNotice("正在理解你的要求，随后会自动执行对应操作。需要确认时会在对话中提示。");
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 具体图片确认卡授权后，由Host继续原步骤；页面不另建付费请求。 */
  async function approveConversationImage(job: TextGenerationJobRecord): Promise<void> {
    if (disabled || textDirty || layoutDirty) return;
    setBusy(true);
    try {
      const next = await api.approvePublicationConversationImage(sessionId, job);
      setConversationJobs((current) => [next, ...current.filter((item) => item.jobId !== next.jobId)]);
      setNotice("本次图片费用已确认，Host会继续制作并放入预览。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 最终确认只针对确认卡固定的双版本，防止旧卡打包新稿。 */
  async function confirmConversationExport(job: TextGenerationJobRecord): Promise<void> {
    const flow = job.source?.workflow;
    if (
      !detail ||
      flow?.state !== "WAITING_FINAL_CONFIRMATION" ||
      flow.draftRevision !== detail.draft.currentRevision ||
      flow.publicationRevision !== detail.publication.revision
    ) {
      setNotice("确认卡版本已变化，请读取最新内容后继续。");
      return;
    }
    await exportPackage(true);
  }

  /** 审核专家独立读取已保存快照，覆盖不足或后续改稿会明确显示限制。 */
  async function startReview() {
    if (!detail || disabled || textDirty || layoutDirty) return;
    setBusy(true);
    try {
      const signature = `review:${detail.draft.currentRevision}:${detail.publication.revision}`;
      setReviewJob(
        await api.reviewPublication(
          sessionId,
          draftId,
          detail.draft.currentRevision,
          detail.publication.revision,
          commandKey(signature),
        ),
      );
      setNotice("审核任务已受理，审核角色会检查本版图文并给出意见。人工确认仍由你完成。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  /** 仅刷新已导入的素材列表，不覆盖未保存的文案与图位。 */
  async function refreshMedia() {
    const next = await api.getPublication(sessionId, draftId);
    setDetail((current) => (current ? { ...current, images: next.images } : current));
  }

  /** 整套确认后生成不可变发布包，任何未保存修改都不能混入导出。 */
  async function exportPackage(confirmedByConversation = false) {
    if (!detail || !fields || disabled || textDirty || layoutDirty || (!reviewed && !confirmedByConversation)) return;
    setBusy(true);
    try {
      const result = await api.exportPublication(
        sessionId,
        draftId,
        detail.draft.currentRevision,
        detail.publication.revision,
      );
      setStep(5);
      setDetail({
        ...detail,
        exports: [result, ...detail.exports.filter((item) => item.exportId !== result.exportId)],
      });
      setNotice("图文发布包已生成。包含文案、顺序配图、发布说明与版本清单，可下载交付。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!detail || !fields) return <p role="status">{notice || "正在读取笔记…"}</p>;
  const currentExport = detail.exports.find(
    (item) =>
      item.draftRevision === detail.draft.currentRevision && item.publicationRevision === detail.publication.revision,
  );
  const allImagesSelected = !!fields.images.length && fields.images.every((image) => image.artifactId);
  return (
    <div className="publication-editor">
      {mediaOpen && merchantId && (
        <MediaPicker
          merchantId={merchantId}
          sessionId={sessionId}
          onClose={() => setMediaOpen(false)}
          onImported={refreshMedia}
        />
      )}
      {reconcile && (
        <ImageReconcileModal
          job={reconcile}
          images={detail.images}
          onClose={() => setReconcile(null)}
          onResolved={async () => {
            await refreshMedia();
            setJobs(await api.listGenerationJobs(sessionId));
          }}
        />
      )}
      <nav className="publication-steps" aria-label="图文制作步骤">
        <Link
          to={`/sessions/${sessionId}?studio=1`}
          onClick={(event) => {
            if (textDirty || layoutDirty) {
              event.preventDefault();
              setNotice("请先保存当前修改，再返回选题。");
            }
          }}
        >
          1 选题与要求
        </Link>
        {[
          [2, "文案"],
          [3, "配图"],
          [4, "整套审核"],
          [5, "发布包"],
        ].map(([number, label]) => (
          <button
            type="button"
            key={number}
            className={step === number ? "selected" : ""}
            disabled={number === 5 && !detail.exports.length}
            onClick={() => setStep(Number(number))}
          >
            {number} {label}
          </button>
        ))}
      </nav>
      <div className="studio-status">
        <strong>
          {title} · 文案第{detail.draft.currentRevision}版
        </strong>
        <span>{textDirty || layoutDirty ? "有未保存修改" : currentExport ? "本版已确认交付" : "待整套审核"}</span>
      </div>
      {notice && (
        <p role="status" className="studio-notice">
          {notice}
        </p>
      )}
      {detail.source && (
        <p className="muted">
          来源：{detail.source.profile ? `商家档案第 ${detail.source.profile.revision} 版` : "原会话资料"}
          {detail.source.product
            ? ` · 商品「${detail.source.product.name}」第 ${detail.source.product.revision} 版`
            : ""}
          {detail.source.topic ? ` · 选题第 ${detail.source.topic.revision} 版` : ""}
        </p>
      )}
      {!!detail.draft.internalNotes && (
        <details className="studio-section">
          <summary>内部说明与资料缺口（不进入发布正文）</summary>
          <AssistantMarkdown content={detail.draft.internalNotes} />
        </details>
      )}
      {!writable && <p>会话已归档或回收，当前只可查看及下载历史交付。</p>}
      {newerDraft && <p className="studio-notice">已有新的文案或编排版本。请先保留本地修改，再读取最新版本核对。</p>}
      <button
        type="button"
        className="outline-button"
        disabled={busy}
        onClick={() => {
          if (
            (textDirty || layoutDirty) &&
            !window.confirm("读取最新版本会丢弃这里尚未保存的修改，请先复制需要保留的内容。继续？")
          )
            return;
          void reload().catch((error: unknown) => setNotice(String(error)));
        }}
      >
        读取最新版本
      </button>
      <PublicationPreview
        sessionId={sessionId}
        title={title}
        body={body}
        images={fields.images}
        dirty={textDirty || layoutDirty}
        detail={detail}
        deliveryDisabled={disabled}
        review={reviews.find(
          (item) =>
            item.draftRevision === detail.draft.currentRevision &&
            item.publicationRevision === detail.publication.revision &&
            item.applicability === "CURRENT",
        )}
        onDiscuss={() => {
          const input = conversation.current?.querySelector<HTMLTextAreaElement>("textarea");
          input?.scrollIntoView({ behavior: "auto", block: "center" });
          input?.focus({ preventScroll: true });
        }}
      />
      <div ref={conversation}>
        <ContentConversation
          sessionId={sessionId}
          draftId={draftId}
          jobs={conversationJobs}
          disabled={disabled || textDirty || layoutDirty || !modelConfigured}
          onSend={sendConversation}
          onApproveImage={approveConversationImage}
          onConfirmExport={confirmConversationExport}
          currentReview={reviews.find(
            (review) =>
              review.draftRevision === detail.draft.currentRevision &&
              review.publicationRevision === detail.publication.revision &&
              review.applicability === "CURRENT",
          )}
        />
      </div>
      <section className="studio-section" hidden={step !== 2}>
        <details
          className="studio-manual"
          open={manualTextOpen}
          onToggle={(event) => setManualTextOpen(event.currentTarget.open)}
        >
          <summary>手动编辑标题与正文（可选）</summary>
          <div className="studio-form">
            <label>
              笔记标题
              <input
                value={title}
                maxLength={120}
                disabled={disabled}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setReviewed(false);
                }}
              />
            </label>
            <label>
              正文与话题
              <textarea
                value={body}
                rows={20}
                maxLength={50000}
                disabled={disabled}
                onChange={(event) => {
                  setBody(event.target.value);
                  setReviewed(false);
                }}
              />
            </label>
            <button
              type="button"
              disabled={disabled || !textDirty || !title.trim() || !body.trim()}
              onClick={() => void saveText()}
            >
              保存文案修改
            </button>
          </div>
        </details>
      </section>
      <section className="studio-section" hidden={step !== 3}>
        {merchantId && (
          <button type="button" disabled={disabled} onClick={() => setMediaOpen(true)}>
            从商家素材库选用实拍图
          </button>
        )}
        <h2>配图与顺序</h2>
        <div className="studio-planning">
          <details className="studio-manual">
            <summary>补充配图要求（可选）</summary>
            <label>
              本篇配图数量
              <select
                aria-label="配图规划张数"
                value={imageCount}
                disabled={disabled}
                onChange={(event) => setImageCount(Number(event.target.value))}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((count) => (
                  <option value={count} key={count}>
                    {count}张{count === 1 ? "封面（默认）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              配图与发布的补充要求
              <textarea
                value={planBrief}
                maxLength={2000}
                disabled={disabled}
                onChange={(event) => setPlanBrief(event.target.value)}
                placeholder="例如：实拍为主，封面只放一句话；发布说明中列出需补的门店信息"
              />
            </label>
          </details>
          <button
            type="button"
            className="primary-button"
            disabled={disabled || textDirty || layoutDirty || !modelConfigured || newerDraft}
            onClick={() => void planImages()}
          >
            {planPending
              ? "Agent 正在规划…"
              : fields.images.length
                ? "重新规划图位与发布说明"
                : "AI 规划配图与发布说明"}
          </button>
          {detail.planningJob?.status === "FAILED" && (
            <p role="status">规划未完成：{detail.planningJob.errorCode}。现有编排保留，可核对后重新规划。</p>
          )}
          <label>
            上传实拍素材
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void uploadImage(file);
              }}
            />
          </label>
        </div>
        <p className="muted">第一张为封面；每张图可选现有图片或单独生成、修改。生成前先保存文案和编排。</p>
        <details className="studio-manual">
          <summary>查看或调整整套视觉风格（可选）</summary>
          <label className="studio-field">
            整套视觉风格
            <textarea
              value={fields.visualStyle}
              maxLength={2000}
              disabled={disabled}
              placeholder="例如：自然门店实拍风格，暖色，简洁排版"
              onChange={(event) => {
                setFields({ ...fields, visualStyle: event.target.value });
                setReviewed(false);
              }}
            />
          </label>
        </details>
        {provider === "unconfigured" ? (
          <p className="studio-notice">图片服务未配置，可以选择已上传实拍图完成交付。</p>
        ) : (
          <label>
            <input
              type="checkbox"
              checked={costConfirmed}
              disabled={disabled}
              onChange={(event) => setCostConfirmed(event.target.checked)}
            />
            我确认下一张 AI 生图或改图可能收费，每次提交后需重新确认。
          </label>
        )}
        <div className="studio-image-grid">
          {fields.images.map((image, index) => {
            const selected = detail.images.find((item) => item.artifactId === image.artifactId);
            const job = jobs.find((item) => item.jobId === image.jobId);
            const pendingImage = !!job && ["QUEUED", "RUNNING", "UNKNOWN_EXTERNAL"].includes(job.status);
            return (
              <article className="studio-image" key={image.slotId}>
                <h3>
                  {index + 1}. {index === 0 ? "封面" : "内页"} · {image.title}
                </h3>
                {selected ? (
                  <img src={api.imageArtifactUrl(sessionId, selected.artifactId)} alt={image.title} />
                ) : (
                  <div className="studio-image-empty">待选择配图</div>
                )}
                <button
                  type="button"
                  disabled={
                    disabled ||
                    textDirty ||
                    layoutDirty ||
                    !costConfirmed ||
                    provider === "unconfigured" ||
                    pendingImage ||
                    !image.prompt.trim()
                  }
                  onClick={() => void generateImage(image)}
                >
                  {image.artifactId ? "按要求生成修改图" : "生成本张配图"}
                </button>
                <details className="studio-manual">
                  <summary>更换图片或调整本张方案（可选）</summary>
                  <label>
                    图片用途
                    <input
                      value={image.title}
                      disabled={disabled}
                      maxLength={120}
                      onChange={(event) => editImage(image.slotId, { title: event.target.value })}
                    />
                  </label>
                  <label>
                    采用图片
                    <select
                      value={image.artifactId ?? ""}
                      disabled={disabled}
                      onChange={(event) => editImage(image.slotId, { artifactId: event.target.value || null })}
                    >
                      <option value="">请选择同会话图片</option>
                      {detail.images.map((file) => (
                        <option key={file.artifactId} value={file.artifactId}>
                          {file.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    本张创作或修改要求
                    <textarea
                      value={image.prompt}
                      maxLength={4000}
                      disabled={disabled}
                      onChange={(event) => editImage(image.slotId, { prompt: event.target.value })}
                    />
                  </label>
                  <div className="prompt-actions">
                    <button type="button" disabled={disabled || index === 0} onClick={() => moveImage(index, -1)}>
                      前移
                    </button>
                    <button
                      type="button"
                      disabled={disabled || index === fields.images.length - 1}
                      onClick={() => moveImage(index, 1)}
                    >
                      后移
                    </button>
                    <button
                      type="button"
                      disabled={disabled || pendingImage}
                      onClick={() => {
                        setFields({ ...fields, images: fields.images.filter((item) => item.slotId !== image.slotId) });
                        setReviewed(false);
                      }}
                    >
                      移除此位置
                    </button>
                  </div>
                </details>
                {job && (
                  <p>
                    {imageStatus[job.status]}
                    {job.status === "UNKNOWN_EXTERNAL" && (
                      <button type="button" disabled={!writable} onClick={() => setReconcile(job)}>
                        核对原请求
                      </button>
                    )}
                    {job.errorCode && ` · ${job.errorCode}`}
                  </p>
                )}
                {job?.resultArtifactId && job.resultArtifactId !== image.artifactId && (
                  <div>
                    <img src={api.imageArtifactUrl(sessionId, job.resultArtifactId)} alt={`${image.title}的新候选`} />
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => editImage(image.slotId, { artifactId: job.resultArtifactId })}
                    >
                      采用这张结果图
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
        <button
          type="button"
          disabled={disabled || fields.images.length >= 9}
          onClick={() => {
            setFields({
              ...fields,
              images: [
                ...fields.images,
                {
                  slotId: crypto.randomUUID(),
                  title: `内页${fields.images.length}`,
                  prompt: "承接本篇正文，延续整套视觉风格。",
                  artifactId: null,
                  jobId: null,
                },
              ],
            });
            setReviewed(false);
          }}
        >
          ＋ 添加配图位置（最多9张）
        </button>
      </section>
      {step === 3 && (
        <button
          type="button"
          className="primary-button"
          disabled={disabled || !layoutDirty}
          onClick={() => void saveLayout()}
        >
          保存配图编排
        </button>
      )}
      <section className="studio-section" hidden={step !== 4}>
        <h2>整套审核与发布说明</h2>
        <section className="review-panel">
          <div className="section-heading">
            <h3>稿件审核角色</h3>
            <button
              type="button"
              disabled={
                disabled ||
                textDirty ||
                layoutDirty ||
                !allImagesSelected ||
                !modelConfigured ||
                (!!reviewJob && ["QUEUED", "RUNNING"].includes(reviewJob.status))
              }
              onClick={() => void startReview()}
            >
              提交本版图文审核
            </button>
          </div>
          {reviewJob && (
            <p className="muted">
              {reviewJob.status === "FAILED"
                ? `审核失败：${reviewJob.errorCode}`
                : ["QUEUED", "RUNNING"].includes(reviewJob.status)
                  ? "审核进行中，等待真实结果…"
                  : "审核任务已完成"}
            </p>
          )}
          {!reviews.length && <p className="muted">审核会检查事实、文案、图片和发布说明；图片覆盖不足会明确标记。</p>}
          {reviews.slice(0, 3).map((review) => (
            <article className="review-result" key={review.reviewId}>
              <span className={`tag ${review.verdict === "PASS" ? "green" : "amber"}`}>
                {review.verdict === "PASS"
                  ? "审核通过"
                  : review.verdict === "LIMITED"
                    ? "覆盖有限，需人工补查"
                    : "需要修改"}
              </span>
              <strong>
                {review.draftRevision === detail.draft.currentRevision &&
                review.publicationRevision === detail.publication.revision &&
                review.applicability === "CURRENT"
                  ? "当前版本"
                  : review.applicability === "UNKNOWN"
                    ? "旧审核未绑定要求，需重新核验"
                    : "历史参考，内容、要求或规则变化后须重新审核"}{" "}
                · 文案 v{review.draftRevision} / 编排 v{review.publicationRevision}
              </strong>
              <details>
                <summary>查看审核意见与修改建议</summary>
                <p>{review.summary}</p>
                <PreviousIssueChecks review={review} />
                {review.requirementChecks && (
                  <ul aria-label="逐项要求核验">
                    {review.requirementChecks.map((check) => (
                      <li key={check.requirementId}>
                        {check.status === "MET" ? "已满足" : check.status === "UNMET" ? "未满足" : "待核实"}：
                        {check.explanation}
                        {check.evidenceRefs.length ? (
                          <details>
                            <summary>查看核验依据</summary>
                            <small>{check.evidenceRefs.join("、")}</small>
                          </details>
                        ) : (
                          <small>尚缺证据</small>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <small>
                  实际比较图片 {review.comparedImages}/{review.totalImages} 张
                </small>
                <ul>
                  {review.issues.map((issue) => (
                    <li key={`${review.reviewId}:${issue.target}:${issue.slotId}:${issue.detail}`}>
                      {issue.severity === "BLOCKER" ? "需修正" : issue.severity === "WARNING" ? "请注意" : "建议"}：
                      {issue.detail} {issue.suggestion}
                    </li>
                  ))}
                </ul>
              </details>
            </article>
          ))}
        </section>
        <details className="studio-manual">
          <summary>查看发布步骤与调整说明（可选）</summary>
          <AssistantMarkdown content={fields.instructions || "配图规划后会自动生成发布说明。"} />
          <label className="studio-field">
            发布说明
            <textarea
              value={fields.instructions}
              rows={4}
              maxLength={8000}
              disabled={disabled}
              placeholder="例如：发布时选择哪个门店、需要补充的地址与话题、发布顺序和注意事项"
              onChange={(event) => {
                setFields({ ...fields, instructions: event.target.value });
                setReviewed(false);
              }}
            />
          </label>
          <button type="button" disabled={disabled || !layoutDirty} onClick={() => void saveLayout()}>
            保存配图编排与发布说明
          </button>
        </details>
        <div className="publication-strip">
          {fields.images.map(
            (image, index) =>
              image.artifactId && (
                <figure key={image.slotId}>
                  <img src={api.imageArtifactUrl(sessionId, image.artifactId)} alt={image.title} />
                  <figcaption>
                    {index + 1}. {image.title}
                  </figcaption>
                </figure>
              ),
          )}
        </div>
        <p>交付内容：文案.txt、按顺序命名的配图、发布说明.md、版本清单.json。</p>
        <div className="review-checklist">
          {[
            "商家、商品、价格与供应事实准确",
            "标题、正文、话题与表达已确认",
            "所有图片内容、封面与顺序已核对",
            "发布说明、门店与需补内容已处理",
          ].map((label, index) => (
            <label className="inline-checkbox" key={label}>
              <input
                type="checkbox"
                checked={checks[index] ?? false}
                disabled={disabled || textDirty || layoutDirty || !allImagesSelected || newerDraft}
                onChange={(event) =>
                  setChecks((current) => current.map((value, item) => (item === index ? event.target.checked : value)))
                }
              />
              {label}
            </label>
          ))}
        </div>
        <div className="prompt-actions">
          <button
            type="button"
            className="primary-button"
            disabled={disabled || textDirty || layoutDirty || !allImagesSelected || !reviewed || newerDraft}
            onClick={() => void exportPackage()}
          >
            确认整套并生成发布包
          </button>
          {currentExport && (
            <a className="outline-button" href={api.publicationDownloadUrl(sessionId, currentExport.artifactId)}>
              下载本版图文发布包 ZIP
            </a>
          )}
        </div>
        {(textDirty || layoutDirty) && <p className="muted">请先保存修改，再确认整套图文。</p>}
        {!allImagesSelected && <p className="muted">请为每个位置选择图片，或移除不需要的位置。</p>}
        <details>
          <summary>历史交付 · {detail.exports.length} 版</summary>
          {detail.exports.map((item) => (
            <p key={item.exportId}>
              文案第{item.draftRevision}版 / 编排第{item.publicationRevision}版 ·{" "}
              {new Date(item.createdAt).toLocaleString()}{" "}
              <a href={api.publicationDownloadUrl(sessionId, item.artifactId)}>下载此固定版本</a>
            </p>
          ))}
        </details>
      </section>
      {step === 5 && (
        <section className="studio-section publication-delivery">
          <h2>图文发布包</h2>
          <p>本版交付包含文案.txt、顺序配图、发布说明.md和版本清单.json。</p>
          {currentExport && (
            <a className="primary-button" href={api.publicationDownloadUrl(sessionId, currentExport.artifactId)}>
              下载本版发布包 ZIP
            </a>
          )}
          <h3>你接下来这样做</h3>
          <ol>
            <li>下载并解压发布包，核对文案和全部图片。</li>
            <li>到小红书创建图文，按文件名前缀上传图片，再复制标题、正文和话题。</li>
            <li>核对门店、活动与供应信息，预览后由你在平台发布。</li>
          </ol>
          <AssistantMarkdown content={detail.publication.instructions} />
          <p className="muted">下载不等于平台已发布。后续修改另存新版本，旧交付保持原样。</p>
          <details className="studio-manual">
            <summary>发布后登记链接与反馈（可选）</summary>
            <PublicationRecordForm
              sessionId={sessionId}
              draftId={draftId}
              exports={detail.exports}
              writable={writable}
            />
          </details>
          <h3>历史交付</h3>
          {detail.exports.map((item) => (
            <p key={item.exportId}>
              文案第{item.draftRevision}版 / 编排第{item.publicationRevision}版 ·{" "}
              <a href={api.publicationDownloadUrl(sessionId, item.artifactId)}>下载此固定版本</a>
            </p>
          ))}
        </section>
      )}
      {step < 4 && (
        <div className="studio-step-footer">
          <span>
            {textDirty || layoutDirty
              ? "请先保存修改，再继续"
              : step === 2
                ? "满意就继续，无需手动修改。"
                : "采用配图后，即可进行整套审核。"}
          </span>
          <button
            type="button"
            className="primary-button"
            disabled={disabled || textDirty || layoutDirty || newerDraft || (step === 3 && !allImagesSelected)}
            onClick={() => {
              if (step === 2 && !fields.images.length && modelConfigured) void planImages();
              else setStep(step + 1);
            }}
          >
            {step === 2
              ? !fields.images.length && modelConfigured
                ? "文案满意，AI 继续规划配图"
                : "文案满意，查看配图"
              : "配图完成，整套审核"}
          </button>
        </div>
      )}
    </div>
  );
}

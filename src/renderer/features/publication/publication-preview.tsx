import { useRef, useState } from "react";
import type {
  PublicationDetail,
  PublicationExport,
  PublicationImage,
  PublicationReview,
} from "../../../shared/publication.js";
import * as api from "../../api/client.js";
import { AssistantMarkdown } from "../../components/assistant-markdown.js";
import { Modal } from "../../components/ui.js";

/** 用实际采用的图片与完整正文预览本篇成品，放大时沿用同一顺序。 */
export function PublicationPreview({
  sessionId,
  title,
  body,
  images,
  dirty,
  detail,
  deliveryDisabled = false,
  review,
  onDiscuss,
}: {
  sessionId: string;
  title: string;
  body: string;
  images: PublicationImage[];
  dirty: boolean;
  detail: PublicationDetail;
  deliveryDisabled?: boolean;
  review?: PublicationReview;
  onDiscuss?: () => void;
}) {
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState("");
  const [checkedVersion, setCheckedVersion] = useState("");
  const [exported, setExported] = useState<{ version: string; receipt: PublicationExport } | null>(null);
  const [busy, setBusy] = useState(false);
  const exporting = useRef(false);
  const [feedback, setFeedback] = useState<{ copy: string; message: string; error: boolean } | null>(null);
  const version = `${sessionId}:${detail.draft.draftId}:${detail.draft.currentRevision}:${detail.publication.revision}`;
  const copy = [title, body].filter((text) => text.trim()).join("\n\n");
  const currentExport =
    detail.exports.find(
      (item) =>
        item.draftRevision === detail.draft.currentRevision && item.publicationRevision === detail.publication.revision,
    ) ?? (exported?.version === version ? exported.receipt : undefined);
  const hasAllImages = !!images.length && images.every((image) => image.artifactId);
  const cannotExport = dirty || deliveryDisabled || busy || !hasAllImages;
  const latestPreview = useRef({ version, dirty, deliveryDisabled });
  latestPreview.current = { version, dirty, deliveryDisabled };
  const confirming = confirmVersion === version && !dirty;
  const selected = images.find((item) => item.slotId === selectedSlot) ?? images[0];
  const index = selected ? images.indexOf(selected) : 0;

  /** 复制当前预览的标题与完整正文，失败时保留可手动复制的原文。 */
  async function copyText() {
    try {
      await navigator.clipboard.writeText(copy);
      setFeedback({ copy, message: dirty ? "已复制当前未保存文案。" : "已复制标题和完整正文。", error: false });
    } catch {
      setFeedback({ copy, message: "复制失败，请选择预览中的标题和正文后手动复制。", error: true });
    }
  }

  /** 用户确认当前双版本后沿原 Host 导出，成功回执到达才启动真实 ZIP 下载。 */
  async function downloadPackage() {
    if (cannotExport || checkedVersion !== version || exporting.current) return;
    exporting.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const receipt = await api.exportPublication(
        sessionId,
        detail.draft.draftId,
        detail.draft.currentRevision,
        detail.publication.revision,
      );
      // 回执绑定点击时所见版本；后续改稿不能继续下载旧包冒充当前成果。
      setExported({ version, receipt });
      if (
        latestPreview.current.version !== version ||
        latestPreview.current.dirty ||
        latestPreview.current.deliveryDisabled
      )
        return;
      setConfirmVersion("");
      setCheckedVersion("");
      const link = document.createElement("a");
      link.href = api.publicationDownloadUrl(sessionId, receipt.artifactId);
      link.download = "";
      document.body.append(link);
      link.click();
      link.remove();
      setFeedback({ copy, message: "素材包已生成，已发起 ZIP 下载。", error: false });
    } catch (reason) {
      setFeedback({ copy, message: reason instanceof Error ? reason.message : String(reason), error: true });
    } finally {
      exporting.current = false;
      setBusy(false);
    }
  }

  /** 内嵌与全屏共用交付入口，旧包、未保存内容和缺图均不能替代当前完整版本。 */
  function deliveryActions() {
    return (
      <div className="publication-preview-delivery">
        <div className="prompt-actions">
          <button type="button" className="outline-button" disabled={!copy.trim()} onClick={() => void copyText()}>
            一键拷贝文案
          </button>
          {currentExport && !dirty && !deliveryDisabled ? (
            <a
              className="primary-button"
              href={api.publicationDownloadUrl(sessionId, currentExport.artifactId)}
              download
            >
              下载素材包
            </a>
          ) : (
            <button
              type="button"
              className="primary-button"
              disabled={cannotExport}
              onClick={() => {
                setCheckedVersion("");
                setConfirmVersion(version);
              }}
            >
              {busy ? "正在打包…" : "下载素材包"}
            </button>
          )}
        </div>
        {(!currentExport || dirty || deliveryDisabled) && (
          <p className="muted">
            {dirty
              ? "请先保存修改，再下载当前版本。"
              : !hasAllImages
                ? "配图尚未全部完成并采用，可先拷贝文案。"
                : deliveryDisabled
                  ? "请等待当前任务结束并核对最新版本后下载。"
                  : "素材包包含文案、全部配图、发布说明和版本清单。"}
          </p>
        )}
        {confirming && !currentExport && (
          <section className="content-chat-approval" aria-label="下载素材包前确认">
            <p>
              请确认当前图文：文案第 {detail.draft.currentRevision} 版 / 编排第 {detail.publication.revision} 版。
            </p>
            {review ? (
              <p>{review.verdict === "LIMITED" ? "审核覆盖有限，请人工补查。" : review.summary}</p>
            ) : (
              <p>本版尚无独立审核意见，请人工核对全部内容。</p>
            )}
            {review?.issues.length ? (
              <ul>
                {review.issues.map((issue) => (
                  <li key={`${issue.target}:${issue.slotId}:${issue.detail}`}>{issue.detail}</li>
                ))}
              </ul>
            ) : null}
            <details>
              <summary>核对发布说明</summary>
              <AssistantMarkdown
                content={detail.publication.instructions || "未填写发布说明，请在发布前核对门店和活动信息。"}
              />
            </details>
            <label className="inline-checkbox">
              <input
                type="checkbox"
                checked={checkedVersion === version}
                disabled={cannotExport}
                onChange={(event) => setCheckedVersion(event.target.checked ? version : "")}
              />
              我已核对商家与商品事实、文案、全部配图和发布说明
            </label>
            <div className="prompt-actions">
              <button
                type="button"
                className="primary-button"
                disabled={cannotExport || checkedVersion !== version}
                onClick={() => void downloadPackage()}
              >
                {busy ? "正在打包…" : "确认并下载素材包"}
              </button>
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => {
                  setConfirmVersion("");
                  setCheckedVersion("");
                }}
              >
                暂不下载
              </button>
            </div>
          </section>
        )}
        {feedback?.copy === copy && (
          <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "error" : "muted"}>
            {feedback.message}
          </p>
        )}
      </div>
    );
  }

  /** 内嵌与全屏共用完整图文，缺图显示真实占位，不补造效果图。 */
  function previewContent() {
    return (
      <div className={`publication-preview-content ${images.length ? "with-images" : "text-only"}`}>
        {!!images.length && (
          <div className="publication-preview-gallery">
            {selected?.artifactId ? (
              <img
                className="publication-preview-image"
                src={api.imageArtifactUrl(sessionId, selected.artifactId)}
                alt={`第${index + 1}张：${selected.title}`}
              />
            ) : (
              <div className="publication-preview-empty">
                <strong>{index === 0 ? "封面待制作" : `第${index + 1}张待制作`}</strong>
                <p>{selected?.title}。图片完成并采用后，会显示在这里。</p>
              </div>
            )}
            <p className="publication-preview-caption">{selected?.title}</p>
            <nav className="publication-preview-thumbnails" aria-label="预览图片顺序">
              {images.map((item, position) => (
                <button
                  type="button"
                  key={item.slotId}
                  aria-label={`查看第${position + 1}张：${item.title}`}
                  aria-pressed={selected?.slotId === item.slotId}
                  onClick={() => setSelectedSlot(item.slotId)}
                >
                  {item.artifactId ? (
                    <img src={api.imageArtifactUrl(sessionId, item.artifactId)} alt="" />
                  ) : (
                    <span>待制作</span>
                  )}
                  <small>{position === 0 ? "封面" : position + 1}</small>
                </button>
              ))}
            </nav>
          </div>
        )}
        <article className="publication-preview-copy">
          <p className="page-kicker">
            {images.length ? `图文预览 · 第 ${index + 1} / ${images.length} 张` : "文案预览"}
          </p>
          <h2>{title || "待生成标题"}</h2>
          <AssistantMarkdown content={body || "文案生成后会显示在这里。"} />
          {!images.length && <p className="muted">配图完成后，会在此展示图片与正文的组合。</p>}
        </article>
      </div>
    );
  }

  return (
    <section className="publication-preview" aria-label="发布效果预览">
      <header className="publication-preview-heading">
        <div>
          <h2>发布效果预览</h2>
          <p>
            {dirty
              ? "当前有未保存修改，保存后才能进入审核和交付。"
              : "查看完整标题、正文和采用的图片；平台最终排版以发布页预览为准。"}
          </p>
        </div>
        <div className="prompt-actions">
          {onDiscuss && (
            <button type="button" className="primary-button" onClick={onDiscuss}>
              和 AI 对话
            </button>
          )}
          <button type="button" className="outline-button" onClick={() => setExpanded(true)}>
            全屏查看图文
          </button>
        </div>
      </header>
      {deliveryActions()}
      {previewContent()}
      {expanded && (
        <Modal title="完整图文预览" fullScreen footer={deliveryActions()} onClose={() => setExpanded(false)}>
          {dirty && <p className="studio-notice">这是当前未保存的预览，请先保存再确认交付。</p>}
          {previewContent()}
        </Modal>
      )}
    </section>
  );
}

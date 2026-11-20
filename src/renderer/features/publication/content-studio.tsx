import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { ContentDraftRecord, MerchantCatalogEntry, TextGenerationJobRecord } from "../../../shared/contracts.js";
import type { ResearchReport } from "../../../shared/research.js";
import * as api from "../../api/client.js";
import { TopicPanel } from "../research/topic-panel.js";
import { ContentConversation } from "./content-conversation.js";
import { PublicationEditor } from "./publication-editor.js";

const jobLabels = { QUEUED: "等待执行", RUNNING: "制作中", READY_FOR_REVIEW: "草稿已保存", FAILED: "任务失败" };

/** 将选题、明确主题直创及持久草稿汇入同一会话的图文工作台。 */
export function ContentStudio({
  sessionId,
  merchantId,
  merchantName,
  modelConfigured,
  imageInputEnabled,
  provider,
  writable,
}: {
  sessionId: string;
  merchantId?: string;
  merchantName: string;
  modelConfigured: boolean;
  imageInputEnabled: boolean;
  provider: string;
  writable: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const draftId = query.get("draft");
  const jobId = query.get("job");
  const [drafts, setDrafts] = useState<ContentDraftRecord[]>([]);
  const [jobs, setJobs] = useState<TextGenerationJobRecord[]>([]);
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [products, setProducts] = useState<MerchantCatalogEntry[]>([]);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [productId, setProductId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    /** 读取真实任务与来源，重开后继续既有草稿，避免依赖页面临时进度。 */
    async function refresh() {
      try {
        const [nextDrafts, nextJobs, research, catalog] = await Promise.all([
          api.listContentDrafts(sessionId),
          api.listTextGenerationJobs(sessionId),
          merchantId ? api.getMerchantResearch(merchantId, sessionId) : Promise.resolve(null),
          merchantId ? api.listMerchantCatalog(merchantId) : Promise.resolve([]),
        ]);
        if (!active) return;
        setDrafts(nextDrafts);
        setJobs(nextJobs);
        setReports(research?.reports ?? []);
        setProducts(catalog.filter((item) => item.kind === "PRODUCT" && item.status === "ACTIVE"));
        const selected = nextJobs.find((job) => job.jobId === jobId);
        if (
          selected &&
          ["CONTENT", "PUBLICATION_CHAT"].includes(selected.purpose) &&
          selected.resultDraftId &&
          selected.resultDraftId !== draftId
        )
          navigate(`/sessions/${sessionId}?studio=1&draft=${encodeURIComponent(selected.resultDraftId)}`, {
            replace: true,
          });
      } catch (error) {
        if (active) setNotice(String(error));
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId, merchantId, jobId, draftId, navigate]);

  /** 无稿件时也能从一句话开始，Agent可先讨论选题或创建本次唯一一篇。 */
  async function startConversation(message: string): Promise<boolean> {
    if (!writable || busy || !modelConfigured) return false;
    const input = { message, ...(conversationRootJobId ? { rootJobId: conversationRootJobId } : {}) };
    const signature = JSON.stringify({ sessionId, ...input });
    if (!pending.current.has(signature)) pending.current.set(signature, crypto.randomUUID());
    setBusy(true);
    try {
      const job = await api.sendPublicationConversation(sessionId, input, pending.current.get(signature) as string);
      pending.current.delete(signature);
      setJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      navigate(`/sessions/${sessionId}?studio=1&job=${job.jobId}`);
      return true;
    } catch (error) {
      setNotice(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 明确主题可直接写稿，商品为可选事实来源，响应丢失保留命令键。 */
  async function createDraft() {
    if (!writable || busy || !modelConfigured || !title.trim() || !brief.trim()) return;
    const input = { title: title.trim(), brief: brief.trim(), ...(productId ? { productEntryId: productId } : {}) };
    const signature = JSON.stringify(input);
    if (!pending.current.has(signature)) pending.current.set(signature, crypto.randomUUID());
    setBusy(true);
    try {
      const job = await api.createTextGenerationJob(sessionId, input, pending.current.get(signature));
      pending.current.delete(signature);
      navigate(`/sessions/${sessionId}?studio=1&job=${job.jobId}`);
      setNotice("文案任务已受理。成功后会自动进入这篇图文，继续配图、审核和下载。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 选题创作进入已有任务等待回执，不再次启动另一份文案。 */
  function contentCreated(job: TextGenerationJobRecord) {
    navigate(`/sessions/${sessionId}?studio=1&job=${job.jobId}`);
  }

  const contentJobs = jobs.filter((job) => job.purpose === "CONTENT");
  const conversationRootJobId = jobs.find(
    (job) => job.jobId === jobId && job.purpose === "PUBLICATION_CHAT" && job.source?.taskContext,
  )?.jobId;
  return (
    <section className="content-studio">
      <header className="studio-heading">
        <div>
          <p className="page-kicker">{merchantName || "当前会话"} / 内容任务</p>
          <h1>图文工作台</h1>
        </div>
        <div className="prompt-actions">
          <Link className="outline-button" to={`/sessions/${sessionId}`}>
            回到对话
          </Link>
          {merchantId && (
            <Link className="outline-button" to={`/merchants/${merchantId}?tab=products`}>
              维护商家与商品
            </Link>
          )}
        </div>
      </header>
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      {!!drafts.length && (
        <nav className="studio-draft-tabs" aria-label="本次内容任务">
          <Link className={!draftId ? "selected" : ""} to={`/sessions/${sessionId}?studio=1`}>
            选题 / 新建一篇
          </Link>
          {drafts.map((draft) => (
            <Link
              key={draft.draftId}
              className={draftId === draft.draftId ? "selected" : ""}
              to={`/sessions/${sessionId}?studio=1&draft=${draft.draftId}`}
            >
              {draft.title}
            </Link>
          ))}
        </nav>
      )}
      {draftId ? (
        <PublicationEditor
          key={`${sessionId}:${draftId}`}
          sessionId={sessionId}
          draftId={draftId}
          merchantId={merchantId}
          provider={provider}
          modelConfigured={modelConfigured}
          writable={writable}
        />
      ) : (
        <>
          <div className="studio-overview">
            <strong>选题与要求 → 文案 → 配图 → 整套审核 → 发布包</strong>
            <p>直接在下方说目标，AI会判断该讨论选题、写稿还是制作配图。每次一篇，最后让你确认并下载。</p>
          </div>
          <ContentConversation
            sessionId={sessionId}
            draftId=""
            rootJobId={conversationRootJobId}
            jobs={jobs}
            disabled={
              busy ||
              !writable ||
              !modelConfigured ||
              jobs.some(
                (job) =>
                  job.purpose === "PUBLICATION_CHAT" &&
                  (["QUEUED", "RUNNING"].includes(job.status) || job.source?.workflow?.state === "RUNNING"),
              )
            }
            onSend={startConversation}
          />
          {merchantId && (
            <details className="studio-manual">
              <summary>查看选题卡与来源（可选）</summary>
              <TopicPanel
                key={sessionId}
                merchantId={merchantId}
                sessionId={sessionId}
                reports={reports}
                modelConfigured={modelConfigured}
                imageInputEnabled={imageInputEnabled}
                sessionWritable={writable}
                onContentCreated={contentCreated}
              />
            </details>
          )}
          <details className="studio-section">
            <summary>已有明确主题，直接写文案</summary>
            <div className="studio-form">
              <label>
                本篇标题 / 主题
                <input
                  aria-label="直创主题"
                  value={title}
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                这篇要表达什么
                <textarea
                  aria-label="直创要求"
                  value={brief}
                  maxLength={8000}
                  onChange={(event) => setBrief(event.target.value)}
                  placeholder="说明目标、读者、必要内容与限制。缺少的事实会保留待确认。"
                />
              </label>
              {merchantId && (
                <label>
                  关联商品 / 服务（可选）
                  <select
                    aria-label="直创关联商品"
                    value={productId}
                    onChange={(event) => setProductId(event.target.value)}
                  >
                    <option value="">不限定单个商品</option>
                    {products.map((product) => (
                      <option key={product.entryId} value={product.entryId}>
                        {product.name} · 第{product.revision}版
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="primary-button"
                type="button"
                disabled={busy || !writable || !modelConfigured || !title.trim() || !brief.trim()}
                onClick={() => void createDraft()}
              >
                生成本篇文案
              </button>
            </div>
          </details>
          <section className="studio-section">
            <h2>本次文案任务</h2>
            {!contentJobs.length && <p className="muted">选择选题或填写主题后，任务会保存在这里。</p>}
            {contentJobs.map((job) => (
              <article className="studio-job" key={job.jobId}>
                <strong>{job.title}</strong>
                <span>{jobLabels[job.status]}</span>
                {job.errorCode && <p role="status">{job.errorCode} · 原任务保留，可回对话核对原因后重试。</p>}
                {job.resultDraftId && (
                  <Link to={`/sessions/${sessionId}?studio=1&draft=${job.resultDraftId}`}>继续这篇图文 →</Link>
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </section>
  );
}

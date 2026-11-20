import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  ContentDraftRecord,
  ContentRevisionRecord,
  MerchantCatalogEntry,
  MessageRecord,
  TextGenerationJobRecord,
} from "../../../shared/contracts.js";
import * as api from "../../api/client.js";

/** 在会话里把成功回复显式保存为素材草稿，并提供修订、审核和下载。 */
export function ContentDraftPanel({
  sessionId,
  messages,
  merchantId,
  modelConfigured,
  defaultOpen = false,
}: {
  sessionId: string;
  messages: MessageRecord[];
  merchantId: string | null;
  modelConfigured: boolean;
  defaultOpen?: boolean;
}) {
  const [searchParams] = useSearchParams();
  const requestedDraft = searchParams.get("draft");
  const [drafts, setDrafts] = useState<ContentDraftRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [revisions, setRevisions] = useState<ContentRevisionRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [revisionBrief, setRevisionBrief] = useState("");
  const [productEntryId, setProductEntryId] = useState("");
  const [products, setProducts] = useState<MerchantCatalogEntry[]>([]);
  const [jobs, setJobs] = useState<TextGenerationJobRecord[]>([]);
  const selected = drafts.find((item) => item.draftId === selectedId);
  const replies = messages.filter((item) => item.role === "assistant" && item.content.trim());

  useEffect(() => {
    let active = true;
    setDrafts([]);
    setSelectedId("");
    setSourceId("");
    setTitle("");
    setBody("");
    setRevisions([]);
    void api.listContentDrafts(sessionId).then(
      (items) => {
        if (active) setDrafts(items);
      },
      (error: unknown) => {
        if (active) setNotice(String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    setJobs([]);
    setProducts([]);
    setProductEntryId("");
    /** 从 Host 重读任务与草稿，恢复页面刷新前的生成进度。 */
    async function refresh() {
      try {
        const [nextJobs, nextDrafts] = await Promise.all([
          api.listTextGenerationJobs(sessionId),
          api.listContentDrafts(sessionId),
        ]);
        if (active) {
          setJobs(nextJobs.filter((job) => !["TOPIC_PLAN", "RESEARCH", "RESEARCH_CONTINUATION"].includes(job.purpose)));
          setDrafts(nextDrafts);
        }
      } catch (error) {
        if (active) setNotice(error instanceof Error ? error.message : String(error));
      }
    }
    void refresh();
    if (merchantId)
      void api
        .listMerchantCatalog(merchantId)
        .then((items) => {
          if (active) setProducts(items.filter((item) => item.kind === "PRODUCT" && item.status === "ACTIVE"));
        })
        .catch((error: unknown) => {
          if (active) setNotice(String(error));
        });
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId, merchantId]);

  useEffect(() => {
    if (!requestedDraft) return;
    let active = true;
    void api
      .getContentDraft(sessionId, requestedDraft)
      .then((detail) => {
        if (!active) return;
        setSelectedId(detail.draft.draftId);
        setTitle(detail.draft.title);
        setBody(detail.draft.body);
        setRevisions(detail.revisions);
      })
      .catch((error: unknown) => {
        if (active) setNotice(String(error));
      });
    return () => {
      active = false;
    };
  }, [sessionId, requestedDraft]);

  /** 从结构化简报启动可恢复文案任务，商品宣传自动使用固定模板。 */
  async function createTask() {
    if (busy || !taskTitle.trim() || !brief.trim() || !modelConfigured) return;
    setBusy(true);
    setNotice("");
    try {
      const created = await api.createTextGenerationJob(sessionId, {
        title: taskTitle.trim(),
        brief: brief.trim(),
        ...(productEntryId ? { productEntryId } : {}),
      });
      setJobs((current) => [created, ...current.filter((item) => item.jobId !== created.jobId)]);
      setNotice("文案任务已受理。Agent 完成后会自动保存为可修订草稿。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 请求 Agent 基于当前冻结版本追加一版文案，旧版本继续保留。 */
  async function createRevisionTask() {
    if (!selected || busy || !revisionBrief.trim() || !modelConfigured) return;
    setBusy(true);
    setNotice("");
    try {
      const created = await api.createTextGenerationJob(sessionId, {
        title: selected.title,
        brief: revisionBrief.trim(),
        targetDraftId: selected.draftId,
        expectedRevision: selected.currentRevision,
      });
      setJobs((current) => [created, ...current.filter((item) => item.jobId !== created.jobId)]);
      setNotice("修改任务已受理，完成后会追加新版本。当前稿与已审核版保留。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 重读草稿和版本，确保审核按钮始终使用 Host 保存的当前版本。 */
  async function openDraft(draftId: string) {
    const detail = await api.getContentDraft(sessionId, draftId);
    setRevisionBrief("");
    setSelectedId(draftId);
    setTitle(detail.draft.title);
    setBody(detail.draft.body);
    setRevisions(detail.revisions);
    setDrafts((current) => current.map((item) => (item.draftId === draftId ? detail.draft : item)));
  }

  /** 把一条用户选择的助手回复保存为独立素材草稿。 */
  async function createDraft() {
    const reply = replies.find((item) => item.messageId === sourceId);
    if (!reply || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const suggestedTitle =
        reply.content
          .split("\n")
          .find((line) => line.trim())
          ?.replace(/^#+\s*/, "")
          .slice(0, 80) || "素材草稿";
      const created = await api.createContentDraft(sessionId, reply.messageId, suggestedTitle);
      setDrafts(await api.listContentDrafts(sessionId));
      await openDraft(created.draftId);
      setNotice("已保存为素材草稿，可修订后审核。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 追加新修订，不覆盖已审核版本。 */
  async function saveRevision() {
    if (!selected || busy) return;
    setBusy(true);
    setNotice("");
    try {
      await api.reviseContentDraft(sessionId, selected.draftId, selected.currentRevision, title, body);
      setDrafts(await api.listContentDrafts(sessionId));
      await openDraft(selected.draftId);
      setNotice("已保存新版本。旧版本仍可查看。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 由用户显式批准当前版本后请求正式 Markdown 文件。 */
  async function approve() {
    if (!selected || busy) return;
    setBusy(true);
    setNotice("");
    try {
      await api.approveContentDraft(sessionId, selected.draftId, selected.currentRevision);
      setDrafts(await api.listContentDrafts(sessionId));
      await openDraft(selected.draftId);
      setNotice("当前版本已审核，正式文件可以下载。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="content-draft-panel" open={defaultOpen || !!requestedDraft}>
      <summary>素材草稿与审核 · {drafts.length} 份</summary>
      <p className="muted">
        可直接创建文案任务，也可从已完成的回复建立草稿。修改会追加版本，审核后才生成正式下载文件。
      </p>
      {notice && <p role="status">{notice}</p>}
      <div className="content-draft-editor">
        <label>
          素材标题
          <input value={taskTitle} maxLength={120} onChange={(event) => setTaskTitle(event.target.value)} />
        </label>
        <label>
          创作目标
          <textarea value={brief} rows={3} maxLength={8000} onChange={(event) => setBrief(event.target.value)} />
        </label>
        {merchantId && (
          <select
            aria-label="选择商品模板"
            value={productEntryId}
            onChange={(event) => setProductEntryId(event.target.value)}
          >
            <option value="">不选商品 · 自由创作</option>
            {products.map((item) => (
              <option key={item.entryId} value={item.entryId}>
                {item.name} · 商品宣传模板
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          disabled={busy || !modelConfigured || !taskTitle.trim() || !brief.trim()}
          onClick={() => void createTask()}
        >
          创建文案任务
        </button>
        {!modelConfigured && <span className="muted">请先配置文本模型。</span>}
      </div>
      {jobs.length > 0 && (
        <div className="content-draft-editor">
          {jobs.map((job) => (
            <p key={job.jobId}>
              <strong>{job.title}</strong> · {job.intent === "MODIFY" ? "AI 修改" : "新建文案"} ·{" "}
              {job.status === "READY_FOR_REVIEW"
                ? "草稿待审核"
                : job.status === "RUNNING"
                  ? "Agent 创作中"
                  : job.status === "QUEUED"
                    ? "排队中"
                    : "失败"}
              {job.source?.topic && ` · 来源选题：${job.source.topic.title} 第 ${job.source.topic.revision} 版`}
              {job.templateId && ` · ${job.templateId} ${job.templateVersion}`}
              {job.errorCode && ` · ${job.errorCode}`}
              {job.resultDraftId && (
                <button type="button" onClick={() => void openDraft(job.resultDraftId as string)}>
                  打开草稿
                </button>
              )}
            </p>
          ))}
        </div>
      )}
      <div className="content-draft-actions">
        <select aria-label="选择助手回复" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
          <option value="">选择要保存的助手回复</option>
          {replies.map((reply) => (
            <option key={reply.messageId} value={reply.messageId}>
              {reply.content.replace(/\s+/g, " ").slice(0, 70)}
            </option>
          ))}
        </select>
        <button type="button" disabled={!sourceId || busy} onClick={() => void createDraft()}>
          保存为素材草稿
        </button>
      </div>
      <div className="content-draft-actions">
        <select
          aria-label="选择素材草稿"
          value={selectedId}
          onChange={(event) => {
            if (event.target.value) void openDraft(event.target.value);
            else setSelectedId("");
          }}
        >
          <option value="">选择已保存草稿</option>
          {drafts.map((draft) => (
            <option key={draft.draftId} value={draft.draftId}>
              {draft.title} · 第 {draft.currentRevision} 版
            </option>
          ))}
        </select>
      </div>
      {selected && (
        <div className="content-draft-editor">
          <label>
            标题
            <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            正文
            <textarea value={body} rows={10} maxLength={50000} onChange={(event) => setBody(event.target.value)} />
          </label>
          <div className="content-draft-actions">
            <button type="button" disabled={busy || !title.trim() || !body.trim()} onClick={() => void saveRevision()}>
              保存新版本
            </button>
            <button
              type="button"
              disabled={busy || !!selected.artifactId || title !== selected.title || body !== selected.body}
              onClick={() => void approve()}
            >
              审核当前版
            </button>
            {selected.artifactId && (
              <a href={api.contentArtifactDownloadUrl(sessionId, selected.artifactId)}>下载当前版 Markdown</a>
            )}
          </div>
          <label>
            让 Agent 修改当前版
            <textarea
              value={revisionBrief}
              rows={2}
              maxLength={8000}
              onChange={(event) => setRevisionBrief(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={
              busy || !modelConfigured || !revisionBrief.trim() || title !== selected.title || body !== selected.body
            }
            onClick={() => void createRevisionTask()}
          >
            生成新修订版
          </button>
          <details>
            <summary>版本历史 · {revisions.length} 版</summary>
            {revisions.map((revision) => (
              <div key={revision.revision} className="content-revision">
                <strong>
                  第 {revision.revision} 版 · {revision.author === "AGENT" ? "助手初稿" : "用户修订"}
                </strong>
                {revision.artifactId && (
                  <a href={api.contentArtifactDownloadUrl(sessionId, revision.artifactId)}>下载已审核版本</a>
                )}
                <pre>
                  {revision.title}
                  {"\n\n"}
                  {revision.body}
                </pre>
              </div>
            ))}
          </details>
        </div>
      )}
    </details>
  );
}

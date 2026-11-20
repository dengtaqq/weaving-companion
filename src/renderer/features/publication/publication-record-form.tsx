import { useEffect, useRef, useState } from "react";
import type { PublicationExport } from "../../../shared/publication.js";
import type { PublicationRecordLink } from "../../../shared/workbench.js";
import * as api from "../../api/client.js";
/** 发布完成后人工登记链接与反馈；保留所采用发布包，不把下载算作平台发布。 */
export function PublicationRecordForm({
  sessionId,
  draftId,
  exports,
  writable,
}: {
  sessionId: string;
  draftId: string;
  exports: PublicationExport[];
  writable: boolean;
}) {
  const [record, setRecord] = useState<PublicationRecordLink | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [artifactId, setArtifactId] = useState(exports[0]?.artifactId ?? "");
  const [url, setUrl] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [metrics, setMetrics] = useState({ likes: "", favorites: "", comments: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(new Map<string, string>());
  useEffect(() => {
    let active = true;
    void api
      .getPublicationRecord(sessionId, draftId)
      .then((value) => {
        if (!active) return;
        setRecord(value);
        if (value) {
          setArtifactId(value.artifactId);
          setUrl(value.url);
          setDate(value.publishedAt.slice(0, 10));
          setNote(value.note);
          setMetrics({
            likes: value.metrics.likes?.toString() ?? "",
            favorites: value.metrics.favorites?.toString() ?? "",
            comments: value.metrics.comments?.toString() ?? "",
          });
        }
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) setNotice(String(error));
      });
    return () => {
      active = false;
    };
  }, [sessionId, draftId]);
  /** 回执不明重试同一记录，反馈数字为空时保留未提供。 */
  async function save() {
    if (busy || !loaded) return;
    setBusy(true);
    try {
      const input = {
        artifactId,
        url,
        publishedAt: `${date}T12:00:00+08:00`,
        note,
        metrics: {
          likes: metrics.likes ? Number(metrics.likes) : null,
          favorites: metrics.favorites ? Number(metrics.favorites) : null,
          comments: metrics.comments ? Number(metrics.comments) : null,
        },
      };
      const signature = JSON.stringify({ input, revision: record?.revision ?? 0 });
      if (!pending.current.has(signature)) pending.current.set(signature, crypto.randomUUID());
      setRecord(
        await api.savePublicationRecord(
          sessionId,
          draftId,
          input,
          record?.revision ?? 0,
          pending.current.get(signature) as string,
        ),
      );
      setNotice("人工发布记录已保存，可在仪表盘的笔记反馈中继续维护。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="publication-record">
      <h3>发布登记与反馈</h3>
      <p className="muted">在小红书完成发布后，填入实际链接。这里记录你提供的信息，不会自动读取平台数据。</p>
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      <div className="form-stack">
        <label>
          实际发布的版本
          <select
            value={artifactId}
            disabled={!writable || busy}
            onChange={(event) => setArtifactId(event.target.value)}
          >
            {exports.map((item) => (
              <option key={item.exportId} value={item.artifactId}>
                文案 v{item.draftRevision} / 编排 v{item.publicationRevision}
              </option>
            ))}
          </select>
        </label>
        <label>
          已发布笔记链接
          <input
            type="url"
            placeholder="https://"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={!writable || busy}
          />
        </label>
        <label>
          发布日期
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            disabled={!writable || busy}
          />
        </label>
        <div className="form-grid">
          {[
            ["likes", "点赞"],
            ["favorites", "收藏"],
            ["comments", "评论"],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min="0"
                step="1"
                value={metrics[key as keyof typeof metrics]}
                disabled={!writable || busy}
                onChange={(event) => setMetrics({ ...metrics, [key as string]: event.target.value })}
              />
            </label>
          ))}
        </div>
        <label>
          反馈与下次调整
          <textarea
            rows={3}
            value={note}
            maxLength={2000}
            disabled={!writable || busy}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        className="primary-button"
        disabled={!loaded || !writable || busy || !url.trim() || !artifactId || !date}
        onClick={() => void save()}
      >
        保存人工发布记录
      </button>
    </section>
  );
}

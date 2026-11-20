import { useEffect, useState } from "react";
import type { ArtifactRecord, GenerationJobRecord } from "../../../shared/contracts.js";
import * as api from "../../api/client.js";

const STATUS_LABEL: Record<GenerationJobRecord["status"], string> = {
  QUEUED: "排队中",
  RUNNING: "生成中",
  READY_FOR_REVIEW: "待查看",
  UNKNOWN_EXTERNAL: "结果未知，需人工对账",
  FAILED: "失败",
};
const SIZE_LABEL: Record<GenerationJobRecord["size"], string> = {
  "1024x1024": "方形 1:1",
  "1536x1024": "横版 3:2",
  "1024x1536": "竖版 2:3",
};
const QUALITY_LABEL: Record<GenerationJobRecord["quality"], string> = {
  low: "标准",
  medium: "高清",
  high: "超清",
};

/** 在会话中创建真实图片任务，并基于上传图或既有生成图继续文字改图。 */
export function ImageGenerationPanel({
  sessionId,
  uploads,
  provider,
  defaultOpen = false,
}: {
  sessionId: string;
  uploads: ArtifactRecord[];
  provider: string;
  defaultOpen?: boolean;
}) {
  const [jobs, setJobs] = useState<GenerationJobRecord[]>([]);
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<GenerationJobRecord["size"]>("1024x1024");
  const [quality, setQuality] = useState<GenerationJobRecord["quality"]>("medium");
  const [referenceId, setReferenceId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const images = [
    ...uploads.filter(
      (item) => item.kind === "upload" && item.mimeType.startsWith("image/") && item.sizeBytes <= 8 * 1024 * 1024,
    ),
    ...jobs
      .filter((item) => item.resultArtifactId)
      .map((item) => ({
        artifactId: item.resultArtifactId as string,
        title: `生成图片 ${item.jobId.slice(-8)}`,
      })),
  ];

  useEffect(() => {
    let active = true;
    setJobs([]);
    setReferenceId("");
    /** 定时读取持久状态，刷新后仍能看到任务和结果。 */
    async function refresh() {
      try {
        const result = await api.listGenerationJobs(sessionId);
        if (active) setJobs(result);
      } catch (error) {
        if (active) setNotice(error instanceof Error ? error.message : String(error));
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  /** 用户每次提交均需确认供应商可能收费，编辑不会覆盖原图。 */
  async function submit() {
    if (busy || !prompt.trim() || !confirmed || provider === "unconfigured") return;
    setBusy(true);
    setNotice("");
    try {
      const result = await api.createImageJob(sessionId, {
        prompt: prompt.trim(),
        size,
        quality,
        ...(referenceId ? { referenceArtifactId: referenceId } : {}),
        costConfirmed: true,
      });
      setJobs((current) => [result, ...current.filter((item) => item.jobId !== result.jobId)]);
      setConfirmed(false);
      setNotice("任务已受理。图片生成完成后会出现在下方；结果未知时不会自动重新收费。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="content-draft-panel image-generation-panel" open={defaultOpen}>
      <summary>AI 生图与改图 · {jobs.length} 个任务</summary>
      {provider === "unconfigured" ? (
        <p className="muted">图片服务尚未配置。请在 Host 设置 ZHIBAN_SEEDREAM_API_KEY 或 ARK_API_KEY 后重启。</p>
      ) : (
        <>
          <p className="muted">
            使用 {provider}
            。不选参考图即文生图；选择已有图片则按文字指令生成新版本，原图保留。尺寸和清晰度共同决定实际输出像素。
          </p>
          <label>
            图片描述或修改要求
            <textarea value={prompt} rows={3} maxLength={8000} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <div className="content-draft-actions">
            <select
              aria-label="选择参考图"
              value={referenceId}
              onChange={(event) => setReferenceId(event.target.value)}
            >
              <option value="">不选参考图 · 生成新图片</option>
              {images.map((item) => (
                <option key={item.artifactId} value={item.artifactId}>
                  {item.title}
                </option>
              ))}
            </select>
            <select
              aria-label="图片尺寸"
              value={size}
              onChange={(event) => setSize(event.target.value as GenerationJobRecord["size"])}
            >
              <option value="1024x1024">方形 1:1</option>
              <option value="1536x1024">横版 3:2</option>
              <option value="1024x1536">竖版 2:3</option>
            </select>
            <select
              aria-label="图片清晰度"
              value={quality}
              onChange={(event) => setQuality(event.target.value as GenerationJobRecord["quality"])}
            >
              <option value="low">标准</option>
              <option value="medium">高清</option>
              <option value="high">超清</option>
            </select>
          </div>
          <label>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{" "}
            我确认提交本次可能收费的图片请求；实际费用以 Provider 账单为准。
          </label>
          <button type="button" disabled={busy || !prompt.trim() || !confirmed} onClick={() => void submit()}>
            {referenceId ? "生成修改版" : "生成图片"}
          </button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {jobs.map((job) => (
        <article className="image-generation-job" key={job.jobId}>
          <strong>
            {job.intent === "MODIFY" ? "图片修改" : "图片生成"} · {STATUS_LABEL[job.status]}
          </strong>
          <p>{job.prompt}</p>
          <small>
            {job.modelId} · {SIZE_LABEL[job.size]} · {QUALITY_LABEL[job.quality]} ·{" "}
            {new Date(job.createdAt).toLocaleString()}
          </small>
          {job.errorCode && <p className="muted">{job.errorCode}</p>}
          {job.resultArtifactId && (
            <div>
              <img
                src={api.imageArtifactUrl(sessionId, job.resultArtifactId)}
                alt={job.prompt.slice(0, 60)}
                loading="lazy"
              />
              <div className="content-draft-actions">
                <a
                  href={api.imageArtifactUrl(sessionId, job.resultArtifactId)}
                  download={`生成图片-${job.jobId.slice(-8)}.png`}
                >
                  下载图片
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setReferenceId(job.resultArtifactId ?? "");
                    setConfirmed(false);
                  }}
                >
                  基于此图修改
                </button>
              </div>
            </div>
          )}
        </article>
      ))}
    </details>
  );
}

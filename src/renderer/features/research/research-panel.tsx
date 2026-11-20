import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ContentAnalysis,
  normalizedResearchTitle,
  type ResearchAdoptInput,
  type ResearchBatch,
  type ResearchCandidate,
  type ResearchLibraryItem,
  type ResearchReport,
  type ResearchScope,
} from "../../../shared/research.js";
import * as api from "../../api/client.js";
import { AssistantMarkdown } from "../../components/assistant-markdown.js";
import { TopicPanel } from "./topic-panel.js";

const kindLabels = { KEYWORD: "关键词", TREND: "近期话题", COMPETITOR_DIFFERENCE: "竞品内容差异" };
const analysisLabels: Record<ContentAnalysis["status"], string> = {
  QUEUED: "等待研究",
  COLLECTING: "采集中",
  ANALYZING: "整理证据中",
  READY: "可用于选题",
  PARTIAL: "部分结果，需复核缺口",
  WAITING_INPUT: "缺少可用候选",
  FAILED: "研究失败",
  CANCELLED: "已取消",
};
const attemptLabels = { ...analysisLabels, INTERRUPTED: "执行中断，保留历史" };

/** 展示 Host 自动保存的固定模板报告，复制与下载仍保留候选身份。 */
function ResearchReportView({ report }: { report: ResearchReport }) {
  const [notice, setNotice] = useState("");
  /** 复制报告正文；剪贴板失败时保留下载入口并明确提示。 */
  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report.markdown);
      setNotice("已复制研究报告，候选仍需编辑采用。");
    } catch {
      setNotice("当前浏览器未允许复制，可下载 Markdown 报告。");
    }
  }
  return (
    <details className="research-batch" open>
      <summary>
        {report.title} · 固定模板 v{report.templateVersion}
      </summary>
      <p className="muted">每轮成功研究自动形成一份报告。当前执行状态：{report.sourceRunStatus}；候选尚需用户采用。</p>
      {report.stale && <p className="muted">商家资料或所选来源已变化，本报告保留原版本，使用前请复核。</p>}
      <div className="prompt-actions">
        <button type="button" onClick={() => void copyReport()}>
          复制报告
        </button>
        <a href={api.researchReportDownloadUrl(report.merchantId, report.reportId)} download>
          下载 Markdown 报告
        </a>
      </div>
      {notice && <p role="status">{notice}</p>}
      <div className="research-report-preview">
        <AssistantMarkdown content={report.markdown} />
      </div>
    </details>
  );
}

/** 按候选类型展示可核对的研究结论，优先级与有效窗口均不冒充平台指标。 */
function CandidateDetails({ candidate }: { candidate: ResearchCandidate }) {
  if (candidate.kind === "KEYWORD")
    return (
      <p>
        {candidate.details.category} ·{" "}
        {{ AWARENESS: "认知", COMPARISON: "比较", ACTION: "行动" }[candidate.details.intent]}意图 ·{" "}
        {candidate.details.priority} 定性优先级；搜索量未知
      </p>
    );
  if (candidate.kind === "TREND")
    return (
      <p>
        样本发布时间：
        {candidate.details.publishedAt ? new Date(candidate.details.publishedAt).toLocaleString() : "未知"}
        ；建议有效至：
        {candidate.details.validUntil ? new Date(candidate.details.validUntil).toLocaleString() : "未确定"}（建议窗口）
      </p>
    );
  return (
    <p>
      比较维度：{candidate.details.dimension}。{candidate.details.observation}；本方{" "}
      {candidate.details.ownEvidenceIds.length} 项证据，对方 {candidate.details.competitorEvidenceIds.length} 项证据。
    </p>
  );
}

/** 展示商家研究候选、编辑采用和版本库；商家页与会话页读取相同持久数据。 */
export function ResearchPanel({
  merchantId,
  sessionId,
  refreshKey,
  onRetry,
  retryDisabled = false,
  researchScope,
  modelConfigured = false,
  imageInputEnabled = false,
  sessionWritable = false,
  defaultOpen = false,
}: {
  merchantId: string;
  sessionId?: string;
  refreshKey?: string;
  /** 由会话页新发用户消息开始一次研究，旧失败证据继续保留。 */
  onRetry?: () => Promise<void>;
  retryDisabled?: boolean;
  researchScope?: ResearchScope;
  modelConfigured?: boolean;
  imageInputEnabled?: boolean;
  sessionWritable?: boolean;
  defaultOpen?: boolean;
}) {
  const [batches, setBatches] = useState<ResearchBatch[]>([]);
  const [library, setLibrary] = useState<ResearchLibraryItem[]>([]);
  const [analyses, setAnalyses] = useState<ContentAnalysis[]>([]);
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [selected, setSelected] = useState<{ batchId: string; index: number } | null>(null);
  const [title, setTitle] = useState("");
  const [relevance, setRelevance] = useState("");
  const [angle, setAngle] = useState("");
  const [allowStale, setAllowStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const scopeKey = `${merchantId}:${sessionId ?? ""}`;
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;

  useEffect(() => {
    // Run 状态变化时重新读取持久结果；刷新键只负责触发这一读取。
    void refreshKey;
    let active = true;
    void api.getMerchantResearch(merchantId, sessionId).then(
      (result) => {
        if (!active) return;
        setBatches(result.batches);
        setLibrary(result.library);
        setAnalyses(result.analyses);
        setReports(result.reports);
      },
      (error: unknown) => {
        if (active) setNotice(String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [merchantId, sessionId, refreshKey]);

  /** 刷新后台已经提交的候选与采用状态，不把本地编辑当作保存成功。 */
  async function refresh() {
    const result = await api.getMerchantResearch(merchantId, sessionId);
    if (activeScope.current !== scopeKey) return;
    setBatches(result.batches);
    setLibrary(result.library);
    setAnalyses(result.analyses);
    setReports(result.reports);
  }

  /** 把选择的候选填入采用编辑框；证据和原研究正文保持不可变。 */
  function editCandidate(batch: ResearchBatch, index: number) {
    const candidate = batch.candidates[index];
    if (!candidate) return;
    setSelected({ batchId: batch.batchId, index });
    setTitle(candidate.title);
    setRelevance(candidate.merchantRelevance);
    setAngle(candidate.contentAngle);
    setAllowStale(false);
    setNotice("");
  }

  const batch = batches.find((item) => item.batchId === selected?.batchId);
  const candidate = selected ? batch?.candidates[selected.index] : null;
  const duplicate = candidate
    ? library.find(
        (item) =>
          item.candidate.kind === candidate.kind &&
          normalizedResearchTitle(item.candidate.title) === normalizedResearchTitle(title),
      )
    : null;

  /** 用户明确采用编辑内容；同类同名时携带已有版本，响应丢失可沿原幂等键重试。 */
  async function adopt() {
    if (busy || !batch || !candidate || !selected) return;
    const input: ResearchAdoptInput = {
      candidateIndex: selected.index,
      title,
      merchantRelevance: relevance,
      contentAngle: angle,
      targetItemId: duplicate?.itemId ?? null,
      expectedRevision: duplicate?.revision ?? null,
      allowStale,
    };
    const signature = JSON.stringify({ batchId: batch.batchId, input });
    if (pending.current?.signature !== signature) pending.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setNotice("");
    try {
      await api.adoptResearchCandidate(merchantId, batch.batchId, input, pending.current.key);
      await refresh();
      if (activeScope.current === scopeKey) {
        setSelected(null);
        setNotice("已保存到当前商家研究库；后续新会话可读取，仍保留研究建议身份。");
      }
    } catch (error) {
      if (activeScope.current === scopeKey) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (activeScope.current === scopeKey) setBusy(false);
    }
  }

  /** 停用后不再进入后续 Run，已经冻结的旧版本继续可读。 */
  async function deactivate(item: ResearchLibraryItem) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await api.deactivateResearchItem(merchantId, item.itemId, item.revision);
      await refresh();
    } catch (error) {
      if (activeScope.current === scopeKey) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (activeScope.current === scopeKey) setBusy(false);
    }
  }

  return (
    <details className="research-panel" open={defaultOpen || !!researchScope}>
      <summary>
        商家研究 · {batches.length} 次结果 · {library.filter((item) => item.status === "ACTIVE").length} 条采用建议
      </summary>
      <p className="muted">
        候选围绕本商家业务产生。采用后保留研究来源和版本，不修改人工确认的商家档案。忽略的候选可留在原结果中。
      </p>
      {researchScope && (
        <p>
          本次重点：{researchScope.focus || "商家整体内容机会"}；观察最近 {researchScope.windowDays} 天，
          {researchScope.productId ? "聚焦已选商品/服务" : "面向商家整体业务"}。
        </p>
      )}
      <div className="prompt-actions">
        <button type="button" onClick={() => void refresh().catch((error: unknown) => setNotice(String(error)))}>
          刷新研究结果
        </button>
        {onRetry && (
          <button
            type="button"
            disabled={busy || retryDisabled}
            onClick={() => void onRetry().catch((error: unknown) => setNotice(String(error)))}
          >
            重新研究
          </button>
        )}
      </div>
      {onRetry && <p className="muted">重新研究会开启新一轮采集；原来的失败记录保留，已保存的证据不会被覆盖。</p>}
      {notice && <p role="status">{notice}</p>}
      {reports.map((report) => (
        <ResearchReportView key={report.reportId} report={report} />
      ))}
      {analyses.map((analysis) => (
        <details key={analysis.analysisId} className="research-batch">
          <summary>
            内容分析 · {analysisLabels[analysis.status]} · {analysis.attempts.length} 次尝试
          </summary>
          <p>研究重点：{analysis.scope.focus || "商家整体内容机会"}。研究结果不等于已确认商家事实。</p>
          {analysis.latestReadyReportId && analysis.status !== "READY" && (
            <p className="muted">之前可用的研究总结仍保留；本轮状态不会覆盖它。</p>
          )}
          {analysis.attempts.map((attempt) => (
            <div key={`${attempt.runId}:${attempt.runAttempt}`}>
              <p>
                执行 {attempt.runAttempt} · {attemptLabels[attempt.status]} ·{" "}
                {new Date(attempt.startedAt).toLocaleString()}
              </p>
              {attempt.gaps.length > 0 && <p>来源缺口：{attempt.gaps.join("；")}</p>}
              {attempt.errorCode && <p>失败原因：{attempt.errorCode}</p>}
              {attempt.reportId && <p className="muted">本次固定模板报告已保留，可在上方查看与下载。</p>}
            </div>
          ))}
        </details>
      ))}
      {!batches.length && <p className="muted">暂无已保存候选。研究完成后在此查看；采集受限时应展示来源缺口。</p>}
      {batches.map((result) => (
        <details key={result.batchId} className="research-batch" open={batches.length === 1}>
          <summary>
            {{ KEYWORDS: "关键词研究", TRENDS: "近期话题研究", COMPETITORS: "竞品差异研究" }[result.scope.goal]} ·{" "}
            {new Date(result.createdAt).toLocaleString()} · {result.candidates.length} 项候选
          </summary>
          <p>
            研究重点：{result.scope.focus || "商家整体内容机会"}；观察最近 {result.scope.windowDays} 天；商家资料第{" "}
            {result.profileRevision} 版。
          </p>
          <p>{result.coverage}</p>
          {result.gaps.length > 0 && <p>来源缺口：{result.gaps.join("；")}</p>}
          {result.stale && <p className="muted">商家资料或所选来源已变化，采用前请复核。</p>}
          {result.sourceRunStatus !== "SUCCEEDED" && <p className="muted">来源任务尚未成功完成，候选暂不能采用。</p>}
          {!sessionId && <Link to={`/sessions/${result.sessionId}`}>查看原研究会话</Link>}
          <ul className="research-candidates">
            {result.candidates.map((item, index) => (
              <li key={`${result.batchId}:${item.kind}:${item.title}`}>
                <strong>
                  {kindLabels[item.kind]}：{item.title}
                </strong>
                <p>商家关联：{item.merchantRelevance}</p>
                <p>适用客群：{item.audience}</p>
                <p>内容角度：{item.contentAngle}</p>
                <CandidateDetails candidate={item} />
                {item.cautions.length > 0 && <p>限制与待核实：{item.cautions.join("；")}</p>}
                <div className="research-sources">
                  {result.evidenceRefs
                    .filter((ref) => item.evidenceIds.includes(ref.evidenceId))
                    .map((ref) => (
                      <a key={ref.evidenceId} href={ref.sourceUrl} target="_blank" rel="noreferrer">
                        公开证据 · {new Date(ref.collectedAt).toLocaleString()}
                      </a>
                    ))}
                </div>
                <button
                  type="button"
                  disabled={busy || result.sourceRunStatus !== "SUCCEEDED"}
                  onClick={() => editCandidate(result, index)}
                >
                  编辑并选用
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
      {candidate && batch && (
        <div className="research-editor">
          <h4>采用到当前商家研究库</h4>
          <label>
            名称
            <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            为什么适合本商家
            <textarea value={relevance} maxLength={1000} onChange={(event) => setRelevance(event.target.value)} />
          </label>
          <label>
            可用内容角度
            <textarea value={angle} maxLength={1000} onChange={(event) => setAngle(event.target.value)} />
          </label>
          {duplicate && <p>已有同类同名建议，将更新第 {duplicate.revision} 版并保留历史。</p>}
          {batch.stale && (
            <label>
              <input type="checkbox" checked={allowStale} onChange={(event) => setAllowStale(event.target.checked)} />
              已复核，仍采用基于原商家资料的结果
            </label>
          )}
          <div className="prompt-actions">
            <button
              type="button"
              disabled={busy || !title.trim() || !relevance.trim() || !angle.trim() || (batch.stale && !allowStale)}
              onClick={() => void adopt()}
            >
              {duplicate ? "更新已有建议" : "保存到商家研究库"}
            </button>
            <button type="button" disabled={busy} onClick={() => setSelected(null)}>
              取消选用
            </button>
          </div>
        </div>
      )}
      <TopicPanel
        key={`topics:${merchantId}:${sessionId ?? ""}`}
        merchantId={merchantId}
        sessionId={sessionId}
        reports={reports}
        modelConfigured={modelConfigured}
        imageInputEnabled={imageInputEnabled}
        sessionWritable={sessionWritable}
      />
      <h4>已采用研究库</h4>
      {!library.length && <p className="muted">尚未采用研究建议；人工登记的线索仍在商品与选题来源中。</p>}
      <ul className="research-candidates">
        {library.map((item) => (
          <li key={item.itemId}>
            <strong>
              {kindLabels[item.candidate.kind]}：{item.candidate.title} · 第 {item.revision} 版 ·{" "}
              {item.status === "ACTIVE" ? "已采用" : "已停用"}
            </strong>
            <p>{item.candidate.merchantRelevance}</p>
            <p>可用角度：{item.candidate.contentAngle}</p>
            <CandidateDetails candidate={item.candidate} />
            {item.stale && <p className="muted">商家资料或所选来源已变化，需要复核。</p>}
            {item.expiresAt && (
              <p className="muted">
                研究来源使用至 {new Date(item.expiresAt).toLocaleString()}；未设置建议截止的话题按原观察范围限制使用。
              </p>
            )}
            {item.expiresAt && Date.parse(item.expiresAt) <= Date.now() && (
              <p className="muted">已超过来源使用窗口，仅保留历史，不进入新一轮选题来源。</p>
            )}
            <small>
              采用于 {new Date(item.adoptedAt).toLocaleString()} · 商家资料第 {item.profileRevision} 版
            </small>
            <details>
              <summary>来源与版本</summary>
              <p>研究建议第 {item.revision} 版；采用后仍保留研究推断身份。</p>
              <div className="research-sources">
                {item.evidenceRefs.map((ref) => (
                  <a key={ref.evidenceId} href={ref.sourceUrl} target="_blank" rel="noreferrer">
                    公开证据 · {new Date(ref.collectedAt).toLocaleString()}
                  </a>
                ))}
              </div>
            </details>
            {item.status === "ACTIVE" && (
              <button type="button" disabled={busy} onClick={() => void deactivate(item)}>
                停用
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

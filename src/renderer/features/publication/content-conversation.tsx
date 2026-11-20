import { useEffect, useRef, useState } from "react";
import type { TextGenerationJobRecord } from "../../../shared/contracts.js";
import type { PublicationReview } from "../../../shared/publication.js";
import type { TaskExecutionLimits } from "../../../shared/task-execution.js";
import * as api from "../../api/client.js";
import { AssistantMarkdown } from "../../components/assistant-markdown.js";
import { TaskContextPanel } from "./task-context-panel.js";

/** 围绕同一篇稿件展示真实任务对话，输入按稿件暂存，回执从Host恢复。 */
export function ContentConversation({
  sessionId,
  draftId,
  rootJobId,
  jobs,
  disabled,
  onSend,
  onApproveImage,
  onConfirmExport,
  currentReview,
}: {
  sessionId: string;
  draftId: string;
  rootJobId?: string;
  jobs: TextGenerationJobRecord[];
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
  onApproveImage?: (job: TextGenerationJobRecord) => Promise<void>;
  onConfirmExport?: (job: TextGenerationJobRecord) => Promise<void>;
  currentReview?: PublicationReview;
}) {
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const storageKey = `zhiban:content-chat:${sessionId}:${draftId}`;
  const restored = useRef(false);
  const history = jobs
    .filter(
      (job) =>
        (draftId
          ? job.targetDraftId === draftId || job.resultDraftId === draftId
          : !job.targetDraftId && !job.resultDraftId) &&
        !job.source?.parentConversationJobId &&
        ["CONTENT", "PUBLICATION_PLAN", "PUBLICATION_CHAT"].includes(job.purpose),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-30);
  const latest = history.at(-1);
  const lastReply = `${latest?.jobId}:${latest?.status}:${latest?.conversation?.reply ?? ""}:${latest?.source?.workflow?.receipt}`;
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const input = JSON.parse(saved);
        if (typeof input.text === "string") setText(input.text);
      }
    } catch {
      // 暂存不可用时仍可发起Host持久任务，不能把浏览器缓存当对话事实源。
    }
    restored.current = true;
  }, [storageKey]);
  useEffect(() => {
    if (!restored.current) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ text }));
    } catch {
      // 私密窗口可能禁用暂存；已受理记录仍在Host，未发送输入只保留当前页。
    }
  }, [text, storageKey]);
  useEffect(() => {
    if (lastReply) log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [lastReply]);

  /** 仅在Host受理成功后清空输入，失败时保留原话供重试。 */
  async function send() {
    if (disabled || !text.trim()) return;
    if (await onSend(text.trim())) setText("");
  }

  return (
    <section className="content-conversation" aria-label="这篇内容的对话">
      <header>
        <h2>和 AI 对话，完成这一篇</h2>
        <p>直接说目标、改文案或换配图。AI 自动判断并执行，最后由你确认整套图文。</p>
      </header>
      <TaskContextPanel
        sessionId={sessionId}
        draftId={draftId}
        rootJobId={rootJobId}
        sourceJobIds={history.map((job) => job.jobId)}
      />
      <div className="content-conversation-log" role="log" aria-label="本篇对话记录" aria-live="polite" ref={log}>
        {!history.length && <p className="muted">例如：“为什么这样写？”或“标题短一点，正文更自然”。</p>}
        {history.map((job) => (
          <article key={job.jobId} id={`content-message-${job.jobId}`}>
            {job.conversation ? (
              <div className="content-chat-user">
                <strong>你</strong>
                <p>{job.conversation.instruction}</p>
              </div>
            ) : (
              <p className="muted">历史任务 · {job.title}</p>
            )}
            <div className="content-chat-assistant">
              <strong>{job.conversation?.reply ? "AI" : "任务结果"}</strong>
              {job.source?.workflow ? (
                <>
                  {job.conversation?.reply && <AssistantMarkdown content={job.conversation.reply} />}
                  {job.source.workflow.completed.length > 0 && (
                    <ul>
                      {[...new Set(job.source.workflow.completed)].map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                  {job.source.workflow.receipt && <p role="status">{job.source.workflow.receipt}</p>}
                  {job.source.workflow.exportArtifactId && (
                    <a href={api.publicationDownloadUrl(sessionId, job.source.workflow.exportArtifactId)}>
                      下载本版发布包 ZIP
                    </a>
                  )}
                </>
              ) : job.status === "FAILED" ? (
                <p>这次未完成：{job.errorCode}。原稿保留，请调整要求后重试。</p>
              ) : job.status !== "READY_FOR_REVIEW" ? (
                <p>{job.status === "QUEUED" ? "已受理，等待处理…" : "正在处理你的消息…"}</p>
              ) : job.conversation?.reply ? (
                <AssistantMarkdown content={job.conversation.reply} />
              ) : (
                <p>
                  {job.purpose === "PUBLICATION_PLAN"
                    ? `配图方案已保存${job.source?.planningImageCount ? `，共${job.source.planningImageCount}张` : ""}，可以预览后制作。`
                    : "文案任务已完成，结果保存在这篇内容中。"}
                </p>
              )}
            </div>
          </article>
        ))}
      </div>
      {latest && <TaskExecutionCard sessionId={sessionId} job={latest} disabled={disabled} />}
      {currentReview && <ConversationReview review={currentReview} />}
      {latest?.source?.workflow && (
        <ConversationApproval
          key={`${latest.jobId}:${latest.source.workflow.state}`}
          job={latest}
          disabled={disabled}
          onApproveImage={onApproveImage}
          onConfirmExport={onConfirmExport}
          review={currentReview}
        />
      )}
      <div className="content-conversation-compose">
        <label>
          给 AI 的消息
          <textarea
            value={text}
            rows={3}
            maxLength={2000}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            placeholder="例如：标题短一点，封面换成暖色；或继续完成，做好后让我确认下载"
          />
        </label>
        <div className="content-chat-send">
          <small>不用选择模式。付费图片会先确认具体请求，完成后再确认并下载发布包。</small>
          <button
            type="button"
            className="primary-button"
            disabled={disabled || !text.trim()}
            onClick={() => void send()}
          >
            发给 AI
          </button>
        </div>
      </div>
    </section>
  );
}

/** 在同一对话展示当前版本的真实审核意见，不要求用户切换审核页面。 */
export function ConversationReview({ review }: { review: PublicationReview }) {
  return (
    <section className="content-chat-approval" aria-label="本篇审核意见">
      <strong>
        {review.verdict === "CHANGES_REQUIRED"
          ? "审核发现需要修改的问题"
          : review.verdict === "LIMITED"
            ? "审核覆盖有限，请人工补查"
            : "独立审核已完成"}
      </strong>
      <p>
        文案 v{review.draftRevision} / 配图编排 v{review.publicationRevision} · 实际查看图片 {review.comparedImages}/
        {review.totalImages} 张
      </p>
      <details>
        <summary>查看审核意见与修改建议（{review.issues.length}项）</summary>
        <p>{review.summary}</p>
        <PreviousIssueChecks review={review} />
        <ul>
          {review.issues.map((issue) => (
            <li key={`${issue.target}:${issue.slotId}:${issue.detail}`}>
              {issue.severity === "BLOCKER" ? "需修正：" : "建议核对："}
              {issue.detail} {issue.suggestion}
            </li>
          ))}
        </ul>
      </details>
      {review.verdict === "CHANGES_REQUIRED" && <p>可以直接说“按审核意见修改，再继续完成”。</p>}
    </section>
  );
}

/** 确认卡由Host持久状态驱动，模型回复或普通“确认”文字不能代替按钮授权。 */
export function ConversationApproval({
  job,
  disabled,
  onApproveImage,
  onConfirmExport,
  review,
}: {
  job: TextGenerationJobRecord;
  disabled: boolean;
  onApproveImage?: (job: TextGenerationJobRecord) => Promise<void>;
  onConfirmExport?: (job: TextGenerationJobRecord) => Promise<void>;
  review?: PublicationReview;
}) {
  const [checked, setChecked] = useState(false);
  const flow = job.source?.workflow;
  if (!flow) return null;
  if (flow.state === "WAITING_IMAGE_CONFIRMATION" && flow.imageRequest && onApproveImage)
    return (
      <section className="content-chat-approval" aria-label="本次配图费用确认">
        <h3>确认这一次配图制作</h3>
        <p>1 张图片 · {flow.imageRequest.modelId} · 1280×1920 · 标准质量。费用按图片服务商规则收取。</p>
        <details>
          <summary>查看画面要求与参考</summary>
          <p>{flow.imageRequest.fields.images.find((image) => image.slotId === flow.imageRequest?.slotId)?.prompt}</p>
          <small>{flow.imageRequest.referenceArtifactId ? "将以当前配图为参考修改。" : "本次为新图片制作。"}</small>
        </details>
        <button type="button" className="primary-button" disabled={disabled} onClick={() => void onApproveImage(job)}>
          确认本次图片费用并继续
        </button>
        <p className="muted">也可以继续对话改变要求；旧确认卡随之失效。</p>
      </section>
    );
  if (flow.state !== "WAITING_FINAL_CONFIRMATION" || !onConfirmExport) return null;
  return (
    <section className="content-chat-approval" aria-label="整套图文最终确认">
      <h3>本篇已准备好，等你最后确认</h3>
      <p>
        请核对上方成品预览。文案 v{flow.draftRevision} / 配图编排 v{flow.publicationRevision}。
      </p>
      {review && (
        <p>
          {review.verdict === "LIMITED"
            ? "审核覆盖有限，请结合上方审核意见人工补查。"
            : "独立审核结果见上方，确认前请核对。"}
        </p>
      )}
      <label className="inline-checkbox">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => setChecked(event.target.checked)}
        />
        我已核对商家与商品事实、文案、全部配图和发布说明
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={disabled || !checked}
        onClick={() => void onConfirmExport(job)}
      >
        确认整套并生成发布包
      </button>
      <p className="muted">确认后可下载 ZIP；平台发布由你完成。需要修改时继续说即可。</p>
    </section>
  );
}

/** 复审逐项显示原问题的真实结论，避免把已保存补丁展示成审核通过。 */
export function PreviousIssueChecks({ review }: { review: PublicationReview }) {
  if (!review.previousIssueChecks?.length) return null;
  return (
    <section aria-label="旧问题复审结果">
      <strong>旧问题复审</strong>
      <ul>
        {review.previousIssueChecks.map((check) => (
          <li key={check.issueId}>
            {check.status === "RESOLVED" ? "已解决" : check.status === "REMAINING" ? "仍存在" : "待核实"}：
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
    </section>
  );
}

/** 原任务额度与暂停入口；只有用户点击并提交新额度才能恢复，不自动加预算。 */
export function TaskExecutionCard({
  sessionId,
  job,
  disabled,
}: {
  sessionId: string;
  job: TextGenerationJobRecord;
  disabled: boolean;
}) {
  const control = job.executionControl;
  const [edited, setEdited] = useState<{ rootJobId: string; limits: TaskExecutionLimits } | null>(null);
  const limits = control ? (edited?.rootJobId === control.rootJobId ? edited.limits : control.limits) : null;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!control || !limits) return null;
  /** 提交时带当前控制版本，轮询期间的结算变化不能覆盖人工确认。 */
  async function resume() {
    if (!control || !limits) return;
    setBusy(true);
    setError("");
    try {
      await api.resumeTaskExecution(sessionId, job.jobId, control.revision, limits);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const labels: Record<keyof TaskExecutionLimits, string> = {
    modelCalls: "模型请求",
    toolCalls: "工具调用",
    steps: "执行步骤",
    images: "图片请求",
    summaryCalls: "结果汇总",
    activeMs: "活跃执行时长（分钟）",
  };
  return (
    <details className="content-chat-approval" open={control.state === "PAUSED"} aria-label="任务执行额度">
      <summary>{control.state === "PAUSED" ? "任务达到额度，已暂停并保留成果" : "查看本篇执行额度"}</summary>
      <p>
        模型 {control.usage.modelCalls}/{control.limits.modelCalls} · 工具 {control.usage.toolCalls}/
        {control.limits.toolCalls} · 图片请求 {control.usage.images}/{control.limits.images}
      </p>
      <p>
        已报告 {control.usage.reportedTokens} token；{control.usage.unknownUsages}
        次用量未知。图片与模型账单不按此计数推算。
      </p>
      {control.state === "PAUSED" && (
        <>
          <p>
            达到：{labels[control.reason as keyof TaskExecutionLimits] ?? control.reason}
            。调整总额度后可继续原任务，图片仍需费用确认。
          </p>
          <div className="task-execution-limits">
            {Object.entries(labels).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={
                    key === "activeMs"
                      ? Math.ceil(control.usage.activeMs / 60000)
                      : control.usage[key as keyof TaskExecutionLimits]
                  }
                  value={key === "activeMs" ? limits.activeMs / 60000 : limits[key as keyof TaskExecutionLimits]}
                  disabled={disabled || busy}
                  onChange={(event) =>
                    setEdited({
                      rootJobId: control.rootJobId,
                      limits: { ...limits, [key]: Number(event.target.value) * (key === "activeMs" ? 60000 : 1) },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <button type="button" disabled={disabled || busy} onClick={() => void resume()}>
            确认新额度并继续
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}

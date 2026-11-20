import { useEffect, useState } from "react";
import type { TaskContextView, TaskRequirement } from "../../../shared/task-context.js";
import * as api from "../../api/client.js";

const requirementGroups = [
  { kind: "GOAL", title: "当前目标" },
  { kind: "CONSTRAINT", title: "持续要求" },
  { kind: "OPEN_QUESTION", title: "待确认问题" },
] as const;
const applicabilityLabels = { CURRENT: "当前适用", HISTORICAL: "历史参考", NEEDS_REVIEW: "需要复核" };
const readabilityLabels = { AVAILABLE: "可读取", UNAVAILABLE: "当前不可读取" };
const approvalLabels = { PENDING: "尚未确认", APPROVED: "已确认该版本", NOT_APPLICABLE: "无需单独确认" };

/** 只展示 Host 记录的本篇要求和成果状态，切换目标后不沿用前一篇的查询结果。 */
export function TaskContextPanel({
  sessionId,
  draftId,
  rootJobId,
  sourceJobIds,
}: {
  sessionId: string;
  draftId: string;
  rootJobId?: string;
  sourceJobIds: string[];
}) {
  const targetKey = `${sessionId}:${draftId}:${rootJobId ?? ""}`;
  const [result, setResult] = useState<{ targetKey: string; view: TaskContextView | null; failed: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!draftId && !rootJobId) return;
    let active = true;
    let loading = false;
    /** 在已有图文轮询周期内读取持久事实，失败后清除旧视图，避免陈旧要求被当作当前状态。 */
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const view = await api.getTaskContext(sessionId, draftId ? { draftId } : { rootJobId });
        if (!active) return;
        if (view && (view.snapshot.sessionId !== sessionId || (draftId && view.draftId !== draftId))) {
          setResult({ targetKey, view: null, failed: true });
          return;
        }
        setResult({ targetKey, view, failed: false });
      } catch {
        if (active) setResult({ targetKey, view: null, failed: true });
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId, draftId, rootJobId, targetKey]);

  if (result?.targetKey !== targetKey) return null;
  if (result.failed)
    return (
      <p className="task-context-panel muted" role="status">
        本篇任务要求暂时无法读取，正在重试。
      </p>
    );
  const view = result.view;
  if (!view) return null;
  const requirements = view.snapshot.requirements.filter((item) => item.status === "ACTIVE");
  const history = view.snapshot.requirements.filter((item) => item.status !== "ACTIVE");
  const pendingSources = view.snapshot.pendingSources;

  return (
    <details className="task-context-panel">
      <summary>
        本篇任务要求与进度
        <small>
          {requirements.length} 条有效要求{pendingSources.length ? ` · ${pendingSources.length} 条补充待整理` : ""}
        </small>
      </summary>
      <div className="task-context-body">
        <p className="muted">要求来自本篇对话。需要调整时，直接在下方告诉 AI。</p>
        {pendingSources.length > 0 && (
          <details className="task-context-pending">
            <summary>本篇还有 {pendingSources.length} 条补充尚未完成整理，原话已保留</summary>
            <ul>
              {pendingSources.map((source) => (
                <li key={`${source.kind}:${source.id}`}>
                  <RequirementSource source={{ ...source, quote: source.text }} sourceJobIds={sourceJobIds} />
                </li>
              ))}
            </ul>
          </details>
        )}
        {!requirements.length && <p className="muted">尚未整理出持续要求，以原始消息为准。</p>}
        {requirementGroups.map((group) => {
          const items = requirements.filter((item) => item.kind === group.kind);
          if (!items.length) return null;
          return (
            <section key={group.kind} aria-label={group.title}>
              <h3>{group.title}</h3>
              <ul>
                {items.map((item) => (
                  <li key={item.requirementId}>
                    {item.text}
                    <details className="task-context-source">
                      <summary>查看来源原话</summary>
                      <RequirementSource source={item.source} sourceJobIds={sourceJobIds} />
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {history.length > 0 && (
          <details className="task-context-source">
            <summary>已替换或已解决的要求（{history.length}）</summary>
            <ul>
              {history.map((item) => (
                <li key={item.requirementId}>
                  {item.status === "SUPERSEDED" ? "已替换" : "已解决"}：{item.text}
                  <RequirementSource source={item.source} sourceJobIds={sourceJobIds} />
                </li>
              ))}
            </ul>
          </details>
        )}
        <section aria-label="可复用成果">
          <h3>已有成果与适用范围</h3>
          {!view.carriers.length && <p className="muted">暂无已保存的成果。</p>}
          <ul>
            {view.carriers.map((carrier) => (
              <li key={`${carrier.kind}:${carrier.id}`}>
                <strong>
                  {carrier.title}
                  {carrier.revision !== null ? ` · 第 ${carrier.revision} 版` : ""}
                </strong>
                <p className="task-context-asset-state">
                  {readabilityLabels[carrier.readability]} · {applicabilityLabels[carrier.applicability]} ·{" "}
                  {approvalLabels[carrier.approval]}
                </p>
                <p>{carrier.progress}</p>
                {carrier.reason && <p>{carrier.reason}</p>}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="剩余事项">
          <h3>剩余事项</h3>
          {!view.remainingWork.length ? (
            <p className="muted">暂无已记录的待办。</p>
          ) : (
            <ul>
              {[...new Set(view.remainingWork)].map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </details>
  );
}

/** 展示真实来源引文；当前对话仍可见的原话提供原位回看入口。 */
function RequirementSource({ source, sourceJobIds }: { source: TaskRequirement["source"]; sourceJobIds: string[] }) {
  return (
    <div className="task-context-source">
      <blockquote>{source.quote}</blockquote>
      {source.kind === "GENERATION_REQUEST" && sourceJobIds.includes(source.id) && (
        <a href={`#content-message-${encodeURIComponent(source.id)}`}>回看这条消息</a>
      )}
    </div>
  );
}

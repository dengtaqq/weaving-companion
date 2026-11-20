import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { MerchantRecord } from "../../../shared/contracts.js";
import type { ContentTaskSummary, WorkbenchBoard, WorkPlan, WorkPlanFields } from "../../../shared/workbench.js";
import * as api from "../../api/client.js";
import { Icon, Modal } from "../../components/ui.js";

const stageLabels: Record<ContentTaskSummary["stage"], string> = {
  TOPIC: "选题与方向",
  COPY: "文案制作",
  IMAGES: "配图制作",
  REVIEW: "待整套审核",
  DELIVERY: "可下载发布包",
  PUBLISHED: "已人工登记发布",
};
/** 采用本机日期形成日历键，避免 UTC 跨日让排班偏移。 */
export function calendarDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** 按真实任务是否已有草稿生成继续工作入口。 */
export function contentTaskUrl(task: ContentTaskSummary): string {
  return `/sessions/${task.sessionId}?studio=1${task.draftId ? `&draft=${task.draftId}` : task.jobId ? `&job=${task.jobId}` : ""}`;
}

/** 真实工作排期与内容进度共用仪表盘，不创建定时执行或模拟成功状态。 */
export function DashboardPage({
  merchants,
  defaultMerchantId,
  initialTab = "plans",
}: {
  merchants: MerchantRecord[];
  defaultMerchantId?: string;
  initialTab?: "plans" | "tasks" | "feedback";
}) {
  const [tab, setTab] = useState(initialTab);
  const [board, setBoard] = useState<WorkbenchBoard | null>(null);
  const [merchantId, setMerchantId] = useState(defaultMerchantId ?? "");
  const [day, setDay] = useState(calendarDate(new Date()));
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState<WorkPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const commands = useRef(new Map<string, string>());
  const [from, setFrom] = useState(calendarDate(new Date()));
  const end = new Date(`${from}T12:00:00`);
  end.setDate(end.getDate() + 7);
  const to = calendarDate(end);
  /** 保存或运行后从数据库刷新，不根据点击先行标记完成。 */
  const refresh = useCallback(async () => {
    const next = await api.getWorkbenchBoard(from, to, merchantId || undefined);
    setBoard(next);
  }, [from, to, merchantId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void api
      .getWorkbenchBoard(from, to, merchantId || undefined)
      .then((next) => {
        if (active) setBoard(next);
      })
      .catch((error: unknown) => {
        if (active) setNotice(String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const timer = window.setInterval(
      () =>
        void refresh().catch((error: unknown) => {
          if (active) setNotice(String(error));
        }),
      5000,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [from, to, merchantId, refresh]);
  /** 新增计划时固定 ID，响应不明时重试仍是同一个计划。 */
  function newPlan() {
    const selected = merchantId || merchants[0]?.merchantId;
    if (!selected) {
      setNotice("请先在商家维护中添加商家。");
      return;
    }
    setEdit({
      planId: `plan_${crypto.randomUUID()}`,
      merchantId: selected,
      sessionId: null,
      draftId: null,
      title: "",
      scheduledFor: day,
      status: "TODO",
      note: "",
      revision: 0,
      createdAt: "",
      updatedAt: "",
    });
    setNotice("");
  }
  /** 持久化计划或明确完成/取消，版本冲突保留当前表单。 */
  async function savePlan(value: WorkPlan) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    const fields: WorkPlanFields = {
      merchantId: value.merchantId,
      sessionId: value.sessionId,
      draftId: value.draftId,
      title: value.title,
      scheduledFor: value.scheduledFor,
      status: value.status,
      note: value.note,
    };
    const signature = JSON.stringify(value);
    if (!commands.current.has(signature)) commands.current.set(signature, crypto.randomUUID());
    try {
      await api.saveWorkPlan(value.planId, value.revision, fields, commands.current.get(signature) as string);
      if (value.scheduledFor < from || value.scheduledFor > to) setFrom(value.scheduledFor);
      setDay(value.scheduledFor);
      await refresh();
      setEdit(null);
      setNotice(value.status === "CANCELLED" ? "计划已取消，关联内容保留。" : "计划已保存。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  const days = Array.from({ length: 8 }, (_, index) => {
    const date = new Date(`${from}T12:00:00`);
    date.setDate(date.getDate() + index);
    return { key: calendarDate(date), date };
  });
  const plans = board?.plans.filter((item) => item.scheduledFor === day) ?? [];
  const tasks = board?.tasks ?? [];
  return (
    <div className="page-content dashboard-page">
      <nav className="page-tabs" aria-label="仪表盘视图">
        {[
          ["plans", "工作计划"],
          ["tasks", "内容任务"],
          ["feedback", "笔记反馈"],
        ].map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value as typeof tab)}
          >
            {label}
          </button>
        ))}
      </nav>
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      <div className="dashboard-filter">
        <input
          type="date"
          aria-label="排期起始日"
          value={from}
          onChange={(event) => {
            if (event.target.value) {
              setFrom(event.target.value);
              setDay(event.target.value);
            }
          }}
        />
        <select aria-label="筛选商家" value={merchantId} onChange={(event) => setMerchantId(event.target.value)}>
          <option value="">全部商家</option>
          {merchants.map((item) => (
            <option key={item.merchantId} value={item.merchantId}>
              {item.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="quiet-button"
          disabled={loading}
          onClick={() => void refresh().catch((error: unknown) => setNotice(String(error)))}
        >
          <Icon name="calendar" />
          刷新
        </button>
      </div>
      {tab === "plans" && (
        <>
          <section className="schedule-section">
            <div className="section-heading">
              <h2>
                工作排期 <small>今天及未来 7 天</small>
              </h2>
              <button type="button" onClick={newPlan}>
                <Icon name="plus" />
                添加计划
              </button>
            </div>
            <div className="week-track">
              {days.map(({ key, date }) => {
                const count =
                  board?.plans.filter((plan) => plan.scheduledFor === key && plan.status === "TODO").length ?? 0;
                return (
                  <button
                    type="button"
                    key={key}
                    className={`week-day ${day === key ? "selected" : ""}`}
                    onClick={() => setDay(key)}
                  >
                    <span>
                      {key === calendarDate(new Date())
                        ? "今天"
                        : date.toLocaleDateString("zh-CN", { weekday: "long" })}
                    </span>
                    <strong>{date.getDate()}</strong>
                    <small>{count ? `${count} 项待办` : "暂无安排"}</small>
                  </button>
                );
              })}
            </div>
          </section>
          <div className="dashboard-summary">
            本机计划 · {board?.stats.running ?? 0} 个运行中 · {board?.stats.failed ?? 0} 个失败待处理{" "}
            <span>
              维护中 {board?.stats.merchants ?? 0} 家商家 · {board?.stats.products ?? 0} 个商品
            </span>
          </div>
          <section className="schedule-section">
            <div className="section-heading">
              <h2>
                {new Date(`${day}T12:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} 工作计划
              </h2>
              <span className="muted">{plans.length} 项</span>
            </div>
            {plans.length ? (
              plans.map((plan) => (
                <article className="plan-row" key={plan.planId}>
                  <button
                    type="button"
                    className={`plan-check ${plan.status === "DONE" ? "done" : ""}`}
                    aria-label={plan.status === "DONE" ? `重新打开${plan.title}` : `完成${plan.title}`}
                    disabled={busy}
                    onClick={() => void savePlan({ ...plan, status: plan.status === "DONE" ? "TODO" : "DONE" })}
                  >
                    {plan.status === "DONE" && <Icon name="check" size={14} />}
                  </button>
                  <div>
                    <strong>{plan.title}</strong>
                    <small>
                      {merchants.find((item) => item.merchantId === plan.merchantId)?.name}{" "}
                      {plan.note && `· ${plan.note}`}
                    </small>
                  </div>
                  {plan.sessionId && (
                    <Link to={`/sessions/${plan.sessionId}${plan.draftId ? `?studio=1&draft=${plan.draftId}` : ""}`}>
                      继续工作
                    </Link>
                  )}
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      setEdit({ ...plan });
                      setNotice("");
                    }}
                  >
                    编辑
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-plan">
                <Icon name="shop" size={28} />
                <div>
                  <strong>{loading ? "正在读取计划…" : "当天暂无工作计划"}</strong>
                  <p>维护商家后，可添加排期；内容制作和交付会保存在内容任务中。</p>
                </div>
              </div>
            )}
          </section>
          <section className="schedule-section">
            <div className="section-heading">
              <h2>
                待处理内容 <small>{tasks.filter((task) => task.stage !== "PUBLISHED").length} 项</small>
              </h2>
              <button type="button" className="quiet-button" onClick={() => setTab("tasks")}>
                查看全部 <Icon name="right" />
              </button>
            </div>
            <TaskTable tasks={tasks.filter((task) => task.stage !== "PUBLISHED").slice(0, 5)} />
          </section>
        </>
      )}
      {tab === "tasks" && (
        <>
          <div className="page-heading">
            <div>
              <h1>内容任务</h1>
              <p>从选题到交付，回到同一篇图文继续工作。</p>
            </div>
          </div>
          <TaskTable tasks={tasks} />
        </>
      )}
      {tab === "feedback" && (
        <>
          <div className="page-heading">
            <div>
              <h1>笔记反馈</h1>
              <p>发布链接和反馈由你在发布包页人工登记，点击笔记继续补充。</p>
            </div>
          </div>
          <TaskTable tasks={tasks.filter((task) => task.publicationRecord)} />
        </>
      )}
      {edit && (
        <Modal
          title={edit.revision ? "编辑工作计划" : "添加工作计划"}
          onClose={() => {
            if (!busy) setEdit(null);
          }}
          footer={
            <>
              {edit.revision > 0 && (
                <button
                  type="button"
                  className="quiet-button danger-text"
                  disabled={busy}
                  onClick={() => void savePlan({ ...edit, status: "CANCELLED" })}
                >
                  取消此计划
                </button>
              )}
              <button type="button" onClick={() => setEdit(null)}>
                关闭
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !edit.title.trim()}
                onClick={() => void savePlan(edit)}
              >
                保存计划
              </button>
            </>
          }
        >
          {notice && (
            <p className="studio-notice" role="status">
              {notice}
            </p>
          )}
          <div className="form-stack">
            <label>
              所属商家
              <select
                disabled={edit.revision > 0}
                value={edit.merchantId}
                onChange={(event) =>
                  setEdit({ ...edit, merchantId: event.target.value, sessionId: null, draftId: null })
                }
              >
                {merchants.map((merchant) => (
                  <option key={merchant.merchantId} value={merchant.merchantId}>
                    {merchant.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              计划内容
              <input
                value={edit.title}
                maxLength={120}
                onChange={(event) => setEdit({ ...edit, title: event.target.value })}
                placeholder="例如：确认本周选题、补拍商品图"
              />
            </label>
            <label>
              工作日期
              <input
                type="date"
                value={edit.scheduledFor}
                onChange={(event) => setEdit({ ...edit, scheduledFor: event.target.value })}
              />
            </label>
            <label>
              关联内容（可选）
              <select
                value={edit.draftId ?? edit.sessionId ?? ""}
                onChange={(event) => {
                  const task = tasks.find((task) => (task.draftId ?? task.sessionId) === event.target.value);
                  setEdit({ ...edit, sessionId: task?.sessionId ?? null, draftId: task?.draftId ?? null });
                }}
              >
                <option value="">不关联具体内容</option>
                {tasks
                  .filter((task) => task.merchantId === edit.merchantId)
                  .map((task) => (
                    <option key={task.draftId ?? task.jobId} value={task.draftId ?? task.sessionId}>
                      {task.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              备注
              <textarea
                value={edit.note}
                maxLength={2000}
                rows={3}
                onChange={(event) => setEdit({ ...edit, note: event.target.value })}
              />
            </label>
          </div>
          <p className="muted">这是人工工作安排，不会自动生成、收费或发布。</p>
        </Modal>
      )}
    </div>
  );
}
/** 统一内容列表展示真实阶段，并给出可继续的任务入口。 */
export function TaskTable({ tasks }: { tasks: ContentTaskSummary[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>内容</th>
            <th>所属商家</th>
            <th>当前阶段</th>
            <th>最近更新</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.draftId ?? task.jobId}>
              <td>
                <strong>{task.title}</strong>
                {task.publicationRecord && (
                  <small>
                    人工登记 · 点赞 {task.publicationRecord.metrics.likes ?? "—"} · 收藏{" "}
                    {task.publicationRecord.metrics.favorites ?? "—"} · 评论{" "}
                    {task.publicationRecord.metrics.comments ?? "—"}
                  </small>
                )}
                {task.errorCode && <small className="danger-text">{task.errorCode}</small>}
              </td>
              <td>{task.merchantName}</td>
              <td>
                <span
                  className={`tag ${task.status === "FAILED" ? "red" : task.stage === "DELIVERY" || task.stage === "PUBLISHED" ? "green" : ""}`}
                >
                  {task.errorCode === "UNKNOWN_EXTERNAL"
                    ? "图片待核对"
                    : task.status === "FAILED"
                      ? "任务失败"
                      : task.status === "WORKING"
                        ? "执行中"
                        : stageLabels[task.stage]}
                </span>
              </td>
              <td>{new Date(task.updatedAt).toLocaleDateString("zh-CN")}</td>
              <td>
                <Link className="outline-button" to={contentTaskUrl(task)}>
                  继续 <Icon name="right" size={14} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!tasks.length && (
        <div className="empty-state">
          <Icon name="file" size={30} />
          <p>还没有相关内容。从商家或商品开始创作。</p>
          <Link to="/merchants">去维护商家 →</Link>
        </div>
      )}
    </div>
  );
}

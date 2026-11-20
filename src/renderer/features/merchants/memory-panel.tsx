import { type FormEvent, useEffect, useState } from "react";
import type {
  MemoryFields,
  MemoryJob,
  MemoryKind,
  MerchantCatalogEntry,
  MerchantMemory,
} from "../../../shared/contracts.js";
import { MEMORY_SOURCE_MESSAGE_LIMIT, MEMORY_SOURCE_TEXT_LIMIT } from "../../../shared/contracts.js";
import * as api from "../../api/client.js";

const kinds: Record<MemoryKind, string> = {
  PREFERENCE: "偏好",
  RULE: "规则",
  FACT: "事实",
  DECISION: "决策",
  PROGRESS: "进展",
};
const jobLabels: Record<MemoryJob["status"], string> = {
  QUEUED: "等待总结",
  RUNNING: "总结中",
  SUCCEEDED: "整理完成（生效状态见记忆列表）",
  FAILED: "总结未完成",
};
const jobErrors: Record<string, string> = {
  MODEL_NOT_CONFIGURED: "尚未配置文本模型，配置后可重试",
  MODEL_CONFIGURATION_CHANGED: "模型服务已变化，重试可使用当前配置",
  MODEL_TIMEOUT: "模型请求超时，可重试",
  MODEL_OUTPUT_TRUNCATED: "模型输出达到长度上限，总结尚未完整生成，可重试",
  MODEL_PROVIDER_FAILED: "模型服务返回错误，可重试",
  MODEL_RESPONSE_INCOMPLETE: "模型回复未完整结束，可重试",
  MODEL_RESPONSE_MISSING: "模型没有返回回复，可重试",
  EMPTY_MODEL_RESPONSE: "模型没有返回总结正文，可重试",
  MEMORY_INTERRUPTED: "总结中断，可重试",
  MEMORY_RESULT_INVALID: "模型返回格式不符合要求，可重试",
  MEMORY_SOURCE_INVALID: "总结引用未通过来源核对，可重试",
  MEMORY_CONTEXT_BUDGET: "会话文字超出当前模型的上下文预算",
  MEMORY_LIMIT: "记忆数量达到上限，请先停用旧记录",
  MEMORY_NO_MESSAGES: "会话没有可总结的文字",
  MEMORY_TEMPLATE_CHANGED: "总结规则已更新，可恢复会话后重新归档",
};
const empty: MemoryFields = {
  title: "",
  content: "",
  kind: "PREFERENCE",
  expiresAt: null,
  subject: { kind: "MERCHANT" },
  productBasis: null,
};

/** 根据审核、有效期和商品当前版本给出实际可用状态。 */
function memoryLabel(item: MerchantMemory, products: MerchantCatalogEntry[]): string {
  if (item.status === "INACTIVE") return "已停用";
  if (!item.review || !item.subject || item.status === "CANDIDATE")
    return !item.subject
      ? "待审核 / 请选择归属"
      : item.subject.kind === "MERCHANT"
        ? "待审核 · 商家通用"
        : "待审核 · 商品限定";
  if (item.expiresAt && item.expiresAt <= new Date().toISOString()) return "已过期";
  if (item.subject.kind === "MERCHANT") return "有效 · 商家通用";
  const entryId = item.subject.productEntryId;
  const product = products.find((entry) => entry.entryId === entryId);
  if (product?.status !== "ACTIVE") return "商品不可用";
  if (
    item.productBasis &&
    (item.productBasis.revision !== product.revision || item.productBasis.sha256 !== product.sha256)
  )
    return `待复核商品版本 · ${product.name}`;
  return `有效 · ${product.name} · ${entryId}`;
}

/** 将 ISO 有效期转换为本地日期时间输入值。 */
function localDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** 展示可追溯的商家记忆、人工编辑和归档总结回执。 */
export function MemoryPanel({ merchantId }: { merchantId: string }) {
  const [items, setItems] = useState<MerchantMemory[]>([]);
  const [jobs, setJobs] = useState<MemoryJob[]>([]);
  const [products, setProducts] = useState<MerchantCatalogEntry[]>([]);
  const [draft, setDraft] = useState<MemoryFields>(empty);
  const [editing, setEditing] = useState<MerchantMemory | null>(null);
  const [expiry, setExpiry] = useState("");
  const [history, setHistory] = useState<MerchantMemory[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setJobs([]);
    setProducts([]);
    setEditing(null);
    setDraft(empty);
    setExpiry("");
    setHistory([]);
    setNotice("");
    /** 从持久状态刷新总结进度，页面切换后忽略旧商家的结果。 */
    const refresh = async () => {
      try {
        const [memories, tasks, catalog] = await Promise.all([
          api.listMemories(merchantId),
          api.listMemoryJobs(merchantId),
          api.listMerchantCatalog(merchantId),
        ]);
        if (!cancelled) {
          setItems(memories);
          setJobs(tasks);
          setProducts(catalog.filter((entry) => entry.kind === "PRODUCT"));
        }
      } catch (error) {
        if (!cancelled) setNotice(String(error));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [merchantId]);

  /** 写操作后立即刷新记忆及任务，而不依赖轮询。 */
  async function reload() {
    const [memories, tasks, catalog] = await Promise.all([
      api.listMemories(merchantId),
      api.listMemoryJobs(merchantId),
      api.listMerchantCatalog(merchantId),
    ]);
    setItems(memories);
    setJobs(tasks);
    setProducts(catalog.filter((entry) => entry.kind === "PRODUCT"));
  }

  /** 保存人工条目或确认已核对的候选，编辑受版本 CAS 保护。 */
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const input = { ...draft, expiresAt: expiry ? new Date(expiry).toISOString() : null };
      if (editing)
        await api.updateMemory(merchantId, editing.memoryId, {
          ...input,
          expectedRevision: editing.revision,
          status: "ACTIVE",
        });
      else await api.createMemory(merchantId, input);
      setDraft(empty);
      setEditing(null);
      setExpiry("");
      await reload();
      setNotice("记忆已保存；之后受理的任务会使用新版本。人工档案保持独立，冲突时需核对。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 停用只影响新任务召回，历史版本保留供审计。 */
  async function disable(item: MerchantMemory) {
    if (busy) return;
    setBusy(true);
    try {
      await api.updateMemory(merchantId, item.memoryId, {
        title: item.title,
        content: item.content,
        kind: item.kind,
        expiresAt: item.expiresAt,
        expectedRevision: item.revision,
        status: "INACTIVE",
      });
      if (editing?.memoryId === item.memoryId) {
        setEditing(null);
        setDraft(empty);
        setExpiry("");
      }
      await reload();
      setNotice("已停用；后续记忆召回会排除它，历史对话与快照仍保留。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 展开不可变版本历史及来源。 */
  async function showHistory(item: MerchantMemory) {
    try {
      setHistory(await api.memoryHistory(merchantId, item.memoryId));
    } catch (error) {
      setNotice(String(error));
    }
  }

  /** 重试失败总结，保持原来源范围不变。 */
  async function retry(job: MemoryJob) {
    setBusy(true);
    try {
      await api.retryMemoryJob(merchantId, job.jobId);
      await reload();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 恢复会话后打开原对话，已有总结保持可追溯。 */
  async function restore(job: MemoryJob) {
    setBusy(true);
    try {
      await api.restoreSession(job.sessionId);
      window.location.assign(`/sessions/${encodeURIComponent(job.sessionId)}`);
    } catch (error) {
      setNotice(String(error));
      setBusy(false);
    }
  }

  return (
    <section className="surface-card merchant-form memory-panel">
      <h2>商家记忆</h2>
      <p className="muted">
        “记住：……”和归档总结都会生成待审核候选。核对内容、选择商家通用或具体商品并保存后，后续任务才会引用。未指定商品的商家会话仅使用商家通用记忆。
      </p>
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      <form className="merchant-form" onSubmit={(event) => void save(event)}>
        <h3>{editing ? `编辑 / 确认记忆 · 第 ${editing.revision} 版` : "新增长期记忆"}</h3>
        <label>
          主题
          <input
            value={draft.title}
            maxLength={120}
            required
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </label>
        <label>
          类型
          <select
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryKind })}
          >
            {Object.entries(kinds).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          适用对象
          <select
            required
            aria-label="适用对象"
            value={
              draft.subject?.kind === "MERCHANT"
                ? "MERCHANT"
                : draft.subject?.kind === "PRODUCT"
                  ? draft.subject.productEntryId
                  : ""
            }
            onChange={(event) =>
              setDraft({
                ...draft,
                subject:
                  event.target.value === "MERCHANT"
                    ? { kind: "MERCHANT" }
                    : { kind: "PRODUCT", productEntryId: event.target.value },
                productBasis: null,
              })
            }
          >
            <option value="" disabled>
              请选择适用对象
            </option>
            <option value="MERCHANT">商家通用</option>
            {products.map((product) => (
              <option key={product.entryId} value={product.entryId} disabled={product.status !== "ACTIVE"}>
                {product.name} · {product.entryId}
                {product.status !== "ACTIVE" ? "（已停用）" : ""}
              </option>
            ))}
          </select>
        </label>
        {draft.subject?.kind === "PRODUCT" && (
          <label>
            <input
              type="checkbox"
              checked={Boolean(draft.productBasis)}
              onChange={(event) => {
                const entryId = draft.subject?.kind === "PRODUCT" ? draft.subject.productEntryId : "";
                const product = products.find((entry) => entry.entryId === entryId);
                setDraft({
                  ...draft,
                  productBasis:
                    event.target.checked && product
                      ? { entryId: product.entryId, revision: product.revision, sha256: product.sha256 }
                      : null,
                });
              }}
            />{" "}
            商品资料更新后需重新审核
            {draft.productBasis && <small>依据第 {draft.productBasis.revision} 版；重新勾选可核对当前商品版本。</small>}
          </label>
        )}
        <label>
          内容
          <textarea
            aria-label="内容"
            value={draft.content}
            maxLength={2000}
            required
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
        </label>
        <label>
          有效期（留空长期有效）
          <input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
        </label>
        <div className="prompt-actions">
          <button
            type="submit"
            className="primary-button compact"
            disabled={busy || !draft.title.trim() || !draft.content.trim() || !draft.subject}
          >
            {editing?.status === "CANDIDATE" ? "确认并保存" : "保存记忆"}
          </button>
          {editing && (
            <button
              type="button"
              className="outline-button"
              onClick={() => {
                setEditing(null);
                setDraft(empty);
                setExpiry("");
              }}
            >
              取消编辑
            </button>
          )}
        </div>
      </form>
      <ul className="merchant-links">
        {items.map((item) => (
          <li key={item.memoryId}>
            <div>
              <strong>{item.title}</strong>
              <small>
                {item.tier === "SHORT" ? "近期总结 · 模型归纳" : "长期记忆"} · {kinds[item.kind]} ·{" "}
                {memoryLabel(item, products)} · 第 {item.revision} 版
              </small>
              <p className="memory-text">{item.content}</p>
              <small>
                来源：
                {item.source.kind === "HUMAN"
                  ? "人工维护"
                  : item.source.kind === "USER_MESSAGE"
                    ? "用户明确要求保存"
                    : "归档会话提取"}{" "}
                · {item.source.quote}
              </small>
              {item.source.sessionId && (
                <a href={`/sessions/${encodeURIComponent(item.source.sessionId)}`}>查看来源会话</a>
              )}
              <small>
                {item.expiresAt ? `有效至 ${new Date(item.expiresAt).toLocaleString("zh-CN")}` : "长期有效"}
              </small>
            </div>
            <div className="prompt-actions">
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => {
                  setEditing(item);
                  setDraft({
                    title: item.title,
                    content: item.content,
                    kind: item.kind,
                    expiresAt: item.expiresAt,
                    subject: item.subject,
                    productBasis: item.productBasis ?? null,
                  });
                  setExpiry(localDate(item.expiresAt));
                }}
              >
                {!item.review || item.status === "CANDIDATE" ? "核对并确认" : "编辑"}
              </button>
              <button
                type="button"
                className="outline-button"
                disabled={busy || item.status === "INACTIVE"}
                onClick={() => void disable(item)}
              >
                {item.status === "CANDIDATE" ? "忽略" : "停用"}
              </button>
              <button type="button" className="outline-button" onClick={() => void showHistory(item)}>
                版本
              </button>
            </div>
          </li>
        ))}
      </ul>
      {!items.length && <p className="muted">还没有商家记忆。</p>}
      {history.length > 0 && (
        <details open>
          <summary>记忆版本历史</summary>
          {history.map((item) => (
            <p key={item.revision} className="memory-text">
              第 {item.revision} 版 · {item.status} · {new Date(item.updatedAt).toLocaleString("zh-CN")}
              <br />
              {item.content}
            </p>
          ))}
        </details>
      )}
      <h3>归档总结</h3>
      <p className="muted">
        归档仅生成待审核的总结和候选，人工确认后才能用于后续任务。附件原件不会因此获得读取权限。摘要最多覆盖近期{" "}
        {MEMORY_SOURCE_MESSAGE_LIMIT} 条、共 {MEMORY_SOURCE_TEXT_LIMIT}
        字；截取范围显示在任务中。
      </p>
      {jobs.map((job) => (
        <article className="memory-job" key={job.jobId}>
          <strong>
            {jobLabels[job.status]} · 第 {job.attempt} 次尝试
          </strong>
          <p className="muted">
            覆盖 {job.sourceCount} 条 · 未纳入 {job.omittedCount} 条 · 截取 {job.truncatedCount} 条
            {job.errorCode ? ` · ${jobErrors[job.errorCode] ?? `${job.errorCode}：总结未完成，可重试`}` : ""}
          </p>
          {job.result && (
            <details>
              <summary>查看总结与引用原话</summary>
              <p className="memory-text">{job.result.overview}</p>
              {job.result.items.map((item) => (
                <p key={`${item.messageId}-${item.kind}-${item.quote}`}>
                  {item.kind === "USER_STATEMENT"
                    ? "用户陈述"
                    : item.kind === "AGENT_SUGGESTION"
                      ? "助手建议"
                      : "未决问题"}
                  ：{item.text}
                  <br />
                  <small>
                    原话：{item.quote} · {item.messageId}
                  </small>
                </p>
              ))}
            </details>
          )}
          <div className="prompt-actions">
            {job.status === "FAILED" && (
              <button type="button" className="outline-button" disabled={busy} onClick={() => void retry(job)}>
                重试总结
              </button>
            )}
            <button type="button" className="outline-button" disabled={busy} onClick={() => void restore(job)}>
              恢复并打开会话
            </button>
            <a href={`/sessions/${encodeURIComponent(job.sessionId)}`}>查看会话</a>
          </div>
        </article>
      ))}
      {!jobs.length && <p className="muted">归档商家会话后，可在这里查看总结进度。</p>}
    </section>
  );
}

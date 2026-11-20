import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  MerchantCatalogEntry,
  MerchantCatalogInput,
  MerchantDetail,
  PublicPageEvidenceRecord,
  SessionRecord,
} from "../../../shared/contracts.js";
import type { ResearchScope } from "../../../shared/research.js";
import * as api from "../../api/client.js";
import { sessionDraftKey } from "../chat/session-draft.js";

const emptyEntry: MerchantCatalogInput = {
  kind: "PRODUCT",
  name: "",
  detail: "",
  sourceUrl: null,
  evidenceId: null,
  observedAt: null,
};
const kindLabels: Record<MerchantCatalogInput["kind"], string> = {
  PRODUCT: "商品/服务",
  KEYWORD: "关键词",
  TREND: "热点线索",
  COMPETITOR: "竞品内容线索",
  MERCHANT_UPDATE: "商家动态",
};
type AnalysisGoal = "TOPIC" | "DIAGNOSIS" | "KEYWORDS" | "TRENDS" | "COMPETITORS";

/** 为商家提供商品库、选题线索和两种会话创作入口。 */
export function MerchantContentStart({
  detail,
  evidence,
  onSessionCreated,
  isActive = true,
}: {
  detail: MerchantDetail;
  evidence: PublicPageEvidenceRecord[];
  onSessionCreated: (session: SessionRecord) => void;
  isActive?: boolean;
}) {
  const navigate = useNavigate();
  const merchantId = detail.merchant.merchantId;
  const [items, setItems] = useState<MerchantCatalogEntry[]>([]);
  const [entry, setEntry] = useState<MerchantCatalogInput>(emptyEntry);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mode, setMode] = useState<"PRODUCT" | "ANALYSIS">("PRODUCT");
  const [analysisGoal, setAnalysisGoal] = useState<AnalysisGoal>("TOPIC");
  const [productId, setProductId] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [accountUrl, setAccountUrl] = useState("");
  const [researchFocus, setResearchFocus] = useState("");
  const [windowDays, setWindowDays] = useState(30);
  const [linkSourceIds, setLinkSourceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pendingStart = useRef<{ signature: string; session: SessionRecord | null; key: string } | null>(null);
  const entryFormRef = useRef<HTMLFormElement>(null);
  const entryNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isActive) return;
    let active = true;
    setItems([]);
    void api.listMerchantCatalog(merchantId).then(
      (result) => {
        if (!active) return;
        setItems(result);
        const available = new Set(result.filter((item) => item.status === "ACTIVE").map((item) => item.entryId));
        setProductId((current) => (available.has(current) ? current : ""));
        setSourceIds((current) => current.filter((id) => available.has(id)));
      },
      (error: unknown) => {
        if (active) setNotice(String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [merchantId, isActive]);

  /** 打开当前商家的商品创建表单，并将焦点移至商品名称。 */
  function startProductEntry() {
    if (busy) return;
    setEntry(emptyEntry);
    setEditingId(null);
    setNotice("");
    entryFormRef.current?.scrollIntoView({ block: "start" });
    entryNameRef.current?.focus({ preventScroll: true });
  }

  /** 保存用户确认的条目，保留来源和历史版本。 */
  async function saveEntry(event: FormEvent) {
    event.preventDefault();
    if (busy || !entry.name.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const current = items.find((item) => item.entryId === editingId);
      if (current) await api.updateMerchantCatalogEntry(merchantId, current.entryId, current.revision, entry, "ACTIVE");
      else await api.createMerchantCatalogEntry(merchantId, entry);
      setItems(await api.listMerchantCatalog(merchantId));
      setEntry(emptyEntry);
      setEditingId(null);
      setNotice(
        entry.kind === "PRODUCT"
          ? `商品已保存，所属商家：${detail.merchant.name}。可在上方选择该商品开始创作。`
          : "已保存。热点和竞品线索在取得公开证据前仅作为待核实线索。",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 停用一条商品或线索，保留已受理会话的旧版快照。 */
  async function archiveEntry(item: MerchantCatalogEntry) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await api.updateMerchantCatalogEntry(
        merchantId,
        item.entryId,
        item.revision,
        {
          kind: item.kind,
          name: item.name,
          detail: item.detail,
          sourceUrl: item.sourceUrl,
          evidenceId: item.evidenceId,
          observedAt: item.observedAt,
        },
        "INACTIVE",
      );
      setItems(await api.listMerchantCatalog(merchantId));
      if (productId === item.entryId) setProductId("");
      setSourceIds((current) => current.filter((id) => id !== item.entryId));
      setNotice("条目已停用；历史版本仍可供已受理任务读取。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 创建关联商家的会话，并把所选分支及冻结条目 ID 放入待发送草稿。 */
  async function start() {
    const product = items.find(
      (item) => item.entryId === productId && item.kind === "PRODUCT" && item.status === "ACTIVE",
    );
    if (busy || (mode === "PRODUCT" && !product)) return;
    setBusy(true);
    setNotice("");
    try {
      const researchScope: ResearchScope | undefined =
        mode === "ANALYSIS" && ["KEYWORDS", "TRENDS", "COMPETITORS"].includes(analysisGoal)
          ? {
              goal: analysisGoal as ResearchScope["goal"],
              focus: researchFocus.trim(),
              windowDays,
              productId: product?.entryId ?? null,
              catalogSourceIds: sourceIds,
              linkSourceIds,
            }
          : undefined;
      const signature = JSON.stringify({ mode, analysisGoal, productId, sourceIds, accountUrl, researchScope });
      if (pendingStart.current?.signature !== signature)
        pendingStart.current = { signature, session: null, key: crypto.randomUUID() };
      const pending = pendingStart.current;
      const session =
        pending.session ?? (await api.createMerchantSession(merchantId, researchScope, `${pending.key}:session`));
      if (!pending.session) {
        pending.session = session;
        onSessionCreated(session);
      }
      const productRef = product
        ? `商品：${product.name}（条目 ${product.entryId}，第 ${product.revision} 版）。请调用 merchant_catalog_get 核对本轮冻结的完整商品事实。`
        : "本次面向商家整体业务，不限定单个商品；未确认的商品事实列为缺口。";
      const account = accountUrl.trim()
        ? `\n请调用 public_page_collect 读取我给出的小红书账号/笔记：${accountUrl.trim()}；账号主页请开启 includeRecentNotes 读取可见的前五篇笔记和评论。`
        : "";
      const selectedSources = items.filter((item) => sourceIds.includes(item.entryId));
      const sources = selectedSources.length
        ? `\n本轮选用的选题线索：${selectedSources
            .map(
              (item) =>
                `${item.name}（${item.entryId}，第 ${item.revision} 版；${item.provenance}）${item.sourceUrl ? ` ${item.sourceUrl}` : ""}`,
            )
            .join("；")}。仅对我本轮给出的可采集小红书链接调用 public_page_collect；失败时说明缺口。`
        : "";
      const researchPrompt: Partial<Record<AnalysisGoal, string>> = {
        KEYWORDS:
          "请为这家商家挖掘小红书关键词：先读取 xhs-market-research 的关键词规则与本轮商家资料，再用 xhs_public_search 核实当前业务相关的候选词。按类别、意图、证据和定性优先级交付；没有搜索量就标记未知，不要编造热度。",
        TRENDS:
          "请发现这家商家可用的近期小红书话题：先读取 xhs-market-research 的近期话题规则，再用 xhs_public_search 取可见样本并核对实际发布时间。区分近期话题候选和平台热点；没有连续数据不声称上升趋势。",
        COMPETITORS:
          "请比较这家商家与已登记竞品的公开内容差异：先读取 xhs-market-research 的竞品规则，调用 merchant_catalog_get 与 merchant_links_list 找到本轮冻结的来源 ID，再用 merchant_source_collect 核实双方实际可见的笔记。列出样本和证据；缺少本方账号或竞品链接时说明缺口，不算虚假的差异分。",
      };
      let prompt =
        mode === "PRODUCT"
          ? `请根据我选中的商品直接创作一篇小红书宣传文案，先交付可修改草稿。${productRef} 不要编造价格、功效或优惠。`
          : analysisGoal === "DIAGNOSIS"
            ? `请诊断这家商家的小红书账号与现有素材的问题，区分公开观察、推断和缺失数据，逐项说明证据与可执行改进建议；必要时再给出选题方向。${productRef}${account}${sources}`
            : researchPrompt[analysisGoal]
              ? `${researchPrompt[analysisGoal]}${productRef}${account}${sources}`
              : `请分析这家商家的小红书内容机会并规划 3—5 个可选择的选题；按需使用本轮冻结的关键词、热点线索、竞品内容线索、商家动态和历史内容。请调用 merchant_catalog_get 核对所用条目，列出来源 ID、时间和待核实项；没有公开证据时不得声称已抓取热点或比较竞品。本轮只做选题，等我选一条再创作。${productRef}${account}${sources}`;
      if (researchScope)
        prompt += `\n按本轮冻结研究范围执行：重点是${researchScope.focus || "结合商家目标寻找内容机会"}；观察最近 ${windowDays} 天，发布时间不可见时说明缺口。先说明搜索/对标选择与商家的关系，再采集；调用 xhs_public_search 时填写 purpose。每项候选说明商家关联、适用客群、内容角度、证据和限制，调用 merchant_research_save 保存候选或无结果的缺口；不代替我采用。`;
      if (mode === "ANALYSIS" && analysisGoal === "TOPIC")
        prompt +=
          "\n请用 merchant_research_get(format=REPORT) 读取本轮已采用研究简报，再按需核对条目；优先使用与商家目标相关、未过期且资料未变化的来源，保留条目 ID 和版本。";
      if (mode === "PRODUCT") {
        const job = await api.createTextGenerationJob(
          session.sessionId,
          {
            title: `${product?.name ?? "商品"} · 小红书图文`,
            brief: prompt,
            productEntryId: product?.entryId,
          },
          pending.key,
        );
        pendingStart.current = null;
        navigate(`/sessions/${session.sessionId}?studio=1&job=${job.jobId}`);
        return;
      }
      if (analysisGoal === "TOPIC") {
        await api.createTopicPlan(session.sessionId, { brief: prompt, allowStale: false }, pending.key);
        pendingStart.current = null;
        navigate(`/sessions/${session.sessionId}?studio=1`);
        return;
      }
      pendingStart.current = null;
      sessionStorage.setItem(sessionDraftKey(session.sessionId), prompt);
      navigate(`/sessions/${session.sessionId}`, { state: { compose: prompt } });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const products = items.filter((item) => item.kind === "PRODUCT" && item.status === "ACTIVE");
  return (
    <section id="merchant-catalog" className="surface-card merchant-form">
      <h2>商品库与内容创作</h2>
      <p className="muted">当前商家：{detail.merchant.name}。在这里创建的商品会自动绑定此商家。</p>
      <button type="button" className="outline-button" disabled={busy} onClick={startProductEntry}>
        ＋ 新增商品
      </button>
      <p className="muted">直接选商品创作，或先做账号/素材诊断与内容分析。诊断报告可保留，不是创作的必经步骤。</p>
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      <div className="prompt-actions">
        <label>
          <input type="radio" name="content-mode" checked={mode === "PRODUCT"} onChange={() => setMode("PRODUCT")} />{" "}
          选商品直接创作
        </label>
        <label>
          <input type="radio" name="content-mode" checked={mode === "ANALYSIS"} onChange={() => setMode("ANALYSIS")} />{" "}
          先分析/诊断，再选题创作
        </label>
      </div>
      {mode === "ANALYSIS" && (
        <label>
          本轮目标
          <select value={analysisGoal} onChange={(event) => setAnalysisGoal(event.target.value as AnalysisGoal)}>
            <option value="TOPIC">内容分析与选题规划</option>
            <option value="DIAGNOSIS">账号与素材问题诊断</option>
            <option value="KEYWORDS">关键词挖掘（公开样本）</option>
            <option value="TRENDS">近期话题发现（公开样本）</option>
            <option value="COMPETITORS">竞品内容差异（已登记来源）</option>
          </select>
        </label>
      )}
      {mode === "ANALYSIS" && ["KEYWORDS", "TRENDS", "COMPETITORS"].includes(analysisGoal) && (
        <fieldset>
          <legend>本次商家研究范围</legend>
          <p className="muted">
            使用当前商家的行业、地域、客群和已确认服务；只需补充本次重点。研究建议不会自动变成商家事实。
          </p>
          <label>
            本次重点（可选）
            <input
              value={researchFocus}
              maxLength={500}
              placeholder="例如：吸引附近上班族，寻找搬家清洁选题"
              onChange={(event) => setResearchFocus(event.target.value)}
            />
          </label>
          <label>
            观察时间范围
            <select value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value))}>
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
            </select>
          </label>
          {detail.links
            .filter((item) => ["ACCOUNT", "REFERENCE"].includes(item.kind))
            .map((item) => (
              <label key={item.linkId}>
                <input
                  type="checkbox"
                  checked={linkSourceIds.includes(item.linkId)}
                  onChange={(event) =>
                    setLinkSourceIds((current) =>
                      event.target.checked ? [...current, item.linkId] : current.filter((id) => id !== item.linkId),
                    )
                  }
                />
                {item.kind === "ACCOUNT" ? "本方账号" : "参考来源"}：{item.label || item.url}
              </label>
            ))}
          {analysisGoal === "COMPETITORS" && (
            <p className="muted">勾选本方账号及下方竞品线索；缺少任一方实际内容时只报告缺口，不生成差异结论。</p>
          )}
        </fieldset>
      )}
      {mode === "ANALYSIS" && items.some((item) => item.kind !== "PRODUCT") && (
        <fieldset>
          <legend>本轮选用的关键词、热点、竞品或商家动态</legend>
          {items
            .filter((item) => item.kind !== "PRODUCT")
            .map((item) => (
              <label key={item.entryId}>
                <input
                  type="checkbox"
                  checked={sourceIds.includes(item.entryId)}
                  onChange={(event) =>
                    setSourceIds((current) =>
                      event.target.checked ? [...current, item.entryId] : current.filter((id) => id !== item.entryId),
                    )
                  }
                />{" "}
                {kindLabels[item.kind]}：{item.name}
              </label>
            ))}
        </fieldset>
      )}
      <label>
        {mode === "PRODUCT" ? "选择商品/服务" : "关联商品/服务（可选）"}
        <select value={productId} onChange={(event) => setProductId(event.target.value)}>
          <option value="">{products.length ? "请选择" : "商品库暂无条目"}</option>
          {products.map((item) => (
            <option key={item.entryId} value={item.entryId}>
              {item.name} · 第 {item.revision} 版
            </option>
          ))}
        </select>
      </label>
      {!products.length && <p className="muted">当前商家暂无商品，点击“新增商品”填写并保存后，即可在此选择。</p>}
      {mode === "ANALYSIS" && (
        <label>
          小红书账号/笔记链接（可选，填写后本轮可采集）
          <input
            type="url"
            value={accountUrl}
            placeholder="https://www.xiaohongshu.com/..."
            onChange={(event) => setAccountUrl(event.target.value)}
          />
        </label>
      )}
      <button
        type="button"
        className="primary-button compact"
        disabled={busy || (mode === "PRODUCT" && !productId)}
        onClick={() => void start()}
      >
        {mode === "PRODUCT"
          ? "开始商品创作"
          : analysisGoal === "DIAGNOSIS"
            ? "开始问题诊断"
            : ["KEYWORDS", "TRENDS", "COMPETITORS"].includes(analysisGoal)
              ? "开始公开资料研究"
              : "开始内容分析"}
      </button>
      <h3>商品库与选题来源</h3>
      <p className="muted">
        关键词、近期话题和竞品研究可读取有限公开样本；研究结论留在会话中。目录仍由用户维护，只有关联本商家采集证据 ID
        的条目才标记为已核实。
      </p>
      {items.length ? (
        <ul className="merchant-links">
          {items.map((item) => (
            <li key={item.entryId}>
              <div>
                <strong>{item.name}</strong>
                <small>
                  {kindLabels[item.kind]} · 第 {item.revision} 版 ·{" "}
                  {item.provenance === "PUBLIC_EVIDENCE"
                    ? "关联公开证据"
                    : item.provenance === "MERCHANT_CONFIRMED"
                      ? "商家确认"
                      : "用户线索，待核实"}
                </small>
                {item.detail && <p>{item.detail}</p>}
                {item.sourceUrl && (
                  <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                    来源链接
                  </a>
                )}
              </div>
              <div className="prompt-actions">
                <button
                  type="button"
                  className="outline-button"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(item.entryId);
                    setEntry({
                      kind: item.kind,
                      name: item.name,
                      detail: item.detail,
                      sourceUrl: item.sourceUrl,
                      evidenceId: item.evidenceId,
                      observedAt: item.observedAt,
                    });
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="outline-button"
                  disabled={busy}
                  onClick={() => void archiveEntry(item)}
                >
                  停用
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">暂无商品和选题线索；请先添加商品，或在分析分支中提供账号链接。</p>
      )}
      <form ref={entryFormRef} className="merchant-link-form" onSubmit={(event) => void saveEntry(event)}>
        <h3>{`${editingId ? "编辑" : "新增"}${kindLabels[entry.kind]}`}</h3>
        <label>
          所属商家
          <input value={detail.merchant.name} readOnly />
        </label>
        <label>
          类型
          <select
            value={entry.kind}
            disabled={Boolean(editingId)}
            onChange={(event) => setEntry({ ...entry, kind: event.target.value as MerchantCatalogInput["kind"] })}
          >
            {Object.entries(kindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {entry.kind === "PRODUCT" ? "商品名称" : "名称"}
          <input
            ref={entryNameRef}
            value={entry.name}
            maxLength={120}
            required
            onChange={(event) => setEntry({ ...entry, name: event.target.value })}
          />
        </label>
        <label>
          {entry.kind === "PRODUCT" ? "已确认卖点与限制" : "内容与说明"}
          <textarea
            value={entry.detail}
            maxLength={2000}
            onChange={(event) => setEntry({ ...entry, detail: event.target.value })}
          />
        </label>
        <label>
          来源链接（可选）
          <input
            type="url"
            value={entry.sourceUrl ?? ""}
            onChange={(event) => setEntry({ ...entry, sourceUrl: event.target.value || null })}
          />
        </label>
        <label>
          公开证据（可选，选用后将核对来源与采集时间）
          <select
            value={entry.evidenceId ?? ""}
            onChange={(event) => {
              const selected = evidence.find((item) => item.evidenceId === event.target.value);
              setEntry({
                ...entry,
                evidenceId: selected?.evidenceId ?? null,
                sourceUrl: selected?.sourceUrl ?? entry.sourceUrl,
                observedAt: selected?.collectedAt ?? entry.observedAt,
              });
            }}
          >
            <option value="">未关联公开证据</option>
            {evidence
              .filter((item) => item.status === "COLLECTED")
              .map((item) => (
                <option key={item.evidenceId} value={item.evidenceId}>
                  {item.title || item.sourceUrl} · {item.evidenceId}
                </option>
              ))}
          </select>
        </label>
        {entry.kind !== "PRODUCT" && (
          <label>
            线索观察时间（可选）
            <input
              type="datetime-local"
              value={entry.observedAt ? entry.observedAt.slice(0, 16) : ""}
              onChange={(event) =>
                setEntry({
                  ...entry,
                  observedAt: event.target.value ? new Date(event.target.value).toISOString() : null,
                })
              }
            />
          </label>
        )}
        <button type="submit" className="primary-button compact" disabled={busy || !entry.name.trim()}>
          {editingId ? "保存修订" : entry.kind === "PRODUCT" ? "创建商品并绑定商家" : "添加条目"}
        </button>
        {editingId && (
          <button
            type="button"
            className="outline-button"
            onClick={() => {
              setEditingId(null);
              setEntry(emptyEntry);
            }}
          >
            取消编辑
          </button>
        )}
      </form>
    </section>
  );
}

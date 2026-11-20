import { type FormEvent, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  AccountDiagnosisRecord,
  MerchantDetail,
  MerchantLinkInput,
  MerchantProfileFields,
  MerchantRecord,
  PublicDiagnosisReportRecord,
  PublicPageEvidenceRecord,
  SessionRecord,
} from "../../../shared/contracts.js";
import * as api from "../../api/client.js";
import { Icon, Modal } from "../../components/ui.js";
import { DashboardPage } from "../dashboard/dashboard-page.js";
import { ResearchPanel } from "../research/research-panel.js";
import { MediaLibrary } from "./media-library.js";
import { MemoryPanel } from "./memory-panel.js";
import { MerchantContentStart } from "./merchant-content-start.js";
import { ProductsPage } from "./products-page.js";

const profileLabels: Array<[keyof MerchantProfileFields, string]> = [
  ["name", "商家名称"],
  ["industry", "行业"],
  ["serviceArea", "服务地区"],
  ["products", "产品与服务"],
  ["audience", "目标客群"],
  ["goals", "经营目标"],
  ["voice", "品牌语气"],
  ["constraints", "运营限制"],
];
const profileLimits: Record<keyof MerchantProfileFields, number> = {
  name: 120,
  industry: 300,
  serviceArea: 500,
  products: 2000,
  audience: 1000,
  goals: 1000,
  voice: 500,
  constraints: 2000,
};
const emptyLink: MerchantLinkInput = { platform: "", kind: "ACCOUNT", url: "", label: "" };
const linkKinds: Array<{ value: MerchantLinkInput["kind"]; label: string }> = [
  { value: "ACCOUNT", label: "账号" },
  { value: "SHOP", label: "店铺" },
  { value: "PRODUCT", label: "商品" },
  { value: "CONTENT", label: "内容" },
  { value: "REFERENCE", label: "参考" },
];
const evidenceStatusLabels: Record<PublicPageEvidenceRecord["status"], string> = {
  COLLECTED: "已采集可见内容",
  LIMITED: "仅取得少量内容",
  BLOCKED: "访问受限",
  FAILED: "读取失败",
};
const evidenceAccessModeLabels: Record<PublicPageEvidenceRecord["accessMode"], string> = {
  PUBLIC_UNAUTHENTICATED: "无登录访问",
  USER_AUTHORIZED: "用户授权 Chrome 访问",
};

interface MerchantPageProps {
  merchantId?: string;
  modelConfigured?: boolean;
  onSessionCreated: (session: SessionRecord) => void;
}

/** 商家资料由人工维护；公开取证和诊断草稿另行保存。 */
export function MerchantPage({ merchantId, onSessionCreated, modelConfigured = false }: MerchantPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [tab, setTab] = useState("profile");
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!merchantId) {
      setTab("profile");
      return;
    }
    const requested = new URLSearchParams(location.search).get("tab");
    setTab(
      requested && ["profile", "products", "sources", "media", "content", "memory"].includes(requested)
        ? requested
        : location.hash === "#merchant-catalog"
          ? "products"
          : "profile",
    );
  }, [merchantId, location.search, location.hash]);
  const [merchants, setMerchants] = useState<MerchantRecord[]>([]);
  const [detail, setDetail] = useState<MerchantDetail | null>(null);
  const [evidence, setEvidence] = useState<PublicPageEvidenceRecord[]>([]);
  const [diagnoses, setDiagnoses] = useState<AccountDiagnosisRecord[]>([]);
  const [reports, setReports] = useState<PublicDiagnosisReportRecord[]>([]);
  const [profile, setProfile] = useState<MerchantProfileFields | null>(null);
  const [newName, setNewName] = useState("");
  const [link, setLink] = useState<MerchantLinkInput>(emptyLink);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    setNotice("");
    if (!merchantId) {
      setDetail(null);
      setEvidence([]);
      setDiagnoses([]);
      setReports([]);
      void api
        .listMerchants()
        .then((items) => {
          if (!cancelled) setMerchants(items);
        })
        .catch((error: unknown) => {
          if (!cancelled) setNotice(String(error));
        });
    } else {
      void Promise.all([
        api.getMerchant(merchantId),
        api.listPublicEvidence(merchantId),
        api.listAccountDiagnoses(merchantId),
        api.listPublicDiagnosisReports(merchantId),
      ])
        .then(([item, publicEvidence, accountDiagnoses, publicReports]) => {
          if (cancelled) return;
          setDetail(item);
          setProfile(item.profile.fields);
          setEvidence(publicEvidence);
          setDiagnoses(accountDiagnoses);
          setReports(publicReports);
        })
        .catch((error: unknown) => {
          if (!cancelled) setNotice(String(error));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [merchantId]);

  /** 创建商家并进入新商家页面。 */
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!newName.trim() || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const item = await api.createMerchant(newName.trim());
      setNewName("");
      navigate(`/merchants/${item.merchant.merchantId}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 提交人工档案修订并处理版本冲突。 */
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!detail || !profile || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const item = await api.updateMerchantProfile(detail.merchant.merchantId, detail.profile.revision, profile);
      setDetail(item);
      setProfile(item.profile.fields);
      setNotice(`档案已保存为第 ${item.profile.revision} 版。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 创建或更新商家平台链接。 */
  async function saveLink(event: FormEvent) {
    event.preventDefault();
    if (!detail || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const current = detail.links.find((item) => item.linkId === editingLinkId);
      if (current) await api.updateMerchantLink(detail.merchant.merchantId, current.linkId, current.revision, link);
      else await api.createMerchantLink(detail.merchant.merchantId, link);
      const fresh = await api.getMerchant(detail.merchant.merchantId);
      setDetail(fresh);
      setLink(emptyLink);
      setEditingLinkId(null);
      // 保存链接只是登记入口，实际页面内容只能由独立取证记录证明。
      setNotice("平台链接已保存；实际读取结果请查看取证记录。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 停用商家平台链接并刷新列表。 */
  async function disableLink(linkId: string, revision: number) {
    if (!detail || busy) return;
    setBusy(true);
    setNotice("");
    try {
      await api.disableMerchantLink(detail.merchant.merchantId, linkId, revision);
      setDetail(await api.getMerchant(detail.merchant.merchantId));
      if (editingLinkId === linkId) {
        setEditingLinkId(null);
        setLink(emptyLink);
      }
      setNotice("链接已停用；历史会话的运行快照不受影响。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 创建归属于当前商家的会话并打开。 */
  async function newMerchantSession() {
    if (!detail || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const session = await api.createMerchantSession(detail.merchant.merchantId);
      onSessionCreated(session);
      navigate(`/sessions/${session.sessionId}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 重新加载商家的公开证据、草稿和固定报告。 */
  async function refreshFindings() {
    if (!merchantId || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const [publicEvidence, accountDiagnoses, publicReports] = await Promise.all([
        api.listPublicEvidence(merchantId),
        api.listAccountDiagnoses(merchantId),
        api.listPublicDiagnosisReports(merchantId),
      ]);
      setEvidence(publicEvidence);
      setDiagnoses(accountDiagnoses);
      setReports(publicReports);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 用户选定一版草稿后导出有固定来源的公开资料报告。 */
  async function publishReport(diagnosisId: string) {
    if (!merchantId || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const report = await api.publishPublicDiagnosisReport(merchantId, diagnosisId);
      setReports(await api.listPublicDiagnosisReports(merchantId));
      setNotice(`公开资料报告已生成：${report.reportId}。缺少经营数据的范围已写入报告。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!merchantId)
    return (
      <div className="page-content merchant-page">
        <div className="page-kicker">工作台 / 商家</div>
        <div className="page-heading">
          <div>
            <h1>商家信息库</h1>
            <p>选择商家可维护档案、创建商品并绑定该商家，供关联会话读取。</p>
          </div>
        </div>
        {notice && (
          <p className="error" role="alert">
            {notice}
          </p>
        )}
        <div className="filter-row">
          <div className="search-field">
            <Icon name="search" />
            <input
              placeholder="搜索商家"
              aria-label="搜索商家"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button type="button" className="primary-button" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            新增商家
          </button>
        </div>
        {adding && (
          <Modal title="新增商家" onClose={() => setAdding(false)}>
            {" "}
            <form className="surface-card merchant-form" onSubmit={(event) => void create(event)}>
              <h2>新增商家</h2>
              <label htmlFor="merchant-name">商家名称</label>
              <input
                id="merchant-name"
                value={newName}
                maxLength={120}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="输入商家名称"
              />
              <button type="submit" className="primary-button compact" disabled={busy || !newName.trim()}>
                创建商家
              </button>
            </form>
          </Modal>
        )}
        <section className="merchant-card-grid">
          {merchants.length ? (
            merchants
              .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
              .map((item) => (
                <button
                  key={item.merchantId}
                  type="button"
                  className="merchant-card"
                  onClick={() => navigate(`/merchants/${item.merchantId}`)}
                >
                  <span className="row-icon">▧</span>
                  <span className="row-main">
                    <strong>{item.name}</strong>
                    <small>档案第 {item.profileRevision} 版 · 查看商品库</small>
                  </span>
                  <span className="row-arrow">↗</span>
                </button>
              ))
          ) : (
            <div className="list-empty">
              <p>还没有商家。</p>
            </div>
          )}
        </section>
      </div>
    );

  return (
    <div className="page-content merchant-page">
      <div className="page-kicker">工作台 / 商家 / {detail?.merchant.name ?? "加载中"}</div>
      <div className="page-heading">
        <div>
          <h1>{detail?.merchant.name ?? "商家资料"}</h1>
          <p>档案和链接在消息受理时冻结为本轮上下文。</p>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={!detail || busy}
          onClick={() => void newMerchantSession()}
        >
          ＋ 新建关联此商家的会话
        </button>
      </div>
      <button type="button" className="text-link" onClick={() => navigate("/merchants")}>
        ← 返回商家列表
      </button>
      <nav className="page-tabs merchant-tabs" aria-label="商家资料分类">
        {[
          ["profile", "基础档案"],
          ["products", "商品与服务"],
          ["sources", "账号与资料"],
          ["media", "实拍素材"],
          ["content", "内容记录"],
          ["memory", "商家记忆"],
        ].map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={tab === value ? "active" : ""}
            onClick={() => navigate(`/merchants/${merchantId}?tab=${value ?? "profile"}`, { replace: true })}
          >
            {label}
          </button>
        ))}
      </nav>
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {detail && profile && (
        <>
          <div hidden={tab !== "profile"}>
            <form className="surface-card merchant-form" onSubmit={(event) => void saveProfile(event)}>
              <h2>基础档案 · 第 {detail.profile.revision} 版</h2>
              <p className="muted">
                来源：人工维护 · 保存于 {new Date(detail.profile.createdAt).toLocaleString("zh-CN")}
              </p>
              <div className="merchant-fields">
                {profileLabels.map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <textarea
                      value={profile[field]}
                      maxLength={profileLimits[field]}
                      onChange={(event) =>
                        setProfile((current) => (current ? { ...current, [field]: event.target.value } : current))
                      }
                    />
                  </label>
                ))}
              </div>
              <button type="submit" className="primary-button compact" disabled={busy || !profile.name.trim()}>
                保存档案
              </button>
            </form>
          </div>
          <div hidden={tab !== "memory"}>
            <MemoryPanel key={merchantId} merchantId={merchantId} />
          </div>
          <div hidden={tab !== "content"}>
            <DashboardPage merchants={[detail.merchant]} defaultMerchantId={merchantId} initialTab="tasks" />
            <MerchantContentStart
              key={detail.merchant.merchantId}
              detail={detail}
              isActive={tab === "content"}
              evidence={evidence}
              onSessionCreated={onSessionCreated}
            />
          </div>
          <div hidden={tab !== "products"}>
            <ProductsPage
              merchants={[detail.merchant]}
              defaultMerchantId={merchantId}
              embedded
              modelConfigured={modelConfigured}
              onSessionCreated={onSessionCreated}
            />
          </div>
          <div hidden={tab !== "media"}>
            <MediaLibrary merchantId={merchantId} />
          </div>
          <div hidden={tab !== "sources"}>
            <ResearchPanel key={`research:${merchantId}`} merchantId={detail.merchant.merchantId} />
            <section className="surface-card merchant-form">
              <h2>平台链接</h2>
              <p className="muted">来源：人工维护。链接只保存入口，实际读取结果见下方取证记录。</p>
              {detail.links.length ? (
                <ul className="merchant-links">
                  {detail.links.map((item) => (
                    <li key={item.linkId}>
                      <div>
                        <strong>{item.label || item.platform}</strong>
                        <small>
                          {item.platform} · {linkKinds.find((kind) => kind.value === item.kind)?.label}
                        </small>
                        <a href={item.url} target="_blank" rel="noreferrer">
                          {item.url}
                        </a>
                      </div>
                      <div className="prompt-actions">
                        <button
                          type="button"
                          className="outline-button"
                          disabled={busy}
                          onClick={() => {
                            setEditingLinkId(item.linkId);
                            setLink({ platform: item.platform, kind: item.kind, url: item.url, label: item.label });
                          }}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="outline-button"
                          disabled={busy}
                          onClick={() => void disableLink(item.linkId, item.revision)}
                        >
                          停用
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">尚无链接。</p>
              )}
              <form onSubmit={(event) => void saveLink(event)} className="merchant-link-form">
                <h3>{editingLinkId ? "编辑链接" : "新增链接"}</h3>
                <label>
                  平台
                  <input
                    value={link.platform}
                    maxLength={60}
                    required
                    onChange={(event) => setLink({ ...link, platform: event.target.value })}
                  />
                </label>
                <label>
                  类型
                  <select
                    value={link.kind}
                    onChange={(event) => setLink({ ...link, kind: event.target.value as MerchantLinkInput["kind"] })}
                  >
                    {linkKinds.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  网址
                  <input
                    type="url"
                    value={link.url}
                    maxLength={2048}
                    required
                    placeholder="https://"
                    onChange={(event) => setLink({ ...link, url: event.target.value })}
                  />
                </label>
                <label>
                  备注
                  <input
                    value={link.label}
                    maxLength={120}
                    onChange={(event) => setLink({ ...link, label: event.target.value })}
                  />
                </label>
                <div className="prompt-actions">
                  <button
                    type="submit"
                    className="primary-button compact"
                    disabled={busy || !link.platform.trim() || !link.url.trim()}
                  >
                    {editingLinkId ? "保存修改" : "添加链接"}
                  </button>
                  {editingLinkId && (
                    <button
                      type="button"
                      className="outline-button"
                      onClick={() => {
                        setEditingLinkId(null);
                        setLink(emptyLink);
                      }}
                    >
                      取消编辑
                    </button>
                  )}
                </div>
              </form>
            </section>
            <section className="surface-card merchant-form">
              <div className="list-head">
                <h2>公开取证与账号诊断</h2>
                <button type="button" className="outline-button" disabled={busy} onClick={() => void refreshFindings()}>
                  刷新记录
                </button>
              </div>
              <p className="muted">在关联该商家的会话中完成公开取证和账号诊断后，记录会显示在这里。</p>
              {evidence.length ? (
                <ul className="merchant-links">
                  {evidence.map((item) => (
                    <li key={item.evidenceId} id={`evidence-${item.evidenceId}`}>
                      <div>
                        <strong>{item.title || "公开页面"}</strong>
                        <small>
                          {evidenceStatusLabels[item.status]} ·{" "}
                          {evidenceAccessModeLabels[item.accessMode] ?? "访问方式未记录"} ·{" "}
                          {new Date(item.collectedAt).toLocaleString("zh-CN")}
                        </small>
                        <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                          {item.sourceUrl}
                        </a>
                        {item.finalUrl && item.finalUrl !== item.sourceUrl && <small>最终地址：{item.finalUrl}</small>}
                        <small>证据 ID：{item.evidenceId}</small>
                        <small title={item.visibleTextSha256 ?? ""}>
                          正文 SHA-256：
                          {item.visibleTextSha256 ? `${item.visibleTextSha256.slice(0, 12)}…` : "旧版未记录"}
                        </small>
                        {item.errorCode && <small>读取限制：{item.errorCode}</small>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">暂无公开取证记录。</p>
              )}
              {diagnoses.length ? (
                diagnoses.map((item) => (
                  <details key={item.diagnosisId}>
                    <summary>
                      账号诊断 DRAFT · v{item.version ?? 1} · {new Date(item.createdAt).toLocaleString("zh-CN")}
                    </summary>
                    {item.revisesDiagnosisId && <p className="muted">修订自：{item.revisesDiagnosisId}</p>}
                    <p className="muted">仅基于下列页面可见内容，可在会话中要求修订为新版本；不是完整经营诊断。</p>
                    {reports.some((report) => report.diagnosisId === item.diagnosisId) ? (
                      <p className="muted">此版本已导出为公开资料报告。</p>
                    ) : (
                      <button
                        type="button"
                        className="outline-button"
                        disabled={busy}
                        onClick={() => void publishReport(item.diagnosisId)}
                      >
                        导出此版公开资料报告
                      </button>
                    )}
                    <p>{item.report.summary}</p>
                    <h3>观察与推断</h3>
                    <ul>
                      {item.report.findings.map((finding) => (
                        <li key={`${finding.point}:${finding.evidenceIds.join(",")}`}>
                          {finding.kind === "OBSERVATION"
                            ? "直接观察"
                            : finding.kind === "INFERENCE"
                              ? "基于证据的推断"
                              : "旧版未分类"}
                          ：{finding.point}（证据：{finding.evidenceIds.join("、")}）
                        </li>
                      ))}
                    </ul>
                    <h3>建议</h3>
                    <ul>
                      {item.report.actions.map((action) => (
                        <li key={`${action.action}:${action.evidenceIds.join(",")}`}>
                          {action.action}（证据：{action.evidenceIds.join("、")}）
                        </li>
                      ))}
                    </ul>
                    {item.report.unknowns.length > 0 && <p>待核实：{item.report.unknowns.join("；")}</p>}
                    <h3>证据来源</h3>
                    <ul className="merchant-links">
                      {(item.evidenceRefs ?? []).map((ref) => (
                        <li key={ref.evidenceId}>
                          <div>
                            <a href={ref.sourceUrl} target="_blank" rel="noreferrer">
                              {ref.sourceUrl}
                            </a>
                            <small>
                              {evidenceAccessModeLabels[ref.accessMode]} ·{" "}
                              {new Date(ref.collectedAt).toLocaleString("zh-CN")}
                            </small>
                            <small title={ref.visibleTextSha256}>
                              正文 SHA-256：{ref.visibleTextSha256.slice(0, 12)}…
                            </small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))
              ) : (
                <p className="muted">暂无账号诊断草稿。</p>
              )}
              <h3>公开资料报告</h3>
              {reports.length ? (
                <ul className="merchant-links">
                  {reports.map((report) => (
                    <li key={report.reportId}>
                      <div>
                        <strong>公开资料诊断报告 · 来源草稿 v{report.sourceVersion}</strong>
                        <small>{new Date(report.createdAt).toLocaleString("zh-CN")} · 缺少经营数据</small>
                        <a
                          href={`/api/v1/merchants/${encodeURIComponent(report.merchantId)}/public-diagnosis-reports/${encodeURIComponent(report.reportId)}/content`}
                        >
                          下载 Markdown 报告
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">暂无已导出的公开资料报告。</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

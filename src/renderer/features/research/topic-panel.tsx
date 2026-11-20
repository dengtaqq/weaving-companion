import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ArtifactRecord, MerchantCatalogEntry, TextGenerationJobRecord } from "../../../shared/contracts.js";
import { normalizedResearchTitle, type ResearchReport } from "../../../shared/research.js";
import type { TopicCard, TopicCreationInput, TopicFields } from "../../../shared/topics.js";
import * as api from "../../api/client.js";

const MAX_REFERENCE_FILES = 5;
const MAX_TEXT_REFERENCE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_REFERENCE_BYTES = 8 * 1024 * 1024;

const jobLabels = { QUEUED: "等待执行", RUNNING: "Agent 执行中", READY_FOR_REVIEW: "结果已保存", FAILED: "失败" };
const errorLabels: Record<string, string> = {
  TOPIC_OUTPUT_INVALID: "选题格式或证据校验未通过，请重新生成",
  TOPIC_REVISION_CONFLICT: "选题已变化，请重新选择当前版本",
  TOPIC_REFERENCE_INVALID: "参考资料不可用，请重新选择",
  TEXT_RUN_CANCELLED: "任务已取消",
  TEXT_RUN_FAILED: "Agent 执行失败，请查看会话详情",
};

/** 从持久选题中提取可编辑内容，来源与权限字段不能由页面改写。 */
function topicFields(topic: TopicCard): TopicFields {
  return {
    title: topic.title,
    audience: topic.audience,
    angle: topic.angle,
    format: topic.format,
    merchantRelevance: topic.merchantRelevance,
    evidenceIds: topic.evidenceIds,
    materials: topic.materials,
    cautions: topic.cautions,
  };
}

/** 串接研究总结、选题编辑与文案任务，审核下载继续复用现有草稿面板。 */
export function TopicPanel({
  merchantId,
  sessionId,
  reports,
  modelConfigured,
  imageInputEnabled,
  sessionWritable,
  onContentCreated,
}: {
  merchantId: string;
  sessionId?: string;
  reports: ResearchReport[];
  modelConfigured: boolean;
  imageInputEnabled: boolean;
  sessionWritable: boolean;
  onContentCreated?: (job: TextGenerationJobRecord) => void;
}) {
  const [planningBrief, setPlanningBrief] = useState("");
  const [topics, setTopics] = useState<TopicCard[]>([]);
  const [jobs, setJobs] = useState<TextGenerationJobRecord[]>([]);
  const [products, setProducts] = useState<MerchantCatalogEntry[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [selected, setSelected] = useState<TopicCard | null>(null);
  const [fields, setFields] = useState<TopicFields | null>(null);
  const [creating, setCreating] = useState(false);
  const [productId, setProductId] = useState("");
  const [templateId, setTemplateId] = useState<TopicCreationInput["templateId"]>("FREE");
  const [styleMode, setStyleMode] = useState<TopicCreationInput["styleMode"]>("NONE");
  const [styleBrief, setStyleBrief] = useState("");
  const [brief, setBrief] = useState("");
  const [channel, setChannel] = useState("小红书");
  const [refs, setRefs] = useState<string[]>([]);
  const [sourceReviewed, setSourceReviewed] = useState(false);
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [referencesReady, setReferencesReady] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const editor = useRef<HTMLDivElement>(null);
  const pending = useRef(new Map<string, string>());
  const scope = `${merchantId}:${sessionId ?? ""}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const canEdit = !!sessionId && sessionWritable;
  const canGenerate = canEdit && modelConfigured;
  const textReferenceCount = artifacts.filter(
    (item) => refs.includes(item.artifactId) && item.mimeType === "text/plain",
  ).length;
  const imageReferenceCount = refs.length - textReferenceCount;
  const hasTooManyReferences = textReferenceCount > MAX_REFERENCE_FILES || imageReferenceCount > MAX_REFERENCE_FILES;

  /** 同参重试复用命令键，成功后新的明确操作可创建另一份稿件。 */
  function commandKey(signature: string): string {
    if (!pending.current.has(signature)) pending.current.set(signature, crypto.randomUUID());
    return pending.current.get(signature) as string;
  }

  /** 重读选题与任务，刷新或重新打开页面不依赖本地临时结果。 */
  async function refresh() {
    const [nextTopics, nextJobs] = await Promise.all([
      api.listTopics(merchantId, sessionId),
      sessionId ? api.listTextGenerationJobs(sessionId) : Promise.resolve([]),
    ]);
    if (activeScope.current !== scope) return;
    setTopics(nextTopics);
    setJobs(nextJobs);
  }

  useEffect(() => {
    let active = true;
    /** 定期回读真实状态，失败不伪造完成结果。 */
    async function poll() {
      try {
        const [nextTopics, nextJobs, nextProducts, nextArtifacts] = await Promise.all([
          api.listTopics(merchantId, sessionId),
          sessionId ? api.listTextGenerationJobs(sessionId) : Promise.resolve([]),
          creating ? api.listMerchantCatalog(merchantId) : Promise.resolve(null),
          creating && sessionId ? api.listArtifacts(sessionId) : Promise.resolve(null),
        ]);
        if (active) {
          setTopics(nextTopics);
          setJobs(nextJobs);
          if (nextProducts && nextArtifacts) {
            setProducts(nextProducts.filter((item) => item.kind === "PRODUCT" && item.status === "ACTIVE"));
            setArtifacts(nextArtifacts);
            setReferencesReady(true);
            setReferenceError("");
          }
        }
      } catch (error) {
        if (active) {
          if (creating) {
            setReferencesReady(false);
            setReferenceError(String(error));
          } else setNotice(String(error));
        }
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [merchantId, sessionId, creating]);

  /** 没有研究报告时也可按本次明确目标规划，来源标为商家资料建议。 */
  async function planFromProfile() {
    if (busy || !sessionId || !canGenerate || !planningBrief.trim()) return;
    const input = { brief: planningBrief.trim(), allowStale: false };
    const signature = JSON.stringify(input);
    setBusy(true);
    try {
      await api.createTopicPlan(sessionId, input, commandKey(signature));
      pending.current.delete(signature);
      await refresh();
      setNotice("选题任务已受理。完成后选择一张卡片，再创作文案与配图。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 把用户选择的报告交给主 Agent 规划，旧选题继续保留。 */
  async function plan(report: ResearchReport) {
    if (busy || !sessionId || !canGenerate) return;
    const input = {
      reportId: report.reportId,
      reportHash: report.sha256,
      allowStale: reviewed.includes(report.reportId),
    };
    const signature = JSON.stringify(input);
    setBusy(true);
    try {
      await api.createTopicPlan(sessionId, input, commandKey(signature));
      pending.current.delete(signature);
      await refresh();
      setNotice("选题规划已受理，Agent 完成并通过来源校验后会显示卡片。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!selected) return;
    editor.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [selected]);

  /** 打开选题编辑或创作表单，商品与风格在此时才选择。 */
  function choose(topic: TopicCard, create: boolean) {
    if (!canEdit || (create && !canGenerate)) return;
    setReferencesReady(false);
    setReferenceError("");
    setSelected(topic);
    setFields(topicFields(topic));
    setCreating(create);
    setSourceReviewed(false);
    setProductId("");
    setTemplateId("FREE");
    setRefs([]);
    setStyleMode("NONE");
    setStyleBrief("");
    setBrief("");
    setNotice("");
  }

  /** 提交选题的新版本或停用，冲突时保留用户输入供核对。 */
  async function save(topic: TopicCard, status: "ACTIVE" | "INACTIVE", nextFields: TopicFields) {
    if (busy || !canEdit) return;
    const input = { expectedRevision: topic.revision, status, fields: nextFields };
    const signature = JSON.stringify({ topicId: topic.topicId, input });
    setBusy(true);
    try {
      await api.updateTopic(topic.sessionId, topic.topicId, input, commandKey(signature));
      pending.current.delete(signature);
      await refresh();
      setSelected(null);
      setCreating(false);
      setNotice("选题版本已保存，已有任务保持原来源。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 创建绑定选题和明确参考白名单的文案任务，不自动审核。 */
  async function create() {
    if (busy || !selected || !sessionId || !canGenerate || !referencesReady || hasTooManyReferences) return;
    const chosen = artifacts.filter((item) => refs.includes(item.artifactId));
    if (chosen.length !== refs.length) {
      setNotice("参考文件已变化，请重新打开创作表单选择。");
      return;
    }
    const topicCreation: TopicCreationInput = {
      topicId: selected.topicId,
      topicRevision: selected.revision,
      templateId,
      styleMode,
      styleBrief,
      channel,
      allowStale: sourceReviewed,
      textArtifactIds: chosen.filter((item) => item.mimeType === "text/plain").map((item) => item.artifactId),
      imageArtifactIds: chosen.filter((item) => item.mimeType.startsWith("image/")).map((item) => item.artifactId),
    };
    const input = {
      title: selected.title,
      brief: brief.trim() || "按选题及其来源限制创作完整文案。",
      ...(productId ? { productEntryId: productId } : {}),
      topicCreation,
    };
    const signature = JSON.stringify(input);
    setBusy(true);
    try {
      const job = await api.createTextGenerationJob(sessionId, input, commandKey(signature));
      onContentCreated?.(job);
      pending.current.delete(signature);
      await refresh();
      setSelected(null);
      setCreating(false);
      setNotice("文案任务已受理，完成后进入图文工作台修改、配图并整套审核。");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }

  const planning = jobs.filter((job) => job.purpose === "TOPIC_PLAN");
  return (
    <section className="topic-panel">
      <h4>选题与创作 · {topics.length} 张选题卡</h4>
      <p className="muted">
        可以直接基于商家资料规划，也可采用下方研究。选择一张选题后，文案、配图和发布包留在同一内容任务。
      </p>
      {sessionId && (
        <div className="studio-section studio-form">
          <label>
            这次想达到什么目标？
            <textarea
              aria-label="选题规划目标"
              value={planningBrief}
              maxLength={8000}
              placeholder="例如：为附近上班族规划本周小红书选题；账号或笔记链接可在本次目标中填写"
              onChange={(event) => setPlanningBrief(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={
              busy ||
              !canGenerate ||
              !planningBrief.trim() ||
              planning.some((job) => ["QUEUED", "RUNNING"].includes(job.status))
            }
            onClick={() => void planFromProfile()}
          >
            基于商家资料规划选题
          </button>
        </div>
      )}
      {sessionId && !sessionWritable && (
        <p className="muted">当前会话已归档或回收，恢复会话后才能编辑选题或创建任务。</p>
      )}
      {sessionId && sessionWritable && !modelConfigured && (
        <p className="muted">文本模型未配置，暂不能生成选题或创作文案；已有选题仍可查看和编辑。</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {reports.map((report) => (
        <div className="research-batch" key={report.reportId}>
          <strong>
            {report.title} · {new Date(report.createdAt).toLocaleString()}
          </strong>
          {report.stale && (
            <label>
              <input
                type="checkbox"
                checked={reviewed.includes(report.reportId)}
                onChange={(event) =>
                  setReviewed((old) =>
                    event.target.checked ? [...old, report.reportId] : old.filter((id) => id !== report.reportId),
                  )
                }
              />
              已复核商家资料变化，仍使用本版研究
            </label>
          )}
          {sessionId ? (
            <button
              type="button"
              className="outline-button compact"
              disabled={
                busy ||
                !canGenerate ||
                report.sourceRunStatus !== "SUCCEEDED" ||
                (report.stale && !reviewed.includes(report.reportId)) ||
                planning.some(
                  (job) =>
                    job.source?.report?.reportId === report.reportId && ["QUEUED", "RUNNING"].includes(job.status),
                )
              }
              onClick={() => void plan(report)}
            >
              从这份研究生成选题
            </button>
          ) : (
            <Link to={`/sessions/${report.sessionId}`}>打开研究会话生成选题</Link>
          )}
        </div>
      ))}
      {planning.map((job) => (
        <p key={job.jobId}>
          选题规划 · {jobLabels[job.status]}
          {job.errorCode && ` · ${errorLabels[job.errorCode] ?? job.errorCode}`}
        </p>
      ))}
      {!topics.length && <p className="muted">暂无已保存选题。填写本次目标生成选题，或从成功研究继续。</p>}
      {topics.map((topic) => {
        const linked = jobs.filter((job) => job.purpose === "CONTENT" && job.source?.topic?.topicId === topic.topicId);
        const isExpired = !!topic.expiresAt && Date.parse(topic.expiresAt) <= Date.now();
        const similar = topics.some(
          (other) =>
            other.topicId !== topic.topicId &&
            normalizedResearchTitle(other.title) === normalizedResearchTitle(topic.title),
        );
        return (
          <article key={topic.topicId} className="research-batch">
            <strong>
              {topic.title} · 第 {topic.revision} 版 · {topic.status === "ACTIVE" ? "可选" : "已停用"}
            </strong>
            <p>
              目标读者：{topic.audience}；建议形式：{topic.format}
            </p>
            <p>内容角度：{topic.angle}</p>
            <p>商家关联：{topic.merchantRelevance}</p>
            {!!topic.materials.length && <p>所需素材：{topic.materials.join("；")}</p>}
            {!!topic.cautions.length && <p>待核实：{topic.cautions.join("；")}</p>}
            {!!topic.sourceCautions.length && <p className="muted">原研究限制：{topic.sourceCautions.join("；")}</p>}
            {topic.expiresAt && <p className="muted">来源有效至：{new Date(topic.expiresAt).toLocaleString()}</p>}
            {isExpired && <p className="muted">来源已过期，请重新研究后再创作。</p>}
            {similar && <p className="muted">近期已有同名选题，请复核是否重复。</p>}
            <details>
              <summary>研究来源与证据</summary>
              <p>
                {topic.sourceReportId
                  ? `研究 ${topic.sourceReportId} · ${topic.sourceReportHash?.slice(0, 12) ?? ""}`
                  : `商家档案第 ${topic.sourceProfileRevision} 版 · 基于商家资料的选题建议`}
              </p>
              {topic.evidenceRefs.map((ref) => (
                <p key={ref.evidenceId}>
                  <a href={ref.sourceUrl} target="_blank" rel="noreferrer">
                    公开证据 · {new Date(ref.collectedAt).toLocaleString()}
                  </a>
                </p>
              ))}
            </details>
            {sessionId ? (
              <div className="prompt-actions">
                <button type="button" disabled={busy || !canEdit} onClick={() => choose(topic, false)}>
                  编辑选题
                </button>
                <button
                  type="button"
                  disabled={busy || !canGenerate || isExpired || topic.status !== "ACTIVE"}
                  onClick={() => choose(topic, true)}
                >
                  用此选题创作
                </button>
                <button
                  type="button"
                  disabled={busy || !canEdit}
                  onClick={() =>
                    void save(topic, topic.status === "ACTIVE" ? "INACTIVE" : "ACTIVE", topicFields(topic))
                  }
                >
                  {topic.status === "ACTIVE" ? "停用" : "恢复选用"}
                </button>
              </div>
            ) : (
              <Link to={`/sessions/${topic.sessionId}`}>打开选题与创作</Link>
            )}
            {linked.map((job) => (
              <p key={job.jobId}>
                文案：{job.title} · {jobLabels[job.status]} · 选题第 {job.source?.topic?.revision} 版{" "}
                {job.errorCode && (errorLabels[job.errorCode] ?? job.errorCode)}{" "}
                {job.resultDraftId && (
                  <Link to={`/sessions/${topic.sessionId}?studio=1&draft=${job.resultDraftId}`}>
                    进入图文制作与交付
                  </Link>
                )}
              </p>
            ))}
          </article>
        );
      })}
      {selected && fields && (
        <div className="research-editor" ref={editor}>
          <h4>
            {creating ? "从选题创建文案" : "编辑选题"}：{selected.title}
          </h4>
          {creating ? (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={sourceReviewed}
                  onChange={(event) => setSourceReviewed(event.target.checked)}
                />
                已复核选题依据与商家当前资料（资料变化时需确认）
              </label>
              <label>
                关联商品/服务
                <select
                  aria-label="关联商品/服务"
                  value={productId}
                  onChange={(event) => setProductId(event.target.value)}
                >
                  <option value="">不选商品</option>
                  {products.map((item) => (
                    <option key={item.entryId} value={item.entryId}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                内容模板
                <select
                  aria-label="内容模板"
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value as TopicCreationInput["templateId"])}
                >
                  <option value="FREE">围绕选题自由创作</option>
                  <option value="PRODUCT_PROMOTION">商品宣传：标题、卖点、场景和行动引导</option>
                </select>
              </label>
              <label>
                渠道
                <input
                  aria-label="渠道"
                  value={channel}
                  maxLength={100}
                  onChange={(event) => setChannel(event.target.value)}
                />
              </label>
              <label>
                风格
                <select
                  aria-label="风格"
                  value={styleMode}
                  onChange={(event) => setStyleMode(event.target.value as TopicCreationInput["styleMode"])}
                >
                  <option value="NONE">按主题自然表达</option>
                  <option value="KEEP">沿用参考风格</option>
                  <option value="NEW">尝试新风格</option>
                </select>
              </label>
              <label>
                风格要求
                <textarea
                  aria-label="风格要求"
                  value={styleBrief}
                  maxLength={2000}
                  onChange={(event) => setStyleBrief(event.target.value)}
                />
              </label>
              <label>
                篇幅及其他创作要求
                <textarea
                  aria-label="篇幅及其他创作要求"
                  value={brief}
                  maxLength={8000}
                  onChange={(event) => setBrief(event.target.value)}
                />
              </label>
              <p className="muted">
                只授权勾选的当前会话参考文件。文字和图片各最多 5 份，文字每份不超过 2 MB，图片每张不超过 8 MB。
              </p>
              {!referencesReady && (
                <p role="status">
                  {referenceError
                    ? `读取商品或参考文件失败，将自动重试：${referenceError}`
                    : "正在读取最新商品和参考文件…"}
                </p>
              )}
              {!imageInputEnabled && (
                <p className="muted">当前模型未启用视觉输入，图片参考暂不可选；文字创作可继续。</p>
              )}
              {hasTooManyReferences && <p role="status">文字和图片参考各最多选择 5 份，请取消多余文件。</p>}
              {artifacts
                .filter(
                  (item) =>
                    item.mimeType === "text/plain" || ["image/png", "image/jpeg", "image/webp"].includes(item.mimeType),
                )
                .map((item) => (
                  <label key={item.artifactId}>
                    <input
                      type="checkbox"
                      disabled={
                        !referencesReady ||
                        (item.mimeType === "text/plain"
                          ? item.sizeBytes > MAX_TEXT_REFERENCE_BYTES
                          : !imageInputEnabled || item.sizeBytes > MAX_IMAGE_REFERENCE_BYTES)
                      }
                      checked={refs.includes(item.artifactId)}
                      onChange={(event) =>
                        setRefs((old) =>
                          event.target.checked ? [...old, item.artifactId] : old.filter((id) => id !== item.artifactId),
                        )
                      }
                    />
                    {item.mimeType === "text/plain" ? "文字参考" : "图片参考"}：{item.title}
                  </label>
                ))}
              <button
                type="button"
                disabled={
                  busy ||
                  !canGenerate ||
                  !referencesReady ||
                  hasTooManyReferences ||
                  !channel.trim() ||
                  (templateId === "PRODUCT_PROMOTION" && !productId)
                }
                onClick={() => void create()}
              >
                创建文案任务
              </button>
            </>
          ) : (
            <>
              {(["title", "audience", "angle", "format", "merchantRelevance"] as const).map((key) => (
                <label key={key}>
                  {
                    {
                      title: "标题",
                      audience: "目标读者",
                      angle: "内容角度",
                      format: "建议形式",
                      merchantRelevance: "商家关联",
                    }[key]
                  }
                  <textarea
                    aria-label={
                      {
                        title: "标题",
                        audience: "目标读者",
                        angle: "内容角度",
                        format: "建议形式",
                        merchantRelevance: "商家关联",
                      }[key]
                    }
                    value={fields[key]}
                    maxLength={key === "title" ? 120 : key === "angle" || key === "merchantRelevance" ? 1000 : 500}
                    onChange={(event) => setFields({ ...fields, [key]: event.target.value })}
                  />
                </label>
              ))}
              <label>
                所需素材（每行一项）
                <textarea
                  value={fields.materials.join("\n")}
                  onChange={(event) => setFields({ ...fields, materials: event.target.value.split("\n") })}
                />
              </label>
              <label>
                待核实项（每行一项）
                <textarea
                  value={fields.cautions.join("\n")}
                  onChange={(event) => setFields({ ...fields, cautions: event.target.value.split("\n") })}
                />
              </label>
              <button
                type="button"
                disabled={busy || !canEdit}
                onClick={() =>
                  void save(selected, selected.status, {
                    ...fields,
                    materials: fields.materials.map((item) => item.trim()).filter(Boolean),
                    cautions: fields.cautions.map((item) => item.trim()).filter(Boolean),
                  })
                }
              >
                保存选题新版本
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setSelected(null);
              setCreating(false);
            }}
          >
            取消
          </button>
        </div>
      )}
    </section>
  );
}

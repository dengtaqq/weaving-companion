import type {
  CapabilityRole,
  ExpertConfiguration,
  SkillDetail,
  SkillPackageFile,
  StoredSkillVersion,
  TeamConfiguration,
} from "../../shared/capabilities.js";
import type {
  AcceptedMessage,
  AccountDiagnosisRecord,
  ArtifactRecord,
  CapabilityCatalog,
  ContentDraftRecord,
  ContentRevisionRecord,
  ContextCheckpointRecord,
  DelegationAttemptRecord,
  DelegationRecord,
  ExpertSelectionId,
  GenerationJobRecord,
  MemoryFields,
  MemoryJob,
  MerchantCatalogEntry,
  MerchantCatalogInput,
  MerchantDetail,
  MerchantLinkInput,
  MerchantMemory,
  MerchantPlatformLink,
  MerchantProfileFields,
  MerchantRecord,
  MessageRecord,
  MessageSearchHit,
  ModelAvailability,
  PublicDiagnosisReportRecord,
  PublicPageEvidenceRecord,
  RunRecord,
  RuntimeEvent,
  SessionDeleteImpact,
  SessionPage,
  SessionRecord,
  SessionSnapshot,
  SystemPromptSetting,
  TextGenerationJobRecord,
  UpdateMemoryInput,
  XhsLoginState,
} from "../../shared/contracts.js";
import { CONTRACT_VERSION } from "../../shared/contracts.js";
import type { PromptSnapshot } from "../../shared/prompt-snapshot.js";
import type {
  PublicationDetail,
  PublicationExport,
  PublicationFields,
  PublicationImageTarget,
  PublicationRecord,
  PublicationReview,
} from "../../shared/publication.js";
import type { PublicationConversationInput } from "../../shared/publication-conversation.js";
import type {
  ContentAnalysis,
  ResearchAdoptInput,
  ResearchBatch,
  ResearchLibraryItem,
  ResearchReport,
  ResearchScope,
} from "../../shared/research.js";
import type { TaskContextView } from "../../shared/task-context.js";
import type { TaskExecutionControl, TaskExecutionLimits } from "../../shared/task-execution.js";
import type { TopicCard, TopicCreationInput, TopicPlanInput, TopicUpdateInput } from "../../shared/topics.js";
import type {
  MerchantMedia,
  PublicationRecordLink,
  WorkbenchBoard,
  WorkPlan,
  WorkPlanFields,
} from "../../shared/workbench.js";

let csrfToken: string | null = null;

/** 读取指定会话轮次的不可变启动快照；专家目标由 Host 复核父轮归属。 */
export async function getPromptSnapshots(
  sessionId: string,
  runId: string,
  delegationId = "",
): Promise<{
  snapshots: PromptSnapshot[];
  delegations: Array<{ delegationId: string; targetExpertId: string }>;
}> {
  const query = delegationId ? `?delegationId=${encodeURIComponent(delegationId)}` : "";
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/prompt-snapshots${query}`,
  );
}

/** 下载指定已记录尝试，内容由 Host 从相同快照生成。 */
export function promptSnapshotDownloadUrl(
  sessionId: string,
  runId: string,
  attempt: number,
  delegationId: string,
): string {
  const query = new URLSearchParams({ format: "markdown", attempt: String(attempt) });
  if (delegationId) query.set("delegationId", delegationId);
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/prompt-snapshots?${query}`;
}

/** 读取 Host 当前真实内置 Skill 与专家团元数据，界面不自行假定资产已安装。 */
export async function getCapabilities(): Promise<CapabilityCatalog> {
  return request("/capabilities");
}

/** 读取商家或会话的持久选题卡。 */
export async function listTopics(merchantId: string, sessionId?: string): Promise<TopicCard[]> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return (await request<{ items: TopicCard[] }>(`/merchants/${encodeURIComponent(merchantId)}/topics${query}`)).items;
}

/** 明确引用研究报告并启动选题规划，重复请求沿用相同命令键。 */
export async function createTopicPlan(
  sessionId: string,
  input: TopicPlanInput,
  key: string,
): Promise<TextGenerationJobRecord> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/topic-plans`,
    { method: "POST", body: JSON.stringify(input) },
    key,
  );
}

/** 保存选题新版本或停用，保留原研究来源。 */
export async function updateTopic(
  sessionId: string,
  topicId: string,
  input: TopicUpdateInput,
  key: string,
): Promise<TopicCard> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/topics/${encodeURIComponent(topicId)}`,
    { method: "PUT", body: JSON.stringify(input) },
    key,
  );
}

/** 返回经会话路径归属校验的正式素材下载地址。 */
export function contentArtifactDownloadUrl(sessionId: string, artifactId: string): string {
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}/content-artifacts/${encodeURIComponent(artifactId)}/download`;
}

/** 返回带会话归属检查的图片预览与下载地址。 */
export function imageArtifactUrl(sessionId: string, artifactId: string): string {
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(artifactId)}/content`;
}

/** 列出本会话的全部图片生成和修改任务。 */
export async function listGenerationJobs(sessionId: string): Promise<GenerationJobRecord[]> {
  return (await request<{ items: GenerationJobRecord[] }>(`/sessions/${encodeURIComponent(sessionId)}/generation-jobs`))
    .items;
}

/** 显式确认费用并受理一次可追溯的图片任务。 */
export async function createImageJob(
  sessionId: string,
  input: {
    prompt: string;
    size: GenerationJobRecord["size"];
    quality: GenerationJobRecord["quality"];
    referenceArtifactId?: string;
    costConfirmed: true;
    publication?: PublicationImageTarget;
  },
  operationKey?: string,
): Promise<GenerationJobRecord> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/generation-jobs/images`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    operationKey,
  );
}

/** 列出本会话由素材任务启动的文案 Run 与草稿结果。 */
export async function listTextGenerationJobs(sessionId: string): Promise<TextGenerationJobRecord[]> {
  return (
    await request<{ items: TextGenerationJobRecord[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/generation-jobs/text`,
    )
  ).items;
}

/** 受理一次带冻结模板/商品来源的文案生成任务。 */
export async function createTextGenerationJob(
  sessionId: string,
  input: {
    title: string;
    brief: string;
    productEntryId?: string;
    targetDraftId?: string;
    expectedRevision?: number;
    topicCreation?: TopicCreationInput;
  },
  operationKey?: string,
): Promise<TextGenerationJobRecord> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/generation-jobs/text`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    operationKey,
  );
}

/** 列出当前会话已保存的素材草稿。 */
export async function listContentDrafts(sessionId: string): Promise<ContentDraftRecord[]> {
  return (await request<{ items: ContentDraftRecord[] }>(`/sessions/${encodeURIComponent(sessionId)}/content-drafts`))
    .items;
}

/** 读取素材草稿的当前内容和历史修订。 */
export async function getContentDraft(
  sessionId: string,
  draftId: string,
): Promise<{
  draft: ContentDraftRecord;
  revisions: ContentRevisionRecord[];
}> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/content-drafts/${encodeURIComponent(draftId)}`);
}

/** 将用户选中的成功回复提取为可编辑素材草稿。 */
export async function createContentDraft(
  sessionId: string,
  sourceMessageId: string,
  title: string,
): Promise<ContentDraftRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/content-drafts`, {
    method: "POST",
    body: JSON.stringify({ sourceMessageId, title }),
  });
}

/** 按预期版本追加素材修订。 */
export async function reviseContentDraft(
  sessionId: string,
  draftId: string,
  expectedRevision: number,
  title: string,
  body: string,
): Promise<ContentDraftRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/content-drafts/${encodeURIComponent(draftId)}`, {
    method: "PUT",
    body: JSON.stringify({ expectedRevision, title, body }),
  });
}

/** 用户显式审核当前版并请求 Host 登记正式文件。 */
export async function approveContentDraft(
  sessionId: string,
  draftId: string,
  expectedRevision: number,
): Promise<ContentDraftRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/content-drafts/${encodeURIComponent(draftId)}/approve`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

/** 让Agent判断本次要求并通过Host执行，不需要前端选择操作模式。 */
export async function sendPublicationConversation(
  sessionId: string,
  input: PublicationConversationInput,
  key: string,
): Promise<TextGenerationJobRecord> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/publication-conversations`,
    { method: "POST", body: JSON.stringify(input) },
    key,
  );
}

/** 按当前稿件或明确选择的根任务读取任务要求，普通会话不猜测最近稿件。 */
export async function getTaskContext(
  sessionId: string,
  target: { draftId?: string; rootJobId?: string },
): Promise<TaskContextView | null> {
  const query = new URLSearchParams();
  if (target.draftId) query.set("draftId", target.draftId);
  else if (target.rootJobId) query.set("rootJobId", target.rootJobId);
  return request(`/sessions/${encodeURIComponent(sessionId)}/task-context?${query}`);
}

/** 人工确认新额度后沿原任务位置恢复，不创建替代业务任务。 */
export async function resumeTaskExecution(
  sessionId: string,
  jobId: string,
  expectedRevision: number,
  limits: TaskExecutionLimits,
): Promise<TaskExecutionControl> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/publication-conversations/${encodeURIComponent(jobId)}/execution-control`,
    {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ expectedRevision, limits }),
    },
  );
}

/** 用户只授权这张确认卡中的具体付费图片请求。 */
export async function approvePublicationConversationImage(
  sessionId: string,
  job: TextGenerationJobRecord,
): Promise<TextGenerationJobRecord> {
  const flow = job.source?.workflow;
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/publication-conversations/${encodeURIComponent(job.jobId)}/approve-image`,
    {
      method: "POST",
      body: JSON.stringify({
        approvalId: flow?.imageRequest?.approvalId,
        draftRevision: flow?.draftRevision,
        publicationRevision: flow?.publicationRevision,
        costConfirmed: true,
      }),
    },
  );
}

/** 读取一篇笔记的图文编排和已确认发布包。 */
export async function getPublication(sessionId: string, draftId: string): Promise<PublicationDetail> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/content-drafts/${encodeURIComponent(draftId)}/publication`,
  );
}

/** 规划当前正文的图位、逐图提示和真实发布操作，不自动发起付费图片请求。 */
export async function planPublication(
  sessionId: string,
  draftId: string,
  draftRevision: number,
  publicationRevision: number,
  brief: string,
  key: string,
  imageCount = 1,
): Promise<TextGenerationJobRecord> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/content-drafts/${encodeURIComponent(draftId)}/publication/plan`,
    {
      method: "POST",
      body: JSON.stringify({ draftRevision, publicationRevision, brief, imageCount }),
    },
    key,
  );
}

/** 保存图片编排和发布说明，复用同一编辑命令键。 */
export async function savePublication(
  sessionId: string,
  draftId: string,
  expectedRevision: number,
  fields: PublicationFields,
  key: string,
): Promise<PublicationRecord> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/content-drafts/${encodeURIComponent(draftId)}/publication`,
    { method: "PUT", body: JSON.stringify({ expectedRevision, fields }) },
    key,
  );
}

/** 用户确认整套图文后请求不可变 ZIP 交付。 */
export async function exportPublication(
  sessionId: string,
  draftId: string,
  draftRevision: number,
  publicationRevision: number,
): Promise<PublicationExport> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/content-drafts/${encodeURIComponent(draftId)}/publication/exports`,
    { method: "POST", body: JSON.stringify({ draftRevision, publicationRevision, confirmed: true }) },
  );
}

/** 按会话归属下载固定交付版本。 */
export function publicationDownloadUrl(sessionId: string, artifactId: string): string {
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}/publications/${encodeURIComponent(artifactId)}/download`;
}

/** 统一附加同源凭证、CSRF 和幂等标识，并转换接口错误。 */
async function request<T>(path: string, init: RequestInit = {}, operationKey?: string): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
    headers.set("Idempotency-Key", operationKey ?? headers.get("Idempotency-Key") ?? crypto.randomUUID());
    if (init.body && !(init.body instanceof Blob)) headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: "same-origin" });
  const result = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`);
  return result;
}

/** 调用 Host API：查询本机浏览器是否已完成配对。 */
export async function pairingStatus(): Promise<boolean> {
  const status = await request<{ paired: boolean; csrfToken: string | null }>("/pairing/status");
  csrfToken = status.csrfToken;
  return status.paired;
}

/** 调用 Host API：探测 Host 是否可用。 */
export async function hostHealth(): Promise<boolean> {
  try {
    const result = await request<{ status: string }>("/health");
    return result.status === "ok";
  } catch {
    return false;
  }
}

/** 调用 Host API：提交本机配对码并建立 Cookie 会话。 */
export async function completePairing(code: string): Promise<void> {
  const result = await request<{ csrfToken: string }>("/pairing/complete", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  csrfToken = result.csrfToken;
}

/** 调用 Host API：读取工作台启动所需的模型和 Provider 状态。 */
export async function bootstrap(): Promise<{ model: ModelAvailability; providers: Record<string, string> }> {
  const result = await request<{
    contractVersion: number;
    model: ModelAvailability;
    providers: Record<string, string>;
  }>("/bootstrap");
  // 前后端契约版本不一致时停止继续使用旧页面。
  if (result.contractVersion !== CONTRACT_VERSION) throw new Error("工作台版本不匹配，请刷新页面");
  return result;
}

/** 调用 Host API：读取全局系统提示词及版本。 */
export async function getSystemPrompt(): Promise<SystemPromptSetting> {
  return request("/settings/system-prompt");
}

/** 调用 Host API：按预期版本更新全局系统提示词。 */
export async function updateSystemPrompt(content: string, revision: number): Promise<SystemPromptSetting> {
  return request("/settings/system-prompt", {
    method: "PUT",
    body: JSON.stringify({ content, revision }),
  });
}

/** 调用 Host API：列出工作台中的普通和商家会话。 */
export async function listSessions(): Promise<SessionRecord[]> {
  return (await request<{ items: SessionRecord[] }>("/sessions")).items;
}

/** 调用 Host API：分页列出活动会话或回收站。 */
export async function listSessionPage(
  status: "ACTIVE" | "TRASHED",
  cursor: string | null = null,
): Promise<SessionPage> {
  const params = new URLSearchParams({ status });
  if (cursor) params.set("cursor", cursor);
  return request(`/sessions/page?${params}`);
}

/** 调用 Host API：搜索消息正文并返回可定位结果。 */
export async function searchMessages(query: string, merchantId?: string): Promise<MessageSearchHit[]> {
  const params = new URLSearchParams({ q: query });
  if (merchantId) params.set("merchantId", merchantId);
  return (await request<{ items: MessageSearchHit[] }>(`/sessions/search?${params}`)).items;
}

/** 调用 Host API：按预期版本更新会话标题。 */
export async function renameSession(
  sessionId: string,
  title: string,
  expectedRevision: number,
): Promise<SessionRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: "PATCH",
    body: JSON.stringify({ title, expectedRevision }),
  });
}

/** 调用 Host API：预览将会话放入回收站的影响。 */
export async function sessionDeleteImpact(sessionId: string): Promise<SessionDeleteImpact> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/delete-impact`);
}

/** 调用 Host API：将无活动 Run 的会话移入回收站。 */
export async function trashSession(sessionId: string): Promise<SessionRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/trash`, { method: "POST", body: "{}" });
}

/** 调用 Host API：恢复回收站中的会话。 */
export async function restoreTrashedSession(sessionId: string): Promise<SessionRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/untrash`, { method: "POST", body: "{}" });
}

/** 调用 Host API：归档普通会话但不创建商家总结。 */
export async function archiveNormalSession(sessionId: string): Promise<SessionRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST", body: "{}" });
}

/** 调用 Host API：确认后永久清理回收站会话并等待持久回执。 */
export async function purgeSession(sessionId: string): Promise<{ sessionId: string; status: "FINALIZED" }> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/permanent`, {
    method: "DELETE",
    body: JSON.stringify({ confirmSessionId: sessionId }),
  });
}

/** 调用 Host API：记录当前会话中最近看到的持久消息。 */
export async function markSessionRead(sessionId: string, messageId: string): Promise<SessionRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/read`, {
    method: "POST",
    body: JSON.stringify({ messageId }),
  });
}

/** 调用 Host API：读取搜索命中消息周围的历史。 */
export async function messagesAround(sessionId: string, messageId: string): Promise<MessageRecord[]> {
  const params = new URLSearchParams({ messageId });
  return (
    await request<{ items: MessageRecord[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages/around?${params}`)
  ).items;
}

/** 调用 Host API：创建普通会话并返回持久化记录。 */
export async function createSession(): Promise<SessionRecord> {
  return request("/sessions", { method: "POST", body: JSON.stringify({ title: "新会话" }) });
}

/** 调用 Host API：列出本机维护的商家摘要。 */
export async function listMerchants(): Promise<MerchantRecord[]> {
  return (await request<{ items: MerchantRecord[] }>("/merchants")).items;
}

/** 调用 Host API：读取指定商家的完整人工档案。 */
export async function getMerchant(merchantId: string): Promise<MerchantDetail> {
  return request(`/merchants/${encodeURIComponent(merchantId)}`);
}

/** 读取当前商家商品库和选题来源。 */
export async function listMerchantCatalog(merchantId: string): Promise<MerchantCatalogEntry[]> {
  return (await request<{ items: MerchantCatalogEntry[] }>(`/merchants/${encodeURIComponent(merchantId)}/catalog`))
    .items;
}

/** 保存一条商家商品或选题线索。 */
export async function createMerchantCatalogEntry(
  merchantId: string,
  input: MerchantCatalogInput,
  operationKey?: string,
): Promise<MerchantCatalogEntry> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/catalog`, {
    method: "POST",
    body: JSON.stringify(input),
    headers: operationKey ? { "Idempotency-Key": operationKey } : undefined,
  });
}

/** 按版本修订或停用商品和线索。 */
export async function updateMerchantCatalogEntry(
  merchantId: string,
  entryId: string,
  expectedRevision: number,
  input: MerchantCatalogInput,
  status: "ACTIVE" | "INACTIVE",
  operationKey?: string,
): Promise<MerchantCatalogEntry> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/catalog/${encodeURIComponent(entryId)}`, {
    method: "PUT",
    body: JSON.stringify({ ...input, expectedRevision, status }),
    headers: operationKey ? { "Idempotency-Key": operationKey } : undefined,
  });
}

/** 调用 Host API：读取指定商家的公开页面证据列表。 */
export async function listPublicEvidence(merchantId: string): Promise<PublicPageEvidenceRecord[]> {
  return (
    await request<{ items: PublicPageEvidenceRecord[] }>(`/merchants/${encodeURIComponent(merchantId)}/public-evidence`)
  ).items;
}

/** 调用 Host API：读取指定商家的账号诊断草稿列表。 */
export async function listAccountDiagnoses(merchantId: string): Promise<AccountDiagnosisRecord[]> {
  return (
    await request<{ items: AccountDiagnosisRecord[] }>(`/merchants/${encodeURIComponent(merchantId)}/account-diagnoses`)
  ).items;
}

/** 读取指定商家的已导出公开资料报告。 */
export async function listPublicDiagnosisReports(merchantId: string): Promise<PublicDiagnosisReportRecord[]> {
  return (
    await request<{ items: PublicDiagnosisReportRecord[] }>(
      `/merchants/${encodeURIComponent(merchantId)}/public-diagnosis-reports`,
    )
  ).items;
}

/** 将一版已核对来源的草稿导出为固定的公开资料报告。 */
export async function publishPublicDiagnosisReport(
  merchantId: string,
  diagnosisId: string,
): Promise<PublicDiagnosisReportRecord> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/public-diagnosis-reports`, {
    method: "POST",
    body: JSON.stringify({ diagnosisId }),
  });
}

/** 读取商家的长期记忆、近期总结和待确认条目。 */
export async function listMemories(merchantId: string): Promise<MerchantMemory[]> {
  return (await request<{ items: MerchantMemory[] }>(`/merchants/${encodeURIComponent(merchantId)}/memories`)).items;
}

/** 人工保存一条长期记忆。 */
export async function createMemory(merchantId: string, input: MemoryFields): Promise<MerchantMemory> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/memories`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 按预期版本修改、确认或停用记忆。 */
export async function updateMemory(
  merchantId: string,
  memoryId: string,
  input: UpdateMemoryInput,
): Promise<MerchantMemory> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/memories/${encodeURIComponent(memoryId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** 读取商家记忆版本历史。 */
export async function memoryHistory(merchantId: string, memoryId: string): Promise<MerchantMemory[]> {
  return (
    await request<{ items: MerchantMemory[] }>(
      `/merchants/${encodeURIComponent(merchantId)}/memories/${encodeURIComponent(memoryId)}/history`,
    )
  ).items;
}

/** 读取归档总结的持久状态及结果。 */
export async function listMemoryJobs(merchantId: string): Promise<MemoryJob[]> {
  return (await request<{ items: MemoryJob[] }>(`/merchants/${encodeURIComponent(merchantId)}/memory-jobs`)).items;
}

/** 重试原来源范围的失败总结。 */
export async function retryMemoryJob(merchantId: string, jobId: string): Promise<MemoryJob> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/memory-jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    body: "{}",
  });
}

/** 明确允许会话文字总结用于当前商家后续会话，并归档。 */
export async function archiveSession(sessionId: string): Promise<MemoryJob> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    body: JSON.stringify({ shareConversationSummary: true }),
  });
}

/** 恢复归档会话并保留总结来源。 */
export async function restoreSession(sessionId: string): Promise<SessionRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/restore`, { method: "POST", body: "{}" });
}

/** 调用 Host API：创建商家及初始人工档案。 */
export async function createMerchant(name: string): Promise<MerchantDetail> {
  return request("/merchants", { method: "POST", body: JSON.stringify({ name }) });
}

/** 调用 Host API：按版本更新人工确认的商家档案。 */
export async function updateMerchantProfile(
  merchantId: string,
  expectedRevision: number,
  fields: MerchantProfileFields,
): Promise<MerchantDetail> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/profile`, {
    method: "PUT",
    body: JSON.stringify({ expectedRevision, fields }),
  });
}

/** 调用 Host API：保存商家提供的平台链接，不将其视为已采集证据。 */
export async function createMerchantLink(merchantId: string, fields: MerchantLinkInput): Promise<MerchantPlatformLink> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/links`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
}

/** 调用 Host API：按版本修改已有平台链接。 */
export async function updateMerchantLink(
  merchantId: string,
  linkId: string,
  expectedRevision: number,
  fields: MerchantLinkInput,
): Promise<MerchantPlatformLink> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/links/${encodeURIComponent(linkId)}`, {
    method: "PUT",
    body: JSON.stringify({ ...fields, expectedRevision }),
  });
}

/** 调用 Host API：按版本停用平台链接并保留历史记录。 */
export async function disableMerchantLink(
  merchantId: string,
  linkId: string,
  expectedRevision: number,
): Promise<MerchantPlatformLink> {
  return request(`/merchants/${encodeURIComponent(merchantId)}/links/${encodeURIComponent(linkId)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision }),
  });
}

/** 调用 Host API：创建归属于指定商家的新会话。 */
export async function createMerchantSession(
  merchantId: string,
  researchScope?: ResearchScope,
  operationKey?: string,
): Promise<SessionRecord> {
  return request(
    `/merchants/${encodeURIComponent(merchantId)}/sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        title: researchScope ? "商家内容研究" : "新会话",
        ...(researchScope && { researchScope }),
      }),
    },
    operationKey,
  );
}

/** 调用 Host API：读取商家研究候选及采用库，可限定候选所属会话。 */
export async function getMerchantResearch(
  merchantId: string,
  sessionId?: string,
): Promise<{
  batches: ResearchBatch[];
  library: ResearchLibraryItem[];
  analyses: ContentAnalysis[];
  reports: ResearchReport[];
}> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request(`/merchants/${encodeURIComponent(merchantId)}/research${query}`);
}

/** 返回报告下载地址，凭证继续通过已配对的本机会话传递。 */
export function researchReportDownloadUrl(merchantId: string, reportId: string): string {
  return `/api/v1/merchants/${encodeURIComponent(merchantId)}/research-reports/${encodeURIComponent(reportId)}/download`;
}

/** 调用 Host API：用户编辑并采用候选，更新已有条目时携带其版本。 */
export async function adoptResearchCandidate(
  merchantId: string,
  batchId: string,
  input: ResearchAdoptInput,
  operationKey: string,
): Promise<ResearchLibraryItem> {
  return request(
    `/merchants/${encodeURIComponent(merchantId)}/research/${encodeURIComponent(batchId)}/adopt`,
    { method: "POST", body: JSON.stringify(input) },
    operationKey,
  );
}

/** 调用 Host API：停用研究条目，保留已冻结的历史版本。 */
export async function deactivateResearchItem(
  merchantId: string,
  itemId: string,
  expectedRevision: number,
): Promise<ResearchLibraryItem> {
  return request(
    `/merchants/${encodeURIComponent(merchantId)}/research-library/${encodeURIComponent(itemId)}/deactivate`,
    { method: "POST", body: JSON.stringify({ expectedRevision }) },
  );
}

/** 调用 Host API：在无活动 Run 时将普通会话及其证据绑定到商家。 */
export async function bindSessionMerchant(sessionId: string, merchantId: string): Promise<SessionRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/merchant`, {
    method: "POST",
    body: JSON.stringify({ merchantId }),
  });
}

/** 调用 Host API：读取指定会话及其当前归属。 */
export async function getSession(sessionId: string): Promise<SessionRecord> {
  return request(`/sessions/${encodeURIComponent(sessionId)}`);
}

/** 调用 Host API：读取断线恢复所需的会话、消息、Run 与事件快照。 */
export async function getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/snapshot`);
}

/** 调用 Host API：查询当前会话的小红书浏览器授权状态。 */
export async function getXhsLogin(sessionId: string): Promise<XhsLoginState> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/xhs-login`);
}

/** 调用 Host API：请求 Host 打开独立 Chrome 资料目录供用户登录。 */
export async function startXhsLogin(sessionId: string, targetUrl: string): Promise<XhsLoginState> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/xhs-login/start`, {
    method: "POST",
    body: JSON.stringify({ targetUrl }),
  });
}

/** 调用 Host API：通知 Host 关闭 Chrome、复核目标页并完成授权。 */
export async function confirmXhsLogin(sessionId: string): Promise<XhsLoginState> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/xhs-login/confirm`, {
    method: "POST",
    body: "{}",
  });
}

/** 调用 Host API：撤销当前会话未完成的浏览器登录流程。 */
export async function cancelXhsLogin(sessionId: string): Promise<XhsLoginState> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/xhs-login/cancel`, {
    method: "POST",
    body: "{}",
  });
}

/** 调用 Host API：分页读取当前会话的持久化消息。 */
export async function listMessages(sessionId: string, before?: string): Promise<MessageRecord[]> {
  const params = before ? `?before=${encodeURIComponent(before)}` : "";
  return (await request<{ items: MessageRecord[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages${params}`))
    .items;
}

/** 调用 Host API：附幂等键发送用户消息并创建本轮 Run。 */
export async function sendMessage(
  sessionId: string,
  content: string,
  clientTurnId: string,
  expertRole?: ExpertSelectionId,
  artifactIds?: string[],
  continueFromRunId?: string,
): Promise<AcceptedMessage> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content,
        clientTurnId,
        ...(expertRole && { expertRole }),
        ...(artifactIds && { artifactIds }),
        ...(continueFromRunId && { continueFromRunId }),
      }),
    },
    clientTurnId,
  );
}

/** 调用 Host API：请求取消指定 Run。 */
export async function cancelRun(runId: string): Promise<RunRecord> {
  return request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" });
}

/** 调用 Host API：读取父 Run 的委派任务、输入和结果。 */
export async function getDelegation(runId: string, delegationId?: string): Promise<DelegationRecord | null> {
  const response = await request<{ delegation: DelegationRecord | null; delegations: DelegationRecord[] }>(
    `/runs/${encodeURIComponent(runId)}/delegation`,
  );
  return delegationId
    ? (response.delegations.find((item) => item.delegationId === delegationId) ?? null)
    : response.delegation;
}

/** 调用 Host API：列出父 Run 的专家任务与待回答问题。 */
export async function listDelegationsForRun(runId: string): Promise<DelegationRecord[]> {
  return (await request<{ delegations: DelegationRecord[] }>(`/runs/${encodeURIComponent(runId)}/delegation`))
    .delegations;
}

/** 调用 Host API：列出专家任务的持久化尝试。 */
export async function listDelegationAttempts(delegationId: string): Promise<DelegationAttemptRecord[]> {
  return (
    await request<{ attempts: DelegationAttemptRecord[] }>(`/delegations/${encodeURIComponent(delegationId)}/attempts`)
  ).attempts;
}

/** 调用 Host API：回答专家提出的问题。 */
export async function answerDelegation(delegationId: string, answer: string): Promise<DelegationRecord> {
  return (
    await request<{ delegation: DelegationRecord }>(`/delegations/${encodeURIComponent(delegationId)}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    })
  ).delegation;
}

/** 调用 Host API：向活动专家发送调整指令。 */
export async function steerDelegation(delegationId: string, instruction: string): Promise<void> {
  await request(`/delegations/${encodeURIComponent(delegationId)}/steer`, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  });
}

/** 调用 Host API：终止指定专家任务。 */
export async function cancelDelegation(delegationId: string): Promise<DelegationRecord> {
  return (
    await request<{ delegation: DelegationRecord }>(`/delegations/${encodeURIComponent(delegationId)}/cancel`, {
      method: "POST",
      body: "{}",
    })
  ).delegation;
}

/** 调用 Host API：列出会话中的长对话压缩检查点。 */
export async function listContextCheckpoints(sessionId: string): Promise<ContextCheckpointRecord[]> {
  return (
    await request<{ checkpoints: ContextCheckpointRecord[] }>(`/sessions/${encodeURIComponent(sessionId)}/checkpoints`)
  ).checkpoints;
}

/** 调用 Host API：列出指定会话可见的附件。 */
export async function listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
  return (await request<{ items: ArtifactRecord[] }>(`/sessions/${encodeURIComponent(sessionId)}/artifacts`)).items;
}

/** 调用 Host API：上传本会话附件并返回受管文件记录。 */
export async function uploadReferenceFile(sessionId: string, file: File): Promise<ArtifactRecord> {
  return request(`/uploads?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Mime": ["image/png", "image/jpeg", "image/webp"].includes(file.type) ? file.type : "text/plain",
      "X-File-Name": encodeURIComponent(file.name),
      "X-File-Name-Encoding": "uri",
    },
    body: file,
  });
}

/** 建立 SSE 事件流；出错先关闭默认重连，由调用方换 token 后续订。 */
export async function connectEvents(
  sessionId: string,
  afterSeq: number,
  onEvent: (event: RuntimeEvent) => void,
  onClose: () => void,
): Promise<EventSource> {
  // 每次连接都领取新的短期凭证；重连时不能复用已消费的 token。
  const { token } = await request<{ token: string }>("/events/token", { method: "POST", body: "{}" });
  const url = new URL(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/events/stream?afterSeq=${afterSeq}&token=${encodeURIComponent(token)}`,
    location.origin,
  );
  const source = new EventSource(url);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as RuntimeEvent);
    } catch {
      source.close();
      onClose();
    }
  };
  source.onerror = () => {
    source.close();
    onClose();
  };
  return source;
}

/** 向 Host 预览校验完整 Skill 包，尚不安装。 */
export async function previewSkill(files: SkillPackageFile[]): Promise<{
  name: string;
  description: string;
  content: string;
  files: Array<{ path: string; sizeBytes: number }>;
  packageHash: string;
  expectedRevision: number;
}> {
  return request("/capabilities/skills/preview", { method: "POST", body: JSON.stringify({ files }) });
}
/** 以稳定键原子安装一份用户 Skill 版本。 */
export async function installSkill(
  files: SkillPackageFile[],
  expectedRevision: number,
  roles: CapabilityRole[],
  key: string,
): Promise<StoredSkillVersion> {
  return request("/capabilities/skills", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ files, expectedRevision, enabled: true, roles }),
  });
}
/** 读取 Skill 原文、引用文件与版本记录。 */
export async function getSkill(name: string): Promise<SkillDetail> {
  return request(`/capabilities/skills/${encodeURIComponent(name)}`);
}
/** 保存启停、关联或选定的历史回滚版本。 */
export async function updateSkill(
  name: string,
  input: { expectedRevision: number; enabled: boolean; roles: CapabilityRole[]; rollbackRevision: number | null },
  key: string,
): Promise<StoredSkillVersion> {
  return request(`/capabilities/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify(input),
  });
}
/** 按已读版本更新角色职责和关联方法。 */
export async function saveExpert(
  role: CapabilityRole,
  expectedRevision: number,
  fields: Pick<ExpertConfiguration, "name" | "description" | "instructions" | "skillNames">,
  key: string,
): Promise<ExpertConfiguration> {
  return request(`/capabilities/experts/${role}`, {
    method: "PUT",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ expectedRevision, fields }),
  });
}
/** 更新专家团信息及启用成员。 */
export async function saveExpertTeam(
  expectedRevision: number,
  fields: Pick<TeamConfiguration, "name" | "description" | "enabledRoles">,
  key: string,
): Promise<TeamConfiguration> {
  return request("/capabilities/team", {
    method: "PUT",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ expectedRevision, fields }),
  });
}

/** 按日期范围读取工作计划、内容任务和运行摘要。 */
export async function getWorkbenchBoard(from: string, to: string, merchantId?: string): Promise<WorkbenchBoard> {
  const params = new URLSearchParams({ from, to });
  if (merchantId) params.set("merchantId", merchantId);
  return request(`/workbench?${params}`);
}
/** 保存人工排期，计划 ID 在编辑器中生成并保持稳定。 */
export async function saveWorkPlan(
  planId: string,
  expectedRevision: number,
  fields: WorkPlanFields,
  key: string,
): Promise<WorkPlan> {
  return request(`/work-plans/${encodeURIComponent(planId)}`, {
    method: "PUT",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ expectedRevision, fields }),
  });
}
/** 读取商家实拍素材，商品筛选只改变列表不扩大归属。 */
export async function listMerchantMedia(merchantId: string, productEntryId?: string): Promise<MerchantMedia[]> {
  return (
    await request<{ items: MerchantMedia[] }>(
      `/merchants/${merchantId}/media${productEntryId ? `?productEntryId=${encodeURIComponent(productEntryId)}` : ""}`,
    )
  ).items;
}
/** 上传由用户明确选择的图片，保留业务归属与稳定命令键。 */
export async function uploadMerchantMedia(
  merchantId: string,
  productEntryId: string | null,
  file: File,
  key: string,
): Promise<MerchantMedia> {
  const params = new URLSearchParams({ title: file.name });
  if (productEntryId) params.set("productEntryId", productEntryId);
  return request(`/merchants/${merchantId}/media?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-File-Type": file.type, "Idempotency-Key": key },
    body: file,
  });
}
/** 构造受配对保护的商家素材预览地址。 */
export function merchantMediaUrl(item: MerchantMedia): string {
  return `/api/v1/merchants/${item.merchantId}/media/${item.mediaId}/content`;
}
/** 停用或重新启用资料，已引用版本仍保留。 */
export async function updateMerchantMedia(
  item: MerchantMedia,
  status: MerchantMedia["status"],
  key: string,
): Promise<MerchantMedia> {
  return request(`/merchants/${item.merchantId}/media/${item.mediaId}`, {
    method: "PUT",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ expectedRevision: item.revision, status }),
  });
}
/** 将用户选定的同商家素材加入当前会话供配图采用。 */
export async function importMerchantMedia(
  sessionId: string,
  mediaIds: string[],
  key: string,
): Promise<ArtifactRecord[]> {
  return (
    await request<{ items: ArtifactRecord[] }>(`/sessions/${sessionId}/media`, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ mediaIds }),
    })
  ).items;
}
/** 读取该草稿的独立审核历史和进行中的任务。 */
export async function getPublicationReviews(
  sessionId: string,
  draftId: string,
): Promise<{ reviews: PublicationReview[]; job: TextGenerationJobRecord | null }> {
  return request(`/sessions/${sessionId}/content-drafts/${draftId}/publication/reviews`);
}
/** 为已保存双版本发起真正的审核角色 Run。 */
export async function reviewPublication(
  sessionId: string,
  draftId: string,
  draftRevision: number,
  publicationRevision: number,
  key: string,
): Promise<TextGenerationJobRecord> {
  return request(`/sessions/${sessionId}/content-drafts/${draftId}/publication/reviews`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ draftRevision, publicationRevision }),
  });
}
/** 人工对账未知请求，处理完成后才允许用户显式新建付费尝试。 */
export async function reconcileImageJob(
  sessionId: string,
  jobId: string,
  input: { resolution: "NO_RESULT" | "ADOPT_IMAGE"; artifactId: string | null; note: string },
  key: string,
): Promise<{ jobId: string; status: string }> {
  return request(`/sessions/${sessionId}/generation-jobs/${jobId}/reconcile`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ ...input, confirmed: true }),
  });
}
/** 读取用户登记的发布链接和表现反馈。 */
export async function getPublicationRecord(sessionId: string, draftId: string): Promise<PublicationRecordLink | null> {
  return request(`/sessions/${sessionId}/content-drafts/${draftId}/published`);
}
/** 保存与固定发布包关联的人工发布及反馈记录。 */
export async function savePublicationRecord(
  sessionId: string,
  draftId: string,
  input: Omit<PublicationRecordLink, "recordId" | "draftId" | "revision" | "createdAt" | "updatedAt">,
  expectedRevision: number,
  key: string,
): Promise<PublicationRecordLink> {
  return request(`/sessions/${sessionId}/content-drafts/${draftId}/published`, {
    method: "PUT",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ ...input, expectedRevision }),
  });
}

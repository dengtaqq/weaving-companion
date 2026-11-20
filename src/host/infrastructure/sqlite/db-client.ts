import { Worker } from "node:worker_threads";
import type {
  CapabilityRole,
  CapabilityState,
  ExpertConfiguration,
  SkillPackageFile,
  StoredSkillVersion,
  TeamConfiguration,
} from "../../../shared/capabilities.js";
import type {
  AcceptedMessage,
  AccountDiagnosisDraft,
  AccountDiagnosisRecord,
  ArtifactRecord,
  ContentDraftRecord,
  ContentRevisionRecord,
  ContextCheckpointRecord,
  DelegationAttemptRecord,
  DelegationInputSnapshot,
  DelegationRecord,
  DelegationTaskV2,
  GenerationJobRecord,
  MemoryFields,
  MemoryJob,
  MemoryMessageSource,
  MemoryScope,
  MemorySummary,
  MerchantCatalogEntry,
  MerchantCatalogInput,
  MerchantDetail,
  MerchantLinkInput,
  MerchantMemory,
  MerchantPlatformLink,
  MerchantProfileFields,
  MerchantProfileRecord,
  MerchantRecord,
  MessageRecord,
  MessageSearchHit,
  ModelUsageSummary,
  PublicDiagnosisReportRecord,
  PublicPageEvidenceRecord,
  RunRecord,
  RuntimeEvent,
  SessionDeleteImpact,
  SessionPage,
  SessionRecord,
  SessionSnapshot,
  TextGenerationJobRecord,
  UpdateMemoryInput,
  UpdateMerchantLinkInput,
} from "../../../shared/contracts.js";
import type { AgentMaterialRef, ExpertTaskV3 } from "../../../shared/expert-contract.js";
import type {
  PublicationDetail,
  PublicationExport,
  PublicationFields,
  PublicationImageTarget,
  PublicationRecord,
  PublicationReview,
  PublicationSnapshot,
} from "../../../shared/publication.js";
import type { PublicationConversationInput } from "../../../shared/publication-conversation.js";
import type {
  ContentAnalysis,
  ResearchAdoptInput,
  ResearchBatch,
  ResearchLibraryItem,
  ResearchReport,
  ResearchSaveInput,
  ResearchScope,
} from "../../../shared/research.js";
import type { BackgroundResearchReceipt } from "../../../shared/research-agent.js";
import type { ResearchMemorySnapshot } from "../../../shared/research-memory.js";
import type {
  CurrentTaskStatus,
  CurrentTaskStatusRequest,
  TaskContextRef,
  TaskContextSnapshot,
  TaskContextView,
} from "../../../shared/task-context.js";
import type {
  TaskBudgetActor,
  TaskBudgetKind,
  TaskExecutionControl,
  TaskExecutionLimits,
} from "../../../shared/task-execution.js";
import type { TopicCard, TopicCreationInput, TopicPlanInput, TopicUpdateInput } from "../../../shared/topics.js";
import type {
  MerchantMedia,
  PublicationRecordLink,
  WorkbenchBoard,
  WorkPlan,
  WorkPlanFields,
} from "../../../shared/workbench.js";
import type { ModelConfig } from "../../config.js";
import type { MemoryEmbeddingRecord, MemoryEmbeddingRef } from "../../modules/merchants/domain/memory-retrieval.js";
import type { CollectedPublicPage } from "../../modules/research/infrastructure/public-page-collector.js";
import type { RuntimePlan, RuntimePlanConfig, SystemPromptSetting } from "../../runtime/execution/runtime-plan.js";
import type { MainHistoryView } from "../../runtime/history/main-history.js";
import type { PiRuntimeEvent, RuntimeStateSnapshot } from "../../runtime/ports/pi-runtime-port.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

interface DbReply {
  id: number;
  result?: unknown;
  error?: string;
}

export interface StoredSession extends SessionRecord {
  piSessionFile: string | null;
}

interface StoredSessionSnapshot extends Omit<SessionSnapshot, "session"> {
  session: StoredSession;
}

export interface StoredMerchantContextSnapshot {
  memoryScope?: MemoryScope;
  snapshotId: string;
  merchantId: string;
  sha256: string;
  profile: MerchantProfileRecord;
  links: MerchantPlatformLink[];
  memories?: MerchantMemory[];
  catalog?: MerchantCatalogEntry[];
  researchScope?: ResearchScope;
  researchLibrary?: ResearchLibraryItem[];
}

export interface StoredMemoryJob extends MemoryJob {
  sources: MemoryMessageSource[];
  model: Omit<ModelConfig, "apiKey"> | null;
}

/** 通过 Worker 调用 SQLite，避免同步数据库操作阻塞 HTTP 事件循环。 */
export class DbClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private workerFailure: Error | null = null;

  /** 启动隔离的 SQLite Worker 并建立请求响应映射。 */
  constructor(dbPath: string) {
    this.worker = new Worker(new URL("./db-worker.js", import.meta.url), { workerData: { dbPath } });
    this.worker.on("message", (reply: DbReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(reply.error));
      else pending.resolve(reply.result);
    });
    this.worker.on("error", (error) => this.failWorker(error));
    this.worker.on("exit", (code) => {
      this.failWorker(new Error(`DB Worker 退出：${code}`));
    });
  }

  /** 在数据库 Worker 异常时拒绝所有未完成请求。 */
  private failWorker(error: Error): void {
    this.workerFailure = error;
    this.rejectPending(error);
  }

  /** 统一清理等待 Worker 回应的请求。 */
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** 为 SQLite Worker 操作分配请求 ID，并匹配异步响应。 */
  private request<T>(name: string, ...args: unknown[]): Promise<T> {
    // 请求 ID 对应 Worker 回复；Worker 异常时统一拒绝所有等待中的请求。
    if (this.workerFailure) return Promise.reject(this.workerFailure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, name, args });
    });
  }

  /** 读取人工计划及真实内容任务阶段。 */
  getWorkbenchBoard(from: string, to: string, merchantId?: string): Promise<WorkbenchBoard> {
    return this.request("getWorkbenchBoard", from, to, merchantId);
  }
  /** 按版本创建或修订人工工作计划。 */
  saveWorkPlan(planId: string, expectedRevision: number, fields: WorkPlanFields, key: string): Promise<WorkPlan> {
    return this.request("saveWorkPlan", planId, expectedRevision, fields, `workbench:${key}`, new Date().toISOString());
  }
  /** 列出商家或指定商品的受管实拍资料。 */
  listMerchantMedia(merchantId: string, productEntryId?: string): Promise<MerchantMedia[]> {
    return this.request("listMerchantMedia", merchantId, productEntryId);
  }
  /** 登记已保存文件的素材记录及归属。 */
  createMerchantMedia(
    merchantId: string,
    productEntryId: string | null,
    title: string,
    hash: string,
    mime: string,
    size: number,
    key: string,
  ): Promise<MerchantMedia> {
    return this.request(
      "createMerchantMedia",
      merchantId,
      productEntryId,
      title,
      hash,
      mime,
      size,
      `workbench:${key}`,
      new Date().toISOString(),
    );
  }
  /** 版本化启停商家素材，保留已引用副本。 */
  updateMerchantMedia(
    merchantId: string,
    mediaId: string,
    revision: number,
    status: MerchantMedia["status"],
    key: string,
  ): Promise<MerchantMedia> {
    return this.request(
      "updateMerchantMedia",
      merchantId,
      mediaId,
      revision,
      status,
      `workbench:${key}`,
      new Date().toISOString(),
    );
  }
  /** 用户明确采用后将同商家素材登记到会话白名单候选。 */
  importMerchantMedia(sessionId: string, mediaIds: string[], key: string): Promise<ArtifactRecord[]> {
    return this.request("importMerchantMedia", sessionId, mediaIds, `workbench:${key}`, new Date().toISOString());
  }
  /** 对已确认交付包保存用户人工发布登记与反馈。 */
  savePublicationRecord(
    sessionId: string,
    draftId: string,
    artifactId: string,
    url: string,
    publishedAt: string,
    note: string,
    metrics: PublicationRecordLink["metrics"],
    expectedRevision: number,
    key: string,
  ): Promise<PublicationRecordLink> {
    return this.request(
      "savePublicationRecord",
      sessionId,
      draftId,
      artifactId,
      url,
      publishedAt,
      note,
      metrics,
      expectedRevision,
      `workbench:${key}`,
      new Date().toISOString(),
    );
  }
  /** 读取固定交付包的人工发布记录。 */
  getPublicationRecord(sessionId: string, draftId: string): Promise<PublicationRecordLink | null> {
    return this.request("getPublicationRecord", sessionId, draftId);
  }
  /** 显式登记未知图片请求的人工核对结果，不执行第二次付费请求。 */
  reconcileImageJob(
    sessionId: string,
    jobId: string,
    resolution: "NO_RESULT" | "ADOPT_IMAGE",
    artifactId: string | null,
    note: string,
    key: string,
  ): Promise<{ jobId: string; status: string; resolution: string; note: string; artifactId: string | null }> {
    return this.request(
      "reconcileImageJob",
      sessionId,
      jobId,
      resolution,
      artifactId,
      note,
      `workbench:${key}`,
      new Date().toISOString(),
    );
  }

  /** 读取用户安装的 Skill 与角色/团队配置。 */
  getCapabilityState(): Promise<CapabilityState> {
    return this.request("getCapabilityState");
  }
  /** 原子安装完整 Skill 包，响应丢失时复用同一命令。 */
  installSkillPackage(
    files: SkillPackageFile[],
    expectedRevision: number,
    enabled: boolean,
    roles: CapabilityRole[],
    builtinNames: string[],
    key: string,
  ): Promise<StoredSkillVersion> {
    return this.request(
      "installSkillPackage",
      files,
      expectedRevision,
      enabled,
      roles,
      builtinNames,
      `capability:${key}`,
      new Date().toISOString(),
    );
  }
  /** 为启停、关联或回滚追加一个新版本。 */
  updateInstalledSkill(
    name: string,
    expectedRevision: number,
    enabled: boolean,
    roles: CapabilityRole[],
    rollbackRevision: number | null,
    key: string,
  ): Promise<StoredSkillVersion> {
    return this.request(
      "updateInstalledSkill",
      name,
      expectedRevision,
      enabled,
      roles,
      rollbackRevision,
      `capability:${key}`,
      new Date().toISOString(),
    );
  }
  /** 读取已安装 Skill 的原文件与历史版本摘要。 */
  getInstalledSkill(name: string): Promise<{
    current: StoredSkillVersion | null;
    versions: Array<{ revision: number; packageHash: string; createdAt: string }>;
  }> {
    return this.request("getInstalledSkill", name);
  }
  /** 保存角色职责与 Skill 选集，使用版本保护并发编辑。 */
  saveExpertConfiguration(
    input: ExpertConfiguration,
    expectedRevision: number,
    key: string,
  ): Promise<ExpertConfiguration> {
    return this.request(
      "saveExpertConfiguration",
      input,
      expectedRevision,
      `capability:${key}`,
      new Date().toISOString(),
    );
  }
  /** 保存团队名称和启用角色，权限由固定工具目录约束。 */
  saveTeamConfiguration(input: TeamConfiguration, expectedRevision: number, key: string): Promise<TeamConfiguration> {
    return this.request(
      "saveTeamConfiguration",
      input,
      expectedRevision,
      `capability:${key}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：检查数据库完整性和已应用的迁移版本。 */
  health(): Promise<{ quickCheck: string; schemaVersion: number }> {
    return this.request("health");
  }

  /** 向 SQLite Worker 请求：读取全局系统提示词及版本。 */
  getSystemPrompt(): Promise<SystemPromptSetting> {
    return this.request("getSystemPrompt");
  }

  /** 向 SQLite Worker 请求：按预期版本更新全局系统提示词。 */
  updateSystemPrompt(content: string, revision: number, operationKey: string): Promise<SystemPromptSetting> {
    return this.request(
      "updateSystemPrompt",
      content,
      revision,
      `systemPrompt:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：创建商家及初始人工档案。 */
  createMerchant(name: string, operationKey: string): Promise<MerchantDetail> {
    return this.request(
      "createMerchant",
      `mer_${crypto.randomUUID()}`,
      name,
      `merchant:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：列出本机维护的商家摘要。 */
  listMerchants(): Promise<MerchantRecord[]> {
    return this.request("listMerchants");
  }

  /** 向 SQLite Worker 请求：读取指定商家的完整人工档案。 */
  getMerchant(merchantId: string): Promise<MerchantDetail | null> {
    return this.request("getMerchant", merchantId);
  }

  /** 列出商家的商品库和带来源标记的选题线索。 */
  listMerchantCatalog(merchantId: string): Promise<MerchantCatalogEntry[]> {
    return this.request("listMerchantCatalog", merchantId);
  }

  /** 保存人工维护的商品或选题来源。 */
  createMerchantCatalogEntry(
    merchantId: string,
    input: MerchantCatalogInput,
    operationKey: string,
  ): Promise<MerchantCatalogEntry> {
    return this.request(
      "createMerchantCatalogEntry",
      merchantId,
      `mce_${crypto.randomUUID()}`,
      input,
      `merchantCatalog:${merchantId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 按版本修订或停用商品和选题线索。 */
  updateMerchantCatalogEntry(
    merchantId: string,
    entryId: string,
    expectedRevision: number,
    input: MerchantCatalogInput,
    status: "ACTIVE" | "INACTIVE",
    operationKey: string,
  ): Promise<MerchantCatalogEntry> {
    return this.request(
      "updateMerchantCatalogEntry",
      merchantId,
      entryId,
      expectedRevision,
      input,
      status,
      `merchantCatalog:${merchantId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：读取 Run 受理时冻结的商家上下文。 */
  getMerchantContextSnapshot(snapshotId: string): Promise<StoredMerchantContextSnapshot | null> {
    return this.request("getMerchantContextSnapshot", snapshotId);
  }

  /** 向 SQLite Worker 请求：保存公开页面的原始可见内容与来源信息。 */
  createPublicEvidence(
    merchantId: string | null,
    sessionId: string,
    runId: string,
    page: CollectedPublicPage,
  ): Promise<PublicPageEvidenceRecord> {
    return this.request("createPublicEvidence", `evd_${crypto.randomUUID()}`, merchantId, sessionId, runId, page);
  }

  /** 向 SQLite Worker 请求：按 ID 读取一条公开页面证据。 */
  getPublicEvidence(evidenceId: string): Promise<PublicPageEvidenceRecord | null> {
    return this.request("getPublicEvidence", evidenceId);
  }

  /** 向 SQLite Worker 请求：读取当前 Run 对指定 URL 已生成的证据。 */
  getPublicEvidenceForRun(runId: string, sourceUrl: string): Promise<PublicPageEvidenceRecord | null> {
    return this.request("getPublicEvidenceForRun", runId, sourceUrl);
  }

  /** 向 SQLite Worker 请求：读取指定商家的公开页面证据列表。 */
  listPublicEvidence(merchantId: string): Promise<PublicPageEvidenceRecord[]> {
    return this.request("listPublicEvidence", merchantId);
  }

  /** 向 SQLite Worker 请求：验证证据引用与草稿版本后追加账号诊断 DRAFT。 */
  saveAccountDiagnosis(
    merchantId: string | null,
    sessionId: string,
    runId: string,
    profileRevision: number | null,
    evidenceIds: string[],
    revisesDiagnosisId: string | null,
    report: AccountDiagnosisDraft,
  ): Promise<AccountDiagnosisRecord> {
    return this.request(
      "saveAccountDiagnosis",
      `dia_${crypto.randomUUID()}`,
      merchantId,
      sessionId,
      runId,
      profileRevision,
      evidenceIds,
      revisesDiagnosisId,
      report,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：按 ID 读取账号诊断草稿及来源快照。 */
  getAccountDiagnosis(diagnosisId: string): Promise<AccountDiagnosisRecord | null> {
    return this.request("getAccountDiagnosis", diagnosisId);
  }

  /** 向 SQLite Worker 请求：读取指定商家的账号诊断草稿列表。 */
  listAccountDiagnoses(merchantId: string): Promise<AccountDiagnosisRecord[]> {
    return this.request("listAccountDiagnoses", merchantId);
  }

  /** 登记经用户选择导出的公开资料报告及其不可变 Markdown 文件。 */
  publishPublicDiagnosisReport(
    merchantId: string,
    diagnosisId: string,
    hash: string,
    size: number,
  ): Promise<PublicDiagnosisReportRecord> {
    return this.request(
      "publishPublicDiagnosisReport",
      `pdr_${crypto.randomUUID()}`,
      `art_${crypto.randomUUID()}`,
      merchantId,
      diagnosisId,
      hash,
      size,
      new Date().toISOString(),
    );
  }

  /** 列出当前商家的公开资料报告。 */
  listPublicDiagnosisReports(merchantId: string): Promise<PublicDiagnosisReportRecord[]> {
    return this.request("listPublicDiagnosisReports", merchantId);
  }

  /** 按归属读取公开资料报告。 */
  getPublicDiagnosisReport(merchantId: string, reportId: string): Promise<PublicDiagnosisReportRecord | null> {
    return this.request("getPublicDiagnosisReport", merchantId, reportId);
  }

  /** 向 SQLite Worker 请求：列出普通会话归属的账号诊断草稿。 */
  listSessionAccountDiagnoses(sessionId: string): Promise<AccountDiagnosisRecord[]> {
    return this.request("listSessionAccountDiagnoses", sessionId);
  }

  /** 列出商家的记忆及当前候选，正文包含可追溯来源。 */
  listMemories(merchantId: string): Promise<MerchantMemory[]> {
    return this.request("listMemories", merchantId);
  }

  /** 读取商家冻结版本在指定向量模型下的派生缓存。 */
  getMemoryEmbeddings(
    merchantId: string,
    embeddingKey: string,
    refs: MemoryEmbeddingRef[],
  ): Promise<MemoryEmbeddingRecord[]> {
    return this.request("getMemoryEmbeddings", merchantId, embeddingKey, refs);
  }

  /** 保存经过来源校验的向量缓存，不改写记忆正文或有效状态。 */
  saveMemoryEmbeddings(merchantId: string, embeddingKey: string, records: MemoryEmbeddingRecord[]): Promise<void> {
    return this.request("saveMemoryEmbeddings", merchantId, embeddingKey, records, new Date().toISOString());
  }

  /** 按商家归属读取记忆的历史版本。 */
  memoryHistory(merchantId: string, memoryId: string): Promise<MerchantMemory[]> {
    return this.request("memoryHistory", merchantId, memoryId);
  }

  /** 保存人工明确确认的长期记忆。 */
  createMemory(merchantId: string, input: MemoryFields, operationKey: string): Promise<MerchantMemory> {
    return this.request(
      "createMemory",
      merchantId,
      input,
      `memory:${merchantId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 按预期版本编辑、确认候选或停用记忆。 */
  updateMemory(
    merchantId: string,
    memoryId: string,
    input: UpdateMemoryInput,
    operationKey: string,
  ): Promise<MerchantMemory> {
    return this.request(
      "updateMemory",
      merchantId,
      memoryId,
      input,
      `memory:${merchantId}:${memoryId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 归档无活动 Run 的商家会话并登记独立总结任务。 */
  archiveForMemory(sessionId: string, model: StoredMemoryJob["model"], operationKey: string): Promise<MemoryJob> {
    return this.request(
      "archiveForMemory",
      sessionId,
      model,
      `archive:${sessionId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 列出商家的归档总结任务和真实执行状态。 */
  listMemoryJobs(merchantId: string): Promise<MemoryJob[]> {
    return this.request("listMemoryJobs", merchantId);
  }

  /** 显式重试失败任务并为新尝试固定非秘密模型配置。 */
  retryMemoryJob(
    merchantId: string,
    jobId: string,
    model: StoredMemoryJob["model"],
    operationKey: string,
  ): Promise<MemoryJob> {
    return this.request(
      "retryMemoryJob",
      merchantId,
      jobId,
      model,
      `memoryRetry:${merchantId}:${jobId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 对账重启前的总结任务，最多自动恢复一次。 */
  recoverMemoryJobs(): Promise<void> {
    return this.request("recoverMemoryJobs", new Date().toISOString());
  }

  /** 原子领取一个待处理总结任务。 */
  claimMemoryJob(): Promise<StoredMemoryJob | null> {
    return this.request("claimMemoryJob", new Date().toISOString());
  }

  /** 校验来源并原子提交总结及长期候选，或记录失败。 */
  finishMemoryJob(
    jobId: string,
    attempt: number,
    result: MemorySummary | null,
    errorCode: string | null,
  ): Promise<void> {
    return this.request("finishMemoryJob", jobId, attempt, result, errorCode, new Date().toISOString());
  }

  /** 恢复归档会话，保留原总结与历史记录。 */
  restoreSession(sessionId: string, operationKey: string): Promise<StoredSession> {
    return this.request("restoreSession", sessionId, `restore:${sessionId}:${operationKey}`, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：按版本更新人工确认的商家档案。 */
  updateMerchantProfile(
    merchantId: string,
    expectedRevision: number,
    fields: MerchantProfileFields,
    operationKey: string,
  ): Promise<MerchantDetail> {
    return this.request(
      "updateMerchantProfile",
      merchantId,
      expectedRevision,
      fields,
      `merchantProfile:${merchantId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：保存商家提供的平台链接，不将其视为已采集证据。 */
  createMerchantLink(
    merchantId: string,
    input: MerchantLinkInput,
    operationKey: string,
  ): Promise<MerchantPlatformLink> {
    return this.request(
      "createMerchantLink",
      merchantId,
      `mlk_${crypto.randomUUID()}`,
      input,
      `merchantLink:${merchantId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：按版本修改已有平台链接。 */
  updateMerchantLink(
    merchantId: string,
    linkId: string,
    input: UpdateMerchantLinkInput,
    operationKey: string,
  ): Promise<MerchantPlatformLink> {
    return this.request(
      "updateMerchantLink",
      merchantId,
      linkId,
      input,
      `merchantLinkUpdate:${merchantId}:${linkId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：按版本停用平台链接并保留历史记录。 */
  disableMerchantLink(
    merchantId: string,
    linkId: string,
    expectedRevision: number,
    operationKey: string,
  ): Promise<MerchantPlatformLink> {
    return this.request(
      "disableMerchantLink",
      merchantId,
      linkId,
      expectedRevision,
      `merchantLinkDisable:${merchantId}:${linkId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：创建普通会话并返回持久化记录。 */
  createSession(
    title: string,
    modelAlias: string,
    adapterVersion: string,
    operationKey: string,
  ): Promise<StoredSession> {
    return this.request(
      "createSession",
      `ses_${crypto.randomUUID()}`,
      title,
      modelAlias,
      adapterVersion,
      `session:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：创建归属于指定商家的新会话。 */
  createMerchantSession(
    merchantId: string,
    title: string,
    modelAlias: string,
    adapterVersion: string,
    operationKey: string,
    researchScope?: ResearchScope,
  ): Promise<StoredSession> {
    return this.request(
      "createMerchantSession",
      `ses_${crypto.randomUUID()}`,
      merchantId,
      title,
      modelAlias,
      adapterVersion,
      `merchantSession:${merchantId}:${operationKey}`,
      new Date().toISOString(),
      researchScope,
    );
  }

  /** 向 SQLite Worker 请求：保存当前商家 Run 的不可变研究候选。 */
  saveResearchBatch(sessionId: string, runId: string, input: ResearchSaveInput): Promise<ResearchBatch> {
    return this.request("saveResearchBatch", sessionId, runId, input, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：按商家及可选会话读取研究候选。 */
  listResearchBatches(merchantId: string, sessionId?: string): Promise<ResearchBatch[]> {
    return this.request("listResearchBatches", merchantId, sessionId);
  }

  /** 向 SQLite Worker 请求：读取研究会话的分析状态与历史尝试。 */
  listContentAnalyses(merchantId: string, sessionId?: string): Promise<ContentAnalysis[]> {
    return this.request("listContentAnalyses", merchantId, sessionId);
  }

  /** 向 SQLite Worker 请求：读取成功研究 Run 的固定模板报告。 */
  listResearchReports(merchantId: string, sessionId?: string): Promise<ResearchReport[]> {
    return this.request("listResearchReports", merchantId, sessionId);
  }

  /** 按商家读取一份报告，下载时继续核对报告与原批次的摘要。 */
  getResearchReport(merchantId: string, reportId: string): Promise<ResearchReport | null> {
    return this.request("getResearchReport", merchantId, reportId);
  }

  /** 向 SQLite Worker 请求：读取商家采用的研究建议及当前版本。 */
  listResearchLibrary(merchantId: string): Promise<ResearchLibraryItem[]> {
    return this.request("listResearchLibrary", merchantId);
  }

  /** 向 SQLite Worker 请求：用户采用候选或以 CAS 更新同类已有建议。 */
  adoptResearchCandidate(
    merchantId: string,
    batchId: string,
    input: ResearchAdoptInput,
    operationKey: string,
  ): Promise<ResearchLibraryItem> {
    return this.request(
      "adoptResearchCandidate",
      merchantId,
      batchId,
      input,
      `research:${merchantId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：停用研究建议并保留其历史版本。 */
  deactivateResearchItem(merchantId: string, itemId: string, expectedRevision: number): Promise<ResearchLibraryItem> {
    return this.request("deactivateResearchItem", merchantId, itemId, expectedRevision);
  }

  /** 向 SQLite Worker 请求：在无活动 Run 时将普通会话及其证据绑定到商家。 */
  bindSessionMerchant(sessionId: string, merchantId: string, operationKey: string): Promise<StoredSession> {
    return this.request(
      "bindSessionMerchant",
      sessionId,
      merchantId,
      `sessionMerchant:${sessionId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：列出工作台中的普通和商家会话。 */
  listSessions(): Promise<StoredSession[]> {
    return this.request("listSessions");
  }

  /** 按稳定游标读取活动会话或回收站。 */
  listSessionPage(
    status: "ACTIVE" | "TRASHED",
    cursor: string | null,
    limit = 50,
  ): Promise<Omit<SessionPage, "items"> & { items: StoredSession[] }> {
    return this.request("listSessionPage", status, cursor, limit);
  }

  /** 按标题版本更新会话，拒绝多窗口旧版本覆盖。 */
  renameSession(sessionId: string, title: string, expectedRevision: number, key: string): Promise<StoredSession> {
    return this.request(
      "renameSession",
      sessionId,
      title,
      expectedRevision,
      `rename:${sessionId}:${key}`,
      new Date().toISOString(),
    );
  }

  /** 归档普通会话，不生成商家记忆任务。 */
  archiveNormalSession(sessionId: string, key: string): Promise<StoredSession> {
    return this.request(
      "archiveNormalSession",
      sessionId,
      `archiveNormal:${sessionId}:${key}`,
      new Date().toISOString(),
    );
  }

  /** 返回删除前的影响清单和活动 Run 标识。 */
  sessionDeleteImpact(sessionId: string): Promise<SessionDeleteImpact> {
    return this.request("sessionDeleteImpact", sessionId);
  }

  /** 将会话移入保留三十天的回收站。 */
  trashSession(sessionId: string, key: string): Promise<StoredSession> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    return this.request("trashSession", sessionId, `trash:${sessionId}:${key}`, now.toISOString(), expiresAt);
  }

  /** 恢复回收站中的会话与原生命周期状态。 */
  restoreTrashedSession(sessionId: string, key: string): Promise<StoredSession> {
    return this.request("restoreTrashedSession", sessionId, `untrash:${sessionId}:${key}`, new Date().toISOString());
  }

  /** 冻结永久删除任务的来源并校验外部引用。 */
  prepareSessionPurge(
    sessionId: string,
  ): Promise<{ sessionId: string; phase: "PREPARED" | "COMMITTED" | "FINALIZED"; artifactHashes: string[] }> {
    return this.request("prepareSessionPurge", sessionId, new Date().toISOString());
  }

  /** 返回重启后仍需推进的永久删除任务。 */
  listPendingSessionPurges(): Promise<Array<{ sessionId: string; phase: "PREPARED" | "COMMITTED" }>> {
    return this.request("listPendingSessionPurges");
  }

  /** 列出保留期已满、可启动清理的回收站会话。 */
  listExpiredTrashedSessions(): Promise<string[]> {
    return this.request("listExpiredTrashedSessions", new Date().toISOString());
  }

  /** 暂存文件后原子删除数据库中的会话依赖。 */
  commitSessionPurge(sessionId: string): Promise<"COMMITTED" | "FINALIZED"> {
    return this.request("commitSessionPurge", sessionId, new Date().toISOString());
  }

  /** 读取当前删除任务需要清理的独占 Blob。 */
  listSessionBlobGc(sessionId: string): Promise<string[]> {
    return this.request("listSessionBlobGc", sessionId);
  }

  /** 清理 Blob 后释放阻止并发登记的数据库锁。 */
  finishSessionBlobGc(sessionId: string, hash: string): Promise<void> {
    return this.request("finishSessionBlobGc", sessionId, hash);
  }

  /** 暂存目录清理后将永久删除标为完成。 */
  finalizeSessionPurge(sessionId: string): Promise<"FINALIZED"> {
    return this.request("finalizeSessionPurge", sessionId, new Date().toISOString());
  }

  /** 单调推进已读消息行号，返回更新后的未读数。 */
  markSessionRead(sessionId: string, messageId: string): Promise<StoredSession> {
    return this.request("markSessionRead", sessionId, messageId, new Date().toISOString());
  }

  /** 搜索当前本机用户可见的消息，可限定一个商家。 */
  searchMessages(query: string, merchantId: string | null = null, limit = 30): Promise<MessageSearchHit[]> {
    return this.request("searchMessages", query, merchantId, limit);
  }

  /** 读取指定消息前后的历史用于搜索定位。 */
  messagesAround(sessionId: string, messageId: string, radius = 25): Promise<MessageRecord[]> {
    return this.request("messagesAround", sessionId, messageId, radius);
  }

  /** 向 SQLite Worker 请求：读取指定会话及其当前归属。 */
  /** 持久异步汇总任务与投递去重，在原文字队列调度。 */
  prepareAsyncResultSummaries(modelId: string): Promise<void> {
    return this.request("prepareAsyncResultSummaries", modelId, new Date().toISOString());
  }
  /** 消费已成功汇总的真实消息，不重复生成。 */
  completeAsyncResultSummary(sessionId: string, jobId: string): Promise<void> {
    return this.request("completeAsyncResultSummary", sessionId, jobId, new Date().toISOString());
  }
  /** 分段读取已授权会话的原任务记录，保留完整正文供模型按需回读。 */
  readTaskHistory(
    sessionId: string,
    jobId: string,
    section: "INPUT" | "RESULT",
    offset: number,
    limit: number,
  ): Promise<{
    jobId: string;
    purpose: string;
    section: string;
    sha256: string;
    offset: number;
    totalLength: number;
    nextOffset: number | null;
    text: string;
    note: string;
  }> {
    return this.request("readTaskHistory", sessionId, jobId, section, offset, limit);
  }
  /** 读取主历史的成果导航和可精确识别的内部输入hash。 */
  readMainHistoryView(sessionId: string): Promise<MainHistoryView> {
    return this.request("readMainHistoryView", sessionId);
  }
  /** 读取原根任务的共享额度。 */
  getTaskExecutionControl(sessionId: string, jobId: string): Promise<TaskExecutionControl | null> {
    return this.request("getTaskExecutionControl", sessionId, jobId);
  }
  /** 实际请求前在Worker原子预留，父子Attempt不能互相代用。 */
  reserveTaskExecution(actor: TaskBudgetActor, kind: TaskBudgetKind, key: string): Promise<boolean> {
    return this.request("reserveTaskExecution", actor, kind, key, new Date().toISOString());
  }
  /** 结算实际报告或未知用量，重复回调不重复记账。 */
  settleTaskExecution(actor: TaskBudgetActor, key: string, tokens: number | null): Promise<void> {
    return this.request("settleTaskExecution", actor, key, tokens, new Date().toISOString());
  }
  /** 恢复扫描收口中断的预留，不清零累计预算。 */
  reconcileTaskExecution(): Promise<void> {
    return this.request("reconcileTaskExecution", new Date().toISOString());
  }
  /** 人工带版本调整额度后恢复原任务。 */
  resumeTaskExecution(
    sessionId: string,
    jobId: string,
    revision: number,
    limits: TaskExecutionLimits,
    key: string,
  ): Promise<TaskExecutionControl> {
    return this.request(
      "resumeTaskExecution",
      sessionId,
      jobId,
      revision,
      limits,
      `task-resume:${sessionId}:${key}`,
      new Date().toISOString(),
    );
  }

  /** 读取当前会话的持久状态。 */
  getSession(sessionId: string): Promise<StoredSession | null> {
    return this.request("getSession", sessionId);
  }

  /** 向 SQLite Worker 请求：读取断线恢复所需的会话、消息、Run 与事件快照。 */
  getSessionSnapshot(sessionId: string): Promise<StoredSessionSnapshot | null> {
    return this.request("getSessionSnapshot", sessionId);
  }

  /** 向 SQLite Worker 请求：冻结消息与 Runtime Plan，写入排队 Run 后唤醒调度。 */
  acceptMessage(
    sessionId: string,
    content: string,
    clientTurnId: string,
    operationKey: string,
    planConfig: RuntimePlanConfig,
    artifactIds?: string[],
    generationJobId?: string,
    continueFromRunId?: string,
  ): Promise<AcceptedMessage & { event: RuntimeEvent | null }> {
    // 会话 ID 与操作键共同组成幂等范围，重试时返回同一个 Run。
    return this.request(
      "acceptMessage",
      sessionId,
      `msg_${crypto.randomUUID()}`,
      `run_${crypto.randomUUID()}`,
      content,
      clientTurnId,
      `message:${sessionId}:${operationKey}`,
      planConfig,
      artifactIds,
      `evt_${crypto.randomUUID()}`,
      new Date().toISOString(),
      generationJobId,
      continueFromRunId,
    );
  }

  /** 向 SQLite Worker 请求：分页读取当前会话的持久化消息。 */
  listMessages(sessionId: string, limit = 50, before: string | null = null): Promise<MessageRecord[]> {
    return this.request("listMessages", sessionId, limit, before);
  }

  /** 向 SQLite Worker 请求：按序号补拉当前会话的运行事件。 */
  listEvents(sessionId: string, afterSeq: number, limit = 500): Promise<RuntimeEvent[]> {
    return this.request("listEvents", sessionId, afterSeq, limit);
  }

  /** 向 SQLite Worker 请求：列出重启后需要重新唤醒的排队 Run。 */
  listQueuedRunIds(): Promise<string[]> {
    return this.request("listQueuedRunIds");
  }

  /** 向 SQLite Worker 请求：列出仍被附件引用的 Blob 供恢复检查。 */
  listBlobReferences(): Promise<Array<{ hash: string; sizeBytes: number }>> {
    return this.request("listBlobReferences");
  }

  /** 向 SQLite Worker 请求：读取指定 Run 的状态和归属。 */
  getRun(runId: string): Promise<RunRecord | null> {
    return this.request("getRun", runId);
  }

  /** 向 SQLite Worker 请求：读取消息受理时冻结的 Runtime Plan。 */
  getRunPlan(runId: string): Promise<RuntimePlan | null> {
    return this.request("getRunPlan", runId);
  }

  /** 向 SQLite Worker 请求：记录取消请求并生成可恢复的状态事件。 */
  requestRunCancellation(runId: string): Promise<{ run: RunRecord; events: RuntimeEvent[] }> {
    return this.request("requestRunCancellation", runId, `evt_${crypto.randomUUID()}`, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：事务性领取下一条允许执行的 Run。 */
  claimNextRun(occupiedSessionIds: string[] = []): Promise<RunRecord | null> {
    return this.request("claimNextRun", new Date().toISOString(), occupiedSessionIds);
  }

  /** 向 SQLite Worker 请求：读取当前 Run 原始用户请求。 */
  getRunPrompt(runId: string): Promise<string | null> {
    return this.request("getRunPrompt", runId);
  }

  /** 向 SQLite Worker 请求：将运行事件追加到会话序列。 */
  appendEvent(
    sessionId: string,
    runId: string,
    type: string,
    payload: Record<string, unknown>,
    expectedAttempt?: number,
  ): Promise<RuntimeEvent> {
    return this.request(
      "appendEvent",
      sessionId,
      runId,
      `evt_${crypto.randomUUID()}`,
      type,
      payload,
      new Date().toISOString(),
      expectedAttempt,
    );
  }

  /** 向 SQLite Worker 请求：保存压缩阶段与来源检查点。 */
  recordCompactionEvent(
    runId: string,
    detail: Extract<PiRuntimeEvent, { type: "compaction.started" | "compaction.finished" }>,
    expectedAttempt?: number,
  ): Promise<RuntimeEvent> {
    return this.request(
      "recordCompactionEvent",
      runId,
      detail,
      `evt_${crypto.randomUUID()}`,
      new Date().toISOString(),
      expectedAttempt,
    );
  }

  /** 向 SQLite Worker 请求：登记当前主 Run Attempt 的工作文件和完整性状态。 */
  recordRunSnapshot(runId: string, attempt: number, snapshot: RuntimeStateSnapshot): Promise<void> {
    return this.request("recordRunSnapshot", runId, attempt, snapshot, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：读取主 Run 尝试索引，仅供 Host 内部诊断。 */
  listRunSnapshots(runId: string): Promise<
    Array<{
      run_id: string;
      attempt: number;
      session_id: string;
      source_snapshot_ref: string | null;
      source_snapshot_hash: string | null;
      source_verification: RuntimeStateSnapshot["sourceVerification"];
      working_snapshot_ref: string;
      working_snapshot_hash: string | null;
      file_exists: number;
      status: "PREPARED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
      created_at: string;
      updated_at: string;
    }>
  > {
    return this.request("listRunSnapshots", runId);
  }

  /** 向 SQLite Worker 请求：事务性保存助手结果、终态和最后事件。 */
  finishRun(
    runId: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    text: string | null,
    errorCode: string | null,
    errorMessage: string | null,
    sessionFile: string | null,
    usage: ModelUsageSummary | null = null,
    expectedAttempt?: number,
    expectedSnapshotHash?: string | null,
  ): Promise<RuntimeEvent[]> {
    // 结果写入和完成事件由 Worker 在同一事务内处理。
    return this.request(
      "finishRun",
      runId,
      status,
      text,
      errorCode,
      errorMessage,
      sessionFile,
      usage,
      `msg_${crypto.randomUUID()}`,
      `evt_${crypto.randomUUID()}`,
      `evt_${crypto.randomUUID()}`,
      new Date().toISOString(),
      expectedAttempt,
      expectedSnapshotHash,
    );
  }

  /** 向 SQLite Worker 请求：启动时扫描中断的 Run 并写入明确恢复结果。 */
  recoverInterrupted(): Promise<RuntimeEvent[]> {
    return this.request("recoverInterrupted", new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：按稳定任务键幂等保留子任务。 */
  reserveDelegation(
    parentSessionId: string,
    parentRunId: string,
    inputHash: string,
    input: DelegationTaskV2 | ExpertTaskV3,
  ): Promise<DelegationRecord> {
    return this.request(
      "reserveDelegation",
      `dlg_${crypto.randomUUID()}`,
      parentSessionId,
      parentRunId,
      `ses_${crypto.randomUUID()}`,
      `run_${crypto.randomUUID()}`,
      inputHash,
      input,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：读取父 Run 对应的委派状态和结果。 */
  getDelegationForParentRun(parentRunId: string): Promise<DelegationRecord | null> {
    return this.request("getDelegationForParentRun", parentRunId);
  }

  /** 向 SQLite Worker 请求：列出父 Run 的全部专家任务。 */
  listDelegationsForParentRun(parentRunId: string): Promise<DelegationRecord[]> {
    return this.request("listDelegationsForParentRun", parentRunId);
  }

  /** 向 SQLite Worker 请求：按稳定任务键读取子任务。 */
  getDelegationForTask(parentRunId: string, taskKey: string): Promise<DelegationRecord | null> {
    return this.request("getDelegationForTask", parentRunId, taskKey);
  }

  /** 向 SQLite Worker 请求：按父消息边界读取同会话已提交消息的有界来源。 */
  listRecentMessagesForDelegation(
    sessionId: string,
    parentMessageId: string,
  ): Promise<Array<{ id: string; role: "user" | "assistant"; sha256: string; excerpt: string }>> {
    return this.request("listRecentMessagesForDelegation", sessionId, parentMessageId);
  }

  /** 向 SQLite Worker 请求：读取指定子任务。 */
  getDelegation(delegationId: string): Promise<DelegationRecord | null> {
    return this.request("getDelegation", delegationId);
  }

  /** 读取当前研究委派持久笔记，不将其作为商家长期记忆。 */
  getResearchMemory(delegationId: string): Promise<ResearchMemorySnapshot> {
    return this.request("getResearchMemory", delegationId);
  }

  /** 以原父轮稳定任务键受理后台研究，重试仅复用原Job。 */
  createBackgroundResearch(
    sessionId: string,
    runId: string,
    input: ExpertTaskV3,
    materials: Array<{ ref: AgentMaterialRef; text: string }>,
  ): Promise<BackgroundResearchReceipt> {
    return this.request("createBackgroundResearch", sessionId, runId, input, materials, new Date().toISOString());
  }

  /** 接纳已保存的研究结果并原子创建一次父会话续执行。 */
  completeResearchJob(sessionId: string, jobId: string): Promise<void> {
    return this.request("completeResearchJob", sessionId, jobId, new Date().toISOString());
  }

  /** 用父子尝试和乐观版本提交研究笔记与覆盖边界。 */
  saveResearchMemory(
    delegationId: string,
    attempt: number,
    parentAttempt: number,
    baseRevision: number,
    snapshot: ResearchMemorySnapshot,
  ): Promise<void> {
    return this.request("saveResearchMemory", delegationId, attempt, parentAttempt, baseRevision, snapshot);
  }

  /** 恢复时读取已冻结子 Plan，避免使用新工具版本重建导致旧 hash 改变。 */
  getDelegationPlan(delegationId: string): Promise<RuntimePlan | null> {
    return this.request("getDelegationPlan", delegationId);
  }

  /** 向 SQLite Worker 请求：读取专家任务的尝试历史。 */
  listDelegationAttempts(delegationId: string): Promise<DelegationAttemptRecord[]> {
    return this.request("listDelegationAttempts", delegationId);
  }

  /** 向 SQLite Worker 请求：查看指定会话的压缩检查点。 */
  listContextCheckpoints(sessionId: string): Promise<ContextCheckpointRecord[]> {
    return this.request("listContextCheckpoints", sessionId);
  }

  /** 向 SQLite Worker 请求：保存子 Agent 待用户回答的问题。 */
  askDelegation(delegationId: string, question: string): Promise<DelegationRecord> {
    return this.request("askDelegation", delegationId, question, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：保存用户对专家问题的回答。 */
  answerDelegation(delegationId: string, answer: string): Promise<DelegationRecord> {
    return this.request("answerDelegation", delegationId, answer, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：保存版本化的专家调整指令。 */
  steerDelegation(delegationId: string, content: string): Promise<{ delegation: DelegationRecord; version: number }> {
    return this.request("steerDelegation", delegationId, content, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：标记调整指令已排入 Pi 下一轮。 */
  markDelegationSteerDelivered(delegationId: string, version: number): Promise<void> {
    return this.request("markDelegationSteerDelivered", delegationId, version, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：列出重启子尝试所需的追加输入。 */
  listDelegationInstructions(
    delegationId: string,
  ): Promise<Array<{ version: number; kind: "ANSWER" | "STEER"; content: string }>> {
    return this.request("listDelegationInstructions", delegationId);
  }

  /** 向 SQLite Worker 请求：标记父工具已接收子任务结果。 */
  acknowledgeDelegation(delegationId: string): Promise<DelegationRecord> {
    return this.request("acknowledgeDelegation", delegationId, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：保存子任务实际授权输入和快照哈希。 */
  freezeDelegationInput(
    delegationId: string,
    snapshot: DelegationInputSnapshot,
    childPlanJson: string,
  ): Promise<DelegationRecord> {
    return this.request("freezeDelegationInput", delegationId, snapshot, childPlanJson);
  }

  /** 向 SQLite Worker 请求：把委派标记为正在运行。 */
  startDelegation(delegationId: string): Promise<DelegationRecord> {
    return this.request("startDelegation", delegationId, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：先保存子 Agent 的结构化结果再交给父 Agent。 */
  submitDelegation(
    delegationId: string,
    result: NonNullable<DelegationRecord["result"]>,
    expectedAttempt?: number,
    expectedParentAttempt?: number,
  ): Promise<DelegationRecord> {
    return this.request(
      "submitDelegation",
      delegationId,
      result,
      new Date().toISOString(),
      expectedAttempt,
      expectedParentAttempt,
    );
  }

  /** 向 SQLite Worker 请求：以失败或取消终态收口未完成的委派。 */
  finishDelegation(delegationId: string, status: "FAILED" | "CANCELLED", errorCode: string): Promise<DelegationRecord> {
    return this.request("finishDelegation", delegationId, status, errorCode, new Date().toISOString());
  }

  /** 将用户原话和可选稿件版本提交给图文对话统筹。 */
  createPublicationConversation(
    sessionId: string,
    input: PublicationConversationInput,
    modelId: string,
    imageModelId: string | null,
    key: string,
  ): Promise<TextGenerationJobRecord> {
    return this.request(
      "createPublicationConversation",
      `chat_${crypto.randomUUID()}`,
      sessionId,
      input,
      modelId,
      imageModelId,
      `publication-chat:${sessionId}:${key}`,
      new Date().toISOString(),
    );
  }
  /** 保存真实路由回复并开始可恢复的图文步骤。 */
  completePublicationConversation(sessionId: string, jobId: string): Promise<TextGenerationJobRecord> {
    return this.request("completePublicationConversation", sessionId, jobId, new Date().toISOString());
  }
  /** 获取仍需Host推进的对话，费用和最终确认等待期间不自动执行。 */
  listRunnablePublicationConversations(): Promise<Array<{ sessionId: string; jobId: string }>> {
    return this.request("listRunnablePublicationConversations");
  }
  /** 推进一个步骤，返回刚受理的图片任务交由原图片服务执行。 */
  advancePublicationConversation(
    sessionId: string,
    jobId: string,
    imageModelId: string | null,
    imageInput: boolean,
  ): Promise<GenerationJobRecord[]> {
    return this.request(
      "advancePublicationConversation",
      sessionId,
      jobId,
      imageModelId,
      imageInput,
      new Date().toISOString(),
    );
  }
  /** 将具体图片确认卡的用户授权保存到原持久步骤。 */
  approvePublicationConversationImage(
    sessionId: string,
    jobId: string,
    approvalId: string,
    draftRevision: number,
    publicationRevision: number,
  ): Promise<TextGenerationJobRecord> {
    return this.request(
      "approvePublicationConversationImage",
      sessionId,
      jobId,
      approvalId,
      draftRevision,
      publicationRevision,
      new Date().toISOString(),
    );
  }

  /** 受理固定版本的独立图文审核任务。 */
  createPublicationReviewJob(
    sessionId: string,
    draftId: string,
    draftRevision: number,
    publicationRevision: number,
    modelId: string,
    imageInput: boolean,
    key: string,
  ): Promise<TextGenerationJobRecord> {
    return this.request(
      "createPublicationReviewJob",
      `gen_${crypto.randomUUID()}`,
      sessionId,
      draftId,
      draftRevision,
      publicationRevision,
      modelId,
      imageInput,
      `publication-review:${sessionId}:${key}`,
      new Date().toISOString(),
    );
  }
  /** 保存真实审核角色成功 Run 的结构化结果。 */
  completePublicationReviewJob(sessionId: string, jobId: string): Promise<TextGenerationJobRecord> {
    return this.request("completePublicationReviewJob", sessionId, jobId, new Date().toISOString());
  }
  /** 查询审核及其固定图文版本，供页面识别历史结果。 */
  getPublicationReviews(
    sessionId: string,
    draftId: string,
  ): Promise<{ reviews: PublicationReview[]; job: TextGenerationJobRecord | null }> {
    return this.request("getPublicationReviews", sessionId, draftId);
  }

  /** 精确读取冻结任务上下文，旧 Run 不读取当前最新版。 */
  getTaskContextSnapshot(sessionId: string, ref: TaskContextRef): Promise<TaskContextSnapshot> {
    return this.request("getTaskContextSnapshot", sessionId, ref);
  }

  /** 以实际 Run/Attempt 读取只读进度，拒绝已取消或被替代的执行身份。 */
  getCurrentTaskStatus(sessionId: string, request: CurrentTaskStatusRequest): Promise<CurrentTaskStatus> {
    return this.request("getCurrentTaskStatus", sessionId, request);
  }

  /** 查询明确稿件或根任务的持续要求和当前业务成果。 */
  getTaskContextView(sessionId: string, draftId?: string, rootJobId?: string): Promise<TaskContextView | null> {
    return this.request("getTaskContextView", sessionId, draftId, rootJobId);
  }

  /** 读取当前笔记的正文、配图编排和已确认交付历史。 */
  getPublication(sessionId: string, draftId: string): Promise<PublicationDetail> {
    return this.request("getPublication", sessionId, draftId);
  }

  /** 将固定正文与当前编排交给 Agent 生成可校验的图位方案。 */
  createPublicationPlanningJob(
    sessionId: string,
    draftId: string,
    draftRevision: number,
    publicationRevision: number,
    brief: string,
    modelId: string,
    key: string,
    imageCount?: number,
  ): Promise<TextGenerationJobRecord> {
    return this.request(
      "createPublicationPlanningJob",
      `job_${crypto.randomUUID()}`,
      sessionId,
      draftId,
      draftRevision,
      publicationRevision,
      brief,
      modelId,
      `publication-plan:${sessionId}:${key}`,
      new Date().toISOString(),
      imageCount,
    );
  }
  /** 提交成功 Run 的图位规划，不将文字方案登记成已生成图片。 */
  completePublicationPlanningJob(sessionId: string, jobId: string): Promise<TextGenerationJobRecord> {
    return this.request("completePublicationPlanningJob", sessionId, jobId, new Date().toISOString());
  }

  /** 保存编排的下一版本，保留响应丢失时的幂等回执。 */
  savePublication(
    sessionId: string,
    draftId: string,
    revision: number,
    fields: PublicationFields,
    key: string,
  ): Promise<PublicationRecord> {
    return this.request(
      "savePublication",
      sessionId,
      draftId,
      revision,
      fields,
      `publication:${sessionId}:${key}`,
      new Date().toISOString(),
    );
  }

  /** 为 ZIP 构建读取同一版本的正文和图片元数据。 */
  getPublicationSnapshot(
    sessionId: string,
    draftId: string,
    draftRevision: number,
    publicationRevision: number,
  ): Promise<PublicationSnapshot> {
    return this.request("getPublicationSnapshot", sessionId, draftId, draftRevision, publicationRevision);
  }

  /** 用已落地的 ZIP Blob 登记不可变交付，提交前由 Worker 复核快照。 */
  completePublicationExport(
    sessionId: string,
    draftId: string,
    draftRevision: number,
    publicationRevision: number,
    snapshotHash: string,
    blobHash: string,
    size: number,
  ): Promise<PublicationExport> {
    return this.request(
      "completePublicationExport",
      sessionId,
      draftId,
      draftRevision,
      publicationRevision,
      snapshotHash,
      `pub_${crypto.randomUUID()}`,
      `art_${crypto.randomUUID()}`,
      blobHash,
      size,
      new Date().toISOString(),
    );
  }

  /** 列出指定会话已保存的素材草稿。 */
  listContentDrafts(sessionId: string): Promise<ContentDraftRecord[]> {
    return this.request("listContentDrafts", sessionId);
  }

  /** 读取一份素材草稿及所有不可变修订版。 */
  getContentDraft(
    sessionId: string,
    draftId: string,
  ): Promise<{ draft: ContentDraftRecord; revisions: ContentRevisionRecord[] } | null> {
    return this.request("getContentDraft", sessionId, draftId);
  }

  /** 从一条成功助手回复建立用户可编辑的素材草稿。 */
  createContentDraft(
    sessionId: string,
    messageId: string,
    title: string,
    operationKey: string,
  ): Promise<ContentDraftRecord> {
    return this.request(
      "createContentDraft",
      sessionId,
      messageId,
      title,
      `draft_${crypto.randomUUID()}`,
      `content:${sessionId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 通过预期版本追加素材草稿修订。 */
  reviseContentDraft(
    sessionId: string,
    draftId: string,
    revision: number,
    title: string,
    body: string,
    operationKey: string,
  ): Promise<ContentDraftRecord> {
    return this.request(
      "reviseContentDraft",
      sessionId,
      draftId,
      revision,
      title,
      body,
      `content:${sessionId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 将用户审核的草稿版本和已发布 Blob 原子登记为正式产物。 */
  approveContentDraft(
    sessionId: string,
    draftId: string,
    revision: number,
    hash: string,
    size: number,
    operationKey: string,
  ): Promise<ContentDraftRecord> {
    return this.request(
      "approveContentDraft",
      sessionId,
      draftId,
      revision,
      `art_${crypto.randomUUID()}`,
      hash,
      size,
      `content:${sessionId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：登记受管文件及其会话归属和 Blob 引用。 */
  createImageJob(
    sessionId: string,
    prompt: string,
    modelId: string,
    size: GenerationJobRecord["size"],
    quality: GenerationJobRecord["quality"],
    referenceArtifactId: string | null,
    operationKey: string,
    publication?: PublicationImageTarget,
  ): Promise<GenerationJobRecord> {
    return this.request(
      "createImageJob",
      `gen_${crypto.randomUUID()}`,
      sessionId,
      prompt,
      modelId,
      size,
      quality,
      referenceArtifactId,
      `generation:${sessionId}:${operationKey}`,
      new Date().toISOString(),
      publication,
    );
  }

  /** 列出当前会话的素材图片任务。 */
  listGenerationJobs(sessionId: string): Promise<GenerationJobRecord[]> {
    return this.request("listGenerationJobs", sessionId);
  }

  /** 读取当前会话持有的一次素材图片任务。 */
  getGenerationJob(sessionId: string, jobId: string): Promise<GenerationJobRecord | null> {
    return this.request("getGenerationJob", sessionId, jobId);
  }

  /** 在付费调用前持久化一次唯一执行尝试。 */
  claimGenerationJob(sessionId: string, jobId: string): Promise<GenerationJobRecord> {
    return this.request("claimGenerationJob", sessionId, jobId, new Date().toISOString());
  }

  /** 原子登记图片产物并完成素材任务。 */
  completeGenerationJob(
    sessionId: string,
    jobId: string,
    hash: string,
    size: number,
    mime: string,
    providerRequestId: string | null,
  ): Promise<GenerationJobRecord> {
    return this.request(
      "completeGenerationJob",
      sessionId,
      jobId,
      `art_${crypto.randomUUID()}`,
      hash,
      size,
      mime,
      providerRequestId,
      new Date().toISOString(),
    );
  }

  /** 记录明确失败或需要人工对账的外部请求。 */
  finishGenerationJob(
    sessionId: string,
    jobId: string,
    status: "FAILED" | "UNKNOWN_EXTERNAL",
    code: string,
    providerRequestId: string | null,
  ): Promise<GenerationJobRecord> {
    return this.request(
      "finishGenerationJob",
      sessionId,
      jobId,
      status,
      code,
      providerRequestId,
      new Date().toISOString(),
    );
  }

  /** 启动时保留已发送付费请求的不确定性，仅返回从未领取的任务。 */
  recoverGenerationJobs(): Promise<{ queued: GenerationJobRecord[]; unknown: number }> {
    return this.request("recoverGenerationJobs", new Date().toISOString());
  }

  /** 冻结文案简报、商品版本和可选的商品宣传模板。 */
  createTextGenerationJob(
    sessionId: string,
    title: string,
    brief: string,
    productEntryId: string | null,
    targetDraftId: string | null,
    expectedRevision: number | null,
    modelId: string,
    operationKey: string,
    topicCreation?: TopicCreationInput,
  ): Promise<TextGenerationJobRecord> {
    return this.request(
      "createTextGenerationJob",
      `gen_${crypto.randomUUID()}`,
      sessionId,
      title,
      brief,
      productEntryId,
      targetDraftId,
      expectedRevision,
      modelId,
      `generation:${sessionId}:${operationKey}`,
      new Date().toISOString(),
      topicCreation,
    );
  }

  /** 创建引用成功研究报告的可恢复选题规划任务。 */
  createTopicPlanningJob(
    sessionId: string,
    input: TopicPlanInput,
    modelId: string,
    key: string,
  ): Promise<TextGenerationJobRecord> {
    return this.request(
      "createTopicPlanningJob",
      `gen_${crypto.randomUUID()}`,
      sessionId,
      input,
      modelId,
      `topic-plan:${sessionId}:${key}`,
      new Date().toISOString(),
    );
  }

  /** 校验成功 Run 输出并原子登记选题卡与终态。 */
  completeTopicPlanningJob(sessionId: string, jobId: string): Promise<TextGenerationJobRecord> {
    return this.request("completeTopicPlanningJob", sessionId, jobId, new Date().toISOString());
  }

  /** 按商家及可选会话查询当前选题。 */
  listTopics(merchantId: string, sessionId?: string): Promise<TopicCard[]> {
    return this.request("listTopics", merchantId, sessionId);
  }

  /** 显式编辑或停用选题，使用版本和幂等键防止覆盖。 */
  updateTopic(sessionId: string, topicId: string, input: TopicUpdateInput, key: string): Promise<TopicCard> {
    return this.request(
      "updateTopic",
      sessionId,
      topicId,
      input,
      `topic-update:${sessionId}:${key}`,
      new Date().toISOString(),
    );
  }

  /** 将成功 Run 的助手回复以 CAS 追加为 AI 修订版。 */
  applyGeneratedRevision(
    sessionId: string,
    draftId: string,
    expectedRevision: number,
    sourceMessageId: string,
    operationKey: string,
  ): Promise<ContentDraftRecord> {
    return this.request(
      "applyGeneratedRevision",
      sessionId,
      draftId,
      expectedRevision,
      sourceMessageId,
      `content:${sessionId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 列出本会话文案生成任务。 */
  listTextGenerationJobs(sessionId: string): Promise<TextGenerationJobRecord[]> {
    return this.request("listTextGenerationJobs", sessionId);
  }

  /** 获取可继续调度的文案任务。 */
  listPendingTextGenerationJobs(): Promise<TextGenerationJobRecord[]> {
    return this.request("listPendingTextGenerationJobs");
  }

  /** Run 受理前核对商品或草稿仍指向任务冻结的来源版本。 */
  validateTextGenerationSources(sessionId: string, jobId: string): Promise<void> {
    return this.request("validateTextGenerationSources", sessionId, jobId);
  }

  /** 将已受理 Run 绑定至文案任务。 */
  attachTextGenerationRun(sessionId: string, jobId: string, runId: string): Promise<TextGenerationJobRecord> {
    return this.request("attachTextGenerationRun", sessionId, jobId, runId, new Date().toISOString());
  }

  /** 获取成功 Run 的助手回复标识。 */
  findTextGenerationReply(sessionId: string, runId: string): Promise<string | null> {
    return this.request("findTextGenerationReply", sessionId, runId);
  }

  /** 草稿持久化后结束文案生成步骤。 */
  completeTextGenerationJob(sessionId: string, jobId: string, draftId: string): Promise<TextGenerationJobRecord> {
    return this.request("completeTextGenerationJob", sessionId, jobId, draftId, new Date().toISOString());
  }

  /** 记录文案 Run 明确失败，避免在恢复时产生假草稿。 */
  failTextGenerationJob(sessionId: string, jobId: string, code: string): Promise<TextGenerationJobRecord> {
    return this.request("failTextGenerationJob", sessionId, jobId, code, new Date().toISOString());
  }

  /** 向 SQLite Worker 请求：登记受管文件及其会话归属和 Blob 引用。 */
  createArtifact(
    sessionId: string,
    title: string,
    hash: string,
    mime: string,
    size: number,
    operationKey: string,
  ): Promise<ArtifactRecord> {
    return this.request(
      "createArtifact",
      `art_${crypto.randomUUID()}`,
      sessionId,
      title,
      hash,
      mime,
      size,
      `upload:${sessionId}:${operationKey}`,
      new Date().toISOString(),
    );
  }

  /** 向 SQLite Worker 请求：读取指定附件的元数据和权限信息。 */
  getArtifact(id: string): Promise<ArtifactRecord | null> {
    return this.request("getArtifact", id);
  }

  /** 向 SQLite Worker 请求：列出指定会话可见的附件。 */
  listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    return this.request("listArtifacts", sessionId);
  }

  /** 关闭 SQLite Worker 并拒绝尚未完成的请求。 */
  async close(): Promise<void> {
    try {
      if (!this.workerFailure) await this.request("close");
    } finally {
      await this.worker.terminate();
    }
  }
}

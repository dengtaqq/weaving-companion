import { type Static, Type } from "typebox";
import type {
  AccountDiagnosisDraft,
  DelegationRecord,
  DelegationTaskV2,
  PublicPageEvidenceRecord,
} from "../../../shared/contracts.js";
import type { ExpertTaskV3 } from "../../../shared/expert-contract.js";
import { type ResearchSaveInput, researchSaveSchema } from "../../../shared/research.js";
import type { BackgroundResearchReceipt } from "../../../shared/research-agent.js";
import type { FileStore } from "../../infrastructure/files/files.js";
import type { DbClient, StoredMerchantContextSnapshot } from "../../infrastructure/sqlite/db-client.js";
import type { ExpertAssetSnapshot } from "../../modules/capabilities/infrastructure/expert-assets.js";
import type { SkillAssetSnapshot } from "../../modules/capabilities/infrastructure/skill-assets.js";
import type {
  MemorySearchBudget,
  MemorySearchResult,
  MemorySearchService,
} from "../../modules/merchants/application/memory-search-service.js";
import {
  type MemorySearchPlan,
  rankLegacyMemory,
  rankMemoryBm25,
} from "../../modules/merchants/domain/memory-retrieval.js";
import { isMemoryApplicable } from "../../modules/merchants/domain/memory-scope.js";
import {
  createPublicationTool,
  type PublicationToolStore,
} from "../../modules/publication/interfaces/publication-tool.js";
import { renderResearchDocument } from "../../modules/research/application/research-report.js";
import {
  collectPublicPage,
  isPublicNoteUrl,
  isPublicProfileUrl,
  publicPageUrl,
} from "../../modules/research/infrastructure/public-page-collector.js";
import {
  publicPageImageContent,
  saveCollectedPublicPage,
} from "../../modules/research/infrastructure/public-page-images.js";
import { authorizedXhsProfile } from "../../modules/research/infrastructure/xhs-login-service.js";
import {
  collectXhsSearch,
  xhsSearchKeyword,
  xhsSearchUrl,
} from "../../modules/research/infrastructure/xhs-search-collector.js";
import { RESEARCH_TOOL_REGISTRATIONS } from "../../modules/research/interfaces/research-tool-execution.js";
import { expertTaskV3Schema } from "../delegation/expert-contracts.js";
import { microcompactReadMetadata } from "../history/microcompact.js";
import { type HostToolDefinition, snapshotToolExecutionPolicies } from "./host-tool.js";

type SessionReader = PublicationToolStore &
  Pick<
    DbClient,
    | "getSession"
    | "listArtifacts"
    | "getArtifact"
    | "createPublicEvidence"
    | "getPublicEvidence"
    | "getPublicEvidenceForRun"
    | "listAccountDiagnoses"
    | "listSessionAccountDiagnoses"
    | "getAccountDiagnosis"
    | "saveAccountDiagnosis"
    | "saveResearchBatch"
  >;
type BlobReader = Pick<FileStore, "readBlob" | "putBlob">;
type ToolRisk = "read" | "write";
type ToolScope = "session" | "external";

interface CatalogEntry {
  risk: ToolRisk;
  scope: ToolScope;
  definition: HostToolDefinition;
}

export const CATALOG_TOOL_EXECUTION_POLICIES = snapshotToolExecutionPolicies(
  Object.values(RESEARCH_TOOL_REGISTRATIONS),
);

export const MEMORY_TOOLSET_VERSION = 11;
export const PRE_RESEARCH_TOOLSET_VERSION = 12;
export const PRE_RESEARCH_SAVE_TOOLSET_VERSION = 13;
export const PRE_PUBLICATION_TOOLSET_VERSION = 14;
export const PRE_EXPERT_CONTRACT_TOOLSET_VERSION = 15;
export const TOOLSET_VERSION = 16;
export const PRE_MEMORY_TOOLSET_VERSION = 10;
export const PRE_UNIVERSAL_EXPERT_TOOLSET_VERSION = 9;
export const PRE_EXPERT_METHOD_TOOLSET_VERSION = 8;
export const PRE_DELEGATION_TOOLSET_VERSION = 5;
export const PREVIOUS_TOOLSET_VERSION = 4;
export const OLDER_TOOLSET_VERSION = 3;
export const LEGACY_TOOLSET_VERSION = 2;
export const SESSION_TOOL_IDS = [
  "publication_task",
  "session_context",
  "list_uploaded_files",
  "read_uploaded_text",
  "read_skill",
  "public_page_collect",
  "evidence_get",
  "account_diagnosis_save",
  "account_diagnosis_get",
] as const;
export const MERCHANT_TOOL_IDS = [
  "merchant_profile_get",
  "merchant_catalog_get",
  "xhs_public_search",
  "merchant_source_collect",
  "merchant_research_save",
  "merchant_research_get",
  "merchant_links_list",
  "read_expert_method",
  "merchant_memory_search",
  "merchant_memory_get",
] as const;
export const ALL_TOOL_IDS = [...SESSION_TOOL_IDS, ...MERCHANT_TOOL_IDS, "delegate_task", "delegation_submit"] as const;
export type DelegateTaskInput = DelegationTaskV2 | ExpertTaskV3;
export type DelegateTaskHandler = (
  input: DelegateTaskInput,
  signal?: AbortSignal,
) => Promise<DelegationRecord | BackgroundResearchReceipt>;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_CHARACTERS = 12_000;
const memorySearchSchema = Type.Object({
  query: Type.String({ maxLength: 200 }),
  tier: Type.Optional(Type.Union([Type.Literal("LONG"), Type.Literal("SHORT")])),
});
const memoryGetSchema = Type.Object({
  memoryId: Type.String(),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
});
const merchantCatalogGetSchema = Type.Object({ entryId: Type.Optional(Type.String({ minLength: 1 })) });
const xhsPublicSearchSchema = Type.Object({
  keyword: Type.String({ minLength: 1, maxLength: 80 }),
  includeImages: Type.Optional(Type.Boolean({ description: "取得样本笔记实际可见主图截图，供支持视觉的模型分析" })),
  purpose: Type.Optional(
    Type.String({ minLength: 1, maxLength: 500, description: "此搜索与当前商家业务、客群及本次目标的关联理由" }),
  ),
});
const researchGetSchema = Type.Object({
  format: Type.Optional(Type.Literal("REPORT", { description: "将本轮冻结的已采用建议按固定模板生成简报" })),
  itemId: Type.Optional(Type.String({ minLength: 1 })),
  query: Type.Optional(Type.String({ maxLength: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
const merchantSourceCollectSchema = Type.Object({
  sourceType: Type.Union([Type.Literal("CATALOG"), Type.Literal("LINK")]),
  sourceId: Type.String({ minLength: 1 }),
  includeImages: Type.Optional(Type.Boolean({ description: "同时保存主页封面与样本笔记可见主图截图" })),
});
const PUBLIC_URL_IN_PROMPT = /https:\/\/[^\s<>"'`，。；、（）)\]]+/g;
const readTextSchema = Type.Object({
  artifactId: Type.String({ description: "list_uploaded_files 返回的文件 ID" }),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "起始字符位置，默认 0" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_CHARACTERS, description: "读取字符数" })),
});
const readSkillSchema = Type.Object({
  name: Type.String({ description: "本轮 Skill 目录中的名称" }),
  reference: Type.Optional(Type.String({ description: "Skill 引用的 references/*.md 路径；省略时读取 SKILL.md 正文" })),
});
const readExpertMethodSchema = Type.Object({
  role: Type.Union([Type.Literal("writer"), Type.Literal("visual"), Type.Literal("reviewer")]),
});
const publicPageSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 2048 }),
  includeRecentNotes: Type.Optional(Type.Boolean({ description: "账号主页按展示顺序继续读取最多 5 篇笔记及可见评论" })),
  includeImages: Type.Optional(Type.Boolean({ description: "同时保存实际可见图片截图；不是原图或全部历史图片" })),
});
const MAX_RECENT_NOTES = 5;
const evidenceGetSchema = Type.Object({
  evidenceId: Type.String(),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_CHARACTERS })),
  includeImages: Type.Optional(Type.Boolean({ description: "读取本证据已保存的图片截图；不会重新采集或扩大来源" })),
});
const diagnosisSaveSchema = Type.Object({
  evidenceIds: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
  revisesDiagnosisId: Type.Optional(
    Type.String({ description: "修订既有 DRAFT 时填写 account_diagnosis_get 返回的草稿 ID" }),
  ),
  report: Type.Object({
    scope: Type.String({ minLength: 1, maxLength: 500 }),
    summary: Type.String({ minLength: 1, maxLength: 3000 }),
    findings: Type.Array(
      Type.Object({
        kind: Type.Union([Type.Literal("OBSERVATION"), Type.Literal("INFERENCE")], {
          description: "OBSERVATION 是页面直接可见的事实；INFERENCE 是基于证据的推断",
        }),
        point: Type.String({ minLength: 1, maxLength: 1000 }),
        evidenceIds: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
      }),
      { minItems: 1, maxItems: 20 },
    ),
    actions: Type.Array(
      Type.Object({
        action: Type.String({ minLength: 1, maxLength: 1000 }),
        evidenceIds: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
      }),
      { maxItems: 20 },
    ),
    unknowns: Type.Array(Type.String({ maxLength: 500 }), { minItems: 1, maxItems: 20 }),
  }),
});
const diagnosisGetSchema = Type.Object({ diagnosisId: Type.Optional(Type.String()) });
const delegateTaskSchema = Type.Object({
  version: Type.Literal(2),
  taskKey: Type.Optional(
    Type.String({ minLength: 1, maxLength: 80, description: "本轮稳定任务键；不同专家步骤使用不同键，重试保持原键" }),
  ),
  targetExpertId: Type.Union([Type.Literal("writer"), Type.Literal("visual"), Type.Literal("reviewer")]),
  task: Type.String({ minLength: 1, maxLength: 8000 }),
  criteria: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 40 }),
      text: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    { minItems: 1, maxItems: 20 },
  ),
  inputRefs: Type.Array(
    Type.Object({
      type: Type.Union([Type.Literal("uploaded_text"), Type.Literal("public_evidence")]),
      id: Type.String({ minLength: 1 }),
    }),
    { maxItems: 20 },
  ),
  contextSummary: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  missingInformation: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 10 })),
  expectedOutput: Type.Union([Type.Literal("text_draft"), Type.Literal("text_report")], {
    description: "writer 使用 text_draft；visual 和 reviewer 使用 text_report",
  }),
});

/** 只有目录内明确列出的工具会传给 Pi；后续工具按相同边界登记。 */
export function createSessionTools(
  store: SessionReader,
  files: BlobReader,
  sessionId: string,
  allowedArtifacts: Array<{ artifactId: string; blobHash: string }> | null = null,
  allowedToolIds: readonly string[] = SESSION_TOOL_IDS,
  merchantContext: StoredMerchantContextSnapshot | null = null,
  skills: readonly SkillAssetSnapshot[] = [],
  expertMethods: readonly ExpertAssetSnapshot[] = [],
  runId: string | null = null,
  delegateTask?: DelegateTaskHandler,
  allowedEvidenceIds: readonly string[] | null = null,
  userPrompt = "",
  dataDir?: string,
  publication?: {
    modelId: string;
    imageModelId: string | null;
    toolsetVersion?: number;
    historyReadEnabled?: boolean;
    imageInput?: boolean;
    researchImagesEnabled?: boolean;
  },
  memorySearch?: { plan: MemorySearchPlan; service?: MemorySearchService; budget?: MemorySearchBudget },
): HostToolDefinition[] {
  // 模型只能采集本轮用户原文中出现的链接，工具参数不能自行扩大授权范围。
  const authorizedPublicUrls = new Set<string>();
  for (const match of userPrompt.match(PUBLIC_URL_IN_PROMPT) ?? []) {
    try {
      authorizedPublicUrls.add(publicPageUrl(match.replace(/[.,!?;:]+$/, "")).toString());
    } catch {
      // 提示词中的其他网址不获得公开页工具权限。
    }
  }
  const artifactHashes = allowedArtifacts
    ? new Map(allowedArtifacts.map((artifact) => [artifact.artifactId, artifact.blobHash]))
    : null;
  const searchedKeywords = new Set<string>();
  const collectedSources = new Set<string>();
  /** 图片采集只对冻结为研究新版的Run开放，旧Run不因升级取得额外能力。 */
  const assertImageCollectionAllowed = (includeImages?: boolean) => {
    if (includeImages && !publication?.researchImagesEnabled) throw new Error("TOOL_IMAGE_COLLECTION_UNAVAILABLE");
  };
  /** 每次最多发送五张已登记图片；回执列出与像素顺序一致的来源，不把未发送图片称为已看过。 */
  const imageDelivery = async (
    pages: Awaited<ReturnType<SessionReader["createPublicEvidence"]>>[],
    requested: boolean | undefined,
    signal?: AbortSignal,
  ) => {
    assertImageCollectionAllowed(requested);
    const enabled = Boolean(requested && publication?.imageInput);
    const content = await publicPageImageContent(store, files, sessionId, pages, enabled, signal);
    const deliveredImages = enabled
      ? pages
          .filter((page) => page.sessionId === sessionId && ["COLLECTED", "LIMITED"].includes(page.status))
          .flatMap((page) =>
            (page.images ?? []).map((image) => ({
              evidenceId: page.evidenceId,
              artifactId: image.artifactId,
              description: image.description,
            })),
          )
          .slice(0, content.length)
      : [];
    return {
      content,
      report: {
        imageInputStatus: !requested
          ? "NOT_REQUESTED"
          : !enabled
            ? "UNAVAILABLE"
            : content.length
              ? "DELIVERED"
              : "NO_VISIBLE_IMAGES",
        deliveredImages,
      },
    };
  };
  /** 工具执行前确认当前会话仍有效。 */
  const requireActiveSession = async () => {
    const session = await store.getSession(sessionId);
    if (session?.lifecycleStatus !== "ACTIVE") throw new Error("TOOL_SESSION_UNAVAILABLE");
    return session;
  };
  /** 确认工具调用仍属于冻结的商家会话。 */
  const requireMerchantSession = async () => {
    const session = await requireActiveSession();
    if (!merchantContext || session.scope !== "MERCHANT" || session.ownerId !== merchantContext.merchantId)
      throw new Error("TOOL_MERCHANT_NOT_AUTHORIZED");
    return {
      ...merchantContext,
      memories: (merchantContext.memories ?? []).filter((item) =>
        isMemoryApplicable(item, merchantContext.memoryScope ?? { version: 1, product: null }),
      ),
    };
  };
  /** 确定证据应归属当前商家还是普通会话。 */
  const currentMerchantId = async () => {
    const session = await requireActiveSession();
    if (session.scope === "NORMAL" && session.ownerId === "local" && !merchantContext) return null;
    if (session.scope === "MERCHANT" && merchantContext?.merchantId === session.ownerId) return session.ownerId;
    throw new Error("TOOL_SESSION_SCOPE_CHANGED");
  };
  const catalog: CatalogEntry[] = [
    {
      risk: "write",
      scope: "session",
      definition: {
        name: "merchant_research_save",
        label: "保存商家研究候选",
        description:
          "按本轮冻结的商家研究范围保存结构化候选和来源缺口；不采用、不修改人工目录。仅成功 Run 的候选可由用户采用。同批重试保持 batchKey 和内容不变。",
        parameters: Type.Unsafe<ResearchSaveInput>(researchSaveSchema),
        /** Host 从当前 Run 推导商家和快照，模型不能指定归属或代替用户采用。 */
        async execute(_toolCallId, params: ResearchSaveInput, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const snapshot = await requireMerchantSession();
          if (!runId || allowedEvidenceIds || !snapshot.researchScope) throw new Error("TOOL_RESEARCH_NOT_AUTHORIZED");
          const batch = await store.saveResearchBatch(sessionId, runId, params);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  batchId: batch.batchId,
                  candidateCount: batch.candidates.length,
                  gaps: batch.gaps,
                  note: "候选已保存，尚未采用。Run 成功完成后 Host 自动生成固定模板报告，可在研究面板查看、复制或下载；采用后后续会话可用 merchant_research_get(format=REPORT) 读取简报。",
                }),
              },
            ],
            details: { risk: "write", scope: "session", batchId: batch.batchId },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "merchant_research_get",
        label: "读取商家采用的研究建议",
        description:
          "列出本轮冻结研究库短索引；按 itemId 读取完整采用版本，format=REPORT 按固定模板生成已采用简报，支持同样的查询和分页。采用仍是研究推断，未采用候选不在简报中。",
        parameters: researchGetSchema,
        /** 只在本轮冻结版本中读取，后续停用或更新不改变历史输入。 */
        async execute(_toolCallId, params: Static<typeof researchGetSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const snapshot = await requireMerchantSession();
          const library = snapshot.researchLibrary ?? [];
          const item = params.itemId ? library.find((entry) => entry.itemId === params.itemId) : null;
          if (params.itemId && !item) throw new Error("TOOL_RESEARCH_SOURCE_NOT_FOUND");
          const query = params.query?.trim().toLocaleLowerCase("zh-CN") ?? "";
          const matches = query
            ? library.filter((entry) =>
                `${entry.candidate.title} ${entry.candidate.merchantRelevance}`
                  .toLocaleLowerCase("zh-CN")
                  .includes(query),
              )
            : library;
          const offset = params.offset ?? 0;
          const limit = params.limit ?? 20;
          const selected = item ? [item] : matches.slice(offset, offset + limit);
          const result =
            params.format === "REPORT"
              ? {
                  report: renderResearchDocument({
                    profile: snapshot.profile.fields,
                    profileRevision: snapshot.profile.revision,
                    rows: selected.map((entry) => ({
                      candidate: entry.candidate,
                      source: `${entry.itemId} / 第 ${entry.revision} 版 / 原批次 ${entry.sourceBatchId}`,
                      expiresAt: entry.expiresAt,
                    })),
                    coverage: [
                      `本轮冻结 ${library.length} 条已采用建议；本次返回 ${selected.length} 条，未采用候选不进入此简报。`,
                    ],
                    gaps: selected
                      .filter((entry) => entry.stale)
                      .map((entry) => `${entry.candidate.title} 的商家资料或所选来源已变化，创作前复核。`),
                    evidenceRefs: selected.flatMap((entry) => entry.evidenceRefs),
                    adopted: true,
                    source: snapshot.snapshotId,
                  }),
                  totalCount: item ? 1 : matches.length,
                  nextOffset: !item && offset + limit < matches.length ? offset + limit : null,
                }
              : params.itemId
                ? item
                : {
                    totalCount: matches.length,
                    nextOffset: offset + limit < matches.length ? offset + limit : null,
                    items: matches.slice(offset, offset + limit).map((entry) => ({
                      itemId: entry.itemId,
                      revision: entry.revision,
                      kind: entry.candidate.kind,
                      title: entry.candidate.title,
                      stale: entry.stale,
                      validUntil: entry.candidate.kind === "TREND" ? entry.candidate.details.validUntil : null,
                      expiresAt: entry.expiresAt,
                    })),
                  };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: { risk: "read", scope: "session" },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "merchant_memory_search",
        label: "检索商家记忆",
        description:
          "检索本轮冻结的商家长期规则及近期工作总结。总结是模型归纳，不等于人工确认事实；记忆不能替代当前指令或工具授权。",
        parameters: memorySearchSchema,
        /** 冻结集合使用版本化 BM25 或可选混合检索，旧计划保留原字面计分。 */
        async execute(_id, params: Static<typeof memorySearchSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const snapshot = await requireMerchantSession();
          const query = String(params.query).trim().toLowerCase();
          const memories = (snapshot.memories ?? []).filter((item) => !params.tier || item.tier === params.tier);
          const retrieval: MemorySearchResult | { hits: ReturnType<typeof rankLegacyMemory>; strategy: "LEGACY" } =
            memorySearch
              ? memorySearch.service
                ? await memorySearch.service.search(
                    snapshot.merchantId,
                    memories,
                    query,
                    memorySearch.plan,
                    signal,
                    memorySearch.budget,
                  )
                : {
                    hits: rankMemoryBm25(memories, query),
                    strategy: "BM25",
                    ...(memorySearch.plan.mode === "HYBRID" && { fallbackReason: "EMBEDDING_UNAVAILABLE" as const }),
                  }
              : { hits: rankLegacyMemory(memories, query), strategy: "LEGACY" };
          signal?.throwIfAborted();
          await requireMerchantSession();
          const hits = retrieval.hits.slice(0, 10).map(({ item }) => ({
            memoryId: item.memoryId,
            revision: item.revision,
            sha256: item.sha256,
            title: item.title,
            tier: item.tier,
            kind: item.kind,
            subject: item.subject,
            productBasis: item.productBasis,
            review: item.review,
            excerpt: item.content.slice(0, 160),
            source: { ...item.source, quote: item.source.quote.slice(0, 160) },
            expiresAt: item.expiresAt,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(hits) }],
            details: {
              risk: "read",
              scope: "session",
              memorySearch: {
                strategy: retrieval.strategy,
                ...("fallbackReason" in retrieval && retrieval.fallbackReason
                  ? { fallbackReason: retrieval.fallbackReason }
                  : {}),
              },
            },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "merchant_memory_get",
        label: "读取商家记忆",
        description: "按 ID 分段读取本轮已授权的商家记忆及来源。不能读取未在本轮快照中的条目。",
        parameters: memoryGetSchema,
        /** 从冻结版本返回正文片段，ID 不得用于扩大商家授权范围。 */
        async execute(_id, params: Static<typeof memoryGetSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const snapshot = await requireMerchantSession();
          const item = snapshot.memories?.find((item) => item.memoryId === params.memoryId);
          if (!item) throw new Error("MEMORY_NOT_AUTHORIZED");
          const offset = Math.min(Number(params.offset ?? 0), item.content.length);
          const nextOffset = Math.min(offset + Number(params.limit ?? 2000), item.content.length);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...item,
                  content: item.content.slice(offset, nextOffset),
                  offset,
                  nextOffset,
                  totalCharacters: item.content.length,
                }),
              },
            ],
            details: { risk: "read", scope: "session" },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "session_context",
        label: "当前会话",
        description: "读取当前会话的 ID、标题和范围。只返回本会话的元数据。",
        promptSnippet: "读取当前会话的基本信息",
        parameters: Type.Object({}),
        /** 读取当前会话的元数据，并在执行时复核权限。 */
        async execute(_toolCallId, _params, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const session = await requireActiveSession();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ sessionId: session.sessionId, title: session.title, scope: session.scope }),
              },
            ],
            details: { risk: "read", scope: "session" },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "list_uploaded_files",
        label: "已上传文件",
        description: "列出当前会话已上传的文件及可读取状态。仅当前会话可见。",
        promptSnippet: "列出当前会话上传的文件",
        parameters: Type.Object({}),
        /** 列出本轮有权查看的上传文件，并在执行时复核权限。 */
        async execute(_toolCallId, _params, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          await requireActiveSession();
          const artifacts = (await store.listArtifacts(sessionId)).filter(
            (artifact) =>
              artifact.sessionId === sessionId &&
              artifact.kind === "upload" &&
              (!artifactHashes || artifactHashes.get(artifact.artifactId) === artifact.blobHash),
          );
          const items = artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            title: artifact.title,
            sizeBytes: artifact.sizeBytes,
            readable:
              artifact.status === "READY" &&
              artifact.mimeType === "text/plain" &&
              artifact.sizeBytes <= MAX_TEXT_FILE_BYTES,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(items) }],
            details: { risk: "read", scope: "session" },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "read_uploaded_text",
        label: "读取上传文本",
        description: "按字符范围读取当前会话上传的 UTF-8 文本文件。先用 list_uploaded_files 获取 artifactId。",
        promptSnippet: "分段读取当前会话上传的文本文件",
        parameters: readTextSchema,
        /** 读取本轮有权查看的文本附件片段，并在执行时复核权限。 */
        async execute(_toolCallId, params: Static<typeof readTextSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          await requireActiveSession();
          const artifact = await store.getArtifact(params.artifactId);
          if (artifact?.sessionId !== sessionId || artifact.kind !== "upload" || artifact.status !== "READY")
            throw new Error("TOOL_FILE_NOT_FOUND");
          if (artifactHashes && artifactHashes.get(artifact.artifactId) !== artifact.blobHash)
            throw new Error("TOOL_FILE_NOT_AUTHORIZED");
          if (artifact.mimeType !== "text/plain") throw new Error("TOOL_FILE_UNSUPPORTED");
          if (artifact.sizeBytes > MAX_TEXT_FILE_BYTES) throw new Error("TOOL_FILE_TOO_LARGE");
          const content = await files.readBlob(artifact.blobHash);
          if (content.length > MAX_TEXT_FILE_BYTES) throw new Error("TOOL_FILE_TOO_LARGE");
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const characters = Array.from(new TextDecoder("utf-8", { fatal: true }).decode(content));
          const offset = Math.min(params.offset ?? 0, characters.length);
          const limit = params.limit ?? MAX_READ_CHARACTERS;
          const nextOffset = Math.min(offset + limit, characters.length);
          const result = {
            title: artifact.title,
            artifactId: artifact.artifactId,
            totalCharacters: characters.length,
            offset,
            nextOffset,
            text: characters.slice(offset, nextOffset).join(""),
          };
          const text = JSON.stringify(result);
          return {
            content: [{ type: "text", text }],
            details: {
              risk: "read",
              scope: "session",
              ...microcompactReadMetadata(
                { kind: "upload", artifactId: artifact.artifactId, blobHash: artifact.blobHash, offset, nextOffset },
                text,
              ),
            },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "merchant_profile_get",
        label: "商家档案",
        description: "读取本轮已冻结的当前商家人工确认档案。不能读取其他商家。",
        promptSnippet: "读取当前商家的人工档案",
        parameters: Type.Object({}),
        /** 读取冻结的商家人工档案，并在执行时复核权限。 */
        async execute(_toolCallId, _params, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const snapshot = await requireMerchantSession();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ revision: snapshot.profile.revision, fields: snapshot.profile.fields }),
              },
            ],
            details: { risk: "read", scope: "session" },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "merchant_catalog_get",
        label: "商品与选题线索",
        description: "无参数列出本轮冻结的商品和选题线索短索引；按条目 ID 读取详情。只读当前商家资料。",
        promptSnippet: "读取商品与关键词、热点、竞品线索详情及来源状态",
        parameters: merchantCatalogGetSchema,
        /** 按冻结版本与商家归属读取商品或线索。 */
        async execute(_toolCallId, params: Static<typeof merchantCatalogGetSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const snapshot = await requireMerchantSession();
          const catalog = snapshot.catalog ?? [];
          const entry = params.entryId ? catalog.find((item) => item.entryId === params.entryId) : null;
          if (params.entryId && !entry) throw new Error("TOOL_MERCHANT_CATALOG_NOT_FOUND");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  params.entryId
                    ? entry
                    : catalog.map((item) => ({
                        entryId: item.entryId,
                        kind: item.kind,
                        revision: item.revision,
                        name: item.name,
                        provenance: item.provenance,
                        evidenceId: item.evidenceId,
                        observedAt: item.observedAt,
                      })),
                ),
              },
            ],
            details: { risk: "read", scope: "session" },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "external",
      definition: {
        ...RESEARCH_TOOL_REGISTRATIONS.search,
        label: "搜索小红书公开笔记",
        description:
          "只在当前商家会话按关键词搜索站内可见笔记，每轮最多 5 个不同关键词、每次最多 5 篇详情。保存搜索页和笔记证据；受限、空结果和可见样本不代表平台搜索量或实时热点。",
        promptSnippet: "按当前商家业务搜索公开笔记并保存可核实证据",
        parameters: xhsPublicSearchSchema,
        /** 受控搜索只使用 Host 构造的站内地址，结果逐条绑定当前 Run 和商家。 */
        async execute(_toolCallId, params: Static<typeof xhsPublicSearchSchema>, signal) {
          assertImageCollectionAllowed(params.includeImages);
          const snapshot = await requireMerchantSession();
          if (!runId || allowedEvidenceIds) throw new Error("TOOL_RESEARCH_NOT_AUTHORIZED");
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const keyword = xhsSearchKeyword(params.keyword);
          if (snapshot.researchScope && !params.purpose?.trim()) throw new Error("TOOL_RESEARCH_PURPOSE_REQUIRED");
          if (!searchedKeywords.has(keyword) && searchedKeywords.size >= 5)
            throw new Error("TOOL_SEARCH_LIMIT_REACHED");
          searchedKeywords.add(keyword);
          const sourceUrl = xhsSearchUrl(keyword);
          const previous = await store.getPublicEvidenceForRun(runId, sourceUrl);
          const profileDir = dataDir ? await authorizedXhsProfile(dataDir, sessionId) : null;
          const authorizedProfileDir = profileDir ?? process.env.ZHIBAN_XHS_AUTH_PROFILE_DIR?.trim();
          let page = previous?.merchantId === snapshot.merchantId && previous.sessionId === sessionId ? previous : null;
          if (!page) {
            const collected = await collectXhsSearch(keyword, signal, authorizedProfileDir);
            if (signal?.aborted) throw new Error("TOOL_ABORTED");
            page = await saveCollectedPublicPage(
              store,
              files,
              snapshot.merchantId,
              sessionId,
              runId,
              collected,
              signal,
            );
          }
          const notes = [];
          const imagePages = [];
          if (page.status === "COLLECTED") {
            for (const link of page.links.slice(0, 5)) {
              if (signal?.aborted) throw new Error("TOOL_ABORTED");
              if (!isPublicNoteUrl(link.url)) continue;
              const prior = await store.getPublicEvidenceForRun(runId, link.url);
              let note = prior?.merchantId === snapshot.merchantId && prior.sessionId === sessionId ? prior : null;
              if (!note) {
                const collected = await collectPublicPage(
                  link.url,
                  signal,
                  authorizedProfileDir,
                  false,
                  params.includeImages,
                );
                if (signal?.aborted) throw new Error("TOOL_ABORTED");
                note = await saveCollectedPublicPage(
                  store,
                  files,
                  snapshot.merchantId,
                  sessionId,
                  runId,
                  collected,
                  signal,
                );
              }
              imagePages.push(note);
              notes.push({
                images: note.images ?? [],
                imageCaptureError: note.imageCaptureError ?? null,
                evidenceId: note.evidenceId,
                status: note.status,
                errorCode: note.errorCode,
                sourceUrl: note.sourceUrl,
                collectedAt: note.collectedAt,
                title: note.title,
                visibleTextSha256: note.visibleTextSha256,
                excerpt: note.visibleText.slice(0, 1500),
              });
            }
          }
          const delivery = await imageDelivery([...imagePages, page], params.includeImages, signal);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  keyword,
                  purpose: params.purpose ?? null,
                  ...delivery.report,
                  images: page.images ?? [],
                  imageCaptureError: page.imageCaptureError ?? null,
                  evidenceId: page.evidenceId,
                  status: page.status,
                  errorCode: page.errorCode,
                  sourceUrl: page.sourceUrl,
                  collectedAt: page.collectedAt,
                  visibleTextSha256: page.visibleTextSha256,
                  excerpt: page.visibleText.slice(0, 3000),
                  notes,
                  note: "仅为本次可见搜索样本；没有平台搜索量、全站热度或完整竞品数据。",
                }),
              },
              ...delivery.content,
            ],
            details: { risk: "read", scope: "external", evidenceId: page.evidenceId, status: page.status },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "external",
      definition: {
        ...RESEARCH_TOOL_REGISTRATIONS.merchantSource,
        label: "采集商家已登记来源",
        description:
          "仅采集本轮冻结的商家账号链接或竞品线索 URL；主页可读取最多 5 篇实际可见笔记。来源链接不等于已取得证据。",
        promptSnippet: "核实本轮商家账号和竞品线索的公开页面",
        parameters: merchantSourceCollectSchema,
        /** 来源 ID 必须存在于本轮商家快照，模型不能提供任意采集网址。 */
        async execute(_toolCallId, params: Static<typeof merchantSourceCollectSchema>, signal) {
          assertImageCollectionAllowed(params.includeImages);
          const snapshot = await requireMerchantSession();
          if (!runId || allowedEvidenceIds) throw new Error("TOOL_RESEARCH_NOT_AUTHORIZED");
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const catalogEntry =
            params.sourceType === "CATALOG"
              ? snapshot.catalog?.find((item) => item.entryId === params.sourceId && item.kind === "COMPETITOR")
              : null;
          const link =
            params.sourceType === "LINK"
              ? snapshot.links.find(
                  (item) => item.linkId === params.sourceId && ["ACCOUNT", "REFERENCE"].includes(item.kind),
                )
              : null;
          const url = catalogEntry?.sourceUrl ?? link?.url;
          if (!url) throw new Error("TOOL_RESEARCH_SOURCE_NOT_FOUND");
          if (
            snapshot.researchScope &&
            !(params.sourceType === "CATALOG"
              ? snapshot.researchScope.catalogSourceIds.includes(params.sourceId)
              : snapshot.researchScope.linkSourceIds.includes(params.sourceId))
          )
            throw new Error("TOOL_RESEARCH_SOURCE_NOT_SELECTED");
          const sourceUrl = publicPageUrl(url).toString();
          const sourceKey = `${params.sourceType}:${params.sourceId}`;
          if (!collectedSources.has(sourceKey) && collectedSources.size >= 6)
            throw new Error("TOOL_RESEARCH_SOURCE_LIMIT_REACHED");
          collectedSources.add(sourceKey);
          const profileDir = dataDir ? await authorizedXhsProfile(dataDir, sessionId) : null;
          const authorizedProfileDir = profileDir ?? process.env.ZHIBAN_XHS_AUTH_PROFILE_DIR?.trim();
          const previous = await store.getPublicEvidenceForRun(runId, sourceUrl);
          let page = previous?.merchantId === snapshot.merchantId && previous.sessionId === sessionId ? previous : null;
          if (!page) {
            const collected = await collectPublicPage(
              sourceUrl,
              signal,
              authorizedProfileDir,
              true,
              params.includeImages,
            );
            if (signal?.aborted) throw new Error("TOOL_ABORTED");
            page = await saveCollectedPublicPage(
              store,
              files,
              snapshot.merchantId,
              sessionId,
              runId,
              collected,
              signal,
            );
          }
          const notes = [];
          const imagePages = [];
          if (page.status === "COLLECTED" && isPublicProfileUrl(page.finalUrl ?? "")) {
            let noteLinks = page.links;
            if (
              previous &&
              !noteLinks.some((item) => isPublicNoteUrl(item.url) && new URL(item.url).searchParams.has("xsec_token"))
            ) {
              const refreshed = await collectPublicPage(
                sourceUrl,
                signal,
                authorizedProfileDir,
                true,
                params.includeImages,
              );
              if (refreshed.status === "COLLECTED") noteLinks = refreshed.links;
            }
            for (const item of noteLinks
              .filter((item) => isPublicNoteUrl(item.url) && new URL(item.url).searchParams.has("xsec_token"))
              .slice(0, 5)) {
              if (signal?.aborted) throw new Error("TOOL_ABORTED");
              const prior = await store.getPublicEvidenceForRun(runId, item.url);
              let note = prior?.merchantId === snapshot.merchantId && prior.sessionId === sessionId ? prior : null;
              if (!note) {
                const collected = await collectPublicPage(
                  item.url,
                  signal,
                  authorizedProfileDir,
                  false,
                  params.includeImages,
                );
                if (signal?.aborted) throw new Error("TOOL_ABORTED");
                note = await saveCollectedPublicPage(
                  store,
                  files,
                  snapshot.merchantId,
                  sessionId,
                  runId,
                  collected,
                  signal,
                );
              }
              imagePages.push(note);
              notes.push({
                images: note.images ?? [],
                imageCaptureError: note.imageCaptureError ?? null,
                evidenceId: note.evidenceId,
                status: note.status,
                errorCode: note.errorCode,
                sourceUrl: note.sourceUrl,
                collectedAt: note.collectedAt,
                title: note.title,
                visibleTextSha256: note.visibleTextSha256,
                excerpt: note.visibleText.slice(0, 1500),
              });
            }
          }
          const delivery = await imageDelivery([...imagePages, page], params.includeImages, signal);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sourceType: params.sourceType,
                  sourceId: params.sourceId,
                  sourceRevision: catalogEntry?.revision ?? link?.revision,
                  ...delivery.report,
                  images: page.images ?? [],
                  imageCaptureError: page.imageCaptureError ?? null,
                  evidenceId: page.evidenceId,
                  status: page.status,
                  errorCode: page.errorCode,
                  sourceUrl: page.sourceUrl,
                  collectedAt: page.collectedAt,
                  visibleTextSha256: page.visibleTextSha256,
                  excerpt: page.visibleText.slice(0, 3000),
                  notes,
                }),
              },
              ...delivery.content,
            ],
            details: { risk: "read", scope: "external", evidenceId: page.evidenceId, status: page.status },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "merchant_links_list",
        label: "商家平台链接",
        description: "列出本轮已冻结的当前商家平台链接；链接本身不代表已读取网页内容。",
        promptSnippet: "列出当前商家的平台入口",
        parameters: Type.Object({}),
        /** 列出冻结的商家平台链接，并在执行时复核权限。 */
        async execute(_toolCallId, _params, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const snapshot = await requireMerchantSession();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  snapshot.links.map((link) => ({
                    linkId: link.linkId,
                    platform: link.platform,
                    kind: link.kind,
                    url: link.url,
                    label: link.label,
                    collectionStatus: link.collectionStatus,
                  })),
                ),
              },
            ],
            details: { risk: "read", scope: "session" },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "read_skill",
        label: "读取本轮 Skill",
        description: "按名称读取本轮固定版本的 Skill 正文；需要参考材料时再传入正文提到的 reference 路径。",
        promptSnippet: "按需读取本轮允许的 Skill 方法",
        parameters: readSkillSchema,
        /** 读取冻结的 Skill 正文或参考文件，并在执行时复核权限。 */
        async execute(_toolCallId, params: Static<typeof readSkillSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const skill = skills.find((item) => item.name === params.name);
          if (!skill) throw new Error("TOOL_SKILL_NOT_AUTHORIZED");
          const source = params.reference
            ? skill.references.find((reference) => reference.path === params.reference)
            : skill;
          if (!source) throw new Error("TOOL_SKILL_REFERENCE_NOT_FOUND");
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const referenceList = params.reference
            ? ""
            : `\n可按需读取的参考文件：${skill.references.map((reference) => reference.path).join("、") || "无"}`;
          const text = `<skill name="${skill.name}" path="${params.reference ?? "SKILL.md"}" sha256="${source.sha256}">\n${source.content}\n</skill>${referenceList}`;
          return {
            content: [
              {
                type: "text",
                text,
              },
            ],
            details: {
              risk: "read",
              scope: "session",
              skill: skill.name,
              sha256: source.sha256,
              ...microcompactReadMetadata(
                { kind: "skill", name: skill.name, path: params.reference ?? "SKILL.md", sha256: source.sha256 },
                text,
              ),
            },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "read_expert_method",
        label: "读取专家方法",
        description: "按角色读取本轮冻结的专家方法，供当前 Agent 参考；不会启动另一位专家。",
        promptSnippet: "任务需要时读取写作、视觉或审核方法",
        parameters: readExpertMethodSchema,
        /** 仅在商家会话内读取本轮冻结的专家方法，并复核会话归属。 */
        async execute(_toolCallId, params: Static<typeof readExpertMethodSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          await requireMerchantSession();
          const method = expertMethods.find((item) => item.role === params.role);
          if (!method) throw new Error("TOOL_EXPERT_METHOD_NOT_AUTHORIZED");
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const text = JSON.stringify({
            role: method.role,
            groupId: method.groupId,
            sharedRules: method.sharedRules,
            sharedSha256: method.sharedSha256,
            method: method.prompt,
            promptSha256: method.promptSha256,
            note: "仅供当前 Agent 参考；不切换角色、不代表独立专家已执行，也不增加本轮工具权限。",
          });
          return {
            content: [{ type: "text", text }],
            details: {
              risk: "read",
              scope: "session",
              role: method.role,
              sha256: method.promptSha256,
              ...microcompactReadMetadata(
                {
                  kind: "expert",
                  role: method.role,
                  groupId: method.groupId,
                  sharedSha256: method.sharedSha256,
                  promptSha256: method.promptSha256,
                },
                text,
              ),
            },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "external",
      definition: {
        ...RESEARCH_TOOL_REGISTRATIONS.publicPage,
        label: "采集公开主页",
        description:
          "读取本轮明确给定的小红书主页或笔记；账号主页可选择继续读取页面展示的前 5 篇笔记详情和可见评论。逐页保存来源、时间、访问方式与受限状态。",
        promptSnippet: "读取公开页面；失败或登录受限时不要声称已采集",
        parameters: publicPageSchema,
        /** 采集用户本轮明确给出的小红书页面，并在执行时复核权限。 */
        async execute(_toolCallId, params: Static<typeof publicPageSchema>, signal) {
          assertImageCollectionAllowed(params.includeImages);
          const merchantId = await currentMerchantId();
          if (!runId) throw new Error("TOOL_RUN_UNAVAILABLE");
          const sourceUrl = publicPageUrl(params.url).toString();
          if (!authorizedPublicUrls.has(sourceUrl)) throw new Error("TOOL_PUBLIC_PAGE_NOT_AUTHORIZED");
          // 同 Run 重试复用已落库证据，避免重复访问站点和产生两个来源版本。
          const previous = await store.getPublicEvidenceForRun(runId, sourceUrl);
          let evidence = previous?.sessionId === sessionId && previous.merchantId === merchantId ? previous : null;
          const sessionProfile = dataDir ? await authorizedXhsProfile(dataDir, sessionId) : null;
          const profileDir = sessionProfile ?? process.env.ZHIBAN_XHS_AUTH_PROFILE_DIR?.trim();
          if (!evidence) {
            const page = await collectPublicPage(
              sourceUrl,
              signal,
              profileDir,
              params.includeRecentNotes,
              params.includeImages,
            );
            if (signal?.aborted) throw new Error("TOOL_ABORTED");
            evidence = await saveCollectedPublicPage(store, files, merchantId, sessionId, runId, page, signal);
          }
          const imagePages = [];
          const notes: Array<{
            images: PublicPageEvidenceRecord["images"];
            imageCaptureError: string | null;
            evidenceId: string;
            sourceUrl: string;
            finalUrl: string | null;
            title: string;
            collectedAt: string;
            accessMode: string;
            visibleTextSha256: string;
            status: string;
            errorCode: string | null;
            visibleCharacters: number;
            commentSectionVisible: boolean;
            excerpt: string;
          }> = [];
          if (
            params.includeRecentNotes &&
            evidence.status === "COLLECTED" &&
            isPublicProfileUrl(evidence.finalUrl ?? "")
          ) {
            // 子链接必须实际出现在已授权主页证据中；只取展示顺序的前五个不同笔记。
            let noteLinks = evidence.links;
            if (
              previous &&
              !noteLinks.some((link) => isPublicNoteUrl(link.url) && new URL(link.url).searchParams.has("xsec_token"))
            ) {
              // 同 Run 先按单页采集、后请求笔记时，重新从该授权主页发现卡片，不改写既有证据。
              const refreshed = await collectPublicPage(sourceUrl, signal, profileDir, true);
              if (refreshed.status === "COLLECTED") noteLinks = refreshed.links;
            }
            const seenPaths = new Set<string>();
            for (const link of noteLinks) {
              if (!isPublicNoteUrl(link.url) || !new URL(link.url).searchParams.has("xsec_token")) continue;
              const path = new URL(link.url).pathname;
              if (seenPaths.has(path)) continue;
              seenPaths.add(path);
              if (notes.length >= MAX_RECENT_NOTES) break;
              const noteUrl = publicPageUrl(link.url).toString();
              const priorNote = await store.getPublicEvidenceForRun(runId, noteUrl);
              let noteEvidence =
                priorNote?.sessionId === sessionId && priorNote.merchantId === merchantId ? priorNote : null;
              if (!noteEvidence) {
                const page = await collectPublicPage(noteUrl, signal, profileDir, false, params.includeImages);
                if (signal?.aborted) throw new Error("TOOL_ABORTED");
                noteEvidence = await saveCollectedPublicPage(store, files, merchantId, sessionId, runId, page, signal);
              }
              imagePages.push(noteEvidence);
              notes.push({
                images: noteEvidence.images ?? [],
                imageCaptureError: noteEvidence.imageCaptureError ?? null,
                evidenceId: noteEvidence.evidenceId,
                sourceUrl: noteEvidence.sourceUrl,
                finalUrl: noteEvidence.finalUrl,
                title: noteEvidence.title,
                collectedAt: noteEvidence.collectedAt,
                accessMode: noteEvidence.accessMode,
                visibleTextSha256: noteEvidence.visibleTextSha256,
                status: noteEvidence.status,
                errorCode: noteEvidence.errorCode,
                visibleCharacters: Array.from(noteEvidence.visibleText).length,
                commentSectionVisible: noteEvidence.visibleText.includes("[本页实际加载的评论区摘录]"),
                excerpt: noteEvidence.visibleText.slice(0, 1800),
              });
            }
          }
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const delivery = await imageDelivery([...imagePages, evidence], params.includeImages, signal);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...delivery.report,
                  images: evidence.images ?? [],
                  imageCaptureError: evidence.imageCaptureError ?? null,
                  evidenceId: evidence.evidenceId,
                  status: evidence.status,
                  errorCode: evidence.errorCode,
                  sourceUrl: evidence.sourceUrl,
                  finalUrl: evidence.finalUrl,
                  title: evidence.title,
                  collectedAt: evidence.collectedAt,
                  visibleTextSha256: evidence.visibleTextSha256,
                  accessMode: evidence.accessMode,
                  visibleCharacters: Array.from(evidence.visibleText).length,
                  excerpt: evidence.visibleText.slice(0, 5000),
                  links: evidence.links,
                  notes,
                  note: "每篇笔记均有独立证据 ID；评论仅限笔记详情页实际加载的可见部分，未出现时不得声称已读取。需要更多正文时调用 evidence_get。",
                }),
              },
              ...delivery.content,
            ],
            details: { risk: "read", scope: "external", evidenceId: evidence.evidenceId, status: evidence.status },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "evidence_get",
        label: "读取公开证据",
        description: "按证据 ID 分段读取当前会话或已关联商家保存的公开页面文字及来源。",
        promptSnippet: "读取当前会话可用的公开页面证据",
        parameters: evidenceGetSchema,
        /** 读取归属校验通过的公开证据片段，并在执行时复核权限。 */
        async execute(_toolCallId, params: Static<typeof evidenceGetSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const merchantId = await currentMerchantId();
          const evidence = await store.getPublicEvidence(params.evidenceId);
          if (!evidence || (merchantId ? evidence.merchantId !== merchantId : evidence.sessionId !== sessionId))
            throw new Error("TOOL_EVIDENCE_NOT_FOUND");
          // 子 Agent 还受委派输入白名单限制，即使同商家证据也不能越权读取。
          if (allowedEvidenceIds && !allowedEvidenceIds.includes(evidence.evidenceId))
            throw new Error("TOOL_EVIDENCE_NOT_AUTHORIZED");
          const delivery = await imageDelivery([evidence], params.includeImages, signal);
          const characters = Array.from(evidence.visibleText);
          const offset = Math.min(params.offset ?? 0, characters.length);
          const nextOffset = Math.min(offset + (params.limit ?? MAX_READ_CHARACTERS), characters.length);
          const text = JSON.stringify({
            ...evidence,
            ...delivery.report,
            visibleText: characters.slice(offset, nextOffset).join(""),
            totalCharacters: characters.length,
            offset,
            nextOffset,
          });
          return {
            content: [{ type: "text", text }, ...delivery.content],
            details: {
              risk: "read",
              scope: "session",
              evidenceId: evidence.evidenceId,
              ...microcompactReadMetadata(
                {
                  kind: "evidence",
                  evidenceId: evidence.evidenceId,
                  sha256: evidence.visibleTextSha256,
                  offset,
                  nextOffset,
                },
                text,
              ),
            },
          };
        },
      },
    },
    {
      risk: "write",
      scope: "session",
      definition: {
        name: "account_diagnosis_save",
        label: "保存账号诊断草稿",
        description:
          "基于可见证据保存或修订账号诊断 DRAFT；区分直接观察、推断和未知，逐项引用证据 ID。修订时传 revisesDiagnosisId，形成新版本；不代表完整经营诊断。",
        promptSnippet: "保存有证据引用的当前账号诊断草稿",
        parameters: diagnosisSaveSchema,
        /** 校验来源后保存账号诊断草稿，并在执行时复核权限。 */
        async execute(_toolCallId, params: Static<typeof diagnosisSaveSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const merchantId = await currentMerchantId();
          if (!runId) throw new Error("TOOL_RUN_UNAVAILABLE");
          if (allowedEvidenceIds && params.evidenceIds.some((id) => !allowedEvidenceIds.includes(id)))
            throw new Error("TOOL_EVIDENCE_NOT_AUTHORIZED");
          const result = await store.saveAccountDiagnosis(
            merchantId,
            sessionId,
            runId,
            merchantContext?.profile.revision ?? null,
            params.evidenceIds,
            params.revisesDiagnosisId ?? null,
            params.report as AccountDiagnosisDraft,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  diagnosisId: result.diagnosisId,
                  status: result.status,
                  evidenceIds: result.evidenceIds,
                  evidenceRefs: result.evidenceRefs,
                  version: result.version,
                  revisesDiagnosisId: result.revisesDiagnosisId,
                  createdAt: result.createdAt,
                }),
              },
            ],
            details: { risk: "write", scope: "session", diagnosisId: result.diagnosisId },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "delegate_task",
        label: "委派专家",
        description:
          "将明确任务交给独立研究、写作、视觉或审核 Agent。填写稳定 taskKey、带 ID 的验收条件及获准资料 ID；可先写作再审核，不同任务使用不同键。",
        promptSnippet:
          (publication?.toolsetVersion ?? TOOLSET_VERSION) >= TOOLSET_VERSION
            ? "研究使用version=3、targetExpertId=researcher、contractId=researcher.report.v1、payload可含questions。默认dependent等待结果；需要后台研究时executionMode=background，先收到受理回执，Host完成后续执行，不能当成研究完成；后台任务每个用户轮最多一个且不能从内部续执行再创建。其他专家使用dependent。writer契约writer.text.v1（payload可含channel/tone）；visual契约visual.report.v1（可含aspectRatio=2:3/imageCount）；reviewer契约reviewer.report.v1（可含focus）。contractVersion=1；inputRefs必须提供Host材料的kind/id/revision/sha256；无资料用[]，payload无额外要求用{}；普通任务直接执行，无需委派。"
            : "按需委派 writer、visual 或 reviewer；同轮多任务使用不同 taskKey；长请求补 contextSummary",
        parameters:
          (publication?.toolsetVersion ?? TOOLSET_VERSION) >= TOOLSET_VERSION
            ? Type.Unsafe<DelegateTaskInput>({
                // Provider 要求工具参数顶层显式为 object；anyOf 继续保留两版完整参数校验。
                ...Type.Union([delegateTaskSchema, expertTaskV3Schema]),
                type: "object",
              })
            : delegateTaskSchema,
        /** 向本轮允许的专家子 Agent 委派任务，并复核会话状态。 */
        async execute(_toolCallId, params: Static<typeof delegateTaskSchema>, signal) {
          await requireActiveSession();
          if (!delegateTask) throw new Error("DELEGATION_NOT_ALLOWED");
          const result = await delegateTask(params as DelegateTaskInput, signal);
          if ("kind" in result)
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              details: { risk: "read", scope: "session", jobId: result.jobId, status: result.status },
            };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  delegationId: result.delegationId,
                  childRunId: result.childRunId,
                  status: result.status,
                  result: result.result,
                  errorCode: result.errorCode,
                }),
              },
            ],
            details: { risk: "read", scope: "session", delegationId: result.delegationId, status: result.status },
          };
        },
      },
    },
    {
      risk: "read",
      scope: "session",
      definition: {
        name: "account_diagnosis_get",
        label: "读取账号诊断草稿",
        description: "读取当前会话或已关联商家的指定或最近一份账号诊断草稿与证据引用。",
        promptSnippet: "读取当前会话可用的账号诊断草稿",
        parameters: diagnosisGetSchema,
        /** 读取当前归属的账号诊断草稿，并在执行时复核权限。 */
        async execute(_toolCallId, params: Static<typeof diagnosisGetSchema>, signal) {
          if (signal?.aborted) throw new Error("TOOL_ABORTED");
          const merchantId = await currentMerchantId();
          const diagnosis = params.diagnosisId
            ? await store.getAccountDiagnosis(params.diagnosisId)
            : ((merchantId
                ? await store.listAccountDiagnoses(merchantId)
                : await store.listSessionAccountDiagnoses(sessionId))[0] ?? null);
          if (!diagnosis || (merchantId ? diagnosis.merchantId !== merchantId : diagnosis.sessionId !== sessionId))
            throw new Error("TOOL_DIAGNOSIS_NOT_FOUND");
          return {
            content: [{ type: "text", text: JSON.stringify(diagnosis) }],
            details: { risk: "read", scope: "session", diagnosisId: diagnosis.diagnosisId },
          };
        },
      },
    },
  ];
  // 每个工具仍受本轮 Plan 白名单限制；外部只读与内部草稿写入各自由 Host 校验归属。
  if (publication && runId && allowedToolIds.includes("publication_task"))
    catalog.push({
      risk: "write",
      scope: "session",
      definition: createPublicationTool(
        store,
        sessionId,
        runId,
        publication.modelId,
        publication.imageModelId,
        publication.historyReadEnabled,
      ),
    });
  return catalog.filter((entry) => allowedToolIds.includes(entry.definition.name)).map((entry) => entry.definition);
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import AjvModule from "ajv/dist/2020.js";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type {
  BindSessionMerchantInput,
  CreateMerchantInput,
  CreateSessionInput,
  MemoryFields,
  MerchantCatalogInput,
  MerchantLinkInput,
  PairingInput,
  RecoveryReport,
  SendMessageInput,
  SessionRecord,
  UpdateMemoryInput,
  UpdateMerchantLinkInput,
  UpdateMerchantProfileInput,
  UpdateSystemPromptInput,
} from "../../shared/contracts.js";
import {
  bindSessionMerchantSchema,
  CONTRACT_VERSION,
  createMemorySchema,
  createMerchantSchema,
  createSessionSchema,
  merchantCatalogSchema,
  merchantLinkSchema,
  pairingSchema,
  sendMessageSchema,
  updateMemorySchema,
  updateMerchantLinkSchema,
  updateMerchantProfileSchema,
  updateSystemPromptSchema,
} from "../../shared/contracts.js";
import { promptSnapshotMarkdown } from "../../shared/prompt-snapshot.js";
import { type PublicationImageTarget, publicationTargetSchema } from "../../shared/publication.js";
import {
  type ResearchAdoptInput,
  type ResearchScope,
  researchAdoptSchema,
  researchScopeSchema,
} from "../../shared/research.js";
import {
  type TopicCreationInput,
  type TopicPlanInput,
  type TopicUpdateInput,
  topicCreationSchema,
  topicPlanSchema,
  topicUpdateSchema,
} from "../../shared/topics.js";
import type { HostConfig, ModelConfig } from "../config.js";
import type { AuditEntry, AuditLog } from "../infrastructure/audit/audit.js";
import type { FileStore } from "../infrastructure/files/files.js";
import type { DbClient, StoredSession } from "../infrastructure/sqlite/db-client.js";
import { registerCapabilityRoutes } from "../modules/capabilities/interfaces/capability-routes.js";
import type { GenerationService } from "../modules/media/application/generation-service.js";
import { MemoryService } from "../modules/merchants/application/memory-service.js";
import { TextGenerationService } from "../modules/publication/application/text-generation-service.js";
import { renderContentMarkdown } from "../modules/publication/infrastructure/content-markdown.js";
import { registerPublicationRoutes } from "../modules/publication/interfaces/publication-routes.js";
import { renderPublicDiagnosisReport } from "../modules/research/application/public-diagnosis-report.js";
import { XhsLoginService } from "../modules/research/infrastructure/xhs-login-service.js";
import { SessionPurgeService } from "../modules/sessions/application/session-purge-service.js";
import { SessionService } from "../modules/sessions/application/session-service.js";
import { registerWorkbenchRoutes } from "../modules/workbench/interfaces/workbench-routes.js";
import { PI_ADAPTER_VERSION } from "../runtime/adapters/pi/pi-sdk-adapter.js";
import type { AgentTaskManager } from "../runtime/execution/agent-task-manager.js";
import { DEFAULT_SYSTEM_PROMPT } from "../runtime/execution/runtime-plan.js";
import type { EventHub } from "./event-hub.js";
import type { PairingService } from "./pairing.js";

const ajv = new AjvModule.default({ allErrors: true });
const validatePairing = ajv.compile<PairingInput>(pairingSchema);
const validateCreateSession = ajv.compile<CreateSessionInput>(createSessionSchema);
const validateBindSessionMerchant = ajv.compile<BindSessionMerchantInput>(bindSessionMerchantSchema);
const validateMessage = ajv.compile<SendMessageInput>(sendMessageSchema);
const validateMerchantSession = ajv.compile<{ title?: string; researchScope?: ResearchScope }>({
  type: "object",
  additionalProperties: false,
  properties: { title: { type: "string", maxLength: 120 }, researchScope: researchScopeSchema },
});
const validateResearchAdopt = ajv.compile<ResearchAdoptInput>(researchAdoptSchema);
const validateSystemPrompt = ajv.compile<UpdateSystemPromptInput>(updateSystemPromptSchema);
const validateMerchant = ajv.compile<CreateMerchantInput>(createMerchantSchema);
const validateMerchantCatalog = ajv.compile<MerchantCatalogInput>(merchantCatalogSchema);
const validateMerchantCatalogUpdate = ajv.compile<
  MerchantCatalogInput & { expectedRevision: number; status: "ACTIVE" | "INACTIVE" }
>({
  ...merchantCatalogSchema,
  required: [...merchantCatalogSchema.required, "expectedRevision", "status"],
  properties: {
    ...merchantCatalogSchema.properties,
    expectedRevision: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
  },
});
const validateMerchantProfile = ajv.compile<UpdateMerchantProfileInput>(updateMerchantProfileSchema);
const validateMerchantLink = ajv.compile<MerchantLinkInput>(merchantLinkSchema);
const validateMerchantLinkUpdate = ajv.compile<UpdateMerchantLinkInput>(updateMerchantLinkSchema);
const validateMemoryCreate = ajv.compile<MemoryFields>(createMemorySchema);
const validateMemoryUpdate = ajv.compile<UpdateMemoryInput>(updateMemorySchema);
const validateContentCreate = ajv.compile<{ sourceMessageId: string; title: string }>({
  type: "object",
  additionalProperties: false,
  required: ["sourceMessageId", "title"],
  properties: {
    sourceMessageId: { type: "string", minLength: 1, maxLength: 80 },
    title: { type: "string", minLength: 1, maxLength: 120 },
  },
});
const validateContentRevise = ajv.compile<{ expectedRevision: number; title: string; body: string }>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "title", "body"],
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1, maxLength: 120 },
    body: { type: "string", minLength: 1, maxLength: 50000 },
  },
});
const validateContentApprove = ajv.compile<{ expectedRevision: number }>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision"],
  properties: { expectedRevision: { type: "integer", minimum: 1 } },
});
const validateImageJob = ajv.compile<{
  prompt: string;
  size: "1024x1024" | "1536x1024" | "1024x1536";
  quality: "low" | "medium" | "high";
  referenceArtifactId?: string;
  costConfirmed: true;
  publication?: PublicationImageTarget;
}>({
  type: "object",
  additionalProperties: false,
  required: ["prompt", "size", "quality", "costConfirmed"],
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 8000 },
    size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"] },
    quality: { type: "string", enum: ["low", "medium", "high"] },
    referenceArtifactId: { type: "string", minLength: 1, maxLength: 80 },
    costConfirmed: { const: true },
    publication: publicationTargetSchema,
  },
});
const validateTopicPlan = ajv.compile<TopicPlanInput>(topicPlanSchema);
const validateTopicUpdate = ajv.compile<TopicUpdateInput>(topicUpdateSchema);
const validateTextJob = ajv.compile<{
  title: string;
  brief: string;
  productEntryId?: string;
  targetDraftId?: string;
  expectedRevision?: number;
  topicCreation?: TopicCreationInput;
}>({
  type: "object",
  additionalProperties: false,
  required: ["title", "brief"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    brief: { type: "string", minLength: 1, maxLength: 8000 },
    topicCreation: topicCreationSchema,
    productEntryId: { type: "string", minLength: 1, maxLength: 80 },
    targetDraftId: { type: "string", minLength: 1, maxLength: 80 },
    expectedRevision: { type: "integer", minimum: 1 },
  },
});
const validateArchive = ajv.compile<{ shareConversationSummary: true }>({
  type: "object",
  additionalProperties: false,
  required: ["shareConversationSummary"],
  properties: { shareConversationSummary: { const: true } },
});
const validateSessionTitle = ajv.compile<{ title: string; expectedRevision: number }>({
  type: "object",
  additionalProperties: false,
  required: ["title", "expectedRevision"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    expectedRevision: { type: "integer", minimum: 1 },
  },
});
const validateLinkDisable = ajv.compile<{ expectedRevision: number }>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision"],
  properties: { expectedRevision: { type: "integer", minimum: 1 } },
});
const validateXhsLoginStart = ajv.compile<{ targetUrl: string }>({
  type: "object",
  additionalProperties: false,
  required: ["targetUrl"],
  properties: { targetUrl: { type: "string", minLength: 1, maxLength: 2048 } },
});
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain"]);

/** 校验上传内容的基本文件特征，避免只相信客户端声明的 MIME。 */
function matchesMime(content: Buffer, mime: string): boolean {
  if (mime === "image/png") return content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg")
    return content.length >= 3 && content[0] === 255 && content[1] === 216 && content[2] === 255;
  if (mime === "image/webp")
    return content.toString("ascii", 0, 4) === "RIFF" && content.toString("ascii", 8, 12) === "WEBP";
  if (mime === "application/pdf") return content.toString("ascii", 0, 5) === "%PDF-";
  if (mime === "text/plain") {
    if (content.includes(0)) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

interface ServerDependencies {
  config: HostConfig;
  db: DbClient;
  files: FileStore;
  pairing: PairingService;
  events: EventHub;
  taskManager: AgentTaskManager;
  generation: GenerationService;
  audit: AuditLog;
  recovery: RecoveryReport;
  secretsLocked: boolean;
}

/** 读取单值请求头，忽略多值或缺失情况。 */
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** 统一返回商家输入错误及请求标识。 */
function merchantInputError(request: FastifyRequest, reply: FastifyReply, code: string, message: string, status = 400) {
  return reply.code(status).send({ code, message, requestId: request.id, retryable: false });
}

/** 解析非负整数查询参数，区分缺省值和非法输入。 */
function queryNumber(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** 冻结总结尝试的非秘密模型参数，密钥仅由执行服务临时注入。 */
function memoryModelConfig(model: ModelConfig | null): Omit<ModelConfig, "apiKey"> | null {
  if (!model) return null;
  const { apiKey: _secret, ...safe } = model;
  return safe;
}

/** 从数据库会话中移除 Host 私有 Pi 快照路径再返回页面。 */
function publicSession({ piSessionFile: _piSessionFile, ...session }: StoredSession): SessionRecord {
  // Pi 快照位于 Host 私有目录，不属于前端会话对象。
  return session;
}

/** 标准化商家平台链接并拒绝不安全的 URL。 */
function normalizedMerchantLink(input: MerchantLinkInput): MerchantLinkInput {
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new Error("MERCHANT_LINK_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("MERCHANT_LINK_INVALID");
  url.hash = "";
  const platform = input.platform.trim();
  if (!platform) throw new Error("MERCHANT_LINK_INVALID");
  return { platform, kind: input.kind, url: url.toString(), label: input.label.trim() };
}

/** 创建 Host 的 HTTP API 与工作台静态资源服务；监听地址由启动入口指定。 */
export async function createServer(deps: ServerDependencies): Promise<FastifyInstance> {
  const server = fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });
  const origin = `http://127.0.0.1:${deps.config.port}`;
  /** 异步记录关键操作审计，写入失败时保留错误提示。 */
  const recordAudit = (entry: AuditEntry) => {
    void deps.audit.record(entry).catch(() => process.stderr.write(`[audit] ${entry.action} 写入失败\n`));
  };
  const sessions = new SessionService(
    deps.db,
    deps.files,
    deps.events,
    deps.taskManager,
    deps.config.model,
    PI_ADAPTER_VERSION,
    deps.config.embedding,
  );
  const textGeneration = new TextGenerationService(deps.db, sessions, deps.config.model?.modelId ?? null, {
    imageModelId: deps.config.image?.modelId ?? null,
    imageInput: deps.config.model?.imageInput ?? false,
    /** 把对话已授权的图片任务交给原有付费任务服务。 */
    enqueue: (job) => deps.generation.enqueue(job),
  });
  const xhsLogin = new XhsLoginService(deps.config.dataDir);
  server.addHook("onClose", async () => xhsLogin.close());
  const memoryService = new MemoryService(deps.db, deps.files, deps.config);
  const purgeService = new SessionPurgeService(deps.db, deps.files);
  server.addHook("onReady", async () => {
    await purgeService.recover();
    purgeService.start();
    if (!deps.recovery.blobIssues.length) await memoryService.start();
    if (!deps.recovery.blobIssues.length) textGeneration.start();
  });
  server.addHook("onClose", async () => purgeService.stop());
  server.addHook("onClose", async () => memoryService.stop());
  server.addHook("onClose", async () => textGeneration.stop());
  server.addHook("preClose", async () => {
    deps.taskManager.beginStop();
    deps.events.close();
  });

  server.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );
  // 入口先限制 Host、Origin 和写入类型，减少本机服务被其他网页调用的机会。
  server.addHook("onRequest", async (request, reply) => {
    if (request.headers.host !== new URL(origin).host) {
      reply.code(403).send({ code: "INVALID_HOST", message: "无效的 Host", requestId: request.id, retryable: false });
      return;
    }
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (isWrite && request.headers.origin !== origin) {
      reply
        .code(403)
        .send({ code: "INVALID_ORIGIN", message: "只接受同源请求", requestId: request.id, retryable: false });
      return;
    }
    if (isWrite && request.url.startsWith("/api/v1/")) {
      const expectedType =
        request.url.split("?")[0] === "/api/v1/uploads" ||
        /^\/api\/v1\/merchants\/[^/]+\/media$/.test(request.url.split("?")[0] ?? "")
          ? "application/octet-stream"
          : "application/json";
      const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== expectedType) {
        reply.code(415).send({
          code: "UNSUPPORTED_CONTENT_TYPE",
          message: `请求需要 ${expectedType} Content-Type`,
          requestId: request.id,
          retryable: false,
        });
      }
    }
  });
  // 公共探活与配对接口之外，所有 API 都要求有效 Cookie；写入再校验 CSRF。
  server.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) return;
    if (
      ["/api/v1/health", "/api/v1/ready", "/api/v1/pairing/status", "/api/v1/pairing/complete"].includes(
        request.url.split("?")[0] ?? "",
      )
    )
      return;
    const cookie = deps.pairing.readCookie(request.headers.cookie);
    if (!cookie) {
      reply
        .code(401)
        .send({ code: "PAIRING_REQUIRED", message: "请先完成本机配对", requestId: request.id, retryable: false });
      return;
    }
    if (
      !["GET", "HEAD"].includes(request.method) &&
      !deps.pairing.verifyCsrf(cookie, header(request, "x-csrf-token"))
    ) {
      reply.code(403).send({ code: "INVALID_CSRF", message: "CSRF 校验失败", requestId: request.id, retryable: false });
      return;
    }
    // 存储异常时保留读取和排障入口，阻止新写入扩大问题。
    if (deps.recovery.blobIssues.length > 0 && !["GET", "HEAD"].includes(request.method)) {
      reply.code(503).send({
        code: "RECOVERY_REQUIRED",
        message: "存储存在异常，请先检查启动恢复报告",
        requestId: request.id,
        retryable: false,
      });
      return;
    }
  });
  // 对外只返回稳定错误码，详细异常留在 Host 日志中。
  server.setErrorHandler((error, request, reply) => {
    const errorMessage = error instanceof Error ? error.message : "";
    const clientStatus =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
        ? error.statusCode
        : null;
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "服务处理失败";
    if (errorMessage === "HOST_STOPPING" || errorMessage === "EVENT_STREAM_CLOSED") {
      status = 503;
      code = errorMessage;
      message = "本机服务正在停止，请在重新启动后继续";
    } else if (["PROMPT_SNAPSHOT_INVALID", "PROMPT_SNAPSHOT_PATH_ESCAPE"].includes(errorMessage)) {
      status = 409;
      code = "PROMPT_SNAPSHOT_INVALID";
      message = "提示词快照无法通过完整性校验，未按当前配置重建";
    } else if (errorMessage === "SESSION_NOT_FOUND") {
      status = 404;
      code = "SESSION_NOT_FOUND";
      message = "会话不存在";
    } else if (errorMessage === "MESSAGE_NOT_FOUND") {
      status = 404;
      code = errorMessage;
      message = "消息不存在或不属于此会话";
    } else if (errorMessage === "RESEARCH_NOT_FOUND") {
      status = 404;
      code = errorMessage;
      message = "研究候选或采用条目不存在，或不属于当前商家";
    } else if (
      ["RESEARCH_STALE", "RESEARCH_REVISION_CONFLICT", "RESEARCH_DUPLICATE", "RESEARCH_RUN_NOT_READY"].includes(
        errorMessage,
      )
    ) {
      status = 409;
      code = errorMessage;
      message =
        errorMessage === "RESEARCH_STALE"
          ? "商家资料或研究来源已变化，请复核后明确选择采用旧资料结果"
          : errorMessage === "RESEARCH_DUPLICATE"
            ? "已有同类同名研究建议，请刷新并选择更新已有条目"
            : errorMessage === "RESEARCH_RUN_NOT_READY"
              ? "来源研究尚未成功完成，不能采用"
              : "研究建议版本已变化，请刷新后重试";
    } else if (["RESEARCH_INPUT_INVALID", "RESEARCH_SOURCE_INVALID", "RESEARCH_LIMIT_REACHED"].includes(errorMessage)) {
      status = 400;
      code = errorMessage;
      message =
        errorMessage === "RESEARCH_LIMIT_REACHED"
          ? "研究候选或采用库已达到数量限制"
          : "研究范围、候选内容或证据归属无效，请检查后重试";
    } else if (errorMessage.startsWith("WORKBENCH_")) {
      const errors: Record<string, string> = {
        WORKBENCH_NOT_FOUND: "计划或素材不存在",
        WORKBENCH_INPUT_INVALID: "日期、素材或登记内容无效，请检查后重试",
        WORKBENCH_REVISION_CONFLICT: "内容已有新版本，请重新读取后保存",
        WORKBENCH_SOURCE_INVALID: "关联资料不属于当前商家或会话",
        WORKBENCH_STATE_CONFLICT: "任务状态已经变化，请先刷新核对",
      };
      status =
        errorMessage === "WORKBENCH_NOT_FOUND"
          ? 404
          : ["WORKBENCH_REVISION_CONFLICT", "WORKBENCH_STATE_CONFLICT"].includes(errorMessage)
            ? 409
            : 400;
      code = errorMessage;
      message = errors[errorMessage] ?? "工作台操作失败";
    } else if (errorMessage.startsWith("CAPABILITY_")) {
      const errors: Record<string, string> = {
        CAPABILITY_NOT_FOUND: "能力或版本不存在",
        CAPABILITY_PACKAGE_INVALID:
          "请选择含 SKILL.md 和 references/*.md 的有效目录；单文件不超过32 KB，整包不超过128 KB",
        CAPABILITY_FRONTMATTER_INVALID: "SKILL.md 需包含有效的 name、description 和规则正文",
        CAPABILITY_BUILTIN_READONLY: "内置 Skill 保留原版，请使用不同名称上传",
        CAPABILITY_REVISION_CONFLICT: "配置已有新版本，请重新读取后保存",
        CAPABILITY_LIMIT_EXCEEDED: "已安装方法数量或大小超过限制，请先停用部分方法",
        CAPABILITY_INPUT_INVALID: "能力配置字段无效，请核对后重试",
      };
      status =
        errorMessage === "CAPABILITY_NOT_FOUND"
          ? 404
          : ["CAPABILITY_REVISION_CONFLICT", "CAPABILITY_BUILTIN_READONLY"].includes(errorMessage)
            ? 409
            : 400;
      code = errorMessage;
      message = errors[errorMessage] ?? "能力暂不可用";
    } else if (errorMessage.startsWith("TASK_BUDGET_")) {
      const errors: Record<string, string> = {
        TASK_BUDGET_NOT_FOUND: "本任务尚未启用执行额度，或不属于当前会话",
        TASK_BUDGET_REVISION_CONFLICT: "额度状态已变化，请刷新后核对再继续",
        TASK_BUDGET_LIMIT_INVALID: "新额度须为有效总量，不能低于已使用额度或超过单次调整上限",
        TASK_BUDGET_RECONCILE_REQUIRED: "上次执行已有外部操作，请先核对原回执；不会自动重放请求",
      };
      code = errorMessage;
      status =
        errorMessage === "TASK_BUDGET_NOT_FOUND" ? 404 : errorMessage === "TASK_BUDGET_LIMIT_INVALID" ? 400 : 409;
      message = errors[errorMessage] ?? "任务额度暂不可用";
    } else if (errorMessage.startsWith("TOPIC_")) {
      const topicErrors: Record<string, string> = {
        TOPIC_NOT_FOUND: "选题不存在、已停用或不属于本会话",
        TOPIC_REVISION_CONFLICT: "选题版本已变化，请刷新后重新选择",
        TOPIC_SOURCE_INVALID: "研究来源无效、不属于当前会话或尚未成功完成",
        TOPIC_SOURCE_STALE: "商家资料已变化，请复核旧研究后勾选继续使用",
        TOPIC_SOURCE_EXPIRED: "报告含已过期话题，请重新研究后规划选题",
        TOPIC_SOURCE_TOO_LARGE: "研究资料过长，请缩小研究范围后重新规划",
        TOPIC_NO_CANDIDATES: "报告没有可用候选，请补充研究资料",
        TOPIC_REFERENCE_INVALID: "参考资料不可用或不属于当前会话",
        TOPIC_OUTPUT_INVALID: "选题输出格式或证据校验未通过，可重新生成",
      };
      status = errorMessage === "TOPIC_NOT_FOUND" ? 404 : 409;
      code = errorMessage;
      message = topicErrors[errorMessage] ?? "选题资料无效";
    } else if (errorMessage.startsWith("TASK_CONTEXT_")) {
      const contextErrors: Record<string, string> = {
        TASK_CONTEXT_NOT_FOUND: "任务上下文不存在或不属于当前会话",
        TASK_CONTEXT_SOURCE_INVALID: "任务要求的来源或归属校验未通过，原内容保留",
        TASK_CONTEXT_REVISION_CONFLICT: "任务要求已有新版本，请刷新核对后重试",
        TASK_CONTEXT_DELTA_INVALID: "本次要求整理格式无效，原话已保留，可继续补充",
        TASK_CONTEXT_LIMIT: "有效要求或待整理原话超过本轮容量，请缩小本次任务范围",
        TASK_CONTEXT_REQUIREMENTS_PENDING: "仍有未整理的新要求，请先通过对话整理要求后再审核",
      };
      status = errorMessage === "TASK_CONTEXT_NOT_FOUND" ? 404 : 409;
      code = errorMessage;
      message = contextErrors[errorMessage] ?? "任务上下文暂不可用，原内容保留";
    } else if (errorMessage.startsWith("PUBLICATION_")) {
      const publicationErrors: Record<string, string> = {
        PUBLICATION_NOT_FOUND: "笔记或发布包不存在",
        PUBLICATION_REVISION_CONFLICT: "文案或图文编排已变化，请刷新核对后重试",
        PUBLICATION_IMAGES_REQUIRED: "请为每个配图位置选用一张图片后再确认交付",
        PUBLICATION_IMAGE_INVALID: "配图或图片任务不属于当前会话，或文件不可用",
        PUBLICATION_IMAGE_PENDING: "此图仍在生成或结果未知，请核对原任务后再操作",
        PUBLICATION_REVIEW_PENDING: "本篇图文正在审核，请等待当前任务结束",
        PUBLICATION_REVIEW_INVALID: "审核结果格式无效，原内容保留，可重新发起",
        PUBLICATION_REVIEW_SOURCE_INVALID: "审核角色或来源回执无效，不能作为独立审核结果",
        PUBLICATION_PLAN_INVALID: "Agent 配图方案格式不正确，请重新规划",
        PUBLICATION_INPUT_INVALID: "图文编排或整套确认信息无效",
        PUBLICATION_CONVERSATION_PENDING: "正在执行上一条要求，完成后可继续对话",
        PUBLICATION_CONVERSATION_INVALID: "本次操作计划格式无效，原内容保留，可重新提出要求",
        PUBLICATION_APPROVAL_INVALID: "这次确认已过时，请核对当前对话和版本",
        PUBLICATION_BLOB_INVALID: "发布包文件完整性校验失败",
      };
      status = errorMessage === "PUBLICATION_NOT_FOUND" ? 404 : 409;
      code = errorMessage;
      message = publicationErrors[errorMessage] ?? "发布包暂不可用";
    } else if (errorMessage === "CONTENT_DRAFT_NOT_FOUND" || errorMessage === "CONTENT_SOURCE_INVALID") {
      status = 404;
      code = errorMessage;
      message = "素材草稿或来源回复不存在，或来源 Run 尚未成功";
    } else if (errorMessage === "CONTENT_REVISION_CONFLICT") {
      status = 409;
      code = errorMessage;
      message = "素材草稿版本已变化，请刷新后重试";
    } else if (errorMessage === "CONTENT_INPUT_INVALID" || errorMessage === "CONTENT_BLOB_INVALID") {
      status = 400;
      code = errorMessage;
      message = "素材内容或文件校验无效";
    } else if (errorMessage === "GENERATION_JOB_NOT_FOUND") {
      status = 404;
      code = errorMessage;
      message = "素材任务不存在";
    } else if (errorMessage === "IMAGE_REFERENCE_INVALID") {
      status = 400;
      code = errorMessage;
      message = "参考图不存在、不属于本会话或格式不可用";
    } else if (errorMessage === "PRODUCT_SOURCE_INVALID") {
      status = 400;
      code = errorMessage;
      message = "请选择本商家商品库中的有效商品";
    } else if (errorMessage === "IDEMPOTENCY_CONFLICT") {
      status = 409;
      code = errorMessage;
      message = "同一请求键的内容已经变化";
    } else if (
      [
        "SESSION_REVISION_CONFLICT",
        "SESSION_ALREADY_TRASHED",
        "SESSION_NOT_TRASHED",
        "SESSION_NOT_ARCHIVED",
        "SESSION_NOT_ACTIVE",
        "SESSION_PURGE_IN_PROGRESS",
        "SESSION_PURGE_REFERENCED",
      ].includes(errorMessage)
    ) {
      status = 409;
      code = errorMessage;
      message =
        errorMessage === "SESSION_PURGE_REFERENCED"
          ? "此会话的资料仍被其他诊断或商家记忆引用，暂不能永久删除"
          : "会话状态或标题版本已变化，请刷新后重试";
    } else if (errorMessage === "SESSION_CURSOR_INVALID") {
      status = 400;
      code = errorMessage;
      message = "分页游标无效";
    } else if (["PUBLIC_PAGE_URL_INVALID", "PUBLIC_PAGE_URL_NOT_ALLOWED"].includes(errorMessage)) {
      status = 400;
      code = errorMessage;
      message = "仅支持小红书主页或笔记的 HTTPS 链接";
    } else if (errorMessage === "XHS_LOGIN_IN_PROGRESS") {
      status = 409;
      code = errorMessage;
      message = "当前会话已有登录窗口，请先完成或取消";
    } else if (errorMessage === "XHS_LOGIN_NOT_PENDING") {
      status = 409;
      code = errorMessage;
      message = "没有等待确认的登录窗口，请重新打开";
    } else if (
      [
        "AUTH_PROFILE_UNAVAILABLE",
        "ACCESS_RESTRICTED",
        "CONTENT_NOT_VISIBLE",
        "PAGE_LOAD_FAILED",
        "XHS_LOGIN_NOT_VERIFIED",
      ].includes(errorMessage)
    ) {
      status = 409;
      code = errorMessage;
      message = `尚未验证目标页可读（${errorMessage}），请检查 Chrome 登录状态或站点限制后重试`;
    } else if (errorMessage === "RUN_NOT_FOUND") {
      status = 404;
      code = "RUN_NOT_FOUND";
      message = "Run 不存在";
    } else if (errorMessage === "MODEL_NOT_CONFIGURED") {
      status = 424;
      code = "MODEL_NOT_CONFIGURED";
      message = "请先配置文本模型";
    } else if (errorMessage === "SKILL_ASSET_INVALID") {
      status = 503;
      code = "SKILL_ASSET_INVALID";
      message = "Skill 资产不可用，请检查项目内的 Skill 文件";
    } else if (errorMessage === "EXPERT_ASSET_INVALID") {
      status = 503;
      code = "EXPERT_ASSET_INVALID";
      message = "角色提示词不可用，请检查项目内的 Expert 文件";
    } else if (errorMessage === "EXPERT_NOT_AVAILABLE") {
      status = 400;
      code = "EXPERT_NOT_AVAILABLE";
      message = "当前会话不能选择该角色";
    } else if (["IDEMPOTENCY_CONFLICT", "CLIENT_TURN_CONFLICT"].includes(errorMessage)) {
      status = 409;
      code = errorMessage;
      message = "请求标识已用于不同内容";
    } else if (errorMessage === "MESSAGE_ARTIFACT_INVALID") {
      status = 400;
      code = errorMessage;
      message = "所选文件不存在、不可用或不属于当前会话";
    } else if (errorMessage === "BLOB_GC_IN_PROGRESS") {
      status = 409;
      code = errorMessage;
      message = "同内容文件正在清理，请稍后重试上传或导出";
    } else if (errorMessage === "SYSTEM_PROMPT_CONFLICT") {
      status = 409;
      code = errorMessage;
      message = "全局提示词已被其他页面修改，请刷新后再保存";
    } else if (errorMessage === "SYSTEM_PROMPT_INVALID") {
      status = 400;
      code = errorMessage;
      message = "提示词不能为空，且不能超过 20000 字符";
    } else if (errorMessage === "MODEL_URL_HAS_CREDENTIALS") {
      status = 400;
      code = errorMessage;
      message = "模型 Base URL 不能包含凭证或查询参数";
    } else if (["MERCHANT_NOT_FOUND", "MERCHANT_LINK_NOT_FOUND", "MERCHANT_CATALOG_NOT_FOUND"].includes(errorMessage)) {
      status = 404;
      code = errorMessage;
      message = "商家或链接不存在";
    } else if (["MERCHANT_REVISION_CONFLICT", "MERCHANT_CATALOG_REVISION_CONFLICT"].includes(errorMessage)) {
      status = 409;
      code = errorMessage;
      message = "商家资料已被修改，请刷新后重试";
    } else if (["MEMORY_NOT_FOUND", "MEMORY_JOB_NOT_FOUND"].includes(errorMessage)) {
      status = 404;
      code = errorMessage;
      message = "当前商家的记忆或总结任务不存在";
    } else if (["MEMORY_SUBJECT_REQUIRED", "MEMORY_SUBJECT_INVALID"].includes(errorMessage)) {
      status = 400;
      code = errorMessage;
      message = "请明确记忆适用于商家通用还是本商家商品，并核对商品版本依据";
    } else if (["MEMORY_REVISION_CONFLICT", "MEMORY_JOB_CONFLICT", "MEMORY_ALREADY_ARCHIVED"].includes(errorMessage)) {
      status = 409;
      code = errorMessage;
      message = "记忆版本或任务状态已变化，请刷新记录后重试";
    } else if (
      [
        "MEMORY_INPUT_INVALID",
        "MEMORY_EXPIRED",
        "MEMORY_LIMIT",
        "MEMORY_NO_MESSAGES",
        "MEMORY_MERCHANT_REQUIRED",
      ].includes(errorMessage)
    ) {
      status = 400;
      code = errorMessage;
      message =
        errorMessage === "MEMORY_LIMIT"
          ? "有效和待确认记忆最多 100 条，请先停用旧记录"
          : errorMessage === "MEMORY_MERCHANT_REQUIRED"
            ? "请先关联商家再保存归档总结"
            : "记忆内容或有效期无效，或没有可总结的会话文字";
    } else if (errorMessage.startsWith("CONTINUATION_")) {
      status = 409;
      code = errorMessage;
      message =
        errorMessage === "CONTINUATION_CONTEXT_LIMIT"
          ? "接续的原始要求过长或已连续停止多次，请整理完整要求后开始新任务"
          : "接续来源已变化、尚未停止或不属于当前会话，请刷新后重试或开始新任务";
    } else if (errorMessage === "SESSION_RUN_ACTIVE") {
      status = 409;
      code = errorMessage;
      message = "当前会话已有执行任务，请等待完成或停止后再操作";
    } else if (errorMessage === "SESSION_MERCHANT_CONFLICT") {
      status = 409;
      code = errorMessage;
      message = "该对话已关联其他商家";
    } else if (
      [
        "MERCHANT_INPUT_INVALID",
        "MERCHANT_LINK_INVALID",
        "MERCHANT_LINK_LIMIT",
        "MERCHANT_CATALOG_INPUT_INVALID",
        "MERCHANT_CATALOG_EVIDENCE_INVALID",
        "MERCHANT_CATALOG_LIMIT",
      ].includes(errorMessage)
    ) {
      status = 400;
      code = errorMessage;
      message =
        errorMessage === "MERCHANT_LINK_LIMIT"
          ? "每个商家最多保存 20 条有效链接"
          : errorMessage === "MERCHANT_CATALOG_LIMIT"
            ? "每个商家最多保存 100 条有效商品和线索"
            : errorMessage === "MERCHANT_CATALOG_EVIDENCE_INVALID"
              ? "公开证据不可用或不属于当前商家"
              : errorMessage === "MERCHANT_CATALOG_INPUT_INVALID"
                ? "商品或选题线索内容、来源链接或时间无效"
                : "商家资料或链接无效";
    } else if (clientStatus) {
      status = clientStatus;
      code = "INVALID_REQUEST";
      message = "请求格式无效";
    }
    if (status >= 500) process.stderr.write(`[request ${request.id}] ${code}\n`);
    reply.code(status).send({ code, message, requestId: request.id, retryable: false });
  });

  // 探活表示进程可响应；就绪还要求数据库和 Blob 检查通过。
  // GET /api/v1/health：只报告进程存活，不代表数据库或模型可用。
  server.get("/api/v1/health", async () => ({ status: "ok" }));
  // GET /api/v1/ready：核对数据库与 Blob 就绪状态，另返回模型是否已配置。
  server.get("/api/v1/ready", async (_request, reply) => {
    const database = await deps.db.health();
    const ready = database.quickCheck === "ok" && deps.recovery.blobIssues.length === 0;
    if (!ready) reply.code(503);
    return {
      ready,
      database,
      runtime: { adapterVersion: PI_ADAPTER_VERSION, modelConfigured: Boolean(deps.config.model) },
      recovery: {
        scannedAt: deps.recovery.scannedAt,
        interruptedRunCount: deps.recovery.interruptedRunIds.length,
        queuedRunCount: deps.recovery.queuedRunIds.length,
        stagingFileCount: deps.recovery.stagingFiles.length,
        blobIssueCount: deps.recovery.blobIssues.length,
      },
    };
  });
  // GET /api/v1/recovery：提供启动恢复扫描的只读结果。
  server.get("/api/v1/recovery", async () => deps.recovery);
  // GET /api/v1/pairing/status：返回当前浏览器的配对与 CSRF 状态。
  server.get("/api/v1/pairing/status", async (request) => {
    const cookie = deps.pairing.readCookie(request.headers.cookie);
    return { paired: Boolean(cookie), csrfToken: cookie ? deps.pairing.csrfToken(cookie) : null };
  });
  // POST /api/v1/pairing/complete：验证本机配对码并签发独立 Cookie。
  server.post("/api/v1/pairing/complete", async (request, reply) => {
    if (!validatePairing(request.body))
      return reply
        .code(400)
        .send({ code: "INVALID_INPUT", message: "请输入六位配对码", requestId: request.id, retryable: false });
    const cookie = deps.pairing.complete(request.body.code);
    if (!cookie)
      return reply.code(403).send({
        code: "INVALID_PAIRING_CODE",
        message: "配对码错误",
        requestId: request.id,
        retryable: false,
      });
    reply.header("Set-Cookie", deps.pairing.cookieHeader(cookie));
    recordAudit({ action: "pairing.completed", requestId: request.id });
    return { paired: true, csrfToken: deps.pairing.csrfToken(cookie) };
  });
  // GET /api/v1/bootstrap：提供工作台启动所需的版本与模型可用状态。
  registerCapabilityRoutes(server, deps.db, recordAudit);
  registerWorkbenchRoutes(server, deps.db, deps.files, matchesMime, recordAudit);
  server.get("/api/v1/bootstrap", async () => ({
    contractVersion: CONTRACT_VERSION,
    model: deps.config.model
      ? {
          configured: true,
          alias: deps.config.model.modelId,
          reason: null,
          imageInput: deps.config.model.imageInput === true,
        }
      : {
          configured: false,
          alias: null,
          reason: deps.secretsLocked
            ? "加密模型配置已锁定，请设置 ZHIBAN_MASTER_KEY 后重启 Host"
            : "尚未配置文本模型，请设置 ZHIBAN_MODEL_BASE_URL、ZHIBAN_MODEL_ID 和 ZHIBAN_MODEL_API_KEY 后重启 Host",
        },
    providers: {
      image: deps.config.image ? deps.config.image.modelId : "unconfigured",
      businessData: "unconfigured",
      delivery: "unconfigured",
    },
  }));
  // GET /api/v1/settings/system-prompt：读取全局系统提示词及当前版本。
  server.get("/api/v1/settings/system-prompt", async () => ({
    ...(await deps.db.getSystemPrompt()),
    defaultContent: DEFAULT_SYSTEM_PROMPT,
  }));
  // PUT /api/v1/settings/system-prompt：按预期版本更新全局系统提示词。
  server.put("/api/v1/settings/system-prompt", async (request, reply) => {
    const operationKey = header(request, "idempotency-key");
    if (!operationKey)
      return reply.code(400).send({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "缺少 Idempotency-Key",
        requestId: request.id,
        retryable: false,
      });
    if (!validateSystemPrompt(request.body))
      return reply.code(400).send({
        code: "INVALID_INPUT",
        message: "提示词内容或版本无效",
        requestId: request.id,
        retryable: false,
      });
    const result = await deps.db.updateSystemPrompt(request.body.content, request.body.revision, operationKey);
    recordAudit({ action: "system-prompt.updated", requestId: request.id, status: String(result.revision) });
    return { ...result, defaultContent: DEFAULT_SYSTEM_PROMPT };
  });
  // 每次 SSE 连接先申请与当前 Cookie 绑定的一次性 token，重连重新签发。
  // POST /api/v1/events/token：为当前配对会话签发一次性事件连接令牌。
  server.post("/api/v1/events/token", async (request, reply) => {
    const cookie = deps.pairing.readCookie(request.headers.cookie);
    if (!cookie)
      return reply
        .code(401)
        .send({ code: "PAIRING_REQUIRED", message: "请先配对", requestId: request.id, retryable: false });
    return { token: deps.pairing.issueConnectionToken(cookie) };
  });

  // GET /api/v1/sessions/:sessionId/events/stream：鉴权后按游标接续 SSE。
  server.get<{ Params: { sessionId: string }; Querystring: { afterSeq?: string; token?: string } }>(
    "/api/v1/sessions/:sessionId/events/stream",
    async (request, reply) => {
      const cookie = deps.pairing.readCookie(request.headers.cookie);
      const sourceOrigin = request.headers.origin;
      if (
        (sourceOrigin && sourceOrigin !== origin) ||
        !cookie ||
        !deps.pairing.consumeConnectionToken(cookie, request.query.token ?? "")
      )
        return reply.code(403).send({
          code: "INVALID_EVENT_TOKEN",
          message: "事件连接凭证无效，请重新连接",
          requestId: request.id,
          retryable: false,
        });
      const afterSeq = queryNumber(header(request, "last-event-id") ?? request.query.afterSeq, 0);
      if (afterSeq === null)
        return reply
          .code(400)
          .send({ code: "INVALID_CURSOR", message: "事件游标无效", requestId: request.id, retryable: false });
      await deps.events.open(reply, request.params.sessionId, afterSeq);
    },
  );

  // GET /api/v1/merchants：列出本机人工维护的商家。
  server.get("/api/v1/merchants", async () => ({ items: await deps.db.listMerchants() }));
  // POST /api/v1/merchants：创建商家及其初始人工档案。
  server.post("/api/v1/merchants", async (request, reply) => {
    const operationKey = header(request, "idempotency-key");
    if (!operationKey) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    if (!validateMerchant(request.body)) return merchantInputError(request, reply, "INVALID_INPUT", "商家名称无效");
    const result = await deps.db.createMerchant(request.body.name, operationKey);
    recordAudit({ action: "merchant.created", requestId: request.id, merchantId: result.merchant.merchantId });
    return reply.code(201).send(result);
  });
  // GET /api/v1/merchants/:merchantId：读取指定商家的档案与平台链接。
  server.get<{ Params: { merchantId: string } }>("/api/v1/merchants/:merchantId", async (request, reply) => {
    const result = await deps.db.getMerchant(request.params.merchantId);
    if (!result) return merchantInputError(request, reply, "MERCHANT_NOT_FOUND", "商家不存在", 404);
    return result;
  });
  // 商品库与选题线索由商家人工维护；热点和竞品证据须显式标注来源。
  server.get<{ Params: { merchantId: string } }>("/api/v1/merchants/:merchantId/catalog", async (request, reply) => {
    if (!(await deps.db.getMerchant(request.params.merchantId)))
      return merchantInputError(request, reply, "MERCHANT_NOT_FOUND", "商家不存在", 404);
    return { items: await deps.db.listMerchantCatalog(request.params.merchantId) };
  });
  server.post<{ Params: { merchantId: string } }>("/api/v1/merchants/:merchantId/catalog", async (request, reply) => {
    const key = header(request, "idempotency-key");
    if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    if (!validateMerchantCatalog(request.body))
      return merchantInputError(request, reply, "INVALID_INPUT", "商品或选题线索无效");
    const result = await deps.db.createMerchantCatalogEntry(request.params.merchantId, request.body, key);
    recordAudit({
      action: "merchant.catalog.updated",
      requestId: request.id,
      merchantId: request.params.merchantId,
      status: `${result.kind}:${result.revision}`,
    });
    return reply.code(201).send(result);
  });
  server.put<{ Params: { merchantId: string; entryId: string } }>(
    "/api/v1/merchants/:merchantId/catalog/:entryId",
    async (request, reply) => {
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateMerchantCatalogUpdate(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "商品或选题线索版本无效");
      const result = await deps.db.updateMerchantCatalogEntry(
        request.params.merchantId,
        request.params.entryId,
        request.body.expectedRevision,
        request.body,
        request.body.status,
        key,
      );
      recordAudit({
        action: "merchant.catalog.updated",
        requestId: request.id,
        merchantId: request.params.merchantId,
        status: `${result.kind}:${result.revision}:${result.status}`,
      });
      return result;
    },
  );
  // GET /api/v1/merchants/:merchantId/public-evidence：按商家归属列出公开页面证据。
  server.get<{ Params: { merchantId: string } }>(
    "/api/v1/merchants/:merchantId/public-evidence",
    async (request, reply) => {
      if (!(await deps.db.getMerchant(request.params.merchantId)))
        return merchantInputError(request, reply, "MERCHANT_NOT_FOUND", "商家不存在", 404);
      return { items: await deps.db.listPublicEvidence(request.params.merchantId) };
    },
  );
  // GET /api/v1/merchants/:merchantId/account-diagnoses：按商家归属列出账号诊断草稿。
  server.get<{ Params: { merchantId: string } }>(
    "/api/v1/merchants/:merchantId/account-diagnoses",
    async (request, reply) => {
      if (!(await deps.db.getMerchant(request.params.merchantId)))
        return merchantInputError(request, reply, "MERCHANT_NOT_FOUND", "商家不存在", 404);
      return { items: await deps.db.listAccountDiagnoses(request.params.merchantId) };
    },
  );
  // GET /api/v1/merchants/:merchantId/public-diagnosis-reports：按归属列出已导出的公开资料报告。
  server.get<{ Params: { merchantId: string } }>(
    "/api/v1/merchants/:merchantId/public-diagnosis-reports",
    async (request, reply) => {
      if (!(await deps.db.getMerchant(request.params.merchantId)))
        return merchantInputError(request, reply, "MERCHANT_NOT_FOUND", "商家不存在", 404);
      return { items: await deps.db.listPublicDiagnosisReports(request.params.merchantId) };
    },
  );
  // POST：用户选择一版有完整来源的草稿，生成不可变的公开资料报告。
  server.post<{ Params: { merchantId: string }; Body: { diagnosisId?: string } }>(
    "/api/v1/merchants/:merchantId/public-diagnosis-reports",
    async (request, reply) => {
      const merchant = await deps.db.getMerchant(request.params.merchantId);
      if (!merchant) return merchantInputError(request, reply, "MERCHANT_NOT_FOUND", "商家不存在", 404);
      const diagnosisId = request.body?.diagnosisId;
      if (typeof diagnosisId !== "string" || !/^dia_[0-9a-f-]{36}$/.test(diagnosisId))
        return merchantInputError(request, reply, "INVALID_INPUT", "诊断版本无效");
      const diagnosis = await deps.db.getAccountDiagnosis(diagnosisId);
      if (diagnosis?.merchantId !== request.params.merchantId)
        return merchantInputError(request, reply, "DIAGNOSIS_NOT_FOUND", "诊断版本不存在", 404);
      let markdown: string;
      try {
        markdown = renderPublicDiagnosisReport(diagnosis, merchant.merchant.name);
      } catch {
        return merchantInputError(
          request,
          reply,
          "PUBLIC_REPORT_SOURCE_INCOMPLETE",
          "请先修订缺少来源或分类的诊断草稿",
        );
      }
      const content = Buffer.from(markdown, "utf8");
      const blob = await deps.files.putBlob(content);
      const report = await deps.db.publishPublicDiagnosisReport(
        request.params.merchantId,
        diagnosisId,
        blob.hash,
        blob.size,
      );
      recordAudit({
        action: "public_diagnosis_report.published",
        requestId: request.id,
        merchantId: request.params.merchantId,
        artifactId: report.artifactId,
      });
      return reply.code(201).send(report);
    },
  );
  // GET：下载前再核对商家归属、Artifact 状态和 Blob 摘要。
  server.get<{ Params: { merchantId: string; reportId: string } }>(
    "/api/v1/merchants/:merchantId/public-diagnosis-reports/:reportId/content",
    async (request, reply) => {
      const report = await deps.db.getPublicDiagnosisReport(request.params.merchantId, request.params.reportId);
      if (!report) return merchantInputError(request, reply, "REPORT_NOT_FOUND", "报告不存在", 404);
      const artifact = await deps.db.getArtifact(report.artifactId);
      if (
        artifact?.kind !== "public_diagnosis_report" ||
        artifact.status !== "READY" ||
        artifact.blobHash !== report.blobHash
      )
        return merchantInputError(request, reply, "REPORT_UNAVAILABLE", "报告文件不可用", 409);
      const content = await deps.files.readBlob(report.blobHash);
      return reply
        .type("text/markdown; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.title)}`)
        .send(content);
    },
  );
  // 商家记忆写入仅由已配对用户发起；Agent 只有冻结版本的读取工具。
  server.get<{ Params: { merchantId: string } }>("/api/v1/merchants/:merchantId/memories", async (request) => ({
    items: await deps.db.listMemories(request.params.merchantId),
  }));
  server.get<{ Params: { merchantId: string; memoryId: string } }>(
    "/api/v1/merchants/:merchantId/memories/:memoryId/history",
    async (request) => ({ items: await deps.db.memoryHistory(request.params.merchantId, request.params.memoryId) }),
  );
  server.post<{ Params: { merchantId: string } }>("/api/v1/merchants/:merchantId/memories", async (request, reply) => {
    const key = header(request, "idempotency-key");
    if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    if (!validateMemoryCreate(request.body)) return merchantInputError(request, reply, "INVALID_INPUT", "记忆内容无效");
    const result = await deps.db.createMemory(request.params.merchantId, request.body, key);
    recordAudit({ action: "merchant.memory.updated", requestId: request.id, merchantId: request.params.merchantId });
    return reply.code(201).send(result);
  });
  server.put<{ Params: { merchantId: string; memoryId: string } }>(
    "/api/v1/merchants/:merchantId/memories/:memoryId",
    async (request, reply) => {
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateMemoryUpdate(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "记忆内容或版本无效");
      const result = await deps.db.updateMemory(request.params.merchantId, request.params.memoryId, request.body, key);
      recordAudit({ action: "merchant.memory.updated", requestId: request.id, merchantId: request.params.merchantId });
      return result;
    },
  );
  server.get<{ Params: { merchantId: string } }>(
    "/api/v1/merchants/:merchantId/memory-jobs",
    async (request, reply) => {
      if (!(await deps.db.getMerchant(request.params.merchantId)))
        return merchantInputError(request, reply, "MERCHANT_NOT_FOUND", "商家不存在", 404);
      return { items: await deps.db.listMemoryJobs(request.params.merchantId) };
    },
  );
  server.post<{ Params: { merchantId: string; jobId: string } }>(
    "/api/v1/merchants/:merchantId/memory-jobs/:jobId/retry",
    async (request, reply) => {
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      const result = await deps.db.retryMemoryJob(
        request.params.merchantId,
        request.params.jobId,
        memoryModelConfig(deps.config.model),
        key,
      );
      memoryService.wake();
      return result;
    },
  );
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/archive", async (request, reply) => {
    const key = header(request, "idempotency-key");
    if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    const current = await deps.db.getSession(request.params.sessionId);
    if (!current) return merchantInputError(request, reply, "SESSION_NOT_FOUND", "会话不存在", 404);
    if (current.scope === "NORMAL") {
      const archived = await deps.db.archiveNormalSession(request.params.sessionId, key);
      recordAudit({ action: "session.archived", requestId: request.id, sessionId: request.params.sessionId });
      return publicSession(archived);
    }
    if (!validateArchive(request.body))
      return merchantInputError(request, reply, "INVALID_INPUT", "归档需要明确允许会话文字总结用于该商家的后续会话");
    const result = await deps.db.archiveForMemory(request.params.sessionId, memoryModelConfig(deps.config.model), key);
    recordAudit({
      action: "session.archived",
      requestId: request.id,
      sessionId: request.params.sessionId,
      merchantId: result.merchantId,
    });
    memoryService.wake();
    return reply.code(202).send(result);
  });
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/restore", async (request, reply) => {
    const key = header(request, "idempotency-key");
    if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    return publicSession(await deps.db.restoreSession(request.params.sessionId, key));
  });

  // PUT /api/v1/merchants/:merchantId/profile：按预期版本保存商家人工档案。
  server.put<{ Params: { merchantId: string } }>("/api/v1/merchants/:merchantId/profile", async (request, reply) => {
    const operationKey = header(request, "idempotency-key");
    if (!operationKey) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    if (!validateMerchantProfile(request.body))
      return merchantInputError(request, reply, "INVALID_INPUT", "商家档案无效");
    const result = await deps.db.updateMerchantProfile(
      request.params.merchantId,
      request.body.expectedRevision,
      request.body.fields,
      operationKey,
    );
    recordAudit({ action: "merchant.profile.updated", requestId: request.id, merchantId: request.params.merchantId });
    return result;
  });
  // POST /api/v1/merchants/:merchantId/links：创建商家平台链接；链接本身不是已采集证据。
  server.post<{ Params: { merchantId: string } }>("/api/v1/merchants/:merchantId/links", async (request, reply) => {
    const operationKey = header(request, "idempotency-key");
    if (!operationKey) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    if (!validateMerchantLink(request.body)) return merchantInputError(request, reply, "INVALID_INPUT", "平台链接无效");
    const result = await deps.db.createMerchantLink(
      request.params.merchantId,
      normalizedMerchantLink(request.body),
      operationKey,
    );
    recordAudit({ action: "merchant.link.updated", requestId: request.id, merchantId: request.params.merchantId });
    return reply.code(201).send(result);
  });
  // PUT /api/v1/merchants/:merchantId/links/:linkId：按版本更新平台链接。
  server.put<{ Params: { merchantId: string; linkId: string } }>(
    "/api/v1/merchants/:merchantId/links/:linkId",
    async (request, reply) => {
      const operationKey = header(request, "idempotency-key");
      if (!operationKey) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateMerchantLinkUpdate(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "平台链接无效");
      const normalized = normalizedMerchantLink(request.body);
      const result = await deps.db.updateMerchantLink(
        request.params.merchantId,
        request.params.linkId,
        { ...normalized, expectedRevision: request.body.expectedRevision },
        operationKey,
      );
      recordAudit({ action: "merchant.link.updated", requestId: request.id, merchantId: request.params.merchantId });
      return result;
    },
  );
  // DELETE /api/v1/merchants/:merchantId/links/:linkId：按版本停用平台链接。
  server.delete<{ Params: { merchantId: string; linkId: string } }>(
    "/api/v1/merchants/:merchantId/links/:linkId",
    async (request, reply) => {
      const operationKey = header(request, "idempotency-key");
      if (!operationKey) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateLinkDisable(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "链接版本无效");
      const result = await deps.db.disableMerchantLink(
        request.params.merchantId,
        request.params.linkId,
        request.body.expectedRevision,
        operationKey,
      );
      recordAudit({ action: "merchant.link.updated", requestId: request.id, merchantId: request.params.merchantId });
      return result;
    },
  );
  // GET /api/v1/merchants/:merchantId/research：商家候选与采用库共用持久事实源。
  server.get<{ Params: { merchantId: string }; Querystring: { sessionId?: string } }>(
    "/api/v1/merchants/:merchantId/research",
    async (request, reply) => {
      const merchantId = request.params.merchantId;
      if (!(await deps.db.getMerchant(merchantId)))
        return merchantInputError(request, reply, "MERCHANT_NOT_FOUND", "商家不存在", 404);
      if (request.query.sessionId) {
        const session = await deps.db.getSession(request.query.sessionId);
        if (session?.scope !== "MERCHANT" || session.ownerId !== merchantId) throw new Error("RESEARCH_NOT_FOUND");
      }
      const [batches, library, analyses, reports] = await Promise.all([
        deps.db.listResearchBatches(merchantId, request.query.sessionId),
        deps.db.listResearchLibrary(merchantId),
        deps.db.listContentAnalyses(merchantId, request.query.sessionId),
        deps.db.listResearchReports(merchantId, request.query.sessionId),
      ]);
      return { batches, library, analyses, reports };
    },
  );
  // GET /api/v1/merchants/:merchantId/research-reports/:reportId/download：下载候选报告，不自动采用或发布。
  server.get<{ Params: { merchantId: string; reportId: string } }>(
    "/api/v1/merchants/:merchantId/research-reports/:reportId/download",
    async (request, reply) => {
      const report = await deps.db.getResearchReport(request.params.merchantId, request.params.reportId);
      if (!report) throw new Error("RESEARCH_NOT_FOUND");
      const status = `> 来源执行状态：${report.sourceRunStatus}；${report.stale ? "商家资料或所选来源已变化，使用前复核" : "采用建议仍需用户确认"}。\n\n`;
      return reply
        .type("text/markdown; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${report.title}.md`)}`)
        .send(status + report.markdown);
    },
  );
  // POST /api/v1/merchants/:merchantId/research/:batchId/adopt：用户编辑后显式采用候选。
  server.post<{ Params: { merchantId: string; batchId: string } }>(
    "/api/v1/merchants/:merchantId/research/:batchId/adopt",
    async (request, reply) => {
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateResearchAdopt(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "研究采用参数无效");
      const result = await deps.db.adoptResearchCandidate(
        request.params.merchantId,
        request.params.batchId,
        request.body,
        key,
      );
      recordAudit({
        action: "merchant.research.adopted",
        requestId: request.id,
        merchantId: request.params.merchantId,
      });
      return result;
    },
  );
  // POST /api/v1/merchants/:merchantId/research-library/:itemId/deactivate：按版本停用，保留旧引用。
  server.post<{ Params: { merchantId: string; itemId: string } }>(
    "/api/v1/merchants/:merchantId/research-library/:itemId/deactivate",
    async (request, reply) => {
      if (!header(request, "idempotency-key"))
        return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateLinkDisable(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "研究条目版本无效");
      const result = await deps.db.deactivateResearchItem(
        request.params.merchantId,
        request.params.itemId,
        request.body.expectedRevision,
      );
      recordAudit({
        action: "merchant.research.deactivated",
        requestId: request.id,
        merchantId: request.params.merchantId,
      });
      return result;
    },
  );

  // POST /api/v1/merchants/:merchantId/sessions：创建归属指定商家的新会话。
  server.post<{ Params: { merchantId: string } }>("/api/v1/merchants/:merchantId/sessions", async (request, reply) => {
    const operationKey = header(request, "idempotency-key");
    if (!operationKey) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    const body = request.body ?? {};
    if (!validateMerchantSession(body))
      return merchantInputError(request, reply, "INVALID_INPUT", "会话或研究范围参数无效");
    const title = body.title?.trim() || "商家会话";
    const result = await sessions.createMerchantSession(
      request.params.merchantId,
      title,
      operationKey,
      body.researchScope,
    );
    recordAudit({
      action: "session.create.accepted",
      requestId: request.id,
      sessionId: result.sessionId,
      merchantId: request.params.merchantId,
    });
    return reply.code(201).send(publicSession(result));
  });

  // 会话与消息的读写走 SessionService / DbClient，HTTP 层负责校验和响应。
  // GET /api/v1/sessions：列出本机普通与商家会话。
  server.get("/api/v1/sessions", async () => ({ items: (await deps.db.listSessions()).map(publicSession) }));
  // GET /api/v1/sessions/page：按稳定游标浏览活动会话或回收站。
  server.get<{ Querystring: { status?: string; cursor?: string; limit?: string } }>(
    "/api/v1/sessions/page",
    async (request, reply) => {
      if (request.query.status && !["ACTIVE", "TRASHED"].includes(request.query.status))
        return merchantInputError(request, reply, "INVALID_STATUS", "会话列表状态无效");
      const status = request.query.status === "TRASHED" ? "TRASHED" : "ACTIVE";
      const limit = queryNumber(request.query.limit, 50);
      if (limit === null || limit < 1 || limit > 100)
        return merchantInputError(request, reply, "INVALID_LIMIT", "limit 必须为 1～100");
      const result = await deps.db.listSessionPage(status, request.query.cursor ?? null, limit);
      return { items: result.items.map(publicSession), nextCursor: result.nextCursor };
    },
  );
  // GET /api/v1/sessions/search：搜索所有可见会话的持久消息。
  server.get<{ Querystring: { q?: string; merchantId?: string } }>(
    "/api/v1/sessions/search",
    async (request, reply) => {
      const query = request.query.q?.trim() ?? "";
      if (!query || query.length > 120)
        return merchantInputError(request, reply, "INVALID_QUERY", "请输入 1～120 字的关键词");
      if (request.query.merchantId && !(await deps.db.getMerchant(request.query.merchantId)))
        return merchantInputError(request, reply, "MERCHANT_NOT_FOUND", "商家不存在", 404);
      return { items: await deps.db.searchMessages(query, request.query.merchantId ?? null) };
    },
  );
  // POST /api/v1/sessions：创建普通会话。
  server.post("/api/v1/sessions", async (request, reply) => {
    const operationKey = header(request, "idempotency-key");
    if (!operationKey)
      return reply.code(400).send({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "缺少 Idempotency-Key",
        requestId: request.id,
        retryable: false,
      });
    const body = request.body ?? {};
    if (!validateCreateSession(body))
      return reply
        .code(400)
        .send({ code: "INVALID_INPUT", message: "会话参数无效", requestId: request.id, retryable: false });
    const title = body.title?.trim() || "新会话";
    const result = await sessions.createSession(title, operationKey);
    recordAudit({ action: "session.create.accepted", requestId: request.id, sessionId: result.sessionId });
    return reply.code(201).send(publicSession(result));
  });
  // PATCH /api/v1/sessions/:sessionId/title：用户按版本修改标题。
  server.patch<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/title", async (request, reply) => {
    const key = header(request, "idempotency-key");
    if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    if (!validateSessionTitle(request.body) || !request.body.title.trim())
      return merchantInputError(request, reply, "INVALID_INPUT", "标题或预期版本无效");
    return publicSession(
      await deps.db.renameSession(
        request.params.sessionId,
        request.body.title.trim(),
        request.body.expectedRevision,
        key,
      ),
    );
  });
  // GET /api/v1/sessions/:sessionId/delete-impact：回收前预览关联对象。
  server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/delete-impact", async (request) =>
    deps.db.sessionDeleteImpact(request.params.sessionId),
  );
  // POST /api/v1/sessions/:sessionId/trash：仅移动生命周期，不删除持久内容。
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/trash", async (request, reply) => {
    const key = header(request, "idempotency-key");
    if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    const result = await deps.db.trashSession(request.params.sessionId, key);
    recordAudit({ action: "session.trashed", requestId: request.id, sessionId: request.params.sessionId });
    return publicSession(result);
  });
  // POST /api/v1/sessions/:sessionId/untrash：从回收站恢复原状态。
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/untrash", async (request, reply) => {
    const key = header(request, "idempotency-key");
    if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    const result = await deps.db.restoreTrashedSession(request.params.sessionId, key);
    recordAudit({ action: "session.untrashed", requestId: request.id, sessionId: request.params.sessionId });
    return publicSession(result);
  });
  // DELETE /api/v1/sessions/:sessionId/permanent：明确确认后永久清理回收站会话。
  server.delete<{ Params: { sessionId: string }; Body: { confirmSessionId?: string } }>(
    "/api/v1/sessions/:sessionId/permanent",
    async (request, reply) => {
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (request.body?.confirmSessionId !== request.params.sessionId)
        return merchantInputError(request, reply, "INVALID_INPUT", "请明确确认要永久删除的会话 ID");
      await purgeService.run(request.params.sessionId);
      recordAudit({ action: "session.purged", requestId: request.id, sessionId: request.params.sessionId });
      return { sessionId: request.params.sessionId, status: "FINALIZED" };
    },
  );
  // POST /api/v1/sessions/:sessionId/read：单调记录本机用户已读位置。
  server.post<{ Params: { sessionId: string }; Body: { messageId?: string } }>(
    "/api/v1/sessions/:sessionId/read",
    async (request, reply) => {
      const messageId = request.body?.messageId;
      if (typeof messageId !== "string" || !messageId.startsWith("msg_"))
        return merchantInputError(request, reply, "INVALID_INPUT", "消息 ID 无效");
      return publicSession(await deps.db.markSessionRead(request.params.sessionId, messageId));
    },
  );
  // GET /api/v1/sessions/:sessionId/messages/around：按持久消息 ID 定位历史。
  server.get<{ Params: { sessionId: string }; Querystring: { messageId?: string } }>(
    "/api/v1/sessions/:sessionId/messages/around",
    async (request, reply) => {
      if (!request.query.messageId) return merchantInputError(request, reply, "INVALID_INPUT", "缺少消息 ID");
      return { items: await deps.db.messagesAround(request.params.sessionId, request.query.messageId) };
    },
  );
  // POST /api/v1/sessions/:sessionId/merchant：将普通会话绑定到商家并保留历史归属。
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/merchant", async (request, reply) => {
    const operationKey = header(request, "idempotency-key");
    if (!operationKey) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    if (!validateBindSessionMerchant(request.body))
      return merchantInputError(request, reply, "INVALID_INPUT", "请选择要关联的商家");
    const result = await sessions.bindSessionMerchant(request.params.sessionId, request.body.merchantId, operationKey);
    recordAudit({
      action: "session.merchant.bound",
      requestId: request.id,
      sessionId: result.sessionId,
      merchantId: result.ownerId,
    });
    return publicSession(result);
  });
  // GET /api/v1/sessions/:sessionId：读取指定会话的公开元数据。
  server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId", async (request, reply) => {
    const result = await deps.db.getSession(request.params.sessionId);
    if (!result)
      return reply
        .code(404)
        .send({ code: "SESSION_NOT_FOUND", message: "会话不存在", requestId: request.id, retryable: false });
    return publicSession(result);
  });
  // GET /api/v1/sessions/:sessionId/snapshot：返回断线恢复所需的会话、消息、Run 与事件快照。
  server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/snapshot", async (request, reply) => {
    const snapshot = await deps.db.getSessionSnapshot(request.params.sessionId);
    if (!snapshot)
      return reply
        .code(404)
        .send({ code: "SESSION_NOT_FOUND", message: "会话不存在", requestId: request.id, retryable: false });
    return { ...snapshot, session: publicSession(snapshot.session) };
  });
  /** 校验小红书登录请求指向仍活跃的本机会话。 */
  const requireXhsLoginSession = async (sessionId: string) => {
    const session = await deps.db.getSession(sessionId);
    if (session?.lifecycleStatus !== "ACTIVE") throw new Error("SESSION_NOT_FOUND");
  };
  // GET /api/v1/sessions/:sessionId/xhs-login：查询当前会话的小红书浏览器授权状态。
  server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/xhs-login", async (request) => {
    await requireXhsLoginSession(request.params.sessionId);
    return xhsLogin.status(request.params.sessionId);
  });
  // POST /api/v1/sessions/:sessionId/xhs-login/start：校验目标链接并打开会话专属 Chrome 登录窗口。
  server.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/xhs-login/start",
    async (request, reply) => {
      await requireXhsLoginSession(request.params.sessionId);
      if (!validateXhsLoginStart(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "目标链接无效");
      const result = await xhsLogin.start(request.params.sessionId, request.body.targetUrl);
      recordAudit({ action: "xhs.login.started", sessionId: request.params.sessionId, requestId: request.id });
      return result;
    },
  );
  // POST /api/v1/sessions/:sessionId/xhs-login/confirm：复核目标页可读后确认会话授权。
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/xhs-login/confirm", async (request) => {
    await requireXhsLoginSession(request.params.sessionId);
    const result = await xhsLogin.confirm(request.params.sessionId);
    recordAudit({ action: "xhs.login.confirmed", sessionId: request.params.sessionId, requestId: request.id });
    return result;
  });
  // POST /api/v1/sessions/:sessionId/xhs-login/cancel：关闭待确认的 Chrome 登录窗口。
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/xhs-login/cancel", async (request) => {
    await requireXhsLoginSession(request.params.sessionId);
    await xhsLogin.cancel(request.params.sessionId);
    recordAudit({ action: "xhs.login.cancelled", sessionId: request.params.sessionId, requestId: request.id });
    return xhsLogin.status(request.params.sessionId);
  });
  // GET /api/v1/sessions/:sessionId/messages：分页读取会话消息。
  server.get<{ Params: { sessionId: string }; Querystring: { limit?: string; before?: string } }>(
    "/api/v1/sessions/:sessionId/messages",
    async (request, reply) => {
      if (!(await deps.db.getSession(request.params.sessionId)))
        return reply
          .code(404)
          .send({ code: "SESSION_NOT_FOUND", message: "会话不存在", requestId: request.id, retryable: false });
      const limit = queryNumber(request.query.limit, 50);
      if (limit === null || limit < 1 || limit > 100)
        return reply
          .code(400)
          .send({ code: "INVALID_LIMIT", message: "limit 必须为 1～100", requestId: request.id, retryable: false });
      return { items: await deps.db.listMessages(request.params.sessionId, limit, request.query.before ?? null) };
    },
  );
  // POST /api/v1/sessions/:sessionId/messages：原子受理新消息与排队 Run。
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/messages", async (request, reply) => {
    if (!deps.config.model)
      return reply
        .code(424)
        .send({ code: "MODEL_NOT_CONFIGURED", message: "请先配置文本模型", requestId: request.id, retryable: false });
    const operationKey = header(request, "idempotency-key");
    if (!operationKey)
      return reply.code(400).send({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "缺少 Idempotency-Key",
        requestId: request.id,
        retryable: false,
      });
    if (!validateMessage(request.body))
      return reply
        .code(400)
        .send({ code: "INVALID_INPUT", message: "消息参数无效", requestId: request.id, retryable: false });
    const body = request.body;
    const accepted = await sessions.acceptMessage(
      request.params.sessionId,
      body.content,
      body.clientTurnId,
      operationKey,
      body.expertRole,
      body.artifactIds,
      undefined,
      body.continueFromRunId,
    );
    if (accepted.event)
      recordAudit({
        action: "message.accepted",
        requestId: request.id,
        sessionId: request.params.sessionId,
        messageId: accepted.messageId,
        runId: accepted.runId,
      });
    // 202 只表示已持久化并进入队列，模型回复通过事件流异步到达。
    return reply.code(202).send({
      messageId: accepted.messageId,
      runId: accepted.runId,
      operationId: accepted.operationId,
      accepted: true,
    });
  });
  // GET /api/v1/sessions/:sessionId/events：按序号补拉持久化运行事件。
  server.get<{ Params: { sessionId: string }; Querystring: { afterSeq?: string } }>(
    "/api/v1/sessions/:sessionId/events",
    async (request, reply) => {
      const afterSeq = queryNumber(request.query.afterSeq, 0);
      if (afterSeq === null)
        return reply
          .code(400)
          .send({ code: "INVALID_CURSOR", message: "afterSeq 无效", requestId: request.id, retryable: false });
      return { items: await deps.db.listEvents(request.params.sessionId, afterSeq) };
    },
  );
  // GET /api/v1/runs/:runId：读取指定 Run 的持久状态。
  server.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", async (request, reply) => {
    const run = await deps.db.getRun(request.params.runId);
    if (!run)
      return reply
        .code(404)
        .send({ code: "RUN_NOT_FOUND", message: "Run 不存在", requestId: request.id, retryable: false });
    return run;
  });
  // 只在所属会话内读取主 Run 或其专家子任务的启动快照，不重建缺失历史。
  server.get<{ Params: { sessionId: string; runId: string } }>(
    "/api/v1/sessions/:sessionId/runs/:runId/prompt-snapshots",
    async (request, reply) => {
      const run = await deps.db.getRun(request.params.runId);
      if (!run || run.sessionId !== request.params.sessionId)
        return merchantInputError(request, reply, "RUN_NOT_FOUND", "本会话没有该运行记录", 404);
      const session = await deps.db.getSession(run.sessionId);
      if (!session || session.lifecycleStatus === "TRASHED")
        return merchantInputError(request, reply, "SESSION_NOT_FOUND", "会话不存在或已移入回收站", 404);
      const delegations = await deps.db.listDelegationsForParentRun(run.runId);
      const delegationId = (request.query as Record<string, unknown>).delegationId;
      if (delegationId !== undefined && (typeof delegationId !== "string" || !delegationId))
        return merchantInputError(request, reply, "INVALID_INPUT", "专家任务参数无效");
      const child = delegationId ? delegations.find((item) => item.delegationId === delegationId) : null;
      if (delegationId && !child) return merchantInputError(request, reply, "RUN_NOT_FOUND", "本轮没有该专家任务", 404);
      const snapshots = (
        await deps.files.readPromptSnapshots(child?.childSessionId ?? run.sessionId, child?.childRunId ?? run.runId)
      ).filter((item) => item.attempt <= (child?.attempt ?? run.attempt));
      const query = request.query as Record<string, unknown>;
      if (query.format === "markdown") {
        const attempt = queryNumber(query.attempt, 0);
        if (!attempt) return merchantInputError(request, reply, "INVALID_INPUT", "请选择有效的运行尝试");
        const snapshot = snapshots.find((item) => item.attempt === attempt);
        if (!snapshot) return merchantInputError(request, reply, "PROMPT_SNAPSHOT_NOT_FOUND", "该尝试未记录快照", 404);
        return reply
          .type("text/markdown; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="${snapshot.runId}-attempt-${snapshot.attempt}.md"`)
          .send(promptSnapshotMarkdown(snapshot));
      }
      return {
        snapshots,
        delegations: child
          ? []
          : delegations.map(({ delegationId, targetExpertId }) => ({ delegationId, targetExpertId })),
      };
    },
  );
  // GET /api/v1/runs/:runId/plan：只返回可公开的冻结 Run Plan 摘要。
  server.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/plan", async (request, reply) => {
    const run = await deps.db.getRun(request.params.runId);
    if (!run)
      return reply
        .code(404)
        .send({ code: "RUN_NOT_FOUND", message: "Run 不存在", requestId: request.id, retryable: false });
    const plan = await deps.db.getRunPlan(run.runId);
    if (!plan) return { schemaVersion: 0, legacy: true };
    return {
      schemaVersion: plan.schemaVersion,
      runId: plan.runId,
      planHash: plan.planHash,
      modelId: plan.model.modelId,
      adapterVersion: plan.runtime.adapterVersion,
      toolsetVersion: plan.runtime.toolsetVersion,
      systemPromptRevision: plan.instructions.revision,
      systemPromptHash: plan.instructions.sha256,
      toolIds: plan.policy.allowedToolIds,
      skills:
        plan.schemaVersion === 3 || plan.schemaVersion === 4 || plan.schemaVersion === 5 || plan.schemaVersion === 6
          ? plan.capabilities.skills.map(({ name, sha256 }) => ({ name, sha256 }))
          : [],
      expert:
        (plan.schemaVersion === 4 || plan.schemaVersion === 5 || plan.schemaVersion === 6) && plan.capabilities.expert
          ? {
              groupId: plan.capabilities.expert.groupId,
              role: plan.capabilities.expert.role,
              sharedSha256: plan.capabilities.expert.sharedSha256,
              promptSha256: plan.capabilities.expert.promptSha256,
            }
          : null,
      expertMethods:
        plan.schemaVersion === 4 || plan.schemaVersion === 5 || plan.schemaVersion === 6
          ? (plan.capabilities.expertMethods ?? []).map(({ role, promptSha256, sharedSha256 }) => ({
              role,
              promptSha256,
              sharedSha256,
            }))
          : [],
      expertGroup:
        plan.schemaVersion === 5 || plan.schemaVersion === 6
          ? {
              groupId: plan.capabilities.expertGroup.groupId,
              mainRole: plan.capabilities.expertGroup.mainRole,
              targets: [
                "writer",
                ...(plan.capabilities.expertGroup.visual ? ["visual"] : []),
                ...(plan.capabilities.expertGroup.reviewer ? ["reviewer"] : []),
              ],
              manifestSha256: plan.capabilities.expertGroup.manifestSha256,
              ...(plan.schemaVersion === 6 && { toolIdsByRole: plan.capabilities.expertGroup.toolIdsByRole }),
            }
          : null,
      mainAgent:
        plan.schemaVersion === 6
          ? {
              sharedSha256: plan.capabilities.mainAgent.sharedSha256,
              promptSha256: plan.capabilities.mainAgent.sha256,
            }
          : null,
      artifactCount: plan.policy.allowedArtifacts.length,
      merchantContext:
        plan.schemaVersion === 2
          ? { merchantId: plan.session.ownerId, snapshotId: plan.merchant.snapshotId, sha256: plan.merchant.sha256 }
          : (plan.schemaVersion === 3 ||
                plan.schemaVersion === 4 ||
                plan.schemaVersion === 5 ||
                plan.schemaVersion === 6) &&
              plan.merchant
            ? { merchantId: plan.session.ownerId, snapshotId: plan.merchant.snapshotId, sha256: plan.merchant.sha256 }
            : null,
    };
  });
  // GET /api/v1/runs/:runId/delegation：读取父 Run 的委派输入、状态和结果。
  server.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/delegation", async (request, reply) => {
    const run = await deps.db.getRun(request.params.runId);
    if (!run)
      return reply
        .code(404)
        .send({ code: "RUN_NOT_FOUND", message: "Run 不存在", requestId: request.id, retryable: false });
    return {
      delegation: await deps.db.getDelegationForParentRun(run.runId),
      delegations: await deps.db.listDelegationsForParentRun(run.runId),
    };
  });
  // 读取本会话压缩检查点，供长对话来源与恢复状态展示。
  server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/checkpoints", async (request, reply) => {
    const session = await deps.db.getSession(request.params.sessionId);
    if (!session) return merchantInputError(request, reply, "SESSION_NOT_FOUND", "会话不存在", 404);
    return { checkpoints: await deps.db.listContextCheckpoints(session.sessionId) };
  });
  // 查看专家任务的各次尝试和重启中断原因。
  server.get<{ Params: { delegationId: string } }>(
    "/api/v1/delegations/:delegationId/attempts",
    async (request, reply) => {
      const record = await deps.db.getDelegation(request.params.delegationId);
      if (!record) return merchantInputError(request, reply, "DELEGATION_NOT_FOUND", "专家任务不存在", 404);
      return { attempts: await deps.db.listDelegationAttempts(record.delegationId) };
    },
  );
  // 用户回答专家问题：追加版本化输入后，活动子任务继续或由重启后的父轮恢复。
  server.post<{ Params: { delegationId: string }; Body: { answer?: string } }>(
    "/api/v1/delegations/:delegationId/answer",
    async (request, reply) => {
      const record = await deps.db.getDelegation(request.params.delegationId);
      if (!record) return merchantInputError(request, reply, "DELEGATION_NOT_FOUND", "专家任务不存在", 404);
      const answer = request.body?.answer?.trim();
      if (!answer || answer.length > 4000)
        return merchantInputError(request, reply, "DELEGATION_ANSWER_INVALID", "回答需为 1 至 4000 字");
      try {
        return { delegation: await deps.taskManager.answerDelegation(record.delegationId, answer) };
      } catch (error) {
        return merchantInputError(
          request,
          reply,
          "DELEGATION_ANSWER_CONFLICT",
          error instanceof Error ? error.message : "专家任务状态已变化",
          409,
        );
      }
    },
  );
  // 用户调整仅投递给仍活动的子 Agent，版本化指令不会修改原任务单。
  server.post<{ Params: { delegationId: string }; Body: { instruction?: string } }>(
    "/api/v1/delegations/:delegationId/steer",
    async (request, reply) => {
      const record = await deps.db.getDelegation(request.params.delegationId);
      if (!record) return merchantInputError(request, reply, "DELEGATION_NOT_FOUND", "专家任务不存在", 404);
      const instruction = request.body?.instruction?.trim();
      if (!instruction || instruction.length > 2000)
        return merchantInputError(request, reply, "DELEGATION_STEER_INVALID", "调整指令需为 1 至 2000 字");
      try {
        await deps.taskManager.steerDelegation(record.delegationId, instruction);
        return { accepted: true };
      } catch (error) {
        return merchantInputError(
          request,
          reply,
          "DELEGATION_STEER_CONFLICT",
          error instanceof Error ? error.message : "专家任务状态已变化",
          409,
        );
      }
    },
  );
  // 用户终止一条子任务；已提交结果仍可查看。
  server.post<{ Params: { delegationId: string } }>(
    "/api/v1/delegations/:delegationId/cancel",
    async (request, reply) => {
      const record = await deps.db.getDelegation(request.params.delegationId);
      if (!record) return merchantInputError(request, reply, "DELEGATION_NOT_FOUND", "专家任务不存在", 404);
      return { delegation: await deps.taskManager.cancelDelegation(record.delegationId) };
    },
  );
  // POST /api/v1/runs/:runId/cancel：记录取消意图并通知运行中的 Agent。
  server.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/cancel", async (request, reply) => {
    if (!header(request, "idempotency-key"))
      return reply.code(400).send({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "缺少 Idempotency-Key",
        requestId: request.id,
        retryable: false,
      });
    const { run, changed } = await deps.taskManager.cancel(request.params.runId);
    if (changed)
      recordAudit({
        action: "run.cancel.requested",
        requestId: request.id,
        runId: run.runId,
        sessionId: run.sessionId,
      });
    return reply.code(run.status === "RUNNING" ? 202 : 200).send(run);
  });
  // GET /api/v1/operations/:operationId：查询幂等操作的受理或执行结果。
  server.get<{ Params: { operationId: string } }>("/api/v1/operations/:operationId", async (request, reply) => {
    const run = await deps.db.getRun(request.params.operationId);
    if (!run)
      return reply
        .code(404)
        .send({ code: "OPERATION_NOT_FOUND", message: "操作不存在", requestId: request.id, retryable: false });
    return { operationId: run.runId, status: run.status, errorCode: run.errorCode, errorMessage: run.errorMessage };
  });

  // 上传先落内容寻址 Blob，再把元数据和会话关联。
  // POST /api/v1/uploads：校验文件内容并写入受管 Blob 与附件记录。
  server.post<{ Querystring: { sessionId?: string } }>("/api/v1/uploads", async (request, reply) => {
    const sessionId = request.query.sessionId ?? "";
    if (!(await deps.db.getSession(sessionId)))
      return reply
        .code(404)
        .send({ code: "SESSION_NOT_FOUND", message: "会话不存在", requestId: request.id, retryable: false });
    const operationKey = header(request, "idempotency-key");
    const mime = header(request, "x-file-mime");
    const rawTitle = header(request, "x-file-name");
    const titleEncoding = header(request, "x-file-name-encoding");
    let title: string | null = rawTitle ?? null;
    if (titleEncoding) {
      try {
        title = titleEncoding === "uri" && rawTitle ? decodeURIComponent(rawTitle) : null;
      } catch {
        title = null;
      }
    }
    if (!operationKey || !mime || !MIME_TYPES.has(mime) || !title || !Buffer.isBuffer(request.body)) {
      return reply
        .code(400)
        .send({ code: "INVALID_UPLOAD", message: "上传信息无效", requestId: request.id, retryable: false });
    }
    const content = request.body as Buffer;
    if (content.length > 100 * 1024 * 1024)
      return reply
        .code(413)
        .send({ code: "FILE_TOO_LARGE", message: "单文件不能超过 100MB", requestId: request.id, retryable: false });
    if (!matchesMime(content, mime))
      return reply
        .code(400)
        .send({ code: "INVALID_MIME", message: "文件内容与类型不匹配", requestId: request.id, retryable: false });
    const blob = await deps.files.putBlob(content);
    const artifact = await deps.db.createArtifact(
      sessionId,
      deps.files.safeTitle(title),
      blob.hash,
      mime,
      blob.size,
      operationKey,
    );
    recordAudit({
      action: "artifact.upload.accepted",
      requestId: request.id,
      sessionId,
      artifactId: artifact.artifactId,
      blobHash: blob.hash,
      sizeBytes: blob.size,
    });
    return reply.code(201).send(artifact);
  });
  // GET /api/v1/sessions/:sessionId/artifacts：列出当前会话可见的附件元数据。
  server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/artifacts", async (request) => ({
    items: await deps.db.listArtifacts(request.params.sessionId),
  }));
  // GET /api/v1/artifacts/:artifactId/content：核验附件归属后读取受管 Blob 内容。
  server.get<{ Params: { artifactId: string } }>("/api/v1/artifacts/:artifactId/content", async (request, reply) => {
    const artifact = await deps.db.getArtifact(request.params.artifactId);
    if (artifact?.kind !== "upload")
      return reply
        .code(404)
        .send({ code: "ARTIFACT_NOT_FOUND", message: "产物不存在", requestId: request.id, retryable: false });
    const content = await deps.files.readBlob(artifact.blobHash);
    reply
      .type(artifact.mimeType)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.title)}`);
    return reply.send(content);
  });

  // 图片任务由用户显式确认费用后受理；相同幂等键只执行一次付费请求。
  server.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/generation-jobs/images",
    async (request, reply) => {
      if (!deps.config.image)
        return merchantInputError(
          request,
          reply,
          "IMAGE_PROVIDER_NOT_CONFIGURED",
          "请先在 Host 配置 ZHIBAN_SEEDREAM_API_KEY 或 ARK_API_KEY",
          424,
        );
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateImageJob(request.body) || !request.body.prompt.trim())
        return merchantInputError(request, reply, "INVALID_INPUT", "图片描述、尺寸、质量或费用确认无效");
      let prompt = request.body.prompt.trim();
      if (request.body.publication) {
        const target = request.body.publication;
        const detail = await deps.db.getContentDraft(request.params.sessionId, target.draftId);
        const revision = detail?.revisions.find((item) => item.revision === target.draftRevision);
        if (!revision) throw new Error("PUBLICATION_REVISION_CONFLICT");
        prompt = `${prompt}\n\n以下为本篇笔记第${revision.revision}版文案资料，只用已确认信息作图，不自行增加价格或服务承诺：\n${revision.title}\n${revision.body.slice(0, 4000)}`;
      }
      const job = await deps.db.createImageJob(
        request.params.sessionId,
        prompt,
        deps.config.image.modelId,
        request.body.size,
        request.body.quality,
        request.body.referenceArtifactId ?? null,
        key,
        request.body.publication,
      );
      deps.generation.enqueue(job);
      recordAudit({
        action: "generation.image.accepted",
        requestId: request.id,
        sessionId: job.sessionId,
        status: job.status,
        jobId: job.jobId,
      });
      return reply.code(202).send(job);
    },
  );
  // 会话内查询图片任务，恢复页面时可区分结果未知与真正成功。
  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/generation-jobs",
    async (request, reply) => {
      if (!(await deps.db.getSession(request.params.sessionId)))
        return merchantInputError(request, reply, "SESSION_NOT_FOUND", "会话不存在", 404);
      return { items: await deps.db.listGenerationJobs(request.params.sessionId) };
    },
  );
  server.get<{ Params: { sessionId: string; jobId: string } }>(
    "/api/v1/sessions/:sessionId/generation-jobs/:jobId",
    async (request, reply) => {
      const job = await deps.db.getGenerationJob(request.params.sessionId, request.params.jobId);
      return job ?? merchantInputError(request, reply, "GENERATION_JOB_NOT_FOUND", "素材任务不存在", 404);
    },
  );
  // 上传图和生成图均只通过带会话归属的受管文件入口预览/下载。
  server.get<{ Params: { sessionId: string; artifactId: string } }>(
    "/api/v1/sessions/:sessionId/images/:artifactId/content",
    async (request, reply) => {
      const artifact = await deps.db.getArtifact(request.params.artifactId);
      if (
        artifact?.sessionId !== request.params.sessionId ||
        artifact.status !== "READY" ||
        !["upload", "generated_image"].includes(artifact.kind ?? "") ||
        !["image/png", "image/jpeg", "image/webp"].includes(artifact.mimeType)
      )
        return merchantInputError(request, reply, "ARTIFACT_NOT_FOUND", "图片不存在", 404);
      const content = await deps.files.readBlob(artifact.blobHash);
      return reply
        .type(artifact.mimeType)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(artifact.title)}`)
        .send(content);
    },
  );

  server.get<{ Params: { merchantId: string }; Querystring: { sessionId?: string } }>(
    "/api/v1/merchants/:merchantId/topics",
    async (request) => ({ items: await deps.db.listTopics(request.params.merchantId, request.query.sessionId) }),
  );
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/topic-plans", async (request, reply) => {
    if (!deps.config.model) return merchantInputError(request, reply, "MODEL_NOT_CONFIGURED", "请先配置文本模型", 424);
    const key = header(request, "idempotency-key");
    if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
    if (!validateTopicPlan(request.body))
      return merchantInputError(request, reply, "INVALID_INPUT", "请填写选题目标或选择一份有效研究报告");
    const job = await deps.db.createTopicPlanningJob(
      request.params.sessionId,
      request.body,
      deps.config.model.modelId,
      key,
    );
    textGeneration.wake();
    recordAudit({
      action: "topic.plan.accepted",
      requestId: request.id,
      sessionId: request.params.sessionId,
      jobId: job.jobId,
    });
    return reply.code(202).send(job);
  });
  server.put<{ Params: { sessionId: string; topicId: string } }>(
    "/api/v1/sessions/:sessionId/topics/:topicId",
    async (request, reply) => {
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateTopicUpdate(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "选题内容或版本无效");
      return deps.db.updateTopic(request.params.sessionId, request.params.topicId, request.body, key);
    },
  );

  // 冻结文案简报和可选商品模板，复用 Agent Run 生成并自动登记草稿。
  server.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/generation-jobs/text",
    async (request, reply) => {
      if (!deps.config.model)
        return merchantInputError(request, reply, "MODEL_NOT_CONFIGURED", "请先配置文本模型", 424);
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (
        !validateTextJob(request.body) ||
        !request.body.title.trim() ||
        /[\r\n]/.test(request.body.title) ||
        !request.body.brief.trim() ||
        Boolean(request.body.targetDraftId) !== Boolean(request.body.expectedRevision) ||
        (request.body.targetDraftId && request.body.productEntryId)
      )
        return merchantInputError(request, reply, "INVALID_INPUT", "素材标题或目标无效");
      if (request.body.topicCreation?.imageArtifactIds.length && !deps.config.model.imageInput)
        return merchantInputError(
          request,
          reply,
          "TOPIC_IMAGE_UNAVAILABLE",
          "当前文本模型未启用图片输入，请移除图片参考或配置视觉模型",
          409,
        );
      const job = await deps.db.createTextGenerationJob(
        request.params.sessionId,
        request.body.title.trim(),
        request.body.brief.trim(),
        request.body.productEntryId ?? null,
        request.body.targetDraftId ?? null,
        request.body.expectedRevision ?? null,
        deps.config.model.modelId,
        key,
        request.body.topicCreation,
      );
      textGeneration.wake();
      recordAudit({
        action: "generation.text.accepted",
        requestId: request.id,
        sessionId: job.sessionId,
        jobId: job.jobId,
        status: job.status,
      });
      return reply.code(202).send(job);
    },
  );
  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/generation-jobs/text",
    async (request, reply) => {
      if (!(await deps.db.getSession(request.params.sessionId)))
        return merchantInputError(request, reply, "SESSION_NOT_FOUND", "会话不存在", 404);
      return { items: await deps.db.listTextGenerationJobs(request.params.sessionId) };
    },
  );

  // 素材草稿从成功回复显式提取，修订保留历史；只有用户审核命令会登记正式文件。
  server.get<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts",
    async (request, reply) => {
      if (!(await deps.db.getSession(request.params.sessionId)))
        return merchantInputError(request, reply, "SESSION_NOT_FOUND", "会话不存在", 404);
      return { items: await deps.db.listContentDrafts(request.params.sessionId) };
    },
  );
  server.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts",
    async (request, reply) => {
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateContentCreate(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "请选择助手回复并输入素材标题");
      const result = await deps.db.createContentDraft(
        request.params.sessionId,
        request.body.sourceMessageId,
        request.body.title,
        key,
      );
      return reply.code(201).send(result);
    },
  );
  server.get<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId",
    async (request, reply) => {
      const result = await deps.db.getContentDraft(request.params.sessionId, request.params.draftId);
      if (!result) return merchantInputError(request, reply, "CONTENT_DRAFT_NOT_FOUND", "素材草稿不存在", 404);
      return result;
    },
  );
  server.put<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId",
    async (request, reply) => {
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateContentRevise(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "素材标题、正文或版本无效");
      return deps.db.reviseContentDraft(
        request.params.sessionId,
        request.params.draftId,
        request.body.expectedRevision,
        request.body.title,
        request.body.body,
        key,
      );
    },
  );
  server.post<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId/approve",
    async (request, reply) => {
      const key = header(request, "idempotency-key");
      if (!key) return merchantInputError(request, reply, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key");
      if (!validateContentApprove(request.body))
        return merchantInputError(request, reply, "INVALID_INPUT", "审核版本无效");
      const detail = await deps.db.getContentDraft(request.params.sessionId, request.params.draftId);
      if (!detail) return merchantInputError(request, reply, "CONTENT_DRAFT_NOT_FOUND", "素材草稿不存在", 404);
      if (detail.draft.currentRevision !== request.body.expectedRevision)
        return merchantInputError(request, reply, "CONTENT_REVISION_CONFLICT", "素材草稿版本已变化", 409);
      const existing = detail.draft.artifactId ? await deps.db.getArtifact(detail.draft.artifactId) : null;
      const blob = existing
        ? { hash: existing.blobHash, size: existing.sizeBytes }
        : await deps.files.putBlob(renderContentMarkdown(detail.draft.title, detail.draft.body));
      return deps.db.approveContentDraft(
        request.params.sessionId,
        request.params.draftId,
        request.body.expectedRevision,
        blob.hash,
        blob.size,
        key,
      );
    },
  );
  server.get<{ Params: { sessionId: string; artifactId: string } }>(
    "/api/v1/sessions/:sessionId/content-artifacts/:artifactId/download",
    async (request, reply) => {
      const artifact = await deps.db.getArtifact(request.params.artifactId);
      if (
        artifact?.sessionId !== request.params.sessionId ||
        artifact.kind !== "content_markdown" ||
        artifact.status !== "READY"
      )
        return merchantInputError(request, reply, "ARTIFACT_NOT_FOUND", "素材产物不存在", 404);
      const content = await deps.files.readBlob(artifact.blobHash);
      return reply
        .type("text/markdown; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.title)}`)
        .send(content);
    },
  );

  registerPublicationRoutes(
    server,
    deps.db,
    deps.files,
    deps.config.model?.modelId ?? null,
    () => textGeneration.wake(),
    recordAudit,
    deps.config.model?.imageInput === true,
    deps.config.image?.modelId ?? null,
  );

  const webRoot = resolve("dist-web");
  await server.register(fastifyStatic, { root: webRoot, prefix: "/" });
  // 前端路由回退到 index.html；未知 API 始终返回 JSON 404。
  server.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/"))
      return reply
        .code(404)
        .send({ code: "NOT_FOUND", message: "接口不存在", requestId: request.id, retryable: false });
    if (request.headers.accept?.includes("text/html")) {
      reply.type("text/html");
      return reply.send(await readFile(resolve(webRoot, "index.html")));
    }
    return reply.code(404).send();
  });
  return server;
}

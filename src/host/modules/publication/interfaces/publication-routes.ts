import { createHash } from "node:crypto";
import AjvModule from "ajv/dist/2020.js";
import type { FastifyInstance } from "fastify";
import { type PublicationFields, publicationFieldsSchema } from "../../../../shared/publication.js";
import type { PublicationConversationInput } from "../../../../shared/publication-conversation.js";
import type { TaskExecutionLimits } from "../../../../shared/task-execution.js";
import type { AuditEntry } from "../../../infrastructure/audit/audit.js";
import type { FileStore } from "../../../infrastructure/files/files.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";
import { publicationHash } from "../infrastructure/publication-store.js";
import { renderPublicationZip } from "../infrastructure/publication-zip.js";

const ajv = new AjvModule.default();
const validateConversation = ajv.compile<PublicationConversationInput>({
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 2000 },
    rootJobId: { type: "string", minLength: 1, maxLength: 100 },
    draftId: { type: "string", minLength: 1, maxLength: 100 },
    draftRevision: { type: "integer", minimum: 1 },
    publicationRevision: { type: "integer", minimum: 0 },
  },
  dependentRequired: { draftId: ["draftRevision", "publicationRevision"] },
});
const validateImageApproval = ajv.compile<{
  approvalId: string;
  draftRevision: number;
  publicationRevision: number;
  costConfirmed: true;
}>({
  type: "object",
  additionalProperties: false,
  required: ["approvalId", "draftRevision", "publicationRevision", "costConfirmed"],
  properties: {
    approvalId: { type: "string", minLength: 1, maxLength: 100 },
    draftRevision: { type: "integer", minimum: 1 },
    publicationRevision: { type: "integer", minimum: 0 },
    costConfirmed: { const: true },
  },
});
const validateSave = ajv.compile<{ expectedRevision: number; fields: PublicationFields }>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "fields"],
  properties: { expectedRevision: { type: "integer", minimum: 0 }, fields: publicationFieldsSchema },
});
const validateExport = ajv.compile<{ draftRevision: number; publicationRevision: number; confirmed: true }>({
  type: "object",
  additionalProperties: false,
  required: ["draftRevision", "publicationRevision", "confirmed"],
  properties: {
    draftRevision: { type: "integer", minimum: 1 },
    publicationRevision: { type: "integer", minimum: 1 },
    confirmed: { const: true },
  },
});

const validatePlanRequest = ajv.compile<{
  draftRevision: number;
  publicationRevision: number;
  brief: string;
  imageCount?: number;
}>({
  type: "object",
  additionalProperties: false,
  required: ["draftRevision", "publicationRevision", "brief"],
  properties: {
    draftRevision: { type: "integer", minimum: 1 },
    publicationRevision: { type: "integer", minimum: 0 },
    brief: { type: "string", maxLength: 2000 },
    imageCount: { type: "integer", minimum: 1, maximum: 9 },
  },
});

const validateReviewRequest = ajv.compile<{ draftRevision: number; publicationRevision: number }>({
  type: "object",
  additionalProperties: false,
  required: ["draftRevision", "publicationRevision"],
  properties: { draftRevision: { type: "integer", minimum: 1 }, publicationRevision: { type: "integer", minimum: 1 } },
});

const validateBudgetResume = ajv.compile<{ expectedRevision: number; limits: TaskExecutionLimits }>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "limits"],
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["modelCalls", "toolCalls", "steps", "images", "summaryCalls", "activeMs"],
      properties: Object.fromEntries(
        ["modelCalls", "toolCalls", "steps", "images", "summaryCalls", "activeMs"].map((key) => [
          key,
          { type: "integer", minimum: 0 },
        ]),
      ),
    },
  },
});

/** 在既有同源配对保护下提供编排和整套确认导出，不执行任何平台发布。 */
export function registerPublicationRoutes(
  server: FastifyInstance,
  db: DbClient,
  files: FileStore,
  modelId: string | null,
  wake: () => void,
  recordAudit?: (entry: AuditEntry) => void,
  imageInput = false,
  imageModelId: string | null = null,
): void {
  server.post<{ Params: { sessionId: string; jobId: string } }>(
    "/api/v1/sessions/:sessionId/publication-conversations/:jobId/execution-control",
    async (request) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !validateBudgetResume(request.body)) throw new Error("TASK_BUDGET_LIMIT_INVALID");
      const control = await db.resumeTaskExecution(
        request.params.sessionId,
        request.params.jobId,
        request.body.expectedRevision,
        request.body.limits,
        key,
      );
      recordAudit?.({
        action: "task.budget.resumed",
        sessionId: request.params.sessionId,
        jobId: request.params.jobId,
        requestId: request.id,
      });
      wake();
      return control;
    },
  );
  server.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/publication-conversations",
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !validateConversation(request.body)) throw new Error("PUBLICATION_INPUT_INVALID");
      if (!modelId)
        return reply
          .code(424)
          .send({ code: "MODEL_NOT_CONFIGURED", message: "请先配置文本模型", retryable: false, requestId: request.id });
      const job = await db.createPublicationConversation(
        request.params.sessionId,
        request.body,
        modelId,
        imageModelId,
        key,
      );
      recordAudit?.({
        action: "publication.conversation.accepted",
        sessionId: request.params.sessionId,
        jobId: job.jobId,
        requestId: request.id,
      });
      wake();
      return reply.code(202).send(job);
    },
  );
  server.post<{ Params: { sessionId: string; jobId: string } }>(
    "/api/v1/sessions/:sessionId/publication-conversations/:jobId/approve-image",
    async (request, reply) => {
      if (!validateImageApproval(request.body)) throw new Error("PUBLICATION_APPROVAL_INVALID");
      const input = request.body;
      const job = await db.approvePublicationConversationImage(
        request.params.sessionId,
        request.params.jobId,
        input.approvalId,
        input.draftRevision,
        input.publicationRevision,
      );
      recordAudit?.({
        action: "publication.conversation.image.confirmed",
        sessionId: request.params.sessionId,
        jobId: job.jobId,
        requestId: request.id,
      });
      wake();
      return reply.code(202).send(job);
    },
  );
  server.get<{ Params: { sessionId: string }; Querystring: { draftId?: string; rootJobId?: string } }>(
    "/api/v1/sessions/:sessionId/task-context",
    async (request) => {
      const { draftId, rootJobId } = request.query;
      if (
        (!draftId && !rootJobId) ||
        [draftId, rootJobId].some(
          (value) => value !== undefined && (typeof value !== "string" || !value || value.length > 100),
        )
      )
        throw new Error("TASK_CONTEXT_SOURCE_INVALID");
      return db.getTaskContextView(request.params.sessionId, draftId, rootJobId);
    },
  );
  server.get<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId/publication/reviews",
    async (request) => db.getPublicationReviews(request.params.sessionId, request.params.draftId),
  );
  server.post<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId/publication/reviews",
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !validateReviewRequest(request.body)) throw Error("PUBLICATION_INPUT_INVALID");
      if (!modelId)
        return reply
          .code(424)
          .send({ code: "MODEL_NOT_CONFIGURED", message: "请先配置文本模型", retryable: false, requestId: request.id });
      const input = request.body;
      const job = await db.createPublicationReviewJob(
        request.params.sessionId,
        request.params.draftId,
        input.draftRevision,
        input.publicationRevision,
        modelId,
        imageInput,
        key,
      );
      recordAudit?.({
        action: "publication.review.accepted",
        requestId: request.id,
        sessionId: request.params.sessionId,
        draftId: request.params.draftId,
        jobId: job.jobId,
      });
      wake();
      return reply.code(202).send(job);
    },
  );
  server.post<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId/publication/plan",
    async (request, reply) => {
      const input = request.body;
      const key = request.headers["idempotency-key"];
      if (!validatePlanRequest(input) || typeof key !== "string") throw new Error("PUBLICATION_INPUT_INVALID");
      if (!modelId)
        return reply
          .code(424)
          .send({ code: "MODEL_NOT_CONFIGURED", message: "请先配置文本模型", retryable: false, requestId: request.id });
      const job = await db.createPublicationPlanningJob(
        request.params.sessionId,
        request.params.draftId,
        input.draftRevision,
        input.publicationRevision,
        input.brief,
        modelId,
        key,
        input.imageCount,
      );
      recordAudit?.({
        action: "publication.plan.accepted",
        requestId: request.id,
        sessionId: request.params.sessionId,
        draftId: request.params.draftId,
        jobId: job.jobId,
      });
      wake();
      return reply.code(202).send(job);
    },
  );
  server.get<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId/publication",
    async (request) => db.getPublication(request.params.sessionId, request.params.draftId),
  );
  server.put<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId/publication",
    async (request) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !validateSave(request.body)) throw new Error("PUBLICATION_INPUT_INVALID");
      const result = await db.savePublication(
        request.params.sessionId,
        request.params.draftId,
        request.body.expectedRevision,
        request.body.fields,
        key,
      );
      recordAudit?.({
        action: "publication.updated",
        requestId: request.id,
        sessionId: request.params.sessionId,
        draftId: request.params.draftId,
        status: `revision:${result.revision}`,
      });
      return result;
    },
  );
  server.post<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId/publication/exports",
    async (request, reply) => {
      if (!validateExport(request.body)) throw new Error("PUBLICATION_INPUT_INVALID");
      const { sessionId, draftId } = request.params;
      const { draftRevision, publicationRevision } = request.body;
      const snapshot = await db.getPublicationSnapshot(sessionId, draftId, draftRevision, publicationRevision);
      // 在所有图片实际读取并校验后才生成 ZIP，避免把元数据登记成功当成交付成功。
      const images = await Promise.all(snapshot.images.map((image) => readPublicationBlob(files, image.blobHash)));
      if (
        images.some(
          (bytes, index) =>
            bytes.length !== snapshot.images[index]?.sizeBytes ||
            publicationHashBytes(bytes) !== snapshot.images[index]?.blobHash,
        )
      )
        throw new Error("PUBLICATION_IMAGE_INVALID");
      const blob = await files.putBlob(renderPublicationZip(snapshot, images));
      const result = await db.completePublicationExport(
        sessionId,
        draftId,
        draftRevision,
        publicationRevision,
        publicationHash(snapshot),
        blob.hash,
        blob.size,
      );
      recordAudit?.({
        action: "publication.exported",
        requestId: request.id,
        sessionId,
        draftId,
        artifactId: result.artifactId,
        blobHash: blob.hash,
        sizeBytes: blob.size,
      });
      return reply.code(201).send(result);
    },
  );
  server.get<{ Params: { sessionId: string; artifactId: string } }>(
    "/api/v1/sessions/:sessionId/publications/:artifactId/download",
    async (request, reply) => {
      const artifact = await db.getArtifact(request.params.artifactId);
      if (
        artifact?.sessionId !== request.params.sessionId ||
        artifact.kind !== "publication_zip" ||
        artifact.status !== "READY"
      )
        throw new Error("PUBLICATION_NOT_FOUND");
      const bytes = await readPublicationBlob(files, artifact.blobHash);
      if (publicationHashBytes(bytes) !== artifact.blobHash || bytes.length !== artifact.sizeBytes)
        throw new Error("PUBLICATION_BLOB_INVALID");
      return reply
        .type("application/zip")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.title)}`)
        .send(bytes);
    },
  );
}

/** 文件丢失时返回可识别的交付错误，不把读取失败当成成功下载。 */
async function readPublicationBlob(files: FileStore, hash: string): Promise<Buffer> {
  try {
    return await files.readBlob(hash);
  } catch {
    throw new Error("PUBLICATION_BLOB_INVALID");
  }
}

/** 校验被引用的实际 Blob 字节，不能把 JSON 摘要用于文件完整性检查。 */
function publicationHashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

import { createHash } from "node:crypto";
import AjvModule from "ajv/dist/2020.js";
import type { FastifyInstance } from "fastify";
import type { MerchantMedia, PublicationRecordLink, WorkPlanFields } from "../../../../shared/workbench.js";
import type { AuditEntry } from "../../../infrastructure/audit/audit.js";
import type { FileStore } from "../../../infrastructure/files/files.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";

const ajv = new AjvModule.default();
const nullableId = { type: ["string", "null"], maxLength: 80 };
const validatePlan = ajv.compile<{ expectedRevision: number; fields: WorkPlanFields }>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "fields"],
  properties: {
    expectedRevision: { type: "integer", minimum: 0 },
    fields: {
      type: "object",
      additionalProperties: false,
      required: ["merchantId", "sessionId", "draftId", "title", "scheduledFor", "status", "note"],
      properties: {
        merchantId: { type: "string", minLength: 1, maxLength: 80 },
        sessionId: nullableId,
        draftId: nullableId,
        title: { type: "string", minLength: 1, maxLength: 120 },
        scheduledFor: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        status: { enum: ["TODO", "DONE", "CANCELLED"] },
        note: { type: "string", maxLength: 2000 },
      },
    },
  },
});
const validateMediaUpdate = ajv.compile<{ expectedRevision: number; status: MerchantMedia["status"] }>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "status"],
  properties: { expectedRevision: { type: "integer", minimum: 1 }, status: { enum: ["ACTIVE", "INACTIVE"] } },
});
const validateMediaImport = ajv.compile<{ mediaIds: string[] }>({
  type: "object",
  additionalProperties: false,
  required: ["mediaIds"],
  properties: {
    mediaIds: {
      type: "array",
      minItems: 1,
      maxItems: 9,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
});
const metric = { type: ["integer", "null"], minimum: 0, maximum: 1000000000 };
const validateRecord = ajv.compile<{
  expectedRevision: number;
  artifactId: string;
  url: string;
  publishedAt: string;
  note: string;
  metrics: PublicationRecordLink["metrics"];
}>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "artifactId", "url", "publishedAt", "note", "metrics"],
  properties: {
    expectedRevision: { type: "integer", minimum: 0 },
    artifactId: { type: "string", minLength: 1, maxLength: 80 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    publishedAt: { type: "string", minLength: 1, maxLength: 40 },
    note: { type: "string", maxLength: 2000 },
    metrics: {
      type: "object",
      additionalProperties: false,
      required: ["likes", "favorites", "comments"],
      properties: { likes: metric, favorites: metric, comments: metric },
    },
  },
});
const validateReconciliation = ajv.compile<{
  resolution: "NO_RESULT" | "ADOPT_IMAGE";
  artifactId: string | null;
  note: string;
  confirmed: true;
}>({
  type: "object",
  additionalProperties: false,
  required: ["resolution", "artifactId", "note", "confirmed"],
  properties: {
    resolution: { enum: ["NO_RESULT", "ADOPT_IMAGE"] },
    artifactId: nullableId,
    note: { type: "string", minLength: 5, maxLength: 2000 },
    confirmed: { const: true },
  },
});

/** 提供人工排期、素材维护和发布记录，外部状态只按实际回执或用户明确登记展示。 */
export function registerWorkbenchRoutes(
  server: FastifyInstance,
  db: DbClient,
  files: FileStore,
  isValidImage: (bytes: Buffer, mime: string) => boolean,
  recordAudit: (entry: AuditEntry) => void,
): void {
  server.get<{ Querystring: { from?: string; to?: string; merchantId?: string } }>(
    "/api/v1/workbench",
    async (request) => {
      const { from, to, merchantId } = request.query;
      if (
        !from ||
        !to ||
        !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
        !Number.isFinite(Date.parse(from)) ||
        !Number.isFinite(Date.parse(to)) ||
        to < from ||
        Date.parse(to) - Date.parse(from) > 366 * 86400000
      )
        throw Error("WORKBENCH_INPUT_INVALID");
      return db.getWorkbenchBoard(from, to, merchantId);
    },
  );
  server.put<{ Params: { planId: string } }>("/api/v1/work-plans/:planId", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !validatePlan(request.body) || request.params.planId.length > 80)
      throw Error("WORKBENCH_INPUT_INVALID");
    const input = request.body;
    const result = await db.saveWorkPlan(request.params.planId, input.expectedRevision, input.fields, key);
    recordAudit({
      action: "workbench.updated",
      requestId: request.id,
      merchantId: result.merchantId,
      status: `plan:${result.planId}:v${result.revision}`,
    });
    return reply.code(input.expectedRevision === 0 ? 201 : 200).send(result);
  });
  server.get<{ Params: { merchantId: string }; Querystring: { productEntryId?: string } }>(
    "/api/v1/merchants/:merchantId/media",
    async (request) => ({ items: await db.listMerchantMedia(request.params.merchantId, request.query.productEntryId) }),
  );
  server.post<{ Params: { merchantId: string }; Querystring: { title?: string; productEntryId?: string } }>(
    "/api/v1/merchants/:merchantId/media",
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      const mime = typeof request.headers["x-file-type"] === "string" ? request.headers["x-file-type"] : "";
      if (
        typeof key !== "string" ||
        !Buffer.isBuffer(request.body) ||
        !["image/png", "image/jpeg", "image/webp"].includes(mime) ||
        !isValidImage(request.body, mime) ||
        !request.query.title
      )
        throw Error("WORKBENCH_INPUT_INVALID");
      const blob = await files.putBlob(request.body);
      const result = await db.createMerchantMedia(
        request.params.merchantId,
        request.query.productEntryId ?? null,
        request.query.title,
        blob.hash,
        mime,
        blob.size,
        key,
      );
      recordAudit({
        action: "workbench.updated",
        requestId: request.id,
        merchantId: result.merchantId,
        blobHash: blob.hash,
        sizeBytes: blob.size,
        status: `media:${result.mediaId}`,
      });
      return reply.code(201).send(result);
    },
  );
  server.put<{ Params: { merchantId: string; mediaId: string } }>(
    "/api/v1/merchants/:merchantId/media/:mediaId",
    async (request) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !validateMediaUpdate(request.body)) throw Error("WORKBENCH_INPUT_INVALID");
      const result = await db.updateMerchantMedia(
        request.params.merchantId,
        request.params.mediaId,
        request.body.expectedRevision,
        request.body.status,
        key,
      );
      recordAudit({
        action: "workbench.updated",
        requestId: request.id,
        merchantId: result.merchantId,
        status: `media:${result.mediaId}:v${result.revision}`,
      });
      return result;
    },
  );
  server.get<{ Params: { merchantId: string; mediaId: string } }>(
    "/api/v1/merchants/:merchantId/media/:mediaId/content",
    async (request, reply) => {
      const item = (await db.listMerchantMedia(request.params.merchantId)).find(
        (item) => item.mediaId === request.params.mediaId,
      );
      if (item?.status !== "ACTIVE") throw Error("WORKBENCH_NOT_FOUND");
      const bytes = await files.readBlob(item.blobHash);
      if (bytes.length !== item.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== item.blobHash)
        throw Error("CONTENT_BLOB_INVALID");
      return reply
        .type(item.mimeType)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .send(bytes);
    },
  );
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/media", async (request) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !validateMediaImport(request.body)) throw Error("WORKBENCH_INPUT_INVALID");
    const result = await db.importMerchantMedia(request.params.sessionId, request.body.mediaIds, key);
    recordAudit({
      action: "workbench.updated",
      requestId: request.id,
      sessionId: request.params.sessionId,
      status: `media.imported:${result.length}`,
    });
    return { items: result };
  });
  server.get<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId/published",
    async (request) => db.getPublicationRecord(request.params.sessionId, request.params.draftId),
  );
  server.put<{ Params: { sessionId: string; draftId: string } }>(
    "/api/v1/sessions/:sessionId/content-drafts/:draftId/published",
    async (request) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !validateRecord(request.body)) throw Error("WORKBENCH_INPUT_INVALID");
      const input = request.body;
      const result = await db.savePublicationRecord(
        request.params.sessionId,
        request.params.draftId,
        input.artifactId,
        input.url,
        input.publishedAt,
        input.note,
        input.metrics,
        input.expectedRevision,
        key,
      );
      recordAudit({
        action: "workbench.updated",
        requestId: request.id,
        sessionId: request.params.sessionId,
        draftId: request.params.draftId,
        artifactId: input.artifactId,
        status: "publication.user-recorded",
      });
      return result;
    },
  );
  server.post<{ Params: { sessionId: string; jobId: string } }>(
    "/api/v1/sessions/:sessionId/generation-jobs/:jobId/reconcile",
    async (request) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !validateReconciliation(request.body)) throw Error("WORKBENCH_INPUT_INVALID");
      const input = request.body;
      if (input.resolution === "ADOPT_IMAGE" && input.artifactId) {
        const artifact = await db.getArtifact(input.artifactId);
        if (artifact?.sessionId !== request.params.sessionId) throw Error("WORKBENCH_SOURCE_INVALID");
        const bytes = await files.readBlob(artifact.blobHash);
        if (
          bytes.length !== artifact.sizeBytes ||
          createHash("sha256").update(bytes).digest("hex") !== artifact.blobHash
        )
          throw Error("CONTENT_BLOB_INVALID");
      }
      const result = await db.reconcileImageJob(
        request.params.sessionId,
        request.params.jobId,
        input.resolution,
        input.artifactId,
        input.note,
        key,
      );
      recordAudit({
        action: "workbench.updated",
        requestId: request.id,
        sessionId: request.params.sessionId,
        jobId: request.params.jobId,
        artifactId: input.artifactId ?? undefined,
        status: `image.reconciled:${input.resolution}`,
      });
      return result;
    },
  );
}

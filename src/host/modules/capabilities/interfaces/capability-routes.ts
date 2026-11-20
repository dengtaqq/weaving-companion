import AjvModule from "ajv/dist/2020.js";
import type { FastifyInstance } from "fastify";
import {
  CAPABILITY_ROLES,
  type CapabilityRole,
  type ExpertConfiguration,
  type SkillDetail,
  type SkillPackageFile,
  type TeamConfiguration,
} from "../../../../shared/capabilities.js";
import type { AuditEntry } from "../../../infrastructure/audit/audit.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";
import { resolveCapabilities } from "../application/capability-registry.js";
import { parseSkillPackage, skillPackageHash } from "../application/skill-package.js";
import { loadSkillAssets } from "../infrastructure/skill-assets.js";

const ajv = new AjvModule.default();
const filesSchema = {
  type: "array",
  minItems: 1,
  maxItems: 40,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: { path: { type: "string", maxLength: 240 }, content: { type: "string", maxLength: 32768 } },
  },
};
const rolesSchema = { type: "array", maxItems: 4, uniqueItems: true, items: { enum: CAPABILITY_ROLES } };
const validatePreview = ajv.compile<{ files: SkillPackageFile[] }>({
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: { files: filesSchema },
});
const validateInstall = ajv.compile<{
  files: SkillPackageFile[];
  expectedRevision: number;
  enabled: boolean;
  roles: CapabilityRole[];
}>({
  type: "object",
  additionalProperties: false,
  required: ["files", "expectedRevision", "enabled", "roles"],
  properties: {
    files: filesSchema,
    expectedRevision: { type: "integer", minimum: 0 },
    enabled: { type: "boolean" },
    roles: rolesSchema,
  },
});
const validateSkillUpdate = ajv.compile<{
  expectedRevision: number;
  enabled: boolean;
  roles: CapabilityRole[];
  rollbackRevision: number | null;
}>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "enabled", "roles", "rollbackRevision"],
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    enabled: { type: "boolean" },
    roles: rolesSchema,
    rollbackRevision: { type: ["integer", "null"], minimum: 1 },
  },
});
const validateExpert = ajv.compile<{
  expectedRevision: number;
  fields: Pick<ExpertConfiguration, "name" | "description" | "instructions" | "skillNames">;
}>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "fields"],
  properties: {
    expectedRevision: { type: "integer", minimum: 0 },
    fields: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description", "instructions", "skillNames"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: "string", maxLength: 2000 },
        instructions: { type: "string", minLength: 1, maxLength: 32768 },
        skillNames: { type: "array", maxItems: 60, uniqueItems: true, items: { type: "string", maxLength: 80 } },
      },
    },
  },
});
const validateTeam = ajv.compile<{
  expectedRevision: number;
  fields: Pick<TeamConfiguration, "name" | "description" | "enabledRoles">;
}>({
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "fields"],
  properties: {
    expectedRevision: { type: "integer", minimum: 0 },
    fields: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description", "enabledRoles"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: "string", maxLength: 2000 },
        enabledRoles: {
          type: "array",
          uniqueItems: true,
          maxItems: 3,
          items: { enum: ["writer", "visual", "reviewer", "researcher"] },
        },
      },
    },
  },
});

/** 提供真实能力安装和职责配置；资产更新只对之后受理的 Run 生效。 */
export function registerCapabilityRoutes(
  server: FastifyInstance,
  db: DbClient,
  recordAudit: (entry: AuditEntry) => void,
): void {
  server.get("/api/v1/capabilities", async () => (await resolveCapabilities(db)).catalog);
  server.post("/api/v1/capabilities/skills/preview", async (request) => {
    if (!validatePreview(request.body)) throw new Error("CAPABILITY_PACKAGE_INVALID");
    const parsed = parseSkillPackage(request.body.files);
    const registry = await resolveCapabilities(db);
    const old = registry.catalog.skills.find((item) => item.name === parsed.snapshot.name);
    if (old?.source === "BUILTIN") throw new Error("CAPABILITY_BUILTIN_READONLY");
    return {
      name: parsed.snapshot.name,
      description: parsed.snapshot.description,
      content: parsed.snapshot.content,
      files: parsed.files.map((file) => ({ path: file.path, sizeBytes: Buffer.byteLength(file.content) })),
      packageHash: parsed.packageHash,
      expectedRevision: old?.revision ?? 0,
    };
  });
  server.post("/api/v1/capabilities/skills", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !validateInstall(request.body)) throw new Error("CAPABILITY_INPUT_INVALID");
    const builtin = await loadSkillAssets();
    const input = request.body;
    const skill = await db.installSkillPackage(
      input.files,
      input.expectedRevision,
      input.enabled,
      input.roles,
      builtin.map((item) => item.name),
      key,
    );
    recordAudit({
      action: "capability.updated",
      requestId: request.id,
      status: `skill:${skill.name}:v${skill.revision}`,
    });
    return reply.code(201).send(skill);
  });
  server.get<{ Params: { name: string } }>("/api/v1/capabilities/skills/:name", async (request) => {
    const { catalog } = await resolveCapabilities(db);
    const item = catalog.skills.find((skill) => skill.name === request.params.name);
    if (!item) throw new Error("CAPABILITY_NOT_FOUND");
    if (item.source === "UPLOADED") {
      const saved = await db.getInstalledSkill(item.name);
      return { item, files: saved.current?.files ?? [], versions: saved.versions } satisfies SkillDetail;
    }
    const skill = (await loadSkillAssets()).find((skill) => skill.name === item.name);
    if (!skill) throw new Error("CAPABILITY_NOT_FOUND");
    const files = [
      {
        path: "SKILL.md",
        content: `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}`,
      },
      ...skill.references.map(({ path, content }) => ({ path, content })),
    ];
    return {
      item,
      files,
      versions: [{ revision: 1, packageHash: skillPackageHash(files), createdAt: "" }],
    } satisfies SkillDetail;
  });
  server.put<{ Params: { name: string } }>("/api/v1/capabilities/skills/:name", async (request) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !validateSkillUpdate(request.body)) throw new Error("CAPABILITY_INPUT_INVALID");
    const input = request.body;
    const skill = await db.updateInstalledSkill(
      request.params.name,
      input.expectedRevision,
      input.enabled,
      input.roles,
      input.rollbackRevision,
      key,
    );
    recordAudit({
      action: "capability.updated",
      requestId: request.id,
      status: `skill:${skill.name}:v${skill.revision}`,
    });
    return skill;
  });
  server.put<{ Params: { role: string } }>("/api/v1/capabilities/experts/:role", async (request) => {
    const key = request.headers["idempotency-key"];
    const role = request.params.role as CapabilityRole;
    if (!CAPABILITY_ROLES.includes(role) || typeof key !== "string" || !validateExpert(request.body))
      throw new Error("CAPABILITY_INPUT_INVALID");
    const { catalog } = await resolveCapabilities(db);
    const input = request.body;
    if (input.fields.skillNames.some((name) => !catalog.skills.some((skill) => skill.name === name)))
      throw new Error("CAPABILITY_INPUT_INVALID");
    const result = await db.saveExpertConfiguration(
      { ...input.fields, role, revision: input.expectedRevision, updatedAt: "" },
      input.expectedRevision,
      key,
    );
    recordAudit({ action: "capability.updated", requestId: request.id, status: `expert:${role}:v${result.revision}` });
    return result;
  });
  server.put("/api/v1/capabilities/team", async (request) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !validateTeam(request.body)) throw new Error("CAPABILITY_INPUT_INVALID");
    const input = request.body;
    const result = await db.saveTeamConfiguration(
      { ...input.fields, groupId: "merchant-content-team", revision: input.expectedRevision, updatedAt: "" },
      input.expectedRevision,
      key,
    );
    recordAudit({ action: "capability.updated", requestId: request.id, status: `team:v${result.revision}` });
    return result;
  });
}

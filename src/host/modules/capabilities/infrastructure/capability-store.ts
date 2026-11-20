import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CAPABILITY_ROLES,
  type CapabilityRole,
  type CapabilityState,
  type ExpertConfiguration,
  type StoredSkillVersion,
  type TeamConfiguration,
} from "../../../../shared/capabilities.js";
import { parseSkillPackage } from "../application/skill-package.js";

type Row = Record<string, unknown>;

/** 管理上传方法与专家配置的不可变版本；文件包在同一 SQLite 事务中原子安装。 */
export function createCapabilityOperations(db: DatabaseSync, transaction: <T>(operation: () => T) => T) {
  /** 读取已安装文件的当前版本，保留旧版供历史任务与回滚使用。 */
  function readSkill(name: string): StoredSkillVersion | null {
    const row = db
      .prepare(
        "SELECT s.*, v.body_json FROM capability_skill s JOIN capability_skill_revision v ON v.name=s.name AND v.revision=s.revision WHERE s.name=?",
      )
      .get(name) as Row | undefined;
    return row
      ? {
          ...JSON.parse(String(row.body_json)),
          revision: Number(row.revision),
          enabled: Boolean(row.enabled),
          roles: JSON.parse(String(row.roles_json)),
          updatedAt: String(row.updated_at),
        }
      : null;
  }
  /** 读取某个配置版本，缺省时由运行装配回退到内置资产。 */
  function readConfiguration<T>(id: string): T | null {
    const row = db.prepare("SELECT body_json FROM capability_configuration WHERE configuration_id=?").get(id) as
      | Row
      | undefined;
    return row ? (JSON.parse(String(row.body_json)) as T) : null;
  }
  /** 先匹配幂等结果，再执行版本校验，避免响应丢失时重复安装。 */
  function mutation<T>(key: string, input: unknown, execute: () => T, now: string): T {
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return transaction(() => {
      const old = db
        .prepare("SELECT kind,request_hash,result_json FROM api_operation WHERE operation_key=?")
        .get(key) as Row | undefined;
      if (old) {
        if (old.kind !== "capability.write" || old.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
        return JSON.parse(String(old.result_json)) as T;
      }
      const result = execute();
      db.prepare(
        "INSERT INTO api_operation(operation_key,kind,request_hash,result_json,created_at) VALUES (?,'capability.write',?,?,?)",
      ).run(key, hash, JSON.stringify(result), now);
      return result;
    });
  }
  /** 配置的当前行与历史修订一起提交，角色更新不改历史 Run。 */
  function writeConfiguration<T extends { revision: number }>(
    id: string,
    kind: "EXPERT" | "TEAM",
    value: T,
    now: string,
  ): T {
    const body = JSON.stringify(value);
    db.prepare(
      "INSERT INTO capability_configuration(configuration_id,kind,revision,body_json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(configuration_id) DO UPDATE SET revision=excluded.revision,body_json=excluded.body_json,updated_at=excluded.updated_at",
    ).run(id, kind, value.revision, body, now);
    db.prepare(
      "INSERT INTO capability_configuration_revision(configuration_id,revision,body_json,created_at) VALUES (?,?,?,?)",
    ).run(id, value.revision, body, now);
    return value;
  }
  /** 将完整包发布成新版本；即使回滚也追加版本，不改变已冻结内容。 */
  function writeSkill(
    current: StoredSkillVersion | null,
    fields: Omit<StoredSkillVersion, "revision" | "createdAt" | "updatedAt">,
    now: string,
  ): StoredSkillVersion {
    const installed = db
      .prepare("SELECT name FROM capability_skill WHERE enabled=1 AND name!=?")
      .all(fields.name) as Row[];
    const bytes =
      installed.reduce(
        (sum, row) => sum + Buffer.byteLength(JSON.stringify(readSkill(String(row.name))?.files ?? [])),
        0,
      ) + (fields.enabled ? Buffer.byteLength(JSON.stringify(fields.files)) : 0);
    if (bytes > 524288) throw new Error("CAPABILITY_LIMIT_EXCEEDED");
    const result = {
      ...fields,
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    db.prepare(
      "INSERT INTO capability_skill(name,revision,enabled,roles_json,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,roles_json=excluded.roles_json,updated_at=excluded.updated_at",
    ).run(result.name, result.revision, result.enabled ? 1 : 0, JSON.stringify(result.roles), result.createdAt, now);
    db.prepare("INSERT INTO capability_skill_revision(name,revision,body_json,created_at) VALUES (?,?,?,?)").run(
      result.name,
      result.revision,
      JSON.stringify(result),
      now,
    );
    return result;
  }
  return {
    /** 返回全局单用户配置；具体角色和文件仍由装配器校验。 */
    getCapabilityState: (): CapabilityState => ({
      skills: (db.prepare("SELECT name FROM capability_skill ORDER BY name").all() as Row[]).map(
        (row) => readSkill(String(row.name)) as StoredSkillVersion,
      ),
      experts: CAPABILITY_ROLES.flatMap((role) => {
        const config = readConfiguration<ExpertConfiguration>(`expert:${role}`);
        return config ? [config] : [];
      }),
      team: readConfiguration<TeamConfiguration>("team:merchant-content-team"),
    }),
    /** 安装/更新用户上传包，禁止与内置同名，旧版本和启停状态均可追溯。 */
    installSkillPackage: (
      files: unknown,
      expectedRevision: number,
      enabled: boolean,
      roles: CapabilityRole[],
      builtinNames: string[],
      key: string,
      now: string,
    ): StoredSkillVersion =>
      mutation(
        key,
        { files, expectedRevision, enabled, roles },
        () => {
          const parsed = parseSkillPackage(files);
          if (builtinNames.includes(parsed.snapshot.name)) throw new Error("CAPABILITY_BUILTIN_READONLY");
          if (!roles.every((role) => CAPABILITY_ROLES.includes(role)) || new Set(roles).size !== roles.length)
            throw new Error("CAPABILITY_INPUT_INVALID");
          const current = readSkill(parsed.snapshot.name);
          if ((current?.revision ?? 0) !== expectedRevision) throw new Error("CAPABILITY_REVISION_CONFLICT");
          if (!current && Number((db.prepare("SELECT count(*) AS n FROM capability_skill").get() as Row).n) >= 50)
            throw new Error("CAPABILITY_LIMIT_EXCEEDED");
          const result = writeSkill(current, { ...parsed, name: parsed.snapshot.name, enabled, roles }, now);
          // 上传时显式选择的关联应同时进入已有角色配置，避免“安装成功但专家看不到”。
          for (const role of roles) {
            const config = readConfiguration<ExpertConfiguration>(`expert:${role}`);
            if (config && !config.skillNames.includes(result.name))
              writeConfiguration(
                `expert:${role}`,
                "EXPERT",
                {
                  ...config,
                  skillNames: [...config.skillNames, result.name],
                  revision: config.revision + 1,
                  updatedAt: now,
                },
                now,
              );
          }
          return result;
        },
        now,
      ),
    /** 启停、修改关联或回滚文件都产生新的不可变版本。 */
    updateInstalledSkill: (
      name: string,
      expectedRevision: number,
      enabled: boolean,
      roles: CapabilityRole[],
      rollbackRevision: number | null,
      key: string,
      now: string,
    ): StoredSkillVersion =>
      mutation(
        key,
        { name, expectedRevision, enabled, roles, rollbackRevision },
        () => {
          const current = readSkill(name);
          if (!current) throw new Error("CAPABILITY_NOT_FOUND");
          if (current.revision !== expectedRevision) throw new Error("CAPABILITY_REVISION_CONFLICT");
          if (!roles.every((role) => CAPABILITY_ROLES.includes(role)) || new Set(roles).size !== roles.length)
            throw new Error("CAPABILITY_INPUT_INVALID");
          const row = rollbackRevision
            ? (db
                .prepare("SELECT body_json FROM capability_skill_revision WHERE name=? AND revision=?")
                .get(name, rollbackRevision) as Row | undefined)
            : null;
          if (rollbackRevision && !row) throw new Error("CAPABILITY_NOT_FOUND");
          const source = row ? (JSON.parse(String(row.body_json)) as StoredSkillVersion) : current;
          const result = writeSkill(
            current,
            { name, enabled, roles, snapshot: source.snapshot, files: source.files, packageHash: source.packageHash },
            now,
          );
          for (const role of roles) {
            const config = readConfiguration<ExpertConfiguration>(`expert:${role}`);
            if (config && !config.skillNames.includes(name))
              writeConfiguration(
                `expert:${role}`,
                "EXPERT",
                { ...config, skillNames: [...config.skillNames, name], revision: config.revision + 1, updatedAt: now },
                now,
              );
          }
          return result;
        },
        now,
      ),
    /** 读取文件与历史；内置文件详情由固定资产目录另行提供。 */
    getInstalledSkill: (name: string) => ({
      current: readSkill(name),
      versions: (
        db
          .prepare(
            "SELECT revision,body_json,created_at FROM capability_skill_revision WHERE name=? ORDER BY revision DESC",
          )
          .all(name) as Row[]
      ).map((row) => ({
        revision: Number(row.revision),
        packageHash: (JSON.parse(String(row.body_json)) as StoredSkillVersion).packageHash,
        createdAt: String(row.created_at),
      })),
    }),
    /** 保存已校验的角色职责与方法选集；工具授权不来自配置。 */
    saveExpertConfiguration: (
      input: ExpertConfiguration,
      expectedRevision: number,
      key: string,
      now: string,
    ): ExpertConfiguration =>
      mutation(
        key,
        { input, expectedRevision },
        () => {
          if (
            !CAPABILITY_ROLES.includes(input.role) ||
            !input.name.trim() ||
            input.name.length > 80 ||
            input.description.length > 2000 ||
            !input.instructions.trim() ||
            Buffer.byteLength(input.instructions) > 32768 ||
            new Set(input.skillNames).size !== input.skillNames.length ||
            input.skillNames.length > 60
          )
            throw new Error("CAPABILITY_INPUT_INVALID");
          const id = `expert:${input.role}`;
          const current = readConfiguration<ExpertConfiguration>(id);
          if ((current?.revision ?? 0) !== expectedRevision) throw new Error("CAPABILITY_REVISION_CONFLICT");
          return writeConfiguration(id, "EXPERT", { ...input, revision: expectedRevision + 1, updatedAt: now }, now);
        },
        now,
      ),
    /** 保存专家团展示信息和启用成员，停用由委派入口复核。 */
    saveTeamConfiguration: (
      input: TeamConfiguration,
      expectedRevision: number,
      key: string,
      now: string,
    ): TeamConfiguration =>
      mutation(
        key,
        { input, expectedRevision },
        () => {
          if (
            input.groupId !== "merchant-content-team" ||
            !input.name.trim() ||
            input.name.length > 80 ||
            input.description.length > 2000 ||
            !input.enabledRoles.every((role) => ["writer", "visual", "reviewer", "researcher"].includes(role)) ||
            new Set(input.enabledRoles).size !== input.enabledRoles.length
          )
            throw new Error("CAPABILITY_INPUT_INVALID");
          const current = readConfiguration<TeamConfiguration>("team:merchant-content-team");
          if ((current?.revision ?? 0) !== expectedRevision) throw new Error("CAPABILITY_REVISION_CONFLICT");
          return writeConfiguration(
            "team:merchant-content-team",
            "TEAM",
            { ...input, revision: expectedRevision + 1, updatedAt: now },
            now,
          );
        },
        now,
      ),
  };
}

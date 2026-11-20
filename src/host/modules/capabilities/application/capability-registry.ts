import { createHash } from "node:crypto";
import {
  CAPABILITY_ROLES,
  type CapabilityCatalog,
  type CapabilityRole,
  type ExpertConfiguration,
  type SkillCatalogItem,
  type TeamConfiguration,
} from "../../../../shared/capabilities.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";
import {
  type ExpertAssetSnapshot,
  loadExpertGroupV2Asset,
  loadMainAgentAsset,
} from "../infrastructure/expert-assets.js";
import { loadSkillAssets } from "../infrastructure/skill-assets.js";

const names: Record<CapabilityRole, string> = {
  main: "织伴基础助手",
  writer: "内容写作专家",
  visual: "视觉制作专家",
  reviewer: "稿件审核专家",
  researcher: "资料研究专家",
};
const descriptions: Record<CapabilityRole, string> = {
  main: "理解目标、统筹正式写作、视觉规划和审核任务，并基于真实回执完成交付。",
  writer: "围绕选题创作文案、按反馈改稿，保留已确认事实。",
  visual: "规划封面、内页与逐图修改要求，检查图文表达。",
  reviewer: "核对当前版本与事实来源，列出必须修改项和可选建议。",
  researcher: "读取获准资料、采集公开证据，整理研究假设、尝试路径和未解决问题。",
};

/** 汇合内置资产和用户版本，所有内容在消息受理时一次性冻结。 */
export async function resolveCapabilities(store: Pick<DbClient, "getCapabilityState">) {
  const [builtin, group, main, state] = await Promise.all([
    loadSkillAssets(),
    loadExpertGroupV2Asset(),
    loadMainAgentAsset(),
    store.getCapabilityState(),
  ]);
  if (!group.researcher) throw new Error("EXPERT_ASSET_INVALID");
  const roleAssets = { ...group, researcher: group.researcher };
  const items: SkillCatalogItem[] = builtin.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: "BUILTIN",
    revision: 1,
    enabled: true,
    roles: [...CAPABILITY_ROLES],
    sha256: skill.sha256,
    fileCount: skill.references.length + 1,
    updatedAt: "",
  }));
  for (const skill of state.skills) {
    if (builtin.some((item) => item.name === skill.name)) throw new Error("CAPABILITY_BUILTIN_READONLY");
    items.push({
      name: skill.name,
      description: skill.snapshot.description,
      source: "UPLOADED",
      revision: skill.revision,
      enabled: skill.enabled,
      roles: skill.roles,
      sha256: skill.snapshot.sha256,
      fileCount: skill.files.length,
      updatedAt: skill.updatedAt,
    });
  }
  const snapshots = [...builtin, ...state.skills.filter((skill) => skill.enabled).map((skill) => skill.snapshot)];
  const configs: ExpertConfiguration[] = CAPABILITY_ROLES.map(
    (role) =>
      state.experts.find((expert) => expert.role === role) ?? {
        role,
        revision: 0,
        name: names[role],
        description: descriptions[role],
        instructions: role === "main" ? main.prompt : roleAssets[role].prompt,
        skillNames: items.filter((item) => item.roles.includes(role)).map((item) => item.name),
        updatedAt: "",
      },
  );
  /** 每个角色只装配其关联且启用的方法，禁用方法不进入新任务快照。 */
  function roleSkills(role: CapabilityRole) {
    const config = configs.find((item) => item.role === role) as ExpertConfiguration;
    return snapshots.filter(
      (skill) =>
        config.skillNames.includes(skill.name) &&
        items.some((item) => item.name === skill.name && item.enabled && item.roles.includes(role)),
    );
  }
  const team: TeamConfiguration = state.team ?? {
    groupId: "merchant-content-team",
    revision: 0,
    name: "商家内容专家团",
    description: "由主助手统筹，写作、视觉规划与审核专家承担对应正式步骤。",
    enabledRoles: ["writer", "visual", "reviewer", "researcher"],
    updatedAt: "",
  };
  const mainConfig = configs.find((item) => item.role === "main") as ExpertConfiguration;
  const mainPrompt = `${mainConfig.instructions}\n\n本轮已启用团队成员：${team.enabledRoles.map((role) => names[role]).join("、") || "无；仅处理普通解释与建议，正式步骤需启用对应专家"}。仅可使用本轮冻结的工具与方法。`;
  /** 角色职责可编辑，公共约束与工具权限仍继承内置 Host 资产。 */
  function configuredExpert(role: Exclude<CapabilityRole, "main">): ExpertAssetSnapshot {
    const config = configs.find((item) => item.role === role) as ExpertConfiguration;
    return {
      ...roleAssets[role],
      prompt: config.instructions,
      promptSha256: createHash("sha256").update(config.instructions).digest("hex"),
      skills: roleSkills(role),
      configurationRevision: config.revision,
    };
  }
  const configuredGroup = {
    ...group,
    writer: configuredExpert("writer"),
    visual: configuredExpert("visual"),
    reviewer: configuredExpert("reviewer"),
    researcher: configuredExpert("researcher"),
    enabledRoles: team.enabledRoles,
    configurationRevision: team.revision,
  };
  const catalog: CapabilityCatalog = {
    skills: items,
    experts: configs,
    group: {
      ...team,
      roles: [...team.enabledRoles],
      sha256: createHash("sha256").update(JSON.stringify(configuredGroup)).digest("hex"),
    },
  };
  return {
    catalog,
    skills: roleSkills("main"),
    allSkills: snapshots,
    group: configuredGroup,
    main: {
      ...main,
      prompt: mainPrompt,
      sha256: createHash("sha256").update(mainPrompt).digest("hex"),
      configurationRevision: mainConfig.revision,
    },
  };
}

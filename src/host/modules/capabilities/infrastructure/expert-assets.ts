import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPERT_ROLE_IDS, type ExpertRoleId } from "../../../../shared/contracts.js";
import { ALL_TOOL_IDS } from "../../../runtime/tools/tool-catalog.js";
import type { SkillAssetSnapshot } from "./skill-assets.js";

export interface ExpertAssetSnapshot {
  groupId: "merchant-content-team";
  role: ExpertRoleId;
  sharedRules: string;
  sharedSha256: string;
  prompt: string;
  promptSha256: string;
  skills?: SkillAssetSnapshot[];
  configurationRevision?: number;
}

export interface ExpertGroupSnapshot {
  groupId: "merchant-content-team";
  mainRole: "coordinator";
  writer: ExpertAssetSnapshot;
  visual?: ExpertAssetSnapshot;
  reviewer?: ExpertAssetSnapshot;
  researcher?: ExpertAssetSnapshot;
  writerToolIds: string[];
  manifestSha256: string;
}

export interface MainAgentSnapshot {
  sharedRules: string;
  sharedSha256: string;
  prompt: string;
  sha256: string;
}

export interface ExpertGroupV2Snapshot {
  groupId: "merchant-content-team";
  mainRole: "main";
  enabledRoles?: Array<"writer" | "visual" | "reviewer" | "researcher">;
  configurationRevision?: number;
  writer: ExpertAssetSnapshot;
  visual: ExpertAssetSnapshot;
  reviewer: ExpertAssetSnapshot;
  researcher?: ExpertAssetSnapshot;
  toolIdsByRole: Record<"writer" | "visual" | "reviewer", string[]> & { researcher?: string[] };
  manifestSha256: string;
}

const EXPERT_ROOT = fileURLToPath(new URL("../../../../../assets/experts/merchant-content-team/", import.meta.url));
const MAX_EXPERT_BYTES = 32 * 1024;
export const EXPERT_METHOD_ROLES = ["writer", "visual", "reviewer", "researcher"] as const;
export type ExpertMethodRole = (typeof EXPERT_METHOD_ROLES)[number];
const EXPERT_METHOD_DESCRIPTIONS: Record<ExpertMethodRole, string> = {
  writer: "写作、改稿和文字自查的方法；不代表独立写作子 Agent 已运行。",
  visual: "封面与配图规划、图像检查的方法；仅在图片能力实际可用时执行出图。",
  reviewer: "稿件问题分类与核对的方法；单 Agent 自查不等于独立审核。",
  researcher: "资料研究、证据核对与研究进展整理的方法；研究假设不等于商家事实。",
};

/** 计算资产正文摘要，用于冻结版本与变更检测。 */
function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 从固定资产目录读取并限制专家提示词文件。 */
async function readExpertFile(name: string): Promise<string> {
  const path = join(EXPERT_ROOT, name);
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_EXPERT_BYTES) throw new Error("EXPERT_ASSET_INVALID");
  const bytes = await readFile(path);
  if (bytes.length > MAX_EXPERT_BYTES) throw new Error("EXPERT_ASSET_INVALID");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (!content) throw new Error("EXPERT_ASSET_INVALID");
  return content;
}

/** 受理时固定角色和共用约束；排队或重试时不重新读取磁盘。 */
export async function loadExpertAsset(role: ExpertRoleId): Promise<ExpertAssetSnapshot> {
  if (!EXPERT_ROLE_IDS.includes(role)) throw new Error("EXPERT_ASSET_INVALID");
  try {
    const [sharedRules, prompt] = await Promise.all([readExpertFile("shared-rules.md"), readExpertFile(`${role}.md`)]);
    return {
      groupId: "merchant-content-team",
      role,
      sharedRules,
      sharedSha256: hash(sharedRules),
      prompt,
      promptSha256: hash(prompt),
    };
  } catch (error) {
    process.stderr.write(`[experts] 资产读取失败：${error instanceof Error ? error.message : String(error)}\n`);
    throw new Error("EXPERT_ASSET_INVALID");
  }
}

/** 冻结通用主 Agent 的职责说明；委派能力由 Group 和工具权限另行决定。 */
export async function loadMainAgentAsset(): Promise<MainAgentSnapshot> {
  const [sharedRules, prompt] = await Promise.all([readExpertFile("shared-rules.md"), readExpertFile("main.md")]);
  return { sharedRules, sharedSha256: hash(sharedRules), prompt, sha256: hash(prompt) };
}

/** 主 Agent 直接处理当前任务，仅在独立专家能力有帮助时调用委派。 */
export function mainAgentInstructions(main: MainAgentSnapshot | null): string {
  return main ? `\n\n本轮共用约束：\n${main.sharedRules}\n\n本轮主 Agent 职责：\n${main.prompt}` : "";
}

/** 冻结新版专家拓扑，并分别校验每个子角色可用的工具。 */
export async function loadExpertGroupV2Asset(): Promise<ExpertGroupV2Snapshot> {
  const content = await readExpertFile("group-v2.json");
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== "object") throw new Error("EXPERT_ASSET_INVALID");
  const manifest = value as Record<string, unknown>;
  const toolIdsByRole = manifest.toolIdsByRole as Record<string, unknown> | undefined;
  if (
    manifest.groupId !== "merchant-content-team" ||
    manifest.mainRole !== "main" ||
    !toolIdsByRole ||
    !["writer", "visual", "reviewer", "researcher"].every((role) => {
      const ids = toolIdsByRole[role];
      return (
        Array.isArray(ids) &&
        ids.length > 0 &&
        new Set(ids).size === ids.length &&
        ids.every(
          (id) =>
            typeof id === "string" &&
            ALL_TOOL_IDS.includes(id as (typeof ALL_TOOL_IDS)[number]) &&
            id !== "delegate_task" &&
            id !== "delegation_submit",
        )
      );
    })
  )
    throw new Error("EXPERT_ASSET_INVALID");
  const [writer, visual, reviewer, researcher] = await Promise.all([
    loadExpertAsset("writer"),
    loadExpertAsset("visual"),
    loadExpertAsset("reviewer"),
    loadExpertAsset("researcher"),
  ]);
  return {
    groupId: "merchant-content-team",
    mainRole: "main",
    writer,
    visual,
    reviewer,
    researcher,
    toolIdsByRole: toolIdsByRole as ExpertGroupV2Snapshot["toolIdsByRole"],
    manifestSha256: hash(content),
  };
}

/** 在商家消息受理时冻结可按需读取的专家方法，不改变本轮主角色。 */
export async function loadExpertMethodAssets(): Promise<ExpertAssetSnapshot[]> {
  return Promise.all(EXPERT_METHOD_ROLES.map((role) => loadExpertAsset(role)));
}

/** 只展示方法目录；正文由受控工具按需读取。 */
export function expertMethodCatalogInstructions(methods: readonly ExpertAssetSnapshot[]): string {
  if (!methods.length) return "";
  const catalog = methods.map((method) => ({
    role: method.role,
    description: EXPERT_METHOD_DESCRIPTIONS[method.role as ExpertMethodRole],
  }));
  return `\n\n本轮可按需参考的专家方法目录：${JSON.stringify(catalog)}。写作或改稿可读 writer，封面与配图规划可读 visual，稿件自查可读 reviewer；只有当前任务需要额外方法时才调用 read_expert_method 读取对应正文。用户询问可用方法时可直接介绍目录。读取方法只帮助当前 Agent 工作，不切换本轮角色、不表示已启动独立专家，也不增加工具权限；历史中的方法可能过期，本轮使用时重新读取。`;
}

/** 团拓扑与目标专家正文一起固定；运行时不重新读取可变文件。 */
export async function loadExpertGroupAsset(): Promise<ExpertGroupSnapshot> {
  try {
    const content = await readExpertFile("group.json");
    const manifest: unknown = JSON.parse(content);
    if (!manifest || typeof manifest !== "object") throw new Error("EXPERT_ASSET_INVALID");
    const value = manifest as Record<string, unknown>;
    const toolIds = value.writerToolIds;
    if (
      value.groupId !== "merchant-content-team" ||
      value.mainRole !== "coordinator" ||
      value.writerRole !== "writer" ||
      value.visualRole !== "visual" ||
      value.reviewerRole !== "reviewer" ||
      !Array.isArray(toolIds) ||
      toolIds.length === 0 ||
      new Set(toolIds).size !== toolIds.length ||
      !toolIds.every(
        (id) =>
          typeof id === "string" &&
          ALL_TOOL_IDS.includes(id as (typeof ALL_TOOL_IDS)[number]) &&
          id !== "delegate_task" &&
          id !== "delegation_submit",
      )
    )
      throw new Error("EXPERT_ASSET_INVALID");
    return {
      groupId: "merchant-content-team",
      mainRole: "coordinator",
      writer: await loadExpertAsset("writer"),
      visual: await loadExpertAsset("visual"),
      reviewer: await loadExpertAsset("reviewer"),
      writerToolIds: toolIds,
      manifestSha256: hash(content),
    };
  } catch {
    throw new Error("EXPERT_ASSET_INVALID");
  }
}

/** 按角色选择组装本轮系统指令，不扩大工具权限。 */
export function expertInstructions(
  expert: ExpertAssetSnapshot | null,
  group: ExpertGroupSnapshot | null = null,
): string {
  if (!expert) return "";
  const ending = group
    ? "你是统筹 Agent。需要独立写作、视觉规划或稿件审核时，按任务调用 delegate_task，目标可为 writer、visual、reviewer；等待子 Agent 的实际结果后再回答。子 Agent 只看到本轮任务单和明确授权的资料；以前对话中仍需要的用户事实应写入 contextSummary 并说明来源。关键事实缺失时先向用户询问，不要编造；视觉专家只规划画面；实际图片能力以Host工具状态为准，未收到真实图片回执不能声称已出图。每轮最多委派一个子任务，不要声称未实际发生的委派或复核。"
    : "本轮只有一个 Agent，不要声称已委派其他专家或完成独立复核。";
  return `\n\n本轮专家共用约束：\n${expert.sharedRules}\n\n本轮角色（${expert.role}）：\n${expert.prompt}\n${ending}`;
}

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface SkillReferenceSnapshot {
  path: string;
  content: string;
  sha256: string;
}

export interface SkillAssetSnapshot {
  name: string;
  description: string;
  content: string;
  sha256: string;
  references: SkillReferenceSnapshot[];
}

const SKILL_ROOT = fileURLToPath(new URL("../../../../../assets/skills/", import.meta.url));
const MAX_SKILL_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 计算资产正文摘要，用于冻结版本与变更检测。 */
function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 从项目资产目录读取受限大小的 Markdown 正文。 */
async function readMarkdown(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_SKILL_BYTES) throw new Error("SKILL_ASSET_INVALID");
  const content = await readFile(path);
  if (content.length > MAX_SKILL_BYTES) throw new Error("SKILL_ASSET_INVALID");
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

/** 读取 Skill 的受控参考文件并生成版本快照。 */
async function readReferences(skillDir: string): Promise<SkillReferenceSnapshot[]> {
  const referenceDir = join(skillDir, "references");
  try {
    const info = await lstat(referenceDir);
    if (!info.isDirectory()) throw new Error("SKILL_ASSET_INVALID");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const entries = await readdir(referenceDir, { withFileTypes: true });
  const references: SkillReferenceSnapshot[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const content = await readMarkdown(join(referenceDir, entry.name));
    references.push({ path: `references/${entry.name}`, content, sha256: hash(content) });
  }
  return references;
}

/** 每次受理从项目资产读取一次，正文随 Plan 冻结；执行时不再依赖磁盘当前版本。 */
export async function loadSkillAssets(): Promise<SkillAssetSnapshot[]> {
  try {
    return await readSkillAssets();
  } catch (error) {
    process.stderr.write(`[skills] 资产读取失败：${error instanceof Error ? error.message : String(error)}\n`);
    throw new Error("SKILL_ASSET_INVALID");
  }
}

/** 扫描固定 Skill 目录并忽略非合规资产。 */
async function readSkillAssets(): Promise<SkillAssetSnapshot[]> {
  const entries = await readdir(SKILL_ROOT, { withFileTypes: true });
  const skills: SkillAssetSnapshot[] = [];
  let totalBytes = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!SKILL_NAME.test(name)) throw new Error("SKILL_ASSET_INVALID");
    const skillDir = join(SKILL_ROOT, name);
    const raw = await readMarkdown(join(skillDir, "SKILL.md"));
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(raw);
    } catch {
      throw new Error("SKILL_ASSET_INVALID");
    }
    const { frontmatter, body } = parsed;
    const description = frontmatter.description;
    if (
      frontmatter.name !== name ||
      typeof description !== "string" ||
      !description.trim() ||
      description.length > 1024 ||
      !body.trim()
    ) {
      throw new Error("SKILL_ASSET_INVALID");
    }
    const references = await readReferences(skillDir);
    const content = body.trim();
    totalBytes +=
      Buffer.byteLength(content) +
      references.reduce((size, reference) => size + Buffer.byteLength(reference.content), 0);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("SKILL_ASSET_INVALID");
    skills.push({ name, description: description.trim(), content, sha256: hash(content), references });
  }
  return skills;
}

/** 模型只先看到目录；Skill 正文及 references 由受控工具按需返回。 */
export function skillCatalogInstructions(skills: readonly SkillAssetSnapshot[], hasMerchantContext: boolean): string {
  if (!skills.length) return "";
  const catalog = skills.map(({ name, description }) => ({ name, description }));
  const scopeNote = hasMerchantContext
    ? ""
    : "当前会话尚未关联商家。可对用户明确给定的小红书公开链接调用 public_page_collect、evidence_get，并将有依据的账号诊断草稿保存到当前会话；需要读取商家人工档案和平台链接时，请用户在本会话关联商家。";
  return `\n\n本轮可参考的 Skill 方法目录：${JSON.stringify(catalog)}\n用户询问可用 Skill 时，直接根据目录列出名称与用途。仅在当前任务需要执行某项方法时调用 read_skill 读取正文；引用的参考文件可再按 path 读取。${scopeNote}Skill 不赋予新的工具或外部能力。历史中的 Skill 内容可能属于旧版本，本轮使用前应重新读取。`;
}

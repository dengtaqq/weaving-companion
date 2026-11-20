import { createHash } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  isSkillReferencePath,
  SKILL_FILE_LIMIT,
  SKILL_PACKAGE_LIMIT,
  type SkillPackageFile,
  type SkillSnapshot,
} from "../../../../shared/capabilities.js";

/** 对文件原文和顺序一致的包计算版本摘要。 */
export function skillPackageHash(files: SkillPackageFile[]): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}
/** 只允许有界的相对 Markdown 文档，禁止路径逃逸、重复文件和脚本。 */
export function normalizeSkillFiles(value: unknown): SkillPackageFile[] {
  if (!Array.isArray(value) || !value.length || value.length > 40) throw new Error("CAPABILITY_PACKAGE_INVALID");
  const files: SkillPackageFile[] = value
    .map((file) => {
      if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.content !== "string")
        throw new Error("CAPABILITY_PACKAGE_INVALID");
      const path: string = file.path;
      if (
        path.length > 240 ||
        path.includes("\\") ||
        Array.from(path).some((char) => char.charCodeAt(0) < 32) ||
        path.startsWith("/") ||
        !path.split("/").every((part: string) => part && part !== "." && part !== "..") ||
        !path.endsWith(".md") ||
        file.content.includes("\0") ||
        Buffer.byteLength(file.content) > SKILL_FILE_LIMIT
      )
        throw new Error("CAPABILITY_PACKAGE_INVALID");
      return { path, content: file.content };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (
    new Set(files.map((file) => file.path.toLowerCase())).size !== files.length ||
    files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > SKILL_PACKAGE_LIMIT
  )
    throw new Error("CAPABILITY_PACKAGE_INVALID");
  if (
    files.filter((file) => file.path === "SKILL.md").length !== 1 ||
    files.some((file) => file.path !== "SKILL.md" && !isSkillReferencePath(file.path))
  )
    throw new Error("CAPABILITY_PACKAGE_INVALID");
  return files;
}
/** 校验包头并生成与内置 Skill 完全相同的运行快照。 */
export function parseSkillPackage(value: unknown): {
  files: SkillPackageFile[];
  snapshot: SkillSnapshot;
  packageHash: string;
} {
  const files = normalizeSkillFiles(value);
  const raw = files.find((file) => file.path === "SKILL.md") as SkillPackageFile;
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(raw.content);
  } catch {
    throw new Error("CAPABILITY_FRONTMATTER_INVALID");
  }
  const { name, description } = parsed.frontmatter;
  if (
    typeof name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    name.length > 80 ||
    typeof description !== "string" ||
    !description.trim() ||
    description.length > 1024 ||
    !parsed.body.trim()
  )
    throw new Error("CAPABILITY_FRONTMATTER_INVALID");
  const content = parsed.body.trim();
  const snapshot = {
    name,
    description: description.trim(),
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    references: files
      .filter((file) => file.path !== "SKILL.md")
      .map((file) => ({ ...file, sha256: createHash("sha256").update(file.content).digest("hex") })),
  };
  return { files, snapshot, packageHash: skillPackageHash(files) };
}

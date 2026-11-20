export const CAPABILITY_ROLES = ["main", "writer", "visual", "reviewer", "researcher"] as const;
export type CapabilityRole = (typeof CAPABILITY_ROLES)[number];
export const SKILL_FILE_LIMIT = 32 * 1024;
export const SKILL_PACKAGE_LIMIT = 128 * 1024;

/** 用户选择的 Skill 文档；只接收相对路径和 Markdown，不运行上传脚本。 */
export interface SkillPackageFile {
  path: string;
  content: string;
}
/** 可直接冻结进 Run 的已校验方法内容。 */
export interface SkillSnapshot {
  name: string;
  description: string;
  content: string;
  sha256: string;
  references: Array<{ path: string; content: string; sha256: string }>;
}
/** 原子安装的一份完整版本，正文和参考文件同时提交。 */
export interface StoredSkillVersion {
  name: string;
  revision: number;
  enabled: boolean;
  roles: CapabilityRole[];
  snapshot: SkillSnapshot;
  files: SkillPackageFile[];
  packageHash: string;
  createdAt: string;
  updatedAt: string;
}
/** 页面中的能力列表项，内置与用户导入采用相同展示结构。 */
export interface SkillCatalogItem {
  name: string;
  description: string;
  source: "BUILTIN" | "UPLOADED";
  revision: number;
  enabled: boolean;
  roles: CapabilityRole[];
  sha256: string;
  fileCount: number;
  updatedAt: string;
}
/** 内置角色的用户配置；工具权限和公共约束由 Host 固定。 */
export interface ExpertConfiguration {
  role: CapabilityRole;
  revision: number;
  name: string;
  description: string;
  instructions: string;
  skillNames: string[];
  updatedAt: string;
}
/** 专家团队可维护名称、简介和启用成员，角色 ID 和工具权限不随表单扩展。 */
export interface TeamConfiguration {
  groupId: "merchant-content-team";
  revision: number;
  name: string;
  description: string;
  enabledRoles: Array<Exclude<CapabilityRole, "main">>;
  updatedAt: string;
}
/** 保存配置时的领域状态，未配置角色回退到随项目提供的内置版本。 */
export interface CapabilityState {
  skills: StoredSkillVersion[];
  experts: ExpertConfiguration[];
  team: TeamConfiguration | null;
}
/** 真实能力目录及当前生效的可编辑配置。 */
export interface CapabilityCatalog {
  skills: SkillCatalogItem[];
  experts: ExpertConfiguration[];
  group: TeamConfiguration & { roles: string[]; sha256: string };
}
/** 规则详情包含原文件与版本历史，回滚仍生成新的当前版本。 */
export interface SkillDetail {
  item: SkillCatalogItem;
  files: SkillPackageFile[];
  versions: Array<{ revision: number; packageHash: string; createdAt: string }>;
}

/** 引用只作为受管文档快照读取，拒绝绝对路径、逃逸分段和控制字符。 */
export function isSkillReferencePath(path: string): boolean {
  return (
    path.startsWith("references/") &&
    path.endsWith(".md") &&
    !path.includes("\\") &&
    !Array.from(path).some((char) => char.charCodeAt(0) < 32) &&
    path.split("/").every((part) => !!part && part !== "." && part !== "..")
  );
}

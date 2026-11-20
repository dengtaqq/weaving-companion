/** 提示词中的一个有序来源段；content 保留运行时使用的原文。 */
export interface PromptSection {
  id: string;
  title: string;
  content: string;
}

/** 单次运行尝试启动时保存的指令和固定资料，不等同完整模型网络请求。 */
export interface PromptSnapshot {
  schemaVersion: 1;
  sessionId: string;
  runId: string;
  attempt: number;
  createdAt: string;
  adapterVersion: string;
  assemblyVersion: string;
  planHash: string | null;
  systemPromptRevision: number | null;
  systemSections: PromptSection[];
  systemPrompt: string;
  contextSections: PromptSection[];
  toolIds: string[];
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  skills: Array<{ name: string; sha256: string }>;
  sha256: string;
}

/** 将同一份只读快照转为可复制、下载的 Markdown。 */
export function promptSnapshotMarkdown(snapshot: PromptSnapshot): string {
  return [
    "# 本轮提示词与资料",
    `Run: ${snapshot.runId} · Attempt: ${snapshot.attempt}`,
    `记录时间：${snapshot.createdAt}`,
    `适配器：${snapshot.adapterVersion} · 组装版本：${snapshot.assemblyVersion}`,
    `基础提示词版本：${snapshot.systemPromptRevision ?? "未知"} · Plan hash：${snapshot.planHash ?? "无"}`,
    `快照 SHA-256：${snapshot.sha256}`,
    "这是运行启动时准备使用的系统指令和固定资料；不包含完整历史、后续工具结果、动态进度或图片字节，不证明模型请求已发送或任务已完成。",
    "## 系统指令（按组装顺序）",
    ...snapshot.systemSections.map((section) => `### ${section.title}\n\n${section.content}`),
    "## SDK 有效系统文本",
    snapshot.systemPrompt,
    "## 本轮固定资料",
    ...snapshot.contextSections.map((section) => `### ${section.title}\n\n${section.content}`),
    snapshot.contextSections.length ? "" : "无固定资料注入。",
    "## 实际装配工具",
    snapshot.toolIds.join("、") || "无",
    ...snapshot.tools.map(
      (tool) => `### ${tool.name}\n\n${tool.description}\n\n${JSON.stringify(tool.parameters, null, 2)}`,
    ),
    "## Skill 版本（正文按需读取）",
    ...snapshot.skills.map((skill) => `- ${skill.name}: ${skill.sha256}`),
  ].join("\n\n");
}

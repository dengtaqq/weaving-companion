import { createHash } from "node:crypto";
import type { PromptSection, PromptSnapshot } from "../../../shared/prompt-snapshot.js";
import {
  expertInstructions,
  expertMethodCatalogInstructions,
  mainAgentInstructions,
} from "../../modules/capabilities/infrastructure/expert-assets.js";
import { skillCatalogInstructions } from "../../modules/capabilities/infrastructure/skill-assets.js";
import type { ResolvedRunContext } from "./context-assembler.js";
import { LEGACY_TASK_FOCUS_INSTRUCTIONS, TASK_FOCUS_INSTRUCTIONS } from "./task-focus.js";

/** 由同一有序段落生成 SDK 使用的系统文本和页面可查看的来源。 */
export function assembleSystemPrompt(input: ResolvedRunContext, taskFocusEnabled: boolean) {
  const sections: PromptSection[] = [
    { id: "global", title: "全局基础提示词", content: input.systemPrompt },
    { id: "main", title: "共用约束与主 Agent 职责", content: mainAgentInstructions(input.mainAgent) },
    { id: "expert", title: "专家约束与职责", content: expertInstructions(input.expert, input.expertGroup) },
    {
      id: "skills",
      title: "Skill 目录与读取规则",
      content: skillCatalogInstructions(input.skills, Boolean(input.merchantContext)),
    },
    { id: "methods", title: "专家方法目录", content: expertMethodCatalogInstructions(input.expertMethods) },
    {
      id: "execution",
      title: "任务执行与结束核对",
      content: taskFocusEnabled
        ? input.plan?.runtime.adapterVersion.includes(":prompt-assembly-1:")
          ? TASK_FOCUS_INSTRUCTIONS
          : LEGACY_TASK_FOCUS_INSTRUCTIONS
        : "",
    },
  ].filter((section) => section.content.length > 0);
  return { sections, text: sections.map((section) => section.content).join("") };
}

/** 保存已实际装配的系统文本、固定来源与工具名称，不读取当前可变资产。 */
export function createPromptSnapshot(
  input: ResolvedRunContext,
  system: ReturnType<typeof assembleSystemPrompt>,
  tools: PromptSnapshot["tools"],
  sdkSystemPrompt: string,
): PromptSnapshot {
  const contextSections: PromptSection[] = [
    { id: "merchant", title: "商家资料简介", content: input.merchantContext?.brief ?? "" },
    { id: "attachments", title: "授权附件索引（不表示正文已读）", content: input.attachmentIndex ?? "" },
    { id: "task", title: "冻结任务要求与成果索引", content: input.taskContextBrief ?? "" },
  ].filter((section) => section.content.length > 0);
  const body: Omit<PromptSnapshot, "sha256"> = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    runId: input.runId,
    attempt: input.attempt ?? 1,
    createdAt: new Date().toISOString(),
    adapterVersion: input.plan?.runtime.adapterVersion ?? "legacy",
    assemblyVersion: input.plan?.runtime.adapterVersion.includes(":prompt-assembly-1:")
      ? "prompt-assembly-1"
      : "legacy",
    planHash: input.sourceSummary.planHash,
    systemPromptRevision: input.sourceSummary.systemPromptRevision,
    systemSections: system.sections,
    systemPrompt: sdkSystemPrompt,
    contextSections,
    toolIds: tools.map((tool) => tool.name),
    tools,
    skills: input.skills.map(({ name, sha256 }) => ({ name, sha256 })),
  };
  return { ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

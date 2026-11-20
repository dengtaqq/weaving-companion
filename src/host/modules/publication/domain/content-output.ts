import AjvModule from "ajv/dist/2020.js";

export const CONTENT_OUTPUT_VERSION = "text-output-v2";
export const contentOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body", "internalNotes"],
  properties: {
    action: { enum: ["REVISE", "REPLY"] },
    reply: { type: "string", minLength: 1, maxLength: 4000 },
    title: { type: "string", minLength: 1, maxLength: 120 },
    body: { type: "string", minLength: 1, maxLength: 50000 },
    internalNotes: { type: "string", maxLength: 8000 },
  },
} as const;
export interface ContentOutput {
  action?: "REVISE" | "REPLY";
  reply?: string;
  title: string;
  body: string;
  internalNotes: string;
}
const validateOutput = new AjvModule.default().compile<ContentOutput>(contentOutputSchema);
/** 新任务强制分开发布正文与内部说明，格式不符时明确失败，不把整段回复当正文。 */
export function parseContentOutput(text: string): ContentOutput {
  let output: unknown;
  try {
    output = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    throw new Error("CONTENT_OUTPUT_INVALID");
  }
  if (!validateOutput(output) || !output.title.trim() || /[\r\n]/.test(output.title) || !output.body.trim())
    throw new Error("CONTENT_OUTPUT_INVALID");
  if (output.action === "REPLY" && !output.reply?.trim()) throw new Error("CONTENT_OUTPUT_INVALID");
  return {
    title: output.title.trim(),
    body: output.body.trim(),
    internalNotes: output.internalNotes.trim(),
    ...(output.action ? { action: output.action } : {}),
    ...(output.reply ? { reply: output.reply.trim() } : {}),
  };
}
/** 最终响应协议覆盖任务描述里的展示格式，来源缺口必须留在内部字段。 */
export function contentOutputInstruction(): string {
  return [
    "最终回复只输出符合以下Schema的JSON，不输出代码围栏或JSON之外的解释。",
    JSON.stringify(contentOutputSchema),
    "每次只处理当前这一篇。reply 用自然对话回复用户，简短说明修改或回答问题；首次创作 action=REVISE。当前稿件对话中，用户明确要求改稿时 action=REVISE，返回完整新稿；只问原因、建议或解释时 action=REPLY，保留原标题正文，只在reply回答，不制造新版本。不要把对话回答写进发布正文。",
    "title 是简洁的实际发布标题，选题名只是工作主题；body 只放可发布正文和话题，不能包含正文标签、资料ID、内部备注、待核实清单或任务状态。资料缺口、配图需求、风险、来源及下一步只放 internalNotes。不得在任何字段编造事实，也不要声称尚未保存草稿：Host 会在校验后自动保存。",
  ].join("\n");
}

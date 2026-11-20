import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { sha256 } from "../execution/runtime-plan.js";

/** 主模型的只读历史投影；完整业务输入、结果与用户原话仍保存在原日志。 */
export interface MainHistoryView {
  protectedUserHashes?: string[];
  internalPromptHashes: string[];
  receipts: Array<{
    jobId: string;
    purpose: string;
    status: string;
    draftId: string | null;
    receipt: string;
    summary: string | null;
  }>;
}

/** 仅移除可精确识别的旧内部回合，并收窄旧编排工具结果；当前回合及真实用户原话保留。 */
export function projectMainHistory(
  messages: ContextEvent["messages"],
  view: MainHistoryView,
  preserveCurrent = true,
): ContextEvent["messages"] {
  const protectedUsers = new Set(view.protectedUserHashes ?? []);
  const internal = new Set(view.internalPromptHashes.filter((hash) => !protectedUsers.has(hash)));
  let skip = false;
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") lastUser = i;
  return messages.flatMap((message, index) => {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      skip = (!preserveCurrent || index < lastUser) && internal.has(sha256(text));
    }
    if (skip) return [];
    if (
      (!preserveCurrent || index < lastUser) &&
      message.role === "toolResult" &&
      message.toolName === "publication_task"
    ) {
      return [
        {
          ...message,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                notice:
                  "历史任务结果正文已从主模型视图收窄，原工具记录保留；通过publication_task STATUS/READ_INPUT按jobId回读。",
                taskReceipts: view.receipts,
              }),
            },
          ],
        },
      ];
    }
    if ((!preserveCurrent || index < lastUser) && message.role === "assistant")
      return [{ ...message, content: message.content.filter((part) => part.type !== "thinking") }];
    return [message];
  });
}

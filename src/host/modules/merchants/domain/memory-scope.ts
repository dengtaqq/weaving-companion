import type { MemoryScope, MerchantMemory } from "../../../../shared/contracts.js";

/** 仅审核通过、对象明确且与冻结商品版本适配的记忆能够进入执行上下文。 */
export function isMemoryApplicable(memory: MerchantMemory, scope: MemoryScope): boolean {
  if (memory.status !== "ACTIVE" || !memory.review || !memory.subject) return false;
  if (memory.subject.kind === "MERCHANT") return !memory.productBasis;
  const product = scope.product;
  if (!product || product.entryId !== memory.subject.productEntryId) return false;
  const basis = memory.productBasis;
  return (
    !basis ||
    (basis.entryId === product.entryId && basis.revision === product.revision && basis.sha256 === product.sha256)
  );
}

/** 历史记忆工具正文按本轮精确版本过滤，保留调用配对和原始历史文件。 */
export function projectMemoryHistory<T>(messages: readonly T[], memories: readonly MerchantMemory[]): T[] {
  const allowed = new Set(memories.map((item) => `${item.memoryId}:${item.revision}:${item.sha256}`));
  return messages.map((message) => {
    const row = message as Record<string, unknown>;
    if (row.role !== "toolResult" || !["merchant_memory_search", "merchant_memory_get"].includes(String(row.toolName)))
      return message;
    try {
      const content = row.content as Array<{ type: string; text?: string }>;
      const text = content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      const parsed: unknown = JSON.parse(text);
      /** 历史结果必须能与当前冻结条目的 ID、版本和哈希同时匹配。 */
      const matches = (value: unknown) => {
        if (!value || typeof value !== "object") return false;
        const item = value as Record<string, unknown>;
        return allowed.has(`${item.memoryId}:${item.revision}:${item.sha256}`);
      };
      const result = Array.isArray(parsed)
        ? parsed.filter(matches)
        : matches(parsed)
          ? parsed
          : { unavailable: "该历史记忆不属于本轮获准范围，请按当前商家记忆重新检索。" };
      return { ...row, content: [{ type: "text", text: JSON.stringify(result) }] } as T;
    } catch {
      return { ...row, content: [{ type: "text", text: "该历史记忆无法核对当前版本，本轮不提供其正文。" }] } as T;
    }
  });
}

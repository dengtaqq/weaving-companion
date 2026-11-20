import type { Browser, BrowserContext } from "playwright-core";

/** 取消只关闭本次采集拥有的上下文；关闭失败时等待实际 close，不能提前释放会话。 */
export function bindCollectionCleanup(
  browser: Browser | null,
  context: BrowserContext,
  signal?: AbortSignal,
): () => Promise<void> {
  let closeTask: Promise<void> | null = null;
  const closed = new Promise<void>((resolve) => {
    if (browser) browser.once("disconnected", () => resolve());
    else context.once("close", () => resolve());
  });
  /** 多次取消和 finally 共用一次清理，拒绝关闭时仍等待真实退出事件。 */
  const close = () => {
    closeTask ??= (browser?.close() ?? context.close()).catch(() => closed);
    return closeTask;
  };
  /** 监听建立前已经取消也必须立即关闭，防止启动浏览器期间丢失信号。 */
  const onAbort = () => void close();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return async () => {
    await close();
    signal?.removeEventListener("abort", onAbort);
  };
}

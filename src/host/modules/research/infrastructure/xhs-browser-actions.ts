import { setTimeout } from "node:timers/promises";

const ACTION_PAUSE_MS = 1_000;
let actionQueue: Promise<void> = Promise.resolve();

/** 将本 Host 的小红书自动操作串行化，每次操作前停顿一秒，取消后跳过尚未执行的操作。 */
export async function runXhsBrowserAction<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("TOOL_ABORTED");
  // 搜索、主页、详情与登录导航共用队列，不能靠并发工具或不同会话绕过操作间隔。
  const scheduled = actionQueue.then(async () => {
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    try {
      await setTimeout(ACTION_PAUSE_MS, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) throw new Error("TOOL_ABORTED");
      throw error;
    }
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    return action();
  });
  // 失败或取消只结束当前操作，不破坏后续采集的排队顺序。
  actionQueue = scheduled.then(
    () => {},
    () => {},
  );
  if (!signal) return scheduled;
  return new Promise<T>((resolve, reject) => {
    /** 让排队中的取消立即返回，队列稍后领取时仍会检查信号并跳过操作。 */
    const onAbort = () => reject(new Error("TOOL_ABORTED"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void scheduled.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const MIN_RUN_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MULTIPLIER = 4;

/** 模型等待累计计时排除工具批次；整轮墙钟时限始终覆盖执行和清理。 */
export class RuntimeDeadline {
  private modelTimer: NodeJS.Timeout | null = null;
  private runTimer: NodeJS.Timeout | null = null;
  private remainingMs: number;
  private resumedAt = performance.now();
  private readonly tools = new Set<string>();
  private expired = false;

  /** 旧 Run 保持整轮 MODEL_TIMEOUT，新 Run 另有整轮兜底并隔离工具等待。 */
  constructor(
    timeoutMs: number,
    private readonly isolateTools: boolean,
    private readonly onTimeout: (code: "MODEL_TIMEOUT" | "RUN_TIMEOUT") => void,
  ) {
    this.remainingMs = timeoutMs;
    this.resume();
    if (isolateTools)
      this.runTimer = setTimeout(
        () => this.expire("RUN_TIMEOUT"),
        Math.min(2_147_483_647, Math.max(MIN_RUN_TIMEOUT_MS, timeoutMs * RUN_TIMEOUT_MULTIPLIER)),
      );
  }

  /** 同批第一个工具启动时暂停模型计时，并发工具不能提前恢复计时。 */
  toolStarted(id: string): void {
    if (!this.isolateTools || this.expired) return;
    if (this.tools.size === 0) {
      this.remainingMs = Math.max(0, this.remainingMs - (performance.now() - this.resumedAt));
      if (this.modelTimer) clearTimeout(this.modelTimer);
      this.modelTimer = null;
    }
    this.tools.add(id);
  }

  /** 所有已启动工具均结束后才继续累计模型等待预算。 */
  toolCompleted(id: string): void {
    if (!this.tools.delete(id) || this.tools.size || this.expired) return;
    this.resume();
  }

  /** 在完成、失败或取消时解除两个定时器，避免跨 Run 的晚到中止。 */
  stop(): void {
    if (this.modelTimer) clearTimeout(this.modelTimer);
    if (this.runTimer) clearTimeout(this.runTimer);
    this.modelTimer = null;
    this.runTimer = null;
  }

  /** 从剩余模型预算继续计时，不因工具批次重置原额度。 */
  private resume(): void {
    this.resumedAt = performance.now();
    this.modelTimer = setTimeout(() => this.expire("MODEL_TIMEOUT"), this.remainingMs);
  }

  /** 仅首个到期原因生效，真正执行退出仍由适配器和 Host 等待。 */
  private expire(code: "MODEL_TIMEOUT" | "RUN_TIMEOUT"): void {
    if (this.expired) return;
    this.expired = true;
    this.stop();
    this.onTimeout(code);
  }
}

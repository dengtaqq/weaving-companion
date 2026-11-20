import type { FileStore } from "../../../infrastructure/files/files.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";

/** 协调永久删除的文件暂存、数据库提交和重启后续清理。 */
export class SessionPurgeService {
  private readonly pending = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  /** 绑定数据库与受管文件系统。 */
  constructor(
    private readonly db: DbClient,
    private readonly files: FileStore,
  ) {}

  /** 从中断阶段继续执行一次永久删除，同一会话并发调用只执行一次。 */
  run(sessionId: string): Promise<void> {
    const existing = this.pending.get(sessionId);
    if (existing) return existing;
    const task = this.runSteps(sessionId).finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, task);
    return task;
  }

  /** 启动时对账已受理而未完成的永久删除。 */
  async recover(): Promise<void> {
    for (const item of await this.db.listPendingSessionPurges()) {
      try {
        await this.run(item.sessionId);
      } catch (error) {
        process.stderr.write(
          `[session purge ${item.sessionId}] ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    await this.sweepExpired();
  }

  /** 定期处理到期会话，Host 停止时不延长进程寿命。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => {
        void this.sweepExpired().catch((error) => process.stderr.write(`[expired sessions] ${String(error)}\n`));
      },
      6 * 60 * 60 * 1000,
    );
    this.timer.unref();
  }

  /** 停止周期扫描，已受理删除仍由持久日志恢复。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 到期后逐条执行安全删除；外部引用阻止删除并保留回收站记录。 */
  private async sweepExpired(): Promise<void> {
    for (const sessionId of await this.db.listExpiredTrashedSessions()) {
      try {
        await this.run(sessionId);
      } catch (error) {
        process.stderr.write(
          `[expired session ${sessionId}] ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  /** 先移动工作区，再原子删除元数据，最后清理暂存目录。 */
  private async runSteps(sessionId: string): Promise<void> {
    const journal = await this.db.prepareSessionPurge(sessionId);
    if (journal.phase === "FINALIZED") return;
    if (journal.phase === "PREPARED") {
      await this.files.stageSessionPurge(sessionId);
      await this.db.commitSessionPurge(sessionId);
    }
    for (const hash of await this.db.listSessionBlobGc(sessionId)) {
      await this.files.removeManagedBlob(hash);
      await this.db.finishSessionBlobGc(sessionId, hash);
    }
    await this.files.finalizeSessionPurge(sessionId);
    await this.db.finalizeSessionPurge(sessionId);
  }
}

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface AuditEntry {
  action:
    | "task.budget.resumed"
    | "pairing.completed"
    | "session.create.accepted"
    | "session.merchant.bound"
    | "message.accepted"
    | "artifact.upload.accepted"
    | "generation.image.accepted"
    | "generation.text.accepted"
    | "topic.plan.accepted"
    | "capability.updated"
    | "workbench.updated"
    | "publication.plan.accepted"
    | "publication.review.accepted"
    | "publication.updated"
    | "publication.exported"
    | "publication.conversation.accepted"
    | "publication.conversation.image.confirmed"
    | "public_diagnosis_report.published"
    | "run.cancel.requested"
    | "run.finished"
    | "system-prompt.updated"
    | "merchant.created"
    | "merchant.profile.updated"
    | "merchant.link.updated"
    | "merchant.catalog.updated"
    | "merchant.research.adopted"
    | "merchant.research.deactivated"
    | "merchant.memory.updated"
    | "session.archived"
    | "session.trashed"
    | "session.untrashed"
    | "session.purged"
    | "xhs.login.started"
    | "xhs.login.confirmed"
    | "xhs.login.cancelled";
  requestId?: string;
  sessionId?: string;
  messageId?: string;
  runId?: string;
  artifactId?: string;
  jobId?: string;
  draftId?: string;
  blobHash?: string;
  sizeBytes?: number;
  status?: string;
  merchantId?: string;
}

/** 将关键操作按日期追加到 JSONL 审计文件。 */
export class AuditLog {
  private pending: Promise<void> = Promise.resolve();

  /** 绑定审计日志目录，写入由队列串行处理。 */
  private constructor(private readonly directory: string) {}

  /** 准备审计目录并创建日志写入器。 */
  static async create(dataDir: string): Promise<AuditLog> {
    const directory = join(dataDir, "audit");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new AuditLog(directory);
  }

  /** 将关键业务操作追加到本地审计日志。 */
  record(entry: AuditEntry): Promise<void> {
    const occurredAt = new Date().toISOString();
    const path = join(this.directory, `${occurredAt.slice(0, 10)}.jsonl`);
    const line = `${JSON.stringify({ auditId: `aud_${randomUUID()}`, occurredAt, ...entry })}\n`;
    // 串行追加，保持同一进程内审计记录的写入顺序。
    const task = this.pending.then(() => appendFile(path, line, { mode: 0o600 }));
    this.pending = task.catch(() => {});
    return task;
  }

  /** 等待之前排队的审计日志全部写完。 */
  async close(): Promise<void> {
    await this.pending;
  }
}

import { join } from "node:path";
import type { RecoveryReport } from "../shared/contracts.js";
import { loadConfig } from "./config.js";
import { EventHub } from "./http/event-hub.js";
import { PairingService } from "./http/pairing.js";
import { createServer } from "./http/server.js";
import { AuditLog } from "./infrastructure/audit/audit.js";
import { FileStore } from "./infrastructure/files/files.js";
import { EncryptedSecretStore } from "./infrastructure/security/secret-store.js";
import { DbClient } from "./infrastructure/sqlite/db-client.js";
import { GenerationService } from "./modules/media/application/generation-service.js";
import { SeedreamImageMediaPort } from "./modules/media/infrastructure/image-media-port.js";
import { AgentTaskManager } from "./runtime/execution/agent-task-manager.js";

/** 按文件锁、密钥、数据库、恢复检查、HTTP 服务的顺序启动 Host。 */
async function main(): Promise<void> {
  let config = loadConfig();
  const files = new FileStore(config.dataDir);
  await files.prepare();
  const releaseLease = await files.acquireLease();
  let db: DbClient | null = null;
  let audit: AuditLog | null = null;
  try {
    const secrets = await EncryptedSecretStore.open(
      config.dataDir,
      config.model ? undefined : process.env.ZHIBAN_MASTER_KEY?.trim(),
    );
    config = loadConfig(process.env, secrets.savedValues());
    db = new DbClient(join(config.dataDir, "zhiban.sqlite"));
    const health = await db.health();
    if (health.quickCheck !== "ok") throw new Error("数据库完整性检查失败");
    const auditLog = await AuditLog.create(config.dataDir);
    audit = auditLog;
    // 只读工具 Run 从上次成功快照重试；取消请求和超出重试上限的 Run 收口为终态。
    const interrupted = await db.recoverInterrupted();
    for (const event of interrupted.filter((item) => item.type === "session.execution.finished")) {
      await auditLog.record({
        action: "run.finished",
        sessionId: event.sessionId,
        runId: event.runId ?? undefined,
        status: String(event.payload.status ?? "FAILED"),
      });
    }
    const [queuedRunIds, stagingFiles, blobReferences] = await Promise.all([
      db.listQueuedRunIds(),
      files.scanStaging(),
      db.listBlobReferences(),
    ]);
    const blobIssues = await files.verifyBlobs(blobReferences);
    const interruptedRunIds = interrupted
      .filter(
        (event) => event.type === "session.execution.retrying" || event.payload.errorCode !== "PREVIOUS_RUN_FAILED",
      )
      .map((event) => event.runId)
      .filter((id): id is string => id !== null);
    const recovery: RecoveryReport = {
      scannedAt: new Date().toISOString(),
      interruptedRunIds,
      queuedRunIds,
      stagingFiles,
      blobIssues,
      items: [
        ...queuedRunIds.map((resourceId) => ({
          resourceKind: "run" as const,
          resourceId,
          disposition: "RETRY" as const,
          reason: "QUEUED",
        })),
        ...interrupted
          .filter((event) => event.runId && event.type === "session.execution.finished")
          .map((event) => ({
            resourceKind: "run" as const,
            resourceId: event.runId as string,
            disposition: "FAILED" as const,
            reason: String(event.payload.errorCode ?? "HOST_INTERRUPTED"),
          })),
        ...stagingFiles.map((file) => ({
          resourceKind: "staging" as const,
          resourceId: file.name,
          disposition: "RECONCILE" as const,
          reason: file.kind === "file" ? "UNPUBLISHED_FILE" : "UNEXPECTED_ENTRY",
        })),
        ...blobIssues.map((issue) => ({
          resourceKind: "blob" as const,
          resourceId: issue.hash,
          disposition: "MANUAL" as const,
          reason: issue.reason,
        })),
      ],
    };
    const pairing = await PairingService.create(config.dataDir);
    const events = new EventHub(db);
    const taskManager = new AgentTaskManager(db, files, config, (event) => {
      events.publish(event);
      if (event.type === "session.execution.finished") {
        void auditLog
          .record({
            action: "run.finished",
            sessionId: event.sessionId,
            runId: event.runId ?? undefined,
            status: String(event.payload.status ?? "UNKNOWN"),
          })
          .catch(() => process.stderr.write(`[audit] run.finished 写入失败\n`));
      }
    });
    const generation = new GenerationService(
      db,
      files,
      config.image ? new SeedreamImageMediaPort(config.image.apiKey, config.image.timeoutMs) : null,
      config.image?.modelId ?? null,
    );
    const server = await createServer({
      config,
      db,
      files,
      pairing,
      events,
      taskManager,
      generation,
      audit: auditLog,
      recovery,
      secretsLocked: secrets.locked,
    });
    await server.listen({ port: config.port, host: "127.0.0.1" });
    const imageRecovery = await generation.start();
    if (imageRecovery.unknown) process.stdout.write(`图片任务待对账：${imageRecovery.unknown} 个\n`);
    // Blob 校验失败时保留只读排障能力，暂停新的 Run。
    if (recovery.blobIssues.length === 0) taskManager.start();
    process.stdout.write(`织伴 Agent 已启动：http://127.0.0.1:${config.port}\n`);
    process.stdout.write(`本机配对码：${pairing.startupCode}（可重复使用）\n`);
    if (!config.model)
      process.stdout.write(
        secrets.locked
          ? "加密模型配置已锁定；设置 ZHIBAN_MASTER_KEY 后重启 Host。\n"
          : "文本模型尚未配置；会话可创建，发送消息暂不可用。\n",
      );
    if (recovery.interruptedRunIds.length || recovery.stagingFiles.length || recovery.blobIssues.length) {
      process.stdout.write(
        `恢复扫描：中断 Run ${recovery.interruptedRunIds.length}、待检查 staging ${recovery.stagingFiles.length}、Blob 异常 ${recovery.blobIssues.length}；详情见 /api/v1/recovery。\n`,
      );
    }

    let closing = false;
    // 退出时先停止入口和调度，再关闭持久化资源并释放文件锁。
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      taskManager.beginStop();
      events.close();
      await server.close();
      await taskManager.stop();
      await generation.stop();
      await auditLog.close();
      await db?.close();
      await releaseLease();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } catch (error) {
    await audit?.close();
    await db?.close();
    await releaseLease();
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`织伴 Agent 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

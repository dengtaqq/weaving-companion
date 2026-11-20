import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { RecoveryReport } from "../../../shared/contracts.js";
import type { PromptSnapshot } from "../../../shared/prompt-snapshot.js";

const MAX_PROMPT_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** 管理本机工作区、内容寻址 Blob 和 Host 独占文件锁。 */
export class FileStore {
  readonly root: string;

  /** 计算受管工作区、Blob 和暂存目录。 */
  constructor(dataDir: string) {
    this.root = resolve(dataDir);
  }

  /** 创建并校验工作区、Blob 和暂存目录。 */
  async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await Promise.all([
      mkdir(join(this.root, "blobs", "sha256"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, "staging"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, "runtime", "pi-agent"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, "operators", "local", "sessions"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, "deletion-staging"), { recursive: true, mode: 0o700 }),
    ]);
  }

  /** 计算指定会话的受管工作目录。 */
  workspace(sessionId: string): string {
    if (!/^ses_[0-9a-f-]{36}$/.test(sessionId)) throw new Error("INVALID_SESSION_ID");
    return join(this.root, "operators", "local", "sessions", sessionId, "workspace");
  }

  /** 创建会话工作目录并校验其安全边界。 */
  async prepareWorkspace(sessionId: string): Promise<string> {
    const workspace = this.workspace(sessionId);
    for (const directory of ["input", "output", "tmp"]) {
      await mkdir(join(workspace, directory), { recursive: true, mode: 0o700 });
    }
    return workspace;
  }

  /** 返回当前会话的受管 Pi 快照目录。 */
  piSessionDirectory(sessionId: string): string {
    if (!/^ses_[0-9a-f-]{36}$/.test(sessionId)) throw new Error("INVALID_SESSION_ID");
    return join(this.root, "runtime", "pi-agent", "sessions", sessionId);
  }

  /** 原子发布只读启动快照；同一 Run/Attempt 不允许覆盖，永久删除沿用会话 Pi 目录清理。 */
  async savePromptSnapshot(snapshot: PromptSnapshot): Promise<void> {
    const directory = await this.promptSnapshotDirectory(snapshot.sessionId, snapshot.runId, true);
    if (!Number.isSafeInteger(snapshot.attempt) || snapshot.attempt < 1) throw new Error("PROMPT_SNAPSHOT_INVALID");
    const target = join(directory, `${snapshot.attempt}.json`);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const content = JSON.stringify(snapshot);
    if (Buffer.byteLength(content) > MAX_PROMPT_SNAPSHOT_BYTES) throw new Error("PROMPT_SNAPSHOT_TOO_LARGE");
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    try {
      // link 只发布完整文件，EEXIST 不能覆写已记录的历史尝试。
      await link(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** 仅读取指定会话与 Run 的已记录快照，并核对受管路径、身份和完整性。 */
  async readPromptSnapshots(sessionId: string, runId: string): Promise<PromptSnapshot[]> {
    let directory: string;
    try {
      directory = await this.promptSnapshotDirectory(sessionId, runId, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const names = (await readdir(directory)).filter((name) => /^[1-9]\d*\.json$/.test(name));
    const snapshots: PromptSnapshot[] = [];
    for (const name of names) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_PROMPT_SNAPSHOT_BYTES || (await realpath(path)) !== path)
        throw new Error("PROMPT_SNAPSHOT_INVALID");
      const content = await readFile(path, "utf8");
      let snapshot: PromptSnapshot;
      try {
        snapshot = JSON.parse(content) as PromptSnapshot;
      } catch {
        throw new Error("PROMPT_SNAPSHOT_INVALID");
      }
      if (!snapshot || typeof snapshot !== "object") throw new Error("PROMPT_SNAPSHOT_INVALID");
      const { sha256, ...body } = snapshot;
      if (
        snapshot.schemaVersion !== 1 ||
        snapshot.sessionId !== sessionId ||
        snapshot.runId !== runId ||
        !Number.isSafeInteger(snapshot.attempt) ||
        `${snapshot.attempt}.json` !== name ||
        createHash("sha256").update(JSON.stringify(body)).digest("hex") !== sha256
      )
        throw new Error("PROMPT_SNAPSHOT_INVALID");
      snapshots.push(snapshot);
    }
    return snapshots.sort((left, right) => left.attempt - right.attempt);
  }

  /** 在会话 Pi 根下定位快照，逐层拒绝符号链接和跨目录引用。 */
  private async promptSnapshotDirectory(sessionId: string, runId: string, create: boolean): Promise<string> {
    if (!/^run_[0-9a-f-]{36}$/.test(runId)) throw new Error("INVALID_RUN_ID");
    const root = await realpath(this.root);
    this.piSessionDirectory(sessionId);
    const session = join(root, "runtime", "pi-agent", "sessions", sessionId);
    const directories = [
      join(root, "runtime"),
      join(root, "runtime", "pi-agent"),
      join(root, "runtime", "pi-agent", "sessions"),
      session,
      join(session, "prompts"),
      join(session, "prompts", runId),
    ];
    for (const directory of directories) {
      if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
        throw new Error("PROMPT_SNAPSHOT_PATH_ESCAPE");
    }
    return join(session, "prompts", runId);
  }

  /** 将已确认永久删除的会话目录移到受管暂存区，重试时可识别已移动目录。 */
  async stageSessionPurge(sessionId: string): Promise<void> {
    if (!/^ses_[0-9a-f-]{36}$/.test(sessionId)) throw new Error("INVALID_SESSION_ID");
    const root = await realpath(this.root);
    const stagingRoot = await realpath(join(this.root, "deletion-staging"));
    if (!stagingRoot.startsWith(`${root}${sep}`)) throw new Error("PURGE_PATH_ESCAPE");
    const staging = join(stagingRoot, sessionId);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    if ((await realpath(staging)) !== staging) throw new Error("PURGE_PATH_ESCAPE");
    const sources = [
      { source: join(this.root, "operators", "local", "sessions", sessionId), target: join(staging, "workspace") },
      { source: this.piSessionDirectory(sessionId), target: join(staging, "pi") },
    ];
    for (const item of sources) {
      let sourceInfo: Awaited<ReturnType<typeof lstat>>;
      try {
        sourceInfo = await lstat(item.source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!sourceInfo.isDirectory() || !(await realpath(item.source)).startsWith(`${root}${sep}`))
        throw new Error("PURGE_PATH_ESCAPE");
      try {
        await lstat(item.target);
        throw new Error("PURGE_STAGE_CONFLICT");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(item.source, item.target);
    }
  }

  /** 数据库提交删除后，校验暂存区归属并清理该会话的目录。 */
  async finalizeSessionPurge(sessionId: string): Promise<void> {
    if (!/^ses_[0-9a-f-]{36}$/.test(sessionId)) throw new Error("INVALID_SESSION_ID");
    const stagingRoot = await realpath(join(this.root, "deletion-staging"));
    const target = join(stagingRoot, sessionId);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!info.isDirectory() || !(await realpath(target)).startsWith(`${stagingRoot}${sep}`))
      throw new Error("PURGE_PATH_ESCAPE");
    await rm(target, { recursive: true, force: true });
  }

  /** 仅删除数据库已独占收集的受管 Blob，缺失文件视为可重试的已完成步骤。 */
  async removeManagedBlob(hash: string): Promise<void> {
    const path = this.blobPath(hash);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const root = await this.managedBlobRoot();
    if (!info.isFile() || !(await realpath(path)).startsWith(`${root}${sep}`)) throw new Error("BLOB_PATH_ESCAPE");
    await rm(path);
  }

  /** 按内容哈希原子写入受管 Blob，避免重复存储。 */
  async putBlob(content: Buffer): Promise<{ hash: string; size: number }> {
    const hash = createHash("sha256").update(content).digest("hex");
    const target = this.blobPath(hash);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const blobRoot = await this.managedBlobRoot();
    const targetDir = await realpath(dirname(target));
    if (!targetDir.startsWith(`${blobRoot}${sep}`)) throw new Error("BLOB_PATH_ESCAPE");
    // 相同哈希只复用校验通过的现存文件，防止引用损坏内容。
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.size !== content.length || (await this.fileHash(target)) !== hash) {
        throw new Error("BLOB_HASH_MISMATCH");
      }
      return { hash, size: content.length };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const staging = join(this.root, "staging", randomUUID());
    const stagingDir = await realpath(dirname(staging));
    const root = await realpath(this.root);
    if (!stagingDir.startsWith(`${root}${sep}`)) throw new Error("STAGING_PATH_ESCAPE");
    // 先写 staging 再改名发布，避免读取到未写完的 Blob。
    await writeFile(staging, content, { flag: "wx", mode: 0o600 });
    try {
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { force: true });
      throw error;
    }
    return { hash, size: content.length };
  }

  /** 校验 Blob 哈希后定位受管文件路径。 */
  blobPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("INVALID_BLOB_HASH");
    return join(this.root, "blobs", "sha256", hash.slice(0, 2), hash);
  }

  /** 从受管 Blob 目录读取并校验内容。 */
  async readBlob(hash: string): Promise<Buffer> {
    const path = this.blobPath(hash);
    if (!(await lstat(path)).isFile()) throw new Error("BLOB_PATH_ESCAPE");
    const actual = await realpath(path);
    const allowed = `${await this.managedBlobRoot()}${sep}`;
    if (!actual.startsWith(allowed)) throw new Error("BLOB_PATH_ESCAPE");
    const content = await readFile(actual);
    if (createHash("sha256").update(content).digest("hex") !== hash) throw new Error("BLOB_HASH_MISMATCH");
    return content;
  }

  /** 流式计算文件摘要以核对 Blob 完整性。 */
  private async fileHash(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  }

  /** 解析并验证 Blob 根目录，防止路径逃逸。 */
  private async managedBlobRoot(): Promise<string> {
    const root = await realpath(this.root);
    const blobRoot = await realpath(join(this.root, "blobs", "sha256"));
    if (!blobRoot.startsWith(`${root}${sep}`)) throw new Error("BLOB_PATH_ESCAPE");
    return blobRoot;
  }

  /** 扫描暂存目录中的未完成文件供启动恢复。 */
  async scanStaging(): Promise<RecoveryReport["stagingFiles"]> {
    const root = await realpath(this.root);
    const directory = await realpath(join(this.root, "staging"));
    if (!directory.startsWith(`${root}${sep}`)) throw new Error("STAGING_PATH_ESCAPE");
    const files: RecoveryReport["stagingFiles"] = [];
    for (const name of await readdir(directory)) {
      const info = await lstat(join(directory, name));
      files.push({
        name,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        kind: info.isFile() ? "file" : "unexpected",
      });
    }
    return files;
  }

  /** 核对数据库附件引用与实际 Blob 文件。 */
  async verifyBlobs(references: Array<{ hash: string; sizeBytes: number }>): Promise<RecoveryReport["blobIssues"]> {
    // 只核对数据库仍引用的 Blob，结果用于决定是否暂停写入。
    const blobRoot = await this.managedBlobRoot();
    const issues: RecoveryReport["blobIssues"] = [];
    for (const reference of references) {
      try {
        const path = this.blobPath(reference.hash);
        const info = await lstat(path);
        const actual = await realpath(path);
        if (!info.isFile() || !actual.startsWith(`${blobRoot}${sep}`)) {
          issues.push({ hash: reference.hash, reason: "INVALID_PATH" });
        } else if (info.size !== reference.sizeBytes) {
          issues.push({ hash: reference.hash, reason: "SIZE_MISMATCH" });
        } else if ((await this.fileHash(actual)) !== reference.hash) {
          issues.push({ hash: reference.hash, reason: "HASH_MISMATCH" });
        }
      } catch (error) {
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
        issues.push({ hash: reference.hash, reason: missing ? "MISSING" : "INVALID_PATH" });
      }
    }
    return issues;
  }

  /** 取得本机单实例文件锁并返回释放方法。 */
  async acquireLease(): Promise<() => Promise<void>> {
    // 数据目录同一时间只允许一个 Host，遗留锁仅在旧 PID 已退出时清理。
    const leasePath = join(this.root, "host.lock");
    let handle: FileHandle;
    try {
      handle = await open(leasePath, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const previousPid = Number(await readFile(leasePath, "utf8"));
      if (Number.isSafeInteger(previousPid) && previousPid > 0) {
        try {
          process.kill(previousPid, 0);
          throw new Error(`数据目录已被 Host ${previousPid} 使用`);
        } catch (checkError) {
          if (!(checkError instanceof Error) || !("code" in checkError) || checkError.code !== "ESRCH")
            throw checkError;
        }
      }
      await rm(leasePath);
      handle = await open(leasePath, "wx", 0o600);
    }
    await handle.writeFile(String(process.pid));
    return async () => {
      await handle.close();
      await rm(leasePath, { force: true });
    };
  }

  /** 清洗上传文件标题，避免路径和控制字符进入元数据。 */
  safeTitle(input: string): string {
    return (
      basename(input)
        .replace(/[\r\n\t]/g, " ")
        .slice(0, 120) || "file"
    );
  }
}

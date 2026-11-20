import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const FILE_NAME = "secrets.enc";
// AAD 固定密文用途，避免其他 AES-GCM 数据被当作本文件解密。
const AAD = Buffer.from("zhiban-secret-store-v1");

interface EncryptedFile {
  version: 1;
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface SecretStorePort {
  /** 读取指定键对应的已保存密钥。 */
  get(key: string): Promise<string | undefined>;
  /** 更新单个密钥并原子持久化。 */
  set(key: string, value: string): Promise<void>;
  /** 删除指定密钥并原子持久化。 */
  delete(key: string): Promise<void>;
}

/** 判断密钥文件缺失错误，区别于权限或内容损坏。 */
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 由主密钥和随机盐派生本地加密密钥。 */
function secretKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, 32);
}

/** 解密并校验持久化的模型密钥集合。 */
function parseSecrets(text: string, masterKey: string): { salt: Buffer; values: Record<string, string> } {
  try {
    const envelope = JSON.parse(text) as EncryptedFile;
    if (envelope.version !== 1) throw new Error("UNSUPPORTED_SECRET_STORE_VERSION");
    const salt = Buffer.from(envelope.salt, "base64url");
    const nonce = Buffer.from(envelope.nonce, "base64url");
    const tag = Buffer.from(envelope.tag, "base64url");
    if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16) throw new Error("INVALID_SECRET_STORE");
    const decipher = createDecipheriv("aes-256-gcm", secretKey(masterKey, salt), nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
    const values = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("INVALID_SECRET_STORE");
    if (Object.values(values).some((value) => typeof value !== "string")) throw new Error("INVALID_SECRET_STORE");
    return { salt, values: values as Record<string, string> };
  } catch {
    // 错误密钥、密文损坏和格式错误统一表现为解锁失败。
    throw new Error("SECRET_STORE_UNLOCK_FAILED");
  }
}

/** 使用主密钥加密本机配置；未提供主密钥时可识别锁定状态。 */
export class EncryptedSecretStore implements SecretStorePort {
  readonly locked: boolean;
  private readonly path: string;
  private readonly masterKey: string | null;
  private readonly salt: Buffer;
  private values: Record<string, string>;
  private pending = Promise.resolve();

  /** 保存密钥文件路径、主密钥和当前已解密值。 */
  private constructor(
    path: string,
    masterKey: string | null,
    salt: Buffer,
    values: Record<string, string>,
    locked: boolean,
  ) {
    this.path = path;
    this.masterKey = masterKey;
    this.salt = salt;
    this.values = values;
    this.locked = locked;
  }

  /** 打开或初始化本地加密密钥存储。 */
  static async open(dataDir: string, masterKey: string | undefined): Promise<EncryptedSecretStore> {
    const path = join(dataDir, FILE_NAME);
    let text: string | null = null;
    try {
      if (!(await lstat(path)).isFile()) throw new Error("INVALID_SECRET_STORE");
      text = await readFile(path, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (text === null) return new EncryptedSecretStore(path, masterKey || null, randomBytes(16), {}, false);
    if (!masterKey) return new EncryptedSecretStore(path, null, Buffer.alloc(0), {}, true);
    const { salt, values } = parseSecrets(text, masterKey);
    return new EncryptedSecretStore(path, masterKey, salt, values, false);
  }

  /** 读取指定键对应的已保存密钥。 */
  async get(key: string): Promise<string | undefined> {
    // 进程环境优先，便于临时覆盖本机保存值。
    return process.env[`ZHIBAN_${key}`] ?? this.values[key];
  }

  /** 提供已加载密钥的只读快照供配置合并。 */
  savedValues(): Readonly<Record<string, string>> {
    return { ...this.values };
  }

  /** 更新单个密钥并原子持久化。 */
  async set(key: string, value: string): Promise<void> {
    await this.setMany({ [key]: value });
  }

  /** 删除指定密钥并原子持久化。 */
  async delete(key: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) throw new Error("INVALID_SECRET_KEY");
    await this.modify((values) => {
      delete values[key];
    });
  }

  /** 一次写入多个模型密钥，避免部分配置落盘。 */
  async setMany(entries: Record<string, string>): Promise<void> {
    if (Object.keys(entries).some((key) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key))) throw new Error("INVALID_SECRET_KEY");
    if (Object.values(entries).some((value) => typeof value !== "string")) throw new Error("INVALID_SECRET_VALUE");
    await this.modify((values) => Object.assign(values, entries));
  }

  /** 串行加密并原子替换密钥文件，避免并发写入覆盖。 */
  private async modify(change: (values: Record<string, string>) => void): Promise<void> {
    const masterKey = this.masterKey;
    if (!masterKey) throw new Error("SECRET_STORE_LOCKED");
    // 串行写入并用临时文件替换，避免并发覆盖或留下半份密文。
    const job = this.pending.then(async () => {
      const next = { ...this.values };
      change(next);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secretKey(masterKey, this.salt), nonce);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(next), "utf8"), cipher.final()]);
      const envelope: EncryptedFile = {
        version: 1,
        salt: this.salt.toString("base64url"),
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      };
      const tempPath = join(dirname(this.path), `.secrets-${randomUUID()}.tmp`);
      try {
        await writeFile(tempPath, JSON.stringify(envelope), { flag: "wx", mode: 0o600 });
        await rename(tempPath, this.path);
      } catch (error) {
        await rm(tempPath, { force: true });
        throw error;
      }
      this.values = next;
    });
    this.pending = job.catch(() => {});
    await job;
  }
}

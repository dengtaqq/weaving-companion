import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PAIRING_CODE } from "../../shared/contracts.js";

const COOKIE_NAME = "zhiban_session";

/** 以恒定时间比较配对凭据，避免泄露匹配长度。 */
function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 管理本机固定配对码、会话 Cookie 和短期 SSE 凭证。 */
export class PairingService {
  private readonly secret: Buffer;
  private readonly connectionTokens = new Map<string, { cookie: string; expiresAt: number }>();

  /** 保存配对签名密钥并初始化短期连接令牌集合。 */
  private constructor(secret: Buffer) {
    this.secret = secret;
  }

  /** 从本地目录读取或生成配对签名密钥。 */
  static async create(dataDir: string): Promise<PairingService> {
    const path = join(dataDir, "auth.key");
    let secret: Buffer;
    try {
      secret = await readFile(path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      secret = randomBytes(32);
      try {
        // 独占创建，防止并发启动时两个 Host 各自使用不同密钥。
        await writeFile(path, secret, { flag: "wx", mode: 0o600 });
      } catch (writeError) {
        if (!(writeError instanceof Error) || !("code" in writeError) || writeError.code !== "EEXIST") throw writeError;
        secret = await readFile(path);
      }
    }
    if (secret.length !== 32) throw new Error("本机配对密钥无效");
    return new PairingService(secret);
  }

  /** 返回当前 Host 启动时使用的本机配对码。 */
  get startupCode(): string {
    return DEFAULT_PAIRING_CODE;
  }

  /** 验证配对码并签发浏览器会话凭据。 */
  complete(code: string): string | null {
    if (!equalSecret(code, DEFAULT_PAIRING_CODE)) return null;
    const payload = Buffer.from(
      JSON.stringify({ issuedAt: Date.now(), nonce: randomBytes(16).toString("hex") }),
    ).toString("base64url");
    const signature = this.sign(payload);
    return `${payload}.${signature}`;
  }

  /** 生成带安全属性的本机配对 Cookie 响应头。 */
  cookieHeader(value: string): string {
    return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
  }

  /** 从请求 Cookie 中提取并验证配对凭据。 */
  readCookie(header: string | undefined): string | null {
    const value = header
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    if (!value) return null;
    const [payload, signature] = value.split(".");
    if (!payload || !signature || !equalSecret(this.sign(payload), signature)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as { issuedAt?: number };
      if (!parsed.issuedAt || Date.now() - parsed.issuedAt > 30 * 24 * 60 * 60_000) return null;
      return value;
    } catch {
      return null;
    }
  }

  /** 根据已配对凭据派生当前请求使用的 CSRF 令牌。 */
  csrfToken(cookie: string): string {
    return this.sign(`csrf:${cookie}`);
  }

  /** 核验写请求的 CSRF 令牌是否属于当前配对会话。 */
  verifyCsrf(cookie: string, token: string | undefined): boolean {
    return Boolean(token && equalSecret(this.csrfToken(cookie), token));
  }

  /** 签发短期 SSE 连接令牌。 */
  issueConnectionToken(cookie: string): string {
    // EventSource 不能携带 CSRF 头，连接使用已通过 CSRF 申请的 Cookie 绑定凭证。
    for (const [value, entry] of this.connectionTokens) {
      if (entry.expiresAt <= Date.now()) this.connectionTokens.delete(value);
    }
    const token = randomBytes(24).toString("base64url");
    this.connectionTokens.set(token, { cookie, expiresAt: Date.now() + 60_000 });
    return token;
  }

  /** 一次性消费并校验 SSE 连接令牌。 */
  consumeConnectionToken(cookie: string, token: string): boolean {
    const entry = this.connectionTokens.get(token);
    this.connectionTokens.delete(token);
    return Boolean(entry && entry.cookie === cookie && entry.expiresAt >= Date.now());
  }

  /** 使用 Host 私钥对本机凭据内容生成签名。 */
  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }
}

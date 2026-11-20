import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium } from "playwright-core";
import { collectPublicPage, publicPageUrl } from "./public-page-collector.js";
import { runXhsBrowserAction } from "./xhs-browser-actions.js";
import { collectXhsSearch, isXhsSearchUrl, xhsSearchUrl } from "./xhs-search-collector.js";

export type XhsLoginStatus = "UNCONFIGURED" | "AWAITING_LOGIN" | "VERIFYING" | "READY";

interface PendingLogin {
  context: BrowserContext;
  targetUrl: string;
  status: "AWAITING_LOGIN" | "VERIFYING";
}

/** 按会话 ID 摘要定位独立的浏览器授权目录。 */
function sessionDirectory(dataDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(dataDir, "browser-auth", "sessions", key);
}

/** 定位本会话的 Chrome 资料目录，避免跨会话复用登录态。 */
function profileDirectory(dataDir: string, sessionId: string): string {
  return join(sessionDirectory(dataDir, sessionId), "chrome-profile");
}

/** 只在用户确认且目标页真实可读后，才把会话资料目录标记为可供采集工具使用。 */
export async function authorizedXhsProfile(dataDir: string, sessionId: string): Promise<string | null> {
  try {
    const marker = JSON.parse(await readFile(join(sessionDirectory(dataDir, sessionId), "authorized.json"), "utf8"));
    return marker.sessionId === sessionId && marker.status === "READY" ? profileDirectory(dataDir, sessionId) : null;
  } catch {
    return null;
  }
}

export class XhsLoginService {
  private readonly pending = new Map<string, PendingLogin>();

  /** 绑定本机数据目录，为每个会话隔离浏览器授权资料。 */
  constructor(private readonly dataDir: string) {}

  /** 返回本会话小红书登录流程的当前状态。 */
  async status(sessionId: string): Promise<{ status: XhsLoginStatus; targetUrl: string | null }> {
    const pending = this.pending.get(sessionId);
    if (pending) return { status: pending.status, targetUrl: pending.targetUrl };
    return {
      status: (await authorizedXhsProfile(this.dataDir, sessionId)) ? "READY" : "UNCONFIGURED",
      targetUrl: null,
    };
  }

  /** 校验目标链接并打开当前会话专属的可见 Chrome。 */
  async start(sessionId: string, value: string): Promise<{ status: XhsLoginStatus; targetUrl: string }> {
    const target = publicPageUrl(value);
    const targetUrl = isXhsSearchUrl(target.toString())
      ? xhsSearchUrl(target.searchParams.get("keyword") ?? "生活")
      : target.toString();
    const existing = this.pending.get(sessionId);
    if (existing) {
      if (existing.targetUrl !== targetUrl) throw new Error("XHS_LOGIN_IN_PROGRESS");
      return { status: existing.status, targetUrl };
    }
    const profileDir = profileDirectory(this.dataDir, sessionId);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    // 开始新授权即撤销旧标记；未完成目标页复核前采集工具不能复用这个目录。
    await rm(join(sessionDirectory(this.dataDir, sessionId), "authorized.json"), { force: true });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel: "chrome",
        headless: false,
        acceptDownloads: false,
        locale: "zh-CN",
        viewport: null,
      });
    } catch {
      throw new Error("AUTH_PROFILE_UNAVAILABLE");
    }
    try {
      // 登录窗口的所有请求都留在站点域名白名单内，包括页面跳转与子资源。
      await context.route("**/*", async (route) => {
        const requested = route.request().url();
        if (requested.startsWith("data:") || requested.startsWith("blob:")) return route.continue();
        try {
          const url = new URL(requested);
          const host = url.hostname.toLowerCase();
          if (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            ["xiaohongshu.com", "xhslink.com", "xhslink.cn", "xhscdn.com"].some(
              (domain) => host === domain || host.endsWith(`.${domain}`),
            )
          )
            return route.continue();
        } catch {
          // 登录窗口不能访问其他站点或本机地址。
        }
        return route.abort();
      });
    } catch {
      await context.close().catch(() => {});
      throw new Error("XHS_LOGIN_BROWSER_FAILED");
    }
    this.pending.set(sessionId, { context, targetUrl, status: "AWAITING_LOGIN" });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await runXhsBrowserAction(() => page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }));
    } catch {
      // 页面暂不可达时仍让用户在 Chrome 中完成登录；确认时再严格复核目标页。
    }
    return { status: "AWAITING_LOGIN", targetUrl };
  }

  /** 结束登录窗口、验证目标页可读并写入授权标记。 */
  async confirm(sessionId: string): Promise<{ status: "READY"; targetUrl: string }> {
    const pending = this.pending.get(sessionId);
    if (pending?.status !== "AWAITING_LOGIN") throw new Error("XHS_LOGIN_NOT_PENDING");
    pending.status = "VERIFYING";
    try {
      await pending.context.close().catch(() => {});
      const target = new URL(pending.targetUrl);
      const profile = profileDirectory(this.dataDir, sessionId);
      const result = isXhsSearchUrl(target.toString())
        ? await collectXhsSearch(target.searchParams.get("keyword") ?? "生活", undefined, profile)
        : await collectPublicPage(pending.targetUrl, undefined, profile);
      if (result.status !== "COLLECTED") throw new Error(result.errorCode ?? "XHS_LOGIN_NOT_VERIFIED");
      // 用户确认只是触发复核；只有真实读取目标正文后才原子授予会话采集权。
      const directory = sessionDirectory(this.dataDir, sessionId);
      const marker = join(directory, "authorized.json");
      const temporary = join(directory, `authorized-${process.pid}.tmp`);
      await writeFile(
        temporary,
        JSON.stringify({ sessionId, status: "READY", confirmedAt: new Date().toISOString() }),
        {
          mode: 0o600,
        },
      );
      await rename(temporary, marker);
      return { status: "READY", targetUrl: pending.targetUrl };
    } finally {
      this.pending.delete(sessionId);
    }
  }

  /** 撤销待确认登录并关闭该会话的浏览器窗口。 */
  async cancel(sessionId: string): Promise<void> {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    if (pending.status === "VERIFYING") throw new Error("XHS_LOGIN_IN_PROGRESS");
    this.pending.delete(sessionId);
    await pending.context.close().catch(() => {});
  }

  /** 关闭所有尚未确认的会话浏览器窗口。 */
  async close(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((sessionId) => this.cancel(sessionId)));
  }
}

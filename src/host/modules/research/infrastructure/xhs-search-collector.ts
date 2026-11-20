import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, type BrowserContext, chromium } from "playwright-core";
import { bindCollectionCleanup } from "./collection-browser-cleanup.js";
import type { CollectedPublicPage } from "./public-page-collector.js";
import { isPublicNoteUrl, publicPageUrl } from "./public-page-collector.js";
import { runXhsBrowserAction } from "./xhs-browser-actions.js";

const SEARCH_URL = "https://www.xiaohongshu.com/search_result/";
const MAX_SEARCH_NOTES = 5;
const MAX_SEARCH_TEXT = 24_000;

/** 只接受短关键词，避免模型把网址或整段提示词当成搜索条件。 */
export function xhsSearchKeyword(value: string): string {
  if (/[\r\n<>]/.test(value) || /https?:\/\//i.test(value)) throw new Error("XHS_SEARCH_KEYWORD_INVALID");
  const keyword = value.trim().replace(/\s+/g, " ");
  if (!keyword || keyword.length > 80) {
    throw new Error("XHS_SEARCH_KEYWORD_INVALID");
  }
  return keyword;
}

/** 为一次研究生成稳定的站内搜索地址；URL 仅由 Host 构造。 */
export function xhsSearchUrl(keyword: string): string {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("keyword", xhsSearchKeyword(keyword));
  return url.toString();
}

/** 识别站内搜索页的新旧路径形式，避免正常尾斜杠跳转被误判为不可用。 */
export function isXhsSearchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.hostname === "www.xiaohongshu.com" && /^\/search_result\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** 从实际可见的搜索结果卡片中取得可访问的笔记链接。 */
async function visibleNoteLinks(page: import("playwright-core").Page, signal?: AbortSignal) {
  const links: CollectedPublicPage["links"] = [];
  const seenPaths = new Set<string>();
  const cards = page.locator("section.note-item");
  const count = Math.min(await cards.count(), MAX_SEARCH_NOTES);
  const searchUrl = page.url();
  for (let index = 0; index < count; index++) {
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    try {
      const card = cards.nth(index);
      const rawLink = await card
        .locator('a[href*="/explore/"], a[href*="/discovery/item/"]')
        .first()
        .getAttribute("href");
      if (!rawLink) continue;
      const cardText = (await card.innerText({ timeout: 2_000 })).slice(0, 180);
      const notePath = new URL(rawLink, searchUrl).pathname;
      await runXhsBrowserAction(() => card.click({ timeout: 5_000 }), signal);
      await page.waitForURL((url) => url.pathname === notePath, { timeout: 5_000 });
      const noteUrl = publicPageUrl(page.url());
      if (
        isPublicNoteUrl(noteUrl.toString()) &&
        noteUrl.searchParams.has("xsec_token") &&
        !seenPaths.has(noteUrl.pathname)
      ) {
        seenPaths.add(noteUrl.pathname);
        links.push({ text: cardText, url: noteUrl.toString() });
      }
    } catch {
      if (signal?.aborted) throw new Error("TOOL_ABORTED");
      // 单张卡片无法打开时保留其他已取得的结果，最终覆盖数由返回值说明。
    } finally {
      if (!signal?.aborted && page.url() !== searchUrl) {
        await runXhsBrowserAction(() => page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }), signal).catch(
          () =>
            runXhsBrowserAction(() => page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }), signal),
        );
      }
    }
  }
  return links;
}

/** 通过站内可见搜索页采集有限样本，登录或风控失败时保留失败证据。 */
export async function collectXhsSearch(
  keyword: string,
  signal?: AbortSignal,
  authorizedProfileDir?: string,
): Promise<CollectedPublicPage> {
  const sourceUrl = xhsSearchUrl(keyword);
  if (signal?.aborted) throw new Error("TOOL_ABORTED");
  const collectedAt = new Date().toISOString();
  const accessMode = authorizedProfileDir ? "USER_AUTHORIZED" : "PUBLIC_UNAUTHENTICATED";
  let browser: Browser | null = null;
  let context: BrowserContext;
  try {
    if (authorizedProfileDir) {
      const profileDir = resolve(authorizedProfileDir);
      if (!(await stat(profileDir)).isDirectory()) throw new Error("AUTH_PROFILE_UNAVAILABLE");
      context = await chromium.launchPersistentContext(profileDir, {
        timeout: 20_000,
        channel: "chrome",
        headless: false,
        acceptDownloads: false,
        locale: "zh-CN",
        viewport: null,
      });
    } else {
      browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 20_000 });
      context = await browser.newContext({ acceptDownloads: false, locale: "zh-CN" });
    }
  } catch {
    await browser?.close().catch(() => {});
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    return {
      sourceUrl,
      finalUrl: null,
      title: "",
      visibleText: "",
      links: [],
      status: "FAILED",
      errorCode: authorizedProfileDir ? "AUTH_PROFILE_UNAVAILABLE" : "BROWSER_UNAVAILABLE",
      collectedAt,
      accessMode,
    };
  }
  const cleanup = bindCollectionCleanup(browser, context, signal);
  try {
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) return route.continue();
      try {
        const url = new URL(requestUrl);
        const host = url.hostname.toLowerCase();
        if (
          url.protocol === "https:" &&
          ["xiaohongshu.com", "xhscdn.com"].some((domain) => host === domain || host.endsWith(`.${domain}`)) &&
          route.request().resourceType() !== "media"
        )
          return route.continue();
      } catch {
        // 页面资源限制在小红书域名内。
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.dismiss());
    const response = await runXhsBrowserAction(
      () => page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }),
      signal,
    );
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    const initialText = (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    )
      .trim()
      .slice(0, MAX_SEARCH_TEXT);
    if (isXhsSearchUrl(page.url()) && !/IP存在风险|访问异常|扫码登录|登录后查看/.test(initialText.slice(0, 500))) {
      await page
        .locator("section.note-item")
        .first()
        .waitFor({ state: "visible", timeout: 5_000 })
        .catch(() => {});
    }
    const finalUrl = page.url();
    // 后续点击卡片会改变 document.title，必须先固定搜索页标题，避免把详情标题误记为搜索来源。
    const title = (await page.title()).slice(0, 300);
    const text = (
      await page
        .locator("body")
        .innerText()
        .catch(() => initialText)
    )
      .trim()
      .slice(0, MAX_SEARCH_TEXT);
    const restricted =
      /\/(?:website-login|login|captcha|verify)(?:\/|$)/i.test(new URL(finalUrl).pathname) ||
      /IP存在风险|访问异常|扫码登录|登录后查看/.test(text.slice(0, 500));
    const validPage = isXhsSearchUrl(finalUrl);
    const links = !restricted && validPage ? await visibleNoteLinks(page, signal) : [];
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    const status: CollectedPublicPage["status"] = restricted
      ? "BLOCKED"
      : !validPage || (response && response.status() >= 400)
        ? "FAILED"
        : links.length
          ? "COLLECTED"
          : "LIMITED";
    return {
      sourceUrl,
      finalUrl,
      title,
      visibleText: text,
      links,
      status,
      errorCode:
        status === "BLOCKED"
          ? "ACCESS_RESTRICTED"
          : status === "FAILED"
            ? "SEARCH_PAGE_UNAVAILABLE"
            : status === "LIMITED"
              ? "NO_VISIBLE_NOTES"
              : null,
      collectedAt,
      accessMode,
    };
  } catch (error) {
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    return {
      sourceUrl,
      finalUrl: null,
      title: "",
      visibleText: "",
      links: [],
      status: "FAILED",
      errorCode: error instanceof Error && error.name === "TimeoutError" ? "PAGE_TIMEOUT" : "PAGE_LOAD_FAILED",
      collectedAt,
      accessMode,
    };
  } finally {
    await cleanup();
  }
}

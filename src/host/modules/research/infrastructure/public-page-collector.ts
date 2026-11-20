import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import type { PublicPageEvidenceImage } from "../../../../shared/contracts.js";
import { bindCollectionCleanup } from "./collection-browser-cleanup.js";
import { runXhsBrowserAction } from "./xhs-browser-actions.js";

export interface CollectedPublicPage {
  sourceUrl: string;
  finalUrl: string | null;
  title: string;
  visibleText: string;
  links: Array<{ text: string; url: string }>;
  status: "COLLECTED" | "LIMITED" | "BLOCKED" | "FAILED";
  errorCode: string | null;
  collectedAt: string;
  accessMode: "PUBLIC_UNAUTHENTICATED" | "USER_AUTHORIZED";
  imageCaptures?: Array<{ bytes: Uint8Array; description: string }>;
  images?: PublicPageEvidenceImage[];
  imageCaptureError?: string;
}

const MAX_VISIBLE_CHARACTERS = 24_000;
const MAX_LINKS = 40;
const NAVIGATION_TIMEOUT_MS = 20_000;
const COMMENT_LOAD_WAIT_MS = 1_500;
const MAX_PROFILE_NOTES = 5;

/** 只截取当前内容区实际加载的图片；不点击轮播、不下载任意资源或截取整个登录页面。 */
export async function capturePublicPageImages(
  page: Page,
  profile: boolean,
  signal?: AbortSignal,
): Promise<Pick<CollectedPublicPage, "imageCaptures" | "imageCaptureError">> {
  const candidates = page.locator(
    profile
      ? "section.note-item .cover img, section.note-item a.cover img"
      : ".note-detail-mask .swiper-slide-active img, .note-container .swiper-slide-active img, .note-slider .swiper-slide-active img, .media-container img, #noteContainer .note-content img",
  );
  const imageCaptures: NonNullable<CollectedPublicPage["imageCaptures"]> = [];
  const limit = profile ? 3 : 1;
  let failed = false;
  for (let index = 0; index < Math.min(await candidates.count(), 20) && imageCaptures.length < limit; index++) {
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    const image = candidates.nth(index);
    try {
      if (!(await image.isVisible())) continue;
      const loaded = await image.evaluate((element) => {
        const img = element as HTMLImageElement;
        return img.complete && img.naturalWidth >= 160 && img.naturalHeight >= 160;
      });
      if (!loaded) continue;
      const bytes = await runXhsBrowserAction(
        () => image.screenshot({ type: "png", timeout: 3_000, animations: "disabled", scale: "css" }),
        signal,
      );
      if (!bytes.length || bytes.length > 2 * 1024 * 1024) {
        failed = true;
        continue;
      }
      imageCaptures.push({
        bytes,
        description: profile
          ? `主页可见笔记封面截图 ${imageCaptures.length + 1}`
          : "笔记当前可见主图截图（不含全部轮播图）",
      });
    } catch {
      if (signal?.aborted) throw new Error("TOOL_ABORTED");
      failed = true;
    }
  }
  return {
    imageCaptures,
    ...(!imageCaptures.length && { imageCaptureError: failed ? "IMAGE_CAPTURE_FAILED" : "IMAGE_NOT_VISIBLE" }),
  };
}

/** 判断页面域名是否属于允许采集的小红书站点。 */
function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ["xiaohongshu.com", "xhslink.com", "xhslink.cn"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/** 判断浏览器加载的子资源是否属于允许域名。 */
function isAllowedResourceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isAllowedHost(host) || host === "xhscdn.com" || host.endsWith(".xhscdn.com");
}

/** 确认短链最终落在账号主页或笔记详情，而不是站点首页、登录壳或 404 页面。 */
function isSupportedContentPage(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host !== "xiaohongshu.com" && !host.endsWith(".xiaohongshu.com")) return false;
  return /^\/(?:user\/profile|explore|discovery\/item)\/[^/]+$/i.test(url.pathname.replace(/\/+$/, ""));
}

/** 判断账号页发现的链接是否是可读取的笔记详情页。 */
export function isPublicNoteUrl(value: string): boolean {
  try {
    const url = publicPageUrl(value);
    return (
      (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com")) &&
      /^\/(?:explore|discovery\/item)\/[^/]+$/i.test(url.pathname.replace(/\/+$/, ""))
    );
  } catch {
    return false;
  }
}

/** 判断最终页面是否是账号主页。 */
export function isPublicProfileUrl(value: string): boolean {
  try {
    const url = publicPageUrl(value);
    return (
      (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com")) &&
      /^\/user\/profile\/[^/]+$/i.test(url.pathname.replace(/\/+$/, ""))
    );
  } catch {
    return false;
  }
}

/** 解析并校验本轮明确授权的小红书 HTTPS 链接。 */
export function publicPageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_PAGE_URL_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password || !isAllowedHost(url.hostname)) {
    throw new Error("PUBLIC_PAGE_URL_NOT_ALLOWED");
  }
  url.hash = "";
  return url;
}

/** 在授权主页逐张打开前五个笔记卡片，取得站点生成的可访问详情链接。 */
async function discoverProfileNoteLinks(
  page: Page,
  profileUrl: string,
  signal?: AbortSignal,
): Promise<Array<{ text: string; url: string }>> {
  const links: Array<{ text: string; url: string }> = [];
  const cards = page.locator("section.note-item");
  const count = Math.min(await cards.count(), MAX_PROFILE_NOTES);
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
      const notePath = new URL(rawLink, profileUrl).pathname;
      await runXhsBrowserAction(() => card.click({ timeout: 5_000 }), signal);
      await page.waitForURL((url) => url.pathname === notePath, { timeout: 5_000 });
      const signedUrl = publicPageUrl(page.url());
      if (isPublicNoteUrl(signedUrl.toString()) && signedUrl.searchParams.has("xsec_token")) {
        links.push({ text: cardText, url: signedUrl.toString() });
      }
    } catch {
      if (signal?.aborted) throw new Error("TOOL_ABORTED");
      // 单张卡片失败不把整个主页误判为采集失败；只返回成功打开的笔记。
    } finally {
      if (!signal?.aborted && page.url() !== profileUrl) {
        await runXhsBrowserAction(() => page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }), signal).catch(
          () =>
            runXhsBrowserAction(
              () => page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
              signal,
            ),
        );
      }
    }
  }
  return links;
}

/** 只读取用户给定链接；可选复用用户在本机 Chrome 独立资料目录中的授权登录态。 */
export async function collectPublicPage(
  value: string,
  signal?: AbortSignal,
  authorizedProfileDir?: string,
  discoverNotes = false,
  includeImages = false,
): Promise<CollectedPublicPage> {
  const sourceUrl = publicPageUrl(value).toString();
  if (signal?.aborted) throw new Error("TOOL_ABORTED");
  const collectedAt = new Date().toISOString();
  const accessMode = authorizedProfileDir ? "USER_AUTHORIZED" : "PUBLIC_UNAUTHENTICATED";
  let browser: Browser | null = null;
  let context: BrowserContext;
  try {
    // 仅明确授权过的会话复用持久资料目录；普通采集使用无登录态的临时上下文。
    if (authorizedProfileDir) {
      const profileDir = resolve(authorizedProfileDir);
      if (!(await stat(profileDir)).isDirectory()) throw new Error("AUTH_PROFILE_UNAVAILABLE");
      context = await chromium.launchPersistentContext(profileDir, {
        timeout: NAVIGATION_TIMEOUT_MS,
        channel: "chrome",
        headless: false,
        acceptDownloads: false,
        locale: "zh-CN",
        viewport: null,
      });
    } else {
      browser = await chromium.launch({ channel: "chrome", headless: true, timeout: NAVIGATION_TIMEOUT_MS });
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
        if (
          url.protocol === "https:" &&
          isAllowedResourceHost(url.hostname) &&
          route.request().resourceType() !== "media"
        )
          return route.continue();
      } catch {
        // 页面内链接和资源不扩大本轮允许的域名范围。
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.dismiss());
    const response = await runXhsBrowserAction(
      () => page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
      signal,
    );
    if (signal?.aborted) throw new Error("TOOL_ABORTED");
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
    const finalUrl = page.url();
    // 跳转后的最终地址也必须仍是允许的页面，不能只验证用户最初给出的 URL。
    const finalPage = publicPageUrl(finalUrl);
    if (isPublicNoteUrl(finalUrl)) {
      // 笔记评论常在正文加载后才出现；只滚动当前详情页，不点击回复或翻页。
      await runXhsBrowserAction(
        () =>
          page.evaluate(() => {
            const comments = document.querySelector(
              "#commentContainer, #commentArea, .comments-container, .comment-container",
            );
            comments?.scrollIntoView({ block: "center" });
            if (!comments) window.scrollTo(0, document.body.scrollHeight);
          }),
        signal,
      );
      await page.waitForTimeout(COMMENT_LOAD_WAIT_MS);
    }
    const observed = await page.evaluate(
      (maxLinks) => ({
        title: document.title,
        text: document.body?.innerText ?? "",
        commentText:
          document
            .querySelector<HTMLElement>("#commentContainer, #commentArea, .comments-container, .comment-container")
            ?.innerText?.trim() ?? "",
        links: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .filter((anchor) => anchor.href.startsWith("https://"))
          .map((anchor) => ({ text: anchor.innerText.trim().slice(0, 180), url: anchor.href }))
          .filter(
            (link) => link.text || /^https:\/\/[^/]*xiaohongshu\.com\/(?:explore|discovery\/item)\//i.test(link.url),
          )
          .sort((left, right) => {
            /** 把正文卡片链接排在导航链接前，保留同类链接的页面顺序。 */
            const noteLink = (url: string) =>
              /^https:\/\/[^/]*xiaohongshu\.com\/(?:explore|discovery\/item)\//i.test(url);
            return Number(noteLink(right.url)) - Number(noteLink(left.url));
          })
          .slice(0, maxLinks),
      }),
      MAX_LINKS,
    );
    if (discoverNotes && isPublicProfileUrl(finalUrl)) {
      const signedNotes = await discoverProfileNoteLinks(page, finalUrl, signal);
      // 主页 DOM 里的无签名 href 会落到 404；只把实际点击取得的详情链接交给后续取证。
      observed.links = [...signedNotes, ...observed.links.filter((link) => !isPublicNoteUrl(link.url))].slice(
        0,
        MAX_LINKS,
      );
    }
    const pageText = observed.text.trim();
    const commentExcerpt = observed.commentText.slice(0, 4_000);
    const visibleText = (
      commentExcerpt ? `${pageText.slice(0, 19_000)}\n\n[本页实际加载的评论区摘录]\n${commentExcerpt}` : pageText
    ).slice(0, MAX_VISIBLE_CHARACTERS);
    // 登录墙、风控页与短正文分别标记，避免把不可见内容误写为成功证据。
    const accessRestricted =
      /\/(?:website-login|login|captcha|verify)(?:\/|$)/i.test(new URL(finalUrl).pathname) ||
      (visibleText.length < 200 && /扫码登录|登录后查看|登录后查看更多|IP存在风险|访问异常/.test(visibleText));
    // 站点 404 或导航壳也可能有很长的公共页脚；正文长度不能单独证明账号/笔记可见。
    const hasContentPage = isSupportedContentPage(finalPage);
    const status = accessRestricted
      ? "BLOCKED"
      : (response && response.status() >= 400) || !hasContentPage
        ? "FAILED"
        : visibleText.length >= 120
          ? "COLLECTED"
          : "LIMITED";
    const imageResult =
      includeImages && ["COLLECTED", "LIMITED"].includes(status)
        ? await capturePublicPageImages(page, isPublicProfileUrl(finalUrl), signal)
        : includeImages
          ? { imageCaptureError: "PAGE_NOT_ACCESSIBLE" }
          : {};
    return {
      sourceUrl,
      finalUrl,
      title: observed.title.slice(0, 300),
      visibleText,
      links: observed.links.filter((link) => {
        try {
          publicPageUrl(link.url);
          return true;
        } catch {
          return false;
        }
      }),
      status,
      errorCode:
        status === "BLOCKED"
          ? "ACCESS_RESTRICTED"
          : status === "FAILED"
            ? hasContentPage
              ? "HTTP_ERROR"
              : "CONTENT_NOT_VISIBLE"
            : status === "LIMITED"
              ? "CONTENT_NOT_VISIBLE"
              : null,
      collectedAt,
      accessMode,
      ...imageResult,
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
      errorCode:
        error instanceof Error && error.message === "PUBLIC_PAGE_URL_NOT_ALLOWED"
          ? "REDIRECT_NOT_ALLOWED"
          : error instanceof Error && error.name === "TimeoutError"
            ? "PAGE_TIMEOUT"
            : "PAGE_LOAD_FAILED",
      collectedAt,
      accessMode,
    };
  } finally {
    await cleanup();
  }
}

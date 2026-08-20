import { chromium } from "playwright-core";

import {
  assertUsablePage,
  isXingtuMarketRedirect,
  manualBrowserError,
  pageMatches,
  PLATFORM_RULES,
} from "./common.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:18800";
const NAVIGATION_TIMEOUT_MS = 15_000;
const AUTH_BLOCKING_ERROR_CODES = new Set([
  "YPSCAN_MANUAL_LOGIN_REQUIRED",
  "YPSCAN_MANUAL_CAPTCHA_REQUIRED",
]);

function isAuthBlockingError(error) {
  return AUTH_BLOCKING_ERROR_CODES.has(error?.code);
}

/** Enter the Xingtu workspace when the public landing page already shows an authenticated account. */
async function enterAuthenticatedXingtuWorkspace(page) {
  if (!isXingtuMarketRedirect(page.url()) || typeof page.locator !== "function") return false;
  const account = page
    .locator(".user-info:visible")
    .filter({ hasText: /ID\s*[:：]\s*\d+/u })
    .first();
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    if (await account.isVisible().catch(() => false)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/** Wait through Xingtu's client-side market → landing redirect before deciding login state. */
async function settleXingtuWorkspace(page) {
  if (typeof page.locator !== "function") return false;
  const started = Date.now();
  while (Date.now() - started < 12_000) {
    if (isXingtuMarketRedirect(page.url())) {
      if (await enterAuthenticatedXingtuWorkspace(page)) return true;
    } else if (pageMatches("xingtu", page.url())) {
      if (typeof page.getByPlaceholder !== "function") return false;
      const marketInput = page.getByPlaceholder(/按内容关键词找达人|内容关键词/u).first();
      if (await marketInput.isVisible().catch(() => false)) return false;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

function connected(browser) {
  return typeof browser?.isConnected !== "function" || browser.isConnected();
}

async function navigateOnce(page, platform) {
  const target = PLATFORM_RULES[platform];
  try {
    await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    return page;
  } catch (error) {
    await page.bringToFront?.().catch(() => {});
    try {
      await assertUsablePage(page, platform);
      return page;
    } catch (pageError) {
      if (isAuthBlockingError(pageError)) throw pageError;
    }
    throw manualBrowserError(
      "YPSCAN_MANUAL_PAGE_OPEN_FAILED",
      `打开${platform === "xingtu" ? "星图" : "蒲公英"}达人广场失败`,
      {
        target_url: target.url,
        page_url: page.url?.() ?? null,
        reason: error?.message ?? String(error),
      },
    );
  }
}

async function openMarketPage(context, platform, reopen = false) {
  if (reopen) return navigateOnce(await context.newPage(), platform);
  const pages = context.pages();
  let page = pages.find((item) => pageMatches(platform, item.url()));
  if (page) return page;

  page = pages.find((item) => item.url() === "about:blank") ?? (await context.newPage());
  try {
    return await navigateOnce(page, platform);
  } catch (firstError) {
    if (isAuthBlockingError(firstError)) throw firstError;
    const retryPage = await context.newPage();
    try {
      return await navigateOnce(retryPage, platform);
    } catch (secondError) {
      await retryPage.bringToFront?.().catch(() => {});
      throw secondError;
    }
  }
}

/** Connect to the host Browser so Runner and Browser use the same profile and cookies. */
export function createManualBrowserRuntime({
  browserCdpUrl = DEFAULT_CDP_URL,
  connectOverCDP = (endpointURL, options) => chromium.connectOverCDP(endpointURL, options),
} = {}) {
  const endpointURL =
    String(browserCdpUrl ?? "")
      .trim()
      .replace(/\/+$/u, "") || DEFAULT_CDP_URL;
  let browser = null;
  let activeRunId = null;

  async function hostBrowser() {
    if (browser && connected(browser)) return browser;
    browser = null;
    try {
      browser = await connectOverCDP(endpointURL, { noDefaults: true });
      return browser;
    } catch (error) {
      throw manualBrowserError(
        "YPSCAN_MANUAL_BROWSER_UNAVAILABLE",
        "无法连接宿主 Browser，请先在 YP Action 中打开 Browser 后继续",
        { cdp_url: endpointURL, reason: error?.message ?? String(error) },
      );
    }
  }

  return {
    browser_cdp_url: endpointURL,
    acquire(runId) {
      if (activeRunId) return { acquired: false, active_run_id: activeRunId };
      activeRunId = runId;
      return {
        acquired: true,
        release() {
          if (activeRunId === runId) activeRunId = null;
        },
      };
    },
    async page(platform, { reopen = false } = {}) {
      const current = await hostBrowser();
      const context = current.contexts()[0];
      if (!context) {
        browser = null;
        throw manualBrowserError(
          "YPSCAN_MANUAL_BROWSER_UNAVAILABLE",
          "宿主 Browser 尚未创建可用页面上下文，请打开 Browser 后继续",
        );
      }
      let page = await openMarketPage(context, platform, reopen);
      if (platform === "xingtu" && (await settleXingtuWorkspace(page))) {
        page = await context.newPage();
        page = await navigateOnce(page, platform);
      }
      await page.bringToFront?.().catch(() => {});
      return page;
    },
    async close() {
      // The host owns the Browser process. Never close it from the plugin.
      browser = null;
      activeRunId = null;
    },
  };
}

export { DEFAULT_CDP_URL as DEFAULT_BROWSER_CDP_URL };

import { chmod, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { chromium } from "playwright-core";

import { manualBrowserError, pageMatches, PLATFORM_RULES } from "./common.js";

const DEFAULT_PROFILE_DIR = join(homedir(), ".ypscan", "browser-profile");

function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function prepareProfile(profileDir, workspaceDir) {
  if (!isAbsolute(profileDir)) {
    throw manualBrowserError(
      "YPSCAN_MANUAL_PROFILE_INVALID",
      "manualBrowserProfileDir 必须是绝对路径",
    );
  }
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
  const resolved = await realpath(profileDir);
  if (workspaceDir) {
    const workspace = await realpath(workspaceDir);
    if (inside(workspace, resolved)) {
      throw manualBrowserError(
        "YPSCAN_MANUAL_PROFILE_INVALID",
        "浏览器 Profile 不得保存在项目工作区内",
      );
    }
  }
  return resolved;
}

async function launchContext(launcher, profileDir) {
  const options = {
    channel: "chrome",
    headless: false,
    viewport: null,
    acceptDownloads: true,
  };
  try {
    return await launcher.launchPersistentContext(profileDir, options);
  } catch (chromeError) {
    try {
      return await launcher.launchPersistentContext(profileDir, {
        headless: false,
        viewport: null,
        acceptDownloads: true,
      });
    } catch (chromiumError) {
      throw manualBrowserError(
        "YPSCAN_MANUAL_BROWSER_UNAVAILABLE",
        "无法启动手扒专用 Chrome",
        {
          chrome: chromeError?.message ?? String(chromeError),
          chromium: chromiumError?.message ?? String(chromiumError),
        },
      );
    }
  }
}

/** Create one persistent, serialized browser runtime for the gateway. */
export function createManualBrowserRuntime({
  profileDir = DEFAULT_PROFILE_DIR,
  launcher = chromium,
} = {}) {
  let context = null;
  let activeRunId = null;

  async function browserContext(workspaceDir) {
    if (context) return context;
    const resolvedProfile = await prepareProfile(profileDir, workspaceDir);
    context = await launchContext(launcher, resolvedProfile);
    context.setDefaultTimeout?.(6_000);
    context.setDefaultNavigationTimeout?.(15_000);
    context.once?.("close", () => {
      context = null;
    });
    return context;
  }

  return {
    profile_dir: profileDir,
    acquire(runId) {
      if (activeRunId) {
        return { acquired: false, active_run_id: activeRunId };
      }
      activeRunId = runId;
      return {
        acquired: true,
        release() {
          if (activeRunId === runId) activeRunId = null;
        },
      };
    },
    async page(platform, workspaceDir) {
      const current = await browserContext(workspaceDir);
      const target = PLATFORM_RULES[platform];
      let page = current.pages().find((item) => pageMatches(platform, item.url()));
      page ??= current.pages().find((item) => item.url() === "about:blank") ?? null;
      page ??= await current.newPage();
      if (!pageMatches(platform, page.url())) {
        await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      }
      await page.bringToFront().catch(() => {});
      return page;
    },
    async close() {
      const closing = context;
      context = null;
      activeRunId = null;
      await closing?.close().catch(() => {});
    },
  };
}

export { DEFAULT_PROFILE_DIR as DEFAULT_MANUAL_BROWSER_PROFILE_DIR };

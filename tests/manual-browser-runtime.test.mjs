import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManualBrowserRuntime } from "../src/tools/manual-research/browser-runtime.js";

function fakeLauncher(actions) {
  const page = {
    currentUrl: "about:blank",
    url() {
      return this.currentUrl;
    },
    async goto(url) {
      this.currentUrl = url;
      actions.push(["goto", url]);
    },
    async bringToFront() {},
  };
  const context = {
    pages: () => [page],
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    once() {},
    async close() {
      actions.push(["close"]);
    },
  };
  return {
    async launchPersistentContext(profileDir, options) {
      actions.push(["launch", profileDir, options.channel]);
      return context;
    },
  };
}

test("browser runtime uses a private persistent profile and serializes every run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ypscan-browser-runtime-"));
  const workspaceDir = join(root, "workspace");
  const profileDir = join(root, "profile");
  await mkdir(workspaceDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const actions = [];
  const runtime = createManualBrowserRuntime({ profileDir, launcher: fakeLauncher(actions) });

  const first = runtime.acquire("run-1");
  assert.equal(first.acquired, true);
  assert.deepEqual(runtime.acquire("run-1"), { acquired: false, active_run_id: "run-1" });
  assert.deepEqual(runtime.acquire("run-2"), { acquired: false, active_run_id: "run-1" });
  await runtime.page("xingtu", workspaceDir);
  assert.equal((await stat(profileDir)).mode & 0o777, 0o700);
  assert.deepEqual(actions[0], ["launch", await realpath(profileDir), "chrome"]);
  assert.deepEqual(actions[1], ["goto", "https://www.xingtu.cn/ad/creator/market"]);

  first.release();
  assert.equal(runtime.acquire("run-2").acquired, true);
  await runtime.close();
});

test("browser runtime rejects a profile stored inside the workspace", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-browser-workspace-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const runtime = createManualBrowserRuntime({
    profileDir: join(workspaceDir, "browser-profile"),
    launcher: fakeLauncher([]),
  });

  await assert.rejects(runtime.page("pgy", workspaceDir), {
    code: "YPSCAN_MANUAL_PROFILE_INVALID",
  });
});

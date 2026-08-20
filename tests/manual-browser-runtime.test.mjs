import assert from "node:assert/strict";
import test from "node:test";

import { createManualBrowserRuntime } from "../src/tools/manual-research/browser-runtime.js";

function locator({ body = "", accountVisible = false } = {}) {
  return {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    nth() {
      return this;
    },
    async count() {
      return 0;
    },
    async innerText() {
      return body;
    },
    async isVisible() {
      return accountVisible;
    },
  };
}

function fakePage(actions, options = {}) {
  const state = {
    url: options.url ?? "about:blank",
    gotoError: options.gotoError ?? null,
  };
  const pageLocator = locator(options);
  return {
    url: () => state.url,
    async goto(url) {
      actions.push(["goto", url]);
      if (state.gotoError) {
        state.url = options.gotoUrl ?? state.url;
        throw state.gotoError;
      }
      state.url = options.gotoUrl ?? url;
    },
    async bringToFront() {
      actions.push(["front", state.url]);
    },
    locator: () => pageLocator,
    getByPlaceholder: () => ({
      first() {
        return this;
      },
      async isVisible() {
        return options.marketInputVisible ?? false;
      },
    }),
    async waitForTimeout() {},
  };
}

function hostBrowser(pages, actions) {
  const context = {
    pages: () => pages,
    async newPage() {
      const page = fakePage(actions, { marketInputVisible: true });
      pages.push(page);
      actions.push(["new-page"]);
      return page;
    },
  };
  return {
    isConnected: () => true,
    contexts: () => [context],
    async close() {
      actions.push(["browser-close"]);
    },
  };
}

test("browser runtime reuses the host Browser profile and serializes every run", async () => {
  const actions = [];
  const pages = [fakePage(actions)];
  const browser = hostBrowser(pages, actions);
  const connections = [];
  const runtime = createManualBrowserRuntime({
    browserCdpUrl: "http://127.0.0.1:19999",
    async connectOverCDP(endpoint, options) {
      connections.push([endpoint, options]);
      return browser;
    },
  });

  const first = runtime.acquire("run-1");
  assert.equal(first.acquired, true);
  assert.deepEqual(runtime.acquire("run-1"), { acquired: false, active_run_id: "run-1" });
  assert.deepEqual(runtime.acquire("run-2"), { acquired: false, active_run_id: "run-1" });
  await runtime.page("pgy");
  await runtime.page("pgy");

  assert.deepEqual(connections, [["http://127.0.0.1:19999", { noDefaults: true }]]);
  assert.equal(pages.length, 1);
  assert.deepEqual(actions[0], ["goto", "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol"]);

  first.release();
  assert.equal(runtime.acquire("run-2").acquired, true);
  await runtime.close();
  assert.equal(
    actions.some(([kind]) => kind === "browser-close"),
    false,
  );
});

test("browser runtime retries a failed page open in a new host tab", async () => {
  const actions = [];
  const pages = [fakePage(actions, { gotoError: new Error("net::ERR_TIMED_OUT") })];
  const runtime = createManualBrowserRuntime({
    connectOverCDP: async () => hostBrowser(pages, actions),
  });

  const page = await runtime.page("pgy");

  assert.equal(page.url(), "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol");
  assert.equal(actions.filter(([kind]) => kind === "goto").length, 2);
  assert.equal(actions.filter(([kind]) => kind === "new-page").length, 1);
});

test("browser runtime explicitly reopens a recoverable run in a new host tab", async () => {
  const actions = [];
  const pages = [
    fakePage(actions, {
      url: "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
    }),
  ];
  const runtime = createManualBrowserRuntime({
    connectOverCDP: async () => hostBrowser(pages, actions),
  });

  const page = await runtime.page("pgy", { reopen: true });

  assert.equal(page.url(), "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol");
  assert.equal(pages.length, 2);
  assert.equal(actions.filter(([kind]) => kind === "new-page").length, 1);
  assert.equal(actions.filter(([kind]) => kind === "goto").length, 1);
});

test("browser runtime keeps a login page open for user recovery", async () => {
  const actions = [];
  const pages = [
    fakePage(actions, {
      gotoError: new Error("navigation interrupted"),
      gotoUrl: "https://pgy.xiaohongshu.com/login",
      body: "请登录",
    }),
  ];
  const runtime = createManualBrowserRuntime({
    connectOverCDP: async () => hostBrowser(pages, actions),
  });

  await assert.rejects(runtime.page("pgy"), {
    code: "YPSCAN_MANUAL_LOGIN_REQUIRED",
  });
  assert.equal(actions.filter(([kind]) => kind === "new-page").length, 0);
  assert.equal(
    actions.some(([kind]) => kind === "front"),
    true,
  );
});

test("browser runtime reports an unavailable host Browser as recoverable", async () => {
  const runtime = createManualBrowserRuntime({
    connectOverCDP: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  await assert.rejects(runtime.page("xingtu"), {
    code: "YPSCAN_MANUAL_BROWSER_UNAVAILABLE",
  });
});

test("browser runtime re-enters Xingtu from an authenticated redirect", async () => {
  const actions = [];
  const pages = [
    fakePage(actions, {
      gotoUrl: "https://www.xingtu.cn/redirect_to/ad/creator/market",
      accountVisible: true,
    }),
  ];
  const runtime = createManualBrowserRuntime({
    connectOverCDP: async () => hostBrowser(pages, actions),
  });

  const result = await runtime.page("xingtu");

  assert.equal(result.url(), "https://www.xingtu.cn/ad/creator/market");
  assert.equal(actions.filter(([kind]) => kind === "goto").length, 2);
  assert.equal(actions.filter(([kind]) => kind === "new-page").length, 1);
});

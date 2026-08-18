import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectManualBrowser,
  inspectManualBrowserPage,
  resolveInteractiveElement,
} from "../src/tools/manual-browser-state.js";

function locator({
  visible = false,
  count = 0,
  text = "",
  value = "",
  disabled = false,
  items = [],
} = {}) {
  return {
    first() {
      return this;
    },
    nth() {
      return this;
    },
    filter() {
      return this;
    },
    isVisible: async () => visible,
    isDisabled: async () => disabled,
    getAttribute: async () => null,
    innerText: async () => text,
    inputValue: async () => value,
    count: async () => count,
    evaluateAll: async () => items,
    getByRole() {
      return locator();
    },
    locator() {
      return locator();
    },
  };
}

function pageHarness({
  url,
  body = "",
  title = "",
  focused = true,
  keywordVisible = false,
  keyword = "",
  rows = 0,
  challenge = false,
  modal = null,
  loading = false,
  interactiveElements = [],
} = {}) {
  const page = {
    url: () => url,
    title: async () => title,
    evaluate: async () => ({ focused, visible: focused }),
    getByPlaceholder: () => locator({ visible: keywordVisible, value: keyword }),
    locator(selector) {
      if (selector === "body") return locator({ text: body });
      if (selector.includes("#captcha_container")) return locator({ visible: challenge });
      if (selector.startsWith("[role=dialog]")) {
        if (!modal) return locator();
        const dialog = locator({ visible: true, text: modal.text });
        dialog.getByRole = () => locator({ visible: modal.dismissible });
        dialog.locator = () => locator({ visible: false });
        return {
          count: async () => 1,
          nth: () => dialog,
        };
      }
      if (selector.includes("base-author-list") || selector.includes("tbody tr")) {
        return locator({ count: rows });
      }
      if (selector.includes("loading") || selector.includes("aria-busy")) {
        return locator({ visible: loading });
      }
      if (selector.startsWith("button,input,select")) {
        return locator({ items: interactiveElements });
      }
      return locator();
    },
  };
  return page;
}

test("observer distinguishes wrong page, logged-out page and ready results", async () => {
  const wrong = await inspectManualBrowserPage(
    pageHarness({ url: "https://example.com/", body: "首页" }),
    "xingtu",
  );
  assert.equal(wrong.page_state, "WRONG_PAGE");

  const login = await inspectManualBrowserPage(
    pageHarness({ url: "https://www.xingtu.cn/login", body: "扫码登录后继续" }),
    "xingtu",
  );
  assert.equal(login.page_state, "LOGIN_REQUIRED");

  const results = await inspectManualBrowserPage(
    pageHarness({
      url: "https://www.xingtu.cn/ad/creator/market",
      body: "达人广场",
      keywordVisible: true,
      keyword: "办公软件",
      rows: 12,
    }),
    "xingtu",
  );
  assert.equal(results.page_state, "RESULTS_READY");
  assert.equal(results.market.keyword, "办公软件");
  assert.equal(results.market.result_row_count, 12);
  assert.ok(results.state_id);
});

test("observer reports a pending redirect as page-level navigation state without waiting", async () => {
  const redirected = await inspectManualBrowserPage(
    pageHarness({
      url: "https://www.xingtu.cn/?redirect_uri=%2Fad%2Fcreator%2Fmarket",
      body: "星图首页",
      loading: true,
    }),
    "xingtu",
  );
  assert.equal(redirected.page_state, "WRONG_PAGE");
  assert.equal(redirected.page_kind, "platform_other");
  assert.equal(redirected.navigation.redirect_detected, true);
  assert.equal(redirected.navigation.status, "redirect_target_pending");
});

test("observer returns every visible interactive element without coupling page context to DOM churn", async () => {
  const items = Array.from({ length: 35 }, (_, index) => ({
    locator_index: index,
    region: { kind: "filters", label: "筛选区" },
    role: "button",
    tag: "button",
    name: `动态筛选 ${index + 1}`,
    text: `动态筛选 ${index + 1}`,
    value: "",
    input_type: null,
    href: null,
    enabled: true,
    checked: false,
    selected: false,
    expanded: null,
    pressed: null,
    active: false,
    occurrence: 0,
  }));
  const first = await inspectManualBrowserPage(
    pageHarness({
      url: "https://www.xingtu.cn/ad/creator/market",
      body: "达人广场",
      interactiveElements: items,
    }),
    "xingtu",
  );
  const second = await inspectManualBrowserPage(
    pageHarness({
      url: "https://www.xingtu.cn/ad/creator/market",
      body: "达人广场",
      interactiveElements: [...items, { ...items[0], locator_index: 35, name: "新出现的菜单" }],
    }),
    "xingtu",
  );
  assert.equal(first.elements.length, 35);
  assert.equal(second.elements.length, 36);
  assert.equal(first.page_context_id, second.page_context_id);
  assert.notEqual(first.observation_id, second.observation_id);
  assert.notEqual(first.state_id, second.state_id);
});

test("element resolution preserves the original DOM locator index when hidden nodes were skipped", async () => {
  const item = {
    locator_index: 7,
    region: { kind: "filters", label: "筛选区" },
    role: "button",
    tag: "button",
    name: "城市",
    text: "城市",
    value: "",
    input_type: null,
    href: null,
    enabled: true,
    checked: false,
    selected: false,
    expanded: null,
    pressed: null,
    active: false,
    occurrence: 0,
  };
  let resolvedIndex = null;
  const resolvedLocator = { marker: "resolved" };
  const page = {
    locator() {
      return {
        evaluateAll: async () => [item],
        nth(index) {
          resolvedIndex = index;
          return resolvedLocator;
        },
      };
    },
  };
  const snapshot = await inspectManualBrowserPage(
    pageHarness({
      url: "https://www.xingtu.cn/ad/creator/market",
      interactiveElements: [item],
    }),
    "xingtu",
  );
  const resolved = await resolveInteractiveElement(page, snapshot.elements[0]);
  assert.equal(resolved.locator, resolvedLocator);
  assert.equal(resolvedIndex, 7);
});

test("observer exposes safe modals and treats detail CAPTCHA as the highest-priority state", async () => {
  const modal = await inspectManualBrowserPage(
    pageHarness({
      url: "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
      body: "博主广场 新手引导",
      keywordVisible: true,
      modal: { text: "欢迎使用，知道了", dismissible: true },
    }),
    "pgy",
  );
  assert.equal(modal.page_state, "MODAL_BLOCKED");
  assert.equal(modal.modal.dismissible, true);

  const captcha = await inspectManualBrowserPage(
    pageHarness({
      url: "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/123456",
      body: "达人详情",
      challenge: true,
      modal: { text: "普通提示", dismissible: true },
    }),
    "xingtu",
  );
  assert.equal(captcha.page_state, "CAPTCHA_BLOCKED");
  assert.equal(captcha.challenge.present, true);
});

test("observer follows the focused tab but can resolve an exact expected state", async () => {
  const wrongPage = pageHarness({
    url: "https://example.com/",
    body: "当前错误标签",
    focused: true,
  });
  const marketPage = pageHarness({
    url: "https://www.xingtu.cn/ad/creator/market",
    body: "达人广场",
    focused: false,
    keywordVisible: true,
  });
  const browser = { contexts: () => [{ pages: () => [wrongPage, marketPage] }] };
  const focused = await inspectManualBrowser(browser, "xingtu");
  assert.equal(focused.state.page_state, "WRONG_PAGE");
  const market = await inspectManualBrowserPage(marketPage, "xingtu");
  const exact = await inspectManualBrowser(browser, "xingtu", {
    expectedStateId: market.state_id,
  });
  assert.equal(exact.page, marketPage);
  assert.equal(exact.state.page_state, "MARKET_READY");
});

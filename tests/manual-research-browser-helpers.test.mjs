import assert from "node:assert/strict";
import test from "node:test";

import {
  assertUsablePage,
  clickOptional,
  closeFloatingLayer,
  dismissOrdinaryPopups,
  fillMenuRange,
  hasResultRefreshEvidence,
  openFilterMenu,
  pageMatches,
  platformRangeValue,
  resultCountFromText,
  selectMenuValues,
} from "../src/tools/manual-research/common.js";

test("known ordinary platform prompts are closed without user handoff", async () => {
  let bodyText = "达人广场 完善基础资质信息";
  let clicks = 0;
  const emptyDialogs = { count: async () => 0 };
  const button = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => bodyText.includes("完善基础资质信息"),
    click: async () => {
      clicks += 1;
      bodyText = "达人广场";
    },
  };
  const page = {
    locator(selector) {
      if (selector === "body") return { innerText: async () => bodyText };
      return emptyDialogs;
    },
    getByRole: () => button,
    waitForTimeout: async () => {},
  };

  assert.deepEqual(await dismissOrdinaryPopups(page, "xingtu"), ["完善基础资质信息"]);
  assert.equal(clicks, 1);
});

test("login and security dialogs are never dismissed as ordinary prompts", async () => {
  const dialog = {
    isVisible: async () => true,
    innerText: async () => "扫码登录后继续",
    getByRole() {
      throw new Error("protected dialog must not inspect a dismiss button");
    },
    locator() {
      throw new Error("protected dialog must not inspect a close icon");
    },
  };
  const dialogs = { count: async () => 1, nth: () => dialog };
  const page = {
    locator(selector) {
      if (selector === "body") return { innerText: async () => "达人广场" };
      return dialogs;
    },
  };

  assert.deepEqual(await dismissOrdinaryPopups(page, "xingtu"), []);
});

test("a visible verify-center iframe is treated as a real CAPTCHA handoff", async () => {
  const hidden = {
    first() {
      return this;
    },
    isVisible: async () => false,
  };
  const challenge = {
    first() {
      return this;
    },
    isVisible: async () => true,
  };
  const body = { innerText: async () => "达人广场" };
  const page = {
    url: () => "https://www.xingtu.cn/ad/creator/market",
    locator(selector) {
      if (selector === "body") return body;
      if (selector.includes("captcha")) return challenge;
      return hidden;
    },
  };
  await assert.rejects(
    () => assertUsablePage(page, "xingtu"),
    (error) => error.code === "YPSCAN_MANUAL_CAPTCHA_REQUIRED",
  );
});

test("range conversion preserves yuan, converts ratios to percent and honors 万 inputs", () => {
  assert.equal(platformRangeValue(2_000, { unit: "yuan" }), "2000");
  assert.equal(platformRangeValue(0.125, { unit: "ratio" }), "12.5");
  assert.equal(platformRangeValue(250_000, { unit: null, placeholder: "最低粉丝量（万）" }), "25");
  assert.equal(
    platformRangeValue(100_000, {
      unit: "count",
      placeholder: "0",
      displayText: "1000w以上 10w-100w w - w",
    }),
    "10",
  );
  assert.equal(platformRangeValue(null, { unit: "yuan" }), null);
});

test("result signals and platform URLs are parsed without private APIs", () => {
  assert.equal(resultCountFromText("根据内容词找到 1,234 达人", "xingtu"), 1_234);
  assert.equal(resultCountFromText("推荐 358 位博主", "pgy"), 358);
  assert.equal(pageMatches("xingtu", "https://www.xingtu.cn/ad/creator/market"), true);
  assert.equal(
    pageMatches("pgy", "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol/other"),
    false,
  );
});

test("a keyword submission needs real result-refresh evidence", () => {
  assert.equal(hasResultRefreshEvidence({ ready: false, timed_out: true }), false);
  assert.equal(hasResultRefreshEvidence({ ready: true, empty: true }), true);
  assert.equal(hasResultRefreshEvidence({ ready: false }, { total: 0 }), true);
});

test("dynamic aria-controls resolves a teleported menu after real hover and click", async () => {
  const events = [];
  const menu = {
    isVisible: async () => true,
    first() {
      return this;
    },
  };
  const hidden = {
    isVisible: async () => false,
    count: async () => 0,
    locator() {
      return this;
    },
    first() {
      return this;
    },
  };
  const trigger = {
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => events.push("scroll"),
    hover: async () => events.push("hover"),
    click: async () => events.push("click"),
    getAttribute: async (name) => (name === "aria-controls" ? "menu-42" : null),
    innerText: async () => "科技数码",
    first() {
      return this;
    },
  };
  const wrongTrigger = {
    ...trigger,
    innerText: async () => "美妆",
    hover: async () => events.push("wrong-hover"),
    click: async () => events.push("wrong-click"),
  };
  const title = {
    innerText: async () => "达人类型",
    count: async () => 1,
    first() {
      return this;
    },
  };
  const controls = {
    count: async () => 2,
    nth: (index) => (index === 0 ? wrongTrigger : trigger),
    first: () => wrongTrigger,
  };
  const row = {
    isVisible: async () => true,
    locator(selector) {
      if (selector === "[aria-controls]") return controls;
      if (selector.includes("filter-title")) return title;
      return hidden;
    },
  };
  const rows = {
    count: async () => 1,
    nth: () => row,
  };
  const page = {
    locator(selector) {
      if (selector === ".custom-selector__button:visible") return hidden;
      if (selector.startsWith(".market-filter-wrapper")) return rows;
      assert.equal(selector, '[id="menu-42"]');
      return menu;
    },
    waitForTimeout: async () => {},
  };

  const opened = await openFilterMenu(page, ["达人类型"], {
    triggerLabels: ["科技数码"],
    optionValues: ["科技数码"],
  });
  assert.equal(opened.menu_id, "menu-42");
  assert.equal(opened.menu, menu);
  assert.equal(opened.trigger_matches_option, true);
  assert.deepEqual(events, ["scroll", "hover", "click"]);
});

test("current PGY custom-selector trigger resolves its teleported filter popover", async () => {
  const events = [];
  const emptyRows = { count: async () => 0 };
  const menu = {
    isVisible: async () => true,
    last() {
      return this;
    },
  };
  const trigger = {
    innerText: async () => "合作报价",
    scrollIntoViewIfNeeded: async () => events.push("scroll"),
    hover: async () => events.push("hover"),
    click: async () => events.push("click"),
  };
  const triggers = {
    count: async () => 1,
    nth: () => trigger,
  };
  const page = {
    locator(selector) {
      if (selector.startsWith(".market-filter-wrapper")) return emptyRows;
      if (selector === ".custom-selector__button:visible") return triggers;
      assert.equal(selector, ".filter-select-popover:visible");
      return menu;
    },
    waitForTimeout: async () => {},
  };

  const opened = await openFilterMenu(page, ["合作报价"]);
  assert.equal(opened.menu, menu);
  assert.equal(opened.trigger_text, "合作报价");
  assert.deepEqual(events, ["scroll", "hover", "click"]);
});

test("cascading selection waits for hover settlement and a committed leaf", async () => {
  const events = [];
  const waits = [];
  let childReady = false;
  let leafSelected = false;
  const option = (label, visible) => ({
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => visible(),
    scrollIntoViewIfNeeded: async () => events.push(["scroll", label]),
    hover: async () => events.push(["hover", label]),
    click: async () => {
      events.push(["click", label]);
      if (label === "二级") leafSelected = true;
    },
    evaluate: async () => ({ known: true, selected: label === "二级" && leafSelected }),
  });
  const root = {
    getByText(pattern) {
      return option("一级", () => pattern.test("一级"));
    },
  };
  const overlay = {
    last() {
      return this;
    },
    getByText(pattern) {
      return option("二级", () => childReady && pattern.test("二级"));
    },
  };
  const page = {
    locator: () => overlay,
    waitForTimeout: async (milliseconds) => {
      waits.push(milliseconds);
      if (milliseconds === 300) childReady = true;
    },
  };

  assert.deepEqual(
    await selectMenuValues(page, { menu: root }, ["一级 > 二级"], { close: false }),
    ["一级 > 二级"],
  );
  assert.deepEqual(waits, [300, 75, 75, 180]);
  assert.deepEqual(events, [
    ["scroll", "一级"],
    ["hover", "一级"],
    ["scroll", "二级"],
    ["hover", "二级"],
    ["click", "二级"],
  ]);
});

test("three-level cascade binds each child column to the hovered parent", async () => {
  const events = [];
  let level = 0;
  let leafSelected = false;
  const option = (label, x, onHover = () => {}, onClick = () => {}) => ({
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    boundingBox: async () => ({ x, y: 0, width: 80, height: 30 }),
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {
      events.push(`hover:${label}`);
      onHover();
    },
    click: async () => {
      events.push(`click:${label}`);
      onClick();
    },
    evaluate: async () => ({ known: true, selected: label === "三级" && leafSelected }),
  });
  const makeColumn = (label, x, target) => ({
    isVisible: async () => true,
    innerText: async () => label,
    boundingBox: async () => ({ x, y: 0, width: 100, height: 200 }),
    getByText(pattern) {
      const matches = pattern.test(label);
      return {
        ...target,
        isVisible: async () => matches,
      };
    },
  });
  const first = option("一级", 10, () => {
    level = Math.max(level, 1);
  });
  const second = option("二级", 110, () => {
    level = Math.max(level, 2);
  });
  const wrongSecond = option("二级", 310, () => events.push("wrong-parent"));
  const third = option(
    "三级",
    210,
    () => {},
    () => {
      leafSelected = true;
    },
  );
  const columns = () => [
    makeColumn("一级", 0, first),
    makeColumn("二级", 300, wrongSecond),
    ...(level >= 1 ? [makeColumn("二级", 100, second)] : []),
    ...(level >= 2 ? [makeColumn("三级", 200, third)] : []),
  ];
  const columnCollection = {
    count: async () => columns().length,
    nth: (index) => columns()[index],
  };
  const overlay = {
    last() {
      return this;
    },
    getByText: () => ({ isVisible: async () => false }),
  };
  const page = {
    locator(selector) {
      return selector.includes("semi-cascader-column") ? columnCollection : overlay;
    },
    waitForTimeout: async () => {},
  };

  assert.deepEqual(
    await selectMenuValues(page, { menu: columns()[0] }, ["一级 > 二级 > 三级"], {
      close: false,
    }),
    ["一级 > 二级 > 三级"],
  );
  assert.deepEqual(events, ["hover:一级", "hover:二级", "hover:三级", "click:三级"]);
  assert.equal(events.includes("wrong-parent"), false);
});

test("a pre-rendered unrelated child column is not accepted as cascade progress", async () => {
  let clicked = false;
  const makeOption = (label, x) => ({
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    boundingBox: async () => ({ x, y: 0, width: 80, height: 30 }),
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      clicked = true;
    },
    evaluate: async () => ({ known: true, selected: false }),
  });
  const parent = makeOption("一级", 10);
  const unrelated = makeOption("二级", 110);
  const columns = [
    {
      isVisible: async () => true,
      innerText: async () => "一级",
      boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 200 }),
      getByText: (pattern) => ({ ...parent, isVisible: async () => pattern.test("一级") }),
    },
    {
      isVisible: async () => true,
      innerText: async () => "二级",
      boundingBox: async () => ({ x: 100, y: 0, width: 100, height: 200 }),
      getByText: (pattern) => ({ ...unrelated, isVisible: async () => pattern.test("二级") }),
    },
  ];
  const page = {
    locator(selector) {
      if (selector.includes("semi-cascader-column")) {
        return { count: async () => columns.length, nth: (index) => columns[index] };
      }
      return {
        last() {
          return this;
        },
        getByText: () => unrelated,
      };
    },
    waitForTimeout: async () => {},
  };

  assert.deepEqual(
    await selectMenuValues(page, { menu: columns[0] }, ["一级 > 二级"], { close: false }),
    [],
  );
  assert.equal(clicked, false);
});

test("an expanded parent does not authorize a pre-rendered unrelated child column", async () => {
  let clicked = false;
  const makeOption = (label, x, expanded = false) => ({
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    boundingBox: async () => ({ x, y: 0, width: 80, height: 30 }),
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      clicked = true;
    },
    evaluate: async (callback) =>
      callback({
        parentElement: null,
        matches: () => false,
        querySelector: () => null,
        getAttribute: (name) => (name === "aria-expanded" && expanded ? "true" : null),
      }),
  });
  const parent = makeOption("一级", 10, true);
  const unrelated = makeOption("二级", 110);
  const columns = [
    {
      isVisible: async () => true,
      innerText: async () => "一级",
      boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 200 }),
      getByText: (pattern) => ({ ...parent, isVisible: async () => pattern.test("一级") }),
    },
    {
      isVisible: async () => true,
      innerText: async () => "二级",
      boundingBox: async () => ({ x: 100, y: 0, width: 100, height: 200 }),
      getByText: (pattern) => ({ ...unrelated, isVisible: async () => pattern.test("二级") }),
    },
  ];
  const page = {
    locator(selector) {
      if (selector.includes("semi-cascader-column")) {
        return { count: async () => columns.length, nth: (index) => columns[index] };
      }
      return {
        last() {
          return this;
        },
        getByText: () => unrelated,
      };
    },
    waitForTimeout: async () => {},
  };

  assert.deepEqual(
    await selectMenuValues(page, { menu: columns[0] }, ["一级 > 二级"], { close: false }),
    [],
  );
  assert.equal(clicked, false);
});

test("a pre-rendered child explicitly controlled by the hovered parent is accepted", async () => {
  let selected = false;
  const node = {
    parentElement: null,
    matches: () => false,
    querySelector: () => null,
    getAttribute: (name) => (name === "aria-controls" ? "controlled-child" : null),
  };
  const parent = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    boundingBox: async () => ({ x: 10, y: 0, width: 80, height: 30 }),
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    evaluate: async (callback) => callback(node),
  };
  const leaf = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      selected = true;
    },
    evaluate: async () => ({ known: true, selected }),
  };
  const makeColumn = (label, x, option) => ({
    first() {
      return this;
    },
    isVisible: async () => true,
    innerText: async () => label,
    boundingBox: async () => ({ x, y: 0, width: 100, height: 200 }),
    getByText: (pattern) => ({ ...option, isVisible: async () => pattern.test(label) }),
  });
  const root = makeColumn("一级", 0, parent);
  const child = makeColumn("二级", 100, leaf);
  const columns = [root, child];
  const page = {
    locator(selector) {
      if (selector === '[id="controlled-child"]') return child;
      if (selector.includes("semi-cascader-column")) {
        return { count: async () => columns.length, nth: (index) => columns[index] };
      }
      return {
        last() {
          return this;
        },
        getByText: () => ({ isVisible: async () => false }),
      };
    },
    waitForTimeout: async () => {},
  };

  assert.deepEqual(
    await selectMenuValues(page, { menu: root }, ["一级 > 二级"], { close: false }),
    ["一级 > 二级"],
  );
  assert.equal(selected, true);
});

test("a missed first leaf click is retried and accepted only after selection commits", async () => {
  let clicks = 0;
  let selected = false;
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      clicks += 1;
      if (clicks === 2) selected = true;
    },
    evaluate: async () => ({ known: true, selected }),
  };
  const menu = { getByText: () => option };
  const page = { waitForTimeout: async () => {} };

  assert.deepEqual(await selectMenuValues(page, { menu }, ["二级"], { close: false }), ["二级"]);
  assert.equal(clicks, 2);
});

test("a leaf with hover-only is-active state is still clicked", async () => {
  let clicks = 0;
  let selected = false;
  const node = {
    parentElement: null,
    matches: () => false,
    querySelector: () => null,
    getAttribute(name) {
      if (name === "class") return "is-active";
      if (name === "aria-selected") return selected ? "true" : "false";
      return null;
    },
  };
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      clicks += 1;
      selected = true;
    },
    evaluate: async (callback) => callback(node),
  };
  const menu = { getByText: () => option };
  const page = { waitForTimeout: async () => {} };

  assert.deepEqual(await selectMenuValues(page, { menu }, ["二级"], { close: false }), ["二级"]);
  assert.equal(clicks, 1);
});

test("PGY --active tags are recognized before a retry can toggle them off", async () => {
  let clicks = 0;
  let selected = false;
  const node = {
    parentElement: null,
    matches: () => false,
    querySelector: () => null,
    getAttribute(name) {
      if (name === "class") {
        return selected ? "tag --interactive --active" : "tag --interactive";
      }
      return null;
    },
  };
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      clicks += 1;
      selected = !selected;
    },
    evaluate: async (callback) => callback(node),
  };
  const menu = { getByText: () => option };
  const page = { waitForTimeout: async () => {} };

  assert.deepEqual(await selectMenuValues(page, { menu }, ["职场"], { close: false }), ["职场"]);
  assert.equal(clicks, 1);
  assert.equal(selected, true);
});

test("a hover-only --active class is not mistaken for a committed selection", async () => {
  let hovered = false;
  let clicks = 0;
  let selected = false;
  const node = {
    parentElement: null,
    matches: () => false,
    querySelector: () => null,
    getAttribute(name) {
      if (name === "class") {
        return hovered || selected ? "tag --interactive --active" : "tag --interactive";
      }
      if (name === "aria-selected") return selected ? "true" : "false";
      return null;
    },
  };
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {
      hovered = true;
    },
    click: async () => {
      clicks += 1;
      selected = true;
    },
    evaluate: async (callback) => callback(node),
  };
  const menu = { getByText: () => option };
  const page = { waitForTimeout: async () => {} };

  assert.deepEqual(await selectMenuValues(page, { menu }, ["职场"], { close: false }), ["职场"]);
  assert.equal(clicks, 1);
});

test("an explicit filter summary prevents re-clicking an already selected option", async () => {
  let clicks = 0;
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      clicks += 1;
    },
  };
  const menu = { getByText: () => option };
  const page = { waitForTimeout: async () => {} };

  assert.deepEqual(
    await selectMenuValues(
      page,
      { menu, readback: async () => "笔记类型：图文笔记为主" },
      ["图文笔记为主"],
      { close: false },
    ),
    ["图文笔记为主"],
  );
  assert.equal(clicks, 0);
});

test("duplicate visible labels in one menu are rejected instead of choosing the first", async () => {
  let clicks = 0;
  const option = {
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      clicks += 1;
    },
  };
  const matches = {
    filter() {
      return this;
    },
    count: async () => 2,
    nth: () => option,
  };
  const menu = { getByText: () => matches };
  const page = {
    locator: () => ({
      last() {
        return this;
      },
      getByText: () => matches,
    }),
    waitForTimeout: async () => {},
  };

  assert.deepEqual(await selectMenuValues(page, { menu }, ["女"], { close: false }), []);
  assert.equal(clicks, 0);
});

test("a disappearing menu without selection readback is not treated as committed", async () => {
  let visible = true;
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => visible,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      visible = false;
    },
    evaluate: async () => ({ known: false, selected: false }),
  };
  const menu = { getByText: () => option };
  const row = { innerText: async () => "达人类型" };
  const page = { waitForTimeout: async () => {} };

  assert.deepEqual(await selectMenuValues(page, { menu, row }, ["二级"], { close: false }), []);
});

test("an unrelated row-text change does not prove an already-present value was committed", async () => {
  let reads = 0;
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {},
    evaluate: async () => ({ known: false, selected: false }),
  };
  const menu = { getByText: () => option };
  const row = {
    innerText: async () => (reads++ === 0 ? "达人类型 美妆教程 结果1" : "达人类型 美妆教程 结果2"),
  };
  const page = { waitForTimeout: async () => {} };

  assert.deepEqual(await selectMenuValues(page, { menu, row }, ["美妆教程"], { close: false }), []);
});

test("partial multi-value selection is rejected", async () => {
  let selected = false;
  const first = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      selected = true;
    },
    evaluate: async () => ({ known: true, selected }),
  };
  const missing = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => false,
  };
  const menu = { getByText: (pattern) => (pattern.test("一级") ? first : missing) };
  const overlay = {
    last() {
      return this;
    },
    getByText: () => missing,
  };
  const page = { locator: () => overlay, waitForTimeout: async () => {} };

  assert.deepEqual(
    await selectMenuValues(page, { menu }, ["一级", "不存在"], { close: false }),
    [],
  );
});

test("a visible confirmation that fails to click invalidates the selection", async () => {
  let selected = false;
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      selected = true;
    },
    evaluate: async () => ({ known: true, selected }),
  };
  const confirm = {
    first() {
      return this;
    },
    isVisible: async () => true,
    click: async () => {
      throw new Error("detached");
    },
  };
  const menu = { getByText: () => option, getByRole: () => confirm };
  const page = {
    waitForTimeout: async () => {},
    mouse: { move: async () => {}, down: async () => {}, up: async () => {} },
  };

  assert.deepEqual(await selectMenuValues(page, { menu }, ["二级"]), []);
});

test("a late first commit during retry dwell is not toggled off", async () => {
  let clicks = 0;
  let selected = false;
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      clicks += 1;
    },
    evaluate: async () => ({ known: true, selected }),
  };
  const menu = { getByText: () => option };
  const page = {
    waitForTimeout: async (milliseconds) => {
      if (milliseconds === 180) selected = true;
    },
  };

  assert.deepEqual(await selectMenuValues(page, { menu }, ["二级"], { close: false }), ["二级"]);
  assert.equal(clicks, 1);
});

test("an uncommitted menu click is retried once and never reported as selected", async () => {
  let clicks = 0;
  const waits = [];
  const option = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      clicks += 1;
    },
    evaluate: async () => ({ known: true, selected: false }),
  };
  const menu = { getByText: () => option };
  const page = {
    waitForTimeout: async (milliseconds) => waits.push(milliseconds),
  };

  assert.deepEqual(await selectMenuValues(page, { menu }, ["二级"], { close: false }), []);
  assert.equal(clicks, 2);
  assert.equal(waits[0], 180);
  assert.equal(waits.includes(300), true);
});

test("floating menus are closed with a complete mouse sequence", async () => {
  const events = [];
  await closeFloatingLayer({
    mouse: {
      move: async (x, y) => events.push(["move", x, y]),
      down: async () => events.push(["down"]),
      up: async () => events.push(["up"]),
    },
    waitForTimeout: async () => {},
  });
  assert.deepEqual(events, [["move", 8, 8], ["down"], ["up"]]);
});

test("a one-input range uses the real upper bound for lte facts", async () => {
  const filled = [];
  const hidden = {
    isVisible: async () => false,
    first() {
      return this;
    },
  };
  const input = {
    getAttribute: async () => "最高报价",
    fill: async (value) => filled.push(value),
  };
  const inputs = {
    count: async () => 1,
    nth: () => input,
  };
  const menu = {
    getByText: () => hidden,
    getByRole: () => hidden,
    locator: () => inputs,
    innerText: async () => "",
  };
  const page = {
    mouse: { move: async () => {}, down: async () => {}, up: async () => {} },
    waitForTimeout: async () => {},
  };

  assert.equal(await fillMenuRange(page, { menu }, { min: 0, max: 2_000, unit: "yuan" }), true);
  assert.deepEqual(filled, ["2000"]);
});

test("range filling ignores readonly dropdown inputs instead of waiting for editability", async () => {
  const hidden = {
    isVisible: async () => false,
    first() {
      return this;
    },
  };
  const menu = {
    getByText: () => hidden,
    getByRole: () => hidden,
    locator(selector) {
      assert.equal(selector, "input:visible:not([readonly]):not([disabled])");
      return { count: async () => 0 };
    },
    innerText: async () => "",
  };
  const page = {
    mouse: { move: async () => {}, down: async () => {}, up: async () => {} },
    waitForTimeout: async () => {},
  };

  assert.equal(await fillMenuRange(page, { menu }, { min: 0, max: 75, unit: "ratio" }), false);
});

test("range filling refuses an ambiguous menu with multiple input groups", async () => {
  let fills = 0;
  const hidden = {
    isVisible: async () => false,
    first() {
      return this;
    },
  };
  const inputs = {
    count: async () => 4,
    nth: () => ({ fill: async () => (fills += 1) }),
  };
  const menu = {
    getByText: () => hidden,
    locator: () => inputs,
  };
  const page = {
    mouse: { move: async () => {}, down: async () => {}, up: async () => {} },
    waitForTimeout: async () => {},
  };

  assert.equal(await fillMenuRange(page, { menu }, { min: 1, max: 2, unit: "yuan" }), false);
  assert.equal(fills, 0);
});

test("an open upper bound clears a stale second range input", async () => {
  const filled = [];
  const hidden = {
    isVisible: async () => false,
    first() {
      return this;
    },
  };
  const inputs = {
    count: async () => 2,
    nth: (index) => ({
      getAttribute: async () => (index === 0 ? "0" : "5000"),
      fill: async (value) => filled.push([index, value]),
    }),
  };
  const menu = {
    getByText: () => hidden,
    getByRole: () => hidden,
    locator: () => inputs,
    innerText: async () => "1000w以上 10w-100w w - w",
  };
  const page = {
    mouse: { move: async () => {}, down: async () => {}, up: async () => {} },
    waitForTimeout: async () => {},
  };

  assert.equal(
    await fillMenuRange(page, { menu }, { min: 100_000, max: null, unit: "count" }),
    true,
  );
  assert.deepEqual(filled, [
    [1, ""],
    [0, "10"],
  ]);
});

test("an optional confirm that disappears during rerender fails fast", async () => {
  let attempts = 0;
  const locator = {
    isVisible: async () => true,
    click: async ({ timeout }) => {
      attempts += 1;
      assert.equal(timeout, 25);
      throw new Error("detached during rerender");
    },
  };
  assert.equal(await clickOptional(locator, 25), false);
  assert.equal(attempts, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createXingtuAdapter } from "../src/tools/manual-research/xingtu-adapter.js";

function collection(items) {
  return {
    count: async () => items.length,
    nth: (index) => items[index],
    first: () => items[0],
    last: () => items.at(-1),
  };
}

const hidden = {
  count: async () => 0,
  isVisible: async () => false,
  innerText: async () => "",
  first() {
    return this;
  },
  last() {
    return this;
  },
  filter() {
    return this;
  },
  getByText() {
    return this;
  },
  locator() {
    return this;
  },
};

function basePage(locator, { bodyText = () => "达人广场" } = {}) {
  return {
    url: () => "https://www.xingtu.cn/ad/creator/market",
    locator(selector) {
      if (selector === "body") return { innerText: async () => bodyText() };
      if (selector.includes("captcha")) return hidden;
      return locator(selector);
    },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    mouse: {
      move: async () => {},
      down: async () => {},
      up: async () => {},
    },
  };
}

test("Xingtu creator paths open the first-level trigger before selecting the leaf", async () => {
  const events = [];
  let leafSelected = false;
  const confirm = {
    isVisible: async () => true,
    click: async () => events.push("confirm"),
    first() {
      return this;
    },
  };
  const leaf = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => events.push("leaf-scroll"),
    hover: async () => events.push("leaf-hover"),
    click: async () => {
      events.push("leaf-click");
      leafSelected = true;
    },
    evaluate: async () => ({ known: true, selected: leafSelected }),
  };
  const menu = {
    isVisible: async () => true,
    first() {
      return this;
    },
    getByText(pattern) {
      assert.equal(pattern.test("美妆教程"), true);
      return leaf;
    },
    getByRole: () => confirm,
  };
  const trigger = {
    innerText: async () => "美妆",
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => events.push("trigger-scroll"),
    hover: async () => events.push("trigger-hover"),
    click: async () => events.push("trigger-click"),
    getAttribute: async (name) => (name === "aria-controls" ? "creator-type-menu" : null),
  };
  const title = {
    count: async () => 1,
    innerText: async () => "达人类型",
    first() {
      return this;
    },
  };
  const row = {
    isVisible: async () => true,
    innerText: async () => (leafSelected ? "达人类型 美妆 美妆教程" : "达人类型 美妆"),
    locator(selector) {
      if (selector === "[aria-controls]") return collection([trigger]);
      if (selector.includes("filter-title")) return title;
      return hidden;
    },
  };
  const page = basePage((selector) => {
    if (selector === ".custom-selector__button:visible") return hidden;
    if (selector.startsWith(".market-filter-wrapper")) return collection([row]);
    if (selector === '[id="creator-type-menu"]') return menu;
    throw new Error(`unexpected locator: ${selector}`);
  });

  const receipt = await createXingtuAdapter(page).applyFilter({
    control: "creator_type",
    mode: "options",
    values: ["美妆 > 美妆教程"],
  });

  assert.equal(receipt.applied, true);
  assert.match(receipt.readback, /美妆教程/u);
  assert.deepEqual(events, [
    "trigger-scroll",
    "trigger-hover",
    "trigger-click",
    "leaf-scroll",
    "leaf-hover",
    "leaf-click",
    "confirm",
  ]);
});

test("Xingtu reset skips a disabled nested reset and safely selects all", async () => {
  const events = [];
  let activeVisible = true;
  const disabledReset = {
    isVisible: async () => true,
    isEnabled: async () => false,
    click: async () => {
      throw new Error("disabled reset must not be clicked");
    },
    first() {
      return this;
    },
  };
  const all = {
    isVisible: async () => true,
    click: async () => {
      events.push("all");
      activeVisible = false;
    },
    first() {
      return this;
    },
    filter() {
      return this;
    },
  };
  const confirm = {
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => events.push("confirm"),
    last() {
      return this;
    },
  };
  const menu = {
    isVisible: async () => true,
    first() {
      return this;
    },
    getByRole(_role, options) {
      return options.name.test("重置") ? disabledReset : confirm;
    },
    getByText: () => all,
  };
  const active = {
    isVisible: async () => activeVisible,
    click: async () => events.push("open"),
    getAttribute: async (name) => (name === "aria-controls" ? "active-menu" : null),
    first() {
      return this;
    },
  };
  const page = basePage((selector) => {
    if (selector.includes("aria-controls") && selector.includes("active")) return active;
    if (selector === '[id="active-menu"]') return menu;
    return hidden;
  });
  page.keyboard = { press: async () => {} };
  page.getByRole = () => hidden;
  page.getByPlaceholder = () => hidden;

  await createXingtuAdapter(page).reset();

  assert.deepEqual(events, ["open", "all", "confirm"]);
});

test("Xingtu price view uses the labeled type trigger and verifies the table header", async () => {
  const events = [];
  let selected = false;
  const wrongControl = {
    innerText: async () => "输入报价区间",
    isVisible: async () => true,
    getAttribute: async (name) => (name === "aria-controls" ? "wrong-menu" : null),
    click: async () => events.push("wrong-click"),
  };
  let menuId = "price-type-menu-before-open";
  const priceTypeTrigger = {
    innerText: async () => (selected ? "植入视频" : "全部"),
    isVisible: async () => true,
    getAttribute: async (name) => {
      if (name === "aria-controls") return menuId;
      if (name === "placeholder") return "选择报价类型";
      return null;
    },
    hover: async () => events.push("type-hover"),
    click: async () => {
      events.push("type-click");
      menuId = "price-type-menu-after-open";
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
    scrollIntoViewIfNeeded: async () => events.push("option-scroll"),
    hover: async () => events.push("option-hover"),
    click: async () => {
      events.push("option-click");
      selected = true;
    },
    evaluate: async () => ({ known: true, selected }),
  };
  const priceTypeMenu = {
    isVisible: async () => true,
    innerText: async () => "全部 植入视频 定制视频 短直种草",
    first() {
      return this;
    },
    getByText(pattern) {
      assert.equal(pattern.test("植入视频"), true);
      return option;
    },
  };
  const confirm = {
    isVisible: async () => true,
    click: async () => events.push("confirm"),
    last() {
      return this;
    },
  };
  const quoteMenu = {
    isVisible: async () => true,
    first() {
      return this;
    },
    locator(selector) {
      assert.equal(selector, "[aria-controls]");
      return collection([wrongControl, priceTypeTrigger]);
    },
    getByRole: () => confirm,
  };
  const quoteTrigger = {
    innerText: async () => "达人报价",
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => events.push("quote-scroll"),
    hover: async () => events.push("quote-hover"),
    click: async () => events.push("quote-click"),
    getAttribute: async (name) => (name === "aria-controls" ? "quote-menu" : null),
  };
  const title = {
    count: async () => 1,
    innerText: async () => "合作数据",
    first() {
      return this;
    },
  };
  const row = {
    isVisible: async () => true,
    innerText: async () => "合作数据 达人报价",
    locator(selector) {
      if (selector === "[aria-controls]") return collection([quoteTrigger]);
      if (selector.includes("filter-title")) return title;
      return hidden;
    },
  };
  let headerText = "达人信息 植入视频报价 预期CPM";
  const header = { innerText: async () => headerText };
  const page = basePage((selector) => {
    if (selector === ".custom-selector__button:visible") return hidden;
    if (selector.startsWith(".market-filter-wrapper")) return collection([row]);
    if (selector === '[id="quote-menu"]') return quoteMenu;
    if (selector === '[id="price-type-menu-after-open"]') return priceTypeMenu;
    if (selector === ".base-author-list .section-wrapper.sticky-header") return header;
    throw new Error(`unexpected locator: ${selector}`);
  });

  const receipt = await createXingtuAdapter(page).setPriceView("植入视频");

  assert.deepEqual(receipt, {
    applied: true,
    reason: null,
    readback: "达人信息 植入视频报价 预期CPM",
  });
  assert.equal(events.includes("wrong-click"), false);
  assert.deepEqual(events, [
    "quote-scroll",
    "quote-hover",
    "quote-click",
    "type-hover",
    "type-click",
    "option-scroll",
    "option-hover",
    "option-click",
    "confirm",
  ]);

  headerText = "达人信息 定制视频报价 预期CPM";
  assert.deepEqual(await createXingtuAdapter(page).setPriceView("植入视频"), {
    applied: false,
    reason: "price_view_readback_mismatch",
    readback: headerText,
  });
});

test("Xingtu price view accepts the quote label and delayed confirmation", async () => {
  const events = [];
  let pending = false;
  let headerText = "达人信息 定制视频报价 预期CPM";
  let menuId = "price-type-menu-before-open";
  const priceTypeTrigger = {
    innerText: async () => "全部",
    isVisible: async () => true,
    getAttribute: async (name) => {
      if (name === "aria-controls") return menuId;
      if (name === "placeholder") return "选择报价类型";
      return null;
    },
    hover: async () => {},
    click: async () => {
      menuId = "price-type-menu-after-open";
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
      events.push("option-click");
      pending = true;
    },
    evaluate: async () => ({ known: false, selected: false }),
  };
  const priceTypeMenu = {
    isVisible: async () => true,
    innerText: async () => "全部 植入视频 定制视频 短直种草",
    first() {
      return this;
    },
    getByText(pattern) {
      return pattern.test("植入视频") ? option : hidden;
    },
  };
  const confirm = {
    isVisible: async () => true,
    click: async () => {
      events.push("confirm");
      if (pending) headerText = "达人信息 植入视频报价 预期CPM";
    },
    last() {
      return this;
    },
  };
  const quoteMenu = {
    isVisible: async () => true,
    first() {
      return this;
    },
    locator: () => collection([priceTypeTrigger]),
    getByRole: () => confirm,
  };
  const quoteTrigger = {
    innerText: async () => "达人报价",
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {},
    getAttribute: async (name) => (name === "aria-controls" ? "quote-menu" : null),
  };
  const title = {
    count: async () => 1,
    innerText: async () => "合作数据",
    first() {
      return this;
    },
  };
  const row = {
    isVisible: async () => true,
    innerText: async () => "合作数据 达人报价",
    locator(selector) {
      if (selector === "[aria-controls]") return collection([quoteTrigger]);
      if (selector.includes("filter-title")) return title;
      return hidden;
    },
  };
  const header = { innerText: async () => headerText };
  const page = basePage((selector) => {
    if (selector === ".custom-selector__button:visible") return hidden;
    if (selector.startsWith(".market-filter-wrapper")) return collection([row]);
    if (selector === '[id="quote-menu"]') return quoteMenu;
    if (selector === '[id="price-type-menu-after-open"]') return priceTypeMenu;
    if (selector === ".base-author-list .section-wrapper.sticky-header") return header;
    if (selector.includes(".el-popper:visible")) return hidden;
    throw new Error(`unexpected locator: ${selector}`);
  });

  assert.deepEqual(await createXingtuAdapter(page).setPriceView("植入视频"), {
    applied: true,
    reason: null,
    readback: "达人信息 植入视频报价 预期CPM",
  });
  assert.deepEqual(events, ["option-click", "confirm"]);
});

test("Xingtu quote range identifies the custom interval control instead of using control order", async () => {
  const events = [];
  const values = ["", ""];
  let rangeMenuId = "range-before-open";
  const typeTrigger = {
    innerText: async () => "全部",
    isVisible: async () => true,
    hover: async () => events.push("type-hover"),
    click: async () => events.push("type-open"),
    getAttribute: async (name) => (name === "aria-controls" ? "type-menu" : null),
  };
  const rangeTrigger = {
    innerText: async () => "报价区间",
    isVisible: async () => true,
    hover: async () => events.push("range-hover"),
    click: async () => {
      events.push("range-open");
      rangeMenuId = "range-after-open";
    },
    getAttribute: async (name) => (name === "aria-controls" ? rangeMenuId : null),
  };
  const typeMenu = {
    isVisible: async () => true,
    innerText: async () => "全部 植入视频 定制视频 短直种草",
    locator: () => collection([]),
    first() {
      return this;
    },
  };
  const inputs = collection(
    values.map((_, index) => ({
      getAttribute: async () => "请输入金额",
      fill: async (value) => {
        values[index] = value;
        events.push(`fill-${index}:${value}`);
      },
      inputValue: async () => values[index],
    })),
  );
  const rangeConfirm = {
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => events.push("range-confirm"),
    first() {
      return this;
    },
  };
  const custom = {
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => events.push("custom"),
    first() {
      return this;
    },
  };
  const rangeMenu = {
    isVisible: async () => true,
    innerText: async () => "不限 1万以下 自定义区间",
    locator(selector) {
      assert.equal(selector, "input:visible:not([readonly]):not([disabled])");
      return inputs;
    },
    getByText: () => custom,
    getByRole: () => rangeConfirm,
    first() {
      return this;
    },
  };
  const outerConfirm = {
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => events.push("outer-confirm"),
    last() {
      return this;
    },
  };
  const quoteMenu = {
    isVisible: async () => true,
    locator: () => collection([typeTrigger, rangeTrigger]),
    getByRole: () => outerConfirm,
    first() {
      return this;
    },
  };
  const quoteTrigger = {
    innerText: async () => (values.every(Boolean) ? "达人报价·2" : "达人报价"),
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => events.push("quote-open"),
    getAttribute: async (name) => (name === "aria-controls" ? "quote-menu" : null),
  };
  const title = {
    count: async () => 1,
    innerText: async () => "合作数据",
    first() {
      return this;
    },
  };
  const row = {
    isVisible: async () => true,
    innerText: async () => `合作数据 达人报价 ${values.join("-")}`,
    locator(selector) {
      if (selector === "[aria-controls]") return collection([quoteTrigger]);
      if (selector.includes("filter-title")) return title;
      return hidden;
    },
  };
  const page = basePage((selector) => {
    if (selector === ".custom-selector__button:visible") return hidden;
    if (selector.startsWith(".market-filter-wrapper")) return collection([row]);
    if (selector === '[id="quote-menu"]') return quoteMenu;
    if (selector === '[id="type-menu"]') return typeMenu;
    if (selector === '[id="range-after-open"]') return rangeMenu;
    return hidden;
  });
  page.keyboard = { press: async () => events.push("escape") };
  page.getByPlaceholder = () => ({
    first() {
      return this;
    },
    inputValue: async () => "办公软件",
  });

  const adapter = createXingtuAdapter(page);
  const receipt = await adapter.applyFilter({
    control: "creator_price",
    mode: "range",
    min: 50_000,
    max: 120_000,
    unit: "yuan",
  });

  assert.equal(receipt.applied, true);
  assert.equal(receipt.verification_readback, "达人报价·2");
  assert.deepEqual(values, ["50000", "120000"]);
  assert.deepEqual(events, [
    "quote-open",
    "range-hover",
    "range-open",
    "custom",
    "fill-1:120000",
    "fill-0:50000",
    "range-confirm",
    "outer-confirm",
  ]);

  const selection = {
    branch: { keyword: "办公软件" },
    verification: {
      price_view: {},
      actual_filters: [
        {
          ...receipt,
          control: "creator_price",
          mode: "range",
          min: 50_000,
          max: 120_000,
          unit: "yuan",
        },
      ],
    },
  };
  assert.equal((await adapter.verifySelection(selection)).valid, true);
  values[1] = "999";
  const mismatch = await adapter.verifySelection(selection);
  assert.equal(mismatch.valid, false);
  assert.deepEqual(mismatch.filters[0].readback, ["50000", "999"]);
});

test("Xingtu selection verification survives later filters changing the same row", async () => {
  const finalBody =
    "达人广场 已选条件 达人报价·2 预期播放量 自定义 预期CPE 互动率 完播率 爆文率 进行中的任务数";
  const header = { innerText: async () => "达人信息 植入视频报价 预期CPM" };
  const keyword = {
    inputValue: async () => "办公软件",
    first() {
      return this;
    },
  };
  const page = basePage(
    (selector) => {
      if (selector === ".base-author-list .section-wrapper.sticky-header") return header;
      return hidden;
    },
    { bodyText: () => finalBody },
  );
  page.getByPlaceholder = () => keyword;
  page.getByRole = () => hidden;

  const verification = await createXingtuAdapter(page).verifySelection({
    branch: { keyword: "办公软件" },
    verification: {
      price_view: { requested: "植入视频" },
      actual_filters: [
        {
          control: "creator_price",
          readback:
            "合作数据 达人报价·2 预期播放量 预期CPM 预期CPE 互动率 完播率 爆文率 进行中的任务数",
        },
        {
          control: "cpm",
          readback:
            "合作数据 达人报价·2 预期播放量 自定义 预期CPE 互动率 完播率 爆文率 进行中的任务数",
          verification_readback: "自定义",
        },
      ],
    },
  });

  assert.equal(verification.valid, true);
  assert.deepEqual(verification.filters, [
    { control: "creator_price", valid: true },
    { control: "cpm", valid: true },
  ]);

  const missingReadback = await createXingtuAdapter(page).verifySelection({
    branch: { keyword: "办公软件" },
    verification: {
      price_view: { requested: "植入视频" },
      actual_filters: [{ control: "cpm", readback: "", verification_readback: "" }],
    },
  });
  assert.equal(missingReadback.valid, false);
  assert.deepEqual(missingReadback.filters, [{ control: "cpm", valid: false }]);
});

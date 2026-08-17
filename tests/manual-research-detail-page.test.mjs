import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { collectCreatorDetail } from "../src/tools/manual-research/detail-page.js";

function firstVisible(visible = false) {
  return {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    isVisible: async () => visible,
  };
}

function detailHarness(bodyText) {
  const context = new EventEmitter();
  let closed = false;
  const detailPage = {
    async goto() {},
    url: () => "https://www.xingtu.cn/ad/creator/detail/star-dom",
    locator(selector) {
      if (selector === "body") return { innerText: async () => bodyText };
      if (selector === "a[href]:visible") return { evaluateAll: async () => [] };
      return firstVisible(false);
    },
    async close() {
      closed = true;
    },
  };
  const listPage = {
    context: () => context,
    waitForTimeout: async () => {},
  };
  const pages = [listPage];
  context.pages = () => pages;
  context.newPage = async () => {
    pages.push(detailPage);
    return detailPage;
  };
  return { listPage, wasClosed: () => closed };
}

function adaptiveDetailHarness() {
  const context = new EventEmitter();
  let stage = 0;
  let closed = false;
  const controls = () =>
    stage === 0
      ? [{ text: "粉丝数据", role: "button", popup: "menu", expanded: "false" }]
      : stage === 1
        ? [
            { text: "粉丝数据", role: "button", popup: "menu", expanded: "true" },
            { text: "用户分析", role: "menuitem" },
          ]
        : [];
  const elements = () =>
    controls().map((control) => ({
      tagName: "BUTTON",
      textContent: control.text,
      getAttribute(name) {
        return {
          role: control.role,
          "aria-haspopup": control.popup ?? null,
          "aria-expanded": control.expanded ?? null,
          "aria-label": null,
          title: null,
        }[name];
      },
    }));
  const detailPage = {
    async goto() {},
    url: () => "https://www.xingtu.cn/ad/creator/detail/star-adaptive",
    context: () => context,
    getByText() {
      return firstVisible(false);
    },
    locator(selector) {
      if (selector === "body") {
        return { innerText: async () => (stage === 2 ? "用户分析 女性粉丝占比：68%" : "达人详情") };
      }
      if (selector === "a[href]:visible") return { evaluateAll: async () => [] };
      if (selector.includes("button:visible")) {
        return {
          evaluateAll: async (callback) => callback(elements()),
          nth(index) {
            return {
              scrollIntoViewIfNeeded: async () => {},
              hover: async () => {},
              click: async () => {
                const control = controls()[index];
                if (control?.text === "粉丝数据") stage = 1;
                if (control?.text === "用户分析") stage = 2;
              },
            };
          },
        };
      }
      return firstVisible(false);
    },
    waitForTimeout: async () => {},
    async close() {
      closed = true;
    },
  };
  const listPage = { context: () => context, waitForTimeout: async () => {} };
  const pages = [listPage];
  context.pages = () => pages;
  context.newPage = async () => {
    pages.push(detailPage);
    return detailPage;
  };
  return { listPage, wasClosed: () => closed };
}

test("detail collection falls back to visible DOM when no structured response is captured", async () => {
  const harness = detailHarness(
    "粉丝数：12.5万 所在地：上海 预期CPM：36 互动率：8.5% 60s以上视频报价：18,000",
  );
  const detail = await collectCreatorDetail(
    harness.listPage,
    "xingtu",
    {
      platform_id: "star-dom",
      nickname: "DOM达人",
      detail_url: "https://www.xingtu.cn/ad/creator/detail/star-dom",
    },
    { groups: ["summary"], capturedAt: "2026-08-17T00:00:00.000Z" },
  );

  assert.equal(detail.status, "complete");
  assert.equal(detail.source_type, "dom");
  assert.equal(detail.fields.followers_raw, "12.5万");
  assert.equal(detail.fields.city, "上海");
  assert.equal(detail.fields.cpm_raw, "36");
  assert.equal(detail.fields.interaction_rate_raw, "8.5%");
  assert.equal(detail.fields.price_by_tier["60s以上视频"], "18,000");
  assert.equal(harness.wasClosed(), true, "the temporary detail tab must be closed");
});

test("PGY brand-gated details remain inaccessible without choosing a brand", async () => {
  const harness = detailHarness("请先选择品牌，选择合作品牌后查看博主详情");
  const detail = await collectCreatorDetail(
    harness.listPage,
    "pgy",
    {
      platform_id: "kol-brand",
      nickname: "品牌受限博主",
      detail_url: "https://pgy.xiaohongshu.com/solar/kol/kol-brand",
    },
    { groups: ["summary"], capturedAt: "2026-08-17T00:00:00.000Z" },
  );

  assert.equal(detail.status, "blocked");
  assert.equal(detail.reason, "detail_not_accessible");
  assert.deepEqual(detail.fields, {});
  assert.equal(harness.wasClosed(), true);
});

test("detail collection re-inspects a cascading menu and records verified navigation", async () => {
  const harness = adaptiveDetailHarness();
  const detail = await collectCreatorDetail(
    harness.listPage,
    "xingtu",
    {
      platform_id: "star-adaptive",
      nickname: "级联达人",
      detail_url: "https://www.xingtu.cn/ad/creator/detail/star-adaptive",
    },
    { groups: ["summary", "audience"], capturedAt: "2026-08-17T00:00:00.000Z" },
  );

  assert.equal(detail.status, "complete");
  assert.equal(detail.fields.audience_female_rate_raw, "68%");
  assert.deepEqual(detail.completed_groups, ["audience", "summary"]);
  assert.deepEqual(detail.missing_groups, []);
  assert.deepEqual(
    detail.navigation[0].actions.map((action) => [action.control, action.changed]),
    [
      ["粉丝数据", true],
      ["用户分析", true],
    ],
  );
  assert.equal(harness.wasClosed(), true);
});

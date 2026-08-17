import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { collectCreatorDetail } from "../src/tools/manual-research/detail-page.js";

function firstVisible(visible = false) {
  return {
    first() {
      return this;
    },
    isVisible: async () => visible,
  };
}

function detailHarness(bodyText, detailUrl = "https://www.xingtu.cn/ad/creator/detail/star-dom") {
  const context = new EventEmitter();
  let closed = false;
  const detailPage = {
    async goto() {},
    url: () => detailUrl,
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

test("Xingtu detail URLs backfill and verify the stable creator ID", async () => {
  const detailUrl =
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/7324533389695025215";
  const harness = detailHarness("粉丝数：261.7万 60s以上视频报价：14,300", detailUrl);
  const detail = await collectCreatorDetail(
    harness.listPage,
    "xingtu",
    { nickname: "WPS大老板", detail_url: detailUrl },
    { groups: ["summary"], capturedAt: "2026-08-17T00:00:00.000Z" },
  );

  assert.equal(detail.status, "complete");
  assert.equal(detail.platform_id, "7324533389695025215");
  assert.equal(detail.detail_url, detailUrl);
});

test("Xingtu rejects a detail page whose creator ID differs from the candidate", async () => {
  const detailUrl =
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/7324533389695025215";
  const harness = detailHarness("粉丝数：261.7万", detailUrl);
  const detail = await collectCreatorDetail(
    harness.listPage,
    "xingtu",
    { platform_id: "9999999999999999999", nickname: "错误达人", detail_url: detailUrl },
    { groups: ["summary"], capturedAt: "2026-08-17T00:00:00.000Z" },
  );

  assert.equal(detail.status, "blocked");
  assert.equal(detail.reason, "detail_identity_mismatch");
  assert.deepEqual(detail.fields, {});
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

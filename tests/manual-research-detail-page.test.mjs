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

function detailHarness(
  bodyText,
  detailUrl = "https://www.xingtu.cn/ad/creator/detail/star-dom",
  {
    qualificationVisible = false,
    captchaVisible = false,
    videoCards = [],
    authenticatedRedirect = false,
    authenticatedRedirectViaIndex = false,
    html = `<html><body>${bodyText}</body></html>`,
  } = {},
) {
  const context = new EventEmitter();
  let closed = false;
  let currentUrl = detailUrl;
  let gotoCount = 0;
  const detailPage = {
    content: async () => html,
    evaluate: async (callback, argument) => callback(argument),
    async goto() {
      gotoCount += 1;
      currentUrl =
        authenticatedRedirect && gotoCount === 1
          ? `https://www.xingtu.cn/?redirect_uri=${new URL(detailUrl).pathname}`
          : detailUrl;
    },
    url: () => currentUrl,
    locator(selector) {
      if (selector === "body") return { innerText: async () => bodyText };
      if (selector === "a[href]:visible") return { evaluateAll: async () => [] };
      if (selector === ".content-video-card:visible") {
        return {
          evaluateAll: async (callback) =>
            callback(
              videoCards.map((card) => ({
                querySelector: () => ({ textContent: card.title }),
                querySelectorAll: () =>
                  (card.metrics ?? []).map((value) => ({ textContent: value })),
              })),
            ),
        };
      }
      if (selector.includes("#captcha_container")) return firstVisible(captchaVisible);
      if (selector === ".user-info:visible") {
        return {
          filter() {
            return this;
          },
          first() {
            return this;
          },
          isVisible: async () => authenticatedRedirect,
          click: async () => {
            currentUrl = authenticatedRedirectViaIndex
              ? "https://www.xingtu.cn/ad/creator/index"
              : detailUrl;
          },
        };
      }
      if (selector.includes("[role=dialog]")) {
        const dialog = {
          isVisible: async () => qualificationVisible,
          innerText: async () => "完善基础资质信息 企业资质名称 经营地区 提 交",
        };
        return { count: async () => Number(qualificationVisible), nth: () => dialog };
      }
      return firstVisible(false);
    },
    waitForTimeout: async () => {},
    waitForURL: async () => {},
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
      if (selector === ".content-video-card:visible") return { evaluateAll: async () => [] };
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
    "粉丝数：12.5万 所在地：上海 预期CPM：36 互动率：8.5% 植入视频报价：18,000",
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
  assert.equal(detail.fields.price_by_tier.植入视频, "18,000");
  assert.equal(harness.wasClosed(), true, "the temporary detail tab must be closed");
});

test("detail collection hands the original full-page HTML to the evidence store", async () => {
  const html = "<html><head><script>window.unmapped='保留'</script></head><body>粉丝数：12.5万</body></html>";
  const harness = detailHarness(
    "粉丝数：12.5万",
    "https://www.xingtu.cn/ad/creator/detail/star-html",
    { html },
  );
  const snapshots = [];
  const detail = await collectCreatorDetail(
    harness.listPage,
    "xingtu",
    {
      platform_id: "star-html",
      nickname: "HTML达人",
      detail_url: "https://www.xingtu.cn/ad/creator/detail/star-html",
    },
    {
      groups: ["summary"],
      capturedAt: "2026-08-20T00:00:00.000Z",
      async onHtmlSnapshot(snapshot) {
        snapshots.push(snapshot);
        return { snapshot_id: "snapshot-html", group: snapshot.group, sha256: "test" };
      },
    },
  );

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].html, html);
  assert.equal(detail.html_snapshots[0].snapshot_id, "snapshot-html");
});

test("Xingtu detail URLs backfill and verify the stable creator ID", async () => {
  const detailUrl =
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/7324533389695025215";
  const harness = detailHarness("粉丝数：261.7万 植入视频报价：14,300", detailUrl);
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

test("Xingtu follows an authenticated landing redirect back to the creator detail", async () => {
  const detailUrl =
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/7324533389695025215";
  const harness = detailHarness("粉丝数：261.7万 植入视频报价：14,300", detailUrl, {
    authenticatedRedirect: true,
  });
  const detail = await collectCreatorDetail(
    harness.listPage,
    "xingtu",
    { platform_id: "7324533389695025215", nickname: "重定向达人", detail_url: detailUrl },
    { groups: ["summary"], capturedAt: "2026-08-17T00:00:00.000Z" },
  );

  assert.equal(detail.status, "complete");
  assert.equal(detail.detail_url, detailUrl);
});

test("Xingtu retries the detail URL when account entry lands on the creator workspace", async () => {
  const detailUrl =
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/7324533389695025215";
  const harness = detailHarness("粉丝数：261.7万", detailUrl, {
    authenticatedRedirect: true,
    authenticatedRedirectViaIndex: true,
  });
  const detail = await collectCreatorDetail(
    harness.listPage,
    "xingtu",
    { platform_id: "7324533389695025215", nickname: "工作区达人", detail_url: detailUrl },
    { groups: ["summary"], capturedAt: "2026-08-17T00:00:00.000Z" },
  );

  assert.equal(detail.status, "complete");
  assert.equal(detail.detail_url, detailUrl);
});

test("Xingtu reads detail data underneath a qualification prompt without dismissing it", async () => {
  const harness = detailHarness(
    "完善基础资质信息 粉丝数：12.5万 所在地：上海 植入视频报价：18,000",
    "https://www.xingtu.cn/ad/creator/detail/star-overlay",
    {
      qualificationVisible: true,
      videoCards: [{ title: "AI 办公效率实测", metrics: ["12.8万", "3200"] }],
    },
  );
  const detail = await collectCreatorDetail(
    harness.listPage,
    "xingtu",
    {
      platform_id: "star-overlay",
      nickname: "弹窗下达人",
      detail_url: "https://www.xingtu.cn/ad/creator/detail/star-overlay",
    },
    { groups: ["summary", "recent_content"], capturedAt: "2026-08-17T00:00:00.000Z" },
  );

  assert.equal(detail.status, "complete");
  assert.equal(detail.fields.followers_raw, "12.5万");
  assert.equal(detail.fields.city, "上海");
  assert.equal(detail.fields.recent_content[0].title, "AI 办公效率实测");
});

test("a real CAPTCHA preserves already captured detail evidence for resume", async () => {
  const harness = detailHarness(
    "粉丝数：12.5万 所在地：上海",
    "https://www.xingtu.cn/ad/creator/detail/star-captcha",
    { captchaVisible: true },
  );

  await assert.rejects(
    () =>
      collectCreatorDetail(
        harness.listPage,
        "xingtu",
        {
          platform_id: "star-captcha",
          nickname: "验证达人",
          detail_url: "https://www.xingtu.cn/ad/creator/detail/star-captcha",
        },
        { groups: ["summary"], capturedAt: "2026-08-17T00:00:00.000Z" },
      ),
    (error) => {
      assert.equal(error.code, "YPSCAN_MANUAL_CAPTCHA_REQUIRED");
      assert.equal(error.details.captured_detail.fields.followers_raw, "12.5万");
      assert.equal(error.details.captured_detail.status, "complete");
      assert.equal(error.details.captured_detail.reason, "manual_challenge_after_capture");
      return true;
    },
  );
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

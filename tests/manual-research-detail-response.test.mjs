import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  captureDetailResponsesDuring,
  normalizeDetailResponse,
} from "../src/tools/manual-research/detail-response-capture.js";

function response(url, payload, status = 200, postData = null, sourcePageUrl = null) {
  return {
    url: () => url,
    status: () => status,
    request: () => ({
      resourceType: () => "xhr",
      postData: () => postData,
      frame: () => ({ page: () => ({ url: () => sourcePageUrl }) }),
    }),
    headers: () => ({ "content-type": "application/json" }),
    json: async () => payload,
  };
}

function fakePage() {
  const context = new EventEmitter();
  return {
    context: () => context,
    waitForTimeout: async () => {},
    emit(value) {
      context.emit("response", value);
    },
    listenerCount() {
      return context.listenerCount("response");
    },
  };
}

test("frozen PGY detail families are collected only from page-triggered responses", async () => {
  const page = fakePage();
  const candidate = { platform_id: "kol-1" };
  const result = await captureDetailResponsesDuring(page, {
    platform: "pgy",
    candidate,
    expectedGroups: ["summary", "audience", "performance", "growth"],
    action: async () => {
      assert.equal(page.listenerCount(), 1, "the listener must exist before the page action");
      page.emit(
        response("https://pgy.xiaohongshu.com/api/solar/kol/dataV3/dataSummary", {
          data: { kolId: "kol-1", fansNum: "18万", picturePrice: "8000" },
        }),
      );
      page.emit(
        response("https://pgy.xiaohongshu.com/api/solar/kol/dataV3/fansSummary", {
          data: { kolId: "kol-1", femaleRate: "72%", cityList: [{ city: "上海" }] },
        }),
      );
      page.emit(
        response("https://pgy.xiaohongshu.com/api/solar/kol/dataV3/notesRate", {
          data: { kolId: "kol-1", normalReadMedian: "2.1万", businessReadMedian: "1.4万" },
        }),
      );
      page.emit(
        response("https://pgy.xiaohongshu.com/api/solar/kol/data/kol-1/fans_overall_new_history", {
          data: { kolId: "kol-1", updateTime: "2026-08-16" },
        }),
      );
    },
  });

  assert.equal(page.listenerCount(), 0);
  assert.deepEqual(result.capture.groups, ["summary", "audience", "performance", "growth"]);
  assert.equal(result.capture.fields.followers_raw, "18万");
  assert.equal(result.capture.fields.audience_female_rate_raw, "72%");
  assert.equal(result.capture.fields.daily_read_median_raw, "2.1万");
  assert.equal(result.capture.fields.updated_at, "2026-08-16");
  assert.equal(result.capture.endpoints.length, 4);
});

test("PGY frozen detail endpoints remain bound by the current creator page", async () => {
  const page = fakePage();
  const result = await captureDetailResponsesDuring(page, {
    platform: "pgy",
    candidate: { platform_id: "kol-page-1" },
    expectedGroups: ["summary"],
    action: async () => {
      page.emit(
        response(
          "https://pgy.xiaohongshu.com/api/solar/kol/dataV3/dataSummary",
          { data: { fansNum: "18万", picturePrice: "8000" } },
          200,
          null,
          "https://pgy.xiaohongshu.com/solar/kol/kol-page-1",
        ),
      );
    },
  });

  assert.equal(result.capture.fields.followers_raw, "18万");
  assert.equal(result.capture.fields.price_picture_raw, "8000");
});

test("Xingtu discovers and remembers a same-origin detail pathname by current creator ID", async () => {
  const page = fakePage();
  const learnedPaths = new Set();
  const candidate = { platform_id: "star-9" };
  const first = await captureDetailResponsesDuring(page, {
    platform: "xingtu",
    candidate,
    expectedGroups: ["summary"],
    learnedPaths,
    action: async () => {
      page.emit(
        response("https://www.xingtu.cn/gw/api/author/detail?authorId=star-9", {
          data: { authorId: "star-9", nickName: "星图达人", fansNum: 230000 },
        }),
      );
    },
  });

  assert.equal(first.capture.fields.nickname, "星图达人");
  assert.equal(learnedPaths.has("/gw/api/author/detail"), true);

  const second = await captureDetailResponsesDuring(page, {
    platform: "xingtu",
    candidate,
    expectedGroups: ["summary"],
    learnedPaths,
    action: async () => {
      page.emit(
        response("https://www.xingtu.cn/gw/api/author/detail", {
          data: { authorId: "star-9", expectedCpm: 35 },
        }),
      );
    },
  });
  assert.equal(second.capture.fields.cpm_raw, 35);
});

test("Xingtu accepts detail evidence bound to the creator in the request body", async () => {
  const page = fakePage();
  const result = await captureDetailResponsesDuring(page, {
    platform: "xingtu",
    candidate: { platform_id: "star-request-1" },
    expectedGroups: ["summary", "recent_content"],
    action: async () => {
      page.emit(
        response(
          "https://www.xingtu.cn/gw/api/data_sp/external_multi_get_item",
          {
            data: {
              interactionRate: "8.5%",
              videos: [{ title: "AI 办公效率实测", url: "https://douyin.com/video/1" }],
            },
          },
          200,
          JSON.stringify({ author_id: "star-request-1" }),
        ),
      );
    },
  });

  assert.equal(result.capture.fields.interaction_rate_raw, "8.5%");
  assert.equal(result.capture.fields.recent_content[0].title, "AI 办公效率实测");
});

test("Xingtu binds item responses to the current creator detail page", async () => {
  const page = fakePage();
  const result = await captureDetailResponsesDuring(page, {
    platform: "xingtu",
    candidate: { platform_id: "star-page-1" },
    expectedGroups: ["summary", "recent_content"],
    action: async () => {
      page.emit(
        response(
          "https://www.xingtu.cn/gw/api/data_sp/external_multi_get_item?item_ids=video-1",
          {
            data: {
              interactionRate: "7%",
              videos: [{ title: "办公工具横评", url: "https://douyin.com/video/1" }],
            },
          },
          200,
          null,
          "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/star-page-1",
        ),
      );
    },
  });

  assert.equal(result.capture.fields.recent_content[0].title, "办公工具横评");
});

test("Xingtu ignores unrelated account responses emitted from a creator detail page", async () => {
  const page = fakePage();
  const result = await captureDetailResponsesDuring(page, {
    platform: "xingtu",
    candidate: { platform_id: "star-page-2" },
    expectedGroups: ["summary", "recent_content"],
    action: async () => {
      const sourcePageUrl =
        "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/star-page-2";
      page.emit(
        response(
          "https://www.xingtu.cn/gw/api/demander/info",
          { data: { userId: "buyer-account", nickName: "采购账号", city: "北京" } },
          200,
          null,
          sourcePageUrl,
        ),
      );
      page.emit(
        response(
          "https://www.xingtu.cn/gw/api/data_sp/external_multi_get_item?item_ids=video-2",
          { data: { videos: [{ title: "当前达人作品", url: "https://douyin.com/video/2" }] } },
          200,
          null,
          sourcePageUrl,
        ),
      );
    },
  });

  assert.equal(result.capture.fields.nickname, undefined);
  assert.equal(result.capture.fields.city, undefined);
  assert.equal(result.capture.fields.recent_content[0].title, "当前达人作品");
});

for (const status of [401, 403, 429]) {
  test(`a relevant ${status} response stops capture without automatic replay`, async () => {
    const page = fakePage();
    await assert.rejects(
      () =>
        captureDetailResponsesDuring(page, {
          platform: "pgy",
          candidate: { platform_id: "kol-risk" },
          expectedGroups: ["summary"],
          action: async () => {
            page.emit(
              response(
                "https://pgy.xiaohongshu.com/api/solar/kol/dataV3/dataSummary?kolId=kol-risk",
                {},
                status,
              ),
            );
          },
        }),
      (error) => error.code === "YPSCAN_MANUAL_DETAIL_RISK_SIGNAL",
    );
    assert.equal(page.listenerCount(), 0);
  });
}

test("normalization keeps only mapped detail fields instead of raw payloads", () => {
  const normalized = normalizeDetailResponse({
    data: {
      authorId: "star-1",
      fansNum: "9.8万",
      secretToken: "must-not-be-kept",
      notes: [{ title: "办公效率实测", url: "https://example.test/note/1" }],
    },
  });
  assert.equal(normalized.fields.followers_raw, "9.8万");
  assert.equal("secretToken" in normalized.fields, false);
  assert.equal(normalized.fields.recent_content[0].title, "办公效率实测");
});

test("normalization accepts explicit agency fields and ignores generic organization metadata", () => {
  const explicit = normalizeDetailResponse({ data: { mcnName: "精准机构" } });
  assert.equal(explicit.fields.agency, "精准机构");

  const generic = normalizeDetailResponse({
    data: { organization: "页面组织信息", institution: "认证机构类型" },
  });
  assert.equal("agency" in generic.fields, false);

  const nonText = normalizeDetailResponse({ data: { agency: true } });
  assert.equal("agency" in nonText.fields, false);
});

test("normalization extracts labeled Xingtu audience distributions", () => {
  const normalized = normalizeDetailResponse({
    data: {
      authorId: "star-audience",
      genderDistribution: [
        { label: "男性", rate: "62%" },
        { label: "女性", rate: "38%" },
      ],
      cityDistribution: [{ city: "上海", rate: "31%" }],
      personaDistribution: [{ name: "都市白领", proportion: "44%" }],
    },
  });
  assert.equal(normalized.fields.audience_male_rate_raw, "62%");
  assert.equal(normalized.fields.audience_female_rate_raw, "38%");
  assert.deepEqual(normalized.fields.audience_city_distribution, [
    { name: "上海", rate_raw: "31%" },
  ]);
  assert.deepEqual(normalized.fields.audience_persona_distribution, [
    { name: "都市白领", rate_raw: "44%" },
  ]);
});

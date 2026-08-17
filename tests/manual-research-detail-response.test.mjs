import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  captureDetailResponsesDuring,
  normalizeDetailResponse,
} from "../src/tools/manual-research/detail-response-capture.js";

function response(url, payload, status = 200) {
  return {
    url: () => url,
    status: () => status,
    request: () => ({ resourceType: () => "xhr" }),
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
        response(
          "https://pgy.xiaohongshu.com/api/solar/kol/data/kol-1/fans_overall_new_history",
          { data: { kolId: "kol-1", updateTime: "2026-08-16" } },
        ),
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

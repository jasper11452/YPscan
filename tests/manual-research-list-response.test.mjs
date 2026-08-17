import assert from "node:assert/strict";
import test from "node:test";

import {
  captureListResponseDuring,
  extractListResponse,
  mergeCapturedAndDomRows,
  normalizeListResponseRow,
} from "../src/tools/manual-research/list-response-capture.js";

function responsePage() {
  const listeners = new Set();
  return {
    on(event, listener) {
      if (event === "response") listeners.add(listener);
    },
    off(event, listener) {
      if (event === "response") listeners.delete(listener);
    },
    emit(response) {
      for (const listener of listeners) listener(response);
    },
    async waitForTimeout() {},
    listenerCount() {
      return listeners.size;
    },
  };
}

test("extracts the signed-in PGY filtered list without retaining raw response data", () => {
  const result = extractListResponse(
    {
      code: 0,
      data: {
        total: 41,
        kols: [
          {
            userId: "pgy-user-1",
            nickName: "咖啡研究所",
            fansNumber: 128000,
            picturePrice: 2600,
            videoPrice: 4800,
            estimateAllCpm: 52.3,
            city: "上海",
            contentTags: [{ name: "咖啡" }, { name: "生活方式" }],
          },
        ],
      },
    },
    "pgy",
  );

  assert.equal(result.total, 41);
  assert.equal(result.response_path, "data.kols");
  assert.deepEqual(
    {
      id: result.rows[0].platform_id,
      nickname: result.rows[0].nickname,
      followers: result.rows[0].followers_raw,
      price: result.rows[0].price_raw,
      cpm: result.rows[0].cpm_raw,
      city: result.rows[0].city,
    },
    {
      id: "pgy-user-1",
      nickname: "咖啡研究所",
      followers: "128000",
      price: "2600",
      cpm: "52.3",
      city: "上海",
    },
  );
  assert.equal("raw_response" in result.rows[0], false);
});

test("supports the published Xingtu author-list response and metric field arrays", () => {
  const result = extractListResponse(
    {
      data: {
        pagination: { total_count: 289 },
        authors: [
          {
            id: "6774914600774139912",
            nick_name: "办公技巧",
            city: "北京",
            fields: [
              { name: "follower", value: 235000 },
              { name: "expected_cpm", value: 31.6 },
              { name: "personal_interate_rate", value: "4.2%" },
            ],
          },
        ],
      },
    },
    "xingtu",
  );

  assert.equal(result.total, 289);
  assert.equal(result.response_path, "data.authors");
  assert.equal(result.rows[0].platform_id, "6774914600774139912");
  assert.equal(result.rows[0].nickname, "办公技巧");
  assert.equal(result.rows[0].followers_raw, "235000");
  assert.equal(result.rows[0].cpm_raw, "31.6");
  assert.equal(result.rows[0].interaction_rate, "4.2%");
  assert.equal(
    result.rows[0].detail_url,
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/6774914600774139912",
  );
  assert.equal(result.rows[0].detail_url_source, "list_response_author_id");
});

test("resolves relative Xingtu homepage routes returned by the creator list", () => {
  const row = normalizeListResponseRow(
    {
      authorId: "7324533389695025215",
      nickName: "WPS大老板",
      jumpUrl: "/ad/creator/author-homepage/douyin-video/7324533389695025215",
    },
    "xingtu",
  );

  assert.equal(
    row.detail_url,
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/7324533389695025215",
  );
  assert.equal(row.detail_url_source, "list_response_url");
});

test("supports the current Xingtu creator-square response with top-level authors", () => {
  const result = extractListResponse(
    {
      authors: [
        {
          star_id: "7497580738422767666",
          attribute_datas: {
            nick_name: "博哥办公",
            follower: 2572581,
            city: "德州市",
            price_1_20: 4900,
            price_20_60: 5300,
            price_60: 6200,
            prospective_60_cpm: 84.7342,
          },
        },
      ],
      pagination: { page: 1, limit: 20, total_count: 289, has_more: true },
    },
    "xingtu",
  );

  assert.equal(result.total, 289);
  assert.equal(result.response_path, "authors");
  assert.equal(result.rows[0].platform_id, "7497580738422767666");
  assert.equal(result.rows[0].nickname, "博哥办公");
  assert.equal(result.rows[0].followers_raw, "2572581");
  assert.equal(result.rows[0].city, "德州市");
  assert.equal(result.rows[0].quote_fields.price60, 6200);
});

test("discovers renamed creator arrays while rejecting non-creator JSON arrays", () => {
  const result = extractListResponse(
    {
      data: {
        total: 2,
        filters: [{ id: "tag-1", name: "科技" }],
        result: {
          records: [
            { oAuthorId: "author-1", authorName: "科技阿博", followerCount: 90000 },
            { oAuthorId: "author-2", authorName: "数码小周", followerCount: 120000 },
          ],
        },
      },
    },
    "xingtu",
  );

  assert.equal(result.response_path, "data.result.records");
  assert.deepEqual(
    result.rows.map((row) => row.platform_id),
    ["author-1", "author-2"],
  );
});

test("DOM display values enrich network identities instead of replacing them", () => {
  const rows = mergeCapturedAndDomRows(
    [normalizeListResponseRow({ authorId: "stable-id", nickName: "同一达人" }, "xingtu")],
    [
      {
        nickname: "同一达人",
        followers_raw: "23.5万",
        price_raw: "¥18,000",
        quote_fields: { "60s以上报价": "¥18,000" },
        tags: ["科技"],
      },
    ],
  );

  assert.equal(rows[0].platform_id, "stable-id");
  assert.equal(rows[0].followers_raw, "23.5万");
  assert.equal(rows[0].price_raw, "¥18,000");
  assert.deepEqual(rows[0].tags, ["科技"]);
});

test("clean network city wins over DOM text polluted by adjacent badges", () => {
  const rows = mergeCapturedAndDomRows(
    [
      normalizeListResponseRow(
        { authorId: "stable-id", nickName: "同一达人", city: "德州市" },
        "xingtu",
      ),
    ],
    [
      {
        nickname: "同一达人",
        city: "德州市 头部必选榜·周榜·职场·第14名",
        followers_raw: "257.3w",
      },
    ],
  );

  assert.equal(rows[0].city, "德州市");
  assert.equal(rows[0].followers_raw, "257.3w");
});

test("clean network nickname wins over a DOM row polluted by adjacent PGY fields", () => {
  const rows = mergeCapturedAndDomRows(
    [normalizeListResponseRow({ userId: "kol-1", nickName: "张张不脏脏" }, "pgy")],
    [{ nickname: "张张不脏脏 北京 考研过来人", followers_raw: "1.8w" }],
  );

  assert.equal(rows[0].nickname, "张张不脏脏");
  assert.equal(rows[0].followers_raw, "1.8w");
});

test("observes one browser-signed list response and removes the temporary listener", async () => {
  const page = responsePage();
  const response = {
    url: () => "https://pgy.xiaohongshu.com/api/solar/cooperator/blogger/v2?trace=secret",
    request: () => ({
      resourceType: () => "xhr",
      postDataJSON: () => ({ pageNum: 3, trackId: "not-returned" }),
    }),
    headers: () => ({ "content-type": "application/json;charset=UTF-8" }),
    json: async () => ({
      data: { total: 21, kols: [{ userId: "kol-3", nickName: "第三页博主" }] },
    }),
  };

  const observed = await captureListResponseDuring(page, "pgy", async () => {
    page.emit(response);
    return { refreshed: true };
  });

  assert.deepEqual(observed.action_result, { refreshed: true });
  assert.equal(observed.capture.page_number, 3);
  assert.equal(
    observed.capture.endpoint,
    "https://pgy.xiaohongshu.com/api/solar/cooperator/blogger/v2",
  );
  assert.equal(observed.capture.rows[0].platform_id, "kol-3");
  assert.equal(page.listenerCount(), 0);
  assert.equal(JSON.stringify(observed).includes("not-returned"), false);
  assert.equal(JSON.stringify(observed).includes("secret"), false);
});

test("captures the current Xingtu creator-square endpoint without retaining query data", async () => {
  const page = responsePage();
  const response = {
    url: () =>
      "https://www.xingtu.cn/gw/api/gsearch/search_for_author_square?tracking=not-returned",
    request: () => ({
      resourceType: () => "xhr",
      postDataJSON: () => ({ page: 1, opaque_signature: "not-returned" }),
    }),
    headers: () => ({ "content-type": "application/json" }),
    json: async () => ({
      authors: [
        {
          star_id: "7497580738422767666",
          attribute_datas: { nick_name: "博哥办公", follower: 2572581 },
        },
      ],
      pagination: { page: 1, total_count: 289 },
    }),
  };

  const observed = await captureListResponseDuring(page, "xingtu", async () => {
    page.emit(response);
    return { refreshed: true };
  });

  assert.equal(observed.capture.page_number, 1);
  assert.equal(
    observed.capture.endpoint,
    "https://www.xingtu.cn/gw/api/gsearch/search_for_author_square",
  );
  assert.equal(observed.capture.response_path, "authors");
  assert.equal(observed.capture.rows[0].platform_id, "7497580738422767666");
  assert.equal(JSON.stringify(observed).includes("not-returned"), false);
  assert.equal(page.listenerCount(), 0);
});

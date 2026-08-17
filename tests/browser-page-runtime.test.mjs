import assert from "node:assert/strict";
import test from "node:test";

import { readResultsPage } from "../src/tools/browser-page-runtime.js";

function withPageGlobals({ document, href }, run) {
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    location: globalThis.location,
  };
  globalThis.document = document;
  globalThis.location = { href };
  globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block" });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    });
}

function resultCell(text, { href = null, nickname = null, tags = [] } = {}) {
  const link = href ? { href, innerText: nickname ?? "", textContent: nickname ?? "" } : null;
  return {
    innerText: text,
    textContent: text,
    parentElement: null,
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector === "a") return link;
      if (selector.includes("nickname") && nickname) {
        return { innerText: nickname, textContent: nickname };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "a[href]") return link ? [link] : [];
      if (selector.includes("tag")) {
        return tags.map((tag) => ({ innerText: tag, textContent: tag }));
      }
      return [];
    },
  };
}

test("readResultsPage keeps Xingtu column values associated by row", async () => {
  const creators = [
    resultCell("达人甲 女 上海", {
      href: "https://www.douyin.com/user/123456789",
      nickname: "达人甲",
      tags: ["科技"],
    }),
    resultCell("达人乙 男 北京", {
      href: "https://www.douyin.com/user/987654321",
      nickname: "达人乙",
      tags: ["办公"],
    }),
  ];
  const columns = [
    creators,
    [resultCell("12万"), resultCell("25万")],
    [resultCell("8000"), resultCell("12000")],
    [resultCell("80"), resultCell("95")],
  ].map((cells) => ({
    querySelectorAll(selector) {
      return selector === ":scope > .content-cell" ? cells : [];
    },
  }));
  const sticky = {
    classList: { contains: (name) => name === "sticky-header" },
    innerText: "达人信息 粉丝数 21-60s报价 预期CPM",
  };
  const body = {
    classList: { contains: () => false },
    querySelectorAll(selector) {
      return selector === ":scope > .content-section > .content-column" ? columns : [];
    },
  };
  const document = {
    querySelectorAll(selector) {
      return selector === ".base-author-list .section-wrapper" ? [sticky, body] : [];
    },
  };

  const result = await withPageGlobals(
    { document, href: "https://www.xingtu.cn/ad/creator/market" },
    () => readResultsPage({ platform: "xingtu" }),
  );

  assert.equal(result.price_tier, "21-60s");
  assert.deepEqual(
    result.rows.map((row) => ({
      platform_id: row.platform_id,
      nickname: row.nickname,
      followers_raw: row.followers_raw,
      price_raw: row.price_raw,
      cpm_raw: row.cpm_raw,
    })),
    [
      {
        platform_id: "123456789",
        nickname: "达人甲",
        followers_raw: "12万",
        price_raw: "8000",
        cpm_raw: "80",
      },
      {
        platform_id: "987654321",
        nickname: "达人乙",
        followers_raw: "25万",
        price_raw: "12000",
        cpm_raw: "95",
      },
    ],
  );
});

test("Xingtu mismatched header and body columns are not cross-paired", async () => {
  const creator = resultCell("达人甲 女 上海", {
    href: "https://www.douyin.com/user/123456789",
    nickname: "达人甲",
  });
  const bodyColumns = [creator, resultCell("12万"), resultCell("8000"), resultCell("80")].map(
    (cell) => ({ querySelectorAll: () => [cell] }),
  );
  const sticky = {
    classList: { contains: (name) => name === "sticky-header" },
    innerText: "达人信息 21-60s报价 预期CPM",
    querySelectorAll: () => ["达人信息", "21-60s报价", "预期CPM"].map(resultCell),
  };
  const body = {
    classList: { contains: () => false },
    querySelectorAll: () => bodyColumns,
  };
  const document = {
    querySelectorAll: () => [sticky, body],
  };

  const result = await withPageGlobals(
    { document, href: "https://www.xingtu.cn/ad/creator/market" },
    () => readResultsPage({ platform: "xingtu" }),
  );

  assert.equal(result.rows[0].platform_id, "123456789");
  assert.equal(result.rows[0].followers_raw, null);
  assert.equal(result.rows[0].cpm_raw, null);
});

test("a follower count is never used as a fallback stable platform ID", async () => {
  const creator = resultCell("达人甲 女 上海 粉丝数 123456789", { nickname: "达人甲" });
  const columns = [{ querySelectorAll: () => [creator] }];
  const sticky = {
    classList: { contains: (name) => name === "sticky-header" },
    innerText: "达人信息",
  };
  const body = { classList: { contains: () => false }, querySelectorAll: () => columns };
  const document = { querySelectorAll: () => [sticky, body] };

  const result = await withPageGlobals(
    { document, href: "https://www.xingtu.cn/ad/creator/market" },
    () => readResultsPage({ platform: "xingtu" }),
  );
  assert.equal(result.rows[0].platform_id, null);
});

test("readResultsPage returns visible PGY cards and supports an empty result", async () => {
  const href = "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol";
  const cards = [
    resultCell("博主甲 女 上海 粉丝数 8万 图文报价 ￥3000", {
      href: "https://pgy.xiaohongshu.com/kol/900000001",
      nickname: "博主甲",
      tags: ["家居"],
    }),
    resultCell("博主乙 男 杭州 粉丝数 15万 视频报价 ￥5000", {
      href: "https://pgy.xiaohongshu.com/kol/900000002",
      nickname: "博主乙",
      tags: ["数码"],
    }),
  ];
  const document = {
    querySelectorAll(selector) {
      return selector === "thead th,[role=columnheader]" ? [] : cards;
    },
  };
  const result = await withPageGlobals({ document, href }, () =>
    readResultsPage({ platform: "pgy" }),
  );
  assert.deepEqual(
    result.rows.map((row) => ({ platform_id: row.platform_id, nickname: row.nickname })),
    [
      { platform_id: "900000001", nickname: "博主甲" },
      { platform_id: "900000002", nickname: "博主乙" },
    ],
  );

  const empty = await withPageGlobals({ document: { querySelectorAll: () => [] }, href }, () =>
    readResultsPage({ platform: "pgy" }),
  );
  assert.deepEqual(empty.rows, []);
});

test("readResultsPage keeps PGY table fields inside their original row", async () => {
  const href = "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol";
  const header = ["博主信息", "粉丝数", "图文报价", "阅读中位数", "互动中位数"].map((value) =>
    resultCell(value),
  );
  const makeRow = (cells) => ({
    innerText: cells.map((cell) => cell.innerText).join(" "),
    textContent: cells.map((cell) => cell.textContent).join(" "),
    parentElement: null,
    getClientRects: () => [{}],
    querySelector: () => null,
    querySelectorAll(selector) {
      return selector.startsWith(":scope > td") ? cells : [];
    },
  });
  const rows = [
    makeRow([
      resultCell("博主甲 女 上海", {
        href: "https://pgy.xiaohongshu.com/kol/900000001",
        nickname: "博主甲",
      }),
      resultCell("8万"),
      resultCell("3000"),
      resultCell("1.2万"),
      resultCell("800"),
    ]),
    makeRow([
      resultCell("博主乙 男 杭州", {
        href: "https://pgy.xiaohongshu.com/kol/900000002",
        nickname: "博主乙",
      }),
      resultCell("15万"),
      resultCell("5000"),
      resultCell("2.5万"),
      resultCell("1200"),
    ]),
  ];
  const headerRow = {
    innerText: "博主信息 近期笔记 粉丝数 阅读中位数（日常） 互动中位数（日常） 全部报价 操作",
    textContent: "博主信息 近期笔记 粉丝数 阅读中位数（日常） 互动中位数（日常） 全部报价 操作",
    parentElement: null,
    getClientRects: () => [{}],
    closest: (selector) => (selector === "thead" ? {} : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const document = {
    querySelectorAll(selector) {
      return selector === "thead th,[role=columnheader]" ? header : [headerRow, ...rows];
    },
  };

  const result = await withPageGlobals({ document, href }, () =>
    readResultsPage({ platform: "pgy" }),
  );
  assert.deepEqual(
    result.rows.map((row) => ({
      nickname: row.nickname,
      followers: row.followers_raw,
      price: row.price_raw,
      read_median: row.read_median,
      interaction_median: row.interaction_median,
    })),
    [
      {
        nickname: "博主甲",
        followers: "8万",
        price: "3000",
        read_median: "1.2万",
        interaction_median: "800",
      },
      {
        nickname: "博主乙",
        followers: "15万",
        price: "5000",
        read_median: "2.5万",
        interaction_median: "1200",
      },
    ],
  );
});

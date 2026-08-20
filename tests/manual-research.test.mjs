import assert from "node:assert/strict";
import test from "node:test";

import { createStagedManualResearch as createManualResearch } from "./helpers/manual-staged-runner.mjs";
import {
  compileManualResearchPlan,
  mergeManualCandidates,
} from "../src/tools/manual-research-plan.js";
import {
  MANUAL_RESEARCH_PARAMETERS,
  validateManualFilterSelectionParams,
  validateManualResearchParams,
} from "../src/tools/manual-research-protocol.js";
import { detailGroupsForPlan } from "../src/tools/manual-research-detail.js";

function fact(id, kind, normalizedValue, extra = {}) {
  return {
    id,
    kind,
    status: "present",
    disposition: "active",
    strength: "hard",
    normalized_value: normalizedValue,
    source: { id: `source-${id}`, quote: String(normalizedValue) },
    ...extra,
  };
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function fakeBrowser(url) {
  const page = { url: () => url };
  return {
    page,
    closed: false,
    contexts() {
      return [{ pages: () => [page] }];
    },
    close() {
      this.closed = true;
    },
  };
}

function successfulAdapter(
  actionLog,
  { exportStatus = "complete", failKeyword = null, pageTotal = 2 } = {},
) {
  let keyword = "";
  let currentPage = 0;
  return {
    async prepare() {
      actionLog.push(["prepare"]);
    },
    async reset() {
      actionLog.push(["reset"]);
    },
    async applyFilter(filter) {
      actionLog.push(["filter", filter.control, filter.min, filter.max]);
      return { applied: true, menu_id: `menu-${filter.control}`, readback: filter.control };
    },
    async setPriceView(value) {
      actionLog.push(["price_view", value]);
      return { applied: true, readback: value };
    },
    async search(value) {
      keyword = value;
      currentPage = 0;
      actionLog.push(["search", value, "Enter"]);
      return value === failKeyword
        ? { applied: false, reason: "keyword_input_not_found" }
        : { applied: true, result_count: 3 };
    },
    async verifySelection() {
      return { valid: true };
    },
    async readPage(pageNumber) {
      currentPage = pageNumber;
      actionLog.push(["read", keyword, pageNumber]);
      const suffix = keyword === "咖啡" ? "coffee" : "camping";
      return {
        page_number: pageNumber,
        price_tier: "植入视频",
        source_url: `https://www.xingtu.cn/ad/creator/market?page=${pageNumber}`,
        rows: [
          {
            platform_id: "shared-creator",
            nickname: "共同达人",
            detail_url: "https://www.xingtu.cn/creator/shared-creator",
            price_raw: "1800",
            followers_raw: "20万",
          },
          {
            platform_id: `${suffix}-${pageNumber}`,
            nickname: `${keyword}-${pageNumber}`,
            detail_url: `https://www.xingtu.cn/creator/${suffix}-${pageNumber}`,
            price_raw: "1800",
            followers_raw: "20万",
          },
        ],
      };
    },
    async nextPage() {
      actionLog.push(["next", currentPage]);
      return currentPage < pageTotal;
    },
    async collectDetail(candidate) {
      actionLog.push(["detail", candidate.platform_id]);
      return {
        candidate_ref: candidate.platform_id,
        platform_id: candidate.platform_id,
        nickname: candidate.nickname,
        detail_url: candidate.detail_url,
        status: "complete",
        source_type: "browser_response",
        captured_at: "2026-08-17T00:00:00.000Z",
        response_endpoints: ["/gw/api/detail"],
        fields: {
          followers_raw: candidate.followers_raw,
          price_by_tier: { 植入视频: candidate.price_raw },
          recent_content: [{ title: `${candidate.nickname}近期内容` }],
        },
      };
    },
    async export() {
      actionLog.push(["export", keyword]);
      return exportStatus === "complete"
        ? { status: "complete", kind: "lark_sheet", url: `https://example.test/${keyword}` }
        : { status: exportStatus, reason: "fresh_link_not_observed" };
    },
  };
}

function baseParams(extra = {}) {
  return {
    requirement_id: "requirement-1",
    platform: "douyin",
    facts: [
      fact("product", "product_name", "咖啡"),
      fact("direction", "content_direction", "露营"),
      fact("count", "creator_count", 3, { role: "submission" }),
      fact("price", "creator_price", 2_000, { operator: "lte" }),
      fact("duration", "video_duration", 60, { operator: "gte", minimum: 60, maximum: null }),
    ],
    ...extra,
  };
}

test("manual plan expands the customer creator price once to 50%–120%", () => {
  const plan = compileManualResearchPlan({
    platform: "xingtu",
    facts: baseParams().facts,
  });

  assert.deepEqual(plan.keywords, ["咖啡", "露营"]);
  assert.equal(plan.price_view, "植入视频");
  assert.equal(plan.price_view_source, "platform_default");
  assert.equal(plan.price_semantics_version, 2);
  assert.deepEqual(
    plan.filters.find((item) => item.fact_kind === "creator_price"),
    {
      fact_id: "price",
      fact_kind: "creator_price",
      control: "creator_price",
      mode: "range",
      source: { id: "source-price", quote: "2000" },
      min: 1_000,
      max: 2_400,
      unit: "yuan",
      range_policy: "customer_value_50_to_120_percent",
      input_anchor: {
        operator: "lte",
        normalized_value: 2_000,
        minimum: null,
        maximum: null,
        qualifier: "generic",
      },
    },
  );
  assert.deepEqual(plan.price_policy, {
    creator_price: "customer_value_50_to_120_percent",
    minimum_factor: 0.5,
    maximum_factor: 1.2,
    quote_tier: "植入视频",
    other_metrics_expanded: false,
    applied_ranges: [
      {
        fact_id: "price",
        min: 1_000,
        max: 2_400,
        unit: "yuan",
        input_anchor: {
          operator: "lte",
          normalized_value: 2_000,
          minimum: null,
          maximum: null,
          qualifier: "generic",
        },
      },
    ],
  });
});

test("manual plan preserves business summary fields for the Excel template", () => {
  const plan = compileManualResearchPlan({
    platform: "pgy",
    facts: [
      fact("brand", "brand_name", "千问"),
      fact("project", "project_name", "千问8月推广"),
      fact("deadline", "submission_deadline", "2026-08-20T10:00:00+08:00"),
      fact("media", "responsible_media", "杨小玉"),
      fact("count", "creator_count", 5),
    ],
  });

  assert.deepEqual(plan.export_summary, {
    brand_product: "千问",
    project_name: "千问8月推广",
    submission_deadline: "2026-08-20T10:00:00+08:00",
    responsible_media: "杨小玉",
  });
});

test("manual plan accepts parser facts that carry numeric data in value", () => {
  const plan = compileManualResearchPlan({
    platform: "pgy",
    quote_type: "图文",
    facts: [
      fact("product", "product_name", "家居"),
      { ...fact("count", "creator_count", undefined), value: 10, role: "submission" },
      {
        ...fact("followers", "follower_count", undefined),
        value: 100_000,
        operator: "gte",
      },
      { ...fact("cpm", "cpm_max", undefined), value: 500, operator: "lte" },
      { ...fact("cpe", "cpe_max", undefined), value: 20, operator: "lte" },
      { ...fact("price", "creator_price", undefined), value: 2_000, operator: "lte" },
    ],
  });

  assert.equal(plan.target_count, 10);
  assert.deepEqual(
    Object.fromEntries(
      plan.filters.map((filter) => [filter.control, { min: filter.min, max: filter.max }]),
    ),
    {
      follower_count: { min: 100_000, max: null },
      cpm: { min: 0, max: 500 },
      cpe: { min: 0, max: 20 },
      creator_price: { min: 1_000, max: 2_400 },
    },
  );
});

test("manual price expansion turns a 100k cap into 50k–120k and expands range edges", () => {
  const capped = compileManualResearchPlan({
    platform: "pgy",
    facts: [
      fact("format", "content_format", "picture"),
      fact("price", "creator_price", 100_000, {
        operator: "lte",
        qualifier: "picture",
        minimum: 0,
        maximum: 100_000,
      }),
    ],
    keywords: ["家居"],
  });
  assert.deepEqual(
    capped.filters.find((item) => item.control === "creator_price"),
    {
      fact_id: "price",
      fact_kind: "creator_price",
      control: "creator_price",
      mode: "range",
      source: { id: "source-price", quote: "100000" },
      min: 50_000,
      max: 120_000,
      unit: "yuan",
      range_policy: "customer_value_50_to_120_percent",
      input_anchor: {
        operator: "lte",
        normalized_value: 100_000,
        minimum: 0,
        maximum: 100_000,
        qualifier: "picture",
      },
    },
  );

  const ranged = compileManualResearchPlan({
    platform: "pgy",
    facts: [
      fact("format", "content_format", "video"),
      fact("price", "creator_price", null, {
        operator: "between",
        qualifier: "video",
        minimum: 80_000,
        maximum: 100_000,
      }),
    ],
    keywords: ["家居"],
  });
  assert.equal(ranged.price_view, "视频");
  assert.deepEqual(
    ranged.filters.find((item) => item.control === "creator_price"),
    {
      fact_id: "price",
      fact_kind: "creator_price",
      control: "creator_price",
      mode: "range",
      source: { id: "source-price", quote: "null" },
      min: 40_000,
      max: 120_000,
      unit: "yuan",
      range_policy: "customer_value_50_to_120_percent",
      input_anchor: {
        operator: "between",
        normalized_value: null,
        minimum: 80_000,
        maximum: 100_000,
        qualifier: "video",
      },
    },
  );
});

test("Xingtu quote type is independent from duration and maps gender to visible controls", () => {
  const xingtu = compileManualResearchPlan({
    platform: "xingtu",
    facts: [
      fact("duration", "video_duration", "duration_l3"),
      fact("gender", "creator_gender", "female"),
      fact("price", "creator_price", 2_000, {
        operator: "exact",
        maximum: 2_000,
        quote: "定制视频报价 2000",
      }),
    ],
    keywords: ["办公软件"],
  });
  assert.equal(xingtu.price_view, "定制视频");
  assert.deepEqual(xingtu.filters.find((item) => item.control === "creator_gender").values, ["女"]);
  assert.deepEqual(
    xingtu.filters.filter((item) => item.control === "creator_price").map((item) => item.fact_id),
    ["price"],
  );
  assert.deepEqual(
    xingtu.filters
      .filter((item) => item.control === "creator_price")
      .map((item) => [item.min, item.max, item.range_policy]),
    [[1_000, 2_400, "customer_value_50_to_120_percent"]],
  );
  assert.deepEqual(xingtu.unexpressed, []);

  assert.throws(
    () =>
      compileManualResearchPlan({
        platform: "pgy",
        facts: [
          fact("picture-price", "creator_price", 800, { qualifier: "picture" }),
          fact("video-price", "creator_price", 1_500, { qualifier: "video" }),
        ],
        keywords: ["咖啡"],
      }),
    { code: "YPSCAN_MANUAL_QUOTE_TYPE_CONFLICT" },
  );
});

test("Xingtu keeps audience and semantic hard conditions out of unstable list controls", () => {
  const plan = compileManualResearchPlan({
    platform: "xingtu",
    keywords: ["办公软件"],
    facts: [
      fact("duration", "video_duration", "duration_l3"),
      fact("price", "creator_price", 20_000, { operator: "lte" }),
      fact("followers", "follower_count", 100_000, { operator: "gte" }),
      fact("cpm", "cpm_max", 100, { operator: "lte" }),
      fact("male", "audience_male_rate", 75, { operator: "lte", unit: "percent" }),
      fact("city", "audience_city", "一二线"),
      fact("content", "content_direction", "办公软件相关"),
      fact("excluded", "excluded_content", "低沉、都市蓝领、都市银发", {
        operator: "not_in",
      }),
    ],
  });

  assert.deepEqual(
    plan.filters.map((item) => item.control),
    ["creator_price", "follower_count", "cpm"],
  );
  assert.deepEqual(plan.detail_filters, [
    {
      fact_id: "male",
      fact_kind: "audience_male_rate",
      control: "audience_male_rate",
      mode: "range",
      source: { id: "source-male", quote: "75" },
      min: 0,
      max: 0.75,
      unit: "ratio",
      stage: "detail",
    },
  ]);
  assert.deepEqual(
    plan.review_requirements.map((item) => item.fact_kind),
    ["audience_city", "content_direction", "excluded_content"],
  );
  assert.equal(detailGroupsForPlan(plan).includes("audience"), true);
});

test("open-ended numeric facts preserve null instead of coercing it to zero", () => {
  const plan = compileManualResearchPlan({
    platform: "xingtu",
    facts: [fact("followers", "follower_count", 100_000, { operator: "gte" })],
    keywords: ["办公软件"],
  });
  assert.deepEqual(plan.filters[0], {
    fact_id: "followers",
    fact_kind: "follower_count",
    control: "follower_count",
    mode: "range",
    source: { id: "source-followers", quote: "100000" },
    min: 100_000,
    max: null,
    unit: "count",
  });
});

function noResultAdapter(page) {
  return {
    async prepare() {},
    async reset() {},
    async applyFilter() {
      return { applied: true };
    },
    async setPriceView(value) {
      return { applied: true, readback: value };
    },
    async search() {
      return { applied: true, result_count: 0 };
    },
    async readPage() {
      return { rows: [], source_url: page.url(), price_tier: null };
    },
    async nextPage() {
      return false;
    },
    async export() {
      throw new Error("an empty result must not export");
    },
  };
}

test("manual research navigates directly to each platform's canonical creator market", async () => {
  const cases = [
    {
      platform: "xingtu",
      initialUrl: "https://www.xingtu.cn/",
      targetUrl: "https://www.xingtu.cn/ad/creator/market",
    },
    {
      platform: "pgy",
      initialUrl: "https://pgy.xiaohongshu.com/",
      targetUrl: "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
    },
  ];

  for (const item of cases) {
    let currentUrl = item.initialUrl;
    let newPageCalls = 0;
    const navigations = [];
    const page = {
      url: () => currentUrl,
      evaluate: async () => ({ focused: true, visible: true }),
      goto: async (url) => {
        navigations.push(url);
        currentUrl = url;
      },
    };
    const browser = {
      contexts: () => [
        {
          pages: () => [page],
          newPage: async () => {
            newPageCalls += 1;
            throw new Error("the existing platform page must be reused");
          },
        },
      ],
    };
    const run = createManualResearch({
      connectOverCDP: async () => browser,
      createAdapter: (_platform, selectedPage) => noResultAdapter(selectedPage),
    });

    const data = payload(
      await run(
        baseParams({
          platform: item.platform,
          page_url: item.initialUrl,
          keywords: ["咖啡"],
        }),
      ),
    );

    assert.equal(data.success, true);
    assert.equal(data.source_url, item.targetUrl);
    assert.deepEqual(navigations, [item.targetUrl]);
    assert.equal(newPageCalls, 0);
  }
});

test("manual research opens one canonical market page when no platform page exists", async () => {
  const targetUrl = "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol";
  const navigations = [];
  let newPageCalls = 0;
  let currentUrl = "about:blank";
  const marketPage = {
    url: () => currentUrl,
    goto: async (url) => {
      navigations.push(url);
      currentUrl = url;
    },
  };
  const unrelatedPage = { url: () => "https://example.com/existing" };
  let createdPage = null;
  const context = {
    pages: () => [unrelatedPage, ...(createdPage ? [createdPage] : [])],
    newPage: async () => {
      newPageCalls += 1;
      createdPage = marketPage;
      return createdPage;
    },
  };
  const run = createManualResearch({
    connectOverCDP: async () => ({ contexts: () => [context] }),
    createAdapter: (_platform, selectedPage) => noResultAdapter(selectedPage),
  });

  const data = payload(
    await run(baseParams({ platform: "pgy", keywords: ["咖啡"], page_url: undefined })),
  );

  assert.equal(data.success, true);
  assert.equal(data.source_url, targetUrl);
  assert.equal(newPageCalls, 1);
  assert.deepEqual(navigations, [targetUrl]);
});

test("manual research uses browser list pagination first and skips quota-limited export when sufficient", async () => {
  const actions = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  let endpoint = null;
  const run = createManualResearch({
    browserCdpUrl: "http://127.0.0.1:18800",
    connectOverCDP: async (value) => {
      endpoint = value;
      return browser;
    },
    createAdapter: () => successfulAdapter(actions),
  });

  const data = payload(await run(baseParams()));

  assert.equal(endpoint, "http://127.0.0.1:18800");
  assert.equal(data.status, "partial");
  assert.equal(data.success, true);
  assert.equal(data.original_price_policy, "customer_facts_as_expansion_anchor");
  assert.equal(data.manual_price_policy, "customer_value_50_to_120_percent");
  assert.deepEqual(
    data.branches.map((branch) => [branch.keyword, branch.page_count, branch.export.status]),
    [
      ["咖啡", 2, "skipped"],
      ["露营", 2, "skipped"],
    ],
  );
  assert.equal(data.export_fallback.status, "skipped");
  assert.equal(data.export_fallback.quota_consumed, false);
  assert.equal(data.candidate_count, 5);
  assert.deepEqual(
    data.candidates.find((candidate) => candidate.platform_id === "shared-creator").source_branches,
    ["keyword-1", "keyword-2"],
  );
  assert.equal(actions.filter((item) => item[0] === "search" && item[2] === "Enter").length, 2);
  assert.equal(actions.filter((item) => item[0] === "export").length, 0);
  assert.equal(browser.closed, false, "connecting over CDP must not close the host Browser");
});

test("the current delivery count bounds the global pool and skips remaining keyword branches", async () => {
  const actions = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const adapter = successfulAdapter(actions, { pageTotal: 1 });
  adapter.readPage = async (pageNumber) => ({
    page_number: pageNumber,
    price_tier: "植入视频",
    source_url: browser.page.url(),
    rows: Array.from({ length: 20 }, (_, index) => ({
      platform_id: `creator-${index + 1}`,
      nickname: `达人${index + 1}`,
      price_raw: "10000",
      followers_raw: "20万",
      ...(index === 0 ? { quote_fields: { raw_price60: 10_000 } } : {}),
    })),
  });
  adapter.nextPage = async () => false;
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => adapter,
  });

  const data = payload(
    await run({
      requirement_id: "current-batch-10",
      platform: "xingtu",
      facts: [fact("product", "product_name", "办公软件"), fact("count", "creator_count", 10)],
      keywords: ["办公软件", "职场", "AI工具", "效率办公"],
    }),
  );

  assert.equal(data.plan.target_count, 10);
  assert.equal(data.plan.collection_target, 20);
  assert.equal(data.candidate_count, 20);
  assert.deepEqual(
    data.branches.map((branch) => branch.keyword),
    ["办公软件"],
  );
  assert.deepEqual(
    actions.filter((item) => item[0] === "search").map((item) => item[1]),
    ["办公软件"],
  );
  assert.equal(data.candidates[0].list_fields, undefined);
  assert.equal(data.candidates[0].evidence, undefined);
  assert.deepEqual(data.detail_review, [
    "original_brief_relevance",
    "recent_content",
    "semantic_relevance",
    "customer_price_50_to_120_percent",
  ]);
  assert.equal(data.detail_tasks[0].review, undefined);
  assert.equal(data.export_fallback.quota_consumed, false);
});

test("price-rejected rows do not stop later pages or keyword branches", async () => {
  const actions = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  let keyword = "";
  let currentPage = 0;
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => ({
      async prepare() {},
      async reset() {},
      async setPriceView(value) {
        return { applied: true, readback: value };
      },
      async applyFilter() {
        return { applied: true };
      },
      async search(value) {
        keyword = value;
        currentPage = 0;
        actions.push(["search", value]);
        return { applied: true, result_count: 40 };
      },
      async readPage(pageNumber) {
        currentPage = pageNumber;
        actions.push(["read", keyword, pageNumber]);
        return {
          price_tier: "植入视频",
          source_url: browser.page.url(),
          rows: Array.from({ length: 20 }, (_, index) => ({
            platform_id: `${keyword}-${pageNumber}-${index}`,
            nickname: `${keyword}达人${pageNumber}-${index}`,
            price_raw: pageNumber === 1 ? "800" : "1800",
          })),
        };
      },
      async nextPage() {
        return currentPage < 2;
      },
      async export() {
        return { status: "complete" };
      },
    }),
  });

  const data = payload(
    await run({
      ...baseParams(),
      keywords: ["办公软件", "效率工具"],
      facts: [
        ...baseParams().facts.filter((item) => item.kind !== "creator_count"),
        fact("count", "creator_count", 15, { role: "submission" }),
      ],
    }),
  );

  assert.equal(data.delivery_status, "shortfall");
  assert.equal(data.eligible_candidate_count, 40);
  assert.equal(data.rejected_candidate_count, 40);
  assert.deepEqual(
    actions.filter(([kind]) => kind === "search").map(([, value]) => value),
    ["办公软件", "效率工具"],
  );
  assert.deepEqual(
    actions.filter(([kind]) => kind === "read").map(([, value, page]) => [value, page]),
    [
      ["办公软件", 1],
      ["办公软件", 2],
      ["效率工具", 1],
      ["效率工具", 2],
    ],
  );
});

test("records without stable IDs or detail URLs remain separate", () => {
  const merged = mergeManualCandidates([
    { platform: "pgy", nickname: "同名", source_branches: ["a"] },
    { platform: "pgy", nickname: "同名", source_branches: ["b"] },
  ]);
  assert.equal(merged.length, 2);
});

test("PGY-style 18-page result sets retain row association and deduplicate every page", async () => {
  const browser = fakeBrowser("https://pgy.xiaohongshu.com/solar/pre-trade/note/kol");
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => successfulAdapter([], { pageTotal: 18 }),
  });
  const data = payload(
    await run(
      baseParams({
        platform: "xiaohongshu",
        page_url: "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
        keywords: ["咖啡"],
        facts: baseParams().facts.filter(
          (item) => !["creator_price", "video_duration"].includes(item.kind),
        ),
      }),
    ),
  );
  assert.equal(data.status, "partial");
  assert.equal(data.branches[0].page_count, 18);
  assert.equal(data.candidate_count, 19);
});

test("a later branch selection failure blocks collection after one bounded retry", async () => {
  const actions = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => successfulAdapter(actions, { failKeyword: "露营" }),
  });

  const result = await run(baseParams());
  const data = payload(result);
  assert.equal(data.status, "failed");
  assert.equal(data.success, false);
  assert.equal(data.ready_for_collection, false);
  assert.equal(data.failed_stage, "keyword");
  assert.equal(data.failed_control, "keyword");
  assert.equal(data.error.code, "YPSCAN_MANUAL_KEYWORD_NOT_APPLIED");
  assert.equal(result.isError, true);
  assert.equal(actions.filter((item) => item[0] === "search" && item[1] === "露营").length, 2);
});

test("a transient ordinary UI failure recovers once and completes the same branch", async () => {
  const actions = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const adapter = successfulAdapter(actions);
  const reset = adapter.reset;
  let failed = false;
  adapter.reset = async () => {
    actions.push(["reset-attempt"]);
    if (!failed) {
      failed = true;
      throw new Error("overlay intercepted click");
    }
    await reset();
  };
  adapter.recover = async () => {
    actions.push(["recover-popup"]);
  };
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => adapter,
  });

  const data = payload(await run(baseParams({ keywords: ["咖啡"] })));
  assert.equal(data.status, "partial");
  assert.equal(data.branches[0].recovery.attempted, true);
  assert.equal(data.branches[0].recovery.attempts, 2);
  assert.equal(actions.filter((item) => item[0] === "recover-popup").length, 1);
});

test("login or CAPTCHA handoff is an explicit needs_user_action result", async () => {
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => ({
      async prepare() {
        throw Object.assign(new Error("请登录"), { code: "YPSCAN_MANUAL_LOGIN_REQUIRED" });
      },
    }),
  });

  const result = await run(baseParams());
  const data = payload(result);
  assert.equal(data.status, "needs_user_action");
  assert.equal(data.success, false);
  assert.equal(data.error.code, "YPSCAN_MANUAL_LOGIN_REQUIRED");
  assert.equal(result.isError, true);
});

test("an explicit zero-result search does not waste an export quota", async () => {
  let exports = 0;
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => ({
      async prepare() {},
      async reset() {},
      async applyFilter() {
        return { applied: true };
      },
      async setPriceView() {
        return { applied: true };
      },
      async search() {
        return { applied: true, result_count: 0 };
      },
      async readPage() {
        return { rows: [], source_url: browser.page.url(), price_tier: "植入视频" };
      },
      async nextPage() {
        return false;
      },
      async export() {
        exports += 1;
        return { status: "complete" };
      },
    }),
  });
  const data = payload(await run(baseParams({ keywords: ["无结果品牌词"] })));
  assert.equal(data.status, "complete");
  assert.equal(data.candidate_count, 0);
  assert.equal(data.export_fallback.status, "skipped");
  assert.equal(exports, 0);
});

test("an unapplied hard filter blocks collection without consuming export quota", async () => {
  const actions = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const adapter = successfulAdapter(actions);
  adapter.applyFilter = async (filter) => ({
    applied: false,
    reason: "filter_row_not_found",
    control: filter.control,
  });
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => adapter,
  });

  const data = payload(await run(baseParams({ keywords: ["咖啡"] })));
  assert.equal(data.status, "failed");
  assert.equal(data.ready_for_collection, false);
  assert.equal(data.error.code, "YPSCAN_MANUAL_FILTER_NOT_APPLIED");
  assert.equal(data.verification.failed_filters[0].reason, "filter_row_not_found");
  assert.equal(
    actions.some((item) => item[0] === "export"),
    false,
  );
});

test("a failed price-tier readback stops before search after one bounded retry", async () => {
  const actions = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const adapter = successfulAdapter(actions);
  adapter.setPriceView = async (value) => {
    actions.push(["price_view", value]);
    return {
      applied: false,
      reason: "price_view_readback_mismatch",
      readback: "达人信息 定制视频报价",
    };
  };
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => adapter,
  });

  const data = payload(await run(baseParams({ keywords: ["咖啡"] })));
  assert.equal(data.status, "failed");
  assert.equal(data.ready_for_collection, false);
  assert.equal(data.error.code, "YPSCAN_MANUAL_PRICE_VIEW_NOT_APPLIED");
  assert.equal(data.verification.price_view.readback, "达人信息 定制视频报价");
  assert.deepEqual(
    actions.filter(([action]) =>
      ["price_view", "search", "read", "filter", "export"].includes(action),
    ),
    [
      ["price_view", "植入视频"],
      ["price_view", "植入视频"],
    ],
  );
});

test("a preserved-filter mismatch falls back safely and a price-tier failure cannot export", async () => {
  const actions = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const adapter = successfulAdapter(actions);
  let priceViewCalls = 0;
  adapter.setPriceView = async (value) => {
    priceViewCalls += 1;
    actions.push(["price_view", value]);
    return priceViewCalls === 1
      ? { applied: true, readback: value }
      : {
          applied: false,
          reason: "price_view_readback_mismatch",
          readback: "达人信息 定制视频报价",
        };
  };
  adapter.verifySelection = async ({ branch }) => ({ valid: branch.keyword !== "露营" });
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => adapter,
  });
  const facts = [
    ...baseParams().facts.filter((item) => item.kind !== "creator_count"),
    fact("count-10", "creator_count", 10, { role: "submission" }),
  ];

  const data = payload(await run(baseParams({ facts })));
  assert.equal(data.status, "failed");
  assert.equal(data.ready_for_collection, false);
  assert.equal(data.error.code, "YPSCAN_MANUAL_PRICE_VIEW_NOT_APPLIED");
  assert.equal(
    actions.some(([action]) => action === "export"),
    false,
  );
  assert.equal(
    actions.some(([action, keyword]) => action === "search" && keyword === "露营"),
    true,
  );
});

test("native export is attempted once only after DOM candidates miss the requested target", async () => {
  const actions = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => successfulAdapter(actions, { exportStatus: "pending" }),
  });
  const data = payload(
    await run(
      baseParams({
        keywords: ["咖啡", "露营"],
        facts: [...baseParams().facts, fact("larger-count", "creator_count", 50)],
      }),
    ),
  );
  assert.equal(data.status, "partial");
  assert.ok(data.candidate_count > 0);
  assert.equal(data.export_fallback.status, "pending");
  assert.deepEqual(data.export_fallback.reasons, ["candidate_target_not_met"]);
  assert.equal(actions.filter((item) => item[0] === "export").length, 1);
});

test("detail collection is serial, bounded to twice the target and retries an ordinary failure once", async () => {
  const actions = [];
  const attempts = new Map();
  let active = 0;
  let maxActive = 0;
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => ({
      async prepare() {},
      async reset() {},
      async setPriceView(value) {
        return { applied: true, readback: value };
      },
      async applyFilter() {
        return { applied: true };
      },
      async search() {
        return { applied: true, result_count: 3 };
      },
      async readPage() {
        return {
          price_tier: "植入视频",
          source_url: browser.page.url(),
          rows: Array.from({ length: 3 }, (_, index) => ({
            platform_id: `serial-${index + 1}`,
            nickname: `串行达人${index + 1}`,
            price_raw: "1800",
          })),
        };
      },
      async nextPage() {
        return false;
      },
      async collectDetail(candidate) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const count = (attempts.get(candidate.platform_id) ?? 0) + 1;
        attempts.set(candidate.platform_id, count);
        actions.push(["detail", candidate.platform_id, count]);
        active -= 1;
        if (candidate.platform_id === "serial-1" && count === 1) {
          throw Object.assign(new Error("temporary navigation failure"), {
            code: "YPSCAN_MANUAL_DETAIL_FAILED",
          });
        }
        return {
          candidate_ref: candidate.platform_id,
          status: "complete",
          fields: {
            price_by_tier: { 植入视频: candidate.price_raw },
            recent_content: [{ title: "办公效率内容" }],
          },
        };
      },
      async recover() {
        actions.push(["recover"]);
      },
      async paceDetail() {
        actions.push(["pace"]);
      },
      async export() {
        return { status: "complete" };
      },
    }),
  });

  const data = payload(
    await run({
      ...baseParams(),
      facts: baseParams().facts.map((item) =>
        item.kind === "creator_count" ? { ...item, normalized_value: 1 } : item,
      ),
      keywords: ["办公软件"],
    }),
  );

  assert.equal(data.detail_collection.planned_count, 2);
  assert.equal(data.detail_collection.completed_count, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(actions, [
    ["detail", "serial-1", 1],
    ["recover"],
    ["detail", "serial-1", 2],
    ["pace"],
    ["detail", "serial-2", 1],
  ]);
});

test("detail risk signals stop the batch immediately and are never retried", async () => {
  let attempts = 0;
  let recoveries = 0;
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => ({
      async prepare() {},
      async reset() {},
      async setPriceView(value) {
        return { applied: true, readback: value };
      },
      async applyFilter() {
        return { applied: true };
      },
      async search() {
        return { applied: true, result_count: 1 };
      },
      async readPage() {
        return {
          price_tier: "植入视频",
          source_url: browser.page.url(),
          rows: [{ platform_id: "risk-1", nickname: "风险达人", price_raw: "1800" }],
        };
      },
      async nextPage() {
        return false;
      },
      async collectDetail() {
        attempts += 1;
        throw Object.assign(new Error("429"), {
          code: "YPSCAN_MANUAL_DETAIL_RISK_SIGNAL",
        });
      },
      async recover() {
        recoveries += 1;
      },
      async export() {
        return { status: "complete" };
      },
    }),
  });

  const data = payload(await run({ ...baseParams(), keywords: ["办公软件"] }));
  assert.equal(data.status, "needs_user_action");
  assert.equal(data.error.code, "YPSCAN_MANUAL_DETAIL_RISK_SIGNAL");
  assert.equal(data.interruption.phase, "detail");
  assert.equal(data.user_action.resume_tool, "ypscan_manual_research");
  assert.deepEqual(data.user_action.resume_args, {
    operation: "collect",
    requirement_id: "requirement-1",
    platform: "xingtu",
    run_id: data.artifact.run_id,
    selection_id: data.user_action.resume_args.selection_id,
  });
  assert.equal(attempts, 1);
  assert.equal(recoveries, 0);
});

test("a list CPM violation is rejected before any detail navigation", async () => {
  const detailIds = [];
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const run = createManualResearch({
    connectOverCDP: async () => browser,
    createAdapter: () => ({
      async prepare() {},
      async reset() {},
      async verifyBaseline() {
        return { valid: true };
      },
      async setPriceView(value) {
        return { applied: true, readback: value };
      },
      async applyFilter(filter) {
        return { applied: true, readback: filter.control };
      },
      async search() {
        return { applied: true, result_count: 2 };
      },
      async verifySelection() {
        return { valid: true };
      },
      async readPage() {
        return {
          price_tier: "植入视频",
          source_url: browser.page.url(),
          rows: [
            {
              platform_id: "cpm-rejected",
              nickname: "高CPM达人",
              price_raw: "1800",
              cpm_raw: "187",
            },
            {
              platform_id: "cpm-passed",
              nickname: "合规达人",
              price_raw: "1800",
              cpm_raw: "80",
            },
          ],
        };
      },
      async nextPage() {
        return false;
      },
      async collectDetail(candidate) {
        detailIds.push(candidate.platform_id);
        return {
          candidate_ref: candidate.platform_id,
          status: "complete",
          fields: { cpm_raw: candidate.cpm_raw, recent_content: [{ title: "办公内容" }] },
        };
      },
      async export() {
        return { status: "complete" };
      },
    }),
  });
  const data = payload(
    await run({
      ...baseParams(),
      keywords: ["办公软件"],
      facts: [
        ...baseParams().facts.map((item) =>
          item.kind === "creator_count" ? { ...item, normalized_value: 1 } : item,
        ),
        fact("cpm", "cpm_max", 100, { operator: "lte" }),
      ],
    }),
  );
  assert.deepEqual(detailIds, ["cpm-passed"]);
  assert.equal(data.list_hard_rejected_candidate_count, 1);
  assert.equal(data.list_hard_pass_candidate_count, 1);
});

test("public protocol exposes only Playwright CLI operations while internal migration remains", () => {
  assert.equal(MANUAL_RESEARCH_PARAMETERS.required.includes("operation"), true);
  assert.deepEqual(MANUAL_RESEARCH_PARAMETERS.properties.operation.enum, [
    "start",
    "capture_list",
    "capture_detail",
    "finalize",
    "apply_reviews",
    "create_submission",
  ]);
  for (const legacyProperty of [
    "selection_id",
    "page_url",
    "original_brief",
    "resume_from_branch",
  ]) {
    assert.equal(MANUAL_RESEARCH_PARAMETERS.properties[legacyProperty], undefined);
  }
  const params = validateManualResearchParams(baseParams());
  assert.equal(params.platform, "xingtu");
  assert.equal(params.operation, "legacy_collect");
  assert.equal(params.selector_args.keywords, undefined);
  assert.equal(params.selector_args.facts.length, baseParams().facts.length);
  const selection = validateManualFilterSelectionParams(baseParams({ fresh_run: true }));
  assert.equal(selection.platform, "xingtu");
  assert.equal(selection.fresh_run, true);
  const compactSelection = validateManualFilterSelectionParams({
    requirement_id: "compact-selection",
    platform: "douyin",
    facts: [
      { kind: "creator_price", operator: "lte", value: 20_000 },
      { kind: "creator_count", value: 10 },
      { kind: "follower_count", operator: "gte", value: 100_000 },
    ],
  });
  assert.deepEqual(
    compactSelection.facts.map((item) => item.normalized_value),
    [20_000, 10, 100_000],
  );
  const compactPlan = compileManualResearchPlan(compactSelection);
  assert.equal(compactPlan.target_count, 10);
  assert.deepEqual(
    compactPlan.filters.find((item) => item.control === "creator_price"),
    {
      fact_id: null,
      fact_kind: "creator_price",
      control: "creator_price",
      mode: "range",
      source: null,
      min: 10_000,
      max: 24_000,
      unit: "yuan",
      range_policy: "customer_value_50_to_120_percent",
      input_anchor: {
        operator: "lte",
        normalized_value: 20_000,
        minimum: null,
        maximum: null,
        qualifier: "generic",
      },
    },
  );
  assert.throws(
    () => validateManualFilterSelectionParams(baseParams({ keywords: ["1", "2", "3", "4", "5"] })),
    /1–4/u,
  );
  assert.throws(
    () => validateManualFilterSelectionParams(baseParams({ fresh_run: "yes" })),
    /布尔值/u,
  );
  assert.throws(
    () =>
      validateManualFilterSelectionParams(
        baseParams({
          facts: [{ kind: "creator_price", operator: "lte", value: [10_000, 24_000] }],
        }),
      ),
    /客户原始价格事实/u,
  );
  assert.throws(
    () =>
      validateManualFilterSelectionParams(
        baseParams({
          facts: [fact("price", "creator_price", null, { operator: "lte" })],
        }),
      ),
    /缺少有限数值/u,
  );
  const reviews = validateManualResearchParams({
    operation: "apply_reviews",
    requirement_id: "requirement-1",
    platform: "douyin",
    run_id: "run-1",
    reviews: [
      {
        candidate_ref: "creator-1",
        decision: "include",
        reasons: ["内容相关"],
        evidence: ["近期作品：办公效率"],
      },
    ],
  });
  assert.equal(reviews.operation, "apply_reviews");
  assert.equal(reviews.facts, undefined);
  const listCapture = validateManualResearchParams({
    operation: "capture_list",
    requirement_id: "requirement-1",
    platform: "douyin",
    run_id: "run-1",
    keyword: "办公软件",
    list_snapshot: {
      source_url: "https://www.xingtu.cn/ad/creator/market",
      rows: [{ platform_id: "creator-1" }],
    },
  });
  assert.equal(listCapture.list_snapshot.rows[0].platform_id, "creator-1");
  const detailCapture = validateManualResearchParams({
    operation: "capture_detail",
    requirement_id: "requirement-1",
    platform: "douyin",
    run_id: "run-1",
    candidate_ref: "creator-1",
    detail_snapshot: {
      url: "https://www.xingtu.cn/ad/creator/detail",
      fields: { cpm_raw: "80" },
    },
  });
  assert.equal(detailCapture.detail_snapshot.fields.cpm_raw, "80");
  assert.throws(
    () =>
      validateManualResearchParams({
        operation: "capture_list",
        requirement_id: "requirement-1",
        platform: "douyin",
        run_id: "run-1",
        keyword: "办公软件",
      }),
    /list_snapshot/u,
  );
  assert.throws(
    () =>
      validateManualResearchParams({
        operation: "apply_reviews",
        requirement_id: "requirement-1",
        platform: "xingtu",
        run_id: "run-1",
        reviews: Array.from({ length: 21 }, (_, index) => ({
          candidate_ref: `creator-${index}`,
          decision: "include",
          reasons: [],
          evidence: [],
        })),
      }),
    /1–20/u,
  );
  assert.throws(
    () =>
      validateManualResearchParams({
        operation: "apply_reviews",
        requirement_id: "requirement-1",
        platform: "xingtu",
        run_id: "run-1",
        reviews: [{ candidate_ref: "creator-1", decision: "include", reasons: [], evidence: [] }],
      }),
    /不能为空/u,
  );
});

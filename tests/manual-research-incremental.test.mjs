import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManualFilterSelection } from "../src/tools/manual-filter-selection.js";
import {
  createManualResearchStore,
  loadManualResearchRun,
} from "../src/tools/manual-research-artifact.js";
import { createManualResearch, latestOpenCandidate } from "../src/tools/manual-research.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function params() {
  return {
    requirement_id: "incremental-list",
    platform: "xingtu",
    facts: [
      { kind: "creator_count", normalized_value: 1 },
      { kind: "creator_price", normalized_value: 20_000, operator: "lte" },
      { kind: "video_duration", normalized_value: "duration_l3" },
      { kind: "follower_count", normalized_value: 100_000, operator: "gte" },
      { id: "creator-type", kind: "creator_type", normalized_value: ["美妆教程", "护肤保养"] },
    ],
    keywords: ["办公软件"],
  };
}

function resultState() {
  return {
    observation_id: "results-observation",
    page_context_id: "results-context",
    state_id: "results-state",
    page_state: "RESULTS_READY",
    page_kind: "creator_market",
    url: "https://www.xingtu.cn/ad/creator/market",
    modal: { present: false },
    challenge: { present: false },
    market: {
      keyword: "办公软件",
      filters: ["达人报价"],
      result_row_count: 1,
      page_number: 1,
      can_next_page: false,
    },
    detail: null,
    elements: [],
    regions: [],
    selected_filters: [{ label: "硬筛", value: "已选择" }],
    selected_filter_fingerprint: "filters-a",
    tabs: [],
  };
}

test("Playwright CLI run starts and captures the current list without a selection credential", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-native-browser-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  let browserConnections = 0;
  const research = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => {
      browserConnections += 1;
      return { contexts: () => [] };
    },
  });

  const started = payload(await research({ operation: "start", ...params() }));
  assert.equal(started.status, "ready_for_playwright");
  assert.equal(started.target_url, "https://www.xingtu.cn/ad/creator/market");
  assert.equal(started.price_view, "植入视频");
  assert.equal(started.browser_policy.playwright_session, "ypscan");
  assert.equal(started.browser_policy.target_url, started.target_url);
  assert.equal(started.browser_policy.selection_id_required, false);
  assert.deepEqual(
    started.range_execution_plan.find((item) => item.control === "creator_price").preset_rounds,
    ["1w-5w"],
  );
  assert.deepEqual(
    started.range_execution_plan.find((item) => item.control === "follower_count").preset_rounds,
    ["10w-100w", "100w-300w", "300w-500w", "500w-1000w", "1000w以上"],
  );
  assert.equal(started.selection_plan.schema_version, 1);
  assert.equal(started.selection_plan.batches.length, 1);
  assert.deepEqual(
    started.selection_plan.batches[0].items.map((item) => item.path),
    [
      ["美妆", "美妆教程"],
      ["美妆", "护肤保养"],
    ],
  );
  assert.equal(browserConnections, 0);

  const captured = payload(
    await research({
      operation: "capture_list",
      requirement_id: started.requirement_id,
      platform: started.platform,
      run_id: started.run_id,
      keyword: "办公软件",
      keyword_complete: false,
      list_snapshot: {
        source_url: "https://www.xingtu.cn/ad/creator/market",
        page_number: 1,
        price_tier: "植入视频",
        rows: [
          {
            platform_id: "native-creator-1",
            nickname: "原生达人",
            followers_raw: "20万",
            price_raw: "1.8万",
          },
        ],
      },
      filter_evidence: [
        {
          fact: "植入视频报价 2 万以内",
          page_control: "达人报价",
          selected_path: ["植入视频"],
          verified: true,
          evidence: "筛选栏显示植入视频",
        },
        {
          control: "creator_price",
          page_control: "达人报价",
          selected_path: ["1w-5w"],
          verified: true,
          evidence: "报价区间显示 1w-5w",
        },
        {
          control: "follower_count",
          page_control: "粉丝数",
          selected_path: ["10w-100w"],
          verified: true,
          evidence: "粉丝数本轮为 10w-100w",
        },
      ],
    }),
  );
  assert.equal(captured.status, "list_captured");
  assert.equal(captured.candidate_count, 1);
  assert.equal(captured.candidates[0].platform_id, "native-creator-1");
  assert.equal(browserConnections, 0);

  const skipped = payload(
    await research({
      operation: "capture_detail",
      requirement_id: started.requirement_id,
      platform: started.platform,
      run_id: started.run_id,
      candidate_ref: "native-creator-1",
      detail_snapshot: {
        url: "https://www.xingtu.cn/ad/creator/detail",
        fields: {},
        challenge: true,
      },
    }),
  );
  assert.equal(skipped.success, true);
  assert.equal(skipped.status, "detail_skipped");
  assert.equal(skipped.user_action_required, undefined);
});

test("ordinary Playwright page drift is recoverable instead of stopping the run", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-native-recovery-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const research = createManualResearch({
    workspaceDir,
  });
  const started = payload(await research({ operation: "start", ...params() }));
  const result = payload(
    await research({
      operation: "capture_list",
      requirement_id: started.requirement_id,
      platform: started.platform,
      run_id: started.run_id,
      keyword: "办公软件",
      list_snapshot: {
        source_url: "https://www.xingtu.cn/ad/creator/index",
        rows: [],
      },
    }),
  );
  assert.equal(result.success, true);
  assert.equal(result.status, "recoverable");
  assert.match(result.recovery_hint, /Playwright CLI/u);
});

test("capture_list blocks a wrong quote tier, rejects visible hard failures, and completes without an empty page", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-native-hard-guard-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const research = createManualResearch({ workspaceDir });
  const started = payload(await research({ operation: "start", ...params() }));
  const priceRangeEvidence = {
    control: "creator_price",
    page_control: "达人报价",
    selected_path: ["1w-5w"],
    verified: true,
  };
  const followerPresets = ["10w-100w", "100w-300w", "300w-500w", "500w-1000w", "1000w以上"];
  const rangeEvidenceFor = (preset) => [
    priceRangeEvidence,
    {
      control: "follower_count",
      page_control: "粉丝数",
      selected_path: [preset],
      verified: true,
    },
  ];
  const capture = (list_snapshot, keyword_complete = false, filter_evidence = []) =>
    research({
      operation: "capture_list",
      requirement_id: started.requirement_id,
      platform: started.platform,
      run_id: started.run_id,
      keyword: "办公软件",
      keyword_complete,
      filter_evidence,
      list_snapshot,
    });

  const wrongTier = payload(
    await capture({
      source_url: "https://www.xingtu.cn/ad/creator/market",
      price_tier: "定制视频",
      rows: [{ platform_id: "wrong-tier", price_raw: "18000", followers_raw: "20万" }],
    }),
  );
  assert.equal(wrongTier.status, "recoverable");
  assert.equal(wrongTier.page_state, "QUOTE_TIER_MISMATCH");
  assert.equal(wrongTier.required_price_tier, "植入视频");

  const captured = payload(
    await capture(
      {
        source_url: "https://www.xingtu.cn/ad/creator/market",
        price_tier: "植入视频",
        rows: [
          { platform_id: "eligible", price_raw: "18000", followers_raw: "20万" },
          { platform_id: "over-price", price_raw: "45000", followers_raw: "20万" },
          { platform_id: "under-followers", price_raw: "18000", followers_raw: "8万" },
        ],
      },
      false,
      rangeEvidenceFor(followerPresets[0]),
    ),
  );
  assert.equal(captured.page_row_count, 3);
  assert.equal(captured.page_candidate_count, 1);
  assert.equal(captured.page_rejected_candidate_count, 2);
  assert.deepEqual(
    captured.candidates.map((item) => item.platform_id),
    ["eligible"],
  );

  const incompleteCoverage = payload(
    await capture(
      { source_url: "https://www.xingtu.cn/ad/creator/market", rows: [] },
      true,
      followerPresets.flatMap(rangeEvidenceFor),
    ),
  );
  assert.equal(incompleteCoverage.keyword_complete, false);
  assert.deepEqual(incompleteCoverage.remaining_preset_rounds, [
    { control: "follower_count", preset: "100w-300w" },
    { control: "follower_count", preset: "300w-500w" },
    { control: "follower_count", preset: "500w-1000w" },
    { control: "follower_count", preset: "1000w以上" },
  ]);

  for (const preset of followerPresets.slice(1)) {
    const round = payload(
      await capture(
        {
          source_url: "https://www.xingtu.cn/ad/creator/market",
          page_number: 1,
          price_tier: "植入视频",
          rows: [],
        },
        false,
        rangeEvidenceFor(preset),
      ),
    );
    assert.equal(round.keyword_complete, false);
  }

  const completed = payload(
    await capture({ source_url: "https://www.xingtu.cn/ad/creator/market", rows: [] }, true),
  );
  assert.equal(completed.completion_only, true);
  assert.equal(completed.candidate_count, 1);

  const restored = await loadManualResearchRun({
    workspaceDir,
    runId: started.run_id,
    requirementId: started.requirement_id,
    platform: started.platform,
  });
  assert.equal(restored.events.filter((event) => event.type === "page").length, 5);
  assert.deepEqual(
    restored.candidates.map((item) => item.platform_id),
    ["eligible"],
  );
  const pageEvent = restored.events.find((event) => event.type === "page");
  assert.deepEqual(
    pageEvent.rejected_candidates.map((item) => item.platform_id),
    ["over-price", "under-followers"],
  );
});

async function committedRun(workspaceDir, page) {
  const inspector = async () => ({ page, state: resultState() });
  const select = createManualFilterSelection({
    workspaceDir,
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: inspector,
    createAdapter: () => ({
      async verifySelection() {
        return { valid: true };
      },
      async dispose() {},
    }),
  });
  const planned = payload(await select(params()));
  const loaded = await loadManualResearchRun({
    workspaceDir,
    runId: planned.run_id,
    requirementId: planned.requirement_id,
    platform: planned.platform,
  });
  const store = await createManualResearchStore({
    workspaceDir,
    params: { ...loaded.params, run_id: planned.run_id },
    plan: loaded.plan,
  });
  await store.saveBrowserState({
    source: "observer",
    observation_id: "clean-baseline",
    page_kind: "creator_market",
    market: { keyword: "" },
    selected_filters: [],
  });
  for (const requirement of planned.interaction_plan.hard_requirements) {
    await store.saveBrowserAction({
      action_id: requirement.requirement_ref,
      protocol_version: 3,
      action: "element:select",
      operation: "select",
      purpose: "filter_requirement",
      requirement_ref: requirement.requirement_ref,
      branch_index: 0,
      candidate_ref: null,
      ok: true,
      verified: true,
      changed: true,
      receipt: { applied: true, after_selected_filters: [{ label: requirement.kind }] },
    });
  }
  await store.saveBrowserAction({
    action_id: "keyword-action",
    protocol_version: 3,
    action: "element:fill_submit",
    operation: "fill_submit",
    purpose: "keyword_search",
    branch_index: 0,
    ok: true,
    verified: true,
    changed: true,
    receipt: { applied: true, readback: planned.branch.keyword },
  });
  return payload(
    await select({
      operation: "commit",
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
    }),
  );
}

test("v3 collect captures one current page and asks Agent to inspect before opening detail", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-incremental-list-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const page = { url: () => "https://www.xingtu.cn/ad/creator/market" };
  const committed = await committedRun(workspaceDir, page);
  let reads = 0;
  let nextCalls = 0;
  const collect = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({ page, state: resultState() }),
    createAdapter: () => ({
      async readPage() {
        reads += 1;
        return {
          rows: [
            {
              platform_id: "creator-1",
              nickname: "效率达人",
              detail_url: "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/creator-1",
              price_raw: "18000",
              format: "植入视频",
            },
          ],
          source_url: page.url(),
          price_tier: "植入视频",
          collection_source: "browser_response+dom",
        };
      },
      async nextPage() {
        nextCalls += 1;
        return { advanced: true };
      },
      async dispose() {},
    }),
  });
  const result = payload(await collect(committed.collection_args));
  assert.equal(result.status, "awaiting_browser_action");
  assert.equal(result.candidate_count, 1);
  assert.equal(result.next_call.tool, "ypscan_manual_browser_inspect");
  assert.equal(result.next_call.intent.action, "open_creator_detail");
  assert.equal(result.next_call.intent.candidate_ref, "creator-1");
  assert.equal(reads, 1);
  assert.equal(nextCalls, 0, "read-only collect must never advance pagination itself");
  const checkpoint = await readFile(
    join(workspaceDir, "ypscan-manual-research", committed.run_id, "checkpoint.jsonl"),
    "utf8",
  );
  assert.match(checkpoint, /"type":"page"/u);
  assert.match(checkpoint, /"phase":"LIST_COMPLETE"/u);
});

test("a detail navigation blocked by CAPTCHA keeps its candidate context after human recovery", () => {
  assert.equal(
    latestOpenCandidate([
      {
        action: "open_creator_detail",
        candidate_ref: "creator-1",
        ok: false,
        after_state_id: "captcha-detail-state",
        error: { code: "CAPTCHA_BLOCKED" },
      },
    ]),
    "creator-1",
  );
  assert.equal(
    latestOpenCandidate([
      {
        action: "open_creator_detail",
        candidate_ref: "creator-1",
        ok: false,
        after_state_id: null,
        error: { code: "CAPTCHA_BLOCKED" },
      },
    ]),
    null,
    "a CAPTCHA seen before navigation must not invent an active detail candidate",
  );
});

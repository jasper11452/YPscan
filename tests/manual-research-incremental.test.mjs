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
              format: "60s以上视频",
            },
          ],
          source_url: page.url(),
          price_tier: "60s以上视频",
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

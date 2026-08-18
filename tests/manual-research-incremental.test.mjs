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
    state_id: "results-state",
    page_state: "RESULTS_READY",
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
  for (const action of planned.planned_actions) {
    await store.saveBrowserAction({
      action_id: action.plan_action_id,
      action: action.action,
      plan_action_id: action.plan_action_id,
      branch_index: 0,
      candidate_ref: null,
      ok: true,
      verified: true,
      changed: true,
      receipt:
        action.action === "search_keyword"
          ? { applied: true, result_count: 1 }
          : action.action === "reset_filters"
            ? { applied: true, valid: true }
            : action.action === "set_price_view"
              ? { applied: true, readback: action.price_view }
              : action.action === "apply_filter"
                ? { applied: true, readback: action.filter.control }
                : { applied: true },
    });
  }
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

test("v2 collect captures one current page and returns an exact open-detail action", async (t) => {
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
  assert.equal(result.next_call.tool, "ypscan_manual_browser_action");
  assert.equal(result.next_call.args.action, "open_creator_detail");
  assert.equal(result.next_call.args.candidate_ref, "creator-1");
  assert.equal(result.next_call.args.expected_state_id, "results-state");
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

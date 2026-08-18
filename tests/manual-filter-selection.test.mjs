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
import { createManualResearch } from "../src/tools/manual-research.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function browser() {
  const page = { url: () => "https://www.xingtu.cn/ad/creator/market" };
  return { page, contexts: () => [{ pages: () => [page] }] };
}

function params() {
  return {
    requirement_id: "selection-contract",
    platform: "xingtu",
    facts: [
      { kind: "creator_count", normalized_value: 3 },
      { kind: "creator_price", normalized_value: 100_000, operator: "lte" },
      { kind: "video_duration", normalized_value: "duration_l3" },
      { kind: "creator_gender", normalized_value: "女" },
    ],
    keywords: ["AI工具", "办公效率"],
  };
}

function readyInspection(
  fakeBrowser = browser(),
  { keyword = "AI工具", fingerprint = "filters-a" } = {},
) {
  return {
    page: fakeBrowser.page,
    state: {
      observation_id: "observation-ready",
      page_context_id: "market-context",
      state_id: "ready-state",
      page_state: "RESULTS_READY",
      page_kind: "creator_market",
      url: "https://www.xingtu.cn/ad/creator/market",
      market: { keyword, result_row_count: 3 },
      selected_filters: [{ label: "硬筛", value: "已选择" }],
      selected_filter_fingerprint: fingerprint,
      elements: [],
      regions: [],
      modal: { present: false },
      challenge: { present: false },
      tabs: [],
    },
  };
}

async function seedVerifiedActions(workspaceDir, planned) {
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
      action_id: `test-${requirement.requirement_ref}`,
      protocol_version: 3,
      action: "element:select",
      operation: "select",
      purpose: "filter_requirement",
      requirement_ref: requirement.requirement_ref,
      branch_index: planned.branch.branch_index,
      candidate_ref: null,
      ok: true,
      verified: true,
      changed: true,
      receipt: { applied: true, after_selected_filters: [{ label: requirement.kind }] },
    });
  }
  await store.saveBrowserAction({
    action_id: "test-keyword",
    protocol_version: 3,
    action: "element:fill_submit",
    operation: "fill_submit",
    purpose: "keyword_search",
    branch_index: planned.branch.branch_index,
    ok: true,
    verified: true,
    changed: true,
    receipt: { applied: true, readback: planned.branch.keyword },
  });
}

async function planSelection(workspaceDir, extra = {}) {
  const select = createManualFilterSelection({ workspaceDir, ...extra });
  return { select, planned: payload(await select(params())) };
}

test("legacy collect returns migration args without connecting Browser", async () => {
  let connections = 0;
  const collect = createManualResearch({
    connectOverCDP: async () => {
      connections += 1;
      return browser();
    },
  });
  const result = payload(await collect(params()));
  assert.equal(result.error.code, "YPSCAN_MANUAL_SELECTION_REQUIRED");
  assert.deepEqual(result.selector_args, params());
  assert.equal(connections, 0);
});

test("selection planning requires a checkpoint workspace and never connects Browser", async () => {
  let connections = 0;
  const select = createManualFilterSelection({
    connectOverCDP: async () => {
      connections += 1;
      return browser();
    },
  });
  const selected = payload(await select(params()));
  assert.equal(selected.status, "failed");
  assert.equal(selected.error.code, "YPSCAN_MANUAL_WORKSPACE_UNAVAILABLE");
  assert.equal(connections, 0);
});

test("v3 plan returns requirements without deciding page elements", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-plan-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  let connections = 0;
  const { planned } = await planSelection(workspaceDir, {
    connectOverCDP: async () => {
      connections += 1;
      return browser();
    },
  });
  assert.equal(planned.status, "awaiting_browser_actions");
  assert.equal(planned.ready_for_collection, false);
  assert.equal(planned.protocol_version, 3);
  assert.equal(planned.planned_actions, undefined);
  assert.equal(planned.interaction_plan.mode, "establish_filter_set");
  assert.equal(planned.interaction_plan.keyword_must_be_last, true);
  assert.equal(planned.interaction_plan.hard_requirements.length, 3);
  assert.equal(planned.next_call.tool, "ypscan_manual_browser_inspect");
  assert.equal(connections, 0);
});

test("commit refuses incomplete action receipts before Browser access", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-incomplete-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  let connections = 0;
  const { select, planned } = await planSelection(workspaceDir, {
    connectOverCDP: async () => {
      connections += 1;
      return browser();
    },
  });
  const committed = payload(
    await select({
      operation: "commit",
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
    }),
  );
  assert.equal(committed.ready_for_collection, false);
  assert.equal(committed.error.code, "YPSCAN_MANUAL_ACTIONS_INCOMPLETE");
  assert.equal(committed.selection_id, undefined);
  assert.equal(connections, 0);
});

test("commit signs a credential only after action receipts and final readback agree", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-commit-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const fakeBrowser = browser();
  const { select, planned } = await planSelection(workspaceDir, {
    connectOverCDP: async () => fakeBrowser,
    inspectBrowser: async () => readyInspection(fakeBrowser),
    createAdapter: () => ({
      async verifySelection() {
        return { valid: true };
      },
      async dispose() {},
    }),
  });
  await seedVerifiedActions(workspaceDir, planned);
  const committed = payload(
    await select({
      operation: "commit",
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
    }),
  );
  assert.equal(committed.status, "ready");
  assert.equal(committed.ready_for_collection, true);
  assert.ok(committed.selection_id);
  assert.equal(committed.protocol_version, 3);
  assert.equal(committed.verification.requirements.length, 3);
  assert.ok(committed.filter_set_id);
  const checkpoint = await readFile(
    join(workspaceDir, "ypscan-manual-research", committed.run_id, "checkpoint.jsonl"),
    "utf8",
  );
  const selection = checkpoint
    .trim()
    .split("\n")
    .map(JSON.parse)
    .find((event) => event.type === "selection").selection;
  assert.equal(selection.protocol_version, 3);
  assert.equal(selection.filter_fingerprint, "filters-a");
  assert.doesNotMatch(checkpoint, /cookie|token|authorization|request_headers/iu);

  const nextBranch = payload(
    await select({
      operation: "plan",
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 1,
    }),
  );
  assert.equal(nextBranch.interaction_plan.mode, "keyword_only");
  assert.equal(nextBranch.interaction_plan.preserve_filters, true);
  assert.equal(nextBranch.interaction_plan.filter_set_id, committed.filter_set_id);
  assert.equal(nextBranch.planned_actions, undefined);
});

test("a final keyword mismatch cannot issue a selection credential", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-mismatch-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const fakeBrowser = browser();
  const { select, planned } = await planSelection(workspaceDir, {
    connectOverCDP: async () => fakeBrowser,
    inspectBrowser: async () => readyInspection(fakeBrowser, { keyword: "错误关键词" }),
  });
  await seedVerifiedActions(workspaceDir, planned);
  const committed = payload(
    await select({
      operation: "commit",
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
    }),
  );
  assert.equal(committed.status, "failed");
  assert.equal(committed.error.code, "YPSCAN_MANUAL_SELECTION_READBACK_MISMATCH");
  assert.equal(committed.selection_id, undefined);
});

test("a later keyword branch rejects filter drift instead of rebuilding all filters", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-drift-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const fakeBrowser = browser();
  let current = { keyword: "AI工具", fingerprint: "filters-a" };
  const { select, planned } = await planSelection(workspaceDir, {
    connectOverCDP: async () => fakeBrowser,
    inspectBrowser: async () => readyInspection(fakeBrowser, current),
  });
  await seedVerifiedActions(workspaceDir, planned);
  const base = payload(
    await select({
      operation: "commit",
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
    }),
  );
  assert.equal(base.status, "ready");

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
  await store.saveBrowserAction({
    action_id: "test-keyword-branch-1",
    protocol_version: 3,
    action: "element:fill_submit",
    operation: "fill_submit",
    purpose: "keyword_search",
    branch_index: 1,
    ok: true,
    verified: true,
    changed: true,
    receipt: { applied: true, readback: "办公效率" },
  });
  current = { keyword: "办公效率", fingerprint: "filters-drifted" };
  const drifted = payload(
    await select({
      operation: "commit",
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 1,
    }),
  );
  assert.equal(drifted.status, "failed");
  assert.equal(drifted.error.code, "YPSCAN_MANUAL_FILTER_SET_DRIFT");
  assert.match(drifted.next_call.reason, /仅修复/);
  assert.equal(drifted.selection_id, undefined);
});

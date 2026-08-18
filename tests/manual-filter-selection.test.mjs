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

function readyInspection(fakeBrowser = browser()) {
  return {
    page: fakeBrowser.page,
    state: {
      state_id: "ready-state",
      page_state: "RESULTS_READY",
      url: "https://www.xingtu.cn/ad/creator/market",
      market: { keyword: "AI工具" },
      modal: { present: false },
      challenge: { present: false },
      tabs: [],
    },
  };
}

async function seedVerifiedActions(workspaceDir, planned, { searchSnapshot = null } = {}) {
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
    const receipt =
      action.action === "search_keyword"
        ? {
            applied: true,
            result_count: 3,
            ...(searchSnapshot ? { list_snapshot: searchSnapshot } : {}),
          }
        : action.action === "reset_filters"
          ? { applied: true, valid: true }
          : action.action === "set_price_view"
            ? { applied: true, readback: action.price_view }
            : action.action === "apply_filter"
              ? { applied: true, readback: action.filter.control }
              : { applied: true };
    await store.saveBrowserAction({
      action_id: `test-${action.plan_action_id}`,
      action: action.action,
      plan_action_id: action.plan_action_id,
      branch_index: planned.branch.branch_index,
      candidate_ref: null,
      ok: true,
      verified: true,
      changed: true,
      receipt,
    });
  }
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

test("plan returns ordered semantic actions without touching Browser", async (t) => {
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
  assert.equal(planned.protocol_version, 2);
  assert.deepEqual(
    planned.planned_actions.map((action) => action.action),
    [
      "ensure_market_ready",
      "reset_filters",
      "set_price_view",
      "apply_filter",
      "apply_filter",
      "search_keyword",
    ],
  );
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
  const snapshot = {
    page_number: 1,
    rows: [{ platform_id: "snapshot-1", nickname: "快照达人" }],
  };
  await seedVerifiedActions(workspaceDir, planned, { searchSnapshot: snapshot });
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
  assert.equal(committed.verification.actual_filters.length, 2);
  assert.equal(committed.list_snapshot, undefined);
  const checkpoint = await readFile(
    join(workspaceDir, "ypscan-manual-research", committed.run_id, "checkpoint.jsonl"),
    "utf8",
  );
  const selection = checkpoint
    .trim()
    .split("\n")
    .map(JSON.parse)
    .find((event) => event.type === "selection").selection;
  assert.equal(selection.protocol_version, 2);
  assert.equal(selection.list_snapshot.rows[0].platform_id, "snapshot-1");
  assert.doesNotMatch(checkpoint, /cookie|token|authorization|request_headers/iu);
});

test("a final-state mismatch cannot issue a selection credential", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-mismatch-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const fakeBrowser = browser();
  const { select, planned } = await planSelection(workspaceDir, {
    connectOverCDP: async () => fakeBrowser,
    inspectBrowser: async () => readyInspection(fakeBrowser),
    createAdapter: () => ({
      async verifySelection() {
        return { valid: false, reason: "keyword_mismatch" };
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
  assert.equal(committed.status, "failed");
  assert.equal(committed.error.code, "YPSCAN_MANUAL_SELECTION_READBACK_MISMATCH");
  assert.equal(committed.selection_id, undefined);
});

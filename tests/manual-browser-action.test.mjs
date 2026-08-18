import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManualBrowserAction } from "../src/tools/manual-browser-action.js";
import { createManualFilterSelection } from "../src/tools/manual-filter-selection.js";
import { browserActionsForBranch } from "../src/tools/manual-browser-plan.js";
import {
  createManualResearchStore,
  loadManualResearchRun,
} from "../src/tools/manual-research-artifact.js";
import { compileManualResearchPlan } from "../src/tools/manual-research-plan.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function selectionParams() {
  return {
    requirement_id: "browser-action-contract",
    platform: "xingtu",
    facts: [
      { kind: "creator_price", normalized_value: 20_000, operator: "lte" },
      { kind: "video_duration", normalized_value: "duration_l3" },
    ],
    keywords: ["办公软件"],
  };
}

function pageState(pageState, id) {
  return {
    state_id: id,
    page_state: pageState,
    platform: "xingtu",
    url:
      pageState === "WRONG_PAGE"
        ? "https://example.com/"
        : "https://www.xingtu.cn/ad/creator/market",
    title: "",
    modal: { present: false, dismissible: false },
    challenge: { present: pageState === "CAPTCHA_BLOCKED" },
    market: ["MARKET_READY", "RESULTS_READY"].includes(pageState)
      ? { keyword: "", filters: [], result_row_count: 0, page_number: 1 }
      : null,
    detail: null,
    visible_controls: [],
    tabs: [],
  };
}

async function plannedRun(workspaceDir) {
  const input = selectionParams();
  const plan = { ...compileManualResearchPlan(input), protocol_version: 2 };
  const store = await createManualResearchStore({ workspaceDir, params: input, plan });
  const branch = plan.branches[0];
  return {
    ...input,
    run_id: store.run_id,
    branch,
    planned_actions: browserActionsForBranch(plan, branch),
  };
}

test("semantic action rejects stale expected_state_id without touching the page", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-browser-stale-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const planned = await plannedRun(workspaceDir);
  let adapterCalls = 0;
  const act = createManualBrowserAction({
    workspaceDir,
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({ page: null, state: pageState("UNKNOWN", "current") }),
    createAdapter: () => {
      adapterCalls += 1;
      return {};
    },
  });
  const first = planned.planned_actions[0];
  const result = payload(
    await act({
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
      action: first.action,
      plan_action_id: first.plan_action_id,
      expected_state_id: "stale",
    }),
  );
  assert.equal(result.error.code, "PAGE_CHANGED");
  assert.equal(result.changed, false);
  assert.equal(adapterCalls, 0);
});

test("ensure action records before/after state and advances to the next planned action", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-browser-action-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const planned = await plannedRun(workspaceDir);
  const page = {};
  let current = pageState("WRONG_PAGE", "wrong-state");
  const act = createManualBrowserAction({
    workspaceDir,
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({ page, state: current }),
    inspectPage: async () => current,
    resolvePage: async () => page,
    createAdapter: () => ({
      async prepare() {
        current = pageState("MARKET_READY", "market-state");
      },
      async dispose() {},
    }),
  });
  const first = planned.planned_actions[0];
  const result = payload(
    await act({
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
      action: first.action,
      plan_action_id: first.plan_action_id,
      expected_state_id: "wrong-state",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.verified, true);
  assert.equal(result.before_state.page_state, "WRONG_PAGE");
  assert.equal(result.after_state.page_state, "MARKET_READY");
  assert.equal(result.next_call.args.action, "reset_filters");
  assert.equal(result.next_call.args.expected_state_id, "market-state");
  const checkpoint = await readFile(
    join(workspaceDir, "ypscan-manual-research", planned.run_id, "checkpoint.jsonl"),
    "utf8",
  );
  assert.match(checkpoint, /"type":"browser_action"/u);
  assert.match(checkpoint, /"phase":"MARKET_READY"/u);
});

test("login and CAPTCHA are blocking states, not retryable action errors", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-browser-login-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const planned = await plannedRun(workspaceDir);
  const page = {};
  let adapterCalls = 0;
  const act = createManualBrowserAction({
    workspaceDir,
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({ page, state: pageState("LOGIN_REQUIRED", "login-state") }),
    createAdapter: () => {
      adapterCalls += 1;
      return {};
    },
  });
  const first = planned.planned_actions[0];
  const result = payload(
    await act({
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
      action: first.action,
      plan_action_id: first.plan_action_id,
      expected_state_id: "login-state",
    }),
  );
  assert.equal(result.status, "needs_user_action");
  assert.equal(result.error.code, "LOGIN_REQUIRED");
  assert.equal(result.retryable, false);
  assert.equal(result.next_call.tool, "ypscan_manual_browser_inspect");
  assert.equal(adapterCalls, 0);
});

test("the action ledger stops an unchanged action after two failed attempts", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-browser-progress-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const planned = await plannedRun(workspaceDir);
  const page = {};
  const state = pageState("WRONG_PAGE", "unchanged");
  let attempts = 0;
  const act = createManualBrowserAction({
    workspaceDir,
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({ page, state }),
    inspectPage: async () => state,
    resolvePage: async () => page,
    createAdapter: () => ({
      async prepare() {
        attempts += 1;
      },
      async dispose() {},
    }),
  });
  const first = planned.planned_actions[0];
  const args = {
    requirement_id: planned.requirement_id,
    platform: planned.platform,
    run_id: planned.run_id,
    branch_index: 0,
    action: first.action,
    plan_action_id: first.plan_action_id,
    expected_state_id: "unchanged",
  };
  assert.equal(payload(await act(args)).error.code, "POSTCONDITION_FAILED");
  assert.equal(payload(await act(args)).error.code, "POSTCONDITION_FAILED");
  const stopped = payload(await act(args));
  assert.equal(stopped.error.code, "NO_PROGRESS");
  assert.equal(stopped.retryable, false);
  assert.equal(attempts, 2);
});

test("v3 resolves an observed element even when unrelated page elements changed", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-browser-v3-element-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const planned = payload(await createManualFilterSelection({ workspaceDir })(selectionParams()));
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
  const target = {
    element_id: "el-filter-menu",
    region_id: "filters",
    role: "button",
    tag: "button",
    name: "任意新版筛选菜单",
    enabled: true,
    actions: ["click", "hover"],
  };
  const observation = {
    source: "observer",
    observation_id: "observation-v3",
    tab_id: "tab:0:0",
    page_context_id: "market-context",
    state_id: "observed-state",
    page_state: "MARKET_READY",
    page_kind: "creator_market",
    url: "https://www.xingtu.cn/ad/creator/market",
    market: { keyword: "" },
    modal: { present: false },
    challenge: { present: false },
    elements: [target],
    selected_filters: [],
    selected_filter_fingerprint: "filters-empty",
  };
  await store.saveBrowserState(observation);
  const page = { waitForTimeout: async () => {} };
  const before = {
    ...observation,
    observation_id: "current-observation",
    state_id: "current-with-unrelated-elements",
    elements: [target, { element_id: "unrelated" }],
  };
  const after = {
    ...before,
    state_id: "menu-open",
    elements: [target, { element_id: "menu-option" }, { element_id: "unrelated" }],
  };
  let clicks = 0;
  const act = createManualBrowserAction({
    workspaceDir,
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({ page, state: before }),
    inspectPage: async () => after,
    resolveElement: async (_page, descriptor) => ({
      element: descriptor ? { ...target, expanded: clicks ? "true" : null } : null,
      locator: descriptor
        ? {
            click: async () => {
              clicks += 1;
            },
          }
        : null,
      snapshot: { elements: [target] },
    }),
  });
  const result = payload(
    await act({
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
      operation: "click",
      observation_id: observation.observation_id,
      element_id: target.element_id,
      purpose: "inspection",
      expected_effect: "menu_opened",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.protocol_version, 3);
  assert.equal(clicks, 1);
  assert.equal(result.next_call.tool, "ypscan_manual_browser_inspect");
});

test("v3 enforces keyword-last and forbids reset after a filter set exists", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-browser-v3-order-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const planned = payload(await createManualFilterSelection({ workspaceDir })(selectionParams()));
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
  const search = { element_id: "el-search", tag: "input", enabled: true };
  await store.saveBrowserState({
    source: "observer",
    observation_id: "order-observation",
    tab_id: "tab:0:0",
    page_context_id: "market-context",
    page_kind: "creator_market",
    market: { keyword: "" },
    selected_filters: [],
    elements: [search],
  });
  let connections = 0;
  const act = createManualBrowserAction({
    workspaceDir,
    connectOverCDP: async () => {
      connections += 1;
      return { contexts: () => [] };
    },
  });
  const early = payload(
    await act({
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
      operation: "fill_submit",
      observation_id: "order-observation",
      element_id: search.element_id,
      value: "办公软件",
      purpose: "keyword_search",
      expected_effect: "results_refreshed",
    }),
  );
  assert.equal(early.error.code, "YPSCAN_MANUAL_KEYWORD_TOO_EARLY");
  assert.equal(connections, 0);

  await store.saveSelection({
    protocol_version: 3,
    selection_id: "base-selection",
    status: "ready",
    branch: loaded.plan.branches[0],
    filter_set_id: "filter-set",
    filter_fingerprint: "filters-a",
  });
  const reset = payload(
    await act({
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
      operation: "click",
      observation_id: "order-observation",
      element_id: search.element_id,
      purpose: "reset_filters",
      expected_effect: "page_changed",
    }),
  );
  assert.equal(reset.error.code, "YPSCAN_MANUAL_ACTION_NOT_ALLOWED");
  assert.equal(connections, 0);
});

test("v3 fills an Agent-chosen arbitrary range and verifies each input before confirming", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-browser-v3-range-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const planned = payload(await createManualFilterSelection({ workspaceDir })(selectionParams()));
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
  const elements = [
    { element_id: "el-min", tag: "input", enabled: true },
    { element_id: "el-max", tag: "input", enabled: true },
    { element_id: "el-confirm", tag: "button", enabled: true },
  ];
  const observation = {
    source: "observer",
    observation_id: "range-observation",
    tab_id: "tab:0:0",
    page_context_id: "market-context",
    state_id: "range-before",
    page_state: "MARKET_READY",
    page_kind: "creator_market",
    url: "https://www.xingtu.cn/ad/creator/market",
    market: { keyword: "" },
    modal: { present: false },
    challenge: { present: false },
    elements,
    selected_filters: [],
  };
  await store.saveBrowserState(observation);
  const values = new Map();
  let confirmed = 0;
  const page = { waitForTimeout: async () => {} };
  const resolveElement = async (_page, descriptor) => ({
    element: descriptor ?? null,
    locator: descriptor
      ? {
          fill: async (value) => values.set(descriptor.element_id, value),
          inputValue: async () => values.get(descriptor.element_id) ?? "",
          click: async () => {
            confirmed += 1;
          },
        }
      : null,
  });
  const act = createManualBrowserAction({
    workspaceDir,
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({ page, state: observation }),
    inspectPage: async () => ({ ...observation, state_id: "range-after" }),
    resolveElement,
  });
  const result = payload(
    await act({
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
      branch_index: 0,
      operation: "set_range",
      observation_id: observation.observation_id,
      element_ids: ["el-min", "el-max"],
      confirm_element_id: "el-confirm",
      range: { min: 10000, max: 24000 },
      purpose: "inspection",
      expected_effect: "value_filled",
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.receipt.readbacks, ["10000", "24000"]);
  assert.equal(confirmed, 1);
});

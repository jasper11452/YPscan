import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManualBrowserAction } from "../src/tools/manual-browser-action.js";
import { createManualFilterSelection } from "../src/tools/manual-filter-selection.js";

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
  const select = createManualFilterSelection({ workspaceDir });
  return payload(await select(selectionParams()));
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

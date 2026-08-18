import assert from "node:assert/strict";
import test from "node:test";

import { createFilterRangeSetter } from "../src/tools/set-filter-range.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test("range helper fills an Agent-chosen dynamic filter and verifies its commit", async () => {
  let readback = "粉丝数量";
  let openedArgs = null;
  let filledRange = null;
  let menuVisible = true;
  const setFilterRange = createFilterRangeSetter({
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({
      page: { waitForTimeout: async () => {} },
      state: { page_state: "MARKET_READY" },
    }),
    openMenu: async (_page, labels, options) => {
      openedArgs = { labels, options };
      return {
        row: { innerText: async () => readback },
        menu: { isVisible: async () => menuVisible },
      };
    },
    fillRange: async (_page, _opened, range, options) => {
      filledRange = { range, options };
      readback = "粉丝数量 10万以上";
      menuVisible = false;
      return true;
    },
  });

  const result = payload(
    await setFilterRange({
      platform: "douyin",
      field_label: "粉丝数量",
      trigger_label: "粉丝数量",
      min: 100_000,
      unit: "count",
    }),
  );

  assert.equal(result.success, true);
  assert.equal(result.status, "applied");
  assert.equal(result.verified, true);
  assert.deepEqual(openedArgs, {
    labels: "粉丝数量",
    options: { triggerLabel: "粉丝数量" },
  });
  assert.deepEqual(filledRange, {
    range: { min: 100_000, max: null, unit: "count" },
    options: { requireConfirm: true },
  });
  assert.deepEqual(result.readback, {
    before: { row: "粉丝数量", selected_filters: "" },
    after: { row: "粉丝数量 10万以上", selected_filters: "" },
    menu_closed: true,
    adopted_open_menu: false,
  });
});

test("range helper never reports success when the dynamic confirmation did not commit", async () => {
  const setFilterRange = createFilterRangeSetter({
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({
      page: { waitForTimeout: async () => {} },
      state: { page_state: "RESULTS_READY" },
    }),
    openMenu: async () => ({
      row: { innerText: async () => "粉丝数量" },
      menu: { isVisible: async () => true },
    }),
    fillRange: async () => false,
  });

  const result = payload(
    await setFilterRange({
      platform: "xingtu",
      field_label: "粉丝数量",
      min: 100_000,
      unit: "count",
    }),
  );

  assert.equal(result.success, true);
  assert.equal(result.status, "not_applied");
  assert.equal(result.verified, false);
  assert.equal(result.error.code, "RANGE_NOT_COMMITTED");
  assert.match(result.recovery_hint, /不要复用旧 Browser ref/u);
});

test("missing range controls are recoverable and login remains a human state", async () => {
  const missing = createFilterRangeSetter({
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({ page: {}, state: { page_state: "MARKET_READY" } }),
    openMenu: async () => null,
  });
  const missingResult = payload(
    await missing({ platform: "pgy", field_label: "预期CPM", max: 100, unit: "yuan" }),
  );
  assert.equal(missingResult.status, "not_applied");
  assert.equal(missingResult.error.code, "RANGE_FIELD_NOT_FOUND");

  const blocked = createFilterRangeSetter({
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({ page: {}, state: { page_state: "LOGIN_REQUIRED" } }),
  });
  const blockedResult = payload(
    await blocked({ platform: "xingtu", field_label: "粉丝数量", min: 100_000, unit: "count" }),
  );
  assert.equal(blockedResult.status, "needs_user_action");
  assert.equal(blockedResult.user_action_required, true);
});

test("range helper validates open bounds and normalized ratios", async () => {
  const setFilterRange = createFilterRangeSetter();
  const empty = payload(
    await setFilterRange({ platform: "xingtu", field_label: "粉丝数量", unit: "count" }),
  );
  assert.equal(empty.error.code, "YPSCAN_FILTER_RANGE_ARGUMENT_INVALID");

  const ratio = payload(
    await setFilterRange({
      platform: "xingtu",
      field_label: "互动率",
      min: 2,
      unit: "ratio",
    }),
  );
  assert.equal(ratio.error.code, "YPSCAN_FILTER_RANGE_ARGUMENT_INVALID");
});

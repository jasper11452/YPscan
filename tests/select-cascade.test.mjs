import assert from "node:assert/strict";
import test from "node:test";

import { createCascadeSelector } from "../src/tools/select-cascade.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test("cascade helper executes an Agent-chosen visible path and verifies the leaf commit", async () => {
  let readback = "达人分类";
  let openedArgs = null;
  let selectedValues = null;
  const selectCascade = createCascadeSelector({
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({
      page: {},
      state: { page_state: "MARKET_READY" },
    }),
    openMenu: async (_page, labels, options) => {
      openedArgs = { labels, options };
      return {
        row: { innerText: async () => readback },
        menu: {},
        trigger: {},
      };
    },
    selectValues: async (_page, _opened, values) => {
      selectedValues = values;
      readback = "达人分类 美食 / 烘焙";
      return values;
    },
  });

  const result = payload(
    await selectCascade({
      platform: "douyin",
      field_label: "达人分类",
      trigger_label: "全部分类",
      path: ["美食", "烘焙"],
    }),
  );

  assert.equal(result.success, true);
  assert.equal(result.status, "applied");
  assert.equal(result.verified, true);
  assert.deepEqual(openedArgs, {
    labels: ["达人分类"],
    options: { triggerLabels: ["全部分类"], optionValues: ["美食"] },
  });
  assert.deepEqual(selectedValues, ["美食 / 烘焙"]);
  assert.deepEqual(result.readback, {
    before: "达人分类",
    after: "达人分类 美食 / 烘焙",
  });
});

test("missing cascade controls are recoverable and do not stop the handpick task", async () => {
  const selectCascade = createCascadeSelector({
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({
      page: {},
      state: { page_state: "RESULTS_READY" },
    }),
    openMenu: async () => null,
  });

  const result = payload(
    await selectCascade({
      platform: "pgy",
      field_label: "内容分类",
      path: ["数码", "手机"],
    }),
  );

  assert.equal(result.success, true);
  assert.equal(result.status, "not_applied");
  assert.equal(result.verified, false);
  assert.equal(result.error.code, "CASCADE_FIELD_NOT_FOUND");
  assert.match(result.recovery_hint, /详情硬复核/u);
});

test("login and global CAPTCHA remain explicit human-action states", async () => {
  const selectCascade = createCascadeSelector({
    connectOverCDP: async () => ({ contexts: () => [] }),
    inspectBrowser: async () => ({
      page: {},
      state: { page_state: "CAPTCHA_BLOCKED" },
    }),
  });

  const result = payload(
    await selectCascade({
      platform: "xingtu",
      field_label: "达人分类",
      path: ["美食"],
    }),
  );

  assert.equal(result.success, false);
  assert.equal(result.status, "needs_user_action");
  assert.equal(result.user_action_required, true);
});

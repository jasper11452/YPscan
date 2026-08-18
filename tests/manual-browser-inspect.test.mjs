import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManualBrowserInspector } from "../src/tools/manual-browser-inspect.js";
import { createManualFilterSelection } from "../src/tools/manual-filter-selection.js";
import { loadManualResearchRun } from "../src/tools/manual-research-artifact.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test("v3 observer persists one full-page snapshot and leaves the next decision to the Agent", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-browser-inspect-v3-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const planned = payload(
    await createManualFilterSelection({ workspaceDir })({
      requirement_id: "inspect-contract",
      platform: "xingtu",
      facts: [{ kind: "creator_price", normalized_value: 20_000, operator: "lte" }],
      keywords: ["办公软件"],
    }),
  );
  const state = {
    observation_id: "observation-full-page",
    page_context_id: "market-context",
    state_id: "market-state",
    page_state: "MARKET_READY",
    page_kind: "creator_market",
    platform: "xingtu",
    url: "https://www.xingtu.cn/ad/creator/market",
    title: "达人广场",
    modal: { present: false },
    challenge: { present: false },
    market: { keyword: "" },
    regions: [{ region_id: "filters", kind: "filters", element_ids: ["price", "city"] }],
    elements: [
      { element_id: "price", name: "达人报价", actions: ["click", "hover"] },
      { element_id: "city", name: "城市", actions: ["click", "hover"] },
    ],
    visible_controls: [],
    selected_filters: [],
    tabs: [],
  };
  const inspect = createManualBrowserInspector({
    workspaceDir,
    connectOverCDP: async () => ({}),
    inspectBrowser: async () => ({ page: {}, state }),
  });
  const observed = payload(
    await inspect({
      requirement_id: planned.requirement_id,
      platform: planned.platform,
      run_id: planned.run_id,
    }),
  );
  assert.equal(observed.protocol_version, 3);
  assert.equal(observed.next_call, null);
  assert.deepEqual(
    observed.state.elements.map((element) => element.name),
    ["达人报价", "城市"],
  );

  const loaded = await loadManualResearchRun({
    workspaceDir,
    runId: planned.run_id,
    requirementId: planned.requirement_id,
    platform: planned.platform,
  });
  assert.equal(loaded.browser_states.at(-1).observation_id, state.observation_id);
});

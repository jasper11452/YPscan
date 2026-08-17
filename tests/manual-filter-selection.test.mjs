import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManualFilterSelection } from "../src/tools/manual-filter-selection.js";
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

function adapter(actions, { verify = true, filterApplied = true } = {}) {
  return {
    async prepare() {
      actions.push("prepare");
    },
    async reset() {
      actions.push("reset");
    },
    async setPriceView(value) {
      actions.push("price");
      return { applied: true, readback: value };
    },
    async applyFilter(filter) {
      actions.push(`filter:${filter.control}`);
      return filterApplied
        ? { applied: true, readback: filter.control }
        : { applied: false, reason: "no_commit_marker" };
    },
    async search(value) {
      actions.push(`search:${value}`);
      return { applied: true, result_count: 3 };
    },
    async verifySelection() {
      actions.push("verify");
      return { valid: verify, reason: verify ? null : "keyword_mismatch" };
    },
    async readPage() {
      actions.push("read");
      return { rows: [], source_url: "https://www.xingtu.cn/ad/creator/market" };
    },
    async nextPage() {
      actions.push("next");
      return false;
    },
    async collectDetail() {
      actions.push("detail");
    },
    async export() {
      actions.push("export");
      return { status: "complete" };
    },
  };
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

test("selection checkpoint contains normalized receipts and final-state verification", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-checkpoint-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const actions = [];
  const select = createManualFilterSelection({
    workspaceDir,
    connectOverCDP: async () => browser(),
    createAdapter: () => adapter(actions),
  });
  const selected = payload(await select(params()));
  assert.equal(selected.status, "ready");
  assert.equal(selected.ready_for_collection, true);
  assert.ok(selected.selection_id);
  assert.equal(selected.verification.actual_filters.length, 2);
  assert.equal(selected.verification.failed_filters.length, 0);
  assert.equal(selected.verification.final_state.valid, true);
  assert.ok(selected.verification.state_hash);
  const checkpointPath = join(
    workspaceDir,
    "ypscan-manual-research",
    selected.run_id,
    "checkpoint.jsonl",
  );
  const checkpoint = await readFile(checkpointPath, "utf8");
  const selectionEvent = checkpoint
    .trim()
    .split("\n")
    .map(JSON.parse)
    .find((event) => event.type === "selection");
  assert.equal(selectionEvent.selection.selection_id, selected.selection_id);
  assert.doesNotMatch(checkpoint, /cookie|token|authorization|request_headers/iu);
});

test("an uncommitted filter has no selection_id and cannot enter actual_filters", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-failed-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const actions = [];
  const select = createManualFilterSelection({
    workspaceDir,
    connectOverCDP: async () => browser(),
    createAdapter: () => adapter(actions, { filterApplied: false }),
  });
  const selected = payload(await select(params()));
  assert.equal(selected.status, "failed");
  assert.equal(selected.ready_for_collection, false);
  assert.equal(selected.selection_id, undefined);
  assert.equal(selected.verification.actual_filters.length, 0);
  assert.equal(selected.verification.failed_filters.length, 2);
});

test("a final-state mismatch cannot issue a selection credential", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-final-state-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const select = createManualFilterSelection({
    workspaceDir,
    connectOverCDP: async () => browser(),
    createAdapter: () => adapter([], { verify: false }),
  });

  const selected = payload(await select(params()));

  assert.equal(selected.status, "failed");
  assert.equal(selected.ready_for_collection, false);
  assert.equal(selected.selection_id, undefined);
  assert.equal(selected.failed_stage, "verify");
  assert.equal(selected.verification.final_state.valid, false);
  assert.equal(selected.error.code, "YPSCAN_MANUAL_SELECTION_READBACK_MISMATCH");
});

test("a newer same-branch selection invalidates the old credential before Browser access", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-stale-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const actions = [];
  const sharedBrowser = browser();
  const select = createManualFilterSelection({
    workspaceDir,
    connectOverCDP: async () => sharedBrowser,
    createAdapter: () => adapter(actions),
  });
  const first = payload(await select(params()));
  const second = payload(
    await select({
      requirement_id: params().requirement_id,
      platform: params().platform,
      run_id: first.run_id,
      branch_index: 0,
    }),
  );
  assert.notEqual(first.selection_id, second.selection_id);
  let collectorConnections = 0;
  const collect = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => {
      collectorConnections += 1;
      return sharedBrowser;
    },
    createAdapter: () => adapter(actions),
  });
  const stale = payload(await collect(first.collection_args));
  assert.equal(stale.error.code, "YPSCAN_MANUAL_SELECTION_STALE");
  assert.equal(collectorConnections, 0);
});

test("selection readback mismatch causes zero list, page, detail and export actions", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-selection-readback-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const sharedBrowser = browser();
  const selectActions = [];
  const select = createManualFilterSelection({
    workspaceDir,
    connectOverCDP: async () => sharedBrowser,
    createAdapter: () => adapter(selectActions),
  });
  const selected = payload(await select(params()));
  const collectActions = [];
  const collect = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => sharedBrowser,
    createAdapter: () => adapter(collectActions, { verify: false }),
  });
  const stale = payload(await collect(selected.collection_args));
  assert.equal(stale.error.code, "YPSCAN_MANUAL_SELECTION_STALE");
  assert.deepEqual(
    collectActions.filter((action) => ["read", "next", "detail", "export"].includes(action)),
    [],
  );
});

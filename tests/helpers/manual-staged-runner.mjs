import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createManualFilterSelection } from "../../src/tools/manual-filter-selection.js";
import { createManualResearch } from "../../src/tools/manual-research.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

export function createStagedManualResearch(options = {}) {
  const workspaceDir = options.workspaceDir ?? mkdtempSync(join(tmpdir(), "ypscan-staged-test-"));
  let stagedAdapter;
  const createAdapter = options.createAdapter
    ? (...args) => {
        stagedAdapter ??= options.createAdapter(...args);
        stagedAdapter.verifySelection ??= async () => ({ valid: true });
        return stagedAdapter;
      }
    : undefined;
  const shared = {
    ...options,
    workspaceDir,
    ...(createAdapter ? { createAdapter } : {}),
  };
  const selectFilters = createManualFilterSelection(shared);
  const collect = createManualResearch(shared);
  return async function stagedRun(params = {}) {
    if (params.operation === "apply_reviews") return collect(params);
    let selectionResult = await selectFilters(params);
    let selection = payload(selectionResult);
    if (selection.success !== true) return selectionResult;
    for (;;) {
      const collectionResult = await collect(selection.collection_args);
      const collection = payload(collectionResult);
      if (collection.status !== "awaiting_filter_selection") return collectionResult;
      selectionResult = await selectFilters(collection.next_selection_args);
      selection = payload(selectionResult);
      if (selection.success !== true) return selectionResult;
    }
  };
}

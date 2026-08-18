import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUID } from "node:crypto";
import {
  createManualResearchStore,
  loadManualResearchRun,
} from "../../src/tools/manual-research-artifact.js";
import { compileManualResearchPlan } from "../../src/tools/manual-research-plan.js";
import { validateManualFilterSelectionParams } from "../../src/tools/manual-research-protocol.js";
import {
  createManualResearch,
  resolveManualResearchPage,
} from "../../src/tools/manual-research.js";
import { hostToolResult } from "../../src/tools/tool-result.js";

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
  const selectFilters = async (rawParams) => {
    try {
      const params = validateManualFilterSelectionParams(rawParams);
      const loaded = params.initial
        ? null
        : await loadManualResearchRun({
            workspaceDir,
            runId: params.run_id,
            requirementId: params.requirement_id,
            platform: params.platform,
          });
      const plan = loaded?.plan ?? compileManualResearchPlan(params);
      const branch = plan.branches[params.branch_index];
      const store = await createManualResearchStore({
        workspaceDir,
        params: { ...params, run_id: params.run_id ?? null },
        plan,
      });
      const browser = await options.connectOverCDP(
        options.browserCdpUrl ?? "http://127.0.0.1:18800",
      );
      const page = await resolveManualResearchPage(browser, params.platform);
      const currentAdapter = createAdapter(params.platform, page, { workspaceDir, now: Date.now });
      const previous = loaded?.selections
        .filter((item) => item.status === "ready")
        .at(-1)?.verification;
      let verification;
      const runAttempt = async (preserved) => {
        await currentAdapter.prepare();
        if (!preserved) {
          await currentAdapter.reset();
          const baseline = await currentAdapter.verifyBaseline?.();
          if (baseline && !baseline.valid) {
            throw Object.assign(new Error("baseline"), {
              code: "YPSCAN_MANUAL_RESET_NOT_APPLIED",
              details: { failed_stage: "reset", failed_control: null, baseline },
            });
          }
        }
        let priceView = preserved?.price_view;
        const actualFilters = preserved ? [...preserved.actual_filters] : [];
        if (!preserved) {
          priceView = await currentAdapter.setPriceView(plan.price_view);
          if (!priceView.applied) {
            throw Object.assign(new Error("price"), {
              code: "YPSCAN_MANUAL_PRICE_VIEW_NOT_APPLIED",
              details: {
                failed_stage: "price_view",
                failed_control: "price_view",
                verification: { price_view: priceView, actual_filters: [], failed_filters: [] },
              },
            });
          }
          for (const filter of plan.filters) {
            const receipt = await currentAdapter.applyFilter(filter);
            if (!receipt.applied) {
              throw Object.assign(new Error("filter"), {
                code: "YPSCAN_MANUAL_FILTER_NOT_APPLIED",
                details: {
                  failed_stage: "filter",
                  failed_control: filter.control,
                  verification: {
                    price_view: priceView,
                    actual_filters: actualFilters,
                    failed_filters: [{ ...filter, ...receipt }],
                  },
                },
              });
            }
            actualFilters.push({ ...filter, ...receipt });
          }
        }
        const keyword = await currentAdapter.search(branch.keyword);
        if (!keyword.applied) {
          throw Object.assign(new Error("keyword"), {
            code: "YPSCAN_MANUAL_KEYWORD_NOT_APPLIED",
            details: {
              failed_stage: "keyword",
              failed_control: "keyword",
              verification: {
                price_view: priceView,
                actual_filters: actualFilters,
                failed_filters: [],
              },
            },
          });
        }
        const next = {
          keyword: { requested: branch.keyword, ...keyword },
          price_view: { requested: plan.price_view, ...priceView },
          actual_filters: actualFilters,
          failed_filters: [],
          unexpressed_filters: plan.unexpressed,
        };
        const finalState = await currentAdapter.verifySelection({ branch, verification: next });
        if (!finalState.valid) {
          throw Object.assign(new Error("verify"), {
            code: "YPSCAN_MANUAL_SELECTION_READBACK_MISMATCH",
            details: { failed_stage: "verify", failed_control: null, verification: next },
          });
        }
        next.final_state = finalState;
        return next;
      };
      const failures = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          verification = await runAttempt(attempt === 1 ? previous : null);
          if (failures.length) {
            verification.recovery = { attempted: true, attempts: attempt, errors: failures };
          }
          break;
        } catch (error) {
          failures.push({ attempt, code: error.code, message: error.message });
          if (attempt === 2 || /LOGIN|CAPTCHA/u.test(error.code ?? "")) throw error;
          await currentAdapter.recover?.(error);
        }
      }
      const selection = {
        selection_id: randomUUID(),
        status: "ready",
        requirement_id: params.requirement_id,
        platform: params.platform,
        branch,
        verification,
        ...(currentAdapter.listSnapshot?.()
          ? { list_snapshot: currentAdapter.listSnapshot() }
          : {}),
      };
      await store.saveSelection(selection);
      const data = {
        success: true,
        status: "ready",
        run_id: store.run_id,
        selection_id: selection.selection_id,
        collection_args: {
          operation: "collect",
          requirement_id: params.requirement_id,
          platform: params.platform,
          run_id: store.run_id,
          selection_id: selection.selection_id,
        },
      };
      return hostToolResult(data, { details: data });
    } catch (error) {
      const data = {
        success: false,
        status: /LOGIN|CAPTCHA/u.test(error.code ?? "") ? "needs_user_action" : "failed",
        ready_for_collection: false,
        failed_stage: error.details?.failed_stage ?? null,
        failed_control: error.details?.failed_control ?? null,
        verification: error.details?.verification ?? {
          actual_filters: [],
          failed_filters: [],
        },
        error: {
          code: error.code ?? "YPSCAN_MANUAL_FILTER_SELECTION_FAILED",
          message: error.message,
        },
      };
      return hostToolResult(data, { details: data, isError: true });
    }
  };
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

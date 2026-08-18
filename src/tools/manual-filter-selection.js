import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { createManualResearchStore, loadManualResearchRun } from "./manual-research-artifact.js";
import { compileManualResearchPlan } from "./manual-research-plan.js";
import {
  MANUAL_FILTER_SELECTION_PARAMETERS,
  validateManualFilterSelectionParams,
} from "./manual-research-protocol.js";
import { createManualResearchAdapter, resolveManualResearchPage } from "./manual-research.js";
import { hostToolResult } from "./tool-result.js";

export { MANUAL_FILTER_SELECTION_PARAMETERS };

const DEFAULT_CDP_URL = "http://127.0.0.1:18800";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function stateHash(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, canonical(item[key])]),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function requiresUserAction(error) {
  return /LOGIN|CAPTCHA/u.test(error?.code ?? "");
}

function selectionError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

async function applySelection(adapter, branch, plan, platform, preservedVerification = null) {
  const actualFilters = [...(preservedVerification?.actual_filters ?? [])];
  const failedFilters = [];
  let failedStage = "reset";
  let failedControl = null;
  try {
    await adapter.prepare();
    if (!preservedVerification) {
      await adapter.reset();
      const baseline = await adapter.verifyBaseline?.();
      if (baseline && !baseline.valid) {
        throw selectionError("YPSCAN_MANUAL_RESET_NOT_APPLIED", "页面旧筛选未清理干净", {
          baseline,
        });
      }
    }

    const applyFilters = async () => {
      failedStage = "price_view";
      failedControl = "price_view";
      await adapter.prepare();
      const priceView = await adapter.setPriceView(plan.price_view);
      if (!priceView.applied) {
        throw selectionError("YPSCAN_MANUAL_PRICE_VIEW_NOT_APPLIED", "报价档位未切换并回读成功", {
          price_view: priceView,
        });
      }
      failedStage = "filter";
      for (const filter of plan.filters) {
        failedControl = filter.control;
        await adapter.prepare();
        const receipt = await adapter.applyFilter(filter);
        const record = { ...filter, ...receipt };
        if (receipt.applied) actualFilters.push(record);
        else failedFilters.push(record);
      }
      return priceView;
    };

    const applyKeyword = async () => {
      failedStage = "keyword";
      failedControl = "keyword";
      await adapter.prepare();
      const keyword = await adapter.search(branch.keyword);
      if (!keyword.applied) {
        throw selectionError("YPSCAN_MANUAL_KEYWORD_NOT_APPLIED", "关键词未真实提交", {
          keyword,
        });
      }
      return keyword;
    };

    let keyword;
    let priceView;
    if (preservedVerification) {
      priceView = preservedVerification.price_view;
      keyword = await applyKeyword();
      if (platform === "pgy" && adapter.resultCount) {
        keyword.result_count = await adapter.resultCount();
      }
    } else if (platform === "pgy") {
      keyword = await applyKeyword();
      priceView = await applyFilters();
      if (adapter.resultCount) keyword.result_count = await adapter.resultCount();
    } else {
      priceView = await applyFilters();
      keyword = await applyKeyword();
    }
    if (failedFilters.length) {
      const first = failedFilters[0];
      throw selectionError("YPSCAN_MANUAL_FILTER_NOT_APPLIED", "存在未提交的页面筛选", {
        failed_stage: "filter",
        failed_control: first.control,
        failed_filters: failedFilters,
      });
    }
    const verification = {
      keyword: { requested: branch.keyword, ...keyword },
      price_view: { requested: plan.price_view, ...priceView },
      actual_filters: actualFilters,
      failed_filters: failedFilters,
      unexpressed_filters: plan.unexpressed ?? [],
      result_count: keyword.result_count ?? null,
    };
    failedStage = "verify";
    failedControl = null;
    const finalState = await adapter.verifySelection({ branch, verification });
    if (!finalState?.valid) {
      throw selectionError(
        "YPSCAN_MANUAL_SELECTION_READBACK_MISMATCH",
        "最终页面筛选状态与已提交筛选不一致",
        { final_state: finalState },
      );
    }
    verification.final_state = finalState;
    return verification;
  } catch (error) {
    error.details = {
      ...(error?.details ?? {}),
      failed_stage: error?.details?.failed_stage ?? failedStage,
      failed_control: error?.details?.failed_control ?? failedControl,
      actual_filters: actualFilters,
      failed_filters: error?.details?.failed_filters ?? failedFilters,
      unexpressed_filters: plan.unexpressed ?? [],
    };
    throw error;
  }
}

/**
 * Create the explicit Browser filter-selection stage.
 *
 * @param {{
 *   browserCdpUrl?: string,
 *   workspaceDir?: string,
 *   connectOverCDP?: (endpointURL: string) => Promise<import("playwright-core").Browser>,
 *   createAdapter?: typeof createManualResearchAdapter,
 *   createArtifactStore?: typeof createManualResearchStore,
 *   loadRun?: typeof loadManualResearchRun,
 *   now?: () => number,
 * }} [options]
 */
export function createManualFilterSelection({
  browserCdpUrl = DEFAULT_CDP_URL,
  workspaceDir,
  connectOverCDP = (endpointURL) => chromium.connectOverCDP(endpointURL),
  createAdapter = createManualResearchAdapter,
  createArtifactStore = createManualResearchStore,
  loadRun = loadManualResearchRun,
  now = Date.now,
} = {}) {
  const cdpUrl = clean(browserCdpUrl).replace(/\/$/u, "");
  return async function manualFilterSelection(rawParams = {}) {
    let params;
    let plan;
    let store;
    let adapter;
    let branch;
    let preservedVerification = null;
    let verification = {
      keyword: null,
      price_view: null,
      actual_filters: [],
      failed_filters: [],
      unexpressed_filters: [],
      result_count: null,
    };
    let failedStage = "arguments";
    let failedControl = null;
    try {
      params = validateManualFilterSelectionParams(rawParams);
      if (params.initial) {
        plan = compileManualResearchPlan(params);
      } else {
        const loaded = await loadRun({
          workspaceDir,
          runId: params.run_id,
          requirementId: params.requirement_id,
          platform: params.platform,
        });
        plan = loaded.plan;
        if (params.branch_index > 0) {
          const previousBranch = plan.branches[params.branch_index - 1];
          const previousSelection = loaded.selections
            .slice()
            .reverse()
            .find(
              (selection) =>
                selection.status === "ready" &&
                selection.branch?.branch_id === previousBranch?.branch_id,
            );
          preservedVerification = previousSelection?.verification ?? null;
        }
      }
      branch = plan.branches[params.branch_index];
      if (!branch) {
        throw selectionError("YPSCAN_MANUAL_BRANCH_INVALID", "branch_index 已超过当前关键词分支数");
      }
      store = await createArtifactStore({
        workspaceDir,
        params: { ...params, run_id: params.run_id ?? null },
        plan,
        now,
      });
      if (!store.enabled || !store.run_id) {
        throw selectionError(
          "YPSCAN_MANUAL_WORKSPACE_UNAVAILABLE",
          "手扒工作区不可用，无法持久化 selection_id",
        );
      }
      failedStage = "navigate";
      const browser = await connectOverCDP(cdpUrl);
      const page = await resolveManualResearchPage(browser, params.platform);
      adapter = createAdapter(params.platform, page, { workspaceDir, now });

      const recoveryErrors = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          verification = await applySelection(
            adapter,
            branch,
            plan,
            params.platform,
            attempt === 1 ? preservedVerification : null,
          );
          if (recoveryErrors.length) {
            verification.recovery = {
              attempted: true,
              attempts: attempt,
              errors: recoveryErrors,
            };
          }
          break;
        } catch (error) {
          recoveryErrors.push({
            attempt,
            code: error?.code ?? "YPSCAN_MANUAL_SELECTION_FAILED",
            message: error?.message ?? String(error),
          });
          failedStage = error?.details?.failed_stage ?? verification.failed_stage ?? failedStage;
          failedControl =
            error?.details?.failed_control ?? verification.failed_control ?? failedControl;
          if (attempt === 2 || requiresUserAction(error)) {
            throw error;
          }
          await adapter.recover?.(error);
        }
      }
      const selectionId = randomUUID();
      const normalizedState = {
        platform: params.platform,
        page_url: page.url(),
        branch,
        keyword: verification.keyword,
        price_view: verification.price_view,
        actual_filters: verification.actual_filters,
      };
      verification.state_hash = stateHash(normalizedState);
      const listSnapshot =
        params.platform === "xingtu" && typeof adapter.listSnapshot === "function"
          ? adapter.listSnapshot()
          : null;
      const selection = {
        selection_id: selectionId,
        status: "ready",
        requirement_id: params.requirement_id,
        platform: params.platform,
        branch,
        page_url: page.url(),
        verification,
        ...(listSnapshot ? { list_snapshot: listSnapshot } : {}),
        selected_at: new Date(now()).toISOString(),
      };
      await store.saveSelection(selection);
      const payload = {
        success: true,
        status: "ready",
        operation: "select_filters",
        requirement_id: params.requirement_id,
        platform: params.platform,
        run_id: store.run_id,
        selection_id: selectionId,
        branch,
        ready_for_collection: true,
        verification,
        collection_args: {
          operation: "collect",
          requirement_id: params.requirement_id,
          platform: params.platform,
          run_id: store.run_id,
          selection_id: selectionId,
        },
      };
      return hostToolResult(payload, { details: payload });
    } catch (error) {
      const status = requiresUserAction(error) ? "needs_user_action" : "failed";
      failedStage = error?.details?.failed_stage ?? failedStage;
      failedControl = error?.details?.failed_control ?? failedControl;
      verification.failed_filters =
        error?.details?.failed_filters ?? verification.failed_filters ?? [];
      verification.actual_filters =
        error?.details?.actual_filters ?? verification.actual_filters ?? [];
      verification.unexpressed_filters =
        error?.details?.unexpressed_filters ?? verification.unexpressed_filters ?? [];
      if (error?.details?.price_view) verification.price_view = error.details.price_view;
      if (error?.details?.keyword) verification.keyword = error.details.keyword;
      if (error?.details?.final_state) verification.final_state = error.details.final_state;
      const failedSelection = branch
        ? {
            status,
            requirement_id: params?.requirement_id ?? clean(rawParams.requirement_id),
            platform: params?.platform ?? clean(rawParams.platform),
            branch,
            failed_stage: failedStage,
            failed_control: failedControl,
            verification,
            error: {
              code: error?.code ?? "YPSCAN_MANUAL_FILTER_SELECTION_FAILED",
              message: error?.message ?? String(error),
            },
            selected_at: new Date(now()).toISOString(),
          }
        : null;
      if (failedSelection && store?.enabled)
        await store.saveSelection(failedSelection).catch(() => {});
      const payload = {
        success: false,
        status,
        operation: "select_filters",
        ready_for_collection: false,
        requirement_id: params?.requirement_id ?? (clean(rawParams.requirement_id) || null),
        platform: params?.platform ?? (clean(rawParams.platform) || null),
        run_id: store?.run_id ?? params?.run_id ?? null,
        branch: branch ?? null,
        failed_stage: failedStage,
        failed_control: failedControl,
        verification,
        error: {
          code: error?.code ?? "YPSCAN_MANUAL_FILTER_SELECTION_FAILED",
          message: error?.message ?? String(error),
          details: error?.details ?? {},
        },
      };
      return hostToolResult(payload, { details: payload, isError: true });
    } finally {
      await adapter?.dispose?.().catch(() => {});
    }
  };
}

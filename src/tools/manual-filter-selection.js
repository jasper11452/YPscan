import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import {
  branchInteractionPlan,
  browserActionsForBranch,
  browserRequirementsForPlan,
} from "./manual-browser-plan.js";
import { inspectManualBrowser } from "./manual-browser-state.js";
import { createManualResearchStore, loadManualResearchRun } from "./manual-research-artifact.js";
import { compileManualResearchPlan } from "./manual-research-plan.js";
import {
  MANUAL_FILTER_SELECTION_PARAMETERS,
  validateManualFilterSelectionParams,
} from "./manual-research-protocol.js";
import { createManualResearchAdapter } from "./manual-research.js";
import { hostToolResult } from "./tool-result.js";

export { MANUAL_FILTER_SELECTION_PARAMETERS };

const DEFAULT_CDP_URL = "http://127.0.0.1:18800";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function stateHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function selectionError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function statusForError(error) {
  return /LOGIN|CAPTCHA/u.test(error?.code ?? "") ? "needs_user_action" : "failed";
}

function latestActionsByPlanId(actions, branchIndex) {
  const latest = new Map();
  for (const action of actions ?? []) {
    if (action.branch_index === branchIndex && action.plan_action_id) {
      latest.set(action.plan_action_id, action);
    }
  }
  return latest;
}

function verificationFromActions(plannedActions, completed) {
  const pricePlan = plannedActions.find((action) => action.action === "set_price_view");
  const keywordPlan = plannedActions.find((action) => action.action === "search_keyword");
  const filterPlans = plannedActions.filter((action) => action.action === "apply_filter");
  const priceAction = pricePlan ? completed.get(pricePlan.plan_action_id) : null;
  const keywordAction = keywordPlan ? completed.get(keywordPlan.plan_action_id) : null;
  return {
    keyword: keywordPlan
      ? { requested: keywordPlan.keyword, ...(keywordAction?.receipt ?? {}) }
      : null,
    price_view: pricePlan
      ? { requested: pricePlan.price_view, ...(priceAction?.receipt ?? {}) }
      : { requested: null, applied: true, readback: null },
    actual_filters: filterPlans.map((action) => ({
      ...action.filter,
      ...(completed.get(action.plan_action_id)?.receipt ?? {}),
    })),
    failed_filters: [],
    unexpressed_filters: [],
  };
}

function latestRequirementActions(actions) {
  const latest = new Map();
  for (const action of actions ?? []) {
    if (action.protocol_version === 3 && action.ok && action.verified && action.requirement_ref) {
      latest.set(action.requirement_ref, action);
    }
  }
  return latest;
}

async function commitV3Selection({
  params,
  plan,
  branch,
  loaded,
  store,
  connectOverCDP,
  cdpUrl,
  inspectBrowser,
  now,
}) {
  const requirements = browserRequirementsForPlan(plan);
  const requirementActions = latestRequirementActions(loaded.browser_actions);
  const baseSelection = (loaded.selections ?? []).find(
    (selection) => selection.protocol_version === 3 && selection.status === "ready",
  );
  const missingRequirements = baseSelection
    ? []
    : requirements
        .map((requirement) => requirement.requirement_ref)
        .filter((reference) => !requirementActions.has(reference));
  const baselineReady = baseSelection
    ? true
    : (loaded.browser_states ?? []).some(
        (state) =>
          state.page_kind === "creator_market" &&
          !clean(state.market?.keyword) &&
          (state.selected_filters ?? []).length === 0,
      );
  const actions = loaded.browser_actions ?? [];
  const keywordIndex = actions.findLastIndex(
    (action) =>
      action.protocol_version === 3 &&
      action.ok &&
      action.verified &&
      action.branch_index === branch.branch_index &&
      action.purpose === "keyword_search",
  );
  const lastFilterMutation = actions.findLastIndex(
    (action) =>
      action.protocol_version === 3 &&
      action.ok &&
      action.verified &&
      ["reset_filters", "filter_requirement", "repair_filter"].includes(action.purpose),
  );
  if (
    !baselineReady ||
    missingRequirements.length ||
    keywordIndex < 0 ||
    keywordIndex < lastFilterMutation
  ) {
    throw selectionError(
      "YPSCAN_MANUAL_ACTIONS_INCOMPLETE",
      "页面硬筛、干净基线或最后关键词动作尚未完成",
      {
        baseline_ready: baselineReady,
        missing_requirement_refs: missingRequirements,
        keyword_submitted: keywordIndex >= 0,
        keyword_is_last: keywordIndex >= lastFilterMutation,
        next_call: {
          tool: "ypscan_manual_browser_inspect",
          args: {
            requirement_id: params.requirement_id,
            platform: params.platform,
            run_id: store.run_id,
          },
          reason: "重新观察完整页面，由 Agent 决定下一条元素动作",
        },
      },
    );
  }
  const browser = await connectOverCDP(cdpUrl);
  const observed = await inspectBrowser(browser, params.platform);
  if (!observed.page) {
    throw selectionError("YPSCAN_MANUAL_PAGE_STATE_UNKNOWN", "无法确定当前 Browser 页面");
  }
  if (["LOGIN_REQUIRED", "CAPTCHA_BLOCKED"].includes(observed.state.page_state)) {
    throw selectionError(observed.state.page_state, "当前 Browser 需要用户处理", {
      state: observed.state,
    });
  }
  if (observed.state.page_kind !== "creator_market") {
    throw selectionError("YPSCAN_MANUAL_SELECTION_READBACK_MISMATCH", "当前页面不是达人广场", {
      state: observed.state,
    });
  }
  const keywordAction = actions[keywordIndex];
  if (clean(observed.state.market?.keyword) !== clean(branch.keyword)) {
    throw selectionError("YPSCAN_MANUAL_SELECTION_READBACK_MISMATCH", "当前关键词与分支不一致", {
      requested: branch.keyword,
      actual: observed.state.market?.keyword ?? null,
    });
  }
  const currentFilterFingerprint = observed.state.selected_filter_fingerprint;
  if (baseSelection && currentFilterFingerprint !== baseSelection.filter_fingerprint) {
    throw selectionError("YPSCAN_MANUAL_FILTER_SET_DRIFT", "后续关键词的硬筛条件发生漂移", {
      expected_filter_fingerprint: baseSelection.filter_fingerprint,
      actual_filter_fingerprint: currentFilterFingerprint,
      selected_filters: observed.state.selected_filters,
      next_call: {
        tool: "ypscan_manual_browser_inspect",
        args: {
          requirement_id: params.requirement_id,
          platform: params.platform,
          run_id: store.run_id,
        },
        reason: "仅修复发生漂移的筛选项，禁止清空全部条件",
      },
    });
  }
  const verification = {
    keyword: {
      requested: branch.keyword,
      readback: observed.state.market?.keyword ?? "",
      applied: true,
      result_count: observed.state.market?.result_row_count ?? null,
      action_id: keywordAction.action_id,
    },
    requirements: requirements.map((requirement) => ({
      ...requirement,
      inherited: Boolean(baseSelection),
      action_id:
        requirementActions.get(requirement.requirement_ref)?.action_id ??
        baseSelection?.verification?.requirements?.find(
          (item) => item.requirement_ref === requirement.requirement_ref,
        )?.action_id ??
        null,
    })),
    actual_filters: requirements.map((requirement) => ({
      control: requirement.kind,
      requirement_ref: requirement.requirement_ref,
      readback:
        requirementActions.get(requirement.requirement_ref)?.receipt?.after_selected_filters ??
        observed.state.selected_filters,
    })),
    price_view: {
      requested: plan.price_view ?? null,
      applied: !plan.price_view || requirements.some((item) => item.kind === "price_view"),
      readback: plan.price_view ?? null,
    },
    unexpressed_filters: plan.unexpressed ?? [],
    selected_filters: observed.state.selected_filters,
    filter_fingerprint: currentFilterFingerprint,
    final_state: {
      valid: true,
      page_context_id: observed.state.page_context_id,
      observation_id: observed.state.observation_id,
    },
  };
  const filterSetId =
    baseSelection?.filter_set_id ??
    stateHash({
      platform: params.platform,
      filter_fingerprint: currentFilterFingerprint,
      requirement_refs: requirements.map((item) => item.requirement_ref),
    });
  const selectionId = randomUUID();
  const selection = {
    protocol_version: 3,
    selection_id: selectionId,
    status: "ready",
    requirement_id: params.requirement_id,
    platform: params.platform,
    branch,
    page_url: observed.state.url,
    filter_set_id: filterSetId,
    filter_fingerprint: currentFilterFingerprint,
    verification,
    selected_at: new Date(now()).toISOString(),
  };
  await store.saveBrowserState({ source: "selection_commit", ...observed.state });
  await store.saveSelection(selection);
  await store.savePhaseTransition({
    phase: "FILTERS_VERIFIED",
    branch_index: branch.branch_index,
    selection_id: selectionId,
    filter_set_id: filterSetId,
  });
  const payload = {
    success: true,
    status: "ready",
    operation: "commit",
    protocol_version: 3,
    requirement_id: params.requirement_id,
    platform: params.platform,
    run_id: store.run_id,
    selection_id: selectionId,
    filter_set_id: filterSetId,
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
}

/**
 * Create the plan/commit selection boundary. Planning never touches Browser;
 * committing never repairs or reapplies a failed interaction.
 *
 * @param {{
 *   browserCdpUrl?: string,
 *   workspaceDir?: string,
 *   connectOverCDP?: (endpointURL: string) => Promise<import("playwright-core").Browser>,
 *   createAdapter?: typeof createManualResearchAdapter,
 *   createArtifactStore?: typeof createManualResearchStore,
 *   loadRun?: typeof loadManualResearchRun,
 *   inspectBrowser?: typeof inspectManualBrowser,
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
  inspectBrowser = inspectManualBrowser,
  now = Date.now,
} = {}) {
  const cdpUrl = clean(browserCdpUrl).replace(/\/$/u, "");
  return async function manualFilterSelection(rawParams = {}) {
    let params;
    let store;
    let branch = null;
    let protocolVersion = 3;
    try {
      params = validateManualFilterSelectionParams(rawParams);
      let plan;
      let loaded = null;
      if (params.initial) {
        plan = compileManualResearchPlan(params);
      } else {
        loaded = await loadRun({
          workspaceDir,
          runId: params.run_id,
          requirementId: params.requirement_id,
          platform: params.platform,
        });
        plan = loaded.plan;
      }
      protocolVersion = plan.protocol_version ?? 2;
      branch = plan.branches[params.branch_index ?? 0];
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
          "手扒工作区不可用，无法持久化 Browser 动作和 selection_id",
        );
      }
      const plannedActions = browserActionsForBranch(plan, branch);
      if (params.operation === "plan") {
        await store.savePhaseTransition({ phase: "PLANNED", branch_index: branch.branch_index });
        const nextCall = {
          tool: "ypscan_manual_browser_inspect",
          args: {
            requirement_id: params.requirement_id,
            platform: params.platform,
            run_id: store.run_id,
          },
          reason: "先识别当前 Browser 页面状态",
        };
        const payload = {
          success: true,
          status: "awaiting_browser_actions",
          operation: "plan",
          protocol_version: plan.protocol_version ?? 2,
          requirement_id: params.requirement_id,
          platform: params.platform,
          run_id: store.run_id,
          branch,
          ready_for_collection: false,
          ...(plan.protocol_version === 3
            ? { interaction_plan: branchInteractionPlan(plan, branch, loaded?.selections ?? []) }
            : { planned_actions: plannedActions }),
          next_call: nextCall,
        };
        return hostToolResult(payload, { details: payload });
      }

      loaded ??= await loadRun({
        workspaceDir,
        runId: store.run_id,
        requirementId: params.requirement_id,
        platform: params.platform,
      });
      if (plan.protocol_version === 3) {
        return await commitV3Selection({
          params,
          plan,
          branch,
          loaded,
          store,
          connectOverCDP,
          cdpUrl,
          inspectBrowser,
          now,
        });
      }
      const completed = latestActionsByPlanId(loaded.browser_actions, branch.branch_index);
      const incomplete = plannedActions.filter((action) => {
        const receipt = completed.get(action.plan_action_id);
        return !receipt?.ok || !receipt?.verified;
      });
      if (incomplete.length) {
        throw selectionError("YPSCAN_MANUAL_ACTIONS_INCOMPLETE", "页面筛选计划尚未全部执行并验证", {
          incomplete_action_ids: incomplete.map((action) => action.plan_action_id),
          next_call: {
            tool: "ypscan_manual_browser_inspect",
            args: {
              requirement_id: params.requirement_id,
              platform: params.platform,
              run_id: store.run_id,
            },
            reason: `动作 ${incomplete[0].plan_action_id} 尚未完成，需重新观察页面后获取可执行动作。`,
          },
        });
      }
      const browser = await connectOverCDP(cdpUrl);
      const observed = await inspectBrowser(browser, params.platform);
      if (!observed.page) {
        throw selectionError("YPSCAN_MANUAL_PAGE_STATE_UNKNOWN", "无法唯一确定当前 Browser 页面", {
          state: observed.state,
        });
      }
      if (["LOGIN_REQUIRED", "CAPTCHA_BLOCKED"].includes(observed.state.page_state)) {
        throw selectionError(observed.state.page_state, "当前 Browser 需要用户处理", {
          state: observed.state,
        });
      }
      if (!["MARKET_READY", "RESULTS_READY"].includes(observed.state.page_state)) {
        throw selectionError(
          "YPSCAN_MANUAL_SELECTION_READBACK_MISMATCH",
          "当前页面不是可复核的达人广场结果页",
          { state: observed.state },
        );
      }
      const verification = verificationFromActions(plannedActions, completed);
      verification.unexpressed_filters = plan.unexpressed ?? [];
      const adapter = createAdapter(params.platform, observed.page, { workspaceDir, now });
      const finalState = await adapter.verifySelection({ branch, verification });
      await adapter.dispose?.().catch(() => {});
      if (!finalState?.valid) {
        throw selectionError(
          "YPSCAN_MANUAL_SELECTION_READBACK_MISMATCH",
          "最终页面筛选状态与已验证动作不一致",
          { final_state: finalState, state: observed.state },
        );
      }
      verification.final_state = finalState;
      verification.state_hash = stateHash({
        platform: params.platform,
        page_url: observed.state.url,
        branch,
        keyword: verification.keyword,
        price_view: verification.price_view,
        actual_filters: verification.actual_filters,
      });
      const searchPlan = plannedActions.find((action) => action.action === "search_keyword");
      const listSnapshot = searchPlan
        ? completed.get(searchPlan.plan_action_id)?.receipt?.list_snapshot
        : null;
      const selectionId = randomUUID();
      const selection = {
        protocol_version: protocolVersion,
        selection_id: selectionId,
        status: "ready",
        requirement_id: params.requirement_id,
        platform: params.platform,
        branch,
        page_url: observed.state.url,
        verification,
        ...(listSnapshot ? { list_snapshot: listSnapshot } : {}),
        selected_at: new Date(now()).toISOString(),
      };
      await store.saveSelection(selection);
      await store.savePhaseTransition({
        phase: "FILTERS_VERIFIED",
        branch_index: branch.branch_index,
        selection_id: selectionId,
      });
      const payload = {
        success: true,
        status: "ready",
        operation: "commit",
        protocol_version: protocolVersion,
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
      const status = statusForError(error);
      const payload = {
        success: false,
        status,
        operation: params?.operation ?? rawParams.operation ?? "plan",
        protocol_version: protocolVersion,
        ready_for_collection: false,
        requirement_id: params?.requirement_id ?? (clean(rawParams.requirement_id) || null),
        platform: params?.platform ?? (clean(rawParams.platform) || null),
        run_id: store?.run_id ?? params?.run_id ?? null,
        branch,
        next_call: error?.details?.next_call ?? null,
        error: {
          code: error?.code ?? "YPSCAN_MANUAL_FILTER_SELECTION_FAILED",
          message: error?.message ?? String(error),
          details: error?.details ?? {},
        },
      };
      return hostToolResult(payload, { details: payload, isError: true });
    }
  };
}

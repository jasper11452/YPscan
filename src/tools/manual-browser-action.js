import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { createManualResearchStore, loadManualResearchRun } from "./manual-research-artifact.js";
import {
  browserActionsForBranch,
  browserRequirementsForPlan,
  findPlannedBrowserAction,
} from "./manual-browser-plan.js";
import {
  inspectManualBrowser,
  inspectManualBrowserPage,
  resolveInteractiveElement,
} from "./manual-browser-state.js";
import { candidateReference, detailGroupsForPlan } from "./manual-research-detail.js";
import { createManualResearchAdapter, resolveManualResearchPage } from "./manual-research.js";
import {
  activateCreatorDetailSection,
  openCreatorDetailPage,
} from "./manual-research/detail-page.js";
import { captureDetailResponsesDuring } from "./manual-research/detail-response-capture.js";
import {
  dismissOrdinaryPopups,
  manualBrowserError,
  pageMatches,
  PLATFORM_RULES,
} from "./manual-research/common.js";
import { hostToolResult } from "./tool-result.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:18800";
const PLAN_ACTIONS = new Set([
  "ensure_market_ready",
  "reset_filters",
  "set_price_view",
  "apply_filter",
  "search_keyword",
]);
const ACTIONS = Object.freeze([
  ...PLAN_ACTIONS,
  "dismiss_modal",
  "wait_for_ready",
  "next_results_page",
  "open_creator_detail",
  "activate_detail_section",
  "return_to_market",
]);
const BLOCKING_STATES = new Set(["LOGIN_REQUIRED", "CAPTCHA_BLOCKED", "MODAL_BLOCKED"]);
const V3_OPERATIONS = Object.freeze([
  "activate_tab",
  "navigate_market",
  "wait",
  "click",
  "hover",
  "fill",
  "fill_submit",
  "select",
  "set_range",
  "confirm",
  "return_to_market",
]);
const V3_ELEMENT_OPERATIONS = new Set([
  "click",
  "hover",
  "fill",
  "fill_submit",
  "select",
  "confirm",
]);
const V3_PURPOSES = new Set([
  "navigation",
  "wait",
  "reset_filters",
  "filter_requirement",
  "repair_filter",
  "keyword_search",
  "pagination",
  "detail",
  "modal",
  "inspection",
]);
const V3_EFFECTS = new Set([
  "page_changed",
  "menu_opened",
  "value_filled",
  "value_selected",
  "dialog_closed",
  "navigation",
  "results_refreshed",
]);

export const MANUAL_BROWSER_ACTION_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["requirement_id", "platform", "run_id"],
  properties: {
    requirement_id: { type: "string", minLength: 1 },
    platform: {
      type: "string",
      enum: ["xingtu", "douyin", "pgy", "xiaohongshu"],
    },
    run_id: { type: "string", minLength: 1 },
    action: { type: "string", enum: ACTIONS },
    operation: { type: "string", enum: V3_OPERATIONS },
    expected_state_id: { type: "string", minLength: 1 },
    observation_id: { type: "string", minLength: 1 },
    target_tab_id: { type: "string", minLength: 1 },
    element_id: { type: "string", minLength: 1 },
    element_ids: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    confirm_element_id: { type: "string", minLength: 1 },
    value: {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
    },
    values: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
    range: {
      type: "object",
      additionalProperties: false,
      properties: {
        min: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
        max: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
      },
    },
    wait_ms: { type: "integer", minimum: 100, maximum: 10000 },
    purpose: { type: "string", enum: [...V3_PURPOSES] },
    expected_effect: { type: "string", enum: [...V3_EFFECTS] },
    requirement_ref: { type: "string", minLength: 1 },
    branch_index: { type: "integer", minimum: 0 },
    plan_action_id: { type: "string", minLength: 1 },
    modal_id: { type: "string", minLength: 1 },
    candidate_ref: { type: "string", minLength: 1 },
    detail_group: {
      type: "string",
      enum: ["audience", "performance", "growth", "recent_content"],
    },
    target_states: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: { type: "string" },
    },
  },
});

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizePlatform(value) {
  const platform = clean(value).toLowerCase();
  if (platform === "douyin") return "xingtu";
  if (platform === "xiaohongshu") return "pgy";
  if (platform === "xingtu" || platform === "pgy") return platform;
  throw manualBrowserError("YPSCAN_MANUAL_ARGUMENT_INVALID", `不支持平台：${platform || "空"}`);
}

function actionSignature(params) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action: params.action,
        branch_index: params.branch_index ?? null,
        plan_action_id: params.plan_action_id ?? null,
        candidate_ref: params.candidate_ref ?? null,
        detail_group: params.detail_group ?? null,
        operation: params.operation ?? null,
        element_id: params.element_id ?? null,
        requirement_ref: params.requirement_ref ?? null,
        target_tab_id: params.target_tab_id ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function safeErrorCode(error) {
  const code = clean(error?.code);
  if (/LOGIN/u.test(code)) return "LOGIN_REQUIRED";
  if (/CAPTCHA|DETAIL_RISK/u.test(code)) return "CAPTCHA_BLOCKED";
  if (/TIMEOUT/u.test(code) || error?.name === "TimeoutError") return "TIMEOUT";
  return code || "POSTCONDITION_FAILED";
}

function failureFromState(state) {
  if (state.page_state === "LOGIN_REQUIRED") return "LOGIN_REQUIRED";
  if (state.page_state === "CAPTCHA_BLOCKED") return "CAPTCHA_BLOCKED";
  if (state.page_state === "MODAL_BLOCKED") return "MODAL_BLOCKED";
  if (state.page_state === "ERROR_PAGE") return "ERROR_PAGE";
  return null;
}

function phaseForAction(action) {
  if (action === "ensure_market_ready") return "MARKET_READY";
  if (["reset_filters", "set_price_view", "apply_filter"].includes(action)) return "FILTERING";
  if (["search_keyword", "next_results_page"].includes(action)) return "RESULTS";
  if (["open_creator_detail", "activate_detail_section"].includes(action)) return "DETAIL_OPEN";
  if (action === "return_to_market") return "DETAIL_PENDING";
  return null;
}

function inspectCall(params) {
  return {
    tool: "ypscan_manual_browser_inspect",
    args: {
      requirement_id: params.requirement_id,
      platform: params.platform,
      run_id: params.run_id,
    },
    reason: "重新观察页面后再决定下一步",
  };
}

function cleanNextCall(nextCall) {
  if (!nextCall) return null;
  return {
    ...nextCall,
    args: Object.fromEntries(
      Object.entries(nextCall.args ?? {}).filter(([, value]) => value !== undefined),
    ),
  };
}

function nextPlannedCall(params, plan, branch, completedIds, afterStateId) {
  const actions = browserActionsForBranch(plan, branch);
  const next = actions.find((item) => !completedIds.has(item.plan_action_id));
  if (next) {
    return {
      tool: "ypscan_manual_browser_action",
      args: {
        requirement_id: params.requirement_id,
        platform: params.platform,
        run_id: params.run_id,
        branch_index: branch.branch_index,
        action: next.action,
        plan_action_id: next.plan_action_id,
        expected_state_id: afterStateId,
      },
      reason: `执行筛选计划动作 ${next.plan_action_id}`,
    };
  }
  return {
    tool: "ypscan_manual_select_filters",
    args: {
      operation: "commit",
      requirement_id: params.requirement_id,
      platform: params.platform,
      run_id: params.run_id,
      branch_index: branch.branch_index,
    },
    reason: "全部页面动作已验证，签发 selection_id",
  };
}

function enforceBudgets(actions, params) {
  const signature = actionSignature(params);
  const relevant = actions.filter((entry) => {
    if (params.candidate_ref) return entry.candidate_ref === params.candidate_ref;
    if (params.action === "next_results_page") {
      return entry.action === "next_results_page" && entry.branch_index === params.branch_index;
    }
    return PLAN_ACTIONS.has(entry.action) && entry.branch_index === params.branch_index;
  });
  const failedSame = relevant.filter(
    (entry) => entry.signature === signature && entry.ok !== true,
  ).length;
  if (failedSame >= 2) {
    throw manualBrowserError("NO_PROGRESS", "同一语义动作已失败两次，拒绝继续盲目重试", {
      signature,
      attempts: failedSame,
    });
  }
  const unchangedFailures = relevant
    .slice()
    .reverse()
    .findIndex((entry) => entry.ok === true || entry.changed === true);
  const unchangedCount = unchangedFailures === -1 ? relevant.length : unchangedFailures;
  if (unchangedCount >= 3) {
    throw manualBrowserError("NO_PROGRESS", "连续三次未验证动作没有改变页面状态");
  }
  const limit = params.candidate_ref ? 12 : params.action === "next_results_page" ? 25 : 30;
  if (relevant.length >= limit) {
    throw manualBrowserError("STEP_LIMIT", `当前交互阶段已达到 ${limit} 步上限`, { limit });
  }
}

async function waitForStates(page, platform, targetStates) {
  const deadline = Date.now() + 10_000;
  let state = await inspectManualBrowserPage(page, platform);
  while (Date.now() < deadline && !targetStates.includes(state.page_state)) {
    await page.waitForTimeout(200);
    state = await inspectManualBrowserPage(page, platform);
    if (BLOCKING_STATES.has(state.page_state)) break;
  }
  return state;
}

async function returnToMarket(browser, detailPage, platform) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const market = pages.find((page) => page !== detailPage && pageMatches(platform, page.url()));
  if (market) {
    await detailPage.close?.().catch(() => {});
    await market.bringToFront?.().catch(() => {});
    return { applied: true, page: market, mode: "close_detail_tab" };
  }
  await detailPage.goBack({ waitUntil: "domcontentloaded", timeout: 8_000 });
  return { applied: true, page: detailPage, mode: "history_back" };
}

function latestV3Selection(loaded) {
  return (loaded.selections ?? []).find(
    (selection) => selection.protocol_version === 3 && selection.status === "ready",
  );
}

function completedRequirementRefs(actions) {
  return new Set(
    (actions ?? [])
      .filter(
        (action) =>
          action.ok &&
          action.verified &&
          ["filter_requirement", "repair_filter"].includes(action.purpose) &&
          action.requirement_ref,
      )
      .map((action) => action.requirement_ref),
  );
}

function cleanPublicElement(element) {
  if (!element) return null;
  const { _locator_index: _index, _region_kind: _region, ...publicElement } = element;
  return publicElement;
}

function v3ActionParams(rawParams, platform) {
  const operation = clean(rawParams.operation);
  const purpose = clean(rawParams.purpose);
  const expectedEffect = clean(rawParams.expected_effect);
  if (!V3_OPERATIONS.includes(operation)) {
    throw manualBrowserError("YPSCAN_MANUAL_ARGUMENT_INVALID", "v3 operation 不受支持");
  }
  if (!V3_PURPOSES.has(purpose) || !V3_EFFECTS.has(expectedEffect)) {
    throw manualBrowserError(
      "YPSCAN_MANUAL_ARGUMENT_INVALID",
      "v3 动作必须提供有效 purpose 和 expected_effect",
    );
  }
  const elementIds = Array.isArray(rawParams.element_ids)
    ? rawParams.element_ids.map(clean).filter(Boolean)
    : [];
  const params = {
    requirement_id: clean(rawParams.requirement_id),
    platform,
    run_id: clean(rawParams.run_id),
    operation,
    action: `element:${operation}`,
    observation_id: clean(rawParams.observation_id),
    target_tab_id: clean(rawParams.target_tab_id) || null,
    element_id: clean(rawParams.element_id) || null,
    element_ids: elementIds,
    confirm_element_id: clean(rawParams.confirm_element_id) || null,
    value: rawParams.value ?? null,
    values: Array.isArray(rawParams.values) ? rawParams.values : [],
    range: rawParams.range && typeof rawParams.range === "object" ? rawParams.range : {},
    wait_ms: Math.min(10_000, Math.max(100, Number(rawParams.wait_ms) || 500)),
    purpose,
    expected_effect: expectedEffect,
    requirement_ref: clean(rawParams.requirement_ref) || null,
    branch_index: Number.isInteger(rawParams.branch_index) ? rawParams.branch_index : 0,
    candidate_ref: clean(rawParams.candidate_ref) || null,
    detail_group: clean(rawParams.detail_group) || null,
  };
  if (!params.observation_id) {
    throw manualBrowserError("YPSCAN_MANUAL_ARGUMENT_INVALID", "v3 动作必须引用 observation_id");
  }
  if (V3_ELEMENT_OPERATIONS.has(operation) && !params.element_id) {
    throw manualBrowserError("YPSCAN_MANUAL_ARGUMENT_INVALID", `${operation} 必须引用 element_id`);
  }
  if (operation === "set_range" && !params.element_ids.length) {
    throw manualBrowserError(
      "YPSCAN_MANUAL_ARGUMENT_INVALID",
      "set_range 必须引用输入框 element_ids",
    );
  }
  if (operation === "activate_tab" && !params.target_tab_id) {
    throw manualBrowserError(
      "YPSCAN_MANUAL_ARGUMENT_INVALID",
      "activate_tab 必须引用 target_tab_id",
    );
  }
  if (purpose === "detail" && !params.candidate_ref) {
    throw manualBrowserError("YPSCAN_MANUAL_ARGUMENT_INVALID", "详情动作必须引用 candidate_ref");
  }
  return params;
}

function v3EffectVerified(params, beforeState, afterState, receipt) {
  if (params.operation === "wait") return true;
  if (params.operation === "navigate_market") {
    return ["creator_market", "platform_other"].includes(afterState.page_kind);
  }
  if (params.operation === "activate_tab") return true;
  if (params.operation === "return_to_market") return afterState.page_kind === "creator_market";
  if (["fill", "fill_submit"].includes(params.operation)) {
    const filled = clean(receipt.readback) === clean(params.value);
    return params.operation === "fill_submit"
      ? filled && clean(afterState.market?.keyword) === clean(params.value)
      : filled;
  }
  if (params.operation === "set_range") return receipt.inputs_verified === true;
  if (params.expected_effect === "dialog_closed") return !afterState.modal.present;
  if (params.expected_effect === "navigation") {
    return beforeState.url !== afterState.url || beforeState.page_kind !== afterState.page_kind;
  }
  if (params.expected_effect === "results_refreshed") {
    return (
      beforeState.market?.page_number !== afterState.market?.page_number ||
      beforeState.state_id !== afterState.state_id
    );
  }
  if (params.expected_effect === "value_selected") {
    return (
      beforeState.selected_filter_fingerprint !== afterState.selected_filter_fingerprint ||
      receipt.target_after?.selected === true ||
      receipt.target_after?.selected === "true" ||
      receipt.target_after?.checked === true ||
      receipt.target_after?.checked === "true" ||
      receipt.target_after?.active === true
    );
  }
  if (params.expected_effect === "menu_opened") {
    return (
      afterState.elements.length > beforeState.elements.length ||
      receipt.target_after?.expanded === "true"
    );
  }
  return beforeState.state_id !== afterState.state_id;
}

async function executeV3BrowserAction({
  rawParams,
  loaded,
  workspaceDir,
  cdpUrl,
  connectOverCDP,
  createArtifactStore,
  inspectBrowser,
  inspectPage,
  resolveElement,
  now,
}) {
  let params;
  let store;
  let beforeState = null;
  let afterState = null;
  try {
    const platform = normalizePlatform(rawParams.platform);
    params = v3ActionParams(rawParams, platform);
    const observation = (loaded.browser_states ?? []).find(
      (state) => state.observation_id === params.observation_id,
    );
    if (!observation) {
      throw manualBrowserError("OBSERVATION_NOT_FOUND", "找不到指定 observation_id，请重新观察");
    }
    const branch = loaded.plan.branches[params.branch_index];
    if (!branch) throw manualBrowserError("YPSCAN_MANUAL_BRANCH_INVALID", "关键词分支不存在");
    const requirements = browserRequirementsForPlan(loaded.plan);
    const requirementRefs = new Set(requirements.map((item) => item.requirement_ref));
    const baseSelection = latestV3Selection(loaded);
    if (params.requirement_ref && !requirementRefs.has(params.requirement_ref)) {
      throw manualBrowserError(
        "YPSCAN_MANUAL_ACTION_NOT_ALLOWED",
        "requirement_ref 不属于当前需求",
      );
    }
    if (params.purpose === "filter_requirement" && (!params.requirement_ref || baseSelection)) {
      throw manualBrowserError(
        "YPSCAN_MANUAL_ACTION_NOT_ALLOWED",
        baseSelection ? "后续关键词不得重新执行全量硬筛" : "硬筛动作必须绑定 requirement_ref",
      );
    }
    if (params.purpose === "repair_filter" && !baseSelection) {
      throw manualBrowserError("YPSCAN_MANUAL_ACTION_NOT_ALLOWED", "首分支不使用 repair_filter");
    }
    if (
      ["filter_requirement", "repair_filter"].includes(params.purpose) &&
      !["value_selected", "value_filled"].includes(params.expected_effect)
    ) {
      throw manualBrowserError(
        "YPSCAN_MANUAL_ACTION_NOT_ALLOWED",
        "硬筛完成动作必须声明可回读的 value_selected 或 value_filled 后置条件",
      );
    }
    if (params.purpose === "reset_filters" && baseSelection) {
      throw manualBrowserError("YPSCAN_MANUAL_ACTION_NOT_ALLOWED", "后续关键词禁止清空筛选条件");
    }
    if (params.purpose === "keyword_search") {
      if (params.operation !== "fill_submit") {
        throw manualBrowserError("YPSCAN_MANUAL_ACTION_NOT_ALLOWED", "关键词必须使用 fill_submit");
      }
      if (!baseSelection) {
        const completed = completedRequirementRefs(loaded.browser_actions);
        const missing = requirements
          .map((item) => item.requirement_ref)
          .filter((reference) => !completed.has(reference));
        const baselineReady = (loaded.browser_states ?? []).some(
          (state) =>
            state.page_kind === "creator_market" &&
            !clean(state.market?.keyword) &&
            (state.selected_filters ?? []).length === 0,
        );
        if (!baselineReady || missing.length) {
          throw manualBrowserError(
            "YPSCAN_MANUAL_KEYWORD_TOO_EARLY",
            "关键词必须在干净基线和全部页面硬筛完成后提交",
            { baseline_ready: baselineReady, missing_requirement_refs: missing },
          );
        }
      }
    }
    store = await createArtifactStore({
      workspaceDir,
      params: { ...loaded.params, run_id: params.run_id },
      plan: loaded.plan,
      now,
    });
    const signature = actionSignature(params);
    const failedSame = (loaded.browser_actions ?? []).filter(
      (action) => action.signature === signature && action.ok !== true,
    ).length;
    if (failedSame >= 2) {
      throw manualBrowserError("NO_PROGRESS", "同一元素语义动作已失败两次");
    }
    const browser = await connectOverCDP(cdpUrl);
    const observed = await inspectBrowser(browser, platform, { tabId: observation.tab_id });
    beforeState = observed.state;
    if (!observed.page || beforeState.page_context_id !== observation.page_context_id) {
      throw manualBrowserError("PAGE_CHANGED", "页面整体上下文已变化，请重新观察", {
        observation_page_context_id: observation.page_context_id,
        current_page_context_id: beforeState.page_context_id,
      });
    }
    if (["LOGIN_REQUIRED", "CAPTCHA_BLOCKED"].includes(beforeState.page_state)) {
      throw manualBrowserError(failureFromState(beforeState), "当前页面需要用户接管");
    }
    if (beforeState.page_state === "MODAL_BLOCKED") {
      if (params.purpose !== "modal") {
        throw manualBrowserError("MODAL_BLOCKED", "当前页面存在阻塞弹窗，请先处理弹窗", {
          state: beforeState,
        });
      }
      if (!beforeState.modal.dismissible) {
        throw manualBrowserError("MODAL_BLOCKED", "当前弹窗未被识别为可安全关闭", {
          state: beforeState,
        });
      }
    }
    let actionPage = observed.page;
    let target = null;
    let targetLocator = null;
    if (params.element_id) {
      const descriptor = observation.elements?.find(
        (element) => element.element_id === params.element_id,
      );
      const resolved = await resolveElement(actionPage, descriptor);
      target = resolved.element;
      targetLocator = resolved.locator;
      if (!targetLocator || !target?.enabled) {
        throw manualBrowserError("TARGET_NOT_FOUND", "目标元素已消失、变化或不可用", {
          element_id: params.element_id,
        });
      }
    }
    const receipt = {
      applied: false,
      purpose: params.purpose,
      expected_effect: params.expected_effect,
      requirement_ref: params.requirement_ref,
      target_before: cleanPublicElement(target),
    };
    if (params.operation === "activate_tab") {
      const targetTab = await inspectBrowser(browser, platform, { tabId: params.target_tab_id });
      if (!targetTab.page) {
        throw manualBrowserError("TARGET_NOT_FOUND", "目标标签页已不存在");
      }
      actionPage = targetTab.page;
      await actionPage.bringToFront?.();
      receipt.applied = true;
    } else if (params.operation === "navigate_market") {
      await actionPage.goto(PLATFORM_RULES[platform].url, {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });
      receipt.applied = true;
    } else if (params.operation === "wait") {
      await actionPage.waitForTimeout(params.wait_ms);
      receipt.applied = true;
    } else if (params.operation === "return_to_market") {
      const returned = await returnToMarket(browser, actionPage, platform);
      actionPage = returned.page;
      Object.assign(receipt, returned, { page: undefined });
    } else if (params.operation === "hover") {
      await targetLocator.hover({ timeout: 3_000 });
      receipt.applied = true;
    } else if (params.operation === "fill" || params.operation === "fill_submit") {
      await targetLocator.fill(String(params.value ?? ""), { timeout: 3_000 });
      receipt.readback = await targetLocator.inputValue().catch(() => "");
      if (params.operation === "fill_submit") await targetLocator.press("Enter");
      receipt.applied = true;
    } else if (params.operation === "select") {
      if (target.tag === "select") {
        await targetLocator.selectOption(params.values.map(String));
      } else {
        await targetLocator.click({ timeout: 3_000 });
      }
      receipt.applied = true;
    } else if (["click", "confirm"].includes(params.operation)) {
      if (params.purpose === "detail" && params.candidate_ref) {
        const candidate = loaded.candidates.find(
          (item) => candidateReference(item) === params.candidate_ref,
        );
        if (!candidate) {
          throw manualBrowserError("TARGET_NOT_FOUND", "run 中不存在指定 candidate_ref");
        }
        const captured = await captureDetailResponsesDuring(actionPage, {
          platform,
          candidate,
          expectedGroups: params.detail_group
            ? [params.detail_group]
            : detailGroupsForPlan(loaded.plan),
          action: () => targetLocator.click({ timeout: 3_000 }),
        });
        receipt.capture = captured.capture;
      } else {
        await targetLocator.click({ timeout: 3_000 });
      }
      receipt.applied = true;
    } else if (params.operation === "set_range") {
      const descriptors = params.element_ids.map((elementId) =>
        observation.elements?.find((element) => element.element_id === elementId),
      );
      const resolvedInputs = [];
      for (const descriptor of descriptors) {
        const resolved = await resolveElement(actionPage, descriptor);
        if (!resolved.locator) {
          throw manualBrowserError("TARGET_NOT_FOUND", "范围输入框已变化，请重新观察");
        }
        resolvedInputs.push(resolved.locator);
      }
      const requested = [params.range.min, params.range.max].slice(0, resolvedInputs.length);
      for (const [index, locator] of resolvedInputs.entries()) {
        await locator.fill(
          requested[index] === null || requested[index] === undefined
            ? ""
            : String(requested[index]),
        );
      }
      const readbacks = await Promise.all(
        resolvedInputs.map((locator) => locator.inputValue().catch(() => "")),
      );
      receipt.inputs_verified = readbacks.every(
        (value, index) => clean(value) === clean(requested[index]),
      );
      receipt.readbacks = readbacks;
      if (params.confirm_element_id) {
        const confirmDescriptor = observation.elements?.find(
          (element) => element.element_id === params.confirm_element_id,
        );
        const confirm = await resolveElement(actionPage, confirmDescriptor);
        if (!confirm.locator) {
          throw manualBrowserError("TARGET_NOT_FOUND", "确认按钮已变化，请重新观察");
        }
        await confirm.locator.click({ timeout: 3_000 });
      }
      receipt.applied = receipt.inputs_verified;
    }
    await actionPage.waitForTimeout?.(200).catch(() => {});
    if (params.purpose === "detail" || params.expected_effect === "navigation") {
      const observedAfter = await inspectBrowser(browser, platform);
      if (observedAfter.page) actionPage = observedAfter.page;
      afterState = observedAfter.state;
    } else {
      afterState = await inspectPage(actionPage, platform);
    }
    afterState.tab_id =
      params.operation === "activate_tab"
        ? params.target_tab_id
        : (afterState.tab_id ?? observation.tab_id);
    const resolvedAfter = params.element_id
      ? await resolveElement(actionPage, { element_id: params.element_id })
      : null;
    receipt.target_after = cleanPublicElement(resolvedAfter?.element);
    receipt.after_selected_filter_fingerprint = afterState.selected_filter_fingerprint;
    receipt.after_selected_filters = afterState.selected_filters;
    if (["LOGIN_REQUIRED", "CAPTCHA_BLOCKED"].includes(afterState.page_state)) {
      throw manualBrowserError(failureFromState(afterState), "动作后页面需要用户接管", {
        after_state: afterState,
      });
    }
    if (params.purpose === "detail" && params.candidate_ref && afterState.detail?.candidate_id) {
      const candidate = loaded.candidates.find(
        (item) => candidateReference(item) === params.candidate_ref,
      );
      if (
        candidate?.platform_id &&
        clean(candidate.platform_id) !== clean(afterState.detail.candidate_id)
      ) {
        throw manualBrowserError("IDENTITY_MISMATCH", "打开的详情页与候选身份不一致", {
          requested: candidate.platform_id,
          actual: afterState.detail.candidate_id,
        });
      }
    }
    const verified = receipt.applied && v3EffectVerified(params, beforeState, afterState, receipt);
    if (!verified) {
      throw manualBrowserError("POSTCONDITION_FAILED", "元素动作未满足局部后置条件", {
        receipt,
        after_state: afterState,
      });
    }
    const actionId = randomUUID();
    const actionRecord = {
      action_id: actionId,
      signature,
      protocol_version: 3,
      action: params.action,
      operation: params.operation,
      purpose: params.purpose,
      expected_effect: params.expected_effect,
      observation_id: params.observation_id,
      element_id: params.element_id,
      element_ids: params.element_ids,
      requirement_ref: params.requirement_ref,
      branch_index: params.branch_index,
      candidate_ref: params.candidate_ref,
      detail_group: params.detail_group,
      ok: true,
      changed: beforeState.state_id !== afterState.state_id,
      verified: true,
      before_state_id: beforeState.state_id,
      after_state_id: afterState.state_id,
      receipt,
    };
    await store.saveBrowserState({ source: "before_action", action_id: actionId, ...beforeState });
    await store.saveBrowserAction(actionRecord);
    await store.saveBrowserState({ source: "after_action", action_id: actionId, ...afterState });
    const payload = {
      success: true,
      status: "completed",
      operation: "browser_action",
      protocol_version: 3,
      ok: true,
      action: params.operation,
      action_id: actionId,
      changed: actionRecord.changed,
      verified: true,
      retryable: false,
      receipt,
      next_call: inspectCall(params),
    };
    return hostToolResult(payload, { details: payload });
  } catch (error) {
    const code = safeErrorCode(error);
    if (store && params) {
      await store
        .saveBrowserAction({
          action_id: randomUUID(),
          signature: actionSignature(params),
          protocol_version: 3,
          action: params.action,
          operation: params.operation,
          purpose: params.purpose,
          observation_id: params.observation_id,
          element_id: params.element_id,
          requirement_ref: params.requirement_ref,
          branch_index: params.branch_index,
          candidate_ref: params.candidate_ref,
          detail_group: params.detail_group,
          ok: false,
          changed: Boolean(
            beforeState && afterState && beforeState.state_id !== afterState.state_id,
          ),
          verified: false,
          before_state_id: beforeState?.state_id ?? null,
          after_state_id: afterState?.state_id ?? error?.details?.after_state?.state_id ?? null,
          error: { code, message: error?.message ?? String(error) },
        })
        .catch(() => {});
    }
    const humanBlocked = ["LOGIN_REQUIRED", "CAPTCHA_BLOCKED"].includes(code);
    const payload = {
      success: false,
      status: humanBlocked ? "needs_user_action" : "failed",
      operation: "browser_action",
      protocol_version: 3,
      ok: false,
      action: params?.operation ?? clean(rawParams.operation) ?? null,
      changed: Boolean(beforeState && afterState && beforeState.state_id !== afterState.state_id),
      verified: false,
      retryable: !humanBlocked && !["NO_PROGRESS", "PAGE_CHANGED"].includes(code),
      next_call: params ? inspectCall(params) : null,
      error: { code, message: error?.message ?? String(error), evidence: error?.details ?? {} },
    };
    return hostToolResult(payload, { details: payload, isError: true });
  }
}

/**
 * @param {{
 *   browserCdpUrl?: string,
 *   workspaceDir?: string,
 *   connectOverCDP?: (endpointURL: string) => Promise<import("playwright-core").Browser>,
 *   createAdapter?: typeof createManualResearchAdapter,
 *   loadRun?: typeof loadManualResearchRun,
 *   createArtifactStore?: typeof createManualResearchStore,
 *   inspectBrowser?: typeof inspectManualBrowser,
 *   inspectPage?: typeof inspectManualBrowserPage,
 *   resolveElement?: typeof resolveInteractiveElement,
 *   resolvePage?: typeof resolveManualResearchPage,
 *   now?: () => number,
 * }} [options]
 */
export function createManualBrowserAction({
  browserCdpUrl = DEFAULT_CDP_URL,
  workspaceDir,
  connectOverCDP = (endpointURL) => chromium.connectOverCDP(endpointURL),
  createAdapter = createManualResearchAdapter,
  loadRun = loadManualResearchRun,
  createArtifactStore = createManualResearchStore,
  inspectBrowser = inspectManualBrowser,
  inspectPage = inspectManualBrowserPage,
  resolveElement = resolveInteractiveElement,
  resolvePage = resolveManualResearchPage,
  now = Date.now,
} = {}) {
  const cdpUrl = clean(browserCdpUrl).replace(/\/$/u, "");
  return async function manualBrowserAction(rawParams = {}) {
    if (rawParams.operation) {
      try {
        const requirementId = clean(rawParams.requirement_id);
        const platform = normalizePlatform(rawParams.platform);
        const runId = clean(rawParams.run_id);
        if (!requirementId || !runId) {
          throw manualBrowserError(
            "YPSCAN_MANUAL_ARGUMENT_INVALID",
            "requirement_id 和 run_id 不能为空",
          );
        }
        const loaded = await loadRun({
          workspaceDir,
          runId,
          requirementId,
          platform,
        });
        if (loaded.plan.protocol_version !== 3) {
          throw manualBrowserError(
            "YPSCAN_MANUAL_PROTOCOL_MISMATCH",
            "element-ID operation 只适用于 v3 运行",
          );
        }
        return executeV3BrowserAction({
          rawParams,
          loaded,
          workspaceDir,
          cdpUrl,
          connectOverCDP,
          createArtifactStore,
          inspectBrowser,
          inspectPage,
          resolveElement,
          now,
        });
      } catch (error) {
        const payload = {
          success: false,
          status: "failed",
          operation: "browser_action",
          protocol_version: 3,
          error: {
            code: safeErrorCode(error),
            message: error?.message ?? String(error),
          },
        };
        return hostToolResult(payload, { details: payload, isError: true });
      }
    }
    let params;
    let store;
    let beforeState = null;
    let afterState = null;
    try {
      params = {
        requirement_id: clean(rawParams.requirement_id),
        platform: normalizePlatform(rawParams.platform),
        run_id: clean(rawParams.run_id),
        action: clean(rawParams.action),
        expected_state_id: clean(rawParams.expected_state_id),
        branch_index: Number.isInteger(rawParams.branch_index) ? rawParams.branch_index : null,
        plan_action_id: clean(rawParams.plan_action_id) || null,
        modal_id: clean(rawParams.modal_id) || null,
        candidate_ref: clean(rawParams.candidate_ref) || null,
        detail_group: clean(rawParams.detail_group) || null,
        target_states: Array.isArray(rawParams.target_states)
          ? rawParams.target_states.map(clean).filter(Boolean)
          : [],
      };
      if (!params.requirement_id || !params.run_id || !ACTIONS.includes(params.action)) {
        throw manualBrowserError(
          "YPSCAN_MANUAL_ARGUMENT_INVALID",
          "动作参数不完整或 action 不受支持",
        );
      }
      const loaded = await loadRun({
        workspaceDir,
        runId: params.run_id,
        requirementId: params.requirement_id,
        platform: params.platform,
      });
      const branch =
        params.branch_index === null ? null : loaded.plan.branches[params.branch_index];
      let planned = null;
      if (PLAN_ACTIONS.has(params.action)) {
        if (!branch || !params.plan_action_id) {
          throw manualBrowserError(
            "YPSCAN_MANUAL_ARGUMENT_INVALID",
            "筛选动作必须引用当前分支的 plan_action_id",
          );
        }
        planned = findPlannedBrowserAction(loaded.plan, params.branch_index, params.plan_action_id);
        if (!planned || planned.action !== params.action) {
          throw manualBrowserError("YPSCAN_MANUAL_ACTION_NOT_ALLOWED", "动作不属于当前筛选计划");
        }
        const latestById = new Map();
        for (const action of loaded.browser_actions ?? []) {
          if (action.branch_index === params.branch_index && action.plan_action_id) {
            latestById.set(action.plan_action_id, action);
          }
        }
        const expectedNext = browserActionsForBranch(loaded.plan, branch).find((action) => {
          const completed = latestById.get(action.plan_action_id);
          return !completed?.ok || !completed?.verified;
        });
        if (expectedNext?.plan_action_id !== planned.plan_action_id) {
          throw manualBrowserError(
            "YPSCAN_MANUAL_ACTION_NOT_ALLOWED",
            "必须按筛选计划顺序执行下一条未完成动作",
            { expected_plan_action_id: expectedNext?.plan_action_id ?? null },
          );
        }
      }
      enforceBudgets(loaded.browser_actions ?? [], params);
      store = await createArtifactStore({
        workspaceDir,
        params: { ...loaded.params, run_id: params.run_id },
        plan: loaded.plan,
        now,
      });
      const browser = await connectOverCDP(cdpUrl);
      const observed = await inspectBrowser(browser, params.platform, {
        expectedStateId: params.expected_state_id,
      });
      beforeState = observed.state;
      if (!observed.page || beforeState.state_id !== params.expected_state_id) {
        throw manualBrowserError("PAGE_CHANGED", "页面状态已经变化，动作未执行", {
          expected_state_id: params.expected_state_id,
          current_tabs: beforeState.tabs,
        });
      }
      if (["LOGIN_REQUIRED", "CAPTCHA_BLOCKED"].includes(beforeState.page_state)) {
        throw manualBrowserError(failureFromState(beforeState), "当前页面需要用户接管", {
          state: beforeState,
        });
      }
      if (
        beforeState.page_state === "MODAL_BLOCKED" &&
        !["ensure_market_ready", "dismiss_modal"].includes(params.action)
      ) {
        throw manualBrowserError(failureFromState(beforeState), "当前页面存在阻塞状态", {
          state: beforeState,
        });
      }

      let actionPage = observed.page;
      let receipt = {};
      if (params.action === "ensure_market_ready") {
        actionPage = await resolvePage(browser, params.platform);
        const adapter = createAdapter(params.platform, actionPage, { workspaceDir, now });
        await adapter.prepare();
        await adapter.dispose?.().catch(() => {});
        receipt = { applied: true, target_url: PLATFORM_RULES[params.platform].url };
      } else if (params.action === "dismiss_modal") {
        if (!beforeState.modal.present || !beforeState.modal.dismissible) {
          throw manualBrowserError("MODAL_BLOCKED", "当前弹窗不在安全关闭白名单", {
            modal: beforeState.modal,
          });
        }
        if (params.modal_id && params.modal_id !== beforeState.modal.modal_id) {
          throw manualBrowserError("PAGE_CHANGED", "目标弹窗已经变化，未执行关闭");
        }
        const dismissed = await dismissOrdinaryPopups(actionPage, params.platform);
        receipt = { applied: dismissed.length > 0, dismissed };
      } else if (params.action === "wait_for_ready") {
        const targetStates = params.target_states.length
          ? params.target_states
          : ["MARKET_READY", "RESULTS_READY", "CREATOR_DETAIL_READY"];
        afterState = await waitForStates(actionPage, params.platform, targetStates);
        receipt = {
          applied: targetStates.includes(afterState.page_state),
          target_states: targetStates,
        };
      } else if (params.action === "return_to_market") {
        receipt = await returnToMarket(browser, actionPage, params.platform);
        actionPage = receipt.page;
      } else {
        const adapter = createAdapter(params.platform, actionPage, { workspaceDir, now });
        if (
          params.action !== "open_creator_detail" &&
          params.action !== "activate_detail_section"
        ) {
          await adapter.prepare();
        }
        if (params.action === "reset_filters") {
          await adapter.reset();
          receipt = (await adapter.verifyBaseline?.()) ?? { valid: true };
          receipt.applied = receipt.valid !== false;
        } else if (params.action === "set_price_view") {
          receipt = await adapter.setPriceView(planned.price_view);
        } else if (params.action === "apply_filter") {
          receipt = await adapter.applyFilter(planned.filter);
        } else if (params.action === "search_keyword") {
          receipt = await adapter.search(planned.keyword);
          const listSnapshot = adapter.listSnapshot?.();
          if (listSnapshot) receipt.list_snapshot = listSnapshot;
        } else if (params.action === "next_results_page") {
          receipt = await adapter.nextPage();
          if (typeof receipt === "boolean") receipt = { advanced: receipt };
          receipt.applied = receipt.advanced === true;
        } else if (params.action === "open_creator_detail") {
          const candidate = loaded.candidates.find(
            (item) => candidateReference(item) === params.candidate_ref,
          );
          if (!candidate) {
            throw manualBrowserError("TARGET_NOT_FOUND", "run 中不存在指定 candidate_ref");
          }
          const opened = await openCreatorDetailPage(actionPage, params.platform, candidate, {
            groups: detailGroupsForPlan(loaded.plan),
          });
          if (!opened.opened) {
            throw manualBrowserError("TARGET_NOT_FOUND", "无法打开指定达人详情", {
              candidate_ref: params.candidate_ref,
            });
          }
          actionPage = opened.detailPage;
          receipt = {
            applied: true,
            candidate_ref: params.candidate_ref,
            temporary: opened.temporary,
            capture: opened.capture ?? null,
          };
        } else if (params.action === "activate_detail_section") {
          const candidate = loaded.candidates.find(
            (item) => candidateReference(item) === params.candidate_ref,
          );
          if (!candidate || !params.detail_group) {
            throw manualBrowserError(
              "YPSCAN_MANUAL_ARGUMENT_INVALID",
              "详情区块动作需要有效 candidate_ref 和 detail_group",
            );
          }
          receipt = await activateCreatorDetailSection(
            actionPage,
            params.platform,
            candidate,
            params.detail_group,
          );
        }
        await adapter.dispose?.().catch(() => {});
      }
      afterState ??= await inspectPage(actionPage, params.platform);
      const blockingCode = failureFromState(afterState);
      const changed = beforeState.state_id !== afterState.state_id;
      const receiptApplied =
        receipt.applied === true || receipt.valid === true || receipt.advanced === true;
      const stateVerified = (() => {
        if (params.action === "ensure_market_ready") {
          return ["MARKET_READY", "RESULTS_READY"].includes(afterState.page_state);
        }
        if (params.action === "dismiss_modal") return !afterState.modal.present;
        if (params.action === "wait_for_ready") return receipt.applied === true;
        if (params.action === "open_creator_detail") {
          const candidate = loaded.candidates.find(
            (item) => candidateReference(item) === params.candidate_ref,
          );
          const identityMatches =
            !candidate?.platform_id ||
            !afterState.detail?.candidate_id ||
            clean(candidate.platform_id) === clean(afterState.detail.candidate_id);
          if (!identityMatches) {
            throw manualBrowserError("IDENTITY_MISMATCH", "打开的详情页与候选身份不一致", {
              requested: candidate?.platform_id ?? null,
              actual: afterState.detail?.candidate_id ?? null,
            });
          }
          return afterState.page_state === "CREATOR_DETAIL_READY";
        }
        if (params.action === "activate_detail_section") return receipt.verified === true;
        if (params.action === "return_to_market") {
          return ["MARKET_READY", "RESULTS_READY"].includes(afterState.page_state);
        }
        return receiptApplied && !blockingCode;
      })();
      if (!stateVerified) {
        throw manualBrowserError(
          blockingCode ?? "POSTCONDITION_FAILED",
          blockingCode ? "动作后页面进入阻塞状态" : "动作执行后未满足预期页面条件",
          { receipt, after_state: afterState },
        );
      }
      const actionId = randomUUID();
      const actionRecord = {
        action_id: actionId,
        signature: actionSignature(params),
        action: params.action,
        plan_action_id: params.plan_action_id,
        branch_index: params.branch_index,
        candidate_ref: params.candidate_ref,
        detail_group: params.detail_group,
        ok: true,
        changed,
        verified: true,
        before_state_id: beforeState.state_id,
        after_state_id: afterState.state_id,
        receipt,
      };
      await store.saveBrowserState({
        source: "before_action",
        action_id: actionId,
        ...beforeState,
      });
      await store.saveBrowserAction(actionRecord);
      await store.saveBrowserState({ source: "after_action", action_id: actionId, ...afterState });
      const phase = phaseForAction(params.action);
      if (phase) {
        await store.savePhaseTransition({
          phase,
          action_id: actionId,
          branch_index: params.branch_index,
          candidate_ref: params.candidate_ref,
        });
      }
      const completedIds = new Set(
        [...(loaded.browser_actions ?? []), actionRecord]
          .filter((entry) => entry.ok && entry.branch_index === params.branch_index)
          .map((entry) => entry.plan_action_id)
          .filter(Boolean),
      );
      const nextCall = planned
        ? nextPlannedCall(params, loaded.plan, branch, completedIds, afterState.state_id)
        : [
              "next_results_page",
              "open_creator_detail",
              "activate_detail_section",
              "return_to_market",
            ].includes(params.action)
          ? {
              tool: "ypscan_manual_research",
              args: {
                operation: "collect",
                requirement_id: params.requirement_id,
                platform: params.platform,
                run_id: params.run_id,
              },
              reason: "读取并持久化当前页面证据",
            }
          : inspectCall(params);
      const payload = {
        success: true,
        status: "completed",
        operation: "browser_action",
        ok: true,
        action: params.action,
        action_id: actionId,
        before_state: beforeState,
        after_state: afterState,
        changed,
        verified: true,
        retryable: false,
        receipt,
        next_call: cleanNextCall(nextCall),
      };
      return hostToolResult(payload, { details: payload });
    } catch (error) {
      const code = safeErrorCode(error);
      const changed = Boolean(
        beforeState && afterState && beforeState.state_id !== afterState.state_id,
      );
      const blocked = ["LOGIN_REQUIRED", "CAPTCHA_BLOCKED", "MODAL_BLOCKED"].includes(code);
      if (store && params) {
        const failureRecord = {
          action_id: randomUUID(),
          signature: actionSignature(params),
          action: params.action,
          plan_action_id: params.plan_action_id,
          branch_index: params.branch_index,
          candidate_ref: params.candidate_ref,
          detail_group: params.detail_group,
          ok: false,
          changed,
          verified: false,
          before_state_id: beforeState?.state_id ?? null,
          after_state_id: afterState?.state_id ?? error?.details?.after_state?.state_id ?? null,
          error: { code, message: error?.message ?? String(error) },
        };
        await store.saveBrowserAction(failureRecord).catch(() => {});
      }
      const resumeCall = params
        ? {
            tool: "ypscan_manual_browser_inspect",
            args: {
              requirement_id: params.requirement_id,
              platform: params.platform,
              run_id: params.run_id,
            },
            reason: blocked ? "用户处理阻塞后重新观察同一页面" : "重新观察页面再决定是否重试",
          }
        : null;
      const payload = {
        success: false,
        status: blocked ? "needs_user_action" : "failed",
        operation: "browser_action",
        ok: false,
        action: params?.action ?? (clean(rawParams.action) || null),
        before_state: beforeState,
        after_state: afterState ?? error?.details?.after_state ?? beforeState,
        changed,
        verified: false,
        retryable: !blocked && !["NO_PROGRESS", "STEP_LIMIT", "PAGE_CHANGED"].includes(code),
        next_call: cleanNextCall(resumeCall),
        error: {
          code,
          message: error?.message ?? String(error),
          evidence: error?.details ?? {},
        },
      };
      return hostToolResult(payload, { details: payload, isError: true });
    }
  };
}

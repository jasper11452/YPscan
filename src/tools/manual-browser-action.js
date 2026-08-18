import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { createManualResearchStore, loadManualResearchRun } from "./manual-research-artifact.js";
import { browserActionsForBranch, findPlannedBrowserAction } from "./manual-browser-plan.js";
import { inspectManualBrowser, inspectManualBrowserPage } from "./manual-browser-state.js";
import { candidateReference, detailGroupsForPlan } from "./manual-research-detail.js";
import { createManualResearchAdapter, resolveManualResearchPage } from "./manual-research.js";
import {
  activateCreatorDetailSection,
  openCreatorDetailPage,
} from "./manual-research/detail-page.js";
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

export const MANUAL_BROWSER_ACTION_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["requirement_id", "platform", "run_id", "action", "expected_state_id"],
  properties: {
    requirement_id: { type: "string", minLength: 1 },
    platform: {
      type: "string",
      enum: ["xingtu", "douyin", "pgy", "xiaohongshu"],
    },
    run_id: { type: "string", minLength: 1 },
    action: { type: "string", enum: ACTIONS },
    expected_state_id: { type: "string", minLength: 1 },
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
  resolvePage = resolveManualResearchPage,
  now = Date.now,
} = {}) {
  const cdpUrl = clean(browserCdpUrl).replace(/\/$/u, "");
  return async function manualBrowserAction(rawParams = {}) {
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

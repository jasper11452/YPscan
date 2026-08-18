import { chromium } from "playwright-core";
import { browserActionsForBranch } from "./manual-browser-plan.js";
import { inspectManualBrowser, MANUAL_BROWSER_PAGE_STATES } from "./manual-browser-state.js";
import { createManualResearchStore, loadManualResearchRun } from "./manual-research-artifact.js";
import { hostToolResult } from "./tool-result.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:18800";

export const MANUAL_BROWSER_INSPECT_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["platform"],
  properties: {
    platform: {
      type: "string",
      enum: ["xingtu", "douyin", "pgy", "xiaohongshu"],
    },
    requirement_id: { type: "string", minLength: 1 },
    run_id: { type: "string", minLength: 1 },
    expected_state_id: { type: "string", minLength: 1 },
  },
});

function platformName(value) {
  const platform = String(value ?? "")
    .trim()
    .toLowerCase();
  if (platform === "douyin") return "xingtu";
  if (platform === "xiaohongshu") return "pgy";
  if (platform === "xingtu" || platform === "pgy") return platform;
  throw Object.assign(new Error(`不支持平台：${platform || "空"}`), {
    code: "YPSCAN_MANUAL_ARGUMENT_INVALID",
  });
}

/**
 * @param {{
 *   browserCdpUrl?: string,
 *   workspaceDir?: string,
 *   connectOverCDP?: (endpointURL: string) => Promise<import("playwright-core").Browser>,
 *   loadRun?: typeof loadManualResearchRun,
 *   createArtifactStore?: typeof createManualResearchStore,
 *   inspectBrowser?: typeof inspectManualBrowser,
 * }} [options]
 */
export function createManualBrowserInspector({
  browserCdpUrl = DEFAULT_CDP_URL,
  workspaceDir,
  connectOverCDP = (endpointURL) => chromium.connectOverCDP(endpointURL),
  loadRun = loadManualResearchRun,
  createArtifactStore = createManualResearchStore,
  inspectBrowser = inspectManualBrowser,
} = {}) {
  const cdpUrl = String(browserCdpUrl ?? "")
    .trim()
    .replace(/\/$/u, "");
  return async function manualBrowserInspect(rawParams = {}) {
    try {
      const platform = platformName(rawParams.platform);
      const browser = await connectOverCDP(cdpUrl);
      const { state } = await inspectBrowser(browser, platform, {
        expectedStateId:
          typeof rawParams.expected_state_id === "string"
            ? rawParams.expected_state_id.trim()
            : null,
      });
      const requirementId =
        typeof rawParams.requirement_id === "string" ? rawParams.requirement_id.trim() : "";
      const runId = typeof rawParams.run_id === "string" ? rawParams.run_id.trim() : "";
      let nextCall = null;
      if (runId && requirementId) {
        const loaded = await loadRun({
          workspaceDir,
          runId,
          requirementId,
          platform,
        });
        const store = await createArtifactStore({
          workspaceDir,
          params: { ...loaded.params, run_id: runId },
          plan: loaded.plan,
        });
        await store.saveBrowserState({ source: "observer", ...state });
        if (loaded.plan.protocol_version === 3) {
          const payload = {
            success: true,
            status: "observed",
            operation: "inspect",
            protocol_version: 3,
            platform,
            requirement_id: requirementId,
            run_id: runId,
            state,
            known_page_states: MANUAL_BROWSER_PAGE_STATES,
            next_call: null,
          };
          return hostToolResult(payload, { details: payload });
        }
        const latestTransition = loaded.phase_transitions?.at(-1) ?? null;
        const branchIndex = Number.isInteger(latestTransition?.branch_index)
          ? latestTransition.branch_index
          : 0;
        const branch = loaded.plan.branches[branchIndex];
        const planned = branch ? browserActionsForBranch(loaded.plan, branch) : [];
        const latestById = new Map();
        for (const action of loaded.browser_actions ?? []) {
          if (action.branch_index === branchIndex && action.plan_action_id) {
            latestById.set(action.plan_action_id, action);
          }
        }
        const nextPlanned = planned.find((action) => {
          const completed = latestById.get(action.plan_action_id);
          return !completed?.ok || !completed?.verified;
        });
        const actionArgs = (action, extra = {}) => ({
          requirement_id: requirementId,
          platform,
          run_id: runId,
          branch_index: branchIndex,
          action: action.action,
          plan_action_id: action.plan_action_id,
          expected_state_id: state.state_id,
          ...extra,
        });
        if (["LOGIN_REQUIRED", "CAPTCHA_BLOCKED"].includes(state.page_state)) {
          nextCall = null;
        } else if (state.page_state === "MODAL_BLOCKED" && state.modal.dismissible) {
          nextCall = {
            tool: "ypscan_manual_browser_action",
            args: {
              requirement_id: requirementId,
              platform,
              run_id: runId,
              action: "dismiss_modal",
              expected_state_id: state.state_id,
              modal_id: state.modal.modal_id,
            },
            reason: "关闭 Observer 已确认可安全关闭的普通弹窗",
          };
        } else if (state.page_state === "MARKET_LOADING") {
          nextCall = {
            tool: "ypscan_manual_browser_action",
            args: {
              requirement_id: requirementId,
              platform,
              run_id: runId,
              action: "wait_for_ready",
              expected_state_id: state.state_id,
              target_states: ["MARKET_READY", "RESULTS_READY"],
            },
            reason: "有界等待达人广场完成加载",
          };
        } else if (nextPlanned) {
          nextCall = {
            tool: "ypscan_manual_browser_action",
            args: actionArgs(nextPlanned),
            reason: `执行筛选计划动作 ${nextPlanned.plan_action_id}`,
          };
        } else {
          const selection = loaded.selections
            .filter((item) => item.status === "ready" && item.branch?.branch_index === branchIndex)
            .at(-1);
          nextCall = selection
            ? {
                tool: "ypscan_manual_research",
                args: {
                  operation: "collect",
                  requirement_id: requirementId,
                  platform,
                  run_id: runId,
                  selection_id: selection.selection_id,
                },
                reason: "当前分支已有 selection_id，读取当前页面证据",
              }
            : {
                tool: "ypscan_manual_select_filters",
                args: {
                  operation: "commit",
                  requirement_id: requirementId,
                  platform,
                  run_id: runId,
                  branch_index: branchIndex,
                },
                reason: "页面动作已完成，签发 selection_id",
              };
        }
      }
      const payload = {
        success: true,
        status: "observed",
        operation: "inspect",
        platform,
        requirement_id: requirementId || null,
        run_id: runId || null,
        state,
        known_page_states: MANUAL_BROWSER_PAGE_STATES,
        next_call: nextCall,
      };
      return hostToolResult(payload, { details: payload });
    } catch (error) {
      const payload = {
        success: false,
        status: "failed",
        operation: "inspect",
        error: {
          code: error?.code ?? "YPSCAN_MANUAL_BROWSER_INSPECT_FAILED",
          message: error?.message ?? String(error),
        },
      };
      return hostToolResult(payload, { details: payload, isError: true });
    }
  };
}

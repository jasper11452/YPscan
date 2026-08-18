import { chromium } from "playwright-core";
import { inspectManualBrowser } from "./manual-browser-state.js";
import {
  cleanText,
  openFilterMenu,
  selectMenuValues,
} from "./manual-research/common.js";
import { hostToolResult } from "./tool-result.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:18800";

export const SELECT_CASCADE_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["platform", "field_label", "path"],
  properties: {
    platform: {
      type: "string",
      enum: ["xingtu", "douyin", "pgy", "xiaohongshu"],
    },
    field_label: {
      type: "string",
      minLength: 1,
      description: "Agent 从当前页面看到的筛选项名称，例如达人分类；不得传代码内预设字段名。",
    },
    trigger_label: {
      type: "string",
      minLength: 1,
      description: "同一筛选行有多个入口时，传当前页面看到的入口文字。",
    },
    path: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string", minLength: 1 },
      description: "按页面实际层级排列的可见文字，例如 [\"美食\", \"烘焙\"]。",
    },
  },
});

function normalizePlatform(value) {
  if (value === "douyin") return "xingtu";
  if (value === "xiaohongshu") return "pgy";
  return value;
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "YPSCAN_CASCADE_ARGUMENT_INVALID" });
}

function validate(params = {}) {
  const platform = normalizePlatform(cleanText(params.platform));
  if (!["xingtu", "pgy"].includes(platform)) throw invalid("platform 不受支持");
  const fieldLabel = cleanText(params.field_label);
  if (!fieldLabel) throw invalid("field_label 不能为空");
  if (!Array.isArray(params.path) || params.path.length < 1 || params.path.length > 4) {
    throw invalid("path 必须包含 1–4 层可见菜单文字");
  }
  const path = params.path.map((value) => cleanText(value));
  if (path.some((value) => !value)) throw invalid("path 不能包含空值");
  return {
    platform,
    field_label: fieldLabel,
    trigger_label: cleanText(params.trigger_label) || null,
    path,
  };
}

function result(payload, isError = false) {
  return hostToolResult(payload, { details: payload, isError });
}

/**
 * Select one Agent-chosen cascade path on the currently open market page.
 * It owns only the hover/click/readback mechanics; it never chooses a business
 * field, navigates, retries the workflow, or persists workflow state.
 */
export function createCascadeSelector({
  browserCdpUrl = DEFAULT_CDP_URL,
  connectOverCDP = (endpointURL) => chromium.connectOverCDP(endpointURL),
  inspectBrowser = inspectManualBrowser,
  openMenu = openFilterMenu,
  selectValues = selectMenuValues,
} = {}) {
  const cdpUrl = cleanText(browserCdpUrl).replace(/\/$/u, "");
  return async function selectCascade(rawParams = {}) {
    let params;
    try {
      params = validate(rawParams);
      const browser = await connectOverCDP(cdpUrl);
      const { page, state } = await inspectBrowser(browser, params.platform);
      if (["LOGIN_REQUIRED", "CAPTCHA_BLOCKED"].includes(state?.page_state)) {
        return result(
          {
            success: false,
            status: "needs_user_action",
            applied: false,
            verified: false,
            user_action_required: true,
            error: {
              code: state.page_state,
              message: "当前平台需要登录或全局安全验证",
            },
          },
          true,
        );
      }
      if (!page || !["MARKET_READY", "RESULTS_READY"].includes(state?.page_state)) {
        return result({
          success: true,
          status: "recoverable",
          applied: false,
          verified: false,
          page_state: state?.page_state ?? "UNKNOWN",
          recovery_hint:
            "先用宿主原生 Browser 返回达人广场、关闭普通弹窗或等待页面稳定，再重新调用；不要停止手扒任务。",
        });
      }
      const opened = await openMenu(page, [params.field_label], {
        ...(params.trigger_label ? { triggerLabels: [params.trigger_label] } : {}),
        optionValues: [params.path[0]],
      });
      if (!opened) {
        return result({
          success: true,
          status: "not_applied",
          applied: false,
          verified: false,
          field_label: params.field_label,
          selected_path: params.path,
          error: { code: "CASCADE_FIELD_NOT_FOUND", message: "没有找到对应筛选行或菜单入口" },
          recovery_hint:
            "重新观察当前页面上的真实筛选名称；同一行有多个入口时补充 trigger_label。仍找不到则把该条件转入详情硬复核并继续。",
        });
      }
      const before = cleanText(await opened.row?.innerText?.().catch(() => ""));
      const pathText = params.path.join(" / ");
      const selected = await selectValues(page, opened, [pathText]);
      const after = cleanText(await opened.row?.innerText?.().catch(() => ""));
      const applied = selected.length === 1;
      return result({
        success: true,
        status: applied ? "applied" : "not_applied",
        applied,
        verified: applied,
        field_label: params.field_label,
        trigger_label: params.trigger_label,
        selected_path: params.path,
        readback: { before, after },
        ...(applied
          ? {}
          : {
              error: {
                code: "CASCADE_PATH_NOT_COMMITTED",
                message: "级联路径没有形成可验证的叶子选择",
              },
              recovery_hint:
                "重新观察菜单实际层级或换一个页面可见同义项再试一次；仍失败则转入详情硬复核并继续，不终止任务。",
            }),
      });
    } catch (error) {
      return result(
        {
          success: false,
          status: "failed",
          applied: false,
          verified: false,
          error: {
            code: error?.code ?? "YPSCAN_CASCADE_FAILED",
            message: error?.message ?? String(error),
          },
        },
        true,
      );
    }
  };
}

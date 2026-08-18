import { chromium } from "playwright-core";
import { inspectManualBrowser } from "./manual-browser-state.js";
import { cleanText, fillMenuRange, openRangeFilterMenu } from "./manual-research/common.js";
import { hostToolResult } from "./tool-result.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:18800";

export const SET_FILTER_RANGE_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["platform", "field_label", "unit"],
  properties: {
    platform: {
      type: "string",
      enum: ["xingtu", "douyin", "pgy", "xiaohongshu"],
    },
    field_label: {
      type: "string",
      minLength: 1,
      description: "Agent 从当前页面看到的范围筛选名称，例如粉丝数量；不得传代码内预设字段名。",
    },
    trigger_label: {
      type: "string",
      minLength: 1,
      description: "同一筛选行有多个入口时，传当前页面看到的入口文字。",
    },
    min: {
      type: "number",
      description: "规范化下限；粉丝传人数、价格传元、比例传 0–1。省略表示开放下限。",
    },
    max: {
      type: "number",
      description: "规范化上限；粉丝传人数、价格传元、比例传 0–1。省略表示开放上限。",
    },
    unit: {
      type: "string",
      enum: ["count", "yuan", "ratio", "number"],
    },
  },
});

function normalizePlatform(value) {
  if (value === "douyin") return "xingtu";
  if (value === "xiaohongshu") return "pgy";
  return value;
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "YPSCAN_FILTER_RANGE_ARGUMENT_INVALID" });
}

function optionalNumber(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value)) throw invalid(`${name} 必须是有限数字`);
  return value;
}

function validate(params = {}) {
  const platform = normalizePlatform(cleanText(params.platform));
  if (!["xingtu", "pgy"].includes(platform)) throw invalid("platform 不受支持");
  const fieldLabel = cleanText(params.field_label);
  if (!fieldLabel) throw invalid("field_label 不能为空");
  const min = optionalNumber(params.min, "min");
  const max = optionalNumber(params.max, "max");
  if (min === null && max === null) throw invalid("min/max 至少提供一个");
  if (min !== null && max !== null && min > max) throw invalid("min 不能大于 max");
  const unit = cleanText(params.unit);
  if (!["count", "yuan", "ratio", "number"].includes(unit)) throw invalid("unit 不受支持");
  if (unit === "ratio" && [min, max].some((value) => value !== null && (value < 0 || value > 1))) {
    throw invalid("ratio 范围必须在 0–1 内");
  }
  return {
    platform,
    field_label: fieldLabel,
    trigger_label: cleanText(params.trigger_label) || null,
    min,
    max,
    unit,
  };
}

function result(payload, isError = false) {
  return hostToolResult(payload, { details: payload, isError });
}

function selectedFilterSummary(bodyText) {
  const text = cleanText(bodyText);
  const start = text.indexOf("已选条件");
  if (start < 0) return "";
  const summary = text.slice(start + "已选条件".length, start + 500);
  const end = summary.indexOf("清空");
  return cleanText(end < 0 ? summary : summary.slice(0, end));
}

async function readEvidence(page, row) {
  const rowText = cleanText(await row?.innerText?.().catch(() => ""));
  const bodyText =
    typeof page?.locator === "function"
      ? await page.locator("body").innerText().catch(() => "")
      : "";
  return { row: rowText, selected_filters: selectedFilterSummary(bodyText) };
}

function evidenceMentionsField(evidence, fieldLabel) {
  const summary = cleanText(evidence?.selected_filters);
  const labels = new Set([
    cleanText(fieldLabel),
    cleanText(fieldLabel).replace(/^预期/u, ""),
    cleanText(fieldLabel).replace(/^达人/u, ""),
    cleanText(fieldLabel).replace(/数量$/u, ""),
  ]);
  return [...labels].some((label) => label.length >= 2 && summary.includes(label));
}

/**
 * Fill one Agent-chosen range filter on the current market page. Locators are
 * resolved by semantics after each render; host Browser snapshot refs are never reused.
 */
export function createFilterRangeSetter({
  browserCdpUrl = DEFAULT_CDP_URL,
  connectOverCDP = (endpointURL) => chromium.connectOverCDP(endpointURL),
  inspectBrowser = inspectManualBrowser,
  openMenu = openRangeFilterMenu,
  fillRange = fillMenuRange,
  readFilterEvidence = readEvidence,
} = {}) {
  const cdpUrl = cleanText(browserCdpUrl).replace(/\/$/u, "");
  return async function setFilterRange(rawParams = {}) {
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
      const opened = await openMenu(page, params.field_label, {
        triggerLabel: params.trigger_label,
      });
      if (!opened) {
        return result({
          success: true,
          status: "not_applied",
          applied: false,
          verified: false,
          field_label: params.field_label,
          error: { code: "RANGE_FIELD_NOT_FOUND", message: "没有找到对应范围筛选或输入浮层" },
          recovery_hint:
            "重新观察当前页面上的真实筛选名称；同一行有多个入口时补充 trigger_label。仍找不到则把该条件转入详情硬复核并继续。",
        });
      }
      const before = await readFilterEvidence(page, opened.row);
      const filled = await fillRange(
        page,
        opened,
        { min: params.min, max: params.max, unit: params.unit },
        { requireConfirm: true },
      );
      await page.waitForTimeout?.(250).catch(() => {});
      const after = await readFilterEvidence(page, opened.row);
      const menuClosed = !(await opened.menu?.isVisible?.().catch(() => false));
      const changed = after.row !== before.row || after.selected_filters !== before.selected_filters;
      const verified = filled && menuClosed && (changed || evidenceMentionsField(after, params.field_label));
      return result({
        success: true,
        status: verified ? "applied" : "not_applied",
        applied: verified,
        verified,
        field_label: params.field_label,
        trigger_label: params.trigger_label,
        range: { min: params.min, max: params.max, unit: params.unit },
        readback: { before, after, menu_closed: menuClosed, adopted_open_menu: opened.adopted === true },
        ...(verified
          ? {}
          : {
              error: {
                code: "RANGE_NOT_COMMITTED",
                message: "范围输入或确认按钮没有形成可验证的页面提交",
              },
              recovery_hint:
                "重新观察筛选名和单位后最多调整参数再试一次；不要复用旧 Browser ref。仍失败则转入详情硬复核并继续。",
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
            code: error?.code ?? "YPSCAN_FILTER_RANGE_FAILED",
            message: error?.message ?? String(error),
          },
        },
        true,
      );
    }
  };
}

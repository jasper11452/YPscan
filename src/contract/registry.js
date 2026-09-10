/**
 * Small argument-normalization boundary shared by Provider-facing flows.
 * validate_requirement also uses this module for a stateless, pre-write
 * completeness and canonical-format gate; it does not retain workflow state.
 */

import { isRecord, nonemptyString } from "../util/value.js";

const MAX_FOLLOWER_COUNT = 999_999_999;

export const UNRESTRICTED_FOLLOWERCOUNT_RANGE = `[0,${MAX_FOLLOWER_COUNT}]`;

/**
 * 手动拓展候选池上限：按目标人数分档，目标越小倍数越高（补偿冷启动损耗），
 * 目标越大倍数越低（绝对冗余已足够）。锚点：10→30、20→50、50→100。
 * @param {number} target 交付目标人数（正整数）
 * @returns {number} 候选池上限（正整数）
 */
export function manualSourcePoolSize(target) {
  const n = Math.max(1, Math.ceil(target));
  if (n <= 10) return n * 3;
  if (n <= 20) return n * 2 + 10;
  // 21~30 用 n+30 兜底，避免 21 人的池子比 20 人还小（2×21=42 < 50）。
  return Math.max(n * 2, n + 30);
}

export const BUSINESS_MODE_VALUES = Object.freeze(["询价机构", "手动拓展"]);
export const PROVIDER_MANUAL_BUSINESS_MODE = "直接手扒";
const PROVIDER_BUSINESS_MODE_VALUES = Object.freeze([
  BUSINESS_MODE_VALUES[0],
  PROVIDER_MANUAL_BUSINESS_MODE,
]);

export function normalizeBusinessMode(value) {
  if (value === PROVIDER_MANUAL_BUSINESS_MODE) return BUSINESS_MODE_VALUES[1];
  return typeof value === "string" && BUSINESS_MODE_VALUES.includes(value) ? value : null;
}

function providerBusinessMode(value) {
  const normalized = normalizeBusinessMode(value);
  if (normalized === BUSINESS_MODE_VALUES[1]) return PROVIDER_MANUAL_BUSINESS_MODE;
  return normalized;
}

export const HOST_PREFIX = "mcp__ypscan__";
export const HOST_PREFIXES = Object.freeze([
  HOST_PREFIX,
  "ypscan__",
  "mcp__ypmcn__",
  "ypmcn__",
  "test__",
]);

const BUSINESS_TOOL_NAMES = Object.freeze([
  "validate_requirement",
  "search_creators",
  "rank_mcns",
  "select_inquiry_form_fields",
  "get_inquiry_form_fields_status",
  "create_with_distributions",
  "sync_mcn_inquiry_status",
  "ingest_mcn_submissions",
  "get_ingest_job",
  "manual_source_creators",
  "manual_source_creators_status",
  "score_manual_source_csv",
  "score_manual_source_csv_status",
  "rank_creators",
  "get_xhs_author_business_card",
  "get_douyin_author_business_card",
  "get_creator_detail",
  "get_creator_detail_export",
  "get_workflow_state",
  "create_submission_batch",
]);

export const TOOL_REGISTRY = Object.freeze(
  Object.fromEntries(BUSINESS_TOOL_NAMES.map((name) => [name, true])),
);

// 插件本地工具同样按宿主工具名参与 Hook 路由（解析、保存、归一化、汇总等）。
const LOCAL_TOOL_NAMES = Object.freeze([
  "file_bridge",
  "ypscan_parse_requirement",
  "ypscan_save_artifact",
  "ypscan_save_creator_links",
  "ypscan_summarize_manual_scores",
  "ypscan_select_cascade",
  "ypscan_set_filter_range",
]);

const HOST_TOOL_NAMES = Object.freeze([...BUSINESS_TOOL_NAMES, ...LOCAL_TOOL_NAMES]);
const HOST_TOOL_REGISTRY = Object.freeze(
  Object.fromEntries(HOST_TOOL_NAMES.map((name) => [name, true])),
);
// 双下划线命名空间（`<前缀>__业务名`），以及宿主把 MCP 命名空间扁平化为单分隔符的形态
// （pi 适配器：`mcp-04b79900_validate_requirement`）。前缀形态受限，不把任意前缀当业务工具。
const HOST_NAMESPACE = /^[a-z0-9_-]+(?:__[a-z0-9_-]+)*$/u;
const FLAT_HOST_NAMESPACE = /^(?:mcp|ypscan|ypmcn)[-_.][a-z0-9]+(?:[-_][a-z0-9]+)*$/u;

export const VALIDATE_REQUIREMENT_PARAMS = Object.freeze([
  "demandId",
  "demandVersion",
  "status",
  "brandName",
  "projectName",
  "product",
  "platform",
  "rebate",
  "quantityTotal",
  "projectStartStart",
  "projectStartEnd",
  "submissionDeadlineAt",
  "rawMessagesJson",
  "contentTag",
  "description",
  "contentFeatureLabel",
  "contentThemeLabel",
  "kolPersonaLabel",
  "talentTypeLabel",
  "pgyBloggerTypeLabel",
  "growBloggerTypeLabel",
  "xtTalentTypeLabel",
  "growTalentTypeLabel",
  "industryTagLabel",
  "kwGender",
  "kwIpDependency",
  "kwUserUrl",
  "organization",
  "hasOrganization",
  "hasOrder30day",
  "hasSocial30day",
  "interactionRate",
  "clickMedium",
  "viewMedium",
  "photoView",
  "videoInteract",
  "photoInteract",
  "followercount",
  "userlikecount",
  "likeIncrement",
  "avgview",
  "avglike",
  "avgcomment",
  "avgcollect",
  "avginteract",
  "femaleRate",
  "age1Rate",
  "age2Rate",
  "age3Rate",
  "age4Rate",
  "age5Rate",
  "age6Rate",
  "cpeL1",
  "cpeL2",
  "cpeL3",
  "cpmL1",
  "cpmL2",
  "cpmL3",
  "kolOfficialPriceL1",
  "kolOfficialPriceL2",
  "kolOfficialPriceL3",
  "originalBrief",
  "refNickname",
  "refUrl",
]);

const REQUIRED_VALIDATE_PARAMS = new Set([
  "status",
  "platform",
  "brandName",
  "projectName",
  "quantityTotal",
  "submissionDeadlineAt",
  "rebate",
  "followercount",
  "contentTag",
  "rawMessagesJson",
]);

const TAG_ARRAY_PARAMS = new Set([
  "pgyBloggerTypeLabel",
  "growBloggerTypeLabel",
  "kolPersonaLabel",
  "contentFeatureLabel",
  "xtTalentTypeLabel",
  "growTalentTypeLabel",
  "contentThemeLabel",
  "industryTagLabel",
]);

const STRING_VALIDATE_PARAMS = new Set(
  VALIDATE_REQUIREMENT_PARAMS.filter(
    (name) => name !== "rawMessagesJson" && name !== "contentTag" && !TAG_ARRAY_PARAMS.has(name),
  ),
);

const STRING_BOOLEAN_PARAMS = new Set(["hasOrganization", "hasOrder30day", "hasSocial30day"]);

export const VALIDATE_REQUIREMENT_RANGE_PARAMS = Object.freeze([
  "rebate",
  "followercount",
  "interactionRate",
  "clickMedium",
  "viewMedium",
  "photoView",
  "videoInteract",
  "photoInteract",
  "userlikecount",
  "likeIncrement",
  "avgview",
  "avglike",
  "avgcomment",
  "avgcollect",
  "avginteract",
  "femaleRate",
  "age1Rate",
  "age2Rate",
  "age3Rate",
  "age4Rate",
  "age5Rate",
  "age6Rate",
  "cpeL1",
  "cpeL2",
  "cpeL3",
  "cpmL1",
  "cpmL2",
  "cpmL3",
  "kolOfficialPriceL1",
  "kolOfficialPriceL2",
  "kolOfficialPriceL3",
]);

const RANGE_PARAMS = VALIDATE_REQUIREMENT_RANGE_PARAMS;

const RATE_RANGE_PARAMS = new Set([
  "interactionRate",
  "femaleRate",
  "age1Rate",
  "age2Rate",
  "age3Rate",
  "age4Rate",
  "age5Rate",
  "age6Rate",
]);

const PRICE_RANGE_PARAMS = new Set([
  "kolOfficialPriceL1",
  "kolOfficialPriceL2",
  "kolOfficialPriceL3",
]);

const MAXIMUM_METRIC_RANGE_PARAMS = new Set(["cpeL1", "cpeL2", "cpeL3", "cpmL1", "cpmL2", "cpmL3"]);

const PLATFORM_TAG_FIELDS = Object.freeze({
  xiaohongshu: [
    "contentFeatureLabel",
    "growBloggerTypeLabel",
    "kolPersonaLabel",
    "pgyBloggerTypeLabel",
  ],
  douyin: ["contentThemeLabel", "growTalentTypeLabel", "industryTagLabel", "xtTalentTypeLabel"],
});

const PLATFORM_ARRAY_FIELD_PARAMS = Object.freeze({
  xiaohongshu: ["contentTag", ...PLATFORM_TAG_FIELDS.xiaohongshu],
  douyin: ["contentTag", ...PLATFORM_TAG_FIELDS.douyin],
});
const PARSED_TAG_FIELDS = Object.freeze([...TAG_ARRAY_PARAMS, "contentTag"]);

const PRICE_FIELDS = Object.freeze([
  "kolOfficialPriceL1",
  "kolOfficialPriceL2",
  "kolOfficialPriceL3",
]);

const DOUYIN_VIDEO_TYPE_METRIC_FIELDS = Object.freeze([
  "kolOfficialPriceL1",
  "kolOfficialPriceL2",
  "kolOfficialPriceL3",
  "cpmL1",
  "cpmL2",
  "cpmL3",
  "cpeL1",
  "cpeL2",
  "cpeL3",
]);

const PLATFORM_ALIASES = Object.freeze({
  xiaohongshu: "xiaohongshu",
  xhs: "xiaohongshu",
  小红书: "xiaohongshu",
  douyin: "douyin",
  dy: "douyin",
  抖音: "douyin",
});

const POSITIVE_INTEGER_STRING = /^([1-9]\d*)$/u;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_DATE_OR_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/u;
function normalizedQuantityTotal(value) {
  if (Number.isSafeInteger(value)) {
    return value > 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return POSITIVE_INTEGER_STRING.test(trimmed) ? trimmed : null;
}

function normalizedBrandName(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        Array.isArray(parsed) &&
        parsed.length === 1 &&
        typeof parsed[0] === "string" &&
        parsed[0].trim()
      ) {
        return parsed[0].trim();
      }
    } catch {
      // Keep the original string when it is not JSON.
    }
    return trimmed;
  }
  if (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === "string" &&
    value[0].trim()
  ) {
    return value[0].trim();
  }
  return value;
}

function normalizedRawMessages(value) {
  let normalized = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return value;
    try {
      const parsed = JSON.parse(trimmed);
      normalized = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return normalized;
  const record = /** @type {Record<string, unknown>} */ (normalized);
  /** @type {Record<string, unknown>} */
  const next = { ...record };
  let changed = false;

  if (!nonemptyString(next.original) && nonemptyString(next.original_demand)) {
    next.original = String(next.original_demand).trim();
    changed = true;
  }
  if (!isRecord(next.clarifications) && isRecord(next.clarify)) {
    next.clarifications = next.clarify;
    changed = true;
  }
  if (!nonemptyString(next.business_mode)) {
    const businessMode =
      normalizeBusinessMode(record.businessMode) ?? normalizeBusinessMode(record.mode);
    if (businessMode) {
      next.business_mode = businessMode;
      changed = true;
    }
  }
  const providerMode = providerBusinessMode(next.business_mode);
  if (providerMode && providerMode !== next.business_mode) {
    next.business_mode = providerMode;
    changed = true;
  }
  return changed ? next : normalized;
}

function normalizedNumericRange(value, { rate = false, price = false, maximum = false } = {}) {
  let parsed = value;
  let percentNotation = false;
  let inputKind = "structured";
  if (typeof value === "string") {
    const trimmed = value.trim();
    const singlePercent = trimmed.match(/^(\d+(?:\.\d+)?)%$/u);
    const range = trimmed.match(
      /^(\d+(?:\.\d+)?)\s*(%)?\s*(?:-|~|～|至|到)\s*(\d+(?:\.\d+)?)\s*(%)?$/u,
    );
    if (singlePercent) {
      parsed = [Number(singlePercent[1]), Number(singlePercent[1])];
      percentNotation = true;
      inputKind = "scalar";
    } else if (range) {
      parsed = [Number(range[1]), Number(range[3])];
      percentNotation = Boolean(range[2] || range[4]);
      inputKind = "range";
    } else if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
      parsed = [Number(trimmed), Number(trimmed)];
      inputKind = "scalar";
    } else {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
  } else if (typeof value === "number" && Number.isFinite(value)) {
    parsed = [value, value];
    inputKind = "scalar";
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !parsed.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return value;
  }
  if (parsed[0] > parsed[1] || (inputKind !== "scalar" && parsed[0] === parsed[1])) {
    return value;
  }
  const normalized = rate
    ? parsed.map((item) => (percentNotation || item > 1 ? item / 100 : item))
    : parsed;
  if (maximum && inputKind === "scalar") {
    return normalized[1] >= 0 ? JSON.stringify([0, normalized[1]]) : value;
  }
  if (price && inputKind !== "structured") {
    return JSON.stringify([Math.floor(normalized[0] * 0.7), Math.ceil(normalized[1] * 1.2)]);
  }
  return JSON.stringify(normalized);
}

function clampFollowerCountRange(value) {
  if (typeof value !== "string") return value;
  const range = parsedCanonicalRange(value);
  if (!range) return value;
  if (range[1] <= MAX_FOLLOWER_COUNT) return value;
  if (range[0] < MAX_FOLLOWER_COUNT) return JSON.stringify([range[0], MAX_FOLLOWER_COUNT]);
  return value;
}

function normalizedFollowerRange(value) {
  if (
    typeof value === "string" &&
    /^(?:无(?:要求)?|不限|不限制|无限制|都可以|均可|粉丝(?:数|量|量级)?不限|不限粉丝(?:数|量|量级)?|粉丝(?:数|量|量级)?无(?:要求|限制)|无(?:任何)?粉丝(?:数|量|量级)?要求)$/u.test(
      value.trim(),
    )
  ) {
    return UNRESTRICTED_FOLLOWERCOUNT_RANGE;
  }
  const normalized = normalizedNumericRange(value);
  if (normalized !== value || typeof value !== "string") {
    return normalizeLegacyUnrestrictedFollowerRange(clampFollowerCountRange(normalized));
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:-|~|～|至|到)\s*(\d+(?:\.\d+)?)$/u);
  if (!match) return normalizeLegacyUnrestrictedFollowerRange(clampFollowerCountRange(value));
  const lower = Number(match[1]);
  const upper = Number(match[2]);
  const result = lower <= upper ? clampFollowerCountRange(JSON.stringify([lower, upper])) : value;
  return normalizeLegacyUnrestrictedFollowerRange(result);
}

/** 历史坏值 [1,999999999]（把“不限”写成下限 1）归一为全量区间。 */
function normalizeLegacyUnrestrictedFollowerRange(value) {
  return value === `[1,${MAX_FOLLOWER_COUNT}]` ? UNRESTRICTED_FOLLOWERCOUNT_RANGE : value;
}

function normalizedRebateRange(value) {
  let minimum = null;
  let maximum = null;
  let hasUpperBound = false;
  if (typeof value === "number" && Number.isFinite(value)) {
    minimum = value;
  } else if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    [minimum, maximum] = value;
    hasUpperBound = true;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const percent = trimmed.match(/^(\d+(?:\.\d+)?)%$/u);
    const minimumPercent = trimmed.match(
      /^(?:不低于|至少)?\s*(\d+(?:\.\d+)?)\s*%(?:以上|及以上)?$/u,
    );
    const range = trimmed.match(
      /^(\d+(?:\.\d+)?)\s*%?\s*(?:-|~|～|至|到)\s*(\d+(?:\.\d+)?)\s*%?$/u,
    );
    if (percent) {
      minimum = Number(percent[1]) / 100;
    } else if (minimumPercent) {
      minimum = Number(minimumPercent[1]) / 100;
    } else if (range) {
      minimum = Number(range[1]);
      maximum = Number(range[2]);
      hasUpperBound = true;
    } else if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
      minimum = Number(trimmed);
    } else {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          Array.isArray(parsed) &&
          parsed.length === 2 &&
          parsed.every((item) => typeof item === "number" && Number.isFinite(item))
        ) {
          [minimum, maximum] = parsed;
          hasUpperBound = true;
        }
      } catch {
        return value;
      }
    }
  }
  if (minimum === null) return value;
  if (minimum > 1 && minimum <= 100) minimum /= 100;
  if (hasUpperBound) {
    if (maximum > 1 && maximum <= 100) maximum /= 100;
    if (maximum !== 1) return value;
  }
  return minimum >= 0 && minimum <= 1 ? JSON.stringify([minimum, 1]) : value;
}

function parseLocalDateTime(value) {
  if (typeof value !== "string") return Number.NaN;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second] = match;
  if (
    !validLocalDateParts(year, month, day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return Number.NaN;
  }
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
}

const DEADLINE_CLOCK = String.raw`(?:\d{1,2}[:：]\d{2}(?:[:：]\d{2})?|\d{1,2}\s*(?:点|时)(?:\s*\d{1,2}\s*分)?(?:\s*\d{1,2}\s*秒)?)`;
const DEADLINE_DATE = String.raw`(?:(?:\d{4}|\d{2})年\s*\d{1,2}月\s*\d{1,2}日\s*|\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T])`;

function normalizedDateTime(value, { now = new Date() } = {}) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  let absolute = trimmed;
  const relative = trimmed.match(
    new RegExp(`^(今天|今日|当天|明天)?(${DEADLINE_CLOCK})(前)?$`, "u"),
  );
  if (relative && (relative[1] || relative[3])) {
    const date = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + (relative[1] === "明天" ? 1 : 0),
    );
    absolute = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${relative[2]}`;
  }
  const match = absolute.match(new RegExp(`^(${DEADLINE_DATE})(${DEADLINE_CLOCK})$`, "u"));
  if (!match) return trimmed;
  const dateParts = match[1].match(/\d+/gu);
  if (!dateParts) return trimmed;
  const [year, monthPart, dayPart] = dateParts;
  const clock =
    match[2].match(/^(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/u) ??
    match[2].match(/^(\d{1,2})\s*(?:点|时)(?:\s*(\d{1,2})\s*分)?(?:\s*(\d{1,2})\s*秒)?$/u);
  if (!clock) return trimmed;
  const [month, day, hour, minute, second] = [monthPart, dayPart, ...clock.slice(1)].map((part) =>
    (part ?? "00").padStart(2, "0"),
  );
  // 中文业务日期的两位年份按 20xx 解释，不随当前时间滚动到下一世纪。
  const fullYear = year.length === 2 ? `20${year}` : year;
  const normalized = `${fullYear}-${month}-${day} ${hour}:${minute}:${second}`;
  const timestamp = parseLocalDateTime(normalized);
  if (!Number.isFinite(timestamp)) return trimmed;
  return timestamp > now.getTime() ? normalized : value;
}

function validLocalDateParts(year, month, day) {
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return (
    date.getFullYear() === Number(year) &&
    date.getMonth() === Number(month) - 1 &&
    date.getDate() === Number(day)
  );
}

function isCanonicalProjectDate(value) {
  if (typeof value !== "string") return false;
  const match = value.match(LOCAL_DATE_OR_DATETIME);
  if (!match || !validLocalDateParts(match[1], match[2], match[3])) return false;
  if (match[4] === undefined) return LOCAL_DATE.test(value);
  return Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6] ?? 0) <= 59;
}

export function isFutureSubmissionDeadline(value, { now = new Date() } = {}) {
  const timestamp = parseLocalDateTime(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

export function normalizeValidateRequirementTagArrays(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  let normalized = null;
  for (const name of TAG_ARRAY_PARAMS) {
    const value = params[name];
    if (value === null) {
      normalized ??= { ...params };
      delete normalized[name];
      continue;
    }
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((item) => typeof item === "string" && item.trim())
      ) {
        normalized ??= { ...params };
        normalized[name] = parsed;
      }
    } catch {
      // Keep invalid values untouched so the local preflight can report the error.
    }
  }
  return normalized ?? params;
}

/**
 * @param {string} toolName
 * @param {string} bare
 * @param {string} separator
 * @param {RegExp} namespace
 */
function matchesHostNamespace(toolName, bare, separator, namespace) {
  const suffix = `${separator}${bare}`;
  if (!toolName.endsWith(suffix)) return false;
  const prefix = toolName.slice(0, -suffix.length);
  return prefix !== "" && namespace.test(prefix);
}

export function stripHostPrefix(toolName) {
  if (typeof toolName !== "string") return null;
  const normalized = toolName.trim().toLowerCase();
  if (Object.hasOwn(HOST_TOOL_REGISTRY, normalized)) return normalized;
  for (const bare of HOST_TOOL_NAMES) {
    if (matchesHostNamespace(normalized, bare, "__", HOST_NAMESPACE)) return bare;
    if (matchesHostNamespace(normalized, bare, "_", FLAT_HOST_NAMESPACE)) return bare;
  }
  return null;
}

function normalizedStringArray(value) {
  if (Array.isArray(value)) {
    const items = value
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return normalizedStringArray(parsed);
  } catch {
    // fall through
  }
  const items = trimmed
    .split(/[，,、\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function normalizePlatformArrayFields(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const platform = normalizedPlatformName(params.platform);
  const fields = PLATFORM_ARRAY_FIELD_PARAMS[platform] ?? [];
  if (fields.length === 0) return params;
  let normalized = params;
  for (const field of fields) {
    const value = normalizedStringArray(params[field]);
    if (!value) continue;
    if (normalized === params) normalized = { ...params };
    normalized[field] = value;
  }
  return normalized;
}

function normalizedPlatformName(value) {
  if (typeof value !== "string") return null;
  return PLATFORM_ALIASES[value.toLowerCase()] ?? PLATFORM_ALIASES[value] ?? value.trim();
}

function tagArrayValue(value) {
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim())
  ) {
    return value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((item) => typeof item === "string" && item.trim())
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Parsed tag arrays are authoritative workflow output. Keep the raw outputs
 * untouched while expanding the canonical fields at the Provider boundary.
 *
 * @param {unknown} rawMessages
 * @param {unknown} platform
 */
function parsedTagArrays(rawMessages, platform) {
  if (!rawMessages || typeof rawMessages !== "object" || Array.isArray(rawMessages)) {
    return {};
  }

  const rawRecord = /** @type {Record<string, unknown>} */ (rawMessages);
  const outputs = rawRecord.parse_outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return {};

  const outputRecord = /** @type {Record<string, unknown>} */ (outputs);
  /** @type {Record<string, string[]>} */
  const tags = {};
  for (const field of PARSED_TAG_FIELDS) {
    if (
      Object.values(PLATFORM_TAG_FIELDS).flat().includes(field) &&
      !(PLATFORM_TAG_FIELDS[normalizedPlatformName(platform)] ?? []).includes(field)
    )
      continue;
    const candidate = outputRecord[field];
    const nested =
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? /** @type {Record<string, unknown>} */ (candidate)[field]
        : candidate;
    const value = tagArrayValue(nested);
    if (value) tags[field] = value;
  }
  return tags;
}

export function invalidPlatformArrayFields(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return [];
  const platform = normalizedPlatformName(params.platform);
  const fields = PLATFORM_ARRAY_FIELD_PARAMS[platform] ?? [];
  return fields.filter((field) => {
    if (!Object.hasOwn(params, field)) return false;
    return !tagArrayValue(params[field]);
  });
}

export function missingRequiredValidateParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return [];
  const missing = [...REQUIRED_VALIDATE_PARAMS].filter((name) => {
    const value = params[name];
    return (
      value === undefined || value === null || (typeof value === "string" && value.trim() === "")
    );
  });

  return missing;
}

function parsedJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return /** @type {Record<string, unknown>} */ (value);
}

function parsedJsonObjectString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsedJsonObject(parsed);
  } catch {
    return null;
  }
}

function parsedCanonicalRange(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !parsed.every((item) => typeof item === "number" && Number.isFinite(item)) ||
      parsed[0] >= parsed[1] ||
      parsed.some((item) => item < 0) ||
      JSON.stringify(parsed) !== value
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function rawRequirementEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = /** @type {Record<string, unknown>} */ (value);
  const collect = (item, depth = 0) => {
    if (depth > 4 || item === null || item === undefined) return [];
    if (["string", "number", "boolean"].includes(typeof item)) {
      const text = String(item).trim();
      return text ? [text] : [];
    }
    if (Array.isArray(item)) {
      return item.flatMap((child) => collect(child, depth + 1));
    }
    if (typeof item !== "object") return [];
    return Object.entries(item).flatMap(([key, child]) => {
      const childParts = collect(child, depth + 1);
      return childParts.length > 0 ? [key, ...childParts] : [];
    });
  };
  return [...collect(record.original), ...collect(record.clarifications)].join(" ");
}

function latestScalarClarification(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawMessages = /** @type {Record<string, unknown>} */ (value);
  const clarifications = rawMessages.clarifications;
  if (!clarifications || typeof clarifications !== "object" || Array.isArray(clarifications)) {
    return null;
  }
  const acceptedKeys = new Set(keys.map((key) => key.toLowerCase()));
  let current = null;
  for (const [key, item] of Object.entries(clarifications)) {
    if (!acceptedKeys.has(key.toLowerCase())) continue;
    const candidates = Array.isArray(item) ? item : [item];
    for (const candidate of candidates) {
      if (!["string", "number", "boolean"].includes(typeof candidate)) continue;
      const text = String(candidate).trim();
      if (text) current = { key, text };
    }
  }
  return current;
}

function latestFieldEvidence(value, keys) {
  const latest = latestScalarClarification(value, keys);
  return latest ? `${latest.key} ${latest.text}` : null;
}

const INVALID_BRAND_CANDIDATE =
  /^(?:null|undefined|unknown|n\/?a|none|未知|未明确|未提及|未提供|暂无品牌|暂无|无品牌|无|不详|待确认|待定|none brand)$/iu;
const BRAND_LABEL_PREFIX = /^(?:品牌(?:名称)?|brandName)\s*[:：=]\s*/iu;

function normalizedBrandCandidate(value) {
  if (typeof value !== "string") return null;
  const candidate = value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
    .replace(BRAND_LABEL_PREFIX, "")
    .trim();
  return candidate && !INVALID_BRAND_CANDIDATE.test(candidate) ? candidate : null;
}

function explicitBrandFromOriginal(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/gu, "\n");
  const patterns = [
    /(?:^|[；;。\n])\s*品牌(?:名称)?\s*[:：=]\s*([^；;，,。\n]+)/iu,
    /(?:^|[；;。\n])\s*合作品牌\s*[:：=]\s*([^；;，,。\n]+)/iu,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = normalizedBrandCandidate(match?.[1]);
    if (candidate) return candidate;
  }
  return null;
}

function uniqueParsedBrand(value, platform) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawMessages = /** @type {Record<string, unknown>} */ (value);
  const outputs = rawMessages.parse_outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return null;
  const outputRecord = /** @type {Record<string, unknown>} */ (outputs);
  const field =
    platform === "xiaohongshu" ? "xhsbrandName" : platform === "douyin" ? "dybrandName" : null;
  if (!field) return null;
  const values = [outputRecord[field], outputRecord.brandName].flatMap((source) => {
    if (typeof source === "string") {
      try {
        const parsed = JSON.parse(source);
        return Array.isArray(parsed) ? parsed : [source];
      } catch {
        return [source];
      }
    }
    return Array.isArray(source) ? source : [source];
  });
  const candidates = [...new Set(values.map(normalizedBrandCandidate).filter(Boolean))];
  return candidates.length === 1 ? candidates[0] : null;
}

function clarifiedBrandEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { present: false, candidates: [] };
  }
  const clarification = latestScalarClarification(value, ["brandName", "品牌", "品牌名称"]);
  if (clarification) {
    const candidate = normalizedBrandCandidate(clarification.text);
    return { present: true, candidates: candidate ? [candidate] : [] };
  }
  return { present: false, candidates: [] };
}

function projectDateTimestamp(value) {
  if (typeof value !== "string") return Number.NaN;
  const match = value.match(LOCAL_DATE_OR_DATETIME);
  if (!match || !isCanonicalProjectDate(value)) return Number.NaN;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  ).getTime();
}

function regexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function chineseQuantity(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 9999) return null;
  const digits = "零一二三四五六七八九";
  let result = "";
  let pendingZero = false;
  for (const [unit, label] of [
    [1000, "千"],
    [100, "百"],
    [10, "十"],
    [1, ""],
  ]) {
    const digit = Math.floor(number / Number(unit)) % 10;
    if (digit) {
      if (pendingZero) result += "零";
      result += `${digits[digit]}${label}`;
      pendingZero = false;
    } else if (result) pendingZero = true;
  }
  return result.replace(/^一十/u, "十");
}

function hasQuantityEvidence(evidence, value) {
  if (typeof value !== "string" || !POSITIVE_INTEGER_STRING.test(value)) return false;
  const chinese = chineseQuantity(value);
  const quantity = `(?:${regexLiteral(value)}${chinese ? `|${chinese}` : ""})`;
  const numericChars = "\\d零〇一二两三四五六七八九十百千万";
  const normalizedEvidence = evidence.normalize("NFKC").replace(/两(?=[百千位名个人])/gu, "二");
  return new RegExp(
    `(?:数量|提报(?:数量|人数)?|达人(?:数量|人数)?|quantityTotal)[^${numericChars}]{0,12}${quantity}(?![${numericChars}])|(?<![${numericChars}])${quantity}\\s*(?:位|名|个|人(?!民币|均))(?:达人|博主)?`,
    "iu",
  ).test(normalizedEvidence);
}

function hasSubmissionDeadlineEvidence(evidence, value, now) {
  if (typeof value !== "string" || !Number.isFinite(parseLocalDateTime(value))) return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const absoluteDates = evidence.matchAll(
    new RegExp(`(?<!\\d)${DEADLINE_DATE}${DEADLINE_CLOCK}(?![\\d分秒:：Zz+−-])`, "gu"),
  );
  for (const [date] of absoluteDates) {
    if (normalizedDateTime(date, { now }) === value) return true;
  }
  const relativeTime = `((?:今天|今日|当天|明天)?${DEADLINE_CLOCK}(?:前)?)`;
  const relativePatterns = [
    `(?:^|[，,；;。\\n])\\s*(?:submissionDeadlineAt|提报截止(?:时间)?|截止时间)\\s*[:：]?\\s*${relativeTime}(?=$|[，,；;。\\n])`,
    `(?:^|[，,；;。\\n])\\s*(?:请)?在?${relativeTime}(?:提交|提报|反馈)(?=$|[，,；;。\\n])`,
  ];
  for (const pattern of relativePatterns) {
    for (const [, date] of evidence.matchAll(new RegExp(pattern, "gu"))) {
      if (normalizedDateTime(date, { now }) === value) return true;
    }
  }
  const numericHour = Number(hour);
  const numericMinute = Number(minute);

  const sameDay =
    Number(year) === now.getFullYear() &&
    Number(month) === now.getMonth() + 1 &&
    Number(day) === now.getDate();
  if (!sameDay || Number(second) !== 0) return false;
  const minutePattern = numericMinute < 10 ? `0?${numericMinute}` : String(numericMinute);
  const clockHourPattern = (hourValue) =>
    `(?<!\\d)${hourValue < 10 ? `0?${hourValue}` : hourValue}`;
  const chineseClock = (hourValue) =>
    `${clockHourPattern(hourValue)}\\s*(?:点|时)${numericMinute ? `\\s*${minutePattern}\\s*分` : "(?:\\s*0+\\s*分)?"}(?:\\s*0+\\s*秒)?(?![\\d分秒])`;
  const colonClock = (hourValue) =>
    `${clockHourPattern(hourValue)}\\s*[:：]\\s*${String(numericMinute).padStart(2, "0")}(?:\\s*[:：]\\s*00)?(?!\\d|\\s*[:：]\\s*\\d)`;
  const anyClock = (hourValue) => `(?:${chineseClock(hourValue)}|${colonClock(hourValue)})`;
  // “今晚8点前”等同日晚上表述：12 小时制别名只在晚/夜语境下与 20:00 等价。
  const eveningHour = numericHour > 12 ? numericHour - 12 : null;
  const eveningPrefix = "(?:今晚|今天晚|今日晚|今夜|当天晚|晚上)";
  const eveningClock =
    eveningHour == null
      ? null
      : `${eveningPrefix}[^。；;\\n]{0,8}(?:${anyClock(numericHour)}|${anyClock(eveningHour)})`;
  const dayClock = `(?:今天|今日|当天)[^。；;\\n]{0,20}(?:${anyClock(numericHour)}${eveningHour == null ? "" : `|晚[^。；;\\n]{0,8}${anyClock(eveningHour)}`})`;
  const deadlineMarker = "(?:submissionDeadlineAt|提报|提交|反馈|截止)";
  // 晚/夜语境的同日钟点本身即视为截止证据（“今晚8点前”无需额外截止标记）；
  // 其余同日钟点仍需截止语义标记，避免把“今天18:00开始直播”误当截止。
  return (
    (eveningClock !== null && new RegExp(eveningClock, "iu").test(evidence)) ||
    new RegExp(
      `(?:${deadlineMarker}[^。；;\\n]{0,20}${dayClock}|${dayClock}[^。；;\\n]{0,20}${deadlineMarker})`,
      "iu",
    ).test(evidence)
  );
}

function hasProjectDateEvidence(evidence, value) {
  if (typeof value !== "string") return false;
  const match = value.match(LOCAL_DATE_OR_DATETIME);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hasTime = match[4] !== undefined;
  const second = Number(match[6] ?? 0);
  const datePatterns = hasTime
    ? [
        `${match[1]}-${match[2]}-${match[3]}[ T]${match[4]}:${match[5]}:${String(second).padStart(2, "0")}`,
        ...(second === 0
          ? [`${match[1]}-${match[2]}-${match[3]}[ T]${match[4]}:${match[5]}(?!:)`]
          : []),
        `${year}年${month}月${day}日${Number(match[4])}点${Number(match[5]) ? `${Number(match[5])}分` : ""}${second ? `${second}秒` : "(?:0秒)?"}`,
      ]
    : [
        regexLiteral(`${match[1]}-${match[2]}-${match[3]}`),
        regexLiteral(`${year}/${month}/${day}`),
        regexLiteral(`${year}年${month}月${day}日`),
      ];
  const context =
    "(?:项目(?:开始|结束)(?:时间)?|档期|投放(?:时间|周期)?|执行(?:时间|周期|开始|结束)?|发布(?:时间)?|上线(?:时间)?|projectStartStart|projectStartEnd)";
  if (
    datePatterns.some((datePattern) =>
      new RegExp(`${context}[^。；;\\n]{0,80}${datePattern}`, "iu").test(evidence),
    )
  ) {
    return true;
  }
  if (hasTime) return false;

  const contextPattern = new RegExp(context, "iu");
  for (const dateMatch of evidence.matchAll(
    /(?<!\d)(?:(\d{2,4})年)?(\d{1,2})月(\d{1,2})日/gu,
  )) {
    if (Number(dateMatch[2]) !== month || Number(dateMatch[3]) !== day) continue;
    const index = dateMatch.index ?? 0;
    if (!contextPattern.test(evidence.slice(Math.max(0, index - 80), index))) continue;
    const evidenceYear = dateMatch[1]
      ? Number(dateMatch[1].length === 2 ? `20${dateMatch[1]}` : dateMatch[1])
      : null;
    if (evidenceYear === null || evidenceYear === year) return true;
  }
  return false;
}

function supportedDouyinVideoTypeTiers(evidence) {
  const tiers = new Set();
  const current = evidence.replace(
    /(?:不要|不做|不选|不接受|排除|不考虑|不需要|不是|非)\s*(?:(?:植入视频|植入|定制视频|定制)\s*(?:、|和|或|以及|与)\s*)*(?:植入视频|植入|定制视频|定制)/gu,
    " ",
  );
  if (/植入视频|植入报价|植入/u.test(current)) tiers.add("L2");
  if (/定制视频|定制报价|定制/u.test(current)) tiers.add("L3");
  return tiers;
}

function metricOutputRecord(rawMessages, field) {
  if (!rawMessages || typeof rawMessages !== "object" || Array.isArray(rawMessages)) return null;
  const outputs = rawMessages.parse_outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return null;
  let value = outputs[field];
  if (typeof value === "string") {
    const parsed = parsedJsonObjectString(value);
    if (!parsed) return null;
    value = parsed;
  }
  return parsedJsonObject(value);
}

function usableMetricValue(value) {
  return (
    value !== null &&
    value !== undefined &&
    !(typeof value === "string" && (!value.trim() || value.trim().toLowerCase() === "null"))
  );
}

const PARSED_RANGE_FIELDS = Object.freeze([
  "followercount",
  "rebate",
  ...PRICE_FIELDS,
  ...DOUYIN_VIDEO_TYPE_METRIC_FIELDS.filter((field) => !PRICE_FIELDS.includes(field)),
]);

/**
 * @param {unknown} outputs
 * @param {string} field
 * @param {unknown} platform
 * @returns {unknown[]}
 */
function collectParsedMetricValues(outputs, field, platform) {
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return [];
  const outputRecord = /** @type {Record<string, unknown>} */ (outputs);
  /** @type {unknown[]} */
  const values = [];
  const add = (value) => {
    if (!usableMetricValue(value)) return;
    if (value && typeof value === "object" && !Array.isArray(value) && field in value) {
      add(/** @type {Record<string, unknown>} */ (value)[field]);
      return;
    }
    values.push(value);
  };
  add(outputRecord[field]);
  const metricMatch = field.match(/^(kolOfficialPrice|cpm|cpe)(L[123])$/u);
  if (metricMatch) {
    const prefix = { douyin: "dy", xiaohongshu: "xhs" }[normalizedPlatformName(platform)];
    for (const key of [...(prefix ? [`${prefix}_${metricMatch[1]}`] : []), metricMatch[1]]) {
      const record = outputRecord[key];
      if (record && typeof record === "object" && !Array.isArray(record)) {
        add(/** @type {Record<string, unknown>} */ (record)[field]);
      }
    }
  }
  return values;
}

/**
 * @param {string} field
 * @param {unknown} value
 */
function canonicalizeMetricRange(field, value) {
  if (field === "rebate") return normalizedRebateRange(value);
  if (field === "followercount") return normalizedFollowerRange(value);
  return normalizedNumericRange(value, {
    rate: RATE_RANGE_PARAMS.has(field),
    price: PRICE_RANGE_PARAMS.has(field),
    maximum: MAXIMUM_METRIC_RANGE_PARAMS.has(field),
  });
}

/**
 * @param {unknown} rawMessages
 * @param {string} field
 * @param {unknown} platform
 * @returns {string | null}
 */
function uniqueParsedRange(rawMessages, field, platform) {
  if (!rawMessages || typeof rawMessages !== "object" || Array.isArray(rawMessages)) {
    return null;
  }
  const outputs = /** @type {Record<string, unknown>} */ (rawMessages).parse_outputs;
  const unique = new Set();
  for (const value of collectParsedMetricValues(outputs, field, platform)) {
    const canonical = canonicalizeMetricRange(field, value);
    if (typeof canonical === "string" && parsedCanonicalRange(canonical)) unique.add(canonical);
  }
  return unique.size === 1 ? [...unique][0] : null;
}

/**
 * @param {unknown} rawMessages
 * @param {string} field
 * @param {unknown} submitted
 * @param {unknown} platform
 */
function hasUniqueParsedRangeEvidence(rawMessages, field, submitted, platform) {
  const parsed = uniqueParsedRange(rawMessages, field, platform);
  if (!parsed) return false;
  const submittedRange = canonicalizeMetricRange(field, submitted);
  return parsed === submittedRange;
}

function equivalentMetricValues(left, right) {
  const key = (value) => {
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value));
      } catch {
        return value.trim();
      }
    }
    return JSON.stringify(value);
  };
  return key(left) === key(right);
}

function normalizeParsedDouyinMetrics(params, rawMessages) {
  if (normalizedPlatformName(params.platform) !== "douyin") return params;
  const evidence =
    latestFieldEvidence(rawMessages, [
      "douyinVideoType",
      "videoType",
      "contentType",
      "视频类型",
      "内容形式",
      "形式",
    ]) ?? rawRequirementEvidence(rawMessages);
  const tiers = supportedDouyinVideoTypeTiers(evidence);
  if (tiers.size !== 1) return params;
  const targetTier = [...tiers][0];
  let normalized = params;
  for (const metric of ["kolOfficialPrice", "cpm", "cpe"]) {
    const record = metricOutputRecord(rawMessages, `dy_${metric}`);
    if (!record) continue;
    const candidates = ["L1", "L2", "L3"]
      .map((tier) => ({ tier, value: record[`${metric}${tier}`] }))
      .filter(({ value }) => usableMetricValue(value));
    if (candidates.length !== 1) continue;
    const targetField = `${metric}${targetTier}`;
    if (Object.hasOwn(normalized, targetField)) continue;
    const source = candidates.find(
      ({ tier, value }) =>
        Object.hasOwn(normalized, `${metric}${tier}`) &&
        equivalentMetricValues(normalized[`${metric}${tier}`], value),
    );
    if (normalized === params) normalized = { ...params };
    if (source && source.tier !== targetTier) delete normalized[`${metric}${source.tier}`];
    normalized[targetField] = candidates[0].value;
  }
  return normalized;
}

/**
 * Validate the complete Provider payload after deterministic, lossless boundary
 * normalization. Semantic choices remain the user's responsibility and must be
 * collected before this preflight can pass.
 *
 * @param {unknown} params
 * @param {{ now?: Date }} [options]
 * @returns {Array<{ field: string, reason: string }>}
 */
export function validateRequirementPreflight(params, { now = new Date() } = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return [{ field: "arguments", reason: "必须是完整的顶层对象" }];
  }
  const payload = /** @type {Record<string, unknown>} */ (params);

  const issues = [];
  const add = (field, reason) => {
    if (!issues.some((issue) => issue.field === field)) {
      issues.push({ field, reason });
    }
  };

  for (const field of Object.keys(payload)) {
    if (!VALIDATE_REQUIREMENT_PARAMS.includes(field)) {
      add(field, "不是 validate_requirement 的已声明参数");
    }
  }

  for (const field of missingRequiredValidateParams(payload)) {
    add(
      field,
      field === "contentTag"
        ? "解析结果缺少非空 contentTag；必须重新解析，禁止向用户询问或自行补值"
        : "缺失或为空，必须先向用户确认",
    );
  }
  if (payload.status !== "ready") add("status", '固定传字符串 "ready"');
  if (!["xiaohongshu", "douyin"].includes(String(payload.platform))) {
    add("platform", '只允许字符串 "xiaohongshu" 或 "douyin"');
  }
  if (typeof payload.brandName !== "string" || !payload.brandName.trim()) {
    add("brandName", "必须直接使用当前平台 Dify 解析品牌；解析缺失或多候选时必须弹窗确认");
  }
  if (typeof payload.projectName !== "string" || !payload.projectName.trim()) {
    add(
      "projectName",
      "必须是非空项目名称字符串；项目名由 Agent 根据当前需求自行总结生成，禁止为此弹窗询问用户",
    );
  }
  if (
    typeof payload.quantityTotal !== "string" ||
    !POSITIVE_INTEGER_STRING.test(payload.quantityTotal)
  ) {
    add("quantityTotal", '必须是正整数字符串，例如 "30"');
  }
  if (!isFutureSubmissionDeadline(payload.submissionDeadlineAt, { now })) {
    add("submissionDeadlineAt", "必须是晚于当前时间的 YYYY-MM-DD HH:mm:ss");
  }
  if (!tagArrayValue(payload.contentTag)) {
    add("contentTag", "必须是非空字符串数组");
  }
  const rawMessages = payload.rawMessagesJson;
  // 容器不可读时，依赖它取证的业务值检查只会报“没有证据”的假错误。
  // 这类证据问题暂不报告；其他可独立判断的缺失和格式问题仍照常聚合。
  let rawMessagesReadable = false;
  if (!rawMessages || typeof rawMessages !== "object" || Array.isArray(rawMessages)) {
    add("rawMessagesJson", "必须是包含原始需求与解析输出的 JSON 对象");
  } else {
    const rawRecord = /** @type {Record<string, unknown>} */ (rawMessages);
    if (
      typeof rawRecord.original !== "string" ||
      !rawRecord.original.trim() ||
      !rawRecord.parse_outputs ||
      typeof rawRecord.parse_outputs !== "object" ||
      Array.isArray(rawRecord.parse_outputs)
    ) {
      add("rawMessagesJson", "必须包含非空 original 和本次契约内 parse_outputs 对象");
    } else {
      rawMessagesReadable = true;
    }
    const businessMode = rawRecord.business_mode;
    if (typeof businessMode !== "string" || !PROVIDER_BUSINESS_MODE_VALUES.includes(businessMode)) {
      add("business_mode", '必须是解析前用户选择的 "询价机构" 或 "手动拓展"');
    }
  }
  const addEvidenceIssue = (field, reason) => {
    if (rawMessagesReadable) add(field, reason);
  };

  for (const field of invalidPlatformArrayFields(payload)) {
    add(field, "当前平台要求非空字符串数组");
  }
  for (const field of TAG_ARRAY_PARAMS) {
    if (Object.hasOwn(payload, field) && !tagArrayValue(payload[field])) {
      add(field, "存在时必须是非空字符串数组");
    }
  }

  if (!PRICE_FIELDS.some((field) => Object.hasOwn(payload, field))) {
    add("kolOfficialPriceL1/L2/L3", "至少提供一个与平台内容形式对应的报价区间");
  }
  for (const field of RANGE_PARAMS) {
    if (!Object.hasOwn(payload, field)) continue;
    const range = parsedCanonicalRange(payload[field]);
    if (!range) {
      add(field, '必须是无空格 JSON 区间字符串 "[min,max]"，且 0 ≤ min < max');
      continue;
    }
    if (field === "followercount" && range[1] > MAX_FOLLOWER_COUNT) {
      add(field, `上限不得超过粉丝技术最大值 ${MAX_FOLLOWER_COUNT}`);
    }
    if (field === "rebate" && range[1] !== 1) {
      add(field, '返点表示最低要求，必须使用 "[min,1]"');
    }
    if (MAXIMUM_METRIC_RANGE_PARAMS.has(field) && range[0] !== 0) {
      add(field, 'CPM/CPE 表示最大可接受值，必须使用 "[0,max]"');
    }
    if (RATE_RANGE_PARAMS.has(field) && range[1] > 1) {
      add(field, "比例区间必须位于 0–1");
    }
  }

  const evidence = rawRequirementEvidence(rawMessages);
  const parsedBrand = uniqueParsedBrand(rawMessages, payload.platform);
  const submittedBrand = normalizedBrandCandidate(payload.brandName);
  const clarifiedBrand = clarifiedBrandEvidence(rawMessages);
  const rawMessagesRecord = /** @type {Record<string, unknown>} */ (rawMessages);
  const explicitBrand = explicitBrandFromOriginal(rawMessagesRecord?.original);
  const clarifiedBrandMatches = Boolean(
    submittedBrand &&
    !parsedBrand &&
    clarifiedBrand.present &&
    clarifiedBrand.candidates.length === 1 &&
    clarifiedBrand.candidates[0] === submittedBrand,
  );
  const explicitBrandMatches = Boolean(
    submittedBrand && !parsedBrand && !clarifiedBrand.present && explicitBrand === submittedBrand,
  );
  const parsedBrandMatches = Boolean(submittedBrand && submittedBrand === parsedBrand);
  if (!parsedBrandMatches && !clarifiedBrandMatches && !explicitBrandMatches) {
    addEvidenceIssue(
      "brandName",
      "必须原样使用当前平台唯一 Dify 解析品牌；仅在解析缺失或多候选时使用最新弹窗答案",
    );
  }
  const quantityEvidence =
    latestFieldEvidence(rawMessages, [
      "quantityTotal",
      "数量",
      "达人数量",
      "达人人数",
      "提报数量",
      "提报人数",
    ]) ?? evidence;
  if (!hasQuantityEvidence(quantityEvidence, payload.quantityTotal)) {
    addEvidenceIssue("quantityTotal", "原始需求或弹窗澄清记录中没有与提交值一致的达人数量证据");
  }
  if (
    !hasUniqueParsedRangeEvidence(rawMessages, "rebate", payload.rebate, payload.platform) &&
    !/(?:返点|返佣|佣金|rebate)/iu.test(evidence)
  ) {
    addEvidenceIssue("rebate", "原始需求或弹窗澄清记录中没有返点证据，且 Dify 未给出唯一返点区间");
  }
  const hasParsedPrice = PRICE_FIELDS.some(
    (field) =>
      Object.hasOwn(payload, field) &&
      hasUniqueParsedRangeEvidence(rawMessages, field, payload[field], payload.platform),
  );
  if (!hasParsedPrice && !/(?:单价|报价|预算|费用|价格|kolOfficialPrice)/iu.test(evidence)) {
    addEvidenceIssue(
      "kolOfficialPriceL1/L2/L3",
      "原始需求或弹窗澄清记录中没有报价证据，且 Dify 未给出唯一报价区间",
    );
  }
  const deadlineEvidence =
    latestFieldEvidence(rawMessages, [
      "submissionDeadlineAt",
      "提报截止",
      "提报截止时间",
      "截止时间",
    ]) ?? evidence;
  if (!hasSubmissionDeadlineEvidence(deadlineEvidence, payload.submissionDeadlineAt, now)) {
    addEvidenceIssue(
      "submissionDeadlineAt",
      "原始需求或弹窗澄清记录中没有与提交值一致的明确截止时间证据",
    );
  }
  if (
    payload.platform === "douyin" &&
    DOUYIN_VIDEO_TYPE_METRIC_FIELDS.some((field) => Object.hasOwn(payload, field))
  ) {
    for (const field of ["kolOfficialPriceL1", "cpmL1", "cpeL1"]) {
      if (Object.hasOwn(payload, field)) {
        add(field, "抖音报价、CPM 和 CPE 不再使用 L1；L2 表示植入视频，L3 表示定制视频");
      }
    }
    const videoTypeEvidence =
      latestFieldEvidence(rawMessages, [
        "douyinVideoType",
        "videoType",
        "contentType",
        "视频类型",
        "内容形式",
        "形式",
      ]) ?? evidence;
    const supportedTiers = supportedDouyinVideoTypeTiers(videoTypeEvidence);
    const mismatchedFields = DOUYIN_VIDEO_TYPE_METRIC_FIELDS.filter(
      (field) =>
        !field.endsWith("L1") &&
        Object.hasOwn(payload, field) &&
        !supportedTiers.has(field.slice(-2)),
    );
    if (mismatchedFields.length > 0) {
      addEvidenceIssue(
        "douyinVideoType",
        `抖音报价、CPM 或 CPE 字段与明确视频类型不匹配（${mismatchedFields.join(",")}）；L2 仅表示植入视频，L3 仅表示定制视频`,
      );
    }
  }
  if (payload.platform === "xiaohongshu") {
    for (const field of ["kolOfficialPriceL3", "cpmL3", "cpeL3"]) {
      if (Object.hasOwn(payload, field)) add(field, "小红书不支持 L3 档位");
    }
  }

  for (const field of ["projectStartStart", "projectStartEnd"]) {
    if (!Object.hasOwn(payload, field)) continue;
    const fieldEvidence =
      latestFieldEvidence(
        rawMessages,
        field === "projectStartStart"
          ? [field, "项目开始", "项目开始时间", "档期开始"]
          : [field, "项目结束", "项目结束时间", "档期结束"],
      ) ?? evidence;
    if (!isCanonicalProjectDate(payload[field])) {
      add(field, "只能传明确的 YYYY-MM-DD 或 ISO 本地日期时间；模糊档期必须弹窗确认或省略");
    } else if (!hasProjectDateEvidence(fieldEvidence, payload[field])) {
      addEvidenceIssue(field, "原始需求或弹窗澄清记录中没有对应的明确项目日期证据");
    }
  }
  const projectStart = projectDateTimestamp(payload.projectStartStart);
  const projectEnd = projectDateTimestamp(payload.projectStartEnd);
  if (Number.isFinite(projectStart) && Number.isFinite(projectEnd) && projectStart > projectEnd) {
    add("projectStartStart/projectStartEnd", "项目开始时间不能晚于结束时间");
  }

  for (const field of STRING_VALIDATE_PARAMS) {
    if (Object.hasOwn(payload, field) && typeof payload[field] !== "string") {
      add(field, "必须是字符串");
    }
  }
  for (const field of STRING_BOOLEAN_PARAMS) {
    const value = payload[field];
    if (
      Object.hasOwn(payload, field) &&
      (typeof value !== "string" || !["true", "false"].includes(value))
    ) {
      add(field, '必须是字符串 "true" 或 "false"');
    }
  }

  return issues;
}

export function normalizeToolCallParams(toolName, params, { now = new Date() } = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const bare = stripHostPrefix(typeof toolName === "string" ? toolName.toLowerCase() : toolName);
  // 本地工具原本不进入 Provider 参数归一化；保持该边界，只归一化业务工具。
  if (!bare || !Object.hasOwn(TOOL_REGISTRY, bare)) return params;

  let normalized =
    bare === "validate_requirement"
      ? normalizePlatformArrayFields(normalizeValidateRequirementTagArrays(params))
      : params;
  const set = (name, value) => {
    if (normalized[name] === value) return;
    if (normalized === params) normalized = { ...params };
    normalized[name] = value;
  };

  if (bare === "validate_requirement") {
    for (const [name, value] of Object.entries(normalized)) {
      if (
        VALIDATE_REQUIREMENT_PARAMS.includes(name) &&
        !REQUIRED_VALIDATE_PARAMS.has(name) &&
        (value === null || (typeof value === "string" && value.trim().toLowerCase() === "null"))
      ) {
        if (normalized === params) normalized = { ...params };
        delete normalized[name];
      }
    }
  }

  if (typeof normalized.platform === "string") {
    const platform = normalized.platform.trim();
    const alias =
      bare === "validate_requirement"
        ? ["xiaohongshu", "douyin"].includes(platform)
          ? platform
          : null
        : bare === "get_creator_detail"
          ? ({ xiaohongshu: "xhs", xhs: "xhs", douyin: "dy", dy: "dy", 小红书: "xhs", 抖音: "dy" }[
              platform.toLowerCase()
            ] ?? { 小红书: "xhs", 抖音: "dy" }[platform])
          : (PLATFORM_ALIASES[platform.toLowerCase()] ?? PLATFORM_ALIASES[platform]);
    if (alias) set("platform", alias);
  }

  if (bare === "validate_requirement") {
    if (normalized.status === undefined || normalized.status === null || normalized.status === "") {
      set("status", "ready");
    }
    if (Object.hasOwn(normalized, "brandName")) {
      set("brandName", normalizedBrandName(normalized.brandName));
    }
    if (Object.hasOwn(normalized, "rawMessagesJson")) {
      const rawMessages = normalizedRawMessages(normalized.rawMessagesJson);
      set("rawMessagesJson", rawMessages);
      for (const [field, value] of Object.entries(
        parsedTagArrays(rawMessages, normalized.platform),
      )) {
        if (!Object.hasOwn(normalized, field)) set(field, value);
      }
      if (rawMessages && typeof rawMessages === "object" && !Array.isArray(rawMessages)) {
        const parsedBrand = uniqueParsedBrand(
          rawMessages,
          normalizedPlatformName(normalized.platform),
        );
        if (parsedBrand) set("brandName", parsedBrand);
        else if (!Object.hasOwn(normalized, "brandName")) {
          const clarifiedBrand = clarifiedBrandEvidence(rawMessages);
          if (clarifiedBrand.candidates.length === 1)
            set("brandName", clarifiedBrand.candidates[0]);
          else {
            const explicitBrand = explicitBrandFromOriginal(rawMessages.original);
            if (explicitBrand) set("brandName", explicitBrand);
          }
        }
        for (const field of PARSED_RANGE_FIELDS) {
          if (
            Object.hasOwn(normalized, field) &&
            normalized[field] !== undefined &&
            normalized[field] !== null &&
            normalized[field] !== ""
          ) {
            continue;
          }
          const parsed = uniqueParsedRange(rawMessages, field, normalized.platform);
          if (parsed) set(field, parsed);
        }
        normalized = normalizeParsedDouyinMetrics(normalized, rawMessages);
      }
    }
    if (
      normalized.followercount === undefined ||
      normalized.followercount === null ||
      normalized.followercount === ""
    ) {
      // 用户未明确粉丝数或明确“不限”时默认落库全量区间，不省略字段、不弹窗。
      set("followercount", UNRESTRICTED_FOLLOWERCOUNT_RANGE);
    }
    const normalizedQuantity = normalizedQuantityTotal(normalized.quantityTotal);
    if (normalizedQuantity !== null) {
      set("quantityTotal", normalizedQuantity);
    } else if (Object.hasOwn(normalized, "quantityTotal")) {
      if (normalized === params) normalized = { ...params };
      delete normalized.quantityTotal;
    }
    for (const name of RANGE_PARAMS) {
      if (!Object.hasOwn(normalized, name)) continue;
      set(
        name,
        name === "rebate"
          ? normalizedRebateRange(normalized[name])
          : name === "followercount"
            ? normalizedFollowerRange(normalized[name])
            : normalizedNumericRange(normalized[name], {
                rate: RATE_RANGE_PARAMS.has(name),
                price: PRICE_RANGE_PARAMS.has(name),
                maximum: MAXIMUM_METRIC_RANGE_PARAMS.has(name),
              }),
      );
    }
    if (Object.hasOwn(normalized, "submissionDeadlineAt")) {
      const normalizedDeadline = normalizedDateTime(normalized.submissionDeadlineAt, { now });
      if (isFutureSubmissionDeadline(normalizedDeadline, { now })) {
        set("submissionDeadlineAt", normalizedDeadline);
      }
    }
  }

  return normalized;
}

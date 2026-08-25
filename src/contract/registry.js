/**
 * Small argument-normalization boundary shared by Provider-facing flows.
 * validate_requirement also uses this module for a stateless, pre-write
 * completeness and canonical-format gate; it does not retain workflow state.
 */

export const UNRESTRICTED_FOLLOWERCOUNT_RANGE = "[0,999999999]";

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
  "create_with_distributions",
  "sync_mcn_inquiry_status",
  "ingest_mcn_submissions",
  "get_ingest_job",
  "manual_source_creators",
  "rank_creators",
  "get_creator_detail",
  "get_creator_detail_export",
  "get_workflow_state",
  "create_submission_batch",
]);

export const TOOL_REGISTRY = Object.freeze(Object.fromEntries(
  BUSINESS_TOOL_NAMES.map((name) => [name, true]),
));

export const VALIDATE_REQUIREMENT_PARAMS = Object.freeze([
  "id",
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

const MAXIMUM_METRIC_RANGE_PARAMS = new Set([
  "cpeL1",
  "cpeL2",
  "cpeL3",
  "cpmL1",
  "cpmL2",
  "cpmL3",
]);

const PLATFORM_REQUIRED_TAG_FIELDS = Object.freeze({
  xiaohongshu: [
    "contentFeatureLabel",
    "growBloggerTypeLabel",
    "kolPersonaLabel",
    "pgyBloggerTypeLabel",
  ],
  douyin: [
    "contentThemeLabel",
    "growTalentTypeLabel",
    "industryTagLabel",
    "xtTalentTypeLabel",
  ],
});

const PLATFORM_ARRAY_FIELD_PARAMS = Object.freeze({
  xiaohongshu: ["contentTag", ...PLATFORM_REQUIRED_TAG_FIELDS.xiaohongshu],
  douyin: ["contentTag", ...PLATFORM_REQUIRED_TAG_FIELDS.douyin],
});

const NUMERIC_TIER_FIELDS = Object.freeze([
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

const PRICE_FIELDS = Object.freeze([
  "kolOfficialPriceL1",
  "kolOfficialPriceL2",
  "kolOfficialPriceL3",
]);

const PLATFORM_ALIASES = Object.freeze({
  xiaohongshu: "xiaohongshu",
  xhs: "xiaohongshu",
  "小红书": "xiaohongshu",
  douyin: "douyin",
  dy: "douyin",
  "抖音": "douyin",
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
  if (typeof value === "string") return value.trim();
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
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
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
    return JSON.stringify([
      Math.floor(normalized[0] * 0.7),
      Math.ceil(normalized[1] * 1.2),
    ]);
  }
  return JSON.stringify(normalized);
}

function normalizedFollowerRange(value) {
  if (
    typeof value === "string" &&
    /^(?:无(?:要求)?|不限|不限制|无限制|都可以|均可)$/u.test(value.trim())
  ) {
    return UNRESTRICTED_FOLLOWERCOUNT_RANGE;
  }
  const normalized = normalizedNumericRange(value);
  if (normalized !== value || typeof value !== "string") return normalized;
  const match = value.trim().match(
    /^(\d+(?:\.\d+)?)\s*(?:-|~|～|至|到)\s*(\d+(?:\.\d+)?)$/u,
  );
  if (!match) return value;
  const lower = Number(match[1]);
  const upper = Number(match[2]);
  return lower <= upper ? JSON.stringify([lower, upper]) : value;
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
          Array.isArray(parsed) && parsed.length === 2 &&
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
  return minimum >= 0 && minimum <= 1
    ? JSON.stringify([minimum, 1])
    : value;
}

function briefUnrestrictsFollowers(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const compact = value.replace(/[ \t]/gu, "");
  return /粉丝(?:数|量|量级)?[^\n。；;]{0,20}要求[:：]?(?:无(?:要求)?|不限|不限制|无限制)(?=$|[\n，,。；;])/u.test(compact) ||
    /(?:无|没有|不限|不限制)(?:任何)?粉丝(?:数|量|量级)?要求/u.test(compact);
}

function parseLocalDateTime(value) {
  if (typeof value !== "string") return Number.NaN;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u,
  );
  if (!match) return Number.NaN;
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
  ] = match;
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

function normalizedDateTime(value, { now = new Date() } = {}) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u,
  );
  if (!match) return trimmed;
  const normalized = `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6] ?? "00"}`;
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
        Array.isArray(parsed) && parsed.length > 0 &&
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

export function stripHostPrefix(toolName) {
  if (typeof toolName !== "string") return null;
  const normalized = toolName.trim().toLowerCase();
  if (Object.hasOwn(TOOL_REGISTRY, normalized)) return normalized;
  for (const bare of BUSINESS_TOOL_NAMES) {
    const suffix = `__${bare}`;
    if (!normalized.endsWith(suffix)) continue;
    const prefix = normalized.slice(0, -suffix.length);
    if (/^[a-z0-9_-]+(?:__[a-z0-9_-]+)*$/u.test(prefix)) return bare;
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
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim())
    ? value
    : null;
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
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  });

  const platform = normalizedPlatformName(params.platform);
  for (const field of PLATFORM_REQUIRED_TAG_FIELDS[platform] ?? []) {
    if (!tagArrayValue(params[field])) missing.push(field);
  }
  return missing;
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
  /^(?:null|undefined|unknown|n\/?a|none|未知|未明确|未提及|未提供|暂无|无|不详|待确认|待定)$/iu;

function normalizedBrandCandidate(value) {
  if (typeof value !== "string") return null;
  const candidate = value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
    .trim();
  return candidate && !INVALID_BRAND_CANDIDATE.test(candidate) ? candidate : null;
}

function uniqueDifyBrand(value, platform) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawMessages = /** @type {Record<string, unknown>} */ (value);
  const outputs = rawMessages.parse_outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return null;
  const outputRecord = /** @type {Record<string, unknown>} */ (outputs);
  const field =
    platform === "xiaohongshu" ? "xhsbrandName" : platform === "douyin" ? "dybrandName" : null;
  if (!field) return null;
  const rawCandidates = outputRecord[field];
  const values = Array.isArray(rawCandidates) ? rawCandidates : [rawCandidates];
  const candidates = [
    ...new Set(
      values
        .map(normalizedBrandCandidate)
        .filter(Boolean),
    ),
  ];
  return candidates.length === 1 ? candidates[0] : null;
}

function explicitBrandEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { present: false, candidates: [] };
  }
  const rawMessages = /** @type {Record<string, unknown>} */ (value);
  const clarification = latestScalarClarification(value, ["brandName", "品牌", "品牌名称"]);
  if (clarification) {
    const labeled = clarification.text.match(
      /^(?:品牌(?:名称)?|brandName)\s*[:：=]\s*([^；;，,。\n]+)/iu,
    );
    const candidate = normalizedBrandCandidate(labeled?.[1] ?? clarification.text);
    return { present: true, candidates: candidate ? [candidate] : [] };
  }
  const values = [];
  let present = false;
  if (typeof rawMessages.original === "string") {
    for (const match of rawMessages.original.matchAll(
      /(?:品牌(?:名称)?|brandName)\s*[:：=]\s*([^；;，,。\n]+)/giu,
    )) {
      present = true;
      const candidate = normalizedBrandCandidate(match[1]);
      if (candidate) values.push(candidate);
    }
  }
  return { present, candidates: [...new Set(values)] };
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

function hasLabeledLiteralEvidence(evidence, value, labels) {
  if (typeof value !== "string" || value.trim() === "") return false;
  return new RegExp(
    `(?:${labels})[^。；;\\n]{0,24}${regexLiteral(value.trim())}`,
    "iu",
  ).test(evidence);
}

function hasQuantityEvidence(evidence, value) {
  if (typeof value !== "string" || !POSITIVE_INTEGER_STRING.test(value)) return false;
  const quantity = regexLiteral(value);
  return new RegExp(
    `(?:数量|提报(?:数量|人数)?|达人(?:数量|人数)?|quantityTotal)[^\\d]{0,12}${quantity}(?!\\d)|(?<!\\d)${quantity}\\s*(?:位|名|个)(?:达人|博主)?`,
    "iu",
  ).test(evidence);
}

function hasSubmissionDeadlineEvidence(evidence, value, now) {
  if (typeof value !== "string" || !Number.isFinite(parseLocalDateTime(value))) return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u,
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (evidence.includes(value)) return true;
  const minutePrecision = `${year}-${month}-${day} ${hour}:${minute}`;
  if (Number(second) === 0 && new RegExp(`${regexLiteral(minutePrecision)}(?!:)`, "u").test(evidence)) {
    return true;
  }
  const chineseDateTime = `${Number(year)}年${Number(month)}月${Number(day)}日${Number(hour)}点${Number(minute) ? `${Number(minute)}分` : ""}`;
  const chinesePattern = Number(second) === 0
    ? `${regexLiteral(chineseDateTime)}(?:0秒)?`
    : `${regexLiteral(chineseDateTime)}${Number(second)}秒`;
  if (new RegExp(chinesePattern, "u").test(evidence)) return true;

  const sameDay =
    Number(year) === now.getFullYear() &&
    Number(month) === now.getMonth() + 1 &&
    Number(day) === now.getDate();
  if (!sameDay || Number(second) !== 0) return false;
  const clock = `${Number(hour)}\\s*(?:点|时)${Number(minute) ? `\\s*${Number(minute)}\\s*分` : ""}`;
  return new RegExp(
    `(?:今天|今日)[^。；;\\n]{0,20}${clock}[^。；;\\n]{0,20}(?:提报|提交|反馈|截止)`,
    "u",
  ).test(evidence);
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
  return datePatterns.some((datePattern) =>
    new RegExp(`${context}[^。；;\\n]{0,80}${datePattern}`, "iu").test(evidence),
  );
}

function durationTier(seconds) {
  if (seconds <= 0) return null;
  if (seconds <= 20) return "L1";
  if (seconds <= 60) return "L2";
  return "L3";
}

function supportedDouyinDurationTiers(evidence) {
  const tiers = new Set();
  let remaining = evidence.replace(
    /(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*(?:-|–|—|~|～|至|到)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/giu,
    (_match, lowerText, upperText) => {
      const lowerTier = durationTier(Number(lowerText));
      const upperTier = durationTier(Number(upperText));
      if (lowerTier && lowerTier === upperTier) tiers.add(lowerTier);
      return " ";
    },
  );
  remaining = remaining.replace(
    /(\d+(?:\.\d+)?)\s*(?:秒|s)\s*(?:以上|及以上|\+)/giu,
    (_match, lowerText) => {
      if (Number(lowerText) >= 60) tiers.add("L3");
      return " ";
    },
  );
  for (const match of remaining.matchAll(/(\d+(?:\.\d+)?)\s*(?:秒|s)/giu)) {
    const tier = durationTier(Number(match[1]));
    if (tier) tiers.add(tier);
  }
  for (const match of evidence.matchAll(/douyinDuration[^。；;\n]{0,20}\b(L[123])\b/giu)) {
    tiers.add(match[1].toUpperCase());
  }
  return tiers;
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

  for (const field of missingRequiredValidateParams(payload)) {
    add(field, "缺失或为空，必须先向用户确认");
  }
  if (payload.status !== "ready") add("status", '固定传字符串 "ready"');
  if (!["xiaohongshu", "douyin"].includes(String(payload.platform))) {
    add("platform", '只允许字符串 "xiaohongshu" 或 "douyin"');
  }
  if (typeof payload.brandName !== "string" || !payload.brandName.trim()) {
    add("brandName", "必须是唯一明确的非空品牌字符串；多候选必须弹窗确认");
  }
  if (typeof payload.projectName !== "string" || !payload.projectName.trim()) {
    add("projectName", "必须是非空项目名称字符串");
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
      add("rawMessagesJson", "必须包含非空 original 和完整 parse_outputs 对象");
    }
  }

  for (const field of invalidPlatformArrayFields(payload)) {
    add(field, "当前平台要求非空字符串数组");
  }
  for (const field of TAG_ARRAY_PARAMS) {
    if (Object.hasOwn(payload, field) && !tagArrayValue(payload[field])) {
      add(field, "存在时必须是非空字符串数组");
    }
  }

  if (!PRICE_FIELDS.some((field) => Object.hasOwn(payload, field))) {
    add("kolOfficialPriceL1/L2/L3", "至少提供一个与平台内容形式或时长对应的报价区间");
  }
  for (const field of RANGE_PARAMS) {
    if (!Object.hasOwn(payload, field)) continue;
    const range = parsedCanonicalRange(payload[field]);
    if (!range) {
      add(field, '必须是无空格 JSON 区间字符串 "[min,max]"，且 0 ≤ min < max');
      continue;
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
  const difyBrand = uniqueDifyBrand(rawMessages, payload.platform);
  const submittedBrand = normalizedBrandCandidate(payload.brandName);
  const explicitBrand = explicitBrandEvidence(rawMessages);
  const explicitBrandMatches = Boolean(
    submittedBrand &&
    explicitBrand.present &&
    explicitBrand.candidates.length === 1 &&
    explicitBrand.candidates[0] === submittedBrand,
  );
  const difyBrandMatches = Boolean(
    submittedBrand && !explicitBrand.present && submittedBrand === difyBrand,
  );
  if (!explicitBrandMatches && !difyBrandMatches) {
    add("brandName", "原始需求、弹窗澄清或当前平台 Dify 唯一候选中没有与提交值一致的品牌证据");
  }
  const projectNameEvidence =
    latestFieldEvidence(rawMessages, ["projectName", "项目", "项目名称"]) ?? evidence;
  if (!hasLabeledLiteralEvidence(projectNameEvidence, payload.projectName, "项目(?:名称)?|projectName")) {
    add("projectName", "原始需求或弹窗澄清记录中没有与提交值一致的项目名称证据");
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
    add("quantityTotal", "原始需求或弹窗澄清记录中没有与提交值一致的达人数量证据");
  }
  if (!/(?:粉丝|万粉|w粉|followercount)/iu.test(evidence)) {
    add("followercount", "原始需求或弹窗澄清记录中没有粉丝量证据，禁止接受 Dify 默认值");
  }
  if (!/(?:返点|返佣|佣金|rebate)/iu.test(evidence)) {
    add("rebate", "原始需求或弹窗澄清记录中没有返点证据，禁止接受 Dify 默认值");
  }
  if (!/(?:单价|报价|预算|费用|价格|kolOfficialPrice)/iu.test(evidence)) {
    add("kolOfficialPriceL1/L2/L3", "原始需求或弹窗澄清记录中没有报价证据");
  }
  const deadlineEvidence =
    latestFieldEvidence(rawMessages, [
      "submissionDeadlineAt",
      "提报截止",
      "提报截止时间",
      "截止时间",
    ]) ?? evidence;
  if (!hasSubmissionDeadlineEvidence(deadlineEvidence, payload.submissionDeadlineAt, now)) {
    add("submissionDeadlineAt", "原始需求或弹窗澄清记录中没有与提交值一致的明确截止时间证据");
  }
  if (
    payload.platform === "douyin" &&
    NUMERIC_TIER_FIELDS.some((field) => Object.hasOwn(payload, field))
  ) {
    const supportedTiers = supportedDouyinDurationTiers(evidence);
    const mismatchedFields = NUMERIC_TIER_FIELDS.filter((field) => {
      if (!Object.hasOwn(payload, field)) return false;
      return !supportedTiers.has(field.slice(-2));
    });
    if (mismatchedFields.length > 0) {
      add(
        "douyinDuration",
        `抖音报价、CPM 或 CPE 档位与明确时长不匹配（${mismatchedFields.join(",")}），必须弹窗确认`,
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
      add(field, "原始需求或弹窗澄清记录中没有对应的明确项目日期证据");
    }
  }
  const projectStart = projectDateTimestamp(payload.projectStartStart);
  const projectEnd = projectDateTimestamp(payload.projectStartEnd);
  if (Number.isFinite(projectStart) && Number.isFinite(projectEnd) && projectStart > projectEnd) {
    add("projectStartStart/projectStartEnd", "项目开始时间不能晚于结束时间");
  }

  return issues;
}

export function normalizeToolCallParams(toolName, params, { now = new Date() } = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const bare = stripHostPrefix(typeof toolName === "string" ? toolName.toLowerCase() : toolName);
  if (!bare) return params;

  let normalized = bare === "validate_requirement"
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
    const alias = bare === "validate_requirement"
      ? (["xiaohongshu", "douyin"].includes(platform) ? platform : null)
      : bare === "get_creator_detail"
        ? ({ xiaohongshu: "xhs", xhs: "xhs", douyin: "dy", dy: "dy", "小红书": "xhs", "抖音": "dy" }[platform.toLowerCase()] ??
          { "小红书": "xhs", "抖音": "dy" }[platform])
        : PLATFORM_ALIASES[platform.toLowerCase()] ?? PLATFORM_ALIASES[platform];
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
      set("rawMessagesJson", normalizedRawMessages(normalized.rawMessagesJson));
    }
    if (
      (normalized.followercount === undefined || normalized.followercount === null || normalized.followercount === "") &&
      briefUnrestrictsFollowers(normalized.originalBrief)
    ) {
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
      set(name, name === "rebate"
        ? normalizedRebateRange(normalized[name])
        : name === "followercount"
          ? normalizedFollowerRange(normalized[name])
          : normalizedNumericRange(normalized[name], {
            rate: RATE_RANGE_PARAMS.has(name),
            price: PRICE_RANGE_PARAMS.has(name),
            maximum: MAXIMUM_METRIC_RANGE_PARAMS.has(name),
          }));
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

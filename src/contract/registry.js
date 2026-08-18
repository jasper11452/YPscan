/**
 * Small argument-normalization boundary shared by the confirmation Hook.
 * Workflow gates, evidence extractors, readiness probes, and retry policy used
 * to live here; those responsibilities were removed with the local ledger.
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

const RANGE_PARAMS = Object.freeze([
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

const PLATFORM_ALIASES = Object.freeze({
  xiaohongshu: "xiaohongshu",
  xhs: "xiaohongshu",
  "小红书": "xiaohongshu",
  douyin: "douyin",
  dy: "douyin",
  "抖音": "douyin",
});

function normalizedNumericRange(value, { rate = false, price = false } = {}) {
  let parsed = value;
  let percentNotation = false;
  let rawNumericInput = false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const singlePercent = trimmed.match(/^(\d+(?:\.\d+)?)%$/u);
    const range = trimmed.match(
      /^(\d+(?:\.\d+)?)\s*(%)?\s*(?:-|~|～|至|到)\s*(\d+(?:\.\d+)?)\s*(%)?$/u,
    );
    if (singlePercent) {
      parsed = [Number(singlePercent[1]), Number(singlePercent[1])];
      percentNotation = true;
      rawNumericInput = true;
    } else if (range) {
      parsed = [Number(range[1]), Number(range[3])];
      percentNotation = Boolean(range[2] || range[4]);
      rawNumericInput = true;
    } else if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
      parsed = [Number(trimmed), Number(trimmed)];
      rawNumericInput = true;
    } else {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
  } else if (typeof value === "number" && Number.isFinite(value)) {
    parsed = [value, value];
    rawNumericInput = true;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !parsed.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return value;
  }
  if (parsed[0] > parsed[1]) return value;
  const normalized = rate
    ? parsed.map((item) => (percentNotation || item > 1 ? item / 100 : item))
    : parsed;
  if (price && rawNumericInput) {
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
    const range = trimmed.match(
      /^(\d+(?:\.\d+)?)\s*%?\s*(?:-|~|～|至|到)\s*(\d+(?:\.\d+)?)\s*%?$/u,
    );
    if (percent) {
      minimum = Number(percent[1]) / 100;
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

function normalizedDateTime(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?$/u,
  );
  return match ? `${match[1]}:00${match[2] ?? ""}` : trimmed;
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
      // Keep invalid values untouched so the Provider can report the error.
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

export function normalizeToolCallParams(toolName, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const bare = stripHostPrefix(typeof toolName === "string" ? toolName.toLowerCase() : toolName);
  if (!bare) return params;

  let normalized = bare === "validate_requirement"
    ? normalizeValidateRequirementTagArrays(params)
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
    if (
      (normalized.followercount === undefined || normalized.followercount === null || normalized.followercount === "") &&
      briefUnrestrictsFollowers(normalized.originalBrief)
    ) {
      set("followercount", UNRESTRICTED_FOLLOWERCOUNT_RANGE);
    }
    if (Number.isSafeInteger(normalized.quantityTotal) && normalized.quantityTotal > 0) {
      set("quantityTotal", String(normalized.quantityTotal));
    } else if (typeof normalized.quantityTotal === "string") {
      set("quantityTotal", normalized.quantityTotal.trim());
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
          }));
    }
    for (const name of ["submissionDeadlineAt"]) {
      if (Object.hasOwn(normalized, name)) set(name, normalizedDateTime(normalized[name]));
    }
  }

  return normalized;
}

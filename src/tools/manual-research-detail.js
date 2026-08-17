import { checkCandidatePrice, parseManualPrice } from "./manual-research-price-check.js";

const DETAIL_REVIEW_BATCH_SIZE = 20;

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function candidateReference(candidate) {
  if (candidate?.platform_id) return String(candidate.platform_id);
  if (candidate?.detail_url) return String(candidate.detail_url);
  const branch = candidate?.source_branches?.[0] ?? "unknown";
  const page = candidate?.source_pages?.[0] ?? "unknown";
  return `${candidate?.platform ?? "unknown"}:nickname:${clean(candidate?.nickname)}:${branch}:${page}`;
}

export function detailQueueLimit(plan) {
  return plan.target_count ? plan.target_count * 2 : 40;
}

export function detailGroupsForPlan(plan) {
  const groups = new Set(["summary", "recent_content"]);
  for (const filter of plan.filters ?? []) {
    if (String(filter.control).startsWith("audience_")) groups.add("audience");
    if (["cpm", "cpe", "interaction_rate"].includes(filter.control)) {
      groups.add("performance");
    }
  }
  for (const item of plan.unexpressed ?? []) {
    if (/growth|涨粉|粉丝增长/iu.test(`${item.fact_kind ?? ""} ${item.source?.quote ?? ""}`)) {
      groups.add("growth");
    }
  }
  return [...groups];
}

function numericText(raw) {
  return clean(raw)
    .replace(/[¥￥$元,，]/gu, "")
    .replace(/\+$/u, "");
}

export function parseDetailCount(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  const value = numericText(raw).toLowerCase();
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s*(亿|千万|百万|万|w|k)?(?:人|次|个)?$/iu);
  if (!match) return null;
  const multiplier = {
    亿: 100_000_000,
    千万: 10_000_000,
    百万: 1_000_000,
    万: 10_000,
    w: 10_000,
    k: 1_000,
  }[match[2]?.toLowerCase()] ?? 1;
  const result = Number(match[1]) * multiplier;
  return Number.isFinite(result) ? result : null;
}

export function parseDetailNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const value = numericText(raw);
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function parseDetailRatio(raw) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return Math.abs(raw) > 1 ? raw / 100 : raw;
  }
  const value = clean(raw);
  const percent = value.match(/(-?\d+(?:\.\d+)?)\s*%/u);
  if (percent) return Number(percent[1]) / 100;
  const result = parseDetailNumber(value);
  if (result === null) return null;
  return Math.abs(result) > 1 ? result / 100 : result;
}

function nonEmpty(value) {
  return value !== null && value !== undefined && value !== "";
}

/** @param {Record<string, any>} [fields] */
export function normalizeDetailFields(fields = {}) {
  /** @type {Record<string, any>} */
  const normalized = { ...fields };
  /** @type {Array<[string, string, (raw: any) => number|null]>} */
  const numericMappings = [
    ["followers", "followers_raw", parseDetailCount],
    ["price_picture", "price_picture_raw", parseManualPrice],
    ["price_video", "price_video_raw", parseManualPrice],
    ["cpm", "cpm_raw", parseDetailNumber],
    ["cpe", "cpe_raw", parseDetailNumber],
    ["expected_views", "expected_views_raw", parseDetailCount],
    ["read_median", "read_median_raw", parseDetailCount],
    ["interaction_median", "interaction_median_raw", parseDetailCount],
    ["daily_read_median", "daily_read_median_raw", parseDetailCount],
    ["daily_interaction_median", "daily_interaction_median_raw", parseDetailCount],
    ["sponsored_read_median", "sponsored_read_median_raw", parseDetailCount],
    ["sponsored_interaction_median", "sponsored_interaction_median_raw", parseDetailCount],
  ];
  for (const [target, source, parser] of numericMappings) {
    if (!nonEmpty(normalized[target]) && nonEmpty(normalized[source])) {
      normalized[target] = parser(normalized[source]);
    }
  }
  const ratioMappings = [
    ["interaction_rate", "interaction_rate_raw"],
    ["audience_male_rate", "audience_male_rate_raw"],
    ["audience_female_rate", "audience_female_rate_raw"],
    ["audience_age_18_23_rate", "audience_age_18_23_rate_raw"],
    ["audience_age_24_30_rate", "audience_age_24_30_rate_raw"],
    ["audience_age_31_40_rate", "audience_age_31_40_rate_raw"],
    ["discovery_rate", "discovery_rate_raw"],
    ["search_rate", "search_rate_raw"],
  ];
  for (const [target, source] of ratioMappings) {
    if (!nonEmpty(normalized[target]) && nonEmpty(normalized[source])) {
      normalized[target] = parseDetailRatio(normalized[source]);
    }
  }
  if (normalized.price_by_tier && typeof normalized.price_by_tier === "object") {
    normalized.price_by_tier = Object.fromEntries(
      Object.entries(normalized.price_by_tier).map(([key, value]) => [
        key,
        { raw: typeof value === "object" ? value.raw : value, value: parseManualPrice(value?.raw ?? value) },
      ]),
    );
  }
  normalized.tags = [...new Set((normalized.tags ?? []).map(clean).filter(Boolean))];
  normalized.audience_cities = [
    ...new Set((normalized.audience_cities ?? []).map(clean).filter(Boolean)),
  ];
  normalized.recent_content = (normalized.recent_content ?? []).slice(0, 3);
  return normalized;
}

function rangeVerdict(value, filter) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "unknown";
  const numeric = Number(value);
  if (filter.min !== null && filter.min !== undefined && numeric < filter.min) return "fail";
  if (filter.max !== null && filter.max !== undefined && numeric > filter.max) return "fail";
  return "pass";
}

function optionVerdict(actualValues, expectedValues) {
  const actual = (Array.isArray(actualValues) ? actualValues : [actualValues])
    .map(clean)
    .filter(Boolean);
  if (!actual.length) return "unknown";
  const expected = (expectedValues ?? []).map(clean).filter(Boolean);
  if (!expected.length) return "pass";
  return expected.some((wanted) =>
    actual.some((value) => value === wanted || value.includes(wanted) || wanted.includes(value)),
  )
    ? "pass"
    : "fail";
}

function priceForPlan(candidate, fields, plan) {
  const tierPrice = fields.price_by_tier?.[plan.price_view];
  if (tierPrice && (tierPrice.raw || tierPrice.value !== null)) {
    return { raw: tierPrice.raw ?? tierPrice.value, tier: plan.price_view };
  }
  if (plan.platform === "pgy") {
    const picture = /图文/u.test(plan.price_view ?? "");
    const raw = picture ? fields.price_picture_raw : fields.price_video_raw;
    if (nonEmpty(raw)) return { raw, tier: plan.price_view };
  }
  return { raw: candidate.price_raw, tier: candidate.quote_tier };
}

function valueForFilter(candidate, fields, filter) {
  const textTags = [candidate.content_type, fields.content_type, ...(candidate.tags ?? []), ...(fields.tags ?? [])];
  switch (filter.control) {
    case "follower_count":
      return fields.followers ?? parseDetailCount(fields.followers_raw ?? candidate.followers_raw);
    case "cpm":
      return fields.cpm ?? parseDetailNumber(fields.cpm_raw ?? candidate.cpm_raw);
    case "cpe":
      return fields.cpe ?? parseDetailNumber(fields.cpe_raw ?? candidate.cpe_raw);
    case "interaction_rate":
      return fields.interaction_rate ?? parseDetailRatio(fields.interaction_rate_raw ?? candidate.interaction_rate);
    case "creator_gender":
      return fields.creator_gender ?? candidate.creator_gender;
    case "creator_city":
      return fields.city ?? candidate.city;
    case "creator_type":
    case "creator_persona":
    case "creator_category":
      return textTags;
    case "audience_gender": {
      if (fields.audience_female_rate === null || fields.audience_female_rate === undefined) {
        return null;
      }
      return fields.audience_female_rate >= 0.5 ? "女" : "男";
    }
    case "audience_city":
      return fields.audience_cities;
    case "audience_female_rate":
      return fields.audience_female_rate;
    case "audience_male_rate":
      return fields.audience_male_rate;
    case "audience_age_18_23_rate":
      return fields.audience_age_18_23_rate;
    case "audience_age_24_30_rate":
      return fields.audience_age_24_30_rate;
    case "audience_age_31_40_rate":
      return fields.audience_age_31_40_rate;
    default:
      return null;
  }
}

export function evaluateCandidateDetail(candidate, detail, plan) {
  const fields = normalizeDetailFields(detail?.fields ?? {});
  const checks = [];
  for (const filter of plan.filters ?? []) {
    if (filter.control === "creator_price") {
      const observed = priceForPlan(candidate, fields, plan);
      const priceCheck = checkCandidatePrice(
        { ...candidate, price_raw: observed.raw, quote_tier: observed.tier },
        plan,
      );
      checks.push({
        fact_id: filter.fact_id ?? null,
        control: filter.control,
        verdict:
          priceCheck.status === "passed"
            ? "pass"
            : priceCheck.status === "rejected"
              ? "fail"
              : "unknown",
        expected: `${filter.min ?? ""}–${filter.max ?? ""}`,
        actual: priceCheck.observed_yuan,
        source_type: nonEmpty(observed.raw) && observed.raw !== candidate.price_raw ? "详情页" : "导出列表",
        reason: priceCheck.reason,
      });
      continue;
    }
    const actual = valueForFilter(candidate, fields, filter);
    const verdict =
      filter.mode === "range"
        ? rangeVerdict(actual, filter)
        : optionVerdict(actual, filter.values);
    checks.push({
      fact_id: filter.fact_id ?? null,
      control: filter.control,
      verdict,
      expected:
        filter.mode === "range" ? `${filter.min ?? ""}–${filter.max ?? ""}` : filter.values,
      actual,
      source_type: nonEmpty(valueForFilter({}, fields, filter)) ? "详情页" : "导出列表",
      reason: verdict === "unknown" ? "required_value_missing" : null,
    });
  }
  const status = checks.some((check) => check.verdict === "fail")
    ? "fail"
    : checks.some((check) => check.verdict === "unknown")
      ? "unknown"
      : "pass";
  return { status, checks, fields };
}

export function mergeDetailRecords(records) {
  const byReference = new Map();
  for (const record of records ?? []) {
    if (record?.candidate_ref) byReference.set(record.candidate_ref, record);
  }
  return [...byReference.values()];
}

export function mergeReviewRecords(records) {
  const byReference = new Map();
  for (const record of records ?? []) {
    if (record?.candidate_ref) byReference.set(record.candidate_ref, record);
  }
  return [...byReference.values()];
}

export function reviewBatch(candidates, details, reviews, limit = DETAIL_REVIEW_BATCH_SIZE) {
  const detailMap = new Map(mergeDetailRecords(details).map((item) => [item.candidate_ref, item]));
  const reviewed = new Set(mergeReviewRecords(reviews).map((item) => item.candidate_ref));
  const tasks = [];
  for (const candidate of candidates) {
    const candidateRef = candidateReference(candidate);
    const detail = detailMap.get(candidateRef);
    if (!detail || detail.hard_evaluation?.status !== "pass" || reviewed.has(candidateRef)) continue;
    tasks.push({
      candidate_ref: candidateRef,
      nickname: candidate.nickname,
      detail_url: detail.detail_url ?? candidate.detail_url ?? null,
      fields: detail.fields,
      recent_content: detail.fields?.recent_content ?? [],
      hard_checks: detail.hard_evaluation.checks,
    });
  }
  return { tasks: tasks.slice(0, limit), remaining: tasks.length };
}

const KEYWORD_FACT_KINDS = Object.freeze([
  "product_name",
  "content_direction",
  "preferred_content",
  "content_feature",
  "content_theme",
  "brand_name",
  "creator_persona",
]);

const FILTER_FACTS = Object.freeze({
  creator_type: { control: "creator_type", mode: "options" },
  platform_creator_type: { control: "creator_type", mode: "options" },
  growth_creator_type: { control: "creator_type", mode: "options" },
  creator_persona: { control: "creator_persona", mode: "options" },
  industry_tag: { control: "creator_category", mode: "options" },
  creator_gender: { control: "creator_gender", mode: "options" },
  creator_city: { control: "creator_city", mode: "options" },
  follower_count: { control: "follower_count", mode: "range", unit: "count" },
  audience_gender: { control: "audience_gender", mode: "options" },
  audience_city: { control: "audience_city", mode: "options" },
  audience_female_rate: { control: "audience_female_rate", mode: "range", unit: "ratio" },
  audience_male_rate: { control: "audience_male_rate", mode: "range", unit: "ratio" },
  audience_age_18_23_rate: { control: "audience_age_18_23_rate", mode: "range", unit: "ratio" },
  audience_age_24_30_rate: { control: "audience_age_24_30_rate", mode: "range", unit: "ratio" },
  audience_age_31_40_rate: { control: "audience_age_31_40_rate", mode: "range", unit: "ratio" },
  creator_price: { control: "creator_price", mode: "range", unit: "yuan" },
  cpm_max: { control: "cpm", mode: "range", unit: "yuan" },
  cpe_max: { control: "cpe", mode: "range", unit: "yuan" },
  interaction_rate: { control: "interaction_rate", mode: "range", unit: "ratio" },
});

const VIEW_FACT_KINDS = new Set(["content_format", "video_duration", "creator_count"]);
const METADATA_FACT_KINDS = new Set(["project_name", "schedule_window", "submission_deadline"]);
const SEMANTIC_REVIEW_FACT_KINDS = new Set([
  "content_direction",
  "preferred_content",
  "content_feature",
  "content_theme",
  "excluded_content",
]);
const XINGTU_DETAIL_ONLY_CONTROLS = new Set([
  "audience_gender",
  "audience_female_rate",
  "audience_male_rate",
  "audience_age_18_23_rate",
  "audience_age_24_30_rate",
  "audience_age_31_40_rate",
]);
const MANUAL_CREATOR_PRICE_MIN_FACTOR = 0.5;
const MANUAL_CREATOR_PRICE_MAX_FACTOR = 1.2;

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function activeFact(fact) {
  return (
    fact &&
    (fact.status === undefined || fact.status === "present") &&
    (fact.disposition === undefined || fact.disposition === "active")
  );
}

function hardFact(fact) {
  return activeFact(fact) && (fact.strength === undefined || fact.strength === "hard");
}

function factValues(fact) {
  const value = fact.normalized_value ?? fact.value ?? fact.subject;
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const normalized = clean(value);
  return normalized ? [normalized] : [];
}

function visibleOptionValue(control, value) {
  const normalized = clean(value).toLowerCase();
  if (["creator_gender", "audience_gender"].includes(control)) {
    if (["female", "woman", "women", "女"].includes(normalized)) return "女";
    if (["male", "man", "men", "男"].includes(normalized)) return "男";
  }
  return clean(value);
}

function factRange(fact) {
  const value = fact.normalized_value;
  const range = Array.isArray(value) && value.length === 2 ? value : null;
  let minimum = fact.minimum ?? range?.[0] ?? null;
  let maximum = fact.maximum ?? range?.[1] ?? null;
  if (!range && Number.isFinite(Number(value))) {
    if (fact.operator === "lte") {
      minimum = 0;
      maximum = value;
    } else if (fact.operator === "gte") {
      minimum = value;
      maximum = null;
    } else if (fact.operator === "exact") {
      minimum = value;
      maximum = value;
    }
  }
  const finiteOrNull = (candidate) => {
    if (candidate === null || candidate === undefined || candidate === "") return null;
    return Number.isFinite(Number(candidate)) ? Number(candidate) : null;
  };
  return {
    min: finiteOrNull(minimum),
    max: finiteOrNull(maximum),
  };
}

function normalizedRangeForMapping(fact, mapping) {
  const range = factRange(fact);
  if (mapping.unit !== "ratio") return range;
  const ratio = (value) => (value !== null && Math.abs(value) > 1 ? value / 100 : value);
  return { min: ratio(range.min), max: ratio(range.max) };
}

function manualCreatorPriceRange(fact) {
  const between = fact.operator === "between";
  const minAnchor = Number(between ? fact.minimum : fact.normalized_value);
  const maxAnchor = Number(between ? fact.maximum : fact.normalized_value);
  return {
    min: Math.floor(minAnchor * MANUAL_CREATOR_PRICE_MIN_FACTOR),
    max: Math.ceil(maxAnchor * MANUAL_CREATOR_PRICE_MAX_FACTOR),
  };
}

function manualCreatorPriceAnchor(fact) {
  return {
    operator: fact.operator,
    normalized_value: fact.normalized_value ?? null,
    minimum: fact.minimum ?? null,
    maximum: fact.maximum ?? null,
    qualifier: fact.qualifier ?? "generic",
  };
}

function reviewRequirement(fact, reason) {
  return {
    fact_id: fact.id ?? null,
    fact_kind: fact.kind ?? "unknown",
    operator: fact.operator ?? null,
    expected: fact.normalized_value ?? fact.value ?? null,
    quote: clean(fact.quote ?? fact.source?.quote),
    reason,
  };
}

function keywordValues(facts) {
  const values = [];
  for (const fact of facts) {
    if (!activeFact(fact) || !KEYWORD_FACT_KINDS.includes(fact.kind)) continue;
    values.push(...factValues(fact));
  }
  return [...new Set(values)].slice(0, 4);
}

function firstFactValue(facts, kinds) {
  const fact = facts.find((candidate) => activeFact(candidate) && kinds.includes(candidate.kind));
  return factValues(fact ?? {})[0] ?? null;
}

function requestedCreatorCount(facts) {
  const values = facts
    .filter(
      (fact) => activeFact(fact) && fact.kind === "creator_count" && fact.role !== "cooperation",
    )
    .flatMap((fact) => [fact.normalized_value, fact.maximum, fact.minimum])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return values.length ? Math.max(...values) : null;
}

function priceView(platform, facts) {
  const format = facts.find((fact) => activeFact(fact) && fact.kind === "content_format");
  const duration = facts.find((fact) => activeFact(fact) && fact.kind === "video_duration");
  const commercial = facts.find(
    (fact) =>
      activeFact(fact) &&
      ["creator_price", "cpm_max", "cpe_max"].includes(fact.kind) &&
      !["", "generic"].includes(clean(fact.qualifier).toLowerCase()),
  );
  const formatText = factValues(format ?? {}).join(" ");
  const durationText = factValues(duration ?? {}).join(" ");
  const qualifier = clean(commercial?.qualifier).toLowerCase();
  const range = factRange(duration ?? {});
  if (platform === "pgy") {
    if (/图文|图片|笔记|picture|image/iu.test(formatText)) return "图文";
    if (/视频|video/iu.test(formatText) || duration) return "视频";
    if (["picture", "image"].includes(qualifier)) return "图文";
    if (qualifier === "video") return "视频";
    return null;
  }
  if (/duration_l3|60s?\+|60秒以上/u.test(durationText)) return "60s以上视频";
  if (/duration_l1|1\s*[-–]\s*20s/u.test(durationText)) return "1-20s视频";
  if (/duration_l2|21\s*[-–]\s*60s/u.test(durationText)) return "21-60s视频";
  if (range.min !== null && range.min >= 60) return "60s以上视频";
  if (range.max !== null && range.max <= 20) return "1-20s视频";
  if (qualifier === "duration_l3") return "60s以上视频";
  if (qualifier === "duration_l1") return "1-20s视频";
  if (qualifier === "duration_l2") return "21-60s视频";
  if (!duration && !/视频|video/iu.test(formatText)) return null;
  return "21-60s视频";
}

function relevantCommercialFact(fact, platform, selectedPriceView) {
  if (!["creator_price", "cpm_max", "cpe_max"].includes(fact.kind)) return true;
  const qualifier = clean(fact.qualifier || "generic").toLowerCase();
  if (["", "generic"].includes(qualifier)) return true;
  if (platform === "pgy") {
    return selectedPriceView === "视频"
      ? qualifier === "video"
      : ["picture", "image"].includes(qualifier);
  }
  if (qualifier === "video") return true;
  const expected = {
    "1-20s视频": "duration_l1",
    "21-60s视频": "duration_l2",
    "60s以上视频": "duration_l3",
  }[selectedPriceView];
  return qualifier === expected;
}

/**
 * Convert parser facts into a deterministic, platform-neutral browser plan.
 * Provider-expanded projections are deliberately ignored. Browser creator
 * price uses the original customer fact as its anchor and expands it once to
 * 50%–120%; other numeric filters retain their original operators/ranges.
 *
 * @param {{platform: "xingtu"|"pgy", facts: any[], keywords?: string[]}} input
 */
export function compileManualResearchPlan({ platform, facts, keywords }) {
  const activeFacts = facts.filter(activeFact);
  const selectedPriceView = priceView(platform, activeFacts);
  const targetCount = requestedCreatorCount(activeFacts);
  const branchKeywords = [
    ...new Set((keywords ?? keywordValues(activeFacts)).map(clean).filter(Boolean)),
  ].slice(0, 4);
  const filters = [];
  const detailFilters = [];
  const reviewRequirements = [];
  const unexpressed = [];
  for (const fact of activeFacts.filter(hardFact)) {
    const mapping = FILTER_FACTS[fact.kind];
    if (mapping) {
      if (!relevantCommercialFact(fact, platform, selectedPriceView)) {
        unexpressed.push({
          fact_id: fact.id ?? null,
          fact_kind: fact.kind,
          source: fact.source ?? null,
          reason: "cooperation_tier_not_selected",
        });
        continue;
      }
      const filter = {
        fact_id: fact.id ?? null,
        fact_kind: fact.kind,
        control: mapping.control,
        mode: mapping.mode,
        source: fact.source ?? null,
      };
      if (mapping.mode === "range") {
        Object.assign(
          filter,
          fact.kind === "creator_price"
            ? manualCreatorPriceRange(fact)
            : normalizedRangeForMapping(fact, mapping),
          {
            unit: mapping.unit ?? null,
            ...(fact.kind === "creator_price"
              ? {
                  range_policy: "customer_value_50_to_120_percent",
                  input_anchor: manualCreatorPriceAnchor(fact),
                }
              : {}),
          },
        );
      } else
        filter.values = factValues(fact).map((value) => visibleOptionValue(mapping.control, value));
      if (platform === "xingtu" && mapping.control === "audience_city") {
        reviewRequirements.push(reviewRequirement(fact, "detail_semantic_review"));
        continue;
      }
      if (platform === "xingtu" && XINGTU_DETAIL_ONLY_CONTROLS.has(mapping.control)) {
        detailFilters.push({ ...filter, stage: "detail" });
        continue;
      }
      filters.push(filter);
      continue;
    }
    if (SEMANTIC_REVIEW_FACT_KINDS.has(fact.kind)) {
      reviewRequirements.push(reviewRequirement(fact, "detail_semantic_review"));
      continue;
    }
    if (
      !KEYWORD_FACT_KINDS.includes(fact.kind) &&
      !VIEW_FACT_KINDS.has(fact.kind) &&
      !METADATA_FACT_KINDS.has(fact.kind)
    ) {
      unexpressed.push({
        fact_id: fact.id ?? null,
        fact_kind: fact.kind ?? "unknown",
        source: fact.source ?? null,
        reason: "platform_filter_not_mapped",
      });
    }
  }
  const keywordsToRun = branchKeywords.length ? branchKeywords : [""];
  const collectionTarget = targetCount
    ? Math.min(200, Math.max(targetCount * 2, targetCount + 10))
    : 40;
  const perBranchTarget = Math.max(20, Math.ceil(collectionTarget / keywordsToRun.length));
  const priceRanges = filters
    .filter((filter) => filter.control === "creator_price")
    .map((filter) => ({
      fact_id: filter.fact_id,
      min: filter.min,
      max: filter.max,
      unit: filter.unit,
      input_anchor: filter.input_anchor,
    }));
  return {
    protocol_version: 3,
    platform,
    keywords: keywordsToRun,
    filters,
    detail_filters: detailFilters,
    review_requirements: reviewRequirements,
    price_view: selectedPriceView,
    price_policy: {
      creator_price: "customer_value_50_to_120_percent",
      minimum_factor: MANUAL_CREATOR_PRICE_MIN_FACTOR,
      maximum_factor: MANUAL_CREATOR_PRICE_MAX_FACTOR,
      quote_tier: selectedPriceView,
      other_metrics_expanded: false,
      applied_ranges: priceRanges,
    },
    target_count: targetCount,
    export_summary: {
      brand_product: firstFactValue(activeFacts, ["brand_name", "product_name"]),
      project_name: firstFactValue(activeFacts, ["project_name"]),
      submission_deadline: firstFactValue(activeFacts, ["submission_deadline"]),
      responsible_media: firstFactValue(activeFacts, ["responsible_media", "media_owner"]),
    },
    collection_target: collectionTarget,
    per_branch_target: perBranchTarget,
    unexpressed,
    branches: keywordsToRun.map((keyword, index) => ({
      branch_index: index,
      branch_id: `keyword-${index + 1}`,
      keyword,
    })),
  };
}

/** @param {any[]} candidates */
export function mergeManualCandidates(candidates) {
  const merged = [];
  const byIdentity = new Map();
  for (const candidate of candidates) {
    const stableIdentity = candidate.platform_id
      ? `${candidate.platform}:id:${candidate.platform_id}`
      : candidate.detail_url
        ? `${candidate.platform}:url:${candidate.detail_url}`
        : null;
    const branch = candidate.source_branches?.[0];
    const page = candidate.source_pages?.[0];
    const ordinal = candidate.list_fields?.ordinal;
    const retryIdentity =
      !stableIdentity && branch && page !== undefined && ordinal !== undefined && candidate.nickname
        ? `${candidate.platform}:slot:${branch}:${page}:${ordinal}:${clean(candidate.nickname)}`
        : null;
    const identity = stableIdentity ?? retryIdentity;
    if (!identity || !byIdentity.has(identity)) {
      const value = {
        ...candidate,
        source_branches: [...new Set(candidate.source_branches ?? [])],
        source_pages: [...new Set(candidate.source_pages ?? [])],
        evidence: [...(candidate.evidence ?? [])],
      };
      merged.push(value);
      if (identity) byIdentity.set(identity, value);
      continue;
    }
    const existing = byIdentity.get(identity);
    existing.source_branches = [
      ...new Set([...existing.source_branches, ...(candidate.source_branches ?? [])]),
    ];
    existing.source_pages = [
      ...new Set([...existing.source_pages, ...(candidate.source_pages ?? [])]),
    ];
    existing.evidence.push(...(candidate.evidence ?? []));
    for (const [key, value] of Object.entries(candidate)) {
      if (
        (existing[key] === null || existing[key] === undefined || existing[key] === "") &&
        value !== null &&
        value !== undefined &&
        value !== ""
      ) {
        existing[key] = value;
      }
    }
  }
  return merged;
}

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, "")
    .trim();
}

export function parseManualPrice(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  const value = clean(raw)
    .replace(/[¥￥,，]/gu, "")
    .replace(/元$/u, "");
  if (!value) return null;
  const match = value.match(/^(\d+(?:\.\d+)?)(万)?$/u);
  if (!match) return null;
  const amount = Number(match[1]) * (match[2] ? 10_000 : 1);
  return Number.isFinite(amount) ? amount : null;
}

export function normalizeManualQuoteTier(platform, raw) {
  const value = clean(raw).replace(/[–—]/gu, "-");
  if (!value) return null;
  if (platform === "pgy") {
    if (/图文/u.test(value)) return "picture";
    if (/视频/u.test(value)) return "video";
    return null;
  }
  if (/60s?(?:以上|\+)/iu.test(value)) return "duration_l3";
  if (/21-60s?/iu.test(value)) return "duration_l2";
  if (/1-20s?/iu.test(value)) return "duration_l1";
  return null;
}

export function checkCandidatePrice(candidate, plan) {
  const priceFilter = plan.filters?.find((filter) => filter.control === "creator_price");
  if (!priceFilter) {
    return {
      status: "not_required",
      reason: null,
      observed_yuan: null,
      observed_tier: null,
      required_min: null,
      required_max: null,
      required_tier: null,
    };
  }
  const requiredTier = normalizeManualQuoteTier(plan.platform, plan.price_view);
  const observedTier = normalizeManualQuoteTier(plan.platform, candidate.quote_tier);
  const base = {
    observed_yuan: null,
    observed_tier: observedTier,
    required_min: priceFilter.min,
    required_max: priceFilter.max,
    required_tier: requiredTier,
  };
  if (!requiredTier || !observedTier) {
    return { status: "needs_review", reason: "quote_tier_missing", ...base };
  }
  if (observedTier !== requiredTier) {
    return { status: "needs_review", reason: "quote_tier_mismatch", ...base };
  }
  if (
    candidate.price_raw === null ||
    candidate.price_raw === undefined ||
    candidate.price_raw === ""
  ) {
    return { status: "needs_review", reason: "price_missing", ...base };
  }
  const observedPrice = parseManualPrice(candidate.price_raw);
  if (observedPrice === null) {
    return { status: "needs_review", reason: "price_unparseable", ...base };
  }
  const result = { ...base, observed_yuan: observedPrice };
  if (observedPrice < priceFilter.min || observedPrice > priceFilter.max) {
    return { status: "rejected", reason: "price_out_of_range", ...result };
  }
  return { status: "passed", reason: null, ...result };
}

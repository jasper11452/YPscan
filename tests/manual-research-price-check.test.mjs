import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCandidatePrice,
  normalizeManualQuoteTier,
  parseManualPrice,
} from "../src/tools/manual-research-price-check.js";

function plan() {
  return {
    platform: "xingtu",
    price_view: "植入视频",
    filters: [{ control: "creator_price", min: 10_000, max: 24_000 }],
  };
}

test("manual price parser handles current platform display formats", () => {
  assert.equal(parseManualPrice(18_000), 18_000);
  assert.equal(parseManualPrice("¥18,000"), 18_000);
  assert.equal(parseManualPrice("18000"), 18_000);
  assert.equal(parseManualPrice("1.8万"), 18_000);
  assert.equal(parseManualPrice("待确认"), null);
});

test("manual quote tiers normalize the supported Xingtu and PGY labels", () => {
  assert.equal(normalizeManualQuoteTier("xingtu", "植入视频"), "placement");
  assert.equal(normalizeManualQuoteTier("xingtu", "定制视频"), "custom");
  assert.equal(normalizeManualQuoteTier("pgy", "图文"), "picture");
  assert.equal(normalizeManualQuoteTier("pgy", "视频"), "video");
});

test("candidate price check includes boundaries and rejects both sides", () => {
  for (const price of [10_000, 14_300, 19_800, 20_000, 24_000]) {
    assert.equal(
      checkCandidatePrice({ quote_tier: "植入视频", price_raw: price }, plan()).status,
      "passed",
    );
  }
  for (const price of [6_200, 8_000, 9_999, 25_000, 28_800]) {
    const result = checkCandidatePrice({ quote_tier: "植入视频", price_raw: price }, plan());
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "price_out_of_range");
  }
});

test("wrong or missing quote tier requires review instead of using the wrong price", () => {
  assert.equal(
    checkCandidatePrice({ quote_tier: "定制视频", price_raw: 18_000 }, plan()).reason,
    "quote_tier_mismatch",
  );
  assert.equal(checkCandidatePrice({ price_raw: 18_000 }, plan()).reason, "quote_tier_missing");
});

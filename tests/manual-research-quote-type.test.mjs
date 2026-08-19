import assert from "node:assert/strict";
import test from "node:test";

import {
  compileManualResearchPlan,
  mergeManualCandidates,
} from "../src/tools/manual-research-plan.js";

function fact(kind, value, extra = {}) {
  return {
    kind,
    normalized_value: value,
    status: "present",
    disposition: "active",
    strength: "hard",
    ...extra,
  };
}

test("Xingtu defaults an untyped creator price to placement", () => {
  const plan = compileManualResearchPlan({
    platform: "xingtu",
    facts: [fact("creator_price", 10_000, { operator: "lte" })],
    keywords: ["咖啡"],
  });
  assert.equal(plan.price_view, "植入视频");
  assert.equal(plan.price_view_source, "platform_default");
});

test("Xingtu explicit custom intent wins without being confused by a negated placement phrase", () => {
  const plan = compileManualResearchPlan({
    platform: "xingtu",
    facts: [
      fact("creator_price", 10_000, {
        operator: "lte",
        quote: "不要植入，只要定制视频报价 1 万以内",
      }),
    ],
    keywords: ["咖啡"],
  });
  assert.equal(plan.price_view, "定制视频");
  assert.equal(plan.price_view_source, "fact");
});

test("Xingtu rejects conflicting and unsupported quote types before Browser work", () => {
  assert.throws(
    () =>
      compileManualResearchPlan({
        platform: "xingtu",
        quote_type: "定制视频",
        facts: [fact("creator_price", 10_000, { quote: "植入视频报价" })],
        keywords: ["咖啡"],
      }),
    { code: "YPSCAN_MANUAL_QUOTE_TYPE_CONFLICT" },
  );
  assert.throws(
    () =>
      compileManualResearchPlan({
        platform: "xingtu",
        quote_type: "植入视频",
        facts: [fact("creator_price", 10_000, { quote: "短直种草报价" })],
        keywords: ["咖啡"],
      }),
    { code: "YPSCAN_MANUAL_QUOTE_TYPE_UNSUPPORTED" },
  );
});

test("PGY price type and content format stay independent", () => {
  const plan = compileManualResearchPlan({
    platform: "pgy",
    facts: [
      fact("content_format", "video"),
      fact("creator_price", 5_000, { operator: "lte", qualifier: "picture" }),
    ],
    keywords: ["咖啡"],
  });
  assert.equal(plan.price_view, "图文");
  assert.deepEqual(plan.filters.find((filter) => filter.control === "content_format").values, [
    "视频笔记为主",
  ]);
});

test("a run without creator price does not force a quote type", () => {
  const plan = compileManualResearchPlan({
    platform: "pgy",
    facts: [fact("content_format", "video")],
    keywords: ["咖啡"],
  });
  assert.equal(plan.price_view, null);
  assert.equal(plan.price_view_source, "none");
});

test("a later stronger exact quote replaces amount, type and evidence atomically", () => {
  const shared = {
    platform: "pgy",
    platform_id: "creator-1",
    source_branches: ["keyword-1"],
    source_pages: [1],
  };
  const [merged] = mergeManualCandidates([
    {
      ...shared,
      price_raw: "20000",
      quote_tier: "图文",
      price_evidence: { source: "visible_selected_column", exact: true },
    },
    {
      ...shared,
      price_raw: "29000",
      quote_tier: "视频",
      price_evidence: { source: "detail", exact: true },
    },
  ]);
  assert.deepEqual(
    {
      price_raw: merged.price_raw,
      quote_tier: merged.quote_tier,
      price_evidence: merged.price_evidence,
    },
    {
      price_raw: "29000",
      quote_tier: "视频",
      price_evidence: { source: "detail", exact: true },
    },
  );
});

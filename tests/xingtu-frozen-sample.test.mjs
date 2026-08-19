import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixturePath = fileURLToPath(
  new URL("./fixtures/xingtu-20260814-frozen.json", import.meta.url),
);
const frozen = JSON.parse(readFileSync(fixturePath, "utf8"));

test("frozen legacy sample records the obsolete duration-price split", () => {
  assert.equal(frozen.tier_rule.list_default_price, 6200);
  assert.equal(frozen.tier_rule.export_60s_plus_price, 8000);
  assert.notEqual(frozen.tier_rule.list_default_price, frozen.tier_rule.export_60s_plus_price);
  assert.equal(frozen.tier_rule.requirement_tier, "60s+");
  assert.equal(frozen.tier_rule.list_default_tier, "21-60s");
});

test("frozen creator anchor keeps creator gender apart from audience gender", () => {
  const anchor = frozen.creator_anchor;
  assert.equal(anchor.creator_gender, "女");
  assert.equal(anchor.audience_gender.male, 0.58);
  assert.equal(anchor.audience_gender.female, 0.42);
  assert.notEqual(anchor.creator_gender, anchor.audience_gender);
});

test("frozen keyword merge stays auditable: 55 unique by Xingtu ID, 50 delivered", () => {
  const merge = frozen.keyword_merge;
  assert.equal(merge["办公软件"].after_numeric_filter + merge["办公技巧"].after_numeric_filter, 69);
  assert.ok(merge.merged_unique_by_xingtu_id <= 69);
  assert.equal(merge.merged_unique_by_xingtu_id, 55);
  assert.equal(merge.delivered, 50);
  assert.equal(merge.tiers.A_优先 + merge.tiers.B_复核 + merge.tiers.C_备选, merge.delivered);
});

test("frozen legacy run records the numeric attrition the new hard-filter plan must avoid", () => {
  const merge = frozen.keyword_merge;
  assert.ok(
    merge["办公软件"].recalled > merge["办公软件"].after_numeric_filter,
    "the legacy sample applied numeric limits only after export",
  );
  assert.ok(merge["办公技巧"].recalled > merge["办公技巧"].after_numeric_filter);
  assert.ok(
    frozen.unexpressed_on_list_page.length > 0,
    "exact tiers stay off the list page as unexpressed conditions",
  );
  assert.ok(
    frozen.business_only_fields.length > 0,
    "business-only criteria are judged offline from export evidence",
  );
});

test("frozen delivered extremes satisfy every hard limit and business-only fields stay honest", () => {
  assert.ok(frozen.delivered_extremes.price_max_actual <= frozen.hard_limits.price_max);
  assert.ok(frozen.delivered_extremes.cpm_max_actual <= frozen.hard_limits.cpm_max);
  assert.ok(frozen.delivered_extremes.fans_min_actual >= frozen.hard_limits.fans_min);
  assert.ok(frozen.unexpressed_on_list_page.length > 0);
  assert.ok(frozen.business_only_fields.length > 0);
});

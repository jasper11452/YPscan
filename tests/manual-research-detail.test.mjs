import assert from "node:assert/strict";
import test from "node:test";

import {
  detailGroupsForPlan,
  detailQueueLimit,
  evaluateCandidateDetail,
  parseDetailCount,
  parseDetailRatio,
  reviewEvidenceGaps,
  reviewBatch,
} from "../src/tools/manual-research-detail.js";
import { createPgyAdapter } from "../src/tools/manual-research/pgy-adapter.js";
import { createXingtuAdapter } from "../src/tools/manual-research/xingtu-adapter.js";

function range(control, min, max) {
  return { fact_id: control, control, mode: "range", min, max };
}

test("detail values normalize Chinese units and inclusive range boundaries", () => {
  assert.equal(parseDetailCount("12.5万"), 125_000);
  assert.equal(parseDetailCount("3k"), 3_000);
  assert.equal(parseDetailRatio("12.5%"), 0.125);

  const candidate = {
    platform: "xingtu",
    platform_id: "creator-1",
    nickname: "达人一",
    price_raw: "¥20,000",
    quote_tier: "60s以上视频",
  };
  const plan = {
    platform: "xingtu",
    price_view: "60s以上视频",
    filters: [
      range("creator_price", 10_000, 20_000),
      range("follower_count", 100_000, 200_000),
      range("interaction_rate", 0.05, 0.1),
    ],
  };
  const result = evaluateCandidateDetail(
    candidate,
    {
      fields: {
        followers_raw: "10万",
        interaction_rate_raw: "10%",
        price_by_tier: { "60s以上视频": "¥20,000" },
      },
    },
    plan,
  );

  assert.equal(result.status, "pass");
  assert.deepEqual(
    result.checks.map((item) => item.verdict),
    ["pass", "pass", "pass"],
  );
});

test("a missing required detail field is unknown and cannot enter review", () => {
  const candidate = { platform: "pgy", platform_id: "creator-2", nickname: "达人二" };
  const plan = {
    platform: "pgy",
    price_view: "图文",
    filters: [range("audience_female_rate", 0.6, 1)],
  };
  const evaluation = evaluateCandidateDetail(candidate, { fields: {} }, plan);
  const detail = {
    candidate_ref: "creator-2",
    fields: evaluation.fields,
    hard_evaluation: evaluation,
  };

  assert.equal(evaluation.status, "unknown");
  assert.equal(evaluation.checks[0].reason, "required_value_missing");
  assert.deepEqual(reviewBatch([candidate], [detail], []).tasks, []);
});

test("detail-only audience limits gate semantic review and expose review requirements", () => {
  const candidate = { platform: "xingtu", platform_id: "creator-audience", nickname: "达人" };
  const plan = {
    platform: "xingtu",
    filters: [],
    detail_filters: [range("audience_male_rate", 0, 0.75)],
    review_requirements: [
      { fact_kind: "audience_city", expected: "一二线", quote: "粉丝主要在一二线" },
    ],
  };
  const evaluation = evaluateCandidateDetail(
    candidate,
    { fields: { audience_male_rate_raw: "75%", audience_cities: ["北京", "上海"] } },
    plan,
  );
  const detail = {
    candidate_ref: candidate.platform_id,
    fields: evaluation.fields,
    hard_evaluation: evaluation,
  };

  assert.equal(evaluation.status, "pass");
  assert.deepEqual(
    reviewBatch([candidate], [detail], [], { requirements: plan.review_requirements }).tasks[0]
      .review_requirements,
    plan.review_requirements,
  );
  assert.equal(
    evaluateCandidateDetail(candidate, { fields: { audience_male_rate_raw: "75.1%" } }, plan)
      .status,
    "fail",
  );
});

test("review evidence gaps distinguish content, city and audience persona requirements", () => {
  const requirements = [
    { fact_kind: "content_direction", quote: "办公软件相关" },
    { fact_kind: "audience_city", quote: "城市主要集中在一二线" },
    { fact_kind: "excluded_content", quote: "粉丝画像不要都市蓝领、都市银发" },
  ];
  assert.deepEqual(reviewEvidenceGaps({ fields: {} }, requirements), [
    "recent_content",
    "audience_city_distribution",
    "audience_persona_distribution",
  ]);
  assert.deepEqual(
    reviewEvidenceGaps(
      {
        fields: {
          recent_content: [{ title: "AI办公实测" }],
          audience_city_distribution: [{ name: "上海", rate_raw: "31%" }],
          audience_persona_distribution: [{ name: "都市白领", rate_raw: "44%" }],
        },
      },
      requirements,
    ),
    [],
  );
});

test("detail planning is targeted, bounded to twice the target and reviews at most twenty", () => {
  const plan = {
    target_count: 12,
    filters: [range("audience_female_rate", 0.6, 1), range("cpm", 0, 50)],
    unexpressed: [{ fact_kind: "growth", source: { quote: "近30天涨粉" } }],
  };
  assert.equal(detailQueueLimit(plan), 24);
  assert.equal(detailQueueLimit({ target_count: null }), 40);
  assert.deepEqual(detailGroupsForPlan(plan), [
    "summary",
    "recent_content",
    "audience",
    "performance",
    "growth",
  ]);

  const candidates = Array.from({ length: 25 }, (_, index) => ({
    platform_id: `creator-${index}`,
    nickname: `达人${index}`,
  }));
  const details = candidates.map((candidate) => ({
    candidate_ref: candidate.platform_id,
    fields: { recent_content: [{ title: "证据" }] },
    hard_evaluation: { status: "pass", checks: [] },
  }));
  const batch = reviewBatch(candidates, details, []);
  assert.equal(batch.tasks.length, 20);
  assert.equal(batch.remaining, 25);
});

test("both platform adapters enforce a two-second gap between creator starts", async () => {
  const xingtuWaits = [];
  const pgyWaits = [];
  await createXingtuAdapter({
    waitForTimeout: async (milliseconds) => xingtuWaits.push(milliseconds),
  }).paceDetail();
  await createPgyAdapter(
    {
      waitForTimeout: async (milliseconds) => pgyWaits.push(milliseconds),
    },
    {},
  ).paceDetail();
  assert.deepEqual(xingtuWaits, [2_000]);
  assert.deepEqual(pgyWaits, [2_000]);
});

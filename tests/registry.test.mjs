import assert from "node:assert/strict";
import test from "node:test";

import {
  invalidPlatformArrayFields,
  isFutureSubmissionDeadline,
  missingRequiredValidateParams,
  normalizeToolCallParams,
} from "../src/contract/registry.js";

test("validate_requirement normalizes a future deadline to fixed local seconds format", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = normalizeToolCallParams(
    "validate_requirement",
    { submissionDeadlineAt: "2026-08-24 10:05" },
    { now },
  );

  assert.equal(params.submissionDeadlineAt, "2026-08-24 10:05:00");
  assert.equal(isFutureSubmissionDeadline(params.submissionDeadlineAt, { now }), true);
});

test("validate_requirement keeps an expired deadline unchanged instead of normalizing it", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = normalizeToolCallParams(
    "validate_requirement",
    { submissionDeadlineAt: "2026-08-24 09:55" },
    { now },
  );

  assert.equal(params.submissionDeadlineAt, "2026-08-24 09:55");
  assert.equal(isFutureSubmissionDeadline(params.submissionDeadlineAt), false);
});

test("future deadline validation accepts short lead times as long as they are after now", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);

  assert.equal(isFutureSubmissionDeadline("2026-08-24 10:00:01", { now }), true);
  assert.equal(isFutureSubmissionDeadline("2026-08-24 10:00:00", { now }), false);
});

test("xiaohongshu platform array fields are normalized to arrays before validate_requirement", () => {
  const params = normalizeToolCallParams("validate_requirement", {
    platform: "xiaohongshu",
    contentFeatureLabel: "真实测评,通勤",
    contentTag: "护肤,通勤",
    growBloggerTypeLabel: '["潜力达人"]',
    kolPersonaLabel: "职场女性",
    talentTypeLabel: "图文,视频",
  });

  assert.deepEqual(params.contentFeatureLabel, ["真实测评", "通勤"]);
  assert.deepEqual(params.contentTag, ["护肤", "通勤"]);
  assert.deepEqual(params.growBloggerTypeLabel, ["潜力达人"]);
  assert.deepEqual(params.kolPersonaLabel, ["职场女性"]);
  assert.deepEqual(params.talentTypeLabel, ["图文", "视频"]);
});

test("douyin platform array fields are normalized to arrays before validate_requirement", () => {
  const params = normalizeToolCallParams("validate_requirement", {
    platform: "douyin",
    contentThemeLabel: "剧情,搞笑",
    growTalentTypeLabel: '["潜力达人"]',
    industryTagLabel: "美妆个护",
    talentTypeLabel: "视频",
  });

  assert.deepEqual(params.contentThemeLabel, ["剧情", "搞笑"]);
  assert.deepEqual(params.growTalentTypeLabel, ["潜力达人"]);
  assert.deepEqual(params.industryTagLabel, ["美妆个护"]);
  assert.deepEqual(params.talentTypeLabel, ["视频"]);
});

test("array normalization preserves the full enum token instead of splitting on the dash", () => {
  const params = normalizeToolCallParams("validate_requirement", {
    platform: "douyin",
    xtTalentTypeLabel: "美妆-美妆教程,剧情搞笑-剧情",
  });

  assert.deepEqual(params.xtTalentTypeLabel, ["美妆-美妆教程", "剧情搞笑-剧情"]);
});

test("invalidPlatformArrayFields reports non-array platform fields before normalization", () => {
  assert.deepEqual(
    invalidPlatformArrayFields({
      platform: "xiaohongshu",
      contentFeatureLabel: 1,
      contentTag: ["护肤"],
      talentTypeLabel: null,
    }),
    ["contentFeatureLabel", "talentTypeLabel"],
  );
});

test("missingRequiredValidateParams reports the platform tag when it is absent", () => {
  assert.deepEqual(
    missingRequiredValidateParams({
      status: "ready",
      platform: "douyin",
      brandName: "品牌A",
      projectName: "项目A",
      quantityTotal: "10",
      submissionDeadlineAt: "2026-08-24 10:05:00",
      rebate: "[0.2,1]",
      followercount: "[0,999999999]",
      contentTag: "美妆,测评",
    }),
    ["xtTalentTypeLabel"],
  );
});

test("platform-required tag arrays are satisfied only by non-empty arrays", () => {
  assert.deepEqual(
    missingRequiredValidateParams({ platform: "xiaohongshu", pgyBloggerTypeLabel: [] }),
    [
      "status",
      "brandName",
      "projectName",
      "quantityTotal",
      "submissionDeadlineAt",
      "rebate",
      "followercount",
      "contentTag",
      "pgyBloggerTypeLabel",
    ],
  );

  assert.equal(
    missingRequiredValidateParams({ platform: "douyin", xtTalentTypeLabel: ["剧情"] }).includes("xtTalentTypeLabel"),
    false,
  );
});

test("platform tag enum reference file exists separately from registry implementation", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(
    new URL("../skills/media-assistant/references/tools/platform_tag_enums.md", import.meta.url),
    "utf8",
  );

  assert.match(text, /## 小红书 `pgyBloggerTypeLabel`/u);
  assert.match(text, /护肤-面部保养/u);
  assert.match(text, /## 抖音 `xtTalentTypeLabel`/u);
  assert.match(text, /美妆-美妆教程/u);
});

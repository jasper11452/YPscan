import assert from "node:assert/strict";
import test from "node:test";

import {
  invalidPlatformArrayFields,
  isFutureSubmissionDeadline,
  missingRequiredValidateParams,
  normalizeToolCallParams,
  VALIDATE_REQUIREMENT_RANGE_PARAMS,
  validateRequirementPreflight,
} from "../src/contract/registry.js";

function completeValidateParams() {
  return {
    status: "ready",
    platform: "douyin",
    brandName: "品牌A",
    projectName: "项目A",
    quantityTotal: "30",
    submissionDeadlineAt: "2026-08-25 12:00:00",
    rebate: "[0.25,1]",
    followercount: "[0,999999999]",
    contentTag: ["科技", "耳机"],
    rawMessagesJson: {
      original:
        "抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；科技耳机方向。",
      parse_outputs: { dybrandName: ["品牌A"] },
      business_mode: "询价机构",
    },
    contentThemeLabel: ["科技数码"],
    growTalentTypeLabel: ["成熟达人"],
    industryTagLabel: ["3C及电器-消费类电子产品"],
    xtTalentTypeLabel: ["科技数码-3C数码"],
    kolOfficialPriceL3: "[35000,60000]",
  };
}

test("validate_requirement drops non-positive or malformed quantityTotal values", () => {
  assert.equal(
    Object.hasOwn(
      normalizeToolCallParams("validate_requirement", { quantityTotal: 0 }),
      "quantityTotal",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      normalizeToolCallParams("validate_requirement", { quantityTotal: "0" }),
      "quantityTotal",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      normalizeToolCallParams("validate_requirement", { quantityTotal: "  " }),
      "quantityTotal",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      normalizeToolCallParams("validate_requirement", { quantityTotal: -1 }),
      "quantityTotal",
    ),
    false,
  );
  assert.equal(
    normalizeToolCallParams("validate_requirement", { quantityTotal: 1 }).quantityTotal,
    "1",
  );
  assert.equal(
    normalizeToolCallParams("validate_requirement", { quantityTotal: "10" }).quantityTotal,
    "10",
  );
});

test("validate_requirement preflight requires the pre-selected business mode", () => {
  const missing = completeValidateParams();
  missing.rawMessagesJson = {
    original: missing.rawMessagesJson.original,
    parse_outputs: missing.rawMessagesJson.parse_outputs,
  };
  assert.equal(
    validateRequirementPreflight(missing).some((issue) => issue.field === "business_mode"),
    true,
  );

  const invalid = completeValidateParams();
  invalid.rawMessagesJson = { ...invalid.rawMessagesJson, business_mode: "人工拓展" };
  assert.equal(
    validateRequirementPreflight(invalid).some((issue) => issue.field === "business_mode"),
    true,
  );
});

test("validate_requirement maps the user-facing manual mode at the Provider boundary", () => {
  const params = completeValidateParams();
  params.rawMessagesJson = { ...params.rawMessagesJson, business_mode: "手动拓展" };

  const normalized = normalizeToolCallParams("validate_requirement", params);

  assert.equal(params.rawMessagesJson.business_mode, "手动拓展");
  assert.equal(normalized.rawMessagesJson.business_mode, "直接手扒");
  assert.equal(
    validateRequirementPreflight(normalized, { now: new Date("2026-08-24T00:00:00+08:00") }).some(
      (issue) => issue.field === "business_mode",
    ),
    false,
  );
});

test("missingRequiredValidateParams still reports quantityTotal when normalization drops an invalid value", () => {
  const normalized = normalizeToolCallParams("validate_requirement", {
    status: "ready",
    platform: "douyin",
    brandName: "品牌A",
    projectName: "项目A",
    quantityTotal: 0,
    submissionDeadlineAt: "2026-08-24 10:05:00",
    rebate: "[0.2,1]",
    followercount: "[0,999999999]",
    contentTag: ["美妆", "测评"],
  });

  assert.equal(missingRequiredValidateParams(normalized).includes("quantityTotal"), true);
});

test("validate_requirement canonicalizes numeric fields once before the Provider call", () => {
  const normalized = normalizeToolCallParams("ypmcn__validate_requirement", {
    ...completeValidateParams(),
    status: undefined,
    brandName: ["品牌A"],
    quantityTotal: 30,
    rebate: "25%以上",
    followercount: [0, 999999999],
    kolOfficialPriceL3: 50000,
    cpmL3: 500,
    cpeL3: "[0,30]",
    rawMessagesJson: JSON.stringify(completeValidateParams().rawMessagesJson),
  });

  assert.equal(normalized.status, "ready");
  assert.equal(normalized.brandName, "品牌A");
  assert.equal(normalized.quantityTotal, "30");
  assert.equal(normalized.rebate, "[0.25,1]");
  assert.equal(normalized.followercount, "[0,999999999]");
  assert.equal(normalized.kolOfficialPriceL3, "[35000,60000]");
  assert.equal(normalized.cpmL3, "[0,500]");
  assert.equal(normalized.cpeL3, "[0,30]");
  assert.deepEqual(normalized.rawMessagesJson, {
    original:
      "抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；科技耳机方向。",
    parse_outputs: { dybrandName: ["品牌A"] },
    business_mode: "询价机构",
  });
});

test("normalizeRequirement routes a unique legacy Douyin metric to the current video tier", () => {
  const params = {
    ...completeValidateParams(),
    brandName: "品牌A",
    kolOfficialPriceL2: [35000, 50000],
    cpmL2: [0, 100],
    cpeL2: [0, 20],
    rawMessagesJson: {
      original:
        "抖音项目：项目A；形式：定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: {
        dy_kolOfficialPrice: { kolOfficialPriceL2: [35000, 50000] },
        dy_cpm: JSON.stringify({ cpmL2: [0, 100] }),
        dy_cpe: JSON.stringify({ cpeL2: [0, 20] }),
      },
    },
  };
  delete params.kolOfficialPriceL3;

  const normalized = normalizeToolCallParams("validate_requirement", params);

  assert.equal(normalized.kolOfficialPriceL3, "[35000,50000]");
  assert.equal(normalized.cpmL3, "[0,100]");
  assert.equal(normalized.cpeL3, "[0,20]");
  assert.equal(Object.hasOwn(normalized, "kolOfficialPriceL2"), false);
  assert.equal(Object.hasOwn(normalized, "cpmL2"), false);
  assert.equal(Object.hasOwn(normalized, "cpeL2"), false);
});

test("normalizeRequirement reuses a unique parsed brand when the original has no explicit brand", () => {
  const params = {
    ...completeValidateParams(),
    brandName: "千问",
    rawMessagesJson: {
      original: "抖音项目：千问耳夹式AI智能体耳机；形式：定制视频；30位。",
      parse_outputs: { dybrandName: ["阿里（千问）"] },
    },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params);

  assert.equal(normalized.brandName, "阿里（千问）");
});

test("validate_requirement rejects degenerate ranges instead of silently repairing them", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);

  for (const field of VALIDATE_REQUIREMENT_RANGE_PARAMS) {
    const normalized = normalizeToolCallParams(
      "validate_requirement",
      { ...completeValidateParams(), [field]: "[1,1]" },
      { now },
    );

    assert.equal(normalized[field], "[1,1]", field);
    assert.equal(
      validateRequirementPreflight(normalized, { now }).some((issue) => issue.field === field),
      true,
      field,
    );
  }
});

test("validate_requirement does not expand an explicit degenerate price range", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const normalized = normalizeToolCallParams(
    "validate_requirement",
    {
      ...completeValidateParams(),
      kolOfficialPriceL3: "50000-50000",
    },
    { now },
  );

  assert.equal(normalized.kolOfficialPriceL3, "50000-50000");
  assert.equal(
    validateRequirementPreflight(normalized, { now }).some(
      (issue) => issue.field === "kolOfficialPriceL3",
    ),
    true,
  );
});

test("validate_requirement rejects prebuilt CPM and CPE ranges with a nonzero lower bound", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);

  for (const field of ["cpmL3", "cpeL3"]) {
    const normalized = normalizeToolCallParams(
      "validate_requirement",
      { ...completeValidateParams(), [field]: "[1,500]" },
      { now },
    );

    assert.equal(normalized[field], "[1,500]", field);
    assert.equal(
      validateRequirementPreflight(normalized, { now }).some((issue) => issue.field === field),
      true,
      field,
    );
  }
});

test("complete canonical validate_requirement params pass the local preflight", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  assert.deepEqual(validateRequirementPreflight(completeValidateParams(), { now }), []);
});

// Hard gate behind the Agent-facing key contract injected by the parse-success
// directive; the instruction side is pinned by tests/flow-directives.test.mjs
// "parse success pins the rawMessagesJson key contract for validate_requirement".
test("validate_requirement preflight blocks a renamed rawMessagesJson original key", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const renamed = completeValidateParams();
  const { original, ...rest } = renamed.rawMessagesJson;
  renamed.rawMessagesJson = { ...rest, original_demand: original };

  assert.deepEqual(
    validateRequirementPreflight(renamed, { now }).map((issue) => issue.field),
    [
      "rawMessagesJson",
      "quantityTotal",
      "followercount",
      "rebate",
      "kolOfficialPriceL1/L2/L3",
      "submissionDeadlineAt",
      "douyinVideoType",
    ],
  );

  const restored = { ...renamed, rawMessagesJson: { ...rest, original } };
  assert.deepEqual(validateRequirementPreflight(restored, { now }), []);
});

test("validate_requirement rejects non-string values for every scalar parameter", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const scalarFields = [
    "id",
    "demandId",
    "demandVersion",
    "product",
    "description",
    "talentTypeLabel",
    "kwGender",
    "kwIpDependency",
    "kwUserUrl",
    "organization",
    "hasOrganization",
    "hasOrder30day",
    "hasSocial30day",
    "originalBrief",
    "refNickname",
    "refUrl",
  ];

  for (const field of scalarFields) {
    const normalized = normalizeToolCallParams(
      "validate_requirement",
      { ...completeValidateParams(), [field]: { unsafe: true } },
      { now },
    );
    const issues = validateRequirementPreflight(normalized, { now });

    assert.equal(
      issues.some((issue) => issue.field === field),
      true,
      `${field} accepted a non-string value`,
    );
  }
});

test("validate_requirement boolean filters accept only string booleans", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);

  for (const field of ["hasOrganization", "hasOrder30day", "hasSocial30day"]) {
    for (const value of [true, false, "yes", "0"]) {
      const params = { ...completeValidateParams(), [field]: value };
      assert.equal(
        validateRequirementPreflight(params, { now }).some((issue) => issue.field === field),
        true,
        `${field} accepted ${JSON.stringify(value)}`,
      );
    }
    for (const value of ["true", "false"]) {
      const params = { ...completeValidateParams(), [field]: value };
      assert.equal(
        validateRequirementPreflight(params, { now }).some((issue) => issue.field === field),
        false,
        `${field} rejected ${value}`,
      );
    }
  }
});

test("validate_requirement rejects undeclared parameters before the Provider call", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = { ...completeValidateParams(), unexpected: { unsafe: true } };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).filter((issue) => issue.field === "unexpected"),
    [{ field: "unexpected", reason: "不是 validate_requirement 的已声明参数" }],
  );
});

test("missing contentTag is a parser contract failure instead of a user question", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  delete params.contentTag;

  assert.match(
    validateRequirementPreflight(params, { now }).find((issue) => issue.field === "contentTag")
      ?.reason ?? "",
    /解析结果.*重新解析.*禁止向用户询问/u,
  );
});

test("preflight rejects followercount above the technical maximum", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    followercount: "[100000,9999999999]",
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["followercount"],
  );
});

test("normalization clamps followercount down to the technical maximum", () => {
  const normalized = normalizeToolCallParams("validate_requirement", {
    ...completeValidateParams(),
    followercount: "[5000000,9999999999]",
  });

  assert.equal(normalized.followercount, "[5000000,999999999]");
});

test("Dify-parsed followercount and price do not require extra user evidence", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    brandName: "千问",
    followercount: "[5000000,9999999999]",
    kolOfficialPriceL3: "[35000,50000]",
    rebate: "[0.25,1]",
    rawMessagesJson: {
      original:
        "项目：千问耳夹式AI智能体耳机；平台：抖音；形式：定制视频；档期：8月底-9月；数量：30位；单价：5w；返点：25%以上。类型：行业头部。",
      parse_outputs: {
        brandName: null,
        followercount: "[5000000,9999999999]",
        rebate: "[0.25,1]",
        kolOfficialPriceL3: "[35000,50000]",
      },
      clarifications: { brandName: "千问" },
      business_mode: "询价机构",
    },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params, { now });
  assert.equal(normalized.followercount, "[5000000,999999999]");
  assert.deepEqual(
    validateRequirementPreflight(normalized, { now }).map((issue) => issue.field),
    ["submissionDeadlineAt"],
  );
});

test("preflight accepts a unique Dify price without 单价 wording", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    kolOfficialPriceL3: "[35000,50000]",
    rawMessagesJson: {
      original:
        "抖音项目：项目A；品牌：品牌A；定制视频；30位；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: {
        dybrandName: ["品牌A"],
        kolOfficialPriceL3: "[35000,50000]",
      },
      business_mode: "询价机构",
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("normalization accepts parsed tag arrays", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  delete params.contentThemeLabel;
  delete params.xtTalentTypeLabel;
  params.rawMessagesJson = {
    ...params.rawMessagesJson,
    parse_outputs: {
      ...params.rawMessagesJson.parse_outputs,
      contentThemeLabel: ["科技数码"],
      xtTalentTypeLabel: ["科技数码-3C数码"],
    },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params, { now });

  assert.deepEqual(normalized.contentThemeLabel, ["科技数码"]);
  assert.deepEqual(normalized.xtTalentTypeLabel, ["科技数码-3C数码"]);
  assert.deepEqual(validateRequirementPreflight(normalized, { now }), []);
});

test("normalization expands parsed stringified tag arrays", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  delete params.contentTag;
  delete params.contentThemeLabel;
  params.rawMessagesJson = {
    ...params.rawMessagesJson,
    parse_outputs: {
      ...params.rawMessagesJson.parse_outputs,
      contentTag: '["AI智能体耳机","科技数码"]',
      contentThemeLabel: '["科技数码"]',
    },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params, { now });

  assert.deepEqual(normalized.contentTag, ["AI智能体耳机", "科技数码"]);
  assert.deepEqual(normalized.contentThemeLabel, ["科技数码"]);
  assert.deepEqual(validateRequirementPreflight(normalized, { now }), []);
});

test("normalization expands a parsed stringified brand array", () => {
  const params = {
    ...completeValidateParams(),
    brandName: "品牌B",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      parse_outputs: { dybrandName: '["品牌A"]' },
    },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params);

  assert.equal(normalized.brandName, "品牌A");
});

test("normalization expands parsed stringified metric objects", () => {
  const params = completeValidateParams();
  delete params.kolOfficialPriceL3;
  delete params.cpmL3;
  delete params.cpeL3;
  params.rawMessagesJson = {
    ...params.rawMessagesJson,
    parse_outputs: {
      ...params.rawMessagesJson.parse_outputs,
      dy_kolOfficialPrice: '{"kolOfficialPriceL3":[35000,60000]}',
      dy_cpm: '{"cpmL3":[0,500]}',
      dy_cpe: '{"cpeL3":[0,20]}',
    },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params);

  assert.equal(normalized.kolOfficialPriceL3, "[35000,60000]");
  assert.equal(normalized.cpmL3, "[0,500]");
  assert.equal(normalized.cpeL3, "[0,20]");
});
test("normalizeRequirement silently omits a null Douyin primary parsed label", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  delete params.xtTalentTypeLabel;
  params.rawMessagesJson = {
    ...params.rawMessagesJson,
    original:
      "抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；账号类型：家电垂类，发布内容中需要有孩子或宠物相关内容。",
    parse_outputs: {
      ...params.rawMessagesJson.parse_outputs,
      xtTalentTypeLabel: null,
    },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params, { now });

  assert.equal(Object.hasOwn(normalized, "xtTalentTypeLabel"), false);
  assert.deepEqual(validateRequirementPreflight(normalized, { now }), []);
});
test("normalizeRequirement never fills a null parsed primary label from clarifications", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  delete params.xtTalentTypeLabel;
  params.rawMessagesJson = {
    ...params.rawMessagesJson,
    parse_outputs: {
      ...params.rawMessagesJson.parse_outputs,
      xtTalentTypeLabel: null,
    },
    clarifications: {
      达人类型: "家居电器",
    },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params, { now });

  assert.equal(Object.hasOwn(normalized, "xtTalentTypeLabel"), false);
  assert.deepEqual(validateRequirementPreflight(normalized, { now }), []);
});
test("preflight no longer blocks a null Douyin primary tag", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  delete params.xtTalentTypeLabel;
  params.rawMessagesJson = {
    ...params.rawMessagesJson,
    original:
      "抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；账号类型：家居。",
    parse_outputs: { xtTalentTypeLabel: null },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params, { now });

  assert.equal(
    validateRequirementPreflight(normalized, { now }).some(
      (issue) => issue.field === "xtTalentTypeLabel",
    ),
    false,
  );
});

test("validate_requirement preflight reports all missing and malformed fields together", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const issues = validateRequirementPreflight(
    {
      ...completeValidateParams(),
      submissionDeadlineAt: undefined,
      rebate: "25%以上",
      kolOfficialPriceL3: [50000, 50000],
      projectStartStart: "8月底",
    },
    { now },
  );

  assert.deepEqual(
    issues.map((issue) => issue.field),
    ["submissionDeadlineAt", "rebate", "kolOfficialPriceL3", "projectStartStart"],
  );
});

test("validate_requirement preflight requires a price tier but not optional parsed labels", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  delete params.kolOfficialPriceL3;
  delete params.contentThemeLabel;
  delete params.xtTalentTypeLabel;

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["kolOfficialPriceL1/L2/L3"],
  );
});

test("null current-platform primary parsed labels are silently omitted", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  for (const [platform, field] of [
    ["xiaohongshu", "pgyBloggerTypeLabel"],
    ["douyin", "xtTalentTypeLabel"],
  ]) {
    const params = completeValidateParams();
    params.platform = platform;
    params.rawMessagesJson = {
      ...params.rawMessagesJson,
      parse_outputs: {
        [platform === "douyin" ? "dybrandName" : "xhsbrandName"]: ["品牌A"],
        [field]: null,
      },
    };
    delete params[field];
    if (platform === "xiaohongshu") {
      delete params.kolOfficialPriceL3;
      delete params.cpmL3;
      params.kolOfficialPriceL1 = "[35000,60000]";
    }

    const normalized = normalizeToolCallParams("validate_requirement", params, { now });
    assert.equal(Object.hasOwn(normalized, field), false, platform);
    assert.deepEqual(validateRequirementPreflight(normalized, { now }), [], platform);
  }
});

test("preflight still requires brand and deadline when Dify did not parse them", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    rawMessagesJson: {
      original:
        "项目：千问耳夹式AI智能体耳机；平台：抖音；形式：定制视频；档期：8月底-9月；数量：30位；单价：5w；返点：25%以上。",
      parse_outputs: {
        followercount: [0, 999999999],
        dy_kolOfficialPrice: { kolOfficialPriceL3: "50000" },
      },
      business_mode: "询价机构",
    },
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["brandName", "submissionDeadlineAt"],
  );
});

test("preflight accepts one current-platform parsed brand without asking again", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    brandName: "品牌A",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: { dybrandName: ["品牌A"] },
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight still rejects multiple parsed brand candidates without user confirmation", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: { dybrandName: ["品牌A", "品牌B"] },
    },
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["brandName"],
  );
});

test("preflight trusts a parsed brand despite conflicting original text", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    brandName: "品牌A",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌B；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: { dybrandName: ["品牌A"] },
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight does not reinterpret a Dify brand from conflicting original text", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    brandName: "品牌A",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌B，产品别名品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: { dybrandName: ["品牌A"] },
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight rejects placeholder strings as parsed brand candidates", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  for (const placeholder of ["null", "未知", "未明确"]) {
    const params = {
      ...completeValidateParams(),
      brandName: placeholder,
      rawMessagesJson: {
        ...completeValidateParams().rawMessagesJson,
        original:
          "抖音项目：项目A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
        parse_outputs: { dybrandName: [placeholder] },
      },
    };

    assert.deepEqual(
      validateRequirementPreflight(params, { now }).map((issue) => issue.field),
      ["brandName"],
      placeholder,
    );
  }
});

test("preflight accepts an Agent-summarized project name without any evidence", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    projectName: "品牌A抖音定制视频投放",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音：品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight accepts a plain parsed brandName key when the platform key is absent", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: { brandName: ["品牌A"] },
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("a Dify parsed brand rejects a conflicting Agent-supplied brand", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    brandName: "品牌B",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌B；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: { dybrandName: ["品牌A"] },
    },
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["brandName"],
  );
});

test("normalization replaces a conflicting Agent-supplied brand with the Dify brand", () => {
  const params = {
    ...completeValidateParams(),
    brandName: "品牌B",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌B；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: { dybrandName: ["品牌A"] },
    },
  };

  const normalized = normalizeToolCallParams("validate_requirement", params);

  assert.equal(normalized.brandName, "品牌A");
});

test("preflight asks when Dify has no brand even if the original text names one", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      parse_outputs: {},
    },
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["brandName"],
  );
});

test("preflight accepts the latest brand clarification when Dify has no brand", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      parse_outputs: {},
      clarifications: { brandName: "品牌：品牌A" },
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight reuses non-empty clarification answers instead of asking again", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    quantityTotal: "50",
    submissionDeadlineAt: "2026-08-26 12:00:00",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌A；定制视频；单价5万元；返点25%以上；粉丝不限；科技耳机方向。",
      clarifications: {
        quantityTotal: "达人数量：50位",
        submissionDeadlineAt: "提报截止：2026-08-26 12:00:00",
      },
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight keeps a same-platform multi-type total in one requirement", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    quantityTotal: "30",
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight uses only the latest scalar clarification for an overridden field", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const rawMessagesJson = {
    ...completeValidateParams().rawMessagesJson,
    clarifications: {
      quantityTotal: ["达人数量：30位", "达人数量改为：50位"],
      submissionDeadlineAt: ["提报截止：2026-08-25 12:00:00", "提报截止改为：2026-08-26 12:00:00"],
    },
  };

  assert.deepEqual(
    validateRequirementPreflight({ ...completeValidateParams(), rawMessagesJson }, { now }).map(
      (issue) => issue.field,
    ),
    ["quantityTotal", "submissionDeadlineAt"],
  );
  assert.deepEqual(
    validateRequirementPreflight(
      {
        ...completeValidateParams(),
        quantityTotal: "50",
        submissionDeadlineAt: "2026-08-26 12:00:00",
        rawMessagesJson,
      },
      { now },
    ),
    [],
  );
});

test("Dify brand stays authoritative while the Agent-summarized project name needs no evidence", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const rawMessagesJson = {
    ...completeValidateParams().rawMessagesJson,
    parse_outputs: { dybrandName: ["品牌A"] },
    clarifications: {
      brandName: ["品牌：品牌A", "品牌：品牌B"],
      projectName: ["项目名称：项目A", "项目名称：项目B"],
    },
  };

  assert.deepEqual(
    validateRequirementPreflight({ ...completeValidateParams(), rawMessagesJson }, { now }).map(
      (issue) => issue.field,
    ),
    [],
  );
  assert.deepEqual(
    validateRequirementPreflight(
      {
        ...completeValidateParams(),
        brandName: "品牌B",
        projectName: "项目B",
        rawMessagesJson,
      },
      { now },
    ).map((issue) => issue.field),
    ["brandName"],
  );
});

test("latest Chinese project-date clarifications are accepted as current evidence", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    projectStartStart: "2026-09-01",
    projectStartEnd: "2026-09-30",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      clarifications: {
        项目开始: "2026-09-01",
        项目结束: "2026-09-30",
      },
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight does not treat empty clarification keys as user evidence", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    rawMessagesJson: {
      original: "抖音项目：项目A；品牌：品牌A；定制视频；单价5万元；返点25%以上。",
      parse_outputs: {},
      clarifications: {
        followercount: "",
        quantityTotal: null,
        submissionDeadlineAt: {},
      },
      business_mode: "询价机构",
    },
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["brandName", "quantityTotal", "followercount", "submissionDeadlineAt"],
  );
});

test("preflight requires exact evidence for brand, quantity, and deadline values", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    brandName: "品牌B",
    projectName: "项目B",
    quantityTotal: "50",
    submissionDeadlineAt: "2026-08-26 12:00:00",
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["brandName", "quantityTotal", "submissionDeadlineAt"],
  );
});

test("preflight rejects a swapped brand while a swapped project name stays acceptable", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    brandName: "项目A",
    projectName: "品牌A",
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["brandName"],
  );
});

test("preflight accepts an unambiguous same-day deadline clock", () => {
  const now = new Date(2026, 7, 24, 10, 30, 0);
  const params = {
    ...completeValidateParams(),
    submissionDeadlineAt: "2026-08-24 12:00:00",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；今天12点前提报；科技耳机方向。",
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight accepts same-day HH:mm deadline evidence before or after the clock", () => {
  const now = new Date(2026, 7, 24, 10, 30, 0);
  const original = completeValidateParams().rawMessagesJson.original;
  for (const deadlineEvidence of ["提交截止今天18:00", "今天18:00前提交"]) {
    const params = {
      ...completeValidateParams(),
      submissionDeadlineAt: "2026-08-24 18:00:00",
      rawMessagesJson: {
        ...completeValidateParams().rawMessagesJson,
        original: original.replace("提报截止2026-08-25 12:00:00", deadlineEvidence),
      },
    };

    assert.deepEqual(validateRequirementPreflight(params, { now }), [], deadlineEvidence);
  }

  const params = {
    ...completeValidateParams(),
    submissionDeadlineAt: "2026-08-24 18:00:00",
    rawMessagesJson: { ...completeValidateParams().rawMessagesJson },
  };
  params.rawMessagesJson.clarifications = { submissionDeadlineAt: "今天18:00" };
  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight accepts zero-padded Chinese clock fields without accepting a longer time", () => {
  const now = new Date(2026, 7, 24, 10, 30, 0);
  for (const [deadlineEvidence, deadline] of [
    ["提交截止今天18点00分", "2026-08-24 18:00:00"],
    ["提交截止今天18点30分00秒", "2026-08-24 18:30:00"],
  ]) {
    const params = {
      ...completeValidateParams(),
      submissionDeadlineAt: deadline,
      rawMessagesJson: {
        ...completeValidateParams().rawMessagesJson,
        original: `抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；${deadlineEvidence}；科技耳机方向。`,
      },
    };
    assert.deepEqual(validateRequirementPreflight(params, { now }), [], deadlineEvidence);
  }

  const mismatched = {
    ...completeValidateParams(),
    submissionDeadlineAt: "2026-08-25 12:00:00",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026年8月25日12点30分；科技耳机方向。",
    },
  };
  assert.deepEqual(
    validateRequirementPreflight(mismatched, { now }).map((issue) => issue.field),
    ["submissionDeadlineAt"],
  );
});

test("preflight requires an exact hour and minute in same-day deadline evidence", () => {
  const now = new Date(2026, 7, 24, 7, 0, 0);
  for (const deadlineEvidence of [
    "提交截止今天18:00",
    "提交截止今天8点30分",
    "提交截止今天08:00:30",
  ]) {
    const params = {
      ...completeValidateParams(),
      submissionDeadlineAt: "2026-08-24 08:00:00",
      rawMessagesJson: {
        ...completeValidateParams().rawMessagesJson,
        original: `抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；${deadlineEvidence}；科技耳机方向。`,
      },
    };

    assert.deepEqual(
      validateRequirementPreflight(params, { now }).map((issue) => issue.field),
      ["submissionDeadlineAt"],
      deadlineEvidence,
    );
  }
});

test("preflight preserves explicitly stated deadline seconds", () => {
  const now = new Date(2026, 7, 24, 10, 30, 0);
  const params = {
    ...completeValidateParams(),
    submissionDeadlineAt: "2026-08-25 12:00:30",
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["submissionDeadlineAt"],
  );
});

test("preflight rejects invalid calendar deadlines instead of letting Date roll them over", () => {
  const now = new Date(2026, 0, 1, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    submissionDeadlineAt: "2026-02-31 12:00:00",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      clarifications: { submissionDeadlineAt: "2026-02-31 12:00:00" },
    },
  };

  assert.equal(isFutureSubmissionDeadline(params.submissionDeadlineAt, { now }), false);
  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["submissionDeadlineAt"],
  );
});

test("preflight rejects concrete project dates inferred from a vague schedule", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    projectStartStart: "2026-08-25",
    projectStartEnd: "2026-09-30",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；档期8月底至9月。",
    },
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["projectStartStart", "projectStartEnd"],
  );
});

test("preflight accepts explicit project dates and rejects a reversed range", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    projectStartStart: "2026-08-25",
    projectStartEnd: "2026-09-30",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；档期2026年8月25日至2026年9月30日。",
    },
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
  assert.deepEqual(
    validateRequirementPreflight(
      { ...params, projectStartStart: "2026-09-30", projectStartEnd: "2026-08-25" },
      { now },
    ).map((issue) => issue.field),
    ["projectStartStart/projectStartEnd"],
  );
});

test("preflight does not add a project clock to date-only evidence", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    projectStartStart: "2026-08-25T09:00:00",
    rawMessagesJson: {
      ...completeValidateParams().rawMessagesJson,
      original:
        "抖音项目：项目A；品牌：品牌A；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；档期2026年8月25日。",
    },
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["projectStartStart"],
  );
});

test("preflight verifies that every Douyin L2/L3 metric matches the stated video type", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  for (const field of [
    "kolOfficialPriceL2",
    "cpmL2",
    "cpeL2",
    "kolOfficialPriceL3",
    "cpmL3",
    "cpeL3",
  ]) {
    const isL2 = field.endsWith("L2");
    const params = completeValidateParams();
    if (!isL2) {
      delete params.kolOfficialPriceL3;
      params.kolOfficialPriceL2 = "[35000,60000]";
    }
    params[field] = field.startsWith("kolOfficialPrice") ? "[35000,60000]" : "[0,100]";
    params.rawMessagesJson = {
      ...params.rawMessagesJson,
      original: `抖音项目：项目A；品牌：品牌A；${isL2 ? "定制视频" : "植入视频"}；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；科技耳机方向。`,
    };

    assert.deepEqual(
      validateRequirementPreflight(params, { now }).map((issue) => issue.field),
      ["douyinVideoType"],
      field,
    );
  }
});

test("preflight accepts Douyin placement-video price, CPM and CPE in L2", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  delete params.kolOfficialPriceL3;
  params.kolOfficialPriceL2 = "[35000,60000]";
  params.cpmL2 = "[0,100]";
  params.cpeL2 = "[0,20]";
  params.rawMessagesJson = {
    ...params.rawMessagesJson,
    original:
      "抖音项目：项目A；品牌：品牌A；植入视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；科技耳机方向。",
  };

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight rejects every Douyin L1 price, CPM and CPE field", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  for (const field of ["kolOfficialPriceL1", "cpmL1", "cpeL1"]) {
    const params = {
      ...completeValidateParams(),
      [field]: field === "kolOfficialPriceL1" ? "[35000,60000]" : "[0,100]",
    };

    assert.deepEqual(
      validateRequirementPreflight(params, { now }).map((issue) => issue.field),
      [field],
      field,
    );
  }
});

test("preflight accepts Douyin custom-video price, CPM and CPE in L3", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  params.cpmL3 = "[0,100]";
  params.cpeL3 = "[0,20]";

  assert.deepEqual(validateRequirementPreflight(params, { now }), []);
});

test("preflight does not treat a negated Douyin video type as positive evidence", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = completeValidateParams();
  delete params.kolOfficialPriceL3;
  params.kolOfficialPriceL2 = "[35000,60000]";
  params.rawMessagesJson = {
    ...params.rawMessagesJson,
    original:
      "抖音项目：项目A；品牌：品牌A；不是植入视频，是定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；科技耳机方向。",
  };

  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["douyinVideoType"],
  );
});

test("preflight applies a shared negation to coordinated Douyin video types", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  for (const videoTypeEvidence of ["不要植入或定制视频", "不做植入、定制视频"]) {
    const params = completeValidateParams();
    params.rawMessagesJson = {
      ...params.rawMessagesJson,
      original: `抖音项目：项目A；品牌：品牌A；${videoTypeEvidence}；30位；单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00；科技耳机方向。`,
    };

    assert.deepEqual(
      validateRequirementPreflight(params, { now }).map((issue) => issue.field),
      ["douyinVideoType"],
      videoTypeEvidence,
    );
  }
});

test("preflight rejects unsupported Xiaohongshu L3 numeric tiers", () => {
  const now = new Date(2026, 7, 24, 10, 0, 0);
  const params = {
    ...completeValidateParams(),
    platform: "xiaohongshu",
    rawMessagesJson: {
      original:
        "小红书项目：项目A；品牌：品牌A；30位；视频单价5万元；返点25%以上；粉丝不限；提报截止2026-08-25 12:00:00。",
      parse_outputs: { xhsbrandName: ["品牌A"] },
      business_mode: "询价机构",
    },
    contentFeatureLabel: ["真实测评"],
    growBloggerTypeLabel: ["成熟博主"],
    kolPersonaLabel: ["科技爱好者"],
    pgyBloggerTypeLabel: ["科技数码-3C数码"],
    kolOfficialPriceL3: "[35000,60000]",
  };
  delete params.contentThemeLabel;
  delete params.growTalentTypeLabel;
  delete params.industryTagLabel;
  delete params.xtTalentTypeLabel;
  assert.deepEqual(
    validateRequirementPreflight(params, { now }).map((issue) => issue.field),
    ["kolOfficialPriceL3"],
  );
});

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
  });

  assert.deepEqual(params.contentFeatureLabel, ["真实测评", "通勤"]);
  assert.deepEqual(params.contentTag, ["护肤", "通勤"]);
  assert.deepEqual(params.growBloggerTypeLabel, ["潜力达人"]);
  assert.deepEqual(params.kolPersonaLabel, ["职场女性"]);
});

test("douyin platform array fields are normalized to arrays before validate_requirement", () => {
  const params = normalizeToolCallParams("validate_requirement", {
    platform: "douyin",
    contentThemeLabel: "剧情,搞笑",
    growTalentTypeLabel: '["潜力达人"]',
    industryTagLabel: "美妆个护",
  });

  assert.deepEqual(params.contentThemeLabel, ["剧情", "搞笑"]);
  assert.deepEqual(params.growTalentTypeLabel, ["潜力达人"]);
  assert.deepEqual(params.industryTagLabel, ["美妆个护"]);
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
    }),
    ["contentFeatureLabel"],
  );
});

test("missingRequiredValidateParams does not require optional parsed labels", () => {
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
      rawMessagesJson: {},
    }),
    [],
  );
});

test("optional platform labels do not enter the required-field list", () => {
  assert.deepEqual(
    missingRequiredValidateParams({
      platform: "xiaohongshu",
      pgyBloggerTypeLabel: [],
      rawMessagesJson: {},
    }),
    [
      "status",
      "brandName",
      "projectName",
      "quantityTotal",
      "submissionDeadlineAt",
      "rebate",
      "followercount",
      "contentTag",
    ],
  );

  assert.equal(
    missingRequiredValidateParams({ platform: "douyin", xtTalentTypeLabel: ["剧情"] }).includes(
      "xtTalentTypeLabel",
    ),
    false,
  );
});

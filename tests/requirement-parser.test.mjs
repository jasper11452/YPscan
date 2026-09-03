import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createRequirementParser,
  DIFY_REQUIREMENT_FIELDS,
  DIFY_REQUIREMENT_OUTPUT_FIELDS,
  DIFY_WORKFLOW_URL,
  PARSE_REQUIREMENT_OUTPUT_SCHEMA,
  PARSE_REQUIREMENT_PARAMETERS,
} from "../src/tools/parse-requirement.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function response(envelope, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => envelope,
  };
}

function projectFile(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("parser runtime constants keep the compact output contract", () => {
  assert.ok(Object.isFrozen(DIFY_REQUIREMENT_OUTPUT_FIELDS));
  assert.equal(new Set(DIFY_REQUIREMENT_OUTPUT_FIELDS).size, DIFY_REQUIREMENT_OUTPUT_FIELDS.length);
  assert.deepEqual(
    Object.keys(PARSE_REQUIREMENT_OUTPUT_SCHEMA.properties.data.properties.outputs.properties),
    DIFY_REQUIREMENT_OUTPUT_FIELDS,
  );
  assert.equal(
    PARSE_REQUIREMENT_OUTPUT_SCHEMA.properties.data.properties.outputs.additionalProperties,
    false,
  );
});

test("validate_requirement card forbids same-platform child allocation", () => {
  const card = projectFile("skills/media-assistant/references/tools/validate_requirement.md");

  assert.doesNotMatch(card, /same-platform multi-type allocation/iu);
  assert.doesNotMatch(card, /remaining child calls.*same-platform type allocation/iu);
  assert.match(card, /keep one requirement with the original total/u);
  assert.match(card, /for `询价机构`.*search_creators/iu);
  assert.match(card, /for `手动拓展`.*select_inquiry_form_fields/iu);
  assert.match(card, /Every genuinely new later start of either function requires a new parse/iu);
  assert.match(card, /never reuse the previous function's requirement/iu);
  assert.doesNotMatch(card, /normal new-requirement flow.*immediately call `search_creators`/iu);
});

test("business contracts distinguish a new function start from resumed inquiry recipients", () => {
  const contracts = {
    skill: projectFile("skills/media-assistant/SKILL.md"),
    parse: projectFile("skills/media-assistant/references/tools/ypscan_parse_requirement.md"),
    validate: projectFile("skills/media-assistant/references/tools/validate_requirement.md"),
    manual: projectFile("skills/media-assistant/references/tools/manual_source_creators.md"),
    question: projectFile("skills/media-assistant/references/tools/askuserquestion.md"),
    distribution: projectFile(
      "skills/media-assistant/references/tools/create_with_distributions.md",
    ),
  };

  assert.match(
    contracts.skill,
    /每次真正开始新的询价机构或手动拓展都必须先创建独立的新 requirement/u,
  );
  assert.match(contracts.skill, /“暂不询价”是唯一的续办例外/u);
  assert.match(contracts.parse, /每次真正开始新的询价机构或手动拓展都重新调用本工具/u);
  assert.match(contracts.parse, /属于恢复原询价分支/u);
  assert.match(
    contracts.validate,
    /Every genuinely new later start of either function requires a new parse/iu,
  );
  assert.match(contracts.validate, /Resuming recipient selection.*is not a new start/iu);
  assert.match(contracts.manual, /每次开始手动拓展都先解析、复核并创建独立的新 requirement/u);
  assert.match(contracts.question, /改用另一功能时，也必须重新解析、复核并创建新 requirement/u);
  assert.match(contracts.question, /沿用原 requirement 与机构映射/u);
  assert.match(contracts.distribution, /explicit.*`前 5 家`.*recipient selection/iu);

  for (const contract of Object.values(contracts)) {
    assert.doesNotMatch(contract, /unchanged requirement may be reused for the other function/iu);
    assert.doesNotMatch(contract, /do not create another requirement for the same request/iu);
  }
});

test("manual sourcing shares the reviewed relaxation policy and recreates requirements", () => {
  const skill = projectFile("skills/media-assistant/SKILL.md");
  const manual = projectFile("skills/media-assistant/references/tools/manual_source_creators.md");
  const status = projectFile(
    "skills/media-assistant/references/tools/manual_source_creators_status.md",
  );

  assert.match(skill, /自动放宽/u);
  assert.match(skill, /实际数量.*(?:0|不足|少于)/su);
  assert.match(skill, /新 requirement|独立的新 requirement/u);
  assert.match(skill, /重新.*字段/u);
  assert.match(skill, /先复核，再放宽/u);
  assert.match(skill, /在结果前汇总全部放宽记录/u);
  assert.match(skill, /手动修改需求 \/ 改用询价机构 \/ 结束/u);
  assert.match(manual, /creator_links_csv_url/u);
  assert.match(manual, /20 个 author 一批/u);
  assert.match(manual, /ypscan_merge_creator_csv → ypscan_upload_creator_csv → score_manual_source_csv/u);
  assert.match(status, /creator_links_csv_url/u);
  assert.match(status, /20 个 author 一批/u);
  assert.match(status, /兼容降级路径/u);
});

test("save artifact card binds final Excel saves to the requirement ID", () => {
  const card = projectFile("skills/media-assistant/references/tools/ypscan_save_excel_artifact.md");

  assert.match(card, /`manual_source_creators`/iu);
  assert.match(card, /`manual_source_creators_status`/iu);
  assert.match(card, /`rank_creators`/iu);
  assert.match(card, /`score_manual_source_csv`/iu);
  assert.match(
    card,
    /Use the current requirement ID for `mcn_ranking`, `mcn_creator_preview`, `manual_source`, and `ranked_submission`/iu,
  );
  assert.match(card, /`artifact_id`.*current requirement ID.*`manual_source`/isu);
  assert.match(card, /`ranked_submission`.*final ranked institutional submission workbook/isu);
});

test("inquiry ranking contracts use uploaded csv_file_path and ranked_submission", () => {
  const skill = projectFile("skills/media-assistant/SKILL.md");
  const ingestCard = projectFile("skills/media-assistant/references/tools/get_ingest_job.md");
  const rankCard = projectFile("skills/media-assistant/references/tools/rank_creators.md");

  assert.match(skill, /保存机构达人预览表 → 保存 links CSV → 选择“精排并生成提报表 \/ 只补全达人信息”/u);
  assert.match(skill, /正式链路不再调用 `create_submission_batch`、`get_creator_detail` 或 `get_creator_detail_export`/u);
  assert.match(ingestCard, /creator_links_csv_url/iu);
  assert.match(ingestCard, /Never skip directly to `rank_creators`/iu);
  assert.match(rankCard, /`csv_file_path`/iu);
  assert.match(rankCard, /`artifact_kind="ranked_submission"`/iu);
  assert.match(rankCard, /Do not call `create_submission_batch`, `get_creator_detail`, or `get_creator_detail_export`/iu);
});

test("parser and validation cards agree on explicit reference creator fields", () => {
  const parseCard = projectFile(
    "skills/media-assistant/references/tools/ypscan_parse_requirement.md",
  );
  const validateCard = projectFile(
    "skills/media-assistant/references/tools/validate_requirement.md",
  );

  for (const card of [parseCard, validateCard]) {
    assert.match(
      card,
      /`refNickname`.*`refUrl`.*用户明确|`refNickname`.*`refUrl`.*user explicitly/isu,
    );
    assert.match(card, /绝不.*推断|Never infer/iu);
  }
  assert.doesNotMatch(parseCard, /不传[^。\n]*`refNickname`[^。\n]*`refUrl`/u);
});

test("new inquiry contracts remove formal creator enrichment after ranking", () => {
  const skill = projectFile("skills/media-assistant/SKILL.md");
  const rankCard = projectFile("skills/media-assistant/references/tools/rank_creators.md");

  assert.match(skill, /正式链路不再调用 `create_submission_batch`、`get_creator_detail` 或 `get_creator_detail_export`/u);
  assert.match(rankCard, /Do not call `create_submission_batch`, `get_creator_detail`, or `get_creator_detail_export`/iu);
});

test("parser card keeps required contentTag distinct from optional labels", () => {
  const card = projectFile("skills/media-assistant/references/tools/ypscan_parse_requirement.md");
  const validateCard = projectFile(
    "skills/media-assistant/references/tools/validate_requirement.md",
  );

  assert.match(card, /八个可选 Label 数组/u);
  assert.match(card, /`contentTag` 必须是非空字符串数组/u);
  assert.match(card, /contentTag.*缺失.*重新解析/u);
  assert.doesNotMatch(card, /八个 Label 和 `contentTag`.*缺失直接省略/u);
  assert.doesNotMatch(card, /任何标签（八个 Label 和 `contentTag`）不得触发弹窗/u);
  assert.match(validateCard, /contentTag.*non-empty string array/iu);
  assert.doesNotMatch(validateCard, /Parsed Label arrays and `contentTag`.*omit any label/iu);
  assert.match(card, /用户主动修改任何业务条件.*重新解析/isu);
  assert.doesNotMatch(card, /单条件修改|只修改一个条件.*直接更新/isu);
});

test("parser publishes only the single-platform workflow input", () => {
  assert.deepEqual(PARSE_REQUIREMENT_PARAMETERS.required, ["demand", "business_mode"]);
  assert.deepEqual(Object.keys(PARSE_REQUIREMENT_PARAMETERS.properties), [
    "demand",
    "business_mode",
  ]);
  assert.deepEqual(PARSE_REQUIREMENT_PARAMETERS.properties.business_mode.enum, [
    "询价机构",
    "手动拓展",
  ]);
  assert.equal(PARSE_REQUIREMENT_PARAMETERS.additionalProperties, false);
  assert.match(PARSE_REQUIREMENT_PARAMETERS.properties.demand.description, /任何业务条件/u);
  assert.match(PARSE_REQUIREMENT_PARAMETERS.properties.demand.description, /用户原始表述/u);
  assert.match(PARSE_REQUIREMENT_PARAMETERS.properties.demand.description, /禁止回填历史解析输出/u);
  assert.match(PARSE_REQUIREMENT_PARAMETERS.properties.business_mode.description, /用户明确表达/u);
  assert.match(
    PARSE_REQUIREMENT_PARAMETERS.properties.business_mode.description,
    /未明确.*AskUserQuestion/u,
  );
  assert.doesNotMatch(
    PARSE_REQUIREMENT_PARAMETERS.properties.business_mode.description,
    /必须与弹窗答案一致/u,
  );

  assert.deepEqual(PARSE_REQUIREMENT_OUTPUT_SCHEMA.properties.data.required, ["outputs"]);
  assert.equal(
    PARSE_REQUIREMENT_OUTPUT_SCHEMA.properties.data.properties.outputs.additionalProperties,
    false,
  );
  assert.deepEqual(
    Object.keys(PARSE_REQUIREMENT_OUTPUT_SCHEMA.properties.data.properties.outputs.properties),
    DIFY_REQUIREMENT_OUTPUT_FIELDS,
  );
  assert.deepEqual(DIFY_REQUIREMENT_FIELDS, [
    "growBloggerTypeLabel",
    "contentFeatureLabel",
    "contentThemeLabel",
    "kolPersonaLabel",
    "pgyBloggerTypeLabel",
    "xtTalentTypeLabel",
    "industryTagLabel",
    "growTalentTypeLabel",
    "contentTag",
    "brandName",
    "followercount",
    "rebate",
    "kolOfficialPrice",
    "cpm",
    "cpe",
  ]);
});

test("parser calls the workflow in blocking mode and returns only contracted outputs", async () => {
  const outputs = {
    growBloggerTypeLabel: ["护肤", "通勤"],
    contentFeatureLabel: null,
    contentThemeLabel: ["真实测评"],
    kolPersonaLabel: ["职场女性"],
    pgyBloggerTypeLabel: ["美妆"],
    xtTalentTypeLabel: ["生活"],
    industryTagLabel: ["个护"],
    growTalentTypeLabel: ["潜力达人"],
    xhsbrandName: null,
    dybrandName: ["测试品牌"],
    contentTag: { contentTag: ["护肤", "通勤"] },
    followercount: { followercount: "[10000,50000]" },
    rebate: { rebate: "[0.3,1]" },
    xhs_kolOfficialPrice: null,
    dy_kolOfficialPrice: { kolOfficialPriceL1: "[7000,12000]" },
    xhs_cpm: null,
    dy_cpm: { cpmL1: "[0,100]" },
    xhs_cpe: null,
    dy_cpe: { cpeL1: "[0,20]" },
    workflowInternalTrace: "must not leak into the tool result",
  };
  const expectedOutputs = { ...outputs };
  delete expectedOutputs.workflowInternalTrace;
  let captured;
  const parser = createRequirementParser({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return response({
        workflow_run_id: "workflow-run-1",
        data: { status: "succeeded", outputs },
      });
    },
  });

  const result = await parser({ demand: "  小红书护肤需求  ", business_mode: "询价机构" });
  const parsed = payload(result);

  assert.equal(captured.url, DIFY_WORKFLOW_URL);
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  const requestBody = JSON.parse(captured.options.body);
  assert.deepEqual(
    { inputs: requestBody.inputs, response_mode: requestBody.response_mode },
    {
      inputs: { demand: "小红书护肤需求" },
      response_mode: "blocking",
    },
  );
  assert.match(requestBody.user, /^ypscan-[a-f0-9]{24}$/u);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.outputs, expectedOutputs);
  assert.equal(Object.hasOwn(parsed.data, "demandFingerprint"), false);
  assert.equal(Object.hasOwn(parsed.data, "workflowRunId"), false);
  assert.equal(result.details, undefined);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text.includes("\n"), false);
});

test("parser preserves every output field declared by runtime constants", async () => {
  const expected = Object.fromEntries(
    DIFY_REQUIREMENT_OUTPUT_FIELDS.map((field) => [field, { marker: field }]),
  );
  const parser = createRequirementParser({
    apiKey: "test-key",
    fetchImpl: async () =>
      response({
        data: {
          status: "succeeded",
          outputs: { ...expected, workflowInternalTrace: "discard" },
        },
      }),
  });

  const parsed = payload(await parser({ demand: "抖音需求", business_mode: "手动拓展" }));
  assert.deepEqual(parsed.data.outputs, expected);
});

test("missing parser-owned fields remain missing inside the compact outputs object", async () => {
  const parser = createRequirementParser({
    apiKey: "test-key",
    fetchImpl: async () =>
      response({ data: { id: "data-run-1", status: "succeeded", outputs: { brandName: null } } }),
  });

  const parsed = payload(await parser({ demand: "抖音需求", business_mode: "直接手扒" }));
  assert.deepEqual(parsed.data.outputs, { brandName: null });
});

test("parser requires a valid current business mode before calling the workflow", async () => {
  let called = false;
  const parser = createRequirementParser({
    apiKey: "test-key",
    fetchImpl: async () => {
      called = true;
      return response({ data: { status: "succeeded", outputs: {} } });
    },
  });

  const missing = await parser({ demand: "抖音需求" });
  assert.equal(called, false);
  assert.equal(missing.isError, true);
  assert.equal(payload(missing).error.code, "INVALID_BUSINESS_MODE");

  const invalid = await parser({ demand: "抖音需求", business_mode: "人工拓展" });
  assert.equal(payload(invalid).error.code, "INVALID_BUSINESS_MODE");
  assert.equal(called, false);
});

test("invalid demand fails without calling the workflow", async () => {
  let called = false;
  const parser = createRequirementParser({
    apiKey: "test-key",
    fetchImpl: async () => {
      called = true;
      throw new Error("should not run");
    },
  });

  const result = await parser({ demand: "   " });
  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.equal(payload(result).error.code, "INVALID_INPUT");
});

test("workflow transport and response failures keep distinct error codes", async (t) => {
  const cases = [
    {
      name: "request",
      fetchImpl: async () => {
        throw new Error("offline");
      },
      code: "DIFY_REQUEST_FAILED",
    },
    {
      name: "timeout",
      fetchImpl: async () => {
        const error = new Error("timeout");
        error.name = "TimeoutError";
        throw error;
      },
      code: "DIFY_TIMEOUT",
    },
    {
      name: "invalid json",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad json");
        },
      }),
      code: "DIFY_INVALID_RESPONSE",
    },
    {
      name: "http",
      fetchImpl: async () => response({ message: "denied" }, { ok: false, status: 401 }),
      code: "DIFY_HTTP_ERROR",
    },
    {
      name: "workflow",
      fetchImpl: async () => response({ data: { status: "failed", outputs: {} } }),
      code: "DIFY_WORKFLOW_FAILED",
    },
    {
      name: "outputs",
      fetchImpl: async () => response({ data: { status: "succeeded" } }),
      code: "DIFY_OUTPUT_INVALID",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const parser = createRequirementParser({ apiKey: "test-key", fetchImpl: item.fetchImpl });
      const result = await parser({ demand: "测试需求", business_mode: "询价机构" });
      assert.equal(result.isError, true);
      assert.equal(payload(result).error.code, item.code);
    });
  }
});

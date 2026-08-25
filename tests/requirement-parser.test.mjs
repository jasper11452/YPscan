import assert from "node:assert/strict";
import test from "node:test";

import {
  createRequirementParser,
  DIFY_REQUIREMENT_FIELDS,
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

test("parser publishes only the single-platform Dify input", () => {
  assert.deepEqual(PARSE_REQUIREMENT_PARAMETERS.required, ["demand"]);
  assert.deepEqual(Object.keys(PARSE_REQUIREMENT_PARAMETERS.properties), ["demand"]);
  assert.equal(PARSE_REQUIREMENT_PARAMETERS.additionalProperties, false);
  assert.match(PARSE_REQUIREMENT_PARAMETERS.properties.demand.description, /用户原始表述/u);
  assert.match(PARSE_REQUIREMENT_PARAMETERS.properties.demand.description, /禁止回填 Dify 输出/u);

  assert.deepEqual(PARSE_REQUIREMENT_OUTPUT_SCHEMA.properties.data.required, [
    "outputs",
    "demandFingerprint",
    "workflowRunId",
  ]);
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

test("parser calls Dify in blocking mode and preserves the complete raw outputs", async () => {
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
    futureWorkflowField: "preserve without local interpretation",
  };
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

  const result = await parser({ demand: "  小红书护肤需求  " });
  const parsed = payload(result);

  assert.equal(captured.url, DIFY_WORKFLOW_URL);
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(captured.options.body), {
    inputs: { demand: "小红书护肤需求" },
    response_mode: "blocking",
    user: `ypscan-${parsed.data.demandFingerprint.slice(0, 24)}`,
  });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.outputs, outputs);
  assert.equal(parsed.data.workflowRunId, "workflow-run-1");
  assert.deepEqual(result.details, parsed.data);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text.includes("\n"), false);
});

test("missing Dify-owned fields remain missing inside the untouched outputs object", async () => {
  const parser = createRequirementParser({
    apiKey: "test-key",
    fetchImpl: async () =>
      response({ data: { id: "data-run-1", status: "succeeded", outputs: { brandName: null } } }),
  });

  const parsed = payload(await parser({ demand: "抖音需求" }));
  assert.deepEqual(parsed.data.outputs, { brandName: null });
  assert.equal(parsed.data.workflowRunId, "data-run-1");
});

test("invalid demand fails without calling Dify", async () => {
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

test("Dify transport and response failures keep distinct error codes", async (t) => {
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
      const result = await parser({ demand: "测试需求" });
      assert.equal(result.isError, true);
      assert.equal(payload(result).error.code, item.code);
    });
  }
});

import { createHash } from "node:crypto";

import { isRecord, nonemptyString } from "../util/value.js";
import { BUSINESS_MODE_VALUES, normalizeBusinessMode } from "../contract/registry.js";
import { hostToolResult } from "./tool-result.js";

export const DIFY_WORKFLOW_URL = "https://dfi.eshypdata.com/v1/workflows/run";

const DIFY_PUBLIC_WORKFLOW_KEY = "app-z3DOs0mgpMIETn3HZI5KNFm5";

export const DIFY_REQUIREMENT_FIELDS = Object.freeze([
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

export const DIFY_REQUIREMENT_OUTPUT_FIELDS = Object.freeze([
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
  "xhsbrandName",
  "dybrandName",
  "followercount",
  "rebate",
  "kolOfficialPrice",
  "kolOfficialPriceL1",
  "kolOfficialPriceL2",
  "kolOfficialPriceL3",
  "xhs_kolOfficialPrice",
  "dy_kolOfficialPrice",
  "cpm",
  "cpmL1",
  "cpmL2",
  "cpmL3",
  "xhs_cpm",
  "dy_cpm",
  "cpe",
  "cpeL1",
  "cpeL2",
  "cpeL3",
  "xhs_cpe",
  "dy_cpe",
]);

export const PARSE_REQUIREMENT_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["demand", "business_mode"],
  properties: {
    demand: {
      type: "string",
      minLength: 1,
      description:
        "当前单个平台的完整最新用户需求原文；首次解析及用户主动修改任何业务条件后都必传，重传时只合并用户原始表述和后续人工改口，禁止回填历史解析输出、自动放宽值或 Provider 归一化值",
    },
    business_mode: {
      type: "string",
      enum: [...BUSINESS_MODE_VALUES],
      description:
        "用户明确表达的初始业务功能；未明确或语义冲突时通过 AskUserQuestion 选择",
    },
  },
});

const DIFY_VALUE_SCHEMA = Object.freeze({
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "array" },
    { type: "object" },
    { type: "null" },
  ],
});

export const PARSE_REQUIREMENT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["success", "data"],
  properties: {
    success: { type: "boolean", const: true },
    data: {
      type: "object",
      additionalProperties: false,
      required: ["outputs"],
      properties: {
        outputs: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            DIFY_REQUIREMENT_OUTPUT_FIELDS.map((field) => [field, DIFY_VALUE_SCHEMA]),
          ),
        },
      },
    },
  },
});

function demandFingerprint(demand) {
  return createHash("sha256").update(demand).digest("hex");
}

function contractedOutputs(outputs) {
  return Object.fromEntries(
    DIFY_REQUIREMENT_OUTPUT_FIELDS.filter((field) => Object.hasOwn(outputs, field)).map((field) => [
      field,
      outputs[field],
    ]),
  );
}

function failure(code, message) {
  return hostToolResult(
    {
      success: false,
      error: {
        code,
        message,
      },
    },
    { isError: true, compact: true },
  );
}

/**
 * Create the requirement parser. Only fields consumed by the current Provider
 * contract are exposed to the Agent.
 *
 * @param {{ apiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export function createRequirementParser({
  apiKey = DIFY_PUBLIC_WORKFLOW_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
} = {}) {
  /** @param {{ demand?: string, business_mode?: string }} [params] */
  return async function parseRequirement(params = {}) {
    const demand = typeof params.demand === "string" ? params.demand.trim() : "";
    if (!demand) return failure("INVALID_INPUT", "demand 必须是非空的单平台需求文本");
    const businessMode = normalizeBusinessMode(params.business_mode);
    if (!businessMode) {
      return failure(
        "INVALID_BUSINESS_MODE",
        'business_mode 必须是用户明确表达或通过模式选择确定的 "询价机构" 或 "手动拓展"',
      );
    }
    if (!nonemptyString(apiKey)) {
      return failure("DIFY_API_KEY_MISSING", "需求解析 Workflow 凭据不可用");
    }
    if (typeof fetchImpl !== "function") {
      return failure("DIFY_CLIENT_UNAVAILABLE", "当前运行环境不支持 HTTP 调用");
    }

    const fingerprint = demandFingerprint(demand);
    let response;
    try {
      response = await fetchImpl(DIFY_WORKFLOW_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: { demand },
          response_mode: "blocking",
          user: `ypscan-${fingerprint.slice(0, 24)}`,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return failure(
        error?.name === "TimeoutError" ? "DIFY_TIMEOUT" : "DIFY_REQUEST_FAILED",
        "需求解析请求失败",
      );
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch {
      return failure("DIFY_INVALID_RESPONSE", "需求解析未返回有效 JSON");
    }
    if (!response.ok) {
      return failure("DIFY_HTTP_ERROR", `需求解析返回 HTTP ${response.status}`);
    }
    if (!isRecord(envelope?.data) || envelope.data.status !== "succeeded") {
      return failure("DIFY_WORKFLOW_FAILED", "需求解析 Workflow 未成功完成");
    }
    if (!isRecord(envelope.data.outputs)) {
      return failure("DIFY_OUTPUT_INVALID", "需求解析 Workflow 缺少 outputs 对象");
    }

    const data = { outputs: contractedOutputs(envelope.data.outputs) };
    const payload = { success: true, data };
    return hostToolResult(payload, { compact: true });
  };
}

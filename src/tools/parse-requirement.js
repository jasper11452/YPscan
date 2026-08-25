import { createHash } from "node:crypto";

import { firstString, isRecord, nonemptyString } from "../util/value.js";
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

export const PARSE_REQUIREMENT_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["demand"],
  properties: {
    demand: {
      type: "string",
      minLength: 1,
      description:
        "当前单个平台的完整最新用户需求原文；首次解析必传，用户一次修改涉及两个及以上条件时只合并用户原始表述和后续改口后重传，禁止回填 Dify 输出或 Provider 归一化值",
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
      required: ["outputs", "demandFingerprint", "workflowRunId"],
      properties: {
        outputs: {
          type: "object",
          additionalProperties: DIFY_VALUE_SCHEMA,
        },
        demandFingerprint: { type: "string" },
        workflowRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  },
});

function demandFingerprint(demand) {
  return createHash("sha256").update(demand).digest("hex");
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
 * Create the Dify-backed requirement parser. The proxy deliberately preserves
 * the complete Workflow output; semantic reconciliation belongs to the Agent.
 *
 * @param {{ apiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export function createRequirementParser({
  apiKey = DIFY_PUBLIC_WORKFLOW_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
} = {}) {
  /** @param {{ demand?: string }} [params] */
  return async function parseRequirement(params = {}) {
    const demand = typeof params.demand === "string" ? params.demand.trim() : "";
    if (!demand) return failure("INVALID_INPUT", "demand 必须是非空的单平台需求文本");
    if (!nonemptyString(apiKey)) {
      return failure("DIFY_API_KEY_MISSING", "Dify Workflow 凭据不可用");
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
        "Dify 需求解析请求失败",
      );
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch {
      return failure("DIFY_INVALID_RESPONSE", "Dify 未返回有效 JSON");
    }
    if (!response.ok) {
      return failure("DIFY_HTTP_ERROR", `Dify 需求解析返回 HTTP ${response.status}`);
    }
    if (!isRecord(envelope?.data) || envelope.data.status !== "succeeded") {
      return failure("DIFY_WORKFLOW_FAILED", "Dify Workflow 未成功完成");
    }
    if (!isRecord(envelope.data.outputs)) {
      return failure("DIFY_OUTPUT_INVALID", "Dify Workflow 缺少 outputs 对象");
    }

    const data = {
      outputs: envelope.data.outputs,
      demandFingerprint: fingerprint,
      workflowRunId: firstString(envelope.workflow_run_id, envelope.data.id) ?? null,
    };
    const payload = { success: true, data };
    return hostToolResult(payload, { details: data, compact: true });
  };
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { hostToolResult } from "./tool-result.js";
import { countCsvDataRows, parseCsv } from "./creator-csv.js";
import { nonemptyString } from "../util/value.js";

const FLOW_VALUES = Object.freeze(["manual_source", "mcn_rank"]);

function failure(code, message, details = {}, retriable = false) {
  return hostToolResult(
    {
      success: false,
      error: {
        code,
        message,
        details,
        retriable,
      },
    },
    { details, isError: true },
  );
}

function success(details) {
  return hostToolResult({ success: true, data: details }, { details });
}

function creatorCsvUploadUrl(baseUrl) {
  return new URL("/mock/upload-creator-csv", baseUrl).toString();
}

export async function uploadCreatorCsv(
  params,
  { fetchImpl = globalThis.fetch, testAdapterBaseUrl = null } = {},
) {
  const mergedCsvPath = params?.merged_csv_path;
  const requirementId = params?.requirement_id;
  const flow = params?.flow;
  if (
    !nonemptyString(mergedCsvPath) ||
    !isAbsolute(mergedCsvPath) ||
    !nonemptyString(requirementId) ||
    !FLOW_VALUES.includes(flow)
  ) {
    return failure("YPSCAN_CREATOR_CSV_UPLOAD_INVALID_INPUT", "upload 参数不完整或格式无效");
  }

  let csvText;
  try {
    csvText = await readFile(mergedCsvPath, "utf8");
  } catch (error) {
    return failure(
      "YPSCAN_CREATOR_CSV_UPLOAD_READ_FAILED",
      "无法读取待上传的 merged CSV",
      error instanceof Error ? { reason: error.message } : {},
    );
  }

  let dataRowCount;
  try {
    dataRowCount = countCsvDataRows(parseCsv(csvText).rows);
  } catch (error) {
    return failure(
      "YPSCAN_CREATOR_CSV_UPLOAD_INVALID_FILE",
      "merged CSV 不是有效 CSV 文件",
      error instanceof Error ? { reason: error.message } : {},
    );
  }

  if (dataRowCount <= 0) {
    return failure("YPSCAN_CREATOR_CSV_EMPTY", "merged CSV 没有可上传的数据行");
  }
  if (dataRowCount > 500) {
    return failure(
      "YPSCAN_CREATOR_CSV_LIMIT_EXCEEDED",
      "merged CSV 数据行超过 500，已在上传前阻断",
      { data_row_count: dataRowCount, limit: 500 },
    );
  }
  if (!testAdapterBaseUrl) {
    return failure(
      "YPSCAN_CREATOR_CSV_UPLOAD_UNAVAILABLE",
      "当前仓库未定义生产 CSV 暂存端点契约，无法真实上传 merged CSV",
      { data_row_count: dataRowCount },
    );
  }
  if (typeof fetchImpl !== "function") {
    return failure("YPSCAN_CREATOR_CSV_UPLOAD_UNAVAILABLE", "当前运行环境不支持 CSV 上传");
  }

  const sha256 = createHash("sha256").update(csvText).digest("hex");
  try {
    const response = await fetchImpl(creatorCsvUploadUrl(testAdapterBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: requirementId,
        flow,
        merged_csv_path: mergedCsvPath,
        data_row_count: dataRowCount,
        sha256,
        csv_text: csvText,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return failure(
        "YPSCAN_CREATOR_CSV_UPLOAD_FAILED",
        `CSV 上传返回 HTTP ${response.status}`,
        { http_status: response.status, data_row_count: dataRowCount },
      );
    }
    const payload = await response.json().catch(() => null);
    const csvFilePath = payload?.data?.csv_file_path ?? payload?.csv_file_path;
    if (!nonemptyString(csvFilePath)) {
      return failure(
        "YPSCAN_CREATOR_CSV_UPLOAD_FAILED",
        "CSV 上传成功响应缺少 csv_file_path",
        { data_row_count: dataRowCount },
      );
    }
    return success({
      requirement_id: String(requirementId),
      flow,
      merged_csv_path: String(mergedCsvPath),
      csv_file_path: String(csvFilePath),
      data_row_count: dataRowCount,
      sha256,
    });
  } catch (error) {
    return failure(
      "YPSCAN_CREATOR_CSV_UPLOAD_FAILED",
      "CSV 上传失败",
      error instanceof Error ? { reason: error.message, data_row_count: dataRowCount } : { data_row_count: dataRowCount },
      true,
    );
  }
}

export function createCreatorCsvUploader({ fetchImpl, testAdapterBaseUrl = null }) {
  return (params) => uploadCreatorCsv(params, { fetchImpl, testAdapterBaseUrl });
}

import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { hostToolResult } from "./tool-result.js";
import { countCsvDataRows, findRequiredHeaders, normalizeCsvHeader, parseCsv, rowsToObjects, stringifyCsv } from "./creator-csv.js";
import { localFileMarkdownLink } from "./save-excel-artifact.js";
import { nonemptyString } from "../util/value.js";

const FLOW_VALUES = Object.freeze(["manual_source", "mcn_rank", "mcn_complete_only"]);
const COMPLETION_ID_HEADER_CANDIDATES = Object.freeze([
  "creator_id",
  "kw_uid",
  "xt_id",
  "author_id",
  "authorid",
  "id",
]);
const RESERVED_HEADERS = new Set(["source_record_id", "creator_id", "url"]);

function failure(code, message, details = {}) {
  return hostToolResult(
    {
      success: false,
      error: { code, message, details, retriable: false },
    },
    { details, isError: true },
  );
}

function success(payload, filePath) {
  const localFileLink = localFileMarkdownLink(filePath);
  return hostToolResult(
    {
      success: true,
      data: payload,
      delivery: {
        local_path: filePath,
        local_file_link: localFileLink,
        display_required: true,
        display_before_next_action: true,
        user_visible_message: `已完成：merged CSV 已保存到本地。\n本地文件：${localFileLink}`,
      },
    },
    { details: payload },
  );
}

function sanitizeSegment(value, fallback) {
  const text = nonemptyString(value) ? value.trim() : fallback;
  return text.replace(/[^a-zA-Z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || fallback;
}

function preferredCompletionIdHeader(headers) {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeCsvHeader(header), header]));
  for (const candidate of COMPLETION_ID_HEADER_CANDIDATES) {
    const header = normalizedHeaders.get(candidate);
    if (header) return header;
  }
  return null;
}

function completionDetailHeaders(headers, idHeader) {
  return headers.filter((header) => {
    const normalized = normalizeCsvHeader(header);
    return header !== idHeader && !RESERVED_HEADERS.has(normalized);
  });
}

/**
 * @param {any} params
 * @param {{ workspaceDir?: string }} [options]
 */
export async function mergeCreatorCsv(
  params,
  { workspaceDir } = {},
) {
  const requirementId = params?.requirement_id;
  const platform = params?.platform;
  const flow = params?.flow;
  const linksCsvPath = params?.links_csv_path;
  const completionCsvPaths = params?.completion_csv_paths;
  if (
    !nonemptyString(requirementId) ||
    !["xiaohongshu", "douyin"].includes(platform) ||
    !FLOW_VALUES.includes(flow) ||
    !nonemptyString(linksCsvPath) ||
    !isAbsolute(linksCsvPath) ||
    !Array.isArray(completionCsvPaths) ||
    completionCsvPaths.length === 0 ||
    completionCsvPaths.some((item) => !nonemptyString(item) || !isAbsolute(item))
  ) {
    return failure("YPSCAN_CREATOR_CSV_MERGE_INVALID_INPUT", "merge 参数不完整或格式无效");
  }
  if (!nonemptyString(workspaceDir) || !isAbsolute(workspaceDir)) {
    return failure("YPSCAN_WORKSPACE_UNAVAILABLE", "宿主未提供可信的当前项目目录");
  }

  let workspacePath;
  try {
    await mkdir(workspaceDir, { recursive: true });
    workspacePath = await realpath(workspaceDir);
    const info = await stat(workspacePath);
    if (!info.isDirectory()) throw new Error("not_directory");
  } catch {
    return failure("YPSCAN_WORKSPACE_UNAVAILABLE", "当前项目目录不可用");
  }

  try {
    const linksCsv = await readFile(linksCsvPath, "utf8");
    const parsedLinks = parseCsv(linksCsv);
    const requiredHeaders = findRequiredHeaders(parsedLinks.headers, ["source_record_id", "creator_id", "url"]);
    if (!requiredHeaders) {
      return failure(
        "YPSCAN_CREATOR_LINKS_CSV_INVALID",
        "links CSV 缺少 source_record_id、creator_id 或 url 列",
      );
    }
    const linksRows = rowsToObjects(parsedLinks.headers, parsedLinks.rows).map((row) => ({
      source_record_id: row[requiredHeaders.get("source_record_id")],
      creator_id: row[requiredHeaders.get("creator_id")],
      url: row[requiredHeaders.get("url")],
    }));

    const detailsByCreatorId = new Map();
    /** @type {string[]} */
    const detailHeaders = [];
    const seenDetailHeaders = new Set();

    for (const completionCsvPath of completionCsvPaths) {
      const completionCsv = await readFile(completionCsvPath, "utf8");
      const parsedCompletion = parseCsv(completionCsv);
      const idHeader = preferredCompletionIdHeader(parsedCompletion.headers);
      if (!idHeader) {
        return failure(
          "YPSCAN_COMPLETION_CSV_INVALID",
          `补全 CSV 缺少可识别的 creator_id 列：${completionCsvPath}`,
        );
      }
      for (const header of completionDetailHeaders(parsedCompletion.headers, idHeader)) {
        if (seenDetailHeaders.has(header)) continue;
        seenDetailHeaders.add(header);
        detailHeaders.push(header);
      }
      for (const row of rowsToObjects(parsedCompletion.headers, parsedCompletion.rows)) {
        const creatorId = String(row[idHeader] ?? "").trim();
        if (!creatorId || detailsByCreatorId.has(creatorId)) continue;
        detailsByCreatorId.set(creatorId, row);
      }
    }

    /** @type {Record<string, string>[]} */
    const mergedRows = [];
    const missingCreatorIds = new Set();
    const matchedCreatorIds = new Set();
    for (const linkRow of linksRows) {
      const creatorId = String(linkRow.creator_id ?? "").trim();
      if (!creatorId) continue;
      const detailRow = detailsByCreatorId.get(creatorId);
      if (!detailRow) {
        missingCreatorIds.add(creatorId);
        continue;
      }
      matchedCreatorIds.add(creatorId);
      const mergedRow = {
        source_record_id: String(linkRow.source_record_id ?? ""),
        creator_id: creatorId,
        url: String(linkRow.url ?? ""),
      };
      for (const header of detailHeaders) {
        mergedRow[header] = String(detailRow[header] ?? "");
      }
      mergedRows.push(mergedRow);
    }

    const headers = ["source_record_id", "creator_id", "url", ...detailHeaders];
    const csvText = stringifyCsv(headers, mergedRows);
    const sha256 = createHash("sha256").update(csvText).digest("hex");
    const prefix = flow === "manual_source" ? "manual-source" : flow === "mcn_rank" ? "mcn-rank" : "mcn-complete";
    const fileName = `${prefix}-${sanitizeSegment(platform, "platform")}-${sanitizeSegment(requirementId, "requirement")}-${sha256.slice(0, 8)}.csv`;
    const filePath = join(workspacePath, fileName);
    const handle = await open(filePath, "wx", 0o600).catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
      return open(filePath, "r+");
    });
    try {
      const current = await handle.readFile({ encoding: "utf8" }).catch(() => "");
      if (current && current !== csvText) {
        return failure("YPSCAN_CREATOR_CSV_MERGE_CONFLICT", "目标 merged CSV 已存在且内容不同");
      }
      if (!current) {
        await handle.truncate(0);
        await handle.writeFile(csvText, { encoding: "utf8" });
        await handle.sync();
      }
    } finally {
      await handle.close();
    }

    return success(
      {
        requirement_id: String(requirementId),
        platform,
        flow,
        file_name: fileName,
        file_path: filePath,
        data_row_count: countCsvDataRows(mergedRows),
        matched_creator_ids: [...matchedCreatorIds],
        missing_creator_ids: [...missingCreatorIds],
        completion_csv_paths: completionCsvPaths.map(String),
        links_csv_path: String(linksCsvPath),
        sha256,
      },
      filePath,
    );
  } catch (error) {
    return failure(
      "YPSCAN_CREATOR_CSV_MERGE_FAILED",
      "merged CSV 生成失败",
      error instanceof Error ? { reason: error.message } : {},
    );
  }
}

export function createCreatorCsvMerger({ workspaceDir }) {
  return (params) => mergeCreatorCsv(params, { workspaceDir });
}

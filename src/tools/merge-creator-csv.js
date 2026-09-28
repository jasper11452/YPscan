import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { nonemptyString } from "../util/value.js";

const FLOW_VALUES = Object.freeze(["manual_source", "mcn_rank", "mcn_complete_only", "creator_detail"]);
// 按平台选择与 links creator_id 同源的 ID；仅缺少优先列时兼容旧表头，不按匹配率猜列。
const COMPLETION_ID_HEADER_CANDIDATES = Object.freeze({
  douyin: [
    "creator_id",
    "请求星图ID",
    "星图ID",
    "xt_id",
    "请求kw_uid",
    "kw_uid",
    "author_id",
    "authorid",
    "id",
  ],
  xiaohongshu: ["creator_id", "请求kw_uid", "kw_uid", "xt_id", "author_id", "authorid", "id"],
});
const RESERVED_HEADERS = new Set(["source_record_id", "creator_id", "url"]);

export function parseCsv(value) {
  const text = String(value);
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char !== "\r") field += char;
  }

  if (quoted) throw new TypeError("CSV 引号未闭合");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return { headers: [], rows: [] };

  const [headers, ...dataRows] = rows;
  return {
    headers,
    rows: dataRows
      .filter((columns) => columns.some((item) => item !== ""))
      .map((columns) => {
        const normalized = columns.slice(0, headers.length);
        while (normalized.length < headers.length) normalized.push("");
        return normalized;
      }),
  };
}

function stringifyCsv(headers, rows) {
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    headers.map(escape).join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header] ?? "")).join(",")),
  ].join("\n");
}

function rowsToObjects(headers, rows) {
  return rows.map((columns) =>
    Object.fromEntries(headers.map((header, index) => [header, columns[index] ?? ""])),
  );
}

export function normalizeCsvHeader(header) {
  return String(header)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
}

export function findRequiredHeaders(headers, requiredHeaders) {
  const byNormalized = new Map(headers.map((header) => [normalizeCsvHeader(header), header]));
  const resolved = new Map();
  for (const requiredHeader of requiredHeaders) {
    const header = byNormalized.get(normalizeCsvHeader(requiredHeader));
    if (!header) return null;
    resolved.set(requiredHeader, header);
  }
  return resolved;
}

function failure(code, message, details = {}) {
  return { ok: false, code, message, details };
}

function sanitizeSegment(value, fallback) {
  const text = nonemptyString(value) ? value.trim() : fallback;
  return text.replace(/[^a-zA-Z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || fallback;
}

function preferredCompletionIdHeader(headers, platform) {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeCsvHeader(header), header]));
  for (const candidate of COMPLETION_ID_HEADER_CANDIDATES[platform]) {
    const header = normalizedHeaders.get(normalizeCsvHeader(candidate));
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
 * @param {{ workspaceDir?: string, readFileImpl?: typeof readFile }} [options]
 */
export async function mergeCreatorCsvFiles(params, { workspaceDir, readFileImpl = readFile } = {}) {
  const requirementId = params?.requirement_id;
  const fieldId = params?.field_id;
  const platform = params?.platform;
  const flow = params?.flow;
  const linksCsvPath = params?.links_csv_path;
  const completionCsvPaths = params?.completion_csv_paths;
  const isCreatorDetail = flow === "creator_detail";
  const scopeId = isCreatorDetail ? fieldId : requirementId;
  const scopeIdText = scopeId == null ? "" : String(scopeId).trim();
  if (
    !nonemptyString(scopeIdText) ||
    !["xiaohongshu", "douyin"].includes(platform) ||
    !FLOW_VALUES.includes(flow) ||
    (!isCreatorDetail &&
      (!nonemptyString(linksCsvPath) ||
        !isAbsolute(linksCsvPath) ||
        linksCsvPath !== linksCsvPath.trim())) ||
    !Array.isArray(completionCsvPaths) ||
    completionCsvPaths.length === 0 ||
    completionCsvPaths.some(
      (item) => !nonemptyString(item) || item !== item.trim() || !isAbsolute(item),
    )
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
    /** @type {Record<string, string>[]} */
    let linksRows = [];
    if (!isCreatorDetail) {
      const linksCsv = await readFileImpl(linksCsvPath, "utf8");
      const parsedLinks = parseCsv(linksCsv);
      const requiredHeaders = findRequiredHeaders(parsedLinks.headers, [
        "source_record_id",
        "creator_id",
        "url",
      ]);
      if (!requiredHeaders) {
        return failure(
          "YPSCAN_CREATOR_LINKS_CSV_INVALID",
          "links CSV 缺少 source_record_id、creator_id 或 url 列",
        );
      }
      linksRows = rowsToObjects(parsedLinks.headers, parsedLinks.rows).map((row) => ({
        source_record_id: row[requiredHeaders.get("source_record_id")],
        creator_id: row[requiredHeaders.get("creator_id")],
        url: row[requiredHeaders.get("url")],
      }));
    }

    const detailsByCreatorId = new Map();
    /** @type {string[]} */
    const orderedCreatorIds = [];
    /** @type {string[]} */
    const detailHeaders = [];
    const seenDetailHeaders = new Set();
    const completionIdColumns = [];

    for (const completionCsvPath of completionCsvPaths) {
      const completionCsv = await readFileImpl(completionCsvPath, "utf8");
      const parsedCompletion = parseCsv(completionCsv);
      const idHeader = preferredCompletionIdHeader(parsedCompletion.headers, platform);
      if (!idHeader) {
        return failure(
          "YPSCAN_COMPLETION_CSV_INVALID",
          `补全 CSV 缺少可识别的 creator_id 列：${completionCsvPath}`,
        );
      }
      completionIdColumns.push({ file_path: completionCsvPath, id_column: idHeader.trim() });
      for (const header of completionDetailHeaders(parsedCompletion.headers, idHeader)) {
        if (seenDetailHeaders.has(header)) continue;
        seenDetailHeaders.add(header);
        detailHeaders.push(header);
      }
      for (const row of rowsToObjects(parsedCompletion.headers, parsedCompletion.rows)) {
        const creatorId = String(row[idHeader] ?? "").trim();
        if (!creatorId || detailsByCreatorId.has(creatorId)) continue;
        detailsByCreatorId.set(creatorId, row);
        orderedCreatorIds.push(creatorId);
      }
    }

    /** @type {Record<string, string>[]} */
    const mergedRows = [];
    const missingCreatorIds = new Set();
    const matchedCreatorIds = new Set();
    if (isCreatorDetail) {
      for (const creatorId of orderedCreatorIds) {
        const detailRow = detailsByCreatorId.get(creatorId);
        const mergedRow = { creator_id: creatorId };
        for (const header of detailHeaders) {
          mergedRow[header] = String(detailRow?.[header] ?? "");
        }
        mergedRows.push(mergedRow);
        matchedCreatorIds.add(creatorId);
      }
    } else {
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
    }

    const headers = isCreatorDetail
      ? ["creator_id", ...detailHeaders]
      : ["source_record_id", "creator_id", "url", ...detailHeaders];
    const csvText = stringifyCsv(headers, mergedRows);
    const deliveryCsvText = flow === "mcn_complete_only" ? `\uFEFF${csvText}` : csvText;
    const sha256 = createHash("sha256").update(csvText).digest("hex");
    const prefix =
      flow === "manual_source"
        ? "manual-source"
        : flow === "mcn_rank"
          ? "mcn-rank"
          : flow === "creator_detail"
            ? "creator-detail"
            : "mcn-complete";
    const fileName = `${prefix}-${sanitizeSegment(platform, "platform")}-${sanitizeSegment(scopeIdText, isCreatorDetail ? "field" : "requirement")}-${sha256.slice(0, 8)}.csv`;
    const filePath = join(workspacePath, fileName);
    const handle = await open(filePath, "wx+", 0o600).catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
      const existing = await lstat(filePath);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("unsafe_existing_file");
      return open(filePath, "r+");
    });
    try {
      const current = await handle.readFile({ encoding: "utf8" });
      if (current && current !== csvText && current !== deliveryCsvText) {
        return failure("YPSCAN_CREATOR_CSV_MERGE_CONFLICT", "目标 merged CSV 已存在且内容不同");
      }
      if (current !== deliveryCsvText) {
        const deliveryBuffer = Buffer.from(deliveryCsvText, "utf8");
        let offset = 0;
        while (offset < deliveryBuffer.length) {
          const { bytesWritten } = await handle.write(
            deliveryBuffer,
            offset,
            deliveryBuffer.length - offset,
            offset,
          );
          if (bytesWritten <= 0) throw new Error("short_write");
          offset += bytesWritten;
        }
        await handle.truncate(deliveryBuffer.length);
        await handle.sync();
      }
    } finally {
      await handle.close();
    }

    if (isCreatorDetail) {
      return {
        ok: true,
        csvText,
        details: {
          requirement_id: scopeIdText,
          field_id: scopeIdText,
          platform,
          flow,
          file_name: fileName,
          file_path: filePath,
          data_row_count: mergedRows.length,
          matched_creator_ids: [...matchedCreatorIds],
          missing_creator_ids: [],
          completion_csv_paths: completionCsvPaths.map(String),
          completion_id_columns: completionIdColumns,
          sha256,
        },
      };
    }
    return {
      ok: true,
      csvText,
      details: {
        requirement_id: scopeIdText,
        platform,
        flow,
        file_name: fileName,
        file_path: filePath,
        data_row_count: mergedRows.length,
        matched_creator_ids: [...matchedCreatorIds],
        missing_creator_ids: [...missingCreatorIds],
        completion_csv_paths: completionCsvPaths.map(String),
        completion_id_columns: completionIdColumns,
        links_csv_path: String(linksCsvPath),
        sha256,
      },
    };
  } catch (error) {
    return failure(
      "YPSCAN_CREATOR_CSV_MERGE_FAILED",
      "merged CSV 生成失败",
      error instanceof Error ? { reason: error.message } : {},
    );
  }
}

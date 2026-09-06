import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { localFileMarkdownLink } from "./save-artifact.js";
import { hostToolResult } from "./tool-result.js";
import { nonemptyString } from "../util/value.js";
import {
  extractCreatorIdFromHomepage,
  readCreatorPreview,
} from "./read-creator-preview.js";
import { normalizeCsvHeader, parseCsv } from "./merge-creator-csv.js";

const LINKS_HEADER = "source_record_id,creator_id,url";

function failure(code, message, details = {}) {
  return hostToolResult(
    { success: false, error: { code, message, details } },
    { details, isError: true },
  );
}

function success(details) {
  const localFileLink = localFileMarkdownLink(details.file_path);
  return hostToolResult(
    {
      success: true,
      data: details,
      delivery: {
        local_path: details.file_path,
        local_file_link: localFileLink,
        display_required: true,
        display_before_next_action: true,
        user_visible_message: `已完成：links CSV 已保存到本地。\n本地文件：${localFileLink}`,
      },
    },
    { details },
  );
}

function sanitizeSegment(value, fallback) {
  const text = nonemptyString(value) ? value.trim() : fallback;
  return text.replace(/[^a-zA-Z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || fallback;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function hasCsvControlCharacter(text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code != null && code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return true;
    }
  }
  return false;
}

function normalizeRows(rows, { preserveSourceId = false } = {}) {
  const problems = [];
  const seen = new Set();
  const normalized = [];
  let position = 0;
  for (const raw of rows) {
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const creatorId = nonemptyString(record.creator_id) ? record.creator_id.trim() : "";
    const url = nonemptyString(record.url) ? record.url.trim() : "";
    const sourceRecordId = nonemptyString(record.source_record_id)
      ? record.source_record_id.trim()
      : preserveSourceId
        ? ""
        : String(position + 1);
    if (!creatorId) {
      problems.push({ index: position, field: "creator_id", reason: "creator_id 不能为空" });
    } else if (!url) {
      problems.push({ index: position, field: "url", reason: "url 不能为空" });
    } else if (
      hasCsvControlCharacter(creatorId) ||
      hasCsvControlCharacter(url) ||
      hasCsvControlCharacter(sourceRecordId)
    ) {
      problems.push({ index: position, reason: "包含控制字符" });
    } else if (!seen.has(creatorId)) {
      seen.add(creatorId);
      normalized.push({ source_record_id: sourceRecordId, creator_id: creatorId, url });
    }
    position += 1;
  }
  return { problems, normalized };
}

/**
 * 把 Provider links CSV 解析成受控行。links CSV 的 url 列必填；creator_id 列可缺，
 * 缺失时按平台主页规则从 url 推导；无法推导或与给定 creator_id 不一致时整份失败。
 */
function readLinksCsv(text, platform) {
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (error) {
    return {
      ok: false,
      code: "YPSCAN_CREATOR_LINKS_INVALID_CSV",
      message: "links CSV 无法解析",
      details: error instanceof Error ? { reason: error.message } : {},
    };
  }
  const byName = new Map();
  const duplicated = new Set();
  for (const header of parsed.headers) {
    const name = normalizeCsvHeader(header);
    if (!name) continue;
    if (byName.has(name)) duplicated.add(name);
    else byName.set(name, header);
  }
  const headerProblems = [];
  if (!byName.has("url")) headerProblems.push("缺少 url 列");
  for (const name of ["url", "creator_id", "source_record_id"]) {
    if (duplicated.has(name)) headerProblems.push(`${name} 列重复`);
  }
  if (headerProblems.length > 0) {
    return {
      ok: false,
      code: "YPSCAN_CREATOR_LINKS_INVALID_CSV",
      message: `links CSV 表头无效：${headerProblems.join("、")}`,
      details: { headers: parsed.headers.map(String) },
    };
  }
  const headers = parsed.headers;
  const urlIndex = headers.indexOf(byName.get("url"));
  const creatorIndex = byName.has("creator_id") ? headers.indexOf(byName.get("creator_id")) : -1;
  const sourceIndex = byName.has("source_record_id")
    ? headers.indexOf(byName.get("source_record_id"))
    : -1;
  const problems = [];
  const rows = [];
  parsed.rows.forEach((cells, index) => {
    const url = String(cells[urlIndex] ?? "").trim();
    if (!url) {
      problems.push({ row: index + 1, field: "url", reason: "url 不能为空" });
      return;
    }
    const givenCreatorId = creatorIndex < 0 ? "" : String(cells[creatorIndex] ?? "").trim();
    const extracted = extractCreatorIdFromHomepage(platform, url);
    if (givenCreatorId) {
      if (extracted !== givenCreatorId) {
        problems.push({
          row: index + 1,
          field: "creator_id",
          reason: "creator_id 与主页 url 不匹配",
        });
        return;
      }
    } else if (!extracted) {
      problems.push({
        row: index + 1,
        field: "creator_id",
        reason: "无法从主页 url 推导 creator_id",
      });
      return;
    }
    rows.push({
      source_record_id: sourceIndex < 0 ? "" : String(cells[sourceIndex] ?? "").trim(),
      creator_id: givenCreatorId || extracted,
      url,
    });
  });
  if (problems.length > 0) {
    return {
      ok: false,
      code: "YPSCAN_CREATOR_LINKS_INVALID_ROWS",
      message: "links 行存在非法项",
      details: { problems },
    };
  }
  return { ok: true, rows };
}

async function verifyLocalCsvSource(path, workspacePath) {
  try {
    const info = await lstat(path);
    const resolved = await realpath(path);
    const inside = relative(workspacePath, resolved);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
    ) {
      return { ok: false, reason: "links CSV 必须是当前项目内的普通文件" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "links CSV 不存在或不可读" };
  }
}

/**
 * @param {any} params
 * @param {{
 *   workspaceDir?: string,
 *   openImpl?: typeof open,
 *   mkdirImpl?: typeof mkdir,
 *   realpathImpl?: typeof realpath,
 *   statImpl?: typeof stat,
 *   allowedPreviews?: (requirementId: string) => {file_path: string, sha256: string}[],
 *   allowedLinksCsvs?: (requirementId: string) => string[],
 * }} [options]
 */
export async function saveCreatorLinks(
  params,
  {
    workspaceDir,
    openImpl = open,
    mkdirImpl = mkdir,
    realpathImpl = realpath,
    statImpl = stat,
    allowedPreviews,
    allowedLinksCsvs,
  } = {},
) {
  const requirementId = params?.requirement_id;
  const fromPreview = params?.preview_file_path !== undefined;
  const fromCsv = params?.links_csv_path !== undefined;
  if (
    !nonemptyString(requirementId) ||
    fromPreview === fromCsv ||
    !["xiaohongshu", "douyin"].includes(params?.platform)
  ) {
    return failure(
      "YPSCAN_CREATOR_LINKS_INVALID_INPUT",
      "传当前 requirement_id、platform，以及 links_csv_path 或 preview_file_path，二者互斥",
    );
  }
  if (!nonemptyString(workspaceDir) || !isAbsolute(workspaceDir)) {
    return failure("YPSCAN_WORKSPACE_UNAVAILABLE", "宿主未提供可信的当前项目目录");
  }

  let workspacePath;
  try {
    await mkdirImpl(workspaceDir, { recursive: true });
    workspacePath = await realpathImpl(workspaceDir);
    const info = await statImpl(workspacePath);
    if (!info.isDirectory()) throw new Error("not_directory");
  } catch {
    return failure("YPSCAN_WORKSPACE_UNAVAILABLE", "当前项目目录不可用");
  }

  let preview;
  let rows;
  if (fromPreview) {
    const read = await readCreatorPreview(params, { workspaceDir, allowedPreviews });
    if (!read.ok) return failure(read.code, read.message, read.details);
    rows = read.rows;
    preview = read.preview;
  } else {
    const csvPath = params.links_csv_path;
    if (
      typeof csvPath !== "string" ||
      !isAbsolute(csvPath) ||
      csvPath !== csvPath.trim() ||
      !csvPath.toLowerCase().endsWith(".csv")
    ) {
      return failure(
        "YPSCAN_CREATOR_LINKS_INVALID_INPUT",
        "links_csv_path 必须是绝对 .csv 路径且无首尾空白",
      );
    }
    if (typeof allowedLinksCsvs === "function") {
      const allowed = (allowedLinksCsvs(requirementId) ?? []).map((item) => normalize(item));
      if (!allowed.includes(normalize(csvPath))) {
        return failure(
          "YPSCAN_CREATOR_LINKS_SOURCE_NOT_ALLOWED",
          "links CSV 必须是当前 requirement 受控保存的产物",
        );
      }
    }
    const verified = await verifyLocalCsvSource(csvPath, workspacePath);
    if (!verified.ok) {
      return failure("YPSCAN_CREATOR_LINKS_SOURCE_NOT_ALLOWED", verified.reason);
    }
    const read = readLinksCsv(await readFile(csvPath, "utf8"), params.platform);
    if (!read.ok) return failure(read.code, read.message, read.details);
    rows = read.rows;
  }

  const { problems, normalized } = normalizeRows(rows, { preserveSourceId: fromPreview });
  if (problems.length > 0) {
    const details = fromCsv
      ? { problems: problems.map(({ index, ...rest }) => ({ row: index + 1, ...rest })) }
      : { problems };
    return failure("YPSCAN_CREATOR_LINKS_INVALID_ROWS", "links 行存在非法项", details);
  }
  if (normalized.length === 0) {
    return failure("YPSCAN_CREATOR_LINKS_EMPTY", "去重后没有可写入的 links 行");
  }

  const csvText = [
    LINKS_HEADER,
    ...normalized.map((row) =>
      [row.source_record_id, row.creator_id, row.url].map(escapeCsv).join(","),
    ),
  ].join("\n");
  const sha256 = createHash("sha256").update(csvText).digest("hex");
  const fileName = `mcn-links-${sanitizeSegment(requirementId, "requirement")}-${sha256.slice(0, 8)}.csv`;
  const filePath = join(workspacePath, fileName);

  try {
    const handle = await openImpl(filePath, "wx+", 0o600).catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
      const existing = await lstat(filePath);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("unsafe_existing_file");
      return openImpl(filePath, "r+");
    });
    try {
      const current = await handle.readFile({ encoding: "utf8" });
      if (current && current !== csvText) {
        return failure("YPSCAN_CREATOR_LINKS_CONFLICT", "目标 links CSV 已存在且内容不同");
      }
      if (!current) {
        await handle.truncate(0);
        await handle.writeFile(csvText, { encoding: "utf8" });
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    return failure("YPSCAN_CREATOR_LINKS_WRITE_FAILED", "links CSV 写入失败", {
      reason: error instanceof Error ? error.message : undefined,
    });
  }

  return success({
    file_name: fileName,
    file_path: filePath,
    row_count: normalized.length,
    sha256,
    ...(preview ? { preview } : {}),
  });
}

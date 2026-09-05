import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { localFileMarkdownLink } from "./save-artifact.js";
import { hostToolResult } from "./tool-result.js";
import { nonemptyString } from "../util/value.js";

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

function normalizeRows(rows) {
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
 * @param {any} params
 * @param {{
 *   workspaceDir?: string,
 *   openImpl?: typeof open,
 *   mkdirImpl?: typeof mkdir,
 *   realpathImpl?: typeof realpath,
 *   statImpl?: typeof stat,
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
  } = {},
) {
  const requirementId = params?.requirement_id;
  const rows = params?.rows;
  if (!nonemptyString(requirementId) || !Array.isArray(rows) || rows.length === 0) {
    return failure("YPSCAN_CREATOR_LINKS_INVALID_INPUT", "requirement_id 与 rows 必须完整且有效");
  }
  const { problems, normalized } = normalizeRows(rows);
  if (problems.length > 0) {
    return failure("YPSCAN_CREATOR_LINKS_INVALID_ROWS", "links 行存在非法项", { problems });
  }
  if (normalized.length === 0) {
    return failure("YPSCAN_CREATOR_LINKS_EMPTY", "去重后没有可写入的 links 行");
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
  });
}

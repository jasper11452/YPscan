import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { unzipSync } from "fflate";
import readXlsxFile from "read-excel-file/node";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PLATFORM_HEADERS = {
  xiaohongshu: {
    ids: ["creator_id", "kw_uid", "蒲公英id", "博主id"],
    urls: ["url", "kwuserurl", "小红书主页"],
  },
  douyin: {
    ids: ["creator_id", "xt_id", "星图id"],
    urls: ["url", "星图主页", "星图链接"],
  },
};

function failure(code, message, details = {}) {
  return { ok: false, code: `YPSCAN_CREATOR_PREVIEW_${code}`, message, details };
}

function headerText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s*＊]/gu, "");
}

function cellText(value) {
  if (value == null) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

/** 从平台主页 URL 提取平台 ID；无法识别或 ID 含非法字符时返回 null。 */
export function extractCreatorIdFromHomepage(platform, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    let id = null;
    if (platform === "xiaohongshu") {
      if (["www.xiaohongshu.com", "xiaohongshu.com"].includes(url.hostname)) {
        id = url.pathname.match(/^\/user\/profile\/([^/]+)\/?$/u)?.[1] ?? null;
      } else if (url.hostname === "pgy.xiaohongshu.com") {
        id = url.pathname.match(/^\/solar\/pre-trade\/blogger-detail\/([^/]+)\/?$/u)?.[1] ?? null;
      }
    } else if (platform === "douyin" && url.hostname === "www.xingtu.cn") {
      id = url.pathname.match(/^\/ad\/creator\/author-homepage\/douyin-video\/([^/]+)\/?$/u)?.[1] ?? null;
    }
    return id && /^[a-zA-Z0-9_-]+$/u.test(id) ? id : null;
  } catch {
    return null;
  }
}

function matchesHomepage(platform, creatorId, value) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(creatorId)) return false;
  return extractCreatorIdFromHomepage(platform, value) === creatorId;
}

/** Read only a hash-verified preview produced for the current requirement. */
export async function readCreatorPreview(params, { workspaceDir, allowedPreviews }) {
  const path = params.preview_file_path;
  const platform = PLATFORM_HEADERS[params.platform];
  const sources =
    typeof allowedPreviews === "function" ? allowedPreviews(params.requirement_id) : [];
  const source = sources.find((item) => item.file_path === path);
  if (
    !platform ||
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path !== path.trim() ||
    !path.toLowerCase().endsWith(".xlsx") ||
    !source?.sha256
  ) {
    return failure(
      "SOURCE_NOT_ALLOWED",
      "仅允许读取当前 requirement 受控保存的预览 xlsx；请先保存本轮预览表",
    );
  }
  try {
    const info = await lstat(path);
    const resolved = await realpath(path);
    const workspace = await realpath(workspaceDir);
    const inside = relative(workspace, resolved);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
    ) {
      return failure("SOURCE_NOT_ALLOWED", "预览文件必须是当前项目内的普通文件");
    }
    if (info.size > MAX_FILE_BYTES) return failure("LIMIT", "预览文件超过 20 MiB");
    const buffer = await readFile(path);
    if (createHash("sha256").update(buffer).digest("hex") !== source.sha256) {
      return failure(
        "SOURCE_CHANGED",
        "预览文件已改变；请重新保存 Provider 返回的本轮预览，不读取修改后的文件",
      );
    }
    // Inspect ZIP metadata before the workbook parser expands the archive.
    let bytes = 0;
    let entries = 0;
    unzipSync(buffer, {
      filter: (entry) => {
        bytes += entry.originalSize;
        entries += 1;
        if (bytes > 40 * 1024 * 1024 || entries > 1000) throw new Error("archive_limit");
        return false;
      },
    });
    const sheets = await readXlsxFile(buffer, { trim: false, parseNumber: (value) => value });
    if (sheets.length !== 1)
      return failure("HEADERS", "预览文件必须只有一张数据工作表，不能猜测选表", {
        sheets: sheets.map((sheet) => sheet.sheet),
      });
    const grid = sheets[0].data;
    if (grid.length > 10000 || grid.some((row) => row.length > 200))
      return failure("LIMIT", "预览表超过 10000 行或 200 列");
    const candidates = [];
    for (let index = 0; index < Math.min(grid.length, 50); index += 1) {
      const headers = grid[index].map(headerText);
      const ids = headers.flatMap((name, i) => (platform.ids.includes(name) ? [i] : []));
      const urls = headers.flatMap((name, i) => (platform.urls.includes(name) ? [i] : []));
      if (ids.length && urls.length) candidates.push({ index, headers, ids, urls });
    }
    if (
      candidates.length !== 1 ||
      candidates[0].ids.length !== 1 ||
      candidates[0].urls.length !== 1
    ) {
      return failure("HEADERS", "缺少或存在歧义的平台 ID/主页表头", {
        platform: params.platform,
        accepted: platform,
      });
    }
    const header = candidates[0];
    const sourceIndex = header.headers.indexOf("source_record_id");
    const institutionIndex = header.headers.indexOf("所属机构");
    const rows = [];
    const records = [];
    let recordBytes = 0;
    const seen = new Set();
    const duplicates = new Set();
    const problems = [];
    let totalRowCount = 0;
    for (let index = header.index + 1; index < grid.length; index += 1) {
      const cells = Array.from({ length: grid[header.index].length }, (_, col) =>
        cellText(grid[index][col]),
      );
      if (cells.every((cell) => !cell.trim())) continue;
      totalRowCount += 1;
      recordBytes += Buffer.byteLength(JSON.stringify(cells));
      if (records.length < 100 && recordBytes <= 256 * 1024)
        records.push({ row: index + 1, cells });
      const creatorId = (cells[header.ids[0]] ?? "").trim();
      const url = (cells[header.urls[0]] ?? "").trim();
      const sourceRecordId = sourceIndex < 0 ? "" : cells[sourceIndex];
      let reason = null;
      if (!creatorId || !url) reason = "平台 ID 或主页为空";
      else if (!matchesHomepage(params.platform, creatorId, url))
        reason = "平台主页与 ID 不匹配或格式不受支持";
      else if (
        [creatorId, url, sourceRecordId].some((value) =>
          [...value].some(
            (char) => char.codePointAt(0) < 0x20 && !["\t", "\n", "\r"].includes(char),
          ),
        )
      )
        reason = "包含控制字符";
      if (reason) {
        problems.push({
          row: index + 1,
          ...(institutionIndex < 0 ? {} : { institution: cells[institutionIndex] }),
          reason,
        });
        continue;
      }
      if (seen.has(creatorId)) duplicates.add(creatorId);
      seen.add(creatorId);
      rows.push({
        creator_id: creatorId,
        url,
        source_record_id: sourceRecordId,
      });
    }
    if (problems.length && !rows.length)
      return failure("ROWS", "预览没有可处理的有效行，未生成 links CSV；原始预览表保留", {
        problems,
      });
    if (!rows.length) return failure("EMPTY", "预览表没有达人记录");
    return {
      ok: true,
      rows,
      preview: {
        file_path: path,
        sha256: source.sha256,
        sheet: sheets[0].sheet,
        header_row: header.index + 1,
        headers: grid[header.index].map(cellText),
        records,
        total_row_count: totalRowCount,
        records_truncated: totalRowCount > records.length,
        excluded_row_count: problems.length,
        problems,
        duplicate_creator_ids: [...duplicates],
        verification_status: "unverified",
      },
    };
  } catch {
    return failure("READ_FAILED", "预览 xlsx 无法解析或超过解压限制；原始文件未修改");
  }
}

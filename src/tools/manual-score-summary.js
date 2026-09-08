import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { unzipSync, zipSync } from "fflate";
import readXlsxFile from "read-excel-file/node";
import writeXlsxFile from "write-excel-file/node";
import { parseCsv } from "./merge-creator-csv.js";
import { localFileMarkdownLink, publishWithoutOverwrite } from "./save-artifact.js";
import { hostToolResult } from "./tool-result.js";
import { nonemptyString } from "../util/value.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const BATCH_SIZE = 20;
const PLATFORM_HEADERS = { douyin: "星图ID", xiaohongshu: "蒲公英ID" };
const PLATFORM_LABELS = { douyin: "抖音", xiaohongshu: "小红书" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) => (value == null ? "" : String(value));

function fail(code, message) {
  throw Object.assign(new Error(message), { code: `YPSCAN_MANUAL_SCORE_${code}` });
}

async function trustedFile(source, workspaceDir, extension) {
  if (
    !nonemptyString(source?.file_path) ||
    !isAbsolute(source.file_path) ||
    !source.file_path.endsWith(extension) ||
    !nonemptyString(source.sha256)
  )
    fail("SOURCE_NOT_ALLOWED", "缺少当前需求已登记的文件与哈希，不能读取或猜测来源");
  const info = await lstat(source.file_path);
  const path = await realpath(source.file_path);
  const inside = relative(await realpath(workspaceDir), path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    fail("SOURCE_NOT_ALLOWED", "仅允许读取当前项目内受控保存的普通文件");
  }
  if (info.size > MAX_FILE_BYTES) fail("LIMIT", "输入文件超过 20 MiB");
  const buffer = await readFile(path);
  if (hash(buffer) !== source.sha256)
    fail("SOURCE_CHANGED", "受控文件已改变，停止汇总，不读取修改后的结果");
  return buffer;
}

/** Read the observed Provider scoring table, not a legacy recommendation template. */
export async function readManualScoreWorkbook(source, { workspaceDir, requirement_id, platform }) {
  const buffer = await trustedFile(source, workspaceDir, ".xlsx");
  let bytes = 0;
  let entries = 0;
  unzipSync(buffer, {
    filter: (entry) => {
      bytes += entry.originalSize;
      entries += 1;
      if (bytes > 40 * 1024 * 1024 || entries > 1000) fail("LIMIT", "评分表超过解压限制");
      return false;
    },
  });
  const sheets = await readXlsxFile(buffer, { trim: false, parseNumber: (value) => value });
  if (sheets.length !== 1) fail("HEADERS", "评分表必须只有一张数据工作表，不能猜测选表");
  const grid = sheets[0].data;
  if (grid.length > 10000 || grid.some((row) => row.length > 200))
    fail("LIMIT", "评分表超过行列上限");
  const headerRows = [];
  for (let index = 0; index < Math.min(grid.length, 50); index += 1) {
    const headers = grid[index].map((value) => text(value).trim());
    if (headers.includes("推荐结论") && headers.includes(PLATFORM_HEADERS[platform]))
      headerRows.push({ index, headers });
  }
  if (headerRows.length !== 1)
    fail("HEADERS", "缺少或存在歧义的评分表头，不能将旧推荐表或预览表当评分结果");
  const { index, headers } = headerRows[0];
  const required = ["平台", PLATFORM_HEADERS[platform], "综合得分", "推荐结论"];
  for (const name of required) {
    if (headers.filter((header) => header === name).length !== 1)
      fail("HEADERS", "评分表的身份、得分或推荐结论列缺失或重复");
  }
  const requirementIds = grid
    .slice(0, index)
    .flatMap((row) =>
      row.flatMap((cell, col) =>
        text(cell).trim() === "需求ID" ? [text(row[col + 1]).trim()] : [],
      ),
    );
  if (requirementIds.length !== 1 || requirementIds[0] !== requirement_id)
    fail("SOURCE_MISMATCH", "评分表的需求ID与当前需求不一致或缺失");
  const idColumn = headers.indexOf(PLATFORM_HEADERS[platform]);
  const platformColumn = headers.indexOf("平台");
  const scoreColumn = headers.indexOf("综合得分");
  const verdictColumn = headers.indexOf("推荐结论");
  const rows = [];
  for (const row of grid.slice(index + 1)) {
    const cells = Array.from({ length: headers.length }, (_, col) => text(row[col]));
    if (cells.every((cell) => !cell.trim())) continue;
    const creatorId = cells[idColumn].trim();
    const rowPlatform = cells[platformColumn].trim();
    if (!creatorId || ![platform, PLATFORM_LABELS[platform]].includes(rowPlatform))
      fail("SOURCE_MISMATCH", "评分表存在缺失身份或其他平台的达人");
    const verdict = cells[verdictColumn].trim();
    if (verdict !== "推荐" && verdict !== "不推荐")
      fail("UNKNOWN_VERDICT", "推荐结论不是明确的“推荐”或“不推荐”，停止自动计数");
    const score = Number(cells[scoreColumn]);
    if (!cells[scoreColumn].trim() || !Number.isFinite(score))
      fail("INVALID_SCORE", "综合得分缺失或不是有效数值");
    rows.push({ creator_id: creatorId, recommended: verdict === "推荐", score, cells });
  }
  return { headers, rows };
}

async function saveSummaryWorkbook(workspaceDir, requirementId, headers, rows, target) {
  const headerCells = headers.map((value) => ({
    value,
    fontWeight: "bold",
    backgroundColor: "#E8F1EE",
    wrap: true,
  }));
  const sheet = (name, selected) => ({
    sheet: name,
    data: [
      headerCells,
      ...selected.map((row) => row.cells.map((value) => ({ value, type: String, wrap: true }))),
    ],
    columns: headers.map((header) => ({
      width: /理由|优势|劣势|介绍/u.test(header) ? 52 : /ID|主页/u.test(header) ? 28 : 18,
    })),
    stickyRowsCount: 1,
    orientation: /** @type {const} */ ("landscape"),
  });
  const generated = await writeXlsxFile(
    [
      sheet("推荐达人", rows.filter((row) => row.recommended).slice(0, target)),
      sheet("已评分达人", rows),
    ],
    { fontFamily: "Calibri", fontSize: 11 },
  ).toBuffer();
  // Normalize ZIP timestamps so identical summaries have identical content and paths.
  const buffer = Buffer.from(zipSync(unzipSync(generated), { mtime: new Date(1980, 0, 1) }));
  const sha256 = hash(buffer);
  const fileName = `manual-score-summary-${hash(requirementId).slice(0, 16)}-${sha256.slice(0, 16)}.xlsx`;
  const path = join(await realpath(workspaceDir), fileName);
  const tempPath = join(await realpath(workspaceDir), `.manual-score-${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const published = await publishWithoutOverwrite(tempPath, path, sha256);
    if (!published.ok) fail("SAVE_FAILED", "汇总文件已改变或无法安全保存，不覆盖已有文件");
    return { file_path: path, file_name: fileName, sha256, idempotent: published.idempotent };
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * Recompute progress from observed source records; no task ledger or remote calls.
 * @param {{requirement_id: string}} params
 * @param {{workspaceDir?: string, sourceContext?: {
 *   business_mode: string, platform: string, quantityTotal: number,
 *   source_conflict?: boolean,
 *   links_file: {file_path: string, sha256: string},
 *   completion_results: {file_path: (string|null), platform: string, successful_author_ids: string[], failed_author_ids: string[]}[],
 *   score_files: {file_path: string, sha256: string}[],
 * }}} options
 */
export async function summarizeManualScores(params, { workspaceDir, sourceContext } = {}) {
  try {
    const requirementId = params?.requirement_id;
    const target = sourceContext?.quantityTotal;
    const platform = sourceContext?.platform;
    if (
      !nonemptyString(requirementId) ||
      !workspaceDir ||
      sourceContext?.source_conflict ||
      sourceContext?.business_mode !== "手动拓展" ||
      !PLATFORM_HEADERS[platform] ||
      !Number.isSafeInteger(target) ||
      target <= 0
    ) {
      fail(
        "CONTEXT_UNAVAILABLE",
        "缺少当前手动拓展需求的可信人数、平台或来源记录；不跨功能复用，不重新建需或猜测人数",
      );
    }
    const links = parseCsv(
      (await trustedFile(sourceContext.links_file, workspaceDir, ".csv")).toString("utf8"),
    );
    if (links.headers.join(",") !== "source_record_id,creator_id,url" || links.rows.length > 10000)
      fail("LINKS_INVALID", "需要已归一化的三列 links CSV，且不超过 10000 行");
    const candidateIds = [...new Set(links.rows.map((row) => row[1].trim()))].slice(0, target * 3);
    if (!candidateIds.length || candidateIds.some((id) => !id))
      fail("LINKS_INVALID", "候选达人身份为空");
    const candidateSet = new Set(candidateIds);
    const successful = new Set();
    const failed = new Set();
    for (const result of sourceContext.completion_results) {
      if (
        result.platform !== platform ||
        !Array.isArray(result.successful_author_ids) ||
        !Array.isArray(result.failed_author_ids)
      )
        fail("COMPLETION_INVALID", "原生补全缺少可验证的当前平台成功/失败名单");
      /** @type {[string[], Set<string>][]} */
      const groups = [
        [result.successful_author_ids, successful],
        [result.failed_author_ids, failed],
      ];
      for (const [values, targetSet] of groups) {
        for (const id of values) {
          if (!candidateSet.has(id))
            fail("SOURCE_MISMATCH", "补全结果包含本轮三倍候选池以外的达人");
          targetSet.add(id);
        }
      }
    }
    if ([...successful].some((id) => failed.has(id)))
      fail("COMPLETION_INVALID", "同一达人同时出现在补全成功与失败名单中");
    const scoredById = new Map();
    let headers = null;
    const files = new Map(sourceContext.score_files.map((file) => [file.file_path, file]));
    for (const source of files.values()) {
      const parsed = await readManualScoreWorkbook(source, {
        workspaceDir,
        requirement_id: requirementId,
        platform,
      });
      if (headers && JSON.stringify(headers) !== JSON.stringify(parsed.headers))
        fail("HEADERS", "各批评分表列配置不一致，停止汇总，不猜测或丢弃字段");
      headers = parsed.headers;
      for (const row of parsed.rows) {
        if (!successful.has(row.creator_id))
          fail("SOURCE_MISMATCH", "评分结果含非本轮补全成功的达人，可能复用了其他批次或需求");
        const previous = scoredById.get(row.creator_id);
        if (previous && JSON.stringify(previous.cells) !== JSON.stringify(row.cells))
          fail("CONFLICTING_RESULTS", "同一达人存在不同评分结果，停止合并，不选择更高分覆盖");
        scoredById.set(row.creator_id, row);
      }
    }
    const rows = candidateIds.flatMap((id) => (scoredById.has(id) ? [scoredById.get(id)] : []));
    rows.sort((a, b) => b.score - a.score);
    const recommendedCount = rows.filter((row) => row.recommended).length;
    const remaining = candidateIds.filter((id) => !successful.has(id) && !failed.has(id));
    const pendingScores = candidateIds.filter((id) => successful.has(id) && !scoredById.has(id));
    const reached = recommendedCount >= target;
    const exhausted = remaining.length === 0 && pendingScores.length === 0;
    const data = {
      requirement_id: requirementId,
      platform,
      target_count: target,
      candidate_count: candidateIds.length,
      recommended_count: recommendedCount,
      scored_count: rows.length,
      completion_failed_count: failed.size,
      failed_author_ids: [...failed],
      unprocessed_count: remaining.length,
      pending_score_author_ids: pendingScores,
      shortfall: Math.max(0, target - recommendedCount),
      target_reached: reached,
      next_action:
        reached || exhausted
          ? "deliver"
          : pendingScores.length
            ? "await_scores"
            : "complete_next_batch",
      next_author_ids: reached || pendingScores.length ? [] : remaining.slice(0, BATCH_SIZE),
      stop_reason: reached ? "target_reached" : exhausted ? "candidates_exhausted" : null,
      links_csv_path: sourceContext.links_file.file_path,
    };
    if (data.next_action !== "deliver" || !rows.length) {
      return hostToolResult({ success: true, data }, { details: data });
    }
    const saved = await saveSummaryWorkbook(workspaceDir, requirementId, headers, rows, target);
    const details = { ...data, ...saved };
    const delivery = {
      local_path: saved.file_path,
      local_file_link: localFileMarkdownLink(saved.file_path),
      display_required: true,
      display_before_next_action: true,
      user_visible_message: `已评分 ${rows.length} 位，推荐 ${recommendedCount} 位，目标 ${target} 位。`,
    };
    return hostToolResult({ success: true, data: details, delivery }, { details });
  } catch (error) {
    return hostToolResult(
      {
        success: false,
        error: {
          code: error?.code?.startsWith("YPSCAN_MANUAL_SCORE_")
            ? error.code
            : "YPSCAN_MANUAL_SCORE_READ_FAILED",
          message: error?.code?.startsWith("YPSCAN_MANUAL_SCORE_")
            ? error.message
            : "评分汇总无法安全读取或保存；保留已有文件并停止，不猜测推荐人数",
          retriable: false,
        },
      },
      { isError: true },
    );
  }
}

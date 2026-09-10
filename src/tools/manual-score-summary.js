import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import readXlsxFile from "read-excel-file/node";
import { Builder, parseStringPromise } from "xml2js";
import { parseCsv } from "./merge-creator-csv.js";
import { localFileMarkdownLink, publishWithoutOverwrite } from "./save-artifact.js";
import { hostToolResult } from "./tool-result.js";
import { nonemptyString } from "../util/value.js";
import { manualSourcePoolSize } from "../contract/registry.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const BATCH_SIZE = 20;
const RELEVANCE_WEIGHT = 0.7;
const COST_EFFECTIVENESS_WEIGHT = 0.3;
const CPM_WEIGHT = 0.6;
const CPE_WEIGHT = 0.4;
const PLATFORM_HEADERS = { douyin: "星图ID", xiaohongshu: "蒲公英ID" };
const PLATFORM_LABELS = { douyin: "抖音", xiaohongshu: "小红书" };
// 性价比只用同批已有商业数据做相对比较，不引入新的 Provider 字段或绝对基准。
const COST_EFFECTIVENESS_HEADERS = {
  douyin: { cpm: ["植入视频-预期CPM"], cpe: ["植入视频-预期CPE"] },
  xiaohongshu: {
    price: ["视频笔记一口价", "视频笔记报价", "视频报价"],
    reach: ["合作_视频&图文_阅读中位数", "日常_视频&图文_阅读中位数"],
    engagement: ["合作_视频&图文_互动中位数", "日常_视频&图文_互动中位数"],
  },
};
const HOMEPAGE_HEADERS = new Set(["星图主页", "抖音主页", "小红书主页"]);
const DOCUMENT_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_RELATIONSHIP_TYPE = `${DOCUMENT_RELATIONSHIP_NAMESPACE}/hyperlink`;
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
  const archive = unzipSync(buffer);
  const sheetPaths = Object.keys(archive).filter((path) =>
    /^xl\/worksheets\/[^/]+\.xml$/u.test(path),
  );
  if (sheetPaths.length !== 1) fail("TEMPLATE", "评分模板必须只有一张工作表");
  const sheetPath = sheetPaths[0];
  const document = await parseStringPromise(strFromU8(archive[sheetPath]));
  const sheet = document.worksheet;
  // Moving formulas or linked objects also requires rewriting their references.
  const xmlRows = new Map((sheet?.sheetData?.[0]?.row ?? []).map((row) => [Number(row.$.r), row]));
  if (
    [
      "hyperlinks",
      "tableParts",
      "drawing",
      "conditionalFormatting",
      "dataValidations",
      "legacyDrawing",
    ].some((key) => sheet[key]) ||
    [...xmlRows.values()].some((row) => row.c?.some((cell) => cell.f))
  )
    fail("TEMPLATE", "评分模板含无法安全移动的公式或关联对象，保留原表并停止合并");
  for (const merge of sheet.mergeCells?.[0]?.mergeCell ?? []) {
    if (Number(merge.$.ref.split(":").at(-1).replace(/[A-Z]/gu, "")) > index + 1)
      fail("TEMPLATE", "评分数据区含合并单元格，不能安全排序");
  }
  const countCells = [];
  for (let r = 0; r < index; r += 1) {
    for (let c = 0; c < grid[r].length; c += 1) {
      if (text(grid[r][c]).trim() === "评分数量") countCells.push(`${columnName(c + 1)}${r + 1}`);
    }
  }
  const homepageColumns = headers.flatMap((header, column) =>
    HOMEPAGE_HEADERS.has(header) ? [column] : [],
  );
  const template = {
    archive,
    sheetPath,
    document,
    headerRow: index + 1,
    countCells,
    homepageColumns,
    scoreColumn,
  };
  const rows = [];
  for (const [offset, row] of grid.slice(index + 1).entries()) {
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
    const rowXml = xmlRows.get(index + offset + 2);
    if (!rowXml) fail("TEMPLATE", "评分行与原始模板坐标不一致");
    rows.push({ creator_id: creatorId, recommended: verdict === "推荐", score, cells, rowXml });
  }
  return { headers, rows, template };
}

function columnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

function setNumericCell(rowXml, columnIndex, value) {
  if (columnIndex < 0) return;
  const ref = columnName(columnIndex);
  const cell = (rowXml.c ?? []).find((item) => text(item.$?.r).replace(/\d+$/u, "") === ref);
  if (!cell) return;
  cell.$.t = "n";
  delete cell.is;
  cell.v = [String(value)];
}

function positiveNumber(value) {
  const parsed = Number(text(value).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function columnIndexes(headers, names) {
  return names.flatMap((name) => (headers.indexOf(name) === -1 ? [] : [headers.indexOf(name)]));
}

function firstPositive(cells, indexes) {
  for (const index of indexes) {
    const value = positiveNumber(cells[index]);
    if (value != null) return value;
  }
  return null;
}

function percentileScores(values) {
  const distinct = [...new Set(values.filter((value) => value != null))].sort((a, b) => a - b);
  if (distinct.length < 2) return values.map(() => null);
  return values.map((value) =>
    value == null
      ? null
      : (100 * (distinct.length - 1 - distinct.indexOf(value))) / (distinct.length - 1),
  );
}

/** 同批同平台相对性价比：成本越低分越高；数据缺失返回 null，由调用方按同批中位数代入。 */
function costEffectivenessScores(headers, rows, platform) {
  const config = COST_EFFECTIVENESS_HEADERS[platform];
  if (!config || !rows.length) return new Map();
  const indexes = Object.fromEntries(
    Object.entries(config).map(([key, names]) => [key, columnIndexes(headers, names)]),
  );
  const cpm = rows.map((row) => {
    if (platform === "douyin") return firstPositive(row.cells, indexes.cpm);
    const price = firstPositive(row.cells, indexes.price);
    const reach = firstPositive(row.cells, indexes.reach);
    return price != null && reach != null ? (price * 1000) / reach : null;
  });
  const cpe = rows.map((row) => {
    if (platform === "douyin") return firstPositive(row.cells, indexes.cpe);
    const price = firstPositive(row.cells, indexes.price);
    const engagement = firstPositive(row.cells, indexes.engagement);
    return price != null && engagement != null ? price / engagement : null;
  });
  const cpmScores = percentileScores(cpm);
  const cpeScores = percentileScores(cpe);
  return new Map(
    rows.map((row, index) => {
      const cpmScore = cpmScores[index];
      const cpeScore = cpeScores[index];
      const score =
        cpmScore == null
          ? cpeScore
          : cpeScore == null
            ? cpmScore
            : CPM_WEIGHT * cpmScore + CPE_WEIGHT * cpeScore;
      return [row.creator_id, score];
    }),
  );
}

function externalHttpUrl(value) {
  const target = text(value).trim();
  try {
    const url = new URL(target);
    return ["http:", "https:"].includes(url.protocol) ? target : null;
  } catch {
    return null;
  }
}

function worksheetRelationshipsPath(sheetPath) {
  const separator = sheetPath.lastIndexOf("/");
  const directory = sheetPath.slice(0, separator);
  const fileName = sheetPath.slice(separator + 1);
  return `${directory}/_rels/${fileName}.rels`;
}

function insertHyperlinks(sheet, hyperlinks) {
  const followingElements = new Set([
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
    "customProperties",
    "cellWatches",
    "ignoredErrors",
    "smartTags",
    "drawing",
    "legacyDrawing",
    "legacyDrawingHF",
    "picture",
    "oleObjects",
    "controls",
    "webPublishItems",
    "tableParts",
    "extLst",
  ]);
  const entries = Object.entries(sheet);
  const nextIndex = entries.findIndex(([key]) => followingElements.has(key));
  const insertionIndex = nextIndex === -1 ? entries.length : nextIndex;
  return Object.fromEntries([
    ...entries.slice(0, insertionIndex),
    ["hyperlinks", [{ hyperlink: hyperlinks }]],
    ...entries.slice(insertionIndex),
  ]);
}

async function addHomepageHyperlinks(archive, sheetPath, document, headerRow, columns, rows) {
  const links = rows.flatMap((row, rowIndex) =>
    columns.flatMap((column) => {
      const target = externalHttpUrl(row.cells[column]);
      return target ? [{ ref: `${columnName(column)}${headerRow + rowIndex + 1}`, target }] : [];
    }),
  );
  if (!links.length) return;

  const relationshipPath = worksheetRelationshipsPath(sheetPath);
  const relationships = archive[relationshipPath]
    ? await parseStringPromise(strFromU8(archive[relationshipPath]))
    : { Relationships: { $: { xmlns: PACKAGE_RELATIONSHIP_NAMESPACE }, Relationship: [] } };
  const root = relationships.Relationships;
  root.$ ??= { xmlns: PACKAGE_RELATIONSHIP_NAMESPACE };
  const records = (root.Relationship ??= []);
  const usedIds = new Set(records.map((record) => record.$?.Id).filter(nonemptyString));
  let sequence = 1;
  const hyperlinks = links.map(({ ref, target }) => {
    while (usedIds.has(`rId${sequence}`)) sequence += 1;
    const id = `rId${sequence}`;
    usedIds.add(id);
    sequence += 1;
    records.push({
      $: { Id: id, Type: HYPERLINK_RELATIONSHIP_TYPE, Target: target, TargetMode: "External" },
    });
    return { $: { ref, "r:id": id } };
  });
  archive[relationshipPath] = strToU8(
    new Builder({ renderOpts: { pretty: false } }).buildObject(relationships),
  );
  const sheet = document.worksheet;
  sheet.$ ??= {};
  sheet.$["xmlns:r"] = DOCUMENT_RELATIONSHIP_NAMESPACE;
  document.worksheet = insertHyperlinks(sheet, hyperlinks);
}

async function saveSummaryWorkbook(workspaceDir, requirementId, template, rows) {
  const { archive, sheetPath, document, headerRow, countCells, homepageColumns, scoreColumn } =
    template;
  const sheet = document.worksheet;
  const prefix = sheet.sheetData[0].row.filter((row) => Number(row.$.r) <= headerRow);
  const body = rows.map((row, index) => {
    const moved = structuredClone(row.rowXml);
    moved.$.r = String(headerRow + index + 1);
    for (const cell of moved.c ?? []) cell.$.r = cell.$.r.replace(/\d+$/u, moved.$.r);
    if (row.display_score != null && row.display_score !== row.score)
      setNumericCell(moved, scoreColumn, row.display_score);
    return moved;
  });
  for (const row of prefix) {
    for (const cell of row.c ?? []) {
      if (!countCells.includes(cell.$.r)) continue;
      // Preserve the Provider's count-cell style and storage type.
      if (cell.$.t === "inlineStr") cell.is = [{ t: [String(rows.length)] }];
      else {
        cell.$.t = "n";
        delete cell.is;
        cell.v = [String(rows.length)];
      }
    }
  }
  sheet.sheetData[0].row = [...prefix, ...body];
  for (const key of ["dimension", "autoFilter"]) {
    if (sheet[key]?.[0]?.$.ref)
      sheet[key][0].$.ref = sheet[key][0].$.ref.replace(/\d+$/u, String(headerRow + rows.length));
  }
  await addHomepageHyperlinks(archive, sheetPath, document, headerRow, homepageColumns, rows);
  archive[sheetPath] = strToU8(
    new Builder({ renderOpts: { pretty: false } }).buildObject(document),
  );
  // Keep every original template part, including styles, sheet name and print settings.
  const buffer = Buffer.from(zipSync(archive, { mtime: new Date(1980, 0, 1) }));
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
 * 汇总失败时仍可交付当前需求已登记、路径与 SHA-256 未变且表格自身属于当前需求的评分表；
 * 校验不过的批次不展示，避免把已修改、越界或属于其他需求的表当成果。
 */
async function verifiedBatchDeliveries(sourceContext, workspaceDir, requirementId) {
  const batchFiles = [];
  for (const source of sourceContext?.score_files ?? []) {
    try {
      await readManualScoreWorkbook(source, {
        workspaceDir,
        requirement_id: requirementId,
        platform: sourceContext?.platform,
      });
    } catch {
      continue;
    }
    batchFiles.push({
      local_path: source.file_path,
      local_file_link: localFileMarkdownLink(source.file_path),
      sha256: source.sha256,
    });
  }
  return batchFiles;
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
    if (sourceContext?.business_mode === "询价机构") {
      fail(
        "MODE_NOT_APPLICABLE",
        "评分汇总仅用于手动拓展，不适用于询价机构；本次未读取或修改评分表",
      );
    }
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
    const candidateIds = [...new Set(links.rows.map((row) => row[1].trim()))].slice(
      0,
      manualSourcePoolSize(target),
    );
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
          if (!candidateSet.has(id)) fail("SOURCE_MISMATCH", "补全结果包含本轮候选池以外的达人");
          targetSet.add(id);
        }
      }
    }
    if ([...successful].some((id) => failed.has(id)))
      fail("COMPLETION_INVALID", "同一达人同时出现在补全成功与失败名单中");
    const scoredById = new Map();
    let headers = null;
    let template = null;
    const files = new Map(sourceContext.score_files.map((file) => [file.file_path, file]));
    for (const source of files.values()) {
      const parsed = await readManualScoreWorkbook(source, {
        workspaceDir,
        requirement_id: requirementId,
        platform,
      });
      if (headers && JSON.stringify(headers) !== JSON.stringify(parsed.headers))
        fail("HEADERS", "各批评分表列配置不一致，停止汇总，不猜测或丢弃字段");
      if (template) {
        for (const part of ["xl/styles.xml", "xl/sharedStrings.xml"]) {
          if (text(template.archive[part]) !== text(parsed.template.archive[part]))
            fail("TEMPLATE", "各批评分模板样式或共享字符串不一致，不能直接合并");
        }
        if (template.headerRow !== parsed.template.headerRow)
          fail("TEMPLATE", "各批评分表头位置不一致");
      } else template = parsed.template;
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
    // 综合分 = 0.7×相关度 + 0.3×性价比；性价比在同批同平台内按成本百分位归一化。
    // 性价比数据不足的行按同批中位数代入，不当作免费或 0 分；整批都没有数据时保留原相关度分。
    const scoredRows = rows.filter((row) => row.score !== 0);
    const costEffectiveness = costEffectivenessScores(headers, scoredRows, platform);
    const validCostEffectiveness = [...costEffectiveness.values()].filter((value) => value != null);
    let medianCostEffectiveness = null;
    if (validCostEffectiveness.length) {
      const sorted = [...validCostEffectiveness].sort((a, b) => a - b);
      medianCostEffectiveness =
        sorted.length % 2 === 1
          ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    }
    let pendingCostEffectiveness = 0;
    for (const row of rows) {
      if (row.score === 0 || !validCostEffectiveness.length) {
        row.display_score = row.score;
        continue;
      }
      const cost = costEffectiveness.get(row.creator_id);
      if (cost == null) pendingCostEffectiveness += 1;
      const used = cost == null ? medianCostEffectiveness : cost;
      row.display_score =
        Math.round((RELEVANCE_WEIGHT * row.score + COST_EFFECTIVENESS_WEIGHT * used) * 10) / 10;
    }
    rows.sort(
      (a, b) =>
        b.display_score - a.display_score ||
        (costEffectiveness.get(b.creator_id) ?? -1) - (costEffectiveness.get(a.creator_id) ?? -1),
    );
    // 综合分为 0 的评分行不写入最终汇总表（用户要求）。0 分通常来自评分失败、资料无效或数据不足，
    // 也可能是有效评估但内容/类型相关度均为 0 级；该行已返回，不按缺行处理，也不自动重评。
    const deliverableRows = rows.filter((row) => row.score !== 0);
    const excludedZeroScoreCount = rows.length - deliverableRows.length;
    const recommendedCount = deliverableRows.filter((row) => row.recommended).length;
    const remaining = candidateIds.filter((id) => !successful.has(id) && !failed.has(id));
    const pendingScores = candidateIds.filter((id) => successful.has(id) && !scoredById.has(id));
    const reached = recommendedCount >= target;
    const exhausted = remaining.length === 0 && pendingScores.length === 0;
    // 首批只排 min(20, N)，目标小于 20 时不多补全用不上的达人；之后每批仍最多 20。
    const firstBatch = successful.size === 0 && failed.size === 0;
    const batchLimit = firstBatch ? Math.min(BATCH_SIZE, target) : BATCH_SIZE;
    const data = {
      requirement_id: requirementId,
      platform,
      target_count: target,
      candidate_count: candidateIds.length,
      recommended_count: recommendedCount,
      scored_count: rows.length,
      excluded_zero_score_count: excludedZeroScoreCount,
      cost_effectiveness_pending_count: pendingCostEffectiveness,
      completion_failed_count: failed.size,
      failed_author_ids: [...failed],
      unprocessed_count: remaining.length,
      pending_score_author_ids: pendingScores,
      shortfall: Math.max(0, target - recommendedCount),
      target_reached: reached,
      next_action: pendingScores.length
        ? "await_scores"
        : reached || exhausted
          ? "deliver"
          : "complete_next_batch",
      next_author_ids: reached || pendingScores.length ? [] : remaining.slice(0, batchLimit),
      stop_reason: pendingScores.length
        ? null
        : reached
          ? "target_reached"
          : exhausted
            ? "candidates_exhausted"
            : null,
      ...(pendingScores.length
        ? {
            progress: {
              display_required: true,
              is_final: false,
              user_visible_message: `当前已评分 ${rows.length} 人，推荐 ${recommendedCount} 人；${excludedZeroScoreCount ? `其中 ${excludedZeroScoreCount} 人综合分为 0，不写入汇总表；` : ""}还有 ${pendingScores.length} 人评分缺失。以下仅为阶段性结果，不代表最终汇总。`,
            },
          }
        : {}),
      links_csv_path: sourceContext.links_file.file_path,
    };
    if (data.next_action !== "deliver" || !deliverableRows.length) {
      return hostToolResult({ success: true, data }, { details: data });
    }
    const saved = await saveSummaryWorkbook(workspaceDir, requirementId, template, deliverableRows);
    const details = { ...data, ...saved };
    const delivery = {
      local_path: saved.file_path,
      local_file_link: localFileMarkdownLink(saved.file_path),
      display_required: true,
      display_before_next_action: true,
      user_visible_message: `已评分 ${rows.length} 位，推荐 ${recommendedCount} 位，目标 ${target} 位。${excludedZeroScoreCount ? `其中 ${excludedZeroScoreCount} 位综合分为 0，未写入汇总表。` : ""}${pendingCostEffectiveness ? `另有 ${pendingCostEffectiveness} 位性价比数据不足，按同批中位数计入排序。` : ""}`,
    };
    return hostToolResult({ success: true, data: details, delivery }, { details });
  } catch (error) {
    const code = error?.code?.startsWith("YPSCAN_MANUAL_SCORE_")
      ? error.code
      : "YPSCAN_MANUAL_SCORE_READ_FAILED";
    const batchFiles =
      code === "YPSCAN_MANUAL_SCORE_MODE_NOT_APPLICABLE"
        ? []
        : await verifiedBatchDeliveries(sourceContext, workspaceDir, params?.requirement_id);
    return hostToolResult(
      {
        success: false,
        error: {
          code,
          message: error?.code?.startsWith("YPSCAN_MANUAL_SCORE_")
            ? error.message
            : "评分汇总无法安全读取或保存；保留已有文件并停止，不猜测推荐人数",
          retriable: false,
        },
        ...(batchFiles.length
          ? {
              data: {
                partial_delivery: {
                  display_required: true,
                  display_before_next_action: true,
                  user_visible_message: "以下为本批评分结果，汇总未完成。",
                  batch_files: batchFiles,
                },
              },
            }
          : {}),
      },
      { isError: true },
    );
  }
}

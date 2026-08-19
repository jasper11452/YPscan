import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { checkCandidatePrice } from "./manual-research-price-check.js";
import {
  candidateReference,
  detailQueueLimit,
  evaluateCandidateList,
  mergeDetailRecords,
  mergeReviewRecords,
  reviewEvidenceGaps,
  reviewBatch,
} from "./manual-research-detail.js";

export const MANUAL_RESEARCH_PREVIEW_LIMIT = 20;

const CHECKPOINT_VERSION = 2;
const ARTIFACT_DIR = "ypscan-manual-research";

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function safeSegment(value) {
  return (
    clean(value)
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "requirement"
  );
}

function fingerprintFor(params, plan) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          requirement_id: params.requirement_id,
          platform: params.platform,
          keywords: plan.keywords,
          filters: plan.filters,
          detail_filters: plan.detail_filters,
          review_requirements: plan.review_requirements,
          price_view: plan.price_view,
          export_summary: plan.export_summary,
          target_count: plan.target_count,
          collection_target: plan.collection_target,
        }),
      ),
    )
    .digest("hex");
}

async function appendDurable(path, value) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readCheckpointEvents(
  path,
  { missingAsEmpty = false, repairTrailingPartial = false } = {},
) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (missingAsEmpty && error?.code === "ENOENT") return [];
    throw error;
  }
  const lines = content.split("\n");
  const lastEventIndex = lines.findLastIndex(Boolean);
  const events = [];
  let validByteLength = 0;
  for (const [index, line] of lines.entries()) {
    const lineByteLength = Buffer.byteLength(line) + Number(index < lines.length - 1);
    if (!line) {
      validByteLength += lineByteLength;
      continue;
    }
    try {
      events.push(JSON.parse(line));
      validByteLength += lineByteLength;
    } catch {
      if (index === lastEventIndex) {
        if (repairTrailingPartial) {
          const handle = await open(path, "r+");
          try {
            await handle.truncate(validByteLength);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        break;
      }
      throw new Error("checkpoint_corrupt");
    }
  }
  return events;
}

function replayCheckpointEvents(events, fingerprint = null) {
  const state = {
    candidates: [],
    branches: [],
    details: [],
    reviews: [],
    selections: [],
    event_count: 0,
    page_count: 0,
    source_url: null,
    interruption: null,
    browser_states: [],
    browser_actions: [],
    phase_transitions: [],
    runner_states: [],
  };
  const branchMap = new Map();
  for (const event of events) {
    if (fingerprint && event.fingerprint !== fingerprint) continue;
    state.event_count += 1;
    if (event.type === "page") {
      state.page_count += 1;
      state.candidates.push(...(event.candidates ?? []));
      state.source_url = event.page?.source_url ?? state.source_url;
    }
    if (event.type === "branch" && event.branch?.branch_id) {
      branchMap.set(event.branch.branch_id, event.branch);
    }
    if (event.type === "detail" && event.detail?.candidate_ref) state.details.push(event.detail);
    if (event.type === "review" && event.review?.candidate_ref) state.reviews.push(event.review);
    if (event.type === "selection" && event.selection?.branch?.branch_id) {
      state.selections.push(event.selection);
    }
    if (event.type === "interruption" && event.interruption) {
      state.interruption = event.interruption;
    }
    if (event.type === "browser_state" && event.state) state.browser_states.push(event.state);
    if (event.type === "browser_action" && event.action) state.browser_actions.push(event.action);
    if (event.type === "phase_transition" && event.transition) {
      state.phase_transitions.push(event.transition);
    }
    if (event.type === "runner_state" && event.state) state.runner_states.push(event.state);
  }
  state.branches = [...branchMap.values()];
  state.details = mergeDetailRecords(state.details);
  state.reviews = mergeReviewRecords(state.reviews);
  return state;
}

async function writeAtomic(path, buffer) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, path);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

function xml(value) {
  return [...String(value ?? "")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join("")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function templateCellStyle(rowIndex, columnIndex) {
  if (rowIndex === 0) return 1;
  if (rowIndex === 1) return columnIndex < 8 ? 2 : 3;
  if (rowIndex === 2) return columnIndex % 2 === 0 && columnIndex < 12 ? 4 : 5;
  if (rowIndex === 3) return 0;
  if (rowIndex === 4) return 6;
  const striped = rowIndex % 2 === 0 ? 7 : 8;
  return columnIndex === 8 ? striped + 2 : striped;
}

function worksheetXml(rows, widths) {
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
          return `<c r="${reference}" t="inlineStr" s="${templateCellStyle(rowIndex, columnIndex)}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        })
        .join("");
      const heights = [34, 28, 28, 12, 36];
      const height = heights[rowIndex] ?? 40;
      return `<row r="${rowIndex + 1}" ht="${height}" customHeight="1">${cells}</row>`;
    })
    .join("");
  const columns = widths
    .map(
      (width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
    )
    .join("");
  const lastColumn = columnName(Math.max(0, widths.length - 1));
  const lastRow = Math.max(1, rows.length);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>${columns}</cols>
  <sheetData>${rowXml}</sheetData>
  <autoFilter ref="A5:${lastColumn}${lastRow}"/>
  <mergeCells count="3"><mergeCell ref="A1:M1"/><mergeCell ref="A2:H2"/><mergeCell ref="I2:M2"/></mergeCells>
  <pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosTimestamp(value) {
  const date = new Date(value);
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function zip(entries, timestamp) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosTimestamp(timestamp);
  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function candidatesWithPriceCheck(candidates, plan) {
  return candidates.map((candidate) => ({
    ...candidate,
    price_check: checkCandidatePrice(candidate, plan),
    list_hard_evaluation: candidate.list_hard_evaluation ?? evaluateCandidateList(candidate, plan),
  }));
}

function eligiblePriceCheck(priceCheck) {
  return ["passed", "not_required"].includes(priceCheck?.status);
}

function detailMapFor(details) {
  return new Map(mergeDetailRecords(details).map((detail) => [detail.candidate_ref, detail]));
}

function reviewMapFor(reviews) {
  return new Map(mergeReviewRecords(reviews).map((review) => [review.candidate_ref, review]));
}

function platformDisplay(value) {
  if (["xingtu", "douyin"].includes(value)) return "抖音";
  if (["pgy", "xiaohongshu"].includes(value)) return "小红书";
  return clean(value) || "未知";
}

function dateTimeDisplay(value) {
  if (!clean(value)) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return clean(value);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function reasonDisplay(value) {
  return (
    {
      price_out_of_range: "报价不在要求区间",
      quote_tier_missing: "报价档位缺失",
      required_value_missing: "缺少必要数据",
    }[value] ?? value
  );
}

function deadlineDisplay(value) {
  const formatted = dateTimeDisplay(value);
  return formatted || "未提供";
}

function monthDay(value) {
  const display = dateTimeDisplay(value);
  return display ? display.slice(5, 10).replace("-", "") : "导出";
}

function selectedPrice(fields, candidate) {
  const tierPrices = Object.values(fields.price_by_tier ?? {});
  const tierPrice = tierPrices.find((value) => value !== null && value !== undefined);
  return (
    candidate.price_raw ??
    fields.price_picture_raw ??
    fields.price_video_raw ??
    tierPrice?.raw ??
    tierPrice?.value ??
    tierPrice ??
    ""
  );
}

function candidateStatus(candidate, detail, review, selectedReferences) {
  const reference = candidateReference(candidate);
  if (selectedReferences.has(reference)) return "已复核纳入";
  if (review?.decision === "exclude") return "已复核淘汰";
  if (
    candidate.price_check?.status === "rejected" ||
    candidate.list_hard_evaluation?.status === "fail" ||
    detail?.hard_evaluation?.status === "fail"
  ) {
    return "硬条件失败";
  }
  if (candidate.collection_mode && candidate.collection_mode !== "filtered") return "降级召回";
  if (
    candidate.price_check?.status === "needs_review" ||
    detail?.hard_evaluation?.status === "unknown" ||
    !review
  ) {
    return "待核验";
  }
  return "待核验";
}

function candidateRemarks(candidate, detail, review) {
  return [
    candidate.price_check?.status === "rejected" ? candidate.price_check.reason : null,
    ...(candidate.list_hard_evaluation?.checks ?? [])
      .filter((check) => check.verdict !== "pass")
      .map((check) => check.reason ?? check.control),
    ...(detail?.hard_evaluation?.checks ?? [])
      .filter((check) => check.verdict !== "pass")
      .map((check) => check.reason ?? check.control),
    ...(review?.reasons ?? []),
    candidate.collection_mode && candidate.collection_mode !== "filtered"
      ? `召回方式：${candidate.collection_mode}`
      : null,
  ]
    .map(reasonDisplay)
    .map(clean)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("；");
}

const TALENT_HEADERS = Object.freeze([
  "供应商名称",
  "状态",
  "提交时间",
  "达人名称",
  "平台",
  "主页链接",
  "粉丝数",
  "内容形式",
  "报价",
  "可执行档期",
  "返点比例",
  "历史案例",
  "备注",
]);

const TALENT_WIDTHS = Object.freeze([18, 12, 20, 22, 12, 36, 14, 20, 16, 22, 14, 38, 42]);

function talentRows(candidates, details, reviews, selectedCandidates, generatedAt) {
  const detailMap = detailMapFor(details);
  const reviewMap = reviewMapFor(reviews);
  const selectedReferences = new Set(selectedCandidates.map(candidateReference));
  return candidates.map((candidate) => {
    const candidateRef = candidateReference(candidate);
    const detail = detailMap.get(candidateRef);
    const review = reviewMap.get(candidateRef);
    const fields = detail?.fields ?? {};
    return [
      fields.agency,
      candidateStatus(candidate, detail, review, selectedReferences),
      dateTimeDisplay(detail?.captured_at ?? generatedAt),
      candidate.nickname ?? detail?.nickname,
      platformDisplay(candidate.platform),
      detail?.detail_url ?? candidate.detail_url,
      fields.followers_raw ?? candidate.followers_raw,
      [
        ...new Set(
          [fields.content_type, ...(fields.tags ?? []), ...(candidate.tags ?? [])].filter(Boolean),
        ),
      ].join("、"),
      selectedPrice(fields, candidate),
      "",
      "",
      (fields.recent_content ?? [])
        .slice(0, 3)
        .map((item) => item.title ?? item.url)
        .filter(Boolean)
        .join("；"),
      candidateRemarks(candidate, detail, review),
    ];
  });
}

function templateRows({ plan, generatedAt, submittedCount, candidates, sheetKind }) {
  const summary = plan.export_summary ?? {};
  const brand = clean(summary.brand_product) || "项目";
  const project = clean(summary.project_name) || brand;
  const titleKind = sheetKind === "candidates" ? "候选达人" : "达人推荐List";
  return [
    [`【${brand}】悦普识星-${titleKind}-${monthDay(generatedAt)}`, ...Array(12).fill("")],
    [
      `达人提报｜${project}，确保填写信息的准确性`,
      ...Array(7).fill(""),
      `提报截止：${deadlineDisplay(summary.submission_deadline)}`,
      ...Array(4).fill(""),
    ],
    [
      "品牌 / 产品",
      brand,
      "项目名称",
      project,
      "投放平台",
      platformDisplay(plan.platform),
      "需求数量",
      `${plan.target_count ?? "未知"}位`,
      "提报数量",
      `${submittedCount}位`,
      "负责媒介",
      clean(summary.responsible_media) || "未提供",
      "",
    ],
    Array(13).fill(""),
    [...TALENT_HEADERS],
    ...candidates,
  ];
}

function finalCandidates(candidates, details, reviews, targetCount) {
  const detailMap = detailMapFor(details);
  const reviewMap = reviewMapFor(reviews);
  return candidates
    .filter((candidate) => {
      const candidateRef = candidateReference(candidate);
      return (
        candidate.collection_mode !== "generic_dom" &&
        detailMap.get(candidateRef)?.hard_evaluation?.status === "pass" &&
        reviewMap.get(candidateRef)?.decision === "include"
      );
    })
    .slice(0, targetCount ?? candidates.length);
}

const RUN_INFO_WIDTHS = Object.freeze([18, 28, 18, 70, ...Array(9).fill(2)]);

function runInfoRows(artifact) {
  const info = artifact.run_info ?? {};
  const rows = [
    ["悦普识星手扒运行说明", ...Array(12).fill("")],
    ["本表记录执行状态、降级和缺口；候选不等于最终推荐。", ...Array(12).fill("")],
    [
      "运行 ID",
      artifact.run_id,
      "执行状态",
      artifact.status,
      ...Array(9).fill(""),
    ],
    Array(13).fill(""),
    ["类别", "项目", "状态", "说明", ...Array(9).fill("")],
  ];
  const add = (category, item, status, description) => {
    rows.push([category, item, status, description, ...Array(9).fill("")]);
  };
  add("标识", "需求 ID", "", info.requirement_id ?? "未知");
  add("标识", "平台", "", info.platform ?? "未知");
  add("执行", "阶段", info.phase ?? "未知", info.quality_level ?? "unverified");
  add("执行", "更新时间", "", info.updated_at ?? artifact.generated_at);
  add("数量", "目标 / 候选 / 推荐", "", `${info.target_count ?? "未知"} / ${info.candidate_count ?? artifact.candidate_row_count} / ${artifact.target_row_count}`);
  add("数量", "候选缺口", "", info.candidate_shortfall ?? "未知");
  add("数量", "推荐缺口", "", artifact.delivery_shortfall);
  add("搜索", "已完成关键词", "", (info.completed_keywords ?? []).join("、") || "无");
  add("搜索", "已完成页数", "", info.completed_pages ?? 0);
  add("搜索", "降级方式", "", (info.fallback_modes_used ?? []).join("、") || "无");
  add("筛选", "已应用", "", (info.applied_filters ?? []).join("；") || "无");
  add("筛选", "未应用", "", (info.unapplied_filters ?? []).join("；") || "无");
  add("详情", "完成进度", "", `${info.detail_completed ?? 0} / ${info.detail_attempted ?? 0}`);
  add("错误", info.error_code ?? "无", info.error_code ? "存在" : "无", info.error_message ?? "");
  add("恢复", "是否可恢复", info.resume_available ? "是" : "否", info.resume_instruction ?? "");
  return rows;
}

/** Build a dependency-free, standards-compliant XLSX workbook. */
export function buildManualResearchWorkbook({
  plan,
  candidates,
  details = [],
  reviews = [],
  artifact,
}) {
  const timestamp = artifact.generated_at;
  const targetCount = plan.target_count ?? candidates.length;
  const checkedCandidates = candidatesWithPriceCheck(candidates, plan);
  const finalRows = finalCandidates(checkedCandidates, details, reviews, targetCount);
  const selectedRows = talentRows(finalRows, details, reviews, finalRows, timestamp);
  const candidateSheetRows = talentRows(checkedCandidates, details, reviews, finalRows, timestamp);
  const sheets = [
    {
      name: "达人推荐List",
      rows: templateRows({
        plan,
        generatedAt: timestamp,
        submittedCount: finalRows.length,
        candidates: selectedRows,
        sheetKind: "recommended",
      }),
      widths: TALENT_WIDTHS,
    },
    ...(artifact.submission_only
      ? []
      : [
          {
            name: "候选达人",
            rows: templateRows({
              plan,
              generatedAt: timestamp,
              submittedCount: finalRows.length,
              candidates: candidateSheetRows,
              sheetKind: "candidates",
            }),
            widths: TALENT_WIDTHS,
          },
          {
            name: "运行说明",
            rows: runInfoRows(artifact),
            widths: RUN_INFO_WIDTHS,
          },
        ]),
  ];
  const sheetNames = sheets.map((sheet) => sheet.name);
  const sheetXml = sheets.map((sheet) => worksheetXml(sheet.rows, sheet.widths));
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n  ")}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView/></bookViews>
  <sheets>${sheetNames.map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
</workbook>`;
  const workbookRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("\n  ")}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="7"><font><sz val="10"/><color rgb="FF245243"/><name val="Microsoft YaHei"/></font><font><b/><sz val="18"/><color rgb="FFF7F6F1"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FF245243"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FF245243"/><name val="Microsoft YaHei"/></font><font><sz val="10"/><color rgb="FF245243"/><name val="Microsoft YaHei"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font><font><b/><sz val="10"/><color rgb="FF245243"/><name val="Microsoft YaHei"/></font></fonts>
  <fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F5A43"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF3EF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF7FAF7"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border/><border><left style="thin"><color rgb="FFD7E1DA"/></left><right style="thin"><color rgb="FFD7E1DA"/></right><top style="thin"><color rgb="FFD7E1DA"/></top><bottom style="thin"><color rgb="FFD7E1DA"/></bottom></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="11"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="5" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="6" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="6" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>YPscan</dc:creator><cp:lastModifiedBy>YPscan</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${xml(timestamp)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${xml(timestamp)}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>YPscan</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheetNames.map((name) => `<vt:lpstr>${xml(name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts></Properties>`;
  return zip(
    [
      ["[Content_Types].xml", contentTypes],
      ["_rels/.rels", rootRelationships],
      ["docProps/app.xml", app],
      ["docProps/core.xml", core],
      ["xl/workbook.xml", workbook],
      ["xl/_rels/workbook.xml.rels", workbookRelationships],
      ["xl/styles.xml", styles],
      ...sheetXml.map((value, index) => [`xl/worksheets/sheet${index + 1}.xml`, value]),
    ],
    timestamp,
  );
}

function createArtifactMetadata({
  runId,
  checkpointPath,
  excelPath,
  candidates,
  details,
  reviews,
  detailPlannedCount,
  targetRowCount,
  deliveryShortfall,
  checkpointEventCount,
  generatedAt,
  exportFallback = null,
  deliveryMessage,
  extra = {},
  executionStatus = "complete",
  runInfo = null,
}) {
  return {
    status: executionStatus,
    run_id: runId,
    checkpoint_path: checkpointPath,
    excel_path: excelPath,
    target_row_count: targetRowCount,
    candidate_row_count: candidates.length,
    detail_planned_count: detailPlannedCount,
    detail_completed_count: mergeDetailRecords(details).length,
    review_completed_count: mergeReviewRecords(reviews).length,
    ...extra,
    delivery_shortfall: deliveryShortfall,
    checkpoint_event_count: checkpointEventCount,
    generated_at: generatedAt,
    run_info: runInfo,
    native_export_quota_consumed: Boolean(exportFallback?.quota_consumed),
    delivery: {
      display_required: true,
      primary_file: "excel_path",
      user_visible_message: deliveryMessage,
    },
  };
}

async function writeArtifactWorkbook({
  plan,
  candidates,
  details,
  reviews,
  artifact,
  failureCode = null,
}) {
  const workbook = buildManualResearchWorkbook({
    plan,
    candidates,
    details,
    reviews,
    artifact,
  });
  try {
    await writeAtomic(artifact.excel_path, workbook);
  } catch (error) {
    if (failureCode) error.code = failureCode;
    throw error;
  }
  artifact.byte_count = workbook.length;
  artifact.sha256 = createHash("sha256").update(workbook).digest("hex");
  return artifact;
}

function finalCheckpointEvent(status, candidates, artifact) {
  return {
    type: "final",
    status,
    candidate_count: candidates.length,
    detail_completed_count: artifact.detail_completed_count,
    review_completed_count: artifact.review_completed_count,
    target_row_count: artifact.target_row_count,
    delivery_shortfall: artifact.delivery_shortfall,
    excel_path: artifact.excel_path,
    sha256: artifact.sha256,
  };
}

function disabledStore() {
  return {
    enabled: false,
    run_id: null,
    restored: {
      candidates: [],
      branches: [],
      details: [],
      reviews: [],
      event_count: 0,
      page_count: 0,
      browser_states: [],
      browser_actions: [],
      phase_transitions: [],
    },
    async savePage() {},
    async saveBranch() {},
    async saveDetail() {},
    async saveInterruption() {},
    async saveSelection() {},
    async saveBrowserState() {},
    async saveBrowserAction() {},
    async savePhaseTransition() {},
    async saveRunnerState() {},
    async snapshot() {
      return { status: "unavailable", reason: "workspace_dir_unavailable" };
    },
    async finalize() {
      return { status: "unavailable", reason: "workspace_dir_unavailable" };
    },
  };
}

/**
 * @param {{workspaceDir?: string, params: any, plan: any, now?: () => number}} options
 */
export async function createManualResearchStore({ workspaceDir, params, plan, now = Date.now }) {
  if (!workspaceDir || !isAbsolute(workspaceDir)) return disabledStore();
  await mkdir(workspaceDir, { recursive: true });
  const workspacePath = await realpath(workspaceDir);
  if (!(await stat(workspacePath)).isDirectory()) return disabledStore();
  const root = join(workspacePath, ARTIFACT_DIR);
  await mkdir(root, { recursive: true });
  const fingerprint = fingerprintFor(params, plan);
  const baseRunName = `${params.platform}-${safeSegment(params.requirement_id)}-${fingerprint.slice(0, 12)}`;
  const latestPointerPath = join(root, `${baseRunName}.latest`);
  let latestRunName = null;
  if (!params.fresh_run) {
    try {
      const pointedName = clean(await readFile(latestPointerPath, "utf8"));
      const belongsToPlan =
        pointedName === baseRunName || pointedName.startsWith(`${baseRunName}-`);
      const safeName =
        pointedName &&
        pointedName !== "." &&
        pointedName !== ".." &&
        !pointedName.includes("/") &&
        !pointedName.includes("\\");
      if (belongsToPlan && safeName && (await stat(join(root, pointedName))).isDirectory()) {
        latestRunName = pointedName;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const explicitRunName = clean(params.run_id);
  if (
    explicitRunName &&
    explicitRunName !== baseRunName &&
    !explicitRunName.startsWith(`${baseRunName}-`)
  ) {
    throw Object.assign(new Error("run_id 与当前筛选计划不一致"), {
      code: "YPSCAN_MANUAL_RUN_MISMATCH",
    });
  }
  const runName = explicitRunName
    ? explicitRunName
    : params.fresh_run
      ? `${baseRunName}-${new Date(now()).toISOString().replace(/\D/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`
      : (latestRunName ?? baseRunName);
  const runDir = join(root, runName);
  await mkdir(runDir, { recursive: true });
  if (params.fresh_run) {
    await writeAtomic(latestPointerPath, Buffer.from(`${runName}\n`, "utf8"));
  }
  const checkpointPath = join(runDir, "checkpoint.jsonl");
  const excelPath = join(runDir, `${runName}.xlsx`);
  const restored = replayCheckpointEvents(
    await readCheckpointEvents(checkpointPath, {
      missingAsEmpty: true,
      repairTrailingPartial: true,
    }),
    fingerprint,
  );
  let eventCount = restored.event_count;
  const append = async (event) => {
    try {
      await appendDurable(checkpointPath, {
        version: CHECKPOINT_VERSION,
        fingerprint,
        captured_at: new Date(now()).toISOString(),
        ...event,
      });
    } catch (error) {
      error.code = "YPSCAN_MANUAL_CHECKPOINT_FAILED";
      throw error;
    }
    eventCount += 1;
  };
  if (eventCount === 0) {
    await append({
      type: "run",
      requirement_id: params.requirement_id,
      platform: params.platform,
      params: { requirement_id: params.requirement_id, platform: params.platform },
      plan,
    });
  }
  /** @type {(state: any) => Promise<any>} */
  const materialize = async ({
    candidates,
    details = [],
    reviews = [],
    status,
    exportFallback = null,
    detailPlannedCount = 0,
    appendFinal = false,
    runInfo = null,
  }) => {
    const generatedAt = new Date(now()).toISOString();
    const checkedCandidates = candidatesWithPriceCheck(candidates, plan);
    const eligibleCandidateCount = checkedCandidates.filter((candidate) =>
      eligiblePriceCheck(candidate.price_check),
    ).length;
    const rejectedCandidateCount = checkedCandidates.filter(
      (candidate) => candidate.price_check.status === "rejected",
    ).length;
    const needsReviewCandidateCount = checkedCandidates.filter(
      (candidate) => candidate.price_check.status === "needs_review",
    ).length;
    const listHardPassCandidateCount = checkedCandidates.filter(
      (candidate) => candidate.list_hard_evaluation.status === "pass",
    ).length;
    const listHardRejectedCandidateCount = checkedCandidates.filter(
      (candidate) => candidate.list_hard_evaluation.status === "fail",
    ).length;
    const listHardPendingCandidateCount = checkedCandidates.filter(
      (candidate) => candidate.list_hard_evaluation.status === "unknown",
    ).length;
    const selectedCandidates = finalCandidates(candidates, details, reviews, plan.target_count);
    const deliveryShortfall = plan.target_count
      ? Math.max(plan.target_count - selectedCandidates.length, 0)
      : 0;
    const artifact = createArtifactMetadata({
      runId: runName,
      checkpointPath,
      excelPath,
      candidates,
      details,
      reviews,
      detailPlannedCount,
      targetRowCount: selectedCandidates.length,
      deliveryShortfall,
      checkpointEventCount: eventCount + Number(appendFinal),
      generatedAt,
      exportFallback,
      deliveryMessage: "手扒详情已增量保存并刷新同一 Excel；请向用户展示 excel_path。",
      extra: {
        eligible_candidate_count: eligibleCandidateCount,
        rejected_candidate_count: rejectedCandidateCount,
        needs_review_candidate_count: needsReviewCandidateCount,
        list_hard_pass_candidate_count: listHardPassCandidateCount,
        list_hard_rejected_candidate_count: listHardRejectedCandidateCount,
        list_hard_pending_candidate_count: listHardPendingCandidateCount,
        restored_candidate_count: restored.candidates.length,
      },
      executionStatus: status,
      runInfo,
    });
    await writeArtifactWorkbook({
      plan,
      candidates,
      details,
      reviews,
      artifact,
      failureCode: "YPSCAN_MANUAL_ARTIFACT_FAILED",
    });
    if (appendFinal) {
      await append(finalCheckpointEvent(status, candidates, artifact));
      artifact.checkpoint_event_count = eventCount;
    }
    return artifact;
  };
  return {
    enabled: true,
    run_id: runName,
    restored,
    checkpoint_path: checkpointPath,
    excel_path: excelPath,
    async savePage({ branch, page, candidates, rejectedCandidates = [] }) {
      await append({
        type: "page",
        branch,
        page,
        candidates,
        rejected_candidates: rejectedCandidates,
      });
    },
    async saveBranch(branch) {
      await append({ type: "branch", branch });
    },
    async saveSelection(selection) {
      await append({ type: "selection", selection });
    },
    async saveDetail({ detail, ...state }) {
      await append({ type: "detail", detail });
      return materialize({ ...state, appendFinal: false });
    },
    async saveInterruption(interruption) {
      await append({ type: "interruption", interruption });
    },
    async saveBrowserState(state) {
      await append({ type: "browser_state", state });
    },
    async saveBrowserAction(action) {
      await append({ type: "browser_action", action });
    },
    async savePhaseTransition(transition) {
      await append({ type: "phase_transition", transition });
    },
    async saveRunnerState(state) {
      await append({ type: "runner_state", state });
    },
    async finalize(state) {
      return materialize({ ...state, appendFinal: true });
    },
    async snapshot(state) {
      return materialize({ ...state, appendFinal: false });
    },
  };
}

function safeRunId(value) {
  const runId = clean(value);
  if (!runId || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\")) {
    throw Object.assign(new Error("run_id 无效"), { code: "YPSCAN_MANUAL_RUN_NOT_FOUND" });
  }
  return runId;
}

/** Load a persisted run without mutating its checkpoint. */
export async function loadManualResearchRun({ workspaceDir, runId, requirementId, platform }) {
  if (!workspaceDir || !isAbsolute(workspaceDir)) {
    throw Object.assign(new Error("workspace_dir_unavailable"), {
      code: "YPSCAN_MANUAL_WORKSPACE_UNAVAILABLE",
    });
  }
  const root = join(await realpath(workspaceDir), ARTIFACT_DIR);
  const safeId = safeRunId(runId);
  const runDir = join(root, safeId);
  let events;
  try {
    if (!(await stat(runDir)).isDirectory()) throw new Error("not_directory");
    events = await readCheckpointEvents(join(runDir, "checkpoint.jsonl"));
  } catch (error) {
    if (error?.code === "YPSCAN_MANUAL_WORKSPACE_UNAVAILABLE") throw error;
    if (error?.message === "checkpoint_corrupt") throw error;
    throw Object.assign(new Error("未找到对应的手扒运行"), {
      code: "YPSCAN_MANUAL_RUN_NOT_FOUND",
    });
  }
  const runEvent = events.find((event) => event.type === "run" && event.plan);
  if (!runEvent?.plan || !runEvent?.params) {
    throw Object.assign(new Error("该运行缺少筛选计划"), {
      code: "YPSCAN_MANUAL_RUN_UNSUPPORTED",
    });
  }
  if (runEvent.requirement_id !== requirementId || runEvent.platform !== platform) {
    throw Object.assign(new Error("run_id 与当前需求或平台不一致"), {
      code: "YPSCAN_MANUAL_RUN_MISMATCH",
    });
  }
  const restored = replayCheckpointEvents(events);
  return {
    run_id: safeId,
    fingerprint: runEvent.fingerprint,
    params: runEvent.params,
    plan: runEvent.plan,
    events,
    branches: restored.branches,
    candidates: mergeStoredCandidates(restored.candidates),
    details: restored.details,
    reviews: restored.reviews,
    selections: restored.selections,
    browser_states: restored.browser_states,
    browser_actions: restored.browser_actions,
    phase_transitions: restored.phase_transitions,
    runner_states: restored.runner_states,
    event_count: restored.event_count,
    page_count: restored.page_count,
  };
}

/** Generate a compact local submission workbook from one completed manual run. */
export async function createManualResearchSubmission({
  workspaceDir,
  runId,
  requirementId,
  platform,
  now = Date.now,
}) {
  const loaded = await loadManualResearchRun({
    workspaceDir,
    runId,
    requirementId,
    platform,
  });
  const pending = reviewBatch(loaded.candidates, loaded.details, loaded.reviews, {
    requirements: loaded.plan.review_requirements,
  });
  if (pending.remaining > 0) {
    throw Object.assign(new Error("仍有达人尚未完成语义复核"), {
      code: "YPSCAN_MANUAL_SUBMISSION_REVIEW_PENDING",
    });
  }
  const checkedCandidates = candidatesWithPriceCheck(loaded.candidates, loaded.plan);
  const selected = finalCandidates(
    checkedCandidates,
    loaded.details,
    loaded.reviews,
    loaded.plan.target_count,
  );
  if (!selected.length) {
    throw Object.assign(new Error("当前运行没有最终纳入达人"), {
      code: "YPSCAN_MANUAL_SUBMISSION_EMPTY",
    });
  }
  const root = join(await realpath(workspaceDir), ARTIFACT_DIR, safeRunId(runId));
  const submissionPath = join(root, `${safeRunId(runId)}-submission.xlsx`);
  const generatedAt = new Date(now()).toISOString();
  const workbook = buildManualResearchWorkbook({
    plan: loaded.plan,
    candidates: loaded.candidates,
    details: loaded.details,
    reviews: loaded.reviews,
    artifact: {
      run_id: loaded.run_id,
      checkpoint_path: join(root, "checkpoint.jsonl"),
      generated_at: generatedAt,
      submission_only: true,
    },
  });
  await writeAtomic(submissionPath, workbook);
  return {
    submission_path: submissionPath,
    row_count: selected.length,
    target_count: loaded.plan.target_count ?? selected.length,
    delivery_shortfall: loaded.plan.target_count
      ? Math.max(loaded.plan.target_count - selected.length, 0)
      : 0,
    byte_count: workbook.length,
    sha256: createHash("sha256").update(workbook).digest("hex"),
    generated_at: generatedAt,
  };
}

function mergeStoredCandidates(candidates) {
  const result = [];
  const byReference = new Map();
  for (const candidate of candidates) {
    const reference = candidateReference(candidate);
    const existing = byReference.get(reference);
    if (!existing) {
      const value = { ...candidate };
      result.push(value);
      byReference.set(reference, value);
      continue;
    }
    existing.source_branches = [
      ...new Set([...(existing.source_branches ?? []), ...(candidate.source_branches ?? [])]),
    ];
    existing.source_pages = [
      ...new Set([...(existing.source_pages ?? []), ...(candidate.source_pages ?? [])]),
    ];
    for (const [key, value] of Object.entries(candidate)) {
      if (
        (existing[key] === null || existing[key] === undefined || existing[key] === "") &&
        value
      ) {
        existing[key] = value;
      }
    }
  }
  return result;
}

/** Apply one Agent review batch to an existing checkpointed run. */
export async function applyManualResearchReviews({
  workspaceDir,
  runId,
  requirementId,
  platform,
  reviews,
  now = Date.now,
}) {
  if (!workspaceDir || !isAbsolute(workspaceDir)) {
    throw Object.assign(new Error("workspace_dir_unavailable"), {
      code: "YPSCAN_MANUAL_WORKSPACE_UNAVAILABLE",
    });
  }
  const root = join(await realpath(workspaceDir), ARTIFACT_DIR);
  const entry = (await readdir(root, { withFileTypes: true })).find(
    (item) => item.isDirectory() && item.name === runId,
  );
  if (!entry) {
    throw Object.assign(new Error("未找到对应的手扒运行"), {
      code: "YPSCAN_MANUAL_RUN_NOT_FOUND",
    });
  }
  const runDir = join(root, entry.name);
  const checkpointPath = join(runDir, "checkpoint.jsonl");
  const excelPath = join(runDir, `${entry.name}.xlsx`);
  const events = await readCheckpointEvents(checkpointPath, { repairTrailingPartial: true });
  const runEvent = events.find((event) => event.type === "run" && event.plan);
  if (!runEvent?.plan || !runEvent?.params) {
    throw Object.assign(new Error("该旧运行缺少详情复核所需的计划数据"), {
      code: "YPSCAN_MANUAL_REVIEW_RUN_UNSUPPORTED",
    });
  }
  if (runEvent.requirement_id !== requirementId || runEvent.platform !== platform) {
    throw Object.assign(new Error("run_id 与当前需求或平台不一致"), {
      code: "YPSCAN_MANUAL_REVIEW_RUN_MISMATCH",
    });
  }
  const plan = runEvent.plan;
  const params = runEvent.params;
  const restored = replayCheckpointEvents(events);
  const candidates = mergeStoredCandidates(restored.candidates);
  const details = restored.details;
  const detailMap = detailMapFor(details);
  const candidateReferences = new Set(candidates.map(candidateReference));
  for (const review of reviews) {
    if (
      !candidateReferences.has(review.candidate_ref) ||
      detailMap.get(review.candidate_ref)?.hard_evaluation?.status !== "pass"
    ) {
      throw Object.assign(new Error(`达人不在当前待复核批次：${review.candidate_ref}`), {
        code: "YPSCAN_MANUAL_REVIEW_CANDIDATE_INVALID",
      });
    }
    if (
      review.decision === "include" &&
      reviewEvidenceGaps(detailMap.get(review.candidate_ref), plan.review_requirements).length
    ) {
      throw Object.assign(new Error(`达人缺少必要复核证据：${review.candidate_ref}`), {
        code: "YPSCAN_MANUAL_REVIEW_EVIDENCE_MISSING",
      });
    }
  }
  const fingerprint = runEvent.fingerprint;
  const capturedAt = new Date(now()).toISOString();
  for (const review of reviews) {
    await appendDurable(checkpointPath, {
      version: CHECKPOINT_VERSION,
      fingerprint,
      captured_at: capturedAt,
      type: "review",
      review: { ...review, reviewed_at: capturedAt },
    });
  }
  const mergedReviews = mergeReviewRecords([...restored.reviews, ...reviews]);
  const batch = reviewBatch(candidates, details, mergedReviews, {
    requirements: plan.review_requirements,
  });
  const status = batch.remaining > 0 ? "reviewing" : "complete";
  const selected = finalCandidates(candidates, details, mergedReviews, plan.target_count);
  const artifact = createArtifactMetadata({
    runId: entry.name,
    checkpointPath,
    excelPath,
    candidates,
    details,
    reviews: mergedReviews,
    detailPlannedCount: detailQueueLimit(plan),
    targetRowCount: selected.length,
    deliveryShortfall: plan.target_count ? Math.max(plan.target_count - selected.length, 0) : 0,
    checkpointEventCount: events.length + reviews.length + 1,
    generatedAt: capturedAt,
    deliveryMessage: "复核结果已写回同一 Excel；请向用户展示 excel_path。",
  });
  await writeArtifactWorkbook({
    plan,
    candidates,
    details,
    reviews: mergedReviews,
    artifact,
  });
  await appendDurable(checkpointPath, {
    version: CHECKPOINT_VERSION,
    fingerprint,
    captured_at: capturedAt,
    ...finalCheckpointEvent(status, candidates, artifact),
  });
  return {
    params,
    plan,
    branches: restored.branches,
    candidates,
    details,
    reviews: mergedReviews,
    review_batch: batch.tasks,
    review_remaining: batch.remaining,
    status,
    artifact,
  };
}

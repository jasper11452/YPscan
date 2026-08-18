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

function worksheetXml(rows, widths) {
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
          return `<c r="${reference}" t="inlineStr" s="${rowIndex === 0 ? 1 : 2}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="32" customHeight="1"' : ""}>${cells}</row>`;
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
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${columns}</cols>
  <sheetData>${rowXml}</sheetData>
  <autoFilter ref="A1:${lastColumn}${lastRow}"/>
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

function missingFields(candidate) {
  return [
    ["platform_id", candidate.platform_id],
    ["followers", candidate.followers_raw],
    ["price", candidate.price_raw],
    ["detail_url", candidate.detail_url],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
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

function priceCheckReview(priceCheck) {
  if (priceCheck?.status === "passed") return "对应档位报价合规；待 Agent 语义复核";
  if (priceCheck?.status === "rejected") return "报价不在要求区间，不得推荐";
  if (priceCheck?.status === "needs_review") return "报价或档位证据不足，待确认";
  return "未提供达人报价条件；待 Agent 语义复核";
}

function candidateRows(candidates, plan) {
  const branchKeywords = new Map(
    plan.branches.map((branch) => [branch.branch_id, branch.keyword || "无关键词"]),
  );
  const header = [
    "序号",
    "平台",
    "平台ID",
    "达人昵称",
    "达人本人性别",
    "城市",
    "内容类型/标签",
    "合作形式/报价口径",
    "报价",
    "价格校验状态",
    "价格校验原因",
    "列表硬筛状态",
    "列表硬筛失败/待补证",
    "标准化报价（元）",
    "要求报价区间",
    "要求报价档位",
    "粉丝数",
    "预期CPM",
    "预期CPE",
    "互动率",
    "预期播放/阅读",
    "详情链接",
    "来源页",
    "关键词分支",
    "采集页码",
    "缺失字段",
    "复核状态",
  ];
  return [
    header,
    ...candidates.map((candidate, index) => [
      index + 1,
      candidate.platform,
      candidate.platform_id,
      candidate.nickname,
      candidate.creator_gender,
      candidate.city,
      [
        ...new Set([candidate.content_type, ...(candidate.tags ?? [])].map(clean).filter(Boolean)),
      ].join("、"),
      candidate.quote_tier,
      candidate.price_raw,
      candidate.price_check?.status,
      candidate.price_check?.reason,
      candidate.list_hard_evaluation?.status,
      (candidate.list_hard_evaluation?.checks ?? [])
        .filter((check) => check.verdict !== "pass")
        .map((check) => `${check.control}:${check.reason ?? check.verdict}`)
        .join("；"),
      candidate.price_check?.observed_yuan,
      candidate.price_check?.required_min === null
        ? ""
        : `${candidate.price_check.required_min}–${candidate.price_check.required_max}`,
      candidate.price_check?.required_tier,
      candidate.followers_raw,
      candidate.cpm_raw,
      candidate.cpe_raw,
      candidate.interaction_rate,
      candidate.expected_views,
      candidate.detail_url,
      candidate.source_url,
      (candidate.source_branches ?? [])
        .map((branchId) => branchKeywords.get(branchId) ?? branchId)
        .join("、"),
      (candidate.source_pages ?? []).join("、"),
      missingFields(candidate).join("、"),
      priceCheckReview(candidate.price_check),
    ]),
  ];
}

function detailMapFor(details) {
  return new Map(mergeDetailRecords(details).map((detail) => [detail.candidate_ref, detail]));
}

function reviewMapFor(reviews) {
  return new Map(mergeReviewRecords(reviews).map((review) => [review.candidate_ref, review]));
}

function detailRows(candidates, details, reviews) {
  const detailMap = detailMapFor(details);
  const reviewMap = reviewMapFor(reviews);
  const header = [
    "序号",
    "平台",
    "平台ID",
    "达人昵称",
    "详情状态",
    "详情原因",
    "硬筛状态",
    "语义复核",
    "复核原因",
    "粉丝数",
    "城市",
    "机构",
    "账号类型",
    "内容类型/标签",
    "图文报价",
    "视频报价",
    "分档报价",
    "CPM",
    "CPE",
    "互动率",
    "预期播放/阅读",
    "男性粉丝占比",
    "女性粉丝占比",
    "18-23岁占比",
    "24-30岁占比",
    "31-40岁占比",
    "受众城市",
    "受众人群画像",
    "阅读中位数",
    "互动中位数",
    "近期内容（最多3条）",
    "详情链接",
    "响应路径",
    "采集来源",
    "采集时间",
  ];
  return [
    header,
    ...candidates.map((candidate, index) => {
      const candidateRef = candidateReference(candidate);
      const detail = detailMap.get(candidateRef);
      const review = reviewMap.get(candidateRef);
      const fields = detail?.fields ?? {};
      return [
        index + 1,
        candidate.platform,
        candidate.platform_id,
        candidate.nickname,
        detail?.status ?? "not_collected",
        detail?.reason,
        detail?.hard_evaluation?.status ?? "unknown",
        review?.decision ?? "待复核",
        (review?.reasons ?? []).join("；"),
        fields.followers_raw ?? candidate.followers_raw,
        fields.city ?? candidate.city,
        fields.agency,
        fields.account_type,
        [
          ...new Set(
            [fields.content_type, ...(fields.tags ?? []), ...(candidate.tags ?? [])].filter(
              Boolean,
            ),
          ),
        ].join("、"),
        fields.price_picture_raw,
        fields.price_video_raw,
        Object.entries(fields.price_by_tier ?? {})
          .map(([tier, value]) => `${tier}:${value?.raw ?? value?.value ?? value}`)
          .join("；"),
        fields.cpm_raw ?? candidate.cpm_raw,
        fields.cpe_raw ?? candidate.cpe_raw,
        fields.interaction_rate_raw ?? fields.interaction_rate ?? candidate.interaction_rate,
        fields.expected_views_raw ?? fields.expected_views ?? candidate.expected_views,
        fields.audience_male_rate_raw ?? fields.audience_male_rate,
        fields.audience_female_rate_raw ?? fields.audience_female_rate,
        fields.audience_age_18_23_rate_raw ?? fields.audience_age_18_23_rate,
        fields.audience_age_24_30_rate_raw ?? fields.audience_age_24_30_rate,
        fields.audience_age_31_40_rate_raw ?? fields.audience_age_31_40_rate,
        (fields.audience_city_distribution ?? fields.audience_cities ?? [])
          .map((item) => (typeof item === "string" ? item : `${item.name}:${item.rate_raw ?? ""}`))
          .join("、"),
        (fields.audience_persona_distribution ?? [])
          .map((item) => `${item.name}:${item.rate_raw ?? ""}`)
          .join("、"),
        fields.read_median_raw ?? fields.read_median,
        fields.interaction_median_raw ?? fields.interaction_median,
        (fields.recent_content ?? [])
          .map((item) => [item.title, item.published_at, item.url].filter(Boolean).join(" | "))
          .join("；"),
        detail?.detail_url ?? candidate.detail_url,
        (detail?.response_endpoints ?? []).join("；"),
        detail?.source_type,
        detail?.captured_at,
      ];
    }),
  ];
}

function conditionRows(candidates, details) {
  const candidateMap = new Map(
    candidates.map((candidate) => [candidateReference(candidate), candidate]),
  );
  const rows = [["达人引用", "达人昵称", "条件", "期望值", "实际值", "结果", "来源", "原因"]];
  for (const candidate of candidates) {
    for (const check of candidate.list_hard_evaluation?.checks ?? []) {
      rows.push([
        candidateReference(candidate),
        candidate.nickname,
        check.control,
        Array.isArray(check.expected) ? check.expected.join("、") : check.expected,
        Array.isArray(check.actual) ? check.actual.join("、") : check.actual,
        check.verdict,
        check.source_type,
        check.reason,
      ]);
    }
  }
  for (const detail of mergeDetailRecords(details)) {
    const candidate = candidateMap.get(detail.candidate_ref);
    for (const check of detail.hard_evaluation?.checks ?? []) {
      rows.push([
        detail.candidate_ref,
        candidate?.nickname ?? detail.nickname,
        check.control,
        Array.isArray(check.expected) ? check.expected.join("、") : check.expected,
        Array.isArray(check.actual) ? check.actual.join("、") : check.actual,
        check.verdict,
        check.source_type,
        check.reason,
      ]);
    }
  }
  return rows;
}

function finalCandidates(candidates, details, reviews, targetCount) {
  const detailMap = detailMapFor(details);
  const reviewMap = reviewMapFor(reviews);
  return candidates
    .filter((candidate) => {
      const candidateRef = candidateReference(candidate);
      return (
        detailMap.get(candidateRef)?.hard_evaluation?.status === "pass" &&
        reviewMap.get(candidateRef)?.decision === "include"
      );
    })
    .slice(0, targetCount ?? candidates.length);
}

/** Build a dependency-free, standards-compliant XLSX workbook. */
export function buildManualResearchWorkbook({
  params,
  plan,
  branches,
  candidates,
  details = [],
  reviews = [],
  status,
  artifact,
}) {
  const timestamp = artifact.generated_at;
  const targetCount = plan.target_count ?? candidates.length;
  const checkedCandidates = candidatesWithPriceCheck(candidates, plan);
  const eligibleCandidates = checkedCandidates.filter((candidate) =>
    eligiblePriceCheck(candidate.price_check),
  );
  const rejectedCandidates = checkedCandidates.filter(
    (candidate) => candidate.price_check.status === "rejected",
  );
  const needsReviewCandidates = checkedCandidates.filter(
    (candidate) => candidate.price_check.status === "needs_review",
  );
  const finalRows = finalCandidates(checkedCandidates, details, reviews, targetCount);
  const deliveryShortfall = plan.target_count
    ? Math.max(plan.target_count - finalRows.length, 0)
    : 0;
  const poolWidths = [
    6, 10, 22, 22, 12, 18, 36, 20, 14, 16, 22, 18, 20, 18, 14, 12, 12, 12, 16, 42, 42, 24, 14, 24,
    16,
  ];
  const detailWidths = [
    6, 10, 22, 22, 14, 22, 12, 12, 30, 14, 16, 20, 16, 36, 14, 14, 30, 12, 12, 12, 16, 14, 14, 14,
    14, 14, 28, 14, 14, 60, 42, 42, 18, 22,
  ];
  const metadataRows = [
    ["字段", "值"],
    ["需求ID", params.requirement_id],
    ["平台", params.platform],
    ["运行状态", status],
    ["运行ID", artifact.run_id ?? ""],
    ["目标交付数", targetCount],
    ["最终名单行数", finalRows.length],
    ["完整候选池行数", candidates.length],
    ["详情计划数", artifact.detail_planned_count ?? 0],
    ["详情完成数", mergeDetailRecords(details).length],
    ["语义复核数", mergeReviewRecords(reviews).length],
    ["价格合格候选数", eligibleCandidates.length],
    ["价格淘汰候选数", rejectedCandidates.length],
    ["价格待复核候选数", needsReviewCandidates.length],
    ["交付缺口", deliveryShortfall],
    ["关键词", plan.keywords.join("、")],
    ["已完成关键词分支", branches.map((branch) => branch.keyword || "无关键词").join("、")],
    ["报价口径", plan.price_view],
    ["手扒报价范围", "客户报价下探 50%、上探 20%（即客户值的 50%–120%）"],
    [
      "实际报价筛选",
      plan.filters
        .filter((filter) => filter.control === "creator_price")
        .map((filter) => `${filter.min ?? ""}–${filter.max ?? ""} ${filter.unit ?? ""}`.trim())
        .join("；") || "未提供达人报价条件",
    ],
    [
      "详情硬审条件",
      (plan.detail_filters ?? [])
        .map((filter) =>
          filter.mode === "range"
            ? `${filter.control}:${filter.min ?? ""}–${filter.max ?? ""}`
            : `${filter.control}:${(filter.values ?? []).join("、")}`,
        )
        .join("；") || "无",
    ],
    [
      "语义复核条件",
      (plan.review_requirements ?? [])
        .map((item) => item.quote || `${item.fact_kind}:${item.expected ?? ""}`)
        .join("；") || "无",
    ],
    ["增量Checkpoint", artifact.checkpoint_path],
    ["生成时间", timestamp],
    ["说明", "最终名单仅包含详情硬条件通过且 Agent 语义复核纳入的达人；空值按未知处理。"],
  ];
  const sheets = [
    { name: "最终名单", rows: detailRows(finalRows, details, reviews), widths: detailWidths },
    {
      name: "详情补录",
      rows: detailRows(checkedCandidates, details, reviews),
      widths: detailWidths,
    },
    { name: "完整候选池", rows: candidateRows(checkedCandidates, plan), widths: poolWidths },
    {
      name: "条件判断",
      rows: conditionRows(checkedCandidates, details),
      widths: [28, 22, 22, 24, 24, 12, 16, 28],
    },
    { name: "运行信息", rows: metadataRows, widths: [24, 90] },
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
  <fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border/><border><left style="thin"><color rgb="FFD9E1F2"/></left><right style="thin"><color rgb="FFD9E1F2"/></right><top style="thin"><color rgb="FFD9E1F2"/></top><bottom style="thin"><color rgb="FFD9E1F2"/></bottom></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
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
}) {
  return {
    status: "complete",
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
    native_export_quota_consumed: Boolean(exportFallback?.quota_consumed),
    delivery: {
      display_required: true,
      primary_file: "excel_path",
      user_visible_message: deliveryMessage,
    },
  };
}

async function writeArtifactWorkbook({
  params,
  plan,
  branches,
  candidates,
  details,
  reviews,
  status,
  artifact,
  failureCode = null,
}) {
  const workbook = buildManualResearchWorkbook({
    params,
    plan,
    branches,
    candidates,
    details,
    reviews,
    status,
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
    },
    async savePage() {},
    async saveBranch() {},
    async saveDetail() {},
    async saveInterruption() {},
    async saveSelection() {},
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
    branches,
    candidates,
    details = [],
    reviews = [],
    status,
    exportFallback = null,
    detailPlannedCount = 0,
    appendFinal = false,
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
    });
    await writeArtifactWorkbook({
      params,
      plan,
      branches,
      candidates,
      details,
      reviews,
      status,
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
    async savePage({ branch, page, candidates }) {
      await append({ type: "page", branch, page, candidates });
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
    params,
    plan,
    branches: restored.branches,
    candidates,
    details,
    reviews: mergedReviews,
    status,
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

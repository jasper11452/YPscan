import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import readXlsxFile from "read-excel-file/node";

import { summarizeManualScores } from "../src/tools/manual-score-summary.js";
import { previewFixture } from "./helpers/creator-preview-fixture.mjs";

const payload = (result) => JSON.parse(result.content[0].text);
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t, { quantityTotal = 10, count = 30, platform = "douyin" } = {}) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-score-summary-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const ids = Array.from({ length: count }, (_, index) => `creator-${index + 1}`);
  const linksPath = join(workspaceDir, "links.csv");
  const csv = [
    "source_record_id,creator_id,url",
    ...ids.map((id, i) => `${i + 1},${id},https://example.invalid/${id}`),
  ].join("\n");
  await writeFile(linksPath, csv);
  const sourceContext = {
    business_mode: "手动拓展",
    platform,
    quantityTotal,
    links_file: { file_path: linksPath, sha256: hash(csv) },
    completion_results: [],
    score_files: [],
  };
  let sequence = 0;
  function batch(
    selected,
    recommendedCount,
    { failed = [], verdicts, requirementId = "req", rowPlatform = platform, rows, headers } = {},
  ) {
    sequence += 1;
    const completionPath = join(workspaceDir, `completion-${sequence}.csv`);
    sourceContext.completion_results.push({
      file_path: completionPath,
      platform,
      successful_author_ids: selected,
      failed_author_ids: failed,
    });
    const columns = headers ?? [
      "平台",
      platform === "douyin" ? "星图ID" : "蒲公英ID",
      "综合得分",
      "推荐结论",
      "推荐理由",
    ];
    const workbook = previewFixture(workspaceDir, {
      name: `score-${sequence}.xlsx`,
      rows: [
        ["需求ID", requirementId],
        columns,
        ...(rows ??
          selected.map((id, index) => [
            rowPlatform,
            id,
            String(100 - index),
            verdicts?.[index] ?? (index < recommendedCount ? "推荐" : "不推荐"),
            "测试依据",
          ])),
      ],
    });
    sourceContext.score_files.push(workbook);
    return workbook;
  }
  const summarize = () =>
    summarizeManualScores({ requirement_id: "req" }, { workspaceDir, sourceContext }).then(payload);
  return { workspaceDir, ids, sourceContext, batch, summarize };
}

test("initial summary schedules only the first 20 of the three-times candidate pool", async (t) => {
  const f = await fixture(t, { count: 40 });
  const result = await f.summarize();
  assert.equal(result.success, true);
  assert.equal(result.data.candidate_count, 30);
  assert.equal(result.data.target_count, 10);
  assert.deepEqual(result.data.next_author_ids, f.ids.slice(0, 20));
  assert.equal(result.data.next_action, "complete_next_batch");
  assert.equal(result.delivery, undefined);
});

for (const platform of ["douyin", "xiaohongshu"]) {
  test(`${platform}: 10 recommendations in the first 20 stop without scheduling the remaining 10`, async (t) => {
    const f = await fixture(t, { platform });
    f.batch(f.ids.slice(0, 20), 10);
    const result = await f.summarize();
    assert.equal(result.success, true);
    assert.equal(result.data.recommended_count, 10);
    assert.equal(result.data.scored_count, 20);
    assert.equal(result.data.unprocessed_count, 10);
    assert.equal(result.data.next_action, "deliver");
    assert.equal(result.data.stop_reason, "target_reached");
    assert.deepEqual(result.data.next_author_ids, []);
    const sheets = await readXlsxFile(result.data.file_path);
    assert.deepEqual(
      sheets.map((sheet) => sheet.sheet),
      ["推荐达人", "已评分达人"],
    );
    assert.equal(sheets[0].data.length, 11);
    assert.equal(sheets[1].data.length, 21);
  });
}

test("6 recommendations then 4 produce one deduplicated final workbook", async (t) => {
  const f = await fixture(t);
  f.batch(f.ids.slice(0, 20), 6);
  const first = await f.summarize();
  assert.equal(first.data.next_action, "complete_next_batch");
  assert.deepEqual(first.data.next_author_ids, f.ids.slice(20));
  assert.equal(first.delivery, undefined);
  f.batch(f.ids.slice(20), 4);
  const last = await f.summarize();
  assert.equal(last.data.recommended_count, 10);
  assert.equal(last.data.scored_count, 30);
  assert.equal(last.data.next_action, "deliver");
  const repeated = await f.summarize();
  assert.equal(repeated.success, true);
  assert.equal(repeated.data.file_path, last.data.file_path);
  assert.equal(repeated.data.idempotent, true);
});

test("exhaustion with too few recommendations delivers the real shortage", async (t) => {
  const f = await fixture(t);
  f.batch(f.ids.slice(0, 20), 2);
  f.batch(f.ids.slice(20), 1);
  const result = await f.summarize();
  assert.equal(result.data.recommended_count, 3);
  assert.equal(result.data.shortfall, 7);
  assert.equal(result.data.stop_reason, "candidates_exhausted");
  assert.equal(result.data.next_action, "deliver");
});

test("zero recommendations still preserve all scored rows without counting processing success", async (t) => {
  const f = await fixture(t, { count: 2 });
  f.batch(f.ids, 0);
  const result = await f.summarize();
  assert.equal(result.data.recommended_count, 0);
  assert.equal(result.data.shortfall, 10);
  assert.equal(result.data.next_action, "deliver");
  const sheets = await readXlsxFile(result.data.file_path);
  assert.equal(sheets[0].data.length, 1);
  assert.equal(sheets[1].data.length, 3);
});

test("completion failures are not rescheduled or counted as unstarted authors", async (t) => {
  const f = await fixture(t);
  f.batch(f.ids.slice(0, 18), 6, { failed: f.ids.slice(18, 20) });
  const result = await f.summarize();
  assert.equal(result.data.completion_failed_count, 2);
  assert.deepEqual(result.data.next_author_ids, f.ids.slice(20));
});

test("completed but not yet scored creators prevent another completion batch", async (t) => {
  const f = await fixture(t);
  f.batch(f.ids.slice(0, 20), 10);
  f.sourceContext.score_files = [];
  const result = await f.summarize();
  assert.equal(result.data.next_action, "await_scores");
  assert.deepEqual(result.data.pending_score_author_ids, f.ids.slice(0, 20));
  assert.deepEqual(result.data.next_author_ids, []);
});

test("duplicate score rows and repeated files do not satisfy a 10-person target with 9 people", async (t) => {
  const f = await fixture(t);
  const rows = f.ids
    .slice(0, 20)
    .map((id, index) => ["douyin", id, "50", index < 9 ? "推荐" : "不推荐", "依据"]);
  const file = f.batch(f.ids.slice(0, 20), 9, { rows: [...rows, ...rows] });
  f.sourceContext.score_files.push(file);
  const result = await f.summarize();
  assert.equal(result.success, true);
  assert.equal(result.data.recommended_count, 9);
  assert.equal(result.data.next_action, "complete_next_batch");
});

for (const variant of [
  "foreign_requirement",
  "foreign_platform",
  "foreign_creator",
  "unknown_verdict",
  "ambiguous_headers",
  "conflicting_duplicate",
]) {
  test(`summary rejects ${variant} rather than fabricating a recommendation count`, async (t) => {
    const f = await fixture(t, { count: 2 });
    const options = {};
    if (variant === "foreign_requirement") options.requirementId = "other";
    if (variant === "foreign_platform") options.rowPlatform = "xiaohongshu";
    if (variant === "unknown_verdict") options.verdicts = ["考虑推荐", "不推荐"];
    if (variant === "ambiguous_headers")
      options.headers = ["平台", "星图ID", "综合得分", "推荐结论", "推荐结论"];
    if (variant === "foreign_creator") options.rows = [["douyin", "foreign", "99", "推荐", "依据"]];
    if (variant === "conflicting_duplicate")
      options.rows = [
        ["douyin", f.ids[0], "99", "推荐", "依据"],
        ["douyin", f.ids[0], "99", "不推荐", "依据"],
      ];
    f.batch(f.ids, 1, options);
    const result = await f.summarize();
    assert.equal(result.success, false);
    assert.match(result.error.code, /^YPSCAN_MANUAL_SCORE_/u);
    assert.equal(result.delivery, undefined);
  });
}

test("modified or symlinked source workbooks are not accepted", async (t) => {
  const f = await fixture(t, { count: 2 });
  const file = f.batch(f.ids, 1);
  await writeFile(file.file_path, "modified");
  assert.equal((await f.summarize()).error.code, "YPSCAN_MANUAL_SCORE_SOURCE_CHANGED");
  await rm(file.file_path);
  await symlink(f.sourceContext.links_file.file_path, file.file_path);
  assert.equal((await f.summarize()).error.code, "YPSCAN_MANUAL_SCORE_SOURCE_NOT_ALLOWED");
});

test("modified normalized links, missing context and institutional requests fail closed", async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceContext.links_file.file_path, "changed");
  assert.equal((await f.summarize()).error.code, "YPSCAN_MANUAL_SCORE_SOURCE_CHANGED");
  f.sourceContext.business_mode = "询价机构";
  assert.equal((await f.summarize()).error.code, "YPSCAN_MANUAL_SCORE_CONTEXT_UNAVAILABLE");
  const missing = payload(
    await summarizeManualScores({ requirement_id: "req" }, { workspaceDir: f.workspaceDir }),
  );
  assert.equal(missing.error.code, "YPSCAN_MANUAL_SCORE_CONTEXT_UNAVAILABLE");
});

test("score IDs remain exact strings and spreadsheet-like text cannot become a formula", async (t) => {
  const f = await fixture(t, { count: 1, quantityTotal: 1 });
  const id = "7324533389695025215";
  const csv = `source_record_id,creator_id,url\n1,${id},https://example.invalid/${id}`;
  await writeFile(f.sourceContext.links_file.file_path, csv);
  f.sourceContext.links_file.sha256 = hash(csv);
  f.batch([id], 1, { rows: [["douyin", { number: id }, "90", "推荐", "=1+1"]] });
  const result = await f.summarize();
  assert.equal(result.success, true);
  const sheets = await readXlsxFile(result.data.file_path, { parseNumber: (value) => value });
  assert.equal(sheets[0].data[1][1], id);
  assert.equal(sheets[0].data[1][4], "=1+1");
  assert.equal((await readFile(result.data.file_path)).length > 0, true);
});

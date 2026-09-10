import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import readXlsxFile from "read-excel-file/node";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Builder, parseStringPromise } from "xml2js";

import { summarizeManualScores } from "../src/tools/manual-score-summary.js";
import { previewFixture } from "./helpers/creator-preview-fixture.mjs";

async function decorateWorkbook(source, change) {
  const archive = unzipSync(await readFile(source.file_path));
  const document = await parseStringPromise(strFromU8(archive["xl/worksheets/sheet1.xml"]));
  await change(document.worksheet, archive);
  archive["xl/worksheets/sheet1.xml"] = strToU8(new Builder().buildObject(document));
  const buffer = Buffer.from(zipSync(archive));
  await writeFile(source.file_path, buffer);
  source.sha256 = hash(buffer);
  return { archive, sheet: document.worksheet };
}

test("merged workbook preserves template parts, numeric types, row styles and literal text", async (t) => {
  const f = await fixture(t, { count: 2, quantityTotal: 2 });
  const sources = [
    f.batch([f.ids[0]], 1, {
      rows: [["douyin", f.ids[0], { number: "80.25" }, "推荐", '$1 r="99"']],
    }),
    f.batch([f.ids[1]], 1, { rows: [["douyin", f.ids[1], { number: "95.5" }, "推荐", "=1+1"]] }),
  ];
  const originals = [];
  for (const [index, source] of sources.entries()) {
    originals.push(
      await decorateWorkbook(source, (sheet, archive) => {
        sheet.dimension = [{ $: { ref: "A1:E3" } }];
        sheet.sheetViews = [
          {
            sheetView: [
              {
                $: { workbookViewId: "0", showGridLines: "0" },
                pane: [{ $: { ySplit: "2", topLeftCell: "A3", state: "frozen" } }],
              },
            ],
          },
        ];
        sheet.cols = [{ col: [{ $: { min: "1", max: "5", width: "24", customWidth: "1" } }] }];
        sheet.mergeCells = [{ $: { count: "1" }, mergeCell: [{ $: { ref: "D1:E1" } }] }];
        sheet.autoFilter = [{ $: { ref: "A2:E3" } }];
        sheet.sheetData[0].row[0].c.push(
          { $: { r: "C1", t: "inlineStr" }, is: [{ t: ["评分数量"] }] },
          { $: { r: "D1", t: "inlineStr" }, is: [{ t: ["1"] }] },
        );
        sheet.sheetData[0].row[2].$ = { r: "3", ht: String(40 + index), customHeight: "1" };
        sheet.sheetData[0].row[2].c[2].$.s = "1";
        archive["xl/styles.xml"] = strToU8(
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf numFmtId="2" fontId="0" fillId="1" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
        );
      }),
    );
  }
  const result = await f.summarize();
  assert.equal(result.success, true, JSON.stringify(result.error));
  const archive = unzipSync(await readFile(result.data.file_path));
  for (const [part, bytes] of Object.entries(originals[0].archive)) {
    if (part !== "xl/worksheets/sheet1.xml") assert.deepEqual(archive[part], bytes, part);
  }
  const { worksheet: sheet } = await parseStringPromise(
    strFromU8(archive["xl/worksheets/sheet1.xml"]),
  );
  for (const key of ["cols", "sheetViews", "mergeCells"])
    assert.deepEqual(sheet[key], originals[0].sheet[key]);
  assert.equal(sheet.dimension[0].$.ref, "A1:E4");
  assert.equal(sheet.autoFilter[0].$.ref, "A2:E4");
  assert.equal(sheet.sheetData[0].row[2].$.ht, "41");
  assert.deepEqual(sheet.sheetData[0].row[2].c[2], { $: { r: "C3", t: "n", s: "1" }, v: ["95.5"] });
  const [output] = await readXlsxFile(result.data.file_path);
  assert.equal(output.data[0][3], "2");
  assert.deepEqual(
    output.data.slice(2).map((row) => row[1]),
    [f.ids[1], f.ids[0]],
  );
  assert.equal(output.data[2][4], "=1+1");
  assert.equal(output.data[3][4], '$1 r="99"');
});

test("homepage URLs become external hyperlinks after score sorting", async (t) => {
  const f = await fixture(t, { count: 2, quantityTotal: 2 });
  const headers = ["平台", "星图ID", "昵称", "综合得分", "推荐结论", "星图主页", "抖音主页"];
  const firstLinks = [
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/creator-1",
    "https://www.douyin.com/user/creator-1",
  ];
  const secondLinks = [
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/creator-2",
    "https://www.douyin.com/user/creator-2",
  ];
  f.batch([f.ids[0]], 1, {
    headers,
    rows: [["douyin", f.ids[0], "低分达人", "80", "推荐", ...firstLinks]],
  });
  f.batch([f.ids[1]], 1, {
    headers,
    rows: [["douyin", f.ids[1], "高分达人", "95", "推荐", ...secondLinks]],
  });

  const result = await f.summarize();
  assert.equal(result.success, true, JSON.stringify(result.error));
  const archive = unzipSync(await readFile(result.data.file_path));
  const { worksheet } = await parseStringPromise(strFromU8(archive["xl/worksheets/sheet1.xml"]));
  const relationships = await parseStringPromise(
    strFromU8(archive["xl/worksheets/_rels/sheet1.xml.rels"]),
  );
  const targetsById = new Map(
    relationships.Relationships.Relationship.map((relationship) => [
      relationship.$.Id,
      relationship.$,
    ]),
  );
  const linksByCell = new Map(
    worksheet.hyperlinks[0].hyperlink.map((link) => [link.$.ref, targetsById.get(link.$["r:id"])]),
  );
  assert.deepEqual([...linksByCell.keys()], ["F3", "G3", "F4", "G4"]);
  assert.deepEqual(
    ["F3", "G3", "F4", "G4"].map((ref) => linksByCell.get(ref).Target),
    [...secondLinks, ...firstLinks],
  );
  for (const relationship of linksByCell.values()) {
    assert.equal(relationship.Type.endsWith("/hyperlink"), true);
    assert.equal(relationship.TargetMode, "External");
  }
});

test("only valid HTTP homepage cells become hyperlinks", async (t) => {
  const f = await fixture(t, { count: 2, quantityTotal: 2, platform: "xiaohongshu" });
  const homepage = "https://www.xiaohongshu.com/user/profile/creator-1";
  const otherUrl = "https://example.invalid/not-a-homepage-column";
  f.batch(f.ids, 2, {
    headers: ["平台", "蒲公英ID", "综合得分", "推荐结论", "小红书主页", "资料链接"],
    rows: [
      ["xiaohongshu", f.ids[0], "90", "推荐", homepage, otherUrl],
      ["xiaohongshu", f.ids[1], "80", "推荐", "javascript:alert(1)", otherUrl],
    ],
  });

  const result = await f.summarize();
  assert.equal(result.success, true, JSON.stringify(result.error));
  const archive = unzipSync(await readFile(result.data.file_path));
  const { worksheet } = await parseStringPromise(strFromU8(archive["xl/worksheets/sheet1.xml"]));
  const relationships = await parseStringPromise(
    strFromU8(archive["xl/worksheets/_rels/sheet1.xml.rels"]),
  );
  assert.deepEqual(
    worksheet.hyperlinks[0].hyperlink.map((link) => link.$.ref),
    ["E3"],
  );
  assert.deepEqual(
    relationships.Relationships.Relationship.map((relationship) => relationship.$.Target),
    [homepage],
  );
  const [sheet] = await readXlsxFile(result.data.file_path);
  assert.deepEqual(sheet.data[2].slice(4), [homepage, otherUrl]);
  assert.deepEqual(sheet.data[3].slice(4), ["javascript:alert(1)", otherUrl]);
});

for (const extendedFirst of [false, true]) {
  test(`batch style suffixes merge without changing references (extended first: ${extendedFirst})`, async (t) => {
    const f = await fixture(t, { count: 2, quantityTotal: 2 });
    const originals = [];
    for (const [index, id] of f.ids.entries()) {
      const extended = (index === 0) === extendedFirst;
      const source = f.batch([id], 1, {
        rows: [["douyin", id, { number: String(80 + index) }, "推荐", "literal"]],
      });
      await decorateWorkbook(source, (sheet, archive) => {
        archive["xl/styles.xml"] = strToU8(
          `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/></font></fonts><fills count="${extended ? 3 : 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${extended ? '<fill><patternFill patternType="solid"><fgColor rgb="00F4F8F5"/></patternFill></fill>' : ""}</fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="${extended ? 2 : 1}"><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0"/>${extended ? '<xf numFmtId="2" fontId="0" fillId="2" borderId="0" xfId="0"/>' : ""}</cellXfs></styleSheet>`,
        );
        sheet.sheetData[0].row[2].$.s = extended ? "1" : "0";
        sheet.sheetData[0].row[2].c[2].$.s = extended ? "1" : "0";
      });
      originals.push({ source, bytes: await readFile(source.file_path) });
    }
    const result = await f.summarize();
    assert.equal(result.success, true, JSON.stringify(result.error));
    const archive = unzipSync(await readFile(result.data.file_path));
    const { styleSheet } = await parseStringPromise(strFromU8(archive["xl/styles.xml"]));
    assert.equal(styleSheet.fills[0].$.count, "3");
    assert.equal(styleSheet.cellXfs[0].$.count, "2");
    assert.equal(styleSheet.cellXfs[0].xf[1].$.fillId, "2");
    assert.equal(styleSheet.cellXfs[0].xf[1].$.numFmtId, "2");
    const { worksheet } = await parseStringPromise(strFromU8(archive["xl/worksheets/sheet1.xml"]));
    const styles = worksheet.sheetData[0].row.slice(2).map((row) => row.c[2].$.s);
    assert.deepEqual(styles, extendedFirst ? ["0", "1"] : ["1", "0"]);
    assert.deepEqual(
      worksheet.sheetData[0].row.slice(2).map((row) => row.$.s),
      styles,
    );
    const [sheet] = await readXlsxFile(result.data.file_path);
    assert.deepEqual(
      sheet.data.slice(2).map((row) => row[1]),
      [...f.ids].reverse(),
    );
    assert.deepEqual(
      sheet.data.slice(2).map((row) => row[2]),
      [81, 80],
    );
    for (const { source, bytes } of originals)
      assert.deepEqual(await readFile(source.file_path), bytes);
    assert.equal((await f.summarize()).data.file_path, result.data.file_path);
  });
}

for (const conflict of ["fill", "number_format", "theme", "shared_strings"]) {
  test(`conflicting ${conflict} definitions still stop safely`, async (t) => {
    const f = await fixture(t, { count: 2 });
    for (const [index, id] of f.ids.entries()) {
      const source = f.batch([id], 1);
      await decorateWorkbook(source, (_sheet, archive) => {
        const changed = index === 1;
        archive["xl/styles.xml"] = strToU8(
          `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fills count="1"><fill><patternFill patternType="solid"><fgColor rgb="${changed && conflict === "fill" ? "FF0000FF" : "FFFF0000"}"/></patternFill></fill></fills><cellXfs count="1"><xf fillId="0" numFmtId="${changed && conflict === "number_format" ? "10" : "2"}"/></cellXfs>${changed && conflict === "theme" ? '<colors><indexedColors><rgbColor rgb="FFFF0000"/></indexedColors></colors>' : ""}</styleSheet>`,
        );
        if (conflict === "shared_strings")
          archive["xl/sharedStrings.xml"] = strToU8(
            `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${index}</t></si></sst>`,
          );
      });
    }
    const result = await f.summarize();
    assert.equal(result.success, false);
    assert.equal(result.error.code, "YPSCAN_MANUAL_SCORE_TEMPLATE");
    assert.equal(result.delivery, undefined);
    assert.equal(result.data.partial_delivery.batch_files.length, 2);
  });
}

for (const variant of ["formula", "merged_data", "different_styles"]) {
  test(`unsafe template ${variant} stops without delivering a corrupted workbook`, async (t) => {
    const f = await fixture(t, { count: 2 });
    f.batch([f.ids[0]], 1);
    const source = f.batch([f.ids[1]], 1);
    await decorateWorkbook(source, (sheet, archive) => {
      if (variant === "formula") sheet.sheetData[0].row[2].c[2].f = ["1+1"];
      if (variant === "merged_data") sheet.mergeCells = [{ mergeCell: [{ $: { ref: "D3:E3" } }] }];
      if (variant === "different_styles")
        archive["xl/styles.xml"] = strToU8(
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
        );
    });
    const result = await f.summarize();
    assert.equal(result.success, false);
    assert.equal(result.error.code, "YPSCAN_MANUAL_SCORE_TEMPLATE");
    assert.equal(result.delivery, undefined);
  });
}

test("douyin 综合得分 blends relevance with batch cost-effectiveness and resorts", async (t) => {
  const f = await fixture(t, { count: 3, quantityTotal: 3 });
  f.batch([...f.ids], 3, {
    headers: [
      "平台",
      "星图ID",
      "综合得分",
      "推荐结论",
      "推荐理由",
      "植入视频-预期CPM",
      "植入视频-预期CPE",
    ],
    rows: [
      ["douyin", f.ids[0], { number: "90" }, "推荐", "a", { number: "100" }, { number: "5" }],
      ["douyin", f.ids[1], { number: "80" }, "推荐", "b", { number: "20" }, { number: "1" }],
      ["douyin", f.ids[2], { number: "95" }, "推荐", "c", { number: "500" }, { number: "50" }],
    ],
  });
  const result = await f.summarize();
  assert.equal(result.success, true, JSON.stringify(result.error));
  assert.equal(result.data.cost_effectiveness_pending_count, 0);
  const [sheet] = await readXlsxFile(result.data.file_path, { parseNumber: (value) => value });
  const body = sheet.data.slice(2);
  assert.deepEqual(
    body.map((row) => row[1]),
    [f.ids[1], f.ids[0], f.ids[2]],
  );
  assert.deepEqual(
    body.map((row) => row[2]),
    ["86", "78", "66.5"],
  );
  assert.deepEqual(
    body.map((row) => row[3]),
    ["推荐", "推荐", "推荐"],
  );
});

test("xiaohongshu 综合得分 uses the price/reach proxy and imputes missing cost data", async (t) => {
  const f = await fixture(t, { count: 4, quantityTotal: 4, platform: "xiaohongshu" });
  f.batch([...f.ids], 4, {
    headers: [
      "平台",
      "蒲公英ID",
      "综合得分",
      "推荐结论",
      "推荐理由",
      "视频笔记一口价",
      "合作_视频&图文_阅读中位数",
      "日常_视频&图文_阅读中位数",
      "合作_视频&图文_互动中位数",
      "日常_视频&图文_互动中位数",
    ],
    rows: [
      [
        "小红书",
        f.ids[0],
        { number: "90" },
        "推荐",
        "a",
        { number: "1000" },
        { number: "10000" },
        { number: "5000" },
        { number: "100" },
        { number: "50" },
      ],
      [
        "小红书",
        f.ids[1],
        { number: "80" },
        "推荐",
        "b",
        { number: "2000" },
        { number: "0" },
        { number: "20000" },
        { number: "0" },
        { number: "200" },
      ],
      [
        "小红书",
        f.ids[2],
        { number: "95" },
        "推荐",
        "c",
        { number: "3000" },
        { number: "10000" },
        { number: "1000" },
        { number: "50" },
        { number: "25" },
      ],
      ["小红书", f.ids[3], { number: "70" }, "推荐", "d", "", "", "", "", ""],
    ],
  });
  const result = await f.summarize();
  assert.equal(result.success, true, JSON.stringify(result.error));
  assert.equal(result.data.cost_effectiveness_pending_count, 1);
  const [sheet] = await readXlsxFile(result.data.file_path, { parseNumber: (value) => value });
  const body = sheet.data.slice(2);
  assert.deepEqual(
    body.map((row) => row[1]),
    [f.ids[0], f.ids[1], f.ids[3], f.ids[2]],
  );
  assert.deepEqual(
    body.map((row) => row[2]),
    ["93", "86", "79", "66.5"],
  );
});

const payload = (result) => JSON.parse(result.content[0].text);
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(
  t,
  {
    quantityTotal = 10,
    count = 30,
    platform = "douyin",
    projectName = null,
    now = () => new Date("2026-09-10T15:30:45"),
  } = {},
) {
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
    ...(projectName ? { project_name: projectName } : {}),
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
    summarizeManualScores({ requirement_id: "req" }, { workspaceDir, sourceContext, now }).then(
      payload,
    );
  return { workspaceDir, ids, sourceContext, batch, summarize };
}

test("initial summary schedules min(20, target) candidates from the gradient pool", async (t) => {
  const small = await fixture(t, { count: 40 });
  const first = await small.summarize();
  assert.equal(first.success, true);
  assert.equal(first.data.candidate_count, 30);
  assert.equal(first.data.target_count, 10);
  assert.deepEqual(first.data.next_author_ids, small.ids.slice(0, 10));
  assert.equal(first.data.next_action, "complete_next_batch");
  assert.equal(first.data.progress, undefined);
  assert.equal(first.delivery, undefined);

  const large = await fixture(t, { count: 200, quantityTotal: 30 });
  const capped = await large.summarize();
  assert.equal(capped.data.candidate_count, 60);
  assert.deepEqual(capped.data.next_author_ids, large.ids.slice(0, 20));
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
    const original = await readXlsxFile(f.sourceContext.score_files[0].file_path);
    assert.deepEqual(
      sheets.map((sheet) => sheet.sheet),
      original.map((sheet) => sheet.sheet),
    );
    assert.equal(sheets[0].data.length, 22);
    assert.deepEqual(sheets[0].data[0].slice(0, 2), ["需求ID", "req"]);
    assert.deepEqual(sheets[0].data, original[0].data);
  });
}

test("final summary is named after the requirement project name or the local timestamp", async (t) => {
  for (const platform of ["douyin", "xiaohongshu"]) {
    const named = await fixture(t, { count: 20, projectName: "天猫9月男装衬衫", platform });
    named.batch(named.ids, 1);
    const withName = await named.summarize();
    assert.equal(withName.success, true, JSON.stringify(withName.error));
    assert.equal(withName.data.file_name, "天猫9月男装衬衫-手动拓展汇总表-20260910-153045.xlsx");

    const fallback = await fixture(t, { count: 20, platform });
    fallback.batch(fallback.ids, 1);
    const unnamed = await fallback.summarize();
    assert.equal(unnamed.success, true, JSON.stringify(unnamed.error));
    assert.equal(unnamed.data.file_name, "手动拓展汇总表-20260910-153045.xlsx");
  }
});

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

test("N=20 processes two batches, deduplicates repeated scores, then stops with 10 unprocessed", async (t) => {
  const f = await fixture(t, { count: 50, quantityTotal: 20 });
  const initial = await f.summarize();
  assert.deepEqual(initial.data.next_author_ids, f.ids.slice(0, 20));

  f.batch(f.ids.slice(0, 20), 10);
  const afterFirstBatch = await f.summarize();
  assert.equal(afterFirstBatch.data.recommended_count, 10);
  assert.deepEqual(afterFirstBatch.data.next_author_ids, f.ids.slice(20, 40));

  const secondRows = f.ids
    .slice(20, 40)
    .map((id, index) => [
      "douyin",
      id,
      String(100 - index),
      index < 10 ? "推荐" : "不推荐",
      "测试依据",
    ]);
  secondRows.push(["douyin", f.ids[0], "100", "推荐", "测试依据"]);
  f.batch(f.ids.slice(20, 40), 10, { rows: secondRows });

  const result = await f.summarize();
  assert.equal(result.success, true, JSON.stringify(result.error));
  assert.equal(result.data.recommended_count, 20);
  assert.equal(result.data.scored_count, 40);
  assert.equal(result.data.unprocessed_count, 10);
  assert.equal(result.data.next_action, "deliver");
  assert.equal(result.data.stop_reason, "target_reached");
  assert.deepEqual(result.data.next_author_ids, []);
  const [sheet] = await readXlsxFile(result.data.file_path);
  assert.equal(sheet.data.slice(2).length, 40);
  assert.equal(new Set(sheet.data.slice(2).map((row) => row[1])).size, 40);

  const repeated = await f.summarize();
  assert.equal(repeated.success, true);
  assert.equal(repeated.data.file_path, result.data.file_path);
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
  assert.equal(sheets[0].data.length, 4);
});

test("zero-score rows stay out of the final workbook but not out of the returned batch", async (t) => {
  const f = await fixture(t, { count: 2, quantityTotal: 2 });
  const source = f.batch(f.ids, 1, {
    rows: [
      ["douyin", f.ids[0], "90", "推荐", "依据"],
      ["douyin", f.ids[1], "0", "不推荐", "本次未完成有效评估"],
    ],
  });
  await decorateWorkbook(source, (sheet) => {
    sheet.sheetData[0].row[0].c.push(
      { $: { r: "C1", t: "inlineStr" }, is: [{ t: ["评分数量"] }] },
      { $: { r: "D1", t: "inlineStr" }, is: [{ t: ["2"] }] },
    );
  });
  const result = await f.summarize();
  assert.equal(result.success, true);
  assert.equal(result.data.scored_count, 2);
  assert.equal(result.data.excluded_zero_score_count, 1);
  assert.equal(result.data.recommended_count, 1);
  assert.equal(result.data.pending_score_author_ids.length, 0);
  assert.equal(result.data.next_action, "deliver");
  const sheets = await readXlsxFile(result.data.file_path);
  assert.equal(sheets[0].data.length, 3);
  assert.equal(sheets[0].data[0][3], "1");
  assert.equal(sheets[0].data[2][1], f.ids[0]);
  assert.match(result.delivery.user_visible_message, /其中 1 位综合分为 0，未写入汇总表/u);
});

test("an all-zero batch never counts a recommendation or writes a workbook", async (t) => {
  const f = await fixture(t, { count: 2, quantityTotal: 2 });
  f.batch(f.ids, 0, {
    rows: [
      ["douyin", f.ids[0], "0", "推荐", "异常输入"],
      ["douyin", f.ids[1], "0", "不推荐", "本次未完成有效评估"],
    ],
  });
  const result = await f.summarize();
  assert.equal(result.success, true);
  assert.equal(result.data.scored_count, 2);
  assert.equal(result.data.excluded_zero_score_count, 2);
  assert.equal(result.data.recommended_count, 0);
  assert.equal(result.data.next_action, "deliver");
  assert.equal(result.delivery, undefined);
  assert.equal(result.data.file_path, undefined);
});

test("progress reports zero-score rows excluded from the pending batch", async (t) => {
  const f = await fixture(t, { count: 2, quantityTotal: 2 });
  f.batch(f.ids, 0, { rows: [["douyin", f.ids[0], "0", "不推荐", "本次未完成有效评估"]] });
  const result = await f.summarize();
  assert.equal(result.data.next_action, "await_scores");
  assert.equal(result.data.excluded_zero_score_count, 1);
  assert.match(result.data.progress.user_visible_message, /其中 1 人综合分为 0，不写入汇总表/u);
  assert.match(result.data.progress.user_visible_message, /还有 1 人评分缺失/u);
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

test("a reached target still waits for every successful creator in the current batch", async (t) => {
  const f = await fixture(t);
  const selected = f.ids.slice(0, 20);
  const rows = selected
    .slice(0, 19)
    .map((id, index) => ["douyin", id, "80", index < 10 ? "推荐" : "不推荐", "依据"]);
  f.batch(selected, 10, { rows });
  const result = await f.summarize();
  assert.equal(result.success, true);
  assert.equal(result.data.recommended_count, 10);
  assert.equal(result.data.target_reached, true);
  assert.equal(result.data.next_action, "await_scores");
  assert.deepEqual(result.data.pending_score_author_ids, [selected[19]]);
  assert.deepEqual(result.data.next_author_ids, []);
  assert.equal(result.data.stop_reason, null);
  assert.equal(result.delivery, undefined);
  assert.equal(result.data.progress.display_required, true);
  assert.equal(result.data.progress.is_final, false);
  assert.match(
    result.data.progress.user_visible_message,
    /当前已评分 19 人，推荐 10 人；还有 1 人评分缺失。以下仅为阶段性结果，不代表最终汇总。/u,
  );
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
  const changed = await f.summarize();
  assert.equal(changed.error.code, "YPSCAN_MANUAL_SCORE_SOURCE_CHANGED");
  // 哈希校验不过的批次不得作为“本批评分结果”交付。
  assert.equal(changed.data, undefined);
  await rm(file.file_path);
  await symlink(f.sourceContext.links_file.file_path, file.file_path);
  assert.equal((await f.summarize()).error.code, "YPSCAN_MANUAL_SCORE_SOURCE_NOT_ALLOWED");
});

test("failed summary offers only hash-verified workbooks that belong to the current requirement", async (t) => {
  const f = await fixture(t, { quantityTotal: 2 });
  const kept = f.batch([f.ids[0]], 1);
  const foreign = f.batch([f.ids[1]], 1, { requirementId: "other" });
  // 补全名单出现候选池以外的达人使汇总失败；两批评分表本身均可解析。
  f.sourceContext.completion_results.push({
    file_path: join(f.workspaceDir, "bogus.csv"),
    platform: "douyin",
    successful_author_ids: ["creator-outside-pool"],
    failed_author_ids: [],
  });
  const result = await f.summarize();
  assert.equal(result.success, false);
  assert.equal(result.error.code, "YPSCAN_MANUAL_SCORE_SOURCE_MISMATCH");
  assert.deepEqual(
    result.data.partial_delivery.batch_files.map((file) => file.local_path),
    [kept.file_path],
  );
  assert.equal(
    result.data.partial_delivery.user_visible_message,
    "以下为本批评分结果，汇总未完成。",
  );
  assert.ok(result.data.partial_delivery.batch_files[0].local_file_link.includes(kept.file_path));
  assert.equal(
    result.data.partial_delivery.batch_files.some((file) => file.local_path === foreign.file_path),
    false,
  );
});

test("modified normalized links, missing context and institutional requests fail closed", async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceContext.links_file.file_path, "changed");
  assert.equal((await f.summarize()).error.code, "YPSCAN_MANUAL_SCORE_SOURCE_CHANGED");
  f.sourceContext.business_mode = "询价机构";
  assert.equal((await f.summarize()).error.code, "YPSCAN_MANUAL_SCORE_MODE_NOT_APPLICABLE");
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
  assert.equal(sheets[0].data[2][1], id);
  assert.equal(sheets[0].data[2][4], "=1+1");
  assert.equal((await readFile(result.data.file_path)).length > 0, true);
});

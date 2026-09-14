import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";

import { saveCreatorLinks } from "../src/tools/save-creator-links.js";
import { previewFixture } from "./helpers/creator-preview-fixture.mjs";
import plugin from "../index.js";
import { fileBridge } from "../src/tools/file-bridge.js";
import { registerFlowDirectiveHooks } from "../src/hooks/register-flow-directives.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function workspaceFixture(t) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-creator-links-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  return workspaceDir;
}

function csvFixture(t, content, { workspaceDir } = {}) {
  const dir = workspaceDir ?? workspaceFixture(t);
  const path = join(dir, "provider-links.csv");
  writeFileSync(path, content);
  return { workspaceDir: dir, path };
}

test("CSV mode derives creator ids from homepage urls and keeps Provider order", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    [
      "url",
      "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
      "https://www.xiaohongshu.com/user/profile/def456",
      "https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
    ].join("\n"),
  );
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req-csv", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );

  assert.equal(result.success, true);
  assert.equal(result.data.row_count, 2);
  assert.match(result.data.file_name, /^mcn-links-req-csv-[a-f0-9]{8}\.csv$/u);
  assert.equal(
    readFileSync(result.data.file_path, "utf8"),
    "source_record_id,creator_id,url\n" +
      "1,abc123,https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123\n" +
      "2,def456,https://www.xiaohongshu.com/user/profile/def456",
  );
});

test("CSV mode passes through a three-column Provider CSV preserving source_record_id", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    [
      "source_record_id,creator_id,url",
      'src-a,abc123,https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123',
    ].join("\n"),
  );
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req-three-column", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );

  assert.equal(result.success, true);
  assert.equal(
    readFileSync(result.data.file_path, "utf8"),
    "source_record_id,creator_id,url\n" +
      "src-a,abc123,https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
  );
});

test("CSV mode accepts Douyin xingtu homepage urls", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    [
      "url",
      "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/7324533389695025215",
    ].join("\n"),
  );
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req-douyin", platform: "douyin", links_csv_path: path },
      { workspaceDir },
    ),
  );

  assert.equal(result.success, true);
  assert.match(readFileSync(result.data.file_path, "utf8"), /7324533389695025215/u);
});

test("CSV mode rejects short links that cannot be resolved to a creator id", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    ["url", "https://xhslink.com/a/abc"].join("\n"),
  );
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req-shortlink", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );

  assert.equal(result.success, false);
  assert.equal(result.error.code, "YPSCAN_CREATOR_LINKS_INVALID_ROWS");
  assert.deepEqual(result.error.details.problems, [
    { row: 1, field: "creator_id", reason: "无法从主页 url 推导 creator_id" },
  ]);
});

test("CSV mode rejects a creator_id mismatching the homepage url", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    [
      "creator_id,url",
      "other-id,https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
    ].join("\n"),
  );
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req-mismatch", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );

  assert.equal(result.success, false);
  assert.equal(result.error.code, "YPSCAN_CREATOR_LINKS_INVALID_ROWS");
  assert.deepEqual(result.error.details.problems, [
    { row: 1, field: "creator_id", reason: "creator_id 与主页 url 不匹配" },
  ]);
});

test("CSV mode rejects a missing or duplicated url column", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    ["creator_id", "abc123"].join("\n"),
  );
  const missing = payload(
    await saveCreatorLinks(
      { requirement_id: "req-no-url", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );
  assert.equal(missing.success, false);
  assert.equal(missing.error.code, "YPSCAN_CREATOR_LINKS_INVALID_CSV");
  assert.match(missing.error.message, /缺少 url 列/u);

  writeFileSync(path, ["url,url", "a,b"].join("\n"));
  const duplicated = payload(
    await saveCreatorLinks(
      { requirement_id: "req-no-url", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );
  assert.equal(duplicated.success, false);
  assert.equal(duplicated.error.code, "YPSCAN_CREATOR_LINKS_INVALID_CSV");
  assert.match(duplicated.error.message, /url 列重复/u);
});

test("CSV mode rejects unparseable CSV content", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    'url\n"unclosed',
  );
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req-bad-quote", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );

  assert.equal(result.success, false);
  assert.equal(result.error.code, "YPSCAN_CREATOR_LINKS_INVALID_CSV");
});

test("CSV mode rejects empty url cells, control characters and empty row sets", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    ["source_record_id,url", "src-a,", "src-b,https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123"].join("\n"),
  );
  const emptyCell = payload(
    await saveCreatorLinks(
      { requirement_id: "req-empty-cell", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );
  assert.equal(emptyCell.success, false);
  assert.equal(emptyCell.error.code, "YPSCAN_CREATOR_LINKS_INVALID_ROWS");
  assert.deepEqual(emptyCell.error.details.problems, [
    { row: 1, field: "url", reason: "url 不能为空" },
  ]);

  writeFileSync(
    path,
    "source_record_id,url\nsrc\u0001a,https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
  );
  const control = payload(
    await saveCreatorLinks(
      { requirement_id: "req-empty-cell", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );
  assert.equal(control.success, false);
  assert.equal(control.error.code, "YPSCAN_CREATOR_LINKS_INVALID_ROWS");
  assert.deepEqual(control.error.details.problems, [{ row: 1, reason: "包含控制字符" }]);

  writeFileSync(path, "url");
  const headerOnly = payload(
    await saveCreatorLinks(
      { requirement_id: "req-empty-cell", platform: "xiaohongshu", links_csv_path: path },
      { workspaceDir },
    ),
  );
  assert.equal(headerOnly.success, false);
  assert.equal(headerOnly.error.code, "YPSCAN_CREATOR_LINKS_EMPTY");
});

test("CSV mode requires platform and rejects the removed rows input", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    "url\nhttps://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
  );
  const noPlatform = payload(
    await saveCreatorLinks(
      { requirement_id: "req-no-platform", links_csv_path: path },
      { workspaceDir },
    ),
  );
  assert.equal(noPlatform.success, false);
  assert.equal(noPlatform.error.code, "YPSCAN_CREATOR_LINKS_INVALID_INPUT");

  const legacyRows = payload(
    await saveCreatorLinks(
      {
        requirement_id: "req-legacy-rows",
        platform: "xiaohongshu",
        rows: [{ creator_id: "c1", url: "https://example.com/1" }],
      },
      { workspaceDir },
    ),
  );
  assert.equal(legacyRows.success, false);
  assert.equal(legacyRows.error.code, "YPSCAN_CREATOR_LINKS_INVALID_INPUT");
});

test("CSV mode refuses files outside the workspace or symbolic links", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    "url\nhttps://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
  );
  const outside = join(tmpdir(), `ypscan-outside-${Date.now()}.csv`);
  writeFileSync(outside, "url\nhttps://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123");
  t.after(() => rmSync(outside, { force: true }));
  const outsideResult = payload(
    await saveCreatorLinks(
      { requirement_id: "req-outside", platform: "xiaohongshu", links_csv_path: outside },
      { workspaceDir },
    ),
  );
  assert.equal(outsideResult.success, false);
  assert.equal(outsideResult.error.code, "YPSCAN_CREATOR_LINKS_SOURCE_NOT_ALLOWED");

  const linkPath = join(workspaceDir, "linked.csv");
  symlinkSync(path, linkPath);
  const symlinkResult = payload(
    await saveCreatorLinks(
      { requirement_id: "req-outside", platform: "xiaohongshu", links_csv_path: linkPath },
      { workspaceDir },
    ),
  );
  assert.equal(symlinkResult.success, false);
  assert.equal(symlinkResult.error.code, "YPSCAN_CREATOR_LINKS_SOURCE_NOT_ALLOWED");
});

test("CSV mode requires a registered artifact path when the source gate is provided", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    "url\nhttps://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
  );
  const params = {
    requirement_id: "req-gate",
    platform: "xiaohongshu",
    links_csv_path: path,
  };
  const foreign = payload(
    await saveCreatorLinks(params, {
      workspaceDir,
      allowedLinksCsvs: (id) => (id === "req-gate" ? ["/other/links.csv"] : []),
    }),
  );
  assert.equal(foreign.success, false);
  assert.equal(foreign.error.code, "YPSCAN_CREATOR_LINKS_SOURCE_NOT_ALLOWED");

  const registered = payload(
    await saveCreatorLinks(params, {
      workspaceDir,
      allowedLinksCsvs: (id) => (id === "req-gate" ? [normalize(path)] : []),
    }),
  );
  assert.equal(registered.success, true);
});

test("CSV mode is idempotent for identical content", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    "url\nhttps://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
  );
  const params = {
    requirement_id: "req-idempotent",
    platform: "xiaohongshu",
    links_csv_path: path,
  };
  const first = payload(await saveCreatorLinks(params, { workspaceDir }));
  const second = payload(await saveCreatorLinks(params, { workspaceDir }));

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(first.data.file_path, second.data.file_path);
});

test("CSV mode refuses an existing symbolic link at the output path", async (t) => {
  const { workspaceDir, path } = csvFixture(
    t,
    "url\nhttps://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/abc123",
  );
  const params = {
    requirement_id: "req-symlink",
    platform: "xiaohongshu",
    links_csv_path: path,
  };
  const first = payload(await saveCreatorLinks(params, { workspaceDir }));
  const outsidePath = join(workspaceDir, "outside.csv");
  writeFileSync(outsidePath, "outside");
  unlinkSync(first.data.file_path);
  symlinkSync(outsidePath, first.data.file_path);

  const result = payload(await saveCreatorLinks(params, { workspaceDir }));
  assert.equal(result.success, false);
  assert.equal(result.error.code, "YPSCAN_CREATOR_LINKS_WRITE_FAILED");
  assert.equal(readFileSync(outsidePath, "utf8"), "outside");
});

test("saved preview workbook yields links and bounded original fields without text read", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const source = previewFixture(workspaceDir);
  const result = payload(
    await saveCreatorLinks(
      {
        requirement_id: "req-preview",
        platform: "xiaohongshu",
        preview_file_path: source.file_path,
      },
      { workspaceDir, allowedPreviews: (id) => (id === "req-preview" ? [source] : []) },
    ),
  );
  assert.equal(result.success, true);
  assert.equal(result.data.row_count, 3);
  assert.equal(result.data.preview.header_row, 5);
  assert.equal(result.data.preview.records[0].cells[5], "3.84");
  assert.equal(result.data.preview.records[1].cells[7], "机构乙");
  assert.equal(result.data.preview.records[2].cells[8], "168000");
  assert.match(
    readFileSync(result.data.file_path, "utf8"),
    /\n,000000000000000000000001,https:\/\//u,
  );
  assert.deepEqual(readFileSync(source.file_path), source.buffer);
});

test("preview input rejects foreign requirements, changed content, and mixed input modes", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const source = previewFixture(workspaceDir);
  const params = {
    requirement_id: "req-preview",
    platform: "xiaohongshu",
    preview_file_path: source.file_path,
  };
  const options = { workspaceDir, allowedPreviews: (id) => (id === "req-preview" ? [source] : []) };
  assert.equal(
    payload(await saveCreatorLinks({ ...params, requirement_id: "other" }, options)).error.code,
    "YPSCAN_CREATOR_PREVIEW_SOURCE_NOT_ALLOWED",
  );
  assert.equal(
    payload(
      await saveCreatorLinks(
        { ...params, links_csv_path: join(workspaceDir, "other.csv") },
        options,
      ),
    ).error.code,
    "YPSCAN_CREATOR_LINKS_INVALID_INPUT",
  );
  writeFileSync(source.file_path, "changed");
  assert.equal(
    payload(await saveCreatorLinks(params, options)).error.code,
    "YPSCAN_CREATOR_PREVIEW_SOURCE_CHANGED",
  );
});

test("preview rejects invalid headers and empty data instead of guessing IDs", async (t) => {
  const workspaceDir = workspaceFixture(t);
  for (const rows of [
    [
      ["昵称", "粉丝数（万）"],
      ["达人", "50"],
    ],
    [["蒲公英ID", "小红书主页"]],
    [
      ["蒲公英ID", "kw_uid", "小红书主页"],
      ["c1", "c2", "https://www.xiaohongshu.com/user/profile/c1"],
    ],
  ]) {
    const source = previewFixture(workspaceDir, { rows });
    const result = payload(
      await saveCreatorLinks(
        { requirement_id: "req", platform: "xiaohongshu", preview_file_path: source.file_path },
        { workspaceDir, allowedPreviews: () => [source] },
      ),
    );
    assert.equal(result.success, false);
    assert.match(result.error.code, /YPSCAN_CREATOR_PREVIEW_(HEADERS|EMPTY)/u);
  }
});

test("preview reports duplicates and keeps full-length Douyin IDs as text", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const row = [
    "7324533389695025215",
    "https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/7324533389695025215",
  ];
  const source = previewFixture(workspaceDir, { rows: [["星图ID", "星图主页"], row, row] });
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req", platform: "douyin", preview_file_path: source.file_path },
      { workspaceDir, allowedPreviews: () => [source] },
    ),
  );
  assert.equal(result.success, true);
  assert.equal(result.data.row_count, 1);
  assert.deepEqual(result.data.preview.duplicate_creator_ids, [row[0]]);
  assert.equal(result.data.preview.total_row_count, 2);
  assert.match(readFileSync(result.data.file_path, "utf8"), /7324533389695025215/u);
});

test("preview isolates invalid institution rows and preserves valid rows", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const source = previewFixture(workspaceDir, {
    rows: [
      ["蒲公英ID", "小红书主页", "所属机构", "source_record_id"],
      ["c1", "https://www.xiaohongshu.com/user/profile/c2", "机构甲", "bad"],
      ["c2", "https://www.xiaohongshu.com/user/profile/c2", "机构乙", "good"],
      ["", "", "机构丙", "missing"],
    ],
  });
  const original = readFileSync(source.file_path);
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req", platform: "xiaohongshu", preview_file_path: source.file_path },
      { workspaceDir, allowedPreviews: () => [source] },
    ),
  );
  assert.equal(result.success, true);
  assert.equal(result.data.row_count, 1);
  assert.equal(result.data.preview.total_row_count, 3);
  assert.equal(result.data.preview.excluded_row_count, 2);
  assert.deepEqual(
    result.data.preview.problems.map(({ row, institution }) => ({ row, institution })),
    [
      { row: 2, institution: "机构甲" },
      { row: 4, institution: "机构丙" },
    ],
  );
  assert.equal(
    readFileSync(result.data.file_path, "utf8"),
    "source_record_id,creator_id,url\ngood,c2,https://www.xiaohongshu.com/user/profile/c2",
  );
  assert.deepEqual(readFileSync(source.file_path), original);
  const hooks = new Map();
  registerFlowDirectiveHooks({ on: (name, handler) => hooks.set(name, handler) });
  const directed = hooks.get("tool_result_persist")({
    toolName: "ypscan_save_creator_links",
    params: { requirement_id: "req", platform: "xiaohongshu", preview_file_path: source.file_path },
    message: { content: [{ type: "text", text: JSON.stringify(result) }] },
  });
  const text = JSON.stringify(directed);
  assert.match(text, /正确行继续补全和生成评分表/u);
  assert.match(text, /PREVIEW_ROW_WARNINGS=/u);
  assert.match(text, /机构甲/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("preview rejects mismatched homepage identities and corrupt files", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const source = previewFixture(workspaceDir, {
    rows: [
      ["蒲公英ID", "小红书主页"],
      ["c1", "https://www.xiaohongshu.com/user/profile/c2"],
    ],
  });
  const params = {
    requirement_id: "req",
    platform: "xiaohongshu",
    preview_file_path: source.file_path,
  };
  assert.equal(
    payload(await saveCreatorLinks(params, { workspaceDir, allowedPreviews: () => [source] })).error
      .code,
    "YPSCAN_CREATOR_PREVIEW_ROWS",
  );
  const { createHash } = await import("node:crypto");
  writeFileSync(source.file_path, "not an xlsx");
  source.sha256 = createHash("sha256").update("not an xlsx").digest("hex");
  assert.equal(
    payload(await saveCreatorLinks(params, { workspaceDir, allowedPreviews: () => [source] })).error
      .code,
    "YPSCAN_CREATOR_PREVIEW_READ_FAILED",
  );
});

test("preview supports Provider-style empty inline string cells", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const source = previewFixture(workspaceDir, {
    rows: [
      ["蒲公英ID", "小红书主页", "博主人设"],
      ["c1", "https://www.xiaohongshu.com/user/profile/c1", null],
    ],
  });
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req", platform: "xiaohongshu", preview_file_path: source.file_path },
      { workspaceDir, allowedPreviews: () => [source] },
    ),
  );
  assert.equal(result.success, true);
  assert.equal(result.data.row_count, 1);
  assert.equal(result.data.preview.records[0].cells[2], "");
});

test("numeric XLSX IDs keep exact digits before becoming links", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const id = "7324533389695025215";
  const source = previewFixture(workspaceDir, {
    rows: [
      ["星图ID", "星图主页"],
      [{ number: id }, `https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/${id}`],
    ],
  });
  const result = payload(
    await saveCreatorLinks(
      { requirement_id: "req", platform: "douyin", preview_file_path: source.file_path },
      { workspaceDir, allowedPreviews: () => [source] },
    ),
  );
  assert.equal(result.success, true);
  assert.equal(result.data.preview.records[0].cells[0], id);
});

test("preview-derived links pass source checks for manual-source upload with mocked OSS", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const source = previewFixture(workspaceDir);
  const hooks = new Map();
  const runtime = registerFlowDirectiveHooks({
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
  runtime.recordSavedCsvArtifact("mcn_creator_preview", "req", { details: source }, workspaceDir);
  const linked = payload(
    await saveCreatorLinks(
      { requirement_id: "req", platform: "xiaohongshu", preview_file_path: source.file_path },
      { workspaceDir, allowedPreviews: runtime.previewFilesFor },
    ),
  );
  runtime.recordLinksCsv("req", linked.data.file_path, workspaceDir);
  const completion = join(workspaceDir, "completion.csv");
  writeFileSync(completion, "creator_id,nickname\n000000000000000000000001,creator-a");
  const params = {
    requirement_id: "req",
    platform: "xiaohongshu",
    flow: "manual_source",
    links_csv_path: linked.data.file_path,
    completion_csv_paths: [completion],
  };
  let uploads = 0;
  const result = payload(
    await fileBridge(params, {
      workspaceDir,
      bundled: null,
      pluginConfig: {
        fileBridgeOss: {
          accessKeyId: "test-ak",
          accessKeySecret: "test-sk",
          region: "oss-cn-shanghai",
          bucket: "test-bucket",
          objectPrefix: "test",
        },
      },
      allowedLinksCsvPaths: runtime.linksCsvPathsFor,
      allowedCompletionCsvPaths: () => [completion],
      createClient: () => ({
        put: async () => {
          uploads += 1;
          return {};
        },
      }),
      fetchImpl: async () => new Response("ok", { status: 200 }),
    }),
  );
  assert.equal(result.success, true);
  assert.equal(uploads, 1);
  assert.equal(result.data.data_row_count, 1);
  assert.equal(result.data.missing_creator_ids.length, 2);
  assert.match(result.data.csv_file_path, /^https:\/\//u);
});

test("handoff url-only Provider links CSV normalizes and merges without file_bridge failure", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const ids = ["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccc"];
  const rawPath = join(workspaceDir, "provider-links.csv");
  writeFileSync(
    rawPath,
    [
      "url",
      ...ids.map(
        (id) => `https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/${id}`,
      ),
    ].join("\n"),
  );
  const hooks = new Map();
  const runtime = registerFlowDirectiveHooks({
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
  runtime.recordSavedCsvArtifact("manual_creator_links", "req-trace", { details: { file_path: rawPath } }, workspaceDir);
  const linked = payload(
    await saveCreatorLinks(
      {
        requirement_id: "req-trace",
        platform: "xiaohongshu",
        links_csv_path: rawPath,
      },
      { workspaceDir, allowedLinksCsvs: runtime.linksCsvPathsFor },
    ),
  );
  assert.equal(linked.success, true);
  assert.equal(linked.data.row_count, 3);
  runtime.recordLinksCsv("req-trace", linked.data.file_path, workspaceDir);

  const completion = join(workspaceDir, "completion.csv");
  writeFileSync(
    completion,
    [
      "creator_id,nickname",
      ...ids.map((id, index) => `${id},达人${index + 1}`),
    ].join("\n"),
  );
  const result = payload(
    await fileBridge(
      {
        requirement_id: "req-trace",
        platform: "xiaohongshu",
        flow: "mcn_complete_only",
        links_csv_path: linked.data.file_path,
        completion_csv_paths: [completion],
      },
      { workspaceDir, allowedLinksCsvPaths: runtime.linksCsvPathsFor },
    ),
  );
  assert.equal(result.success, true);
  assert.equal(result.data.data_row_count, 3);
  assert.deepEqual(result.data.missing_creator_ids, []);
  assert.match(readFileSync(result.data.file_path, "utf8"), /source_record_id,creator_id,url,nickname/u);
});

test("registered save -> preview read -> merge works and reset requires re-registration", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const source = previewFixture(workspaceDir);
  const tools = new Map();
  const hooks = new Map();
  plugin.register({
    fetch: async () => new Response(source.buffer),
    registerTool(tool) {
      const resolved = typeof tool === "function" ? tool({ workspaceDir }) : tool;
      tools.set(resolved.name, resolved);
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
  const save = tools.get("ypscan_save_artifact");
  const linksTool = tools.get("ypscan_save_creator_links");
  const saveParams = {
    artifact_id: "req-flow",
    artifact_kind: "mcn_creator_preview",
    file_url: "https://eshypdata.com/saved-preview.xlsx",
  };
  const saved = payload(await save.execute("save", saveParams));
  assert.equal(saved.success, true);
  const params = {
    requirement_id: "req-flow",
    platform: "xiaohongshu",
    preview_file_path: saved.data.file_path,
  };
  const linked = payload(await linksTool.execute("links", params));
  assert.equal(linked.success, true);
  const completion = join(workspaceDir, "completion.csv");
  writeFileSync(
    completion,
    "creator_id,nickname\n000000000000000000000001,creator-a\n000000000000000000000002,creator-b\n000000000000000000000003,creator-c",
  );
  const bridge = payload(
    await fileBridge(
      {
        requirement_id: "req-flow",
        platform: "xiaohongshu",
        flow: "mcn_complete_only",
        links_csv_path: linked.data.file_path,
        completion_csv_paths: [completion],
      },
      { workspaceDir },
    ),
  );
  assert.equal(bridge.success, true);
  assert.equal(bridge.data.data_row_count, 3);
  assert.match(readFileSync(bridge.data.file_path, "utf8"), /\n,000000000000000000000001,/u);
  await hooks.get("gateway_stop")();
  assert.equal(
    payload(await linksTool.execute("after-reset", params)).error.code,
    "YPSCAN_CREATOR_PREVIEW_SOURCE_NOT_ALLOWED",
  );
  assert.equal(payload(await save.execute("save-again", saveParams)).success, true);
  assert.equal(payload(await linksTool.execute("links-again", params)).success, true);
});

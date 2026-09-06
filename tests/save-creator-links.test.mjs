import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("saveCreatorLinks writes a deduplicated source_record_id,creator_id,url CSV", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const result = await saveCreatorLinks(
    {
      requirement_id: "req-links",
      rows: [
        { source_record_id: "s1", creator_id: "c1", url: "https://example.com/1" },
        { creator_id: "c2", url: "https://example.com/2" },
        { source_record_id: "s3", creator_id: "c1", url: "https://example.com/1" },
      ],
    },
    { workspaceDir },
  );

  const parsed = payload(result);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.row_count, 2);
  assert.match(parsed.data.file_name, /^mcn-links-req-links-[a-f0-9]{8}\.csv$/u);
  assert.match(parsed.delivery.local_file_link, /mcn-links-req-links-/u);
  assert.equal(
    readFileSync(parsed.data.file_path, "utf8"),
    "source_record_id,creator_id,url\ns1,c1,https://example.com/1\n2,c2,https://example.com/2",
  );
});

test("saveCreatorLinks rejects rows with a missing creator_id or url", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const result = await saveCreatorLinks(
    {
      requirement_id: "req-bad-rows",
      rows: [
        { creator_id: "c1", url: "https://example.com/1" },
        { creator_id: "", url: "https://example.com/2" },
        { creator_id: "c3", url: "" },
      ],
    },
    { workspaceDir },
  );

  const parsed = payload(result);
  assert.equal(parsed.success, false);
  assert.equal(parsed.error.code, "YPSCAN_CREATOR_LINKS_INVALID_ROWS");
  assert.equal(parsed.error.details.problems.length, 2);
});

test("saveCreatorLinks rejects an empty row set", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const result = await saveCreatorLinks(
    { requirement_id: "req-empty", rows: [] },
    { workspaceDir },
  );

  const parsed = payload(result);
  assert.equal(parsed.success, false);
  assert.equal(parsed.error.code, "YPSCAN_CREATOR_LINKS_INVALID_INPUT");
});

test("saveCreatorLinks is idempotent for identical content", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const params = {
    requirement_id: "req-idempotent",
    rows: [{ creator_id: "c1", url: "https://example.com/1" }],
  };
  const first = payload(await saveCreatorLinks(params, { workspaceDir }));
  const second = payload(await saveCreatorLinks(params, { workspaceDir }));

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(first.data.file_path, second.data.file_path);
});

test("saveCreatorLinks refuses an existing symbolic link", async (t) => {
  const workspaceDir = workspaceFixture(t);
  const params = {
    requirement_id: "req-symlink",
    rows: [{ creator_id: "c1", url: "https://example.com/1" }],
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
        { ...params, rows: [{ creator_id: "c", url: "https://example.com" }] },
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

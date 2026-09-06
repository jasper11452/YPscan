import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fileBridge, loadFileBridgeConfig } from "../src/tools/file-bridge.js";

test("loadFileBridgeConfig does not implicitly consume host environment credentials", () => {
  const moduleUrl = new URL("../src/tools/file-bridge.js", import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { loadFileBridgeConfig } = await import(${JSON.stringify(moduleUrl)});
    const result = await loadFileBridgeConfig({ bundled: null });
    console.log(JSON.stringify({ ok: result.ok }));
  `,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, AccessKeyId: "test-host-ak", AccessKeySecret: "test-host-sk" },
    },
  );
  assert.deepEqual(JSON.parse(output), { ok: false });
});
import { mergeCreatorCsvFiles } from "../src/tools/merge-creator-csv.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function createMergeFixture(t, { requirementId, flow = "manual_source", rowCount = 2 } = {}) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-file-bridge-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const linksCsvPath = join(workspaceDir, "links.csv");
  const completionCsvPath = join(workspaceDir, "completion.csv");
  const ids = Array.from({ length: rowCount }, (_, index) => `creator-${index + 1}`);
  writeFileSync(
    linksCsvPath,
    [
      "source_record_id,creator_id,url",
      ...ids.map((id, index) => `source-${index + 1},${id},https://example.com/${index + 1}`),
    ].join("\n"),
  );
  writeFileSync(
    completionCsvPath,
    ["creator_id,nickname", ...ids.map((id, index) => `${id},达人${index + 1}`)].join("\n"),
  );
  return {
    workspaceDir,
    params: {
      requirement_id: requirementId ?? "req-fixture",
      platform: "douyin",
      flow,
      links_csv_path: linksCsvPath,
      completion_csv_paths: [completionCsvPath],
    },
  };
}

test("fileBridge merges completion batches and returns a local result without uploading", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-file-bridge-merge-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const linksCsvPath = join(workspaceDir, "links.csv");
  const firstBatchPath = join(workspaceDir, "batch-1.csv");
  const secondBatchPath = join(workspaceDir, "batch-2.csv");
  writeFileSync(
    linksCsvPath,
    "source_record_id,creator_id,url\nsource-2,creator-2,https://example.com/2\nsource-1,creator-1,https://example.com/1\n",
  );
  writeFileSync(firstBatchPath, "author_id,nickname\ncreator-1,达人一\n");
  writeFileSync(secondBatchPath, "kw_uid,nickname\ncreator-2,达人二\n");
  let createClientCalls = 0;

  const result = await fileBridge(
    {
      requirement_id: "req-local-only",
      platform: "douyin",
      flow: "mcn_complete_only",
      links_csv_path: linksCsvPath,
      completion_csv_paths: [firstBatchPath, secondBatchPath],
    },
    {
      workspaceDir,
      env: {},
      createClient: () => {
        createClientCalls += 1;
        return {};
      },
    },
  );

  const parsed = payload(result);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.csv_file_path, undefined);
  assert.equal(parsed.data.data_row_count, 2);
  assert.deepEqual(parsed.data.matched_creator_ids, ["creator-2", "creator-1"]);
  assert.equal(createClientCalls, 0);
  assert.match(parsed.delivery.local_file_link, /mcn-complete-douyin-req-local-only-/u);
  assert.equal(
    readFileSync(parsed.data.file_path, "utf8"),
    "source_record_id,creator_id,url,nickname\nsource-2,creator-2,https://example.com/2,达人二\nsource-1,creator-1,https://example.com/1,达人一",
  );
});

test("merge recognizes the host native completion CSV 请求kw_uid id column", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-file-bridge-host-header-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const linksCsvPath = join(workspaceDir, "links.csv");
  const completionCsvPath = join(workspaceDir, "completion.csv");
  writeFileSync(
    linksCsvPath,
    "source_record_id,creator_id,url\nsource-1,creator-1,https://example.com/1\n",
  );
  writeFileSync(completionCsvPath, "请求kw_uid,用户ID,nickname\ncreator-1,user-red-id,达人一\n");
  const merged = await mergeCreatorCsvFiles(
    {
      requirement_id: "req-host-header",
      platform: "xiaohongshu",
      flow: "manual_source",
      links_csv_path: linksCsvPath,
      completion_csv_paths: [completionCsvPath],
    },
    { workspaceDir },
  );
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.details.matched_creator_ids, ["creator-1"]);
  assert.deepEqual(merged.details.missing_creator_ids, []);
  assert.equal(
    readFileSync(merged.details.file_path, "utf8"),
    "source_record_id,creator_id,url,用户ID,nickname\nsource-1,creator-1,https://example.com/1,user-red-id,达人一",
  );
});

test("loadFileBridgeConfig prefers pluginConfig over explicitly injected env", async () => {
  const result = await loadFileBridgeConfig({
    bundled: null,
    pluginConfig: {
      fileBridgeOss: {
        accessKeyId: "plugin-ak",
        accessKeySecret: "plugin-sk",
        region: "plugin-region",
        bucket: "plugin-bucket",
        objectPrefix: "action",
      },
    },
    env: {
      AccessKeyId: "env-ak",
      AccessKeySecret: "env-sk",
      Region: "env-region",
      Bucket: "env-bucket",
      Object: "env-prefix/",
    },
  });

  assert.deepEqual(result, {
    ok: true,
    config: {
      accessKeyId: "plugin-ak",
      accessKeySecret: "plugin-sk",
      region: "plugin-region",
      bucket: "plugin-bucket",
      objectPrefix: "action/",
    },
  });
});

test("loadFileBridgeConfig accepts explicitly injected env when plugin config is absent", async () => {
  const result = await loadFileBridgeConfig({
    bundled: null,
    env: {
      AccessKeyId: "env-ak",
      AccessKeySecret: "env-sk",
      Region: "oss-cn-shanghai",
      Bucket: "ypmisc",
      Object: "action/",
    },
  });

  assert.deepEqual(result, {
    ok: true,
    config: {
      accessKeyId: "env-ak",
      accessKeySecret: "env-sk",
      region: "oss-cn-shanghai",
      bucket: "ypmisc",
      objectPrefix: "action/",
    },
  });
});

test("fileBridge rejects unreadable source CSV paths", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-file-bridge-missing-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const result = await fileBridge(
    {
      requirement_id: "req-read-failed",
      platform: "douyin",
      flow: "manual_source",
      links_csv_path: join(workspaceDir, "missing-links.csv"),
      completion_csv_paths: [join(workspaceDir, "missing-completion.csv")],
    },
    {
      workspaceDir,
    },
  );

  assert.equal(payload(result).error.code, "YPSCAN_CREATOR_CSV_MERGE_FAILED");
});

test("fileBridge rejects invalid source CSV content", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-invalid-csv" });
  writeFileSync(fixture.params.links_csv_path, 'source_record_id,creator_id,url\nsource-1,"bad');
  const result = await fileBridge(fixture.params, {
    workspaceDir: fixture.workspaceDir,
  });

  assert.equal(payload(result).error.code, "YPSCAN_CREATOR_CSV_MERGE_FAILED");
});

test("mergeCreatorCsvFiles refuses an existing symbolic link", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-merge-symlink" });
  const first = await mergeCreatorCsvFiles(fixture.params, { workspaceDir: fixture.workspaceDir });
  assert.equal(first.ok, true);
  const outsidePath = join(fixture.workspaceDir, "outside.csv");
  writeFileSync(outsidePath, "outside");
  unlinkSync(first.details.file_path);
  symlinkSync(outsidePath, first.details.file_path);

  const result = await mergeCreatorCsvFiles(fixture.params, { workspaceDir: fixture.workspaceDir });
  assert.equal(result.ok, false);
  assert.equal(result.code, "YPSCAN_CREATOR_CSV_MERGE_FAILED");
  assert.equal(readFileSync(outsidePath, "utf8"), "outside");
});

test("fileBridge returns the empty merged CSV without attempting upload", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-empty", rowCount: 1 });
  writeFileSync(
    fixture.params.completion_csv_paths[0],
    "creator_id,nickname\ncreator-other,其他达人",
  );
  let createClientCalls = 0;
  const result = await fileBridge(fixture.params, {
    workspaceDir: fixture.workspaceDir,
    createClient: () => {
      createClientCalls += 1;
      return {};
    },
  });

  const parsed = payload(result);
  assert.equal(parsed.error.code, "YPSCAN_FILE_BRIDGE_EMPTY");
  assert.equal(createClientCalls, 0);
  assert.match(parsed.delivery.local_file_link, /manual-source-douyin-req-empty-/u);
});

test("fileBridge keeps merged CSV files larger than 500 rows local", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-too-large", rowCount: 501 });
  let createClientCalls = 0;
  const result = await fileBridge(fixture.params, {
    workspaceDir: fixture.workspaceDir,
    createClient: () => {
      createClientCalls += 1;
      return {};
    },
  });

  const parsed = payload(result);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.data_row_count, 501);
  assert.equal(parsed.data.upload_skipped, "row_limit_exceeded");
  assert.equal(parsed.data.csv_file_path, undefined);
  assert.equal(createClientCalls, 0);
  assert.match(parsed.delivery.local_file_link, /manual-source-douyin-req-too-large-/u);
});

test("fileBridge uploads the merged CSV and returns an unsigned public URL", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-upload-success" });
  const csvText =
    "source_record_id,creator_id,url,nickname\n" +
    "source-1,creator-1,https://example.com/1,达人1\n" +
    "source-2,creator-2,https://example.com/2,达人2";
  const sha256 = createHash("sha256").update(csvText).digest("hex");
  /** @type {{ key?: string, body?: Buffer, options?: { headers?: Record<string, string> } }} */
  const captured = {};

  const result = await fileBridge(fixture.params, {
    workspaceDir: fixture.workspaceDir,
    bundled: null,
    pluginConfig: {
      fileBridgeOss: {
        accessKeyId: "ak",
        accessKeySecret: "sk",
        region: "oss-cn-shanghai",
        bucket: "ypmisc",
        objectPrefix: "action/",
      },
    },
    createClient: () => ({
      put: async (key, body, options) => {
        captured.key = key;
        captured.body = body;
        captured.options = options;
        return { res: { statusCode: 200 } };
      },
    }),
    fetchImpl: async () => new Response(null, { status: 200 }),
    retryDelaysMs: [],
    sleepImpl: async () => {},
  });

  const parsed = payload(result);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.object_key, `action/manual_source/req-upload-success/${sha256}.csv`);
  assert.equal(
    parsed.data.csv_file_path,
    `https://ypmisc.oss-cn-shanghai.aliyuncs.com/action/manual_source/req-upload-success/${sha256}.csv`,
  );
  assert.equal(parsed.data.sha256, sha256);
  assert.equal(parsed.data.data_row_count, 2);
  assert.match(parsed.delivery.local_file_link, /manual-source-douyin-req-upload-success-/u);
  assert.equal(captured.key, `action/manual_source/req-upload-success/${sha256}.csv`);
  assert.equal(String(captured.body), csvText);
  assert.deepEqual(captured.options, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "x-oss-object-acl": "public-read",
    },
  });
});

test("fileBridge preserves the local result when the uploaded object is not publicly readable", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-private-object" });
  const result = await fileBridge(fixture.params, {
    workspaceDir: fixture.workspaceDir,
    bundled: null,
    pluginConfig: {
      fileBridgeOss: {
        accessKeyId: "ak",
        accessKeySecret: "sk",
        region: "oss-cn-shanghai",
        bucket: "ypmisc",
        objectPrefix: "action/",
      },
    },
    createClient: () => ({
      put: async () => ({ res: { statusCode: 200 } }),
    }),
    fetchImpl: async (_url, options) =>
      new Response(options?.method === "HEAD" ? null : "forbidden", { status: 403 }),
    retryDelaysMs: [],
    sleepImpl: async () => {},
  });

  const parsed = payload(result);
  assert.equal(parsed.error.code, "YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE");
  assert.match(parsed.delivery.local_file_link, /manual-source-douyin-req-private-object-/u);
});

test("fileBridge rejects non-csv source paths before merging", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-non-csv" });
  const result = await fileBridge(
    { ...fixture.params, completion_csv_paths: [join(fixture.workspaceDir, "completion.txt")] },
    { workspaceDir: fixture.workspaceDir, bundled: null },
  );

  const parsed = payload(result);
  assert.equal(parsed.error.code, "YPSCAN_FILE_BRIDGE_INVALID_INPUT");
  assert.match(parsed.error.message, /\.csv/u);
  assert.equal(parsed.error.details.invalid_paths.length, 1);
});

test("fileBridge blocks upload when completion CSVs are not from YP Action", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-not-tracked" });
  let createClientCalls = 0;
  const result = await fileBridge(fixture.params, {
    workspaceDir: fixture.workspaceDir,
    bundled: null,
    pluginConfig: { fileBridgeOss: { accessKeyId: "ak", accessKeySecret: "sk" } },
    allowedCompletionCsvPaths: () => [],
    createClient: () => {
      createClientCalls += 1;
      return {};
    },
  });

  const parsed = payload(result);
  assert.equal(parsed.error.code, "YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED");
  assert.equal(createClientCalls, 0);
  assert.match(parsed.delivery.local_file_link, /manual-source-douyin-req-not-tracked-/u);
});

test("fileBridge blocks upload when the links CSV is not the saved artifact", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-links-blocked" });
  const result = await fileBridge(fixture.params, {
    workspaceDir: fixture.workspaceDir,
    bundled: null,
    pluginConfig: { fileBridgeOss: { accessKeyId: "ak", accessKeySecret: "sk" } },
    allowedLinksCsvPaths: () => [],
    allowedCompletionCsvPaths: () => fixture.params.completion_csv_paths,
  });

  assert.equal(payload(result).error.code, "YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED");
});

test("fileBridge uploads when both sources match the recorded allowlists", async (t) => {
  const fixture = createMergeFixture(t, { requirementId: "req-allowed" });
  let putCalls = 0;
  const result = await fileBridge(fixture.params, {
    workspaceDir: fixture.workspaceDir,
    bundled: null,
    pluginConfig: { fileBridgeOss: { accessKeyId: "ak", accessKeySecret: "sk" } },
    allowedLinksCsvPaths: (id) => (id === "req-allowed" ? [fixture.params.links_csv_path] : []),
    allowedCompletionCsvPaths: (id) =>
      id === "req-allowed" ? fixture.params.completion_csv_paths : [],
    createClient: () => ({
      put: async () => {
        putCalls += 1;
        return { res: { statusCode: 200 } };
      },
    }),
    fetchImpl: async () => new Response(null, { status: 200 }),
    retryDelaysMs: [],
    sleepImpl: async () => {},
  });

  const parsed = payload(result);
  assert.equal(parsed.success, true);
  assert.equal(putCalls, 1);
  assert.match(parsed.data.object_key, /^action\/manual_source\/req-allowed\//u);
  assert.match(
    parsed.data.csv_file_path,
    /^https:\/\/ypmisc\.oss-cn-shanghai\.aliyuncs\.com\/action\//u,
  );
});

test("loadFileBridgeConfig fills built-in non-sensitive defaults from keys alone", async () => {
  const result = await loadFileBridgeConfig({
    bundled: { accessKeyId: "bundle-ak", accessKeySecret: "bundle-sk" },
    env: {},
  });

  assert.deepEqual(result, {
    ok: true,
    config: {
      accessKeyId: "bundle-ak",
      accessKeySecret: "bundle-sk",
      region: "oss-cn-shanghai",
      bucket: "ypmisc",
      objectPrefix: "action/",
    },
  });
});

test("loadFileBridgeConfig prefers bundled credentials over explicitly injected env", async () => {
  const result = await loadFileBridgeConfig({
    bundled: {
      accessKeyId: "bundle-ak",
      accessKeySecret: "bundle-sk",
      region: "bundle-region",
    },
    env: {
      AccessKeyId: "env-ak",
      AccessKeySecret: "env-sk",
      Region: "env-region",
      Bucket: "env-bucket",
      Object: "env/",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.config.accessKeyId, "bundle-ak");
  assert.equal(result.config.region, "bundle-region");
  assert.equal(result.config.bucket, "env-bucket");
  assert.equal(result.config.objectPrefix, "env/");
});

test("loadFileBridgeConfig reads the bundled defaults file when bundled is omitted", async () => {
  const result = await loadFileBridgeConfig({
    env: {},
    readBundledImpl: async () =>
      JSON.stringify({
        accessKeyId: "file-ak",
        accessKeySecret: "file-sk",
        objectPrefix: "bundled/",
      }),
  });

  assert.deepEqual(result, {
    ok: true,
    config: {
      accessKeyId: "file-ak",
      accessKeySecret: "file-sk",
      region: "oss-cn-shanghai",
      bucket: "ypmisc",
      objectPrefix: "bundled/",
    },
  });
});

test("loadFileBridgeConfig ignores malformed or missing bundled defaults files", async () => {
  const result = await loadFileBridgeConfig({
    env: {},
    readBundledImpl: async () => "{ not json",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "fileBridgeOss.accessKeyId / 打包内置凭据 / AccessKeyId 缺失",
    "fileBridgeOss.accessKeySecret / 打包内置凭据 / AccessKeySecret 缺失",
  ]);
});

test("ambiguous whitespace CSV paths never upload an unregistered sibling", async (t) => {
  const { workspaceDir, params } = createMergeFixture(t);
  const original = params.completion_csv_paths[0];
  writeFileSync(`${original} `, "creator_id,nickname\ncreator-1,unauthorized\n");
  let uploads = 0;
  const result = await fileBridge(
    { ...params, completion_csv_paths: [`${original} `] },
    {
      workspaceDir,
      env: {},
      bundled: null,
      pluginConfig: { fileBridgeOss: { accessKeyId: "mock-ak", accessKeySecret: "mock-sk" } },
      fetchImpl: async () => new Response("ok"),
      allowedLinksCsvPaths: () => [params.links_csv_path],
      allowedCompletionCsvPaths: () => [original],
      createClient: () => ({
        put: async () => {
          uploads++;
          return {};
        },
      }),
    },
  );
  assert.equal(payload(result).success, false);
  assert.equal(uploads, 0);
});

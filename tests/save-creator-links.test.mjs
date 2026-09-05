import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveCreatorLinks } from "../src/tools/save-creator-links.js";

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

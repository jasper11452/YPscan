import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveArtifact } from "../src/tools/save-artifact.js";
import { previewFixture } from "./helpers/creator-preview-fixture.mjs";

async function fixture(t) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-score-artifacts-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const first = previewFixture(workspaceDir, {
    name: "source-first.xlsx",
    rows: [["creator_id"], ["first-creator"]],
  }).buffer;
  const second = previewFixture(workspaceDir, {
    name: "source-second.xlsx",
    rows: [["creator_id"], ["second-creator"]],
  }).buffer;
  async function save(buffer, { job = "first", kind = "manual_source", id = "req-score" } = {}) {
    const result = await saveArtifact(
      {
        artifact_kind: kind,
        artifact_id: id,
        file_url: `https://files.eshypdata.com/${job}/scored.xlsx`,
      },
      {
        workspaceDir,
        fetchImpl: async () => new Response(buffer),
        retryDelaysMs: [],
      },
    );
    return JSON.parse(result.content[0].text);
  }
  return { workspaceDir, first, second, save };
}

test("manual-source score workbooks with the same name retain both batches and retry idempotently", async (t) => {
  const { workspaceDir, first, second, save } = await fixture(t);
  const a = await save(first);
  const b = await save(second, { job: "second" });
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.equal(a.data.file_name, "scored.xlsx");
  assert.notEqual(a.data.file_path, b.data.file_path);
  assert.match(b.data.file_name, /^manual_source-[a-f0-9]{16}-[a-f0-9]{64}\.xlsx$/u);
  assert.equal(b.data.artifact_id, "req-score");
  assert.match(b.delivery.local_file_link, new RegExp(b.data.file_name.replace(".", "\\."), "u"));
  assert.deepEqual(await readFile(a.data.file_path), first);
  assert.deepEqual(await readFile(b.data.file_path), second);

  const retry = await save(second, { job: "second" });
  assert.equal(retry.success, true);
  assert.equal(retry.data.file_path, b.data.file_path);
  assert.equal(retry.data.idempotent, true);
  assert.equal((await save(first)).data.idempotent, true);
  assert.equal(
    (await readdir(workspaceDir)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("a reused Provider URL does not overwrite an earlier score workbook", async (t) => {
  const { first, second, save } = await fixture(t);
  const a = await save(first);
  const b = await save(second);
  assert.equal(b.success, true);
  assert.notEqual(a.data.file_path, b.data.file_path);
  assert.deepEqual(await readFile(a.data.file_path), first);
  assert.deepEqual(await readFile(b.data.file_path), second);
});

test("manual-source fallback names separate requirement metadata without using it as a path", async (t) => {
  const { first, second, save } = await fixture(t);
  await save(first);
  const a = await save(second, { id: "req-A" });
  const b = await save(second, { id: "../req-B" });
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.notEqual(a.data.file_path, b.data.file_path);
  assert.equal(b.data.file_name.includes("req-B"), false);
});

test("a changed manual-source fallback file is still a content conflict", async (t) => {
  const { first, second, save } = await fixture(t);
  await save(first);
  const b = await save(second, { job: "second" });
  assert.equal(b.success, true);
  await writeFile(b.data.file_path, "changed locally");
  const retry = await save(second, { job: "second" });
  assert.equal(retry.success, false);
  assert.equal(retry.error.code, "YPSCAN_ARTIFACT_SAVE_CONFLICT");
  assert.equal(await readFile(b.data.file_path, "utf8"), "changed locally");
});

for (const target of ["original", "fallback"]) {
  test(`manual-source ${target} symlinks are rejected without overwriting their targets`, async (t) => {
    const { workspaceDir, first, second, save } = await fixture(t);
    const original = await save(first);
    let path = original.data.file_path;
    if (target === "fallback") {
      const next = await save(second);
      assert.equal(next.success, true);
      path = next.data.file_path;
    }
    const destination = join(workspaceDir, "untouched.xlsx");
    await writeFile(destination, "untouched");
    await unlink(path);
    await symlink(destination, path);
    const result = await save(second);
    assert.equal(result.success, false);
    assert.equal(result.error.code, "YPSCAN_ARTIFACT_SAVE_UNSAFE_PATH");
    assert.equal(await readFile(destination, "utf8"), "untouched");
  });
}

for (const kind of ["mcn_creator_preview", "mcn_ranking", "ranked_submission"]) {
  test(`${kind} content conflict semantics are unchanged`, async (t) => {
    const { first, second, save } = await fixture(t);
    const a = await save(first, { kind });
    const b = await save(second, { kind, job: "second" });
    assert.equal(a.success, true);
    assert.equal(b.success, false);
    assert.equal(b.error.code, "YPSCAN_ARTIFACT_SAVE_CONFLICT");
    assert.deepEqual(await readFile(a.data.file_path), first);
  });
}

test("concurrent manual-source saves preserve both contents without leftover temporary files", async (t) => {
  const { workspaceDir, first, second, save } = await fixture(t);
  const inputs = Array.from({ length: 10 }, (_, index) => (index % 2 ? second : first));
  const results = await Promise.all(inputs.map((buffer) => save(buffer)));
  for (let index = 0; index < results.length; index += 1) {
    assert.equal(results[index].success, true);
    assert.deepEqual(await readFile(results[index].data.file_path), inputs[index]);
  }
  assert.equal(new Set(results.map((result) => result.data.file_path)).size, 2);
  assert.equal(
    (await readdir(workspaceDir)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

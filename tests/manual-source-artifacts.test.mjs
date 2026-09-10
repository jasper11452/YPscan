import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveArtifact } from "../src/tools/save-artifact.js";
import { previewFixture } from "./helpers/creator-preview-fixture.mjs";

const STARTED_AT = "2026-09-10T15:30:45";
const at = (value) => () => new Date(value);

/** 默认时钟每次调用前进一秒：并发/连续保存得到不同时间戳，断言不依赖真实时间。 */
function tickingClock(start = STARTED_AT) {
  let milliseconds = new Date(start).getTime();
  return () => {
    const now = new Date(milliseconds);
    milliseconds += 1000;
    return now;
  };
}

async function fixture(t) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-score-artifacts-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const clock = tickingClock();
  const first = previewFixture(workspaceDir, {
    name: "source-first.xlsx",
    rows: [["creator_id"], ["first-creator"]],
  }).buffer;
  const second = previewFixture(workspaceDir, {
    name: "source-second.xlsx",
    rows: [["creator_id"], ["second-creator"]],
  }).buffer;
  async function save(
    buffer,
    {
      job = "first",
      kind = "manual_source",
      id = "req-score",
      projectName = null,
      now = clock,
    } = {},
  ) {
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
        projectName,
        now,
      },
    );
    return JSON.parse(result.content[0].text);
  }
  return { workspaceDir, first, second, save };
}

test("manual-source score workbooks keep both batches under readable names and retry idempotently", async (t) => {
  const { workspaceDir, first, second, save } = await fixture(t);
  const a = await save(first);
  const b = await save(second, { job: "second" });
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.equal(a.data.file_name, "达人评分排序表-20260910-153045.xlsx");
  assert.equal(b.data.file_name, "达人评分排序表-20260910-153046.xlsx");
  assert.equal(a.data.file_name.includes("scored"), false);
  assert.notEqual(a.data.file_path, b.data.file_path);
  assert.equal(b.data.artifact_id, "req-score");
  assert.match(b.delivery.local_file_link, new RegExp(b.data.file_name.replace(".", "\\."), "u"));
  assert.deepEqual(await readFile(a.data.file_path), first);
  assert.deepEqual(await readFile(b.data.file_path), second);

  // 同一秒内重试同内容：幂等复用，不新增文件。
  const retry = await save(second, { job: "second", now: at("2026-09-10T15:30:46") });
  assert.equal(retry.success, true);
  assert.equal(retry.data.file_path, b.data.file_path);
  assert.equal(retry.data.idempotent, true);
  assert.equal((await save(first, { now: at("2026-09-10T15:30:45") })).data.idempotent, true);
  assert.equal(
    (await readdir(workspaceDir)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("manual score batches use the manual-sourcing readable name", async (t) => {
  const { first, second, save } = await fixture(t);
  const a = await save(first, { kind: "manual_score_batch" });
  const b = await save(second, { kind: "manual_score_batch", job: "second" });
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.equal(a.data.file_name, "手动拓展评分表-20260910-153045.xlsx");
  assert.equal(b.data.file_name, "手动拓展评分表-20260910-153046.xlsx");
  assert.equal(a.data.file_name.includes("batch-score"), false);
});

test("the project name leads the file name and stays unique per content", async (t) => {
  const { first, second, save } = await fixture(t);
  const projectName = "天猫9月男装衬衫";
  const a = await save(first, { projectName, now: at(STARTED_AT) });
  const b = await save(first, { projectName, now: at(STARTED_AT) });
  const renamed = await save(first, { projectName: "另一个项目", now: at(STARTED_AT) });
  const nextBatch = await save(second, { projectName, now: at("2026-09-10T15:31:00") });
  assert.equal(a.success, true);
  assert.equal(a.data.file_name, "天猫9月男装衬衫-达人评分排序表-20260910-153045.xlsx");
  assert.equal(b.data.file_path, a.data.file_path);
  assert.equal(b.data.idempotent, true);
  assert.equal(renamed.data.file_name, "另一个项目-达人评分排序表-20260910-153045.xlsx");
  assert.deepEqual(await readFile(a.data.file_path), first);
  assert.deepEqual(await readFile(nextBatch.data.file_path), second);
});

test("different content saved within the same second adds the content hash instead of overwriting", async (t) => {
  const { first, second, save } = await fixture(t);
  const projectName = "天猫9月男装衬衫";
  const a = await save(first, { projectName, now: at(STARTED_AT) });
  const b = await save(second, { projectName, now: at(STARTED_AT) });
  assert.equal(b.success, true);
  assert.equal(
    b.data.file_name,
    `天猫9月男装衬衫-达人评分排序表-20260910-153045-${b.data.sha256.slice(0, 8)}.xlsx`,
  );
  assert.notEqual(b.data.file_path, a.data.file_path);
  assert.deepEqual(await readFile(a.data.file_path), first);
  assert.deepEqual(await readFile(b.data.file_path), second);
});

test("project names are cleaned, truncated and omitted when unusable", async (t) => {
  const { first, second, save } = await fixture(t);
  const uncleaned = await save(first, {
    projectName: " 天猫/9月:男装\n衬衫  ",
    now: at(STARTED_AT),
  });
  assert.equal(uncleaned.success, true);
  assert.equal(uncleaned.data.file_name, "天猫 9月 男装 衬衫-达人评分排序表-20260910-153045.xlsx");
  const truncated = await save(second, { projectName: "甲".repeat(80), now: at(STARTED_AT) });
  assert.equal(truncated.data.file_name, `${"甲".repeat(20)}-达人评分排序表-20260910-153045.xlsx`);
  const blank = await save(first, { projectName: " / : ", now: at(STARTED_AT) });
  assert.equal(blank.data.file_name, "达人评分排序表-20260910-153045.xlsx");
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

test("manual-source names ignore requirement metadata and the Provider basename", async (t) => {
  const { second, save } = await fixture(t);
  const a = await save(second, { id: "req-A", now: at(STARTED_AT) });
  const b = await save(second, { id: "../req-B", now: at(STARTED_AT) });
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.equal(a.data.file_name, "达人评分排序表-20260910-153045.xlsx");
  assert.equal(a.data.file_name.includes("req"), false);
  assert.equal(a.data.file_name.includes("scored"), false);
  assert.equal(a.data.file_path, b.data.file_path);
  assert.equal(b.data.idempotent, true);
});

test("a locally changed scoring workbook is never overwritten", async (t) => {
  const { first, second, save } = await fixture(t);
  await save(first, { now: at(STARTED_AT) });
  const b = await save(second, { job: "second", now: at("2026-09-10T15:30:46") });
  assert.equal(b.success, true);
  await writeFile(b.data.file_path, "changed locally");
  const retry = await save(second, { job: "second", now: at("2026-09-10T15:30:46") });
  assert.equal(retry.success, true);
  assert.equal(
    retry.data.file_name,
    `达人评分排序表-20260910-153046-${retry.data.sha256.slice(0, 8)}.xlsx`,
  );
  assert.equal(await readFile(b.data.file_path, "utf8"), "changed locally");
  assert.deepEqual(await readFile(retry.data.file_path), second);
});

for (const content of ["first", "second"]) {
  test(`manual-source ${content} symlinks are rejected without overwriting their targets`, async (t) => {
    const { workspaceDir, first, second, save } = await fixture(t);
    const buffer = content === "first" ? first : second;
    const saved = await save(buffer, { now: at(STARTED_AT) });
    assert.equal(saved.success, true);
    const destination = join(workspaceDir, "untouched.xlsx");
    await writeFile(destination, "untouched");
    await unlink(saved.data.file_path);
    await symlink(destination, saved.data.file_path);
    const result = await save(buffer, { now: at(STARTED_AT) });
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
  const results = await Promise.all(inputs.map((buffer) => save(buffer, { now: at(STARTED_AT) })));
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

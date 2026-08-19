import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildManualResearchWorkbook } from "../src/tools/manual-research-artifact.js";
import { compileManualResearchPlan } from "../src/tools/manual-research-plan.js";
import { createManualResearchRunner } from "../src/tools/manual-research-runner.js";

function fact(id, kind, normalizedValue, extra = {}) {
  return {
    id,
    kind,
    status: "present",
    disposition: "active",
    strength: "hard",
    normalized_value: normalizedValue,
    source: { id: `source-${id}`, quote: String(normalizedValue) },
    ...extra,
  };
}

function params(extra = {}) {
  return {
    operation: "start",
    requirement_id: "runner-requirement",
    platform: "xingtu",
    facts: [
      fact("product", "product_name", "办公软件"),
      fact("count", "creator_count", 3, { role: "submission" }),
    ],
    keywords: ["效率办公"],
    ...extra,
  };
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function storedZipEntry(buffer, expectedName) {
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (name === expectedName) return buffer.subarray(dataStart, dataStart + size).toString("utf8");
    offset = dataStart + size;
  }
  return null;
}

function runtime(pageCalls, pageError = null, visibleRows = []) {
  return {
    acquire() {
      return { acquired: true, release() {} };
    },
    async page() {
      pageCalls.count += 1;
      if (pageError) throw pageError;
      return {
        url: () => "https://www.xingtu.cn/ad/creator/market",
        async evaluate() {
          return visibleRows;
        },
      };
    },
  };
}

function adapter(rowCount, actions = []) {
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    platform_id: `creator-${index + 1}`,
    nickname: `达人 ${index + 1}`,
    detail_url: `https://www.xingtu.cn/creator/${index + 1}`,
    followers_raw: "10万",
  }));
  return {
    async prepare() {
      actions.push("prepare");
    },
    async recover() {
      actions.push("recover");
    },
    async reset() {},
    async verifyBaseline() {
      return { valid: true };
    },
    async setPriceView() {
      return { applied: true };
    },
    async applyFilter() {
      return { applied: true };
    },
    async search() {
      return { applied: true };
    },
    async readPage() {
      return {
        rows,
        source_url: "https://www.xingtu.cn/ad/creator/market",
      };
    },
    async nextPage() {
      return false;
    },
    async collectDetail(candidate) {
      return {
        status: "complete",
        platform_id: candidate.platform_id,
        nickname: candidate.nickname,
        detail_url: candidate.detail_url,
        captured_at: "2026-08-19T00:00:00.000Z",
        fields: { recent_content: [] },
      };
    },
    async dispose() {},
  };
}

test("runner completes with candidates and a three-sheet Excel", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-complete-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const pageCalls = { count: 0 };
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime(pageCalls),
    createAdapter: () => adapter(20),
  });

  const data = payload(await run(params()));

  assert.equal(data.success, true);
  assert.equal(data.status, "complete");
  assert.equal(data.quality_level, "exact");
  assert.equal(data.candidate_count, 20);
  const workbook = await readFile(data.artifact.excel_path);
  const workbookXml = storedZipEntry(workbook, "xl/workbook.xml");
  assert.match(workbookXml, /sheet name="达人推荐List"/u);
  assert.match(workbookXml, /sheet name="候选达人"/u);
  assert.match(workbookXml, /sheet name="运行说明"/u);
  assert.equal((workbookXml.match(/<sheet /gu) ?? []).length, 3);
});

test("login interruption still returns a diagnostic Excel and resume arguments", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-login-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const error = Object.assign(new Error("请登录"), { code: "YPSCAN_MANUAL_LOGIN_REQUIRED" });
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }, error),
  });

  const data = payload(await run(params()));

  assert.equal(data.success, true);
  assert.equal(data.status, "needs_user_action");
  assert.equal(data.error.code, "YPSCAN_MANUAL_LOGIN_REQUIRED");
  assert.equal(data.resume_args.operation, "resume");
  assert.equal((await readFile(data.artifact.excel_path)).subarray(0, 2).toString("utf8"), "PK");
});

test("runner marks fallback collection as degraded and keeps its candidate artifact", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-fallback-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }),
    createAdapter: () => adapter(1),
  });

  const data = payload(await run(params()));

  assert.equal(data.status, "complete");
  assert.equal(data.quality_level, "degraded");
  assert.equal(data.candidate_count, 1);
  assert.equal(data.candidates[0].collection_mode, "filtered");
  assert.ok(data.artifact.excel_path);
});

test("runner recovers and retries one failed browser action", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-retry-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const actions = [];
  const fakeAdapter = adapter(20, actions);
  let prepareCalls = 0;
  fakeAdapter.prepare = async () => {
    prepareCalls += 1;
    actions.push("prepare");
    if (prepareCalls === 1) throw new Error("temporary overlay");
  };
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }),
    createAdapter: () => fakeAdapter,
  });

  const data = payload(await run(params()));

  assert.equal(data.status, "complete");
  assert.deepEqual(actions.slice(0, 3), ["prepare", "recover", "prepare"]);
});

test("resuming a terminal run returns its artifact without opening the browser again", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-resume-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const pageCalls = { count: 0 };
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime(pageCalls),
    createAdapter: () => adapter(20),
  });
  const first = payload(await run(params()));

  const resumed = payload(
    await run({
      operation: "resume",
      requirement_id: first.requirement_id,
      platform: first.platform,
      run_id: first.run_id,
    }),
  );

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.artifact.excel_path, first.artifact.excel_path);
  assert.equal(pageCalls.count, 1);
});

test("runner rejects the removed capture protocol", async () => {
  const run = createManualResearchRunner();
  const result = await run({
    operation: "capture_list",
    requirement_id: "runner-requirement",
    platform: "xingtu",
  });
  const data = payload(result);

  assert.equal(result.isError, true);
  assert.equal(data.status, "failed");
  assert.equal(data.error.code, "YPSCAN_MANUAL_ARGUMENT_INVALID");
  assert.match(data.error.message, /旧操作 capture_list 已停用/u);
});

test("generic DOM candidates remain outside the recommendation sheet after review", () => {
  const plan = compileManualResearchPlan(params());
  const candidate = {
    platform: "xingtu",
    platform_id: "generic-1",
    nickname: "通用召回达人",
    detail_url: "https://www.xingtu.cn/creator/generic-1",
    source_url: "https://www.xingtu.cn/ad/creator/market",
    collection_mode: "generic_dom",
  };
  const verifiedCandidate = {
    ...candidate,
    platform_id: "verified-1",
    nickname: "已验证达人",
    detail_url: "https://www.xingtu.cn/creator/verified-1",
    collection_mode: "filtered",
  };
  const workbook = buildManualResearchWorkbook({
    plan,
    candidates: [candidate, verifiedCandidate],
    details: [
      {
        candidate_ref: "generic-1",
        status: "complete",
        fields: {},
        hard_evaluation: { status: "pass", checks: [] },
      },
      {
        candidate_ref: "verified-1",
        status: "complete",
        fields: {},
        hard_evaluation: { status: "pass", checks: [] },
      },
    ],
    reviews: [
      {
        candidate_ref: "generic-1",
        decision: "include",
        reasons: ["内容匹配"],
        evidence: ["详情证据"],
      },
      {
        candidate_ref: "verified-1",
        decision: "include",
        reasons: ["内容匹配"],
        evidence: ["详情证据"],
      },
    ],
    artifact: {
      run_id: "generic-run",
      status: "complete",
      generated_at: "2026-08-19T00:00:00.000Z",
      candidate_row_count: 2,
      target_row_count: 1,
      delivery_shortfall: 2,
      run_info: {},
    },
  });

  const recommendation = storedZipEntry(workbook, "xl/worksheets/sheet1.xml");
  const candidates = storedZipEntry(workbook, "xl/worksheets/sheet2.xml");
  assert.doesNotMatch(recommendation, /通用召回达人/u);
  assert.match(recommendation, /已验证达人/u);
  assert.match(candidates, /通用召回达人/u);
});

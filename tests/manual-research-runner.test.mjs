import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

test("runner keeps filters while changing keywords and reads every result page", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-all-pages-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const actions = [];
  let keyword = "";
  let pageNumber = 1;
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }),
    createAdapter: () => ({
      async prepare() {},
      async reset() {
        actions.push("reset");
      },
      async verifyBaseline() {
        return { valid: true };
      },
      async applyFilter() {
        actions.push("filter");
        return { applied: true };
      },
      async search(value) {
        keyword = value;
        pageNumber = 1;
        actions.push(`search:${value}`);
        return { applied: true };
      },
      async readPage() {
        actions.push(`read:${keyword}:${pageNumber}`);
        return {
          rows: [
            {
              platform_id: `${keyword}-${pageNumber}`,
              nickname: `${keyword}达人${pageNumber}`,
              detail_url: `https://www.xingtu.cn/creator/${keyword}-${pageNumber}`,
            },
          ],
          source_url: "https://www.xingtu.cn/ad/creator/market",
        };
      },
      async nextPage() {
        if (pageNumber >= 3) return false;
        pageNumber += 1;
        return true;
      },
      async collectDetail(candidate) {
        return {
          status: "complete",
          platform_id: candidate.platform_id,
          nickname: candidate.nickname,
          detail_url: candidate.detail_url,
          fields: {},
        };
      },
      async dispose() {},
    }),
  });

  const data = payload(
    await run(
      params({
        facts: [
          fact("product", "product_name", "办公软件"),
          fact("count", "creator_count", 1, { role: "submission" }),
          fact("gender", "creator_gender", "female"),
        ],
        keywords: ["效率", "办公"],
      }),
    ),
  );

  assert.equal(data.candidate_count, 6);
  assert.deepEqual(actions, [
    "reset",
    "filter",
    "search:效率",
    "read:效率:1",
    "read:效率:2",
    "read:效率:3",
    "search:办公",
    "read:办公:1",
    "read:办公:2",
    "read:办公:3",
  ]);
});

test("raw HTML is checkpointed by manifest, read in chunks, and completed only after Agent extraction", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-html-evidence-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const artifactRoot = join(workspaceDir, "ypscan-manual-research");
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(join(artifactRoot, ".gitignore"), "", "utf8");
  const html = `<html><body>粉丝数：10万 <a>办公软件实测</a>${"x".repeat(33_000)}</body></html>`;
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }),
    createAdapter: () => {
      const base = adapter(2);
      return {
        ...base,
        async collectDetail(candidate, { onHtmlSnapshot }) {
          const htmlSnapshots = [];
          for (const group of ["summary", "recent_content"]) {
            htmlSnapshots.push(
              await onHtmlSnapshot({
                group,
                url: candidate.detail_url,
                captured_at: "2026-08-20T00:00:00.000Z",
                html,
              }),
            );
          }
          return {
            status: "complete",
            platform_id: candidate.platform_id,
            nickname: candidate.nickname,
            detail_url: candidate.detail_url,
            captured_at: "2026-08-20T00:00:00.000Z",
            fields: { followers_raw: "错误旧值" },
            html_snapshots: htmlSnapshots,
          };
        },
      };
    },
  });

  const started = payload(
    await run(
      params({
        requirement_id: "html-evidence",
        facts: [
          fact("product", "product_name", "办公软件"),
          fact("count", "creator_count", 1, { role: "submission" }),
        ],
      }),
    ),
  );
  assert.equal(started.status, "awaiting_extraction");
  assert.equal(started.detail_progress.completed, 0);
  assert.equal(started.detail_progress.captured, 2);
  assert.equal(started.detail_progress.qualified, 0);
  assert.equal(started.review_batch[0].fields.followers_raw, undefined);
  const task = started.review_batch[0];
  const snapshot = task.html_snapshots[0];
  const readTaskHtml = async (reviewTask) => {
    let args = {
      operation: "read_detail_html",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
      candidate_ref: reviewTask.candidate_ref,
      snapshot_id: reviewTask.html_snapshots[0].snapshot_id,
      cursor: 0,
    };
    let result = "";
    for (;;) {
      const chunk = payload(await run(args));
      result += chunk.html_chunk;
      if (!chunk.next_call) return result;
      args = chunk.next_call.args;
    }
  };
  const checkpoint = await readFile(started.artifact.checkpoint_path, "utf8");
  assert.doesNotMatch(checkpoint, /办公软件实测/u);
  assert.equal(
    await readFile(join(workspaceDir, "ypscan-manual-research", ".gitignore"), "utf8"),
    "*\n!.gitignore\n",
  );

  const evidenceRoot = join(workspaceDir, "ypscan-manual-research", started.run_id, "evidence");
  const candidateDirs = await readdir(evidenceRoot);
  const htmlFiles = await readdir(join(evidenceRoot, candidateDirs[0]));
  const evidencePath = join(evidenceRoot, candidateDirs[0], htmlFiles[0]);
  assert.equal((await stat(evidencePath)).mode & 0o777, 0o600);

  const beforeRead = payload(
    await run({
      operation: "apply_reviews",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
      reviews: [
        {
          candidate_ref: task.candidate_ref,
          decision: "include",
          reasons: ["内容符合"],
          evidence: ["办公软件实测"],
          extracted_fields: {
            followers_raw: "10万",
            recent_content: [{ title: "办公软件实测", url: null }],
          },
          field_evidence: [
            { field: "followers_raw", snapshot_id: snapshot.snapshot_id, quote: "粉丝数：10万" },
            { field: "recent_content", snapshot_id: snapshot.snapshot_id, quote: "办公软件实测" },
          ],
        },
      ],
    }),
  );
  assert.equal(beforeRead.success, false);
  assert.equal(beforeRead.error.code, "YPSCAN_MANUAL_HTML_READ_INCOMPLETE");

  const skippedChunk = payload(
    await run({
      operation: "read_detail_html",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
      candidate_ref: task.candidate_ref,
      snapshot_id: snapshot.snapshot_id,
      cursor: 1,
    }),
  );
  assert.equal(skippedChunk.success, false);
  assert.equal(skippedChunk.error.code, "YPSCAN_MANUAL_HTML_READ_OUT_OF_SEQUENCE");

  const skippedSnapshot = payload(
    await run({
      operation: "read_detail_html",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
      candidate_ref: task.candidate_ref,
      snapshot_id: task.html_snapshots[1].snapshot_id,
      cursor: 0,
    }),
  );
  assert.equal(skippedSnapshot.success, false);
  assert.equal(skippedSnapshot.error.code, "YPSCAN_MANUAL_HTML_READ_OUT_OF_SEQUENCE");

  assert.equal(await readTaskHtml(task), html.repeat(2));

  const invalid = payload(
    await run({
      operation: "apply_reviews",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
      reviews: [
        {
          candidate_ref: task.candidate_ref,
          decision: "include",
          reasons: ["内容符合"],
          evidence: ["不存在的证据"],
          extracted_fields: { followers_raw: "10万" },
          field_evidence: [
            { field: "followers_raw", snapshot_id: snapshot.snapshot_id, quote: "不存在" },
          ],
        },
      ],
    }),
  );
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.code, "YPSCAN_MANUAL_EXTRACTION_EVIDENCE_NOT_FOUND");

  const fabricated = payload(
    await run({
      operation: "apply_reviews",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
      reviews: [
        {
          candidate_ref: task.candidate_ref,
          decision: "include",
          reasons: ["内容符合"],
          evidence: ["办公软件实测"],
          extracted_fields: {
            followers_raw: "10万",
            recent_content: [{ title: "伪造内容", url: null }],
          },
          field_evidence: [
            { field: "followers_raw", snapshot_id: snapshot.snapshot_id, quote: "粉丝数：10万" },
            { field: "recent_content", snapshot_id: snapshot.snapshot_id, quote: "办公软件实测" },
          ],
        },
      ],
    }),
  );
  assert.equal(fabricated.success, false);
  assert.equal(fabricated.error.code, "YPSCAN_MANUAL_EXTRACTION_VALUE_MISMATCH");

  const excluded = payload(
    await run({
      operation: "apply_reviews",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
      reviews: [
        {
          candidate_ref: task.candidate_ref,
          decision: "exclude",
          reasons: ["内容符合办公软件方向"],
          evidence: ["办公软件实测"],
          extracted_fields: {
            followers_raw: "10万",
            recent_content: [{ title: "办公软件实测", url: null }],
          },
          field_evidence: [
            { field: "followers_raw", snapshot_id: snapshot.snapshot_id, quote: "粉丝数：10万" },
            { field: "recent_content", snapshot_id: snapshot.snapshot_id, quote: "办公软件实测" },
          ],
        },
      ],
    }),
  );
  assert.equal(excluded.status, "reviewing");
  assert.equal(excluded.detail_progress.completed, 1);
  assert.equal(excluded.detail_progress.qualified, 0);
  assert.equal(excluded.review_batch.length, 1);

  const reviewingReplay = payload(
    await run({
      operation: "resume",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
    }),
  );
  assert.equal(reviewingReplay.status, "reviewing");
  assert.equal(reviewingReplay.detail_progress.qualified, 0);
  assert.equal(reviewingReplay.detail_progress.shortfall, 2);
  assert.equal(
    reviewingReplay.next_call.args.candidate_ref,
    excluded.review_batch[0].candidate_ref,
  );

  const replacementTask = excluded.review_batch[0];
  const replacementSnapshot = replacementTask.html_snapshots[0];
  await readTaskHtml(replacementTask);
  const applied = payload(
    await run({
      operation: "apply_reviews",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
      reviews: [
        {
          candidate_ref: replacementTask.candidate_ref,
          decision: "include",
          reasons: ["内容符合办公软件方向"],
          evidence: ["办公软件实测"],
          extracted_fields: {
            followers_raw: "10万",
            recent_content: [{ title: "办公软件实测", url: null }],
          },
          field_evidence: [
            {
              field: "followers_raw",
              snapshot_id: replacementSnapshot.snapshot_id,
              quote: "粉丝数：10万",
            },
            {
              field: "recent_content",
              snapshot_id: replacementSnapshot.snapshot_id,
              quote: "办公软件实测",
            },
          ],
        },
      ],
    }),
  );
  assert.equal(applied.status, "partial");
  assert.equal(applied.detail_progress.completed, 2);
  assert.equal(applied.detail_progress.qualified, 1);
  assert.equal(applied.detail_progress.shortfall, 1);
  assert.equal(applied.artifact.target_row_count, 1);
  assert.equal((await stat(started.artifact.checkpoint_path)).mode & 0o777, 0o600);

  const replayed = payload(
    await run({
      operation: "resume",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
    }),
  );
  assert.equal(replayed.status, "partial");
  assert.equal(replayed.next_call, undefined);

  const submission = payload(
    await run({
      operation: "create_submission",
      requirement_id: "html-evidence",
      platform: "xingtu",
      run_id: started.run_id,
    }),
  );
  assert.equal(submission.status, "complete");
  assert.equal(submission.row_count, 1);
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

test("runner accepts compact creator price facts that use value", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-compact-price-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }),
    createAdapter: () => adapter(20),
  });

  const data = payload(
    await run(
      params({
        facts: [
          { kind: "product_name", value: "办公软件" },
          { kind: "creator_count", value: 3, role: "submission" },
          { kind: "creator_price", value: 20_000, operator: "lte" },
        ],
      }),
    ),
  );

  assert.equal(data.status, "complete");
  assert.equal(data.error, undefined);
});

test("a CAPTCHA after complete extraction preserves one completed detail", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-captcha-captured-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const fakeAdapter = adapter(20);
  fakeAdapter.collectDetail = async (candidate) => {
    throw Object.assign(new Error("平台要求用户完成安全验证"), {
      code: "YPSCAN_MANUAL_CAPTCHA_REQUIRED",
      details: {
        captured_detail: {
          status: "complete",
          reason: "manual_challenge_after_capture",
          platform_id: candidate.platform_id,
          nickname: candidate.nickname,
          detail_url: candidate.detail_url,
          fields: {
            followers_raw: "10万",
            recent_content: [{ title: "办公工具实测", url: null }],
          },
          completed_groups: ["summary", "recent_content"],
          missing_groups: [],
        },
      },
    });
  };
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }),
    createAdapter: () => fakeAdapter,
  });

  const data = payload(await run(params()));

  assert.equal(data.status, "needs_user_action");
  assert.equal(data.detail_progress.attempted, 1);
  assert.equal(data.detail_progress.completed, 1);
  assert.equal(data.detail_progress.partial, 0);
});

test("a successful resume clears the previous login interruption", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-login-resume-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  let pageCalls = 0;
  const browserRuntime = {
    acquire() {
      return { acquired: true, release() {} };
    },
    async page() {
      pageCalls += 1;
      if (pageCalls === 1) {
        throw Object.assign(new Error("请登录"), { code: "YPSCAN_MANUAL_LOGIN_REQUIRED" });
      }
      return {
        url: () => "https://www.xingtu.cn/ad/creator/market",
        async evaluate() {
          return [];
        },
      };
    },
  };
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime,
    createAdapter: () => adapter(20),
  });
  const interrupted = payload(await run(params()));

  const resumed = payload(await run(interrupted.resume_args));

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.artifact.run_info.error_code, null);
  assert.equal(resumed.artifact.run_info.error_message, null);
  assert.equal(pageCalls, 2);
});

test("a page-open timeout is resumable and reopens the host Browser", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-network-resume-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  let pageCalls = 0;
  const pageOptions = [];
  const browserRuntime = {
    acquire() {
      return { acquired: true, release() {} };
    },
    async page(_platform, options) {
      pageCalls += 1;
      pageOptions.push(options);
      if (pageCalls === 1) {
        throw Object.assign(new Error("打开蒲公英达人广场失败"), {
          code: "YPSCAN_MANUAL_PAGE_OPEN_FAILED",
        });
      }
      return {
        url: () => "https://www.xingtu.cn/ad/creator/market",
        async evaluate() {
          return [];
        },
      };
    },
  };
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime,
    createAdapter: () => adapter(20),
  });

  const interrupted = payload(await run(params()));
  assert.equal(interrupted.status, "needs_user_action");
  assert.equal(interrupted.error.code, "YPSCAN_MANUAL_PAGE_OPEN_FAILED");
  assert.equal(interrupted.resume_args.operation, "resume");

  const resumed = payload(await run(interrupted.resume_args));
  assert.equal(resumed.status, "complete");
  assert.equal(pageCalls, 2);
  assert.deepEqual(pageOptions, [{ reopen: false }, { reopen: true }]);
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

  assert.equal(data.status, "partial");
  assert.equal(data.quality_level, "degraded");
  assert.equal(data.candidate_count, 1);
  assert.equal(data.candidates[0].collection_mode, "filtered");
  assert.ok(data.artifact.excel_path);
  assert.deepEqual(data.detail_progress, {
    target: 6,
    attempted: 1,
    completed: 1,
    partial: 0,
    failed: 0,
    shortfall: 5,
  });
});

test("runner replaces failed detail attempts until twice the requested count is collected", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-detail-refill-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const fakeAdapter = adapter(26);
  fakeAdapter.collectDetail = async (candidate) => {
    const index = Number(candidate.platform_id.split("-").at(-1));
    if (index <= 6) {
      throw Object.assign(new Error(`详情 ${index} 超时`), {
        code: "YPSCAN_MANUAL_DETAIL_FAILED",
      });
    }
    return {
      status: "complete",
      platform_id: candidate.platform_id,
      nickname: candidate.nickname,
      detail_url: candidate.detail_url,
      fields: { followers_raw: "10万" },
    };
  };
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }),
    createAdapter: () => fakeAdapter,
  });

  const data = payload(
    await run(
      params({
        facts: [
          fact("product", "product_name", "办公软件"),
          fact("count", "creator_count", 10, { role: "submission" }),
        ],
      }),
    ),
  );

  assert.equal(data.status, "complete");
  assert.deepEqual(data.detail_progress, {
    target: 20,
    attempted: 26,
    completed: 20,
    partial: 0,
    failed: 6,
    shortfall: 0,
  });
  assert.equal(data.detail_failures.length, 6);
  assert.equal(data.detail_failures[0].candidate_ref, "creator-1");
  assert.match(data.detail_failures[0].message, /详情 1 超时/u);
});

test("runner reports partial when fewer than twice the requested detail records exist", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-detail-shortfall-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }),
    createAdapter: () => adapter(9),
  });

  const data = payload(
    await run(
      params({
        facts: [
          fact("product", "product_name", "办公软件"),
          fact("count", "creator_count", 10, { role: "submission" }),
        ],
      }),
    ),
  );

  assert.equal(data.status, "partial");
  assert.equal(data.detail_progress.target, 20);
  assert.equal(data.detail_progress.completed, 9);
  assert.equal(data.detail_progress.shortfall, 11);
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
  const originalWorkbook = await readFile(first.artifact.excel_path);
  const originalWorkbookStat = await stat(first.artifact.excel_path);

  const resumed = payload(
    await run({
      operation: "resume",
      requirement_id: first.requirement_id,
      platform: first.platform,
      run_id: first.run_id,
    }),
  );

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.terminal_replay, true);
  assert.equal(resumed.artifact.excel_path, first.artifact.excel_path);
  assert.deepEqual(await readFile(first.artifact.excel_path), originalWorkbook);
  assert.equal((await stat(first.artifact.excel_path)).mtimeMs, originalWorkbookStat.mtimeMs);
  assert.equal(pageCalls.count, 1);
});

test("terminal failure replay preserves diagnostics without mutating the checkpoint", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-failed-replay-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const pageCalls = { count: 0 };
  const failedAdapter = adapter(0);
  failedAdapter.prepare = async () => {
    throw Object.assign(new Error("tool-section intercepts pointer events"), {
      code: "YPSCAN_MANUAL_RESEARCH_FAILED",
    });
  };
  failedAdapter.recover = async () => {};
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime(pageCalls),
    createAdapter: () => failedAdapter,
  });
  const first = payload(await run(params()));
  const originalCheckpoint = await readFile(first.artifact.checkpoint_path, "utf8");
  const checkpointEvents = originalCheckpoint.trim().split("\n").map(JSON.parse);
  const originalRunnerState = checkpointEvents.findLast((event) => event.type === "runner_state");
  await appendFile(
    first.artifact.checkpoint_path,
    `${JSON.stringify({
      ...originalRunnerState,
      captured_at: "2026-08-19T08:39:54.777Z",
      state: { ...originalRunnerState.state, error_code: null, error_message: null },
    })}\n`,
  );
  const checkpointBefore = await readFile(first.artifact.checkpoint_path, "utf8");

  const replayed = payload(
    await run({
      operation: "resume",
      requirement_id: first.requirement_id,
      platform: first.platform,
      run_id: first.run_id,
    }),
  );

  assert.equal(replayed.status, "failed_with_artifact");
  assert.equal(replayed.terminal_replay, true);
  assert.equal(replayed.artifact.run_info.error_code, "YPSCAN_MANUAL_RESEARCH_FAILED");
  assert.match(replayed.artifact.run_info.error_message, /tool-section intercepts pointer events/u);
  assert.equal(await readFile(first.artifact.checkpoint_path, "utf8"), checkpointBefore);
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

test("detail budget prioritizes candidates missing the selected exact quote", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-runner-price-detail-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const collected = [];
  const fakeAdapter = adapter(12);
  fakeAdapter.readPage = async () => ({
    price_tier: "植入视频",
    source_url: "https://www.xingtu.cn/ad/creator/market",
    rows: Array.from({ length: 12 }, (_, index) => ({
      platform_id: `creator-${index + 1}`,
      nickname: `达人 ${index + 1}`,
      detail_url: `https://www.xingtu.cn/creator/${index + 1}`,
      ...(index < 2 ? { price_raw: "1800" } : {}),
    })),
  });
  fakeAdapter.collectDetail = async (candidate) => {
    collected.push(candidate.platform_id);
    return {
      status: "complete",
      platform_id: candidate.platform_id,
      fields: { price_by_tier: { 植入视频: "1800" } },
    };
  };
  const run = createManualResearchRunner({
    workspaceDir,
    browserRuntime: runtime({ count: 0 }),
    createAdapter: () => fakeAdapter,
  });

  await run(
    params({
      facts: [
        fact("product", "product_name", "办公软件"),
        fact("price", "creator_price", 2_000, { operator: "lte" }),
      ],
    }),
  );

  assert.deepEqual(collected, [
    ...Array.from({ length: 10 }, (_, index) => `creator-${index + 3}`),
    "creator-1",
    "creator-2",
  ]);
});

test("PGY starting price is labeled as all-price evidence, never as a typed quote", () => {
  const plan = compileManualResearchPlan({
    platform: "pgy",
    facts: [],
    keywords: ["咖啡"],
  });
  const workbook = buildManualResearchWorkbook({
    plan,
    candidates: [
      {
        platform: "pgy",
        platform_id: "pgy-1",
        nickname: "博主一",
        collection_mode: "filtered",
        minimum_price_raw: "¥20,000起",
      },
    ],
    artifact: { generated_at: "2026-08-19T00:00:00.000Z" },
  });
  const candidateSheet = storedZipEntry(workbook, "xl/worksheets/sheet2.xml");
  assert.match(candidateSheet, /全部报价（起）/u);
  assert.match(candidateSheet, /¥20,000起/u);
  assert.doesNotMatch(candidateSheet, /图文笔记|视频笔记/u);
});

test("PGY exact quote uses its independent typed label in Excel", () => {
  const plan = compileManualResearchPlan({
    platform: "pgy",
    quote_type: "视频",
    facts: [],
    keywords: ["咖啡"],
  });
  const workbook = buildManualResearchWorkbook({
    plan,
    candidates: [
      {
        platform: "pgy",
        platform_id: "pgy-video-1",
        nickname: "视频博主",
        collection_mode: "filtered",
        price_raw: "¥29,000",
        quote_tier: "视频",
        price_evidence: { source: "structured_list", exact: true },
        minimum_price_raw: "¥20,000起",
      },
    ],
    artifact: { generated_at: "2026-08-19T00:00:00.000Z" },
  });
  const candidateSheet = storedZipEntry(workbook, "xl/worksheets/sheet2.xml");
  assert.match(candidateSheet, /视频笔记/u);
  assert.match(candidateSheet, /¥29,000/u);
  assert.doesNotMatch(candidateSheet, /全部报价（起）/u);
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

test("review score orders recommendations and sends the remainder to candidates", () => {
  const plan = compileManualResearchPlan(
    params({
      facts: [
        fact("product", "product_name", "办公软件"),
        fact("count", "creator_count", 1, { role: "submission" }),
      ],
    }),
  );
  const lowScore = {
    platform: "xingtu",
    platform_id: "low-score",
    nickname: "低分达人",
    detail_url: "https://www.xingtu.cn/creator/low-score",
    collection_mode: "filtered",
  };
  const highScore = {
    ...lowScore,
    platform_id: "high-score",
    nickname: "高分达人",
    detail_url: "https://www.xingtu.cn/creator/high-score",
  };
  const workbook = buildManualResearchWorkbook({
    plan,
    candidates: [lowScore, highScore],
    details: [lowScore, highScore].map((candidate) => ({
      candidate_ref: candidate.platform_id,
      status: "complete",
      fields: {},
      hard_evaluation: { status: "pass", checks: [] },
    })),
    reviews: [
      {
        candidate_ref: "low-score",
        decision: "include",
        recommendation_score: 10,
        reasons: ["可作为候选"],
        evidence: ["详情证据"],
      },
      {
        candidate_ref: "high-score",
        decision: "include",
        recommendation_score: 90,
        reasons: ["优先推荐"],
        evidence: ["详情证据"],
      },
    ],
    artifact: {
      run_id: "score-run",
      status: "complete",
      generated_at: "2026-08-20T00:00:00.000Z",
      candidate_row_count: 2,
      target_row_count: 1,
      delivery_shortfall: 0,
      run_info: {},
    },
  });

  const recommendation = storedZipEntry(workbook, "xl/worksheets/sheet1.xml");
  const candidates = storedZipEntry(workbook, "xl/worksheets/sheet2.xml");
  assert.match(recommendation, /高分达人/u);
  assert.doesNotMatch(recommendation, /低分达人/u);
  assert.match(candidates, /低分达人/u);
  assert.doesNotMatch(candidates, /高分达人/u);
});

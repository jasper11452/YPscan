import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStagedManualResearch as createManualResearch } from "./helpers/manual-staged-runner.mjs";
import { createManualFilterSelection } from "../src/tools/manual-filter-selection.js";
import { createManualResearch as createCollector } from "../src/tools/manual-research.js";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function fakeBrowser(url) {
  const page = { url: () => url };
  return { contexts: () => [{ pages: () => [page] }] };
}

function params() {
  return {
    requirement_id: "requirement-50-creators",
    platform: "xingtu",
    facts: [
      { kind: "creator_count", normalized_value: 50 },
      { kind: "creator_price", normalized_value: 20_000, operator: "lte" },
      { kind: "video_duration", normalized_value: "duration_l3" },
      { kind: "follower_count", normalized_value: 100_000, operator: "gte" },
    ],
    keywords: ["AI工具", "办公软件", "效率办公", "职场"],
  };
}

function pagedAdapter(actionLog, { captchaKeyword = null } = {}) {
  let keyword = "";
  return {
    async prepare() {
      actionLog.push(["prepare"]);
    },
    async reset() {},
    async setPriceView(value) {
      return { applied: true, readback: value };
    },
    async applyFilter(filter) {
      return { applied: true, readback: filter.control };
    },
    async search(value) {
      keyword = value;
      actionLog.push(["search", value]);
      if (value === captchaKeyword) {
        throw Object.assign(new Error("security verification"), {
          code: "YPSCAN_MANUAL_CAPTCHA_REQUIRED",
        });
      }
      return { applied: true, result_count: 500 };
    },
    async readPage(pageNumber) {
      actionLog.push(["read", keyword, pageNumber]);
      return {
        price_tier: "60s以上视频",
        source_url: `https://www.xingtu.cn/ad/creator/market?keyword=${keyword}&page=${pageNumber}`,
        collection_source: "browser_response+dom",
        rows: Array.from({ length: 20 }, (_, index) => ({
          platform_id: `${keyword}-${pageNumber}-${index + 1}`,
          nickname: `${keyword}达人${(pageNumber - 1) * 20 + index + 1}`,
          price_raw: `¥${10_000 + index}`,
          followers_raw: `${20 + index}.0w`,
          cpm_raw: String(30 + index),
          creator_gender: index % 2 ? "男" : "女",
          city: index % 2 ? "上海" : "北京",
          content_type: `${keyword} 科技数码`,
          tags: [keyword, "办公"],
        })),
      };
    },
    async nextPage() {
      return true;
    },
    async collectDetail(candidate) {
      actionLog.push(["detail", candidate.platform_id]);
      return {
        candidate_ref: candidate.platform_id,
        platform_id: candidate.platform_id,
        nickname: candidate.nickname,
        status: "complete",
        source_type: "browser_response",
        captured_at: "2026-08-17T02:00:00.000Z",
        fields: {
          followers_raw: candidate.followers_raw,
          price_by_tier: { "60s以上视频": candidate.price_raw },
          recent_content: [{ title: `${candidate.nickname}近期内容` }],
        },
      };
    },
    async export() {
      actionLog.push(["export"]);
      return { status: "complete" };
    },
  };
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

test("50-person runs checkpoint every page and return a compact review batch plus a five-sheet XLSX", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-manual-50-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const actions = [];
  const run = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => fakeBrowser("https://www.xingtu.cn/ad/creator/market"),
    createAdapter: () => pagedAdapter(actions),
    now: () => Date.UTC(2026, 7, 17, 2, 0, 0),
  });

  const data = payload(await run(params()));

  assert.equal(data.status, "partial");
  assert.equal(data.plan.target_count, 50);
  assert.equal(data.plan.collection_target, 100);
  assert.equal(
    data.candidate_count,
    120,
    "page-sized collection may safely exceed the pool target",
  );
  assert.equal(data.candidate_returned_count, 10);
  assert.equal(data.candidates_truncated, true);
  assert.equal(data.artifact.target_row_count, 0);
  assert.equal(data.artifact.detail_completed_count, 100);
  assert.equal(data.review_batch.length, 20);
  assert.equal(data.review_remaining, 100);
  assert.equal(data.artifact.candidate_row_count, 120);
  assert.equal(data.artifact.native_export_quota_consumed, false);
  assert.equal(actions.filter(([kind]) => kind === "export").length, 0);
  assert.deepEqual(
    actions.filter(([kind]) => kind === "search").map(([, keyword]) => keyword),
    ["AI工具", "办公软件", "效率办公"],
  );

  const checkpoint = await readFile(data.artifact.checkpoint_path, "utf8");
  const events = checkpoint.trim().split("\n").map(JSON.parse);
  assert.equal(events.filter((event) => event.type === "page").length, 6);
  assert.equal(events.filter((event) => event.type === "branch").length, 3);
  assert.equal(events.filter((event) => event.type === "detail").length, 100);
  assert.equal(events.at(-1).type, "final");

  const workbook = await readFile(data.artifact.excel_path);
  assert.equal(workbook.subarray(0, 2).toString("utf8"), "PK");
  const targetSheet = storedZipEntry(workbook, "xl/worksheets/sheet1.xml");
  const detailSheet = storedZipEntry(workbook, "xl/worksheets/sheet2.xml");
  const poolSheet = storedZipEntry(workbook, "xl/worksheets/sheet3.xml");
  assert.equal((targetSheet.match(/<row /gu) ?? []).length, 1);
  assert.equal((detailSheet.match(/<row /gu) ?? []).length, 121);
  assert.equal((poolSheet.match(/<row /gu) ?? []).length, 121);
  assert.match(detailSheet, /待复核/u);
});

test("the target sheet excludes candidates below the manual price floor", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-manual-price-gate-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const rows = [14_300, 19_800, 20_000, 8_000, 6_200].map((price, index) => ({
    platform_id: `price-${index + 1}`,
    nickname: `报价达人${index + 1}`,
    detail_url: `https://www.xingtu.cn/creator/price-${index + 1}`,
    price_raw: `¥${price}`,
    followers_raw: "20万",
  }));
  const run = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => browser,
    createAdapter: () => ({
      async prepare() {},
      async reset() {},
      async setPriceView(value) {
        return { applied: true, readback: value };
      },
      async applyFilter() {
        return { applied: true };
      },
      async search() {
        return { applied: true, result_count: rows.length };
      },
      async readPage() {
        return {
          price_tier: "60s以上",
          source_url: browser.contexts()[0].pages()[0].url(),
          rows,
        };
      },
      async nextPage() {
        return false;
      },
      async collectDetail(candidate) {
        return {
          candidate_ref: candidate.platform_id,
          platform_id: candidate.platform_id,
          nickname: candidate.nickname,
          detail_url: candidate.detail_url,
          status: "complete",
          source_type: "browser_response",
          captured_at: "2026-08-17T02:00:00.000Z",
          fields: {
            followers_raw: candidate.followers_raw,
            price_by_tier: { "60s以上视频": candidate.price_raw },
            recent_content: [{ title: `${candidate.nickname}近期内容` }],
          },
        };
      },
      async export() {
        return { status: "complete" };
      },
    }),
  });

  const data = payload(
    await run({
      requirement_id: "price-gate-five",
      platform: "xingtu",
      facts: [
        { kind: "creator_count", normalized_value: 5 },
        { kind: "creator_price", normalized_value: 20_000, operator: "lte" },
        { kind: "video_duration", normalized_value: "duration_l3" },
      ],
      keywords: ["办公软件"],
    }),
  );

  assert.equal(data.candidate_count, 5);
  assert.equal(data.eligible_candidate_count, 3);
  assert.equal(data.rejected_candidate_count, 2);
  assert.equal(data.delivery_shortfall, 5);
  assert.equal(data.delivery_status, "pending_review");
  assert.equal(data.artifact.target_row_count, 0);
  assert.equal(data.artifact.delivery_shortfall, 5);
  assert.equal(data.review_remaining, 3);
  assert.equal(
    data.detail_tasks.some((task) => ["price-4", "price-5"].includes(task.candidate_ref)),
    false,
  );

  const reviewed = payload(
    await run({
      operation: "apply_reviews",
      requirement_id: "price-gate-five",
      platform: "xingtu",
      run_id: data.artifact.run_id,
      reviews: data.review_batch.map((task) => ({
        candidate_ref: task.candidate_ref,
        decision: "include",
        reasons: ["近期内容与需求相关"],
        evidence: [task.recent_content[0].title],
      })),
    }),
  );
  assert.equal(reviewed.status, "complete");
  assert.equal(reviewed.review_remaining, 0);
  assert.equal(reviewed.artifact.target_row_count, 3);
  assert.equal(reviewed.artifact.excel_path, data.artifact.excel_path);

  const workbook = await readFile(reviewed.artifact.excel_path);
  const targetSheet = storedZipEntry(workbook, "xl/worksheets/sheet1.xml");
  const poolSheet = storedZipEntry(workbook, "xl/worksheets/sheet3.xml");
  assert.equal((targetSheet.match(/<row /gu) ?? []).length, 4);
  assert.equal((poolSheet.match(/<row /gu) ?? []).length, 6);
  assert.match(poolSheet, /报价不在要求区间，不得推荐/u);
});

test("a restarted 50-person run restores its checkpoint and skips completed keyword branches", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-manual-resume-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const firstActions = [];
  const firstAdapter = pagedAdapter(firstActions, { captchaKeyword: "办公软件" });
  firstAdapter.verifySelection = async () => ({ valid: true });
  const firstOptions = {
    workspaceDir,
    connectOverCDP: async () => browser,
    createAdapter: () => firstAdapter,
    now: () => Date.UTC(2026, 7, 17, 2, 0, 0),
  };
  const firstSelect = createManualFilterSelection(firstOptions);
  const firstCollect = createCollector(firstOptions);
  const firstSelection = payload(await firstSelect(params()));
  const firstBranch = payload(await firstCollect(firstSelection.collection_args));
  assert.equal(firstBranch.status, "awaiting_filter_selection");
  assert.equal(firstBranch.candidate_count, 40);
  const interrupted = payload(await firstSelect(firstBranch.next_selection_args));
  assert.equal(interrupted.status, "needs_user_action");
  assert.equal(interrupted.run_id, firstSelection.run_id);
  assert.equal(interrupted.branch.branch_index, 1);

  const resumedActions = [];
  const resumedAdapter = pagedAdapter(resumedActions);
  resumedAdapter.verifySelection = async () => ({ valid: true });
  const resumedOptions = {
    workspaceDir,
    connectOverCDP: async () => browser,
    createAdapter: () => resumedAdapter,
    now: () => Date.UTC(2026, 7, 17, 2, 1, 0),
  };
  const resumedSelect = createManualFilterSelection(resumedOptions);
  const resumedCollect = createCollector(resumedOptions);
  let resumedSelection = payload(
    await resumedSelect({
      requirement_id: params().requirement_id,
      platform: params().platform,
      run_id: interrupted.run_id,
      branch_index: 1,
    }),
  );
  let resumed = payload(await resumedCollect(resumedSelection.collection_args));
  while (resumed.status === "awaiting_filter_selection") {
    resumedSelection = payload(await resumedSelect(resumed.next_selection_args));
    resumed = payload(await resumedCollect(resumedSelection.collection_args));
  }

  assert.equal(resumed.status, "partial");
  assert.equal(resumed.candidate_count, 120);
  assert.equal(resumed.artifact.restored_candidate_count, 80);
  assert.equal(resumed.artifact.target_row_count, 0);
  assert.equal(resumed.artifact.detail_completed_count, 100);
  assert.equal(resumed.candidates_truncated, true);
  assert.deepEqual(
    resumedActions.filter(([kind]) => kind === "search").map(([, keyword]) => keyword),
    ["办公软件", "效率办公"],
    "the completed first branch must not be repeated after restart",
  );
  assert.equal(resumedActions.filter(([kind]) => kind === "export").length, 0);
});

test("fresh_run creates an isolated live run instead of restoring a completed checkpoint", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-manual-fresh-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const firstActions = [];
  const secondActions = [];
  const firstRun = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => browser,
    createAdapter: () => pagedAdapter(firstActions),
    now: () => Date.UTC(2026, 7, 17, 2, 0, 0),
  });
  const secondRun = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => browser,
    createAdapter: () => pagedAdapter(secondActions),
    now: () => Date.UTC(2026, 7, 17, 2, 1, 0),
  });

  const first = payload(await firstRun({ ...params(), fresh_run: true }));
  const second = payload(await secondRun({ ...params(), fresh_run: true }));

  assert.equal(first.status, "partial");
  assert.equal(second.status, "partial");
  assert.notEqual(first.artifact.checkpoint_path, second.artifact.checkpoint_path);
  assert.notEqual(first.artifact.excel_path, second.artifact.excel_path);
  assert.equal(first.artifact.restored_candidate_count, 80);
  assert.equal(second.artifact.restored_candidate_count, 80);
  assert.deepEqual(
    secondActions.filter(([kind]) => kind === "search").map(([, keyword]) => keyword),
    ["AI工具", "办公软件", "效率办公"],
  );
  assert.equal(secondActions.filter(([kind]) => kind === "export").length, 0);

  assert.notEqual(first.artifact.run_id, second.artifact.run_id);
});

test("detail resume skips creators whose detail checkpoint already completed", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-detail-resume-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const rows = Array.from({ length: 3 }, (_, index) => ({
    platform_id: `resume-detail-${index + 1}`,
    nickname: `续跑达人${index + 1}`,
    followers_raw: "20万",
  }));
  const baseAdapter = (detailHandler) => ({
    async prepare() {},
    async reset() {},
    async setPriceView(value) {
      return { applied: true, readback: value };
    },
    async applyFilter() {
      return { applied: true };
    },
    async search() {
      return { applied: true, result_count: rows.length };
    },
    async readPage() {
      return { rows, source_url: browser.contexts()[0].pages()[0].url() };
    },
    async nextPage() {
      return false;
    },
    collectDetail: detailHandler,
    async paceDetail() {},
    async export() {
      return { status: "complete" };
    },
  });
  const runParams = {
    requirement_id: "detail-resume",
    platform: "xingtu",
    facts: [{ kind: "creator_count", normalized_value: 2 }],
    keywords: ["办公软件"],
  };
  let firstAttempts = 0;
  const firstRun = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => browser,
    createAdapter: () =>
      baseAdapter(async (candidate) => {
        firstAttempts += 1;
        if (candidate.platform_id === "resume-detail-2") {
          throw Object.assign(new Error("429"), {
            code: "YPSCAN_MANUAL_DETAIL_RISK_SIGNAL",
          });
        }
        return {
          candidate_ref: candidate.platform_id,
          status: "complete",
          fields: { followers_raw: candidate.followers_raw, recent_content: [{ title: "证据" }] },
        };
      }),
  });
  const interrupted = payload(await firstRun(runParams));
  assert.equal(interrupted.status, "needs_user_action");
  assert.equal(interrupted.detail_collection.completed_count, 1);
  assert.equal(firstAttempts, 2);

  const resumedIds = [];
  const resumedRun = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => browser,
    createAdapter: () =>
      baseAdapter(async (candidate) => {
        resumedIds.push(candidate.platform_id);
        return {
          candidate_ref: candidate.platform_id,
          status: "complete",
          fields: { followers_raw: candidate.followers_raw, recent_content: [{ title: "证据" }] },
        };
      }),
  });
  const resumed = payload(await resumedRun(runParams));
  assert.deepEqual(resumedIds, ["resume-detail-2", "resume-detail-3"]);
  assert.equal(resumed.detail_collection.completed_count, 3);
  assert.equal(resumed.artifact.excel_path, interrupted.artifact.excel_path);
});

test("apply_reviews returns successive batches until the same workbook is complete", async (t) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-review-batches-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const browser = fakeBrowser("https://www.xingtu.cn/ad/creator/market");
  const rows = Array.from({ length: 25 }, (_, index) => ({
    platform_id: `batch-${index + 1}`,
    nickname: `批次达人${index + 1}`,
  }));
  const run = createManualResearch({
    workspaceDir,
    connectOverCDP: async () => browser,
    createAdapter: () => ({
      async prepare() {},
      async reset() {},
      async setPriceView(value) {
        return { applied: true, readback: value };
      },
      async applyFilter() {
        return { applied: true };
      },
      async search() {
        return { applied: true, result_count: rows.length };
      },
      async readPage() {
        return { rows, source_url: browser.contexts()[0].pages()[0].url() };
      },
      async nextPage() {
        return false;
      },
      async collectDetail(candidate) {
        return {
          candidate_ref: candidate.platform_id,
          status: "complete",
          fields: { recent_content: [{ title: `${candidate.nickname}办公内容` }] },
        };
      },
      async paceDetail() {},
      async export() {
        return { status: "complete" };
      },
    }),
  });
  const collect = payload(
    await run({
      requirement_id: "review-batches",
      platform: "xingtu",
      facts: [{ kind: "creator_count", normalized_value: 15 }],
      keywords: ["办公软件"],
    }),
  );
  assert.equal(collect.review_batch.length, 20);
  assert.equal(collect.review_remaining, 25);

  const review = (task) => ({
    candidate_ref: task.candidate_ref,
    decision: "include",
    reasons: ["内容相关"],
    evidence: [task.recent_content[0].title],
  });
  const firstBatch = payload(
    await run({
      operation: "apply_reviews",
      requirement_id: "review-batches",
      platform: "xingtu",
      run_id: collect.artifact.run_id,
      reviews: collect.review_batch.map(review),
    }),
  );
  assert.equal(firstBatch.status, "reviewing");
  assert.equal(firstBatch.review_batch.length, 5);
  assert.equal(firstBatch.review_remaining, 5);
  assert.equal(firstBatch.artifact.excel_path, collect.artifact.excel_path);

  const finalBatch = payload(
    await run({
      operation: "apply_reviews",
      requirement_id: "review-batches",
      platform: "xingtu",
      run_id: collect.artifact.run_id,
      reviews: firstBatch.review_batch.map(review),
    }),
  );
  assert.equal(finalBatch.status, "complete");
  assert.equal(finalBatch.review_remaining, 0);
  assert.equal(finalBatch.artifact.target_row_count, 15);
  assert.equal(finalBatch.artifact.excel_path, collect.artifact.excel_path);
});

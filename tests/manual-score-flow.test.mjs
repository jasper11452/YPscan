import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin from "../index.js";
import { previewFixture } from "./helpers/creator-preview-fixture.mjs";

function canonicalValidateParams(businessMode, quantityTotal = 30) {
  return {
    platform: "douyin",
    brandName: ["测试品牌"],
    projectName: "测试项目",
    quantityTotal,
    submissionDeadlineAt: "2099-08-25 12:00:00",
    rebate: "25%以上",
    followercount: [0, 999999999],
    contentTag: ["科技", "耳机"],
    rawMessagesJson: JSON.stringify({
      original: `抖音项目：测试项目；品牌：测试品牌；定制视频；${quantityTotal}位；单价5万元；返点25%以上；粉丝不限；提报截止2099-08-25 12:00:00；科技耳机方向。`,
      parse_outputs: { dybrandName: ["测试品牌"] },
      business_mode: businessMode,
    }),
    kolOfficialPriceL3: 50000,
  };
}

async function setup(t, mode = "手动拓展") {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ypscan-score-flow-"));
  t.after(() => rm(workspaceDir, { recursive: true, force: true }));
  const context = { workspaceDir, sessionKey: "score-flow" };
  const hooks = new Map();
  const tools = new Map();
  const downloads = new Map();
  plugin.register({
    fetch: async (url) => new Response(downloads.get(String(url)), { status: 200 }),
    registerTool(tool) {
      const value = typeof tool === "function" ? tool(context) : tool;
      tools.set(value.name, value);
    },
    on(name, fn) {
      hooks.set(name, fn);
    },
  });
  let seq = 0;
  function before(name, params) {
    const toolCallId = `call-${++seq}`;
    const result = hooks.get("before_tool_call")({ toolName: name, params, toolCallId }, context);
    assert.notEqual(result?.block, true, result?.blockReason);
    return { toolName: name, toolCallId, params: result?.params ?? params };
  }
  function persist(event, result) {
    const message = result.content
      ? { role: "toolResult", ...result }
      : { role: "toolResult", content: [{ type: "text", text: JSON.stringify(result) }] };
    const amended = hooks.get("tool_result_persist")({ ...event, message }, context);
    return amended?.message?.content?.at(-1)?.text ?? "";
  }
  function remote(name, params, result) {
    return persist(before(name, params), result);
  }
  async function local(name, params) {
    const event = before(name, params);
    const result = await tools.get(name).execute(event.toolCallId, params);
    return { payload: JSON.parse(result.content[0].text), directive: persist(event, result) };
  }
  remote("validate_requirement", canonicalValidateParams(mode, 10), {
    success: true,
    data: { requirement_id: "req" },
  });
  const ids = Array.from({ length: 30 }, (_, i) => `7324533389695025${String(i).padStart(3, "0")}`);
  const links = [
    "source_record_id,creator_id,url",
    ...ids.map(
      (id, i) => `${i},${id},https://www.xingtu.cn/ad/creator/author-homepage/douyin-video/${id}`,
    ),
  ].join("\n");
  downloads.set("https://eshypdata.com/links.csv", links);
  const saved = await local("ypscan_save_artifact", {
    artifact_kind: "manual_creator_links",
    artifact_id: "req",
    file_url: "https://eshypdata.com/links.csv",
  });
  assert.equal(saved.payload.success, true);
  const normalized = await local("ypscan_save_creator_links", {
    requirement_id: "req",
    platform: "douyin",
    links_csv_path: saved.payload.data.file_path,
  });
  assert.equal(normalized.payload.success, true, JSON.stringify(normalized.payload));
  let batch = 0;
  async function score(selected, recommended) {
    batch++;
    const path = join(workspaceDir, `completion-${batch}.csv`);
    await writeFile(path, "creator_id\n" + selected.join("\n"));
    const completionDirective = remote(
      "get_douyin_author_business_card",
      {},
      { csv_file: path, successful_author_ids: selected, failed_author_ids: [] },
    );
    remote(
      "score_manual_source_csv",
      { requirement_id: "req", csv_file_path: `https://example.invalid/batch-${batch}.csv` },
      { success: true, data: { job_id: `job-${batch}` } },
    );
    const url = `https://eshypdata.com/score-${batch}.xlsx`;
    const resultDirective = remote(
      "score_manual_source_csv_status",
      { job_id: `job-${batch}` },
      { success: true, data: { excel_file_url: url } },
    );
    const args = JSON.parse(
      resultDirective
        .split("\n")
        .find((line) => line.startsWith("SAVE_ARTIFACT_ARGS="))
        .slice("SAVE_ARTIFACT_ARGS=".length),
    );
    const workbook = previewFixture(workspaceDir, {
      name: `fixture-${batch}.xlsx`,
      rows: [
        ["需求ID", "req"],
        ["平台", "星图ID", "综合得分", "推荐结论"],
        ...selected.map((id, i) => ["douyin", id, "80", i < recommended ? "推荐" : "不推荐"]),
      ],
    });
    const { readFile } = await import("node:fs/promises");
    downloads.set(url, await readFile(workbook.file_path));
    const savedScore = await local("ypscan_save_artifact", args);
    assert.equal(savedScore.payload.success, true);
    return { completionDirective, args, savedScore };
  }
  return { ids, normalized, score, local, hooks, remote, context, workspaceDir };
}

test("registered tools: initial batch respects the target, first batch sufficient, save then summarize and stop", async (t) => {
  const f = await setup(t);
  assert.match(f.normalized.directive, /SUMMARIZE_MANUAL_SCORES_ARGS=/u);
  const first = await f.local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.deepEqual(first.payload.data.next_author_ids, f.ids.slice(0, 10));
  assert.doesNotMatch(first.directive, /auth_prepare/u);
  const batch = await f.score(f.ids.slice(0, 10), 10);
  assert.match(batch.completionDirective, /只合并上传当前批/u);
  assert.match(batch.completionDirective, /补全 CSV 是内部中间产物，不主动向用户展示表格或链接/u);
  const bridgeArgs = JSON.parse(
    batch.completionDirective
      .split("\n")
      .find((s) => s.startsWith("FILE_BRIDGE_ARGS="))
      .slice("FILE_BRIDGE_ARGS=".length),
  );
  assert.equal(bridgeArgs.completion_csv_paths.length, 1);
  assert.equal(batch.args.artifact_kind, "manual_score_batch");
  assert.match(batch.savedScore.directive, /SCORE_BATCH_LOCAL_LINK=/u);
  assert.match(batch.savedScore.directive, /展示本地链接/u);
  assert.match(batch.savedScore.directive, /SUMMARIZE_MANUAL_SCORES_ARGS=/u);
  const last = await f.local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.equal(last.payload.success, true);
  assert.equal(last.payload.data.recommended_count, 10);
  assert.equal(last.payload.data.next_action, "deliver");
  assert.deepEqual(last.payload.data.next_author_ids, []);
  assert.match(last.directive, /禁止继续补全或评分/u);
  assert.match(last.directive, /展示最终汇总/u);
});

test("registered tools: 6 plus 4 recommendations advance exactly once and deliver 30 scored", async (t) => {
  const f = await setup(t);
  await f.score(f.ids.slice(0, 10), 6);
  const next = await f.local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.equal(next.payload.success, true);
  assert.deepEqual(next.payload.data.next_author_ids, f.ids.slice(10));
  await f.score(f.ids.slice(10), 4);
  const last = await f.local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.equal(last.payload.data.scored_count, 30);
  assert.equal(last.payload.data.recommended_count, 10);
  assert.equal(last.payload.data.next_action, "deliver");
  await f.hooks.get("gateway_stop")();
  const reset = await f.local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.equal(reset.payload.success, false);
});

test("inquiry uses all completion batches and final artifact, never manual early stop", async (t) => {
  const f = await setup(t, "询价机构");
  assert.doesNotMatch(f.normalized.directive, /SUMMARIZE_MANUAL_SCORES_ARGS=/u);
  const batch = await f.score(f.ids.slice(0, 20), 10);
  assert.match(batch.completionDirective, /汇总全部补全批次/u);
  assert.equal(batch.args.artifact_kind, "manual_source");
  assert.doesNotMatch(batch.savedScore.directive, /SUMMARIZE_MANUAL_SCORES_ARGS=/u);
  const summary = await f.local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.equal(summary.payload.success, false);
});

test("inquiry mis-saved as a manual batch delivers the saved file without scheduling summary", async (t) => {
  const f = await setup(t, "询价机构");
  const batch = await f.score(f.ids.slice(0, 5), 3);
  const saved = await f.local("ypscan_save_artifact", {
    ...batch.args,
    artifact_kind: "manual_score_batch",
  });
  assert.equal(saved.payload.success, true);
  assert.equal(saved.payload.data.file_path, batch.savedScore.payload.data.file_path);
  assert.match(saved.directive, /最终交付物/u);
  assert.ok(saved.directive.includes(saved.payload.delivery.local_file_link));
  assert.doesNotMatch(saved.directive, /SUMMARIZE_MANUAL_SCORES_ARGS|ASK_USER_QUESTION_ARGS/u);
});

test("manual batch save without its own requirement mode stops instead of inheriting session mode", async (t) => {
  const f = await setup(t, "询价机构");
  const batch = await f.score(f.ids.slice(0, 5), 3);
  const saved = await f.local("ypscan_save_artifact", {
    ...batch.args,
    artifact_id: "req-without-mode",
    artifact_kind: "manual_score_batch",
  });
  assert.equal(saved.payload.success, true);
  assert.match(saved.directive, /缺少当前 requirement 的已登记业务模式/u);
  assert.match(saved.directive, /停止/u);
  assert.doesNotMatch(saved.directive, /最终交付物|SUMMARIZE_MANUAL_SCORES_ARGS|ASK_USER_QUESTION_ARGS/u);
});

test("inquiry summary misuse is distinct from missing context and never requests retry", async (t) => {
  const f = await setup(t, "询价机构");
  const result = await f.local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.equal(result.payload.error.code, "YPSCAN_MANUAL_SCORE_MODE_NOT_APPLICABLE");
  assert.equal(result.payload.error.retriable, false);
  assert.equal(result.payload.delivery, undefined);
  assert.match(result.directive, /当前需求已成功保存/u);
  assert.match(result.directive, /没有可信保存结果/u);
  assert.doesNotMatch(result.directive, /ASK_USER_QUESTION_ARGS|SUMMARIZE_MANUAL_SCORES_ARGS/u);
  await f.hooks.get("gateway_stop")();
  const missing = await f.local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.equal(missing.payload.error.code, "YPSCAN_MANUAL_SCORE_CONTEXT_UNAVAILABLE");
  assert.match(missing.directive, /停止/u);
  assert.doesNotMatch(missing.directive, /最终交付|ASK_USER_QUESTION_ARGS/u);
});

test("manual sourcing compatibility Excel still delivers without batch summary", async (t) => {
  const f = await setup(t);
  const batch = await f.score(f.ids.slice(0, 5), 3);
  const saved = await f.local("ypscan_save_artifact", {
    ...batch.args,
    artifact_kind: "manual_source",
  });
  assert.equal(saved.payload.success, true);
  assert.match(saved.directive, /最终交付物/u);
  assert.doesNotMatch(saved.directive, /SUMMARIZE_MANUAL_SCORES_ARGS/u);
});

test("registered tools: an all-failed batch is registered and a successful retry supersedes it", async (t) => {
  const f = await setup(t);
  const { ids, local, remote, workspaceDir } = f;
  remote(
    "get_douyin_author_business_card",
    {},
    {
      csv_file: null,
      successful_author_ids: [],
      failed_author_ids: ids.slice(0, 20),
    },
  );
  const next = await local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.equal(next.payload.success, true, JSON.stringify(next.payload));
  assert.equal(next.payload.data.completion_failed_count, 20);
  assert.deepEqual(next.payload.data.next_author_ids, ids.slice(20));

  // 用户明确要求后重试同一批成功：失败记录被成功取代，不产生成功/失败名单冲突。
  const retryPath = join(workspaceDir, "completion-retry.csv");
  await writeFile(retryPath, "creator_id\n" + ids.slice(0, 20).join("\n"));
  remote(
    "get_douyin_author_business_card",
    {},
    {
      csv_file: retryPath,
      successful_author_ids: ids.slice(0, 20),
      failed_author_ids: [],
    },
  );
  const after = await local("ypscan_summarize_manual_scores", { requirement_id: "req" });
  assert.equal(after.payload.success, true, JSON.stringify(after.payload));
  assert.equal(after.payload.data.completion_failed_count, 0);
  assert.equal(after.payload.data.next_action, "await_scores");
  assert.deepEqual(after.payload.data.pending_score_author_ids, ids.slice(0, 20));
  assert.match(after.directive, /progress\.user_visible_message/u);
  assert.match(after.directive, /不代表最终汇总/u);
  assert.match(after.directive, /MANUAL_SCORE_PENDING_AUTHOR_IDS=\[/u);
  assert.match(after.directive, /任务已终态仍缺行/u);
});

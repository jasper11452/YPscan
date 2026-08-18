import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { registerWecomConfirmationOnlyHooks } from "../src/hooks/register-wecom-confirmation-only.js";

function registeredHooks({ skillPath = null } = {}) {
  const hooks = new Map();
  registerWecomConfirmationOnlyHooks(
    {
      on(name, handler) {
        hooks.set(name, handler);
      },
    },
    { now: () => 1, skillPath },
  );
  return hooks;
}

function toolMessage(payload) {
  return {
    role: "toolResult",
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function directiveText(result) {
  return result?.message?.content?.at(-1)?.text ?? "";
}

function argsFromDirective(text) {
  const line = text.split("\n").find((item) => item.startsWith("ASK_USER_QUESTION_ARGS="));
  return JSON.parse(line.slice("ASK_USER_QUESTION_ARGS=".length));
}

function validateArgsFromDirective(text) {
  const line = text.split("\n").find((item) => item.startsWith("VALIDATE_REQUIREMENT_ARGS="));
  return JSON.parse(line.slice("VALIDATE_REQUIREMENT_ARGS=".length));
}

function saveExcelArgsFromDirective(text) {
  const line = text.split("\n").find((item) => item.startsWith("SAVE_EXCEL_ARTIFACT_ARGS="));
  return JSON.parse(line.slice("SAVE_EXCEL_ARTIFACT_ARGS=".length));
}

function namedArgsFromDirective(text, name) {
  const prefix = `${name}=`;
  const line = text.split("\n").find((item) => item.startsWith(prefix));
  return JSON.parse(line.slice(prefix.length));
}

test("startup skill defers Browser branch details to platform references", () => {
  const skill = readFileSync(
    new URL("../skills/media-assistant/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.ok(Buffer.byteLength(skill) <= 8_000);
  assert.match(skill, /references\/xingtu-browser-handpick\.md/u);
  assert.match(skill, /references\/pgy-browser-handpick\.md/u);
  assert.match(skill, /references\/tools\/ypscan_manual_select_filters\.md/u);
  assert.match(skill, /references\/tools\/ypscan_manual_research\.md/u);
  assert.match(skill, /包括 `test`/u);
  assert.match(skill, /多个可用工具映射到同一实际名称时才调用 `AskUserQuestion`/u);
});

test("fixed result directives enforce parse → validate → search → save → rank", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const parse = persist({
    toolName: "ypscan_parse_requirement",
    message: toolMessage({
      success: true,
      data: {
        projections: {
          provider: {
            ready: true,
            search_jobs: [
              {
                params: {
                  status: "ready",
                  createdAt: "2026-08-15 23:03:30",
                  updatedAt: "2026-08-15 23:03:30",
                  platform: "douyin",
                },
              },
            ],
          },
        },
      },
    }),
  });
  const parseText = directiveText(parse);
  assert.match(parseText, /下一步固定调用 validate_requirement/u);
  assert.match(parseText, /不得调用 Browser/u);
  assert.match(parseText, /整体作为顶层参数传入/u);
  assert.match(parseText, /不得手工重建、增删字段、重算区间或改 createdAt\/updatedAt/u);
  assert.deepEqual(validateArgsFromDirective(parseText), {
    status: "ready",
    createdAt: "2026-08-15 23:03:30",
    updatedAt: "2026-08-15 23:03:30",
    platform: "douyin",
  });

  const validate = persist({
    toolName: "ypmcn__validate_requirement",
    message: toolMessage({ success: true, data: { id: "a".repeat(32) } }),
  });
  assert.match(directiveText(validate), /下一步固定调用 search_creators/u);

  const search = persist({
    toolName: "ypmcn__search_creators",
    params: { id: "req-1" },
    message: toolMessage({
      success: true,
      data: {
        total_matched: 0,
        creators_export_path:
          "https://mcp.eshypdata.com/api/download?file_path=creator-preview.xlsx",
      },
    }),
  });
  const searchText = directiveText(search);
  assert.match(searchText, /下一步立即.*调用 ypscan_save_excel_artifact/u);
  assert.match(searchText, /不向用户展示 excel_file_url/u);
  assert.doesNotMatch(searchText, /CREATORS_EXPORT_PATH=/u);
  assert.deepEqual(saveExcelArgsFromDirective(searchText), {
    artifact_kind: "creator_preview",
    artifact_id: "req-1",
    excel_file_url: "https://mcp.eshypdata.com/api/download?file_path=creator-preview.xlsx",
  });
  assert.match(searchText, /不得用 Browser、shell、curl、web_fetch、Python 或通用文件写入代替/u);

  const rank = persist({
    toolName: "ypmcn__rank_mcns",
    message: toolMessage({ success: true, data: { mcns: [{ agency_name: "机构 A" }] } }),
  });
  assert.match(directiveText(rank), /完整 MCN Markdown 表格/u);
  assert.match(directiveText(rank), /用户可见正文文本块/u);
  assert.match(directiveText(rank), /\| 机构名 \| 返点 \| 综合分 \| 本机构预估覆盖达人数 \|/u);
  assert.match(directiveText(rank), /禁止改成项目符号或编号列表/u);
  assert.match(directiveText(rank), /机构名、返点、综合分、本机构预估覆盖达人数/u);
  assert.match(directiveText(rank), /candidate_count 原值/u);
  assert.match(directiveText(rank), /严禁使用累计字段 mcn_covered_creator_count/u);
  assert.match(directiveText(rank), /严禁与前序机构累加/u);
  assert.match(directiveText(rank), /不得用累计\/聚合覆盖字段或相邻行差值替代/u);
  assert.match(directiveText(rank), /表格不得放入弹窗 question/u);
  assert.match(directiveText(rank), /不要输出达人预览表下载链接/u);
  assert.match(directiveText(rank), /CREATOR_PREVIEW_LOCAL_PATH/u);
  assert.match(directiveText(rank), /本地 file_path 不得放入弹窗 question/u);
  assert.match(directiveText(rank), /不得在 AskUserQuestion 返回后补发/u);
  assert.match(directiveText(rank), /ypscan_manual_research\(operation=start\)/u);
  assert.match(directiveText(rank), /宿主原生 Browser 自主/u);
  assert.match(directiveText(rank), /capture_list\/capture_detail/u);
  assert.doesNotMatch(directiveText(rank), /selection_id/u);
  const question = argsFromDirective(directiveText(rank));
  assert.deepEqual(
    question.questions[0].options.map((option) => option.label),
    ["询价机构", "人工拓展并提报"],
  );
  assert.match(question.questions[0].question, /弹窗打开前已在对话中完整展示/u);
  assert.match(question.questions[0].question, /达人预览表本地文件路径/u);
  assert.doesNotMatch(question.questions[0].question, /下载链接/u);
  assert.doesNotMatch(question.questions[0].question, /\| 机构名 \|/u);
});

test("creator preview save keeps the local path and continues to rank", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const params = {
    artifact_kind: "creator_preview",
    artifact_id: "req-1",
    excel_file_url: "https://mcp.eshypdata.com/api/download?file_path=creator-preview.xlsx",
  };
  const saved = persist({
    toolName: "ypscan_save_excel_artifact",
    params,
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/creator-preview.xlsx" },
      delivery: { local_path: "/workspace/creator-preview.xlsx" },
    }),
  });
  const savedText = directiveText(saved);
  assert.match(savedText, /达人预览表 Excel 已保存到当前项目/u);
  assert.match(savedText, /CREATOR_PREVIEW_LOCAL_PATH=\/workspace\/creator-preview\.xlsx/u);
  assert.match(savedText, /下一步固定调用 rank_mcns/u);
  assert.match(savedText, /完整 MCN Markdown 表格之后原样展示/u);
  assert.match(savedText, /不得.*重复下载/u);

  const failed = persist({
    toolName: "ypscan_save_excel_artifact",
    params,
    message: toolMessage({ success: false, error: { code: "YPSCAN_EXCEL_DOWNLOAD_FAILED" } }),
  });
  const failedText = directiveText(failed);
  assert.match(failedText, /达人预览表保存 已暂停/u);
  assert.deepEqual(
    argsFromDirective(failedText).questions[0].options.map((option) => option.label),
    ["重试", "结束本次"],
  );
});

test("institutional retrieval continues through ingest Excel save, creator rank and submission", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const synced = persist({
    toolName: "test__sync_mcn_inquiry_status",
    message: toolMessage({
      success: true,
      data: { inquiries: [{ inquiry_id: 12 }, { inquiry_id: "13" }] },
    }),
  });
  assert.deepEqual(namedArgsFromDirective(directiveText(synced), "INGEST_MCN_SUBMISSIONS_ARGS"), {
    inquiry_ids: ["12", "13"],
  });

  const ingested = persist({
    toolName: "test__ingest_mcn_submissions",
    params: { inquiry_ids: ["12", "13"] },
    message: toolMessage({
      success: true,
      data: {
        requirement_id: "req-ingest",
        excel_file_url: "https://files.eshypdata.com/exports/mcn-preview.xlsx",
      },
    }),
  });
  assert.match(
    directiveText(ingested),
    /MCN_CREATOR_PREVIEW_URL=https:\/\/files\.eshypdata\.com\/exports\/mcn-preview\.xlsx/u,
  );
  assert.match(directiveText(ingested), /原始 URL 直接输出为单独一行用户可见正文/u);
  assert.deepEqual(saveExcelArgsFromDirective(directiveText(ingested)), {
    artifact_kind: "mcn_creator_preview",
    artifact_id: "req-ingest",
    excel_file_url: "https://files.eshypdata.com/exports/mcn-preview.xlsx",
  });

  const previewSaved = persist({
    toolName: "ypscan_save_excel_artifact",
    params: {
      artifact_kind: "mcn_creator_preview",
      artifact_id: "req-ingest",
      excel_file_url: "https://files.eshypdata.com/exports/mcn-preview.xlsx",
    },
    message: toolMessage({ success: true, data: { file_path: "/workspace/mcn-preview.xlsx" } }),
  });
  assert.deepEqual(namedArgsFromDirective(directiveText(previewSaved), "RANK_CREATORS_ARGS"), {
    requirement_id: "req-ingest",
  });

  const ranked = persist({
    toolName: "test__rank_creators",
    params: { requirement_id: "req-ingest" },
    message: toolMessage({ success: true, data: { ranked_count: 8 } }),
  });
  assert.deepEqual(namedArgsFromDirective(directiveText(ranked), "CREATE_SUBMISSION_BATCH_ARGS"), {
    requirement_id: "req-ingest",
    submission_batche_page: 1,
  });

  const submission = persist({
    toolName: "test__create_submission_batch",
    params: { requirement_id: "req-ingest", submission_batche_page: 1 },
    message: toolMessage({
      success: true,
      data: {
        batch_id: "batch-1",
        excel_file_url: "https://files.eshypdata.com/exports/submission.xlsx",
      },
    }),
  });
  assert.deepEqual(saveExcelArgsFromDirective(directiveText(submission)), {
    artifact_kind: "submission_batch",
    artifact_id: "batch-1",
    excel_file_url: "https://files.eshypdata.com/exports/submission.xlsx",
  });
});

test("successful WeCom distribution asks whether to continue manual expansion", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "test__create_with_distributions",
    message: toolMessage({
      success: true,
      data: {
        send_status: {
          sent_suppliers: [{ supplier_id: "a" }],
          failed_suppliers: [],
        },
      },
    }),
  });
  const question = argsFromDirective(directiveText(result)).questions[0];
  assert.deepEqual(
    question.options.map((option) => option.label),
    ["继续人工拓展", "暂不拓展"],
  );
  assert.match(question.question, /成功机构：1 家\n失败机构：0 家/u);
});

test("manual research success directive makes the local Excel the primary large-result delivery", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypscan_manual_research",
    message: toolMessage({
      success: true,
      status: "complete",
      candidate_count: 120,
      artifact: {
        target_row_count: 50,
        excel_path: "/workspace/ypscan-manual-research/result.xlsx",
      },
    }),
  });
  const directive = directiveText(result);
  assert.match(
    directive,
    /MANUAL_RESEARCH_EXCEL_PATH=\/workspace\/ypscan-manual-research\/result\.xlsx/u,
  );
  assert.match(directive, /必须把上面的 Excel 绝对路径原样作为主要交付展示/u);
  assert.match(directive, /不消耗平台导出额度/u);
  assert.match(directive, /禁止在对话粘贴完整名单/u);
  assert.match(directive, /最多 10 条预览/u);
  assert.match(directive, /不得把平台硬筛结果表述为已经完成语义复核/u);
});

test("completed manual research asks for inquiry or a local submission workbook", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypscan_manual_research",
    message: toolMessage({
      success: true,
      status: "complete",
      operation: "apply_reviews",
      requirement_id: "req-manual",
      platform: "xingtu",
      review_remaining: 0,
      delivery_shortfall: 2,
      plan: { target_count: 10 },
      artifact: {
        run_id: "run-manual",
        target_row_count: 8,
        excel_path: "/workspace/manual.xlsx",
      },
    }),
  });
  const text = directiveText(result);
  assert.deepEqual(
    argsFromDirective(text).questions[0].options.map((option) => option.label),
    ["继续询价", "直接生成提报表"],
  );
  assert.deepEqual(namedArgsFromDirective(text, "MANUAL_SUBMISSION_ARGS"), {
    operation: "create_submission",
    requirement_id: "req-manual",
    platform: "xingtu",
    run_id: "run-manual",
  });
});

test("manual research shortfall directive forbids padding rejected price candidates", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypscan_manual_research",
    message: toolMessage({
      success: true,
      status: "partial",
      candidate_count: 5,
      eligible_candidate_count: 3,
      rejected_candidate_count: 2,
      needs_review_candidate_count: 0,
      delivery_shortfall: 2,
      delivery_status: "shortfall",
      plan: {
        target_count: 5,
        planned_filters: [{ control: "creator_price", min: 10_000, max: 24_000, unit: "yuan" }],
      },
      artifact: {
        target_row_count: 3,
        excel_path: "/workspace/ypscan-manual-research/shortfall.xlsx",
      },
    }),
  });
  const directive = directiveText(result);
  assert.match(directive, /目标 5，报价区间初筛通过 3，报价淘汰 2，报价待补证 0/u);
  assert.match(directive, /缺口为 2/u);
  assert.match(directive, /不得声称已凑满/u);
  assert.match(directive, /price_check\.status=rejected 的达人不得推荐或包装为备选/u);
  assert.match(directive, /昵称或平台 ID 搜索只允许定位已有详情任务/u);
  assert.match(directive, /10000–24000 yuan/u);
  assert.match(directive, /MANUAL_RESEARCH_EXCEL_PATH=.*shortfall\.xlsx/u);
});

test("empty rank result still outputs the Markdown table and offers manual expansion or end", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "rank_mcns",
    message: toolMessage({ success: true, data: { mcns: [] } }),
  });

  const text = directiveText(result);
  assert.match(text, /完整 MCN Markdown 表格/u);
  assert.match(text, /用户可见正文文本块/u);
  assert.match(text, /\| 机构名 \| 返点 \| 综合分 \| 本机构预估覆盖达人数 \|/u);
  assert.match(text, /\| 暂无匹配机构 \| — \| — \| — \|/u);
  const question = argsFromDirective(text).questions[0];
  assert.deepEqual(
    question.options.map((option) => option.label),
    ["人工拓展并提报", "结束本次"],
  );
  assert.match(question.question, /弹窗打开前已展示的“暂无匹配机构”Markdown 表格/u);
  assert.match(question.question, /达人预览表本地文件路径/u);
  assert.doesNotMatch(question.question, /下载链接/u);
  assert.doesNotMatch(question.question, /\| 暂无匹配机构 \|/u);
});

test("not-ready parse results pause instead of exposing validate args", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypscan_parse_requirement",
    message: toolMessage({
      success: true,
      data: { projections: { provider: { ready: false, search_jobs: [{ params: {} }] } } },
    }),
  });
  const text = directiveText(result);
  assert.match(text, /ASK_USER_QUESTION_ARGS=/u);
  assert.doesNotMatch(text, /VALIDATE_REQUIREMENT_ARGS=/u);
  assert.deepEqual(
    argsFromDirective(text).questions[0].options.map((option) => option.label),
    ["重试", "结束本次"],
  );
});

test("fixed-flow failures pause through AskUserQuestion instead of a plain-text stop", () => {
  const persist = registeredHooks().get("tool_result_persist");
  for (const toolName of ["validate_requirement", "search_creators", "rank_mcns"]) {
    const result = persist({
      toolName,
      message: toolMessage({ success: false, error: { code: "PROVIDER_FAILED" } }),
    });
    const text = directiveText(result);
    assert.match(text, /ASK_USER_QUESTION_ARGS=/u, toolName);
    assert.deepEqual(
      argsFromDirective(text).questions[0].options.map((option) => option.label),
      ["重试", "结束本次"],
    );
  }
});

test("invalid parse arguments trigger one bounded Agent repair instead of asking the user", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypscan_parse_requirement",
    message: toolMessage({
      success: false,
      error: {
        code: "YPSCAN_REQUIREMENT_INVALID",
        details: { violations: ["facts[2].value 不是 picture/video"] },
      },
    }),
  });
  const text = directiveText(result);

  assert.match(text, /Agent 构造参数/u);
  assert.match(text, /自动重试一次/u);
  assert.match(text, /external_condition 的 value 必须使用 quote 的原文/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("startup instruction fixes the chain and delays Browser until the manual branch", () => {
  const skillPath = "/plugin/skills/media-assistant/SKILL.md";
  const hooks = registeredHooks({ skillPath });
  const context = { runId: "startup-run" };
  const first = hooks.get("before_prompt_build")({}, context);

  assert.match(
    first.prependContext,
    /ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns/u,
  );
  assert.match(
    first.prependContext,
    /rank_mcns 后先把完整 MCN Markdown 表格作为用户可见正文文本块写出/u,
  );
  assert.match(first.prependContext, /search_creators → ypscan_save_excel_artifact → rank_mcns/u);
  assert.match(first.prependContext, /精确 SAVE_EXCEL_ARTIFACT_ARGS/u);
  assert.match(first.prependContext, /不向用户输出 creators_export_path 或 Excel 下载链接/u);
  assert.match(first.prependContext, /立即调用保存工具/u);
  assert.match(first.prependContext, /保存成功后再调用 rank_mcns/u);
  assert.match(first.prependContext, /本地路径不得放进弹窗 question/u);
  assert.match(first.prependContext, /ypscan_manual_research\(operation=start\)/u);
  assert.match(first.prependContext, /宿主原生 Browser 自主/u);
  assert.match(first.prependContext, /capture_list\/capture_detail/u);
  assert.match(first.prependContext, /不使用 selection_id、observation_id、element_id/u);
  assert.match(first.prependContext, /才调用 AskUserQuestion/u);
  assert.match(first.prependContext, /普通 UI\/参数问题的一次有界自动重试不调用/u);
  assert.match(first.prependContext, /正常成功交付不追加完成弹窗/u);
  assert.match(first.prependContext, /包括 test 在内的前缀只是命名空间/u);
  assert.match(first.prependContext, /多个可用工具映射到同一实际名称时才调用 AskUserQuestion/u);

  hooks.get("before_tool_call")({ toolName: "Read", params: { path: skillPath } }, context);
  assert.equal(hooks.get("before_prompt_build")({}, context), undefined);
});

test("ordinary successful delivery is not rewritten by the hook", () => {
  const hooks = registeredHooks();
  assert.equal(
    hooks.get("tool_result_persist")({
      toolName: "ypmcn__get_creator_detail",
      message: toolMessage({ success: true, data: { creator_id: "creator-1" } }),
    }),
    undefined,
  );
});

test("manual research asks only for login/CAPTCHA and keeps ordinary UI recovery with the Agent", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const login = persist({
    toolName: "ypscan_manual_research",
    message: toolMessage({ success: false, error: { code: "YPSCAN_MANUAL_LOGIN_REQUIRED" } }),
  });
  const loginText = directiveText(login);
  assert.match(loginText, /ASK_USER_QUESTION_ARGS=/u);
  assert.deepEqual(
    argsFromDirective(loginText).questions[0].options.map((option) => option.label),
    ["已处理，继续", "结束本次"],
  );

  const filter = persist({
    toolName: "ypscan_manual_research",
    message: toolMessage({ success: false, error: { code: "YPSCAN_MANUAL_KEYWORD_NOT_APPLIED" } }),
  });
  const filterText = directiveText(filter);
  assert.doesNotMatch(filterText, /ASK_USER_QUESTION_ARGS=/u);
  assert.match(filterText, /不得要求用户关闭普通弹窗/u);
  assert.match(filterText, /Observer 状态/u);
  assert.match(filterText, /不盲目重复/u);
});

test("field-selection success exposes the raw URL and keeps columns in the Provider", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "mcp__ypscan__select_inquiry_form_fields",
    message: toolMessage({
      success: true,
      url: "https://agenta.eshypdata.com/demand-field-selector?token=abc",
    }),
  });
  const text = directiveText(result);
  assert.match(
    text,
    /FIELD_SELECTION_URL=https:\/\/agenta\.eshypdata\.com\/demand-field-selector\?token=abc/u,
  );
  assert.match(text, /原样输出为单独一行用户可见正文/u);
  assert.match(text, /禁止 Markdown 包装、重写、用 Browser 打开/u);
  assert.match(text, /按需求 ID 持久化到 Provider 数据库/u);
  assert.match(text, /不得调用已弃用的 get_selected_inquiry_form_fields/u);
  assert.match(text, /不得.*把 columns 放入 Agent 上下文/u);
  assert.match(text, /等待用户完成选择后回复“好了”/u);
  assert.match(text, /调用 create_with_distributions/u);
  assert.match(text, /不得调用 create_submission_batch/u);
  assert.doesNotMatch(text, /GET_SELECTED_INQUIRY_FORM_FIELDS_ARGS=/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("field-selection auto-open failure with a valid link still emits the link directive", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "mcp__ypscan__select_inquiry_form_fields",
    message: toolMessage({
      success: false,
      message: "浏览器打开请求未成功",
      url: "https://agenta.eshypdata.com/demand-field-selector?token=degraded",
    }),
  });
  const text = directiveText(result);
  assert.match(
    text,
    /FIELD_SELECTION_URL=https:\/\/agenta\.eshypdata\.com\/demand-field-selector\?token=degraded/u,
  );
  assert.doesNotMatch(text, /GET_SELECTED_INQUIRY_FORM_FIELDS_ARGS=/u);
});

test("field-selection failure without usable links pauses through AskUserQuestion", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "mcp__ypscan__select_inquiry_form_fields",
    message: toolMessage({ success: false, error: { code: "PROVIDER_FAILED" } }),
  });
  const text = directiveText(result);
  assert.match(text, /ASK_USER_QUESTION_ARGS=/u);
  assert.deepEqual(
    argsFromDirective(text).questions[0].options.map((option) => option.label),
    ["重试", "结束本次"],
  );
});

test("rank and startup directives ban any manual_source_creators call", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const rank = persist({
    toolName: "ypmcn__rank_mcns",
    message: toolMessage({ success: true, data: { mcns: [] } }),
  });
  assert.match(directiveText(rank), /manual_source_creators 都不得调用/u);

  const skillPath = "/plugin/skills/media-assistant/SKILL.md";
  const hooks = registeredHooks({ skillPath });
  const startup = hooks.get("before_prompt_build")({}, { runId: "manual-ban-run" });
  assert.match(startup.prependContext, /manual_source_creators 都不得调用/u);
  assert.match(startup.prependContext, /ypscan_manual_research\(operation=start\)/u);
  assert.match(startup.prependContext, /宿主原生 Browser 自主/u);
  assert.match(startup.prependContext, /capture_list\/capture_detail/u);
});

import assert from "node:assert/strict";
import test from "node:test";

import { registerFlowDirectiveHooks } from "../src/hooks/register-flow-directives.js";
import { mcnRankingRecipientQuestionPayload } from "../src/tools/post-save-questions.js";

function registeredHooks() {
  const hooks = new Map();
  registerFlowDirectiveHooks({
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
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

function saveExcelArgsFromDirective(text) {
  const line = text.split("\n").find((item) => item.startsWith("SAVE_EXCEL_ARTIFACT_ARGS="));
  return JSON.parse(line.slice("SAVE_EXCEL_ARTIFACT_ARGS=".length));
}

function namedArgsFromDirective(text, name) {
  const prefix = `${name}=`;
  const line = text.split("\n").find((item) => item.startsWith(prefix));
  return JSON.parse(line.slice(prefix.length));
}

function completeValidateParams() {
  return {
    platform: "douyin",
    brandName: ["测试品牌"],
    projectName: "测试项目",
    quantityTotal: 30,
    submissionDeadlineAt: "2099-08-25 12:00:00",
    rebate: "25%以上",
    followercount: [0, 999999999],
    contentTag: ["科技", "耳机"],
    rawMessagesJson: JSON.stringify({
      original:
        "抖音项目：测试项目；品牌：测试品牌；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2099-08-25 12:00:00；科技耳机方向。",
      parse_outputs: { dybrandName: ["测试品牌"] },
      business_mode: "询价机构",
    }),
    contentThemeLabel: ["科技数码"],
    growTalentTypeLabel: ["成熟达人"],
    industryTagLabel: ["3C及电器-消费类电子产品"],
    xtTalentTypeLabel: ["科技数码-3C数码"],
    kolOfficialPriceL3: 50000,
    cpmL3: 500,
  };
}

function validateParamsWithMode(mode) {
  return {
    rawMessagesJson: {
      original: "抖音需求原文",
      parse_outputs: {},
      business_mode: mode,
    },
  };
}

test("validated requirements route by the previously selected business mode", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const parse = persist({
    toolName: "ypscan_parse_requirement",
    message: toolMessage({
      success: true,
      data: {
        outputs: {
          dybrandName: ["测试品牌"],
          followercount: { followercount: "[10000,50000]" },
          rebate: { rebate: "[0.3,1]" },
          dy_kolOfficialPrice: { kolOfficialPriceL3: "[7000,12000]" },
        },
      },
    }),
  });
  const parseText = directiveText(parse);
  assert.match(parseText, /YPSCAN_NEXT_ACTION=REVIEW_REQUIREMENT/u);
  assert.match(parseText, /media-assistant Skill.*解析后、落库前必须复核/u);
  assert.match(parseText, /不得直接调用 Browser/u);
  assert.match(parseText, /data\.outputs 仅包含当前 Provider 契约消费的 Workflow 字段/u);
  assert.match(parseText, /DIFY_RESOLVED_FIELDS=brandName,followercount,rebate,kolOfficialPrice/u);
  assert.match(parseText, /DIFY_MISSING_FIELDS=cpm,cpe/u);
  assert.match(parseText, /唯一值直接采用/u);
  assert.match(parseText, /八个可选 Label 有则原样保留、无则省略/u);
  assert.match(parseText, /contentTag 缺失.*重新解析/u);
  assert.doesNotMatch(parseText, /PARSER_OWNED_LOGICAL_FIELDS=|VALIDATE_REQUIREMENT_RANGE_FORMAT=/u);
  assert.ok(parseText.length < 800, `parse directive too long: ${parseText.length}`);
  assert.doesNotMatch(parseText, /VALIDATE_REQUIREMENT_ARGS=/u);

  const parseWithMode = persist({
    toolName: "ypscan_parse_requirement",
    params: { demand: "抖音需求", business_mode: "询价机构" },
    message: toolMessage({
      success: true,
      data: { outputs: { dybrandName: ["测试品牌"] } },
    }),
  });
  assert.match(directiveText(parseWithMode), /BUSINESS_MODE=询价机构/u);
  assert.match(directiveText(parseWithMode), /rawMessagesJson\.business_mode/u);

  const validateInquiry = persist({
    toolName: "ypmcn__validate_requirement",
    params: validateParamsWithMode("询价机构"),
    message: toolMessage({
      success: true,
      data: { id: "a".repeat(32), demand_id: "1787034545923844" },
    }),
  });
  assert.match(directiveText(validateInquiry), /当前需求只保留一个 requirement/u);
  assert.match(directiveText(validateInquiry), /业务模式：询价机构/u);
  assert.match(directiveText(validateInquiry), /严禁使用 data\.demand_id/u);
  assert.deepEqual(namedArgsFromDirective(directiveText(validateInquiry), "SEARCH_CREATORS_ARGS"), {
    id: "a".repeat(32),
  });
  assert.doesNotMatch(directiveText(validateInquiry), /SELECT_INQUIRY_FORM_FIELDS_ARGS=/u);

  const validateManual = persist({
    toolName: "ypmcn__validate_requirement",
    params: validateParamsWithMode("直接手扒"),
    message: toolMessage({
      success: true,
      data: { id: "a".repeat(32), demand_id: "1787034545923844" },
    }),
  });
  assert.match(directiveText(validateManual), /业务模式：直接手扒/u);
  assert.deepEqual(
    namedArgsFromDirective(directiveText(validateManual), "SELECT_INQUIRY_FORM_FIELDS_ARGS"),
    { requirement_id: "a".repeat(32) },
  );
  assert.doesNotMatch(directiveText(validateManual), /SEARCH_CREATORS_ARGS=/u);

  const validateWithoutMode = persist({
    toolName: "ypmcn__validate_requirement",
    message: toolMessage({
      success: true,
      data: { id: "a".repeat(32), demand_id: "1787034545923844" },
    }),
  });
  assert.match(directiveText(validateWithoutMode), /缺少 business_mode/u);
  assert.doesNotMatch(
    directiveText(validateWithoutMode),
    /SEARCH_CREATORS_ARGS=|SELECT_INQUIRY_FORM_FIELDS_ARGS=/u,
  );

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
  assert.match(searchText, /忽略 creators_export_path 等表格链接，不保存或展示/u);
  assert.match(searchText, /不调用保存工具/u);
  assert.match(searchText, /不得用 Browser、脚本或其他方式下载/u);
  assert.doesNotMatch(searchText, /SAVE_EXCEL_ARTIFACT_ARGS=/u);
  assert.deepEqual(namedArgsFromDirective(searchText, "RANK_MCNS_ARGS"), { id: "req-1" });

  const rank = persist({
    toolName: "ypmcn__rank_mcns",
    params: { id: "req-1" },
    message: toolMessage({
      success: true,
      data: { mcns: [{ agency_name: "机构 A", supplier_id: "supplier-a" }] },
    }),
  });
  assert.match(directiveText(rank), /完整 MCN Markdown 表格/u);
  assert.match(directiveText(rank), /用户可见正文文本块/u);
  assert.match(directiveText(rank), /MCN_OUTPUT_FORMAT_LOCK=/u);
  assert.match(directiveText(rank), /只能是五列：排名、机构、覆盖达人、返点、综合分/u);
  assert.match(directiveText(rank), /candidate_count/u);
  assert.match(directiveText(rank), /禁止展示 supplier_id、其他字段、汇总或历史数据/u);
  assert.match(directiveText(rank), /同一 requirement_id、同一平台.*唯一精确匹配/u);
  assert.match(directiveText(rank), /只传 supplierIds/u);
  assert.match(directiveText(rank), /传原始名称 supplier_name/u);
  assert.ok(directiveText(rank).length < 1500, `rank directive too long: ${directiveText(rank).length}`);
  assert.doesNotMatch(directiveText(rank), /ypscan_manual_research|宿主 Browser/u);
  assert.doesNotMatch(directiveText(rank), /manual_source_creators_status/u);
  assert.doesNotMatch(directiveText(rank), /selection_id/u);
  const question = argsFromDirective(directiveText(rank));
  assert.deepEqual(question.questions[0].options.map((option) => option.label), [
    "机构 A",
    "暂不询价",
  ]);
  assert.equal(question.questions[0].multiSelect, false);
  assert.deepEqual(question.questions[0].options, [
    { label: "机构 A", description: "选择该机构作为本次询价收件人" },
    { label: "暂不询价", description: "结束本次询价分支，不发送消息" },
  ]);
  assert.doesNotMatch(JSON.stringify(question), /supplier-a/u);
  assert.match(directiveText(rank), /当前已处于询价机构分支/u);
  assert.match(directiveText(rank), /不得按排名或指标自行选择/u);
  assert.deepEqual(namedArgsFromDirective(directiveText(rank), "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-1",
  });
  assert.match(question.questions[0].question, /当前仅有 1 家候选机构/u);
  assert.doesNotMatch(question.questions[0].question, /下载链接/u);
  assert.doesNotMatch(question.questions[0].question, /\| 排名 \|/u);
  assert.doesNotMatch(question.questions[0].question, /匹配机构：/u);
});

test("bound requirements cannot call opposite branch tools", () => {
  const hooks = registeredHooks();
  const persist = hooks.get("tool_result_persist");
  const before = hooks.get("before_tool_call");
  const validateResult = (requirementId) =>
    toolMessage({ success: true, data: { requirement_id: requirementId } });

  persist({
    toolName: "validate_requirement",
    params: validateParamsWithMode("询价机构"),
    message: validateResult("req-inquiry"),
  });
  persist({
    toolName: "validate_requirement",
    params: validateParamsWithMode("直接手扒"),
    message: validateResult("req-manual"),
  });

  const blockedManualTool = before({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-inquiry", size: 10 },
  });
  assert.equal(blockedManualTool.block, true);
  assert.match(blockedManualTool.blockReason, /询价机构/u);
  assert.match(blockedManualTool.blockReason, /manual_source_creators/u);

  const blockedInquiryTool = before({
    toolName: "test__rank_mcns",
    params: { id: "req-manual" },
  });
  assert.equal(blockedInquiryTool.block, true);
  assert.match(blockedInquiryTool.blockReason, /直接手扒/u);

  assert.equal(
    before({ toolName: "test__search_creators", params: { id: "req-inquiry" } })?.block,
    undefined,
  );
  assert.equal(
    before({
      toolName: "test__manual_source_creators_status",
      params: { requirement_id: "req-manual", batch_id: 1 },
    })?.block,
    undefined,
  );
  assert.equal(
    before({ toolName: "test__rank_mcns", params: { id: "req-unbound" } })?.block,
    undefined,
  );
  assert.equal(
    before({ toolName: "test__rank_creators", params: { requirement_id: "req-manual" } })?.block,
    undefined,
  );
});

test("rank result saves the Provider MCN workbook before the branch question", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const rank = persist({
    toolName: "ypmcn__rank_mcns",
    params: { id: "req-1", platform: "douyin" },
    message: toolMessage({
      success: true,
      data: {
        mcns: [{ agency_name: "机构 A", supplier_id: "supplier-a" }],
        mcns_export_path: "https://mcp.eshypdata.com/api/download?file_path=mcn-ranking.xlsx",
      },
    }),
  });
  const rankText = directiveText(rank);
  assert.match(rankText, /完整表格输出后立即使用下面参数保存/u);
  assert.match(rankText, /保存成功前不得展示本地路径/u);
  assert.deepEqual(saveExcelArgsFromDirective(rankText), {
    artifact_kind: "mcn_ranking",
    artifact_id: "req-1",
    excel_file_url: "https://mcp.eshypdata.com/api/download?file_path=mcn-ranking.xlsx",
    mcn_names: ["机构 A"],
  });
  assert.doesNotMatch(rankText, /ASK_USER_QUESTION_ARGS=/u);
  assert.doesNotMatch(rankText, /INQUIRY_RECIPIENT_SELECTION_ARGS|SELECT_INQUIRY_FORM_FIELDS_ARGS/u);

  const saved = persist({
    toolName: "ypscan_save_excel_artifact",
    params: saveExcelArgsFromDirective(rankText),
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/mcn-ranking.xlsx" },
      delivery: {
        local_path: "/workspace/mcn-ranking.xlsx",
        next_args: mcnRankingRecipientQuestionPayload(["机构 A"]),
      },
    }),
  });
  const savedText = directiveText(saved);
  assert.match(savedText, /MCN 排名表已保存/u);
  assert.match(savedText, /MCN_RANKING_LOCAL_PATH=\/workspace\/mcn-ranking\.xlsx/u);
  assert.match(
    savedText,
    /MCN_RANKING_LOCAL_LINK=\[\/workspace\/mcn-ranking\.xlsx\]\(<file:\/\/\/workspace\/mcn-ranking\.xlsx>\)/u,
  );
  assert.match(savedText, /不要只输出裸路径/u);
  assert.doesNotMatch(savedText, /CREATOR_PREVIEW_LOCAL_PATH/u);
  assert.match(savedText, /选择询价收件机构/u);
  assert.match(savedText, /不得按排名或指标自行选择/u);
  assert.match(savedText, /用户选中弹窗中的一个或多个当前机构/u);
  assert.deepEqual(
    argsFromDirective(savedText).questions[0].options.map((option) => option.label),
    ["机构 A", "暂不询价"],
  );
  assert.deepEqual(namedArgsFromDirective(savedText, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-1",
  });
  assert.match(savedText, /把路径\/链接放入弹窗/u);

  const failed = persist({
    toolName: "ypscan_save_excel_artifact",
    params: saveExcelArgsFromDirective(rankText),
    message: toolMessage({ success: false, error: { code: "YPSCAN_EXCEL_DOWNLOAD_FAILED" } }),
  });
  assert.match(directiveText(failed), /MCN 排名表保存 已暂停/u);
});

test("default manual sourcing polls its status before saving the Excel", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const sourced = persist({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-manual", size: "10" },
    message: toolMessage({
      success: true,
      requirement_id: "req-manual",
      batch_id: 42,
    }),
  });
  const sourceText = directiveText(sourced);
  assert.deepEqual(
    namedArgsFromDirective(sourceText, "MANUAL_SOURCE_CREATORS_STATUS_ARGS"),
    { requirement_id: "req-manual", batch_id: 42 },
  );
  assert.match(sourceText, /仅返回 batch_id/u);
  assert.match(sourceText, /轮询间隔 30 秒，单轮最多查询 10 次/u);
  assert.match(sourceText, /不得猜测或更换 requirement_id 或 batch_id/u);
  assert.doesNotMatch(sourceText, /SAVE_EXCEL_ARTIFACT_ARGS=/u);
  assert.doesNotMatch(sourceText, /ASK_USER_QUESTION_ARGS=/u);

  const pending = persist({
    toolName: "ypmcn__manual_source_creators_status",
    params: { requirement_id: "req-manual", batch_id: 42 },
    message: toolMessage({
      success: false,
      error: { code: "BATCH_NOT_READY", message: "手扒任务处理中" },
    }),
  });
  const pendingText = directiveText(pending);
  assert.deepEqual(
    namedArgsFromDirective(pendingText, "MANUAL_SOURCE_CREATORS_STATUS_ARGS"),
    { requirement_id: "req-manual", batch_id: 42 },
  );
  assert.match(pendingText, /BATCH_NOT_READY/u);
  assert.match(pendingText, /轮询间隔 30 秒，单轮最多查询 10 次/u);
  assert.match(pendingText, /当前对话累计查询次数/u);
  assert.match(pendingText, /第 10 次仍未完成.*继续查询\/暂时结束/u);
  assert.doesNotMatch(pendingText, /POLL_LIMIT_QUESTION_ARGS=/u);
  assert.doesNotMatch(pendingText, /SAVE_EXCEL_ARTIFACT_ARGS=/u);
  assert.doesNotMatch(pendingText, /ASK_USER_QUESTION_ARGS=/u);

  const completed = persist({
    toolName: "ypmcn__manual_source_creators_status",
    params: { requirement_id: "req-manual", batch_id: 42 },
    message: toolMessage({
      success: true,
      data: {
        batch_id: 42,
        excel_file_url: "https://files.eshypdata.com/exports/manual.xlsx",
      },
    }),
  });
  const completedText = directiveText(completed);
  assert.deepEqual(saveExcelArgsFromDirective(completedText), {
    artifact_kind: "manual_source",
    artifact_id: "req-manual",
    excel_file_url: "https://files.eshypdata.com/exports/manual.xlsx",
  });
  assert.match(completedText, /不展示 Provider 下载 URL/u);
  assert.doesNotMatch(completedText, /ASK_USER_QUESTION_ARGS=/u);

  const saved = persist({
    toolName: "ypscan_save_excel_artifact",
    params: {
      artifact_kind: "manual_source",
      artifact_id: "req-manual",
      excel_file_url: "https://files.eshypdata.com/exports/manual.xlsx",
    },
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/manual.xlsx" },
    }),
  });
  const savedText = directiveText(saved);
  assert.match(savedText, /MANUAL_SOURCE_LOCAL_PATH=\/workspace\/manual\.xlsx/u);
  assert.match(savedText, /MANUAL_SOURCE_LOCAL_LINK=/u);
  assert.match(savedText, /达人详情列表/u);
  assert.deepEqual(namedArgsFromDirective(savedText, "RANK_CREATORS_ARGS"), {
    requirement_id: "req-manual",
  });
  assert.doesNotMatch(savedText, /ASK_USER_QUESTION_ARGS=/u);
  assert.doesNotMatch(savedText, /ypscan_manual_research|宿主 Browser/u);
});

test("default manual sourcing repairs missing field selection before retrying", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-manual", size: 10 },
    message: toolMessage({
      success: false,
      error: { code: "REQUIREMENT_COLUMNS_NOT_CONFIGURED" },
    }),
  });
  const text = directiveText(result);

  assert.deepEqual(namedArgsFromDirective(text, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-manual",
  });
  assert.match(text, /不得原参数重试/u);
  assert.match(text, /收到“好了”后/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("default manual sourcing pauses without a task batch and falls back to params", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const sourced = persist({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-nobatch", size: "10" },
    message: toolMessage({ success: true, requirement_id: "req-nobatch" }),
  });
  const sourceText = directiveText(sourced);
  assert.match(sourceText, /默认手扒 已暂停/u);
  assert.doesNotMatch(sourceText, /MANUAL_SOURCE_CREATORS_STATUS_ARGS=/u);

  const completed = persist({
    toolName: "ypmcn__manual_source_creators_status",
    params: { requirement_id: "req-nobatch", batch_id: 42 },
    message: toolMessage({
      success: true,
      data: { excel_file_url: "https://files.eshypdata.com/exports/fallback.xlsx" },
    }),
  });
  assert.deepEqual(saveExcelArgsFromDirective(directiveText(completed)), {
    artifact_kind: "manual_source",
    artifact_id: "req-nobatch",
    excel_file_url: "https://files.eshypdata.com/exports/fallback.xlsx",
  });
});

test("tool-result parsing finds JSON in a separate text block", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypmcn__manual_source_creators_status",
    params: { requirement_id: "req-multipart", batch_id: 7 },
    message: {
      role: "toolResult",
      content: [
        { type: "text", text: 'Metadata: {"notice":true}' },
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            batch_id: 7,
            excel_file_url: "https://files.eshypdata.com/exports/multipart.xlsx",
          }),
        },
        { type: "text", text: "End of provider result." },
      ],
    },
  });

  assert.deepEqual(saveExcelArgsFromDirective(directiveText(result)), {
    artifact_kind: "manual_source",
    artifact_id: "req-multipart",
    excel_file_url: "https://files.eshypdata.com/exports/multipart.xlsx",
  });
});


test("institutional retrieval polls the ingest job before Excel save, creator rank and submission", () => {
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
      data: { job_id: "job-ingest-1" },
    }),
  });
  assert.deepEqual(namedArgsFromDirective(directiveText(ingested), "GET_INGEST_JOB_ARGS"), {
    job_id: "job-ingest-1",
  });
  assert.doesNotMatch(directiveText(ingested), /SAVE_EXCEL_ARTIFACT_ARGS=/u);

  const pending = persist({
    toolName: "test__get_ingest_job",
    params: { job_id: "job-ingest-1" },
    message: toolMessage({ success: false, error: { code: "JOB_PENDING" } }),
  });
  assert.deepEqual(namedArgsFromDirective(directiveText(pending), "GET_INGEST_JOB_ARGS"), {
    job_id: "job-ingest-1",
  });
  assert.match(directiveText(pending), /同一 job_id/u);
  assert.doesNotMatch(directiveText(pending), /ASK_USER_QUESTION_ARGS=/u);

  const completed = persist({
    toolName: "test__get_ingest_job",
    params: { job_id: "job-ingest-1" },
    message: toolMessage({
      success: true,
      data: {
        job_id: "job-ingest-1",
        requirement_id: "req-ingest",
        excel_file_url: "https://files.eshypdata.com/exports/mcn-preview.xlsx",
      },
    }),
  });
  assert.match(
    directiveText(completed),
    /MCN_CREATOR_PREVIEW_URL=https:\/\/files\.eshypdata\.com\/exports\/mcn-preview\.xlsx/u,
  );
  assert.match(directiveText(completed), /原样输出 MCN_CREATOR_PREVIEW_URL/u);
  assert.deepEqual(saveExcelArgsFromDirective(directiveText(completed)), {
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
  const rankedText = directiveText(ranked);
  assert.match(rankedText, /YPSCAN_NEXT_ACTION=APPLY_CURRENT_MODE_RANK_POLICY/u);
  assert.match(rankedText, /RANK_REQUIREMENT_ID=req-ingest/u);
  assert.match(rankedText, /询价机构模式：生成当前提报表/u);
  assert.doesNotMatch(rankedText, /^CREATE_SUBMISSION_BATCH_ARGS=/mu);

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

test("submission enrichment choice maps directly to get_creator_detail", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const saved = persist({
    toolName: "ypscan_save_excel_artifact",
    params: {
      artifact_kind: "submission_batch",
      artifact_id: "123",
      excel_file_url: "https://files.eshypdata.com/exports/submission.xlsx",
    },
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/submission.xlsx" },
      delivery: { next_args: { questions: [] } },
    }),
  });
  const text = directiveText(saved);
  assert.match(text, /选择补充更新时固定调用 get_creator_detail/u);
  assert.match(text, /再轮询 get_creator_detail_export/u);
  assert.match(text, /不得改字段配置/u);
  assert.match(text, /不得.*再次追问/u);
});

test("successful WeCom distribution waits for inquiry retrieval without switching branches", () => {
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
  const text = directiveText(result);
  assert.match(text, /可随时回收在线表格/u);
  assert.match(text, /sync_mcn_inquiry_status/u);
  assert.match(text, /不切换到直接手扒分支/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("rank result follows the current conversation mode after transient state resets", () => {
  const hooks = new Map();
  const transientState = registerFlowDirectiveHooks({
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
  const persist = hooks.get("tool_result_persist");
  persist({
    toolName: "validate_requirement",
    params: validateParamsWithMode("直接手扒"),
    message: toolMessage({ success: true, data: { requirement_id: "req-after-reset" } }),
  });
  transientState.resetTransientState();

  const ranked = persist({
    toolName: "rank_creators",
    params: { requirement_id: "req-after-reset" },
    message: toolMessage({ success: true, data: { ranked_count: 8 } }),
  });
  const text = directiveText(ranked);
  assert.match(text, /YPSCAN_NEXT_ACTION=APPLY_CURRENT_MODE_RANK_POLICY/u);
  assert.match(text, /RANKED_COUNT=8/u);
  assert.match(text, /RANK_REQUIREMENT_ID=req-after-reset/u);
  assert.match(text, /询价机构模式：生成当前提报表/u);
  assert.match(text, /直接手扒模式：先与当前 quantityTotal 比较/u);
  assert.match(text, /不足时先复核/u);
  assert.doesNotMatch(text, /CREATE_SUBMISSION_BATCH_ARGS=|IF_SUFFICIENT/u);
});


test("empty rank result reviews the requirement before relaxation", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "rank_mcns",
    message: toolMessage({ success: true, data: { mcns: [] } }),
  });

  const text = directiveText(result);
  assert.match(text, /完整 MCN Markdown 表格/u);
  assert.match(text, /用户可见正文文本块/u);
  assert.match(text, /\| 排名 \| 机构 \| 覆盖达人 \| 返点 \| 综合分 \|/u);
  assert.match(text, /\| — \| 暂无匹配机构 \| — \| — \| — \|/u);
  assert.match(text, /当前已处于询价机构分支/u);
  assert.match(text, /YPSCAN_NEXT_ACTION=REVIEW_BEFORE_RELAXATION/u);
  assert.match(text, /media-assistant Skill.*结果不足：先复核，再放宽/u);
  assert.match(text, /不得保存空排名表/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("parse directives preserve compact dynamic field summaries", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypscan_parse_requirement",
    message: toolMessage({
      success: true,
      data: {
        outputs: {
          contentTag: null,
          dybrandName: ["测试品牌"],
          dy_kolOfficialPrice: { kolOfficialPriceL3: "[7000,12000]" },
        },
      },
    }),
  });

  const text = directiveText(result);
  assert.match(text, /DIFY_RESOLVED_FIELDS=brandName,kolOfficialPrice/u);
  assert.match(text, /DIFY_MISSING_FIELDS=followercount,rebate,cpm,cpe/u);
  assert.match(text, /唯一值直接采用/u);
  assert.match(text, /八个可选 Label 有则原样保留、无则省略/u);
  assert.match(text, /contentTag 缺失.*重新解析/u);
  assert.match(text, /YPSCAN_NEXT_ACTION=REVIEW_REQUIREMENT/u);
  assert.ok(text.length < 800, `parse directive too long: ${text.length}`);
  assert.doesNotMatch(text, /PARSER_OWNED_LOGICAL_FIELDS=|VALIDATE_REQUIREMENT_RANGE_FORMAT=/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
  assert.doesNotMatch(text, /VALIDATE_REQUIREMENT_ARGS=/u);
});
test("fixed-flow failures pause through AskUserQuestion instead of a plain-text stop", () => {
  const persist = registeredHooks().get("tool_result_persist");
  for (const toolName of [
    "ypscan_parse_requirement",
    "validate_requirement",
    "search_creators",
    "rank_mcns",
  ]) {
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

test("parse and startup directives enumerate required business values before validation", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const parse = persist({
    toolName: "ypscan_parse_requirement",
    message: toolMessage({ success: true, data: { outputs: {} } }),
  });
  const parseText = directiveText(parse);

  assert.match(
    parseText,
    /brandName、quantityTotal、submissionDeadlineAt、rebate、followercount/u,
  );
  assert.match(parseText, /至少一个当前平台支持且与内容形式匹配的报价档位/u);
  assert.match(parseText, /contentTag.*解析结果.*重新解析/u);
  assert.match(parseText, /抖音仅使用 L2\/L3.*小红书不使用 L3/u);
  assert.doesNotMatch(parseText, /至少一个当前平台 kolOfficialPriceL1\/L2\/L3/u);
  assert.match(parseText, /缺失或有歧义.*按 Skill 一次性询问/u);

  const startup = registeredHooks().get("before_prompt_build")({}, { runId: "required-fields" });
  assert.match(
    startup.prependContext,
    /brandName、quantityTotal、submissionDeadlineAt、rebate、followercount/u,
  );
  assert.match(startup.prependContext, /至少一个当前平台支持且与内容形式匹配的报价档位/u);
  assert.match(startup.prependContext, /contentTag.*解析结果.*重新解析/u);
  assert.match(startup.prependContext, /抖音仅使用 L2\/L3.*小红书不使用 L3/u);
  assert.doesNotMatch(startup.prependContext, /至少一个当前平台 kolOfficialPriceL1\/L2\/L3/u);
  assert.match(
    startup.prependContext,
    /这些业务值缺失.*AskUserQuestion/u,
  );
});

test("recipient selection statically hands off to field selection", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "rank_mcns",
    params: { id: "req-inquiry" },
    message: toolMessage({
      success: true,
      data: { mcns: [{ agency_name: "机构 A", supplier_id: "supplier-a" }] },
    }),
  });
  const text = directiveText(result);

  assert.match(text, /收到机构选择答案后，第一个动作必须调用 select_inquiry_form_fields/u);
  assert.match(text, /requirement_id.*req-inquiry/u);
  assert.match(text, /不得提前调用字段选择/u);
  assert.deepEqual(namedArgsFromDirective(text, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-inquiry",
  });
});

test("more than four inquiry recipients use a warning prompt without option truncation", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const names = ["机构 A", "机构 B", "机构 C", "机构 D", "机构 E"];
  const result = persist({
    toolName: "rank_mcns",
    params: { id: "req-many" },
    message: toolMessage({
      success: true,
      data: { mcns: names.map((agency_name) => ({ agency_name })) },
    }),
  });
  const recipient = namedArgsFromDirective(
    directiveText(result),
    "ASK_USER_QUESTION_ARGS",
  ).questions[0];
  const text = directiveText(result);

  assert.match(recipient.header, /提示|警示/u);
  assert.match(recipient.question, /超过.*4.*选项/u);
  names.forEach((name) => assert.doesNotMatch(recipient.question, new RegExp(name, "u")));
  assert.equal(recipient.multiSelect, false);
  assert.deepEqual(recipient.options, [
    { label: "询价全部机构", description: "选择本轮全部候选机构并进入字段选择" },
    { label: "暂不询价", description: "结束本次询价分支，不发送消息" },
  ]);
  assert.doesNotMatch(JSON.stringify(recipient.options), /机构 [A-E]/u);
  assert.match(text, /自定义输入成功解析为一个或多个当前机构的唯一编号或完整名称时成立/u);
  assert.match(text, /用户选中弹窗中的一个或多个当前机构/u);
  assert.match(text, /选择“询价全部机构”.*全部当前机构/u);
  assert.match(text, /空输入、未知机构、无法解析或存在歧义时，不得调用 select_inquiry_form_fields/u);
  assert.match(text, /重新调用本提示或结束本轮/u);
});

test("startup instruction selects and preserves one business mode", () => {
  const hooks = registeredHooks();
  const context = { runId: "startup-run" };
  const first = hooks.get("before_prompt_build")({}, context);

  assert.match(first.prependContext, /用户明确说.*询价机构.*直接使用/u);
  assert.match(first.prependContext, /明确说.*直接手扒.*直接使用/u);
  assert.match(first.prependContext, /未明确、同时出现两种模式或语义冲突/u);
  assert.match(first.prependContext, /BUSINESS_MODE_QUESTION_ARGS=/u);
  assert.match(first.prependContext, /回答前不得解析或落库/u);
  assert.match(first.prependContext, /同一 requirement 禁止交叉分支/u);
  assert.match(first.prependContext, /询价链路：解析→复核→validate_requirement/u);
  assert.match(first.prependContext, /直接手扒：解析→复核→validate_requirement/u);
  assert.match(first.prependContext, /rank_mcns 成功后先输出完整五列表格/u);
  assert.match(first.prependContext, /保存 MCN 排名表/u);
  assert.match(first.prependContext, /MCN 用户可见输出格式锁/u);
  assert.match(first.prependContext, /不得根据响应 schema、原始字段、旧模板或上一轮结果/u);
  assert.match(
    first.prependContext,
    /Supplier ID\/supplier_id、候选达人、供给占比、手扒补量、推荐理由/u,
  );
  assert.match(first.prependContext, /同一 requirement_id/u);
  assert.match(first.prependContext, /直接手扒分支先选择字段，再调用 manual_source_creators/u);
  assert.match(first.prependContext, /直接手扒达人详情 Excel 保存成功后原样展示 delivery\.local_file_link/u);
  assert.match(first.prependContext, /后台 API 完成平台达人搜索、详情抓取和筛选/u);
  assert.match(first.prependContext, /不再提供浏览器详细手扒分支/u);
  assert.match(first.prependContext, /同平台多个达人类型只创建一个 requirement/u);
  assert.match(first.prependContext, /本规则覆盖任何旧的平均分配或批量子需求指令/u);
  assert.doesNotMatch(first.prependContext, /ypscan_manual_research|YPSCAN_MANUAL_BROWSER_UNAVAILABLE|宿主 Browser/u);
  assert.match(first.prependContext, /需求澄清规则/u);
  assert.match(first.prependContext, /同一字段新答案覆盖旧答案/u);
  assert.match(first.prependContext, /八个可选 Label 数组.*不调用 AskUserQuestion 确认/u);
  assert.match(first.prependContext, /contentTag.*重新解析.*禁止询问用户/u);
  assert.match(first.prependContext, /xtTalentTypeLabel/u);
  assert.match(first.prependContext, /只有这些必填数值仍缺失.*才调用 AskUserQuestion/u);
  assert.match(first.prependContext, /自定义输入成功解析为一个或多个当前机构的唯一编号或完整名称时成立/u);
  assert.match(first.prependContext, /用户选中弹窗中的一个或多个当前机构/u);
  assert.match(first.prependContext, /选择“询价全部机构”.*全部当前机构/u);
  assert.match(first.prependContext, /空输入、未知机构、无法解析或存在歧义时，不得调用 select_inquiry_form_fields/u);
  assert.match(first.prependContext, /Dify 品牌候选唯一、合法且非空时必须原样作为 brandName/u);
  assert.match(first.prependContext, /不得询问、改写或被原文与 clarification 覆盖/u);
  assert.match(first.prependContext, /解析品牌缺失、多候选或为 null、未知等占位值时才询问/u);
  assert.match(first.prependContext, /项目名由 Agent 根据当前需求自行总结生成，不弹窗确认/u);
  assert.match(first.prependContext, /调用 validate_requirement 前用一句可见正文告知用户取的项目名/u);
  assert.match(first.prependContext, /validate_requirement 数值字段格式锁/u);
  assert.match(first.prependContext, /无空格 JSON 区间字符串 "\[min,max\]"/u);
  assert.match(first.prependContext, /禁止通过 Provider 报错逐字段、逐类型试探/u);
  assert.match(first.prependContext, /同平台多个达人类型只创建一个 requirement/u);
  assert.match(first.prependContext, /本规则覆盖任何旧的平均分配或批量子需求指令/u);
  assert.doesNotMatch(first.prependContext, /单条件修改可直接更新/u);
  assert.match(first.prependContext, /需求解析复核、结果不足后的二次复核与逐项放宽/u);
  assert.match(first.prependContext, /用户修改需求后的重建规则.*media-assistant Skill/u);
  assert.match(first.prependContext, /绝不使用 data\.demand_id/u);
  assert.match(first.prependContext, /正常成功交付不追加完成弹窗/u);
  assert.match(first.prependContext, /包括 test 在内的前缀只是命名空间/u);
  assert.match(first.prependContext, /多个可用工具映射到同一实际名称时才调用 AskUserQuestion/u);
  assert.match(first.prependContext, /明确无条件回复“可以发\/发吧\/按这个发\/就这样发送”/u);

  assert.equal(hooks.get("before_prompt_build")({}, context), undefined);
});

test("validate_requirement preflight canonicalizes all numeric fields before one Provider call", () => {
  const before = registeredHooks().get("before_tool_call");
  const result = before({
    toolName: "ypmcn__validate_requirement",
    params: completeValidateParams(),
  });

  assert.equal(result.block, undefined);
  assert.equal(result.params.status, "ready");
  assert.equal(result.params.brandName, "测试品牌");
  assert.equal(result.params.quantityTotal, "30");
  assert.equal(result.params.rebate, "[0.25,1]");
  assert.equal(result.params.followercount, "[0,999999999]");
  assert.equal(result.params.kolOfficialPriceL3, "[35000,60000]");
  assert.equal(result.params.cpmL3, "[0,500]");
  assert.equal(typeof result.params.rawMessagesJson, "string");
  assert.deepEqual(JSON.parse(result.params.rawMessagesJson), {
    original:
      "抖音项目：测试项目；品牌：测试品牌；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2099-08-25 12:00:00；科技耳机方向。",
    parse_outputs: { dybrandName: ["测试品牌"] },
    business_mode: "询价机构",
  });
});

test("validate_requirement serializes object-form rawMessagesJson exactly once for Provider", () => {
  const before = registeredHooks().get("before_tool_call");
  const params = completeValidateParams();
  const rawMessagesJson = JSON.parse(params.rawMessagesJson);
  params.rawMessagesJson = rawMessagesJson;

  const result = before({ toolName: "validate_requirement", params });

  assert.equal(typeof result.params.rawMessagesJson, "string");
  assert.deepEqual(JSON.parse(result.params.rawMessagesJson), rawMessagesJson);
});

test("validate_requirement forwards parsed labels without user clarification", () => {
  const before = registeredHooks().get("before_tool_call");
  const params = completeValidateParams();
  delete params.contentThemeLabel;
  delete params.xtTalentTypeLabel;
  const rawMessagesJson = JSON.parse(params.rawMessagesJson);
  rawMessagesJson.parse_outputs = {
    dybrandName: ["测试品牌"],
    contentThemeLabel: ["科技数码"],
    xtTalentTypeLabel: ["科技数码-3C数码"],
  };
  params.rawMessagesJson = rawMessagesJson;

  const result = before({ toolName: "validate_requirement", params });

  assert.equal(result.block, undefined);
  assert.deepEqual(result.params.contentThemeLabel, ["科技数码"]);
  assert.deepEqual(result.params.xtTalentTypeLabel, ["科技数码-3C数码"]);
  assert.deepEqual(JSON.parse(result.params.rawMessagesJson).parse_outputs, rawMessagesJson.parse_outputs);
});

test("validate_requirement silently omits a null Douyin primary parsed label", () => {
  const before = registeredHooks().get("before_tool_call");
  const params = completeValidateParams();
  const rawMessagesJson = JSON.parse(params.rawMessagesJson);
  rawMessagesJson.original =
    "抖音项目：测试项目；品牌：测试品牌；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2099-08-25 12:00:00；账号类型：家电垂类，发布内容中需要有孩子或宠物相关内容。";
  rawMessagesJson.parse_outputs = {
    dybrandName: ["测试品牌"],
    xtTalentTypeLabel: null,
  };
  params.rawMessagesJson = rawMessagesJson;
  delete params.xtTalentTypeLabel;

  const result = before({ toolName: "validate_requirement", params });

  assert.equal(result.block, undefined);
  assert.equal(Object.hasOwn(result.params, "xtTalentTypeLabel"), false);
});

test("validate_requirement never blocks a null current-platform primary parsed label", () => {
  const before = registeredHooks().get("before_tool_call");
  for (const [platform, field] of [
    ["xiaohongshu", "pgyBloggerTypeLabel"],
    ["douyin", "xtTalentTypeLabel"],
  ]) {
    const params = completeValidateParams();
    params.platform = platform;
    const rawMessagesJson = JSON.parse(params.rawMessagesJson);
    rawMessagesJson.parse_outputs = {
      [platform === "douyin" ? "dybrandName" : "xhsbrandName"]: ["测试品牌"],
      [field]: null,
    };
    if (platform === "douyin") {
      rawMessagesJson.original =
        "抖音项目：测试项目；品牌：测试品牌；定制视频；30位；单价5万元；返点25%以上；粉丝不限；提报截止2099-08-25 12:00:00；账号类型：家居。";
    }
    params.rawMessagesJson = rawMessagesJson;
    delete params[field];
    if (platform === "xiaohongshu") {
      delete params.kolOfficialPriceL3;
      delete params.cpmL3;
      params.kolOfficialPriceL1 = "[35000,60000]";
    }

    const result = before({ toolName: "validate_requirement", params });
    assert.equal(result.block, undefined, platform);
    assert.equal(Object.hasOwn(result.params, field), false, platform);
  }
});


test("validate_requirement before-call gate blocks equal range bounds", () => {
  const before = registeredHooks().get("before_tool_call");
  const cases = {
    kolOfficialPriceL3: "[50000,50000]",
    cpmL3: "[500,500]",
    cpeL3: "[30,30]",
    rebate: "[1,1]",
    followercount: "[10000,10000]",
  };

  for (const [field, value] of Object.entries(cases)) {
    const result = before({
      toolName: "validate_requirement",
      params: { ...completeValidateParams(), [field]: value },
    });

    assert.equal(result.block, true, field);
    assert.match(result.blockReason, new RegExp(`${field}.*min < max`, "u"), field);
  }
});

test("validate_requirement preserves a valid parsed price candidate", () => {
  const before = registeredHooks().get("before_tool_call");
  const params = completeValidateParams();
  const rawMessagesJson = JSON.parse(params.rawMessagesJson);
  rawMessagesJson.parse_outputs = {
    dybrandName: ["测试品牌"],
    dy_kolOfficialPrice: { kolOfficialPriceL3: "[35000,50000]" },
  };
  params.rawMessagesJson = JSON.stringify(rawMessagesJson);
  params.kolOfficialPriceL3 = "[35000,50000]";

  const result = before({ toolName: "validate_requirement", params });
  const forwardedParams = result?.params ?? params;

  assert.equal(result?.block, undefined);
  assert.equal(forwardedParams.kolOfficialPriceL3, "[35000,50000]");
});

test("validate_requirement blocks prebuilt CPM and CPE ranges that are not maximum filters", () => {
  const before = registeredHooks().get("before_tool_call");

  for (const field of ["cpmL3", "cpeL3"]) {
    const result = before({
      toolName: "validate_requirement",
      params: { ...completeValidateParams(), [field]: "[1,500]" },
    });

    assert.equal(result.block, true, field);
    assert.match(result.blockReason, new RegExp(`${field}.*\\[0,max\\]`, "u"), field);
  }
});

test("validate_requirement preflight blocks incomplete writes before Provider execution", () => {
  const before = registeredHooks().get("before_tool_call");
  const params = completeValidateParams();
  delete params.submissionDeadlineAt;
  params.rebate = { min: 0.25, max: 1 };
  params.projectStartStart = "8月底";

  const result = before({ toolName: "validate_requirement", params });

  assert.equal(result.block, true);
  assert.match(result.blockReason, /YPSCAN_REQUIREMENT_PREFLIGHT_BLOCKED/u);
  assert.match(result.blockReason, /Provider 没有收到本次写入/u);
  assert.match(result.blockReason, /submissionDeadlineAt/u);
  assert.match(result.blockReason, /rebate/u);
  assert.match(result.blockReason, /projectStartStart/u);
  assert.match(result.blockReason, /只有仍缺失.*才调用 AskUserQuestion/u);
  assert.match(result.blockReason, /已有该字段的有效弹窗答案.*不得再次询问/u);
  assert.match(result.blockReason, /不得自主补值或改变一种类型后继续盲试/u);
});

test("WeCom send confirmation remains advisory instead of a local before-call gate", () => {
  const before = registeredHooks().get("before_tool_call");

  assert.equal(
    before({
      toolName: "ypmcn__create_with_distributions",
      params: {},
    }),
    undefined,
  );
});

test("preflight block result requires grouped popup clarification instead of retry probing", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "validate_requirement",
    message: toolMessage({
      success: false,
      error: {
        code: "TOOL_CALL_BLOCKED",
        message: "YPSCAN_REQUIREMENT_PREFLIGHT_BLOCKED",
      },
    }),
  });
  const text = directiveText(result);

  assert.match(text, /Provider 未执行写入/u);
  assert.match(text, /已经回答但漏传的字段补回 rawMessagesJson.clarifications/u);
  assert.match(text, /同一次 AskUserQuestion 中成组收集/u);
  assert.match(text, /禁止自主选择、默认补值/u);
  assert.match(text, /projectName 由 Agent 根据当前需求自行总结生成/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("verified range fallback returns control to Playwright without stale refs", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypscan_set_filter_range",
    message: toolMessage({
      success: true,
      status: "applied",
      applied: true,
      verified: true,
      field_label: "粉丝数量",
    }),
  });
  const text = directiveText(result);

  assert.match(text, /范围筛选已验证：粉丝数量/u);
  assert.match(text, /不要复用输入前的 ref/u);
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
  assert.match(text, /原样输出 URL/u);
  assert.match(text, /不得改写、包装、用 Browser 打开/u);
  assert.match(text, /按 validate_requirement 返回的 requirement_id/u);
  assert.match(text, /不得使用 demand_id/u);
  assert.match(text, /调用已弃用的 get_selected_inquiry_form_fields/u);
  assert.match(text, /把 columns 放入上下文/u);
  assert.match(text, /等待用户提交并回复“好了”/u);
  assert.match(text, /按原分支恢复/u);
  assert.match(text, /用户明确选中的当前 MCN/u);
  assert.match(text, /发送前确认/u);
  assert.match(text, /直接手扒使用原 requirement_id 和 size/u);
  assert.ok(text.length < 900, `field-selection directive too long: ${text.length}`);
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
  assert.match(text, /用户明确选中的当前 MCN/u);
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

test("rank and startup directives keep direct sourcing separate from inquiry", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const rank = persist({
    toolName: "ypmcn__rank_mcns",
    message: toolMessage({ success: true, data: { mcns: [] } }),
  });
  assert.match(directiveText(rank), /完整 MCN Markdown 表格/u);
  assert.match(directiveText(rank), /禁止展示 supplier_id/u);
  assert.doesNotMatch(directiveText(rank), /manual_source_creators_status/u);
  assert.ok(directiveText(rank).length < 1000, `empty rank directive too long: ${directiveText(rank).length}`);

  const hooks = registeredHooks();
  const startup = hooks.get("before_prompt_build")({}, { runId: "manual-ban-run" });
  assert.match(startup.prependContext, /同一 requirement_id/u);
  assert.match(startup.prependContext, /直接手扒分支先选择字段，再调用 manual_source_creators/u);
  assert.match(startup.prependContext, /不得把详情 Excel 当作最终提报表/u);
  assert.match(startup.prependContext, /读取.*input schema/u);
  assert.match(startup.prependContext, /需求原文.*可选字段/u);
  assert.match(startup.prependContext, /去掉原文字段.*同一 requirement_id 和 size.*重试一次/u);
  assert.doesNotMatch(startup.prependContext, /ypscan_manual_research|宿主 Browser/u);
});

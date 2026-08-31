import assert from "node:assert/strict";
import test from "node:test";

import { registerFlowDirectiveHooks } from "../src/hooks/register-flow-directives.js";
import {
  browserVerificationQuestionPayload,
  businessModeQuestionPayload,
  flowRetryQuestionPayload,
  ingestJobRecoveryQuestionPayload,
  isPopupQuestionPayload,
  MAX_POPUP_LINE_LENGTH,
  mcnRankingRecipientQuestionPayload,
  popupQuestionPayload,
  submissionEnrichmentQuestionPayload,
} from "../src/tools/popup-questions.js";

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

function popupPlainText(value) {
  return value.replaceAll("\n", "");
}

function assertPopupLines(payload) {
  for (const question of payload.questions) {
    for (const value of [
      question.header,
      question.question,
      ...question.options.flatMap((option) => [option.label, option.description]),
    ]) {
      for (const line of value.split("\n")) {
        assert.ok([...line].length <= MAX_POPUP_LINE_LENGTH, `popup line is too long: ${line}`);
      }
    }
  }
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
  assert.doesNotMatch(
    parseText,
    /PARSER_OWNED_LOGICAL_FIELDS=|VALIDATE_REQUIREMENT_RANGE_FORMAT=/u,
  );
  assert.ok(parseText.length < 950, `parse directive too long: ${parseText.length}`);
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
    params: validateParamsWithMode("手动拓展"),
    message: toolMessage({
      success: true,
      data: { id: "a".repeat(32), demand_id: "1787034545923844" },
    }),
  });
  assert.match(directiveText(validateManual), /业务模式：手动拓展/u);
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
  assert.ok(
    directiveText(rank).length < 1500,
    `rank directive too long: ${directiveText(rank).length}`,
  );
  assert.doesNotMatch(directiveText(rank), /ypscan_manual_research|宿主 Browser/u);
  assert.doesNotMatch(directiveText(rank), /manual_source_creators_status/u);
  assert.doesNotMatch(directiveText(rank), /selection_id/u);
  const question = argsFromDirective(directiveText(rank));
  assert.deepEqual(
    question.questions[0].options.map((option) => option.label),
    ["机构 A", "暂不询价"],
  );
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

test("completed requirements can reuse the other business function", () => {
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
    params: validateParamsWithMode("手动拓展"),
    message: validateResult("req-manual"),
  });

  const manualTool = before({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-inquiry", size: 10 },
  });
  assert.equal(manualTool, undefined);

  const inquiryTool = before({
    toolName: "test__rank_mcns",
    params: { id: "req-manual" },
  });
  assert.equal(inquiryTool, undefined);

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
  assert.doesNotMatch(
    rankText,
    /INQUIRY_RECIPIENT_SELECTION_ARGS|SELECT_INQUIRY_FORM_FIELDS_ARGS/u,
  );

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
  assert.deepEqual(namedArgsFromDirective(sourceText, "MANUAL_SOURCE_CREATORS_STATUS_ARGS"), {
    requirement_id: "req-manual",
    batch_id: 42,
  });
  assert.match(sourceText, /仅返回 batch_id/u);
  assert.match(sourceText, /等待 30 秒再进行第 1 次查询/u);
  assert.match(sourceText, /之后每隔 30 秒查询一次，单轮累计最多 10 次/u);
  assert.match(sourceText, /第 10 次仍未完成.*不得自动查询第 11 次/u);
  assert.match(sourceText, /不得猜测或更换 requirement_id 或 batch_id/u);
  assert.doesNotMatch(sourceText, /SAVE_EXCEL_ARTIFACT_ARGS=/u);
  assert.doesNotMatch(sourceText, /ASK_USER_QUESTION_ARGS=/u);

  const pending = persist({
    toolName: "ypmcn__manual_source_creators_status",
    params: { requirement_id: "req-manual", batch_id: 42 },
    message: toolMessage({
      success: false,
      error: { code: "BATCH_NOT_READY", message: "手动拓展任务处理中" },
    }),
  });
  const pendingText = directiveText(pending);
  assert.deepEqual(namedArgsFromDirective(pendingText, "MANUAL_SOURCE_CREATORS_STATUS_ARGS"), {
    requirement_id: "req-manual",
    batch_id: 42,
  });
  assert.match(pendingText, /BATCH_NOT_READY/u);
  assert.match(pendingText, /未到第 10 次时等待 30 秒/u);
  assert.match(pendingText, /单轮累计最多 10 次/u);
  assert.match(pendingText, /当前对话累计查询次数/u);
  assert.match(pendingText, /第 10 次仍未完成.*如实报告并停止/u);
  assert.match(pendingText, /不得自动查询第 11 次/u);
  assert.doesNotMatch(pendingText, /继续查询\/暂时结束/u);
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
  assert.match(savedText, /最终手动拓展结果/u);
  assert.match(savedText, /业务条件未变/u);
  assert.doesNotMatch(savedText, /RANK_CREATORS_ARGS=/u);
  assert.doesNotMatch(savedText, /CREATE_SUBMISSION_BATCH_ARGS=/u);
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
  assert.match(sourceText, /手动拓展 已暂停/u);
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
  assert.match(rankedText, /YPSCAN_NEXT_ACTION=APPLY_INQUIRY_RANK_POLICY/u);
  assert.match(rankedText, /RANK_REQUIREMENT_ID=req-ingest/u);
  assert.match(rankedText, /生成当前机构询价提报表/u);
  assert.doesNotMatch(rankedText, /^CREATE_SUBMISSION_BATCH_ARGS=/mu);

  const submission = persist({
    toolName: "test__create_submission_batch",
    params: { requirement_id: "req-ingest", submission_batche_page: 1 },
    message: toolMessage({
      success: true,
      data: {
        batch_id: 101,
        platform: "xiaohongshu",
        excel_file_url: "https://files.eshypdata.com/exports/submission.xlsx",
      },
    }),
  });
  assert.deepEqual(saveExcelArgsFromDirective(directiveText(submission)), {
    artifact_kind: "submission_batch",
    artifact_id: "101",
    excel_file_url: "https://files.eshypdata.com/exports/submission.xlsx",
    requirement_id: "req-ingest",
    platform: "xhs",
  });
});

test("submission batch save falls back to a top-level requirement_id", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "test__create_submission_batch",
    params: { submission_batche_page: 1 },
    message: toolMessage({
      success: true,
      requirement_id: "req-top-level",
      batch_id: 202,
      excel_file_url: "https://files.eshypdata.com/exports/submission.xlsx",
    }),
  });
  assert.deepEqual(saveExcelArgsFromDirective(directiveText(result)), {
    artifact_kind: "submission_batch",
    artifact_id: "202",
    excel_file_url: "https://files.eshypdata.com/exports/submission.xlsx",
    requirement_id: "req-top-level",
  });
  assert.match(directiveText(result), /必须把当前 requirement 的已确认平台/u);
  assert.match(directiveText(result), /平台缺失时.*不得提供达人信息补全入口/u);
});

test("submission enrichment choice maps both platforms to creator detail and export", () => {
  const persist = registeredHooks().get("tool_result_persist");
  for (const platform of ["xhs", "dy"]) {
    const saved = persist({
      toolName: "ypscan_save_excel_artifact",
      params: {
        artifact_kind: "submission_batch",
        artifact_id: "123",
        excel_file_url: "https://files.eshypdata.com/exports/submission.xlsx",
        requirement_id: `req-${platform}`,
        platform,
      },
      message: toolMessage({
        success: true,
        data: { file_path: `/workspace/${platform}-submission.xlsx` },
        delivery: { next_args: submissionEnrichmentQuestionPayload() },
      }),
    });
    const text = directiveText(saved);
    assert.match(text, /GET_CREATOR_DETAIL_ARGS.*调用 get_creator_detail/u);
    assert.match(text, /GET_CREATOR_DETAIL_EXPORT_ARGS.*轮询 get_creator_detail_export/u);
    assert.match(text, /不得改字段配置/u);
    assert.match(text, /不得.*再次追问/u);
    assert.deepEqual(namedArgsFromDirective(text, "GET_CREATOR_DETAIL_ARGS"), {
      platform,
      batch_id: 123,
      requirement_id: `req-${platform}`,
    });
    assert.deepEqual(namedArgsFromDirective(text, "GET_CREATOR_DETAIL_EXPORT_ARGS"), {
      platform,
      batch_id: 123,
    });
  }
});

test("missing-platform submission saves do not offer creator enrichment", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const saved = persist({
    toolName: "ypscan_save_excel_artifact",
    params: {
      artifact_kind: "submission_batch",
      artifact_id: "123",
      excel_file_url: "https://files.eshypdata.com/exports/submission.xlsx",
      requirement_id: "req-missing",
    },
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/missing-submission.xlsx" },
      delivery: { next_args: { questions: [] } },
    }),
  });
  const text = directiveText(saved);
  assert.match(text, /不展示达人信息补全弹窗/u);
  assert.doesNotMatch(text, /GET_CREATOR_DETAIL_ARGS=|GET_CREATOR_DETAIL_EXPORT_ARGS=/u);
});

test("submission save rejects a malformed enrichment popup", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const saved = persist({
    toolName: "ypscan_save_excel_artifact",
    params: {
      artifact_kind: "submission_batch",
      artifact_id: "123",
      requirement_id: "req-malformed-popup",
      platform: "xhs",
    },
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/submission.xlsx" },
      delivery: { next_args: { questions: [] } },
    }),
  });
  const text = directiveText(saved);
  assert.match(text, /达人信息补全弹窗载荷无效/u);
  assert.doesNotMatch(
    text,
    /GET_CREATOR_DETAIL_ARGS=|GET_CREATOR_DETAIL_EXPORT_ARGS=|ASK_USER_QUESTION_ARGS=/u,
  );
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
  assert.match(text, /不切换到手动拓展分支/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("rank result is reserved for institutional inquiry after transient state resets", () => {
  const hooks = new Map();
  const transientState = registerFlowDirectiveHooks({
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
  const persist = hooks.get("tool_result_persist");
  persist({
    toolName: "validate_requirement",
    params: validateParamsWithMode("手动拓展"),
    message: toolMessage({ success: true, data: { requirement_id: "req-after-reset" } }),
  });
  transientState.resetTransientState();

  const ranked = persist({
    toolName: "rank_creators",
    params: { requirement_id: "req-after-reset" },
    message: toolMessage({ success: true, data: { ranked_count: 8 } }),
  });
  const text = directiveText(ranked);
  assert.match(text, /YPSCAN_NEXT_ACTION=APPLY_INQUIRY_RANK_POLICY/u);
  assert.match(text, /RANKED_COUNT=8/u);
  assert.match(text, /RANK_REQUIREMENT_ID=req-after-reset/u);
  assert.match(text, /生成当前机构询价提报表/u);
  assert.match(text, /手动拓展完成后不得调用本工具/u);
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
  assert.ok(text.length < 950, `parse directive too long: ${text.length}`);
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
    assertPopupLines(argsFromDirective(text));
    assert.deepEqual(
      argsFromDirective(text).questions[0].options.map((option) => option.label),
      ["重试", "结束本次"],
    );
  }
});

test("saved artifact hooks reject malformed popup payloads", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypscan_save_excel_artifact",
    params: { artifact_kind: "mcn_ranking", artifact_id: "req-popup" },
    message: toolMessage({
      success: true,
      data: { file_path: "/tmp/mcn-ranking.xlsx" },
      delivery: {
        local_file_link: "[排名表](<file:///tmp/mcn-ranking.xlsx>)",
        next_args: { questions: [] },
      },
    }),
  });

  assert.doesNotMatch(directiveText(result), /ASK_USER_QUESTION_ARGS=/u);
  assert.match(directiveText(result), /当前没有可选机构/u);
});

test("parse and startup directives enumerate required business values before validation", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const parse = persist({
    toolName: "ypscan_parse_requirement",
    message: toolMessage({ success: true, data: { outputs: {} } }),
  });
  const parseText = directiveText(parse);

  assert.match(parseText, /brandName、quantityTotal、submissionDeadlineAt、rebate、followercount/u);
  assert.match(parseText, /至少一个当前平台支持且与内容形式匹配的报价档位/u);
  assert.match(parseText, /contentTag.*解析结果.*重新解析/u);
  assert.match(parseText, /抖音仅使用 L2\/L3.*小红书不使用 L3/u);
  assert.doesNotMatch(parseText, /至少一个当前平台 kolOfficialPriceL1\/L2\/L3/u);
  assert.match(parseText, /缺失或有歧义.*按 Skill 一次性询问/u);
  assert.match(parseText, /最低返点要求是多少/u);
  assert.match(parseText, /选项只给单个最低返点百分比/u);
  assert.match(parseText, /禁止给返点区间、上限或“不限”类选项/u);

  const startup = registeredHooks().get("before_prompt_build")({}, { runId: "required-fields" });
  assert.match(
    startup.prependContext,
    /brandName、quantityTotal、submissionDeadlineAt、rebate、followercount/u,
  );
  assert.match(startup.prependContext, /至少一个当前平台支持且与内容形式匹配的报价档位/u);
  assert.match(startup.prependContext, /contentTag.*解析结果.*重新解析/u);
  assert.match(startup.prependContext, /抖音仅使用 L2\/L3.*小红书不使用 L3/u);
  assert.doesNotMatch(startup.prependContext, /至少一个当前平台 kolOfficialPriceL1\/L2\/L3/u);
  assert.match(startup.prependContext, /这些业务值缺失.*AskUserQuestion/u);
  assert.match(startup.prependContext, /最低返点要求是多少/u);
  assert.match(startup.prependContext, /选项只给单个最低返点百分比/u);
  assert.match(startup.prependContext, /上限固定按 100% 处理/u);
});

test("recipient selection reuses submitted fields or hands off to field selection", () => {
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

  assert.match(text, /同一 requirement_id 已提交字段配置/u);
  assert.match(text, /已提交字段配置则复用/u);
  assert.match(text, /否则调用 select_inquiry_form_fields/u);
  assert.match(text, /requirement_id.*req-inquiry/u);
  assert.match(text, /不得查询、缓存或重建 columns/u);
  assert.deepEqual(namedArgsFromDirective(text, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-inquiry",
  });
});

test("more than four inquiry recipients use a compact prompt without option truncation", () => {
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
  const recipient = namedArgsFromDirective(directiveText(result), "ASK_USER_QUESTION_ARGS")
    .questions[0];
  const text = directiveText(result);

  assert.equal(popupPlainText(recipient.header), "选择询价机构");
  assert.doesNotMatch(popupPlainText(recipient.question), /超过.*4.*选项/u);
  assert.match(popupPlainText(recipient.question), /候选机构共 5 家/u);
  assertPopupLines({ questions: [recipient] });
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
  assert.match(text, /空输入、未知机构、无法解析或存在歧义时，不得继续询价/u);
  assert.match(text, /重新调用本提示或结束本轮/u);
});

test("long institution names wrap without changing their matching identity", () => {
  const originalName = "这是一家名称超过二十个字符用于测试换行还原能力的机构";
  const payload = mcnRankingRecipientQuestionPayload([originalName, "机构 B"]);
  const wrappedName = payload.questions[0].options[0].label;

  assert.match(wrappedName, /\n/u);
  assert.equal(popupPlainText(wrappedName), originalName);
  assertPopupLines(payload);
});

test("recipient popup rejects empty names and deduplicates restored identities", () => {
  assert.equal(mcnRankingRecipientQuestionPayload([]), null);
  assert.equal(mcnRankingRecipientQuestionPayload(["", "\n", null]), null);

  const payload = mcnRankingRecipientQuestionPayload(["机构 A", "机构 \nA", "机构 A", "机构 B"]);
  assert.deepEqual(
    payload.questions[0].options.map((option) => popupPlainText(option.label)),
    ["机构 A", "机构 B"],
  );
  assertPopupLines(payload);
});

test("recipient popup avoids collisions with its fixed stop action", () => {
  const payload = mcnRankingRecipientQuestionPayload(["暂不询价"]);

  assert.deepEqual(
    payload.questions[0].options.map((option) => popupPlainText(option.label)),
    ["询价全部机构", "暂不询价"],
  );
  assert.equal(payload.questions[0].multiSelect, false);
  assertPopupLines(payload);
});

test("popup text prefers semantic breaks and keeps ASCII tokens intact", () => {
  const question = "进入 followercount 前必须检查品牌和数量，缺失时通过 AskUserQuestion 收集。";
  const description = "立即调用 get_creator_detail 异步补全当前批次，不再选择字段或追问";
  const payload = popupQuestionPayload("标题", question, [
    { label: "选项", description },
    { label: "结束", description: "结束当前步骤" },
  ]);
  assertPopupLines(payload);

  const questionLines = payload.questions[0].question.split("\n");
  assert.equal(popupPlainText(payload.questions[0].question), question);
  assert.ok(
    questionLines.some((line) => line.startsWith("前必须检查品牌和数量，")),
    "breaks after the clause punctuation",
  );

  const descriptionLines = payload.questions[0].options[0].description.split("\n");
  assert.equal(popupPlainText(payload.questions[0].options[0].description), description);
  assert.equal(descriptionLines[1].trim(), "get_creator_detail");
  for (const line of [...questionLines, ...descriptionLines]) {
    assert.ok(!/^[，。！？；：、]/u.test(line), "no punctuation stranded at line start");
  }
});

test("popup text normalizes carriage-return line endings", () => {
  const payload = popupQuestionPayload("标题\r\n分类", "第一行\r第二行", [
    { label: "继续", description: "执行\r\n当前步骤" },
    { label: "结束", description: "停止当前步骤" },
  ]);

  for (const question of payload.questions) {
    for (const value of [
      question.header,
      question.question,
      ...question.options.flatMap((option) => [option.label, option.description]),
    ]) {
      assert.doesNotMatch(value, /\r/u);
    }
  }
  assertPopupLines(payload);
});

test("popup payload validation rejects host-incompatible structures", () => {
  assert.equal(isPopupQuestionPayload({ questions: [] }), false);
  assert.equal(
    isPopupQuestionPayload({
      questions: [
        {
          header: "标题",
          question: "请选择。",
          options: [
            { label: "重复", description: "第一个动作" },
            { label: "重\n复", description: "第二个动作" },
          ],
          multiSelect: false,
        },
      ],
    }),
    false,
  );
  assert.throws(
    () =>
      popupQuestionPayload("标题", "请选择。", [
        { label: "唯一选项", description: "无法形成有效决策" },
      ]),
    /Invalid AskUserQuestion payload/u,
  );
});

test("popup text hard-splits an overlong ASCII token without losing characters", () => {
  const token = "get_creator_detail_export_v2";
  const payload = popupQuestionPayload("标题", "请选择工具。", [
    { label: token, description: "选项说明" },
    { label: "结束", description: "结束当前步骤" },
  ]);
  const wrappedLabel = payload.questions[0].options[0].label;

  assertPopupLines(payload);
  assert.match(wrappedLabel, /\n/u);
  assert.equal(popupPlainText(wrappedLabel), token);
});

test("business mode popup exposes the renamed user-facing option", () => {
  const payload = businessModeQuestionPayload();

  assert.deepEqual(
    payload.questions[0].options.map((option) => popupPlainText(option.label)),
    ["询价机构", "手动拓展"],
  );
  assert.doesNotMatch(JSON.stringify(payload), /直接手扒/u);
});

test("shared recovery popup templates preserve their actions and line limits", () => {
  const retry = flowRetryQuestionPayload("MCN 排名表保存");
  const ingest = ingestJobRecoveryQuestionPayload();
  const browser = browserVerificationQuestionPayload();

  for (const payload of [retry, ingest, browser]) assertPopupLines(payload);
  assert.deepEqual(
    retry.questions[0].options.map((option) => popupPlainText(option.label)),
    ["重试", "结束本次"],
  );
  assert.match(popupPlainText(ingest.questions[0].question), /缺少任务 ID/u);
  assert.deepEqual(
    browser.questions[0].options.map((option) => popupPlainText(option.label)),
    ["已处理，继续", "结束本次"],
  );
});

test("startup instruction selects and preserves one business mode", () => {
  const hooks = registeredHooks();
  const context = { runId: "startup-run" };
  const first = hooks.get("before_prompt_build")({}, context);

  assert.match(first.prependContext, /用户明确说.*询价机构.*直接使用/u);
  assert.match(first.prependContext, /明确说.*手动拓展.*统一使用用户侧模式“手动拓展”/u);
  assert.match(first.prependContext, /直接手扒\/手扒\/手捞筛选/u);
  assert.match(first.prependContext, /未明确、同时出现两种模式或语义冲突/u);
  assert.match(first.prependContext, /BUSINESS_MODE_QUESTION_ARGS=/u);
  assert.match(first.prependContext, /回答前不得解析或落库/u);
  assert.match(first.prependContext, /Provider 边界把“手动拓展”兼容映射为旧线值/u);
  assert.match(first.prependContext, /business_mode 只决定首次落库后的初始功能/u);
  assert.match(first.prependContext, /前一功能完成或明确停止后复用于另一功能/u);
  assert.match(first.prependContext, /功能切换本身不算需求修改/u);
  assert.match(first.prependContext, /已提交过字段配置时继续复用/u);
  assert.match(first.prependContext, /任何一行最多 20 个 Unicode 字符/u);
  assert.match(first.prependContext, /询价链路：解析→复核→validate_requirement/u);
  assert.match(first.prependContext, /手动拓展：解析→复核→validate_requirement/u);
  assert.match(first.prependContext, /rank_mcns 成功后先输出完整五列表格/u);
  assert.match(first.prependContext, /保存 MCN 排名表/u);
  assert.match(first.prependContext, /MCN 用户可见输出格式锁/u);
  assert.match(first.prependContext, /不得根据响应 schema、原始字段、旧模板或上一轮结果/u);
  assert.match(
    first.prependContext,
    /Supplier ID\/supplier_id、候选达人、供给占比、手动拓展补量、推荐理由/u,
  );
  assert.match(first.prependContext, /同一 requirement_id/u);
  assert.match(first.prependContext, /手动拓展分支先选择字段，再调用 manual_source_creators/u);
  assert.match(first.prependContext, /先等待 30 秒.*第 1 次查询 manual_source_creators_status/u);
  assert.match(
    first.prependContext,
    /手动拓展 Excel 保存成功后原样展示 delivery\.local_file_link/u,
  );
  assert.match(first.prependContext, /后台 API 完成平台达人搜索、详情抓取和筛选/u);
  assert.match(first.prependContext, /不再提供浏览器详细拓展分支/u);
  assert.match(first.prependContext, /同平台多个达人类型只创建一个 requirement/u);
  assert.match(first.prependContext, /本规则覆盖任何旧的平均分配或批量子需求指令/u);
  assert.doesNotMatch(
    first.prependContext,
    /ypscan_manual_research|YPSCAN_MANUAL_BROWSER_UNAVAILABLE|宿主 Browser/u,
  );
  assert.match(first.prependContext, /需求澄清规则/u);
  assert.match(first.prependContext, /同一字段新答案覆盖旧答案/u);
  assert.match(first.prependContext, /八个可选 Label 数组.*不调用 AskUserQuestion 确认/u);
  assert.match(first.prependContext, /contentTag.*重新解析.*禁止询问用户/u);
  assert.match(first.prependContext, /xtTalentTypeLabel/u);
  assert.match(first.prependContext, /只有这些必填数值仍缺失.*才调用 AskUserQuestion/u);
  assert.match(
    first.prependContext,
    /自定义输入成功解析为一个或多个当前机构的唯一编号或完整名称时成立/u,
  );
  assert.match(first.prependContext, /用户选中弹窗中的一个或多个当前机构/u);
  assert.match(first.prependContext, /选择“询价全部机构”.*全部当前机构/u);
  assert.match(first.prependContext, /空输入、未知机构、无法解析或存在歧义时，不得继续询价/u);
  assert.match(first.prependContext, /Dify 品牌候选唯一、合法且非空时必须原样作为 brandName/u);
  assert.match(first.prependContext, /不得询问、改写或被原文与 clarification 覆盖/u);
  assert.match(first.prependContext, /解析品牌缺失、多候选或为 null、未知等占位值时才询问/u);
  assert.match(first.prependContext, /项目名由 Agent 根据当前需求自行总结生成，不弹窗确认/u);
  assert.match(
    first.prependContext,
    /调用 validate_requirement 前用一句可见正文告知用户取的项目名/u,
  );
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
  assert.match(first.prependContext, /发送前必须用警示弹窗确认/u);
  assert.match(first.prependContext, /恰好两个选项/u);
  assert.match(first.prependContext, /不得把机构或消息列为选项/u);
  assert.match(first.prependContext, /description 与 wechat_notification_message 内容一致/u);

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

test("validate_requirement maps the user-facing manual mode before Provider serialization", () => {
  const before = registeredHooks().get("before_tool_call");
  const params = completeValidateParams();
  params.rawMessagesJson = {
    ...JSON.parse(params.rawMessagesJson),
    business_mode: "手动拓展",
  };

  const result = before({ toolName: "validate_requirement", params });

  assert.equal(result.block, undefined);
  assert.equal(params.rawMessagesJson.business_mode, "手动拓展");
  assert.equal(JSON.parse(result.params.rawMessagesJson).business_mode, "直接手扒");
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
  assert.deepEqual(
    JSON.parse(result.params.rawMessagesJson).parse_outputs,
    rawMessagesJson.parse_outputs,
  );
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
  assert.match(text, /发送前警示弹窗确认/u);
  assert.match(text, /手动拓展使用原 requirement_id 和 size/u);
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
  assert.ok(
    directiveText(rank).length < 1000,
    `empty rank directive too long: ${directiveText(rank).length}`,
  );

  const hooks = registeredHooks();
  const startup = hooks.get("before_prompt_build")({}, { runId: "manual-ban-run" });
  assert.match(startup.prependContext, /同一 requirement_id/u);
  assert.match(startup.prependContext, /手动拓展分支先选择字段，再调用 manual_source_creators/u);
  assert.match(startup.prependContext, /最终手动拓展结果/u);
  assert.match(startup.prependContext, /不调用 rank_creators 或 create_submission_batch/u);
  assert.match(startup.prependContext, /读取.*input schema/u);
  assert.match(startup.prependContext, /需求原文.*可选字段/u);
  assert.match(startup.prependContext, /去掉原文字段.*同一 requirement_id 和 size.*重试一次/u);
  assert.doesNotMatch(startup.prependContext, /ypscan_manual_research|宿主 Browser/u);
});

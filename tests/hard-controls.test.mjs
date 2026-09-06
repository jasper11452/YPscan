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
  mcnCreatorCompletionQuestionPayload,
  mcnRankingRecipientQuestionPayload,
  popupQuestionPayload,
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

function saveArtifactArgsFromDirective(text) {
  const line = text.split("\n").find((item) => item.startsWith("SAVE_ARTIFACT_ARGS="));
  return JSON.parse(line.slice("SAVE_ARTIFACT_ARGS=".length));
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
    platform: "douyin",
    rawMessagesJson: {
      original: "抖音需求原文",
      parse_outputs: {},
      business_mode: mode,
    },
  };
}

function completeValidateParamsForMode(mode) {
  const params = completeValidateParams();
  const rawMessagesJson = JSON.parse(params.rawMessagesJson);
  rawMessagesJson.business_mode = mode;
  params.rawMessagesJson = JSON.stringify(rawMessagesJson);
  return params;
}

test("validated requirements route by the previously selected business mode", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const validateContext = { sessionKey: "validated-requirements-route" };
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

  const validateInquiry = persist(
    {
      toolName: "ypmcn__validate_requirement",
      params: validateParamsWithMode("询价机构"),
      message: toolMessage({
        success: true,
        data: { id: "a".repeat(32), demand_id: "1787034545923844" },
      }),
    },
    validateContext,
  );
  assert.match(directiveText(validateInquiry), /当前需求只保留一个 requirement/u);
  assert.match(directiveText(validateInquiry), /业务模式：询价机构/u);
  assert.match(directiveText(validateInquiry), /严禁使用 data\.demand_id/u);
  assert.deepEqual(namedArgsFromDirective(directiveText(validateInquiry), "SEARCH_CREATORS_ARGS"), {
    id: "a".repeat(32),
  });
  assert.doesNotMatch(directiveText(validateInquiry), /SELECT_INQUIRY_FORM_FIELDS_ARGS=/u);

  const validateManual = persist(
    {
      toolName: "ypmcn__validate_requirement",
      params: validateParamsWithMode("手动拓展"),
      message: toolMessage({
        success: true,
        data: { id: "a".repeat(32), demand_id: "1787034545923844" },
      }),
    },
    validateContext,
  );
  assert.match(directiveText(validateManual), /业务模式：手动拓展/u);
  assert.deepEqual(
    namedArgsFromDirective(directiveText(validateManual), "SELECT_INQUIRY_FORM_FIELDS_ARGS"),
    { requirement_id: "a".repeat(32), platform: "douyin" },
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

  const search = persist(
    {
      toolName: "ypmcn__search_creators",
      params: { id: "a".repeat(32) },
      message: toolMessage({
        success: true,
        data: {
          total_matched: 0,
          creators_export_path:
            "https://mcp.eshypdata.com/api/download?file_path=creator-preview.xlsx",
        },
      }),
    },
    validateContext,
  );
  const searchText = directiveText(search);
  assert.match(searchText, /忽略 creators_export_path 等表格链接，不保存或展示/u);
  assert.match(searchText, /不调用保存工具/u);
  assert.match(searchText, /不得用 Browser、脚本或其他方式下载/u);
  assert.doesNotMatch(searchText, /SAVE_ARTIFACT_ARGS=/u);
  assert.deepEqual(namedArgsFromDirective(searchText, "RANK_MCNS_ARGS"), {
    id: "a".repeat(32),
    platform: "douyin",
  });

  const rank = persist({
    toolName: "ypmcn__rank_mcns",
    params: { id: "req-1", platform: "douyin" },
    message: toolMessage({
      success: true,
      data: { mcns: [{ agency_name: "机构 A", supplier_id: "supplier-a" }] },
    }),
  });
  assert.match(directiveText(rank), /完整 MCN Markdown 表格/u);
  assert.match(directiveText(rank), /用户可见正文文本块/u);
  assert.match(directiveText(rank), /MCN_OUTPUT_FORMAT_LOCK=/u);
  assert.match(directiveText(rank), /只能是五列：排名、机构、覆盖达人、返点、综合分/u);
  assert.match(directiveText(rank), /排名=rank_no（缺省按响应顺序）/u);
  assert.match(directiveText(rank), /机构=agency_name/u);
  assert.match(directiveText(rank), /返点=rebate_rate/u);
  assert.match(directiveText(rank), /综合分=rank_score/u);
  assert.match(directiveText(rank), /candidate_count/u);
  assert.match(directiveText(rank), /禁止展示 supplier_id、其他字段、汇总或历史数据/u);
  assert.match(directiveText(rank), /同一 requirement_id、同一平台.*唯一精确匹配/u);
  assert.match(directiveText(rank), /只传 supplierIds/u);
  assert.match(directiveText(rank), /传原始名称 supplier_name/u);
  assert.ok(
    directiveText(rank).length < 1650,
    `rank directive too long: ${directiveText(rank).length}`,
  );
  assert.doesNotMatch(directiveText(rank), /ypscan_manual_research|宿主 Browser/u);
  assert.doesNotMatch(directiveText(rank), /manual_source_creators_status/u);
  assert.doesNotMatch(directiveText(rank), /selection_id/u);
  const question = argsFromDirective(directiveText(rank));
  assert.deepEqual(
    question.questions[0].options.map((option) => option.label),
    ["机构 A", "询价全部机构", "暂不询价"],
  );
  assert.equal(question.questions[0].multiSelect, false);
  assert.deepEqual(question.questions[0].options, [
    { label: "机构 A", description: "选择该机构作为本次询价收件人" },
    { label: "询价全部机构", description: "选择本轮全部候选机构并进入字段选择" },
    { label: "暂不询价", description: "本轮不发送，可按当前列表继续" },
  ]);
  assert.doesNotMatch(JSON.stringify(question), /supplier-a/u);
  assert.match(directiveText(rank), /当前已处于询价机构分支/u);
  assert.match(directiveText(rank), /不得按排名或指标自行选择/u);
  assert.deepEqual(namedArgsFromDirective(directiveText(rank), "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-1",
    platform: "douyin",
  });
  assert.match(question.questions[0].question, /当前仅有 1 家候选机构/u);
  assert.match(question.questions[0].question, /自定义输入中填写完整名称/u);
  assert.doesNotMatch(question.questions[0].question, /下载链接/u);
  assert.doesNotMatch(question.questions[0].question, /\| 排名 \|/u);
  assert.doesNotMatch(question.questions[0].question, /匹配机构：/u);
});

test("business tools remain free of local mode gates after requirements complete", () => {
  const hooks = registeredHooks();
  const persist = hooks.get("tool_result_persist");
  const before = hooks.get("before_tool_call");
  const inquiryContext = { sessionKey: "reuse-inquiry" };
  const manualContext = { sessionKey: "reuse-manual" };
  const validateResult = (requirementId) =>
    toolMessage({ success: true, data: { requirement_id: requirementId } });

  persist(
    {
      toolName: "validate_requirement",
      params: validateParamsWithMode("询价机构"),
      message: validateResult("req-inquiry"),
    },
    inquiryContext,
  );
  persist(
    {
      toolName: "validate_requirement",
      params: validateParamsWithMode("手动拓展"),
      message: validateResult("req-manual"),
    },
    manualContext,
  );

  const manualTool = before({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-inquiry", num: 10 },
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
        mcns_download_url: "https://mcp.eshypdata.com/api/download?file_path=mcn-ranking.xlsx",
      },
    }),
  });
  const rankText = directiveText(rank);
  assert.match(rankText, /完整表格输出后立即使用下面参数保存/u);
  assert.match(rankText, /保存成功前不得展示本地路径/u);
  assert.deepEqual(saveArtifactArgsFromDirective(rankText), {
    artifact_kind: "mcn_ranking",
    artifact_id: "req-1",
    file_url: "https://mcp.eshypdata.com/api/download?file_path=mcn-ranking.xlsx",
    mcn_names: ["机构 A"],
  });
  assert.doesNotMatch(rankText, /ASK_USER_QUESTION_ARGS=/u);
  assert.doesNotMatch(
    rankText,
    /INQUIRY_RECIPIENT_SELECTION_ARGS|SELECT_INQUIRY_FORM_FIELDS_ARGS/u,
  );
  assert.doesNotMatch(rankText, /属于恢复当前询价分支/u);

  const saved = persist({
    toolName: "ypscan_save_artifact",
    params: saveArtifactArgsFromDirective(rankText),
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
  assert.match(savedText, /属于恢复当前询价分支/u);
  assert.deepEqual(
    argsFromDirective(savedText).questions[0].options.map((option) => option.label),
    ["机构 A", "询价全部机构", "暂不询价"],
  );
  assert.equal(argsFromDirective(savedText).questions[0].multiSelect, false);
  assert.deepEqual(namedArgsFromDirective(savedText, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-1",
    platform: "douyin",
  });
  assert.match(savedText, /把路径\/链接放入弹窗/u);

  const failed = persist({
    toolName: "ypscan_save_artifact",
    params: saveArtifactArgsFromDirective(rankText),
    message: toolMessage({ success: false, error: { code: "YPSCAN_EXCEL_DOWNLOAD_FAILED" } }),
  });
  assert.match(directiveText(failed), /MCN 排名表保存 已暂停/u);
});

test("default manual sourcing polls its status before saving the final artifact", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const sourced = persist({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-manual", num: 10, demand: "抖音科技耳机手动拓展 10 位" },
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
  assert.match(sourceText, /num 只在当前环境 live schema required 时才传/u);
  assert.match(sourceText, /等待 30 秒再进行第 1 次查询/u);
  assert.match(sourceText, /之后每隔 30 秒查询一次，单轮累计最多 10 次/u);
  assert.match(sourceText, /第 10 次仍未完成.*不得自动查询第 11 次/u);
  assert.match(sourceText, /不得猜测或更换 requirement_id 或 batch_id/u);
  assert.doesNotMatch(sourceText, /\bsize\b|creator_count|page_url|original_brief/u);
  assert.doesNotMatch(sourceText, /SAVE_ARTIFACT_ARGS=/u);
  assert.doesNotMatch(sourceText, /ASK_USER_QUESTION_ARGS=/u);

  const immediate = persist({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-manual", num: 10, demand: "抖音科技耳机手动拓展 10 位" },
    message: toolMessage({
      success: true,
      data: {
        requirement_id: "req-manual",
        excel_file_url: "https://files.eshypdata.com/exports/manual-direct.xlsx",
      },
    }),
  });
  const immediateText = directiveText(immediate);
  assert.match(immediateText, /SAVE_ARTIFACT_ARGS=/u);
  assert.match(immediateText, /YPSCAN_NEXT_ACTION=APPLY_MANUAL_SOURCE_RESULT_POLICY/u);
  assert.match(immediateText, /数量未知时交付当前 Excel 并结束/u);
  assert.match(immediateText, /实际数量为 0 或少于目标数量.*建议.*放宽/u);
  assert.match(immediateText, /创建独立的新 requirement/u);
  assert.deepEqual(saveArtifactArgsFromDirective(immediateText), {
    artifact_kind: "manual_source",
    artifact_id: "req-manual",
    file_url: "https://files.eshypdata.com/exports/manual-direct.xlsx",
  });
  assert.doesNotMatch(immediateText, /MANUAL_SOURCE_CREATORS_STATUS_ARGS=/u);
  assert.doesNotMatch(immediateText, /\bsize\b|creator_count|page_url|original_brief/u);

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
  assert.match(pendingText, /num 只在当前环境 live schema required 时才传/u);
  assert.match(pendingText, /未到第 10 次时等待 30 秒/u);
  assert.match(pendingText, /单轮累计最多 10 次/u);
  assert.match(pendingText, /当前对话累计查询次数/u);
  assert.match(pendingText, /第 10 次仍未完成.*如实报告并停止/u);
  assert.match(pendingText, /不得自动查询第 11 次/u);
  assert.doesNotMatch(pendingText, /继续查询\/暂时结束/u);
  assert.doesNotMatch(pendingText, /POLL_LIMIT_QUESTION_ARGS=/u);
  assert.doesNotMatch(pendingText, /SAVE_ARTIFACT_ARGS=/u);
  assert.doesNotMatch(pendingText, /ASK_USER_QUESTION_ARGS=/u);

  const completed = persist({
    toolName: "ypmcn__manual_source_creators_status",
    params: { requirement_id: "req-manual", batch_id: 42 },
    message: toolMessage({
      success: true,
      data: {
        requirement_id: "req-manual",
        creator_links_csv_url: "https://files.eshypdata.com/exports/manual-links.csv",
      },
    }),
  });
  const completedText = directiveText(completed);
  assert.deepEqual(saveArtifactArgsFromDirective(completedText), {
    artifact_kind: "manual_creator_links",
    artifact_id: "req-manual",
    file_url: "https://files.eshypdata.com/exports/manual-links.csv",
  });
  assert.match(
    completedText,
    /优先消费当前 Provider 响应中的 creator_links_csv_url|保存 links CSV/u,
  );
  assert.doesNotMatch(completedText, /ASK_USER_QUESTION_ARGS=/u);

  const saved = persist({
    toolName: "ypscan_save_artifact",
    params: {
      artifact_kind: "manual_source",
      artifact_id: "req-manual",
      file_url: "https://files.eshypdata.com/exports/manual.xlsx",
    },
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/manual.xlsx" },
    }),
  });
  const savedText = directiveText(saved);
  assert.match(savedText, /MANUAL_SOURCE_LOCAL_PATH=\/workspace\/manual\.xlsx/u);
  assert.match(savedText, /MANUAL_SOURCE_LOCAL_LINK=/u);
  assert.match(savedText, /最终打分排序 Excel 已保存|最终交付物/u);
  assert.match(savedText, /YPSCAN_NEXT_ACTION=APPLY_MANUAL_SOURCE_RESULT_POLICY/u);
  assert.match(savedText, /达到目标数量时结束/u);
  assert.match(savedText, /实际数量为 0 或少于目标数量.*建议.*放宽/u);
  assert.match(savedText, /创建独立的新 requirement/u);
  assert.match(savedText, /每次真正开始新的询价机构或手动拓展都必须先创建独立的新 requirement/u);
  assert.doesNotMatch(savedText, /RANK_CREATORS_ARGS=/u);
  assert.doesNotMatch(savedText, /CREATE_SUBMISSION_BATCH_ARGS=/u);
  assert.doesNotMatch(savedText, /ASK_USER_QUESTION_ARGS=/u);
  assert.doesNotMatch(savedText, /ypscan_manual_research|宿主 Browser/u);
});

test("manual sourcing normalizes a numeric batch string before status polling", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-manual", num: 10 },
    message: toolMessage({
      success: true,
      requirement_id: "req-manual",
      batch_id: "42",
    }),
  });

  assert.deepEqual(
    namedArgsFromDirective(directiveText(result), "MANUAL_SOURCE_CREATORS_STATUS_ARGS"),
    { requirement_id: "req-manual", batch_id: 42 },
  );
});

test("manual source status args prefill num from the validated requirement quantityTotal", () => {
  const hooks = registeredHooks();
  const before = hooks.get("before_tool_call");
  const persist = hooks.get("tool_result_persist");
  const context = { sessionKey: "manual-num-prefill" };
  const validateParams = completeValidateParams();
  before({ toolName: "ypmcn__validate_requirement", params: validateParams }, context);
  persist(
    {
      toolName: "ypmcn__validate_requirement",
      params: validateParams,
      message: toolMessage({ success: true, data: { requirement_id: "req-num" } }),
    },
    context,
  );
  const sourced = persist(
    {
      toolName: "ypmcn__manual_source_creators",
      params: { requirement_id: "req-num" },
      message: toolMessage({ success: true, requirement_id: "req-num", batch_id: 7 }),
    },
    context,
  );
  const sourceText = directiveText(sourced);
  assert.deepEqual(namedArgsFromDirective(sourceText, "MANUAL_SOURCE_CREATORS_STATUS_ARGS"), {
    requirement_id: "req-num",
    batch_id: 7,
  });
  assert.match(sourceText, /MANUAL_SOURCE_TARGET_NUM=30/u);
  assert.match(sourceText, /num 只在当前环境 live schema required 时才传/u);

  // 轮询续接：上一轮实际使用的 num（用户最新确认）优先于落库 quantityTotal。
  const continued = persist(
    {
      toolName: "ypmcn__manual_source_creators_status",
      params: { requirement_id: "req-num", batch_id: 7, num: "25" },
      message: toolMessage({
        success: false,
        error: { code: "BATCH_NOT_READY", message: "手动拓展任务处理中" },
      }),
    },
    context,
  );
  assert.deepEqual(
    namedArgsFromDirective(directiveText(continued), "MANUAL_SOURCE_CREATORS_STATUS_ARGS"),
    { requirement_id: "req-num", batch_id: 7 },
  );
  assert.match(directiveText(continued), /MANUAL_SOURCE_TARGET_NUM=25/u);

  // 未带 num 时回落到落库 quantityTotal。
  const resumed = persist(
    {
      toolName: "ypmcn__manual_source_creators_status",
      params: { requirement_id: "req-num", batch_id: 7 },
      message: toolMessage({
        success: false,
        error: { code: "BATCH_NOT_READY", message: "手动拓展任务处理中" },
      }),
    },
    context,
  );
  assert.deepEqual(
    namedArgsFromDirective(directiveText(resumed), "MANUAL_SOURCE_CREATORS_STATUS_ARGS"),
    { requirement_id: "req-num", batch_id: 7 },
  );
  assert.match(directiveText(resumed), /MANUAL_SOURCE_TARGET_NUM=30/u);
});

test("native completion pins the file bridge flow to the validated business mode", () => {
  const hooks = registeredHooks();
  const before = hooks.get("before_tool_call");
  const persist = hooks.get("tool_result_persist");
  const completionMessage = toolMessage({
    success: true,
    data: {
      csv_file: "/batch/completion.csv",
      successful_author_ids: ["a1", "a2"],
      failed_author_ids: [],
    },
  });

  // 手动拓展分支：flow=manual_source。
  const manualContext = { sessionKey: "completion-flow-manual" };
  const manualParams = completeValidateParamsForMode("手动拓展");
  before({ toolName: "ypmcn__validate_requirement", params: manualParams }, manualContext);
  persist(
    {
      toolName: "ypmcn__validate_requirement",
      params: manualParams,
      message: toolMessage({ success: true, data: { requirement_id: "req-completion-manual" } }),
    },
    manualContext,
  );
  const manualCompletion = persist(
    {
      toolName: "ypaction__get_douyin_author_business_card",
      params: { requirement_id: "req-completion-manual" },
      message: completionMessage,
    },
    manualContext,
  );
  assert.match(directiveText(manualCompletion), /^FILE_BRIDGE_FLOW=manual_source$/mu);

  // 询价机构分支：flow=manual_source（补全后统一打分排序）。
  const inquiryContext = { sessionKey: "completion-flow-inquiry" };
  const inquiryParams = completeValidateParams();
  before({ toolName: "ypmcn__validate_requirement", params: inquiryParams }, inquiryContext);
  persist(
    {
      toolName: "ypmcn__validate_requirement",
      params: inquiryParams,
      message: toolMessage({ success: true, data: { requirement_id: "req-completion-inquiry" } }),
    },
    inquiryContext,
  );
  const inquiryCompletion = persist(
    {
      toolName: "ypaction__get_xhs_author_business_card",
      params: { requirement_id: "req-completion-inquiry" },
      message: completionMessage,
    },
    inquiryContext,
  );
  assert.match(directiveText(inquiryCompletion), /^FILE_BRIDGE_FLOW=manual_source$/mu);

  // 无已校验模式时也固定为 manual_source（补全后统一打分排序）。
  // 宿主原生补全返回没有 success 字段：以 csv_file 存在为准判定成功。
  const fresh = registeredHooks().get("tool_result_persist");
  const unknownCompletion = fresh({
    toolName: "ypaction__get_douyin_author_business_card",
    params: { requirement_id: "req-unknown" },
    message: toolMessage({
      csv_file: "/batch/completion.csv",
      successful_author_ids: ["a1"],
      failed_author_ids: [],
    }),
  });
  const unknownText = directiveText(unknownCompletion);
  assert.match(unknownText, /^FILE_BRIDGE_FLOW=manual_source$/mu);
  assert.doesNotMatch(unknownText, /已暂停|ASK_USER_QUESTION_ARGS/u);
});

test("file_bridge delivers local-only and over-limit merged CSVs without downstream calls", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const localOnlyMessage = toolMessage({
    success: true,
    data: { file_path: "/workspace/merged.csv", data_row_count: 120 },
  });
  const localOnly = persist({
    toolName: "file_bridge",
    params: { requirement_id: "req-complete", flow: "mcn_complete_only" },
    message: localOnlyMessage,
  });
  const localOnlyText = directiveText(localOnly);
  assert.match(localOnlyText, /只补全达人信息/u);
  assert.match(localOnlyText, /MERGED_CSV_LOCAL_LINK=/u);
  assert.doesNotMatch(localOnlyText, /SCORE_MANUAL_SOURCE_CSV_ARGS|RANK_CREATORS_ARGS/u);

  const overLimit = persist({
    toolName: "file_bridge",
    params: { requirement_id: "req-over-limit", flow: "manual_source" },
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/too-many.csv", data_row_count: 501 },
    }),
  });
  const overLimitText = directiveText(overLimit);
  assert.match(overLimitText, /已跳过上传/u);
  assert.match(overLimitText, /MERGED_DATA_ROW_COUNT=501/u);
  assert.doesNotMatch(overLimitText, /SCORE_MANUAL_SOURCE_CSV_ARGS/u);
});

test("manual sourcing rejects a non-integer task batch", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-manual", num: 10 },
    message: toolMessage({
      success: true,
      requirement_id: "req-manual",
      batch_id: "batch-42",
    }),
  });
  const text = directiveText(result);

  assert.match(text, /手动拓展 已暂停/u);
  assert.doesNotMatch(text, /MANUAL_SOURCE_CREATORS_STATUS_ARGS=/u);
});

test("default manual sourcing repairs missing field selection before retrying", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const context = { sessionKey: "manual-source-missing-fields" };
  persist(
    {
      toolName: "ypmcn__validate_requirement",
      params: validateParamsWithMode("手动拓展"),
      message: toolMessage({ success: true, data: { requirement_id: "req-manual" } }),
    },
    context,
  );
  const result = persist(
    {
      toolName: "ypmcn__manual_source_creators",
      params: { requirement_id: "req-manual", num: 10 },
      message: toolMessage({
        success: false,
        error: { code: "REQUIREMENT_COLUMNS_NOT_CONFIGURED" },
      }),
    },
    context,
  );
  const text = directiveText(result);

  assert.deepEqual(namedArgsFromDirective(text, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-manual",
    platform: "douyin",
  });
  assert.match(text, /不得原参数重试/u);
  assert.match(text, /收到“好了”后/u);
  assert.match(text, /过去对其他 requirement.*不算当前 requirement 的提交证据/u);
  assert.match(text, /字段选择 URL 输出后本轮必须结束并等待/u);
  assert.doesNotMatch(text, /\bsize\b|creator_count|page_url|original_brief/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("default manual sourcing pauses without a task batch and falls back to params", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const sourced = persist({
    toolName: "ypmcn__manual_source_creators",
    params: { requirement_id: "req-nobatch", num: 10, demand: "抖音科技耳机手动拓展 10 位" },
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
  const completedText = directiveText(completed);
  assert.deepEqual(saveArtifactArgsFromDirective(completedText), {
    artifact_kind: "manual_source",
    artifact_id: "req-nobatch",
    file_url: "https://files.eshypdata.com/exports/fallback.xlsx",
  });
  assert.match(completedText, /唯一下一项.*本轮必须结束并等待用户明确确认/u);
  assert.match(completedText, /累计放宽只写入 rawMessagesJson\.clarifications/u);
  assert.match(completedText, /跨 requirement 的 keyword 差异只能作为线索/u);
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

  assert.deepEqual(saveArtifactArgsFromDirective(directiveText(result)), {
    artifact_kind: "manual_source",
    artifact_id: "req-multipart",
    file_url: "https://files.eshypdata.com/exports/multipart.xlsx",
  });
});

test("missing scoring columns return to field selection without repeating completed work", () => {
  const hooks = registeredHooks();
  const persist = hooks.get("tool_result_persist");
  const context = { sessionKey: "score-missing-columns" };
  persist(
    {
      toolName: "ypmcn__validate_requirement",
      params: { platform: "xiaohongshu" },
      message: toolMessage({ success: true, data: { requirement_id: "req-score-columns" } }),
    },
    context,
  );

  const directFailure = directiveText(
    persist(
      {
        toolName: "ypmcn__score_manual_source_csv",
        params: {
          requirement_id: "req-score-columns",
          csv_file_path: "https://bucket.oss-cn-shanghai.aliyuncs.com/current.csv",
        },
        message: toolMessage({
          success: false,
          error: {
            code: "REQUIREMENT_COLUMNS_UNAVAILABLE",
            message: "customer demand has no selected inquiry columns",
          },
        }),
      },
      context,
    ),
  );
  assert.deepEqual(namedArgsFromDirective(directFailure, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-score-columns",
    platform: "xiaohongshu",
  });
  assert.match(directFailure, /不得把失败 job 的 success_count 当成最终成功/u);
  assert.match(directFailure, /不得重新搜索、补全或调用 file_bridge/u);
  assert.match(directFailure, /结束本轮等待用户回复“好了”/u);
  assert.deepEqual(namedArgsFromDirective(directFailure, "SCORE_MANUAL_SOURCE_CSV_ARGS"), {
    requirement_id: "req-score-columns",
    csv_file_path: "https://bucket.oss-cn-shanghai.aliyuncs.com/current.csv",
  });
  assert.doesNotMatch(directFailure, /ASK_USER_QUESTION_ARGS|SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS/u);

  hooks.get("before_tool_call")(
    {
      toolName: "ypmcn__score_manual_source_csv",
      toolCallId: "score-submit",
      params: {
        requirement_id: "req-score-columns",
        csv_file_path: "https://bucket.oss-cn-shanghai.aliyuncs.com/current.csv",
      },
    },
    context,
  );
  persist(
    {
      toolName: "ypmcn__score_manual_source_csv",
      toolCallId: "score-submit",
      message: toolMessage({ success: true, data: { job_id: "job-columns" } }),
    },
    context,
  );
  const statusFailure = directiveText(
    persist(
      {
        toolName: "ypmcn__score_manual_source_csv_status",
        params: { job_id: "job-columns" },
        message: toolMessage({
          success: true,
          data: {
            job_id: "job-columns",
            status: "failed",
            success_count: 22,
            error: {
              code: "REQUIREMENT_COLUMNS_UNAVAILABLE",
              message: "customer demand has no selected inquiry columns",
            },
          },
        }),
      },
      context,
    ),
  );
  assert.deepEqual(namedArgsFromDirective(statusFailure, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-score-columns",
    platform: "xiaohongshu",
  });
  assert.match(statusFailure, /success_count.*最终成功/u);
  assert.deepEqual(namedArgsFromDirective(statusFailure, "SCORE_MANUAL_SOURCE_CSV_ARGS"), {
    requirement_id: "req-score-columns",
    csv_file_path: "https://bucket.oss-cn-shanghai.aliyuncs.com/current.csv",
  });
  assert.doesNotMatch(statusFailure, /继续使用同一 job_id 轮询|ASK_USER_QUESTION_ARGS/u);
});

test("columns recovery survives param retention and a generic outer job error", () => {
  const hooks = registeredHooks();
  const persist = hooks.get("tool_result_persist");
  const beforeCall = hooks.get("before_tool_call");
  const context = { sessionKey: "score-columns-lifecycle" };
  const csvPath = "https://bucket.oss-cn-shanghai.aliyuncs.com/merged.csv";

  persist(
    {
      toolName: "ypmcn__validate_requirement",
      params: { platform: "douyin" },
      message: toolMessage({ success: true, data: { requirement_id: "req-lifecycle" } }),
    },
    context,
  );
  beforeCall(
    {
      toolName: "ypmcn__score_manual_source_csv",
      toolCallId: "score-lifecycle",
      params: { requirement_id: "req-lifecycle", csv_file_path: csvPath },
    },
    context,
  );
  persist(
    {
      toolName: "ypmcn__score_manual_source_csv",
      toolCallId: "score-lifecycle",
      message: toolMessage({ success: true, data: { job_id: "job-lifecycle" } }),
    },
    context,
  );
  beforeCall(
    {
      toolName: "ypmcn__score_manual_source_csv_status",
      toolCallId: "status-lifecycle",
      params: { job_id: "job-lifecycle" },
    },
    context,
  );
  const statusFailure = directiveText(
    persist(
      {
        toolName: "ypmcn__score_manual_source_csv_status",
        toolCallId: "status-lifecycle",
        message: toolMessage({
          success: false,
          error: { code: "SCORE_JOB_FAILED", message: "job failed" },
          data: {
            job_id: "job-lifecycle",
            error: {
              code: "REQUIREMENT_COLUMNS_UNAVAILABLE",
              message: "customer demand has no selected inquiry columns",
            },
          },
        }),
      },
      context,
    ),
  );
  assert.deepEqual(namedArgsFromDirective(statusFailure, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    requirement_id: "req-lifecycle",
    platform: "douyin",
  });
  assert.deepEqual(namedArgsFromDirective(statusFailure, "SCORE_MANUAL_SOURCE_CSV_ARGS"), {
    requirement_id: "req-lifecycle",
    csv_file_path: csvPath,
  });
  assert.match(statusFailure, /结束本轮等待用户回复“好了”/u);
  assert.doesNotMatch(statusFailure, /继续使用同一 job_id 轮询/u);

  const directMasked = directiveText(
    persist(
      {
        toolName: "ypmcn__score_manual_source_csv",
        params: { requirement_id: "req-lifecycle", csv_file_path: csvPath },
        message: toolMessage({
          success: false,
          error: { code: "SCORE_JOB_FAILED", message: "job failed" },
          data: { error: { code: "REQUIREMENT_COLUMNS_NOT_CONFIGURED" } },
        }),
      },
      context,
    ),
  );
  assert.deepEqual(namedArgsFromDirective(directMasked, "SCORE_MANUAL_SOURCE_CSV_ARGS"), {
    requirement_id: "req-lifecycle",
    csv_file_path: csvPath,
  });
  assert.doesNotMatch(
    directMasked,
    /达人打分已提交异步打分任务|SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS/u,
  );
});

test("manual scoring polls score_manual_source_csv_status before saving the final Excel", () => {
  const persist = registeredHooks().get("tool_result_persist");

  const scored = persist({
    toolName: "ypmcn__score_manual_source_csv",
    params: { requirement_id: "req-score", csv_file_path: "/provider/merged.csv" },
    message: toolMessage({ success: true, data: { job_id: "job-score-1" } }),
  });
  const scoredText = directiveText(scored);
  assert.match(scoredText, /仅返回 job_id/u);
  assert.match(scoredText, /等待 30 秒再进行第 1 次查询/u);
  assert.match(scoredText, /单轮累计最多 10 次/u);
  assert.match(scoredText, /不得自动查询第 11 次/u);
  assert.match(scoredText, /不得猜测或更换 job_id/u);
  assert.deepEqual(namedArgsFromDirective(scoredText, "SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS"), {
    job_id: "job-score-1",
  });
  assert.doesNotMatch(scoredText, /SAVE_ARTIFACT_ARGS=/u);
  assert.doesNotMatch(scoredText, /ASK_USER_QUESTION_ARGS=/u);

  const pending = persist({
    toolName: "ypmcn__score_manual_source_csv_status",
    params: { job_id: "job-score-1" },
    message: toolMessage({ success: true, data: { status: "processing" } }),
  });
  const pendingText = directiveText(pending);
  assert.match(pendingText, /尚未完成/u);
  assert.match(pendingText, /同一 job_id 轮询/u);
  assert.match(pendingText, /单轮最多 10 次/u);
  assert.match(pendingText, /第 10 次仍未完成时如实报告并停止/u);
  assert.deepEqual(namedArgsFromDirective(pendingText, "SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS"), {
    job_id: "job-score-1",
  });
  assert.doesNotMatch(pendingText, /SAVE_ARTIFACT_ARGS=/u);

  const completed = persist({
    toolName: "ypmcn__score_manual_source_csv_status",
    params: { job_id: "job-score-1", requirement_id: "req-score" },
    message: toolMessage({
      success: true,
      data: {
        requirement_id: "req-score",
        excel_file_url: "https://files.eshypdata.com/exports/manual-scored.xlsx",
      },
    }),
  });
  const completedText = directiveText(completed);
  assert.match(completedText, /已完成/u);
  assert.deepEqual(saveArtifactArgsFromDirective(completedText), {
    artifact_kind: "manual_source",
    artifact_id: "req-score",
    file_url: "https://files.eshypdata.com/exports/manual-scored.xlsx",
  });
  assert.doesNotMatch(completedText, /SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS=/u);

  const failed = persist({
    toolName: "ypmcn__score_manual_source_csv_status",
    params: { job_id: "job-score-1" },
    message: toolMessage({ success: false, error: { code: "SCORE_JOB_FAILED" } }),
  });
  const failedText = directiveText(failed);
  assert.match(failedText, /达人打分结果查询 已暂停/u);
  assert.match(failedText, /ASK_USER_QUESTION_ARGS=/u);

  const syncExcel = persist({
    toolName: "ypmcn__score_manual_source_csv",
    params: { requirement_id: "req-score" },
    message: toolMessage({
      success: true,
      data: {
        requirement_id: "req-score",
        excel_file_url: "https://files.eshypdata.com/exports/manual-sync.xlsx",
      },
    }),
  });
  assert.deepEqual(saveArtifactArgsFromDirective(directiveText(syncExcel)), {
    artifact_kind: "manual_source",
    artifact_id: "req-score",
    file_url: "https://files.eshypdata.com/exports/manual-sync.xlsx",
  });
});

test("manual scoring status terminal recovers requirement id from the score job", () => {
  const persist = registeredHooks().get("tool_result_persist");
  persist({
    toolName: "ypmcn__score_manual_source_csv",
    params: { requirement_id: "req-score-recover", csv_file_path: "/provider/merged.csv" },
    message: toolMessage({ success: true, data: { job_id: "job-score-recover" } }),
  });
  const completed = persist({
    toolName: "ypmcn__score_manual_source_csv_status",
    params: { job_id: "job-score-recover" },
    message: toolMessage({
      success: true,
      data: {
        job_id: "job-score-recover",
        excel_file_url: "https://files.eshypdata.com/exports/manual-recovered.xlsx",
      },
    }),
  });
  const text = directiveText(completed);
  assert.deepEqual(saveArtifactArgsFromDirective(text), {
    artifact_kind: "manual_source",
    artifact_id: "req-score-recover",
    file_url: "https://files.eshypdata.com/exports/manual-recovered.xlsx",
  });
  assert.doesNotMatch(text, /SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS=/u);
});

test("manual scoring status terminal without any requirement id pauses instead of polling", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const orphan = persist({
    toolName: "ypmcn__score_manual_source_csv_status",
    params: { job_id: "job-orphan-score" },
    message: toolMessage({
      success: true,
      data: { excel_file_url: "https://files.eshypdata.com/exports/orphan.xlsx" },
    }),
  });
  const text = directiveText(orphan);
  assert.match(text, /达人打分结果查询.*已暂停/u);
  assert.doesNotMatch(text, /SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS=/u);
});

test("file_bridge returns score args for manual_source and compatibility rank args for mcn_rank", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "file_bridge",
    params: {
      requirement_id: "req-upload",
      flow: "mcn_rank",
    },
    message: toolMessage({
      success: true,
      data: {
        file_path: "/workspace/merged.csv",
        data_row_count: 20,
        csv_file_path: "/provider/merged.csv",
      },
    }),
  });
  const text = directiveText(result);
  assert.match(text, /已合并并完成 OSS 上传/u);
  assert.match(text, /live rank_creators schema 已明确支持 csv_file_path/u);
  assert.match(
    text,
    /当前测试 Provider 仍默认保留 rank_creators\(requirement_id,inquiry_ids\) 旧链路/u,
  );
  assert.deepEqual(namedArgsFromDirective(text, "RANK_CREATORS_ARGS"), {
    requirement_id: "req-upload",
    csv_file_path: "/provider/merged.csv",
  });

  const manualUpload = persist({
    toolName: "file_bridge",
    params: {
      requirement_id: "req-upload",
      flow: "manual_source",
    },
    message: toolMessage({
      success: true,
      data: {
        file_path: "/workspace/merged.csv",
        data_row_count: 20,
        csv_file_path: "/provider/merged.csv",
      },
    }),
  });
  assert.deepEqual(
    namedArgsFromDirective(directiveText(manualUpload), "SCORE_MANUAL_SOURCE_CSV_ARGS"),
    {
      requirement_id: "req-upload",
      csv_file_path: "/provider/merged.csv",
    },
  );
});

test("institutional retrieval syncs, ingests and polls before preview save", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const synced = persist({
    toolName: "test__sync_mcn_inquiry_status",
    params: { requirement_id: "req-ingest" },
    message: toolMessage({
      success: true,
      data: { requirement_id: "req-ingest", inquiries: [{ inquiry_id: 12 }, { inquiry_id: "13" }] },
    }),
  });
  const syncedText = directiveText(synced);
  assert.match(syncedText, /询价状态同步成功，已返回非空 inquiry_ids/u);
  assert.deepEqual(namedArgsFromDirective(syncedText, "INGEST_MCN_SUBMISSIONS_ARGS"), {
    inquiry_ids: ["12", "13"],
  });
  assert.doesNotMatch(syncedText, /GET_WORKFLOW_STATE_ARGS=/u);

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
  assert.doesNotMatch(directiveText(ingested), /SAVE_ARTIFACT_ARGS=/u);

  const pending = persist({
    toolName: "test__get_ingest_job",
    params: { job_id: "job-ingest-1" },
    message: toolMessage({ success: false, error: { code: "JOB_PENDING" } }),
  });
  assert.deepEqual(namedArgsFromDirective(directiveText(pending), "GET_INGEST_JOB_ARGS"), {
    job_id: "job-ingest-1",
  });
  assert.match(directiveText(pending), /同一 job_id/u);
  assert.match(directiveText(pending), /第 10 次仍未完成时如实报告并停止/u);
  assert.match(directiveText(pending), /不询问用户/u);
  assert.doesNotMatch(directiveText(pending), /ASK_USER_QUESTION_ARGS=/u);

  const completed = persist({
    toolName: "test__get_ingest_job",
    params: { job_id: "job-ingest-1" },
    message: toolMessage({
      success: true,
      data: {
        job_id: "job-ingest-1",
        requirement_id: "req-ingest",
        status: "succeeded",
        excel_file_url: "https://files.eshypdata.com/exports/mcn-preview.xlsx",
      },
    }),
  });
  const completedText = directiveText(completed);
  assert.match(
    completedText,
    /MCN_CREATOR_PREVIEW_URL=https:\/\/files\.eshypdata\.com\/exports\/mcn-preview\.xlsx/u,
  );
  assert.match(completedText, /保存机构达人预览表/u);
  assert.match(completedText, /ypscan_save_creator_links/u);
  assert.deepEqual(saveArtifactArgsFromDirective(completedText), {
    artifact_kind: "mcn_creator_preview",
    artifact_id: "req-ingest",
    file_url: "https://files.eshypdata.com/exports/mcn-preview.xlsx",
  });

  const previewSaved = persist({
    toolName: "ypscan_save_artifact",
    params: {
      artifact_kind: "mcn_creator_preview",
      artifact_id: "req-ingest",
      file_url: "https://files.eshypdata.com/exports/mcn-preview.xlsx",
    },
    message: toolMessage({ success: true, data: { file_path: "/workspace/mcn-preview.xlsx" } }),
  });
  const previewText = directiveText(previewSaved);
  assert.match(previewText, /机构达人预览表已保存/u);
  assert.match(previewText, /ypscan_save_creator_links 直接读取预览 xlsx/u);
  assert.match(previewText, /不要用普通 read 读取 xlsx/u);
  assert.match(previewText, /file_bridge（flow=manual_source）/u);
  assert.deepEqual(
    namedArgsFromDirective(previewText, "ASK_USER_QUESTION_ARGS"),
    mcnCreatorCompletionQuestionPayload(),
  );

  const linksGenerated = persist({
    toolName: "ypscan_save_creator_links",
    params: {
      requirement_id: "req-ingest",
      rows: [{ creator_id: "c1", url: "https://example.com/1" }],
    },
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/mcn-links.csv", row_count: 1 },
    }),
  });
  const linksText = directiveText(linksGenerated);
  assert.match(linksText, /受控 links CSV 已生成/u);
  assert.match(linksText, /MCN_CREATOR_LINKS_LOCAL_PATH=\/workspace\/mcn-links\.csv/u);
});

test("scored Excel delivery keeps inquiry and manual shortfall policies separate", () => {
  const hooks = registeredHooks();
  for (const mode of ["询价机构", "手动拓展"]) {
    const context = { sessionKey: `delivery-${mode}` };
    hooks.get("before_tool_call")(
      { toolName: "validate_requirement", params: completeValidateParamsForMode(mode) },
      context,
    );
    const saved = hooks.get("tool_result_persist")(
      {
        toolName: "ypscan_save_artifact",
        params: { artifact_kind: "manual_source", artifact_id: `req-${mode}` },
        message: toolMessage({ success: true, data: { file_path: "/workspace/scored.xlsx" } }),
      },
      context,
    );
    const text = directiveText(saved);
    assert.match(text, /MANUAL_SOURCE_LOCAL_LINK=/u);
    if (mode === "询价机构") {
      assert.match(text, /说明缺口后结束/u);
      assert.doesNotMatch(text, /APPLY_MANUAL_SOURCE_RESULT_POLICY|向用户建议|再向用户建议/u);
    } else {
      assert.match(text, /APPLY_MANUAL_SOURCE_RESULT_POLICY/u);
      assert.match(text, /再向用户建议/u);
    }
  }
});

test("ingest job partially_succeeded reports pending institutions honestly", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const completed = persist({
    toolName: "test__get_ingest_job",
    params: { job_id: "job-ingest-partial" },
    message: toolMessage({
      success: true,
      data: {
        job_id: "job-ingest-partial",
        requirement_id: "req-partial",
        status: "partially_succeeded",
        excel_file_url: "https://files.eshypdata.com/exports/mcn-preview-partial.xlsx",
        results: [
          { success: false, inquiry_id: 1216, error: { code: "DISTRIBUTION_NOT_SUBMITTED" } },
          { success: false, inquiry_id: "1217", error: { code: "DISTRIBUTION_NOT_SUBMITTED" } },
          { success: true, inquiry_id: "1219", error: null },
        ],
      },
    }),
  });
  const text = directiveText(completed);
  assert.match(text, /INGEST_PARTIAL_SUMMARY=已回填 1 家，pending 2 家/u);
  assert.match(text, /inquiry_id: 1216, 1217/u);
  assert.match(text, /不得把 partially_succeeded 当全部完成/u);
  assert.deepEqual(saveArtifactArgsFromDirective(text), {
    artifact_kind: "mcn_creator_preview",
    artifact_id: "req-partial",
    file_url: "https://files.eshypdata.com/exports/mcn-preview-partial.xlsx",
  });
});

test("failed async jobs stop instead of polling again", () => {
  const persist = registeredHooks().get("tool_result_persist");
  for (const toolName of ["get_ingest_job", "score_manual_source_csv_status"]) {
    const result = persist({
      toolName,
      params: { job_id: `job-${toolName}` },
      message: toolMessage({
        success: true,
        data: { job_id: `job-${toolName}`, status: "failed" },
      }),
    });
    const text = directiveText(result);
    assert.match(text, /任务已失败/u);
    assert.doesNotMatch(
      text,
      /继续使用同一 job_id|GET_INGEST_JOB_ARGS|SCORE_MANUAL_SOURCE_CSV_STATUS_ARGS/u,
    );
  }
});

test("summary-only partial ingest cannot invent pending institutions or qualified counts", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const text = directiveText(
    persist({
      toolName: "get_ingest_job",
      params: { job_id: "job" },
      message: toolMessage({
        success: true,
        data: {
          requirement_id: "req",
          status: "partially_succeeded",
          excel_file_url: "https://eshypdata.com/preview.xlsx",
          summary: { requested_count: 3, success_count: 1, failed_count: 2 },
          excel_row_count: 3,
        },
      }),
    }),
  );
  assert.match(text, /缺少逐机构明细/u);
  assert.match(text, /不能.*合格/u);
  assert.match(text, /不能.*待回填/u);
  assert.doesNotMatch(text, /pending 2 家/u);
});

test("partial ingest keeps real failures apart from unsubmitted institutions", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const text = directiveText(
    persist({
      toolName: "get_ingest_job",
      params: { job_id: "job" },
      message: toolMessage({
        success: true,
        data: {
          requirement_id: "req",
          status: "partially_succeeded",
          excel_file_url: "https://eshypdata.com/preview.xlsx",
          results: [
            { success: true, inquiry_id: "1" },
            { success: false, inquiry_id: "2", error: { code: "DISTRIBUTION_NOT_SUBMITTED" } },
            { success: false, inquiry_id: "3", error: { code: "IMPORT_FAILED" } },
          ],
        },
      }),
    }),
  );
  assert.match(text, /已回填 1 家，pending 1 家/u);
  assert.match(text, /处理失败 1 家/u);
  assert.match(text, /IMPORT_FAILED/u);
});

test("ingest job terminal recovers requirement id via inquiry ids when the response omits it", () => {
  const persist = registeredHooks().get("tool_result_persist");
  persist({
    toolName: "test__sync_mcn_inquiry_status",
    params: { requirement_id: "req-ingest-recover" },
    message: toolMessage({
      success: true,
      data: {
        requirement_id: "req-ingest-recover",
        inquiries: [{ inquiry_id: 31 }, { inquiry_id: "32" }],
      },
    }),
  });
  persist({
    toolName: "test__ingest_mcn_submissions",
    params: { inquiry_ids: ["31", "32"] },
    message: toolMessage({ success: true, data: { job_id: "job-ingest-recover" } }),
  });
  const completed = persist({
    toolName: "test__get_ingest_job",
    params: { job_id: "job-ingest-recover" },
    message: toolMessage({
      success: true,
      data: {
        job_id: "job-ingest-recover",
        excel_file_url: "https://files.eshypdata.com/exports/mcn-preview-recovered.xlsx",
      },
    }),
  });
  const text = directiveText(completed);
  assert.deepEqual(saveArtifactArgsFromDirective(text), {
    artifact_kind: "mcn_creator_preview",
    artifact_id: "req-ingest-recover",
    file_url: "https://files.eshypdata.com/exports/mcn-preview-recovered.xlsx",
  });
  assert.doesNotMatch(text, /GET_INGEST_JOB_ARGS=/u);
});

test("ingest job terminal without any requirement id pauses instead of polling", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const orphan = persist({
    toolName: "test__get_ingest_job",
    params: { job_id: "job-orphan-ingest" },
    message: toolMessage({
      success: true,
      data: {
        excel_file_url: "https://files.eshypdata.com/exports/orphan-preview.xlsx",
      },
    }),
  });
  const text = directiveText(orphan);
  assert.match(text, /异步入库结果查询.*已暂停/u);
  assert.doesNotMatch(text, /GET_INGEST_JOB_ARGS=/u);
});

test("institutional links CSV save no longer routes through the old workflow state fallback", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const linksSaved = persist({
    toolName: "ypscan_save_artifact",
    params: {
      artifact_kind: "mcn_creator_links",
      artifact_id: "req-no-mapping",
      file_url: "https://files.eshypdata.com/exports/mcn-links.csv",
    },
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/mcn-links.csv" },
      delivery: {
        local_file_link: "[/workspace/mcn-links.csv](<file:///workspace/mcn-links.csv>)",
      },
    }),
  });
  assert.equal(directiveText(linksSaved), "");
});

test("ranked submission save ends the inquiry ranking branch", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const saved = persist({
    toolName: "ypscan_save_artifact",
    params: {
      artifact_kind: "ranked_submission",
      artifact_id: "req-ranked",
      file_url: "https://files.eshypdata.com/exports/ranked-submission.xlsx",
    },
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/ranked-submission.xlsx" },
      delivery: {
        local_file_link:
          "[/workspace/ranked-submission.xlsx](<file:///workspace/ranked-submission.xlsx>)",
      },
    }),
  });
  const text = directiveText(saved);
  assert.match(text, /最终提报表已保存/u);
  assert.match(text, /原样展示本地链接并结束本轮机构回填精排链路/u);
  assert.doesNotMatch(text, /GET_CREATOR_DETAIL|create_submission_batch|ASK_USER_QUESTION_ARGS=/u);
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
  assert.match(text, /第一个工具是 sync_mcn_inquiry_status/u);
  assert.match(
    text,
    /ingest_mcn_submissions → get_ingest_job → 保存机构达人预览表 → ypscan_save_creator_links 读取预览并派生 links CSV/u,
  );
  assert.match(text, /不切换到手动拓展分支/u);
  assert.doesNotMatch(text, /第一个工具必须是 get_workflow_state/u);
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
    params: { requirement_id: "req-after-reset", inquiry_ids: ["11", "12"] },
    message: toolMessage({
      success: true,
      data: {
        ranked_count: 8,
        excel_file_url: "https://files.eshypdata.com/exports/ranked-after-reset.xlsx",
      },
    }),
  });
  const text = directiveText(ranked);
  assert.match(
    text,
    /rank_creators 成功。该调用的精排输入为当前 requirement_id 与本轮 sync 的 inquiry_ids/u,
  );
  assert.match(text, /直接保存最终提报 Excel 为 ranked_submission/u);
  assert.deepEqual(saveArtifactArgsFromDirective(text), {
    artifact_kind: "ranked_submission",
    artifact_id: "req-after-reset",
    file_url: "https://files.eshypdata.com/exports/ranked-after-reset.xlsx",
  });
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
  assert.match(text, /实际数、目标数、缺口和唯一下一项/u);
  assert.match(text, /提出后结束本轮并等用户确认该项/u);
  assert.match(text, /总体授权不替代逐轮确认/u);
  assert.match(text, /rawMessagesJson\.original 保留未改写原始需求/u);
  assert.match(text, /禁止改写 demand\/original/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
  assert.doesNotMatch(text, /恢复当前询价分支|前 5 家/u);
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
    toolName: "ypscan_save_artifact",
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
  assert.match(startup.prependContext, /数值澄清正文须先解释.*请选择或自定义输入/u);
  assert.match(
    startup.prependContext,
    /未提及则明确缺失字段.*“行业头部达人”等定性描述.*无法确定粉丝数范围/u,
  );
  assert.match(
    startup.prependContext,
    /不得只写“确认报价\/报价上限是多少”.*不得展示“落库\/Provider 参数”等内部术语/u,
  );
  assert.match(
    startup.prependContext,
    /每题设置 multiSelect=false.*恰好 3 个互斥且可直接回答该字段的具体值/u,
  );
  assert.match(
    startup.prependContext,
    /禁用“1 个数值\+返回修改\/取消”的二按钮结构.*自建“其他”选项.*宿主自定义输入/u,
  );
});

test("recipient selection reuses submitted fields or hands off to field selection", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const result = persist({
    toolName: "rank_mcns",
    params: { id: "req-inquiry", platform: "douyin" },
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
    platform: "douyin",
  });
});

test("more than four inquiry recipients use a compact prompt without option truncation", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const names = ["机构 A", "机构 B", "机构 C", "机构 D", "机构 E"];
  const result = persist({
    toolName: "rank_mcns",
    params: { id: "req-many", platform: "douyin" },
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
  assert.match(popupPlainText(recipient.question), /一次询价多家/u);
  assertPopupLines({ questions: [recipient] });
  names.slice(2).forEach((name) => assert.doesNotMatch(recipient.question, new RegExp(name, "u")));
  assert.equal(recipient.multiSelect, false);
  assert.deepEqual(recipient.options, [
    { label: "询价全部机构", description: "选择本轮全部候选机构并进入字段选择" },
    { label: "机构 A", description: "选择该机构作为本次询价收件人" },
    { label: "机构 B", description: "选择该机构作为本次询价收件人" },
    { label: "暂不询价", description: "本轮不发送，可按当前列表继续" },
  ]);
  assert.doesNotMatch(JSON.stringify(recipient.options), /机构 [C-E]/u);
  assert.match(text, /满足续办规则的后续消息/u);
  assert.match(text, /用户选中弹窗中的一个或多个当前机构/u);
  assert.match(text, /未命中当前机构或命中对象缺少 supplier_id 的原始名称/u);
  assert.match(text, /选择“询价全部机构”.*全部当前机构/u);
  assert.match(text, /空输入、未明确机构、无法解析、冲突或存在歧义时，不得继续询价/u);
  assert.match(text, /重新调用本提示或结束本轮/u);
  assert.match(text, /“前 5 家”等可按当前排名唯一确定的表达/u);
  assert.match(text, /属于恢复当前询价分支/u);
  assert.match(
    text,
    /不得重新调用 ypscan_parse_requirement、validate_requirement、search_creators 或 rank_mcns/u,
  );
  assert.match(text, /“暂不询价”只暂停发送，不算明确停止整个询价功能/u);
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
    ["机构 A", "机构 B", "询价全部机构", "暂不询价"],
  );
  assertPopupLines(payload);
});

test("recipient popup avoids collisions with its fixed stop action", () => {
  const payload = mcnRankingRecipientQuestionPayload(["暂不询价"]);

  assert.deepEqual(
    payload.questions[0].options.map((option) => popupPlainText(option.label)),
    ["表格第 1 家", "询价全部机构", "暂不询价"],
  );
  assert.equal(payload.questions[0].multiSelect, false);
  assertPopupLines(payload);
});

test("popup text prefers semantic breaks and keeps ASCII tokens intact", () => {
  const question = "进入 followercount 前必须检查品牌和数量，缺失时通过 AskUserQuestion 收集。";
  const description = "继续做原生补全、合并、上传、精排并交付最终提报表";
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
  assert.ok(descriptionLines.some((line) => line.includes("合并")));
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
  const token = "score_manual_source_csv_v2";
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
  assert.match(first.prependContext, /business_mode 决定本次新建 requirement 进入的功能/u);
  assert.match(
    first.prependContext,
    /每次真正开始新的询价机构或手动拓展都必须先创建独立的新 requirement/u,
  );
  assert.match(
    first.prependContext,
    /必须重新调用 ypscan_parse_requirement、复核并调用 validate_requirement/u,
  );
  assert.match(first.prependContext, /不得跨功能复用 requirement 或已提交字段配置/u);
  assert.match(first.prependContext, /新 requirement 必须重新调用 select_inquiry_form_fields/u);
  assert.match(first.prependContext, /当前 rank_mcns 列表后的暂不发送再续办/u);
  assert.match(first.prependContext, /属于恢复当前询价分支/u);
  assert.match(first.prependContext, /继续使用该列表所属 requirement、平台和 rank_mcns 机构映射/u);
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
  assert.match(first.prependContext, /返回 batch_id 后先等待 30 秒.*轮询/u);
  assert.match(
    first.prependContext,
    /手动拓展 Excel 保存成功后原样展示 delivery\.local_file_link/u,
  );
  assert.match(first.prependContext, /该工具由后台 API 完成搜索和落库/u);
  assert.match(first.prependContext, /数量未知时交付当前 Excel 并结束/u);
  assert.match(first.prependContext, /实际数量为 0 或少于目标数量.*建议.*放宽/u);
  assert.match(first.prependContext, /创建独立的新 requirement/u);
  assert.match(first.prependContext, /达到目标数量时结束/u);
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
  assert.match(first.prependContext, /满足续办规则的后续消息/u);
  assert.match(first.prependContext, /用户选中弹窗中的一个或多个当前机构/u);
  assert.match(first.prependContext, /未命中当前机构或命中对象缺少 supplier_id 的原始名称/u);
  assert.match(first.prependContext, /选择“询价全部机构”.*全部当前机构/u);
  assert.match(
    first.prependContext,
    /空输入、未明确机构、无法解析、冲突或存在歧义时，不得继续询价/u,
  );
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
      Object.assign(params, { kolOfficialPriceL1: "[35000,60000]" });
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
  assert.match(text, /不得改写、包装、用 Browser 替代打开/u);
  assert.match(text, /按 validate_requirement 返回的 requirement_id/u);
  assert.match(text, /不得使用 demand_id/u);
  assert.match(text, /调用已弃用的 get_selected_inquiry_form_fields/u);
  assert.match(text, /把 columns 放入上下文/u);
  assert.match(text, /收到“好了”后按原分支恢复/u);
  assert.match(text, /按原分支恢复/u);
  assert.match(text, /用户明确选中的当前 MCN/u);
  assert.match(text, /其他原名走 supplier_name/u);
  assert.match(text, /发送前警示弹窗确认/u);
  assert.match(text, /手动拓展只使用原 requirement_id 和当前环境 live schema 允许的参数/u);
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
  assert.match(startup.prependContext, /同一 requirement ID/u);
  assert.match(
    startup.prependContext,
    /sync_mcn_inquiry_status→ingest_mcn_submissions→get_ingest_job→保存机构达人预览表→ypscan_save_creator_links 直接读取预览 xlsx 并派生受控 links CSV/u,
  );
  assert.match(startup.prependContext, /score_manual_source_csv→score_manual_source_csv_status/u);
  assert.match(startup.prependContext, /num 的位置必须以当前环境 live schema 为准/u);
  assert.match(startup.prependContext, /手动拓展分支先选择字段，再调用 manual_source_creators/u);
  assert.match(
    startup.prependContext,
    /手动拓展 Excel 保存成功后原样展示 delivery\.local_file_link/u,
  );
  assert.match(startup.prependContext, /不再提供浏览器详细拓展分支，也不追加完成弹窗/u);
  assert.match(
    startup.prependContext,
    /调用 default manual_source_creators 前先读取实际 input schema/u,
  );
  assert.match(startup.prependContext, /用于需求原文的可选字段 demand/u);
  assert.match(startup.prependContext, /schema 不支持 demand 时不得猜字段名/u);
  assert.match(
    startup.prependContext,
    /若 schema required 含 num，则 requirement_id 与 num 一并传/u,
  );
  assert.doesNotMatch(startup.prependContext, /只传 requirement_id 和 num/u);

  assert.doesNotMatch(startup.prependContext, /ypscan_manual_research|宿主 Browser/u);
});

import assert from "node:assert/strict";
import test from "node:test";

import { registerFlowDirectiveHooks } from "../src/hooks/register-flow-directives.js";
import { mcnRankingBranchQuestionPayload } from "../src/tools/post-save-questions.js";

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
    }),
    contentThemeLabel: ["科技数码"],
    growTalentTypeLabel: ["成熟达人"],
    industryTagLabel: ["3C及电器-消费类电子产品"],
    xtTalentTypeLabel: ["科技数码-3C数码"],
    kolOfficialPriceL3: 50000,
    cpmL3: 500,
  };
}

test("fixed result directives skip the search workbook and save only after rank", () => {
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
  assert.match(parseText, /下一步由 Agent.*validate_requirement/u);
  assert.match(parseText, /不得调用 Browser/u);
  assert.match(parseText, /data\.outputs 仅包含当前 Provider 契约消费的 Workflow 字段/u);
  assert.match(parseText, /PARSER_OWNED_LOGICAL_FIELDS=/u);
  assert.match(parseText, /VALIDATE_REQUIREMENT_RANGE_FORMAT=/u);
  assert.match(parseText, /无空格 JSON 区间字符串 "\[min,max\]"/u);
  assert.match(parseText, /min < max/u);
  assert.match(parseText, /禁止再问用户/u);
  assert.match(parseText, /DIFY_RESOLVED_FIELDS=brandName,followercount,rebate,kolOfficialPrice/u);
  assert.match(parseText, /DIFY_MISSING_FIELDS=cpm,cpe/u);
  assert.match(parseText, /Dify 已给出的唯一数值候选直接采用/u);
  assert.match(parseText, /返点.*固定为 "\[min,1\]"/u);
  assert.match(parseText, /不得用 Provider 报错试探类型/u);
  assert.match(parseText, /同一次修改涉及两个及以上/u);
  assert.match(parseText, /只.*用户最初原文和后续改口.*重建完整单平台 demand/u);
  assert.match(parseText, /禁止把旧解析输出、已拓展价格或其他 Provider 归一化值写回 demand/u);
  assert.match(parseText, /先合并 original 与各数值字段最新非空 clarification/u);
  assert.match(parseText, /八个 Label 字段.*和 contentTag 是纯解析结果/u);
  assert.match(parseText, /xtTalentTypeLabel/u);
  assert.match(parseText, /有什么就原样落库什么/u);
  assert.match(parseText, /不做映射、不推断、不弹窗/u);
  assert.match(parseText, /同一字段新答案覆盖旧答案/u);
  assert.match(parseText, /Dify 品牌候选只有一个合法非空非占位值/u);
  assert.match(parseText, /不得询问、改写或被原文与 clarification 覆盖/u);
  assert.match(parseText, /解析品牌为空、多候选或占位值时才弹窗/u);
  assert.match(parseText, /submissionDeadlineAt 缺失或不精确/u);
  assert.match(parseText, /抖音报价、CPM、CPE 统一按视频类型映射/u);
  assert.match(parseText, /kolOfficialPriceL2\/cpmL2\/cpeL2 仅表示植入视频/u);
  assert.match(parseText, /kolOfficialPriceL3\/cpmL3\/cpeL3 仅表示定制视频/u);
  assert.match(parseText, /kolOfficialPriceL1\/cpmL1\/cpeL1 禁止使用/u);
  assert.match(parseText, /旧档位名不作为视频类型证据/u);
  assert.match(parseText, /确定性路由到当前 L2\/L3，不得因此询问用户/u);
  assert.match(parseText, /唯一且合法 followercount、rebate、报价、CPM 或 CPE 属于已解析数值/u);
  assert.match(parseText, /只创建一个 requirement/u);
  assert.match(parseText, /不询问每类人数、不创建子需求/u);
  assert.match(parseText, /本地边界完成预检后只序列化一次/u);
  assert.doesNotMatch(parseText, /VALIDATE_REQUIREMENT_ARGS=/u);

  const validate = persist({
    toolName: "ypmcn__validate_requirement",
    message: toolMessage({
      success: true,
      data: { id: "a".repeat(32), demand_id: "1787034545923844" },
    }),
  });
  assert.match(directiveText(validate), /当前需求只保留一个 requirement/u);
  assert.match(directiveText(validate), /不创建子需求、不重复落库/u);
  assert.match(directiveText(validate), /立即逐字使用 SEARCH_CREATORS_ARGS/u);
  assert.match(directiveText(validate), /严禁使用 data\.demand_id/u);
  assert.deepEqual(namedArgsFromDirective(directiveText(validate), "SEARCH_CREATORS_ARGS"), {
    id: "a".repeat(32),
  });

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
  assert.match(searchText, /不保存、不展示 creators_export_path/u);
  assert.match(searchText, /不得调用 ypscan_save_excel_artifact/u);
  assert.doesNotMatch(searchText, /SAVE_EXCEL_ARTIFACT_ARGS=/u);
  assert.deepEqual(namedArgsFromDirective(searchText, "RANK_MCNS_ARGS"), { id: "req-1" });

  const rank = persist({
    toolName: "ypmcn__rank_mcns",
    message: toolMessage({
      success: true,
      data: { mcns: [{ agency_name: "机构 A", supplier_id: "supplier-a" }] },
    }),
  });
  assert.match(directiveText(rank), /完整 MCN Markdown 表格/u);
  assert.match(directiveText(rank), /用户可见正文文本块/u);
  assert.match(directiveText(rank), /MCN_OUTPUT_FORMAT_LOCK=/u);
  assert.match(directiveText(rank), /不得根据响应 schema、原始字段、旧模板或上一轮结果/u);
  assert.match(directiveText(rank), /\| 排名 \| 机构 \| 覆盖达人 \| 返点 \| 综合分 \|/u);
  assert.ok(
    directiveText(rank).indexOf("MCN_OUTPUT_FORMAT_LOCK=") <
      directiveText(rank).indexOf("输出顺序："),
  );
  assert.match(directiveText(rank), /禁止改成项目符号或编号列表/u);
  assert.match(directiveText(rank), /排名、机构、覆盖达人、返点、综合分/u);
  assert.match(directiveText(rank), /只显示这一张五列表格/u);
  assert.match(directiveText(rank), /固定列且不得增减/u);
  assert.match(directiveText(rank), /排名严格按当前响应顺序从 1 开始连续编号/u);
  assert.match(directiveText(rank), /禁止在表格内外另行展示 supplier_id/u);
  assert.match(directiveText(rank), /匹配机构数、推荐数量/u);
  assert.match(directiveText(rank), /MCN:人工、推荐理由/u);
  assert.match(
    directiveText(rank),
    /Supplier ID\/supplier_id、候选达人、供给占比、手扒补量和推荐理由/u,
  );
  assert.match(directiveText(rank), /supplier_id 仅禁止对用户展示/u);
  assert.match(directiveText(rank), /不得丢失.*机构名与 supplier_id 的真实对应关系/u);
  assert.match(directiveText(rank), /supplier_id 是第一优先级/u);
  assert.match(directiveText(rank), /命中且有非空 supplier_id 就只放入 supplierIds/u);
  assert.match(directiveText(rank), /未匹配或无 ID 才把原始名称放入 supplier_name/u);
  assert.match(directiveText(rank), /candidate_count 原值/u);
  assert.match(directiveText(rank), /严禁使用累计字段 mcn_covered_creator_count/u);
  assert.match(directiveText(rank), /严禁与前序机构累加/u);
  assert.match(directiveText(rank), /不得用累计\/聚合覆盖字段或相邻行差值替代/u);
  assert.match(directiveText(rank), /表格不得放入弹窗 question/u);
  assert.match(directiveText(rank), /不要输出 MCN 排名表下载链接/u);
  assert.match(directiveText(rank), /MCN_RANKING_LOCAL_PATH/u);
  assert.doesNotMatch(directiveText(rank), /CREATOR_PREVIEW_LOCAL_PATH/u);
  assert.match(directiveText(rank), /本地 file_path 不得放入弹窗 question/u);
  assert.match(directiveText(rank), /不得在 AskUserQuestion 返回后补发/u);
  assert.match(directiveText(rank), /同一 requirement_id/u);
  assert.match(directiveText(rank), /直接复用 Provider 持久化字段并调用 manual_source_creators/u);
  assert.match(directiveText(rank), /不得再次调用 select_inquiry_form_fields/u);
  assert.match(directiveText(rank), /否则先调用 select_inquiry_form_fields/u);
  assert.match(directiveText(rank), /REQUIREMENT_COLUMNS_NOT_CONFIGURED/u);
  assert.match(directiveText(rank), /“手扒”“手动拓展”“人工拓展”“直接手扒”“手捞筛选”/u);
  assert.match(directiveText(rank), /一律默认走 MCP/u);
  assert.match(directiveText(rank), /manual_source_creators_status 轮询，间隔 30 秒、单轮最多 10 次/u);
  assert.match(directiveText(rank), /轮询成功返回 Excel 后立即用 ypscan_save_excel_artifact\(manual_source\) 保存/u);
  assert.match(directiveText(rank), /不得激活额外的浏览器手扒分支/u);
  assert.doesNotMatch(directiveText(rank), /ypscan_manual_research|宿主 Browser/u);
  assert.doesNotMatch(directiveText(rank), /selection_id/u);
  const question = argsFromDirective(directiveText(rank));
  assert.deepEqual(
    question.questions[0].options.map((option) => option.label),
    ["询价机构", "人工拓展并提报"],
  );
  assert.match(directiveText(rank), /“询价机构”仅选择业务分支/u);
  assert.match(directiveText(rank), /不得按排名、覆盖达人、返点、综合分或其他字段自行选择机构/u);
  const recipientQuestion = namedArgsFromDirective(
    directiveText(rank),
    "INQUIRY_RECIPIENT_SELECTION_ARGS",
  ).questions[0];
  assert.equal(recipientQuestion.multiSelect, true);
  assert.deepEqual(recipientQuestion.options, [
    { label: "机构 A", description: "选择该机构作为本次询价收件人" },
  ]);
  assert.doesNotMatch(JSON.stringify(recipientQuestion), /supplier-a/u);
  assert.match(question.questions[0].question, /弹窗打开前已在对话中完整展示/u);
  assert.match(question.questions[0].question, /MCN 排名表本地文件路径/u);
  assert.doesNotMatch(question.questions[0].question, /下载链接/u);
  assert.doesNotMatch(question.questions[0].question, /\| 排名 \|/u);
  assert.doesNotMatch(question.questions[0].question, /匹配机构：/u);
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
  assert.match(rankText, /完整 MCN Markdown 表格输出后.*ypscan_save_excel_artifact/u);
  assert.match(rankText, /保存成功前不得展示本地路径或调用 AskUserQuestion/u);
  assert.deepEqual(saveExcelArgsFromDirective(rankText), {
    artifact_kind: "mcn_ranking",
    artifact_id: "req-1",
    excel_file_url: "https://mcp.eshypdata.com/api/download?file_path=mcn-ranking.xlsx",
    mcn_count: 1,
  });
  assert.doesNotMatch(rankText, /ASK_USER_QUESTION_ARGS=/u);

  const saved = persist({
    toolName: "ypscan_save_excel_artifact",
    params: saveExcelArgsFromDirective(rankText),
    message: toolMessage({
      success: true,
      data: { file_path: "/workspace/mcn-ranking.xlsx" },
      delivery: {
        local_path: "/workspace/mcn-ranking.xlsx",
        next_args: mcnRankingBranchQuestionPayload(false),
      },
    }),
  });
  const savedText = directiveText(saved);
  assert.match(savedText, /MCN 排名表 Excel 已保存到当前项目/u);
  assert.match(savedText, /MCN_RANKING_LOCAL_PATH=\/workspace\/mcn-ranking\.xlsx/u);
  assert.match(
    savedText,
    /MCN_RANKING_LOCAL_LINK=\[\/workspace\/mcn-ranking\.xlsx\]\(<file:\/\/\/workspace\/mcn-ranking\.xlsx>\)/u,
  );
  assert.match(savedText, /不得只输出裸路径/u);
  assert.doesNotMatch(savedText, /CREATOR_PREVIEW_LOCAL_PATH/u);
  assert.match(savedText, /下面的 ASK_USER_QUESTION_ARGS/u);
  assert.deepEqual(
    argsFromDirective(savedText).questions[0].options.map((option) => option.label),
    ["询价机构", "人工拓展并提报"],
  );
  assert.match(savedText, /本地路径不得放进弹窗 question/u);

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
  assert.match(sourceText, /不含 Excel/u);
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
  assert.match(pendingText, /第 10 次仍为 BATCH_NOT_READY 时停止/u);
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
    artifact_id: "42",
    excel_file_url: "https://files.eshypdata.com/exports/manual.xlsx",
  });
  assert.match(completedText, /不向用户展示下载 URL/u);
  assert.doesNotMatch(completedText, /ASK_USER_QUESTION_ARGS=/u);

  const saved = persist({
    toolName: "ypscan_save_excel_artifact",
    params: {
      artifact_kind: "manual_source",
      artifact_id: "42",
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
  assert.match(savedText, /当前人工拓展交付/u);
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
  assert.match(text, /不得原参数重试 manual_source_creators/u);
  assert.match(text, /提交并回复“好了”后/u);
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
    artifact_id: "42",
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
    artifact_id: "7",
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
  assert.match(directiveText(pending), /同一个 job_id/u);
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
  assert.match(directiveText(completed), /原始 URL 直接输出为单独一行用户可见正文/u);
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
  assert.match(text, /选择“补充更新达人信息”.*固定调用 get_creator_detail/u);
  assert.match(text, /再用 get_creator_detail_export 轮询/u);
  assert.match(text, /不得调用 select_inquiry_form_fields/u);
  assert.match(text, /不得.*再次追问/u);
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


test("empty rank result still outputs the Markdown table and offers manual expansion or end", () => {
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
  const question = argsFromDirective(text).questions[0];
  assert.deepEqual(
    question.options.map((option) => option.label),
    ["人工拓展并提报", "结束本次"],
  );
  assert.match(question.question, /弹窗打开前已展示的“暂无匹配机构”Markdown 表格/u);
  assert.match(question.question, /MCN 排名表本地文件路径/u);
  assert.doesNotMatch(question.question, /下载链接/u);
  assert.doesNotMatch(question.question, /\| 暂无匹配机构 \|/u);
  assert.doesNotMatch(question.question, /匹配机构：/u);
});

test("parse directives preserve field ownership and change policy", () => {
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
  assert.match(text, /PARSER_OWNED_LOGICAL_FIELDS=/u);
  assert.match(text, /先合并 original 与各数值字段最新非空 clarification/u);
  assert.match(text, /八个 Label 字段.*和 contentTag 是纯解析结果/u);
  assert.match(text, /Dify 已给出的唯一数值候选直接采用，禁止再问用户/u);
  assert.match(text, /DIFY_RESOLVED_FIELDS=/u);
  assert.match(text, /DIFY_MISSING_FIELDS=/u);
  assert.match(text, /同一字段新答案覆盖旧答案/u);
  assert.match(text, /Dify 品牌候选只有一个合法非空非占位值/u);
  assert.match(text, /不得询问、改写或被原文与 clarification 覆盖/u);
  assert.match(text, /解析品牌为空、多候选或占位值时才弹窗/u);
  assert.match(text, /单次修改只涉及一个业务条件时，不再调用/u);
  assert.match(text, /同一次修改涉及两个及以上不同业务条件时/u);
  assert.match(text, /只.*用户最初原文和后续改口.*重建完整单平台 demand/u);
  assert.match(text, /禁止把旧解析输出、已拓展价格或其他 Provider 归一化值写回 demand/u);
  assert.match(text, /刷新全部解析字段/u);
  assert.match(text, /kolOfficialPriceL2\/cpmL2\/cpeL2 仅表示植入视频/u);
  assert.match(text, /kolOfficialPriceL3\/cpmL3\/cpeL3 仅表示定制视频/u);
  assert.match(text, /kolOfficialPriceL1\/cpmL1\/cpeL1 禁止使用/u);
  assert.match(text, /旧档位名不作为视频类型证据/u);
  assert.match(text, /只创建一个 requirement/u);
  assert.match(text, /不询问每类人数、不创建子需求/u);
  assert.match(text, /original 或该字段最新 clarification/u);
  assert.match(text, /已有确认答案时直接复用/u);
  assert.match(text, /项目名 projectName 由 Agent 根据当前需求自行总结生成/u);
  assert.match(text, /用一句用户可见正文告知本次取的项目名/u);
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

test("startup instruction makes backend manual sourcing the only manual path", () => {
  const hooks = registeredHooks();
  const context = { runId: "startup-run" };
  const first = hooks.get("before_prompt_build")({}, context);

  assert.match(
    first.prependContext,
    /ypscan_parse_requirement → validate_requirement → search_creators → rank_mcns → 完整 MCN Markdown 表格 → ypscan_save_excel_artifact\(mcn_ranking\) → MCN 排名表本地文件超链接/u,
  );
  assert.match(
    first.prependContext,
    /rank_mcns 后先把完整 MCN Markdown 表格作为用户可见正文文本块写出/u,
  );
  assert.match(first.prependContext, /rank_mcns 成功后先输出完整五列表格/u);
  assert.match(first.prependContext, /精确 SAVE_EXCEL_ARTIFACT_ARGS/u);
  assert.match(first.prependContext, /忽略其 creators_export_path 或其他表格链接/u);
  assert.match(first.prependContext, /不调用保存工具/u);
  assert.match(first.prependContext, /保存 MCN 排名表/u);
  assert.match(first.prependContext, /delivery\.local_file_link Markdown 超链接/u);
  assert.match(first.prependContext, /本地文件链接不得放进弹窗 question/u);
  assert.match(first.prependContext, /MCN 用户可见输出格式锁/u);
  assert.match(first.prependContext, /不得根据响应 schema、原始字段、旧模板或上一轮结果/u);
  assert.match(
    first.prependContext,
    /Supplier ID\/supplier_id、候选达人、供给占比、手扒补量、推荐理由/u,
  );
  assert.match(first.prependContext, /supplier_id 是第一优先级/u);
  assert.match(first.prependContext, /命中且有非空 supplier_id 就只放入 supplierIds/u);
  assert.match(first.prependContext, /未匹配或无 ID 才把原名放入 supplier_name/u);
  assert.match(first.prependContext, /同一 requirement_id/u);
  assert.match(first.prependContext, /直接调用 manual_source_creators/u);
  assert.match(first.prependContext, /不得再次调用 select_inquiry_form_fields/u);
  assert.match(first.prependContext, /否则先调用 select_inquiry_form_fields/u);
  assert.match(first.prependContext, /REQUIREMENT_COLUMNS_NOT_CONFIGURED/u);
  assert.match(first.prependContext, /默认手扒 Excel 保存成功后原样展示保存结果中的 delivery\.local_file_link/u);
  assert.match(first.prependContext, /“手扒”“手动拓展”“人工拓展”“直接手扒”“手捞筛选”/u);
  assert.match(first.prependContext, /一律默认走 MCP/u);
  assert.match(first.prependContext, /不再提供浏览器详细手扒分支/u);
  assert.match(first.prependContext, /同平台多个达人类型只创建一个 requirement/u);
  assert.match(first.prependContext, /本规则覆盖任何旧的平均分配或批量子需求指令/u);
  assert.doesNotMatch(first.prependContext, /ypscan_manual_research|YPSCAN_MANUAL_BROWSER_UNAVAILABLE|宿主 Browser/u);
  assert.match(first.prependContext, /需求澄清规则/u);
  assert.match(first.prependContext, /同一字段新答案覆盖旧答案/u);
  assert.match(first.prependContext, /Label 数组和 contentTag.*不调用 AskUserQuestion 确认/u);
  assert.match(first.prependContext, /xtTalentTypeLabel/u);
  assert.match(first.prependContext, /只有这些必填数值仍缺失.*才调用 AskUserQuestion/u);
  assert.match(first.prependContext, /Dify 品牌候选唯一、合法且非空时必须原样作为 brandName/u);
  assert.match(first.prependContext, /不得询问、改写或被原文与 clarification 覆盖/u);
  assert.match(first.prependContext, /解析品牌缺失、多候选或为 null、未知等占位值时才询问/u);
  assert.match(first.prependContext, /项目名由 Agent 根据当前需求自行总结生成，不弹窗确认/u);
  assert.match(first.prependContext, /调用 validate_requirement 前用一句可见正文告知用户取的项目名/u);
  assert.match(first.prependContext, /validate_requirement 数值字段格式锁/u);
  assert.match(first.prependContext, /无空格 JSON 区间字符串 "\[min,max\]"/u);
  assert.match(first.prependContext, /禁止通过 Provider 报错逐字段、逐类型试探/u);
  assert.match(first.prependContext, /首次按单平台完整需求.*ypscan_parse_requirement/u);
  assert.match(first.prependContext, /data\.outputs 仅返回当前 Provider 契约消费的 Workflow 字段/u);
  assert.match(first.prependContext, /解析结果负责八个标签数组/u);
  assert.match(first.prependContext, /Dify 品牌候选唯一且为合法非占位值时必须原样采用/u);
  assert.match(first.prependContext, /kolOfficialPriceL2\/cpmL2\/cpeL2=植入视频/u);
  assert.match(first.prependContext, /kolOfficialPriceL3\/cpmL3\/cpeL3=定制视频/u);
  assert.match(first.prependContext, /不使用任何 L1/u);
  assert.match(first.prependContext, /旧档位名不作为类型证据/u);
  assert.match(first.prependContext, /确定性路由到新档位，不得询问用户/u);
  assert.match(first.prependContext, /同平台多个达人类型只创建一个 requirement/u);
  assert.match(first.prependContext, /本规则覆盖任何旧的平均分配或批量子需求指令/u);
  assert.match(first.prependContext, /主达人类型字段 pgyBloggerTypeLabel\/xtTalentTypeLabel 为 null 或缺失时同样省略/u);
  assert.match(first.prependContext, /Dify 已给出的唯一 followercount、rebate、报价、CPM、CPE 直接采用/u);
  assert.match(first.prependContext, /单次修改只涉及一个条件时由 Agent 直接更新/u);
  assert.match(first.prependContext, /同一次修改涉及两个及以上不同业务条件时/u);
  assert.match(first.prependContext, /只能用用户最初原文和后续改口维护的当前原始条件重建完整单平台 demand/u);
  assert.match(first.prependContext, /禁止回填旧解析输出、已拓展价格或其他 Provider 归一化值/u);
  assert.match(first.prependContext, /绝不使用 data\.demand_id/u);
  assert.match(first.prependContext, /正常成功交付不追加完成弹窗/u);
  assert.match(first.prependContext, /包括 test 在内的前缀只是命名空间/u);
  assert.match(first.prependContext, /多个可用工具映射到同一实际名称时才调用 AskUserQuestion/u);

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
  assert.match(text, /原样输出为单独一行用户可见正文/u);
  assert.match(text, /禁止 Markdown 包装、重写、用 Browser 打开/u);
  assert.match(text, /按 requirement ID 持久化到 Provider 数据库/u);
  assert.match(text, /绝不是 demand_id/u);
  assert.match(text, /不得调用已弃用的 get_selected_inquiry_form_fields/u);
  assert.match(text, /不得.*把 columns 放入 Agent 上下文/u);
  assert.match(text, /等待用户完成选择后回复“好了”/u);
  assert.match(text, /恢复发起本次字段选择的原分支/u);
  assert.match(text, /撰写 description 与 wechat_notification_message/u);
  assert.match(text, /发送前确认/u);
  assert.match(text, /完整展示最终机构名称列表和完整企微消息/u);
  assert.match(text, /“确认发送”和“返回修改”/u);
  assert.match(text, /只有用户选择“确认发送”后才.*调用一次/u);
  assert.match(text, /返点只作内部筛选条件，绝不写入这两个消息字段/u);
  assert.match(text, /人工拓展分支.*调用 manual_source_creators/u);
  assert.match(text, /读取实际 input schema/u);
  assert.match(text, /需求原文的可选字段/u);
  assert.match(text, /去掉原文字段、保留同一 requirement_id 和 size 重试一次/u);
  assert.match(text, /不得再次调用 select_inquiry_form_fields/u);
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
  assert.match(text, /只有在用户已明确选中至少一家当前 MCN 后/u);
  assert.match(text, /绝不传空数组、按排名\/覆盖数自行挑选机构或自动发送/u);
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

test("rank and startup directives reuse submitted fields for the same requirement", () => {
  const persist = registeredHooks().get("tool_result_persist");
  const rank = persist({
    toolName: "ypmcn__rank_mcns",
    message: toolMessage({ success: true, data: { mcns: [] } }),
  });
  assert.match(directiveText(rank), /同一 requirement_id/u);
  assert.match(directiveText(rank), /不得再次调用 select_inquiry_form_fields/u);
  assert.match(directiveText(rank), /否则先调用 select_inquiry_form_fields/u);
  assert.match(directiveText(rank), /REQUIREMENT_COLUMNS_NOT_CONFIGURED/u);
  assert.match(directiveText(rank), /manual_source_creators_status 轮询，间隔 30 秒、单轮最多 10 次/u);
  assert.match(directiveText(rank), /轮询成功返回 Excel 后立即用 ypscan_save_excel_artifact\(manual_source\) 保存/u);
  assert.match(directiveText(rank), /读取.*input schema/u);
  assert.match(directiveText(rank), /需求原文.*可选字段/u);
  assert.match(directiveText(rank), /去掉原文字段.*同一 requirement_id 和 size.*重试一次/u);

  const hooks = registeredHooks();
  const startup = hooks.get("before_prompt_build")({}, { runId: "manual-ban-run" });
  assert.match(startup.prependContext, /同一 requirement_id/u);
  assert.match(startup.prependContext, /直接调用 manual_source_creators/u);
  assert.match(startup.prependContext, /不得再次调用 select_inquiry_form_fields/u);
  assert.match(startup.prependContext, /否则先调用 select_inquiry_form_fields/u);
  assert.match(startup.prependContext, /REQUIREMENT_COLUMNS_NOT_CONFIGURED/u);
  assert.match(startup.prependContext, /读取.*input schema/u);
  assert.match(startup.prependContext, /需求原文.*可选字段/u);
  assert.match(startup.prependContext, /去掉原文字段.*同一 requirement_id 和 size.*重试一次/u);
  assert.doesNotMatch(startup.prependContext, /ypscan_manual_research|宿主 Browser/u);
});

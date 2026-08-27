import { firstString, isRecord, nonemptyString } from "../util/value.js";
import {
  normalizeToolCallParams,
  stripHostPrefix,
  VALIDATE_REQUIREMENT_RANGE_PARAMS,
  validateRequirementPreflight,
} from "../contract/registry.js";
import { mcnRankingBranchQuestionPayload } from "../tools/post-save-questions.js";
import { localFileMarkdownLink } from "../tools/save-excel-artifact.js";

const HOOK_OPTIONS = { priority: 90, timeoutMs: 5000 };
const REQUIREMENT_PREFLIGHT_BLOCKED = "YPSCAN_REQUIREMENT_PREFLIGHT_BLOCKED";
const REQUIREMENT_RANGE_FORMAT = '无空格 JSON 区间字符串 "[min,max]"，且 min < max';
const MANUAL_SOURCE_ORIGINAL_TEXT_RULE =
  "调用默认 manual_source_creators 前先读取实际 input schema：若明确提供需求原文的可选字段，优先在该字段传当前完整、未改写的用户原始需求文本；只传原文，不传解析输出或 rawMessagesJson。schema 不支持该字段时只传 requirement_id 和 size；若仅因未知可选字段拒绝，则去掉原文字段、保留同一 requirement_id 和 size 重试一次，不得猜字段名或用该回退掩盖其他业务错误。";
const SINGLE_REQUIREMENT_TYPE_RULE =
  "同平台多个达人类型只创建一个 requirement：保留用户给出的总量，合并全部类型标签与条件，不拆分子需求、不重复落库、不重复搜索；本规则覆盖任何旧的平均分配或批量子需求指令。";
const PARSED_METRIC_REUSE_RULE =
  "解析 Workflow 已给出的唯一且合法 followercount、rebate、报价、CPM 或 CPE 属于已解析数值，必须直接采用，禁止再问；原文精确单价与 Provider 检索区间只是表达格式不同，不得因此创建报价区间弹窗。粉丝技术上限溢出由本地截断到 999999999，不弹窗。只有这些字段缺失、null、多候选或与用户明确改口冲突时才调用 AskUserQuestion。";

const MANUAL_SOURCE_POLL_RULE =
  "这是异步轮询，不调用 AskUserQuestion、不重新提交 manual_source_creators，也不得猜测或更换 requirement_id 或 batch_id。轮询间隔 30 秒，单轮最多查询 10 次";


function paramsFromEvent(event) {
  if (isRecord(event?.params)) return event.params;
  if (isRecord(event?.arguments)) return event.arguments;
  if (isRecord(event?.input)) return event.input;
  return {};
}

function serializeProviderRawMessages(params) {
  if (!isRecord(params.rawMessagesJson)) return params;
  return { ...params, rawMessagesJson: JSON.stringify(params.rawMessagesJson) };
}

function messageText(message) {
  return messageTextParts(message).join("\n");
}

function messageTextParts(message) {
  if (typeof message === "string") return [message];
  if (!isRecord(message)) return [];
  if (typeof message.text === "string") return [message.text];
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : part?.text))
      .filter(nonemptyString);
  }
  return typeof message.content === "string" ? [message.content] : [];
}

function leadingJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function parsedToolResult(message) {
  const parts = messageTextParts(message)
    .map((part) => part.trim())
    .filter(Boolean);
  const texts = [...parts, parts.join("\n")];
  for (const text of texts) {
    try {
      return JSON.parse(text);
    } catch {
      // Prefer a complete JSON text block before extracting embedded JSON.
    }
  }
  for (const text of texts) {
    const json = leadingJson(text);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch {
      // Continue to the next text block.
    }
  }
  return null;
}

function askQuestion(header, question, options, multiSelect = false) {
  return {
    questions: [{ header, question, options, multiSelect }],
  };
}

function flowPauseDirective(stage, message) {
  const result = parsedToolResult(message);
  const code = nonemptyString(result?.error?.code) ? result.error.code : "结果未能继续";
  return [
    `YPSCAN_FLOW_DIRECTIVE=${stage} 已暂停（${code}）。使用下方 AskUserQuestion 选择重试或结束。`,
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(
      askQuestion("悦普识星下一步", `${stage} 无法自动继续，请选择下一步。`, [
        { label: "重试", description: "按当前参数重试" },
        { label: "结束本次", description: "保留结果并结束" },
      ]),
    )}`,
  ].join("\n");
}

function isUsableDifyValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const text = value.trim();
    return text !== "" && text.toLowerCase() !== "null";
  }
  if (Array.isArray(value)) return value.some((item) => isUsableDifyValue(item));
  if (typeof value === "object") {
    return Object.values(value).some((item) => isUsableDifyValue(item));
  }
  return typeof value === "number" ? Number.isFinite(value) : typeof value === "boolean";
}

function classifyDifyOutputs(outputs) {
  /** @type {string[]} */
  const resolved = [];
  /** @type {string[]} */
  const missing = [];
  if (!isRecord(outputs)) {
    return {
      resolved,
      missing: ["brandName", "followercount", "rebate", "kolOfficialPrice", "cpm", "cpe"],
    };
  }
  const brandCandidates = [
    ...new Set(
      [outputs.brandName, outputs.dybrandName, outputs.xhsbrandName]
        .flatMap((source) => (Array.isArray(source) ? source : [source]))
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(
          (item) =>
            item &&
            !/^(?:null|undefined|未知|未明确|未提及|未提供|暂无|无|不详|待确认|待定)$/iu.test(
              item,
            ),
        ),
    ),
  ];
  if (brandCandidates.length === 1) resolved.push("brandName");
  else missing.push("brandName");
  for (const field of ["followercount", "rebate"]) {
    if (isUsableDifyValue(outputs[field])) resolved.push(field);
    else missing.push(field);
  }
  if (
    [
      outputs.kolOfficialPrice,
      outputs.kolOfficialPriceL1,
      outputs.kolOfficialPriceL2,
      outputs.kolOfficialPriceL3,
      outputs.dy_kolOfficialPrice,
      outputs.xhs_kolOfficialPrice,
    ].some(isUsableDifyValue)
  ) {
    resolved.push("kolOfficialPrice");
  } else missing.push("kolOfficialPrice");
  if (
    [outputs.cpm, outputs.cpmL1, outputs.cpmL2, outputs.cpmL3, outputs.dy_cpm, outputs.xhs_cpm].some(
      isUsableDifyValue,
    )
  ) {
    resolved.push("cpm");
  } else missing.push("cpm");
  if (
    [outputs.cpe, outputs.cpeL1, outputs.cpeL2, outputs.cpeL3, outputs.dy_cpe, outputs.xhs_cpe].some(
      isUsableDifyValue,
    )
  ) {
    resolved.push("cpe");
  } else missing.push("cpe");
  for (const field of [
    "growBloggerTypeLabel",
    "contentFeatureLabel",
    "contentThemeLabel",
    "kolPersonaLabel",
    "pgyBloggerTypeLabel",
    "xtTalentTypeLabel",
    "industryTagLabel",
    "growTalentTypeLabel",
    "contentTag",
  ]) {
    if (Array.isArray(outputs[field]) && outputs[field].length > 0) resolved.push(field);
  }
  return { resolved, missing };
}

function parseOutputsFromMessage(message) {
  const result = parsedToolResult(message);
  if (isRecord(result?.data?.outputs)) return result.data.outputs;
  if (isRecord(result?.outputs)) return result.outputs;
  return null;
}

function requirementParseSuccessDirective(message) {
  const { resolved, missing } = classifyDifyOutputs(parseOutputsFromMessage(message));
  return [
    "YPSCAN_FLOW_DIRECTIVE=需求解析成功。data.outputs 仅包含当前 Provider 契约消费的 Workflow 字段。按当前平台和字段名结构化展开、补齐必填项后调用 validate_requirement；不得调用 Browser、search_creators 或直接结束。",
    `DIFY_RESOLVED_FIELDS=${resolved.join(",")}`,
    `DIFY_MISSING_FIELDS=${missing.join(",")}`,
    "DIFY_RESOLVED_FIELDS 中的唯一值直接采用；DIFY_MISSING_FIELDS 与非解析必填项按启动规则收集确认。标签有则原样保留，无则省略；不要把解析输出整体塞入 Provider 参数。",
  ].join("\n");
}

function requirementPreflightBlockReason(issues) {
  const details = issues.map((issue) => `${issue.field}: ${issue.reason}`).join("；");
  return [
    REQUIREMENT_PREFLIGHT_BLOCKED,
    "validate_requirement 未执行，Provider 没有收到本次写入。",
    `一次性修正项：${details}`,
    `格式契约：rebate、followercount、kolOfficialPriceL1/L2/L3、cpmL1/L2/L3、cpeL1/L2/L3 以及其他数值筛选字段全部使用${REQUIREMENT_RANGE_FORMAT}；返点固定为 "[min,1]"。`,
    "只允许对当前有效用户证据中的唯一明确值做确定性格式归一化。先检查当前对话是否已有该字段的有效弹窗答案：数值字段答案写回 rawMessagesJson.clarifications；同一字段新答案覆盖旧答案，不得再次询问。只有仍缺失、模糊、冲突、多候选或需要选择的业务值才调用 AskUserQuestion。解析标签不在此列：八个 Label 和 contentTag 有什么原样落库，null 或缺失就省略，不做映射、不推断、不询问。不得自主补值或改变一种类型后继续盲试。",
  ].join("\n");
}

function requirementPreflightBlockedDirective() {
  return [
    "YPSCAN_FLOW_DIRECTIVE=validate_requirement 已被本地预检阻断，Provider 未执行写入。一次处理工具错误列出的全部字段，不得把阻断说成 Provider 报错。",
    `REQUIREMENT_RANGE_FORMAT=${REQUIREMENT_RANGE_FORMAT}。禁止数组、对象、单值和百分号文本直接进入数值筛选字段。`,
    "先把当前对话中已经回答但漏传的字段补回 rawMessagesJson.clarifications；只对仍未回答、无效、冲突或需选择的字段在同一次 AskUserQuestion 中成组收集（最多四题）。标签有则原样落库、缺失就省略；projectName 由 Agent 根据当前需求自行总结生成。禁止自主选择、默认补值或重试探测。",
  ].join("\n");
}

const MCN_MARKDOWN_TABLE_HEADER = [
  "| 排名 | 机构 | 覆盖达人 | 返点 | 综合分 |",
  "| --- | --- | --- | --- | --- |",
].join("\n");
const MCN_MARKDOWN_EMPTY_ROW = "| — | 暂无匹配机构 | — | — | — |";

const FIELD_SELECTION_AUTO_OPEN_FAILED = "浏览器打开请求未成功";

function inquiryRecipientOptions(mcns) {
  const names = new Set();
  return mcns.flatMap((mcn) => {
    const name = firstString(mcn?.agency_name, mcn?.supplier_name, mcn?.mcn_name, mcn?.name);
    const normalizedName = name?.trim();
    if (!normalizedName || names.has(normalizedName)) return [];
    names.add(normalizedName);
    return [{ label: normalizedName, description: "选择该机构作为本次询价收件人" }];
  });
}

function fieldSelectionDirective(message) {
  const result = parsedToolResult(message);
  const autoOpenFailed =
    String(firstString(result?.message, result?.error?.message)).trim() ===
    FIELD_SELECTION_AUTO_OPEN_FAILED;
  const url = firstString(result?.url, result?.data?.url);
  const linkReady = result?.success === true || (result?.success === false && autoOpenFailed);
  if (!linkReady || !url) return flowPauseDirective("字段选择", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=字段选择链接已生成。原样输出 URL 后停止业务调用，等待用户提交并回复“好了”；不得改写、包装、用 Browser 打开或替用户选择字段。",
    `FIELD_SELECTION_URL=${url}`,
    "Provider 按 validate_requirement 返回的 requirement_id（缺失时兼容 data.id）持久化 columns；不得使用 demand_id、把 columns 放入上下文或调用已弃用的 get_selected_inquiry_form_fields。收到“好了”后按原分支恢复：询价只使用用户明确选中的当前 MCN并做发送前确认，人工拓展使用原 requirement_id 和 size。",
  ].join("\n");
}

function rankMcnsExcelUrl(result) {
  return firstString(
    result?.data?.mcns_export_path,
    result?.data?.mcn_export_path,
    result?.data?.rank_mcns_export_path,
    result?.data?.excel_file_url,
    result?.data?.excel_url,
    result?.data?.result?.mcns_export_path,
    result?.data?.result?.mcn_export_path,
    result?.data?.result?.rank_mcns_export_path,
    result?.data?.result?.excel_file_url,
    result?.data?.result?.excel_url,
    result?.mcns_export_path,
    result?.mcn_export_path,
    result?.rank_mcns_export_path,
    result?.excel_file_url,
    result?.excel_url,
  );
}

function rankMcnsDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("rank_mcns", message);
  const mcns = result?.data?.mcns;
  if (!Array.isArray(mcns)) return flowPauseDirective("rank_mcns", message);
  const excelFileUrl = rankMcnsExcelUrl(result);
  const artifactId = firstString(params?.id, result?.data?.requirement_id, result?.requirement_id);
  const empty = mcns.length === 0;
  const recipientOptions = inquiryRecipientOptions(mcns);
  const recipientSelectionArgs =
    !empty && recipientOptions.length > 0
      ? askQuestion("选择询价机构", "请选择本次需要询价的机构，可多选。", recipientOptions, true)
      : null;
  const branchQuestion = mcnRankingBranchQuestionPayload(empty);
  const lines = [
    "YPSCAN_FLOW_DIRECTIVE=rank_mcns 成功。先把当前响应中的全部机构按原顺序输出为完整 MCN Markdown 表格，作为用户可见正文文本块，再执行分支。",
    "MCN_OUTPUT_FORMAT_LOCK=用户可见结果只能是五列：排名、机构、覆盖达人、返点、综合分；排名从 1 连续编号，覆盖达人取当前机构的 candidate_count。禁止展示 supplier_id、其他字段、汇总或历史数据。",
    MCN_MARKDOWN_TABLE_HEADER,
    "机构名转 supplier ID 只允许使用本轮同一 requirement_id、同一平台响应中的唯一精确匹配；命中非空 ID 只传 supplierIds，否则传原始名称 supplier_name。不得模糊匹配、跨轮复用或自动选机构。",
    ...(recipientSelectionArgs
      ? [
          "用户选择“询价机构”后，先逐字调用下方 INQUIRY_RECIPIENT_SELECTION_ARGS，等待明确选中至少一家当前 MCN；不得按排名或指标自行选择，也不得提前调用字段选择或发送工具。",
          `INQUIRY_RECIPIENT_SELECTION_ARGS=${JSON.stringify(recipientSelectionArgs)}`,
        ]
      : []),
    ...(empty ? [MCN_MARKDOWN_EMPTY_ROW] : []),
  ];
  if (excelFileUrl && artifactId) {
    lines.push(
      "完整表格输出后立即使用下面参数保存；保存成功前不得展示本地路径、调用 AskUserQuestion 或展示 Provider 下载 URL。",
      `SAVE_EXCEL_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "mcn_ranking",
        artifact_id: String(artifactId),
        excel_file_url: excelFileUrl,
        mcn_count: mcns.length,
      })}`,
    );
  } else if (excelFileUrl) {
    lines.push(
      "当前结果有 Excel 链接但缺少本轮 requirement ID；不得猜 artifact_id 或下载，表格后如实说明无法保存，再调用 ASK_USER_QUESTION_ARGS。",
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(branchQuestion)}`,
    );
  } else {
    lines.push(
      "当前结果没有可识别的 Excel 链接；表格后如实说明无法保存，再调用 ASK_USER_QUESTION_ARGS。",
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(branchQuestion)}`,
    );
  }
  return lines.join("\n");
}

function searchCreatorsDirective(message, params = {}) {
  const result = parsedToolResult(message);
  const requirementId = firstString(
    params?.id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  if (!requirementId) return flowPauseDirective("search_creators", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=search_creators 成功（包括 0 命中）。忽略 creators_export_path 等表格链接，不保存或展示，不得用 Browser、脚本或其他方式下载，也不调用保存工具；下一步使用同一 requirement ID 调用 rank_mcns。",
    `RANK_MCNS_ARGS=${JSON.stringify({ id: requirementId })}`,
  ].join("\n");
}

function providerExcelUrl(result) {
  return firstString(
    result?.data?.excel_file_url,
    result?.data?.excel_url,
    result?.data?.creators_export_path,
    result?.data?.result?.excel_file_url,
    result?.data?.result?.excel_url,
    result?.data?.result?.creators_export_path,
    result?.excel_file_url,
    result?.excel_url,
  );
}

function providerJobId(result) {
  const value = result?.data?.job_id ?? result?.job_id;
  if (nonemptyString(value)) return value.trim();
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function manualSourceBatchId(result) {
  for (const raw of [
    result?.batch_id,
    result?.data?.batch_id,
    result?.data?.manual_source_result?.data?.batch_id,
  ]) {
    if (Number.isSafeInteger(raw) && raw > 0) return raw;
    if (nonemptyString(raw)) return raw;
  }
  return undefined;
}

function manualSourceCreatorsDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) {
    if (result?.error?.code === "REQUIREMENT_COLUMNS_NOT_CONFIGURED") {
      const requirementId = firstString(
        params?.requirement_id,
        result?.error?.details?.requirement_id,
      );
      if (!requirementId) return flowPauseDirective("默认手扒字段选择", message);
      return [
        "YPSCAN_FLOW_DIRECTIVE=manual_source_creators 缺少字段配置。用同一 requirement_id 调用 select_inquiry_form_fields，不得原参数重试。",
        `SELECT_INQUIRY_FORM_FIELDS_ARGS=${JSON.stringify({ requirement_id: requirementId })}`,
        "原样展示字段选择 URL；收到“好了”后再用原 requirement_id 和 size 调用 manual_source_creators。",
      ].join("\n");
    }
    return flowPauseDirective("默认手扒", message);
  }
  const batchId = manualSourceBatchId(result);
  const requirementId = firstString(
    result?.requirement_id,
    result?.data?.requirement_id,
    params?.requirement_id,
  );
  if (batchId == null || !requirementId) return flowPauseDirective("默认手扒", message);
  return [
    `YPSCAN_FLOW_DIRECTIVE=manual_source_creators 已提交后台任务（仅返回 batch_id）。立即用 MANUAL_SOURCE_CREATORS_STATUS_ARGS 轮询；${MANUAL_SOURCE_POLL_RULE}。`,
    `MANUAL_SOURCE_CREATORS_STATUS_ARGS=${JSON.stringify({ requirement_id: requirementId, batch_id: batchId })}`,
  ].join("\n");
}

function manualSourceCreatorsStatusDirective(message, params = {}) {
  const result = parsedToolResult(message);
  const requirementId = firstString(
    result?.requirement_id,
    result?.data?.requirement_id,
    params?.requirement_id,
  );
  const batchId = manualSourceBatchId(result) ?? manualSourceBatchId(params);
  const excelFileUrl = providerExcelUrl(result);
  if (result?.success === true && excelFileUrl) {
    const artifactId = batchId == null ? requirementId : String(batchId);
    if (!artifactId) return flowPauseDirective("默认手扒结果查询", message);
    return [
      "YPSCAN_FLOW_DIRECTIVE=manual_source_creators_status 已完成。立即保存 Excel，不展示 Provider 下载 URL；保存成功后交付本地文件。",
      `SAVE_EXCEL_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "manual_source",
        artifact_id: artifactId,
        excel_file_url: excelFileUrl,
      })}`,
    ].join("\n");
  }
  if (result?.error?.code === "BATCH_NOT_READY") {
    if (batchId == null || !requirementId) return flowPauseDirective("默认手扒结果查询", message);
    return [
      `YPSCAN_FLOW_DIRECTIVE=manual_source_creators_status 仍在处理中（BATCH_NOT_READY）。继续使用同一 ID 轮询；${MANUAL_SOURCE_POLL_RULE}；第 10 次仍未完成则如实报告。`,
      `MANUAL_SOURCE_CREATORS_STATUS_ARGS=${JSON.stringify({ requirement_id: requirementId, batch_id: batchId })}`,
    ].join("\n");
  }
  return flowPauseDirective("默认手扒结果查询", message);
}

function distributionDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) {
    const errors = [result?.error, ...(Array.isArray(result?.errors) ? result.errors : [])].filter(
      isRecord,
    );
    const hasError = (pattern) =>
      errors.some((error) => pattern.test(String(firstString(error?.message, error?.code) ?? "")));
    const lines = [
      "YPSCAN_FLOW_DIRECTIVE=create_with_distributions 返回失败或部分成功。原样展示 Provider 状态，不把部分成功说成全失败；已成功机构不得重新加入，禁止自动重发。模糊候选使用 AskUserQuestion 让用户选择，重复发送则停止。",
      "模糊候选经用户确认后，只传选中的 supplier ID，supplier_name 传 []。",
    ];
    if (
      hasError(
        /supplier_name and supplierIds cannot both be empty|supplierIds.*supplier_name.*empty/iu,
      )
    ) {
      lines.push(
        "无收件机构：回到本轮真实 MCN 的机构选择，不能按排名自动选或重发空数组。",
      );
    }
    if (hasError(/只有进行中的项目才能创建供应商分发/u)) {
      const requirementId = firstString(
        params?.requirement_id,
        result?.data?.requirement_id,
        result?.requirement_id,
      );
      lines.push(
        "项目非进行中：仅用当前 requirement_id 调用一次 get_workflow_state 诊断，不自动重发。",
      );
      if (requirementId) {
        lines.push(`GET_WORKFLOW_STATE_ARGS=${JSON.stringify({ requirement_id: requirementId })}`);
      } else {
        lines.push(
          "当前响应和调用参数都缺少 requirement_id，无法安全查询项目状态；停止本轮发送处理。",
        );
      }
    }
    return lines.join("\n");
  }
  const status = result?.data?.send_status;
  if (
    !isRecord(status) ||
    !Array.isArray(status.sent_suppliers) ||
    !Array.isArray(status.failed_suppliers) ||
    status.sent_suppliers.length + status.failed_suppliers.length === 0
  ) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=create_with_distributions success=true 但缺少逐机构发送状态；原样展示并标为未知，不询问后续或自动重发。",
    ].join("\n");
  }
  const sent = status.sent_suppliers;
  const failed = status.failed_suppliers;
  const lines = [
    "YPSCAN_FLOW_DIRECTIVE=create_with_distributions 已返回发送结果。先展示真实逐机构状态，部分成功不得说成全成功。",
    `企微发送摘要：成功 ${sent.length} 家，失败 ${failed.length} 家。`,
  ];
  if (failed.length > 0) {
    lines.push(
      "原样展示失败原因和候选，不自动重发；候选确认后排除本次已成功机构。",
    );
    return lines.join("\n");
  }
  lines.push(
    "全部机构发送成功，立即调用下方 AskUserQuestion 询问是否继续人工拓展。",
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(
      askQuestion(
        "询价后续",
        [
          "企微询价已执行。",
          `成功机构：${sent.length} 家`,
          `失败机构：${failed.length} 家`,
          "是否继续进行人工拓展？",
        ].join("\n"),
        [
          { label: "继续人工拓展", description: "推荐使用后台默认手扒并直接生成 Excel" },
          { label: "暂不拓展", description: "保留当前询价结果，等待机构回填" },
        ],
      ),
    )}`,
    "用户之后说“填好了”“已回收”或“生成表格”时，从 sync_mcn_inquiry_status 开始取回。",
  );
  return lines.join("\n");
}

function syncInquiryDirective(message) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("询价状态同步", message);
  const inquiryIds = Array.isArray(result?.data?.inquiries)
    ? result.data.inquiries.map((item) => item?.inquiry_id).filter((value) => value != null)
    : Array.isArray(result?.data?.inquiry_ids)
      ? result.data.inquiry_ids
      : [];
  const normalizedIds = [
    ...new Set(inquiryIds.map((value) => String(value).trim()).filter(Boolean)),
  ];
  if (!normalizedIds.length) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=询价状态同步未返回可验证的 inquiry_ids；不得继续入库、精排或生成空提报表。",
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=询价状态同步成功。只把本次响应的 inquiry_ids 传给 ingest_mcn_submissions，不得跨轮拼接或使用 trace_id。",
    `INGEST_MCN_SUBMISSIONS_ARGS=${JSON.stringify({ inquiry_ids: normalizedIds })}`,
  ].join("\n");
}

function ingestSubmissionsDirective(message) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("机构提报入库", message);
  const jobId = providerJobId(result);
  if (jobId == null) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=ingest_mcn_submissions 成功但缺少可信 job_id，无法查询异步入库结果。不得把本次响应当成最终 Excel、编造任务 ID 或跳过预览表直接精排。",
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(
        askQuestion("异步入库任务", "机构入库请求已返回，但缺少任务 ID，请选择下一步。", [
          { label: "重试", description: "使用本轮 inquiry_ids 重新发起入库" },
          { label: "结束本次", description: "停止本次机构提报取回" },
        ]),
      )}`,
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=ingest_mcn_submissions 仅创建异步任务，尚未返回预览表。立即用 GET_INGEST_JOB_ARGS 调用 get_ingest_job，不得保存或精排本响应。",
    `GET_INGEST_JOB_ARGS=${JSON.stringify({ job_id: jobId })}`,
  ].join("\n");
}

function getIngestJobDirective(message, params = {}) {
  const result = parsedToolResult(message);
  const jobId = providerJobId(result) ?? providerJobId({ data: params });
  const excelFileUrl = providerExcelUrl(result);
  const requirementId = firstString(
    result?.data?.requirement_id,
    result?.data?.result?.requirement_id,
    result?.requirement_id,
  );
  if (result?.success === true && excelFileUrl && requirementId) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=get_ingest_job 已完成。原样输出 MCN_CREATOR_PREVIEW_URL 后立即保存预览表；保存成功后继续 rank_creators，不得改写或包装 URL。",
      `MCN_CREATOR_PREVIEW_URL=${excelFileUrl}`,
      `SAVE_EXCEL_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "mcn_creator_preview",
        artifact_id: requirementId,
        excel_file_url: excelFileUrl,
      })}`,
    ].join("\n");
  }
  if (jobId != null) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=get_ingest_job 尚未完成。继续使用同一 job_id 轮询，不调用 AskUserQuestion、不重新入库、不更换 job_id；单轮最多 10 次。",
      `GET_INGEST_JOB_ARGS=${JSON.stringify({ job_id: jobId })}`,
    ].join("\n");
  }
  return flowPauseDirective("异步入库结果查询", message);
}

function rankCreatorsDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("rank_creators", message);
  const rankedCount = Number(result?.data?.ranked_count);
  if (Number.isFinite(rankedCount) && rankedCount <= 0) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=rank_creators 结果为空；不得调用 create_submission_batch 生成空提报表，如实说明没有可提报达人。",
    ].join("\n");
  }
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  if (!requirementId) return flowPauseDirective("rank_creators", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=rank_creators 精排成功。立即调用 create_submission_batch 生成第 1 页，不要提问或重新 rank_mcns。",
    `CREATE_SUBMISSION_BATCH_ARGS=${JSON.stringify({
      requirement_id: requirementId,
      submission_batche_page: 1,
    })}`,
  ].join("\n");
}

function submissionBatchDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("提报表生成", message);
  const excelFileUrl = providerExcelUrl(result);
  const artifactId = firstString(result?.data?.batch_id, params?.requirement_id);
  if (!excelFileUrl || !artifactId) return flowPauseDirective("提报表生成", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=create_submission_batch 已生成提报表。立即保存，不展示 Provider 下载 URL。",
    `SAVE_EXCEL_ARTIFACT_ARGS=${JSON.stringify({
      artifact_kind: "submission_batch",
      artifact_id: String(artifactId),
      excel_file_url: excelFileUrl,
    })}`,
  ].join("\n");
}

const EXCEL_SAVE_STAGES = Object.freeze({
  mcn_ranking: "MCN 排名表保存",
  mcn_creator_preview: "机构达人预览表保存",
  submission_batch: "提报表保存",
  manual_source: "默认手扒表保存",
});

function excelArtifactSaveDirective(message, params = {}) {
  const artifactKind = params?.artifact_kind;
  const stage = EXCEL_SAVE_STAGES[artifactKind];
  if (!stage) return null;
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective(stage, message);
  const filePath = firstString(result?.data?.file_path, result?.delivery?.local_path);
  if (!filePath) return flowPauseDirective(stage, message);
  const localFileLink =
    firstString(result?.delivery?.local_file_link) ?? localFileMarkdownLink(filePath);
  if (!localFileLink) return flowPauseDirective(stage, message);
  if (artifactKind === "manual_source") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=默认手扒 Excel 已保存。原样展示本地链接作为交付，不提供浏览器手扒分支。",
      `MANUAL_SOURCE_LOCAL_PATH=${filePath}`,
      `MANUAL_SOURCE_LOCAL_LINK=${localFileLink}`,
      "将 MANUAL_SOURCE_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径。",
    ].join("\n");
  }
  if (artifactKind === "mcn_creator_preview") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=机构达人预览表已保存。原样展示本地链接后立即继续 rank_creators。",
      `MCN_CREATOR_PREVIEW_LOCAL_PATH=${filePath}`,
      `MCN_CREATOR_PREVIEW_LOCAL_LINK=${localFileLink}`,
      "将 MCN_CREATOR_PREVIEW_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径；不得停下、重新 rank_mcns 或调用 create_submission_batch。",
      `RANK_CREATORS_ARGS=${JSON.stringify({ requirement_id: params.artifact_id })}`,
    ].join("\n");
  }
  if (artifactKind === "mcn_ranking") {
    const nextArgs = result?.delivery?.next_args;
    return [
      "YPSCAN_FLOW_DIRECTIVE=MCN 排名表已保存。表格已先输出；原样展示本地链接后执行下一步。",
      `MCN_RANKING_LOCAL_PATH=${filePath}`,
      `MCN_RANKING_LOCAL_LINK=${localFileLink}`,
      "将 MCN_RANKING_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径或把路径/链接放入弹窗；随后执行 ASK_USER_QUESTION_ARGS，不得重复下载或重新 rank_mcns。",
      ...(isRecord(nextArgs)
        ? [`ASK_USER_QUESTION_ARGS=${JSON.stringify(nextArgs)}`]
        : ["保存结果缺少下一步弹窗参数；如实说明无法确定后续分支，不得猜测选项。"]),
    ].join("\n");
  }
  if (artifactKind === "submission_batch") {
    const nextArgs = result?.delivery?.next_args;
    return [
      "YPSCAN_FLOW_DIRECTIVE=Provider 提报表已保存。",
      `SUBMISSION_BATCH_LOCAL_PATH=${filePath}`,
      `SUBMISSION_BATCH_LOCAL_LINK=${localFileLink}`,
      "将 SUBMISSION_BATCH_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径。",
      ...(isRecord(nextArgs)
        ? [
            "随后逐字调用 ASK_USER_QUESTION_ARGS；选择补充更新时固定调用 get_creator_detail，再轮询 get_creator_detail_export，不得改字段配置或再次追问。",
            `ASK_USER_QUESTION_ARGS=${JSON.stringify(nextArgs)}`,
          ]
        : []),
    ].join("\n");
  }
  return null;
}

function cascadeSelectionDirective(message) {
  const result = parsedToolResult(message);
  if (result?.status === "needs_user_action") {
    return [
      `YPSCAN_FLOW_DIRECTIVE=级联菜单操作被${result?.error?.code ?? "登录或全局验证"}阻止。`,
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(
        askQuestion("Browser 验证", "当前平台需要登录或完成全局安全验证，请处理后继续。", [
          { label: "已处理，继续", description: "重新观察页面后继续当前手扒任务" },
          { label: "结束本次", description: "保留当前 checkpoint 并结束" },
        ]),
      )}`,
    ].join("\n");
  }
  if (result?.applied === true && result?.verified === true) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=级联菜单已验证：${result?.field_label ?? "未知筛选"} → ${(result?.selected_path ?? []).join(" / ")}。`,
      "立即回到 Playwright CLI 同一 session 观察完整筛选区并继续剩余条件；不要重复点击已选路径。",
    ].join("\n");
  }
  return [
    `YPSCAN_FLOW_DIRECTIVE=级联菜单未提交（${result?.error?.code ?? result?.status ?? "未知"}），但整个手扒任务不得停止。`,
    result?.recovery_hint ??
      "重新观察页面实际筛选名、入口文字和菜单层级后最多调整参数再试一次；仍失败则将该条件转入详情硬复核并继续其他筛选。",
  ].join("\n");
}

function filterRangeDirective(message) {
  const result = parsedToolResult(message);
  if (result?.status === "needs_user_action") {
    return [
      `YPSCAN_FLOW_DIRECTIVE=范围筛选操作被${result?.error?.code ?? "登录或全局验证"}阻止。`,
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(
        askQuestion("Browser 验证", "当前平台需要登录或完成全局安全验证，请处理后继续。", [
          { label: "已处理，继续", description: "重新观察页面后继续当前手扒任务" },
          { label: "结束本次", description: "保留当前 checkpoint 并结束" },
        ]),
      )}`,
    ].join("\n");
  }
  if (result?.applied === true && result?.verified === true) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=范围筛选已验证：${result?.field_label ?? "未知筛选"}。`,
      "立即回到 Playwright CLI 同一 session 重新 snapshot 并继续剩余条件；不要复用输入前的 ref，也不要重复提交已选范围。",
    ].join("\n");
  }
  return [
    `YPSCAN_FLOW_DIRECTIVE=范围筛选未提交（${result?.error?.code ?? result?.status ?? "未知"}），但整个手扒任务不得停止。`,
    result?.recovery_hint ??
      "重新观察页面实际筛选名、入口文字和单位后最多调整参数再试一次；仍失败则将该条件转入详情硬复核并继续其他筛选。",
  ].join("\n");
}


function flowDirective(toolName, message, params = {}) {
  const normalizedName = toolName.toLowerCase();
  const bare = stripHostPrefix(normalizedName);
  const result = parsedToolResult(message);
  if (
    bare === "validate_requirement" &&
    messageText(message).includes(REQUIREMENT_PREFLIGHT_BLOCKED)
  ) {
    return requirementPreflightBlockedDirective();
  }
  if (bare === "select_inquiry_form_fields") {
    return fieldSelectionDirective(message);
  }
  if (/(?:^|__)ypscan_save_excel_artifact$/iu.test(normalizedName)) {
    return excelArtifactSaveDirective(message, params);
  }
  if (/(?:^|__)ypscan_select_cascade$/iu.test(normalizedName)) {
    return cascadeSelectionDirective(message);
  }
  if (/(?:^|__)ypscan_set_filter_range$/iu.test(normalizedName)) {
    return filterRangeDirective(message);
  }
  if (bare === "create_with_distributions") return distributionDirective(message, params);
  if (bare === "sync_mcn_inquiry_status") return syncInquiryDirective(message);
  if (bare === "ingest_mcn_submissions") return ingestSubmissionsDirective(message);
  if (bare === "get_ingest_job") return getIngestJobDirective(message, params);
  if (bare === "manual_source_creators") return manualSourceCreatorsDirective(message, params);
  if (bare === "manual_source_creators_status")
    return manualSourceCreatorsStatusDirective(message, params);
  if (bare === "rank_creators") return rankCreatorsDirective(message, params);
  if (bare === "create_submission_batch") return submissionBatchDirective(message, params);
  if (bare === "get_workflow_state") return null;
  if (result?.success !== true) {
    if (
      /(?:^|__)ypscan_parse_requirement$/iu.test(normalizedName) ||
      bare === "validate_requirement" ||
      bare === "search_creators" ||
      bare === "rank_mcns"
    ) {
      return flowPauseDirective(normalizedName.split("__").at(-1), message);
    }
    return null;
  }
  if (/(?:^|__)ypscan_parse_requirement$/iu.test(normalizedName)) {
    return requirementParseSuccessDirective(message);
  }
  if (bare === "validate_requirement") {
    const requirementId = firstString(result?.data?.requirement_id, result?.data?.id);
    if (!requirementId) return flowPauseDirective("validate_requirement", message);
    return [
      "YPSCAN_FLOW_DIRECTIVE=validate_requirement 成功。当前需求只保留一个 requirement；立即使用 SEARCH_CREATORS_ARGS 调用 search_creators，不得调用 Browser 或直接结束。",
      "只使用本次返回的 data.requirement_id，缺失时兼容 data.id；严禁使用 data.demand_id。",
      `SEARCH_CREATORS_ARGS=${JSON.stringify({ id: requirementId })}`,
    ].join("\n");
  }
  if (bare === "search_creators") {
    return searchCreatorsDirective(message, params);
  }
  if (bare === "rank_mcns") return rankMcnsDirective(message, params);
  return null;
}

function appendDirective(message, directive) {
  if (!directive || !isRecord(message)) return undefined;
  const content = Array.isArray(message.content)
    ? [...message.content, { type: "text", text: `\n\n${directive}` }]
    : `${messageText(message)}\n\n${directive}`;
  return { message: { ...message, content } };
}

function scopeKey(event, context) {
  return (
    firstString(
      context?.sessionKey,
      context?.sessionId,
      event?.sessionKey,
      event?.sessionId,
      context?.runId,
      context?.run_id,
      event?.runId,
      event?.run_id,
    ) ?? "global"
  );
}

/** Register fixed-flow prompt and result directives. */
export function registerFlowDirectiveHooks(api) {
  const startupScopes = new Set();

  api.on(
    "before_prompt_build",
    (event, context) => {
      const scope = scopeKey(event, context);
      const lines = [];

      if (!startupScopes.has(scope)) {
        startupScopes.add(scope);
        lines.push(
          "[YPscan startup instruction]",
          "工具能力只看宿主完整名称中最后一个 __ 后的实际工具名；包括 test 在内的前缀只是命名空间，不代表测试、旁路或不可用于正式链路。单一匹配时直接调用宿主展示的完整名称；只有多个可用工具映射到同一实际名称时才调用 AskUserQuestion 请用户选择；没有匹配时才报告工具未开放。",
          "固定业务顺序：ypscan_parse_requirement → validate_requirement → search_creators → rank_mcns → 完整 MCN Markdown 表格 → ypscan_save_excel_artifact(mcn_ranking) → MCN 排名表本地文件超链接 → 逐字调用保存结果中的 ASK_USER_QUESTION_ARGS；同平台多个达人类型只创建一个 requirement，保留原始总量并合并标签和条件，不拆分子需求。需求 ID 始终指 requirement ID，优先取 validate_requirement 返回的 data.requirement_id，缺失时兼容 data.id，绝不使用 data.demand_id；search_creators.id 和 rank_mcns.id 都使用这个 requirement ID。search_creators 返回的表格链接不保存、不展示。“询价机构”只选择分支，不指定收件人：用户选该分支后，必须逐字调用 rank_mcns 结果中的 INQUIRY_RECIPIENT_SELECTION_ARGS，等用户明确选中至少一家真实 MCN 后才调用 select_inquiry_form_fields；不得按排名、覆盖人数、返点、综合分或推荐顺序自行挑选机构。随后询价分支固定为字段选择 → 用户提交并回复“好了” → 保留原需求全部信息撰写询价消息 → 发送前确认 → create_with_distributions。发送前确认必须用 AskUserQuestion 在 question 中完整展示最终机构名称列表和完整企微消息，选项固定为“确认发送”和“返回修改”；只有用户选择“确认发送”才调用一次发送工具，关闭、取消、无答案或返回修改均不得发送。supplierIds 和 supplier_name 始终都是数组，空侧传 []，至少一侧非空。用户提供、提名或在机构选择弹窗选中的机构名时，supplier_id 是第一优先级：先在本轮同一 requirement ID、同一平台的 rank_mcns.data.mcns 中做唯一精确匹配；命中且有非空 supplier_id 就只放入 supplierIds，未匹配或无 ID 才把原名放入 supplier_name。不做本地模糊匹配，不跨需求、平台或 run 复用 ID；两个数组可同时非空。模糊、不唯一或重复发送结果必须原样展示，禁止把已成功机构重新加入后续调用。若 Provider 返回“只有进行中的项目才能创建供应商分发”，只用同一 requirement_id 调用一次 get_workflow_state 诊断，禁止自动重发。用户后续说“填好了/已回收/生成表格”时固定执行 sync_mcn_inquiry_status → ingest_mcn_submissions → get_ingest_job（同一 job_id 可重复查询）→ ypscan_save_excel_artifact(mcn_creator_preview) → rank_creators → create_submission_batch → ypscan_save_excel_artifact(submission_batch)，中间不得停。create_with_distributions 是唯一企微发送工具；create_submission_batch 只生成提报表，绝不用于发送企微。get_workflow_state 仅用于诊断，其 allowed_actions 不替代本固定链路。",
          "提报表保存后的“补充更新达人信息”选项唯一映射到 get_creator_detail：用户一旦选择，立即按当前 schema 使用本轮 batch 调用 get_creator_detail，随后调用 get_creator_detail_export 轮询并保存新版表；该选择不是提报字段配置，不得调用 select_inquiry_form_fields，不得提供“达人详情/展示字段”二选一，也不得再次追问补充什么。",
          "search_creators 成功后忽略其 creators_export_path 或其他表格链接，不调用保存工具，直接使用同一 requirement ID 和当前平台调用 rank_mcns。rank_mcns 成功后先输出完整五列表格，再使用其精确 SAVE_EXCEL_ARTIFACT_ARGS 保存 MCN 排名表；保存成功后原样展示保存结果中的 delivery.local_file_link Markdown 超链接，不得只输出裸路径，再调用分支弹窗。rank_mcns 弹窗只放整体总结，本地文件链接不得放进弹窗 question。",
          "MCN 用户可见输出格式锁：rank_mcns 成功后不得根据响应 schema、原始字段、旧模板或上一轮结果自行设计表格。只能输出五列 Markdown 表格：排名、机构、覆盖达人、返点、综合分；列名、顺序和数量不得改动。特别禁止 Supplier ID/supplier_id、候选达人、供给占比、手扒补量、推荐理由及其他 rank_mcns 字段或汇总。",
          "rank_mcns 后先把完整 MCN Markdown 表格作为用户可见正文文本块写出，再用包含真实 mcn_count 的参数保存 MCN 排名表，原样展示保存结果中的 delivery.local_file_link Markdown 超链接，并逐字调用同一保存结果 delivery.next_args 给出的 AskUserQuestion，不得改写弹窗参数。用户只说“手扒”“手动拓展”“人工拓展”“直接手扒”“手捞筛选”或选择人工拓展后，一律默认走 MCP，不得激活额外的浏览器手扒分支。若当前对话已有同一 requirement_id 的字段选择链接且用户已明确回复提交完成，直接调用 manual_source_creators，不得再次调用 select_inquiry_form_fields；否则先调用 select_inquiry_form_fields，用户提交字段并回复“好了”后再调用 manual_source_creators。按当前 Provider schema 传本轮 requirement_id 和用户要求的 size；若 Provider 返回 REQUIREMENT_COLUMNS_NOT_CONFIGURED，再按工具结果指令进入字段选择。提交成功只返回任务 batch_id，不含 Excel：立即用同一 requirement_id 和 batch_id 调用 manual_source_creators_status 轮询，间隔 30 秒、单轮最多 10 次；只有轮询成功返回 excel_file_url 后才立即用 ypscan_save_excel_artifact(manual_source) 保存。",
          MANUAL_SOURCE_ORIGINAL_TEXT_RULE,
          "默认手扒 Excel 保存成功后原样展示保存结果中的 delivery.local_file_link Markdown 超链接，作为人工拓展交付；不再提供浏览器详细手扒分支。",
          "需求澄清规则：解析返回的八个 Label 数组和 contentTag 是纯解析结果，有什么就原样落库什么，保留元素与顺序，不要求原文逐项举证，不调用 AskUserQuestion 确认、不询问任何标签内容；任何标签字段（包括主达人类型 pgyBloggerTypeLabel/xtTalentTypeLabel）为 null 或缺失时直接省略，不做映射、不推断、不弹窗。数值字段先采用 Dify 唯一解析值，再与最新非空 clarification 合并；同一字段新答案覆盖旧答案，其他已确认且未修改的数值继续复用。Dify 已给出唯一 followercount、rebate、报价、CPM、CPE 时禁止再问。只有这些必填数值仍缺失、null、多候选或与用户明确改口冲突时才调用 AskUserQuestion。当前平台 Dify 品牌候选唯一、合法且非空时必须原样作为 brandName，不得询问、改写或被原文与 clarification 覆盖；解析品牌缺失、多候选或为 null、未知等占位值时才询问。项目名由 Agent 根据当前需求自行总结生成，不弹窗确认；调用 validate_requirement 前用一句可见正文告知用户取的项目名。禁止编造标签、默认补数值或普通文本追问。解析 Workflow 唯一合法报价、CPM、CPE 候选直接复用，不因原文单值与 Provider 区间格式差异询问；同平台多个达人类型只保留一个 requirement，总量不变并合并条件，不拆分或追问每类人数。正常成功交付不追加完成弹窗。",
          `validate_requirement 数值字段格式锁：${VALIDATE_REQUIREMENT_RANGE_PARAMS.join(",")} 全部使用${REQUIREMENT_RANGE_FORMAT}，禁止数组、对象、单个数字、百分号文本或自然语言；rebate 固定为 "[min,1]"。第一次调用前一次性检查全部必填字段和格式，禁止通过 Provider 报错逐字段、逐类型试探。`,
          "Dify 已给出的唯一数值直接采用，禁止再问；本地只做区间格式与粉丝技术上限截断。只有解析缺失、null、多候选或与用户明确改口冲突时才阻断。",
          "需求解析分工：首次按单平台完整需求调用 ypscan_parse_requirement，data.outputs 仅返回当前 Provider 契约消费的 Workflow 字段。解析结果负责八个标签数组、contentTag、品牌、followercount、rebate、报价、CPM、CPE 的候选值；Agent 只按字段名和当前平台结构性展开参数片段。八个 Label 数组和 contentTag 是纯解析结果，有什么原样落库、没有就省略，不向用户确认、不询问任何标签内容；主达人类型字段 pgyBloggerTypeLabel/xtTalentTypeLabel 为 null 或缺失时同样省略，不做映射、不推断。当前平台 Dify 品牌候选唯一且为合法非占位值时必须原样采用，不得询问、改写或被原文与 clarification 覆盖；解析品牌缺失或不唯一时才询问。Dify 已给出的唯一 followercount、rebate、报价、CPM、CPE 直接采用，不要求原文再出现粉丝或报价关键词，禁止再问；只有这些字段缺失、null、多候选或与用户明确改口冲突时才弹窗确认。抖音报价、CPM、CPE 按视频类型映射：kolOfficialPriceL2/cpmL2/cpeL2=植入视频，kolOfficialPriceL3/cpmL3/cpeL3=定制视频，不使用任何 L1。解析片段中的旧档位名不作为类型证据；当前用户证据已唯一明确视频类型时，保留合法区间并确定性路由到新档位，不得询问用户。其余 Provider 字段按解析参考从当前有效用户证据构造。同平台多个达人类型只有总量时只保留一个 requirement，原始总量不变并合并全部类型标签和条件，不拆分子需求。单次修改只涉及一个条件时由 Agent 直接更新；同一次修改涉及两个及以上不同业务条件时，只能用用户最初原文和后续改口维护的当前原始条件重建完整单平台 demand，再调用一次 ypscan_parse_requirement，并以新响应刷新全部解析字段。禁止回填旧解析输出、已拓展价格或其他 Provider 归一化值。",
          "人工拓展的 creator_count 使用用户最新指定的本轮交付数并覆盖原需求总量；即使历史轮次声称旧 schema 要求 page_url/original_brief，本轮也先按新版省略，当前验证器再次拒绝时才用当前 URL 与 original_brief='见当前对话原需求' 兼容，禁止复制完整 brief。",
          PARSED_METRIC_REUSE_RULE,
          SINGLE_REQUIREMENT_TYPE_RULE,
        );
      }
      return lines.length ? { prependContext: lines.join("\n") } : undefined;
    },
    HOOK_OPTIONS,
  );

  api.on(
    "before_tool_call",
    (event) => {
      const toolName = firstString(event?.toolName, event?.name) ?? "";
      if (stripHostPrefix(toolName) !== "validate_requirement") return undefined;
      const params = paramsFromEvent(event);
      const normalized = normalizeToolCallParams(toolName, params);
      const issues = validateRequirementPreflight(normalized);
      if (issues.length > 0) {
        return {
          block: true,
          blockReason: requirementPreflightBlockReason(issues),
        };
      }
      const providerParams = serializeProviderRawMessages(normalized);
      return providerParams === params ? undefined : { params: providerParams };
    },
    HOOK_OPTIONS,
  );

  api.on(
    "tool_result_persist",
    (event) => {
      const toolName = firstString(event?.toolName, event?.name) ?? "";
      const params = paramsFromEvent(event);
      return appendDirective(event?.message, flowDirective(toolName, event?.message, params));
    },
    HOOK_OPTIONS,
  );

  return {
    resetTransientState() {
      startupScopes.clear();
    },
  };
}

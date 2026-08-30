import { firstString, isRecord, nonemptyString } from "../util/value.js";
import {
  BUSINESS_MODE_VALUES,
  normalizeToolCallParams,
  stripHostPrefix,
  VALIDATE_REQUIREMENT_RANGE_PARAMS,
  validateRequirementPreflight,
} from "../contract/registry.js";
import {
  businessModeQuestionPayload,
  mcnRankingRecipientQuestionPayload,
  popupQuestionPayload,
} from "../tools/post-save-questions.js";
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
const REQUIREMENT_COMPLETENESS_RULE =
  "进入 validate_requirement 前必须检查 brandName、quantityTotal、submissionDeadlineAt、rebate、followercount 和至少一个当前平台支持且与内容形式匹配的报价档位；抖音仅使用 L2/L3 且必须匹配视频类型，小红书不使用 L3。这些业务值缺失、无效或需要选择时，必须在调用前一次性通过 AskUserQuestion 收集，禁止默认补值。contentTag 必须是解析结果中的非空数组；缺失或无效时重新解析，禁止向用户询问或自行补值；本规则覆盖任何“contentTag 缺失时直接省略”的旧指令。status=ready、projectName 和 rawMessagesJson（当前原文+parse_outputs）由 Agent 构造。";
const INQUIRY_RECIPIENT_RESPONSE_RULE =
  "机构选择仅在用户选中弹窗中的一个或多个当前机构、选择“询价全部机构”，或自定义输入成功解析为一个或多个当前机构的唯一编号或完整名称时成立；弹窗机构标签中的换行仅用于展示，匹配前必须移除换行并还原完整机构名；选择“询价全部机构”表示选择全部当前机构。空输入、未知机构、无法解析或存在歧义时，不得继续询价，应重新调用本提示或结束本轮。";
const REQUIREMENT_REUSE_RULE =
  "同一会话、同一平台的最近成功 requirement 在业务条件未变时可于前一功能完成或明确停止后复用于另一功能；功能切换本身不算需求修改，不重新解析或 validate。已提交过字段配置时继续复用，否则才调用 select_inquiry_form_fields。不得并行执行两个功能，也不得复用旧机构、达人、batch 或 Excel。用户修改任何业务条件时仍必须重新解析、复核并创建新 requirement。";

const MANUAL_SOURCE_POLL_RULE =
  "这是异步轮询，不调用 AskUserQuestion、不重新提交 manual_source_creators，也不得猜测或更换 requirement_id 或 batch_id。轮询间隔 30 秒，单轮最多查询 10 次";

const [BUSINESS_MODE_INQUIRY] = BUSINESS_MODE_VALUES;

function businessModeFromParams(params) {
  const direct = params?.business_mode;
  if (typeof direct === "string" && BUSINESS_MODE_VALUES.includes(direct)) return direct;
  const raw = params?.rawMessagesJson;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const mode = isRecord(value) ? value.business_mode : undefined;
  return typeof mode === "string" && BUSINESS_MODE_VALUES.includes(mode) ? mode : null;
}

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

function flowPauseDirective(stage, message) {
  const result = parsedToolResult(message);
  const code = nonemptyString(result?.error?.code) ? result.error.code : "结果未能继续";
  return [
    `YPSCAN_FLOW_DIRECTIVE=${stage} 已暂停（${code}）。使用下方 AskUserQuestion 选择重试或结束。`,
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(
      popupQuestionPayload("悦普识星下一步", `${stage} 无法自动继续，请选择下一步。`, [
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

function requirementParseSuccessDirective(message, params = {}) {
  const { resolved, missing } = classifyDifyOutputs(parseOutputsFromMessage(message));
  const mode = businessModeFromParams(params);
  return [
    "YPSCAN_FLOW_DIRECTIVE=需求解析成功。data.outputs 仅包含当前 Provider 契约消费的 Workflow 字段。下一步必须先复核，不得直接调用 Browser、search_creators 或结束。",
    "YPSCAN_NEXT_ACTION=REVIEW_REQUIREMENT",
    `DIFY_RESOLVED_FIELDS=${resolved.join(",")}`,
    `DIFY_MISSING_FIELDS=${missing.join(",")}`,
    ...(mode
      ? [
          `BUSINESS_MODE=${mode}`,
          "后续 validate_requirement 的 rawMessagesJson.business_mode 必须使用该值；整个流程保持该模式，不得再次询问。",
        ]
      : []),
    "DIFY_RESOLVED_FIELDS 中的唯一值直接采用；DIFY_MISSING_FIELDS 与非解析必填项按启动规则收集确认。八个可选 Label 有则原样保留、无则省略；contentTag 缺失时按下方规则重新解析。不要把解析输出整体塞入 Provider 参数。",
    "YPSCAN_POLICY=按 media-assistant Skill 的“解析后、落库前必须复核”执行；复核通过后才调用 validate_requirement。",
    "复核时必须确认 brandName、quantityTotal、submissionDeadlineAt、rebate、followercount、contentTag 和至少一个当前平台支持且与内容形式匹配的报价档位；抖音仅使用 L2/L3，小红书不使用 L3。缺失或有歧义时按 Skill 一次性询问；contentTag 必须来自解析结果，缺失时重新解析。",
  ].join("\n");
}

function requirementPreflightBlockReason(issues) {
  const details = issues.map((issue) => `${issue.field}: ${issue.reason}`).join("；");
  return [
    REQUIREMENT_PREFLIGHT_BLOCKED,
    "validate_requirement 未执行，Provider 没有收到本次写入。",
    `一次性修正项：${details}`,
    `格式契约：rebate、followercount、kolOfficialPriceL1/L2/L3、cpmL1/L2/L3、cpeL1/L2/L3 以及其他数值筛选字段全部使用${REQUIREMENT_RANGE_FORMAT}；返点固定为 "[min,1]"。`,
    "只允许对当前有效用户证据中的唯一明确值做确定性格式归一化。先检查当前对话是否已有该字段的有效弹窗答案：数值字段答案写回 rawMessagesJson.clarifications；同一字段新答案覆盖旧答案，不得再次询问。只有仍缺失、模糊、冲突、多候选或需要选择的业务值才调用 AskUserQuestion。八个可选 Label 有什么原样落库，null 或缺失就省略；contentTag 必须来自本次解析的非空数组，缺失时重新解析。所有标签都不做映射、不推断、不询问。不得自主补值或改变一种类型后继续盲试。",
  ].join("\n");
}

function requirementPreflightBlockedDirective() {
  return [
    "YPSCAN_FLOW_DIRECTIVE=validate_requirement 已被本地预检阻断，Provider 未执行写入。一次处理工具错误列出的全部字段，不得把阻断说成 Provider 报错。",
    `REQUIREMENT_RANGE_FORMAT=${REQUIREMENT_RANGE_FORMAT}。禁止数组、对象、单值和百分号文本直接进入数值筛选字段。`,
    "先把当前对话中已经回答但漏传的字段补回 rawMessagesJson.clarifications；只对仍未回答、无效、冲突或需选择的字段在同一次 AskUserQuestion 中成组收集（最多四题）。八个可选 Label 缺失时省略；contentTag 缺失时重新解析，不向用户询问或自行补值。projectName 由 Agent 根据当前需求自行总结生成。禁止自主选择、默认补值或重试探测。",
  ].join("\n");
}

const MCN_MARKDOWN_TABLE_HEADER = [
  "| 排名 | 机构 | 覆盖达人 | 返点 | 综合分 |",
  "| --- | --- | --- | --- | --- |",
].join("\n");
const MCN_MARKDOWN_EMPTY_ROW = "| — | 暂无匹配机构 | — | — | — |";

const FIELD_SELECTION_AUTO_OPEN_FAILED = "浏览器打开请求未成功";

function inquiryRecipientNames(mcns) {
  const seen = new Set();
  return mcns.flatMap((mcn) => {
    const name = firstString(mcn?.agency_name, mcn?.supplier_name, mcn?.mcn_name, mcn?.name)?.trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [name];
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
    "Provider 按 validate_requirement 返回的 requirement_id（缺失时兼容 data.id）持久化 columns；不得使用 demand_id、把 columns 放入上下文或调用已弃用的 get_selected_inquiry_form_fields。收到“好了”后按原分支恢复：询价只使用用户明确选中的当前 MCN并做发送前确认，直接手扒使用原 requirement_id 和 size。",
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
  const recipientNames = inquiryRecipientNames(mcns);
  const lines = [
    "YPSCAN_FLOW_DIRECTIVE=rank_mcns 成功。当前已处于询价机构分支；先把当前响应中的全部机构按原顺序输出为完整 MCN Markdown 表格，作为用户可见正文文本块，再保存排名表并选择询价收件机构。",
    "MCN_OUTPUT_FORMAT_LOCK=用户可见结果只能是五列：排名、机构、覆盖达人、返点、综合分；排名从 1 连续编号，覆盖达人取当前机构的 candidate_count。禁止展示 supplier_id、其他字段、汇总或历史数据。",
    MCN_MARKDOWN_TABLE_HEADER,
    "机构名转 supplier ID 只允许使用本轮同一 requirement_id、同一平台响应中的唯一精确匹配；命中非空 ID 只传 supplierIds，否则传原始名称 supplier_name。不得模糊匹配、跨轮复用或自动选机构。",
  ];
  if (empty) {
    return [
      ...lines,
      MCN_MARKDOWN_EMPTY_ROW,
      "YPSCAN_NEXT_ACTION=REVIEW_BEFORE_RELAXATION",
      "YPSCAN_POLICY=按 media-assistant Skill 的“结果不足：先复核，再放宽”执行。",
      "当前没有可选机构；不得保存空排名表、猜测机构、自动切换功能或未经复核就放宽。",
    ].join("\n");
  }
  if (excelFileUrl && artifactId) {
    lines.push(
      "完整表格输出后立即使用下面参数保存；保存成功前不得展示本地路径、调用 AskUserQuestion 或展示 Provider 下载 URL。保存结果指令中的 ASK_USER_QUESTION_ARGS 就是收件机构选择弹窗，保存成功后逐字调用，不得重复弹窗。",
      `SAVE_EXCEL_ARTIFACT_ARGS=${JSON.stringify({
        artifact_kind: "mcn_ranking",
        artifact_id: String(artifactId),
        excel_file_url: excelFileUrl,
        mcn_names: recipientNames,
      })}`,
    );
  } else if (artifactId && recipientNames.length > 0) {
    lines.push(
      "当前结果无法保存 MCN 排名表；表格后如实说明，再调用 ASK_USER_QUESTION_ARGS 选择收件机构。收到机构选择答案后，若当前对话中同一 requirement_id 已提交字段配置则复用，否则调用 select_inquiry_form_fields（参数见下方 SELECT_INQUIRY_FORM_FIELDS_ARGS）；不得查询、缓存或重建 columns，也不得按排名或指标自行选择。",
      `SELECT_INQUIRY_FORM_FIELDS_ARGS=${JSON.stringify({ requirement_id: artifactId })}`,
      INQUIRY_RECIPIENT_RESPONSE_RULE,
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(mcnRankingRecipientQuestionPayload(recipientNames))}`,
    );
  } else {
    lines.push(
      "当前结果无法保存 MCN 排名表，也缺少进入收件机构选择的条件；表格后如实说明并结束本轮询价，不得猜测 requirement ID 或自动切换功能。",
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

function positiveInteger(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (!nonemptyString(value) || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
    const artifactId = requirementId;
    if (!artifactId) return flowPauseDirective("默认手扒结果查询", message);
    return [
      "YPSCAN_FLOW_DIRECTIVE=manual_source_creators_status 已完成。该 Excel 是后台 API 搜索、详情抓取和筛选后的最终手扒结果；立即保存且不展示 Provider 下载 URL，保存后原样交付并结束本次手扒，不调用 rank_creators 或 create_submission_batch。",
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
      `YPSCAN_FLOW_DIRECTIVE=manual_source_creators_status 仍在处理中（BATCH_NOT_READY）。继续使用同一 ID 轮询；${MANUAL_SOURCE_POLL_RULE}；由当前对话累计查询次数，第 10 次仍未完成时按 media-assistant Skill 询问“继续查询/暂时结束”，不得自动开始第 11 次。`,
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
    "全部机构发送成功。告知用户可随时回收在线表格；用户之后说“填好了”“已回收”或“生成表格”时，从 sync_mcn_inquiry_status 开始取回，不切换到直接手扒分支。",
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
        popupQuestionPayload("异步入库任务", "机构入库请求已返回，但缺少任务 ID，请选择下一步。", [
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
      "YPSCAN_FLOW_DIRECTIVE=get_ingest_job 尚未完成。继续使用同一 job_id 轮询，不重新入库、不更换 job_id；由当前对话累计查询次数，单轮最多 10 次，第 10 次仍未完成时按 media-assistant Skill 询问“继续查询/暂时结束”，不得自动开始第 11 次。",
      `GET_INGEST_JOB_ARGS=${JSON.stringify({ job_id: jobId })}`,
    ].join("\n");
  }
  return flowPauseDirective("异步入库结果查询", message);
}

function rankCreatorsDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("rank_creators", message);
  const rankedCount = Number(result?.data?.ranked_count);
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  if (Number.isFinite(rankedCount) && rankedCount <= 0) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=rank_creators 结果为空；不得调用 create_submission_batch 生成空提报表。",
      "YPSCAN_NEXT_ACTION=APPLY_INQUIRY_RANK_POLICY",
      ...(requirementId ? [`RANK_REQUIREMENT_ID=${requirementId}`] : []),
      "机构询价回收：如实说明本轮没有可交付达人并结束，不自动放宽或重新询价。直接手扒完成后不得调用本工具。",
    ].join("\n");
  }
  if (!requirementId) return flowPauseDirective("rank_creators", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=rank_creators 已返回机构询价回收的真实达人。",
    "YPSCAN_NEXT_ACTION=APPLY_INQUIRY_RANK_POLICY",
    `RANKED_COUNT=${Number.isFinite(rankedCount) ? rankedCount : "unknown"}`,
    `RANK_REQUIREMENT_ID=${requirementId}`,
    "生成当前机构询价提报表；数量不足时说明实际数量和缺口，不自动放宽或重新询价。调用 create_submission_batch 时使用本行 RANK_REQUIREMENT_ID 且 submission_batche_page=1。直接手扒完成后不得调用本工具。",
  ].join("\n");
}

function submissionBatchDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("提报表生成", message);
  const excelFileUrl = providerExcelUrl(result);
  const rawBatchId = result?.data?.batch_id ?? result?.batch_id;
  const artifactId = Number.isSafeInteger(rawBatchId) && rawBatchId > 0
    ? String(rawBatchId)
    : firstString(rawBatchId, params?.requirement_id);
  const requirementId = firstString(params?.requirement_id, result?.data?.requirement_id);
  if (!excelFileUrl || !artifactId) return flowPauseDirective("提报表生成", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=create_submission_batch 已生成提报表。立即保存，不展示 Provider 下载 URL。",
    `SAVE_EXCEL_ARTIFACT_ARGS=${JSON.stringify({
      artifact_kind: "submission_batch",
      artifact_id: String(artifactId),
      excel_file_url: excelFileUrl,
      ...(requirementId ? { requirement_id: requirementId } : {}),
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
      "YPSCAN_FLOW_DIRECTIVE=直接手扒 Excel 已保存。原样展示本地链接作为后台搜索、详情抓取和筛选后的最终手扒结果，然后结束本次手扒；不得调用 rank_creators、create_submission_batch 或补充达人信息弹窗。",
      `MANUAL_SOURCE_LOCAL_PATH=${filePath}`,
      `MANUAL_SOURCE_LOCAL_LINK=${localFileLink}`,
      "将 MANUAL_SOURCE_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径。",
      REQUIREMENT_REUSE_RULE,
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
      "YPSCAN_FLOW_DIRECTIVE=MCN 排名表已保存。表格已先输出；原样展示本地链接后选择询价收件机构。",
      `MCN_RANKING_LOCAL_PATH=${filePath}`,
      `MCN_RANKING_LOCAL_LINK=${localFileLink}`,
      "将 MCN_RANKING_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径或把路径/链接放入弹窗；随后执行 ASK_USER_QUESTION_ARGS 选择询价收件机构，不得按排名或指标自行选择，也不得重复下载或重新 rank_mcns。",
      ...(isRecord(nextArgs)
        ? [
            `ASK_USER_QUESTION_ARGS=${JSON.stringify(nextArgs)}`,
            INQUIRY_RECIPIENT_RESPONSE_RULE,
            "收到机构选择答案后，先检查当前对话中同一 requirement_id 是否已经提交过字段配置：已提交则复用并继续发送预览，未提交才调用 select_inquiry_form_fields（参数见下方 SELECT_INQUIRY_FORM_FIELDS_ARGS）；不得查询、缓存或重建 columns。",
            `SELECT_INQUIRY_FORM_FIELDS_ARGS=${JSON.stringify({ requirement_id: params.artifact_id })}`,
          ]
        : ["当前没有可选机构；如实说明询价功能无法继续，不得自动切换功能或猜测收件机构。"]),
    ].join("\n");
  }
  if (artifactKind === "submission_batch") {
    const nextArgs = result?.delivery?.next_args;
    const requirementId = firstString(params?.requirement_id);
    const batchId = positiveInteger(params?.artifact_id);
    const canEnrich = isRecord(nextArgs) && requirementId && batchId;
    return [
      "YPSCAN_FLOW_DIRECTIVE=Provider 提报表已保存。",
      `SUBMISSION_BATCH_LOCAL_PATH=${filePath}`,
      `SUBMISSION_BATCH_LOCAL_LINK=${localFileLink}`,
      "将 SUBMISSION_BATCH_LOCAL_LINK 原样作为 Markdown 超链接展示，不要只输出裸路径。",
      ...(canEnrich
        ? [
            "随后逐字调用 ASK_USER_QUESTION_ARGS；选择补充更新时逐字使用 GET_CREATOR_DETAIL_ARGS 调用 get_creator_detail，再轮询 get_creator_detail_export，不得改字段配置或再次追问。",
            `ASK_USER_QUESTION_ARGS=${JSON.stringify(nextArgs)}`,
            `GET_CREATOR_DETAIL_ARGS=${JSON.stringify({
              platform: "xhs",
              batch_id: batchId,
              requirement_id: requirementId,
            })}`,
          ]
        : [
            "当前提报表缺少可信的正整数 batch_id 或 requirement_id；保留并交付当前文件，不调用 get_creator_detail，也不猜测关联 ID。",
          ]),
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
        popupQuestionPayload("Browser 验证", "当前平台需要登录或完成全局安全验证，请处理后继续。", [
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
        popupQuestionPayload("Browser 验证", "当前平台需要登录或完成全局安全验证，请处理后继续。", [
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
    return requirementParseSuccessDirective(message, params);
  }
  if (bare === "validate_requirement") {
    const requirementId = firstString(result?.data?.requirement_id, result?.data?.id);
    if (!requirementId) return flowPauseDirective("validate_requirement", message);
    const mode = businessModeFromParams(params);
    if (!mode) {
      return flowPauseDirective("validate_requirement 缺少 business_mode", message);
    }
    if (mode === BUSINESS_MODE_INQUIRY) {
      return [
        "YPSCAN_FLOW_DIRECTIVE=validate_requirement 成功。当前需求只保留一个 requirement，业务模式：询价机构。立即使用 SEARCH_CREATORS_ARGS 调用 search_creators，随后 rank_mcns；不得调用直接手扒分支工具、Browser 或直接结束。",
        "只使用本次返回的 data.requirement_id，缺失时兼容 data.id；严禁使用 data.demand_id。",
        `SEARCH_CREATORS_ARGS=${JSON.stringify({ id: requirementId })}`,
      ].join("\n");
    }
    return [
      "YPSCAN_FLOW_DIRECTIVE=validate_requirement 成功。当前需求只保留一个 requirement，业务模式：直接手扒。立即使用 SELECT_INQUIRY_FORM_FIELDS_ARGS 调用 select_inquiry_form_fields，原样展示 URL 并等待用户提交后回复“好了”；不得调用 search_creators、rank_mcns 或 Browser。",
      "只使用本次返回的 data.requirement_id，缺失时兼容 data.id；严禁使用 data.demand_id。",
      `SELECT_INQUIRY_FORM_FIELDS_ARGS=${JSON.stringify({ requirement_id: requirementId })}`,
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
          `业务模式识别：用户明确说“询价机构/机构询价/MCN 询价”时直接使用“询价机构”；明确说“直接手扒/手扒/手动拓展/人工拓展/手捞筛选”时直接使用“直接手扒”。未明确、同时出现两种模式或语义冲突时，首次业务动作逐字调用 BUSINESS_MODE_QUESTION_ARGS=${JSON.stringify(businessModeQuestionPayload())}，回答前不得解析或落库。选择后把同一 business_mode 传给 ypscan_parse_requirement 和 validate_requirement.rawMessagesJson；business_mode 只决定首次落库后的初始功能。询价链路：解析→复核→validate_requirement→search_creators→rank_mcns→选择机构和字段→发送确认→回收→rank_creators→create_submission_batch。直接手扒：解析→复核→validate_requirement→选择字段→manual_source_creators→状态轮询→保存并交付最终手扒表。需求 ID 优先 data.requirement_id，缺失时兼容 data.id，绝不使用 data.demand_id。发送前确认必须展示完整企微消息和机构名单，并提供“确认发送/返回修改”；用户选择“确认发送”或明确无条件回复“可以发/发吧/按这个发/就这样发送”可发送一次；否定、修改或条件表达不算确认。supplierIds 和 supplier_name 始终为数组，机构只在本轮同一 requirement ID、同一平台的 rank_mcns.data.mcns 中唯一精确匹配，不模糊匹配或跨轮复用。`,
          REQUIREMENT_REUSE_RULE,
          "所有 AskUserQuestion 弹窗的 header、question、label 和 description 均主动换行，任何一行最多 20 个 Unicode 字符；长机构名可为展示插入换行，匹配前移除换行还原原名。",
          "提报表保存后的“补充更新达人信息”选项唯一映射到 get_creator_detail：用户一旦选择，立即使用本轮正整数 batch_id、同一 requirement_id 和 platform=xhs 调用 get_creator_detail，随后调用 get_creator_detail_export 轮询并保存新版表；该选择不是提报字段配置，不得调用 select_inquiry_form_fields，不得提供“达人详情/展示字段”二选一，也不得再次追问补充什么。",
          "仅询价机构分支调用 search_creators；成功后忽略 creators_export_path 等表格链接，直接用同一 requirement ID 调用 rank_mcns。rank_mcns 成功后先输出完整五列表格，再保存 MCN 排名表；保存成功后展示本地链接并调用收件机构选择弹窗，不得再次询问业务模式。",
          "MCN 用户可见输出格式锁：rank_mcns 成功后不得根据响应 schema、原始字段、旧模板或上一轮结果自行设计表格。只能输出五列 Markdown 表格：排名、机构、覆盖达人、返点、综合分；列名、顺序和数量不得改动。特别禁止 Supplier ID/supplier_id、候选达人、供给占比、手扒补量、推荐理由及其他 rank_mcns 字段或汇总。",
          "直接手扒分支先选择字段，再调用 manual_source_creators；该工具由后台 API 完成平台达人搜索、详情抓取和筛选。提交成功后用同一 requirement_id 和 batch_id 轮询 manual_source_creators_status；成功 Excel 保存并展示为最终手扒结果，随后结束本次手扒，不调用 rank_creators 或 create_submission_batch。",
          MANUAL_SOURCE_ORIGINAL_TEXT_RULE,
          "直接手扒 Excel 保存成功后原样展示 delivery.local_file_link，不再提供浏览器详细手扒分支，也不追加完成弹窗。",
          "需求澄清规则：解析返回的八个可选 Label 数组是纯解析结果，有什么就原样落库什么，保留元素与顺序，不要求原文逐项举证，不调用 AskUserQuestion 确认、不询问任何标签内容；可选 Label（包括主达人类型 pgyBloggerTypeLabel/xtTalentTypeLabel）为 null 或缺失时直接省略，不做映射、不推断、不弹窗。contentTag 必须是本次解析结果中的非空数组；缺失或无效时重新解析，禁止询问用户或自行补值。数值字段先采用 Dify 唯一解析值，再与最新非空 clarification 合并；同一字段新答案覆盖旧答案，其他已确认且未修改的数值继续复用。Dify 已给出唯一 followercount、rebate、报价、CPM、CPE 时禁止再问。只有这些必填数值仍缺失、null、多候选或与用户明确改口冲突时才调用 AskUserQuestion。当前平台 Dify 品牌候选唯一、合法且非空时必须原样作为 brandName，不得询问、改写或被原文与 clarification 覆盖；解析品牌缺失、多候选或为 null、未知等占位值时才询问。项目名由 Agent 根据当前需求自行总结生成，不弹窗确认；调用 validate_requirement 前用一句可见正文告知用户取的项目名。禁止编造标签、默认补数值或普通文本追问。解析 Workflow 唯一合法报价、CPM、CPE 候选直接复用，不因原文单值与 Provider 区间格式差异询问；同平台多个达人类型只保留一个 requirement，总量不变并合并条件，不拆分或追问每类人数。正常成功交付不追加完成弹窗。",
          REQUIREMENT_COMPLETENESS_RULE,
          INQUIRY_RECIPIENT_RESPONSE_RULE,
          `validate_requirement 数值字段格式锁：${VALIDATE_REQUIREMENT_RANGE_PARAMS.join(",")} 全部使用${REQUIREMENT_RANGE_FORMAT}，禁止数组、对象、单个数字、百分号文本或自然语言；rebate 固定为 "[min,1]"。第一次调用前一次性检查全部必填字段和格式，禁止通过 Provider 报错逐字段、逐类型试探。`,
          "Dify 已给出的唯一数值直接采用，禁止再问；本地只做区间格式与粉丝技术上限截断。只有解析缺失、null、多候选或与用户明确改口冲突时才阻断。",
          "需求解析复核、结果不足后的二次复核与逐项放宽、用户修改需求后的重建规则，统一按 media-assistant Skill 执行；Hook 只提供当前工具结果和下一步动态参数。",
          "人工拓展的 creator_count 使用用户最新指定的本轮交付数并覆盖原需求总量；即使历史轮次声称旧 schema 要求 page_url/original_brief，本轮也先按新版省略，当前验证器再次拒绝时才用当前 URL 与 original_brief='见当前对话原需求' 兼容，禁止复制完整 brief。",
          PARSED_METRIC_REUSE_RULE,
          SINGLE_REQUIREMENT_TYPE_RULE,
          REQUIREMENT_COMPLETENESS_RULE,
          INQUIRY_RECIPIENT_RESPONSE_RULE,
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
      const bare = stripHostPrefix(toolName.toLowerCase());
      const params = paramsFromEvent(event);
      if (bare !== "validate_requirement") return undefined;
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

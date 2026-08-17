import { fingerprint, firstString, isRecord, newId, nonemptyString } from "../util/hash.js";
import { normalizeToolCallParams, stripHostPrefix } from "../contract/registry.js";

const HOOK_OPTIONS = { priority: 90, timeoutMs: 5000 };
const GRANT_TTL_MS = 10 * 60_000;
const CONFIRM_LABEL = "确认发送";
const CANCEL_LABEL = "取消";
const CHALLENGE_PATTERN = /\[悦普识星 确认 (wc_[0-9a-f-]+)\]/iu;

function paramsFromEvent(event) {
  if (isRecord(event?.params)) return event.params;
  if (isRecord(event?.arguments)) return event.arguments;
  if (isRecord(event?.input)) return event.input;
  return {};
}

function resultFromEvent(event) {
  return event?.result ?? event?.output ?? event?.message;
}

function messageText(message) {
  if (typeof message === "string") return message;
  if (!isRecord(message)) return "";
  if (typeof message.text === "string") return message.text;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : part?.text))
      .filter(nonemptyString)
      .join("\n");
  }
  return typeof message.content === "string" ? message.content : "";
}

function parsedToolResult(message) {
  const text = messageText(message).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function askQuestion(header, question, options) {
  return {
    questions: [{ header, question, options, multiSelect: false }],
  };
}

function flowPauseDirective(stage, message) {
  const result = parsedToolResult(message);
  const code = nonemptyString(result?.error?.code) ? result.error.code : "结果未能继续";
  return [
    `YPSCAN_FLOW_DIRECTIVE=${stage} 已暂停（${code}）。不得用普通文本提问后结束本轮。`,
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(
      askQuestion("悦普识星下一步", `${stage} 当前无法自动继续，请选择下一步。`, [
        { label: "重试", description: "按当前真实参数重新执行当前步骤" },
        { label: "结束本次", description: "保留当前结果并结束本次流程" },
      ]),
    )}`,
  ].join("\n");
}

const MCN_MARKDOWN_TABLE_HEADER = [
  "| 机构名 | 返点 | 综合分 | 本机构预估覆盖达人数 |",
  "| --- | --- | --- | --- |",
].join("\n");
const MCN_MARKDOWN_EMPTY_ROW = "| 暂无匹配机构 | — | — | — |";

const FIELD_SELECTION_AUTO_OPEN_FAILED = "浏览器打开请求未成功";

function fieldSelectionDirective(message) {
  const result = parsedToolResult(message);
  const autoOpenFailed =
    String(firstString(result?.message, result?.error?.message)).trim() ===
    FIELD_SELECTION_AUTO_OPEN_FAILED;
  const url = firstString(result?.url, result?.data?.url);
  const linkReady = result?.success === true || (result?.success === false && autoOpenFailed);
  if (!linkReady || !url) return flowPauseDirective("字段选择", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=字段选择链接已生成。先把 FIELD_SELECTION_URL 里的原始 url 原样输出为单独一行用户可见正文：禁止 Markdown 包装、重写、用 Browser 打开或替用户选择字段。",
    "用户在选择页提交后，select_inquiry_form_fields 会把所选字段按需求 ID 持久化到 Provider 数据库。不得调用已弃用的 get_selected_inquiry_form_fields，不得查询、重建、转存或把 columns 放入 Agent 上下文；后续 Provider 工具只传当前 schema 要求的业务标识，由后端关联字段。",
    `FIELD_SELECTION_URL=${url}`,
  ].join("\n");
}

function rankMcnsDirective(message) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("rank_mcns", message);
  const mcns = result?.data?.mcns;
  if (!Array.isArray(mcns)) return flowPauseDirective("rank_mcns", message);
  const empty = mcns.length === 0;
  const options = empty
    ? [
        { label: "人工拓展并提报", description: "使用宿主 Browser 继续筛选达人" },
        { label: "结束本次", description: "保留机构表格的空结果并结束本次流程" },
      ]
    : [
        { label: "询价机构", description: "从当前真实 MCN 表格选择机构并继续询价" },
        { label: "人工拓展并提报", description: "使用宿主 Browser 继续筛选达人" },
      ];
  return [
    "YPSCAN_FLOW_DIRECTIVE=rank_mcns 成功。本 tool result 里的表头只是格式提示，不是用户可见表格。",
    "输出顺序：先把当前响应中的完整 MCN Markdown 表格作为用户可见正文文本块写出，再原样展示此前 ypscan_save_excel_artifact 返回的 CREATOR_PREVIEW_LOCAL_PATH，最后调用 AskUserQuestion。不要输出达人预览表下载链接；表格禁止改成项目符号或编号列表。",
    "表格固定列：机构名、返点、综合分、本机构预估覆盖达人数；每行覆盖人数只读取该机构对象自己的 candidate_count 原值，严禁使用累计字段 mcn_covered_creator_count，严禁与前序机构累加，也不得用累计/聚合覆盖字段或相邻行差值替代；保持响应顺序，缺失值写未知，不使用历史值补齐。",
    "AskUserQuestion 不得成为 rank_mcns 后的第一个 assistant block；表格不得放入弹窗 question，本地 file_path 不得放入弹窗 question，也不得在 AskUserQuestion 返回后补发。若本轮 search_creators 确实未返回 creators_export_path 或精确保存参数，必须如实说明无法保存，禁止编造或复用历史链接。",
    "人工拓展并提报 = 先用宿主 Browser 直接打开当前平台达人广场，再调用 ypscan_manual_select_filters；只有其 ready_for_collection=true 后才原样使用 collection_args 调用 ypscan_manual_research。星图固定打开 https://www.xingtu.cn/ad/creator/market，蒲公英固定打开 https://pgy.xiaohongshu.com/solar/pre-trade/note/kol；不先打开首页、工作台或其他中转页，任何前缀的 manual_source_creators 都不得调用。",
    MCN_MARKDOWN_TABLE_HEADER,
    ...(empty ? [MCN_MARKDOWN_EMPTY_ROW] : []),
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(
      askQuestion(
        "悦普识星下一步",
        empty
          ? "请根据弹窗打开前已展示的“暂无匹配机构”Markdown 表格和达人预览表本地文件路径选择下一条路径。"
          : "请根据弹窗打开前已在对话中完整展示的本次 MCN Markdown 表格和达人预览表本地文件路径选择下一条路径。",
        options,
      ),
    )}`,
  ].join("\n");
}

function searchCreatorsDirective(message, params = {}) {
  const result = parsedToolResult(message);
  const creatorsExportPath = firstString(
    result?.data?.creators_export_path,
    result?.creators_export_path,
  );
  const artifactId = firstString(params?.id, result?.data?.requirement_id, result?.requirement_id);
  const lines = [
    "YPSCAN_FLOW_DIRECTIVE=search_creators 成功（包括 0 命中）。不得调用 Browser 或直接结束。",
  ];
  if (creatorsExportPath) {
    if (artifactId) {
      lines.push(
        "下一步立即逐字使用下面参数调用 ypscan_save_excel_artifact，不向用户展示 excel_file_url；保存成功后再调用 rank_mcns。不得用 Browser、shell、curl、web_fetch、Python 或通用文件写入代替。",
        `SAVE_EXCEL_ARTIFACT_ARGS=${JSON.stringify({
          artifact_kind: "creator_preview",
          artifact_id: artifactId,
          excel_file_url: creatorsExportPath,
        })}`,
      );
    } else {
      lines.push(
        "当前结果缺少可验证的本轮 requirement_id，无法形成精确保存参数；不得猜测 artifact_id 或调用保存工具，下一步继续调用 rank_mcns。",
      );
    }
  } else {
    lines.push(
      "当前响应未返回 creators_export_path；下一步继续调用 rank_mcns，但表格后必须如实说明达人预览表无法保存，禁止编造或复用历史链接。",
    );
  }
  return lines.join("\n");
}

function creatorPreviewSaveDirective(message, params = {}) {
  if (params?.artifact_kind !== "creator_preview") return null;
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("达人预览表保存", message);
  const filePath = firstString(result?.data?.file_path, result?.delivery?.local_path);
  if (!filePath) return flowPauseDirective("达人预览表保存", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=达人预览表 Excel 已保存到当前项目。",
    `CREATOR_PREVIEW_LOCAL_PATH=${filePath}`,
    "下一步固定调用 rank_mcns；保留上面的真实绝对路径，rank_mcns 成功后在完整 MCN Markdown 表格之后原样展示，再调用其 ASK_USER_QUESTION_ARGS。不得提前展示本地路径、重复下载或直接结束。",
  ].join("\n");
}

function manualFilterSelectionDirective(message) {
  const result = parsedToolResult(message);
  const code = nonemptyString(result?.error?.code)
    ? result.error.code
    : "YPSCAN_MANUAL_FILTER_SELECTION_FAILED";
  const loginOrCaptcha = /LOGIN|CAPTCHA/u.test(code);
  if (!loginOrCaptcha) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=ypscan_manual_select_filters 未就绪（${code}），失败阶段=${result?.failed_stage ?? "未知"}，失败控件=${result?.failed_control ?? "未知"}。`,
      "不得调用 ypscan_manual_research；不得把 failed_filters 写成 actual_filters，也不得要求用户处理普通弹窗或页面复位。工具内部一次有界恢复已经结束，应如实报告筛选失败证据。",
    ].join("\n");
  }
  const options = [
    { label: "已处理，继续", description: "在当前 Browser 页面完成登录或安全验证后继续" },
    { label: "结束本次", description: "保留当前筛选证据并结束本次流程" },
  ];
  return [
    `YPSCAN_FLOW_DIRECTIVE=ypscan_manual_select_filters 已暂停（${code}）。不得调用抓取工具。`,
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(
      askQuestion("悦普识星 Browser 下一步", "当前平台筛选页面无法继续，请选择下一步。", options),
    )}`,
  ].join("\n");
}

function manualFilterSelectionSuccessDirective(message) {
  const result = parsedToolResult(message);
  if (result?.ready_for_collection !== true || !isRecord(result?.collection_args)) {
    return manualFilterSelectionDirective(message);
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=ypscan_manual_select_filters 已完成真实筛选回读。下一步必须原样调用 ypscan_manual_research，不得修改页面或重算参数。",
    `MANUAL_RESEARCH_COLLECTION_ARGS=${JSON.stringify(result.collection_args)}`,
  ].join("\n");
}

function manualResearchDirective(message) {
  const result = parsedToolResult(message);
  const code = nonemptyString(result?.error?.code)
    ? result.error.code
    : "YPSCAN_MANUAL_RESEARCH_FAILED";
  const loginOrCaptcha = /LOGIN|CAPTCHA/u.test(code);
  if (code === "YPSCAN_MANUAL_SELECTION_REQUIRED" && isRecord(result?.selector_args)) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 拒绝旧的一体化调用；抓取尚未开始。",
      `MANUAL_FILTER_SELECTION_ARGS=${JSON.stringify(result.selector_args)}`,
      "下一步调用 ypscan_manual_select_filters，不得原样重试抓取工具。",
    ].join("\n");
  }
  if (code === "YPSCAN_MANUAL_SELECTION_STALE") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 在读页前发现筛选凭证失效，未抓取、未翻页、未导出。",
      "必须重新调用 ypscan_manual_select_filters 选择当前关键词分支，不得让抓取工具自行修复筛选。",
    ].join("\n");
  }
  if (!loginOrCaptcha) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 未完成（${code}）。这是 Agent 可处理的页面/参数问题，不得要求用户关闭普通弹窗、复位筛选或刷新页面，也不得调用 AskUserQuestion。`,
      "Agent 应精简/修正参数后让工具重新直达固定达人广场并做一次有界重试，不得自行打开其他页面；仍失败则如实交付 partial/failed 证据，不盲目重复同一调用。",
    ].join("\n");
  }
  const options = [
    { label: "已处理，继续", description: "在当前 Browser 页面完成登录或安全验证后继续" },
    { label: "结束本次", description: "保留当前结果并结束本次流程" },
  ];
  return [
    `YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 已暂停（${code}）。不得用普通文本提问后结束本轮。`,
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(
      askQuestion("悦普识星 Browser 下一步", "当前平台页面无法继续，请选择下一步。", options),
    )}`,
  ].join("\n");
}

function manualResearchSuccessDirective(message) {
  const result = parsedToolResult(message);
  if (result?.status === "awaiting_filter_selection" && isRecord(result?.next_selection_args)) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 已完成当前关键词抓取，尚未进入详情或最终交付。",
      `MANUAL_FILTER_SELECTION_ARGS=${JSON.stringify(result.next_selection_args)}`,
      "下一步必须调用 ypscan_manual_select_filters；不得让抓取工具自行切换关键词或筛选。",
    ].join("\n");
  }
  const operation = result?.operation ?? "collect";
  const reviewRemaining = Number.isFinite(result?.review_remaining)
    ? result.review_remaining
    : null;
  const excelPath = nonemptyString(result?.artifact?.excel_path)
    ? result.artifact.excel_path.trim()
    : null;
  const candidateCount = Number.isFinite(result?.candidate_count) ? result.candidate_count : null;
  const targetRowCount = Number.isFinite(result?.artifact?.target_row_count)
    ? result.artifact.target_row_count
    : null;
  const targetCount = Number.isFinite(result?.plan?.target_count) ? result.plan.target_count : null;
  const eligibleCount = Number.isFinite(result?.eligible_candidate_count)
    ? result.eligible_candidate_count
    : null;
  const rejectedCount = Number.isFinite(result?.rejected_candidate_count)
    ? result.rejected_candidate_count
    : null;
  const needsReviewCount = Number.isFinite(result?.needs_review_candidate_count)
    ? result.needs_review_candidate_count
    : null;
  const deliveryShortfall = Number.isFinite(result?.delivery_shortfall)
    ? result.delivery_shortfall
    : null;
  const priceRanges = Array.isArray(result?.plan?.planned_filters)
    ? result.plan.planned_filters
        .filter((filter) => filter?.control === "creator_price")
        .map((filter) => `${filter.min}–${filter.max} ${filter.unit ?? ""}`.trim())
    : [];
  const lines = [
    "YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 已返回真实 Browser 结果。不得在成功后重复调用平台原生导出。",
    ...(reviewRemaining > 0
      ? [
          `当前仍有 ${reviewRemaining} 条详情语义复核待处理。必须结合客户原始需求、review_batch 的详情字段与近期内容生成 include/exclude、reasons、evidence，并立即用 operation=apply_reviews、当前 artifact.run_id 调回同一工具；每批最多 20 条，直到 review_remaining=0，期间不得把空的最终名单当成交付结果。`,
        ]
      : [
          "最终回复必须先说明候选池数量、最终名单行数、未表达条件和缺口；不得把平台硬筛结果表述为已经完成语义复核，只有写入 include 的达人属于最终名单。",
        ]),
    `价格交付统计：目标 ${targetCount ?? "未知"}，价格合格 ${eligibleCount ?? "未知"}，价格淘汰 ${rejectedCount ?? "未知"}，价格待复核 ${needsReviewCount ?? "未知"}，缺口 ${deliveryShortfall ?? "未知"}。`,
    ...(priceRanges.length ? [`本轮实际手扒报价区间：${priceRanges.join("；")}。`] : []),
    "最终推荐只能来自本工具返回的 candidates/detail_tasks；昵称或平台 ID 搜索只允许定位已有详情任务，不得重新建立绕过价格筛选的候选池。",
    "price_check.status=rejected 的达人不得推荐或包装为备选；needs_review 只能标为待确认，不能计入已通过人数。",
  ];
  if ((reviewRemaining ?? 0) === 0 && (deliveryShortfall ?? 0) > 0) {
    lines.push(
      `当前价格合格人数不足目标，缺口为 ${deliveryShortfall}；不得声称已凑满，仍不足时必须如实交付当前合格数和缺口。`,
    );
  }
  if (excelPath) {
    lines.push(
      `MANUAL_RESEARCH_EXCEL_PATH=${excelPath}`,
      "必须把上面的 Excel 绝对路径原样作为主要交付展示给用户；该本地文件不消耗平台导出额度。",
    );
  } else {
    lines.push("本次没有可交付的 artifact.excel_path，必须如实说明文件未生成，禁止编造路径。");
  }
  if (operation === "apply_reviews" && reviewRemaining > 0) {
    lines.push(
      "apply_reviews 已返回下一批 review_batch；不得停下或重新采集列表，继续写回当前 run_id。",
    );
  }
  if ((candidateCount ?? targetRowCount ?? 0) > 20) {
    lines.push(
      "候选超过 20 人：禁止在对话粘贴完整名单，只给筛选摘要、待确认项和最多 10 条预览；完整记录以 Excel 为准。",
    );
  }
  return lines.join("\n");
}

function flowDirective(toolName, message, params = {}) {
  const normalizedName = toolName.toLowerCase();
  const result = parsedToolResult(message);
  if (stripHostPrefix(normalizedName) === "select_inquiry_form_fields") {
    return fieldSelectionDirective(message);
  }
  if (/(?:^|__)ypscan_save_excel_artifact$/iu.test(normalizedName)) {
    return creatorPreviewSaveDirective(message, params);
  }
  if (result?.success !== true) {
    if (/(?:^|__)ypscan_manual_select_filters$/iu.test(normalizedName)) {
      return manualFilterSelectionDirective(message);
    }
    if (/(?:^|__)ypscan_manual_research$/iu.test(normalizedName)) {
      return manualResearchDirective(message);
    }
    if (
      /(?:^|__)ypscan_parse_requirement$/iu.test(normalizedName) ||
      /(?:^|__)validate_requirement$/iu.test(normalizedName) ||
      /(?:^|__)search_creators$/iu.test(normalizedName) ||
      /(?:^|__)rank_mcns$/iu.test(normalizedName)
    ) {
      return flowPauseDirective(normalizedName.split("__").at(-1), message);
    }
    return null;
  }
  if (/(?:^|__)ypscan_parse_requirement$/iu.test(normalizedName)) {
    const provider = result?.data?.projections?.provider;
    const ready = provider?.ready;
    if (ready !== true) return flowPauseDirective("需求解析", message);
    const jobs = Array.isArray(provider?.search_jobs) ? provider.search_jobs : [];
    const lines = [
      "YPSCAN_FLOW_DIRECTIVE=需求解析成功。下一步固定调用 validate_requirement；不得调用 Browser、search_creators 或直接结束。",
    ];
    if (jobs.length === 1 && isRecord(jobs[0]?.params)) {
      lines.push(
        "VALIDATE_REQUIREMENT_ARGS 是编译后的完整落库参数。调用 validate_requirement 时必须把它整体作为顶层参数传入，不得手工重建、增删字段、重算区间或改 createdAt/updatedAt。",
        `VALIDATE_REQUIREMENT_ARGS=${JSON.stringify(jobs[0].params)}`,
      );
    } else {
      lines.push(
        "多个搜索分组时按顺序为每个 search_jobs[i].params 调用一次 validate_requirement；每次都必须整体透传该 job 的完整 params，包括 createdAt/updatedAt。",
      );
    }
    return lines.join("\n");
  }
  if (/(?:^|__)validate_requirement$/iu.test(normalizedName)) {
    return "YPSCAN_FLOW_DIRECTIVE=validate_requirement 成功。下一步固定调用 search_creators；保持真实 requirement_id 和 platform，不调用 Browser 或直接结束。";
  }
  if (/(?:^|__)search_creators$/iu.test(normalizedName)) {
    return searchCreatorsDirective(message, params);
  }
  if (/(?:^|__)rank_mcns$/iu.test(normalizedName)) return rankMcnsDirective(message);
  if (/(?:^|__)ypscan_manual_select_filters$/iu.test(normalizedName)) {
    return manualFilterSelectionSuccessDirective(message);
  }
  if (/(?:^|__)ypscan_manual_research$/iu.test(normalizedName)) {
    return manualResearchSuccessDirective(message);
  }
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
      context?.runId,
      context?.run_id,
      context?.sessionKey,
      context?.sessionId,
      event?.runId,
      event?.run_id,
      event?.sessionKey,
      event?.sessionId,
    ) ?? "global"
  );
}

function inquiryFingerprint(params) {
  return fingerprint(JSON.stringify(params ?? {}));
}

function answerTexts(result) {
  if (typeof result === "string") return [result];
  if (!isRecord(result)) return [];
  return [
    result.answer,
    ...(isRecord(result.answers) ? Object.values(result.answers) : []),
    ...(Array.isArray(result.content) ? result.content.map((part) => part?.text) : []),
  ].filter(nonemptyString);
}

function challengeIdFrom(params, result) {
  const texts = [
    ...(Array.isArray(params?.questions)
      ? params.questions.map((question) => question?.question)
      : []),
    ...answerTexts(result),
  ].filter(nonemptyString);
  for (const value of texts) {
    const match = value.match(CHALLENGE_PATTERN);
    if (match) return match[1];
  }
  return null;
}

function selectedLabel(result) {
  for (const text of answerTexts(result)) {
    const lastLine =
      text
        .trim()
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1) ?? "";
    const candidate = lastLine.replace(/[。.!！?？\s]+$/u, "");
    if (
      candidate === CONFIRM_LABEL ||
      new RegExp(`[:：]\\s*${CONFIRM_LABEL}$`, "u").test(candidate)
    ) {
      return CONFIRM_LABEL;
    }
    if (
      candidate === CANCEL_LABEL ||
      new RegExp(`[:：]\\s*${CANCEL_LABEL}$`, "u").test(candidate)
    ) {
      return CANCEL_LABEL;
    }
  }
  return null;
}

function confirmationQuestion(challengeId, params) {
  const recipients = Array.isArray(params?.supplierIds) ? params.supplierIds.length : 0;
  const requirement = nonemptyString(params?.requirement_id)
    ? params.requirement_id.trim()
    : "未提供";
  const message = nonemptyString(params?.wechat_notification_message)
    ? params.wechat_notification_message
    : "（未提供企微正文）";
  return {
    questions: [
      {
        header: "悦普识星确认",
        question: [
          `[悦普识星 确认 ${challengeId}] 即将向 ${recipients} 家机构发起企微询价（需求 ${requirement}）。`,
          "实际待发送企微正文：",
          message,
          "确认仅授权这一次调用，10 分钟内有效，不证明送达。",
        ].join("\n"),
        options: [
          { label: CONFIRM_LABEL, description: "仅授权当前这一次调用，10 分钟内有效" },
          { label: CANCEL_LABEL, description: "不执行该操作" },
        ],
        multiSelect: false,
      },
    ],
  };
}

/**
 * Register the one actual business gate in this plugin: a one-shot,
 * in-memory confirmation immediately before WeCom distribution. The fixed
 * Provider sequence is expressed as stateless result directives; no call is
 * blocked and no cross-turn workflow state is stored.
 */
export function registerWecomConfirmationOnlyHooks(api, { now = Date.now, skillPath = null } = {}) {
  const challenges = new Map();
  const skillReadScopes = new Set();

  const prune = (callNow) => {
    for (const [challengeId, challenge] of challenges) {
      if (callNow - challenge.createdAt > GRANT_TTL_MS || challenge.consumed) {
        challenges.delete(challengeId);
      }
    }
  };

  api.on(
    "before_tool_call",
    async (event, context) => {
      const callNow = now();
      prune(callNow);
      const toolName = firstString(event?.toolName, event?.name) ?? "";
      const normalizedName = toolName.toLowerCase();
      const params = normalizeToolCallParams(normalizedName, paramsFromEvent(event));
      const bare = stripHostPrefix(normalizedName);

      if (
        nonemptyString(skillPath) &&
        /(^|__)read$/iu.test(normalizedName) &&
        [params?.path, params?.file_path, params?.filePath].some(
          (value) => nonemptyString(value) && value.trim() === skillPath,
        )
      ) {
        skillReadScopes.add(scopeKey(event, context));
      }

      if (bare === "create_with_distributions") {
        const key = inquiryFingerprint(params);
        const grant = [...challenges.values()].find(
          (challenge) =>
            challenge.confirmed &&
            !challenge.consumed &&
            challenge.fingerprint === key &&
            callNow - challenge.createdAt <= GRANT_TTL_MS,
        );
        if (grant) {
          grant.consumed = true;
          return undefined;
        }

        const challengeId = newId("wc");
        challenges.set(challengeId, {
          id: challengeId,
          fingerprint: key,
          createdAt: callNow,
          confirmed: false,
          consumed: false,
          scope: scopeKey(event, context),
        });
        const askUserQuestion = confirmationQuestion(challengeId, params);
        const recoveryDirective = {
          schema_version: 1,
          code: "HITL_REQUIRED",
          category: "control",
          action: "call_host_tool",
          next_tool: "AskUserQuestion",
          next_args_from: "ASK_USER_QUESTION_ARGS",
          retry_original: true,
          params_valid: true,
          modify_params: false,
        };
        return {
          block: true,
          blockReason: [
            "HITL_REQUIRED: 【企微状态：本次未发送｜等待用户二次确认】只有确认后的原参数重试才会发起发送",
            `YPSCAN_BLOCK_DIRECTIVE=${JSON.stringify(recoveryDirective)}`,
            "ASK_USER_QUESTION_REQUIRED: 当前原始参数已通过预检；必须立即调用宿主 AskUserQuestion，逐字使用下一行 JSON 参数。用户确认后原样重试一次。",
            `ASK_USER_QUESTION_ARGS=${JSON.stringify(askUserQuestion)}`,
          ].join("\n"),
          recoveryDirective,
          askUserQuestion,
        };
      }

      return undefined;
    },
    HOOK_OPTIONS,
  );

  api.on(
    "before_prompt_build",
    (event, context) => {
      if (!nonemptyString(skillPath) || skillReadScopes.has(scopeKey(event, context))) {
        return undefined;
      }
      return {
        prependContext: [
          "[YPscan startup instruction]",
          `Before the first YPscan or media-assistant action in this run, read the complete Skill exactly once with the host Read tool: ${skillPath}`,
          "固定业务顺序：需求解析阶段内部固定调用 ypscan_parse_requirement → validate_requirement；完整固定链路：ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns。search_creators 返回精确 SAVE_EXCEL_ARTIFACT_ARGS 时立即调用保存工具，不向用户输出 creators_export_path 或 Excel 下载链接；保存成功后再调用 rank_mcns。rank_mcns 后先把完整 MCN Markdown 表格作为用户可见正文文本块写出，再展示真实本地 file_path，最后调用 AskUserQuestion。表格和本地路径不得放进弹窗 question，也不得在 AskUserQuestion 返回后补发；表格禁止改成项目符号或编号列表。人工拓展与手扒先用宿主 Browser 直接打开当前平台达人广场，再调用 ypscan_manual_select_filters；筛选返回 ready_for_collection=true 后才调用 ypscan_manual_research。多关键词严格逐分支 select → collect；星图固定打开 https://www.xingtu.cn/ad/creator/market，蒲公英固定打开 https://pgy.xiaohongshu.com/solar/pre-trade/note/kol，不先打开首页、工作台或其他中转页；任何前缀的 manual_source_creators 都不得调用。",
          "只有确实需要用户澄清、选择、登录/验证码、暂停或结束时才调用 AskUserQuestion；普通 UI/参数问题的一次有界自动重试不调用。正常成功交付不追加完成弹窗。",
          "用户选择人工拓展后，固定达人广场起始导航先由宿主 Browser 直接打开，选择工具仍保留同页导航兜底；首次调用 ypscan_manual_select_filters 必须保留完整硬条件 facts，不得为避开页面控件删除男粉、受众城市或内容排除条件，工具会自动拆分页面筛选、详情硬审与语义复核；普通弹窗、遮罩、失效浮层和筛选复位由工具/Agent 处理，不得让用户代关，也不得另开首页、工作台或中转页；只有登录失效或真实 CAPTCHA 才请求用户接管。",
          "人工拓展的 creator_count 使用用户最新指定的本轮交付数并覆盖原需求总量；即使历史轮次声称旧 schema 要求 page_url/original_brief，本轮也先按新版省略，当前验证器再次拒绝时才用当前 URL 与 original_brief='见当前对话原需求' 兼容，禁止复制完整 brief。",
          "手扒达人价格必须从当前 ypscan_parse_requirement.data.facts 复制客户原始 operator 和原始数值；禁止把 Provider 区间或手工计算后的 50%–120% 区间再次传入。除本轮唯一 creator_count 外，不重算价格事实。",
        ].join("\n"),
      };
    },
    HOOK_OPTIONS,
  );

  api.on(
    "tool_result_persist",
    (event) => {
      const toolName = firstString(event?.toolName, event?.name) ?? "";
      return appendDirective(
        event?.message,
        flowDirective(toolName, event?.message, paramsFromEvent(event)),
      );
    },
    HOOK_OPTIONS,
  );

  api.on(
    "after_tool_call",
    async (event, context) => {
      const toolName = firstString(event?.toolName, event?.name) ?? "";
      if (!/askuserquestion/iu.test(toolName)) return;
      const params = paramsFromEvent(event);
      const result = resultFromEvent(event);
      const challengeId = challengeIdFrom(params, result);
      const scopedPending = challengeId
        ? []
        : [...challenges.values()].filter(
            (item) => !item.confirmed && !item.consumed && item.scope === scopeKey(event, context),
          );
      const challenge = challengeId
        ? challenges.get(challengeId)
        : scopedPending.length === 1
          ? scopedPending[0]
          : null;
      if (!challenge) return;
      challenge.confirmed = selectedLabel(result) === CONFIRM_LABEL;
      if (!challenge.confirmed) challenges.delete(challenge.id);
    },
    HOOK_OPTIONS,
  );

  return {
    resetTransientState() {
      challenges.clear();
      skillReadScopes.clear();
    },
  };
}

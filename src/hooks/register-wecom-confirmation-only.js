import { fingerprint, firstString, isRecord, newId, nonemptyString } from "../util/hash.js";
import { normalizeToolCallParams, stripHostPrefix } from "../contract/registry.js";

const HOOK_OPTIONS = { priority: 90, timeoutMs: 5000 };
const GRANT_TTL_MS = 10 * 60_000;
const MESSAGE_CONFIRM_LABEL = "确认询价消息";
const RECIPIENT_CONFIRM_LABEL = "确认发送机构";
const CANCEL_LABEL = "取消";
const CHALLENGE_PATTERN = /\[悦普识星 询价确认 (wc_[0-9a-f-]+)\]/iu;

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

function requirementInputRepairDirective(message) {
  const result = parsedToolResult(message);
  const violations = Array.isArray(result?.error?.details?.violations)
    ? result.error.details.violations.filter(nonemptyString)
    : [];
  return [
    "YPSCAN_FLOW_DIRECTIVE=ypscan_parse_requirement 拒绝的是 Agent 构造参数，不是用户业务需求。不得让用户为字段形状、枚举、数值单位或引用方式纠错。",
    `PARSE_REPAIR_VIOLATIONS=${JSON.stringify(violations)}`,
    "根据 violations 和工具 repair 示例一次性修正全部 facts，并自动重试一次；不要逐字段试探。external_condition 的 value 必须使用 quote 的原文，不得补写“受众/粉丝”等原文没有的主体。若同一原文已经自动重试过一次仍失败，停止并报告具体接入错误，不得循环重试。只有缺少或冲突的真实业务信息才调用 AskUserQuestion。",
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
    "现在停止业务调用并等待用户完成选择后回复“好了”。收到后保留原需求的全部项目、平台、合作形式、价格、档期、数量、粉丝、返点、内容、画像、城市、CPM 和截止时间，撰写 description 与 wechat_notification_message；不得调用 create_submission_batch。消息准备好后调用 create_with_distributions，由 Hook 依次完成消息确认和机构列表确认。",
    `FIELD_SELECTION_URL=${url}`,
  ].join("\n");
}

function rankMcnsDirective(message) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("rank_mcns", message);
  const mcns = result?.data?.mcns;
  if (!Array.isArray(mcns)) return flowPauseDirective("rank_mcns", message);
  const empty = mcns.length === 0;
  const totalRanked = Number.isFinite(result?.data?.total_ranked)
    ? result.data.total_ranked
    : mcns.length;
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
    "人工拓展并提报 = 先调用 ypscan_manual_research(operation=start) 创建本地运行，再由 Agent 使用宿主原生 Browser 自主导航、关闭普通弹窗、设置筛选、翻页和打开详情；只有原生 Browser 无法稳定选择级联菜单时，才调用 ypscan_select_cascade，并由 Agent 根据需求和当前页面决定 field_label、trigger_label 与 path。每到稳定列表页或详情页分别调用 capture_list/capture_detail 只读采集。首关键词先完成全部硬筛且关键词最后提交，后续关键词保留筛选集只换关键词。普通页面问题自主恢复，任何前缀的 manual_source_creators 都不得调用。",
    MCN_MARKDOWN_TABLE_HEADER,
    ...(empty ? [MCN_MARKDOWN_EMPTY_ROW] : []),
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(
      askQuestion(
        "悦普识星下一步",
        [
          "机构排序已完成。",
          `匹配机构：${totalRanked} 家`,
          `机构明细：${empty ? "弹窗打开前已展示的“暂无匹配机构”Markdown 表格" : "弹窗打开前已在对话中完整展示"}`,
          "达人预览表本地文件路径：请以弹窗前展示的保存结果为准",
          "请选择下一步。",
        ].join("\n"),
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

function providerExcelUrl(result) {
  return firstString(
    result?.data?.excel_file_url,
    result?.data?.excel_url,
    result?.data?.creators_export_path,
    result?.excel_file_url,
    result?.excel_url,
  );
}

function distributionDirective(message) {
  const result = parsedToolResult(message);
  if (result?.success !== true) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=create_with_distributions 未确认成功。企微属于外发副作用，禁止盲目重发。先用当前 requirement_id/project_id 调用 sync_mcn_inquiry_status 核对；只有确认未创建发送记录后才能重新发起双确认。",
    ].join("\n");
  }
  const status = result?.data?.send_status;
  const sent = Array.isArray(status?.sent_suppliers) ? status.sent_suppliers : [];
  const failed = Array.isArray(status?.failed_suppliers) ? status.failed_suppliers : [];
  return [
    "YPSCAN_FLOW_DIRECTIVE=create_with_distributions 已返回发送结果。先展示真实发送状态、成功机构和失败机构，不得把部分成功表述为全部成功。然后立即逐字调用下面的 AskUserQuestion，询问是否继续人工拓展。",
    `企微发送摘要：成功 ${sent.length} 家，失败 ${failed.length} 家。`,
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
          { label: "继续人工拓展", description: "进入 Browser 人工筛选达人流程" },
          { label: "暂不拓展", description: "保留当前询价结果，等待机构回填" },
        ],
      ),
    )}`,
    "用户之后说“填好了”“已回收”或“生成表格”时，固定从 sync_mcn_inquiry_status 开始取回，禁止直接 rank_creators 或 create_submission_batch。",
  ].join("\n");
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
      "YPSCAN_FLOW_DIRECTIVE=询价状态同步成功，但没有返回可验证的 inquiry_ids。不得调用 ingest_mcn_submissions、rank_creators 或生成空提报表；如实说明机构尚未形成可取回记录。",
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=询价状态同步成功。下一步立即把本次响应的完整 inquiry_ids 原样传给 ingest_mcn_submissions，不得跨轮拼接、使用 trace_id 或在此停下。",
    `INGEST_MCN_SUBMISSIONS_ARGS=${JSON.stringify({ inquiry_ids: normalizedIds })}`,
  ].join("\n");
}

function ingestSubmissionsDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("机构提报入库", message);
  const excelFileUrl = providerExcelUrl(result);
  const requirementId = firstString(
    result?.data?.requirement_id,
    result?.requirement_id,
    params?.requirement_id,
  );
  if (!excelFileUrl || !requirementId) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=ingest_mcn_submissions 成功但缺少可信 Excel URL 或 requirement_id，无法保存机构达人预览表。不得编造链接、复用历史文件或跳过预览表直接精排。",
      `ASK_USER_QUESTION_ARGS=${JSON.stringify(
        askQuestion("机构预览表", "机构数据已入库，但预览表下载信息不完整，请选择下一步。", [
          { label: "重试", description: "重新读取本轮机构提报结果" },
          { label: "结束本次", description: "保留已入库结果并停止" },
        ]),
      )}`,
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=机构提报已入库并返回 Excel。先把 MCN_CREATOR_PREVIEW_URL 中的原始 URL 直接输出为单独一行用户可见正文，再立即逐字调用 ypscan_save_excel_artifact 保存为机构达人预览表；保存成功后继续 rank_creators。不得改写链接或用 Markdown 包装。",
    `MCN_CREATOR_PREVIEW_URL=${excelFileUrl}`,
    `SAVE_EXCEL_ARTIFACT_ARGS=${JSON.stringify({
      artifact_kind: "mcn_creator_preview",
      artifact_id: requirementId,
      excel_file_url: excelFileUrl,
    })}`,
  ].join("\n");
}

function rankCreatorsDirective(message, params = {}) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return flowPauseDirective("rank_creators", message);
  const rankedCount = Number(result?.data?.ranked_count);
  if (Number.isFinite(rankedCount) && rankedCount <= 0) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=rank_creators 成功但精排结果为空。不得调用 create_submission_batch 生成空提报表；如实说明当前没有可提报达人。",
    ].join("\n");
  }
  const requirementId = firstString(
    params?.requirement_id,
    result?.data?.requirement_id,
    result?.requirement_id,
  );
  if (!requirementId) return flowPauseDirective("rank_creators", message);
  return [
    "YPSCAN_FLOW_DIRECTIVE=rank_creators 精排成功。下一步立即调用 create_submission_batch 生成第 1 页提报表，不向用户停顿提问，也不得重新 rank_mcns。",
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
    "YPSCAN_FLOW_DIRECTIVE=create_submission_batch 已生成 Provider 提报表。下一步立即逐字调用 ypscan_save_excel_artifact，不向用户展示下载 URL。",
    `SAVE_EXCEL_ARTIFACT_ARGS=${JSON.stringify({
      artifact_kind: "submission_batch",
      artifact_id: String(artifactId),
      excel_file_url: excelFileUrl,
    })}`,
  ].join("\n");
}

function workflowStateDirective(message) {
  const result = parsedToolResult(message);
  if (result?.success !== true) return null;
  return [
    "YPSCAN_FLOW_DIRECTIVE=get_workflow_state 只用于诊断。allowed_actions 可能滞后，不得替代本轮用户已选择的固定链路，不得因此推荐 manual_source_creators。",
    "企微发送只使用 create_with_distributions；提报表只在 ingest_mcn_submissions → rank_creators 完成后使用 create_submission_batch。",
  ].join("\n");
}

function excelArtifactSaveDirective(message, params = {}) {
  const artifactKind = params?.artifact_kind;
  if (!["creator_preview", "mcn_creator_preview", "submission_batch"].includes(artifactKind))
    return null;
  const result = parsedToolResult(message);
  const stage =
    artifactKind === "submission_batch"
      ? "提报表保存"
      : artifactKind === "mcn_creator_preview"
        ? "机构达人预览表保存"
        : "达人预览表保存";
  if (result?.success !== true) return flowPauseDirective(stage, message);
  const filePath = firstString(result?.data?.file_path, result?.delivery?.local_path);
  if (!filePath) return flowPauseDirective(stage, message);
  if (artifactKind === "mcn_creator_preview") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=机构达人预览表 Excel 已保存到当前项目。",
      `MCN_CREATOR_PREVIEW_LOCAL_PATH=${filePath}`,
      "先向用户原样展示上面的真实绝对路径，然后立即调用 rank_creators；不得停下、重新 rank_mcns 或调用 create_submission_batch。",
      `RANK_CREATORS_ARGS=${JSON.stringify({ requirement_id: params.artifact_id })}`,
    ].join("\n");
  }
  if (artifactKind === "submission_batch") {
    const nextArgs = result?.delivery?.next_args;
    return [
      "YPSCAN_FLOW_DIRECTIVE=Provider 提报表已保存到当前项目，完整机构询价链路已完成。",
      `SUBMISSION_BATCH_LOCAL_PATH=${filePath}`,
      "必须先把上面的真实绝对路径原样展示给用户。",
      ...(isRecord(nextArgs)
        ? [
            "展示路径后立即逐字调用下面的 AskUserQuestion，询问是否补充更新达人信息。",
            `ASK_USER_QUESTION_ARGS=${JSON.stringify(nextArgs)}`,
          ]
        : []),
    ].join("\n");
  }
  return [
    "YPSCAN_FLOW_DIRECTIVE=达人预览表 Excel 已保存到当前项目。",
    `CREATOR_PREVIEW_LOCAL_PATH=${filePath}`,
    "下一步固定调用 rank_mcns；保留上面的真实绝对路径，rank_mcns 成功后在完整 MCN Markdown 表格之后原样展示，再调用其 ASK_USER_QUESTION_ARGS。不得提前展示本地路径、重复下载或直接结束。",
  ].join("\n");
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
      "立即回到宿主原生 Browser 观察完整筛选区并继续剩余条件；不要重复点击已选路径，也不要把级联助手扩展成其他页面动作。",
    ].join("\n");
  }
  return [
    `YPSCAN_FLOW_DIRECTIVE=级联菜单未提交（${result?.error?.code ?? result?.status ?? "未知"}），但整个手扒任务不得停止。`,
    result?.recovery_hint ??
      "重新观察页面实际筛选名、入口文字和菜单层级后最多调整参数再试一次；仍失败则将该条件转入详情硬复核并继续其他筛选。",
  ].join("\n");
}

function manualResearchDirective(message) {
  const result = parsedToolResult(message);
  if (isRecord(result?.next_call)) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 当前状态=${result?.status ?? "未知"}。`,
      `YPSCAN_NEXT_CALL=${JSON.stringify(result.next_call)}`,
      "下一步原样执行 next_call，不得让抓取工具内部恢复页面。",
    ].join("\n");
  }
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
      "只能根据 Observer 状态和工具 next_call 恢复；没有 next_call 时如实交付 partial/failed 证据，不盲目重复同一调用。",
    ].join("\n");
  }
  const options = [
    { label: "已处理，继续", description: "在当前 Browser 页面完成登录或安全验证后继续" },
    { label: "结束本次", description: "保留当前结果并结束本次流程" },
  ];
  const resumeTool = nonemptyString(result?.user_action?.resume_tool)
    ? result.user_action.resume_tool.trim()
    : null;
  const resumeArgs = isRecord(result?.user_action?.resume_args)
    ? result.user_action.resume_args
    : null;
  return [
    `YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 已暂停（${code}）。不得用普通文本提问后结束本轮。`,
    ...(resumeTool && resumeArgs
      ? [
          `MANUAL_RESEARCH_RESUME_TOOL=${resumeTool}`,
          `MANUAL_RESEARCH_RESUME_ARGS=${JSON.stringify(resumeArgs)}`,
          "用户确认已完成验证后，必须原样调用上面的恢复工具和参数；不得根据 next_branch 猜测恢复位置。",
        ]
      : []),
    `ASK_USER_QUESTION_ARGS=${JSON.stringify(
      askQuestion("悦普识星 Browser 下一步", "当前平台页面无法继续，请选择下一步。", options),
    )}`,
  ].join("\n");
}

function manualResearchSuccessDirective(message) {
  const result = parsedToolResult(message);
  if (result?.status === "ready_for_native_browser") {
    return [
      "YPSCAN_FLOW_DIRECTIVE=原生 Browser 自助手扒运行已创建。现在由 Agent 自主操作宿主 Browser，不调用 ypscan_manual_browser_inspect、ypscan_manual_browser_action 或 ypscan_manual_select_filters。",
      `MANUAL_RESEARCH_RUN_ID=${result?.run_id ?? "未知"}`,
      "先观察整个页面：错页或重定向就导航到达人广场，普通弹窗自主关闭；根据 hard_requirements 与当前可见筛选项做语义匹配。级联菜单先用原生 Browser；无法稳定悬停展开时调用 ypscan_select_cascade，field_label、trigger_label、path 必须来自当前页面与需求，不得写死。最多调整参数再试一次，仍失败就转入详情硬复核。所有硬筛完成后最后输入首个关键词；后续只换关键词。",
      "每个稳定结果页调用 ypscan_manual_research(operation=capture_list, run_id, keyword, keyword_complete=false)；翻页由原生 Browser 完成。关键词采集完成后再以 keyword_complete=true 记录筛选证据。Agent 自主打开候选详情并调用 capture_detail；单个详情不可访问就跳过继续。完成后调用 finalize。",
    ].join("\n");
  }
  if (result?.status === "recoverable") {
    return [
      `YPSCAN_FLOW_DIRECTIVE=手扒当前步骤可恢复（${result?.page_state ?? result?.error?.code ?? "页面状态变化"}）。不得停下或询问用户。`,
      result?.recovery_hint ??
        "重新观察整个页面，使用宿主原生 Browser 关闭普通弹窗、处理重定向、返回达人广场或重新打开目标详情，然后重试当前只读采集。",
      "不要重复同一种无效操作；可换用文字点击、悬停后点击、键盘或重新导航。只有全局登录或全局验证码才请求用户处理。",
    ].join("\n");
  }
  if (result?.status === "list_captured") {
    return [
      `YPSCAN_FLOW_DIRECTIVE=当前结果页已保存：关键词=${result?.keyword ?? "未知"}，页码=${result?.page_number ?? "未知"}，本页=${result?.page_candidate_count ?? 0}，累计去重=${result?.candidate_count ?? 0}。`,
      result?.keyword_complete
        ? "当前关键词已完成。若目标人数不足，使用原生 Browser 只替换下一个关键词并继续；否则自主进入详情复核。"
        : "继续由原生 Browser 翻页或判断当前关键词是否完成；不要等待固定 next_call。",
    ].join("\n");
  }
  if (["detail_captured", "detail_skipped"].includes(result?.status)) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=当前达人详情已${result.status === "detail_skipped" ? "记录为不可访问" : "保存"}。`,
      "关闭或返回当前详情，继续用原生 Browser 处理下一位达人；单个详情失败、字段缺失或局部验证码不得终止整批任务。全局验证码阻止所有详情时才请求用户。",
    ].join("\n");
  }
  if (result?.operation === "create_submission") {
    const submissionPath = firstString(result?.submission_path, result?.artifact?.submission_path);
    if (!submissionPath) return flowPauseDirective("手扒提报表生成", message);
    return [
      "YPSCAN_FLOW_DIRECTIVE=手扒本地提报表已生成。该文件只包含本轮最终复核纳入达人，不属于 Provider 机构数据。",
      `MANUAL_SUBMISSION_LOCAL_PATH=${submissionPath}`,
      "必须把上面的真实绝对路径和最终行数原样展示给用户，然后结束；不得调用 rank_creators、create_submission_batch 或上传合并。",
    ].join("\n");
  }
  if (isRecord(result?.next_call)) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 当前增量阶段=${result?.status ?? "未知"}。`,
      `YPSCAN_NEXT_CALL=${JSON.stringify(result.next_call)}`,
      "当前工具只完成了一次只读采集；下一步必须原样调用 next_call，不得提前交付或让抓取工具自行导航。",
    ].join("\n");
  }
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
  const listHardPassCount = Number.isFinite(result?.list_hard_pass_candidate_count)
    ? result.list_hard_pass_candidate_count
    : null;
  const listHardRejectedCount = Number.isFinite(result?.list_hard_rejected_candidate_count)
    ? result.list_hard_rejected_candidate_count
    : null;
  const listHardPendingCount = Number.isFinite(result?.list_hard_pending_candidate_count)
    ? result.list_hard_pending_candidate_count
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
    `筛选统计：目标 ${targetCount ?? "未知"}，报价区间初筛通过 ${eligibleCount ?? "未知"}，报价淘汰 ${rejectedCount ?? "未知"}，报价待补证 ${needsReviewCount ?? "未知"}；列表硬条件通过 ${listHardPassCount ?? "未知"}，列表硬条件淘汰 ${listHardRejectedCount ?? "未知"}，列表待补证 ${listHardPendingCount ?? "未知"}；最终缺口 ${deliveryShortfall ?? "未知"}。`,
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
  if ((reviewRemaining ?? 0) === 0 && excelPath) {
    const providerPlatform =
      result?.platform === "xingtu"
        ? "douyin"
        : result?.platform === "pgy"
          ? "xiaohongshu"
          : result?.platform;
    const requirementId = firstString(result?.requirement_id);
    const runId = firstString(result?.artifact?.run_id, result?.run_id);
    if (requirementId && providerPlatform && runId) {
      lines.push(
        "手扒 Excel 展示后必须立即逐字调用下面的 AskUserQuestion，不得直接停止。",
        `FIELD_SELECTION_ARGS=${JSON.stringify({
          requirement_id: requirementId,
          platform: providerPlatform,
        })}`,
        `MANUAL_SUBMISSION_ARGS=${JSON.stringify({
          operation: "create_submission",
          requirement_id: requirementId,
          platform: result.platform,
          run_id: runId,
        })}`,
        `ASK_USER_QUESTION_ARGS=${JSON.stringify(
          askQuestion(
            "手扒后续",
            [
              "人工拓展已完成。",
              `目标达人：${targetCount ?? "未知"} 人`,
              `最终名单：${targetRowCount ?? "未知"} 人`,
              `当前缺口：${deliveryShortfall ?? "未知"} 人`,
              "请选择继续询价或直接生成本地提报表。",
            ].join("\n"),
            [
              { label: "继续询价", description: "先选择询价字段，再确认消息和机构列表" },
              { label: "直接生成提报表", description: "使用本轮最终名单生成独立本地提报表" },
            ],
          ),
        )}`,
      );
    }
  }
  return lines.join("\n");
}

function flowDirective(toolName, message, params = {}) {
  const normalizedName = toolName.toLowerCase();
  const bare = stripHostPrefix(normalizedName);
  const result = parsedToolResult(message);
  if (bare === "select_inquiry_form_fields") {
    return fieldSelectionDirective(message);
  }
  if (/(?:^|__)ypscan_save_excel_artifact$/iu.test(normalizedName)) {
    return excelArtifactSaveDirective(message, params);
  }
  if (/(?:^|__)ypscan_select_cascade$/iu.test(normalizedName)) {
    return cascadeSelectionDirective(message);
  }
  if (bare === "create_with_distributions") return distributionDirective(message);
  if (bare === "sync_mcn_inquiry_status") return syncInquiryDirective(message);
  if (bare === "ingest_mcn_submissions") return ingestSubmissionsDirective(message, params);
  if (bare === "rank_creators") return rankCreatorsDirective(message, params);
  if (bare === "create_submission_batch") return submissionBatchDirective(message, params);
  if (bare === "get_workflow_state") return workflowStateDirective(message);
  if (result?.success !== true) {
    if (
      /(?:^|__)ypscan_parse_requirement$/iu.test(normalizedName) &&
      result?.error?.code === "YPSCAN_REQUIREMENT_INVALID"
    ) {
      return requirementInputRepairDirective(message);
    }
    if (/(?:^|__)ypscan_manual_research$/iu.test(normalizedName)) {
      if (params?.operation === "create_submission") {
        return flowPauseDirective("手扒提报表生成", message);
      }
      return manualResearchDirective(message);
    }
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
  if (bare === "validate_requirement") {
    return "YPSCAN_FLOW_DIRECTIVE=validate_requirement 成功。下一步固定调用 search_creators；保持真实 requirement_id 和 platform，不调用 Browser 或直接结束。";
  }
  if (bare === "search_creators") {
    return searchCreatorsDirective(message, params);
  }
  if (bare === "rank_mcns") return rankMcnsDirective(message);
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

function selectedLabel(result, expectedLabel) {
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
      candidate === expectedLabel ||
      new RegExp(`[:：]\\s*${expectedLabel}$`, "u").test(candidate)
    ) {
      return expectedLabel;
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

function messageConfirmationQuestion(challengeId, params) {
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
        header: "确认询价消息",
        question: [
          `[悦普识星 询价确认 ${challengeId}] 企微尚未发送。`,
          `需求：${requirement}`,
          `拟发送机构：${recipients} 家机构`,
          "请先确认完整询价消息：",
          message,
          "本次只确认消息内容；下一步仍需单独确认机构列表。",
        ].join("\n"),
        options: [
          { label: MESSAGE_CONFIRM_LABEL, description: "消息无误，继续确认发送机构" },
          { label: CANCEL_LABEL, description: "不执行该操作" },
        ],
        multiSelect: false,
      },
    ],
  };
}

function recipientConfirmationQuestion(challenge, supplierNames = new Map()) {
  const supplierIds = Array.isArray(challenge?.params?.supplierIds)
    ? challenge.params.supplierIds
    : [];
  const recipients = supplierIds.map((supplierId, index) => {
    const name = supplierNames.get(supplierId) ?? "名称未知";
    return `${index + 1}. ${name}（${supplierId}）`;
  });
  return {
    questions: [
      {
        header: "确认发送机构",
        question: [
          `[悦普识星 询价确认 ${challenge.id}] 企微尚未发送，询价消息已确认。`,
          `即将发送给 ${supplierIds.length} 家机构：`,
          ...recipients,
          "确认仅授权以上消息和机构列表的一次发送，10 分钟内有效。",
        ].join("\n"),
        options: [
          { label: RECIPIENT_CONFIRM_LABEL, description: "确认向以上机构发送一次" },
          { label: CANCEL_LABEL, description: "不执行该操作" },
        ],
        multiSelect: false,
      },
    ],
  };
}

function normalizedManualConfirmation(value) {
  if (!nonemptyString(value)) return null;
  return value
    .trim()
    .replace(/[。.!！?？]+$/u, "")
    .trim();
}

function currentUserReply(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const current = [...messages].reverse().find((message) => message?.role === "user");
  let value = current ? messageText(current) : firstString(event?.prompt);
  if (!nonemptyString(value)) return null;
  const marker = value.lastIndexOf("[Current user request]");
  if (marker >= 0) value = value.slice(marker + "[Current user request]".length);
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return normalizedManualConfirmation(lines.at(-1));
}

/** Register the only business gate: two confirmations before one WeCom send. */
export function registerWecomConfirmationOnlyHooks(api, { now = Date.now } = {}) {
  const challenges = new Map();
  const rankedSuppliers = new Map();
  const startupScopes = new Set();

  const prune = (callNow) => {
    for (const [challengeId, challenge] of challenges) {
      if (callNow - challenge.createdAt > GRANT_TTL_MS || challenge.consumed) {
        challenges.delete(challengeId);
      }
    }
    for (const [requirementId, ranked] of rankedSuppliers) {
      if (callNow - ranked.createdAt > GRANT_TTL_MS) rankedSuppliers.delete(requirementId);
    }
  };

  const supplierNamesFor = (params, scope) => {
    const requirementId = firstString(params?.requirement_id, params?.id);
    const ranked = requirementId ? rankedSuppliers.get(requirementId) : null;
    return ranked?.scope === scope ? ranked.names : new Map();
  };

  const pendingForScope = (scope) =>
    [...challenges.values()].filter(
      (challenge) =>
        !challenge.consumed &&
        challenge.scope === scope &&
        ["message_pending", "recipients_pending"].includes(challenge.stage),
    );

  api.on(
    "before_tool_call",
    async (event, context) => {
      const callNow = now();
      prune(callNow);
      const toolName = firstString(event?.toolName, event?.name) ?? "";
      const normalizedName = toolName.toLowerCase();
      const params = normalizeToolCallParams(normalizedName, paramsFromEvent(event));
      const bare = stripHostPrefix(normalizedName);

      if (bare === "create_with_distributions") {
        const key = inquiryFingerprint(params);
        const scope = scopeKey(event, context);
        const challenge = [...challenges.values()].find(
          (challenge) =>
            !challenge.consumed &&
            challenge.fingerprint === key &&
            challenge.scope === scope &&
            callNow - challenge.createdAt <= GRANT_TTL_MS,
        );
        if (challenge?.stage === "authorized") {
          challenge.consumed = true;
          return undefined;
        }
        const active = challenge ?? {
          id: newId("wc"),
          fingerprint: key,
          createdAt: callNow,
          consumed: false,
          scope,
          stage: "message_pending",
          params,
        };
        challenges.set(active.id, active);
        const askUserQuestion =
          active.stage === "recipients_pending"
            ? recipientConfirmationQuestion(active, supplierNamesFor(params, scope))
            : messageConfirmationQuestion(active.id, params);
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
            `HITL_REQUIRED: 【企微状态：本次未发送｜等待${active.stage === "recipients_pending" ? "机构列表" : "询价消息"}确认】`,
            `YPSCAN_BLOCK_DIRECTIVE=${JSON.stringify(recoveryDirective)}`,
            "ASK_USER_QUESTION_REQUIRED: 必须立即调用宿主 AskUserQuestion，逐字使用下一行 JSON 参数；不得改写问题或用普通文本代替。用户确认后原样重试。",
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
      const scope = scopeKey(event, context);
      const reply = currentUserReply(event);
      const scopedPending = pendingForScope(scope);
      const challenge = scopedPending.length === 1 ? scopedPending[0] : null;
      const lines = [];
      if (challenge && reply === MESSAGE_CONFIRM_LABEL && challenge.stage === "message_pending") {
        challenge.stage = "recipients_pending";
        const question = recipientConfirmationQuestion(
          challenge,
          supplierNamesFor(challenge.params, scope),
        );
        lines.push(
          "YPSCAN_CONFIRMATION_DIRECTIVE=询价消息已由用户固定确认词确认，但企微仍未发送。立即逐字调用下面的 AskUserQuestion 确认机构列表，不得先调用发送工具。",
          `ASK_USER_QUESTION_ARGS=${JSON.stringify(question)}`,
        );
      } else if (
        challenge &&
        reply === RECIPIENT_CONFIRM_LABEL &&
        challenge.stage === "recipients_pending"
      ) {
        challenge.stage = "authorized";
        lines.push(
          "YPSCAN_CONFIRMATION_DIRECTIVE=机构列表已由用户固定确认词确认。现在原样调用 create_with_distributions 一次，不得修改任何参数。",
          `CREATE_WITH_DISTRIBUTIONS_ARGS=${JSON.stringify(challenge.params)}`,
        );
      }

      if (!startupScopes.has(scope)) {
        startupScopes.add(scope);
        lines.push(
          "[YPscan startup instruction]",
          "工具能力只看宿主完整名称中最后一个 __ 后的实际工具名；包括 test 在内的前缀只是命名空间，不代表测试、旁路或不可用于正式链路。单一匹配时直接调用宿主展示的完整名称；只有多个可用工具映射到同一实际名称时才调用 AskUserQuestion 请用户选择；没有匹配时才报告工具未开放。",
          "固定业务顺序：ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns → 完整 MCN Markdown 表格 → 本地路径 → 逐字调用 ASK_USER_QUESTION_ARGS；此处保存类型固定为 creator_preview。询价分支固定为 select_inquiry_form_fields → 用户提交并回复“好了” → 保留原需求全部信息撰写询价消息 → create_with_distributions 的消息确认和机构确认 → 发送后询问是否继续人工拓展。用户后续说“填好了/已回收/生成表格”时固定执行 sync_mcn_inquiry_status → ingest_mcn_submissions → ypscan_save_excel_artifact(mcn_creator_preview) → rank_creators → create_submission_batch → ypscan_save_excel_artifact(submission_batch)，中间不得停。create_with_distributions 是唯一企微发送工具；create_submission_batch 只生成提报表，绝不用于发送企微。get_workflow_state 仅用于诊断，其 allowed_actions 不替代本固定链路。",
          "search_creators 返回精确 SAVE_EXCEL_ARTIFACT_ARGS 时立即调用保存工具，不向用户输出 creators_export_path 或 Excel 下载链接；保存成功后再调用 rank_mcns。rank_mcns 弹窗只放整体总结，本地路径不得放进弹窗 question。",
          "rank_mcns 后先把完整 MCN Markdown 表格作为用户可见正文文本块写出，再展示真实路径并逐字调用工具结果给出的 AskUserQuestion，不得改写弹窗参数。人工拓展完成后必须询问“继续询价”或“直接生成提报表”；后者调用 ypscan_manual_research(operation=create_submission)。人工拓展先调用 ypscan_manual_research(operation=start)，随后由 Agent 使用宿主原生 Browser 自主操作页面，并用 capture_list/capture_detail 只读落盘；不使用 selection_id、observation_id、element_id、固定 next_call 或三个旧 Browser 编排工具。原生 Browser 不能稳定完成级联选择时才调用 ypscan_select_cascade，参数由 Agent 根据当前页面动态决定。首关键词先建立硬筛且关键词最后提交，后续关键词继承筛选集只换关键词；任何前缀的 manual_source_creators 都不得调用。",
          "只有确实需要用户澄清、选择、登录/验证码、暂停或结束时才调用 AskUserQuestion；普通 UI/参数问题的一次有界自动重试不调用。正常成功交付不追加完成弹窗。",
          "需求解析性能约束：普通 fact 只传 kind/quote/value；抖音 60s+ 必须表达为 content_format=video 和 video_duration=duration_l3（工具也会从同一明确 quote 安全补齐）；女粉偏多、城市集中等无精确数值或主体不明的条件保留为 soft/preferred_content 或 external_condition，禁止猜数值。品牌、数量、截止时间等必填业务信息缺失时才向用户澄清。YPSCAN_REQUIREMENT_INVALID 是 Agent 参数构造错误，必须一次性修正全部 violations，最多自动重试一次。",
          "用户选择人工拓展后，start 必须保留完整硬条件 facts。Agent 每次先用宿主原生 Browser 观察整个页面，再自主处理错页、重定向、普通弹窗、筛选、分页和详情。级联项根据需求事实与当前可见控件动态匹配；原生 Browser 无法稳定悬停展开时调用 ypscan_select_cascade，由它只负责逐层 hover/click 和提交回读。助手失败最多调整参数再试一次，仍失败则转入详情硬复核。普通失败更换交互方式或跳过单个达人继续，只有登录失效、全局 CAPTCHA 或 Browser 完全不可用才请求用户接管。",
          "人工拓展的 creator_count 使用用户最新指定的本轮交付数并覆盖原需求总量；即使历史轮次声称旧 schema 要求 page_url/original_brief，本轮也先按新版省略，当前验证器再次拒绝时才用当前 URL 与 original_brief='见当前对话原需求' 兼容，禁止复制完整 brief。",
          "手扒达人价格必须从当前 ypscan_parse_requirement.data.facts 复制客户原始 operator 和原始数值；禁止把 Provider 区间或手工计算后的 50%–120% 区间再次传入。除本轮唯一 creator_count 外，不重算价格事实。",
        );
      }
      return lines.length ? { prependContext: lines.join("\n") } : undefined;
    },
    HOOK_OPTIONS,
  );

  api.on(
    "tool_result_persist",
    (event, context) => {
      const toolName = firstString(event?.toolName, event?.name) ?? "";
      const bare = stripHostPrefix(toolName);
      const result = parsedToolResult(event?.message);
      if (bare === "rank_mcns" && result?.success === true) {
        const mcns = Array.isArray(result?.data?.mcns) ? result.data.mcns : [];
        const requirementId = firstString(
          event?.params?.id,
          event?.params?.requirement_id,
          mcns[0]?.requirement_id,
        );
        if (requirementId) {
          rankedSuppliers.set(requirementId, {
            createdAt: now(),
            scope: scopeKey(event, context),
            names: new Map(
              mcns
                .filter((mcn) => nonemptyString(mcn?.supplier_id))
                .map((mcn) => [mcn.supplier_id, firstString(mcn?.agency_name) ?? "名称未知"]),
            ),
          });
        }
      }
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
      const scopedPending = challengeId ? [] : pendingForScope(scopeKey(event, context));
      const challenge = challengeId
        ? challenges.get(challengeId)
        : scopedPending.length === 1
          ? scopedPending[0]
          : null;
      if (!challenge) return;
      const expected =
        challenge.stage === "message_pending" ? MESSAGE_CONFIRM_LABEL : RECIPIENT_CONFIRM_LABEL;
      const selected = selectedLabel(result, expected);
      if (selected === expected) {
        challenge.stage =
          challenge.stage === "message_pending" ? "recipients_pending" : "authorized";
      } else {
        challenges.delete(challenge.id);
      }
    },
    HOOK_OPTIONS,
  );

  return {
    resetTransientState() {
      challenges.clear();
      rankedSuppliers.clear();
      startupScopes.clear();
    },
  };
}

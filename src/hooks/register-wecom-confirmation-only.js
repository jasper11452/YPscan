import { fingerprint, firstString, isRecord, newId, nonemptyString } from "../util/hash.js";
import { normalizeToolCallParams, stripHostPrefix } from "../contract/registry.js";

const HOOK_OPTIONS = { priority: 90, timeoutMs: 5000 };
const GRANT_TTL_MS = 10 * 60_000;
const SEND_CONFIRM_LABEL = "确认发送";
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
    "根据每次返回的 violations 和工具 repair 示例一次性修正全部 facts 并继续重试，不限制需求解析工具的调用次数；不要逐字段试探。external_condition 的 value 必须使用 quote 的原文，不得补写“受众/粉丝”等原文没有的主体。只有缺少或冲突的真实业务信息才调用 AskUserQuestion。",
  ].join("\n");
}

const MCN_MARKDOWN_TABLE_HEADER = [
  "| 机构名 | 返点 | 综合分 | 达人数 |",
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
    "用户在选择页提交后，select_inquiry_form_fields 会把所选字段按 requirement ID 持久化到 Provider 数据库；requirement ID 来自 validate_requirement 返回的 data.requirement_id，缺失时兼容 data.id，绝不是 demand_id。不得调用已弃用的 get_selected_inquiry_form_fields，不得查询、重建、转存或把 columns 放入 Agent 上下文；后续 Provider 工具只传当前 schema 要求的业务标识，由后端关联字段。",
    "现在停止业务调用并等待用户完成选择后回复“好了”。收到后保留原需求的全部项目、平台、合作形式、价格、档期、数量、粉丝、返点、内容、画像、城市、CPM 和截止时间，撰写 description 与 wechat_notification_message；不得调用 create_submission_batch。消息准备好后调用 create_with_distributions，由 Hook 在同一次确认中展示机构列表和完整消息。",
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
        { label: "人工拓展并提报", description: "由插件内 Runner 继续筛选并生成 Excel" },
        { label: "结束本次", description: "保留机构表格的空结果并结束本次流程" },
      ]
    : [
        { label: "询价机构", description: "从当前真实 MCN 表格选择机构并继续询价" },
        { label: "人工拓展并提报", description: "由插件内 Runner 继续筛选并生成 Excel" },
      ];
  return [
    "YPSCAN_FLOW_DIRECTIVE=rank_mcns 成功。本 tool result 里的表头只是格式提示，不是用户可见表格。",
    "输出顺序：先把当前响应中的完整 MCN Markdown 表格作为用户可见正文文本块写出，再原样展示此前 ypscan_save_excel_artifact 返回的 CREATOR_PREVIEW_LOCAL_PATH，最后调用 AskUserQuestion。不要输出达人预览表下载链接；表格禁止改成项目符号或编号列表。",
    "用户可见机构结果只显示这一张四列表格，固定列且不得增减：机构名、返点、综合分、达人数。禁止在表格内外另行展示排名、supplier_id、候选数、供给倍数、建议 MCN 数、人工拓展数、MCN:人工、推荐理由、风险标签、recommended_action 或其他 rank_mcns 字段与汇总。每行达人数只读取该机构对象自己的 candidate_count 原值，严禁使用累计字段 mcn_covered_creator_count，严禁与前序机构累加，也不得用累计/聚合覆盖字段或相邻行差值替代；保持响应顺序，缺失值写未知，不使用历史值补齐。",
    "AskUserQuestion 不得成为 rank_mcns 后的第一个 assistant block；表格不得放入弹窗 question，本地 file_path 不得放入弹窗 question，也不得在 AskUserQuestion 返回后补发。若本轮 search_creators 确实未返回 creators_export_path 或精确保存参数，必须如实说明无法保存，禁止编造或复用历史链接。",
    "人工拓展并提报 = 直接调用 ypscan_manual_research(operation=start)，传当前 requirement_id、platform、完整 facts 和 1–4 个关键词。插件内专用持久 Chrome 会自行筛选、降级、分页并生成 Excel；不得调用 Browser、Bash、Playwright CLI 或旧 capture/selection 工具，任何前缀的 manual_source_creators 都不得调用。",
    "start 返回 complete/partial/empty/failed_with_artifact 时立即展示真实 Excel 路径和候选/缺口；needs_user_action 时先展示当前 Excel，再用返回的 resume_args 在用户处理登录或验证码后继续。",
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

function distributionDirective(message) {
  const result = parsedToolResult(message);
  if (result?.success !== true) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=create_with_distributions 未确认成功。企微属于外发副作用，禁止盲目重发。先用当前 requirement_id/project_id 调用 sync_mcn_inquiry_status 核对；只有确认未创建发送记录后才能重新发起发送确认。",
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
    "YPSCAN_FLOW_DIRECTIVE=ingest_mcn_submissions 仅创建了异步入库任务，尚未返回最终机构达人预览表。下一步立即逐字使用 GET_INGEST_JOB_ARGS 调用 get_ingest_job，不得保存本次响应、调用 rank_creators 或在此停下。",
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
      "YPSCAN_FLOW_DIRECTIVE=get_ingest_job 异步入库完成并返回 Excel。先把 MCN_CREATOR_PREVIEW_URL 中的原始 URL 直接输出为单独一行用户可见正文，再立即逐字调用 ypscan_save_excel_artifact 保存为机构达人预览表；保存成功后继续 rank_creators。不得改写链接或用 Markdown 包装。",
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
      "YPSCAN_FLOW_DIRECTIVE=get_ingest_job 尚未成功返回完整 Excel 结果。继续使用同一个 job_id 调用 get_ingest_job；这是异步轮询，不调用 AskUserQuestion、不重新执行 ingest_mcn_submissions，也不得猜测或更换 job_id。单轮最多查询 10 次。",
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
    "企微发送只使用 create_with_distributions；提报表只在 ingest_mcn_submissions → get_ingest_job → rank_creators 完成后使用 create_submission_batch。",
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
            "用户选择“补充更新达人信息”即已明确授权补全：下一步固定调用 get_creator_detail，再用 get_creator_detail_export 轮询结果；不得调用 select_inquiry_form_fields、提供字段调整分支或再次追问要补充什么。",
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
  if (["YPSCAN_MANUAL_SELECTION_REQUIRED", "YPSCAN_MANUAL_SELECTION_STALE"].includes(code)) {
    return [
      "YPSCAN_FLOW_DIRECTIVE=收到已下线的旧筛选/collect 协议结果，当前公开流程尚未创建 Playwright CLI 运行。",
      "重新调用 ypscan_manual_research(operation=start)，传当前 requirement_id、platform、完整 facts 和 1–4 个 keywords；不得调用旧筛选工具或继续使用 selection_id。",
    ].join("\n");
  }
  if (!loginOrCaptcha) {
    return [
      `YPSCAN_FLOW_DIRECTIVE=ypscan_manual_research 硬失败（${code}）。不得调用 Browser、Bash、Playwright CLI 或旧 capture 操作。`,
      "仅当 artifact.excel_path 存在时展示当前诊断 Excel；否则如实说明初始产物创建失败，并根据错误修正参数或工作区后重新 start。",
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
  const status = result?.status;
  const operation = result?.operation;
  const runnerExcelPath = firstString(result?.artifact?.excel_path);
  if (["start", "resume"].includes(operation)) {
    if (["needs_user_action", "busy"].includes(status)) {
      const resumeArgs = isRecord(result?.resume_args) ? result.resume_args : null;
      return [
        `YPSCAN_FLOW_DIRECTIVE=插件内手扒 Runner 当前状态=${status}。浏览器动作由插件负责，禁止调用 Browser、Bash 或 Playwright CLI。`,
        ...(runnerExcelPath
          ? [`MANUAL_RESEARCH_EXCEL_PATH=${runnerExcelPath}`, "先向用户展示当前状态 Excel 的真实绝对路径。"]
          : []),
        ...(resumeArgs ? [`MANUAL_RESEARCH_RESUME_ARGS=${JSON.stringify(resumeArgs)}`] : []),
        `ASK_USER_QUESTION_ARGS=${JSON.stringify(
          askQuestion("手扒恢复", status === "busy" ? "专用浏览器正被另一运行占用。" : "请在手扒专用浏览器完成登录或安全验证。", [
            { label: "已处理，继续", description: "使用当前 run 继续插件内手扒" },
            { label: "结束本次", description: "保留当前状态 Excel 并结束" },
          ]),
        )}`,
      ].join("\n");
    }
    if (["complete", "partial", "empty", "failed_with_artifact"].includes(status)) {
      return [
        `YPSCAN_FLOW_DIRECTIVE=插件内手扒 Runner 已终止：状态=${status}，质量=${result?.quality_level ?? "未知"}。不得调用 Browser、Bash、Playwright CLI、capture_list、capture_detail 或 finalize。`,
        `候选池=${result?.candidate_count ?? 0}，缺口=${result?.delivery_shortfall ?? "未知"}。未复核候选只属于“候选达人”，不得表述为最终推荐。`,
        ...(runnerExcelPath
          ? [`MANUAL_RESEARCH_EXCEL_PATH=${runnerExcelPath}`, "必须向用户原样展示上面的 Excel 绝对路径；该候选产物已满足本次产物优先任务。"]
          : ["没有真实 artifact.excel_path，必须如实说明产物写入失败。"]),
        "详情语义复核、直接生成提报表和继续询价都是可选后续，不得为了完成手扒而强制继续。",
      ].join("\n");
    }
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
  const lines = [
    `YPSCAN_FLOW_DIRECTIVE=手扒复核已写回；剩余=${reviewRemaining ?? "未知"}。不得调用 Browser、Bash、Playwright CLI 或旧 capture 操作。`,
    "复核是候选产物交付后的可选步骤；未复核或未纳入的候选不得表述为最终推荐。",
  ];
  if (excelPath) {
    lines.push(
      `MANUAL_RESEARCH_EXCEL_PATH=${excelPath}`,
      "必须把上面的 Excel 绝对路径原样作为主要交付展示给用户；该本地文件不消耗平台导出额度。",
    );
  } else {
    lines.push("本次没有可交付的 artifact.excel_path，必须如实说明文件未生成，禁止编造路径。");
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
  if (/(?:^|__)ypscan_set_filter_range$/iu.test(normalizedName)) {
    return filterRangeDirective(message);
  }
  if (bare === "create_with_distributions") return distributionDirective(message);
  if (bare === "sync_mcn_inquiry_status") return syncInquiryDirective(message);
  if (bare === "ingest_mcn_submissions") return ingestSubmissionsDirective(message);
  if (bare === "get_ingest_job") return getIngestJobDirective(message, params);
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
        "VALIDATE_REQUIREMENT_ARGS 是编译后的完整落库参数。调用 validate_requirement 时必须把它整体作为顶层参数传入，不得手工重建、增删字段或重算区间；createdAt/updatedAt 由 Provider 自动填写，不要补传。",
        `VALIDATE_REQUIREMENT_ARGS=${JSON.stringify(jobs[0].params)}`,
      );
    } else {
      lines.push(
        "多个搜索分组时按顺序为每个 search_jobs[i].params 调用一次 validate_requirement；每次都必须整体透传该 job 的完整 params，createdAt/updatedAt 由 Provider 自动填写，不要补传。",
      );
    }
    return lines.join("\n");
  }
  if (bare === "validate_requirement") {
    const requirementId = firstString(result?.data?.requirement_id, result?.data?.id);
    if (!requirementId) return flowPauseDirective("validate_requirement", message);
    return [
      "YPSCAN_FLOW_DIRECTIVE=validate_requirement 成功。下一步立即逐字使用 SEARCH_CREATORS_ARGS 调用 search_creators，不调用 Browser 或直接结束。",
      "需求 ID 始终指 requirement ID：优先使用本次落库返回的 data.requirement_id，该字段缺失时兼容 data.id；search_creators.id 严禁使用 data.demand_id。",
      `SEARCH_CREATORS_ARGS=${JSON.stringify({ id: requirementId })}`,
    ].join("\n");
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

function sendConfirmationQuestion(challenge, supplierNames = new Map()) {
  const supplierIds = Array.isArray(challenge?.params?.supplierIds)
    ? challenge.params.supplierIds
    : [];
  const recipients = supplierIds.map((supplierId, index) => {
    const name = supplierNames.get(supplierId) ?? "名称未知";
    return `${index + 1}. ${name}（${supplierId}）`;
  });
  const requirement = nonemptyString(challenge?.params?.requirement_id)
    ? challenge.params.requirement_id.trim()
    : "未提供";
  const message = nonemptyString(challenge?.params?.wechat_notification_message)
    ? challenge.params.wechat_notification_message
    : "（未提供企微正文）";
  return {
    questions: [
      {
        header: "确认企微发送",
        question: [
          `[悦普识星 询价确认 ${challenge.id}] 企微尚未发送。`,
          `需求：${requirement}`,
          `即将发送给 ${supplierIds.length} 家机构：`,
          ...recipients,
          "即将发送的消息内容：",
          message,
          "确认仅授权以上机构列表和消息内容的一次发送，10 分钟内有效。",
        ].join("\n"),
        options: [
          { label: SEND_CONFIRM_LABEL, description: "确认向以上机构发送一次" },
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

/** Register the only business gate: one confirmation before one WeCom send. */
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
        !challenge.consumed && challenge.scope === scope && challenge.stage === "pending",
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
          stage: "pending",
          params,
        };
        challenges.set(active.id, active);
        const askUserQuestion = sendConfirmationQuestion(active, supplierNamesFor(params, scope));
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
            "HITL_REQUIRED: 【企微状态：本次未发送｜等待发送确认】",
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
      if (challenge && reply === SEND_CONFIRM_LABEL && challenge.stage === "pending") {
        challenge.stage = "authorized";
        lines.push(
          "YPSCAN_CONFIRMATION_DIRECTIVE=机构列表和消息内容已由用户固定确认词确认。现在原样调用 create_with_distributions 一次，不得修改任何参数。",
          `CREATE_WITH_DISTRIBUTIONS_ARGS=${JSON.stringify(challenge.params)}`,
        );
      }

      if (!startupScopes.has(scope)) {
        startupScopes.add(scope);
        lines.push(
          "[YPscan startup instruction]",
          "工具能力只看宿主完整名称中最后一个 __ 后的实际工具名；包括 test 在内的前缀只是命名空间，不代表测试、旁路或不可用于正式链路。单一匹配时直接调用宿主展示的完整名称；只有多个可用工具映射到同一实际名称时才调用 AskUserQuestion 请用户选择；没有匹配时才报告工具未开放。",
          "固定业务顺序：ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns → 完整 MCN Markdown 表格 → 本地路径 → 逐字调用 ASK_USER_QUESTION_ARGS；需求 ID 始终指 requirement ID，优先取 validate_requirement 返回的 data.requirement_id，缺失时兼容 data.id，绝不使用 data.demand_id；search_creators.id 和 rank_mcns.id 都使用这个 requirement ID；此处保存类型固定为 creator_preview。询价分支固定为 select_inquiry_form_fields → 用户提交并回复“好了” → 保留原需求全部信息撰写询价消息 → create_with_distributions 在同一次弹窗确认机构列表和完整消息 → 发送后询问是否继续人工拓展。用户后续说“填好了/已回收/生成表格”时固定执行 sync_mcn_inquiry_status → ingest_mcn_submissions → get_ingest_job（同一 job_id 可重复查询）→ ypscan_save_excel_artifact(mcn_creator_preview) → rank_creators → create_submission_batch → ypscan_save_excel_artifact(submission_batch)，中间不得停。create_with_distributions 是唯一企微发送工具；create_submission_batch 只生成提报表，绝不用于发送企微。get_workflow_state 仅用于诊断，其 allowed_actions 不替代本固定链路。",
          "提报表保存后的“补充更新达人信息”选项唯一映射到 get_creator_detail：用户一旦选择，立即按当前 schema 使用本轮 batch 调用 get_creator_detail，随后调用 get_creator_detail_export 轮询并保存新版表；该选择不是提报字段配置，不得调用 select_inquiry_form_fields，不得提供“达人详情/展示字段”二选一，也不得再次追问补充什么。",
          "search_creators 返回精确 SAVE_EXCEL_ARTIFACT_ARGS 时立即调用保存工具，不向用户输出 creators_export_path 或 Excel 下载链接；保存成功后再调用 rank_mcns。rank_mcns 弹窗只放整体总结，本地路径不得放进弹窗 question。",
          "rank_mcns 后先把完整 MCN Markdown 表格作为用户可见正文文本块写出，再展示真实路径并逐字调用工具结果给出的 AskUserQuestion，不得改写弹窗参数。人工拓展直接调用 ypscan_manual_research(operation=start)，由插件内专用持久 Chrome 完成筛选、降级、分页、详情和 Excel；禁止调用宿主 Browser、Bash、Playwright CLI、selection_id、observation_id、element_id 或旧 capture 操作，任何前缀的 manual_source_creators 都不得调用。",
          "手扒 start/resume 的任何可控终态都先展示真实 artifact.excel_path；needs_user_action 时用户处理专用浏览器后原样调用 resume_args。候选产物交付后，详情复核、直接生成提报表和继续询价均为可选后续。",
          "只有确实需要用户澄清、选择、登录/验证码、暂停或结束时才调用 AskUserQuestion；需求解析按最新 violations 持续修正并重试，不限制调用次数；其他普通 UI/参数问题的一次有界自动重试不调用。正常成功交付不追加完成弹窗。",
          "需求解析性能约束：普通 fact 只传 kind/quote/value；抖音 60s+ 必须表达为 content_format=video 和 video_duration=duration_l3（工具也会从同一明确 quote 安全补齐）；参考达人统一使用 reference_creator，昵称和 http/https 链接可作为两条 fact 或同一 value 数组传入，最终分别透传为 refNickname/refUrl；女粉偏多、城市集中等无精确数值或主体不明的条件保留为 soft/preferred_content 或 external_condition，禁止猜数值。品牌、数量、截止时间等必填业务信息缺失时才向用户澄清。YPSCAN_REQUIREMENT_INVALID 是 Agent 参数构造错误，必须按最新 violations 一次性修正并继续调用需求解析工具，不限制调用次数。",
          "用户选择人工拓展后，start 必须保留完整硬条件 facts 和 1–4 个关键词；页面操作、有限重试与逐级降级全部由插件 Runner 执行，Agent不得自行接管普通页面故障。登录失效或全局 CAPTCHA 才请求用户处理，处理后使用同一 run_id 调用 resume。",
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
      const selected = selectedLabel(result, SEND_CONFIRM_LABEL);
      if (selected === SEND_CONFIRM_LABEL && challenge.stage === "pending") {
        challenge.stage = "authorized";
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

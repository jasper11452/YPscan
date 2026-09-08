import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerFlowDirectiveHooks } from "../src/hooks/register-flow-directives.js";
import { saveArtifact } from "../src/tools/save-artifact.js";

function registeredPlugin() {
  const hooks = new Map();
  const transientState = registerFlowDirectiveHooks({
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
  return { hooks, transientState };
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

function namedArgsFromDirective(text, name) {
  const prefix = `${name}=`;
  const line = text.split("\n").find((item) => item.startsWith(prefix));
  return JSON.parse(line.slice(prefix.length));
}

function canonicalValidateParams(businessMode, quantityTotal = 30) {
  return {
    platform: "douyin",
    brandName: ["测试品牌"],
    projectName: "测试项目",
    quantityTotal,
    submissionDeadlineAt: "2099-08-25 12:00:00",
    rebate: "25%以上",
    followercount: [0, 999999999],
    contentTag: ["科技", "耳机"],
    rawMessagesJson: JSON.stringify({
      original: `抖音项目：测试项目；品牌：测试品牌；定制视频；${quantityTotal}位；单价5万元；返点25%以上；粉丝不限；提报截止2099-08-25 12:00:00；科技耳机方向。`,
      parse_outputs: { dybrandName: ["测试品牌"] },
      business_mode: businessMode,
    }),
    kolOfficialPriceL3: 50000,
  };
}

test("completed empty manual search reviews requirements instead of offering a blind retry", () => {
  const { hooks } = registeredPlugin();
  const payload = {
    success: true,
    data: {
      requirement_id: "req-empty",
      batch_id: 535,
      completed: true,
      selected_count: 0,
      success_count: 0,
      no_more_creators: true,
    },
  };
  const result = hooks.get("tool_result_persist")({
    toolName: "manual_source_creators_status",
    message: toolMessage(payload),
  });
  const text = directiveText(result);
  assert.match(text, /YPSCAN_NEXT_ACTION=REVIEW_EMPTY_MANUAL_SOURCE_RESULT/u);
  assert.match(text, /实际数量为 0/u);
  assert.match(text, /不是放宽/u);
  assert.doesNotMatch(
    text,
    /ASK_USER_QUESTION_ARGS=|SAVE_ARTIFACT_ARGS=|MANUAL_SOURCE_CREATORS_STATUS_ARGS=/u,
  );
  assert.deepEqual(JSON.parse(result.message.content[0].text), payload);

  for (const [response, expected] of [
    [{ ...payload, success: false }, /已暂停/u],
    [
      {
        ...payload,
        data: { ...payload.data, creator_links_csv_url: "https://eshypdata.com/links.csv" },
      },
      /SAVE_ARTIFACT_ARGS=/u,
    ],
    [
      {
        ...payload,
        data: { ...payload.data, excel_file_url: "https://eshypdata.com/result.xlsx" },
      },
      /SAVE_ARTIFACT_ARGS=/u,
    ],
  ]) {
    const other = directiveText(
      hooks.get("tool_result_persist")({
        toolName: "manual_source_creators_status",
        message: toolMessage(response),
      }),
    );
    assert.match(other, expected);
    assert.doesNotMatch(other, /REVIEW_EMPTY_MANUAL_SOURCE_RESULT/u);
  }

  for (const data of [
    { completed: false, selected_count: 0, success_count: 0 },
    { completed: true, success_count: 0 },
    { completed: true, selected_count: 1, success_count: 0 },
    { completed: true, selected_count: 0, success_count: 1 },
  ]) {
    const other = directiveText(
      hooks.get("tool_result_persist")({
        toolName: "manual_source_creators_status",
        message: toolMessage({ success: true, data }),
      }),
    );
    assert.doesNotMatch(other, /REVIEW_EMPTY_MANUAL_SOURCE_RESULT/u);
  }
});

test("business skill has a readable installation path even without a host skill catalog", () => {
  const { hooks } = registeredPlugin();
  const context = { sessionKey: "missing-skill-catalog" };
  for (let turn = 0; turn < 2; turn += 1) {
    const prompt = hooks.get("before_prompt_build")({}, context).prependContext;
    const path = prompt.match(/业务规则文件：(.+?)。首次相关操作/u)?.[1];
    assert.ok(path);
    assert.match(readFileSync(path, "utf8"), /^name: media-assistant$/m);
    assert.match(prompt, /本会话已读则不重复/u);
  }
});

test("parse review distinguishes missing parser output from missing user information", () => {
  const { hooks } = registeredPlugin();
  const text = directiveText(
    hooks.get("tool_result_persist")({
      toolName: "ypscan_parse_requirement",
      message: toolMessage({
        success: true,
        data: { outputs: { rebate: null, followercount: null } },
      }),
    }),
  );
  assert.match(text, /DIFY_MISSING_FIELDS 只表示解析器未输出/u);
  assert.match(text, /25%以上.*\[0\.25,1\]/u);
  assert.match(text, /一次.*过期/u);
});

test("flow hooks register the validate_requirement preflight gate", () => {
  const { hooks } = registeredPlugin();
  assert.deepEqual([...hooks.keys()].sort(), [
    "before_prompt_build",
    "before_tool_call",
    "tool_result_persist",
  ]);
});

test("saved preview emits exact workbook input only for the confirmed platform", () => {
  const { hooks } = registeredPlugin();
  const context = { sessionKey: "preview-workbook-args" };
  const persist = hooks.get("tool_result_persist");
  persist(
    {
      toolName: "validate_requirement",
      params: { platform: "xiaohongshu" },
      message: toolMessage({ success: true, data: { id: "req-preview" } }),
    },
    context,
  );
  const saved = {
    toolName: "ypscan_save_artifact",
    message: toolMessage({
      success: true,
      data: {
        artifact_kind: "mcn_creator_preview",
        artifact_id: "req-preview",
        file_path: "/workspace/preview.xlsx",
      },
    }),
  };
  const text = directiveText(persist(saved, context));
  assert.deepEqual(namedArgsFromDirective(text, "SAVE_CREATOR_LINKS_ARGS"), {
    requirement_id: "req-preview",
    platform: "xiaohongshu",
    preview_file_path: "/workspace/preview.xlsx",
  });
  const unknown = directiveText(registeredPlugin().hooks.get("tool_result_persist")(saved));
  assert.doesNotMatch(unknown, /SAVE_CREATOR_LINKS_ARGS=/u);
  assert.match(unknown, /不猜测 platform/u);
});

test("startup requires a visible recipient and WeCom preview before sending", () => {
  const { hooks } = registeredPlugin();
  const prompt = hooks.get("before_prompt_build")({}, { runId: "recipient-contract" });
  assert.match(prompt.prependContext, /supplierIds 和 supplier_name 始终为数组/u);
  assert.match(prompt.prependContext, /同一 requirement ID、同一平台的 rank_mcns\.data\.mcns/u);
  assert.match(prompt.prependContext, /未命中或无 ID 的原名放 supplier_name/u);
  assert.match(prompt.prependContext, /不模糊匹配或跨轮复用/u);
  assert.doesNotMatch(prompt.prependContext, /单独提名的机构使用 supplier_name/u);
  assert.match(prompt.prependContext, /发送前必须用警示弹窗确认/u);
  assert.match(prompt.prependContext, /恰好两个选项/u);
  assert.match(prompt.prependContext, /不得把机构或消息列为选项/u);
  assert.match(prompt.prependContext, /description 与 wechat_notification_message 内容一致/u);
  assert.match(prompt.prependContext, /完整企微消息/u);
  assert.match(prompt.prependContext, /确认发送/u);
  assert.match(prompt.prependContext, /返回修改/u);
  assert.match(prompt.prependContext, /新 requirement.*select_inquiry_form_fields/u);
  assert.doesNotMatch(
    prompt.prependContext,
    /过去对其他 requirement.*不算当前 requirement 的提交证据/u,
  );
  assert.doesNotMatch(prompt.prependContext, /不同 requirement 的 keyword 差异只能作为线索/u);
  assert.doesNotMatch(prompt.prependContext, /不追加企微发送确认/u);
});

test("Provider matching errors remain visible and forbid a full-payload retry", () => {
  const { hooks } = registeredPlugin();
  const payload = {
    success: false,
    error: {
      code: "SUPPLIER_NAME_AMBIGUOUS",
      message: "未精确匹配库内机构",
      details: {
        supplier_name: "示例文化",
        candidates: [{ supplier_id: "supplier-a", supplier_name: "示例文化传媒" }],
      },
    },
    data: { send_status: { sent_suppliers: [{ supplier_id: "supplier-sent" }] } },
  };
  const original = toolMessage(payload);
  const result = hooks.get("tool_result_persist")({
    toolName: "test__create_with_distributions",
    message: original,
  });

  assert.equal(result.message.content[0], original.content[0]);
  assert.match(result.message.content[0].text, /未精确匹配库内机构/u);
  const directive = directiveText(result);
  assert.match(directive, /原样展示 Provider 状态/u);
  assert.match(directive, /已成功机构不得重新加入，禁止自动重发/u);
  assert.match(directive, /使用 AskUserQuestion 让用户选择/u);
  assert.match(directive, /只传选中的 supplier ID，supplier_name 传 \[\]/u);
});

test("empty recipients require explicit selection instead of inferring top-ranked agencies", () => {
  const { hooks } = registeredPlugin();
  const result = hooks.get("tool_result_persist")({
    toolName: "create_with_distributions",
    params: { requirement_id: "req-empty" },
    message: toolMessage({
      success: false,
      error: {
        code: "INVALID_PAYLOAD",
        message: "supplier_name and supplierIds cannot both be empty",
      },
    }),
  });

  const directive = directiveText(result);
  assert.match(directive, /无收件机构/u);
  assert.match(directive, /回到本轮真实 MCN 的机构选择/u);
  assert.match(directive, /不能按排名自动选或重发空数组/u);
  assert.doesNotMatch(directive, /GET_WORKFLOW_STATE_ARGS=/u);
});

test("non-active project failure stops without calling the deprecated workflow-state tool", () => {
  const { hooks } = registeredPlugin();
  const result = hooks.get("tool_result_persist")({
    toolName: "create_with_distributions",
    params: { requirement_id: "req-status" },
    message: toolMessage({
      success: false,
      project: null,
      distributions: { created: [], skipped: [] },
      errors: [{ field: "status", message: "只有进行中的项目才能创建供应商分发" }],
    }),
  });

  const directive = directiveText(result);
  assert.match(directive, /项目非进行中/u);
  assert.match(directive, /原样展示 Provider 错误并停止本轮发送处理/u);
  assert.doesNotMatch(directive, /get_workflow_state|GET_WORKFLOW_STATE_ARGS=/u);
});

test("get_workflow_state is no longer a fixed-flow directive", () => {
  const { hooks } = registeredPlugin();
  const persist = hooks.get("tool_result_persist");

  const withIds = persist({
    toolName: "get_workflow_state",
    params: { requirement_id: "req-wf" },
    message: toolMessage({
      success: true,
      data: { requirement_id: "req-wf", inquiry_ids: [12, "13", 12] },
    }),
  });
  assert.equal(withIds, undefined);

  const empty = persist({
    toolName: "get_workflow_state",
    params: { requirement_id: "req-wf" },
    message: toolMessage({ success: true, data: { requirement_id: "req-wf", inquiry_ids: [] } }),
  });
  assert.equal(empty, undefined);
});

test("partial success defers candidate resolution instead of asking for manual expansion", () => {
  const { hooks } = registeredPlugin();
  const result = hooks.get("tool_result_persist")({
    toolName: "create_with_distributions",
    message: toolMessage({
      success: true,
      data: {
        send_status: {
          sent_suppliers: [{ supplier_id: "supplier-sent" }],
          failed_suppliers: [{ supplier_name: "示例文化", reason: "ambiguous" }],
        },
      },
    }),
  });

  const directive = directiveText(result);
  assert.match(directive, /成功 1 家，失败 1 家/u);
  assert.match(directive, /不自动重发/u);
  assert.match(directive, /排除本次已成功机构/u);
  assert.doesNotMatch(directive, /ASK_USER_QUESTION_ARGS=/u);
});

test("success without per-supplier evidence remains unknown", () => {
  const { hooks } = registeredPlugin();
  for (const send_status of [undefined, { sent_suppliers: [], failed_suppliers: [] }]) {
    const result = hooks.get("tool_result_persist")({
      toolName: "create_with_distributions",
      message: toolMessage({ success: true, data: { send_status } }),
    });
    const directive = directiveText(result);
    assert.match(directive, /缺少逐机构发送状态/u);
    assert.match(directive, /标为未知/u);
    assert.doesNotMatch(directive, /ASK_USER_QUESTION_ARGS=/u);
  }
});

test("Provider idempotency errors are terminal for the repeated institution", () => {
  const { hooks } = registeredPlugin();
  const result = hooks.get("tool_result_persist")({
    toolName: "create_with_distributions",
    message: toolMessage({
      success: false,
      error: {
        code: "INQUIRY_ALREADY_SENT",
        message: "当前需求已经给此机构发送过询价消息",
      },
    }),
  });

  assert.match(result.message.content[0].text, /当前需求已经给此机构发送过询价消息/u);
  assert.match(directiveText(result), /重复发送则停止/u);
  assert.doesNotMatch(directiveText(result), /发送确认|sync_mcn_inquiry_status/u);
});

// The hard enforcement for these keys is validateRequirementPreflight in
// src/contract/registry.js, pinned by tests/registry.test.mjs
// "validate_requirement preflight blocks a renamed rawMessagesJson original key".
test("parse success pins the rawMessagesJson key contract for validate_requirement", () => {
  const { hooks } = registeredPlugin();
  const directive = directiveText(
    hooks.get("tool_result_persist")({
      toolName: "ypscan_parse_requirement",
      message: toolMessage({ success: true, data: { outputs: { dybrandName: ["测试品牌"] } } }),
    }),
  );

  assert.match(directive, /严格按 validate_requirement 工具卡 rawMessagesJson 契约执行/u);
  assert.match(directive, /禁止写成 original_demand 或 demand/u);
  assert.match(directive, /key 写错会被本地预检当成缺失原文阻断/u);
});

test("parse success requires deadline clock review even when persist omits call arguments", () => {
  const { hooks } = registeredPlugin();
  const original = toolMessage({
    success: true,
    data: {
      outputs: {
        brandName: ["小米"],
        followercount: "[100000,500000]",
        rebate: [0.2, 1],
        kolOfficialPriceL2: [3500, 6000],
        contentTag: ["数码测评", "办公效率"],
      },
    },
  });
  const result = hooks.get("tool_result_persist")({
    toolName: "ypscan_parse_requirement",
    message: original,
  });
  const directive = directiveText(result);

  assert.equal(result.message.content[0], original.content[0]);
  assert.match(directive, /截止时间由 Agent 对照当前完整有效需求和最新澄清复核/u);
  assert.match(directive, /两者均无截止证据须询问/u);
  assert.match(directive, /禁止用旧 requirement、默认值或推测/u);
  assert.match(directive, /只有日期没有具体时刻.*必须澄清/u);
  assert.match(directive, /不得默认 18:00、23:59:59 或其他时刻/u);
  assert.match(directive, /不得宣称“无需补充澄清”/u);
  assert.match(directive, /已有明确小时和分钟.*秒省略时可补 00.*不重复询问/u);
  assert.match(directive, /只解析.*仍须指出缺失时刻.*不得创建需求/u);
});

test("validate_requirement success reuses the business mode recorded by the preflight", () => {
  const { hooks } = registeredPlugin();
  const before = hooks.get("before_tool_call");
  const persist = hooks.get("tool_result_persist");
  const context = { sessionKey: "validate-scope" };
  const requirementId = "a".repeat(32);
  // The persist event omits params, matching the reported production failure.
  const persistResult = () =>
    directiveText(
      persist(
        {
          toolName: "mcp__ypscan__validate_requirement",
          message: toolMessage({ success: true, data: { requirement_id: requirementId } }),
        },
        context,
      ),
    );

  // Without a recorded mode the flow still pauses conservatively.
  assert.match(persistResult(), /缺少 business_mode/u);

  assert.equal(
    before(
      {
        toolName: "mcp__ypscan__validate_requirement",
        params: canonicalValidateParams("手动拓展"),
      },
      context,
    ).block,
    undefined,
  );
  const manual = persistResult();
  assert.doesNotMatch(manual, /已暂停|缺少 business_mode/u);
  assert.match(manual, /业务模式：手动拓展/u);
  assert.deepEqual(namedArgsFromDirective(manual, "SELECT_INQUIRY_FORM_FIELDS_ARGS"), {
    platform: "douyin",
    requirement_id: requirementId,
  });
  assert.match(manual, /字段选择 URL 输出后本轮必须结束并等待/u);
  assert.match(manual, /过去对其他 requirement.*不算当前 requirement 的提交证据/u);
  assert.doesNotMatch(manual, /SEARCH_CREATORS_ARGS=/u);

  assert.equal(
    before(
      {
        toolName: "mcp__ypscan__validate_requirement",
        params: canonicalValidateParams("询价机构"),
      },
      context,
    ).block,
    undefined,
  );
  const inquiry = persistResult();
  assert.doesNotMatch(inquiry, /已暂停|缺少 business_mode/u);
  assert.match(inquiry, /业务模式：询价机构/u);
  assert.deepEqual(namedArgsFromDirective(inquiry, "SEARCH_CREATORS_ARGS"), {
    id: requirementId,
  });
  assert.doesNotMatch(inquiry, /SELECT_INQUIRY_FORM_FIELDS_ARGS=/u);
});

test("recorded business mode stays scoped and never leaks across sessions", () => {
  const { hooks } = registeredPlugin();
  const before = hooks.get("before_tool_call");
  const persist = hooks.get("tool_result_persist");
  const requirementId = "c".repeat(32);
  const validateEvent = { toolName: "mcp__ypscan__validate_requirement" };
  const validateSuccess = toolMessage({ success: true, data: { requirement_id: requirementId } });

  const scopeA = { sessionKey: "mode-scope-a" };
  const scopeB = { sessionKey: "mode-scope-b" };

  assert.equal(
    before({ ...validateEvent, params: canonicalValidateParams("询价机构") }, scopeA).block,
    undefined,
  );
  const inA = directiveText(persist({ ...validateEvent, message: validateSuccess }, scopeA));
  assert.deepEqual(namedArgsFromDirective(inA, "SEARCH_CREATORS_ARGS"), { id: requirementId });

  // scopeB never ran a preflight: it must pause instead of reusing scopeA's mode.
  const inB = directiveText(persist({ ...validateEvent, message: validateSuccess }, scopeB));
  assert.match(inB, /缺少 business_mode/u);
  assert.doesNotMatch(inB, /SEARCH_CREATORS_ARGS=/u);
});

test("quantityTotal stays per requirement and never feeds a later requirement", () => {
  const { hooks } = registeredPlugin();
  const before = hooks.get("before_tool_call");
  const persist = hooks.get("tool_result_persist");
  const context = { sessionKey: "quantity-scope" };
  const reqA = "a".repeat(32);
  const reqB = "b".repeat(32);
  const validateEvent = { toolName: "mcp__ypscan__validate_requirement" };

  for (const [requirementId, quantityTotal] of [
    [reqA, 30],
    [reqB, 10],
  ]) {
    assert.equal(
      before(
        { ...validateEvent, params: canonicalValidateParams("手动拓展", quantityTotal) },
        context,
      ).block,
      undefined,
    );
    persist(
      {
        ...validateEvent,
        params: { quantityTotal },
        message: toolMessage({ success: true, data: { requirement_id: requirementId } }),
      },
      context,
    );
  }

  const manualSource = (requirementId, batchId) =>
    directiveText(
      persist(
        {
          toolName: "manual_source_creators",
          message: toolMessage({
            success: true,
            requirement_id: requirementId,
            data: { batch_id: batchId },
          }),
        },
        context,
      ),
    );

  assert.deepEqual(
    namedArgsFromDirective(manualSource(reqA, 7), "MANUAL_SOURCE_CREATORS_STATUS_ARGS"),
    { requirement_id: reqA, batch_id: 7 },
  );
  assert.match(manualSource(reqA, 7), /MANUAL_SOURCE_TARGET_NUM=90/u);
  assert.deepEqual(
    namedArgsFromDirective(manualSource(reqB, 8), "MANUAL_SOURCE_CREATORS_STATUS_ARGS"),
    { requirement_id: reqB, batch_id: 8 },
  );
  assert.match(manualSource(reqB, 8), /MANUAL_SOURCE_TARGET_NUM=30/u);
});

test("derived creator links CSV records are scoped per requirement", () => {
  const { transientState } = registeredPlugin();
  transientState.recordLinksCsv("req-a", "/tmp/links-a.csv", "/workspace");
  transientState.recordLinksCsv("req-b", "/tmp/links-b.csv", "/workspace");
  assert.deepEqual(transientState.linksCsvPathsFor("req-a"), ["/tmp/links-a.csv"]);
  assert.deepEqual(transientState.linksCsvPathsFor("req-b"), ["/tmp/links-b.csv"]);
  assert.deepEqual(transientState.linksCsvPathsFor("req-other"), []);
});

test("reset only re-enables the per-gateway startup instruction", () => {
  const { hooks, transientState } = registeredPlugin();
  const context = { sessionKey: "reset-startup" };
  assert.ok(hooks.get("before_prompt_build")({}, context));
  assert.doesNotMatch(
    hooks.get("before_prompt_build")({}, context).prependContext,
    /\[YPscan startup instruction\]/u,
  );
  transientState.resetTransientState();
  assert.match(
    hooks.get("before_prompt_build")({}, context).prependContext,
    /\[YPscan startup instruction\]/u,
  );
});

test("business mode instruction is injected on every prompt while the full startup block remains scoped", () => {
  const { hooks } = registeredPlugin();
  const beforePrompt = hooks.get("before_prompt_build");
  const context = { sessionKey: "business-mode-every-prompt" };

  const first = beforePrompt({}, context);
  const second = beforePrompt({}, context);

  assert.match(first.prependContext, /\[YPscan startup instruction\]/u);
  assert.match(first.prependContext, /YPSCAN 业务模式指令/u);
  assert.doesNotMatch(second.prependContext, /\[YPscan startup instruction\]/u);
  assert.match(second.prependContext, /YPSCAN 业务模式指令/u);
});

test("YP Action completion CSV paths are recorded per requirement for upload provenance", () => {
  const { hooks, transientState } = registeredPlugin();
  const context = { sessionKey: "legacy-provenance-test" };
  const persist = (event) => hooks.get("tool_result_persist")(event, context);
  persist({
    toolName: "validate_requirement",
    message: toolMessage({ success: true, data: { requirement_id: "req-track" } }),
  });
  hooks.get("before_tool_call")(
    { toolName: "test__get_douyin_author_business_card", toolCallId: "batch", params: {} },
    context,
  );
  persist({
    toolName: "test__get_douyin_author_business_card",
    toolCallId: "batch",
    message: toolMessage({
      success: true,
      csv_file: "/tmp/batch-1.csv",
      successful_author_ids: ["creator-1"],
    }),
  });
  persist({
    toolName: "test__get_douyin_author_business_card",
    message: toolMessage({ success: false, csv_file: null }),
  });

  assert.deepEqual(transientState.completionCsvPathsFor("req-track"), ["/tmp/batch-1.csv"]);
  assert.deepEqual(transientState.completionCsvPathsFor("req-other"), []);
});

test("host-shaped completion result without a success field still emits success and records the CSV", () => {
  const { hooks, transientState } = registeredPlugin();
  const context = { sessionKey: "host-shape-completion" };
  const persist = (event) => hooks.get("tool_result_persist")(event, context);
  persist({
    toolName: "validate_requirement",
    message: toolMessage({ success: true, data: { requirement_id: "req-host-shape" } }),
  });
  hooks.get("before_tool_call")(
    { toolName: "get_xhs_author_business_card", toolCallId: "batch", params: {} },
    context,
  );
  const text = directiveText(
    persist({
      toolName: "get_xhs_author_business_card",
      toolCallId: "batch",
      message: toolMessage({
        csv_file: "/tmp/host-shape.csv",
        successful_author_ids: ["creator-1", "creator-2"],
        failed_author_ids: [],
      }),
    }),
  );
  assert.match(text, /COMPLETION_CSV_FILE=\/tmp\/host-shape\.csv/u);
  assert.match(text, /SUCCESSFUL_AUTHOR_IDS=\["creator-1","creator-2"\]/u);
  assert.match(text, /FILE_BRIDGE_FLOW=manual_source/u);
  assert.doesNotMatch(text, /已暂停|ASK_USER_QUESTION_ARGS/u);
  assert.deepEqual(transientState.completionCsvPathsFor("req-host-shape"), ["/tmp/host-shape.csv"]);
});

test("native completion directives require the platform login check first", () => {
  const { hooks } = registeredPlugin();
  const context = { sessionKey: "login-check-directive" };
  const persist = (event) => hooks.get("tool_result_persist")(event, context);
  hooks.get("before_tool_call")(
    {
      toolName: "validate_requirement",
      toolCallId: "validate",
      params: canonicalValidateParams("手动拓展"),
    },
    context,
  );
  persist({
    toolName: "validate_requirement",
    toolCallId: "validate",
    message: toolMessage({ success: true, data: { requirement_id: "req-login" } }),
  });

  const statusText = directiveText(
    persist({
      toolName: "manual_source_creators_status",
      message: toolMessage({
        success: true,
        requirement_id: "req-login",
        creator_links_csv_url: "https://eshypdata.com/links.csv",
      }),
    }),
  );
  assert.match(statusText, /AUTH_PREPARE_TOOL=douyin_auth_prepare/u);
  assert.match(statusText, /AUTH_PREPARE_ARGS=\{"action":"ensure"\}/u);
  assert.match(statusText, /不自行打开登录页/u);

  const summaryText = directiveText(
    persist({
      toolName: "ypscan_summarize_manual_scores",
      message: toolMessage({
        success: true,
        data: {
          next_action: "complete_next_batch",
          platform: "xiaohongshu",
          next_author_ids: ["creator-1"],
        },
      }),
    }),
  );
  assert.match(summaryText, /AUTH_PREPARE_TOOL=pgy_auth_prepare/u);
  assert.match(summaryText, /NATIVE_COMPLETION_TOOL=get_xhs_author_business_card/u);
});

test("YP Action completion CSV provenance remains isolated between sessions", () => {
  const { hooks, transientState } = registeredPlugin();
  const persist = hooks.get("tool_result_persist");
  const recordRequirement = (sessionKey, requirementId) =>
    persist(
      {
        toolName: "validate_requirement",
        message: toolMessage({ success: true, data: { requirement_id: requirementId } }),
      },
      { sessionKey },
    );
  recordRequirement("session-a", "req-a");
  recordRequirement("session-b", "req-b");
  hooks.get("before_tool_call")(
    { toolName: "get_xhs_author_business_card", toolCallId: "batch-a", params: {} },
    { sessionKey: "session-a" },
  );
  persist(
    {
      toolName: "get_xhs_author_business_card",
      toolCallId: "batch-a",
      message: toolMessage({ success: true, csv_file: "/tmp/session-a.csv" }),
    },
    { sessionKey: "session-a" },
  );

  assert.deepEqual(transientState.completionCsvPathsFor("req-a"), ["/tmp/session-a.csv"]);
  assert.deepEqual(transientState.completionCsvPathsFor("req-b"), []);
});

test("saved links CSV artifacts are recorded per requirement for upload provenance", () => {
  const { transientState } = registeredPlugin();
  transientState.recordSavedCsvArtifact("manual_creator_links", "req-links", {
    details: { file_path: "/tmp/links.csv" },
  });
  assert.deepEqual(transientState.linksCsvPathsFor("req-links"), ["/tmp/links.csv"]);

  transientState.recordSavedCsvArtifact("mcn_ranking", "req-links", {
    details: { file_path: "/tmp/rank.xlsx" },
  });
  assert.deepEqual(transientState.linksCsvPathsFor("req-links"), ["/tmp/links.csv"]);
});

test("saveArtifact hostToolResult shape registers the links CSV path end-to-end", async (t) => {
  const { transientState } = registeredPlugin();
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-record-links-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

  const result = await saveArtifact(
    {
      artifact_kind: "manual_creator_links",
      artifact_id: "req-e2e",
      file_url: "https://mcp.eshypdata.com/api/download?file_path=links.csv",
    },
    {
      workspaceDir,
      fetchImpl: async () =>
        new Response(Buffer.from("source_record_id,creator_id,url"), { status: 200 }),
      retryDelaysMs: [],
    },
  );

  // 模拟 index.js 的 ypscan_save_artifact execute 调用点：把 saveArtifact 返回的
  // hostToolResult 直接交给 recordSavedCsvArtifact。
  transientState.recordSavedCsvArtifact("manual_creator_links", "req-e2e", result, workspaceDir);

  const filePath = result.details.file_path;
  assert.match(filePath, /links\.csv$/u);
  assert.deepEqual(transientState.linksCsvPathsFor("req-e2e"), [filePath]);
});

test("gateway reset clears upload provenance state", () => {
  const { hooks, transientState } = registeredPlugin();
  const context = { sessionKey: "legacy-provenance-test" };
  const persist = (event) => hooks.get("tool_result_persist")(event, context);
  persist({
    toolName: "validate_requirement",
    message: toolMessage({ success: true, data: { requirement_id: "req-reset" } }),
  });
  hooks.get("before_tool_call")(
    { toolName: "get_xhs_author_business_card", toolCallId: "batch", params: {} },
    context,
  );
  persist({
    toolName: "get_xhs_author_business_card",
    toolCallId: "batch",
    message: toolMessage({ success: true, csv_file: "/tmp/batch.csv" }),
  });
  transientState.recordSavedCsvArtifact("manual_creator_links", "req-reset", {
    details: { file_path: "/tmp/links.csv" },
  });
  assert.equal(transientState.completionCsvPathsFor("req-reset").length, 1);
  assert.equal(transientState.linksCsvPathsFor("req-reset").length, 1);

  transientState.resetTransientState();
  assert.deepEqual(transientState.completionCsvPathsFor("req-reset"), []);
  assert.deepEqual(transientState.linksCsvPathsFor("req-reset"), []);
});

test("host call IDs restore quantity, score and ingest params without persist params", () => {
  const { hooks } = registeredPlugin();
  const context = { sessionKey: "host-contract" };
  const call = (toolName, toolCallId, params, data) => {
    hooks.get("before_tool_call")({ toolName, toolCallId, params }, context);
    return directiveText(
      hooks.get("tool_result_persist")(
        { toolName, toolCallId, message: toolMessage({ success: true, data }) },
        context,
      ),
    );
  };
  call("validate_requirement", "validate", canonicalValidateParams("手动拓展", 42), {
    requirement_id: "req-A",
  });
  assert.match(
    call("manual_source_creators", "manual", { requirement_id: "req-A" }, { batch_id: 9 }),
    /MANUAL_SOURCE_TARGET_NUM=126/u,
  );
  call("score_manual_source_csv", "score", { requirement_id: "req-A" }, { job_id: "score-job" });
  assert.equal(
    namedArgsFromDirective(
      call(
        "score_manual_source_csv_status",
        "status",
        { job_id: "score-job" },
        { job_id: "score-job", excel_file_url: "https://eshypdata.com/final.xlsx" },
      ),
      "SAVE_ARTIFACT_ARGS",
    ).artifact_id,
    "req-A",
  );
  call("sync_mcn_inquiry_status", "sync", { requirement_id: "req-A" }, { inquiry_ids: ["inq-A"] });
  call("ingest_mcn_submissions", "ingest", { inquiry_ids: ["inq-A"] }, { job_id: "ingest-job" });
  assert.equal(
    namedArgsFromDirective(
      call(
        "get_ingest_job",
        "get",
        { job_id: "ingest-job" },
        { status: "succeeded", excel_file_url: "https://eshypdata.com/preview.xlsx" },
      ),
      "SAVE_ARTIFACT_ARGS",
    ).artifact_id,
    "req-A",
  );
});

test("native completion binds invocation requirement and ignores unrelated or failed ids", () => {
  const { hooks, transientState } = registeredPlugin();
  const context = { sessionKey: "completion-contract" };
  const persist = (toolName, data, extra = {}) =>
    hooks.get("tool_result_persist")(
      { toolName, message: toolMessage({ success: true, data }), ...extra },
      context,
    );
  persist("validate_requirement", { requirement_id: "req-A" });
  persist("unrelated_tool", { id: "unrelated" }, { params: { id: "unrelated" } });
  hooks.get("before_tool_call")(
    { toolName: "get_xhs_author_business_card", toolCallId: "completion", params: {} },
    context,
  );
  persist("validate_requirement", { requirement_id: "req-B" });
  persist(
    "get_xhs_author_business_card",
    { csv_file: "/tmp/completion.csv" },
    { toolCallId: "completion" },
  );
  assert.deepEqual(transientState.completionCsvPathsFor("req-A"), ["/tmp/completion.csv"]);
  assert.deepEqual(transientState.completionCsvPathsFor("unrelated"), []);
  persist("get_xhs_author_business_card", { csv_file: "/tmp/unmatched.csv" });
  assert.deepEqual(transientState.completionCsvPathsFor("req-B"), []);
});

test("save preview metadata routes a params-free persist result", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-preview-meta-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const result = await saveArtifact(
    {
      artifact_kind: "mcn_creator_preview",
      artifact_id: "req-preview",
      file_url: "https://eshypdata.com/preview.xlsx",
    },
    { workspaceDir, fetchImpl: async () => new Response("mock workbook") },
  );
  const { hooks } = registeredPlugin();
  const text = directiveText(
    hooks.get("tool_result_persist")({ toolName: "ypscan_save_artifact", message: result }),
  );
  assert.match(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("missing raw messages blocks normally at before_tool_call", () => {
  const { hooks } = registeredPlugin();
  for (const rawMessagesJson of [null, undefined]) {
    const response = hooks.get("before_tool_call")({
      toolName: "validate_requirement",
      params: { ...canonicalValidateParams("询价机构"), rawMessagesJson },
    });
    assert.equal(response.block, true);
    assert.match(response.blockReason, /rawMessagesJson/u);
  }
});

test("pending calls are consumed once and cannot cross sessions or reset", () => {
  const { hooks, transientState } = registeredPlugin();
  const before = hooks.get("before_tool_call");
  const persist = hooks.get("tool_result_persist");
  const a = { sessionKey: "a" },
    b = { sessionKey: "b" };
  const start = () =>
    before(
      {
        toolName: "score_manual_source_csv",
        toolCallId: "same",
        params: { requirement_id: "req-a" },
      },
      a,
    );
  const result = (context, job) =>
    persist(
      {
        toolName: "score_manual_source_csv",
        toolCallId: "same",
        message: toolMessage({ success: true, data: { job_id: job } }),
      },
      context,
    );
  const status = (context, job) =>
    directiveText(
      persist(
        {
          toolName: "score_manual_source_csv_status",
          message: toolMessage({
            success: true,
            data: { job_id: job, excel_file_url: "https://eshypdata.com/final.xlsx" },
          }),
        },
        context,
      ),
    );
  start();
  result(b, "wrong-session");
  result(a, "right");
  result(a, "replay");
  assert.match(status(b, "right"), /缺少 requirement_id/u);
  assert.match(status(a, "right"), /SAVE_ARTIFACT_ARGS=/u);
  assert.match(status(a, "right"), /缺少 requirement_id/u);
  assert.match(status(a, "replay"), /缺少 requirement_id/u);
  start();
  transientState.resetTransientState();
  result(a, "reset");
  assert.match(status(a, "reset"), /缺少 requirement_id/u);
});

test("ingest query errors stop instead of polling the restored job ID", () => {
  const { hooks } = registeredPlugin();
  const context = { sessionKey: "ingest-error" };
  hooks.get("before_tool_call")(
    { toolName: "get_ingest_job", toolCallId: "query", params: { job_id: "missing-job" } },
    context,
  );
  const text = directiveText(
    hooks.get("tool_result_persist")(
      {
        toolName: "get_ingest_job",
        toolCallId: "query",
        message: toolMessage({ success: false, error: { code: "JOB_NOT_FOUND" } }),
      },
      context,
    ),
  );
  assert.doesNotMatch(text, /GET_INGEST_JOB_ARGS=/u);
  assert.match(text, /已暂停/u);
});

test("in-flight status calls retain their requirement after another terminal result", () => {
  for (const [submitTool, statusTool] of [
    ["score_manual_source_csv", "score_manual_source_csv_status"],
    ["ingest_mcn_submissions", "get_ingest_job"],
  ]) {
    const { hooks } = registeredPlugin();
    const context = { sessionKey: statusTool };
    const before = hooks.get("before_tool_call");
    const persist = hooks.get("tool_result_persist");
    before(
      { toolName: submitTool, toolCallId: "submit", params: { requirement_id: "req-A" } },
      context,
    );
    persist(
      {
        toolName: submitTool,
        toolCallId: "submit",
        message: toolMessage({ success: true, data: { job_id: "job-A" } }),
      },
      context,
    );
    for (const toolCallId of ["first", "second"]) {
      before({ toolName: statusTool, toolCallId, params: { job_id: "job-A" } }, context);
    }
    for (const toolCallId of ["first", "second"]) {
      const text = directiveText(
        persist(
          {
            toolName: statusTool,
            toolCallId,
            message: toolMessage({
              success: true,
              data: { job_id: "job-A", excel_file_url: "https://eshypdata.com/final.xlsx" },
            }),
          },
          context,
        ),
      );
      assert.equal(namedArgsFromDirective(text, "SAVE_ARTIFACT_ARGS").artifact_id, "req-A");
    }
  }
});

test("failed business or native results cannot change completion provenance", () => {
  const { hooks, transientState } = registeredPlugin();
  const context = { sessionKey: "failure-provenance" };
  const persist = (toolName, body, toolCallId) =>
    hooks.get("tool_result_persist")({ toolName, toolCallId, message: toolMessage(body) }, context);
  persist("validate_requirement", { success: true, data: { id: "req-good" } });
  persist("validate_requirement", { success: false, data: { id: "req-failed" } });
  for (const [id, success] of [
    ["failed", false],
    ["success", true],
  ]) {
    hooks.get("before_tool_call")(
      { toolName: "get_xhs_author_business_card", toolCallId: id, params: {} },
      context,
    );
    persist("get_xhs_author_business_card", { success, csv_file: `/tmp/${id}.csv` }, id);
  }
  assert.deepEqual(transientState.completionCsvPathsFor("req-good"), ["/tmp/success.csv"]);
  assert.deepEqual(transientState.completionCsvPathsFor("req-failed"), []);
});

test("manual source startup only requests requirement_id and delegates demand to Provider", () => {
  const { hooks } = registeredPlugin();
  const { prependContext } = hooks.get("before_prompt_build")({}, { runId: "provider-demand" });
  assert.match(prependContext, /调用 manual_source_creators 只传 requirement_id/u);
  assert.match(prependContext, /不传 demand、num、解析输出或 rawMessagesJson/u);
  assert.match(prependContext, /需求文本由 Provider 从后台读取/u);
  assert.doesNotMatch(
    prependContext,
    /manual_source_creators\.demand|可选需求原文字段|若 schema required 含 num，则 requirement_id 与 num 一并传/u,
  );
});

test("status polling without requirement history preserves the already tripled num", () => {
  const { hooks } = registeredPlugin();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = hooks.get("tool_result_persist")({
      toolName: "manual_source_creators_status",
      params: { requirement_id: "req-resumed", batch_id: 7, num: 90 },
      message: toolMessage({ success: false, error: { code: "BATCH_NOT_READY" } }),
    });
    assert.match(directiveText(result), /MANUAL_SOURCE_TARGET_NUM=90/u);
  }
});

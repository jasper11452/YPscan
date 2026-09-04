import assert from "node:assert/strict";
import test from "node:test";

import { registerFlowDirectiveHooks } from "../src/hooks/register-flow-directives.js";

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

test("flow hooks register the validate_requirement preflight gate", () => {
  const { hooks } = registeredPlugin();
  assert.deepEqual([...hooks.keys()].sort(), [
    "before_prompt_build",
    "before_tool_call",
    "tool_result_persist",
  ]);
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

test("non-active project failure only triggers a workflow-state diagnostic", () => {
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
  assert.match(directive, /调用一次 get_workflow_state 诊断，不自动重发/u);
  assert.deepEqual(namedArgsFromDirective(directive, "GET_WORKFLOW_STATE_ARGS"), {
    requirement_id: "req-status",
  });
});

test("workflow state routes ingest, sync recovery or pauses by inquiry id presence", () => {
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
  const withIdsText = directiveText(withIds);
  assert.match(withIdsText, /已返回非空 inquiry_ids/u);
  assert.deepEqual(namedArgsFromDirective(withIdsText, "INGEST_MCN_SUBMISSIONS_ARGS"), {
    inquiry_ids: ["12", "13"],
  });
  assert.doesNotMatch(withIdsText, /GET_WORKFLOW_STATE_ARGS=/u);
  assert.doesNotMatch(withIdsText, /ASK_USER_QUESTION_ARGS=/u);

  const fromInquiries = persist({
    toolName: "get_workflow_state",
    params: { requirement_id: "req-wf" },
    message: toolMessage({
      success: true,
      data: { inquiries: [{ inquiry_id: 7 }, { inquiry_id: "8" }] },
    }),
  });
  assert.deepEqual(
    namedArgsFromDirective(directiveText(fromInquiries), "INGEST_MCN_SUBMISSIONS_ARGS"),
    { inquiry_ids: ["7", "8"] },
  );

  const empty = persist({
    toolName: "get_workflow_state",
    params: { requirement_id: "req-wf" },
    message: toolMessage({ success: true, data: { requirement_id: "req-wf", inquiry_ids: [] } }),
  });
  const emptyText = directiveText(empty);
  assert.match(emptyText, /空 inquiry_ids/u);
  assert.match(emptyText, /先调用 sync_mcn_inquiry_status/u);
  assert.match(emptyText, /sync 成功后必须回到 get_workflow_state 取 inquiry_ids/u);
  assert.match(emptyText, /mcn_planning 单独出现不等于可以精排/u);
  assert.deepEqual(namedArgsFromDirective(emptyText, "GET_WORKFLOW_STATE_ARGS"), {
    requirement_id: "req-wf",
  });
  assert.doesNotMatch(emptyText, /INGEST_MCN_SUBMISSIONS_ARGS=/u);

  const unparsable = persist({
    toolName: "get_workflow_state",
    params: { requirement_id: "req-wf" },
    message: toolMessage({
      success: true,
      data: { requirement_id: "req-wf", allowed_actions: ["create_with_distributions"] },
    }),
  });
  const unparsableText = directiveText(unparsable);
  assert.match(unparsableText, /get_workflow_state 已暂停/u);
  assert.deepEqual(
    namedArgsFromDirective(unparsableText, "ASK_USER_QUESTION_ARGS").questions[0].options.map(
      (option) => option.label,
    ),
    ["重试", "结束本次"],
  );
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
  assert.match(manualSource(reqA, 7), /MANUAL_SOURCE_TARGET_NUM=30/u);
  assert.deepEqual(
    namedArgsFromDirective(manualSource(reqB, 8), "MANUAL_SOURCE_CREATORS_STATUS_ARGS"),
    { requirement_id: reqB, batch_id: 8 },
  );
  assert.match(manualSource(reqB, 8), /MANUAL_SOURCE_TARGET_NUM=10/u);
});

test("inquiry ids stay per requirement and never feed a later artifact save", () => {
  const { hooks } = registeredPlugin();
  const persist = hooks.get("tool_result_persist");
  const context = { sessionKey: "inquiry-ids-scope" };
  const reqA = "a".repeat(32);
  const reqB = "b".repeat(32);

  persist(
    {
      toolName: "get_workflow_state",
      message: toolMessage({
        success: true,
        data: { requirement_id: reqA, inquiry_ids: [1, 2] },
      }),
    },
    context,
  );

  const saveLinks = (artifact_id) =>
    directiveText(
      persist(
        {
          toolName: "ypscan_save_csv_artifact",
          params: { artifact_kind: "mcn_creator_links", artifact_id },
          message: toolMessage({
            success: true,
            data: { file_path: "/tmp/links.csv" },
            delivery: { local_file_link: "[links](/tmp/links.csv)" },
          }),
        },
        context,
      ),
    );

  const forA = saveLinks(reqA);
  assert.deepEqual(namedArgsFromDirective(forA, "RANK_CREATORS_ARGS"), {
    requirement_id: reqA,
    inquiry_ids: ["1", "2"],
  });

  const forB = saveLinks(reqB);
  assert.doesNotMatch(forB, /RANK_CREATORS_ARGS=/u);
  assert.deepEqual(namedArgsFromDirective(forB, "GET_WORKFLOW_STATE_ARGS"), {
    requirement_id: reqB,
  });
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

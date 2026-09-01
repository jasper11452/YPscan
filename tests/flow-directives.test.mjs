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

test("workflow-state success keeps the raw diagnostic without a repeated directive", () => {
  const { hooks } = registeredPlugin();
  const message = toolMessage({
    success: true,
    data: { requirement_id: "req-status", allowed_actions: ["create_with_distributions"] },
  });

  assert.equal(
    hooks.get("tool_result_persist")({
      toolName: "get_workflow_state",
      message,
    }),
    undefined,
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
  const validateParams = (businessMode) => ({
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
      business_mode: businessMode,
    }),
    kolOfficialPriceL3: 50000,
  });
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
      { toolName: "mcp__ypscan__validate_requirement", params: validateParams("手动拓展") },
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
      { toolName: "mcp__ypscan__validate_requirement", params: validateParams("询价机构") },
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

test("reset only re-enables the per-gateway startup instruction", () => {
  const { hooks, transientState } = registeredPlugin();
  const context = { sessionKey: "reset-startup" };
  assert.ok(hooks.get("before_prompt_build")({}, context));
  assert.equal(hooks.get("before_prompt_build")({}, context), undefined);
  transientState.resetTransientState();
  assert.ok(hooks.get("before_prompt_build")({}, context));
});

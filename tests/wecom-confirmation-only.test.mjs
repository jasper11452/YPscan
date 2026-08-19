import assert from "node:assert/strict";
import test from "node:test";

import { registerWecomConfirmationOnlyHooks } from "../src/hooks/register-wecom-confirmation-only.js";

function registeredPlugin(now = () => 1) {
  const hooks = new Map();
  const transientState = registerWecomConfirmationOnlyHooks(
    {
      on(name, handler) {
        hooks.set(name, handler);
      },
    },
    { now },
  );
  return { hooks, transientState };
}

function registeredHooks(now = () => 1) {
  return registeredPlugin(now).hooks;
}

const inquiryParams = {
  requirement_id: "req-wecom-only",
  supplierIds: ["supplier-a", "supplier-b"],
  description: "新品询价",
  wechat_notification_message: "您好，请协助反馈本次项目报价。",
};

async function persistRankedSuppliers(hooks, context, mcns = null) {
  await hooks.get("tool_result_persist")(
    {
      toolName: "test__rank_mcns",
      params: { id: inquiryParams.requirement_id },
      message: {
        content: JSON.stringify({
          success: true,
          data: {
            mcns: mcns ?? [
              { supplier_id: "supplier-a", agency_name: "机构甲" },
              { supplier_id: "supplier-b", agency_name: "机构乙" },
            ],
          },
        }),
      },
    },
    context,
  );
}

test("Provider calls remain unrestricted and their params are not rewritten", async () => {
  const hooks = registeredHooks();
  assert.equal(
    await hooks.get("before_tool_call")({ toolName: "ypmcn__rank_creators", params: {} }, {}),
    undefined,
  );

  assert.equal(
    await hooks.get("before_tool_call")(
      {
        toolName: "mcp__ypscan__select_inquiry_form_fields",
        params: { requirement_id: "req-wecom-only", platform: "xiaohongshu" },
      },
      {},
    ),
    undefined,
  );

  assert.equal(
    await hooks.get("before_tool_call")(
      {
        toolName: "test__search_creators",
        params: { id: "req-search-job-a" },
      },
      {},
    ),
    undefined,
  );

  assert.equal(
    await hooks.get("before_tool_call")(
      {
        toolName: "test__rank_mcns",
        params: { id: "req-search-job-b", platform: "douyin" },
      },
      {},
    ),
    undefined,
  );
});

test("WeCom send requires one combined confirmation before one exact send", async () => {
  const hooks = registeredHooks();
  const context = { runId: "run-wecom" };
  await persistRankedSuppliers(hooks, context);
  const blocked = await hooks.get("before_tool_call")(
    {
      toolName: "ypmcn__create_with_distributions",
      toolCallId: "send-first",
      params: inquiryParams,
    },
    context,
  );

  assert.equal(blocked.block, true);
  assert.match(blocked.blockReason, /^HITL_REQUIRED:/u);
  assert.match(blocked.blockReason, /ASK_USER_QUESTION_ARGS=/u);
  assert.match(blocked.blockReason, /YPSCAN_BLOCK_DIRECTIVE=/u);
  assert.equal(blocked.askUserQuestion.questions[0].header, "确认企微发送");
  assert.match(blocked.askUserQuestion.questions[0].question, /2 家机构/u);
  assert.match(blocked.askUserQuestion.questions[0].question, /supplier-a/u);
  assert.match(blocked.askUserQuestion.questions[0].question, /supplier-b/u);
  assert.match(blocked.askUserQuestion.questions[0].question, /您好，请协助反馈本次项目报价/u);
  assert.equal(blocked.askUserQuestion.questions[0].options[0].label, "确认发送");

  await hooks.get("after_tool_call")(
    {
      toolName: "AskUserQuestion",
      params: blocked.askUserQuestion,
      result: { answer: "确认发送" },
    },
    context,
  );

  assert.equal(
    await hooks.get("before_tool_call")(
      {
        toolName: "ypmcn__create_with_distributions",
        toolCallId: "send-confirmed",
        params: inquiryParams,
      },
      context,
    ),
    undefined,
  );

  const secondAttempt = await hooks.get("before_tool_call")(
    {
      toolName: "ypmcn__create_with_distributions",
      toolCallId: "send-again",
      params: inquiryParams,
    },
    context,
  );
  assert.equal(secondAttempt.block, true);
});

test("confirmation rejects changed params and stays scoped to one session", async () => {
  const hooks = registeredHooks();
  const session = { sessionKey: "session-a", runId: "run-a" };
  await persistRankedSuppliers(hooks, session);
  const blocked = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    session,
  );

  await hooks.get("after_tool_call")(
    {
      toolName: "AskUserQuestion",
      params: blocked.askUserQuestion,
      result: { answer: "确认发送" },
    },
    session,
  );

  const changed = await hooks.get("before_tool_call")(
    {
      toolName: "create_with_distributions",
      params: { ...inquiryParams, description: "已改写的需求" },
    },
    session,
  );
  assert.equal(changed.block, true);

  const otherContext = { sessionKey: "session-b", runId: "run-b" };
  await persistRankedSuppliers(hooks, otherContext);
  const otherSession = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    otherContext,
  );
  assert.equal(otherSession.block, true);
  assert.equal(otherSession.askUserQuestion.questions[0].header, "确认企微发送");
});

test("confirmation binds exact params through the single stage", async () => {
  const hooks = registeredHooks();
  const context = { runId: "run-rewritten-question" };
  await persistRankedSuppliers(hooks, context);
  const blocked = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    context,
  );

  await hooks.get("after_tool_call")(
    {
      toolName: "AskUserQuestion",
      params: {
        questions: [
          { ...blocked.askUserQuestion.questions[0], question: "是否确认发送本次询价？" },
        ],
      },
      result: { answer: "确认发送" },
    },
    context,
  );

  assert.equal(
    await hooks.get("before_tool_call")(
      { toolName: "create_with_distributions", params: inquiryParams },
      context,
    ),
    undefined,
  );

  const whitespaceChanged = await hooks.get("before_tool_call")(
    {
      toolName: "create_with_distributions",
      params: {
        ...inquiryParams,
        wechat_notification_message: ` ${inquiryParams.wechat_notification_message}`,
      },
    },
    context,
  );
  assert.equal(whitespaceChanged.block, true);
});

test("test MCP prefixes cannot bypass the WeCom gate", async () => {
  const hooks = registeredHooks();
  const context = { sessionKey: "test-prefix-session" };
  await persistRankedSuppliers(hooks, context);
  const blocked = await hooks.get("before_tool_call")(
    { toolName: "test__create_with_distributions", params: inquiryParams },
    context,
  );
  assert.equal(blocked.block, true);
  assert.equal(blocked.askUserQuestion.questions[0].header, "确认企微发送");
});

test("fixed manual confirmation phrase authorizes the current send", async () => {
  const hooks = registeredHooks();
  const context = { sessionKey: "manual-confirm-session" };
  await persistRankedSuppliers(hooks, context);
  await hooks.get("before_tool_call")(
    { toolName: "test__create_with_distributions", params: inquiryParams },
    context,
  );

  const generic = hooks.get("before_prompt_build")({ prompt: "确认" }, context);
  assert.doesNotMatch(generic.prependContext, /机构列表和消息内容已由用户固定确认词确认/u);
  const confirmed = hooks.get("before_prompt_build")({ prompt: "确认发送。" }, context);
  assert.match(confirmed.prependContext, /原样调用 create_with_distributions/u);
  assert.equal(
    await hooks.get("before_tool_call")(
      { toolName: "test__create_with_distributions", params: inquiryParams },
      context,
    ),
    undefined,
  );
});

test("combined confirmation displays ranked institution names", async () => {
  const hooks = registeredHooks();
  const context = { sessionKey: "ranked-name-session" };
  await persistRankedSuppliers(hooks, context);

  const blocked = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    context,
  );
  assert.match(blocked.askUserQuestion.questions[0].question, /机构甲（supplier-a）/u);
  assert.match(blocked.askUserQuestion.questions[0].question, /机构乙（supplier-b）/u);
});

test("ranked institution names outlive the ten-minute send grant", async () => {
  let clock = 1;
  const hooks = registeredHooks(() => clock);
  const context = { sessionKey: "ranked-name-ttl-session" };
  await persistRankedSuppliers(hooks, context);

  clock += 11 * 60_000;
  const blocked = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    context,
  );

  assert.match(blocked.blockReason, /^HITL_REQUIRED:/u);
  assert.match(blocked.askUserQuestion.questions[0].question, /机构甲（supplier-a）/u);
  assert.doesNotMatch(blocked.askUserQuestion.questions[0].question, /名称未知/u);
});

test("send authorization still expires after ten minutes", async () => {
  let clock = 1;
  const hooks = registeredHooks(() => clock);
  const context = { sessionKey: "send-grant-ttl-session" };
  await persistRankedSuppliers(hooks, context);
  const blocked = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    context,
  );
  await hooks.get("after_tool_call")(
    {
      toolName: "AskUserQuestion",
      params: blocked.askUserQuestion,
      result: { answer: "确认发送" },
    },
    context,
  );

  clock += 10 * 60_000 + 1;
  const expired = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    context,
  );

  assert.match(expired.blockReason, /^HITL_REQUIRED:/u);
  assert.equal(expired.askUserQuestion.questions[0].header, "确认企微发送");
});

test("ranked institution names are isolated by session scope", async () => {
  const hooks = registeredHooks();
  const contextA = { sessionKey: "ranked-scope-a" };
  const contextB = { sessionKey: "ranked-scope-b" };
  await persistRankedSuppliers(hooks, contextA);
  await persistRankedSuppliers(hooks, contextB, [
    { supplier_id: "supplier-a", agency_name: "机构丙" },
    { supplier_id: "supplier-b", agency_name: "机构丁" },
  ]);

  const blockedA = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    contextA,
  );
  const blockedB = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    contextB,
  );

  assert.match(blockedA.askUserQuestion.questions[0].question, /机构甲（supplier-a）/u);
  assert.match(blockedB.askUserQuestion.questions[0].question, /机构丙（supplier-a）/u);
});

test("WeCom send is blocked when any recipient name cannot be verified", async () => {
  const hooks = registeredHooks();
  const context = { sessionKey: "missing-ranked-name-session" };
  await persistRankedSuppliers(hooks, context, [
    { supplier_id: "supplier-a", agency_name: "机构甲" },
    { supplier_id: "supplier-b", agency_name: "" },
  ]);

  const blocked = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    context,
  );

  assert.equal(blocked.block, true);
  assert.match(blocked.blockReason, /^INQUIRY_RECIPIENT_NAME_MISSING:/u);
  assert.match(blocked.blockReason, /supplier-b/u);
  assert.equal(blocked.askUserQuestion, undefined);
  assert.equal(blocked.recoveryDirective.action, "stop");
});

test("WeCom send is blocked after transient name state is lost", async () => {
  const { hooks, transientState } = registeredPlugin();
  const context = { sessionKey: "reset-ranked-name-session" };
  await persistRankedSuppliers(hooks, context);
  transientState.resetTransientState();

  const blocked = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    context,
  );

  assert.match(blocked.blockReason, /^INQUIRY_RECIPIENT_NAME_MISSING:/u);
  assert.equal(blocked.askUserQuestion, undefined);
});

test("startup injects the fixed chain once without requiring a Skill read", () => {
  const hooks = registeredHooks(() => 1);
  const context = { runId: "skill-run" };
  const prompt = hooks.get("before_prompt_build")({}, context);
  assert.doesNotMatch(prompt.prependContext, /read the complete Skill/iu);
  assert.match(
    prompt.prependContext,
    /ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns/u,
  );
  assert.equal(hooks.get("before_prompt_build")({}, context), undefined);
});

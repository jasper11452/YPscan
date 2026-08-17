import assert from "node:assert/strict";
import test from "node:test";

import { registerWecomConfirmationOnlyHooks } from "../src/hooks/register-wecom-confirmation-only.js";

function registeredHooks(now = () => 1, skillPath = null) {
  const hooks = new Map();
  registerWecomConfirmationOnlyHooks(
    {
      on(name, handler) {
        hooks.set(name, handler);
      },
    },
    { now, skillPath },
  );
  return hooks;
}

const inquiryParams = {
  requirement_id: "req-wecom-only",
  supplierIds: ["supplier-a", "supplier-b"],
  description: "新品询价",
  wechat_notification_message: "您好，请协助反馈本次项目报价。",
};

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
});

test("WeCom send requires confirmation and consumes an exact one-shot in-memory grant", async () => {
  const hooks = registeredHooks();
  const context = { runId: "run-wecom" };
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
  assert.match(blocked.askUserQuestion.questions[0].question, /2 家机构/u);
  assert.match(blocked.askUserQuestion.questions[0].question, /您好，请协助反馈本次项目报价/u);

  await hooks.get("after_tool_call")(
    {
      toolName: "AskUserQuestion",
      params: blocked.askUserQuestion,
      result: { content: [{ text: `${blocked.askUserQuestion.questions[0].question}: 确认发送` }] },
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

test("confirmation rejects changed params and survives host run rollover", async () => {
  const hooks = registeredHooks();
  const blocked = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    { runId: "run-a" },
  );

  await hooks.get("after_tool_call")(
    {
      toolName: "AskUserQuestion",
      params: blocked.askUserQuestion,
      result: { answer: "确认发送" },
    },
    { runId: "run-a" },
  );

  const changed = await hooks.get("before_tool_call")(
    {
      toolName: "create_with_distributions",
      params: { ...inquiryParams, description: "已改写的需求" },
    },
    { runId: "run-a" },
  );
  assert.equal(changed.block, true);

  const otherRun = await hooks.get("before_tool_call")(
    { toolName: "create_with_distributions", params: inquiryParams },
    { runId: "run-b" },
  );
  assert.equal(otherRun, undefined);
});

test("confirmation binds exact string whitespace and accepts a rewritten question in the same run", async () => {
  const hooks = registeredHooks();
  const context = { runId: "run-rewritten-question" };
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

test("startup asks for the complete Skill once and keeps the fixed chain in context", () => {
  const skillPath = "/plugin/skills/media-assistant/SKILL.md";
  const hooks = registeredHooks(() => 1, skillPath);
  const context = { runId: "skill-run" };
  const prompt = hooks.get("before_prompt_build")({}, context);
  assert.match(prompt.prependContext, /Before the first YPscan/u);
  assert.match(
    prompt.prependContext,
    /ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns/u,
  );

  hooks.get("before_tool_call")({ toolName: "Read", params: { path: skillPath } }, context);
  assert.equal(hooks.get("before_prompt_build")({}, context), undefined);
});

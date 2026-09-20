import assert from "node:assert/strict";
import test from "node:test";

import { registerFlowDirectiveHooks } from "../src/hooks/register-flow-directives.js";

function registeredPlugin() {
  const hooks = new Map();
  const runtime = registerFlowDirectiveHooks({
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
  return { hooks, runtime };
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

function persist(toolName, params, message) {
  return registeredPlugin().hooks.get("tool_result_persist")({
    toolName,
    params,
    message: toolMessage(message),
  });
}

test("creator-detail field selection returns field_id and URL without a requirement", () => {
  const text = directiveText(
    persist(
      "mcp__ypscan__select_inquiry_form_fields",
      { platform: "douyin", creator_ids: ["creator-1", "creator-2"] },
      {
        success: true,
        status: "selection_required",
        field_id: "run-123",
        url: "https://example.invalid/creator-fields",
      },
    ),
  );
  assert.match(text, /FIELD_SELECTION_FIELD_ID=run-123/u);
  assert.match(text, /FIELD_SELECTION_URL=https:\/\/example\.invalid\/creator-fields/u);
  assert.match(text, /只扒达人信息的字段选择链接已生成/u);
  assert.doesNotMatch(text, /get_inquiry_form_fields_status/u);
  assert.doesNotMatch(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("creator-detail field selection pauses without field_id or URL", () => {
  const missingId = directiveText(
    persist(
      "mcp__ypscan__select_inquiry_form_fields",
      { platform: "xiaohongshu", creator_links: ["https://example.invalid/p/1"] },
      { success: true, status: "opened", url: "https://example.invalid/creator-fields" },
    ),
  );
  assert.match(missingId, /缺少 field_id 或 URL/u);
  assert.doesNotMatch(missingId, /FIELD_SELECTION_URL=/u);

  const missingUrl = directiveText(
    persist(
      "mcp__ypscan__select_inquiry_form_fields",
      { platform: "xiaohongshu", creator_ids: ["creator-1"] },
      { success: true, status: "selection_required", field_id: "run-456" },
    ),
  );
  assert.match(missingUrl, /缺少 field_id 或 URL/u);
});

test("excel_export success delivers the table link as final delivery", () => {
  const text = directiveText(
    persist(
      "mcp__ypscan__excel_export",
      { field_id: "run-123", source_csv_file_link: "https://example.invalid/creators.csv" },
      {
        success: true,
        data: { file_url: "https://example.invalid/creator-table.xlsx" },
      },
    ),
  );
  assert.match(text, /EXCEL_EXPORT_FILE_URL=https:\/\/example\.invalid\/creator-table\.xlsx/u);
  assert.match(text, /最终交付/u);
  assert.doesNotMatch(text, /FIELD_SELECTION_URL=|ASK_USER_QUESTION_ARGS=/u);
});

test("excel_export missing columns re-shows the field page URL", () => {
  const text = directiveText(
    persist(
      "mcp__ypscan__excel_export",
      { field_id: "run-123", source_csv_file_link: "https://example.invalid/creators.csv" },
      {
        success: false,
        error: { code: "EXCEL_EXPORT_COLUMNS_NOT_CONFIGURED", message: "未选择字段" },
        url: "https://example.invalid/creator-fields",
      },
    ),
  );
  assert.match(text, /未选择字段/u);
  assert.match(text, /FIELD_SELECTION_URL=https:\/\/example\.invalid\/creator-fields/u);
});

test("excel_export invalid source csv asks for a fresh upload", () => {
  const text = directiveText(
    persist(
      "mcp__ypscan__excel_export",
      { field_id: "run-123", source_csv_file_link: "https://example.invalid/bad.csv" },
      {
        success: false,
        error: { code: "EXCEL_EXPORT_SOURCE_CSV_INVALID", message: "csv 无法解析" },
      },
    ),
  );
  assert.match(text, /source_csv_file_link 无效/u);
  assert.match(text, /file_bridge 重新上传/u);
});

test("excel_export unknown failure pauses with a retry option", () => {
  const text = directiveText(
    persist(
      "mcp__ypscan__excel_export",
      { field_id: "run-123", source_csv_file_link: "https://example.invalid/creators.csv" },
      { success: false, error: { code: "PROVIDER_FAILED" } },
    ),
  );
  assert.match(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("host call IDs keep creator args for creator-detail field selection", () => {
  const { hooks } = registeredPlugin();
  const context = { sessionKey: "creator-detail" };
  hooks.get("before_tool_call")(
    {
      toolName: "mcp__ypscan__select_inquiry_form_fields",
      toolCallId: "cd-1",
      params: { platform: "douyin", creator_ids: ["creator-1"] },
    },
    context,
  );
  const text = directiveText(
    hooks.get("tool_result_persist")(
      {
        toolName: "mcp__ypscan__select_inquiry_form_fields",
        toolCallId: "cd-1",
        message: toolMessage({
          success: true,
          status: "selection_required",
          field_id: "run-123",
          url: "https://example.invalid/creator-fields",
        }),
      },
      context,
    ),
  );
  assert.match(text, /FIELD_SELECTION_FIELD_ID=run-123/u);
  assert.match(text, /FIELD_SELECTION_URL=/u);
  assert.doesNotMatch(text, /缺少目标需求 ID/u);
});

test("host call IDs keep field_id for excel_export recovery", () => {
  const { hooks } = registeredPlugin();
  const context = { sessionKey: "excel-export" };
  hooks.get("before_tool_call")(
    {
      toolName: "mcp__ypscan__excel_export",
      toolCallId: "ex-1",
      params: { field_id: "run-123", source_csv_file_link: "https://example.invalid/creators.csv" },
    },
    context,
  );
  const text = directiveText(
    hooks.get("tool_result_persist")(
      {
        toolName: "mcp__ypscan__excel_export",
        toolCallId: "ex-1",
        message: toolMessage({
          success: false,
          error: { code: "EXCEL_EXPORT_COLUMNS_NOT_CONFIGURED", message: "未选择字段" },
          url: "https://example.invalid/creator-fields",
        }),
      },
      context,
    ),
  );
  assert.match(text, /FIELD_SELECTION_FIELD_ID=run-123/u);
  assert.match(text, /FIELD_SELECTION_URL=https:\/\/example\.invalid\/creator-fields/u);
});

test("creator-detail field selection error pauses", () => {
  const text = directiveText(
    persist(
      "mcp__ypscan__select_inquiry_form_fields",
      { platform: "douyin", creator_ids: ["creator-1"] },
      { success: false, status: "error", error: { code: "INVALID_ARGS" } },
    ),
  );
  assert.match(text, /只扒达人信息的字段选择失败/u);
  assert.doesNotMatch(text, /FIELD_SELECTION_URL=|ASK_USER_QUESTION_ARGS=/u);
});

test("creator-detail field selection accepts a numeric field_id", () => {
  const text = directiveText(
    persist(
      "mcp__ypscan__select_inquiry_form_fields",
      { platform: "douyin", creator_ids: ["creator-1"] },
      {
        success: true,
        status: "selection_required",
        field_id: 123,
        url: "https://example.invalid/creator-fields",
      },
    ),
  );
  assert.match(text, /FIELD_SELECTION_FIELD_ID=123/u);
  assert.match(text, /FIELD_SELECTION_URL=/u);
});

test("excel_export success without a file URL pauses", () => {
  const text = directiveText(
    persist(
      "mcp__ypscan__excel_export",
      { field_id: "run-123", source_csv_file_link: "https://example.invalid/creators.csv" },
      { success: true },
    ),
  );
  assert.match(text, /ASK_USER_QUESTION_ARGS=/u);
});

test("creator-detail completion paths gate on field_id for file_bridge upload", () => {
  const { hooks, runtime } = registeredPlugin();
  const context = { sessionKey: "creator-detail-upload", workspaceDir: "/workspace" };
  hooks.get("tool_result_persist")(
    {
      toolName: "mcp__ypscan__select_inquiry_form_fields",
      toolCallId: "sel-1",
      params: { platform: "douyin", creator_ids: ["creator-1"] },
      message: toolMessage({
        success: true,
        status: "selection_required",
        field_id: "run-123",
        url: "https://example.invalid/creator-fields",
      }),
    },
    context,
  );
  hooks.get("before_tool_call")(
    {
      toolName: "mcp__ypscan__get_douyin_author_business_card",
      toolCallId: "comp-1",
      params: { author_ids: ["creator-1"] },
    },
    context,
  );
  hooks.get("tool_result_persist")(
    {
      toolName: "mcp__ypscan__get_douyin_author_business_card",
      toolCallId: "comp-1",
      message: toolMessage({
        csv_file: "/workspace/completion.csv",
        successful_author_ids: ["creator-1"],
        failed_author_ids: [],
      }),
    },
    context,
  );
  assert.deepEqual(runtime.completionCsvPathsFor("run-123"), ["/workspace/completion.csv"]);
  assert.deepEqual(runtime.completionCsvPathsFor("req-other"), []);
});

test("file_bridge creator_detail directs the next excel_export call", () => {
  const text = directiveText(
    persist(
      "file_bridge",
      { field_id: "run-123", platform: "douyin", flow: "creator_detail" },
      {
        success: true,
        data: {
          requirement_id: "run-123",
          field_id: "run-123",
          flow: "creator_detail",
          file_path: "/workspace/creator-detail.csv",
          csv_file_path: "https://example.invalid/creator-detail/123/abc.csv",
          data_row_count: 2,
        },
        delivery: { local_file_link: "file:///workspace/creator-detail.csv" },
      },
    ),
  );
  assert.match(text, /EXCEL_EXPORT_ARGS=/u);
  assert.match(text, /source_csv_file_link/u);
  assert.doesNotMatch(text, /启动打分|SCORE_MANUAL_SOURCE_CSV_ARGS|缺少/u);
});

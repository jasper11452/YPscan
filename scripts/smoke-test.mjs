/** Side-effect-free installation smoke test for the fixed-flow profile. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import plugin from "../index.js";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url)), "utf8"),
);
assert.equal(
  manifest.version,
  packageJson.version,
  "manifest and package versions must stay in sync",
);
assert.equal(packageJson.files.includes("skills"), true, "published package must include skills");
assert.equal(
  manifest.mcpServers.ypscan.toolFilter.include.includes("manual_source_creators"),
  false,
  "deprecated manual sourcing must never be exposed by this plugin",
);
assert.equal(
  manifest.mcpServers.ypscan.toolFilter.include.includes("select_inquiry_form_fields"),
  true,
  "field selection must be exposed directly by the Provider MCP",
);
assert.equal(
  manifest.mcpServers.ypscan.toolFilter.include.includes("get_selected_inquiry_form_fields"),
  false,
  "deprecated field-selection reads must not be exposed",
);
assert.equal(
  manifest.mcpServers.ypscan.toolFilter.include.includes("get_ingest_job"),
  true,
  "async ingest result polling must be exposed from the Provider MCP",
);

const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-smoke-"));
const registered = { tools: [], hooks: [] };
try {
  plugin.register({
    config: {},
    pluginConfig: {},
    registerTool(toolOrFactory) {
      registered.tools.push(
        typeof toolOrFactory === "function" ? toolOrFactory({ workspaceDir }) : toolOrFactory,
      );
    },
    on(name, handler) {
      registered.hooks.push({ name, handler });
    },
  });

  const toolNames = registered.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("ypscan_parse_requirement"));
  assert.ok(toolNames.includes("ypscan_manual_research"));
  assert.ok(toolNames.includes("ypscan_save_excel_artifact"));
  assert.equal(toolNames.includes("ypscan_manual_browser_inspect"), false);
  assert.equal(toolNames.includes("ypscan_manual_browser_action"), false);
  assert.equal(toolNames.includes("ypscan_manual_select_filters"), false);
  const excelSaver = registered.tools.find((tool) => tool.name === "ypscan_save_excel_artifact");
  assert.ok(excelSaver.parameters.properties.artifact_kind.enum.includes("creator_preview"));
  assert.ok(excelSaver.parameters.properties.artifact_kind.enum.includes("mcn_creator_preview"));
  assert.equal(toolNames.includes("ypscan__select_inquiry_form_fields"), false);
  assert.equal(toolNames.length, 3);
  assert.equal(toolNames.includes("ypscan_runtime_status"), false);
  assert.equal(toolNames.includes("ypscan_capture_field_selection"), false);
  assert.equal(toolNames.includes("ypscan_import_manual_source_excel"), false);
  assert.equal(toolNames.includes("ypscan_commit_browser_source_batch"), false);
  assert.equal(toolNames.includes("ypscan_parse_requirement_tags"), false);
  const manualResearch = registered.tools.find((tool) => tool.name === "ypscan_manual_research");
  const rejectedLegacyCall = await manualResearch.execute("smoke-legacy", {
    requirement_id: "smoke-requirement",
    platform: "xingtu",
    facts: [],
    keywords: ["smoke"],
  });
  const rejectedLegacyPayload = JSON.parse(rejectedLegacyCall.content[0].text);
  assert.equal(rejectedLegacyPayload.success, false);
  assert.equal(rejectedLegacyPayload.error.code, "YPSCAN_MANUAL_ARGUMENT_INVALID");

  const hookNames = registered.hooks.map((hook) => hook.name);
  assert.deepEqual([...new Set(hookNames)].sort(), [
    "after_tool_call",
    "before_prompt_build",
    "before_tool_call",
    "gateway_start",
    "gateway_stop",
    "tool_result_persist",
  ]);
  const beforeHook = registered.hooks.find((hook) => hook.name === "before_tool_call").handler;
  const persistHook = registered.hooks.find((hook) => hook.name === "tool_result_persist").handler;
  assert.equal(
    await beforeHook(
      {
        toolName: "ypscan__get_workflow_state",
        params: { requirement_id: "smoke" },
      },
      {},
    ),
    undefined,
  );

  const sendParams = {
    requirement_id: "smoke-requirement",
    supplierIds: ["smoke-supplier"],
    description: "smoke",
    wechat_notification_message: "smoke WeCom body",
  };
  const sendContext = { runId: "smoke-run" };
  await persistHook(
    {
      toolName: "ypmcn__rank_mcns",
      params: { id: sendParams.requirement_id },
      message: {
        content: JSON.stringify({
          success: true,
          data: {
            mcns: [{ supplier_id: "smoke-supplier", agency_name: "Smoke 机构" }],
          },
        }),
      },
    },
    sendContext,
  );
  const blocked = await beforeHook(
    {
      toolName: "ypmcn__create_with_distributions",
      params: sendParams,
    },
    sendContext,
  );
  assert.match(blocked.blockReason, /^HITL_REQUIRED:/u);

  console.log(`smoke test OK: tools=${toolNames.length}, hooks=${hookNames.length}`);
} finally {
  for (const hook of registered.hooks) {
    if (hook.name === "gateway_stop") await hook.handler();
  }
  rmSync(workspaceDir, { recursive: true, force: true });
}

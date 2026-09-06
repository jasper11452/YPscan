/** Side-effect-free installation smoke test for the fixed-flow profile. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import plugin from "../index.js";

function readJsonFile(path) {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `invalid JSON in ${path}: ${error instanceof Error ? error.message : "unknown parse error"}`,
      { cause: error },
    );
  }
}

const packageJson = readJsonFile(fileURLToPath(new URL("../package.json", import.meta.url)));
const manifest = readJsonFile(fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url)));
assert.equal(
  manifest.version,
  packageJson.version,
  "manifest and package versions must stay in sync",
);
assert.equal(packageJson.files.includes("skills"), true, "published package must include skills");
assert.deepEqual(
  manifest.skills,
  ["./skills"],
  "plugin manifest must declare skills so the host discovers media-assistant",
);
assert.match(
  readFileSync(new URL("../skills/media-assistant/SKILL.md", import.meta.url), "utf8"),
  /^name: media-assistant$/m,
  "declared skills directory must contain the business skill",
);
assert.equal(
  packageJson.files.includes("src/tools/save-creator-links.js"),
  true,
  "published package must include the creator-links module imported by index.js",
);
assert.equal(
  packageJson.files.includes("src/tools/file-bridge-oss-defaults.json"),
  true,
  "published package must be able to ship pack-time injected OSS credentials",
);
assert.equal(
  manifest.mcpServers.ypscan.url,
  "https://mcp.eshypdata.com/mcp",
  "Provider MCP must use the current HTTP endpoint",
);
assert.equal(
  manifest.mcpServers.ypscan.transport,
  "streamable-http",
  "Provider MCP must use OpenClaw's canonical Streamable HTTP transport",
);
assert.equal(
  manifest.mcpServers.ypscan.toolFilter.include.includes("manual_source_creators"),
  true,
  "default backend manual sourcing must be exposed by this plugin",
);
assert.equal(
  manifest.mcpServers.ypscan.toolFilter.include.includes("manual_source_creators_status"),
  true,
  "manual sourcing status polling must be exposed from the Provider MCP",
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
assert.equal(
  manifest.mcpServers.ypscan.toolFilter.include.includes("score_manual_source_csv"),
  true,
  "manual-source CSV scoring must be exposed from the Provider MCP",
);
assert.equal(
  manifest.mcpServers.ypscan.toolFilter.include.includes("score_manual_source_csv_status"),
  true,
  "manual-source CSV scoring job status polling must be exposed from the Provider MCP",
);
assert.deepEqual(manifest.configSchema.properties.fileBridgeOss.required, [
  "accessKeyId",
  "accessKeySecret",
  "region",
  "bucket",
  "objectPrefix",
]);
assert.equal(
  manifest.configSchema.properties.fileBridgeOss.additionalProperties,
  false,
  "fileBridgeOss must reject unknown properties",
);
for (const removed of [
  "create_submission_batch",
  "get_creator_detail",
  "get_creator_detail_export",
  "get_workflow_state",
]) {
  assert.equal(
    manifest.mcpServers.ypscan.toolFilter.include.includes(removed),
    false,
    `deprecated formal-chain tool ${removed} must not be exposed from the Provider MCP`,
  );
}

const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-smoke-"));
const registered = { tools: [], hooks: [] };
try {
  plugin.register({
    config: {},
    pluginConfig: {
      fileBridgeOss: {
        accessKeyId: "ak",
        accessKeySecret: "sk",
        region: "oss-cn-shanghai",
        bucket: "ypmisc",
        objectPrefix: "action",
      },
    },
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
  assert.equal(toolNames.includes("ypscan_manual_research"), false);
  assert.ok(toolNames.includes("ypscan_save_artifact"));
  assert.ok(toolNames.includes("ypscan_save_creator_links"));
  assert.equal(toolNames.includes("ypscan_manual_browser_inspect"), false);
  assert.equal(toolNames.includes("ypscan_manual_browser_action"), false);
  assert.equal(toolNames.includes("ypscan_manual_select_filters"), false);
  const artifactSaver = registered.tools.find((tool) => tool.name === "ypscan_save_artifact");
  assert.equal(
    artifactSaver.parameters.properties.artifact_kind.enum.includes("creator_preview"),
    false,
  );
  assert.deepEqual(artifactSaver.parameters.required, ["artifact_kind", "artifact_id", "file_url"]);
  assert.deepEqual(artifactSaver.parameters.properties.artifact_kind.enum, [
    "creator_detail_export",
    "mcn_ranking",
    "mcn_creator_preview",
    "manual_source",
    "ranked_submission",
    "manual_creator_links",
    "mcn_creator_links",
  ]);
  const creatorLinksSaver = registered.tools.find(
    (tool) => tool.name === "ypscan_save_creator_links",
  );
  assert.ok(creatorLinksSaver);
  assert.deepEqual(creatorLinksSaver.parameters.required, ["requirement_id", "platform"]);
  assert.deepEqual(
    creatorLinksSaver.parameters.oneOf.map((item) => item.required),
    [["links_csv_path"], ["preview_file_path"]],
  );
  assert.equal(packageJson.files.includes("src/tools/read-creator-preview.js"), true);
  assert.equal(toolNames.includes("ypscan_merge_creator_csv"), false);
  const fileBridgeTool = registered.tools.find((tool) => tool.name === "file_bridge");
  assert.ok(fileBridgeTool);
  assert.deepEqual(fileBridgeTool.parameters.required, [
    "requirement_id",
    "platform",
    "flow",
    "links_csv_path",
    "completion_csv_paths",
  ]);
  assert.deepEqual(fileBridgeTool.parameters.properties.flow.enum, [
    "manual_source",
    "mcn_rank",
    "mcn_complete_only",
  ]);
  assert.equal(toolNames.includes("ypscan__select_inquiry_form_fields"), false);
  assert.equal(toolNames.length, 4);
  assert.equal(toolNames.includes("ypscan_runtime_status"), false);
  assert.equal(toolNames.includes("ypscan_capture_field_selection"), false);
  assert.equal(toolNames.includes("ypscan_import_manual_source_excel"), false);
  assert.equal(toolNames.includes("ypscan_commit_browser_source_batch"), false);
  assert.equal(toolNames.includes("ypscan_parse_requirement_tags"), false);

  const hookNames = registered.hooks.map((hook) => hook.name);
  assert.deepEqual([...new Set(hookNames)].sort(), [
    "before_prompt_build",
    "before_tool_call",
    "gateway_start",
    "gateway_stop",
    "tool_result_persist",
  ]);

  console.log(`smoke test OK: tools=${toolNames.length}, hooks=${hookNames.length}`);
} finally {
  for (const hook of registered.hooks) {
    if (hook.name === "gateway_stop") await hook.handler();
  }
  rmSync(workspaceDir, { recursive: true, force: true });
}

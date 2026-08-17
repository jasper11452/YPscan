import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("field selection is exposed directly from the Provider MCP", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../openclaw.plugin.json", import.meta.url),
    "utf8",
  ));
  assert.equal(
    manifest.mcpServers.ypscan.toolFilter.include.includes("select_inquiry_form_fields"),
    true,
  );
  assert.equal(
    manifest.mcpServers.ypscan.toolFilter.include.includes("get_selected_inquiry_form_fields"),
    false,
  );
  assert.equal(
    manifest.contracts.tools.includes("ypscan__select_inquiry_form_fields"),
    false,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { createPlaywrightCliRuntime } from "../src/tools/playwright-cli-runtime.js";

test("Playwright CLI capture uses one short named session and parses raw JSON", async () => {
  const calls = [];
  const runtime = createPlaywrightCliRuntime({
    wrapperPath: "/yp/playwright_cli.sh",
    session: "ypscan",
    exec: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: JSON.stringify({
          source_url: "https://www.xingtu.cn/ad/creator/market",
          rows: [{ nickname: "测试达人" }],
        }),
      };
    },
  });

  const captured = await runtime.readList("xingtu");
  assert.equal(captured.rows[0].nickname, "测试达人");
  assert.equal(calls[0].file, "/yp/playwright_cli.sh");
  assert.deepEqual(calls[0].args.slice(0, 4), ["--session", "ypscan", "--raw", "run-code"]);
  assert.match(calls[0].args[4], /page\.evaluate/u);
  assert.equal(calls[0].options.timeout, 30_000);
});

test("Playwright CLI runtime reports a missing session explicitly", async () => {
  const runtime = createPlaywrightCliRuntime({
    exec: async () => {
      throw Object.assign(new Error("Browser 'ypscan' is not open"), {
        stderr: "Browser 'ypscan' is not open",
      });
    },
  });

  await assert.rejects(
    () => runtime.readDetail("xingtu"),
    (error) =>
      error.code === "YPSCAN_PLAYWRIGHT_SESSION_UNAVAILABLE" &&
      /not open/u.test(error.message),
  );
});

test("overlong Playwright session names are rejected before spawning a process", () => {
  assert.throws(
    () => createPlaywrightCliRuntime({ session: "ypscan-session-is-too-long" }),
    /session 名称过长/u,
  );
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPgyAdapter } from "../src/tools/manual-research/pgy-adapter.js";
import { createXingtuAdapter } from "../src/tools/manual-research/xingtu-adapter.js";

function locator({ visible = true, onClick = () => {}, evaluateAll = null, text = "" } = {}) {
  return {
    first() {
      return this;
    },
    last() {
      return this;
    },
    isVisible: async () => visible,
    innerText: async () => text,
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => onClick(),
    evaluateAll: evaluateAll ? async () => evaluateAll() : undefined,
  };
}

test("PGY quote selection does not click the note-type content filter", async () => {
  let interactiveCalls = 0;
  const page = {
    url: () => "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
    locator(selector) {
      if (selector === "body") return locator({ text: "博主广场" });
      return locator({ visible: false });
    },
    getByText() {
      interactiveCalls += 1;
      return locator();
    },
    getByRole() {
      interactiveCalls += 1;
      return locator();
    },
  };
  const result = await createPgyAdapter(page, {
    workspaceDir: "/tmp",
    now: () => 123,
  }).setPriceView("图文");

  assert.deepEqual(result, { applied: true, readback: "图文", source: "internal_target" });
  assert.equal(interactiveCalls, 0);
});

test("Xingtu export returns only a newly observed Feishu link", async () => {
  const oldLink = "https://example.feishu.cn/sheets/old";
  const newLink = "https://example.feishu.cn/sheets/new";
  let clicked = false;
  let linkReads = 0;
  const page = {
    url: () => "https://www.xingtu.cn/ad/creator/market",
    locator(selector) {
      if (selector === "body") return locator({ text: "达人广场" });
      if (selector.includes("captcha")) return locator({ visible: false });
      if (selector === "a[href]") {
        return locator({
          evaluateAll: () => {
            linkReads += 1;
            return linkReads === 1 ? [oldLink] : [oldLink, newLink];
          },
        });
      }
      return locator({ onClick: () => (clicked = true) });
    },
    getByRole() {
      return locator();
    },
    waitForTimeout: async () => {},
  };

  const result = await createXingtuAdapter(page).export();
  assert.equal(clicked, true);
  assert.deepEqual(result, { status: "complete", kind: "lark_sheet", url: newLink });
});

test("PGY export waits for the native download and saves its suggested filename", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-pgy-export-"));
  const saved = [];
  try {
    let downloadListener;
    const download = {
      suggestedFilename: () => "pgy-creators.xlsx",
      saveAs: async (filePath) => saved.push(filePath),
    };
    const exportButton = locator({ onClick: () => downloadListener(download) });
    const confirmButton = locator({ visible: false });
    const page = {
      url: () => "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
      locator(selector) {
        return selector === "body" ? locator({ text: "博主广场" }) : locator({ visible: false });
      },
      getByRole(_role, { name }) {
        return name.test("导出") ? exportButton : confirmButton;
      },
      on(name, listener) {
        assert.equal(name, "download");
        downloadListener = listener;
      },
      off(name, listener) {
        assert.equal(name, "download");
        assert.equal(listener, downloadListener);
      },
    };

    const result = await createPgyAdapter(page, {
      workspaceDir,
      now: () => 123,
    }).export();
    const expected = join(workspaceDir, "ypscan-exports", "123", "pgy-creators.xlsx");
    assert.deepEqual(saved, [expected]);
    assert.deepEqual(result, {
      status: "complete",
      kind: "native_file",
      file_path: expected,
      filename: "pgy-creators.xlsx",
    });
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("PGY export removes its download waiter when the export click fails", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-pgy-export-failure-"));
  let activeListener = null;
  try {
    const page = {
      url: () => "https://pgy.xiaohongshu.com/solar/pre-trade/note/kol",
      locator(selector) {
        return selector === "body" ? locator({ text: "博主广场" }) : locator({ visible: false });
      },
      getByRole(_role, { name }) {
        return name.test("导出")
          ? locator({
              onClick: () => {
                throw new Error("click failed");
              },
            })
          : locator({ visible: false });
      },
      on(_name, listener) {
        activeListener = listener;
      },
      off(_name, listener) {
        if (activeListener === listener) activeListener = null;
      },
    };
    const result = await createPgyAdapter(page, { workspaceDir, now: () => 123 }).export();
    assert.deepEqual(result, { status: "failed", reason: "export_click_failed" });
    assert.equal(activeListener, null);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

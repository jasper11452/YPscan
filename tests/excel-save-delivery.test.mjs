import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveArtifact } from "../src/tools/save-artifact.js";
import {
  MAX_POPUP_LINE_LENGTH,
  mcnRankingRecipientQuestionPayload,
} from "../src/tools/popup-questions.js";

function saveFixture(workspaceDir, artifactKind, fileName, extraParams = {}) {
  return saveArtifact(
    {
      artifact_kind: artifactKind,
      artifact_id: "artifact-1",
      file_url: `https://mcp.eshypdata.com/api/download?file_path=${fileName}`,
      ...extraParams,
    },
    {
      workspaceDir,
      fetchImpl: async () =>
        new Response(Buffer.from(`xlsx-${fileName}`), {
          status: 200,
        }),
      retryDelaysMs: [],
    },
  );
}

function assertPopupLines(payload) {
  for (const question of payload.questions) {
    for (const value of [
      question.header,
      question.question,
      ...question.options.flatMap((option) => [option.label, option.description]),
    ]) {
      for (const line of value.split("\n")) {
        assert.ok([...line].length <= MAX_POPUP_LINE_LENGTH);
      }
    }
  }
}

test("only MCN ranking save offers the recipient question", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-ranking-recipient-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

  const mcnRanking = JSON.parse(
    (
      await saveFixture(workspaceDir, "mcn_ranking", "mcn-ranking.xlsx", {
        mcn_names: ["机构 A", "机构 B"],
      })
    ).content[0].text,
  );
  assert.equal(mcnRanking.success, true);
  assert.equal(mcnRanking.delivery.next_tool, "AskUserQuestion");
  assert.deepEqual(
    mcnRanking.delivery.next_args,
    mcnRankingRecipientQuestionPayload(["机构 A", "机构 B"]),
  );
  assert.equal(mcnRanking.delivery.next_args.questions[0].multiSelect, false);
  assertPopupLines(mcnRanking.delivery.next_args);

  const emptyMcnRanking = JSON.parse(
    (await saveFixture(workspaceDir, "mcn_ranking", "empty-mcn-ranking.xlsx", { mcn_names: [] }))
      .content[0].text,
  );
  assert.equal(emptyMcnRanking.delivery.next_args, undefined);

  for (const artifactKind of [
    "mcn_creator_preview",
    "manual_source",
    "ranked_submission",
    "creator_detail_export",
  ]) {
    const saved = JSON.parse(
      (await saveFixture(workspaceDir, artifactKind, `${artifactKind}.xlsx`)).content[0].text,
    );
    assert.equal(saved.success, true);
    assert.equal(saved.delivery.next_tool, undefined);
    assert.equal(saved.delivery.next_args, undefined);
  }
});

test("MCN ranking save omits an invalid recipient question", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-invalid-recipients-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

  const result = JSON.parse(
    (
      await saveFixture(workspaceDir, "mcn_ranking", "invalid-recipients.xlsx", {
        mcn_names: ["", "\n", null],
      })
    ).content[0].text,
  );

  assert.equal(result.success, true);
  assert.equal(result.delivery.next_tool, undefined);
  assert.equal(result.delivery.next_args, undefined);
});

test("successful saves expose a clickable local file link with an encoded target", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan 本地链接-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

  const result = JSON.parse(
    (await saveFixture(workspaceDir, "manual_source", "达人 排名 1.xlsx")).content[0].text,
  );

  assert.equal(result.success, true);
  assert.match(result.delivery.local_file_link, /^\[\/.*达人 排名 1\.xlsx\]\(<file:\/\/\//u);
  assert.match(
    result.delivery.local_file_link,
    /%E8%BE%BE%E4%BA%BA%20%E6%8E%92%E5%90%8D%201\.xlsx>\)$/u,
  );
  assert.match(result.delivery.user_visible_message, /点击|本地文件/u);
});

test("search creator previews are no longer accepted as save artifacts", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-removed-creator-preview-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

  const result = JSON.parse(
    (await saveFixture(workspaceDir, "creator_preview", "creator-preview.xlsx")).content[0].text,
  );
  assert.equal(result.success, false);
  assert.equal(result.error.code, "YPSCAN_ARTIFACT_INVALID_INPUT");
});

test("Excel download accepts HTTPS URLs under eshypdata.com", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-trusted-download-url-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const excelFileUrl =
    "https://test-agenta.eshypdata.com/api/mcp-tools/rank-mcns-exports/ranking.xlsx";
  let fetchedUrl = null;
  const result = JSON.parse(
    (
      await saveArtifact(
        {
          artifact_kind: "mcn_ranking",
          artifact_id: "artifact-trusted-url",
          file_url: excelFileUrl,
        },
        {
          workspaceDir,
          fetchImpl: async (url) => {
            fetchedUrl = url;
            return new Response(Buffer.from("xlsx-ranking"), { status: 200 });
          },
          retryDelaysMs: [],
        },
      )
    ).content[0].text,
  );

  assert.equal(result.success, true);
  assert.equal(fetchedUrl, excelFileUrl);
  assert.equal(result.data.file_name, "ranking.xlsx");
});

test("Excel download rejects URLs outside eshypdata.com before fetching", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-invalid-download-url-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  let fetchCalls = 0;
  for (const excelFileUrl of [
    "not a url",
    "https://example.com/a.xlsx",
    "https://eshypdata.com.evil.example/a.xlsx",
    "http://mcp.eshypdata.com/a.xlsx",
    "https://user@mcp.eshypdata.com/a.xlsx",
    "https://mcp.eshypdata.com/a.xlsx#fragment",
  ]) {
    const result = JSON.parse(
      (
        await saveArtifact(
          {
            artifact_kind: "ranked_submission",
            artifact_id: "artifact-invalid-url",
            file_url: excelFileUrl,
          },
          {
            workspaceDir,
            fetchImpl: async () => {
              fetchCalls += 1;
              return new Response();
            },
          },
        )
      ).content[0].text,
    );
    assert.equal(result.error.code, "YPSCAN_ARTIFACT_DOWNLOAD_URL_INVALID");
  }
  assert.equal(fetchCalls, 0);
});

test("Excel download uses the configured finite retry schedule", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-download-retry-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  let attempts = 0;
  const result = JSON.parse(
    (
      await saveArtifact(
        {
          artifact_kind: "ranked_submission",
          artifact_id: "artifact-retry",
          file_url: "https://mcp.eshypdata.com/api/download?file_path=retry.xlsx",
        },
        {
          workspaceDir,
          retryDelaysMs: [0],
          sleepImpl: async () => {},
          fetchImpl: async () => {
            attempts += 1;
            return attempts === 1
              ? new Response("temporary", { status: 503 })
              : new Response(Buffer.from("xlsx-retry"), { status: 200 });
          },
        },
      )
    ).content[0].text,
  );

  assert.equal(result.success, true);
  assert.equal(result.data.download_attempts, 2);
});

test("CSV artifacts use the same save path and derive a safe format-specific name", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-csv-artifact-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

  const saved = JSON.parse(
    (await saveFixture(workspaceDir, "manual_creator_links", "creator-links.csv")).content[0].text,
  );

  assert.equal(saved.success, true);
  assert.equal(saved.data.file_name, "creator-links.csv");
  assert.match(saved.delivery.local_file_link, /creator-links\.csv/u);
  assert.match(saved.delivery.user_visible_message, /CSV 已保存/u);

  const fallback = JSON.parse(
    (await saveFixture(workspaceDir, "manual_creator_links", "creator-links.xlsx")).content[0].text,
  );
  assert.equal(fallback.success, true);
  assert.match(fallback.data.file_name, /^manual_creator_links-[a-f0-9]{16}\.csv$/u);
});

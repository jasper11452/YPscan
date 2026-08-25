import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveExcelArtifact } from "../src/tools/save-excel-artifact.js";
import { submissionEnrichmentQuestionPayload } from "../src/tools/post-save-questions.js";

function saveFixture(workspaceDir, artifactKind, fileName) {
  return saveExcelArtifact({
    artifact_kind: artifactKind,
    artifact_id: "artifact-1",
    excel_file_url: `https://mcp.eshypdata.com/api/download?file_path=${fileName}`,
  }, {
    workspaceDir,
    fetchImpl: async () => new Response(Buffer.from(`xlsx-${fileName}`), {
      status: 200,
    }),
    retryDelaysMs: [],
  });
}

test("only Provider submission save offers enrichment", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-submission-enrichment-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

  const initial = JSON.parse((await saveFixture(
    workspaceDir,
    "submission_batch",
    "initial-submission.xlsx",
  )).content[0].text);
  assert.equal(initial.delivery.next_tool, "AskUserQuestion");
  assert.deepEqual(initial.delivery.next_args, submissionEnrichmentQuestionPayload());
  const enrichmentOption = initial.delivery.next_args.questions[0].options[0];
  assert.equal(enrichmentOption.label, "补充更新达人信息");
  assert.match(enrichmentOption.description, /立即调用 get_creator_detail/u);
  assert.match(enrichmentOption.description, /不再选择字段或追问/u);

  const enriched = JSON.parse((await saveFixture(
    workspaceDir,
    "creator_detail_export",
    "enriched-submission.xlsx",
  )).content[0].text);
  assert.equal(enriched.delivery.next_tool, undefined);
  assert.equal(enriched.delivery.next_args, undefined);

  const mcnRanking = JSON.parse((await saveFixture(
    workspaceDir,
    "mcn_ranking",
    "mcn-ranking.xlsx",
  )).content[0].text);
  assert.equal(mcnRanking.success, true);
  assert.equal(mcnRanking.delivery.next_tool, undefined);
  assert.equal(mcnRanking.delivery.next_args, undefined);

  const mcnPreview = JSON.parse((await saveFixture(
    workspaceDir,
    "mcn_creator_preview",
    "mcn-creator-preview.xlsx",
  )).content[0].text);
  assert.equal(mcnPreview.success, true);
  assert.equal(mcnPreview.delivery.next_tool, undefined);

  const manualSource = JSON.parse((await saveFixture(
    workspaceDir,
    "manual_source",
    "manual-source.xlsx",
  )).content[0].text);
  assert.equal(manualSource.success, true);
  assert.equal(manualSource.delivery.next_tool, undefined);
});

test("search creator previews are no longer accepted as save artifacts", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-removed-creator-preview-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));

  const result = JSON.parse((await saveFixture(
    workspaceDir,
    "creator_preview",
    "creator-preview.xlsx",
  )).content[0].text);
  assert.equal(result.success, false);
  assert.equal(result.error.code, "YPSCAN_EXCEL_INVALID_INPUT");
});

test("Excel download accepts HTTPS URLs under eshypdata.com", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-trusted-download-url-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const excelFileUrl =
    "https://test-agenta.eshypdata.com/api/mcp-tools/rank-mcns-exports/ranking.xlsx";
  let fetchedUrl = null;
  const result = JSON.parse((await saveExcelArtifact({
    artifact_kind: "mcn_ranking",
    artifact_id: "artifact-trusted-url",
    excel_file_url: excelFileUrl,
  }, {
    workspaceDir,
    fetchImpl: async (url) => {
      fetchedUrl = url;
      return new Response(Buffer.from("xlsx-ranking"), { status: 200 });
    },
    retryDelaysMs: [],
  })).content[0].text);

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
    const result = JSON.parse((await saveExcelArtifact({
      artifact_kind: "submission_batch",
      artifact_id: "artifact-invalid-url",
      excel_file_url: excelFileUrl,
    }, {
      workspaceDir,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response();
      },
    })).content[0].text);
    assert.equal(result.error.code, "YPSCAN_EXCEL_DOWNLOAD_URL_INVALID");
  }
  assert.equal(fetchCalls, 0);
});

test("Excel download uses the configured finite retry schedule", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ypscan-download-retry-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  let attempts = 0;
  const result = JSON.parse((await saveExcelArtifact({
    artifact_kind: "submission_batch",
    artifact_id: "artifact-retry",
    excel_file_url: "https://mcp.eshypdata.com/api/download?file_path=retry.xlsx",
  }, {
    workspaceDir,
    retryDelaysMs: [0],
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("temporary", { status: 503 })
        : new Response(Buffer.from("xlsx-retry"), { status: 200 });
    },
  })).content[0].text);

  assert.equal(result.success, true);
  assert.equal(result.data.download_attempts, 2);
});

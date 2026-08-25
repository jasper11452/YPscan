import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { hostToolResult } from "./tool-result.js";
import { nonemptyString } from "../util/value.js";
import { excelArtifactTestDownloadUrl } from "./test-adapter.js";
import { submissionEnrichmentQuestionPayload } from "./post-save-questions.js";

export const EXCEL_ARTIFACT_KINDS = Object.freeze([
  "submission_batch",
  "creator_detail_export",
  "mcn_ranking",
  "mcn_creator_preview",
  "manual_source",
]);
export const MAX_EXCEL_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const EXCEL_ARTIFACT_TIMEOUT_MS = 20_000;
export const EXCEL_ARTIFACT_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000]);

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

function downloadFailureCode(error) {
  if (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    error?.cause?.name === "TimeoutError" ||
    error?.cause?.name === "AbortError"
  ) {
    return "YPSCAN_EXCEL_DOWNLOAD_TIMEOUT";
  }
  const detail = `${error?.message ?? ""} ${error?.cause?.message ?? ""}`;
  return /redirect/iu.test(detail)
    ? "YPSCAN_EXCEL_REDIRECT_FORBIDDEN"
    : "YPSCAN_EXCEL_DOWNLOAD_FAILED";
}

function failure(code, message, reason = code, {
  retriable = false,
  details = {},
} = {}) {
  const payload = {
    success: false,
    error: {
      code,
      message,
      details: { reason, ...details },
      retriable,
    },
  };
  return hostToolResult(payload, { details: payload.error.details });
}

function success(details, artifactKind) {
  const initialSubmission = artifactKind === "submission_batch";
  const delivery = {
    local_path: details.file_path,
    display_required: true,
    display_before_next_action: true,
    user_visible_message: `已完成：Excel 已保存到本地。\n本地路径：${details.file_path}`,
    ...(initialSubmission
      ? {
            next_tool: "AskUserQuestion",
            next_args: submissionEnrichmentQuestionPayload(),
            next_action:
              "提报表已生成；展示本地绝对路径后立即按 next_args 询问是否补充更新达人信息",
          }
      : {}),
  };
  return hostToolResult(
    { success: true, data: details, delivery },
    { details },
  );
}

export function validateExcelDownloadUrl(value) {
  if (!nonemptyString(value)) return false;
  try {
    const parsed = new URL(value);
    const trustedHostname =
      parsed.hostname === "eshypdata.com" || parsed.hostname.endsWith(".eshypdata.com");
    return parsed.protocol === "https:" &&
      trustedHostname &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === "";
  } catch {
    return false;
  }
}

function safeExcelNameFromPath(value) {
  if (!nonemptyString(value)) return null;
  const name = value.trim().split(/[\\/]/).at(-1);
  return nonemptyString(name) && /^[^/\\]+\.xlsx$/iu.test(name)
    ? name
    : null;
}

function excelFileNameFromDownloadUrl(excelFileUrl, artifactKind) {
  const parsedUrl = new URL(excelFileUrl);
  const filePath = parsedUrl.searchParams.get("file_path");
  const direct = safeExcelNameFromPath(filePath);
  if (direct) return direct;
  // Path-style download endpoints (e.g. the creator-detail-export export) carry
  // the filename in the URL path; fall back to the trailing .xlsx segment.
  let fromPath;
  try {
    fromPath = safeExcelNameFromPath(decodeURIComponent(parsedUrl.pathname));
  } catch {
    fromPath = null;
  }
  if (fromPath) return fromPath;
  try {
    const decoded = Buffer.from(filePath, "base64").toString("utf8");
    const fromBase64 = safeExcelNameFromPath(decoded);
    if (fromBase64) return fromBase64;
  } catch {
    // Fall through to a deterministic local filename.
  }
  const suffix = createHash("sha256").update(excelFileUrl).digest("hex").slice(0, 16);
  return `${artifactKind}-${suffix}.xlsx`;
}

async function responseBuffer(response, maxBytes) {
  const declaredLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, code: "YPSCAN_EXCEL_TOO_LARGE" };
  }
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, code: "YPSCAN_EXCEL_TOO_LARGE" };
        }
        chunks.push(chunk);
      }
    } catch (error) {
      return { ok: false, code: downloadFailureCode(error) };
    } finally {
      reader.releaseLock?.();
    }
    return { ok: true, buffer: Buffer.concat(chunks, total) };
  }
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > maxBytes
      ? { ok: false, code: "YPSCAN_EXCEL_TOO_LARGE" }
      : { ok: true, buffer };
  } catch (error) {
    return { ok: false, code: downloadFailureCode(error) };
  }
}

function retryAfterDelayMs(response, nowMs) {
  const value = response?.headers?.get?.("retry-after");
  if (!nonemptyString(value)) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function jitteredDelayMs(delayMs, randomImpl) {
  const sample = Math.min(1, Math.max(0, Number(randomImpl?.()) || 0));
  return Math.round(delayMs * (0.8 + sample * 0.4));
}

function retryableDownloadFailure(code, status) {
  if (Number.isInteger(status)) return RETRYABLE_HTTP_STATUSES.has(status);
  return code === "YPSCAN_EXCEL_DOWNLOAD_FAILED" ||
    code === "YPSCAN_EXCEL_DOWNLOAD_TIMEOUT";
}

async function downloadExcelBuffer(excelFileUrl, {
  fetchImpl,
  maxBytes,
  timeoutMs,
  retryDelaysMs,
  sleepImpl,
  clock,
  randomImpl,
}) {
  const startedAt = clock();
  let attempts = 0;
  let lastFailure = null;
  for (let index = 0; index <= retryDelaysMs.length; index += 1) {
    const remainingMs = timeoutMs - Math.max(0, clock() - startedAt);
    if (remainingMs <= 0) break;
    attempts += 1;
    let response = null;
    try {
      response = await fetchImpl(excelFileUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, remainingMs)),
      });
      if (response?.status >= 300 && response.status < 400) {
        return {
          ok: false,
          code: "YPSCAN_EXCEL_REDIRECT_FORBIDDEN",
          status: response.status,
          attempts,
          retriable: false,
        };
      }
      if (!response?.ok) {
        lastFailure = {
          ok: false,
          code: "YPSCAN_EXCEL_DOWNLOAD_FAILED",
          status: response?.status ?? null,
          attempts,
          retriable: retryableDownloadFailure(
            "YPSCAN_EXCEL_DOWNLOAD_FAILED",
            response?.status,
          ),
        };
      } else {
        const downloaded = await responseBuffer(response, maxBytes);
        if (downloaded.ok) {
          return { ...downloaded, attempts, status: response.status };
        }
        lastFailure = {
          ...downloaded,
          status: response.status,
          attempts,
          retriable: retryableDownloadFailure(downloaded.code, null),
        };
      }
    } catch (error) {
      const code = downloadFailureCode(error);
      lastFailure = {
        ok: false,
        code,
        status: null,
        attempts,
        retriable: retryableDownloadFailure(code, null),
      };
    }
    if (!lastFailure.retriable || index >= retryDelaysMs.length) break;
    const retryAfterMs = retryAfterDelayMs(response, clock());
    const delayMs = retryAfterMs ?? jitteredDelayMs(
      retryDelaysMs[index],
      randomImpl,
    );
    const budgetRemainingMs = timeoutMs - Math.max(0, clock() - startedAt);
    if (delayMs >= budgetRemainingMs) break;
    await sleepImpl(delayMs);
  }
  return lastFailure ?? {
    ok: false,
    code: "YPSCAN_EXCEL_DOWNLOAD_TIMEOUT",
    status: null,
    attempts,
    retriable: true,
  };
}

async function existingFileState(targetPath, expectedSha256) {
  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { ok: false, code: "YPSCAN_EXCEL_SAVE_UNSAFE_PATH" };
    }
    if (info.size <= 0 || info.size > MAX_EXCEL_ARTIFACT_BYTES) {
      return { ok: false, code: "YPSCAN_EXCEL_SAVE_CONFLICT" };
    }
    const existing = await readFile(targetPath);
    const sha256 = createHash("sha256").update(existing).digest("hex");
    return sha256 === expectedSha256
      ? { ok: true, idempotent: true, size: info.size }
      : { ok: false, code: "YPSCAN_EXCEL_SAVE_CONFLICT" };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { ok: true, idempotent: false }
      : { ok: false, code: "YPSCAN_EXCEL_SAVE_UNSAFE_PATH" };
  }
}

async function publishWithoutOverwrite(tempPath, targetPath, sha256) {
  const existing = await existingFileState(targetPath, sha256);
  if (!existing.ok || existing.idempotent) return existing;
  try {
    await link(tempPath, targetPath);
    return { ok: true, idempotent: false };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      return { ok: false, code: "YPSCAN_EXCEL_SAVE_FAILED" };
    }
    return existingFileState(targetPath, sha256);
  }
}

/**
 * @param {any} params
 * @param {{
 *   workspaceDir?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   retryDelaysMs?: readonly number[],
 *   sleepImpl?: (delayMs: number) => Promise<any>,
 *   clock?: () => number,
 *   randomImpl?: () => number,
 *   testAdapterBaseUrl?: string | null,
 * }} [options]
 */
export async function saveExcelArtifact(params, {
  workspaceDir,
  fetchImpl = globalThis.fetch,
  timeoutMs = EXCEL_ARTIFACT_TIMEOUT_MS,
  maxBytes = MAX_EXCEL_ARTIFACT_BYTES,
  retryDelaysMs = EXCEL_ARTIFACT_RETRY_DELAYS_MS,
  sleepImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  clock = Date.now,
  randomImpl = Math.random,
  testAdapterBaseUrl = null,
} = {}) {
  const artifactKind = params?.artifact_kind;
  const artifactId = params?.artifact_id;
  const excelFileUrl = params?.excel_file_url;
  if (
    !EXCEL_ARTIFACT_KINDS.includes(artifactKind) ||
    !nonemptyString(artifactId) ||
    !nonemptyString(excelFileUrl)
  ) {
    return failure(
      "YPSCAN_EXCEL_INVALID_INPUT",
      "artifact_kind、artifact_id 和 excel_file_url 必须完整且有效",
    );
  }
  if (!validateExcelDownloadUrl(excelFileUrl)) {
    return failure(
      "YPSCAN_EXCEL_DOWNLOAD_URL_INVALID",
      "excel_file_url 必须是 eshypdata.com 主域下的 HTTPS 下载地址",
    );
  }
  const fileName = excelFileNameFromDownloadUrl(excelFileUrl, artifactKind);
  if (
    basename(fileName) !== fileName ||
    fileName.includes("\\") ||
    extname(fileName).toLowerCase() !== ".xlsx"
  ) {
    return failure(
      "YPSCAN_EXCEL_FILE_NAME_INVALID",
      "从下载地址推导出的 Excel 文件名不安全",
    );
  }
  if (!nonemptyString(workspaceDir) || !isAbsolute(workspaceDir)) {
    return failure(
      "YPSCAN_WORKSPACE_UNAVAILABLE",
      "宿主未提供可信的当前项目目录",
    );
  }
  if (typeof fetchImpl !== "function") {
    return failure(
      "YPSCAN_EXCEL_DOWNLOAD_UNAVAILABLE",
      "当前运行环境不支持受控下载",
    );
  }

  let workspacePath;
  try {
    await mkdir(workspaceDir, { recursive: true });
    workspacePath = await realpath(workspaceDir);
    const workspaceInfo = await stat(workspacePath);
    if (!workspaceInfo.isDirectory()) throw new Error("not_directory");
  } catch {
    return failure(
      "YPSCAN_WORKSPACE_UNAVAILABLE",
      "当前项目目录不可用",
    );
  }
  const targetPath = join(workspacePath, fileName);
  const tempPath = join(
    workspacePath,
    `.${fileName}.ypscan-${randomUUID()}.tmp`,
  );
  let tempCreated = false;
  try {
    const downloaded = await downloadExcelBuffer(
      excelArtifactTestDownloadUrl(testAdapterBaseUrl, excelFileUrl), {
        fetchImpl,
        maxBytes,
        timeoutMs,
        retryDelaysMs,
        sleepImpl,
        clock,
        randomImpl,
      },
    );
    if (!downloaded.ok) {
      return failure(
        downloaded.code,
        downloaded.code === "YPSCAN_EXCEL_TOO_LARGE"
          ? "Excel 超过 20 MiB 上限"
          : downloaded.code === "YPSCAN_EXCEL_DOWNLOAD_TIMEOUT"
            ? "Excel 下载超过总时间限制"
            : downloaded.code === "YPSCAN_EXCEL_REDIRECT_FORBIDDEN"
              ? "Excel 下载禁止重定向"
              : Number.isInteger(downloaded.status)
                ? `Excel 下载返回 HTTP ${downloaded.status}`
                : "无法读取 Excel 下载内容",
        downloaded.code,
        {
          retriable: downloaded.retriable,
          details: {
            attempts: downloaded.attempts,
            ...(Number.isInteger(downloaded.status)
              ? { http_status: downloaded.status }
              : {}),
          },
        },
      );
    }
    const buffer = downloaded.buffer;
    if (buffer.length <= 0) {
      return failure("YPSCAN_EXCEL_INVALID_XLSX", "Excel 下载内容为空");
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const tempHandle = await open(tempPath, "wx", 0o600);
    tempCreated = true;
    try {
      await tempHandle.writeFile(buffer);
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    const published = await publishWithoutOverwrite(
      tempPath,
      targetPath,
      sha256,
    );
    if (!published.ok) {
      return failure(
        published.code,
        published.code === "YPSCAN_EXCEL_SAVE_CONFLICT"
          ? "目标文件已存在且内容不同，拒绝覆盖"
          : "Excel 无法安全发布到当前项目",
      );
    }
    const details = {
      file_name: fileName,
      file_path: targetPath,
      byte_count: buffer.length,
      sha256,
      idempotent: published.idempotent,
      download_attempts: downloaded.attempts,
    };
    return success(details, artifactKind);
  } catch {
    return failure(
      "YPSCAN_EXCEL_SAVE_FAILED",
      "Excel 保存过程中发生本地错误",
    );
  } finally {
    if (tempCreated) await unlink(tempPath).catch(() => {});
  }
}

/**
 * @param {{ workspaceDir?: string, fetchImpl?: typeof fetch, testAdapterBaseUrl?: string | null }} options
 */
export function createExcelArtifactSaver({
  workspaceDir,
  fetchImpl,
  testAdapterBaseUrl = null,
}) {
  return (params) => saveExcelArtifact(params, {
    workspaceDir,
    fetchImpl,
    testAdapterBaseUrl,
  });
}

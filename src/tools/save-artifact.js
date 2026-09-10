import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostToolResult } from "./tool-result.js";
import { nonemptyString } from "../util/value.js";
import { artifactTestDownloadUrl } from "./test-adapter.js";
import { mcnRankingRecipientQuestionPayload } from "./popup-questions.js";

const ARTIFACT_EXTENSIONS = {
  creator_detail_export: ".xlsx",
  mcn_ranking: ".xlsx",
  mcn_creator_preview: ".xlsx",
  manual_source: ".xlsx",
  manual_score_batch: ".xlsx",
  ranked_submission: ".xlsx",
  manual_creator_links: ".csv",
  mcn_creator_links: ".csv",
};

export const ARTIFACT_KINDS = Object.freeze(Object.keys(ARTIFACT_EXTENSIONS));
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const ARTIFACT_TIMEOUT_MS = 20_000;
const ARTIFACT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

function failure(code, message, reason = code, { retriable = false, details = {} } = {}) {
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

function success(details, artifactKind, params, format) {
  const localFileLink = localFileMarkdownLink(details.file_path);
  // links CSV 是补全、合并与上传的中间输入；manual_score_batch 是分批汇总前的
  // 单批评分表。默认内部使用；询价误存的最终交付由持有需求模式的 Hook 决定。
  const internalOnly =
    ARTIFACT_EXTENSIONS[artifactKind] === ".csv" || artifactKind === "manual_score_batch";
  const delivery = {
    local_path: details.file_path,
    local_file_link: localFileLink,
    display_required: !internalOnly,
    display_before_next_action: !internalOnly,
    user_visible_message: internalOnly
      ? `${format} 已保存到本地，作为后续步骤的内部输入，不向用户展示文件路径、链接或表格。`
      : `已完成：${format} 已保存到本地。\n本地文件：${localFileLink}`,
  };
  if (artifactKind === "manual_score_batch") {
    delivery.user_visible_message +=
      "仅当 Hook 确认当前需求为询价误存并指示最终交付时，展示本次真实评分表。";
  }
  const nextArgs =
    artifactKind === "mcn_ranking" ? mcnRankingRecipientQuestionPayload(params?.mcn_names) : null;
  if (nextArgs) {
    delivery.next_tool = "AskUserQuestion";
    delivery.next_args = nextArgs;
    delivery.next_action = "MCN 排名表已保存；展示本地文件链接后按 next_args 选择询价收件机构";
  }
  return hostToolResult({ success: true, data: details, delivery }, { details });
}

/**
 * @param {string} filePath
 */
export function localFileMarkdownLink(filePath) {
  if (!nonemptyString(filePath) || !isAbsolute(filePath)) return null;
  const label = filePath.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `[${label}](<${pathToFileURL(filePath).href}>)`;
}

function validateArtifactDownloadUrl(value) {
  if (!nonemptyString(value)) return false;
  try {
    const parsed = new URL(value);
    const trustedHostname =
      parsed.hostname === "eshypdata.com" || parsed.hostname.endsWith(".eshypdata.com");
    return (
      parsed.protocol === "https:" &&
      trustedHostname &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function safeArtifactNameFromPath(value, extension) {
  if (!nonemptyString(value)) return null;
  const name = value.trim().split(/[\\/]/).at(-1);
  return nonemptyString(name) && name.toLowerCase().endsWith(extension) ? name : null;
}

// Provider 的评分导出文件名是需求/内容哈希串（如 manual_source_score_<hash>_<hash>.xlsx），
// 用户无法分辨是哪张表；这两类评分表统一改用本地可读名。汇总表使用同一命名规则。
/** @type {Readonly<Record<string, string>>} */
const READABLE_ARTIFACT_LABELS = {
  manual_source: "达人评分排序表",
  manual_score_batch: "手动拓展评分表",
};
const PROJECT_NAME_MAX_LENGTH = 20;

/**
 * 项目名是调用方生成的自由文本，只用于本地文件名：清洗非法字符、折叠空白、按长度截断，失败返回 null。
 * @param {unknown} value
 */
export function safeNameSegment(value) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  const characters = [...cleaned];
  return characters.length > PROJECT_NAME_MAX_LENGTH
    ? characters.slice(0, PROJECT_NAME_MAX_LENGTH).join("")
    : cleaned;
}

/** 本地时间戳 `YYYYMMDD-HHmmss`。 */
function localTimeStamp(now) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * 本地可读文件名：`<项目名>-<标签>-<YYYYMMDD-HHmmss>.xlsx`，没有项目名时省略第一段。
 * @param {string} label
 * @param {unknown} projectName
 * @param {Date} [now]
 */
export function readableArtifactFileName(label, projectName, now = new Date()) {
  const project = safeNameSegment(projectName);
  return `${project ? `${project}-` : ""}${label}-${localTimeStamp(now)}.xlsx`;
}

function artifactFileNameFromDownloadUrl(fileUrl, artifactKind, extension) {
  const parsedUrl = new URL(fileUrl);
  const filePath = parsedUrl.searchParams.get("file_path");
  const candidates = [filePath];
  try {
    candidates.push(decodeURIComponent(parsedUrl.pathname));
  } catch {
    candidates.push(null);
  }
  if (extension === ".xlsx" && nonemptyString(filePath)) {
    try {
      candidates.push(Buffer.from(filePath, "base64").toString("utf8"));
    } catch {
      candidates.push(null);
    }
  }
  for (const candidate of candidates) {
    const name = safeArtifactNameFromPath(candidate, extension);
    if (name) return name;
  }
  const suffix = createHash("sha256").update(fileUrl).digest("hex").slice(0, 16);
  return `${artifactKind}-${suffix}${extension}`;
}

function downloadFailureCode(error) {
  if (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    error?.cause?.name === "TimeoutError" ||
    error?.cause?.name === "AbortError"
  ) {
    return "YPSCAN_ARTIFACT_DOWNLOAD_TIMEOUT";
  }
  const detail = `${error?.message ?? ""} ${error?.cause?.message ?? ""}`;
  return /redirect/iu.test(detail)
    ? "YPSCAN_ARTIFACT_REDIRECT_FORBIDDEN"
    : "YPSCAN_ARTIFACT_DOWNLOAD_FAILED";
}

async function responseBuffer(response) {
  const declaredLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) {
    return { ok: false, code: "YPSCAN_ARTIFACT_TOO_LARGE" };
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
        if (total > MAX_ARTIFACT_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, code: "YPSCAN_ARTIFACT_TOO_LARGE" };
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
    return buffer.length > MAX_ARTIFACT_BYTES
      ? { ok: false, code: "YPSCAN_ARTIFACT_TOO_LARGE" }
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
  return code === "YPSCAN_ARTIFACT_DOWNLOAD_FAILED" || code === "YPSCAN_ARTIFACT_DOWNLOAD_TIMEOUT";
}

async function downloadArtifactBuffer(fileUrl, { fetchImpl, retryDelaysMs, sleepImpl }) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastFailure = null;
  for (let index = 0; index <= retryDelaysMs.length; index += 1) {
    const remainingMs = ARTIFACT_TIMEOUT_MS - Math.max(0, Date.now() - startedAt);
    if (remainingMs <= 0) break;
    attempts += 1;
    let response = null;
    try {
      response = await fetchImpl(fileUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, remainingMs)),
      });
      if (response?.status >= 300 && response.status < 400) {
        return {
          ok: false,
          code: "YPSCAN_ARTIFACT_REDIRECT_FORBIDDEN",
          status: response.status,
          attempts,
          retriable: false,
        };
      }
      if (!response?.ok) {
        lastFailure = {
          ok: false,
          code: "YPSCAN_ARTIFACT_DOWNLOAD_FAILED",
          status: response?.status ?? null,
          attempts,
          retriable: retryableDownloadFailure("YPSCAN_ARTIFACT_DOWNLOAD_FAILED", response?.status),
        };
      } else {
        const downloaded = await responseBuffer(response);
        if (downloaded.ok) return { ...downloaded, attempts, status: response.status };
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
    const retryAfterMs = retryAfterDelayMs(response, Date.now());
    const delayMs = retryAfterMs ?? jitteredDelayMs(retryDelaysMs[index], Math.random);
    const budgetRemainingMs = ARTIFACT_TIMEOUT_MS - Math.max(0, Date.now() - startedAt);
    if (delayMs >= budgetRemainingMs) break;
    await sleepImpl(delayMs);
  }
  return (
    lastFailure ?? {
      ok: false,
      code: "YPSCAN_ARTIFACT_DOWNLOAD_TIMEOUT",
      status: null,
      attempts,
      retriable: true,
    }
  );
}

async function existingFileState(targetPath, expectedSha256) {
  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { ok: false, code: "YPSCAN_ARTIFACT_SAVE_UNSAFE_PATH" };
    }
    if (info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) {
      return { ok: false, code: "YPSCAN_ARTIFACT_SAVE_CONFLICT" };
    }
    const existing = await readFile(targetPath);
    const sha256 = createHash("sha256").update(existing).digest("hex");
    return sha256 === expectedSha256
      ? { ok: true, idempotent: true, size: info.size }
      : { ok: false, code: "YPSCAN_ARTIFACT_SAVE_CONFLICT" };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { ok: true, idempotent: false }
      : { ok: false, code: "YPSCAN_ARTIFACT_SAVE_UNSAFE_PATH" };
  }
}

export async function publishWithoutOverwrite(tempPath, targetPath, sha256) {
  const existing = await existingFileState(targetPath, sha256);
  if (!existing.ok || existing.idempotent) return existing;
  try {
    await link(tempPath, targetPath);
    return { ok: true, idempotent: false };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      return { ok: false, code: "YPSCAN_ARTIFACT_SAVE_FAILED" };
    }
    return existingFileState(targetPath, sha256);
  }
}

/**
 * 发布可读名交付文件：同一时间戳下出现不同内容时在文件名末尾补内容哈希再发布一次，
 * 始终不覆盖已有文件；同内容重复发布幂等复用。
 * @param {string} tempPath
 * @param {string} workspacePath
 * @param {string} fileName
 * @param {string} sha256
 */
export async function publishReadableArtifact(tempPath, workspacePath, fileName, sha256) {
  const targetPath = join(workspacePath, fileName);
  const attempt = await publishWithoutOverwrite(tempPath, targetPath, sha256);
  if (attempt.ok || attempt.code !== "YPSCAN_ARTIFACT_SAVE_CONFLICT") {
    return { ...attempt, fileName, filePath: targetPath };
  }
  const fallbackName = fileName.replace(/\.xlsx$/u, `-${sha256.slice(0, 8)}.xlsx`);
  const fallbackPath = join(workspacePath, fallbackName);
  return {
    ...(await publishWithoutOverwrite(tempPath, fallbackPath, sha256)),
    fileName: fallbackName,
    filePath: fallbackPath,
  };
}

/**
 * @param {any} params
 * @param {{
 *   workspaceDir?: string,
 *   fetchImpl?: typeof fetch,
 *   retryDelaysMs?: readonly number[],
 *   sleepImpl?: (delayMs: number) => Promise<any>,
 *   testAdapterBaseUrl?: string | null,
 *   projectName?: string | null,
 *   now?: () => Date,
 * }} [options]
 */
export async function saveArtifact(
  params,
  {
    workspaceDir,
    fetchImpl = globalThis.fetch,
    retryDelaysMs = ARTIFACT_RETRY_DELAYS_MS,
    sleepImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    testAdapterBaseUrl = null,
    projectName = null,
    now = () => new Date(),
  } = {},
) {
  const artifactKind = params?.artifact_kind;
  const artifactId = params?.artifact_id;
  const fileUrl = params?.file_url;
  const extension = ARTIFACT_EXTENSIONS[artifactKind];
  if (!extension || !nonemptyString(artifactId) || !nonemptyString(fileUrl)) {
    return failure(
      "YPSCAN_ARTIFACT_INVALID_INPUT",
      "artifact_kind、artifact_id 和 file_url 必须完整且有效",
    );
  }
  if (!validateArtifactDownloadUrl(fileUrl)) {
    return failure(
      "YPSCAN_ARTIFACT_DOWNLOAD_URL_INVALID",
      "file_url 必须是 eshypdata.com 主域下的 HTTPS 下载地址",
    );
  }
  const format = extension === ".xlsx" ? "Excel" : "CSV";
  const readableLabel = READABLE_ARTIFACT_LABELS[artifactKind];
  if (!nonemptyString(workspaceDir) || !isAbsolute(workspaceDir)) {
    return failure("YPSCAN_WORKSPACE_UNAVAILABLE", "宿主未提供可信的当前项目目录");
  }
  if (typeof fetchImpl !== "function") {
    return failure("YPSCAN_ARTIFACT_DOWNLOAD_UNAVAILABLE", "当前运行环境不支持受控下载");
  }

  let workspacePath;
  try {
    await mkdir(workspaceDir, { recursive: true });
    workspacePath = await realpath(workspaceDir);
    const workspaceInfo = await stat(workspacePath);
    if (!workspaceInfo.isDirectory()) throw new Error("not_directory");
  } catch {
    return failure("YPSCAN_WORKSPACE_UNAVAILABLE", "当前项目目录不可用");
  }

  const tempPath = join(workspacePath, `.ypscan-${randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    const downloaded = await downloadArtifactBuffer(
      artifactTestDownloadUrl(testAdapterBaseUrl, fileUrl),
      {
        fetchImpl,
        retryDelaysMs,
        sleepImpl,
      },
    );
    if (!downloaded.ok) {
      return failure(
        downloaded.code,
        downloaded.code === "YPSCAN_ARTIFACT_TOO_LARGE"
          ? `${format} 超过 20 MiB 上限`
          : downloaded.code === "YPSCAN_ARTIFACT_DOWNLOAD_TIMEOUT"
            ? `${format} 下载超过总时间限制`
            : downloaded.code === "YPSCAN_ARTIFACT_REDIRECT_FORBIDDEN"
              ? `${format} 下载禁止重定向`
              : Number.isInteger(downloaded.status)
                ? `${format} 下载返回 HTTP ${downloaded.status}`
                : `无法读取 ${format} 下载内容`,
        downloaded.code,
        {
          retriable: downloaded.retriable,
          details: {
            attempts: downloaded.attempts,
            ...(Number.isInteger(downloaded.status) ? { http_status: downloaded.status } : {}),
          },
        },
      );
    }
    const buffer = downloaded.buffer;
    if (buffer.length <= 0) {
      return failure("YPSCAN_ARTIFACT_INVALID_CONTENT", `${format} 下载内容为空`);
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const readableName = readableLabel
      ? readableArtifactFileName(readableLabel, projectName, now())
      : null;
    const fileName =
      readableName ?? artifactFileNameFromDownloadUrl(fileUrl, artifactKind, extension);
    const targetPath = join(workspacePath, fileName);
    const tempHandle = await open(tempPath, "wx", 0o600);
    tempCreated = true;
    try {
      await tempHandle.writeFile(buffer);
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    const published = readableName
      ? await publishReadableArtifact(tempPath, workspacePath, fileName, sha256)
      : {
          ...(await publishWithoutOverwrite(tempPath, targetPath, sha256)),
          fileName,
          filePath: targetPath,
        };
    if (!published.ok) {
      return failure(
        published.code,
        published.code === "YPSCAN_ARTIFACT_SAVE_CONFLICT"
          ? "目标文件已存在且内容不同，拒绝覆盖"
          : `${format} 无法安全发布到当前项目`,
      );
    }
    const details = {
      artifact_kind: artifactKind,
      artifact_id: artifactId,
      file_name: published.fileName,
      file_path: published.filePath,
      byte_count: buffer.length,
      sha256,
      idempotent: published.idempotent,
      download_attempts: downloaded.attempts,
    };
    return success(details, artifactKind, params, format);
  } catch {
    return failure("YPSCAN_ARTIFACT_SAVE_FAILED", `${format} 保存过程中发生本地错误`);
  } finally {
    if (tempCreated) await unlink(tempPath).catch(() => {});
  }
}

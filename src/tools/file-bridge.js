import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import OSS from "ali-oss";
import { mergeCreatorCsvFiles } from "./merge-creator-csv.js";
import { localFileMarkdownLink } from "./save-artifact.js";
import { hostToolResult } from "./tool-result.js";
import { isRecord, nonemptyString } from "../util/value.js";

const FILE_BRIDGE_CONFIG_FIELDS = Object.freeze([
  {
    resultKey: "accessKeyId",
    pluginKey: "accessKeyId",
    envKey: "AccessKeyId",
    label: "fileBridgeOss.accessKeyId / 打包内置凭据 / AccessKeyId",
  },
  {
    resultKey: "accessKeySecret",
    pluginKey: "accessKeySecret",
    envKey: "AccessKeySecret",
    label: "fileBridgeOss.accessKeySecret / 打包内置凭据 / AccessKeySecret",
  },
  {
    resultKey: "region",
    pluginKey: "region",
    envKey: "Region",
    label: "fileBridgeOss.region / 打包内置凭据 / Region",
  },
  {
    resultKey: "bucket",
    pluginKey: "bucket",
    envKey: "Bucket",
    label: "fileBridgeOss.bucket / 打包内置凭据 / Bucket",
  },
  {
    resultKey: "objectPrefix",
    pluginKey: "objectPrefix",
    envKey: "Object",
    label: "fileBridgeOss.objectPrefix / 打包内置凭据 / Object",
  },
]);
const OSS_DEFAULTS = Object.freeze({
  region: "oss-cn-shanghai",
  bucket: "ypmisc",
  objectPrefix: "action",
});
const PUBLIC_URL_CHECK_RETRY_DELAYS_MS = Object.freeze([500, 1_000, 2_000]);

// merged CSV 是打分或精排前的内部中间产物，默认不要求展示；只有遗留
// `mcn_complete_only` 分支的本地 merged CSV 就是该分支的唯一产物。
function localDelivery(filePath, message, { display = false } = {}) {
  const localFileLink = localFileMarkdownLink(filePath);
  return {
    local_file_path: filePath,
    local_file_link: localFileLink,
    display_required: display,
    display_before_next_action: display,
    user_visible_message: display ? `${message}\n本地文件：${localFileLink}` : message,
  };
}

function failure(code, message, details = {}, retriable = false, filePath = null) {
  return hostToolResult(
    {
      success: false,
      error: {
        code,
        message,
        details,
        retriable,
      },
      ...(nonemptyString(filePath)
        ? { delivery: localDelivery(filePath, "数据已合并，但后续处理失败。") }
        : {}),
    },
    { details, isError: true },
  );
}

function success(details) {
  const message = nonemptyString(details?.csv_file_path) ? "数据已合并上传。" : "数据已合并。";
  return hostToolResult(
    {
      success: true,
      data: details,
      delivery: localDelivery(details.file_path, message, {
        display: details?.flow === "mcn_complete_only",
      }),
    },
    { details },
  );
}

function normalizeObjectPrefix(prefix) {
  const trimmed = typeof prefix === "string" ? prefix.trim() : "";
  const normalized = trimmed.replace(/^\/+|\/+$/gu, "");
  return normalized ? `${normalized}/` : "";
}

function pluginFileBridgeOssConfig(pluginConfig) {
  return isRecord(pluginConfig?.fileBridgeOss) ? pluginConfig.fileBridgeOss : null;
}

function resolvedConfigValue(pluginValues, bundledValues, env, field) {
  if (nonemptyString(pluginValues?.[field.pluginKey])) {
    return String(pluginValues[field.pluginKey]).trim();
  }
  if (nonemptyString(bundledValues?.[field.pluginKey])) {
    return String(bundledValues[field.pluginKey]).trim();
  }
  if (nonemptyString(env?.[field.envKey])) {
    return String(env[field.envKey]).trim();
  }
  return "";
}

function validateConfigValue(field, value) {
  if (!nonemptyString(value)) return `${field.label} 缺失`;
  if (field.resultKey === "objectPrefix" && !normalizeObjectPrefix(value)) {
    return `${field.label} 前缀为空`;
  }
  return null;
}

async function readBundledDefaults(readFileImpl) {
  try {
    const text = await readFileImpl(
      new URL("./file-bridge-oss-defaults.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 配置读取顺序：插件配置 `fileBridgeOss` → 打包内置凭据（prepack 注入，见
 * scripts/prepare-oss-bundle.mjs）→ 调用方显式注入的 env 配置；不读取宿主进程环境变量。`region`/`bucket`/
 * `objectPrefix` 最后回落到内置非敏感默认值，只有 AK/SK 缺失才报配置缺失。
 * `bundled` 传 null 时禁用打包凭据；省略时按默认路径读取内置文件（不存在则忽略）。
 * @param {{
 *   pluginConfig?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   bundled?: Record<string, unknown> | null,
 *   readBundledImpl?: typeof readFile,
 * }} [options]
 */
export async function loadFileBridgeConfig({
  pluginConfig = {},
  env = {},
  bundled,
  readBundledImpl = readFile,
} = {}) {
  const pluginValues = pluginFileBridgeOssConfig(pluginConfig);
  const bundledValues =
    bundled === undefined ? await readBundledDefaults(readBundledImpl) : bundled;
  const raw = Object.fromEntries(
    FILE_BRIDGE_CONFIG_FIELDS.map((field) => [
      field.resultKey,
      resolvedConfigValue(pluginValues, bundledValues, env, field),
    ]),
  );
  const resolved = {
    accessKeyId: raw.accessKeyId,
    accessKeySecret: raw.accessKeySecret,
    region: raw.region || OSS_DEFAULTS.region,
    bucket: raw.bucket || OSS_DEFAULTS.bucket,
    objectPrefix: raw.objectPrefix || OSS_DEFAULTS.objectPrefix,
  };
  const problems = FILE_BRIDGE_CONFIG_FIELDS.flatMap((field) => {
    const problem = validateConfigValue(field, resolved[field.resultKey]);
    return problem ? [problem] : [];
  });
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    config: {
      accessKeyId: resolved.accessKeyId,
      accessKeySecret: resolved.accessKeySecret,
      region: resolved.region,
      bucket: resolved.bucket,
      objectPrefix: normalizeObjectPrefix(resolved.objectPrefix),
    },
  };
}

function publicObjectUrl({ bucket, region }, objectKey) {
  const encodedObjectKey = objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://${bucket}.${region}.aliyuncs.com/${encodedObjectKey}`;
}

function buildObjectKey(objectPrefix, flow, scopeId, sha256) {
  if (!isSafeObjectSegment(scopeId)) {
    throw new TypeError("requirement_id/field_id 不能包含路径分隔符或控制字符");
  }
  return `${objectPrefix}${flow}/${scopeId}/${sha256}.csv`;
}

function isSafeObjectSegment(value) {
  if (!nonemptyString(value)) return false;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint == null || codePoint <= 0x1f) return false;
    if (char === "/" || char === "\\" || char === "?" || char === "#") return false;
  }
  return true;
}

async function sleep(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function probeReadable(method, publicUrl, fetchImpl) {
  const response = await fetchImpl(publicUrl, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.body && typeof response.body.cancel === "function") {
    await response.body.cancel().catch(() => {});
  }
  return response;
}

async function ensurePublicUrlReadable(
  publicUrl,
  {
    fetchImpl = globalThis.fetch,
    retryDelaysMs = PUBLIC_URL_CHECK_RETRY_DELAYS_MS,
    sleepImpl = sleep,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      code: "YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE",
      details: { reason: "当前运行环境不支持匿名 URL 校验", public_url: publicUrl, attempts: 0 },
    };
  }
  let attempts = 0;
  let lastStatus = null;
  let lastReason = null;
  for (let index = 0; index <= retryDelaysMs.length; index += 1) {
    attempts += 1;
    try {
      const headResponse = await probeReadable("HEAD", publicUrl, fetchImpl);
      if (headResponse.ok) return { ok: true, attempts };
      lastStatus = headResponse.status;
      if (
        headResponse.status === 405 ||
        headResponse.status === 403 ||
        headResponse.status === 404
      ) {
        const getResponse = await probeReadable("GET", publicUrl, fetchImpl);
        if (getResponse.ok) return { ok: true, attempts };
        lastStatus = getResponse.status;
      }
      lastReason = `HTTP ${lastStatus}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : "匿名 URL 校验失败";
    }
    if (index < retryDelaysMs.length) await sleepImpl(retryDelaysMs[index]);
  }
  return {
    ok: false,
    code: "YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE",
    details: {
      public_url: publicUrl,
      http_status: lastStatus,
      reason: lastReason,
      attempts,
    },
  };
}

function createOssClient(config) {
  return new OSS({
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    secure: true,
  });
}

function isCsvFilePath(value) {
  return nonemptyString(value) && value === value.trim() && /\.csv$/iu.test(value);
}

/** 把宿主返回的本地路径规范为可比较的绝对路径；供 Hook 记录与 file_bridge 校验共用。 */
export function normalizeLocalFilePath(value, workspaceDir) {
  if (!nonemptyString(value) || value !== value.trim()) return "";
  const trimmed = value.trim();
  let absolute = trimmed;
  if (!isAbsolute(trimmed) && nonemptyString(workspaceDir)) {
    absolute = join(workspaceDir, trimmed);
  }
  return normalize(absolute);
}

function csvPathProblems(params) {
  const problems = [];
  if (params?.flow !== "creator_detail" && !isCsvFilePath(params?.links_csv_path)) {
    problems.push({ field: "links_csv_path", path: String(params?.links_csv_path ?? "") });
  }
  for (const path of params?.completion_csv_paths ?? []) {
    if (!isCsvFilePath(path))
      problems.push({ field: "completion_csv_paths", path: String(path ?? "") });
  }
  return problems;
}

function allowedUploadPathSet(getter, requirementId, workspaceDir) {
  if (typeof getter !== "function") return null;
  return new Set(
    (getter(requirementId) ?? [])
      .map((path) => normalizeLocalFilePath(path, workspaceDir))
      .filter(Boolean),
  );
}

/**
 * 上传来源门禁：links CSV 必须是当前 requirement 受控保存的产物，补全 CSV 必须来自
 * 当前 requirement 的 YP Action 原生补全工具。getter 未传入时（直接调用/测试）不门禁。
 */
function blockedUploadSources(
  params,
  { workspaceDir, allowedLinksCsvPaths, allowedCompletionCsvPaths },
) {
  const blocked = [];
  const isCreatorDetail = params?.flow === "creator_detail";
  const scopeId = isCreatorDetail ? params?.field_id : params?.requirement_id;
  if (!isCreatorDetail) {
    const linksAllowed = allowedUploadPathSet(
      allowedLinksCsvPaths,
      params?.requirement_id,
      workspaceDir,
    );
    if (
      linksAllowed &&
      !linksAllowed.has(normalizeLocalFilePath(params?.links_csv_path, workspaceDir))
    ) {
      blocked.push({ field: "links_csv_path", path: String(params?.links_csv_path ?? "") });
    }
  }
  const completionsAllowed = allowedUploadPathSet(
    allowedCompletionCsvPaths,
    scopeId,
    workspaceDir,
  );
  if (completionsAllowed) {
    for (const path of params?.completion_csv_paths ?? []) {
      if (!completionsAllowed.has(normalizeLocalFilePath(path, workspaceDir))) {
        blocked.push({ field: "completion_csv_paths", path: String(path ?? "") });
      }
    }
  }
  return blocked;
}

function hasCsvControlCharacter(text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code != null && code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return true;
    }
  }
  return false;
}

function mergedCsvContentProblems(csvText, flow) {
  const problems = [];
  const headerPrefix = flow === "creator_detail" ? "creator_id" : "source_record_id,creator_id,url";
  if (!nonemptyString(csvText) || !csvText.startsWith(headerPrefix)) {
    problems.push(`merged CSV 表头必须以 ${headerPrefix} 开头`);
  }
  if (typeof csvText === "string" && hasCsvControlCharacter(csvText)) {
    problems.push("merged CSV 内容包含控制字符");
  }
  return problems;
}

/**
 * @param {any} params
 * @param {{
 *   workspaceDir?: string,
 *   pluginConfig?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   bundled?: Record<string, unknown> | null,
 *   readBundledImpl?: typeof readFile,
 *   readFileImpl?: typeof readFile,
 *   fetchImpl?: typeof globalThis.fetch,
 *   createClient?: (config: any) => any,
 *   sleepImpl?: (delayMs: number) => Promise<void>,
 *   retryDelaysMs?: readonly number[],
 *   allowedLinksCsvPaths?: (requirementId: string) => string[] | null,
 *   allowedCompletionCsvPaths?: (requirementId: string) => string[] | null,
 * }} [options]
 */
export async function fileBridge(
  params,
  {
    workspaceDir,
    pluginConfig = {},
    env = {},
    bundled,
    readBundledImpl,
    readFileImpl = readFile,
    fetchImpl = globalThis.fetch,
    createClient = createOssClient,
    sleepImpl = sleep,
    retryDelaysMs = PUBLIC_URL_CHECK_RETRY_DELAYS_MS,
    allowedLinksCsvPaths,
    allowedCompletionCsvPaths,
  } = {},
) {
  const pathProblems = csvPathProblems(params);
  if (pathProblems.length > 0) {
    return failure("YPSCAN_FILE_BRIDGE_INVALID_INPUT", "links 与补全文件必须都是 .csv 文件", {
      invalid_paths: pathProblems,
    });
  }

  const merged = await mergeCreatorCsvFiles(params, { workspaceDir, readFileImpl });
  if (!merged.ok) {
    return failure(merged.code, merged.message, merged.details);
  }

  const { csvText, details: mergedDetails } = merged;
  const { data_row_count: dataRowCount, file_path: filePath, flow } = mergedDetails;

  if (dataRowCount <= 0) {
    return failure(
      "YPSCAN_FILE_BRIDGE_EMPTY",
      "merged CSV 没有可处理的数据行",
      mergedDetails,
      false,
      filePath,
    );
  }
  if (flow === "mcn_complete_only" || dataRowCount > 500) {
    return success({
      ...mergedDetails,
      ...(dataRowCount > 500 ? { upload_skipped: "row_limit_exceeded", upload_limit: 500 } : {}),
    });
  }

  const contentProblems = mergedCsvContentProblems(csvText, flow);
  if (contentProblems.length > 0) {
    return failure(
      "YPSCAN_FILE_BRIDGE_INVALID_CSV",
      "merged CSV 内容校验失败",
      { problems: contentProblems },
      false,
      filePath,
    );
  }

  const blockedSources = blockedUploadSources(params, {
    workspaceDir,
    allowedLinksCsvPaths,
    allowedCompletionCsvPaths,
  });
  if (blockedSources.length > 0) {
    return failure(
      "YPSCAN_FILE_BRIDGE_SOURCE_NOT_ALLOWED",
      "上传来源校验失败：merged CSV 只能由当前 requirement 受控保存的 links CSV 与 YP Action 原生补全产出的 CSV 生成",
      { blocked_sources: blockedSources },
      false,
      filePath,
    );
  }

  const loadedConfig = await loadFileBridgeConfig({ pluginConfig, env, bundled, readBundledImpl });
  if (!loadedConfig.ok) {
    return failure(
      "YPSCAN_FILE_BRIDGE_CONFIG_MISSING",
      "OSS 配置不完整",
      { missing_or_invalid: loadedConfig.problems },
      false,
      filePath,
    );
  }

  let objectKey;
  try {
    objectKey = buildObjectKey(
      loadedConfig.config.objectPrefix,
      flow,
      mergedDetails.requirement_id,
      mergedDetails.sha256,
    );
  } catch (error) {
    return failure(
      "YPSCAN_FILE_BRIDGE_INVALID_INPUT",
      "requirement_id/field_id 不能用于构造 OSS 对象路径",
      error instanceof Error ? { reason: error.message } : {},
      false,
      filePath,
    );
  }

  let client;
  try {
    client = await createClient(loadedConfig.config);
  } catch (error) {
    return failure(
      "YPSCAN_FILE_BRIDGE_UPLOAD_FAILED",
      "OSS 客户端初始化失败",
      error instanceof Error ? { reason: error.message } : {},
      true,
      filePath,
    );
  }

  try {
    const response = await client.put(objectKey, Buffer.from(csvText, "utf8"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "x-oss-object-acl": "public-read",
      },
    });
    const statusCode = Number(response?.res?.statusCode ?? response?.statusCode ?? 200);
    if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode >= 300)) {
      return failure(
        "YPSCAN_FILE_BRIDGE_UPLOAD_FAILED",
        `OSS 上传返回 HTTP ${statusCode}`,
        { http_status: statusCode, object_key: objectKey, data_row_count: dataRowCount },
        false,
        filePath,
      );
    }
  } catch (error) {
    return failure(
      "YPSCAN_FILE_BRIDGE_UPLOAD_FAILED",
      "OSS 上传失败",
      error instanceof Error
        ? { reason: error.message, object_key: objectKey }
        : { object_key: objectKey },
      true,
      filePath,
    );
  }

  const csvFilePath = publicObjectUrl(loadedConfig.config, objectKey);
  const publicCheck = await ensurePublicUrlReadable(csvFilePath, {
    fetchImpl,
    retryDelaysMs,
    sleepImpl,
  });
  if (!publicCheck.ok) {
    return failure(
      publicCheck.code,
      "OSS 对象已上传，但匿名公网地址不可读",
      { ...publicCheck.details, object_key: objectKey, data_row_count: dataRowCount },
      false,
      filePath,
    );
  }

  return success({
    ...mergedDetails,
    csv_file_path: csvFilePath,
    object_key: objectKey,
  });
}

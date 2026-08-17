const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"]);

export function resolveTestAdapterBaseUrl(pluginConfig = {}) {
  if (pluginConfig?.testMode !== true) return null;
  const raw = pluginConfig?.testAdapterBaseUrl;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("testMode 需要非空 testAdapterBaseUrl");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("testAdapterBaseUrl 不是有效 URL");
  }
  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("testAdapterBaseUrl 仅允许无凭据的 loopback HTTP origin");
  }
  return parsed.origin;
}

export function excelArtifactTestDownloadUrl(baseUrl, originalDownloadUrl) {
  if (!baseUrl) return originalDownloadUrl;
  const original = new URL(originalDownloadUrl);
  const filePath = original.searchParams.get("file_path");
  const target = new URL("/mock/artifact", baseUrl);
  target.searchParams.set("file_path", filePath ?? "");
  return target.toString();
}

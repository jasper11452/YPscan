/**
 * @param {any} payload
 * @param {{ details?: any, isError?: boolean, compact?: boolean }} [options]
 */
export function hostToolResult(payload, {
  details,
  isError = payload?.success === false || payload?.ok === false,
  compact = false,
} = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, compact ? undefined : 2),
      },
    ],
    ...(details === undefined ? {} : { details }),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {{ ok: false, error: { code: string, message: string } }}
 */
export function createToolErrorResult(code, message) {
  return {
    ok: false,
    error: { code, message },
  };
}

export function ensureHostToolResult(value) {
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    return value;
  }
  return hostToolResult(value ?? {
    success: false,
    error: {
      code: "LOCAL_TOOL_EMPTY_RESULT",
      message: "本地工具未返回有效结果",
    },
  });
}

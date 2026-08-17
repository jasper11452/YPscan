/**
 * @param {any} payload
 * @param {{ details?: any, isError?: boolean, compact?: boolean }} [options]
 */
export function hostToolResult(
  payload,
  { details, isError = payload?.success === false || payload?.ok === false, compact = false } = {},
) {
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

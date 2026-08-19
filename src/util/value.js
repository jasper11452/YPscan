export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function firstString(...values) {
  return values.find(nonemptyString);
}

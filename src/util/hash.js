import { createHash, randomUUID } from "node:crypto";

/** Recursively sort object keys and trim strings; preserve array order. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === "string") return value.trim();
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function fingerprint(value) {
  return sha256(typeof value === "string" ? value : canonicalJson(value));
}

/** no-blind-retry action key: one tool plus semantically equal arguments. */
export function actionKey(toolName, params) {
  return `${toolName}:${fingerprint(canonicalJson(params ?? {}))}`;
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function firstString(...values) {
  return values.find(nonemptyString);
}

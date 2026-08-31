import { redactSecrets } from "../../domain/src/index.js";
import type { DiagnosticRecord, DiagnosticValue } from "./types.js";

export const REDACTED_DIAGNOSTIC_VALUE = "[REDACTED]" as const;

const SECRET_KEY_NAMES = new Set([
  "authorization",
  "httpauthorization",
  "apikey",
  "xapikey",
  "providerapikey",
  "accesstoken",
  "refreshtoken",
  "clienttoken",
  "interviewclienttoken",
  "sessiontoken",
  "authtoken",
  "bearertoken",
  "password",
  "passwd",
  "secret",
  "secretkey",
  "providersecret",
  "credential",
  "credentials"
]);

const STANDALONE_BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/=-]{4,}/giu;
const COMMON_API_KEY_PATTERN = /\b(?:sk-[a-z0-9_-]{8,}|AIza[a-z0-9_-]{20,})\b/giu;
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

export function isSecretDiagnosticKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEY_NAMES.has(normalized)) return true;
  return normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("clienttoken")
    || normalized.endsWith("sessiontoken")
    || normalized.endsWith("authtoken")
    || normalized.endsWith("bearertoken")
    || normalized.endsWith("secretkey")
    || normalized.endsWith("password");
}

export function sanitizeDiagnosticText(text: string): string {
  return redactSecrets(text)
    .replace(STANDALONE_BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(COMMON_API_KEY_PATTERN, REDACTED_DIAGNOSTIC_VALUE);
}

function sanitizeObject(
  value: object,
  seen: WeakSet<object>
): DiagnosticRecord | readonly DiagnosticValue[] {
  if (seen.has(value)) return ["[Circular]"];
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value
        .map((item) => sanitizeValue(item, seen))
        .filter((item): item is DiagnosticValue => item !== undefined);
    }

    const entries: Array<readonly [string, unknown]> = value instanceof Error
      ? [
          ["name", value.name],
          ["message", value.message],
          ...(value.stack === undefined ? [] : [["stack", value.stack] as const]),
          ...Object.entries(value)
        ]
      : Object.entries(value);

    const output: Record<string, DiagnosticValue> = {};
    for (const [key, raw] of entries) {
      if (BLOCKED_OBJECT_KEYS.has(key)) continue;
      if (isSecretDiagnosticKey(key)) {
        output[key] = REDACTED_DIAGNOSTIC_VALUE;
        continue;
      }
      const sanitized = sanitizeValue(raw, seen);
      if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function sanitizeValue(
  value: unknown,
  seen: WeakSet<object>
): DiagnosticValue | undefined {
  if (value === null) return null;
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  return sanitizeObject(value, seen);
}

export function sanitizeDiagnosticValue(value: unknown): DiagnosticValue | undefined {
  return sanitizeValue(value, new WeakSet<object>());
}

function isDiagnosticRecord(value: DiagnosticValue): value is DiagnosticRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeDiagnosticRecord(
  record: Readonly<Record<string, unknown>>
): DiagnosticRecord {
  const sanitized = sanitizeDiagnosticValue(record);
  return sanitized !== undefined && isDiagnosticRecord(sanitized) ? sanitized : {};
}

export function sanitizeErrorMetadata(error: unknown): DiagnosticRecord {
  const sanitized = sanitizeDiagnosticValue(error);
  if (sanitized === undefined) return {};
  return isDiagnosticRecord(sanitized) ? sanitized : { error: sanitized };
}

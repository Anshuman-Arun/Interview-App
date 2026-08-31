import { redactSecrets } from "../../domain/src/index.js";
import type { DiagnosticRecord, DiagnosticValue } from "./types.js";

export const REDACTED_DIAGNOSTIC_VALUE = "[REDACTED]" as const;
export const TRUNCATED_DIAGNOSTIC_VALUE = "[TRUNCATED]" as const;
export const CIRCULAR_DIAGNOSTIC_VALUE = "[CIRCULAR]" as const;
export const UNSUPPORTED_DIAGNOSTIC_VALUE = "[UNSUPPORTED_OBJECT]" as const;
export const ACCESSOR_DIAGNOSTIC_VALUE = "[ACCESSOR_OMITTED]" as const;
export const UNINSPECTABLE_DIAGNOSTIC_VALUE = "[UNINSPECTABLE_OBJECT]" as const;

export const DIAGNOSTIC_SANITIZATION_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 2_000,
  maxArrayItems: 256,
  maxObjectEntries: 256,
  maxStringLength: 2_000,
  maxKeyLength: 256
});

const SECRET_KEY_NAMES = new Set([
  "authorization",
  "httpauthorization",
  "auth",
  "apikey",
  "xapikey",
  "providerapikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clienttoken",
  "interviewclienttoken",
  "sessiontoken",
  "authtoken",
  "bearertoken",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "secretkey",
  "providersecret",
  "privatekey",
  "credential",
  "credentials",
  "cookie",
  "setcookie"
]);

const STANDALONE_AUTH_PATTERN = /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{4,}/giu;
const COMMON_API_KEY_PATTERN = /\b(?:sk-[a-z0-9_-]{8,}|AIza[a-z0-9_-]{20,})\b/giu;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)/giu;
const EXTRA_SECRET_ASSIGNMENT_PATTERN = /(["']?)((?:private[-_]?key|password|passwd|passphrase|cookie|set[-_]?cookie))\1(\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n,}]+)/giu;
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

interface SanitizationState {
  readonly seen: WeakSet<object>;
  remainingNodes: number;
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSecretDiagnosticKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEY_NAMES.has(normalized)) return true;
  return normalized.endsWith("token")
    || normalized.endsWith("apikey")
    || normalized.endsWith("secret")
    || normalized.endsWith("secretkey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("credential")
    || normalized.endsWith("credentials")
    || normalized.endsWith("password")
    || normalized.endsWith("passphrase")
    || normalized.endsWith("cookie");
}

function boundedText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const prefixLength = Math.max(0, maxLength - TRUNCATED_DIAGNOSTIC_VALUE.length);
  return `${text.slice(0, prefixLength)}${TRUNCATED_DIAGNOSTIC_VALUE}`;
}

export function sanitizeDiagnosticText(
  text: string,
  maxLength: number = DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength
): string {
  const safeLimit = Number.isSafeInteger(maxLength) && maxLength > 0
    ? Math.min(maxLength, DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength)
    : DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength;
  const bounded = boundedText(text, safeLimit);
  return redactSecrets(bounded)
    .replace(PRIVATE_KEY_PATTERN, REDACTED_DIAGNOSTIC_VALUE)
    .replace(
      EXTRA_SECRET_ASSIGNMENT_PATTERN,
      (_match: string, keyQuote: string, key: string, separator: string, value: string) => {
        const valueQuote = value[0];
        const redacted = (valueQuote === "\"" || valueQuote === "'") && value.at(-1) === valueQuote
          ? `${valueQuote}${REDACTED_DIAGNOSTIC_VALUE}${valueQuote}`
          : REDACTED_DIAGNOSTIC_VALUE;
        return `${keyQuote}${key}${keyQuote}${separator}${redacted}`;
      }
    )
    .replace(STANDALONE_AUTH_PATTERN, (match) => {
      const scheme = /^\S+/u.exec(match)?.[0] ?? "Credential";
      return `${scheme} [REDACTED]`;
    })
    .replace(COMMON_API_KEY_PATTERN, REDACTED_DIAGNOSTIC_VALUE);
}

function nextOutputKey(output: Readonly<Record<string, DiagnosticValue>>, requested: string): string {
  if (!Object.hasOwn(output, requested)) return requested;
  let suffix = 2;
  while (Object.hasOwn(output, `${requested}#${String(suffix)}`)) suffix += 1;
  return `${requested}#${String(suffix)}`;
}

function inspectDescriptors(value: object): Readonly<Record<string, PropertyDescriptor>> | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
}

function isSupportedRecord(value: object): boolean {
  if (value instanceof Error) return true;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function sanitizeObject(
  value: object,
  state: SanitizationState,
  depth: number
): DiagnosticValue {
  if (state.seen.has(value)) return CIRCULAR_DIAGNOSTIC_VALUE;
  if (depth >= DIAGNOSTIC_SANITIZATION_LIMITS.maxDepth) return TRUNCATED_DIAGNOSTIC_VALUE;
  state.seen.add(value);

  try {
    if (Array.isArray(value)) {
      const descriptors = inspectDescriptors(value);
      if (descriptors === undefined) return UNINSPECTABLE_DIAGNOSTIC_VALUE;
      const rawLength: unknown = descriptors.length?.value;
      if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) {
        return UNINSPECTABLE_DIAGNOSTIC_VALUE;
      }
      const output: DiagnosticValue[] = [];
      const itemCount = Math.min(rawLength, DIAGNOSTIC_SANITIZATION_LIMITS.maxArrayItems);
      for (let index = 0; index < itemCount; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) {
          output.push(null);
          continue;
        }
        if (!("value" in descriptor)) {
          output.push(ACCESSOR_DIAGNOSTIC_VALUE);
          continue;
        }
        const sanitized = sanitizeValue(descriptor.value, state, depth + 1);
        output.push(sanitized ?? null);
      }
      if (rawLength > itemCount) output.push(TRUNCATED_DIAGNOSTIC_VALUE);
      return Object.freeze(output);
    }

    if (value instanceof Date) {
      try {
        return value.toISOString();
      } catch {
        return UNINSPECTABLE_DIAGNOSTIC_VALUE;
      }
    }

    if (!isSupportedRecord(value)) return UNSUPPORTED_DIAGNOSTIC_VALUE;
    const descriptors = inspectDescriptors(value);
    if (descriptors === undefined) return UNINSPECTABLE_DIAGNOSTIC_VALUE;

    const output: Record<string, DiagnosticValue> = {};
    const entries = Object.entries(descriptors)
      .filter(([, descriptor]) => descriptor.enumerable === true || value instanceof Error)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    const entryCount = Math.min(entries.length, DIAGNOSTIC_SANITIZATION_LIMITS.maxObjectEntries);

    for (const [rawKey, descriptor] of entries.slice(0, entryCount)) {
      if (BLOCKED_OBJECT_KEYS.has(rawKey)) continue;
      const sanitizedKey = nextOutputKey(
        output,
        sanitizeDiagnosticText(rawKey, DIAGNOSTIC_SANITIZATION_LIMITS.maxKeyLength)
      );
      if (isSecretDiagnosticKey(rawKey)) {
        output[sanitizedKey] = REDACTED_DIAGNOSTIC_VALUE;
        continue;
      }
      if (!("value" in descriptor)) {
        output[sanitizedKey] = ACCESSOR_DIAGNOSTIC_VALUE;
        continue;
      }
      const sanitized = sanitizeValue(descriptor.value, state, depth + 1);
      if (sanitized !== undefined) output[sanitizedKey] = sanitized;
    }
    if (entries.length > entryCount) output.diagnosticTruncation = TRUNCATED_DIAGNOSTIC_VALUE;
    if (value instanceof Error && !Object.hasOwn(output, "name")) output.name = "Error";
    return Object.freeze(output);
  } finally {
    state.seen.delete(value);
  }
}

function sanitizeValue(
  value: unknown,
  state: SanitizationState,
  depth: number
): DiagnosticValue | undefined {
  if (state.remainingNodes <= 0) return TRUNCATED_DIAGNOSTIC_VALUE;
  state.remainingNodes -= 1;
  if (value === null) return null;
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  try {
    return sanitizeObject(value, state, depth);
  } catch {
    return UNINSPECTABLE_DIAGNOSTIC_VALUE;
  }
}

export function sanitizeDiagnosticValue(value: unknown): DiagnosticValue | undefined {
  return sanitizeValue(value, {
    seen: new WeakSet<object>(),
    remainingNodes: DIAGNOSTIC_SANITIZATION_LIMITS.maxNodes
  }, 0);
}

function isDiagnosticRecord(value: DiagnosticValue): value is DiagnosticRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeDiagnosticRecord(
  record: Readonly<Record<string, unknown>>
): DiagnosticRecord {
  const sanitized = sanitizeDiagnosticValue(record);
  return sanitized !== undefined && isDiagnosticRecord(sanitized)
    ? sanitized
    : Object.freeze({});
}

export function sanitizeErrorMetadata(error: unknown): DiagnosticRecord {
  const sanitized = sanitizeDiagnosticValue(error);
  if (sanitized === undefined) return Object.freeze({});
  return isDiagnosticRecord(sanitized)
    ? sanitized
    : Object.freeze({ error: sanitized });
}

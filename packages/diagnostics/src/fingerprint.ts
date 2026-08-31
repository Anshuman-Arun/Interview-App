import { createHash } from "node:crypto";
import {
  DIAGNOSTIC_SANITIZATION_LIMITS,
  REDACTED_DIAGNOSTIC_VALUE,
  isSecretDiagnosticKey,
  sanitizeDiagnosticText
} from "./sanitize.js";
import type { Sha256Fingerprint } from "./types.js";

export class DiagnosticConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DiagnosticConfigurationError";
  }
}

interface CanonicalizationState {
  readonly seen: WeakSet<object>;
  remainingNodes: number;
}

interface CanonicalObjectEntry {
  readonly key: string;
  readonly descriptor: PropertyDescriptor;
  readonly secret: boolean;
}

function fail(reason: string): never {
  throw new DiagnosticConfigurationError(`Diagnostic configuration is not canonicalizable: ${reason}`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function consumeNode(state: CanonicalizationState): void {
  if (state.remainingNodes <= 0) fail("node limit exceeded");
  state.remainingNodes -= 1;
}

function canonicalString(value: string, label: "key" | "value"): string {
  const limit = label === "key"
    ? DIAGNOSTIC_SANITIZATION_LIMITS.maxKeyLength
    : DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength;
  if (value.length > limit) fail(`${label} length limit exceeded`);
  return sanitizeDiagnosticText(value, limit);
}

function canonicalizeArray(
  value: readonly unknown[],
  state: CanonicalizationState,
  depth: number
): string {
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail("array inspection failed");
  }
  const rawLength: unknown = descriptors.length?.value;
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) {
    fail("array length is invalid");
  }
  if (rawLength > DIAGNOSTIC_SANITIZATION_LIMITS.maxArrayItems) {
    fail("array item limit exceeded");
  }
  const items: string[] = [];
  for (let index = 0; index < rawLength; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined) fail("sparse arrays are unsupported");
    if (!("value" in descriptor)) fail("array accessors are unsupported");
    items.push(canonicalize(descriptor.value, state, depth + 1));
  }
  return `[${items.join(",")}]`;
}

function inspectCanonicalEntries(value: object): readonly CanonicalObjectEntry[] {
  let prototype: unknown;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  let hasEnumerableSymbols: boolean;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
    hasEnumerableSymbols = symbols.some(
      (symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable === true
    );
  } catch {
    return fail("object inspection failed");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("only plain JSON objects are supported");
  }
  if (hasEnumerableSymbols) {
    fail("enumerable symbol keys are unsupported");
  }

  const entries: CanonicalObjectEntry[] = [];
  const canonicalKeys = new Set<string>();
  for (const [rawKey, descriptor] of Object.entries(descriptors)) {
    if (descriptor.enumerable !== true) continue;
    if (rawKey === "__proto__" || rawKey === "prototype" || rawKey === "constructor") {
      fail("unsafe object key rejected");
    }
    const key = canonicalString(rawKey, "key");
    if (canonicalKeys.has(key)) fail("keys collide after sanitization");
    canonicalKeys.add(key);
    entries.push({ key, descriptor, secret: isSecretDiagnosticKey(rawKey) });
  }
  if (entries.length > DIAGNOSTIC_SANITIZATION_LIMITS.maxObjectEntries) {
    fail("object entry limit exceeded");
  }
  return entries.sort((left, right) => compareCodeUnits(left.key, right.key));
}

function canonicalizeObject(
  value: object,
  state: CanonicalizationState,
  depth: number
): string {
  if (state.seen.has(value)) fail("cyclic objects are unsupported");
  state.seen.add(value);
  try {
    const entries = inspectCanonicalEntries(value);
    return `{${entries.map((entry) => {
      if (entry.secret) {
        return `${JSON.stringify(entry.key)}:${JSON.stringify(REDACTED_DIAGNOSTIC_VALUE)}`;
      }
      if (!("value" in entry.descriptor)) fail("accessor properties are unsupported");
      return `${JSON.stringify(entry.key)}:${canonicalize(entry.descriptor.value, state, depth + 1)}`;
    }).join(",")}}`;
  } finally {
    state.seen.delete(value);
  }
}

function canonicalize(value: unknown, state: CanonicalizationState, depth: number): string {
  consumeNode(state);
  if (depth > DIAGNOSTIC_SANITIZATION_LIMITS.maxDepth) fail("depth limit exceeded");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(canonicalString(value, "value"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite numbers are unsupported");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") fail("undefined values are unsupported");
  if (typeof value === "bigint") fail("bigint values are unsupported");
  if (typeof value === "function") fail("function values are unsupported");
  if (typeof value === "symbol") fail("symbol values are unsupported");
  try {
    if (Array.isArray(value)) return canonicalizeArray(value, state, depth);
  } catch {
    return fail("value inspection failed");
  }
  return canonicalizeObject(value, state, depth);
}

export function canonicalizeDiagnosticConfiguration(configuration: unknown): string {
  return canonicalize(configuration, {
    seen: new WeakSet<object>(),
    remainingNodes: DIAGNOSTIC_SANITIZATION_LIMITS.maxNodes
  }, 0);
}

export function fingerprintDiagnosticConfiguration(configuration: unknown): Sha256Fingerprint {
  return createHash("sha256")
    .update(canonicalizeDiagnosticConfiguration(configuration), "utf8")
    .digest("hex");
}

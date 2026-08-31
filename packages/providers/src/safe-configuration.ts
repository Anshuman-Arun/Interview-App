import { z } from "zod";
import { redactSecrets } from "../../domain/src/index.js";

const BLOCKED_CONFIGURATION_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SECRET_CONFIGURATION_KEYS = new Set([
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
const STANDALONE_AUTH_PATTERN = /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/iu;
const COMMON_API_KEY_PATTERN = /\b(?:sk-[a-z0-9_-]{8,}|AIza[a-z0-9_-]{20,})\b/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu;

export const PROVIDER_CONFIGURATION_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 2_000,
  maxArrayItems: 128,
  maxObjectEntries: 128,
  maxStringLength: 4_096,
  maxKeyLength: 128
});

export type ProviderConfigurationSafetyErrorCode =
  | "MALFORMED_CONFIGURATION"
  | "SECRET_IN_CONFIGURATION";

export class ProviderConfigurationSafetyError extends Error {
  public constructor(public readonly code: ProviderConfigurationSafetyErrorCode) {
    super(code === "SECRET_IN_CONFIGURATION"
      ? "Provider configuration contains credential-like material"
      : "Provider configuration is malformed");
    this.name = "ProviderConfigurationSafetyError";
  }
}

export type SafeProviderConfigurationPrimitive = string | number | boolean | null;
export type SafeProviderConfigurationValue =
  | SafeProviderConfigurationPrimitive
  | readonly SafeProviderConfigurationValue[]
  | SafeProviderConfigurationRecord;
export interface SafeProviderConfigurationRecord {
  readonly [key: string]: SafeProviderConfigurationValue;
}

interface ConfigurationInspectionState {
  readonly seen: WeakSet<object>;
  remainingNodes: number;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failMalformedConfiguration(): never {
  throw new ProviderConfigurationSafetyError("MALFORMED_CONFIGURATION");
}

function failSecretConfiguration(): never {
  throw new ProviderConfigurationSafetyError("SECRET_IN_CONFIGURATION");
}

function normalizeConfigurationKey(key: string): string {
  return key.normalize("NFKC").replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isSecretConfigurationKey(key: string): boolean {
  const normalized = normalizeConfigurationKey(key);
  if (SECRET_CONFIGURATION_KEYS.has(normalized)) return true;
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

export function containsSecretLikeConfigurationText(value: string): boolean {
  const normalized = value.normalize("NFKC");
  return redactSecrets(normalized) !== normalized
    || STANDALONE_AUTH_PATTERN.test(normalized)
    || COMMON_API_KEY_PATTERN.test(normalized)
    || PRIVATE_KEY_PATTERN.test(normalized);
}

function consumeConfigurationNode(state: ConfigurationInspectionState): void {
  if (state.remainingNodes <= 0) failMalformedConfiguration();
  state.remainingNodes -= 1;
}

function inspectConfigurationArray(
  value: readonly unknown[],
  state: ConfigurationInspectionState,
  depth: number,
  rejectSecrets: boolean
): readonly SafeProviderConfigurationValue[] {
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return failMalformedConfiguration();
  }
  if (symbols.length > 0) failMalformedConfiguration();

  const rawLength: unknown = descriptors.length?.value;
  if (
    typeof rawLength !== "number"
    || !Number.isSafeInteger(rawLength)
    || rawLength < 0
    || rawLength > PROVIDER_CONFIGURATION_LIMITS.maxArrayItems
  ) {
    failMalformedConfiguration();
  }

  const allowedKeys = new Set<string>(["length"]);
  const output: SafeProviderConfigurationValue[] = [];
  for (let index = 0; index < rawLength; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      failMalformedConfiguration();
    }
    output.push(inspectConfigurationValue(descriptor.value, state, depth + 1, rejectSecrets));
  }
  for (const key of Object.keys(descriptors)) {
    if (!allowedKeys.has(key)) failMalformedConfiguration();
  }
  return Object.freeze(output);
}

function inspectConfigurationRecord(
  value: object,
  state: ConfigurationInspectionState,
  depth: number,
  rejectSecrets: boolean
): SafeProviderConfigurationRecord {
  let prototype: unknown;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let symbols: readonly symbol[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return failMalformedConfiguration();
  }
  if (prototype !== Object.prototype && prototype !== null) failMalformedConfiguration();
  if (symbols.length > 0) failMalformedConfiguration();

  const entries = Object.entries(descriptors);
  if (entries.length > PROVIDER_CONFIGURATION_LIMITS.maxObjectEntries) {
    failMalformedConfiguration();
  }

  const output: Record<string, SafeProviderConfigurationValue> = {};
  for (const [key, descriptor] of entries.sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (
      key.length === 0
      || key.length > PROVIDER_CONFIGURATION_LIMITS.maxKeyLength
      || BLOCKED_CONFIGURATION_KEYS.has(key)
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      failMalformedConfiguration();
    }
    if (rejectSecrets && isSecretConfigurationKey(key)) failSecretConfiguration();
    output[key] = inspectConfigurationValue(descriptor.value, state, depth + 1, rejectSecrets);
  }
  return Object.freeze(output);
}

function inspectConfigurationValue(
  value: unknown,
  state: ConfigurationInspectionState,
  depth: number,
  rejectSecrets: boolean
): SafeProviderConfigurationValue {
  consumeConfigurationNode(state);
  if (depth > PROVIDER_CONFIGURATION_LIMITS.maxDepth) failMalformedConfiguration();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failMalformedConfiguration();
    return value;
  }
  if (typeof value === "string") {
    if (value.length > PROVIDER_CONFIGURATION_LIMITS.maxStringLength) {
      failMalformedConfiguration();
    }
    if (rejectSecrets && containsSecretLikeConfigurationText(value)) failSecretConfiguration();
    return value;
  }
  if (
    typeof value === "undefined"
    || typeof value === "bigint"
    || typeof value === "function"
    || typeof value === "symbol"
  ) {
    return failMalformedConfiguration();
  }

  if (state.seen.has(value)) failMalformedConfiguration();
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return inspectConfigurationArray(value, state, depth, rejectSecrets);
    return inspectConfigurationRecord(value, state, depth, rejectSecrets);
  } finally {
    state.seen.delete(value);
  }
}

function inspectProviderConfigurationValue(
  value: unknown,
  rejectSecrets: boolean
): SafeProviderConfigurationValue {
  return inspectConfigurationValue(value, {
    seen: new WeakSet<object>(),
    remainingNodes: PROVIDER_CONFIGURATION_LIMITS.maxNodes
  }, 0, rejectSecrets);
}

export function inspectPlainProviderConfigurationValue(
  value: unknown
): SafeProviderConfigurationValue {
  return inspectProviderConfigurationValue(value, false);
}

export function inspectSafeProviderConfigurationValue(
  value: unknown
): SafeProviderConfigurationValue {
  return inspectProviderConfigurationValue(value, true);
}

function reportSchemaError(error: unknown, context: z.RefinementCtx): typeof z.NEVER {
  context.addIssue({
    code: "custom",
    message: error instanceof ProviderConfigurationSafetyError
      ? error.code
      : "MALFORMED_CONFIGURATION"
  });
  return z.NEVER;
}

export const SafeProviderConfigurationValueSchema: z.ZodType<SafeProviderConfigurationValue> =
  z.unknown().transform((value, context) => {
    try {
      return inspectSafeProviderConfigurationValue(value);
    } catch (error) {
      return reportSchemaError(error, context);
    }
  });

export const SafeProviderConfigurationRecordSchema: z.ZodType<SafeProviderConfigurationRecord> =
  z.unknown().transform((value, context) => {
    try {
      const inspected = inspectSafeProviderConfigurationValue(value);
      if (typeof inspected !== "object" || inspected === null || Array.isArray(inspected)) {
        return reportSchemaError(undefined, context);
      }
      return inspected;
    } catch (error) {
      return reportSchemaError(error, context);
    }
  });

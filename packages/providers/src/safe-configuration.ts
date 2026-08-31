import { z } from "zod";

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
  "setcookie",
  "authorizationheader",
  "authheader",
  "apikeys",
  "tokens",
  "accesstokens",
  "refreshtokens",
  "clienttokens",
  "sessiontokens",
  "authtokens",
  "bearertokens",
  "passwords",
  "passphrases",
  "secrets",
  "secretkeys",
  "privatekeys",
  "cookies",
  "setcookies",
  "credentialref",
  "credentialsref",
  "credentialrefs",
  "secretref",
  "secretrefs",
  "secretkeyref",
  "secretkeyrefs",
  "privatekeyref",
  "privatekeyrefs",
  "apikeyref",
  "apikeyrefs",
  "accesstokenref",
  "accesstokenrefs",
  "refreshtokenref",
  "refreshtokenrefs",
  "authtokenref",
  "authtokenrefs",
  "bearertokenref",
  "bearertokenrefs",
  "passwordref",
  "passwordrefs",
  "passphraseref",
  "passphraserefs"
]);
const BEARER_AUTH_PATTERN = /\bbearer\s+[a-z0-9._~+/-]{16,}/iu;
const BASIC_AUTH_CANDIDATE_PATTERN =
  /\bbasic\s+([A-Za-z0-9+/]+={0,2})(?=$|[\s,;])/iu;
const COMMON_API_KEY_PATTERN = /\b(?:sk[-_][a-z0-9_-]{16,}|AIza[a-z0-9_-]{20,})\b/iu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:authorization|api[-_]?key|access[-_]?token|client[-_]?token|token|secret|password|passphrase|private[-_]?key|credential)\b\s*[:=]\s*["']?([^\s"'&]{12,})["']?/iu;
const URL_USERINFO_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu;

export const PROVIDER_CONFIGURATION_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 2_000,
  maxArrayItems: 128,
  maxObjectEntries: 128,
  maxStringLength: 4_096,
  maxKeyLength: 128
});

const PROVIDER_DEFINITION_MAX_NODES = 16_384;

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
  return normalized.endsWith("accesstoken")
    || normalized.endsWith("accesstokens")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("refreshtokens")
    || normalized.endsWith("clienttoken")
    || normalized.endsWith("clienttokens")
    || normalized.endsWith("sessiontoken")
    || normalized.endsWith("sessiontokens")
    || normalized.endsWith("authtoken")
    || normalized.endsWith("authtokens")
    || normalized.endsWith("bearertoken")
    || normalized.endsWith("bearertokens")
    || normalized.endsWith("apitoken")
    || normalized.endsWith("apitokens")
    || normalized.endsWith("oauthtoken")
    || normalized.endsWith("oauthtokens")
    || normalized.endsWith("csrftoken")
    || normalized.endsWith("csrftokens")
    || normalized.endsWith("apikey")
    || normalized.endsWith("apikeys")
    || normalized.endsWith("secret")
    || normalized.endsWith("secrets")
    || normalized.endsWith("secretkey")
    || normalized.endsWith("secretkeys")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("privatekeys")
    || normalized.endsWith("credential")
    || normalized.endsWith("credentials")
    || normalized.endsWith("password")
    || normalized.endsWith("passwords")
    || normalized.endsWith("passphrase")
    || normalized.endsWith("passphrases")
    || normalized === "cookie"
    || normalized === "cookies"
    || normalized.endsWith("authorizationheader")
    || normalized.endsWith("authheader")
    || normalized.endsWith("credentialref")
    || normalized.endsWith("credentialsref")
    || normalized.endsWith("credentialrefs")
    || normalized.endsWith("secretref")
    || normalized.endsWith("secretrefs")
    || normalized.endsWith("secretkeyref")
    || normalized.endsWith("secretkeyrefs")
    || normalized.endsWith("privatekeyref")
    || normalized.endsWith("privatekeyrefs")
    || normalized.endsWith("apikeyref")
    || normalized.endsWith("apikeyrefs")
    || normalized.endsWith("accesstokenref")
    || normalized.endsWith("accesstokenrefs")
    || normalized.endsWith("refreshtokenref")
    || normalized.endsWith("refreshtokenrefs")
    || normalized.endsWith("authtokenref")
    || normalized.endsWith("authtokenrefs")
    || normalized.endsWith("bearertokenref")
    || normalized.endsWith("bearertokenrefs")
    || normalized.endsWith("passwordref")
    || normalized.endsWith("passwordrefs")
    || normalized.endsWith("passphraseref")
    || normalized.endsWith("passphraserefs");
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ContainsColon(candidate: string): boolean {
  const withoutPadding = candidate.replace(/=+$/u, "");
  const paddingLength = candidate.length - withoutPadding.length;
  if (
    candidate.length < 8
    || candidate.length % 4 === 1
    || paddingLength > 2
  ) {
    return false;
  }

  let accumulator = 0;
  let bitCount = 0;
  let sawColon = false;
  for (const character of withoutPadding) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) return false;
    accumulator = (accumulator << 6) | value;
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      const byte = (accumulator >> bitCount) & 0xff;
      if (byte === 0x3a) sawColon = true;
    }
    if (bitCount === 0) {
      accumulator = 0;
    } else {
      accumulator &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0 && accumulator !== 0) return false;
  return sawColon;
}

function containsBasicAuthCredential(value: string): boolean {
  const candidate = BASIC_AUTH_CANDIDATE_PATTERN.exec(value)?.[1];
  return candidate !== undefined && base64ContainsColon(candidate);
}

export function containsSecretLikeConfigurationText(value: string): boolean {
  const normalized = value.normalize("NFKC");
  const assignedValue = SECRET_ASSIGNMENT_PATTERN.exec(normalized)?.[1];
  return BEARER_AUTH_PATTERN.test(normalized)
    || containsBasicAuthCredential(normalized)
    || COMMON_API_KEY_PATTERN.test(normalized)
    || URL_USERINFO_PATTERN.test(normalized)
    || PRIVATE_KEY_PATTERN.test(normalized)
    || assignedValue !== undefined;
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
  Object.setPrototypeOf(output, null);
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

function inspectProviderValue(
  value: unknown,
  rejectSecrets: boolean,
  maxNodes: number
): SafeProviderConfigurationValue {
  return inspectConfigurationValue(value, {
    seen: new WeakSet<object>(),
    remainingNodes: maxNodes
  }, 0, rejectSecrets);
}

function inspectProviderConfigurationValue(
  value: unknown,
  rejectSecrets: boolean
): SafeProviderConfigurationValue {
  return inspectProviderValue(value, rejectSecrets, PROVIDER_CONFIGURATION_LIMITS.maxNodes);
}

export function inspectPlainProviderConfigurationValue(
  value: unknown
): SafeProviderConfigurationValue {
  return inspectProviderConfigurationValue(value, false);
}

export function inspectPlainProviderDefinitionValue(
  value: unknown
): SafeProviderConfigurationValue {
  return inspectProviderValue(value, false, PROVIDER_DEFINITION_MAX_NODES);
}

export function inspectSafeProviderConfigurationValue(
  value: unknown
): SafeProviderConfigurationValue {
  return inspectProviderConfigurationValue(value, true);
}

function schemaErrorMessage(error: unknown): ProviderConfigurationSafetyErrorCode {
  return error instanceof ProviderConfigurationSafetyError
    ? error.code
    : "MALFORMED_CONFIGURATION";
}

export const SafeProviderConfigurationValueSchema: z.ZodType<SafeProviderConfigurationValue> =
  z.unknown().transform((value, context) => {
    try {
      return inspectSafeProviderConfigurationValue(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: schemaErrorMessage(error) });
      return z.NEVER;
    }
  });

export const SafeProviderConfigurationRecordSchema: z.ZodType<SafeProviderConfigurationRecord> =
  z.unknown().transform((value, context) => {
    try {
      const inspected = inspectSafeProviderConfigurationValue(value);
      if (typeof inspected !== "object" || inspected === null || Array.isArray(inspected)) {
        context.addIssue({ code: "custom", message: "MALFORMED_CONFIGURATION" });
        return z.NEVER;
      }
      return inspected;
    } catch (error) {
      context.addIssue({ code: "custom", message: schemaErrorMessage(error) });
      return z.NEVER;
    }
  });

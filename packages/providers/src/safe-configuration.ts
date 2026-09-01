import { z } from "zod";

const REFLECT_APPLY_INTRINSIC = Reflect.apply;

const OBJECT_FREEZE_INTRINSIC = Object.freeze;
const OBJECT_SET_PROTOTYPE_OF_INTRINSIC = Object.setPrototypeOf;
const OBJECT_DEFINE_PROPERTY_INTRINSIC = Object.defineProperty;

function objectFreeze<T extends object>(value: T): Readonly<T> {
  return OBJECT_FREEZE_INTRINSIC(value);
}

function objectSetPrototypeOf(value: object, prototype: object | null): void {
  OBJECT_SET_PROTOTYPE_OF_INTRINSIC(value, prototype);
}

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
  "passphraserefs",
  "secretaccesskey",
  "secretaccesskeys",
  "awssecretaccesskey",
  "awssecretaccesskeys",
  "accountkey",
  "accountkeys",
  "storageaccountkey",
  "storageaccountkeys",
  "subscriptionkey",
  "subscriptionkeys",
  "sastoken",
  "sastokens",
  "sharedaccesssignature",
  "sharedaccesssignatures"
]);
const BEARER_AUTH_PATTERN = /\bbearer\s+[a-z0-9._~+/-]{16,}/iu;
const BASIC_AUTH_CANDIDATE_PATTERN =
  /\bbasic\s+([A-Za-z0-9+/]+={0,2})(?=$|[^A-Za-z0-9+/=])/iu;
const COMMON_API_KEY_PATTERN =
  /\b(?:(?:AKIA|ASIA)[0-9A-Z]{16}|sk[-_][a-z0-9_-]{16,}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{20,}|hf_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,})\b/iu;
const CREDENTIAL_WORD_SEPARATOR = "[\\s._-]*";
const HIGH_CONFIDENCE_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?:^|[^a-z0-9])(authorization(?:${CREDENTIAL_WORD_SEPARATOR}header)?|http${CREDENTIAL_WORD_SEPARATOR}authorization|auth${CREDENTIAL_WORD_SEPARATOR}header|api${CREDENTIAL_WORD_SEPARATOR}key|access${CREDENTIAL_WORD_SEPARATOR}token|refresh${CREDENTIAL_WORD_SEPARATOR}token|id${CREDENTIAL_WORD_SEPARATOR}token|client${CREDENTIAL_WORD_SEPARATOR}token|session${CREDENTIAL_WORD_SEPARATOR}token|auth${CREDENTIAL_WORD_SEPARATOR}token|bearer${CREDENTIAL_WORD_SEPARATOR}token|client${CREDENTIAL_WORD_SEPARATOR}secret|provider${CREDENTIAL_WORD_SEPARATOR}secret|webhook${CREDENTIAL_WORD_SEPARATOR}secret|secret${CREDENTIAL_WORD_SEPARATOR}key|secret${CREDENTIAL_WORD_SEPARATOR}access${CREDENTIAL_WORD_SEPARATOR}key|aws${CREDENTIAL_WORD_SEPARATOR}secret${CREDENTIAL_WORD_SEPARATOR}access${CREDENTIAL_WORD_SEPARATOR}key|account${CREDENTIAL_WORD_SEPARATOR}key|storage${CREDENTIAL_WORD_SEPARATOR}account${CREDENTIAL_WORD_SEPARATOR}key|subscription${CREDENTIAL_WORD_SEPARATOR}key|sas${CREDENTIAL_WORD_SEPARATOR}token|shared${CREDENTIAL_WORD_SEPARATOR}access${CREDENTIAL_WORD_SEPARATOR}signature|password|passwd|passphrase|private${CREDENTIAL_WORD_SEPARATOR}key|credential|cookie|set${CREDENTIAL_WORD_SEPARATOR}cookie)\b["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s&,;]+))`,
  "iu"
);
const GENERIC_SECRET_ASSIGNMENT_PATTERN =
  /(?:^|[^a-z0-9])(?:token|secret)\b["']?\s*[:=]\s*["']?([^\s"'&]{12,})["']?/iu;
const AUTHORIZATION_SCHEME_VALUE_PATTERN = new RegExp(
  String.raw`(?:^|[^a-z0-9])(?:authorization(?:${CREDENTIAL_WORD_SEPARATOR}header)?|http${CREDENTIAL_WORD_SEPARATOR}authorization|auth${CREDENTIAL_WORD_SEPARATOR}header)\b["']?\s*[:=]\s*["']?(?:bearer|basic)\s+[^\s"&,;]+`,
  "iu"
);
const GENERIC_NON_SECRET_ASSIGNMENT_VALUES = new Set([
  "",
  "none",
  "null",
  "unset",
  "disabled",
  "placeholder",
  "redacted",
  "[redacted]",
  "n/a",
  "na"
]);
const AUTHORIZATION_NON_SECRET_ASSIGNMENT_VALUES = new Set([
  ...GENERIC_NON_SECRET_ASSIGNMENT_VALUES,
  "required",
  "bearer",
  "basic"
]);
const URL_USERINFO_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN(?:(?: [A-Z0-9]+)? PRIVATE KEY| PGP PRIVATE KEY BLOCK)-----/iu;

export const PROVIDER_CONFIGURATION_LIMITS = objectFreeze({
  maxDepth: 16,
  maxNodes: 2_000,
  maxArrayItems: 128,
  maxObjectEntries: 128,
  maxStringLength: 4_096,
  maxKeyLength: 128
});

const PROVIDER_DEFINITION_MAX_NODES = 16_384;

const SET_HAS_INTRINSIC = Set.prototype.has;
const SET_ADD_INTRINSIC = Set.prototype.add;
const WEAK_SET_HAS_INTRINSIC = WeakSet.prototype.has;
const WEAK_SET_ADD_INTRINSIC = WeakSet.prototype.add;
const WEAK_SET_DELETE_INTRINSIC = WeakSet.prototype.delete;
const REGEXP_EXEC_INTRINSIC = RegExp.prototype.exec;
const STRING_NORMALIZE_INTRINSIC = String.prototype.normalize;
const STRING_TRIM_INTRINSIC = String.prototype.trim;
const STRING_TO_LOWER_CASE_INTRINSIC = String.prototype.toLowerCase;
const STRING_CHAR_CODE_AT_INTRINSIC = String.prototype.charCodeAt;

function setHas<T>(set: ReadonlySet<T>, value: T): boolean {
  const result: unknown = REFLECT_APPLY_INTRINSIC(SET_HAS_INTRINSIC, set, [value]);
  return result === true;
}

function setAdd<T>(set: Set<T>, value: T): void {
  REFLECT_APPLY_INTRINSIC(SET_ADD_INTRINSIC, set, [value]);
}

function weakSetHas(set: WeakSet<object>, value: object): boolean {
  const result: unknown = REFLECT_APPLY_INTRINSIC(WEAK_SET_HAS_INTRINSIC, set, [value]);
  return result === true;
}

function weakSetAdd(set: WeakSet<object>, value: object): void {
  REFLECT_APPLY_INTRINSIC(WEAK_SET_ADD_INTRINSIC, set, [value]);
}

function weakSetDelete(set: WeakSet<object>, value: object): void {
  REFLECT_APPLY_INTRINSIC(WEAK_SET_DELETE_INTRINSIC, set, [value]);
}

function regexpExec(pattern: RegExp, value: string): readonly unknown[] | null {
  const result: unknown = REFLECT_APPLY_INTRINSIC(REGEXP_EXEC_INTRINSIC, pattern, [value]);
  if (result === null) return null;
  if (!Array.isArray(result)) failMalformedConfiguration();
  const output: unknown[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const item: unknown = result[index];
    output[index] = item;
  }
  return objectFreeze(output);
}

function normalizeUnicode(value: string): string {
  const result: unknown = REFLECT_APPLY_INTRINSIC(STRING_NORMALIZE_INTRINSIC, value, ["NFKC"]);
  if (typeof result !== "string") return failMalformedConfiguration();
  return result;
}

function trimString(value: string): string {
  const result: unknown = REFLECT_APPLY_INTRINSIC(STRING_TRIM_INTRINSIC, value, []);
  if (typeof result !== "string") return failMalformedConfiguration();
  return result;
}

function lowerCaseString(value: string): string {
  const result: unknown = REFLECT_APPLY_INTRINSIC(STRING_TO_LOWER_CASE_INTRINSIC, value, []);
  if (typeof result !== "string") return failMalformedConfiguration();
  return result;
}

function stringCharCodeAt(value: string, index: number): number {
  const result: unknown = REFLECT_APPLY_INTRINSIC(STRING_CHAR_CODE_AT_INTRINSIC, value, [index]);
  if (typeof result !== "number" || !Number.isFinite(result)) return -1;
  return result;
}

function stringEndsWith(value: string, suffix: string): boolean {
  if (suffix.length > value.length) return false;
  const offset = value.length - suffix.length;
  for (let index = 0; index < suffix.length; index += 1) {
    if (value[offset + index] !== suffix[index]) return false;
  }
  return true;
}

export type ProviderConfigurationSafetyErrorCode =
  | "MALFORMED_CONFIGURATION"
  | "SECRET_IN_CONFIGURATION";

export class ProviderConfigurationSafetyError extends Error {
  readonly #providerConfigurationSafetyErrorBrand = true;

  public constructor(public readonly code: ProviderConfigurationSafetyErrorCode) {
    super(code === "SECRET_IN_CONFIGURATION"
      ? "Provider configuration contains credential-like material"
      : "Provider configuration is malformed");
    OBJECT_DEFINE_PROPERTY_INTRINSIC(this, "code", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: code
    });
    this.name = "ProviderConfigurationSafetyError";
  }

  public static isSafetyError(value: unknown): value is ProviderConfigurationSafetyError {
    if (typeof value !== "object" || value === null) return false;
    try {
      return #providerConfigurationSafetyErrorBrand in value;
    } catch {
      return false;
    }
  }
}

const isProviderConfigurationSafetyError =
  ProviderConfigurationSafetyError.isSafetyError;

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

function sortedCodeUnitStringCopy(values: readonly string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    let insertionIndex = output.length;
    while (insertionIndex > 0) {
      const previous = output[insertionIndex - 1];
      if (previous === undefined || compareCodeUnits(previous, value) <= 0) break;
      output[insertionIndex] = previous;
      insertionIndex -= 1;
    }
    output[insertionIndex] = value;
  }
  return output;
}

function failMalformedConfiguration(): never {
  throw new ProviderConfigurationSafetyError("MALFORMED_CONFIGURATION");
}

function failSecretConfiguration(): never {
  throw new ProviderConfigurationSafetyError("SECRET_IN_CONFIGURATION");
}

const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";

function normalizeConfigurationKey(key: string): string {
  const normalized = normalizeUnicode(key);
  let output = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const code = stringCharCodeAt(normalized, index);
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a)) {
      output += normalized[index] ?? "";
    } else if (code >= 0x41 && code <= 0x5a) {
      output += ASCII_LOWERCASE[code - 0x41] ?? "";
    }
  }
  return output;
}

function isSecretNormalizedConfigurationKey(normalized: string): boolean {
  if (setHas(SECRET_CONFIGURATION_KEYS, normalized)) return true;
  return stringEndsWith(normalized, "accesstoken")
    || stringEndsWith(normalized, "accesstokens")
    || stringEndsWith(normalized, "refreshtoken")
    || stringEndsWith(normalized, "refreshtokens")
    || stringEndsWith(normalized, "clienttoken")
    || stringEndsWith(normalized, "clienttokens")
    || stringEndsWith(normalized, "sessiontoken")
    || stringEndsWith(normalized, "sessiontokens")
    || stringEndsWith(normalized, "authtoken")
    || stringEndsWith(normalized, "authtokens")
    || stringEndsWith(normalized, "bearertoken")
    || stringEndsWith(normalized, "bearertokens")
    || stringEndsWith(normalized, "apitoken")
    || stringEndsWith(normalized, "apitokens")
    || stringEndsWith(normalized, "oauthtoken")
    || stringEndsWith(normalized, "oauthtokens")
    || stringEndsWith(normalized, "csrftoken")
    || stringEndsWith(normalized, "csrftokens")
    || stringEndsWith(normalized, "apikey")
    || stringEndsWith(normalized, "apikeys")
    || stringEndsWith(normalized, "secret")
    || stringEndsWith(normalized, "secrets")
    || stringEndsWith(normalized, "secretkey")
    || stringEndsWith(normalized, "secretkeys")
    || stringEndsWith(normalized, "privatekey")
    || stringEndsWith(normalized, "privatekeys")
    || stringEndsWith(normalized, "credential")
    || stringEndsWith(normalized, "credentials")
    || stringEndsWith(normalized, "password")
    || stringEndsWith(normalized, "passwords")
    || stringEndsWith(normalized, "passphrase")
    || stringEndsWith(normalized, "passphrases")
    || normalized === "cookie"
    || normalized === "cookies"
    || stringEndsWith(normalized, "authorizationheader")
    || stringEndsWith(normalized, "authheader")
    || stringEndsWith(normalized, "credentialref")
    || stringEndsWith(normalized, "credentialsref")
    || stringEndsWith(normalized, "credentialrefs")
    || stringEndsWith(normalized, "secretref")
    || stringEndsWith(normalized, "secretrefs")
    || stringEndsWith(normalized, "secretkeyref")
    || stringEndsWith(normalized, "secretkeyrefs")
    || stringEndsWith(normalized, "privatekeyref")
    || stringEndsWith(normalized, "privatekeyrefs")
    || stringEndsWith(normalized, "apikeyref")
    || stringEndsWith(normalized, "apikeyrefs")
    || stringEndsWith(normalized, "accesstokenref")
    || stringEndsWith(normalized, "accesstokenrefs")
    || stringEndsWith(normalized, "refreshtokenref")
    || stringEndsWith(normalized, "refreshtokenrefs")
    || stringEndsWith(normalized, "authtokenref")
    || stringEndsWith(normalized, "authtokenrefs")
    || stringEndsWith(normalized, "bearertokenref")
    || stringEndsWith(normalized, "bearertokenrefs")
    || stringEndsWith(normalized, "passwordref")
    || stringEndsWith(normalized, "passwordrefs")
    || stringEndsWith(normalized, "passphraseref")
    || stringEndsWith(normalized, "passphraserefs")
    || stringEndsWith(normalized, "secretaccesskey")
    || stringEndsWith(normalized, "secretaccesskeys")
    || stringEndsWith(normalized, "subscriptionkey")
    || stringEndsWith(normalized, "subscriptionkeys")
    || stringEndsWith(normalized, "sastoken")
    || stringEndsWith(normalized, "sastokens")
    || stringEndsWith(normalized, "sharedaccesssignature")
    || stringEndsWith(normalized, "sharedaccesssignatures");
}

function isSecretConfigurationKey(key: string): boolean {
  return isSecretNormalizedConfigurationKey(normalizeConfigurationKey(key));
}

function isAssignmentWhitespace(value: string, index: number): boolean {
  const code = stringCharCodeAt(value, index);
  return code === 0x09
    || code === 0x0a
    || code === 0x0b
    || code === 0x0c
    || code === 0x0d
    || code === 0x20;
}

function isSimpleAssignmentKeyCharacter(value: string, index: number): boolean {
  const code = stringCharCodeAt(value, index);
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x2e
    || code === 0x2d
    || code === 0x5f;
}

function copyStringRange(value: string, start: number, end: number): string {
  let output = "";
  for (let index = start; index < end; index += 1) {
    output += value[index] ?? "";
  }
  return output;
}

function readSimpleSerializedAssignment(
  value: string,
  operatorIndex: number
): readonly [string, string] | null {
  let cursor = operatorIndex - 1;
  while (cursor >= 0 && isAssignmentWhitespace(value, cursor)) cursor -= 1;
  if (cursor < 0) return null;

  let keyStart: number;
  let keyEnd: number;
  const closingQuote = value[cursor];
  if (closingQuote === "\"" || closingQuote === "'") {
    keyEnd = cursor;
    cursor -= 1;
    while (cursor >= 0 && value[cursor] !== closingQuote) cursor -= 1;
    if (cursor < 0) return null;
    keyStart = cursor + 1;
  } else {
    keyEnd = cursor + 1;
    while (cursor >= 0 && isSimpleAssignmentKeyCharacter(value, cursor)) {
      cursor -= 1;
    }
    keyStart = cursor + 1;
  }
  if (keyStart >= keyEnd) return null;

  cursor = operatorIndex + 1;
  while (cursor < value.length && isAssignmentWhitespace(value, cursor)) cursor += 1;
  const key = copyStringRange(value, keyStart, keyEnd);
  if (cursor >= value.length) return objectFreeze([key, ""]);

  const openingQuote = value[cursor];
  if (openingQuote === "\"" || openingQuote === "'") {
    cursor += 1;
    const valueStart = cursor;
    while (cursor < value.length && value[cursor] !== openingQuote) cursor += 1;
    return objectFreeze([key, copyStringRange(value, valueStart, cursor)]);
  }

  const valueStart = cursor;
  while (
    cursor < value.length
    && !isAssignmentWhitespace(value, cursor)
    && value[cursor] !== ","
    && value[cursor] !== ";"
    && value[cursor] !== "&"
  ) {
    cursor += 1;
  }
  return objectFreeze([key, copyStringRange(value, valueStart, cursor)]);
}

function isAuthorizationConfigurationKey(key: string): boolean {
  return key === "auth"
    || key === "authorization"
    || key === "authorizationheader"
    || key === "httpauthorization"
    || key === "authheader";
}

function containsStructuredSecretAssignment(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "=" && character !== ":") continue;
    const assignment = readSimpleSerializedAssignment(value, index);
    if (assignment === null) continue;

    const normalizedKey = normalizeConfigurationKey(assignment[0]);
    if (!isSecretNormalizedConfigurationKey(normalizedKey)) continue;
    if (normalizedKey === "token" || normalizedKey === "secret") continue;

    const normalizedValue = lowerCaseString(trimString(assignment[1]));
    const allowedValues = isAuthorizationConfigurationKey(normalizedKey)
      ? AUTHORIZATION_NON_SECRET_ASSIGNMENT_VALUES
      : GENERIC_NON_SECRET_ASSIGNMENT_VALUES;
    if (!setHas(allowedValues, normalizedValue)) return true;
  }
  return false;
}

function base64Value(character: string): number {
  const code = stringCharCodeAt(character, 0);
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (character === "+") return 62;
  if (character === "/") return 63;
  return -1;
}

function base64ContainsColon(candidate: string): boolean {
  let contentLength = candidate.length;
  while (contentLength > 0 && candidate[contentLength - 1] === "=") {
    contentLength -= 1;
  }
  const paddingLength = candidate.length - contentLength;
  if (
    candidate.length < 2
    || candidate.length % 4 === 1
    || paddingLength > 2
  ) {
    return false;
  }

  let accumulator = 0;
  let bitCount = 0;
  let sawColon = false;
  for (let index = 0; index < contentLength; index += 1) {
    const character = candidate[index];
    if (character === undefined) return false;
    const value = base64Value(character);
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
  const match = regexpExec(BASIC_AUTH_CANDIDATE_PATTERN, value);
  const candidate = match?.[1];
  return typeof candidate === "string" && base64ContainsColon(candidate);
}

function containsExplicitCredentialAssignment(value: string): boolean {
  if (regexpExec(AUTHORIZATION_SCHEME_VALUE_PATTERN, value) !== null) return true;
  if (containsStructuredSecretAssignment(value)) return true;

  const highConfidence = regexpExec(HIGH_CONFIDENCE_SECRET_ASSIGNMENT_PATTERN, value);
  if (highConfidence !== null) {
    const keyCandidate = highConfidence[1];
    const key = normalizeConfigurationKey(
      typeof keyCandidate === "string" ? keyCandidate : ""
    );
    const assignedValueCandidate =
      highConfidence[2] ?? highConfidence[3] ?? highConfidence[4] ?? "";
    const assignedValue = typeof assignedValueCandidate === "string"
      ? assignedValueCandidate
      : "";
    const normalizedValue = lowerCaseString(trimString(assignedValue));
    const allowedValues = (
      isAuthorizationConfigurationKey(key)
    )
      ? AUTHORIZATION_NON_SECRET_ASSIGNMENT_VALUES
      : GENERIC_NON_SECRET_ASSIGNMENT_VALUES;
    if (!setHas(allowedValues, normalizedValue)) return true;
  }
  return regexpExec(GENERIC_SECRET_ASSIGNMENT_PATTERN, value) !== null;
}

export function containsSecretLikeConfigurationText(value: string): boolean {
  const normalized = normalizeUnicode(value);
  return regexpExec(BEARER_AUTH_PATTERN, normalized) !== null
    || containsBasicAuthCredential(normalized)
    || regexpExec(COMMON_API_KEY_PATTERN, normalized) !== null
    || regexpExec(URL_USERINFO_PATTERN, normalized) !== null
    || regexpExec(PRIVATE_KEY_PATTERN, normalized) !== null
    || containsExplicitCredentialAssignment(normalized);
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
    setAdd(allowedKeys, key);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      failMalformedConfiguration();
    }
    const item: unknown = descriptor.value;
    output[index] = inspectConfigurationValue(item, state, depth + 1, rejectSecrets);
  }
  const descriptorKeys = Object.keys(descriptors);
  for (let index = 0; index < descriptorKeys.length; index += 1) {
    const key = descriptorKeys[index];
    if (key !== undefined && !setHas(allowedKeys, key)) failMalformedConfiguration();
  }
  return objectFreeze(output);
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

  const descriptorKeys = Object.keys(descriptors);
  if (descriptorKeys.length > PROVIDER_CONFIGURATION_LIMITS.maxObjectEntries) {
    failMalformedConfiguration();
  }

  const sortedKeys = sortedCodeUnitStringCopy(descriptorKeys);
  const output: Record<string, SafeProviderConfigurationValue> = {};
  objectSetPrototypeOf(output, null);
  for (let index = 0; index < sortedKeys.length; index += 1) {
    const key = sortedKeys[index];
    if (key === undefined) continue;
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || key.length === 0
      || key.length > PROVIDER_CONFIGURATION_LIMITS.maxKeyLength
      || setHas(BLOCKED_CONFIGURATION_KEYS, key)
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      failMalformedConfiguration();
    }
    const item: unknown = descriptor.value;
    if (rejectSecrets && isSecretConfigurationKey(key)) failSecretConfiguration();
    output[key] = inspectConfigurationValue(item, state, depth + 1, rejectSecrets);
  }
  return objectFreeze(output);
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
    return Object.is(value, -0) ? 0 : value;
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

  if (weakSetHas(state.seen, value)) failMalformedConfiguration();
  weakSetAdd(state.seen, value);
  try {
    if (Array.isArray(value)) return inspectConfigurationArray(value, state, depth, rejectSecrets);
    return inspectConfigurationRecord(value, state, depth, rejectSecrets);
  } finally {
    weakSetDelete(state.seen, value);
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
  return isProviderConfigurationSafetyError(error)
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

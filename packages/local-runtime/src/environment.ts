import { types as utilTypes } from "node:util";
import { DIAGNOSTIC_SANITIZATION_LIMITS } from "../../diagnostics/src/index.js";
import type { LocalEnvironmentDefinition } from "./types.js";

export const DEFAULT_POSIX_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR"
] as const);

export const DEFAULT_WINDOWS_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP"
] as const);

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SECRET_KEY = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION)/iu;
const MAX_CONFIGURED_ENVIRONMENT_KEYS = 256;

export interface BuiltLocalEnvironment {
  readonly environment: NodeJS.ProcessEnv;
  readonly secretValues: readonly string[];
}

export function buildLocalEnvironment(
  definition: LocalEnvironmentDefinition | undefined,
  parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): BuiltLocalEnvironment {
  const inspectedDefinition = inspectEnvironmentDefinition(definition);
  const environment = Object.create(null) as NodeJS.ProcessEnv;
  const secretValues = new Set<string>();
  const defaults = platform === "win32"
    ? DEFAULT_WINDOWS_INHERITED_ENVIRONMENT_KEYS
    : DEFAULT_POSIX_INHERITED_ENVIRONMENT_KEYS;
  const inherited = [...defaults, ...(inspectedDefinition?.inherit ?? [])];
  const inheritedNames = new Set<string>();

  for (const key of inherited) {
    validateEnvironmentKey(key);
    const identity = normalizeKey(key, platform);
    if (inheritedNames.has(identity)) continue;
    inheritedNames.add(identity);
    const parentEntry = findParentEntry(parent, key, platform);
    if (parentEntry === undefined) continue;
    environment[parentEntry.key] = parentEntry.value;
    if (SECRET_KEY.test(parentEntry.key)) {
      addSecretRedactionVariants(secretValues, parentEntry.value);
    }
  }

  const explicitNames = new Set<string>();
  for (const [key, value] of ownDataEntries(inspectedDefinition?.values, "environment.values")) {
    validateEnvironmentEntry(key, value);
    const identity = normalizeKey(key, platform);
    if (explicitNames.has(identity)) throw new Error(`Duplicate explicit environment key: ${key}`);
    explicitNames.add(identity);
    if (explicitNames.size > MAX_CONFIGURED_ENVIRONMENT_KEYS) {
      throw new Error(`Environment configuration may contain at most ${String(MAX_CONFIGURED_ENVIRONMENT_KEYS)} explicit keys`);
    }
    removeEquivalentKey(environment, key, platform);
    environment[key] = value;
    if (SECRET_KEY.test(key)) addSecretRedactionVariants(secretValues, value);
  }

  for (const [key, value] of ownDataEntries(inspectedDefinition?.secrets, "environment.secrets")) {
    validateEnvironmentEntry(key, value);
    const identity = normalizeKey(key, platform);
    if (explicitNames.has(identity)) {
      throw new Error(`Environment key cannot be both public and secret: ${key}`);
    }
    explicitNames.add(identity);
    if (explicitNames.size > MAX_CONFIGURED_ENVIRONMENT_KEYS) {
      throw new Error(`Environment configuration may contain at most ${String(MAX_CONFIGURED_ENVIRONMENT_KEYS)} explicit keys`);
    }
    removeEquivalentKey(environment, key, platform);
    environment[key] = value;
    addSecretRedactionVariants(secretValues, value);
  }

  return Object.freeze({
    environment: Object.freeze(environment),
    secretValues: Object.freeze([...secretValues].sort((left, right) => right.length - left.length))
  });
}

function addSecretRedactionVariants(target: Set<string>, value: string): void {
  if (value.length === 0) return;

  const candidates = new Set<string>([value]);
  let start = 0;
  let physicalLines = 1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code !== 0x0a && code !== 0x0d) continue;
    const fragment = value.slice(start, index);
    if (fragment.length > 0) candidates.add(fragment);
    if (code === 0x0d && value.charCodeAt(index + 1) === 0x0a) index += 1;
    start = index + 1;
    physicalLines += 1;
    if (physicalLines > DIAGNOSTIC_SANITIZATION_LIMITS.maxArrayItems) {
      throw new Error(
        `Secret environment values may contain at most ${String(DIAGNOSTIC_SANITIZATION_LIMITS.maxArrayItems)} physical lines`
      );
    }
  }
  const tail = value.slice(start);
  if (tail.length > 0) candidates.add(tail);

  for (const candidate of [...candidates]) {
    const encoded = JSON.stringify(candidate);
    if (typeof encoded === "string" && encoded.length >= 2) {
      const inner = encoded.slice(1, -1);
      if (inner.length > 0) candidates.add(inner);
    }
  }

  for (const candidate of candidates) {
    if (candidate.length === 0 || target.has(candidate)) continue;
    if (target.size >= DIAGNOSTIC_SANITIZATION_LIMITS.maxNodes) {
      throw new Error(
        `Runtime secret redaction may contain at most ${String(DIAGNOSTIC_SANITIZATION_LIMITS.maxNodes)} patterns`
      );
    }
    target.add(candidate);
  }
}

function safelyIsEnvironmentArray(value: unknown, label: string): boolean {
  if (typeof value === "object" && value !== null && utilTypes.isProxy(value)) {
    throw new Error(`${label} could not be inspected`);
  }
  try {
    return Array.isArray(value);
  } catch {
    throw new Error(`${label} could not be inspected`);
  }
}

function inspectEnvironmentDefinition(
  definition: LocalEnvironmentDefinition | undefined
): LocalEnvironmentDefinition | undefined {
  if (definition === undefined) return undefined;
  if (typeof definition !== "object" || definition === null
      || safelyIsEnvironmentArray(definition, "Environment definition")) {
    throw new Error("Environment definition must be an object");
  }

  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(definition);
  } catch {
    throw new Error("Environment definition could not be inspected");
  }

  const allowed = new Set(["inherit", "values", "secrets"]);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key) && descriptor.enumerable === true) {
      throw new Error(`Unknown environment definition field: ${key}`);
    }
    if (allowed.has(key) && !("value" in descriptor)) {
      throw new Error(`Environment definition field ${key} may not be an accessor`);
    }
  }

  const inheritValue = descriptors.inherit?.value as unknown;
  const valuesValue = descriptors.values?.value as unknown;
  const secretsValue = descriptors.secrets?.value as unknown;

  const inherit = inheritValue === undefined
    ? undefined
    : inspectEnvironmentKeyArray(inheritValue, "environment.inherit");

  const values = valuesValue === undefined
    ? undefined
    : validateAndReturnStringRecord(valuesValue, "environment.values");
  const secrets = secretsValue === undefined
    ? undefined
    : validateAndReturnStringRecord(secretsValue, "environment.secrets");

  return Object.freeze({
    ...(inherit === undefined ? {} : { inherit }),
    ...(values === undefined ? {} : { values }),
    ...(secrets === undefined ? {} : { secrets })
  });
}

function validateAndReturnStringRecord(
  value: unknown,
  label: string
): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || safelyIsEnvironmentArray(value, label)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = ownDataEntries(value as Readonly<Record<string, string>>, label);
  if (entries.length > MAX_CONFIGURED_ENVIRONMENT_KEYS) {
    throw new Error(`${label} may contain at most ${String(MAX_CONFIGURED_ENVIRONMENT_KEYS)} keys`);
  }
  const copy = Object.create(null) as Record<string, string>;
  for (const [key, entryValue] of entries) {
    validateEnvironmentEntry(key, entryValue);
    copy[key] = entryValue;
  }
  return Object.freeze(copy);
}

function inspectEnvironmentKeyArray(value: unknown, label: string): readonly string[] {
  if (!safelyIsEnvironmentArray(value, label)) throw new Error(`${label} must be an array`);

  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`${label} could not be inspected`);
  }

  const rawLength = descriptors.length?.value as unknown;
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) {
    throw new Error(`${label} has an invalid length`);
  }
  if (rawLength > MAX_CONFIGURED_ENVIRONMENT_KEYS) {
    throw new Error(`${label} may contain at most ${String(MAX_CONFIGURED_ENVIRONMENT_KEYS)} keys`);
  }

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length" || descriptor.enumerable !== true) continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} may not contain extra enumerable properties`);
    }
  }

  const copy: string[] = [];
  for (let index = 0; index < rawLength; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${label} must be a dense data-only array`);
    }
    validateEnvironmentKey(descriptor.value);
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
}

function ownDataEntries(
  value: Readonly<Record<string, string>> | undefined,
  label: string
): readonly (readonly [string, string])[] {
  if (value === undefined) return [];
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`${label} could not be inspected`);
  }

  const entries: (readonly [string, string])[] = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.enumerable !== true) continue;
    if (!("value" in descriptor)) throw new Error(`${label} may not contain accessors`);
    if (typeof descriptor.value !== "string") {
      throw new Error(`${label} values must be strings`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function validateEnvironmentEntry(key: string, value: string): void {
  validateEnvironmentKey(key);
  if (value.includes("\0")) throw new Error(`Environment value for ${key} contains a NUL byte`);
}

function validateEnvironmentKey(key: unknown): asserts key is string {
  if (typeof key !== "string") {
    throw new Error("Invalid environment key: expected a string");
  }
  if (!ENVIRONMENT_KEY.test(key)) {
    throw new Error(`Invalid environment key: ${key}`);
  }
}

function normalizeKey(key: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? key.toUpperCase() : key;
}

function findParentEntry(
  parent: NodeJS.ProcessEnv,
  requested: string,
  platform: NodeJS.Platform
): { readonly key: string; readonly value: string } | undefined {
  if (utilTypes.isProxy(parent)) return undefined;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(parent);
  } catch {
    return undefined;
  }

  if (platform !== "win32") {
    const descriptor = descriptors[requested];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      return undefined;
    }
    return { key: requested, value: descriptor.value };
  }

  const wanted = requested.toUpperCase();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key.toUpperCase() !== wanted || !("value" in descriptor) || typeof descriptor.value !== "string") continue;
    return { key, value: descriptor.value };
  }
  return undefined;
}

function removeEquivalentKey(environment: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): void {
  const identity = normalizeKey(key, platform);
  for (const existing of Object.keys(environment)) {
    if (normalizeKey(existing, platform) === identity) Reflect.deleteProperty(environment, existing);
  }
}

import type { LocalEnvironmentDefinition } from "./types.js";

export const DEFAULT_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR"
] as const);

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SECRET_KEY = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION)/iu;

export interface BuiltLocalEnvironment {
  readonly environment: NodeJS.ProcessEnv;
  readonly secretValues: readonly string[];
}

export function buildLocalEnvironment(
  definition: LocalEnvironmentDefinition | undefined,
  parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): BuiltLocalEnvironment {
  const environment: NodeJS.ProcessEnv = {};
  const secretValues = new Set<string>();
  const inherited = [...DEFAULT_INHERITED_ENVIRONMENT_KEYS, ...(definition?.inherit ?? [])];
  const inheritedNames = new Set<string>();

  for (const key of inherited) {
    validateEnvironmentKey(key);
    const identity = normalizeKey(key, platform);
    if (inheritedNames.has(identity)) continue;
    inheritedNames.add(identity);
    const parentEntry = findParentEntry(parent, key, platform);
    if (parentEntry === undefined) continue;
    environment[parentEntry.key] = parentEntry.value;
    if (SECRET_KEY.test(parentEntry.key) && parentEntry.value.length > 0) secretValues.add(parentEntry.value);
  }

  const values = definition?.values ?? {};
  const secrets = definition?.secrets ?? {};
  const explicitNames = new Set<string>();

  for (const [key, value] of Object.entries(values)) {
    validateEnvironmentEntry(key, value);
    const identity = normalizeKey(key, platform);
    if (explicitNames.has(identity)) throw new Error(`Duplicate explicit environment key: ${key}`);
    explicitNames.add(identity);
    removeEquivalentKey(environment, key, platform);
    environment[key] = value;
  }

  for (const [key, value] of Object.entries(secrets)) {
    validateEnvironmentEntry(key, value);
    const identity = normalizeKey(key, platform);
    if (explicitNames.has(identity)) throw new Error(`Environment key cannot be both public and secret: ${key}`);
    explicitNames.add(identity);
    removeEquivalentKey(environment, key, platform);
    environment[key] = value;
    if (value.length > 0) secretValues.add(value);
  }

  return {
    environment,
    secretValues: Object.freeze([...secretValues].sort((left, right) => right.length - left.length))
  };
}

function validateEnvironmentEntry(key: string, value: string): void {
  validateEnvironmentKey(key);
  if (value.includes("\0")) throw new Error(`Environment value for ${key} contains a NUL byte`);
}

function validateEnvironmentKey(key: string): void {
  if (!ENVIRONMENT_KEY.test(key)) throw new Error(`Invalid environment key: ${key}`);
}

function normalizeKey(key: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? key.toUpperCase() : key;
}

function findParentEntry(
  parent: NodeJS.ProcessEnv,
  requested: string,
  platform: NodeJS.Platform
): { readonly key: string; readonly value: string } | undefined {
  if (platform !== "win32") {
    const value = parent[requested];
    return value === undefined ? undefined : { key: requested, value };
  }
  const wanted = requested.toUpperCase();
  for (const [key, value] of Object.entries(parent)) {
    if (key.toUpperCase() === wanted && value !== undefined) return { key, value };
  }
  return undefined;
}

function removeEquivalentKey(environment: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): void {
  const identity = normalizeKey(key, platform);
  for (const existing of Object.keys(environment)) {
    if (normalizeKey(existing, platform) === identity) Reflect.deleteProperty(environment, existing);
  }
}

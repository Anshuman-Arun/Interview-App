import { createHash } from "node:crypto";
import { z } from "zod";
import { isProxy } from "node:util/types";

const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?$/u;
const PORTABLE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const MAX_HTTP_URL_LENGTH = 2_048;

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object"
      || value === null
      || isProxy(value)
      || Array.isArray(value)) return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined
          || !("value" in descriptor)
          || descriptor.enumerable !== true) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function cloneOwnDataRecord<T extends Record<string, unknown>>(value: T): T {
  const clone = { ...value };
  Object.setPrototypeOf(clone, null);
  return clone;
}

const PlainDataRecordSchema = z.custom<Record<string, unknown>>(isPlainDataRecord)
  .transform(cloneOwnDataRecord);

function clonePlainDataArray(value: unknown): readonly unknown[] | undefined {
  if (typeof value !== "object" || value === null || isProxy(value) || !Array.isArray(value)) {
    return undefined;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype) return undefined;
    const clone: unknown[] = [];
    clone.length = value.length;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      clone[index] = descriptor.value;
    }
    return clone;
  } catch {
    return undefined;
  }
}

export const AssetPlatformSchema = z.enum([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32"
]);
export type AssetPlatform = z.infer<typeof AssetPlatformSchema>;

export const AssetArchitectureSchema = z.enum([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64"
]);
export type AssetArchitecture = z.infer<typeof AssetArchitectureSchema>;

export const AssetTypeSchema = z.enum([
  "MODEL",
  "TOKENIZER",
  "VOCAB",
  "CONFIG",
  "RUNTIME",
  "DATA",
  "OTHER"
]);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const AssetInstallStatusSchema = z.enum([
  "NOT_PRESENT",
  "DOWNLOADING",
  "VERIFYING",
  "INSTALLED",
  "CORRUPT",
  "FAILED"
]);
export type AssetInstallStatus = z.infer<typeof AssetInstallStatusSchema>;

export const StableAssetIdentifierSchema = z.string()
  .min(1)
  .max(64)
  .regex(STABLE_ID_PATTERN);

export const AssetVersionSchema = z.string()
  .min(1)
  .max(64)
  .regex(VERSION_PATTERN);

export const PortableAssetFilenameSchema = z.string()
  .min(1)
  .max(96)
  .regex(PORTABLE_FILENAME_PATTERN)
  .refine((value) => value !== "." && value !== "..", "filename must be a leaf name")
  .refine((value) => !value.endsWith("."), "filename may not end with a dot")
  .refine((value) => value.toLowerCase() !== "manifest.json", "filename is reserved for cache metadata")
  .refine((value) => !WINDOWS_DEVICE_NAME_PATTERN.test(value), "filename is reserved on Windows");

export const Sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;

const HttpSourceUrlSchema = z.url().max(MAX_HTTP_URL_LENGTH).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username.length === 0
      && url.password.length === 0
      && url.href.length <= MAX_HTTP_URL_LENGTH;
  } catch {
    return false;
  }
}, "sourceUrl must be a bounded HTTP(S) URL without embedded credentials");

const OptionalMetadataTextSchema = z.string().min(1).max(512);

export const AssetManifestSchema = PlainDataRecordSchema.pipe(z.object({
  schemaVersion: z.literal(1),
  familyId: StableAssetIdentifierSchema,
  artifactId: StableAssetIdentifierSchema,
  version: AssetVersionSchema,
  type: AssetTypeSchema,
  platform: AssetPlatformSchema.optional(),
  architecture: AssetArchitectureSchema.optional(),
  variant: StableAssetIdentifierSchema.optional(),
  filename: PortableAssetFilenameSchema,
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: Sha256DigestSchema,
  sourceUrl: HttpSourceUrlSchema,
  modelVersion: OptionalMetadataTextSchema.optional(),
  protocolVersion: OptionalMetadataTextSchema.optional(),
  license: PlainDataRecordSchema.pipe(z.object({
    name: OptionalMetadataTextSchema,
    url: HttpSourceUrlSchema.optional()
  }).strict()).transform(cloneOwnDataRecord).optional(),
  sourceMetadata: PlainDataRecordSchema.pipe(z.object({
    publisher: OptionalMetadataTextSchema.optional(),
    repository: HttpSourceUrlSchema.optional(),
    revision: OptionalMetadataTextSchema.optional()
  }).strict()).transform(cloneOwnDataRecord).optional()
}).strict()).transform(cloneOwnDataRecord);
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export const AssetResolutionRequestSchema = PlainDataRecordSchema.pipe(z.object({
  familyId: StableAssetIdentifierSchema,
  version: AssetVersionSchema,
  platform: AssetPlatformSchema,
  architecture: AssetArchitectureSchema,
  variant: StableAssetIdentifierSchema.optional()
}).strict()).transform(cloneOwnDataRecord);
export type AssetResolutionRequest = z.infer<typeof AssetResolutionRequestSchema>;

const CurrentPlatformResolutionRequestSchema = PlainDataRecordSchema.pipe(z.object({
  familyId: StableAssetIdentifierSchema,
  version: AssetVersionSchema,
  variant: StableAssetIdentifierSchema.optional()
}).strict()).transform(cloneOwnDataRecord);

export const AssetDiagnosticMetadataSchema = PlainDataRecordSchema.pipe(z.object({
  artifactId: StableAssetIdentifierSchema,
  familyId: StableAssetIdentifierSchema,
  version: AssetVersionSchema,
  sha256: Sha256DigestSchema,
  status: AssetInstallStatusSchema,
  byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).strict()).transform(cloneOwnDataRecord);
export type AssetDiagnosticMetadata = z.infer<typeof AssetDiagnosticMetadataSchema>;

export type ModelAssetErrorCode =
  | "INVALID_MANIFEST"
  | "UNSUPPORTED_PLATFORM"
  | "AMBIGUOUS_ARTIFACT"
  | "INVALID_CONFIGURATION"
  | "INVALID_CACHE_ROOT"
  | "PATH_ESCAPE"
  | "UNSAFE_PATH"
  | "ARTIFACT_TOO_LARGE"
  | "CACHE_LIMIT_EXCEEDED"
  | "INSUFFICIENT_DISK_SPACE"
  | "NETWORK_ERROR"
  | "HTTP_STATUS"
  | "REDIRECT_LIMIT"
  | "UNSAFE_REDIRECT"
  | "DOWNLOAD_TIMEOUT"
  | "CANCELLED"
  | "SIZE_MISMATCH"
  | "DIGEST_MISMATCH"
  | "CORRUPT_INSTALLATION"
  | "NOT_INSTALLED"
  | "ASSET_BUSY"
  | "IO_ERROR";

export class ModelAssetError extends Error {
  public readonly code: ModelAssetErrorCode;

  public constructor(code: ModelAssetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelAssetError";
    this.code = code;
  }
}

export function parseAssetManifest(value: unknown): AssetManifest {
  const result = AssetManifestSchema.safeParse(value);
  if (!result.success) {
    throw new ModelAssetError("INVALID_MANIFEST", "Asset manifest validation failed.");
  }
  return result.data;
}

export function resolveAssetManifest(
  manifests: readonly unknown[],
  requestValue: unknown
): AssetManifest {
  const manifestValues = clonePlainDataArray(manifests);
  if (manifestValues === undefined) {
    throw new ModelAssetError(
      "INVALID_MANIFEST",
      "Asset manifest collection must be a plain dense data array."
    );
  }
  const requestResult = AssetResolutionRequestSchema.safeParse(requestValue);
  if (!requestResult.success) {
    throw new ModelAssetError("INVALID_MANIFEST", "Asset resolution request validation failed.");
  }
  const request = requestResult.data;
  let best: AssetManifest | undefined;
  let bestSpecificity = -1;
  let ambiguous = false;

  for (let index = 0; index < manifestValues.length; index += 1) {
    const manifest = parseAssetManifest(manifestValues[index]);
    if (manifest.familyId !== request.familyId || manifest.version !== request.version) continue;
    if (manifest.platform !== undefined && manifest.platform !== request.platform) continue;
    if (manifest.architecture !== undefined && manifest.architecture !== request.architecture) continue;
    if (request.variant === undefined ? manifest.variant !== undefined : manifest.variant !== request.variant) {
      continue;
    }

    const specificity = Number(manifest.platform !== undefined) + Number(manifest.architecture !== undefined);
    if (specificity > bestSpecificity) {
      best = manifest;
      bestSpecificity = specificity;
      ambiguous = false;
    } else if (specificity === bestSpecificity) {
      ambiguous = true;
    }
  }

  if (best === undefined) {
    throw new ModelAssetError(
      "UNSUPPORTED_PLATFORM",
      "No artifact exactly compatible with the requested platform, architecture, and variant is available."
    );
  }
  if (ambiguous) {
    throw new ModelAssetError(
      "AMBIGUOUS_ARTIFACT",
      "More than one equally specific artifact matches the requested target."
    );
  }
  return best;
}

export function resolveAssetForCurrentPlatform(
  manifests: readonly unknown[],
  requestValue: Omit<AssetResolutionRequest, "platform" | "architecture">
): AssetManifest {
  const requestResult = CurrentPlatformResolutionRequestSchema.safeParse(requestValue);
  if (!requestResult.success) {
    throw new ModelAssetError(
      "INVALID_MANIFEST",
      "Current-platform asset resolution request validation failed."
    );
  }
  const platform = AssetPlatformSchema.safeParse(process.platform);
  const architecture = AssetArchitectureSchema.safeParse(process.arch);
  if (!platform.success || !architecture.success) {
    throw new ModelAssetError(
      "UNSUPPORTED_PLATFORM",
      "The current runtime platform or architecture is not represented by the asset manifest schema."
    );
  }
  return resolveAssetManifest(manifests, {
    ...requestResult.data,
    platform: platform.data,
    architecture: architecture.data
  });
}

export function artifactInstallationKey(manifestValue: unknown): string {
  const manifest = parseAssetManifest(manifestValue);
  const identity = [
    String(manifest.schemaVersion),
    manifest.familyId,
    manifest.artifactId,
    manifest.version,
    manifest.type,
    manifest.platform ?? "*",
    manifest.architecture ?? "*",
    manifest.variant ?? "*",
    manifest.filename,
    String(manifest.sizeBytes),
    manifest.sha256
  ].join("\u0000");
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

export function serializeAssetManifest(manifestValue: unknown): string {
  const manifest = parseAssetManifest(manifestValue);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

import { createHash } from "node:crypto";
import { z } from "zod";

const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?$/u;
const PORTABLE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

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

const HttpSourceUrlSchema = z.string().max(2048).url().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}, "sourceUrl must be an HTTP(S) URL without embedded credentials");

const OptionalMetadataTextSchema = z.string().min(1).max(512);

export const AssetManifestSchema = z.object({
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
  license: z.object({
    name: OptionalMetadataTextSchema,
    url: HttpSourceUrlSchema.optional()
  }).strict().optional(),
  sourceMetadata: z.object({
    publisher: OptionalMetadataTextSchema.optional(),
    repository: HttpSourceUrlSchema.optional(),
    revision: OptionalMetadataTextSchema.optional()
  }).strict().optional()
}).strict();
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export const AssetResolutionRequestSchema = z.object({
  familyId: StableAssetIdentifierSchema,
  version: AssetVersionSchema,
  platform: AssetPlatformSchema,
  architecture: AssetArchitectureSchema,
  variant: StableAssetIdentifierSchema.optional()
}).strict();
export type AssetResolutionRequest = z.infer<typeof AssetResolutionRequestSchema>;

export const AssetDiagnosticMetadataSchema = z.object({
  artifactId: StableAssetIdentifierSchema,
  familyId: StableAssetIdentifierSchema,
  version: AssetVersionSchema,
  sha256: Sha256DigestSchema,
  status: AssetInstallStatusSchema,
  byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).strict();
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
  const requestResult = AssetResolutionRequestSchema.safeParse(requestValue);
  if (!requestResult.success) {
    throw new ModelAssetError("INVALID_MANIFEST", "Asset resolution request validation failed.");
  }
  const request = requestResult.data;
  const manifestsParsed = manifests.map((manifest) => parseAssetManifest(manifest));
  const compatible = manifestsParsed.filter((manifest) => {
    if (manifest.familyId !== request.familyId || manifest.version !== request.version) return false;
    if (manifest.platform !== undefined && manifest.platform !== request.platform) return false;
    if (manifest.architecture !== undefined && manifest.architecture !== request.architecture) return false;
    if (request.variant === undefined) return manifest.variant === undefined;
    return manifest.variant === request.variant;
  });

  if (compatible.length === 0) {
    throw new ModelAssetError(
      "UNSUPPORTED_PLATFORM",
      "No artifact exactly compatible with the requested platform, architecture, and variant is available."
    );
  }

  const scored = compatible.map((manifest) => ({
    manifest,
    specificity: Number(manifest.platform !== undefined) + Number(manifest.architecture !== undefined)
  }));
  const bestSpecificity = Math.max(...scored.map((entry) => entry.specificity));
  const best = scored.filter((entry) => entry.specificity === bestSpecificity);
  if (best.length !== 1 || best[0] === undefined) {
    throw new ModelAssetError(
      "AMBIGUOUS_ARTIFACT",
      "More than one equally specific artifact matches the requested target."
    );
  }
  return best[0].manifest;
}

export function resolveAssetForCurrentPlatform(
  manifests: readonly unknown[],
  request: Omit<AssetResolutionRequest, "platform" | "architecture">
): AssetManifest {
  const platform = AssetPlatformSchema.safeParse(process.platform);
  const architecture = AssetArchitectureSchema.safeParse(process.arch);
  if (!platform.success || !architecture.success) {
    throw new ModelAssetError(
      "UNSUPPORTED_PLATFORM",
      "The current runtime platform or architecture is not represented by the asset manifest schema."
    );
  }
  return resolveAssetManifest(manifests, {
    ...request,
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

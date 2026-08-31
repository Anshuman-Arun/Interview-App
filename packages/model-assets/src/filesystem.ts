import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rmdir,
  statfs,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ModelAssetError,
  Sha256DigestSchema,
  type AssetManifest,
  type Sha256Digest
} from "./types.js";

export const MAX_STORED_MANIFEST_BYTES = 64 * 1024;

export interface FileVerificationExpectations {
  readonly sizeBytes: number;
  readonly sha256: Sha256Digest;
  readonly maxBytes?: number;
}

export type FileVerificationResult =
  | {
      readonly ok: true;
      readonly actualBytes: number;
      readonly actualSha256: Sha256Digest;
    }
  | {
      readonly ok: false;
      readonly reason: "SIZE_MISMATCH" | "DIGEST_MISMATCH";
      readonly actualBytes: number;
      readonly actualSha256?: Sha256Digest;
    };

export interface CachePaths {
  readonly root: string;
  readonly artifacts: string;
  readonly temporary: string;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function assertPathInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".") return;
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new ModelAssetError("PATH_ESCAPE", "Resolved asset path escapes the configured cache root.");
  }
}

export async function initializeCachePaths(rootInput: string): Promise<CachePaths> {
  if (!path.isAbsolute(rootInput)) {
    throw new ModelAssetError("INVALID_CACHE_ROOT", "Asset cache root must be an absolute path.");
  }
  try {
    await mkdir(rootInput, { recursive: true });
    const canonicalRoot = await realpath(rootInput);
    const rootStat = await lstat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new ModelAssetError("INVALID_CACHE_ROOT", "Asset cache root must resolve to a directory.");
    }
    const artifacts = path.join(canonicalRoot, "artifacts");
    const temporary = path.join(canonicalRoot, "tmp");
    await ensureSafeDirectory(canonicalRoot, artifacts);
    await ensureSafeDirectory(canonicalRoot, temporary);
    return { root: canonicalRoot, artifacts, temporary };
  } catch (error) {
    if (error instanceof ModelAssetError) throw error;
    throw new ModelAssetError("INVALID_CACHE_ROOT", "Unable to initialize the asset cache root.", { cause: error });
  }
}

export async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  assertPathInsideRoot(root, directory);
  const relative = path.relative(root, directory);
  if (relative === "") return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new ModelAssetError("UNSAFE_PATH", "Unsafe cache path segment rejected.");
    }
    current = path.join(current, segment);
    assertPathInsideRoot(root, current);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new ModelAssetError("UNSAFE_PATH", "Cache path contains a symbolic link or non-directory entry.");
      }
    } catch (error) {
      if (error instanceof ModelAssetError) throw error;
      if (errnoCode(error) !== "ENOENT") {
        throw new ModelAssetError("IO_ERROR", "Unable to inspect cache directory.", { cause: error });
      }
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (errnoCode(mkdirError) !== "EEXIST") {
          throw new ModelAssetError("IO_ERROR", "Unable to create cache directory.", { cause: mkdirError });
        }
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new ModelAssetError("UNSAFE_PATH", "Cache directory creation raced with an unsafe filesystem entry.");
      }
    }
  }
}

export async function pathEntryExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw new ModelAssetError("IO_ERROR", "Unable to inspect cache entry.", { cause: error });
  }
}

export async function removeEntryInsideRoot(root: string, candidate: string): Promise<void> {
  assertPathInsideRoot(root, candidate);
  if (path.resolve(candidate) === path.resolve(root)) {
    throw new ModelAssetError("PATH_ESCAPE", "Refusing to remove the configured cache root itself.");
  }
  let entry: Stats;
  try {
    entry = await lstat(candidate);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw new ModelAssetError("IO_ERROR", "Unable to inspect cache entry for removal.", { cause: error });
  }

  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    try {
      await unlink(candidate);
      return;
    } catch (error) {
      throw new ModelAssetError("IO_ERROR", "Unable to remove cache file entry.", { cause: error });
    }
  }

  try {
    const directory = await opendir(candidate);
    for await (const child of directory) {
      await removeEntryInsideRoot(root, path.join(candidate, child.name));
    }
  } catch (error) {
    if (error instanceof ModelAssetError) throw error;
    throw new ModelAssetError("IO_ERROR", "Unable to enumerate cache directory for removal.", { cause: error });
  }
  try {
    await rmdir(candidate);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw new ModelAssetError("IO_ERROR", "Unable to remove cache directory.", { cause: error });
  }
}

export async function verifyArtifactFile(
  filePath: string,
  expectations: FileVerificationExpectations,
  signal?: AbortSignal
): Promise<FileVerificationResult> {
  if (!Number.isSafeInteger(expectations.sizeBytes) || expectations.sizeBytes <= 0) {
    throw new ModelAssetError("INVALID_CONFIGURATION", "Expected artifact size must be a positive safe integer.");
  }
  const digest = Sha256DigestSchema.safeParse(expectations.sha256);
  if (!digest.success) {
    throw new ModelAssetError("INVALID_CONFIGURATION", "Expected SHA-256 digest is invalid.");
  }
  const maximum = expectations.maxBytes ?? expectations.sizeBytes;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new ModelAssetError("INVALID_CONFIGURATION", "Verification byte limit must be a positive safe integer.");
  }
  if (signal?.aborted === true) throw new ModelAssetError("CANCELLED", "Artifact verification was cancelled.");

  let fileStat: Stats;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    throw new ModelAssetError("IO_ERROR", "Unable to inspect artifact file.", { cause: error });
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new ModelAssetError("UNSAFE_PATH", "Artifact verification requires a regular non-symlink file.");
  }
  if (fileStat.size > maximum) {
    throw new ModelAssetError("ARTIFACT_TOO_LARGE", "Artifact exceeds the configured verification byte limit.");
  }
  if (fileStat.size !== expectations.sizeBytes) {
    return { ok: false, reason: "SIZE_MISMATCH", actualBytes: fileStat.size };
  }

  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  const abortListener = (): void => {
    stream.destroy(new ModelAssetError("CANCELLED", "Artifact verification was cancelled."));
  };
  signal?.addEventListener("abort", abortListener, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted === true) {
        throw new ModelAssetError("CANCELLED", "Artifact verification was cancelled.");
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maximum) {
        throw new ModelAssetError("ARTIFACT_TOO_LARGE", "Artifact exceeds the configured verification byte limit.");
      }
      hash.update(buffer);
    }
  } catch (error) {
    if (error instanceof ModelAssetError) throw error;
    if (signal?.aborted === true) {
      throw new ModelAssetError("CANCELLED", "Artifact verification was cancelled.", { cause: error });
    }
    throw new ModelAssetError("IO_ERROR", "Unable to read artifact for verification.", { cause: error });
  } finally {
    signal?.removeEventListener("abort", abortListener);
  }

  if (bytes !== expectations.sizeBytes) {
    return { ok: false, reason: "SIZE_MISMATCH", actualBytes: bytes };
  }
  const actualSha256 = hash.digest("hex") as Sha256Digest;
  if (actualSha256 !== expectations.sha256) {
    return { ok: false, reason: "DIGEST_MISMATCH", actualBytes: bytes, actualSha256 };
  }
  return { ok: true, actualBytes: bytes, actualSha256 };
}

export async function copyLocalArtifactBounded(
  sourcePath: string,
  destinationPath: string,
  maxBytes: number,
  signal: AbortSignal
): Promise<number> {
  if (signal.aborted) throw new ModelAssetError("CANCELLED", "Artifact import was cancelled.");
  let sourceStat: Stats;
  try {
    sourceStat = await lstat(sourcePath);
  } catch (error) {
    throw new ModelAssetError("IO_ERROR", "Unable to inspect local import source.", { cause: error });
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new ModelAssetError("UNSAFE_PATH", "Local import source must be a regular non-symlink file.");
  }
  if (sourceStat.size > maxBytes) {
    throw new ModelAssetError("ARTIFACT_TOO_LARGE", "Local import exceeds the configured artifact-size limit.");
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        callback(new ModelAssetError("ARTIFACT_TOO_LARGE", "Local import exceeds the configured artifact-size limit."));
        return;
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(
      createReadStream(sourcePath),
      limiter,
      createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
      { signal }
    );
    return bytes;
  } catch (error) {
    if (signal.aborted) throw new ModelAssetError("CANCELLED", "Artifact import was cancelled.", { cause: error });
    if (error instanceof ModelAssetError) throw error;
    throw new ModelAssetError("IO_ERROR", "Unable to copy local artifact into the cache staging area.", { cause: error });
  }
}

export async function readStoredManifest(manifestPath: string): Promise<unknown> {
  let entry: Stats;
  try {
    entry = await lstat(manifestPath);
  } catch (error) {
    throw new ModelAssetError("CORRUPT_INSTALLATION", "Installed artifact manifest is missing or unreadable.", { cause: error });
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_STORED_MANIFEST_BYTES) {
    throw new ModelAssetError("CORRUPT_INSTALLATION", "Installed artifact manifest is not a bounded regular file.");
  }
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new ModelAssetError("CORRUPT_INSTALLATION", "Installed artifact manifest is malformed.", { cause: error });
  }
}

export async function writeStoredManifest(manifestPath: string, serializedManifest: string): Promise<void> {
  if (Buffer.byteLength(serializedManifest, "utf8") > MAX_STORED_MANIFEST_BYTES) {
    throw new ModelAssetError("INVALID_MANIFEST", "Serialized asset manifest exceeds the cache metadata limit.");
  }
  try {
    await writeFile(manifestPath, serializedManifest, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new ModelAssetError("IO_ERROR", "Unable to write staged asset manifest.", { cause: error });
  }
}

export async function atomicRenameDirectory(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    throw new ModelAssetError("IO_ERROR", "Unable to atomically publish verified artifact.", { cause: error });
  }
}

export async function sumRegularFileBytes(root: string): Promise<number> {
  let entry: Stats;
  try {
    entry = await lstat(root);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw new ModelAssetError("IO_ERROR", "Unable to inspect cache usage.", { cause: error });
  }
  if (entry.isSymbolicLink()) return 0;
  if (entry.isFile()) return entry.size;
  if (!entry.isDirectory()) return 0;
  let total = 0;
  const directory = await opendir(root);
  for await (const child of directory) {
    total += await sumRegularFileBytes(path.join(root, child.name));
    if (!Number.isSafeInteger(total)) {
      throw new ModelAssetError("CACHE_LIMIT_EXCEEDED", "Cache usage exceeds safe integer accounting limits.");
    }
  }
  return total;
}

export async function availableDiskBytes(root: string): Promise<bigint | undefined> {
  try {
    const stats = await statfs(root, { bigint: true });
    return stats.bavail * stats.bsize;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOSYS" || code === "ENOTSUP" || code === "EINVAL") return undefined;
    throw new ModelAssetError("IO_ERROR", "Unable to inspect available disk space.", { cause: error });
  }
}

export function installedPayloadPath(installationDirectory: string, manifest: AssetManifest): string {
  const candidate = path.join(installationDirectory, manifest.filename);
  assertPathInsideRoot(installationDirectory, candidate);
  return candidate;
}

export async function sumArtifactPayloadBytes(root: string): Promise<number> {
  let entry: Stats;
  try {
    entry = await lstat(root);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw new ModelAssetError("IO_ERROR", "Unable to inspect artifact payload usage.", { cause: error });
  }
  if (entry.isSymbolicLink()) return 0;
  if (entry.isFile()) return path.basename(root).toLowerCase() === "manifest.json" ? 0 : entry.size;
  if (!entry.isDirectory()) return 0;
  let total = 0;
  const directory = await opendir(root);
  for await (const child of directory) {
    total += await sumArtifactPayloadBytes(path.join(root, child.name));
    if (!Number.isSafeInteger(total)) {
      throw new ModelAssetError("CACHE_LIMIT_EXCEEDED", "Artifact payload usage exceeds safe integer limits.");
    }
  }
  return total;
}

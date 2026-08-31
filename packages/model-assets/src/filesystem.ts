import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, type Dir, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  statfs,
  unlink,
  writeFile
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
export const REMOVAL_TOMBSTONE_PATTERN =
  /^\.model-assets-delete-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
  readonly rootDevice: number;
  readonly rootInode: number;
}

function validateOptionalAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object"
      || value === null
      || !("aborted" in value)
      || typeof value.aborted !== "boolean"
      || !("addEventListener" in value)
      || typeof value.addEventListener !== "function"
      || !("removeEventListener" in value)
      || typeof value.removeEventListener !== "function") {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      "Cancellation signal must be an AbortSignal when provided."
    );
  }
  return value as AbortSignal;
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
    return {
      root: canonicalRoot,
      artifacts,
      temporary,
      rootDevice: rootStat.dev,
      rootInode: rootStat.ino
    };
  } catch (error) {
    if (error instanceof ModelAssetError) throw error;
    throw new ModelAssetError("INVALID_CACHE_ROOT", "Unable to initialize the asset cache root.", { cause: error });
  }
}

export async function validateCachePaths(paths: CachePaths): Promise<void> {
  let rootStat: Stats;
  try {
    rootStat = await lstat(paths.root);
  } catch (error) {
    throw new ModelAssetError(
      "INVALID_CACHE_ROOT",
      "Configured asset cache root is no longer available.",
      { cause: error }
    );
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ModelAssetError(
      "INVALID_CACHE_ROOT",
      "Configured asset cache root is no longer a regular directory."
    );
  }
  if (rootStat.dev !== paths.rootDevice || rootStat.ino !== paths.rootInode) {
    throw new ModelAssetError(
      "INVALID_CACHE_ROOT",
      "Configured asset cache root was replaced after manager initialization."
    );
  }

  assertPathInsideRoot(paths.root, paths.artifacts);
  assertPathInsideRoot(paths.root, paths.temporary);
  await ensureSafeDirectory(paths.root, paths.artifacts);
  await ensureSafeDirectory(paths.root, paths.temporary);

  let artifactsStat: Stats;
  let temporaryStat: Stats;
  try {
    [artifactsStat, temporaryStat] = await Promise.all([
      lstat(paths.artifacts),
      lstat(paths.temporary)
    ]);
  } catch (error) {
    throw new ModelAssetError(
      "IO_ERROR",
      "Unable to inspect cache directories for atomic publication compatibility.",
      { cause: error }
    );
  }
  if (artifactsStat.isSymbolicLink()
      || temporaryStat.isSymbolicLink()
      || !artifactsStat.isDirectory()
      || !temporaryStat.isDirectory()) {
    throw new ModelAssetError(
      "UNSAFE_PATH",
      "Cache parent directories changed to unsafe filesystem entries."
    );
  }
  if (artifactsStat.dev !== temporaryStat.dev) {
    throw new ModelAssetError(
      "INVALID_CACHE_ROOT",
      "Temporary and installed artifact directories must be on the same filesystem."
    );
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

async function openStableRegularFile(
  filePath: string,
  inspectMessage: string
): Promise<{ readonly handle: FileHandle; readonly stat: Stats }> {
  let beforeOpen: Stats;
  try {
    beforeOpen = await lstat(filePath);
  } catch (error) {
    throw new ModelAssetError("IO_ERROR", inspectMessage, { cause: error });
  }
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new ModelAssetError(
      "UNSAFE_PATH",
      "Expected a regular non-symlink file."
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    throw new ModelAssetError("IO_ERROR", inspectMessage, { cause: error });
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()
        || opened.dev !== beforeOpen.dev
        || opened.ino !== beforeOpen.ino) {
      throw new ModelAssetError(
        "UNSAFE_PATH",
        "File identity changed between inspection and open."
      );
    }
    return { handle, stat: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof ModelAssetError) throw error;
    throw new ModelAssetError("IO_ERROR", inspectMessage, { cause: error });
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

export async function removeEntryInsideRoot(
  root: string,
  candidate: string,
  maxEntries = 10_000
): Promise<void> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      "Removal traversal limit must be a positive safe integer."
    );
  }
  assertPathInsideRoot(root, candidate);
  if (path.resolve(candidate) === path.resolve(root)) {
    throw new ModelAssetError("PATH_ESCAPE", "Refusing to remove the configured cache root itself.");
  }

  const parent = path.dirname(candidate);
  assertPathInsideRoot(root, parent);
  let detached: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidateDetached = path.join(parent, `.model-assets-delete-${randomUUID()}`);
    assertPathInsideRoot(root, candidateDetached);
    try {
      await rename(candidate, candidateDetached);
      detached = candidateDetached;
      break;
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT") return;
      if (code === "EEXIST") continue;
      throw new ModelAssetError(
        "IO_ERROR",
        "Unable to atomically detach cache entry for safe removal.",
        { cause: error }
      );
    }
  }
  if (detached === undefined) {
    throw new ModelAssetError(
      "IO_ERROR",
      "Unable to allocate a unique cache-removal tombstone."
    );
  }

  let validationComplete = false;
  try {
    let entry: Stats;
    try {
      entry = await lstat(detached);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return;
      throw new ModelAssetError(
        "IO_ERROR",
        "Unable to inspect detached cache entry for removal.",
        { cause: error }
      );
    }

    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      validationComplete = true;
      try {
        await unlink(detached);
        return;
      } catch (error) {
        if (errnoCode(error) === "ENOENT") return;
        throw new ModelAssetError(
          "IO_ERROR",
          "Unable to remove detached cache file entry.",
          { cause: error }
        );
      }
    }

    const children: string[] = [];
    let directory: Dir;
    try {
      directory = await opendir(detached);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return;
      throw new ModelAssetError(
        "IO_ERROR",
        "Unable to open detached cache directory for cleanup.",
        { cause: error }
      );
    }
    for await (const child of directory) {
      if (children.length >= maxEntries) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Managed cache directory exceeds the configured direct-entry cleanup limit."
        );
      }
      const childPath = path.join(detached, child.name);
      assertPathInsideRoot(root, childPath);
      let childStat: Stats;
      try {
        childStat = await lstat(childPath);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") continue;
        throw new ModelAssetError(
          "IO_ERROR",
          "Unable to inspect detached cache child during cleanup.",
          { cause: error }
        );
      }
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
        throw new ModelAssetError(
          "UNSAFE_PATH",
          "Managed cache entries must not contain nested directories."
        );
      }
      children.push(child.name);
    }

    validationComplete = true;
    for (const child of children) {
      const childPath = path.join(detached, child);
      try {
        await unlink(childPath);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") continue;
        throw new ModelAssetError(
          "IO_ERROR",
          "Unable to remove detached managed cache child.",
          { cause: error }
        );
      }
    }
    try {
      await rmdir(detached);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return;
      throw new ModelAssetError(
        "IO_ERROR",
        "Unable to remove detached cache directory.",
        { cause: error }
      );
    }
  } catch (error) {
    if (!validationComplete) {
      try {
        await rename(detached, candidate);
      } catch {
        // Leave the tombstone inside the cache root if restoration races or fails.
      }
    }
    throw error;
  }
}

export async function verifyArtifactFile(
  filePath: string,
  expectations: FileVerificationExpectations,
  signal?: AbortSignal
): Promise<FileVerificationResult> {
  const validatedSignal = validateOptionalAbortSignal(signal);
  const rawFilePath: unknown = filePath;
  if (typeof rawFilePath !== "string"
      || rawFilePath.length === 0
      || rawFilePath.includes("\0")) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      "Artifact verification path must be a non-empty valid path string."
    );
  }

  const rawExpectations: unknown = expectations;
  if (typeof rawExpectations !== "object" || rawExpectations === null) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      "Artifact verification expectations must be an object."
    );
  }
  const expectationRecord = rawExpectations as Record<string, unknown>;
  const expectedSize = expectationRecord["sizeBytes"];
  if (typeof expectedSize !== "number"
      || !Number.isSafeInteger(expectedSize)
      || expectedSize <= 0) {
    throw new ModelAssetError("INVALID_CONFIGURATION", "Expected artifact size must be a positive safe integer.");
  }
  const digest = Sha256DigestSchema.safeParse(expectationRecord["sha256"]);
  if (!digest.success) {
    throw new ModelAssetError("INVALID_CONFIGURATION", "Expected SHA-256 digest is invalid.");
  }
  const rawMaximum = expectationRecord["maxBytes"];
  const maximum = rawMaximum ?? expectedSize;
  if (typeof maximum !== "number"
      || !Number.isSafeInteger(maximum)
      || maximum <= 0) {
    throw new ModelAssetError("INVALID_CONFIGURATION", "Verification byte limit must be a positive safe integer.");
  }
  if (validatedSignal?.aborted === true) throw new ModelAssetError("CANCELLED", "Artifact verification was cancelled.");

  const openedFile = await openStableRegularFile(
    rawFilePath,
    "Unable to inspect artifact file."
  );
  const fileStat = openedFile.stat;
  if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
    await openedFile.handle.close().catch(() => undefined);
    throw new ModelAssetError(
      "ARTIFACT_TOO_LARGE",
      "Artifact file size exceeds safe integer byte accounting."
    );
  }
  if (validatedSignal?.aborted === true) {
    await openedFile.handle.close().catch(() => undefined);
    throw new ModelAssetError("CANCELLED", "Artifact verification was cancelled.");
  }
  if (fileStat.size > maximum) {
    await openedFile.handle.close().catch(() => undefined);
    throw new ModelAssetError("ARTIFACT_TOO_LARGE", "Artifact exceeds the configured verification byte limit.");
  }
  if (fileStat.size !== expectedSize) {
    await openedFile.handle.close().catch(() => undefined);
    return { ok: false, reason: "SIZE_MISMATCH", actualBytes: fileStat.size };
  }

  const hash = createHash("sha256");
  let bytes = 0;
  let stream;
  try {
    stream = openedFile.handle.createReadStream({
      highWaterMark: 1024 * 1024,
      autoClose: false
    });
  } catch (error) {
    await openedFile.handle.close().catch(() => undefined);
    throw new ModelAssetError(
      "IO_ERROR",
      "Unable to create an artifact verification stream.",
      { cause: error }
    );
  }
  const abortListener = (): void => {
    stream.destroy(new ModelAssetError("CANCELLED", "Artifact verification was cancelled."));
  };
  validatedSignal?.addEventListener("abort", abortListener, { once: true });
  try {
    for await (const chunk of stream) {
      if (validatedSignal?.aborted === true) {
        throw new ModelAssetError("CANCELLED", "Artifact verification was cancelled.");
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextBytes = bytes + buffer.byteLength;
      if (!Number.isSafeInteger(nextBytes)) {
        throw new ModelAssetError(
          "ARTIFACT_TOO_LARGE",
          "Artifact exceeds safe integer byte accounting."
        );
      }
      bytes = nextBytes;
      if (bytes > maximum) {
        throw new ModelAssetError("ARTIFACT_TOO_LARGE", "Artifact exceeds the configured verification byte limit.");
      }
      hash.update(buffer);
    }
  } catch (error) {
    if (error instanceof ModelAssetError) throw error;
    if (validatedSignal?.aborted === true) {
      throw new ModelAssetError("CANCELLED", "Artifact verification was cancelled.", { cause: error });
    }
    throw new ModelAssetError("IO_ERROR", "Unable to read artifact for verification.", { cause: error });
  } finally {
    validatedSignal?.removeEventListener("abort", abortListener);
    await openedFile.handle.close().catch(() => undefined);
  }

  if (validatedSignal?.aborted === true) {
    throw new ModelAssetError("CANCELLED", "Artifact verification was cancelled.");
  }
  if (bytes !== expectedSize) {
    return { ok: false, reason: "SIZE_MISMATCH", actualBytes: bytes };
  }
  const actualSha256: Sha256Digest = hash.digest("hex");
  if (actualSha256 !== digest.data) {
    return { ok: false, reason: "DIGEST_MISMATCH", actualBytes: bytes, actualSha256 };
  }
  return { ok: true, actualBytes: bytes, actualSha256 };
}

export async function copyLocalArtifactBounded(
  sourcePath: string,
  destinationPath: string,
  expectedBytes: number,
  maxBytes: number,
  signal: AbortSignal
): Promise<number> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      "Local import size bounds must be positive safe integers."
    );
  }
  if (expectedBytes > maxBytes) {
    throw new ModelAssetError(
      "ARTIFACT_TOO_LARGE",
      "Manifest artifact size exceeds the configured local-import limit."
    );
  }
  if (signal.aborted) throw new ModelAssetError("CANCELLED", "Artifact import was cancelled.");
  const openedSource = await openStableRegularFile(
    sourcePath,
    "Unable to inspect local import source."
  );
  const sourceStat = openedSource.stat;
  if (!Number.isSafeInteger(sourceStat.size) || sourceStat.size < 0) {
    await openedSource.handle.close().catch(() => undefined);
    throw new ModelAssetError(
      "ARTIFACT_TOO_LARGE",
      "Local import source exceeds safe integer byte accounting."
    );
  }
  if (sourceStat.size > maxBytes) {
    await openedSource.handle.close().catch(() => undefined);
    throw new ModelAssetError("ARTIFACT_TOO_LARGE", "Local import exceeds the configured artifact-size limit.");
  }
  if (sourceStat.size !== expectedBytes) {
    await openedSource.handle.close().catch(() => undefined);
    throw new ModelAssetError("SIZE_MISMATCH", "Local import size does not match the asset manifest.");
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const nextBytes = bytes + chunk.byteLength;
      if (!Number.isSafeInteger(nextBytes)) {
        callback(new ModelAssetError(
          "ARTIFACT_TOO_LARGE",
          "Local import exceeds safe integer byte accounting."
        ));
        return;
      }
      bytes = nextBytes;
      if (bytes > maxBytes) {
        callback(new ModelAssetError("ARTIFACT_TOO_LARGE", "Local import exceeds the configured artifact-size limit."));
        return;
      }
      if (bytes > expectedBytes) {
        callback(new ModelAssetError("SIZE_MISMATCH", "Local import exceeded the manifest size during copy."));
        return;
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(
      openedSource.handle.createReadStream({ autoClose: false }),
      limiter,
      createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
      { signal }
    );
    if (bytes !== expectedBytes) {
      throw new ModelAssetError("SIZE_MISMATCH", "Local import size changed during copy.");
    }
    return bytes;
  } catch (error) {
    if (signal.aborted) throw new ModelAssetError("CANCELLED", "Artifact import was cancelled.", { cause: error });
    if (error instanceof ModelAssetError) throw error;
    if (errnoCode(error) === "ENOSPC") {
      throw new ModelAssetError(
        "INSUFFICIENT_DISK_SPACE",
        "Local artifact import could not continue because the destination filesystem is full.",
        { cause: error }
      );
    }
    throw new ModelAssetError("IO_ERROR", "Unable to copy local artifact into the cache staging area.", { cause: error });
  } finally {
    await openedSource.handle.close().catch(() => undefined);
  }
}

export async function readStoredManifest(manifestPath: string): Promise<unknown> {
  let openedManifest: { readonly handle: FileHandle; readonly stat: Stats };
  try {
    openedManifest = await openStableRegularFile(
      manifestPath,
      "Unable to inspect installed artifact manifest."
    );
  } catch (error) {
    if (error instanceof ModelAssetError
        && error.code === "IO_ERROR"
        && errnoCode(error.cause) === "ENOENT") {
      throw new ModelAssetError(
        "CORRUPT_INSTALLATION",
        "Installed artifact manifest is missing.",
        { cause: error }
      );
    }
    if (error instanceof ModelAssetError && error.code === "UNSAFE_PATH") {
      throw new ModelAssetError(
        "CORRUPT_INSTALLATION",
        "Installed artifact manifest is not a regular non-symlink file.",
        { cause: error }
      );
    }
    throw error;
  }

  const manifestStat = openedManifest.stat;
  if (!Number.isSafeInteger(manifestStat.size)
      || manifestStat.size < 0
      || manifestStat.size > MAX_STORED_MANIFEST_BYTES) {
    await openedManifest.handle.close().catch(() => undefined);
    throw new ModelAssetError(
      "CORRUPT_INSTALLATION",
      "Installed artifact manifest exceeds the cache metadata byte limit."
    );
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let stream;
  try {
    stream = openedManifest.handle.createReadStream({
      highWaterMark: 16 * 1024,
      autoClose: false
    });
  } catch (error) {
    await openedManifest.handle.close().catch(() => undefined);
    throw new ModelAssetError(
      "IO_ERROR",
      "Unable to create a cached manifest read stream.",
      { cause: error }
    );
  }
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextBytes = bytes + buffer.byteLength;
      if (!Number.isSafeInteger(nextBytes)
          || nextBytes > MAX_STORED_MANIFEST_BYTES) {
        throw new ModelAssetError(
          "CORRUPT_INSTALLATION",
          "Installed artifact manifest exceeds the cache metadata byte limit."
        );
      }
      bytes = nextBytes;
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ModelAssetError) throw error;
    throw new ModelAssetError(
      "IO_ERROR",
      "Unable to read installed artifact manifest.",
      { cause: error }
    );
  } finally {
    await openedManifest.handle.close().catch(() => undefined);
  }

  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch (error) {
    throw new ModelAssetError(
      "CORRUPT_INSTALLATION",
      "Installed artifact manifest is not valid UTF-8.",
      { cause: error }
    );
  }
  try {
    return JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ModelAssetError(
      "CORRUPT_INSTALLATION",
      "Installed artifact manifest is malformed.",
      { cause: error }
    );
  }
}

export async function writeStoredManifest(manifestPath: string, serializedManifest: string): Promise<void> {
  if (Buffer.byteLength(serializedManifest, "utf8") > MAX_STORED_MANIFEST_BYTES) {
    throw new ModelAssetError("INVALID_MANIFEST", "Serialized asset manifest exceeds the cache metadata limit.");
  }
  try {
    await writeFile(manifestPath, serializedManifest, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errnoCode(error) === "ENOSPC") {
      throw new ModelAssetError(
        "INSUFFICIENT_DISK_SPACE",
        "Unable to write staged asset metadata because the destination filesystem is full.",
        { cause: error }
      );
    }
    throw new ModelAssetError("IO_ERROR", "Unable to write staged asset manifest.", { cause: error });
  }
}

export async function atomicRenameDirectory(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if (errnoCode(error) === "ENOSPC") {
      throw new ModelAssetError(
        "INSUFFICIENT_DISK_SPACE",
        "Unable to publish the verified artifact because the destination filesystem is full.",
        { cause: error }
      );
    }
    throw new ModelAssetError("IO_ERROR", "Unable to atomically publish verified artifact.", { cause: error });
  }
}

export async function availableDiskBytes(root: string): Promise<bigint | undefined> {
  try {
    const stats = await statfs(root, { bigint: true });
    return stats.bavail * stats.bsize;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOSYS"
        || code === "ENOTSUP"
        || code === "EINVAL"
        || code === "ERR_METHOD_NOT_IMPLEMENTED") {
      return undefined;
    }
    throw new ModelAssetError("IO_ERROR", "Unable to inspect available disk space.", { cause: error });
  }
}

export function installedPayloadPath(installationDirectory: string, manifest: AssetManifest): string {
  const candidate = path.join(installationDirectory, manifest.filename);
  assertPathInsideRoot(installationDirectory, candidate);
  return candidate;
}

export async function sumManagedCacheBytes(
  root: string,
  maxEntries = 10_000
): Promise<number> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      "Cache accounting traversal limit must be a positive safe integer."
    );
  }

  let entry: Stats;
  try {
    entry = await lstat(root);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw new ModelAssetError("IO_ERROR", "Unable to inspect artifact payload usage.", { cause: error });
  }
  if (entry.isSymbolicLink()) return 0;
  if (entry.isFile()) return entry.size;
  if (!entry.isDirectory()) return 0;

  let total = 0;
  let inspectedEntries = 0;
  let directory: Dir;
  try {
    directory = await opendir(root);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw new ModelAssetError(
      "IO_ERROR",
      "Unable to open managed cache directory for accounting.",
      { cause: error }
    );
  }
  for await (const child of directory) {
    inspectedEntries += 1;
    if (inspectedEntries > maxEntries) {
      throw new ModelAssetError(
        "CACHE_LIMIT_EXCEEDED",
        "Managed cache directory exceeds the configured direct-entry accounting limit."
      );
    }
    const childPath = path.join(root, child.name);
    let childStat: Stats;
    try {
      childStat = await lstat(childPath);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      throw new ModelAssetError(
        "IO_ERROR",
        "Unable to inspect managed cache child for accounting.",
        { cause: error }
      );
    }
    if (childStat.isSymbolicLink()) continue;
    if (childStat.isDirectory()) {
      throw new ModelAssetError(
        "UNSAFE_PATH",
        "Managed cache entries must not contain nested directories."
      );
    }
    if (!childStat.isFile()) continue;
    if (!Number.isSafeInteger(childStat.size) || childStat.size < 0) {
      throw new ModelAssetError(
        "CACHE_LIMIT_EXCEEDED",
        "Managed cache file size exceeds safe integer accounting limits."
      );
    }
    total += childStat.size;
    if (!Number.isSafeInteger(total)) {
      throw new ModelAssetError(
        "CACHE_LIMIT_EXCEEDED",
        "Managed cache usage exceeds safe integer limits."
      );
    }
  }
  return total;
}


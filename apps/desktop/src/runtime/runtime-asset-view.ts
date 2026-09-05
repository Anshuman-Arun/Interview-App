import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  statfs
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  copyLocalArtifactBounded,
  createStableStagingFile,
  ensureSafeDirectory,
  verifyArtifactFile
} from "../../../../packages/model-assets/src/index.js";
import type { ModelAssetManager } from "../../../../packages/model-assets/src/index.js";
import type { DesktopRuntimeAsset } from "./model-assets.js";

const MAX_RUNTIME_VIEW_DIRECTORY_ENTRIES = 1_024;
const MAX_STALE_RUNTIME_VIEW_DELETIONS = 16;
const RUNTIME_VIEW_OWNER_TOKEN = randomBytes(16).toString("hex");
const ACTIVE_RUNTIME_VIEW_ROOTS = new Set<string>();

export interface RuntimeAssetView {
  readonly root: string;
  readonly paths: ReadonlyMap<string, string>;
  dispose(): Promise<void>;
}

export async function cleanupStaleRuntimeAssetViews(
  baseRoot: string,
  signal?: AbortSignal
): Promise<void> {
  if (abortRequested(signal)) throw abortError();
  await ensureOwnedDirectory(baseRoot);
  if (abortRequested(signal)) throw abortError();
  const entries = await readdir(baseRoot, { withFileTypes: true });
  if (entries.length > MAX_RUNTIME_VIEW_DIRECTORY_ENTRIES) {
    throw new Error("Local runtime asset-view directory exceeds the hard inspection limit");
  }
  let deleted = 0;
  for (const entry of entries) {
    if (abortRequested(signal)) throw abortError();
    if (!entry.name.startsWith("run-")) continue;
    const candidate = resolveWithinRoot(baseRoot, entry.name);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      await rm(candidate, { force: true });
      continue;
    }
    if (!metadata.isDirectory()) {
      await rm(candidate, { force: true });
      continue;
    }
    // Protect only views this process still actively owns. A same-process
    // token alone is insufficient: a failed materialization can leave an
    // untracked partial directory that must be eligible for retry cleanup.
    if (ACTIVE_RUNTIME_VIEW_ROOTS.has(path.resolve(candidate))) continue;
    if (deleted >= MAX_STALE_RUNTIME_VIEW_DELETIONS) continue;
    await rm(candidate, { recursive: true, force: true });
    deleted += 1;
  }
  if (abortRequested(signal)) throw abortError();
}

export async function materializeRuntimeAssetView(input: {
  readonly manager: ModelAssetManager;
  readonly assets: readonly DesktopRuntimeAsset[];
  readonly baseRoot: string;
  readonly signal?: AbortSignal;
}): Promise<RuntimeAssetView> {
  if (abortRequested(input.signal)) throw abortError();
  await ensureOwnedDirectory(input.baseRoot);

  const persistentRoot = persistentRuntimeViewRoot(input.baseRoot, input.assets);
  const reused = await tryOpenPersistentRuntimeView(
    persistentRoot,
    input.assets,
    input.signal
  );
  if (reused !== undefined) return reused;

  const totalBytes = input.assets.reduce((sum, asset) => sum + asset.manifest.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error("Local runtime asset-view size exceeds safe integer accounting");
  }
  const filesystem = await statfs(input.baseRoot, { bigint: true });
  const availableBytes = filesystem.bavail * filesystem.bsize;
  if (availableBytes < BigInt(totalBytes)) {
    throw new Error("Insufficient disk space for verified local runtime asset view");
  }

  const stagingRoot = await mkdtemp(path.join(
    input.baseRoot,
    `run-${String(process.pid)}-${RUNTIME_VIEW_OWNER_TOKEN}-`
  ));
  const resolvedStagingRoot = path.resolve(stagingRoot);
  const rootMetadata = await lstat(stagingRoot, { bigint: true });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Local runtime asset-view root changed after creation");
  }
  const rootIdentity = Object.freeze({
    device: rootMetadata.dev,
    inode: rootMetadata.ino
  });
  ACTIVE_RUNTIME_VIEW_ROOTS.add(resolvedStagingRoot);
  const paths = new Map<string, string>();
  try {
    for (const asset of input.assets) {
      if (abortRequested(input.signal)) throw abortError();
      await assertRuntimeViewRootIdentity(stagingRoot, rootIdentity);
      const source = await input.manager.getInstalledPath(asset.manifest, input.signal);
      const destination = resolveWithinRoot(stagingRoot, asset.runtimeRelativePath);
      const parent = path.dirname(destination);
      await ensureSafeDirectory(stagingRoot, parent);
      await assertRuntimeViewRootIdentity(stagingRoot, rootIdentity);
      if (abortRequested(input.signal)) throw abortError();

      const parentMetadata = await lstat(parent, { bigint: true });
      if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
        throw new Error("Local runtime asset destination parent is unsafe");
      }
      const destinationHandle = await createStableStagingFile(
        parent,
        path.basename(destination),
        {
          device: parentMetadata.dev,
          inode: parentMetadata.ino
        }
      );
      try {
        await copyLocalArtifactBounded(
          source,
          destinationHandle,
          asset.manifest.sizeBytes,
          asset.manifest.sizeBytes,
          input.signal ?? new AbortController().signal
        );
      } finally {
        await destinationHandle.close();
      }
      await assertRuntimeViewRootIdentity(stagingRoot, rootIdentity);
      if (abortRequested(input.signal)) throw abortError();
      const verification = await verifyArtifactFile(destination, {
        sizeBytes: asset.manifest.sizeBytes,
        sha256: asset.manifest.sha256,
        maxBytes: asset.manifest.sizeBytes
      }, input.signal);
      await assertRuntimeViewRootIdentity(stagingRoot, rootIdentity);
      if (!verification.ok) {
        throw new Error("Copied local runtime asset failed digest verification");
      }
      paths.set(asset.runtimeRelativePath, destination);
    }

    ACTIVE_RUNTIME_VIEW_ROOTS.delete(resolvedStagingRoot);
    await rm(persistentRoot, { recursive: true, force: true });
    await rename(stagingRoot, persistentRoot);
    const stablePaths = new Map<string, string>();
    for (const asset of input.assets) {
      stablePaths.set(
        asset.runtimeRelativePath,
        resolveWithinRoot(persistentRoot, asset.runtimeRelativePath)
      );
    }
    return persistentRuntimeView(persistentRoot, stablePaths);
  } catch (error) {
    ACTIVE_RUNTIME_VIEW_ROOTS.delete(resolvedStagingRoot);
    try {
      await rm(stagingRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Local runtime asset materialization and cleanup both failed",
        { cause: cleanupError }
      );
    }
    throw error;
  }
}

function persistentRuntimeViewRoot(
  baseRoot: string,
  assets: readonly DesktopRuntimeAsset[]
): string {
  const digest = createHash("sha256");
  for (const asset of assets) {
    digest
      .update(asset.runtimeRelativePath)
      .update("\0")
      .update(String(asset.manifest.sizeBytes))
      .update("\0")
      .update(asset.manifest.sha256)
      .update("\0");
  }
  return resolveWithinRoot(baseRoot, `view-${digest.digest("hex")}`);
}

async function tryOpenPersistentRuntimeView(
  root: string,
  assets: readonly DesktopRuntimeAsset[],
  signal?: AbortSignal
): Promise<RuntimeAssetView | undefined> {
  if (abortRequested(signal)) throw abortError();
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      await rm(root, { recursive: true, force: true });
      return undefined;
    }
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }

  const paths = new Map<string, string>();
  try {
    for (const asset of assets) {
      if (abortRequested(signal)) throw abortError();
      const candidate = resolveWithinRoot(root, asset.runtimeRelativePath);
      const verification = await verifyArtifactFile(candidate, {
        sizeBytes: asset.manifest.sizeBytes,
        sha256: asset.manifest.sha256,
        maxBytes: asset.manifest.sizeBytes
      }, signal);
      if (!verification.ok) {
        await rm(root, { recursive: true, force: true });
        return undefined;
      }
      paths.set(asset.runtimeRelativePath, candidate);
    }
  } catch (error) {
    if (abortRequested(signal)) throw abortError();
    await rm(root, { recursive: true, force: true });
    if (isMissingPathError(error)) return undefined;
    return undefined;
  }
  return persistentRuntimeView(root, paths);
}

function persistentRuntimeView(
  root: string,
  paths: ReadonlyMap<string, string>
): RuntimeAssetView {
  const resolvedRoot = path.resolve(root);
  ACTIVE_RUNTIME_VIEW_ROOTS.add(resolvedRoot);
  return Object.freeze({
    root,
    paths,
    dispose: async () => {
      ACTIVE_RUNTIME_VIEW_ROOTS.delete(resolvedRoot);
    }
  });
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

async function assertRuntimeViewRootIdentity(
  root: string,
  expected: { readonly device: bigint; readonly inode: bigint }
): Promise<void> {
  const metadata = await lstat(root, { bigint: true });
  if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.dev !== expected.device
      || metadata.ino !== expected.inode) {
    throw new Error("Local runtime asset-view root identity changed during materialization");
  }
}

async function ensureOwnedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Local runtime asset-view root is not a safe directory");
  }
}

function resolveWithinRoot(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error("Runtime asset path must be a bounded relative path");
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".."
      || normalized.startsWith(`..${path.sep}`)
      || normalized.split(path.sep).includes("..")) {
    throw new Error("Runtime asset path escapes its managed root");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Runtime asset path escapes its managed root");
  }
  return resolved;
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortError(): Error {
  const error = new Error("Local runtime asset materialization was cancelled");
  error.name = "AbortError";
  return error;
}

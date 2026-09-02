import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  statfs
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  copyLocalArtifactBounded,
  verifyArtifactFile
} from "../../../../packages/model-assets/src/index.js";
import type { ModelAssetManager } from "../../../../packages/model-assets/src/index.js";
import type { DesktopRuntimeAsset } from "./model-assets.js";

const MAX_RUNTIME_VIEW_DIRECTORY_ENTRIES = 1_024;
const MAX_STALE_RUNTIME_VIEW_DELETIONS = 16;
const RUNTIME_VIEW_OWNER_TOKEN = randomBytes(16).toString("hex");
const RUNTIME_VIEW_NAME = /^run-([1-9][0-9]*)-([0-9a-f]{32})-/u;

export interface RuntimeAssetView {
  readonly root: string;
  readonly paths: ReadonlyMap<string, string>;
  dispose(): Promise<void>;
}

export async function cleanupStaleRuntimeAssetViews(baseRoot: string): Promise<void> {
  await ensureOwnedDirectory(baseRoot);
  const entries = await readdir(baseRoot, { withFileTypes: true });
  if (entries.length > MAX_RUNTIME_VIEW_DIRECTORY_ENTRIES) {
    throw new Error("Local runtime asset-view directory exceeds the hard inspection limit");
  }
  let deleted = 0;
  for (const entry of entries) {
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
    // The Electron application holds a single-instance lock for this app-data
    // root. Protect only views created by this exact process instance; PID
    // liveness alone is unsafe because operating systems reuse PIDs.
    if (runtimeViewOwnedByCurrentProcess(entry.name)) continue;
    if (deleted >= MAX_STALE_RUNTIME_VIEW_DELETIONS) continue;
    await rm(candidate, { recursive: true, force: true });
    deleted += 1;
  }
}

export async function materializeRuntimeAssetView(input: {
  readonly manager: ModelAssetManager;
  readonly assets: readonly DesktopRuntimeAsset[];
  readonly baseRoot: string;
  readonly signal?: AbortSignal;
}): Promise<RuntimeAssetView> {
  if (abortRequested(input.signal)) throw abortError();
  await ensureOwnedDirectory(input.baseRoot);

  const totalBytes = input.assets.reduce((sum, asset) => sum + asset.manifest.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error("Local runtime asset-view size exceeds safe integer accounting");
  }
  const filesystem = await statfs(input.baseRoot, { bigint: true });
  const availableBytes = filesystem.bavail * filesystem.bsize;
  if (availableBytes < BigInt(totalBytes)) {
    throw new Error("Insufficient disk space for verified local runtime asset view");
  }

  const root = await mkdtemp(path.join(
    input.baseRoot,
    `run-${String(process.pid)}-${RUNTIME_VIEW_OWNER_TOKEN}-`
  ));
  const paths = new Map<string, string>();
  let complete = false;
  try {
    for (const asset of input.assets) {
      if (abortRequested(input.signal)) throw abortError();
      const source = await input.manager.getInstalledPath(asset.manifest, input.signal);
      const destination = resolveWithinRoot(root, asset.runtimeRelativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      if (abortRequested(input.signal)) throw abortError();
      const destinationHandle = await open(destination, "wx", 0o600);
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
      if (abortRequested(input.signal)) throw abortError();
      const verification = await verifyArtifactFile(destination, {
        sizeBytes: asset.manifest.sizeBytes,
        sha256: asset.manifest.sha256,
        maxBytes: asset.manifest.sizeBytes
      }, input.signal);
      if (!verification.ok) {
        throw new Error("Copied local runtime asset failed digest verification");
      }
      paths.set(asset.runtimeRelativePath, destination);
    }
    complete = true;
    return Object.freeze({
      root,
      paths,
      dispose: async () => {
        await rm(root, { recursive: true, force: true });
      }
    });
  } finally {
    if (!complete) await rm(root, { recursive: true, force: true }).catch(() => undefined);
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

function runtimeViewOwnedByCurrentProcess(name: string): boolean {
  const match = RUNTIME_VIEW_NAME.exec(name);
  if (match?.[1] === undefined || match[2] === undefined) return false;
  return Number(match[1]) === process.pid && match[2] === RUNTIME_VIEW_OWNER_TOKEN;
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortError(): Error {
  const error = new Error("Local runtime asset materialization was cancelled");
  error.name = "AbortError";
  return error;
}

import type { Dir, Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import {
  MAX_DOWNLOAD_REDIRECTS,
  MAX_DOWNLOAD_TIMEOUT_MS,
  downloadHttpArtifact
} from "./download.js";
import {
  atomicRenameDirectory,
  availableDiskBytes,
  copyLocalArtifactBounded,
  ensureSafeDirectory,
  initializeCachePaths,
  installedPayloadPath,
  pathEntryExists,
  readStoredManifest,
  REMOVAL_TOMBSTONE_PATTERN,
  removeEntryInsideRoot,
  sumManagedCacheBytes,
  validateCachePaths,
  verifyArtifactFile,
  writeStoredManifest,
  type CachePaths
} from "./filesystem.js";
import {
  artifactInstallationKey,
  AssetManifestSchema,
  ModelAssetError,
  parseAssetManifest,
  serializeAssetManifest,
  type AssetDiagnosticMetadata,
  type AssetInstallStatus,
  type AssetManifest,
  type ModelAssetErrorCode
} from "./types.js";

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_LIST_ENTRIES = 10_000;
const INSTALLATION_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const TEMPORARY_ENTRY_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ModelAssetManagerOptions {
  readonly rootDir: string;
  readonly maxArtifactBytes: number;
  readonly maxCacheBytes?: number;
  readonly downloadTimeoutMs?: number;
  readonly maxRedirects?: number;
  readonly allowCrossOriginRedirects?: boolean;
  readonly maxListEntries?: number;
}

export interface AssetInspection extends AssetDiagnosticMetadata {
  readonly errorCode?: ModelAssetErrorCode;
}

export interface InstalledArtifactSummary {
  readonly artifactId: string;
  readonly familyId: string;
  readonly version: string;
  readonly type: AssetManifest["type"];
  readonly platform?: AssetManifest["platform"];
  readonly architecture?: AssetManifest["architecture"];
  readonly variant?: string;
  readonly sha256: AssetManifest["sha256"];
  readonly byteSize: number;
}

interface InFlightEntry {
  readonly controller: AbortController;
  stage: "DOWNLOADING" | "VERIFYING";
  stagingDirectory: string | undefined;
  waiters: number;
  settled: boolean;
  promise: Promise<string>;
}

interface InstallationCheck {
  readonly status: "NOT_PRESENT" | "INSTALLED" | "CORRUPT" | "FAILED";
  readonly path?: string;
  readonly errorCode?: ModelAssetErrorCode;
}

function positiveSafeInteger(value: unknown, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      label + " must be a positive safe integer."
    );
  }
  return resolved;
}

function nonnegativeSafeInteger(value: unknown, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 0) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      label + " must be a non-negative safe integer."
    );
  }
  return resolved;
}

function modelAssetErrorCode(error: unknown): ModelAssetErrorCode {
  return error instanceof ModelAssetError ? error.code : "IO_ERROR";
}

function isIntegrityFailure(error: unknown): boolean {
  return error instanceof ModelAssetError
    && (error.code === "SIZE_MISMATCH" || error.code === "DIGEST_MISMATCH");
}

export class ModelAssetManager {
  private readonly maxArtifactBytes: number;
  private readonly maxCacheBytes: number | undefined;
  private readonly downloadTimeoutMs: number;
  private readonly maxRedirects: number;
  private readonly allowCrossOriginRedirects: boolean;
  private readonly maxListEntries: number;
  private readonly cachePathsPromise: Promise<CachePaths>;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly lastFailures = new Map<
    string,
    { readonly status: "FAILED" | "CORRUPT"; readonly code: ModelAssetErrorCode }
  >();
  private capacityGate: Promise<void> = Promise.resolve();
  private reservedBytes = 0;

  public constructor(options: ModelAssetManagerOptions) {
    const rawOptions: unknown = options;
    if (typeof rawOptions !== "object" || rawOptions === null) {
      throw new ModelAssetError(
        "INVALID_CONFIGURATION",
        "Model asset manager options must be an object."
      );
    }
    const optionRecord = rawOptions as Record<string, unknown>;
    const rootDir = optionRecord["rootDir"];
    if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
      throw new ModelAssetError("INVALID_CACHE_ROOT", "Asset cache root must be an absolute path.");
    }

    const rawCrossOriginRedirects = optionRecord["allowCrossOriginRedirects"];
    if (rawCrossOriginRedirects !== undefined && typeof rawCrossOriginRedirects !== "boolean") {
      throw new ModelAssetError(
        "INVALID_CONFIGURATION",
        "allowCrossOriginRedirects must be a boolean when provided."
      );
    }

    this.maxArtifactBytes = positiveSafeInteger(
      optionRecord["maxArtifactBytes"],
      0,
      "maxArtifactBytes"
    );
    const rawMaxCacheBytes = optionRecord["maxCacheBytes"];
    this.maxCacheBytes = rawMaxCacheBytes === undefined
      ? undefined
      : positiveSafeInteger(rawMaxCacheBytes, 0, "maxCacheBytes");
    this.downloadTimeoutMs = positiveSafeInteger(
      optionRecord["downloadTimeoutMs"],
      DEFAULT_DOWNLOAD_TIMEOUT_MS,
      "downloadTimeoutMs"
    );
    if (this.downloadTimeoutMs > MAX_DOWNLOAD_TIMEOUT_MS) {
      throw new ModelAssetError(
        "INVALID_CONFIGURATION",
        "downloadTimeoutMs exceeds the maximum timeout supported by Node.js."
      );
    }
    this.maxRedirects = nonnegativeSafeInteger(
      optionRecord["maxRedirects"],
      DEFAULT_MAX_REDIRECTS,
      "maxRedirects"
    );
    if (this.maxRedirects > MAX_DOWNLOAD_REDIRECTS) {
      throw new ModelAssetError(
        "INVALID_CONFIGURATION",
        "maxRedirects exceeds the package redirect-depth safety limit."
      );
    }
    this.allowCrossOriginRedirects = rawCrossOriginRedirects ?? false;
    this.maxListEntries = positiveSafeInteger(
      optionRecord["maxListEntries"],
      DEFAULT_MAX_LIST_ENTRIES,
      "maxListEntries"
    );
    this.cachePathsPromise = initializeCachePaths(rootDir);
    void this.cachePathsPromise.catch(() => undefined);
  }

  public async install(manifestValue: unknown, signal?: AbortSignal): Promise<string> {
    const manifest = parseAssetManifest(manifestValue);
    return await this.joinOrStart(
      manifest,
      signal,
      async (internalSignal, setStage, setStagingDirectory) => await this.performInstallation(
        manifest,
        internalSignal,
        setStage,
        setStagingDirectory,
        async (destination) => {
          await downloadHttpArtifact(manifest.sourceUrl, destination, {
            maxBytes: this.maxArtifactBytes,
            expectedBytes: manifest.sizeBytes,
            timeoutMs: this.downloadTimeoutMs,
            maxRedirects: this.maxRedirects,
            allowCrossOriginRedirects: this.allowCrossOriginRedirects,
            signal: internalSignal
          });
        }
      )
    );
  }

  public async importLocal(
    manifestValue: unknown,
    sourcePath: string,
    signal?: AbortSignal
  ): Promise<string> {
    const rawSourcePath: unknown = sourcePath;
    if (typeof rawSourcePath !== "string"
        || rawSourcePath.length === 0
        || rawSourcePath.includes("\0")) {
      throw new ModelAssetError(
        "INVALID_CONFIGURATION",
        "Local import source path must be a non-empty valid path string."
      );
    }
    const manifest = parseAssetManifest(manifestValue);
    return await this.joinOrStart(
      manifest,
      signal,
      async (internalSignal, setStage, setStagingDirectory) => await this.performInstallation(
        manifest,
        internalSignal,
        setStage,
        setStagingDirectory,
        async (destination) => {
          await copyLocalArtifactBounded(
            rawSourcePath,
            destination,
            manifest.sizeBytes,
            this.maxArtifactBytes,
            internalSignal
          );
        }
      )
    );
  }

  public async inspect(manifestValue: unknown): Promise<AssetInspection> {
    const manifest = parseAssetManifest(manifestValue);
    const key = artifactInstallationKey(manifest);
    const active = this.inFlight.get(key);
    if (active !== undefined && !active.settled) {
      return this.inspectionFor(manifest, active.stage);
    }

    const check = await this.checkInstallation(manifest);
    if (check.status === "INSTALLED") {
      return this.inspectionFor(manifest, "INSTALLED");
    }
    if (check.status === "CORRUPT") {
      return this.inspectionFor(
        manifest,
        "CORRUPT",
        check.errorCode ?? "CORRUPT_INSTALLATION"
      );
    }
    if (check.status === "FAILED") {
      return this.inspectionFor(
        manifest,
        "FAILED",
        check.errorCode ?? "IO_ERROR"
      );
    }

    const failure = this.lastFailures.get(key);
    if (failure !== undefined) {
      return this.inspectionFor(manifest, failure.status, failure.code);
    }
    return this.inspectionFor(manifest, "NOT_PRESENT");
  }

  public async verifyInstalledArtifact(manifestValue: unknown): Promise<boolean> {
    const manifest = parseAssetManifest(manifestValue);
    const check = await this.checkInstallation(manifest);
    if (check.status === "FAILED") {
      throw new ModelAssetError(
        check.errorCode ?? "IO_ERROR",
        "Unable to verify the installed artifact because cache inspection failed."
      );
    }
    return check.status === "INSTALLED";
  }

  public async getInstalledPath(manifestValue: unknown): Promise<string> {
    const manifest = parseAssetManifest(manifestValue);
    const check = await this.checkInstallation(manifest);
    if (check.status === "FAILED") {
      throw new ModelAssetError(
        check.errorCode ?? "IO_ERROR",
        "Unable to inspect the artifact installation safely."
      );
    }
    if (check.status !== "INSTALLED" || check.path === undefined) {
      throw new ModelAssetError(
        "NOT_INSTALLED",
        "Artifact is not present with the expected verified integrity."
      );
    }
    return check.path;
  }

  public async listInstalledArtifacts(): Promise<readonly InstalledArtifactSummary[]> {
    const paths = await this.getSafeCachePaths();
    const installed: InstalledArtifactSummary[] = [];
    const directoryHandle = await this.openCacheDirectory(
      paths.artifacts,
      "Unable to open the installed artifact cache for inspection."
    );
    let inspectedEntries = 0;

    for await (const entry of directoryHandle) {
      inspectedEntries += 1;
      if (inspectedEntries > this.maxListEntries) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Installed artifact entry count exceeds the configured inspection limit."
        );
      }
      if (!INSTALLATION_KEY_PATTERN.test(entry.name)
          || !entry.isDirectory()
          || entry.isSymbolicLink()) {
        continue;
      }

      const directory = path.join(paths.artifacts, entry.name);
      let manifest: AssetManifest;
      try {
        const stored = await readStoredManifest(path.join(directory, "manifest.json"));
        const parsed = AssetManifestSchema.safeParse(stored);
        if (!parsed.success || artifactInstallationKey(parsed.data) !== entry.name) continue;
        manifest = parsed.data;
      } catch (error) {
        if (error instanceof ModelAssetError && error.code === "IO_ERROR") throw error;
        continue;
      }

      const check = await this.checkInstallation(manifest);
      if (check.status === "FAILED") {
        throw new ModelAssetError(
          check.errorCode ?? "IO_ERROR",
          "Unable to inspect an installed artifact while listing the cache."
        );
      }
      if (check.status !== "INSTALLED") continue;
      installed.push({
        artifactId: manifest.artifactId,
        familyId: manifest.familyId,
        version: manifest.version,
        type: manifest.type,
        ...(manifest.platform === undefined ? {} : { platform: manifest.platform }),
        ...(manifest.architecture === undefined
          ? {}
          : { architecture: manifest.architecture }),
        ...(manifest.variant === undefined ? {} : { variant: manifest.variant }),
        sha256: manifest.sha256,
        byteSize: manifest.sizeBytes
      });
    }

    return installed.sort((left, right) => {
      const leftKey = [
        left.familyId,
        left.artifactId,
        left.version,
        left.platform ?? "",
        left.architecture ?? "",
        left.variant ?? "",
        left.sha256
      ].join("\0");
      const rightKey = [
        right.familyId,
        right.artifactId,
        right.version,
        right.platform ?? "",
        right.architecture ?? "",
        right.variant ?? "",
        right.sha256
      ].join("\0");
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }

  public async getDiagnosticMetadata(manifestValue: unknown): Promise<AssetDiagnosticMetadata> {
    const inspection = await this.inspect(manifestValue);
    return {
      artifactId: inspection.artifactId,
      familyId: inspection.familyId,
      version: inspection.version,
      sha256: inspection.sha256,
      status: inspection.status,
      byteSize: inspection.byteSize
    };
  }

  public async remove(manifestValue: unknown): Promise<void> {
    const manifest = parseAssetManifest(manifestValue);
    const key = artifactInstallationKey(manifest);
    if (this.inFlight.has(key)) {
      throw new ModelAssetError(
        "ASSET_BUSY",
        "Cannot remove an artifact while its installation is in flight."
      );
    }
    const paths = await this.getSafeCachePaths();
    await this.removeManagedEntry(paths, path.join(paths.artifacts, key));
    this.lastFailures.delete(key);
  }

  public async cleanupTemporary(): Promise<void> {
    if (this.inFlight.size > 0) {
      throw new ModelAssetError(
        "ASSET_BUSY",
        "Cannot clear temporary downloads while installations are in flight."
      );
    }

    const paths = await this.getSafeCachePaths();
    const entries = await this.listCacheEntryNames(
      paths.temporary,
      "Temporary cache entry count exceeds the configured cleanup limit."
    );
    for (const entry of entries) {
      if (!TEMPORARY_ENTRY_PATTERN.test(entry)
          && !REMOVAL_TOMBSTONE_PATTERN.test(entry)) {
        continue;
      }
      await this.removeManagedEntry(paths, path.join(paths.temporary, entry));
    }
    this.lastFailures.clear();
  }

  public async clearUnused(keepManifestValues: readonly unknown[]): Promise<number> {
    const rawKeepManifestValues: unknown = keepManifestValues;
    if (!Array.isArray(rawKeepManifestValues)) {
      throw new ModelAssetError(
        "INVALID_MANIFEST",
        "Keep-manifest collection must be an array."
      );
    }
    const keepValues: readonly unknown[] = rawKeepManifestValues;
    if (this.inFlight.size > 0) {
      throw new ModelAssetError(
        "ASSET_BUSY",
        "Cannot clear unused artifacts while installations are in flight."
      );
    }

    if (keepValues.length > this.maxListEntries) {
      throw new ModelAssetError(
        "CACHE_LIMIT_EXCEEDED",
        "Keep-manifest count exceeds the configured cleanup limit."
      );
    }
    const keepKeys = new Set(
      keepValues.map((value) => artifactInstallationKey(parseAssetManifest(value)))
    );
    const paths = await this.getSafeCachePaths();
    const entries = await this.listCacheEntryNames(
      paths.artifacts,
      "Artifact cache entry count exceeds the configured cleanup limit."
    );
    let removed = 0;

    for (const entry of entries) {
      const installationEntry = INSTALLATION_KEY_PATTERN.test(entry);
      const tombstoneEntry = REMOVAL_TOMBSTONE_PATTERN.test(entry);
      if (!installationEntry && !tombstoneEntry) continue;
      if (installationEntry && keepKeys.has(entry)) continue;
      await this.removeManagedEntry(paths, path.join(paths.artifacts, entry));
      this.lastFailures.delete(entry);
      removed += 1;
    }
    return removed;
  }

  private async openCacheDirectory(
    directoryPath: string,
    message: string
  ): Promise<Dir> {
    try {
      return await opendir(directoryPath);
    } catch (error) {
      throw new ModelAssetError("IO_ERROR", message, { cause: error });
    }
  }

  private async listCacheEntryNames(
    directoryPath: string,
    limitMessage: string
  ): Promise<readonly string[]> {
    const names: string[] = [];
    const directory = await this.openCacheDirectory(
      directoryPath,
      "Unable to open a cache directory for cleanup."
    );
    for await (const entry of directory) {
      if (names.length >= this.maxListEntries) {
        throw new ModelAssetError("CACHE_LIMIT_EXCEEDED", limitMessage);
      }
      names.push(entry.name);
    }
    return names.sort();
  }

  private recordFailure(key: string, error: unknown): void {
    if (!this.lastFailures.has(key) && this.lastFailures.size >= this.maxListEntries) {
      const oldestKey = this.lastFailures.keys().next().value;
      if (oldestKey !== undefined) this.lastFailures.delete(oldestKey);
    }
    this.lastFailures.set(key, {
      status: isIntegrityFailure(error) ? "CORRUPT" : "FAILED",
      code: modelAssetErrorCode(error)
    });
  }

  private inspectionFor(
    manifest: AssetManifest,
    status: AssetInstallStatus,
    failureCode?: ModelAssetErrorCode
  ): AssetInspection {
    return {
      artifactId: manifest.artifactId,
      familyId: manifest.familyId,
      version: manifest.version,
      sha256: manifest.sha256,
      status,
      byteSize: manifest.sizeBytes,
      ...(failureCode === undefined ? {} : { errorCode: failureCode })
    };
  }

  private async joinOrStart(
    manifest: AssetManifest,
    signal: AbortSignal | undefined,
    operation: (
      signal: AbortSignal,
      setStage: (stage: "DOWNLOADING" | "VERIFYING") => void,
      setStagingDirectory: (directory: string | undefined) => void
    ) => Promise<string>
  ): Promise<string> {
    if (signal?.aborted === true) {
      throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
    }
    if (manifest.sizeBytes > this.maxArtifactBytes) {
      throw new ModelAssetError(
        "ARTIFACT_TOO_LARGE",
        "Manifest artifact size exceeds the configured artifact limit."
      );
    }

    const key = artifactInstallationKey(manifest);
    let entry = this.inFlight.get(key);
    if (entry !== undefined && entry.controller.signal.aborted && !entry.settled) {
      await this.waitForAbortedEntryToSettle(entry, signal);
      entry = this.inFlight.get(key);
    }
    if (entry === undefined) {
      const controller = new AbortController();
      entry = {
        controller,
        stage: "VERIFYING",
        stagingDirectory: undefined,
        waiters: 0,
        settled: false,
        promise: Promise.resolve("")
      };
      const current = entry;
      current.promise = operation(
        controller.signal,
        (stage) => {
          current.stage = stage;
        },
        (directory) => {
          current.stagingDirectory = directory;
        }
      ).then((installedPath) => {
        this.lastFailures.delete(key);
        return installedPath;
      }).catch((error: unknown) => {
        this.recordFailure(key, error);
        throw error;
      }).finally(() => {
        current.settled = true;
        if (this.inFlight.get(key) === current) this.inFlight.delete(key);
      });
      void current.promise.catch(() => undefined);
      this.inFlight.set(key, current);
    }
    return await this.waitForEntry(entry, signal);
  }

  private async waitForEntry(entry: InFlightEntry, signal?: AbortSignal): Promise<string> {
    entry.waiters += 1;
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      let completed = false;
      const finish = (): void => {
        if (completed) return;
        completed = true;
        signal?.removeEventListener("abort", abortListener);
        entry.waiters -= 1;
        if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
      };
      const abortListener = (): void => {
        finish();
        rejectPromise(
          new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.")
        );
      };

      if (signal?.aborted === true) {
        abortListener();
        return;
      }
      signal?.addEventListener("abort", abortListener, { once: true });

      entry.promise.then((value) => {
        if (completed) return;
        finish();
        resolvePromise(value);
      }, (error: unknown) => {
        if (completed) return;
        finish();
        rejectPromise(error);
      });
    });
  }

  private async waitForAbortedEntryToSettle(
    entry: InFlightEntry,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted === true) {
      throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let completed = false;
      const finish = (): void => {
        if (completed) return;
        completed = true;
        signal?.removeEventListener("abort", abortListener);
        resolvePromise();
      };
      const abortListener = (): void => {
        if (completed) return;
        completed = true;
        signal?.removeEventListener("abort", abortListener);
        rejectPromise(
          new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.")
        );
      };

      signal?.addEventListener("abort", abortListener, { once: true });
      entry.promise.then(finish, finish);
    });
  }

  private async getSafeCachePaths(): Promise<CachePaths> {
    const paths = await this.cachePathsPromise;
    await validateCachePaths(paths);
    return paths;
  }

  private async assertSafeStagingDirectory(
    paths: CachePaths,
    stagingDirectory: string,
    expectedIdentity?: { readonly device: number; readonly inode: number }
  ): Promise<Stats> {
    await validateCachePaths(paths);
    let entry: Stats;
    try {
      entry = await lstat(stagingDirectory);
    } catch (error) {
      throw new ModelAssetError(
        "IO_ERROR",
        "Artifact staging directory disappeared during installation.",
        { cause: error }
      );
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ModelAssetError(
        "UNSAFE_PATH",
        "Artifact staging directory changed to an unsafe filesystem entry."
      );
    }
    if (expectedIdentity !== undefined
        && (entry.dev !== expectedIdentity.device || entry.ino !== expectedIdentity.inode)) {
      throw new ModelAssetError(
        "UNSAFE_PATH",
        "Artifact staging directory was replaced during installation."
      );
    }
    return entry;
  }

  private async removeManagedEntry(paths: CachePaths, candidate: string): Promise<void> {
    await validateCachePaths(paths);
    await removeEntryInsideRoot(paths.root, candidate);
  }

  private async assertArtifactDirectoryShape(
    directoryPath: string,
    manifest: AssetManifest,
    errorCode: "CORRUPT_INSTALLATION" | "UNSAFE_PATH"
  ): Promise<void> {
    const expectedNames = new Set(["manifest.json", manifest.filename]);
    const directory = await this.openCacheDirectory(
      directoryPath,
      "Unable to open an artifact directory for structural inspection."
    );
    let entries = 0;
    for await (const entry of directory) {
      entries += 1;
      if (entries > 2 || !expectedNames.delete(entry.name)) {
        throw new ModelAssetError(
          errorCode,
          "Artifact directory contains entries outside the declared cache layout."
        );
      }
    }
    if (expectedNames.size !== 0) {
      throw new ModelAssetError(
        errorCode,
        "Artifact directory is missing a required cache-layout entry."
      );
    }
  }

  private rejectTransientInstallationFailure(check: InstallationCheck): void {
    if (check.status === "FAILED") {
      throw new ModelAssetError(
        "IO_ERROR",
        "Existing artifact installation could not be inspected safely; refusing destructive repair."
      );
    }
  }

  private async performInstallation(
    manifest: AssetManifest,
    signal: AbortSignal,
    setStage: (stage: "DOWNLOADING" | "VERIFYING") => void,
    setStagingDirectory: (directory: string | undefined) => void,
    stagePayload: (destination: string) => Promise<void>
  ): Promise<string> {
    const paths = await this.getSafeCachePaths();
    const key = artifactInstallationKey(manifest);
    const installationDirectory = path.join(paths.artifacts, key);

    setStage("VERIFYING");
    const initial = await this.checkInstallation(manifest, signal);
    if (initial.status === "INSTALLED" && initial.path !== undefined) return initial.path;
    this.rejectTransientInstallationFailure(initial);
    if (signal.aborted) {
      throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
    }
    if (await pathEntryExists(installationDirectory)) {
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      const beforeRemoval = await this.checkInstallation(manifest, signal);
      if (beforeRemoval.status === "INSTALLED" && beforeRemoval.path !== undefined) {
        return beforeRemoval.path;
      }
      this.rejectTransientInstallationFailure(beforeRemoval);
      if (beforeRemoval.status === "CORRUPT") {
        await this.removeManagedEntry(paths, installationDirectory);
      }
    }

    const serializedManifest = serializeAssetManifest(manifest);
    const reservationBytes = manifest.sizeBytes + Buffer.byteLength(serializedManifest, "utf8");
    if (!Number.isSafeInteger(reservationBytes)) {
      throw new ModelAssetError(
        "CACHE_LIMIT_EXCEEDED",
        "Artifact payload and metadata exceed safe integer accounting limits."
      );
    }
    const stagingDirectory = path.join(
      paths.temporary,
      key + "-" + randomUUID()
    );
    await this.reserveCapacity(paths, reservationBytes, signal);
    let published = false;
    let reservationHeld = true;

    try {
      setStagingDirectory(stagingDirectory);
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation was cancelled.");
      }
      await ensureSafeDirectory(paths.root, stagingDirectory);
      const createdStaging = await this.assertSafeStagingDirectory(paths, stagingDirectory);
      const stagingIdentity = {
        device: createdStaging.dev,
        inode: createdStaging.ino
      };
      const stagedPayload = installedPayloadPath(stagingDirectory, manifest);

      setStage("DOWNLOADING");
      await stagePayload(stagedPayload);
      await this.assertSafeStagingDirectory(paths, stagingDirectory, stagingIdentity);

      setStage("VERIFYING");
      const verification = await verifyArtifactFile(stagedPayload, {
        sizeBytes: manifest.sizeBytes,
        sha256: manifest.sha256,
        maxBytes: this.maxArtifactBytes
      }, signal);
      if (!verification.ok) {
        throw new ModelAssetError(
          verification.reason,
          "Staged artifact failed manifest integrity verification."
        );
      }

      await this.assertSafeStagingDirectory(paths, stagingDirectory, stagingIdentity);
      await writeStoredManifest(
        path.join(stagingDirectory, "manifest.json"),
        serializedManifest
      );
      await this.assertArtifactDirectoryShape(stagingDirectory, manifest, "UNSAFE_PATH");
      if (signal.aborted) {
        throw new ModelAssetError(
          "CANCELLED",
          "Artifact installation was cancelled before publication."
        );
      }

      await this.assertSafeStagingDirectory(paths, stagingDirectory, stagingIdentity);
      if (await pathEntryExists(installationDirectory)) {
        const existing = await this.checkInstallation(manifest, signal);
        if (existing.status === "INSTALLED" && existing.path !== undefined) {
          await this.removeManagedEntry(paths, stagingDirectory);
          if (signal.aborted) {
            throw new ModelAssetError(
              "CANCELLED",
              "Artifact installation request was cancelled."
            );
          }
          return existing.path;
        }
        this.rejectTransientInstallationFailure(existing);
        await this.removeManagedEntry(paths, installationDirectory);
      }

      if (signal.aborted) {
        throw new ModelAssetError(
          "CANCELLED",
          "Artifact installation was cancelled before publication."
        );
      }

      await this.assertSafeStagingDirectory(paths, stagingDirectory, stagingIdentity);
      try {
        await this.publishReservedArtifact(
          paths,
          stagingDirectory,
          installationDirectory,
          reservationBytes,
          signal,
          stagingIdentity
        );
        reservationHeld = false;
        published = true;
      } catch (error) {
        if (error instanceof ModelAssetError
            && (error.code === "CANCELLED"
              || error.code === "UNSAFE_PATH"
              || error.code === "INVALID_CACHE_ROOT")) {
          throw error;
        }
        const raced = await this.checkInstallation(manifest, signal);
        if (raced.status === "INSTALLED" && raced.path !== undefined) {
          await this.removeManagedEntry(paths, stagingDirectory);
          if (signal.aborted) {
            throw new ModelAssetError(
              "CANCELLED",
              "Artifact installation request was cancelled."
            );
          }
          return raced.path;
        }
        throw error;
      }
      return installedPayloadPath(installationDirectory, manifest);
    } finally {
      // Once an operation stops owning its staging directory, capacity scans must
      // count any bytes still present there before the reservation is released.
      setStagingDirectory(undefined);
      if (reservationHeld) {
        await this.releaseCapacity(reservationBytes);
      }
      if (!published) {
        await this.removeManagedEntry(paths, stagingDirectory).catch(() => undefined);
      }
    }
  }

  private async checkInstallation(
    manifest: AssetManifest,
    signal?: AbortSignal
  ): Promise<InstallationCheck> {
    const paths = await this.getSafeCachePaths();
    const key = artifactInstallationKey(manifest);
    const directory = path.join(paths.artifacts, key);

    let directoryStat: Stats;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if (typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ENOENT") {
        return { status: "NOT_PRESENT" };
      }
      return { status: "FAILED", errorCode: "IO_ERROR" };
    }

    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return { status: "CORRUPT", errorCode: "CORRUPT_INSTALLATION" };
    }

    try {
      await this.assertArtifactDirectoryShape(directory, manifest, "CORRUPT_INSTALLATION");
      const storedValue = await readStoredManifest(path.join(directory, "manifest.json"));
      const stored = AssetManifestSchema.safeParse(storedValue);
      if (!stored.success || artifactInstallationKey(stored.data) !== key) {
        return { status: "CORRUPT", errorCode: "CORRUPT_INSTALLATION" };
      }

      const payload = installedPayloadPath(directory, manifest);
      const verification = await verifyArtifactFile(payload, {
        sizeBytes: manifest.sizeBytes,
        sha256: manifest.sha256,
        maxBytes: this.maxArtifactBytes
      }, signal);
      if (!verification.ok) {
        return { status: "CORRUPT", errorCode: verification.reason };
      }
      if (signal?.aborted === true) {
        throw new ModelAssetError("CANCELLED", "Artifact integrity inspection was cancelled.");
      }
      await validateCachePaths(paths);
      const finalDirectoryStat = await lstat(directory);
      if (finalDirectoryStat.isSymbolicLink() || !finalDirectoryStat.isDirectory()) {
        return { status: "CORRUPT", errorCode: "CORRUPT_INSTALLATION" };
      }
      await this.assertArtifactDirectoryShape(directory, manifest, "CORRUPT_INSTALLATION");
      return { status: "INSTALLED", path: payload };
    } catch (error) {
      if (error instanceof ModelAssetError && error.code === "CANCELLED") throw error;
      const errorCode = modelAssetErrorCode(error);
      return {
        status: errorCode === "IO_ERROR" ? "FAILED" : "CORRUPT",
        errorCode
      };
    }
  }

  private async managedCacheBytes(paths: CachePaths): Promise<number> {
    const activeStagingDirectories = new Set(
      [...this.inFlight.values()]
        .map((entry) => entry.stagingDirectory)
        .filter((directory): directory is string => directory !== undefined)
    );

    let total = 0;
    const artifacts = await this.openCacheDirectory(
      paths.artifacts,
      "Unable to open the artifact cache for accounting."
    );
    let artifactEntries = 0;
    for await (const entry of artifacts) {
      artifactEntries += 1;
      if (artifactEntries > this.maxListEntries) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Artifact cache entry count exceeds the configured accounting limit."
        );
      }
      if (!INSTALLATION_KEY_PATTERN.test(entry.name)
          && !REMOVAL_TOMBSTONE_PATTERN.test(entry.name)) {
        continue;
      }
      total += await sumManagedCacheBytes(path.join(paths.artifacts, entry.name));
      if (!Number.isSafeInteger(total)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Managed cache usage exceeds safe integer accounting limits."
        );
      }
    }

    const temporary = await this.openCacheDirectory(
      paths.temporary,
      "Unable to open the temporary cache for accounting."
    );
    let temporaryEntries = 0;
    for await (const entry of temporary) {
      temporaryEntries += 1;
      if (temporaryEntries > this.maxListEntries) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Temporary cache entry count exceeds the configured accounting limit."
        );
      }
      const stagingEntry = TEMPORARY_ENTRY_PATTERN.test(entry.name);
      const tombstoneEntry = REMOVAL_TOMBSTONE_PATTERN.test(entry.name);
      if (!stagingEntry && !tombstoneEntry) continue;
      const candidate = path.join(paths.temporary, entry.name);
      if (stagingEntry && activeStagingDirectories.has(candidate)) continue;
      total += await sumManagedCacheBytes(candidate);
      if (!Number.isSafeInteger(total)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Managed temporary cache usage exceeds safe integer accounting limits."
        );
      }
    }
    return total;
  }

  private async publishReservedArtifact(
    paths: CachePaths,
    stagingDirectory: string,
    installationDirectory: string,
    reservationBytes: number,
    signal: AbortSignal,
    stagingIdentity: { readonly device: number; readonly inode: number }
  ): Promise<void> {
    await this.withCapacityGate(async () => {
      if (signal.aborted) {
        throw new ModelAssetError(
          "CANCELLED",
          "Artifact installation was cancelled before publication."
        );
      }
      await this.assertSafeStagingDirectory(paths, stagingDirectory, stagingIdentity);
      if (signal.aborted) {
        throw new ModelAssetError(
          "CANCELLED",
          "Artifact installation was cancelled before publication."
        );
      }
      await atomicRenameDirectory(stagingDirectory, installationDirectory);
      this.reservedBytes = Math.max(0, this.reservedBytes - reservationBytes);
    });
  }

  private async activeStagingBytes(): Promise<number> {
    let total = 0;
    for (const entry of this.inFlight.values()) {
      if (entry.stagingDirectory === undefined) continue;
      total += await sumManagedCacheBytes(entry.stagingDirectory);
      if (!Number.isSafeInteger(total)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Active staging usage exceeds safe integer accounting limits."
        );
      }
    }
    return total;
  }

  private async reserveCapacity(
    paths: CachePaths,
    requestedBytes: number,
    signal: AbortSignal
  ): Promise<void> {
    await this.withCapacityGate(async () => {
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      await validateCachePaths(paths);
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      const reservedProjection = this.reservedBytes + requestedBytes;
      if (!Number.isSafeInteger(reservedProjection)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "In-flight artifact reservations exceed safe integer accounting limits."
        );
      }

      if (this.maxCacheBytes !== undefined) {
        const usedBytes = await this.managedCacheBytes(paths);
        if (signal.aborted) {
          throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
        }
        const projected = usedBytes + reservedProjection;
        if (!Number.isSafeInteger(projected) || projected > this.maxCacheBytes) {
          throw new ModelAssetError(
            "CACHE_LIMIT_EXCEEDED",
            "Artifact installation would exceed the configured cache-size limit."
          );
        }
      }

      const activeStagingBytes = await this.activeStagingBytes();
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      const alreadyMaterialized = Math.min(activeStagingBytes, this.reservedBytes);
      const outstandingReservation = reservedProjection - alreadyMaterialized;
      const available = await availableDiskBytes(paths.root);
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      if (available !== undefined && available < BigInt(outstandingReservation)) {
        throw new ModelAssetError(
          "INSUFFICIENT_DISK_SPACE",
          "Insufficient free disk space for verified atomic installation."
        );
      }
      this.reservedBytes = reservedProjection;
    });
  }

  private async releaseCapacity(bytes: number): Promise<void> {
    await this.withCapacityGate(async () => {
      this.reservedBytes = Math.max(0, this.reservedBytes - bytes);
    });
  }

  private async withCapacityGate<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const previous = this.capacityGate;
    this.capacityGate = previous.then(() => turn);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

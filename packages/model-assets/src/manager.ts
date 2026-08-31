import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { MAX_DOWNLOAD_TIMEOUT_MS, downloadHttpArtifact } from "./download.js";
import {
  atomicRenameDirectory,
  availableDiskBytes,
  copyLocalArtifactBounded,
  ensureSafeDirectory,
  initializeCachePaths,
  installedPayloadPath,
  pathEntryExists,
  readStoredManifest,
  removeEntryInsideRoot,
  sumArtifactPayloadBytes,
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
  readonly status: "NOT_PRESENT" | "INSTALLED" | "CORRUPT";
  readonly path?: string;
  readonly errorCode?: ModelAssetErrorCode;
}

function positiveSafeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      label + " must be a positive safe integer."
    );
  }
  return resolved;
}

function nonnegativeSafeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
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
    if (!path.isAbsolute(options.rootDir)) {
      throw new ModelAssetError("INVALID_CACHE_ROOT", "Asset cache root must be an absolute path.");
    }
    this.maxArtifactBytes = positiveSafeInteger(
      options.maxArtifactBytes,
      0,
      "maxArtifactBytes"
    );
    this.maxCacheBytes = options.maxCacheBytes === undefined
      ? undefined
      : positiveSafeInteger(options.maxCacheBytes, 0, "maxCacheBytes");
    if (this.maxCacheBytes !== undefined && this.maxCacheBytes < this.maxArtifactBytes) {
      throw new ModelAssetError(
        "INVALID_CONFIGURATION",
        "maxCacheBytes must be at least maxArtifactBytes when both limits are configured."
      );
    }
    this.downloadTimeoutMs = positiveSafeInteger(
      options.downloadTimeoutMs,
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
      options.maxRedirects,
      DEFAULT_MAX_REDIRECTS,
      "maxRedirects"
    );
    this.allowCrossOriginRedirects = options.allowCrossOriginRedirects ?? false;
    this.maxListEntries = positiveSafeInteger(
      options.maxListEntries,
      DEFAULT_MAX_LIST_ENTRIES,
      "maxListEntries"
    );
    this.cachePathsPromise = initializeCachePaths(options.rootDir);
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
            sourcePath,
            destination,
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

    const failure = this.lastFailures.get(key);
    if (failure !== undefined) {
      return this.inspectionFor(manifest, failure.status, failure.code);
    }
    return this.inspectionFor(manifest, "NOT_PRESENT");
  }

  public async verifyInstalledArtifact(manifestValue: unknown): Promise<boolean> {
    const manifest = parseAssetManifest(manifestValue);
    return (await this.checkInstallation(manifest)).status === "INSTALLED";
  }

  public async getInstalledPath(manifestValue: unknown): Promise<string> {
    const manifest = parseAssetManifest(manifestValue);
    const check = await this.checkInstallation(manifest);
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
    const directoryHandle = await opendir(paths.artifacts);
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
      } catch {
        continue;
      }

      if ((await this.checkInstallation(manifest)).status !== "INSTALLED") continue;
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
      const leftKey = left.familyId + "\0" + left.version + "\0" + left.artifactId;
      const rightKey = right.familyId + "\0" + right.version + "\0" + right.artifactId;
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
    await removeEntryInsideRoot(paths.root, path.join(paths.artifacts, key));
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
    const directoryHandle = await opendir(paths.temporary);
    for await (const entry of directoryHandle) {
      if (!TEMPORARY_ENTRY_PATTERN.test(entry.name)) continue;
      await removeEntryInsideRoot(paths.root, path.join(paths.temporary, entry.name));
    }
    this.lastFailures.clear();
  }

  public async clearUnused(keepManifestValues: readonly unknown[]): Promise<number> {
    if (this.inFlight.size > 0) {
      throw new ModelAssetError(
        "ASSET_BUSY",
        "Cannot clear unused artifacts while installations are in flight."
      );
    }

    const keepKeys = new Set(
      keepManifestValues.map((value) => artifactInstallationKey(parseAssetManifest(value)))
    );
    const paths = await this.getSafeCachePaths();
    const directoryHandle = await opendir(paths.artifacts);
    let removed = 0;

    for await (const entry of directoryHandle) {
      if (!INSTALLATION_KEY_PATTERN.test(entry.name) || keepKeys.has(entry.name)) continue;
      await removeEntryInsideRoot(paths.root, path.join(paths.artifacts, entry.name));
      this.lastFailures.delete(entry.name);
      removed += 1;
    }
    return removed;
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
        stage: "DOWNLOADING",
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

    const initial = await this.checkInstallation(manifest);
    if (initial.status === "INSTALLED" && initial.path !== undefined) return initial.path;
    if (await pathEntryExists(installationDirectory)) {
      await removeEntryInsideRoot(paths.root, installationDirectory);
    }

    const reservationBytes = manifest.sizeBytes;
    await this.reserveCapacity(paths, reservationBytes);
    const stagingDirectory = path.join(
      paths.temporary,
      key + "-" + randomUUID()
    );
    setStagingDirectory(stagingDirectory);
    let published = false;

    try {
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation was cancelled.");
      }
      await ensureSafeDirectory(paths.root, stagingDirectory);
      const stagedPayload = installedPayloadPath(stagingDirectory, manifest);

      setStage("DOWNLOADING");
      await stagePayload(stagedPayload);

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

      await writeStoredManifest(
        path.join(stagingDirectory, "manifest.json"),
        serializeAssetManifest(manifest)
      );
      if (signal.aborted) {
        throw new ModelAssetError(
          "CANCELLED",
          "Artifact installation was cancelled before publication."
        );
      }

      if (await pathEntryExists(installationDirectory)) {
        const existing = await this.checkInstallation(manifest);
        if (existing.status === "INSTALLED" && existing.path !== undefined) {
          await removeEntryInsideRoot(paths.root, stagingDirectory);
          return existing.path;
        }
        await removeEntryInsideRoot(paths.root, installationDirectory);
      }

      if (signal.aborted) {
        throw new ModelAssetError(
          "CANCELLED",
          "Artifact installation was cancelled before publication."
        );
      }

      try {
        await atomicRenameDirectory(stagingDirectory, installationDirectory);
        published = true;
      } catch (error) {
        const raced = await this.checkInstallation(manifest);
        if (raced.status === "INSTALLED" && raced.path !== undefined) {
          await removeEntryInsideRoot(paths.root, stagingDirectory);
          return raced.path;
        }
        throw error;
      }
      return installedPayloadPath(installationDirectory, manifest);
    } finally {
      setStagingDirectory(undefined);
      this.releaseCapacity(reservationBytes);
      if (!published) {
        await removeEntryInsideRoot(paths.root, stagingDirectory).catch(() => undefined);
      }
    }
  }

  private async checkInstallation(manifest: AssetManifest): Promise<InstallationCheck> {
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
      return { status: "CORRUPT", errorCode: "CORRUPT_INSTALLATION" };
    }

    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return { status: "CORRUPT", errorCode: "CORRUPT_INSTALLATION" };
    }

    try {
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
      });
      if (!verification.ok) {
        return { status: "CORRUPT", errorCode: verification.reason };
      }
      return { status: "INSTALLED", path: payload };
    } catch (error) {
      return { status: "CORRUPT", errorCode: modelAssetErrorCode(error) };
    }
  }

  private async managedCachePayloadBytes(paths: CachePaths): Promise<number> {
    const activeStagingDirectories = new Set(
      [...this.inFlight.values()]
        .map((entry) => entry.stagingDirectory)
        .filter((directory): directory is string => directory !== undefined)
    );

    let total = 0;
    const artifacts = await opendir(paths.artifacts);
    for await (const entry of artifacts) {
      if (!INSTALLATION_KEY_PATTERN.test(entry.name)) continue;
      total += await sumArtifactPayloadBytes(path.join(paths.artifacts, entry.name));
      if (!Number.isSafeInteger(total)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Managed artifact cache usage exceeds safe integer accounting limits."
        );
      }
    }

    const temporary = await opendir(paths.temporary);
    for await (const entry of temporary) {
      if (!TEMPORARY_ENTRY_PATTERN.test(entry.name)) continue;
      const candidate = path.join(paths.temporary, entry.name);
      if (activeStagingDirectories.has(candidate)) continue;
      total += await sumArtifactPayloadBytes(candidate);
      if (!Number.isSafeInteger(total)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Managed temporary cache usage exceeds safe integer accounting limits."
        );
      }
    }
    return total;
  }

  private async reserveCapacity(paths: CachePaths, requestedBytes: number): Promise<void> {
    await this.withCapacityGate(async () => {
      const reservedProjection = this.reservedBytes + requestedBytes;
      if (!Number.isSafeInteger(reservedProjection)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "In-flight artifact reservations exceed safe integer accounting limits."
        );
      }

      if (this.maxCacheBytes !== undefined) {
        const usedBytes = await this.managedCachePayloadBytes(paths);
        const projected = usedBytes + reservedProjection;
        if (!Number.isSafeInteger(projected) || projected > this.maxCacheBytes) {
          throw new ModelAssetError(
            "CACHE_LIMIT_EXCEEDED",
            "Artifact installation would exceed the configured cache-size limit."
          );
        }
      }

      const available = await availableDiskBytes(paths.root);
      if (available !== undefined && available < BigInt(reservedProjection)) {
        throw new ModelAssetError(
          "INSUFFICIENT_DISK_SPACE",
          "Insufficient free disk space for verified atomic installation."
        );
      }
      this.reservedBytes = reservedProjection;
    });
  }

  private releaseCapacity(bytes: number): void {
    this.reservedBytes = Math.max(0, this.reservedBytes - bytes);
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

import type { BigIntStats, Dir, Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";
import {
  MAX_DOWNLOAD_REDIRECTS,
  MAX_DOWNLOAD_TIMEOUT_MS,
  downloadHttpArtifact
} from "./download.js";
import {
  atomicRenameDirectory,
  availableDiskBytes,
  copyLocalArtifactBounded,
  createStableStagingFile,
  ensureSafeDirectory,
  initializeCachePaths,
  installedPayloadPath,
  pathEntryExists,
  readStoredManifest,
  readStoredManifestWithIdentity,
  REMOVAL_TOMBSTONE_PATTERN,
  removeEntryInsideRoot,
  sumManagedCacheBytes,
  validateCachePaths,
  verifyArtifactFileWithIdentity,
  writeStableStagedManifest,
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
const MANAGED_DIRECTORY_ENTRY_LIMIT = 2;
const INSTALLATION_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const TEMPORARY_ENTRY_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MANAGER_OPTION_KEYS = new Set([
  "rootDir",
  "maxArtifactBytes",
  "maxCacheBytes",
  "downloadTimeoutMs",
  "maxRedirects",
  "allowCrossOriginRedirects",
  "maxListEntries"
]);

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
  waiters: number;
  settled: boolean;
  promise: Promise<string>;
}

interface InstallationCheck {
  readonly status: "NOT_PRESENT" | "INSTALLED" | "CORRUPT" | "FAILED";
  readonly path?: string;
  readonly errorCode?: ModelAssetErrorCode;
}

interface SharedCacheState {
  readonly identity: string;
  capacityGate: Promise<void>;
  mutationGate: Promise<void>;
  pendingGateUsers: number;
  reservedBytes: number;
  readonly activeStagingDirectories: Set<string>;
  readonly stagingReservations: Map<string, number>;
  readonly activeInstallationCounts: Map<string, number>;
  readonly activeCacheLimitCounts: Map<number, number>;
}

const sharedCacheStates = new Map<string, SharedCacheState>();

function sharedCacheIdentity(paths: CachePaths): string {
  return [
    paths.root,
    String(paths.rootDevice),
    String(paths.rootInode),
    String(paths.artifactsDevice),
    String(paths.artifactsInode),
    String(paths.temporaryDevice),
    String(paths.temporaryInode)
  ].join("\0");
}

function sharedCacheStateFor(paths: CachePaths): SharedCacheState {
  const identity = sharedCacheIdentity(paths);
  const existing = sharedCacheStates.get(identity);
  if (existing !== undefined) return existing;
  const created: SharedCacheState = {
    identity,
    capacityGate: Promise.resolve(),
    mutationGate: Promise.resolve(),
    pendingGateUsers: 0,
    reservedBytes: 0,
    activeStagingDirectories: new Set<string>(),
    stagingReservations: new Map<string, number>(),
    activeInstallationCounts: new Map<string, number>(),
    activeCacheLimitCounts: new Map<number, number>()
  };
  sharedCacheStates.set(identity, created);
  return created;
}

function pruneSharedCacheState(shared: SharedCacheState): void {
  if (shared.pendingGateUsers !== 0
      || shared.reservedBytes !== 0
      || shared.activeStagingDirectories.size !== 0
      || shared.stagingReservations.size !== 0
      || shared.activeInstallationCounts.size !== 0
      || shared.activeCacheLimitCounts.size !== 0) {
    return;
  }
  if (sharedCacheStates.get(shared.identity) === shared) {
    sharedCacheStates.delete(shared.identity);
  }
}

function positiveSafeInteger(value: unknown, fallback: number, label: string): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      label + " must be a positive safe integer."
    );
  }
  return resolved;
}

function nonnegativeSafeInteger(value: unknown, fallback: number, label: string): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 0) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      label + " must be a non-negative safe integer."
    );
  }
  return resolved;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isProxy(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      "Configuration fields must be own data properties."
    );
  }
  return descriptor.value;
}

function clonePlainDataArray(value: unknown): readonly unknown[] | undefined {
  if (typeof value !== "object" || value === null || isProxy(value) || !Array.isArray(value)) {
    return undefined;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype) return undefined;
    const clone: unknown[] = new Array<unknown>(value.length);
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

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null || isProxy(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== AbortSignal.prototype
        || Object.hasOwn(value, "aborted")
        || Object.hasOwn(value, "addEventListener")
        || Object.hasOwn(value, "removeEventListener")) {
      return false;
    }
    const abortedGetter = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted"
    )?.get;
    if (abortedGetter === undefined) return false;
    return typeof abortedGetter.call(value) === "boolean";
  } catch {
    return false;
  }
}

function validateOptionalAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!isAbortSignal(value)) {
    throw new ModelAssetError(
      "INVALID_CONFIGURATION",
      "Cancellation signal must be an AbortSignal when provided."
    );
  }
  return value;
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

  public constructor(options: ModelAssetManagerOptions) {
    const rawOptions: unknown = options;
    if (!isUnknownRecord(rawOptions)) {
      throw new ModelAssetError(
        "INVALID_CONFIGURATION",
        "Model asset manager options must be an object."
      );
    }
    const optionRecord = rawOptions;
    for (const key of Object.keys(optionRecord)) {
      if (!MANAGER_OPTION_KEYS.has(key)) {
        throw new ModelAssetError(
          "INVALID_CONFIGURATION",
          "Unknown model asset manager option: " + key + "."
        );
      }
    }
    const rootDir = ownValue(optionRecord, "rootDir");
    if (typeof rootDir !== "string"
        || rootDir.includes("\0")
        || !path.isAbsolute(rootDir)) {
      throw new ModelAssetError("INVALID_CACHE_ROOT", "Asset cache root must be an absolute path.");
    }
    const normalizedRoot = path.resolve(rootDir);
    if (normalizedRoot === path.parse(normalizedRoot).root) {
      throw new ModelAssetError(
        "INVALID_CACHE_ROOT",
        "Asset cache root may not be a filesystem or share root."
      );
    }

    const rawCrossOriginRedirects = ownValue(optionRecord, "allowCrossOriginRedirects");
    if (rawCrossOriginRedirects !== undefined && typeof rawCrossOriginRedirects !== "boolean") {
      throw new ModelAssetError(
        "INVALID_CONFIGURATION",
        "allowCrossOriginRedirects must be a boolean when provided."
      );
    }

    this.maxArtifactBytes = positiveSafeInteger(
      ownValue(optionRecord, "maxArtifactBytes"),
      0,
      "maxArtifactBytes"
    );
    const rawMaxCacheBytes = ownValue(optionRecord, "maxCacheBytes");
    this.maxCacheBytes = rawMaxCacheBytes === undefined
      ? undefined
      : positiveSafeInteger(rawMaxCacheBytes, 0, "maxCacheBytes");
    this.downloadTimeoutMs = positiveSafeInteger(
      ownValue(optionRecord, "downloadTimeoutMs"),
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
      ownValue(optionRecord, "maxRedirects"),
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
      ownValue(optionRecord, "maxListEntries"),
      DEFAULT_MAX_LIST_ENTRIES,
      "maxListEntries"
    );
    this.cachePathsPromise = initializeCachePaths(rootDir);
    void this.cachePathsPromise.catch(() => undefined);
  }

  public async install(manifestValue: unknown, signal?: AbortSignal): Promise<string> {
    const validatedSignal = validateOptionalAbortSignal(signal);
    const manifest = parseAssetManifest(manifestValue);
    return await this.joinOrStart(
      manifest,
      validatedSignal,
      async (internalSignal, setStage) => await this.performInstallation(
        manifest,
        internalSignal,
        setStage,
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
    const validatedSignal = validateOptionalAbortSignal(signal);
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
      validatedSignal,
      async (internalSignal, setStage) => await this.performInstallation(
        manifest,
        internalSignal,
        setStage,
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
      if (!INSTALLATION_KEY_PATTERN.test(entry.name)) continue;

      const directory = path.join(paths.artifacts, entry.name);
      let directoryStat: BigIntStats;
      try {
        directoryStat = await lstat(directory, { bigint: true });
      } catch (error) {
        if (typeof error === "object"
            && error !== null
            && "code" in error
            && error.code === "ENOENT") {
          continue;
        }
        throw new ModelAssetError(
          "IO_ERROR",
          "Unable to inspect an installed artifact cache entry.",
          { cause: error }
        );
      }
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;

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

    await validateCachePaths(paths);
    return installed.sort((left, right) => {
      const leftKey = [
        left.familyId,
        left.artifactId,
        left.version,
        left.type,
        left.platform ?? "",
        left.architecture ?? "",
        left.variant ?? "",
        left.sha256
      ].join("\0");
      const rightKey = [
        right.familyId,
        right.artifactId,
        right.version,
        right.type,
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
    await this.withCapacityGate(paths, async () => {
      await this.withMutationGate(paths, async (shared) => {
        if ((shared.activeInstallationCounts.get(key) ?? 0) > 0) {
          throw new ModelAssetError(
            "ASSET_BUSY",
            "Cannot remove an artifact while its installation is in flight."
          );
        }
        await this.removeManagedEntry(paths, path.join(paths.artifacts, key));
      });
    });
    this.lastFailures.delete(key);
  }

  public async cleanupTemporary(): Promise<void> {
    const paths = await this.getSafeCachePaths();
    await this.withMutationGate(paths, async (shared) => {
      if (shared.activeInstallationCounts.size > 0) {
        throw new ModelAssetError(
          "ASSET_BUSY",
          "Cannot clear temporary downloads while installations are in flight."
        );
      }

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
      await validateCachePaths(paths);
    });
    this.lastFailures.clear();
  }

  public async clearUnused(keepManifestValues: readonly unknown[]): Promise<number> {
    const keepValues = clonePlainDataArray(keepManifestValues);
    if (keepValues === undefined) {
      throw new ModelAssetError(
        "INVALID_MANIFEST",
        "Keep-manifest collection must be a plain dense data array."
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
    return await this.withMutationGate(paths, async (shared) => {
      if (shared.activeInstallationCounts.size > 0) {
        throw new ModelAssetError(
          "ASSET_BUSY",
          "Cannot clear unused artifacts while installations are in flight."
        );
      }
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
      await validateCachePaths(paths);
      return removed;
    });
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
      setStage: (stage: "DOWNLOADING" | "VERIFYING") => void
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
        waiters: 0,
        settled: false,
        promise: Promise.resolve("")
      };
      const current = entry;
      current.promise = operation(
        controller.signal,
        (stage) => {
          current.stage = stage;
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

      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted === true) {
        abortListener();
        return;
      }

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
      if (signal?.aborted === true) {
        abortListener();
        return;
      }
      entry.promise.then(finish, finish);
    });
  }

  private async getSafeCachePaths(): Promise<CachePaths> {
    const paths = await this.cachePathsPromise;
    await validateCachePaths(paths);
    return paths;
  }

  private async assertStoredManifestPath(
    manifestPath: string,
    identity: {
      readonly device: bigint;
      readonly inode: bigint;
      readonly size: bigint;
      readonly mtimeNs: bigint;
      readonly ctimeNs: bigint;
    }
  ): Promise<void> {
    let manifestStat: BigIntStats;
    try {
      manifestStat = await lstat(manifestPath, { bigint: true });
    } catch (error) {
      if (typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ENOENT") {
        throw new ModelAssetError(
          "CORRUPT_INSTALLATION",
          "Installed artifact manifest disappeared before final acceptance.",
          { cause: error }
        );
      }
      throw new ModelAssetError(
        "IO_ERROR",
        "Unable to re-inspect installed artifact manifest before final acceptance.",
        { cause: error }
      );
    }
    if (manifestStat.isSymbolicLink()
        || !manifestStat.isFile()
        || manifestStat.dev !== identity.device
        || manifestStat.ino !== identity.inode
        || manifestStat.size !== identity.size
        || manifestStat.mtimeNs !== identity.mtimeNs
        || manifestStat.ctimeNs !== identity.ctimeNs) {
      throw new ModelAssetError(
        "CORRUPT_INSTALLATION",
        "Installed artifact manifest changed before final acceptance."
      );
    }
  }

  private async assertVerifiedPayloadPath(
    payloadPath: string,
    identity: {
      readonly device: bigint;
      readonly inode: bigint;
      readonly size: bigint;
      readonly mtimeNs: bigint;
      readonly ctimeNs: bigint;
    },
    errorCode: "CORRUPT_INSTALLATION" | "UNSAFE_PATH"
  ): Promise<void> {
    let payloadStat: BigIntStats;
    try {
      payloadStat = await lstat(payloadPath, { bigint: true });
    } catch (error) {
      if (typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ENOENT") {
        throw new ModelAssetError(
          errorCode,
          "Verified artifact payload disappeared before it could be accepted.",
          { cause: error }
        );
      }
      throw new ModelAssetError(
        "IO_ERROR",
        "Unable to re-inspect the verified artifact payload.",
        { cause: error }
      );
    }
    if (payloadStat.isSymbolicLink()
        || !payloadStat.isFile()
        || payloadStat.dev !== identity.device
        || payloadStat.ino !== identity.inode
        || payloadStat.size !== identity.size
        || payloadStat.mtimeNs !== identity.mtimeNs
        || payloadStat.ctimeNs !== identity.ctimeNs) {
      throw new ModelAssetError(
        errorCode,
        "Artifact payload changed after integrity verification."
      );
    }
  }

  private async assertSafeStagingDirectory(
    paths: CachePaths,
    stagingDirectory: string,
    expectedIdentity?: { readonly device: bigint; readonly inode: bigint }
  ): Promise<BigIntStats> {
    await validateCachePaths(paths);
    let entry: BigIntStats;
    try {
      entry = await lstat(stagingDirectory, { bigint: true });
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

  private managedDirectoryTraversalLimit(): number {
    return Math.max(MANAGED_DIRECTORY_ENTRY_LIMIT, this.maxListEntries);
  }

  private async removeManagedEntry(paths: CachePaths, candidate: string): Promise<void> {
    await validateCachePaths(paths);
    await removeEntryInsideRoot(paths.root, candidate, this.managedDirectoryTraversalLimit());
  }

  private async assertArtifactDirectoryShape(
    directoryPath: string,
    manifest: AssetManifest,
    errorCode: "CORRUPT_INSTALLATION" | "UNSAFE_PATH",
    expectedIdentity?: { readonly device: bigint; readonly inode: bigint }
  ): Promise<void> {
    let directoryStat: BigIntStats;
    try {
      directoryStat = await lstat(directoryPath, { bigint: true });
    } catch (error) {
      if (typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ENOENT") {
        throw new ModelAssetError(
          errorCode,
          "Artifact directory disappeared during structural inspection.",
          { cause: error }
        );
      }
      throw new ModelAssetError(
        "IO_ERROR",
        "Unable to inspect artifact directory structure.",
        { cause: error }
      );
    }
    if (directoryStat.isSymbolicLink()
        || !directoryStat.isDirectory()
        || (expectedIdentity !== undefined
          && (directoryStat.dev !== expectedIdentity.device
            || directoryStat.ino !== expectedIdentity.inode))) {
      throw new ModelAssetError(
        errorCode,
        "Artifact directory changed to a different or unsafe filesystem entry."
      );
    }

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

    for (const requiredName of ["manifest.json", manifest.filename]) {
      const requiredPath = path.join(directoryPath, requiredName);
      let requiredStat: Stats;
      try {
        requiredStat = await lstat(requiredPath);
      } catch (error) {
        if (typeof error === "object"
            && error !== null
            && "code" in error
            && error.code === "ENOENT") {
          throw new ModelAssetError(
            errorCode,
            "Artifact directory changed while its required entries were being inspected.",
            { cause: error }
          );
        }
        throw new ModelAssetError(
          "IO_ERROR",
          "Unable to inspect a required artifact cache entry.",
          { cause: error }
        );
      }
      if (requiredStat.isSymbolicLink() || !requiredStat.isFile()) {
        throw new ModelAssetError(
          errorCode,
          "Artifact directory required entries must be regular non-symlink files."
        );
      }
    }

    let finalDirectoryStat: BigIntStats;
    try {
      finalDirectoryStat = await lstat(directoryPath, { bigint: true });
    } catch (error) {
      if (typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ENOENT") {
        throw new ModelAssetError(
          errorCode,
          "Artifact directory disappeared during final structural inspection.",
          { cause: error }
        );
      }
      throw new ModelAssetError(
        "IO_ERROR",
        "Unable to complete artifact directory structural inspection.",
        { cause: error }
      );
    }
    if (finalDirectoryStat.isSymbolicLink()
        || !finalDirectoryStat.isDirectory()
        || finalDirectoryStat.dev !== directoryStat.dev
        || finalDirectoryStat.ino !== directoryStat.ino
        || (expectedIdentity !== undefined
          && (finalDirectoryStat.dev !== expectedIdentity.device
            || finalDirectoryStat.ino !== expectedIdentity.inode))) {
      throw new ModelAssetError(
        errorCode,
        "Artifact directory was replaced during structural inspection."
      );
    }
  }

  private rejectTransientInstallationFailure(check: InstallationCheck): void {
    if (check.status === "FAILED") {
      throw new ModelAssetError(
        check.errorCode ?? "IO_ERROR",
        "Existing artifact installation could not be inspected safely; refusing destructive repair."
      );
    }
  }

  private async reconcileDestinationForInstall(
    paths: CachePaths,
    manifest: AssetManifest,
    signal: AbortSignal
  ): Promise<string | undefined> {
    return await this.withMutationGate(paths, async () => {
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      const current = await this.checkInstallation(manifest, signal);
      if (current.status === "INSTALLED" && current.path !== undefined) {
        return current.path;
      }
      this.rejectTransientInstallationFailure(current);
      if (current.status === "CORRUPT") {
        const directory = path.join(paths.artifacts, artifactInstallationKey(manifest));
        if (await pathEntryExists(directory)) {
          await this.removeManagedEntry(paths, directory);
        }
      }
      return undefined;
    });
  }

  private async beginSharedInstallation(
    paths: CachePaths,
    key: string,
    maxCacheBytes: number | undefined
  ): Promise<void> {
    await this.withCapacityGate(paths, async () => {
      await this.withMutationGate(paths, async (shared) => {
        shared.activeInstallationCounts.set(
          key,
          (shared.activeInstallationCounts.get(key) ?? 0) + 1
        );
        if (maxCacheBytes !== undefined) {
          shared.activeCacheLimitCounts.set(
            maxCacheBytes,
            (shared.activeCacheLimitCounts.get(maxCacheBytes) ?? 0) + 1
          );
        }
      });
    });
  }

  private async endSharedInstallation(
    paths: CachePaths,
    key: string,
    maxCacheBytes: number | undefined
  ): Promise<void> {
    await this.withCapacityGate(paths, async () => {
      await this.withMutationGate(paths, async (shared) => {
        const count = shared.activeInstallationCounts.get(key) ?? 0;
        if (count <= 1) {
          shared.activeInstallationCounts.delete(key);
        } else {
          shared.activeInstallationCounts.set(key, count - 1);
        }
        if (maxCacheBytes !== undefined) {
          const limitCount = shared.activeCacheLimitCounts.get(maxCacheBytes) ?? 0;
          if (limitCount <= 1) {
            shared.activeCacheLimitCounts.delete(maxCacheBytes);
          } else {
            shared.activeCacheLimitCounts.set(maxCacheBytes, limitCount - 1);
          }
        }
      });
    });
  }

  private async performInstallation(
    manifest: AssetManifest,
    signal: AbortSignal,
    setStage: (stage: "DOWNLOADING" | "VERIFYING") => void,
    stagePayload: (destination: FileHandle) => Promise<void>
  ): Promise<string> {
    const paths = await this.getSafeCachePaths();
    const key = artifactInstallationKey(manifest);
    await this.beginSharedInstallation(paths, key, this.maxCacheBytes);
    try {
      const installationDirectory = path.join(paths.artifacts, key);

      setStage("VERIFYING");
    const initial = await this.checkInstallation(manifest, signal);
    if (initial.status === "INSTALLED" && initial.path !== undefined) return initial.path;
    this.rejectTransientInstallationFailure(initial);
    if (signal.aborted) {
      throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
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
    await this.reserveCapacity(paths, stagingDirectory, reservationBytes, signal);
    const shared = sharedCacheStateFor(paths);
    shared.activeStagingDirectories.add(stagingDirectory);
    let published = false;
    let reservationHeld = true;

    try {
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation was cancelled.");
      }
      await validateCachePaths(paths);
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
      const stagedPayloadHandle = await createStableStagingFile(
        stagingDirectory,
        manifest.filename,
        stagingIdentity
      );

      setStage("DOWNLOADING");
      let transferFailed = false;
      try {
        await stagePayload(stagedPayloadHandle);
      } catch (error) {
        transferFailed = true;
        throw error;
      } finally {
        try {
          await stagedPayloadHandle.close();
        } catch (error) {
          if (!transferFailed) {
            throw new ModelAssetError(
              "IO_ERROR",
              "Unable to close the staged artifact payload after transfer.",
              { cause: error }
            );
          }
        }
      }
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation was cancelled after transfer.");
      }
      await this.assertSafeStagingDirectory(paths, stagingDirectory, stagingIdentity);

      setStage("VERIFYING");
      await writeStableStagedManifest(
        stagingDirectory,
        serializedManifest,
        stagingIdentity
      );
      await this.assertArtifactDirectoryShape(
        stagingDirectory,
        manifest,
        "UNSAFE_PATH",
        stagingIdentity
      );
      if (signal.aborted) {
        throw new ModelAssetError(
          "CANCELLED",
          "Artifact installation was cancelled before publication."
        );
      }

      const verification = await verifyArtifactFileWithIdentity(stagedPayload, {
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
      await this.assertVerifiedPayloadPath(
        stagedPayload,
        verification.identity,
        "UNSAFE_PATH"
      );
      if (signal.aborted) {
        throw new ModelAssetError(
          "CANCELLED",
          "Artifact installation was cancelled before publication."
        );
      }

      const existing = await this.reconcileDestinationForInstall(paths, manifest, signal);
      if (existing !== undefined) {
        await this.removeManagedEntry(paths, stagingDirectory);
        if (signal.aborted) {
          throw new ModelAssetError(
            "CANCELLED",
            "Artifact installation request was cancelled."
          );
        }
        return existing;
      }
      await this.assertVerifiedPayloadPath(
        stagedPayload,
        verification.identity,
        "UNSAFE_PATH"
      );
      await this.assertSafeStagingDirectory(paths, stagingDirectory, stagingIdentity);
      await this.assertArtifactDirectoryShape(
        stagingDirectory,
        manifest,
        "UNSAFE_PATH",
        stagingIdentity
      );
      try {
        await this.publishReservedArtifact(
          paths,
          stagingDirectory,
          installationDirectory,
          reservationBytes,
          signal,
          stagingIdentity,
          manifest,
          verification.identity
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
      shared.activeStagingDirectories.delete(stagingDirectory);
      if (!published) {
        await this.removeManagedEntry(paths, stagingDirectory).catch(() => undefined);
      }
      if (reservationHeld) {
        await this.releaseCapacity(paths, stagingDirectory, reservationBytes);
      }
    }
    } finally {
      await this.endSharedInstallation(paths, key, this.maxCacheBytes);
    }
  }

  private async checkInstallation(
    manifest: AssetManifest,
    signal?: AbortSignal
  ): Promise<InstallationCheck> {
    const paths = await this.getSafeCachePaths();
    const key = artifactInstallationKey(manifest);
    const directory = path.join(paths.artifacts, key);

    let directoryStat: BigIntStats;
    try {
      directoryStat = await lstat(directory, { bigint: true });
    } catch (error) {
      if (typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ENOENT") {
        await validateCachePaths(paths);
        return { status: "NOT_PRESENT" };
      }
      return { status: "FAILED", errorCode: "IO_ERROR" };
    }

    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return { status: "CORRUPT", errorCode: "CORRUPT_INSTALLATION" };
    }

    try {
      await this.assertArtifactDirectoryShape(
        directory,
        manifest,
        "CORRUPT_INSTALLATION",
        { device: directoryStat.dev, inode: directoryStat.ino }
      );
      const storedManifestPath = path.join(directory, "manifest.json");
      const storedRead = await readStoredManifestWithIdentity(storedManifestPath);
      const stored = AssetManifestSchema.safeParse(storedRead.value);
      if (!stored.success || artifactInstallationKey(stored.data) !== key) {
        return { status: "CORRUPT", errorCode: "CORRUPT_INSTALLATION" };
      }

      const payload = installedPayloadPath(directory, manifest);
      const verification = await verifyArtifactFileWithIdentity(payload, {
        sizeBytes: manifest.sizeBytes,
        sha256: manifest.sha256,
        maxBytes: this.maxArtifactBytes
      }, signal);
      if (!verification.ok) {
        return { status: "CORRUPT", errorCode: verification.reason };
      }
      await this.assertVerifiedPayloadPath(
        payload,
        verification.identity,
        "CORRUPT_INSTALLATION"
      );
      if (signal?.aborted === true) {
        throw new ModelAssetError("CANCELLED", "Artifact integrity inspection was cancelled.");
      }
      await validateCachePaths(paths);
      const finalDirectoryStat = await lstat(directory, { bigint: true });
      if (finalDirectoryStat.isSymbolicLink()
          || !finalDirectoryStat.isDirectory()
          || finalDirectoryStat.dev !== directoryStat.dev
          || finalDirectoryStat.ino !== directoryStat.ino) {
        return { status: "CORRUPT", errorCode: "CORRUPT_INSTALLATION" };
      }
      await this.assertArtifactDirectoryShape(
        directory,
        manifest,
        "CORRUPT_INSTALLATION",
        { device: directoryStat.dev, inode: directoryStat.ino }
      );
      await this.assertVerifiedPayloadPath(
        payload,
        verification.identity,
        "CORRUPT_INSTALLATION"
      );
      await this.assertStoredManifestPath(
        storedManifestPath,
        storedRead.identity
      );
      await validateCachePaths(paths);
      return { status: "INSTALLED", path: payload };
    } catch (error) {
      if (error instanceof ModelAssetError && error.code === "CANCELLED") throw error;
      const errorCode = modelAssetErrorCode(error);
      const operationalFailure = errorCode === "IO_ERROR"
        || errorCode === "ARTIFACT_TOO_LARGE"
        || errorCode === "INVALID_CONFIGURATION";
      return {
        status: operationalFailure ? "FAILED" : "CORRUPT",
        errorCode
      };
    }
  }

  private async managedCacheBytes(paths: CachePaths): Promise<number> {
    const activeStagingDirectories = sharedCacheStateFor(paths).activeStagingDirectories;

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
      total += await sumManagedCacheBytes(path.join(paths.artifacts, entry.name), MANAGED_DIRECTORY_ENTRY_LIMIT);
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
      total += await sumManagedCacheBytes(candidate, MANAGED_DIRECTORY_ENTRY_LIMIT);
      if (!Number.isSafeInteger(total)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Managed temporary cache usage exceeds safe integer accounting limits."
        );
      }
    }
    await validateCachePaths(paths);
    return total;
  }

  private async publishReservedArtifact(
    paths: CachePaths,
    stagingDirectory: string,
    installationDirectory: string,
    reservationBytes: number,
    signal: AbortSignal,
    stagingIdentity: { readonly device: bigint; readonly inode: bigint },
    manifest: AssetManifest,
    verifiedPayloadIdentity: {
      readonly device: bigint;
      readonly inode: bigint;
      readonly size: bigint;
      readonly mtimeNs: bigint;
      readonly ctimeNs: bigint;
    }
  ): Promise<void> {
    await this.withCapacityGate(paths, async (shared) => {
      await this.withMutationGate(paths, async () => {
        if (signal.aborted) {
          throw new ModelAssetError(
            "CANCELLED",
            "Artifact installation was cancelled before publication."
          );
        }
        await this.assertSafeStagingDirectory(paths, stagingDirectory, stagingIdentity);
        await this.assertArtifactDirectoryShape(
          stagingDirectory,
          manifest,
          "UNSAFE_PATH",
          stagingIdentity
        );
        await this.assertVerifiedPayloadPath(
          installedPayloadPath(stagingDirectory, manifest),
          verifiedPayloadIdentity,
          "UNSAFE_PATH"
        );

        const stagedManifestPath = path.join(stagingDirectory, "manifest.json");
        const stagedManifestRead = await readStoredManifestWithIdentity(stagedManifestPath);
        const stagedManifest = AssetManifestSchema.safeParse(stagedManifestRead.value);
        if (!stagedManifest.success
            || serializeAssetManifest(stagedManifest.data) !== serializeAssetManifest(manifest)) {
          throw new ModelAssetError(
            "CORRUPT_INSTALLATION",
            "Staged artifact manifest changed before atomic publication."
          );
        }

        await validateCachePaths(paths);
        if (signal.aborted) {
          throw new ModelAssetError(
            "CANCELLED",
            "Artifact installation was cancelled before publication."
          );
        }
        if (shared.stagingReservations.get(stagingDirectory) !== reservationBytes
            || reservationBytes > shared.reservedBytes) {
          throw new ModelAssetError(
            "IO_ERROR",
            "Cache reservation accounting lost staging identity before atomic publication."
          );
        }

        let effectiveMaxCacheBytes: number | undefined;
        for (const activeLimit of shared.activeCacheLimitCounts.keys()) {
          if (effectiveMaxCacheBytes === undefined || activeLimit < effectiveMaxCacheBytes) {
            effectiveMaxCacheBytes = activeLimit;
          }
        }
        if (effectiveMaxCacheBytes !== undefined) {
          const usedBytes = await this.managedCacheBytes(paths);
          const stagingCommitment = await this.stagingCommitmentBytes(shared);
          const projectedBytes = usedBytes + stagingCommitment.committedBytes;
          if (!Number.isSafeInteger(projectedBytes)
              || projectedBytes > effectiveMaxCacheBytes) {
            throw new ModelAssetError(
              "CACHE_LIMIT_EXCEEDED",
              "Cache contents changed after reservation and now exceed the active cache-size limit."
            );
          }
        }

        await atomicRenameDirectory(stagingDirectory, installationDirectory);

        await this.assertArtifactDirectoryShape(
          installationDirectory,
          manifest,
          "CORRUPT_INSTALLATION",
          stagingIdentity
        );
        await this.assertVerifiedPayloadPath(
          installedPayloadPath(installationDirectory, manifest),
          verifiedPayloadIdentity,
          "CORRUPT_INSTALLATION"
        );
        await this.assertStoredManifestPath(
          path.join(installationDirectory, "manifest.json"),
          stagedManifestRead.identity
        );
        await validateCachePaths(paths);

        shared.stagingReservations.delete(stagingDirectory);
        shared.reservedBytes -= reservationBytes;
      });
    });
  }

  private async stagingCommitmentBytes(
    shared: SharedCacheState
  ): Promise<{ readonly committedBytes: number; readonly outstandingBytes: number }> {
    let committedBytes = 0;
    let outstandingBytes = 0;
    for (const [stagingDirectory, reservedBytes] of shared.stagingReservations) {
      const actualBytes = await sumManagedCacheBytes(
        stagingDirectory,
        MANAGED_DIRECTORY_ENTRY_LIMIT
      );
      committedBytes += Math.max(actualBytes, reservedBytes);
      outstandingBytes += Math.max(0, reservedBytes - actualBytes);
      if (!Number.isSafeInteger(committedBytes)
          || !Number.isSafeInteger(outstandingBytes)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Active staging commitments exceed safe integer accounting limits."
        );
      }
    }
    return { committedBytes, outstandingBytes };
  }

  private async reserveCapacity(
    paths: CachePaths,
    stagingDirectory: string,
    requestedBytes: number,
    signal: AbortSignal
  ): Promise<void> {
    await this.withCapacityGate(paths, async (shared) => {
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      await validateCachePaths(paths);
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      if (shared.stagingReservations.has(stagingDirectory)) {
        throw new ModelAssetError(
          "IO_ERROR",
          "Duplicate staging reservation identity detected."
        );
      }
      const reservedProjection = shared.reservedBytes + requestedBytes;
      if (!Number.isSafeInteger(reservedProjection)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "In-flight artifact reservations exceed safe integer accounting limits."
        );
      }

      const existingCommitment = await this.stagingCommitmentBytes(shared);
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }

      let effectiveMaxCacheBytes: number | undefined;
      for (const activeLimit of shared.activeCacheLimitCounts.keys()) {
        if (effectiveMaxCacheBytes === undefined || activeLimit < effectiveMaxCacheBytes) {
          effectiveMaxCacheBytes = activeLimit;
        }
      }
      if (effectiveMaxCacheBytes !== undefined) {
        const usedBytes = await this.managedCacheBytes(paths);
        if (signal.aborted) {
          throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
        }
        const projected = usedBytes + existingCommitment.committedBytes + requestedBytes;
        if (!Number.isSafeInteger(projected) || projected > effectiveMaxCacheBytes) {
          throw new ModelAssetError(
            "CACHE_LIMIT_EXCEEDED",
            "Artifact installation would exceed the strictest active cache-size limit."
          );
        }
      }

      const outstandingReservation = existingCommitment.outstandingBytes + requestedBytes;
      if (!Number.isSafeInteger(outstandingReservation)) {
        throw new ModelAssetError(
          "CACHE_LIMIT_EXCEEDED",
          "Outstanding staging reservations exceed safe integer accounting limits."
        );
      }
      const available = await availableDiskBytes(paths.temporary);
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      if (available !== undefined && available < BigInt(outstandingReservation)) {
        throw new ModelAssetError(
          "INSUFFICIENT_DISK_SPACE",
          "Insufficient free disk space for verified atomic installation."
        );
      }
      await validateCachePaths(paths);
      if (signal.aborted) {
        throw new ModelAssetError("CANCELLED", "Artifact installation request was cancelled.");
      }
      shared.reservedBytes = reservedProjection;
      shared.stagingReservations.set(stagingDirectory, requestedBytes);
    });
  }

  private async releaseCapacity(
    paths: CachePaths,
    stagingDirectory: string,
    bytes: number
  ): Promise<void> {
    await this.withCapacityGate(paths, async (shared) => {
      if (shared.stagingReservations.get(stagingDirectory) !== bytes
          || bytes > shared.reservedBytes) {
        throw new ModelAssetError(
          "IO_ERROR",
          "Cache reservation accounting underflowed or lost staging identity during release."
        );
      }
      shared.stagingReservations.delete(stagingDirectory);
      shared.reservedBytes -= bytes;
    });
  }

  private async withCapacityGate<T>(
    paths: CachePaths,
    operation: (shared: SharedCacheState) => Promise<T>
  ): Promise<T> {
    const shared = sharedCacheStateFor(paths);
    shared.pendingGateUsers += 1;
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const previous = shared.capacityGate;
    shared.capacityGate = previous.then(() => turn);
    await previous;
    try {
      return await operation(shared);
    } finally {
      release?.();
      shared.pendingGateUsers -= 1;
      pruneSharedCacheState(shared);
    }
  }

  private async withMutationGate<T>(
    paths: CachePaths,
    operation: (shared: SharedCacheState) => Promise<T>
  ): Promise<T> {
    const shared = sharedCacheStateFor(paths);
    shared.pendingGateUsers += 1;
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const previous = shared.mutationGate;
    shared.mutationGate = previous.then(() => turn);
    await previous;
    try {
      return await operation(shared);
    } finally {
      release?.();
      shared.pendingGateUsers -= 1;
      pruneSharedCacheState(shared);
    }
  }
}

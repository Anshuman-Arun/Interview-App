import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  KokoroSpeechSynthesizer,
  MoonshineSpeechRecognizer,
  SileroVadBackend,
  SpeechWorkerCore,
  TtsWorkerCore
} from "../../../../packages/local-compute/src/index.js";
import {
  LocalRuntimeError,
  LocalRuntimeManager,
  type LocalComponentDefinition,
  type LocalComponentStatus
} from "../../../../packages/local-runtime/src/index.js";
import {
  ModelAssetError,
  ModelAssetManager
} from "../../../../packages/model-assets/src/index.js";
import type { VoiceRuntimeConfiguration } from "../../../server/src/voice-runtime.js";
import { ManagedModelWorkerClient } from "./managed-worker-client.js";
import {
  DESKTOP_LOCAL_MODEL_ASSETS,
  SPEECH_ASSETS,
  SPEECH_WORKER_MODEL_IDENTITY,
  TTS_ASSETS,
  TTS_WORKER_MODEL_IDENTITY,
  type DesktopRuntimeAsset
} from "./model-assets.js";
import {
  ManagedKokoroRuntime,
  ManagedMoonshineRuntime,
  ManagedSileroVadRuntime,
  moonshineRecognizerVersion
} from "./runtime-adapters.js";
import {
  cleanupStaleRuntimeAssetViews,
  materializeRuntimeAssetView,
  type RuntimeAssetView
} from "./runtime-asset-view.js";

const SPEECH_COMPONENT_ID = "desktop-local-speech";
const TTS_COMPONENT_ID = "desktop-local-tts";
const WORKER_COMPONENT_VERSION = "2";
const WORKER_PROTOCOL_VERSION = 2;
const SPEECH_RUNTIME_VERSION = "moonshine-voice/0.1.5;onnxruntime/1.29.0;deps/1";
const TTS_RUNTIME_VERSION = "moonshine-voice/0.1.5;deps/1";
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;

export type DesktopRuntimeCapabilityState =
  | "READY"
  | "MISSING_ASSET"
  | "FAILED"
  | "UNAVAILABLE";

export interface DesktopRuntimeCapabilityStatus {
  readonly state: DesktopRuntimeCapabilityState;
  readonly reasonCode?: string;
  readonly modelIdentity?: string;
  readonly runtimeVersion?: string;
}

export interface DesktopRuntimeCapabilitySnapshot {
  readonly speech: DesktopRuntimeCapabilityStatus;
  readonly tts: DesktopRuntimeCapabilityStatus;
  readonly vision: DesktopRuntimeCapabilityStatus;
}

export interface DesktopLocalRuntimeCompositionOptions {
  readonly appDataRoot: string;
  readonly cwd: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly pythonExecutable?: string;
  readonly workerScriptPath?: string;
}

export class DesktopLocalRuntimeComposition {
  private readonly runtimeManager = new LocalRuntimeManager();
  private readonly assetManager: ModelAssetManager;
  private readonly runtimeViewsRoot: string;
  private readonly workerScriptPath: string;
  private readonly pythonExecutableCandidate: string;
  private pythonExecutable: string | undefined;
  private speechStatus: DesktopRuntimeCapabilityStatus = unavailable("NOT_STARTED");
  private ttsStatus: DesktopRuntimeCapabilityStatus = unavailable("NOT_STARTED");
  private readonly visionStatus: DesktopRuntimeCapabilityStatus = Object.freeze({
    state: "UNAVAILABLE",
    reasonCode: "NO_PRODUCTION_BACKEND_CONFIGURED"
  });
  private speechView: RuntimeAssetView | undefined;
  private ttsView: RuntimeAssetView | undefined;
  private speechWorker: SpeechWorkerCore | undefined;
  private ttsWorker: TtsWorkerCore | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly lifecycleAbort = new AbortController();
  private stopping = false;
  private stopped = false;

  public voiceRuntime: VoiceRuntimeConfiguration | undefined;

  public constructor(options: DesktopLocalRuntimeCompositionOptions) {
    this.runtimeViewsRoot = path.join(options.appDataRoot, "runtime-models");
    this.assetManager = new ModelAssetManager({
      rootDir: path.join(options.appDataRoot, "model-assets"),
      maxArtifactBytes: MAX_ASSET_BYTES,
      maxCacheBytes: MAX_CACHE_BYTES,
      downloadTimeoutMs: 120_000,
      maxRedirects: 3,
      allowCrossOriginRedirects: false,
      maxListEntries: 256
    });
    this.workerScriptPath = options.workerScriptPath ?? (
      options.isPackaged
        ? path.join(options.resourcesPath, "workers", "python", "local_model_worker.py")
        : path.resolve(options.cwd, "workers", "python", "local_model_worker.py")
    );
    this.pythonExecutableCandidate = options.pythonExecutable
      ?? (process.platform === "win32" ? "python" : "python3");
  }

  public start(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.stopping || this.stopped) {
      return Promise.reject(new Error("Desktop local runtime cannot start after shutdown"));
    }
    if (this.startPromise !== undefined) return this.startPromise;
    const signal = options.signal === undefined
      ? this.lifecycleAbort.signal
      : AbortSignal.any([this.lifecycleAbort.signal, options.signal]);
    const operation = this.startOptionalCapabilities(signal);
    this.startPromise = operation;
    return operation;
  }

  public getCapabilityStatus(): DesktopRuntimeCapabilitySnapshot {
    return Object.freeze({
      speech: this.liveStatus(SPEECH_COMPONENT_ID, this.speechStatus),
      tts: this.liveStatus(TTS_COMPONENT_ID, this.ttsStatus),
      vision: this.visionStatus
    });
  }

  public async installVoiceAssets(signal?: AbortSignal): Promise<void> {
    if (!isProductionLocalModelPlatformSupported(process.platform, process.arch)) {
      throw new Error("Local model installation is unavailable on this platform");
    }
    await this.assetManager.cleanupTemporary(signal);
    for (const asset of DESKTOP_LOCAL_MODEL_ASSETS) {
      if (abortRequested(signal)) throw abortError();
      await this.assetManager.install(asset.manifest, signal);
    }
  }

  public stopWorkers(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.stopPromise !== undefined) return this.stopPromise;

    this.stopping = true;
    this.lifecycleAbort.abort();
    const operation = this.performStopWorkers();
    this.stopPromise = operation;
    void operation.finally(() => {
      if (this.stopPromise === operation) this.stopPromise = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async performStopWorkers(): Promise<void> {
    const failures: unknown[] = [];
    // Join startup after aborting it before touching the manager. Otherwise an
    // early materialization/inspection continuation could register a worker
    // after stopAll() had already returned.
    if (this.startPromise !== undefined) {
      await this.startPromise.catch((error: unknown) => {
        if (!isAbortError(error)) failures.push(error);
      });
    }

    const coreShutdowns = [
      this.speechWorker?.shutdown(),
      this.ttsWorker?.shutdown()
    ].filter((operation): operation is Promise<void> => operation !== undefined);
    const coreResults = await Promise.allSettled(coreShutdowns);
    for (const result of coreResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }

    let processTreesStopped = false;
    try {
      await this.runtimeManager.stopAll();
      processTreesStopped = true;
    } catch (error) {
      failures.push(error);
    }

    if (processTreesStopped) {
      // Once the process trees are verified gone, the core objects can no longer
      // issue useful work. Clear them even if a later filesystem cleanup fails.
      this.speechWorker = undefined;
      this.ttsWorker = undefined;

      if (this.ttsView !== undefined) {
        try {
          await this.ttsView.dispose();
          this.ttsView = undefined;
        } catch (error) {
          failures.push(error);
        }
      }
      if (this.speechView !== undefined) {
        try {
          await this.speechView.dispose();
          this.speechView = undefined;
        } catch (error) {
          failures.push(error);
        }
      }

      try {
        // Retry cleanup of any failed materialization that never produced a
        // tracked RuntimeAssetView. Actively owned views remain protected.
        await cleanupStaleRuntimeAssetViews(this.runtimeViewsRoot);
      } catch (error) {
        failures.push(error);
      }
    }

    this.voiceRuntime = undefined;
    const runtimeViewsDisposed = this.ttsView === undefined && this.speechView === undefined;
    this.stopped = processTreesStopped && runtimeViewsDisposed;
    // A failed process-tree stop or failed view deletion is a shutdown state,
    // not permission to return to start(). A later stopWorkers() may retry it.
    this.stopping = !this.stopped;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Desktop local model runtime shutdown failed");
    }
  }

  private async startOptionalCapabilities(signal?: AbortSignal): Promise<void> {
    try {
      await this.assetManager.cleanupTemporary(signal);
      await cleanupStaleRuntimeAssetViews(this.runtimeViewsRoot, signal);
    } catch (error) {
      if (abortRequested(signal) || isAbortError(error)) {
        this.markPendingCapabilitiesCancelled();
        return;
      }
      this.speechStatus = failed("ASSET_CACHE_UNSAFE");
      this.ttsStatus = failed("ASSET_CACHE_UNSAFE");
      return;
    }
    if (abortRequested(signal)) {
      this.markPendingCapabilitiesCancelled();
      return;
    }

    if (!isProductionLocalModelPlatformSupported(process.platform, process.arch)) {
      this.speechStatus = unavailable("UNSUPPORTED_RUNTIME_PLATFORM");
      this.ttsStatus = unavailable("UNSUPPORTED_RUNTIME_PLATFORM");
      return;
    }

    const workerAvailable = await this.workerScriptIsSafe();
    if (!workerAvailable) {
      this.speechStatus = unavailable("WORKER_EXECUTABLE_UNAVAILABLE");
      this.ttsStatus = unavailable("WORKER_EXECUTABLE_UNAVAILABLE");
      return;
    }

    const pythonExecutable = await resolvePythonExecutable(
      this.pythonExecutableCandidate,
      process.platform,
      process.env
    );
    if (pythonExecutable === undefined) {
      this.speechStatus = unavailable("PYTHON_RUNTIME_UNAVAILABLE");
      this.ttsStatus = unavailable("PYTHON_RUNTIME_UNAVAILABLE");
      return;
    }
    this.pythonExecutable = pythonExecutable;

    // Runtime views copy large verified model artifacts onto the same app-data
    // filesystem. Start them sequentially so each disk-space check sees the
    // previous materialization instead of allowing two independent reservations
    // to overcommit the same free space.
    let speechFailed = false;
    try {
      await this.startSpeech(signal);
    } catch (error) {
      speechFailed = true;
      if (this.speechStatus.reasonCode === "WORKER_CLEANUP_FAILED") {
        throw new Error(
          "Speech worker startup failed and its process tree could not be safely cleaned",
          { cause: error }
        );
      }
      if (abortRequested(signal)) this.markPendingCapabilitiesCancelled();
    }

    let ttsFailed = false;
    if (abortRequested(signal)) {
      if (this.ttsStatus.reasonCode === "NOT_STARTED") {
        this.ttsStatus = unavailable("START_CANCELLED");
      }
    } else {
      try {
        await this.startTts(signal);
      } catch (error) {
        ttsFailed = true;
        if (this.ttsStatus.reasonCode === "WORKER_CLEANUP_FAILED") {
          throw new Error(
            "TTS worker startup failed and its process tree could not be safely cleaned",
            { cause: error }
          );
        }
      }
    }

    if (!abortRequested(signal)) {
      if (speechFailed
          && this.speechStatus.state === "UNAVAILABLE"
          && this.speechStatus.reasonCode !== "START_CANCELLED") {
        this.speechStatus = failed("WORKER_START_FAILED");
      }
      if (ttsFailed
          && this.ttsStatus.state === "UNAVAILABLE"
          && this.ttsStatus.reasonCode !== "START_CANCELLED") {
        this.ttsStatus = failed("WORKER_START_FAILED");
      }
    }
    const speechReady = this.speechWorker !== undefined
      && this.liveStatus(SPEECH_COMPONENT_ID, this.speechStatus).state === "READY";
    const ttsReady = this.ttsWorker !== undefined
      && this.liveStatus(TTS_COMPONENT_ID, this.ttsStatus).state === "READY";
    if (speechReady && ttsReady && this.speechWorker !== undefined && this.ttsWorker !== undefined) {
      this.voiceRuntime = Object.freeze({
        speechWorker: this.speechWorker,
        tts: Object.freeze({
          worker: this.ttsWorker,
          voice: "kokoro_af_heart",
          language: "en-US",
          sampleRate: 24_000,
          speed: 1
        })
      });
      return;
    }

    // The authoritative server voice contract is intentionally all-or-nothing:
    // browser microphone ingress and generated TTS share one VoiceRuntimeConfiguration.
    // Do not leave one successfully loaded model resident when its counterpart
    // is unavailable and the server therefore cannot expose voice at all.
    if (speechReady) {
      const cleaned = await this.cleanupCapability("speech");
      this.speechStatus = cleaned
        ? unavailable("VOICE_RUNTIME_INCOMPLETE", SPEECH_WORKER_MODEL_IDENTITY)
        : failed("WORKER_CLEANUP_FAILED", SPEECH_WORKER_MODEL_IDENTITY);
      if (!cleaned) {
        throw new Error(
          "Incomplete voice startup left the speech worker process tree unverified"
        );
      }
    }
    if (ttsReady) {
      const cleaned = await this.cleanupCapability("tts");
      this.ttsStatus = cleaned
        ? unavailable("VOICE_RUNTIME_INCOMPLETE", TTS_WORKER_MODEL_IDENTITY)
        : failed("WORKER_CLEANUP_FAILED", TTS_WORKER_MODEL_IDENTITY);
      if (!cleaned) {
        throw new Error(
          "Incomplete voice startup left the TTS worker process tree unverified"
        );
      }
    }
  }

  private async startSpeech(signal?: AbortSignal): Promise<void> {
    const readiness = await this.inspectAssets(SPEECH_ASSETS, signal);
    if (readiness !== "READY") {
      this.speechStatus = readiness === "MISSING_ASSET"
        ? missingAsset("SPEECH_ASSET_MISSING")
        : failed("SPEECH_ASSET_INVALID");
      return;
    }
    if (abortRequested(signal)) return;
    try {
      this.speechView = await materializeRuntimeAssetView({
        manager: this.assetManager,
        assets: SPEECH_ASSETS,
        baseRoot: this.runtimeViewsRoot,
        ...(signal === undefined ? {} : { signal })
      });

      const sileroPath = requiredViewPath(this.speechView, "speech/silero/silero_vad.onnx");
      const moonshineRoot = path.join(this.speechView.root, "speech", "moonshine");
      const token = randomBytes(32).toString("hex");
      this.runtimeManager.register(this.workerDefinition({
        componentId: SPEECH_COMPONENT_ID,
        component: "speech",
        token,
        modelIdentity: SPEECH_WORKER_MODEL_IDENTITY,
        runtimeVersion: SPEECH_RUNTIME_VERSION,
        capabilities: ["vad", "stt"],
        args: [
          "--component", "speech",
          "--port", "0",
          "--silero-model", sileroPath,
          "--moonshine-model-root", moonshineRoot
        ]
      }));
      this.speechStatus = unavailable("WORKER_STARTING");
      await this.runtimeManager.start(
        SPEECH_COMPONENT_ID,
        signal === undefined ? {} : { signal }
      );
      if (abortRequested(signal)) throw abortError();
      const client = new ManagedModelWorkerClient(
        this.runtimeManager,
        SPEECH_COMPONENT_ID,
        "speech",
        token,
        this.lifecycleAbort.signal
      );
      const vad = new SileroVadBackend(
        new ManagedSileroVadRuntime(client, sileroPath),
        sileroPath
      );
      const recognizer = new MoonshineSpeechRecognizer({
        runtime: new ManagedMoonshineRuntime(client, moonshineRoot),
        modelPath: moonshineRoot,
        modelName: "moonshine-tiny-en",
        modelVersion: moonshineRecognizerVersion()
      });
      this.speechWorker = new SpeechWorkerCore({
        vadBackend: vad,
        recognizer
      });
      this.speechStatus = ready(
        SPEECH_WORKER_MODEL_IDENTITY,
        client.runtimeVersion()
      );
    } catch (error) {
      const cleaned = await this.cleanupCapability("speech");
      this.speechStatus = abortRequested(signal)
        ? unavailable("START_CANCELLED")
        : cleaned
          ? failed(error instanceof ModelAssetError ? "ASSET_FAILURE" : "WORKER_START_FAILED")
          : failed("WORKER_CLEANUP_FAILED");
      throw error;
    }
  }

  private async startTts(signal?: AbortSignal): Promise<void> {
    const readiness = await this.inspectAssets(TTS_ASSETS, signal);
    if (readiness !== "READY") {
      this.ttsStatus = readiness === "MISSING_ASSET"
        ? missingAsset("TTS_ASSET_MISSING")
        : failed("TTS_ASSET_INVALID");
      return;
    }
    if (abortRequested(signal)) return;
    try {
      this.ttsView = await materializeRuntimeAssetView({
        manager: this.assetManager,
        assets: TTS_ASSETS,
        baseRoot: this.runtimeViewsRoot,
        ...(signal === undefined ? {} : { signal })
      });

      const modelPath = requiredViewPath(this.ttsView, "tts/kokoro/model.ort");
      const configPath = requiredViewPath(this.ttsView, "tts/kokoro/config.json");
      const ttsRoot = path.join(this.ttsView.root, "tts");
      const token = randomBytes(32).toString("hex");
      this.runtimeManager.register(this.workerDefinition({
        componentId: TTS_COMPONENT_ID,
        component: "tts",
        token,
        modelIdentity: TTS_WORKER_MODEL_IDENTITY,
        runtimeVersion: TTS_RUNTIME_VERSION,
        capabilities: ["tts"],
        args: [
          "--component", "tts",
          "--port", "0",
          "--tts-asset-root", ttsRoot
        ]
      }));
      this.ttsStatus = unavailable("WORKER_STARTING");
      await this.runtimeManager.start(
        TTS_COMPONENT_ID,
        signal === undefined ? {} : { signal }
      );
      if (abortRequested(signal)) throw abortError();
      const client = new ManagedModelWorkerClient(
        this.runtimeManager,
        TTS_COMPONENT_ID,
        "tts",
        token,
        this.lifecycleAbort.signal
      );
      const synthesizer = await KokoroSpeechSynthesizer.create({
        runtime: new ManagedKokoroRuntime(client, modelPath, configPath),
        modelPath,
        configPath
      });
      if (abortRequested(signal)) throw abortError();
      this.ttsWorker = new TtsWorkerCore(synthesizer);
      this.ttsStatus = ready(
        TTS_WORKER_MODEL_IDENTITY,
        client.runtimeVersion()
      );
    } catch (error) {
      const cleaned = await this.cleanupCapability("tts");
      this.ttsStatus = abortRequested(signal)
        ? unavailable("START_CANCELLED")
        : cleaned
          ? failed(error instanceof ModelAssetError ? "ASSET_FAILURE" : "WORKER_START_FAILED")
          : failed("WORKER_CLEANUP_FAILED");
      throw error;
    }
  }

  private async cleanupCapability(component: "speech" | "tts"): Promise<boolean> {
    const componentId = component === "speech" ? SPEECH_COMPONENT_ID : TTS_COMPONENT_ID;
    const worker = component === "speech" ? this.speechWorker : this.ttsWorker;
    let coreShutdownFailed = false;
    if (worker !== undefined) {
      try {
        await worker.shutdown();
      } catch {
        coreShutdownFailed = true;
      }
    }

    let registered = true;
    try {
      this.runtimeManager.getStatus(componentId);
    } catch (error) {
      if (error instanceof LocalRuntimeError && error.code === "UNKNOWN_COMPONENT") {
        registered = false;
      } else {
        return false;
      }
    }
    if (registered) {
      try {
        await this.runtimeManager.stop(componentId);
      } catch {
        // The worker may still own open model files. Preserve the runtime view
        // until process-tree cleanup is verified rather than deleting beneath it.
        return false;
      }
    }

    if (component === "speech") this.speechWorker = undefined;
    else this.ttsWorker = undefined;

    const view = component === "speech" ? this.speechView : this.ttsView;
    if (view !== undefined) {
      try {
        await view.dispose();
      } catch {
        return false;
      }
    }
    if (component === "speech") this.speechView = undefined;
    else this.ttsView = undefined;
    return !coreShutdownFailed;
  }

  private markPendingCapabilitiesCancelled(): void {
    if (this.speechStatus.reasonCode === "NOT_STARTED") {
      this.speechStatus = unavailable("START_CANCELLED");
    }
    if (this.ttsStatus.reasonCode === "NOT_STARTED") {
      this.ttsStatus = unavailable("START_CANCELLED");
    }
  }

  private async inspectAssets(
    assets: readonly DesktopRuntimeAsset[],
    signal?: AbortSignal
  ): Promise<"READY" | "MISSING_ASSET" | "FAILED"> {
    let missing = false;
    for (const asset of assets) {
      if (abortRequested(signal)) throw abortError();
      const inspection = await this.assetManager.inspect(asset.manifest, signal);
      if (inspection.status === "NOT_PRESENT") {
        missing = true;
        continue;
      }
      if (inspection.status !== "INSTALLED") return "FAILED";
    }
    return missing ? "MISSING_ASSET" : "READY";
  }

  private workerDefinition(input: {
    readonly componentId: string;
    readonly component: "speech" | "tts";
    readonly token: string;
    readonly modelIdentity: string;
    readonly runtimeVersion: string;
    readonly capabilities: readonly string[];
    readonly args: readonly string[];
  }): LocalComponentDefinition {
    return {
      id: input.componentId,
      executable: requiredPythonExecutable(this.pythonExecutable),
      args: ["-I", this.workerScriptPath, ...input.args],
      cwd: path.dirname(this.workerScriptPath),
      environment: {
        values: {
          // The interpreter is already canonical and absolute. Do not pass the
          // user's full PATH into native model workers; retain only the
          // interpreter directory for any runtime-local lookup.
          PATH: path.dirname(requiredPythonExecutable(this.pythonExecutable))
        },
        secrets: {
          INTERVIEW_LOCAL_WORKER_TOKEN: input.token
        }
      },
      startupTimeoutMs: 120_000,
      shutdownTimeoutMs: 5_000,
      terminationTimeoutMs: 5_000,
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => {
          if (!isRecord(message) || message["ready"] !== true) return false;
          const handshake = message["handshake"] as LocalComponentStatus["handshake"];
          return {
            ready: true,
            detail: `${input.component} model worker ready`,
            ...(handshake === undefined ? {} : { handshake })
          };
        }
      },
      expectedHandshake: {
        componentVersion: WORKER_COMPONENT_VERSION,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerType: input.component,
        runtimeVersion: input.runtimeVersion,
        modelVersionOrHash: input.modelIdentity,
        capabilities: input.capabilities
      },
      restartPolicy: {
        mode: "ON_FAILURE",
        maxRetries: 2,
        backoffMs: 250,
        maxBackoffMs: 1_000
      },
      output: {
        maxLines: 200,
        maxBytes: 256 * 1024,
        maxLineBytes: 16 * 1024
      },
      gracefulShutdown: async (control) => {
        await control.writeStdin("shutdown\n");
        control.endStdin();
      }
    };
  }

  private liveStatus(
    componentId: string,
    base: DesktopRuntimeCapabilityStatus
  ): DesktopRuntimeCapabilityStatus {
    if (base.state !== "READY") return base;
    let worker: LocalComponentStatus;
    try {
      worker = this.runtimeManager.getStatus(componentId);
    } catch {
      return failed("WORKER_STATUS_UNAVAILABLE");
    }
    if (worker.state === "READY") {
      const runtimeVersion = worker.handshake?.runtimeVersion;
      return Object.freeze({
        ...base,
        ...(typeof runtimeVersion === "string" ? { runtimeVersion } : {})
      });
    }
    if (worker.state === "FAILED") return failed("WORKER_FAILED", base.modelIdentity);
    if (worker.state === "STARTING") return unavailable("WORKER_RESTARTING", base.modelIdentity);
    return unavailable("WORKER_STOPPED", base.modelIdentity);
  }

  private async workerScriptIsSafe(): Promise<boolean> {
    try {
      const metadata = await lstat(this.workerScriptPath);
      return metadata.isFile() && !metadata.isSymbolicLink();
    } catch {
      return false;
    }
  }
}

function isProductionLocalModelPlatformSupported(
  platform: NodeJS.Platform,
  arch: string
): boolean {
  return arch === "x64" && (platform === "win32" || platform === "linux");
}

async function resolvePythonExecutable(
  candidate: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): Promise<string | undefined> {
  if (
    typeof candidate !== "string"
    || candidate.length === 0
    || candidate.length > 1_024
    || candidate.includes("\0")
  ) {
    return undefined;
  }

  const pathLike = path.isAbsolute(candidate)
    || candidate.includes("/")
    || candidate.includes("\\");
  const candidates: string[] = [];
  if (pathLike) {
    if (!path.isAbsolute(candidate)) return undefined;
    candidates.push(candidate);
  } else {
    const rawPath = environment["PATH"];
    if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
    const names = platform === "win32"
      ? [candidate.toLowerCase().endsWith(".exe") ? candidate : `${candidate}.exe`]
      : [candidate];
    for (const rawEntry of rawPath.split(path.delimiter)) {
      const entry = rawEntry.startsWith('"') && rawEntry.endsWith('"')
        ? rawEntry.slice(1, -1)
        : rawEntry;
      if (entry.length === 0 || !path.isAbsolute(entry)) continue;
      for (const name of names) candidates.push(path.join(entry, name));
    }
  }

  for (const executableCandidate of candidates.slice(0, 256)) {
    try {
      const executable = path.resolve(executableCandidate);
      const launcherMetadata = await lstat(executable);
      const target = launcherMetadata.isSymbolicLink()
        ? await realpath(executable)
        : executable;
      const targetMetadata = await lstat(target);
      if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) continue;
      if (platform !== "win32") {
        await access(executable, fsConstants.X_OK);
      } else if (path.extname(executable).toLowerCase() !== ".exe") {
        continue;
      }
      // Preserve the inspected launcher path rather than replacing it with the
      // symlink target. POSIX virtualenv launchers commonly symlink to the base
      // interpreter; spawning the target would bypass pyvenv.cfg discovery.
      return executable;
    } catch {
      continue;
    }
  }
  return undefined;
}

function requiredPythonExecutable(value: string | undefined): string {
  if (value === undefined) throw new Error("Python runtime was not resolved before worker registration");
  return value;
}

function requiredViewPath(view: RuntimeAssetView, relativePath: string): string {
  const value = view.paths.get(relativePath);
  if (value === undefined) throw new Error("Verified runtime asset view is incomplete");
  return value;
}

function ready(modelIdentity: string, runtimeVersion: string): DesktopRuntimeCapabilityStatus {
  return Object.freeze({
    state: "READY",
    modelIdentity,
    runtimeVersion
  });
}

function missingAsset(reasonCode: string): DesktopRuntimeCapabilityStatus {
  return Object.freeze({ state: "MISSING_ASSET", reasonCode });
}

function failed(reasonCode: string, modelIdentity?: string): DesktopRuntimeCapabilityStatus {
  return Object.freeze({
    state: "FAILED",
    reasonCode,
    ...(modelIdentity === undefined ? {} : { modelIdentity })
  });
}

function unavailable(reasonCode: string, modelIdentity?: string): DesktopRuntimeCapabilityStatus {
  return Object.freeze({
    state: "UNAVAILABLE",
    reasonCode,
    ...(modelIdentity === undefined ? {} : { modelIdentity })
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortError(): Error {
  const error = new Error("Desktop local runtime operation was cancelled");
  error.name = "AbortError";
  return error;
}

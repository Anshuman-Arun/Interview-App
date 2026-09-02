import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  KokoroSpeechSynthesizer,
  MoonshineSpeechRecognizer,
  SileroVadBackend,
  SpeechWorkerCore,
  TtsWorkerCore
} from "../../../../packages/local-compute/src/index.js";
import {
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
const WORKER_COMPONENT_VERSION = "1";
const WORKER_PROTOCOL_VERSION = 1;
const SPEECH_RUNTIME_VERSION = "moonshine-voice/0.1.5;onnxruntime/1.29.0";
const TTS_RUNTIME_VERSION = "moonshine-voice/0.1.5";
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
  private readonly pythonExecutable: string;
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
    this.pythonExecutable = options.pythonExecutable
      ?? (process.platform === "win32" ? "python" : "python3");
  }

  public start(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.stopping || this.stopped) {
      return Promise.reject(new Error("Desktop local runtime cannot start after shutdown"));
    }
    if (this.startPromise !== undefined) return this.startPromise;
    const operation = this.startOptionalCapabilities(options.signal);
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
    for (const asset of DESKTOP_LOCAL_MODEL_ASSETS) {
      if (signal?.aborted === true) throw abortError();
      await this.assetManager.install(asset.manifest, signal);
    }
  }

  public async stopWorkers(): Promise<void> {
    if (this.stopped) return;
    this.stopping = true;
    const failures: unknown[] = [];
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
      for (const view of [this.ttsView, this.speechView]) {
        if (view === undefined) continue;
        try {
          await view.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      this.ttsView = undefined;
      this.speechView = undefined;
    }

    this.voiceRuntime = undefined;
    this.stopped = processTreesStopped;
    this.stopping = !processTreesStopped;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Desktop local model runtime shutdown failed");
    }
  }

  private async startOptionalCapabilities(signal?: AbortSignal): Promise<void> {
    try {
      await this.assetManager.cleanupTemporary();
      await cleanupStaleRuntimeAssetViews(this.runtimeViewsRoot);
    } catch {
      this.speechStatus = failed("ASSET_CACHE_UNSAFE");
      this.ttsStatus = failed("ASSET_CACHE_UNSAFE");
      return;
    }
    if (signal?.aborted === true) return;

    const workerAvailable = await this.workerScriptIsSafe();
    if (!workerAvailable) {
      this.speechStatus = unavailable("WORKER_EXECUTABLE_UNAVAILABLE");
      this.ttsStatus = unavailable("WORKER_EXECUTABLE_UNAVAILABLE");
      return;
    }

    const [speechResult, ttsResult] = await Promise.allSettled([
      this.startSpeech(signal),
      this.startTts(signal)
    ]);
    if (speechResult.status === "rejected" && this.speechStatus.state === "UNAVAILABLE") {
      this.speechStatus = failed("WORKER_START_FAILED");
    }
    if (ttsResult.status === "rejected" && this.ttsStatus.state === "UNAVAILABLE") {
      this.ttsStatus = failed("WORKER_START_FAILED");
    }
    if (this.speechWorker !== undefined
        && this.ttsWorker !== undefined
        && this.liveStatus(SPEECH_COMPONENT_ID, this.speechStatus).state === "READY"
        && this.liveStatus(TTS_COMPONENT_ID, this.ttsStatus).state === "READY") {
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
    }
  }

  private async startSpeech(signal?: AbortSignal): Promise<void> {
    const readiness = await this.inspectAssets(SPEECH_ASSETS);
    if (readiness !== "READY") {
      this.speechStatus = readiness === "MISSING_ASSET"
        ? missingAsset("SPEECH_ASSET_MISSING")
        : failed("SPEECH_ASSET_INVALID");
      return;
    }
    if (signal?.aborted === true) return;
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
    try {
      await this.runtimeManager.start(
        SPEECH_COMPONENT_ID,
        signal === undefined ? {} : { signal }
      );
      const client = new ManagedModelWorkerClient(
        this.runtimeManager,
        SPEECH_COMPONENT_ID,
        "speech",
        token
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
      await this.runtimeManager.stop(SPEECH_COMPONENT_ID).catch(() => undefined);
      this.speechStatus = signal?.aborted === true
        ? unavailable("START_CANCELLED")
        : failed(error instanceof ModelAssetError ? "ASSET_FAILURE" : "WORKER_START_FAILED");
      throw error;
    }
  }

  private async startTts(signal?: AbortSignal): Promise<void> {
    const readiness = await this.inspectAssets(TTS_ASSETS);
    if (readiness !== "READY") {
      this.ttsStatus = readiness === "MISSING_ASSET"
        ? missingAsset("TTS_ASSET_MISSING")
        : failed("TTS_ASSET_INVALID");
      return;
    }
    if (signal?.aborted === true) return;
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
    try {
      await this.runtimeManager.start(
        TTS_COMPONENT_ID,
        signal === undefined ? {} : { signal }
      );
      const client = new ManagedModelWorkerClient(
        this.runtimeManager,
        TTS_COMPONENT_ID,
        "tts",
        token
      );
      const synthesizer = await KokoroSpeechSynthesizer.create({
        runtime: new ManagedKokoroRuntime(client, modelPath, configPath),
        modelPath,
        configPath
      });
      this.ttsWorker = new TtsWorkerCore(synthesizer);
      this.ttsStatus = ready(
        TTS_WORKER_MODEL_IDENTITY,
        client.runtimeVersion()
      );
    } catch (error) {
      await this.runtimeManager.stop(TTS_COMPONENT_ID).catch(() => undefined);
      this.ttsStatus = signal?.aborted === true
        ? unavailable("START_CANCELLED")
        : failed(error instanceof ModelAssetError ? "ASSET_FAILURE" : "WORKER_START_FAILED");
      throw error;
    }
  }

  private async inspectAssets(
    assets: readonly DesktopRuntimeAsset[]
  ): Promise<"READY" | "MISSING_ASSET" | "FAILED"> {
    let missing = false;
    for (const asset of assets) {
      const inspection = await this.assetManager.inspect(asset.manifest);
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
      executable: this.pythonExecutable,
      args: [this.workerScriptPath, ...input.args],
      cwd: path.dirname(this.workerScriptPath),
      environment: {
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
          return {
            ready: true,
            detail: `${input.component} model worker ready`,
            handshake: message["handshake"] as LocalComponentStatus["handshake"]
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
      const runtimeVersion = worker.handshake?.metadata?.["runtimeVersion"];
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

function abortError(): Error {
  const error = new Error("Desktop local runtime operation was cancelled");
  error.name = "AbortError";
  return error;
}

import {
  TTS_LIMITS,
  type KokoroRuntime,
  type KokoroRuntimeSession,
  type KokoroRuntimeSynthesisResult,
  type MoonshineRuntime,
  type SileroVadRuntime
} from "../../../../packages/local-compute/src/index.js";
import type { ManagedModelWorkerClient } from "./managed-worker-client.js";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MOONSHINE_RECOGNIZER_VERSION = "tiny-en-35d84fc0eb2d7451";
const KOKORO_MODEL_VERSION = "af-heart-35d84fc0eb2d7451";
const MAX_TRACKED_VAD_STREAMS = 128;

export class ManagedSileroVadRuntime implements SileroVadRuntime {
  public readonly runtimeVersion: string;
  private readonly streamWorkerInstances = new Map<string, string>();

  public constructor(
    private readonly client: ManagedModelWorkerClient,
    private readonly expectedModelPath: string
  ) {
    this.runtimeVersion = client.runtimeVersion();
  }

  public async score(input: Parameters<SileroVadRuntime["score"]>[0]): Promise<unknown> {
    if (input.modelPath !== this.expectedModelPath) {
      throw new Error("Silero runtime rejected an unexpected model path");
    }
    const workerInstance = this.client.workerInstanceIdentity();
    const previousWorkerInstance = this.streamWorkerInstances.get(input.streamId);
    if (previousWorkerInstance !== undefined && previousWorkerInstance !== workerInstance) {
      this.streamWorkerInstances.delete(input.streamId);
      throw new Error("Silero worker restarted during an active VAD stream");
    }
    this.streamWorkerInstances.delete(input.streamId);
    this.streamWorkerInstances.set(input.streamId, workerInstance);
    while (this.streamWorkerInstances.size > MAX_TRACKED_VAD_STREAMS) {
      const oldest = this.streamWorkerInstances.keys().next().value;
      if (oldest === undefined) break;
      this.streamWorkerInstances.delete(oldest);
    }
    const result = await this.client.postJson("/v1/vad", {
      pcmF32Base64: Buffer.from(input.pcmBytes).toString("base64"),
      sampleRate: input.sampleRate,
      streamId: input.streamId
    }, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: 5_000,
      maxResponseBytes: 1_024
    });
    if (!isRecord(result) || Object.keys(result).length !== 1) {
      throw new Error("Silero worker returned invalid output");
    }
    return result["speechProbability"];
  }
}

export class ManagedMoonshineRuntime implements MoonshineRuntime {
  public readonly runtimeVersion: string;
  public readonly supportsAbort = false;

  public constructor(
    private readonly client: ManagedModelWorkerClient,
    private readonly expectedModelPath: string
  ) {
    this.runtimeVersion = client.runtimeVersion();
  }

  public async transcribe(input: Parameters<MoonshineRuntime["transcribe"]>[0]): Promise<unknown> {
    if (input.modelPath !== this.expectedModelPath || input.configPath !== undefined) {
      throw new Error("Moonshine runtime rejected unexpected model configuration");
    }
    return this.client.postJson("/v1/stt", {
      requestId: input.requestId,
      utteranceId: input.utteranceId,
      pcmF32Base64: Buffer.from(input.pcmBytes).toString("base64"),
      sampleRate: input.sampleRate
    }, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: 60_000,
      maxResponseBytes: 2 * 1024 * 1024
    });
  }
}

export class ManagedKokoroRuntime implements KokoroRuntime {
  public constructor(
    private readonly client: ManagedModelWorkerClient,
    private readonly expectedModelPath: string,
    private readonly expectedConfigPath: string
  ) {}

  public async initialize(options: {
    readonly modelPath: string;
    readonly configPath?: string;
  }): Promise<KokoroRuntimeSession> {
    if (options.modelPath !== this.expectedModelPath
        || options.configPath !== this.expectedConfigPath) {
      throw new Error("Kokoro runtime rejected unexpected model configuration");
    }
    const runtimeVersion = this.client.runtimeVersion();
    let synthesisTail: Promise<void> = Promise.resolve();
    let synthesisReservations = 0;

    const synthesizeSerialized = (
      input: Parameters<KokoroRuntimeSession["synthesize"]>[0]
    ): Promise<KokoroRuntimeSynthesisResult> => {
      if (synthesisReservations >= TTS_LIMITS.maxConcurrentRequests) {
        return Promise.reject(new Error("Kokoro runtime synthesis queue is full"));
      }
      synthesisReservations += 1;
      const operation = synthesisTail.then(async () => {
        const result = await this.client.postJson("/v1/tts", {
          requestId: input.requestId,
          text: input.text,
          voice: input.voice,
          speed: input.speed,
          language: input.language,
          sampleRate: input.sampleRate
        }, {
          timeoutMs: 60_000,
          maxResponseBytes: Math.min(
            16 * 1024 * 1024,
            Math.ceil(TTS_LIMITS.maxPcmBytes / 3) * 4 + 16_384
          )
        });
        return parseTtsResult(result);
      });
      synthesisTail = operation.then(
        () => undefined,
        () => undefined
      );
      return operation.finally(() => {
        synthesisReservations = Math.max(0, synthesisReservations - 1);
      });
    };

    return Object.freeze({
      modelId: "kokoro-af-heart",
      modelVersion: KOKORO_MODEL_VERSION,
      runtimeVersion,
      supportedVoices: Object.freeze(["kokoro_af_heart"]),
      supportedLanguages: Object.freeze(["en-US"] as const),
      supportedSampleRates: Object.freeze([24_000] as const),
      synthesize: synthesizeSerialized,
      cancel: async (
        requestId: Parameters<NonNullable<KokoroRuntimeSession["cancel"]>>[0]
      ): Promise<void> => {
        const result = await this.client.postJson("/v1/tts/cancel", {
          requestId
        }, {
          timeoutMs: TTS_LIMITS.maxRuntimeCancellationWaitMs,
          maxResponseBytes: 1_024
        });
        if (!isRecord(result)
            || Object.keys(result).length !== 1
            || result["accepted"] !== true) {
          throw new Error("Kokoro worker did not accept runtime cancellation");
        }
      }
    });
  }
}

export function moonshineRecognizerVersion(): string {
  return MOONSHINE_RECOGNIZER_VERSION;
}

function parseTtsResult(value: unknown): KokoroRuntimeSynthesisResult {
  if (!isRecord(value)
      || Object.keys(value).some((key) => !["pcmF32Base64", "sampleRate", "channels", "durationMs"].includes(key))) {
    throw new Error("Kokoro worker returned invalid output");
  }
  const encoded = value["pcmF32Base64"];
  const sampleRate = value["sampleRate"];
  const channels = value["channels"];
  const durationMs = value["durationMs"];
  if (typeof encoded !== "string"
      || encoded.length === 0
      || encoded.length > Math.ceil(TTS_LIMITS.maxPcmBytes / 3) * 4 + 8
      || !BASE64_PATTERN.test(encoded)
      || sampleRate !== 24_000
      || channels !== 1
      || typeof durationMs !== "number"
      || !Number.isFinite(durationMs)
      || durationMs <= 0) {
    throw new Error("Kokoro worker returned invalid bounded PCM metadata");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0
      || bytes.byteLength > TTS_LIMITS.maxPcmBytes
      || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Kokoro worker returned invalid bounded PCM");
  }
  const samples = new Float32Array(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return {
    samples,
    sampleRate,
    channels,
    durationMs
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

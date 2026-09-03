import {
  MAX_SPEECH_CONCURRENT_STREAMS,
  MAX_SPEECH_TRANSCRIPT_CHARS,
  MAX_SPEECH_WORD_TIMINGS,
  SPEECH_RECOGNIZER_TIMEOUT_ABORT_REASON,
  SPEECH_VAD_TIMEOUT_ABORT_REASON,
  TTS_LIMITS,
  type KokoroRuntime,
  type KokoroRuntimeSession,
  type KokoroRuntimeSynthesisResult,
  type MoonshineRuntime,
  type SileroVadRuntime
} from "../../../../packages/local-compute/src/index.js";
import {
  ManagedWorkerRequestTimeoutError,
  ManagedWorkerResponseError,
  ManagedWorkerTransportError,
  type ManagedModelWorkerClient,
  type ManagedWorkerRecoveryScope
} from "./managed-worker-client.js";

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
    let result: unknown;
    try {
      result = await runWithWorkerRecycleOnTimeout(this.client, "vad", () =>
        this.client.postJson("/v1/vad", {
          pcmF32Base64: Buffer.from(input.pcmBytes).toString("base64"),
          sampleRate: input.sampleRate,
          streamId: input.streamId
        }, {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          timeoutMs: 5_000,
          maxResponseBytes: 1_024
        })
      );
    } catch (error) {
      const timedOutInSpeechCore =
        input.signal?.aborted === true
        && input.signal.reason === SPEECH_VAD_TIMEOUT_ABORT_REASON;
      if (!timedOutInSpeechCore) throw error;
      try {
        await this.client.recycleAfterUncertainRequest(workerInstance, "vad");
      } catch (recycleError) {
        throw new AggregateError(
          [error, recycleError],
          "Silero VAD timed out and its worker could not be safely recycled",
          { cause: recycleError }
        );
      }
      throw error;
    }
    const probability = isRecord(result)
      && Object.keys(result).length === 1
      ? result["speechProbability"]
      : undefined;
    if (
      typeof probability !== "number"
      || !Number.isFinite(probability)
      || probability < 0
      || probability > 1
    ) {
      const protocolError = new Error("Silero worker returned invalid bounded output");
      await recycleAfterProtocolFailure(
        this.client,
        "vad",
        workerInstance,
        protocolError,
        "Silero VAD protocol output was invalid"
      );
      throw protocolError;
    }
    this.client.markHealthy("vad");
    return probability;
  }
}

export class ManagedMoonshineRuntime implements MoonshineRuntime {
  public readonly runtimeVersion: string;
  public readonly supportsAbort = false;
  public readonly observesPreStartAbort = true;
  private transcriptionTail: Promise<void> = Promise.resolve();
  private transcriptionReservations = 0;
  private readonly activeRequestIds = new Set<string>();

  public constructor(
    private readonly client: ManagedModelWorkerClient,
    private readonly expectedModelPath: string
  ) {
    this.runtimeVersion = client.runtimeVersion();
  }

  public transcribe(input: Parameters<MoonshineRuntime["transcribe"]>[0]): Promise<unknown> {
    if (input.modelPath !== this.expectedModelPath || input.configPath !== undefined) {
      return Promise.reject(new Error("Moonshine runtime rejected unexpected model configuration"));
    }
    if (this.transcriptionReservations >= MAX_SPEECH_CONCURRENT_STREAMS) {
      return Promise.reject(new Error("Moonshine runtime transcription queue is full"));
    }
    if (this.activeRequestIds.has(input.requestId)) {
      return Promise.reject(new Error("Moonshine runtime request ID is already queued"));
    }

    this.transcriptionReservations += 1;
    this.activeRequestIds.add(input.requestId);

    let nativeLaneEntered = false;
    let removeQueuedAbortListener: (() => void) | undefined;
    const signal = input.signal;
    const queuedAbort = signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          const listener = (): void => {
            if (!nativeLaneEntered) reject(abortError());
          };
          removeQueuedAbortListener = () => {
            signal.removeEventListener("abort", listener);
          };
          signal.addEventListener("abort", listener, { once: true });
          if (signal.aborted) listener();
        });

    const scheduled = this.transcriptionTail.then(async () => {
      if (abortRequested(signal)) throw abortError();
      nativeLaneEntered = true;
      removeQueuedAbortListener?.();
      removeQueuedAbortListener = undefined;

      const workerInstance = this.client.workerInstanceIdentity();
      const timeoutRecovery: { promise?: Promise<void> } = {};
      const onAbort = (): void => {
        if (signal?.reason !== SPEECH_RECOGNIZER_TIMEOUT_ABORT_REASON) return;
        timeoutRecovery.promise ??=
          this.client.recycleAfterUncertainRequest(workerInstance, "stt");
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      if (abortRequested(signal)) onAbort();

      let outcome:
        | { readonly ok: true; readonly value: unknown }
        | { readonly ok: false; readonly error: unknown };
      try {
        // Once this request reaches the single native lane, do not wire the
        // application AbortSignal into fetch. Moonshine batch STT is not
        // preemptible in-process. A recognizer timeout instead recycles the
        // exact worker process, while normal stream cancellation only suppresses
        // the late result.
        try {
          const rawResult = await runWithWorkerRecycleOnTimeout(this.client, "stt", () =>
            this.client.postJson("/v1/stt", {
              requestId: input.requestId,
              utteranceId: input.utteranceId,
              pcmF32Base64: Buffer.from(input.pcmBytes).toString("base64"),
              sampleRate: input.sampleRate
            }, {
              timeoutMs: 60_000,
              maxResponseBytes: 2 * 1024 * 1024
            })
          );
          let validatedResult: unknown;
          try {
            validatedResult = validateMoonshineWorkerResult(rawResult);
          } catch (protocolError) {
            await recycleAfterProtocolFailure(
              this.client,
              "stt",
              workerInstance,
              protocolError,
              "Moonshine STT protocol output was invalid"
            );
            throw protocolError;
          }
          outcome = {
            ok: true,
            value: validatedResult
          };
        } catch (error) {
          outcome = { ok: false, error };
        }

        const recovery = timeoutRecovery.promise;
        if (recovery !== undefined) {
          try {
            await recovery;
          } catch (recycleError) {
            throw new AggregateError(
              outcome.ok
                ? [recycleError]
                : [outcome.error, recycleError],
              "Moonshine recognition timed out and its worker could not be safely recycled",
              { cause: recycleError }
            );
          }
        }
        if (!outcome.ok) throw outcome.error;
        if (recovery === undefined) this.client.markHealthy("stt");
        return outcome.value;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    });
    this.transcriptionTail = scheduled.then(
      () => undefined,
      () => undefined
    );
    const releaseReservation = (): void => {
      removeQueuedAbortListener?.();
      removeQueuedAbortListener = undefined;
      this.activeRequestIds.delete(input.requestId);
      this.transcriptionReservations = Math.max(0, this.transcriptionReservations - 1);
    };
    void scheduled.then(releaseReservation, releaseReservation);

    return queuedAbort === undefined
      ? scheduled
      : Promise.race([scheduled, queuedAbort]);
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
    const synthesisStates = new Map<string, {
      started: boolean;
      cancelled: boolean;
    }>();

    const synthesizeSerialized = (
      input: Parameters<KokoroRuntimeSession["synthesize"]>[0]
    ): Promise<KokoroRuntimeSynthesisResult> => {
      if (synthesisReservations >= TTS_LIMITS.maxConcurrentRequests) {
        return Promise.reject(new Error("Kokoro runtime synthesis queue is full"));
      }
      if (synthesisStates.has(input.requestId)) {
        return Promise.reject(new Error("Kokoro runtime request ID is already queued"));
      }
      const state = { started: false, cancelled: false };
      synthesisStates.set(input.requestId, state);
      synthesisReservations += 1;
      const operation = synthesisTail.then(async () => {
        if (state.cancelled) throw abortError();
        // Set this synchronously before the first await. A cancellation that
        // observes started=true must use the worker's request tombstone/native
        // cancellation path; one that observes false never reaches the worker.
        state.started = true;
        const result = await runWithWorkerRecycleOnTimeout(this.client, "tts", () =>
          this.client.postJson("/v1/tts", {
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
          })
        );
        return parseTtsResult(result);
      });
      synthesisTail = operation.then(
        () => undefined,
        () => undefined
      );
      return operation.finally(() => {
        synthesisStates.delete(input.requestId);
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
        const state = synthesisStates.get(requestId);
        if (state !== undefined && !state.started) {
          state.cancelled = true;
          return;
        }
        const result = await runWithWorkerRecycleOnTimeout(this.client, "tts-cancel", () =>
          this.client.postJson("/v1/tts/cancel", {
            requestId
          }, {
            timeoutMs: TTS_LIMITS.maxRuntimeCancellationWaitMs,
            maxResponseBytes: 1_024
          })
        );
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


async function runWithWorkerRecycleOnTimeout<T>(
  client: ManagedModelWorkerClient,
  scope: "vad" | "stt" | "tts" | "tts-cancel",
  operation: () => Promise<T>
): Promise<T> {
  const workerInstance = client.workerInstanceIdentity();
  try {
    return await operation();
  } catch (error) {
    const uncertainNativeState =
      error instanceof ManagedWorkerRequestTimeoutError
      || error instanceof ManagedWorkerTransportError
      || (error instanceof ManagedWorkerResponseError && error.statusCode >= 500);
    if (!uncertainNativeState) throw error;
    try {
      await client.recycleAfterUncertainRequest(workerInstance, scope);
    } catch (recycleError) {
      throw new AggregateError(
        [error, recycleError],
        "Managed local model worker failed and could not be safely recycled",
        { cause: recycleError }
      );
    }
    throw error;
  }
}

function abortError(): Error {
  const error = new Error("Managed local model operation was cancelled before native inference");
  error.name = "AbortError";
  return error;
}


function abortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

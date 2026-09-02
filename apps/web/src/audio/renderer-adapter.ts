import type { DeliveryId } from "../../../../packages/domain/src/index.js";
import { TTS_LIMITS } from "../../../../packages/local-compute/src/index.js";
import {
  RendererPresentationNotExposedError,
  type AudioPlayer
} from "../renderer-client.js";
import type { BrowserAudioPlayback } from "./playback.js";
import { AudioInfrastructureError } from "./types.js";

const AUDIO_SOURCE_RESOLUTION_TIMEOUT_MS = 5_000;
const AUDIO_PLAYBACK_START_TIMEOUT_MS = 5_000;
const AUDIO_PLAYBACK_COMPLETION_TIMEOUT_MS = TTS_LIMITS.maxOutputDurationMs + 10_000;
const MAX_PENDING_AUDIO_RESOLUTIONS = 32;

export interface ResolvedAudioSource {
  readonly source: string;
  readonly release?: () => void;
}

export interface QueuedRendererAudioPlayerOptions {
  readonly resolveAudioSource?: (
    audioRef: string,
    deliveryId: DeliveryId,
    signal: AbortSignal
  ) => ResolvedAudioSource | Promise<ResolvedAudioSource>;
  readonly onSpeakingChanged?: (speaking: boolean) => void;
  readonly outputDeviceId?: string;
}

/**
 * Adapts the hardened physical browser queue to renderer acknowledgement
 * callbacks. Logical audio references may be resolved into short-lived Blob
 * URLs immediately before playback; ownership of those URLs stays here until
 * the concrete playback settles.
 */
export class QueuedRendererAudioPlayer implements AudioPlayer {
  private readonly pendingResolutions = new Map<DeliveryId, AbortController>();
  private readonly resolveAudioSource: QueuedRendererAudioPlayerOptions["resolveAudioSource"];
  private readonly onSpeakingChanged: QueuedRendererAudioPlayerOptions["onSpeakingChanged"];
  private resolutionEpoch = 0;
  private disposed = false;
  private outputDeviceId: string | undefined;

  public constructor(
    private readonly playback: BrowserAudioPlayback,
    options: QueuedRendererAudioPlayerOptions = {}
  ) {
    const rawOptions: unknown = options;
    if (typeof rawOptions !== "object" || rawOptions === null) {
      throw new AudioInfrastructureError("INVALID_REQUEST", "Audio renderer options are invalid");
    }
    let resolver: unknown;
    let speakingObserver: unknown;
    let outputDeviceId: unknown;
    try {
      resolver = Reflect.get(rawOptions, "resolveAudioSource");
      speakingObserver = Reflect.get(rawOptions, "onSpeakingChanged");
      outputDeviceId = Reflect.get(rawOptions, "outputDeviceId");
    } catch {
      throw new AudioInfrastructureError("INVALID_REQUEST", "Audio renderer options could not be inspected");
    }
    if (resolver !== undefined && typeof resolver !== "function") {
      throw new AudioInfrastructureError("INVALID_REQUEST", "Audio source resolver is not callable");
    }
    if (speakingObserver !== undefined && typeof speakingObserver !== "function") {
      throw new AudioInfrastructureError("INVALID_REQUEST", "Speaking observer is not callable");
    }
    this.resolveAudioSource = resolver as QueuedRendererAudioPlayerOptions["resolveAudioSource"];
    this.onSpeakingChanged = speakingObserver as QueuedRendererAudioPlayerOptions["onSpeakingChanged"];
    if (outputDeviceId !== undefined && typeof outputDeviceId !== "string") {
      throw new AudioInfrastructureError("INVALID_REQUEST", "Audio output device identifier is invalid");
    }
    this.outputDeviceId = normalizeOutputDeviceId(outputDeviceId);
  }

  public async playAudio(input: {
    readonly deliveryId: DeliveryId;
    readonly audioRef: string;
    readonly text: string;
    readonly callbacks: {
      readonly onStarted: () => void | Promise<void>;
      readonly onCompleted: () => void | Promise<void>;
    };
  }): Promise<void> {
    if (this.isDisposed()) {
      throw new RendererPresentationNotExposedError(
        "Audio playback adapter is disposed"
      );
    }

    const epoch = this.resolutionEpoch;
    const prior = this.pendingResolutions.get(input.deliveryId);
    if (prior !== undefined) {
      throw new RendererPresentationNotExposedError(
        "Audio delivery is already resolving"
      );
    }
    if (this.pendingResolutions.size >= MAX_PENDING_AUDIO_RESOLUTIONS) {
      throw new RendererPresentationNotExposedError(
        "Audio source resolution concurrency limit reached"
      );
    }
    const controller = new AbortController();
    this.pendingResolutions.set(input.deliveryId, controller);

    let resolved: ResolvedAudioSource | undefined;
    let releaseResolved: (() => void) | undefined;
    try {
      const resolver = this.resolveAudioSource;
      if (resolver === undefined) {
        resolved = { source: input.audioRef };
      } else {
        const resolutionPromise = Promise.resolve(
          resolver(input.audioRef, input.deliveryId, controller.signal)
        );
        try {
          resolved = await waitForAudioResolution(
            resolutionPromise,
            controller,
            AUDIO_SOURCE_RESOLUTION_TIMEOUT_MS
          );
        } catch (error) {
          // A cancellation-ignoring resolver may still produce an owned Blob
          // URL later. Do not await it, but reclaim any late resource it hands
          // back after this delivery has already lost admission.
          void resolutionPromise.then(
            (lateResolved) => releaseLateResolvedSource(lateResolved),
            () => undefined
          );
          throw error;
        }
      }
      try {
        validateResolvedSource(resolved);
      } catch (error) {
        releaseLateResolvedSource(resolved);
        throw error;
      }
      releaseResolved = createReleaseOnce(resolved);

      if (
        controller.signal.aborted
        || this.isDisposed()
        || epoch !== this.resolutionEpoch
        || this.pendingResolutions.get(input.deliveryId) !== controller
      ) {
        releaseResolved();
        throw new RendererPresentationNotExposedError(
          "Audio delivery was cancelled before physical playback admission"
        );
      }

      let handle;
      try {
        handle = this.playback.enqueue({
          id: input.deliveryId,
          source: resolved.source,
          ...(this.outputDeviceId === undefined
            ? {}
            : { outputDeviceId: this.outputDeviceId }),
          callbacks: {
            onStarted: async () => {
              this.notifySpeaking(true);
              await input.callbacks.onStarted();
            },
            onCompleted: async () => {
              this.notifySpeaking(false);
              await input.callbacks.onCompleted();
            }
          }
        });
      } catch (error) {
        releaseResolved();
        if (isDefinitelyNotEnqueued(error)) {
          throw new RendererPresentationNotExposedError(
            "Audio playback was rejected before queue admission",
            { cause: error }
          );
        }
        throw error;
      } finally {
        if (this.pendingResolutions.get(input.deliveryId) === controller) {
          this.pendingResolutions.delete(input.deliveryId);
        }
      }

      const releaseOwnedSource = releaseResolved;
      void handle.result.then(
        () => {
          this.notifySpeaking(false);
          releaseOwnedSource();
        },
        () => {
          this.notifySpeaking(false);
          releaseOwnedSource();
        }
      );

      const startOutcome = await waitForPlaybackStart(
        handle.started,
        AUDIO_PLAYBACK_START_TIMEOUT_MS
      );
      if (startOutcome === "STARTED") {
        void enforcePlaybackCompletionDeadline(
          handle.result,
          handle.cancel,
          AUDIO_PLAYBACK_COMPLETION_TIMEOUT_MS
        );
        return;
      }
      if (startOutcome === "TIMED_OUT") {
        handle.cancel();
        throw new RendererPresentationNotExposedError(
          "Audio playback did not begin within the bounded start deadline"
        );
      }

      const outcome = await handle.result;
      throw new RendererPresentationNotExposedError(
        `Audio playback did not start (${outcome.status})`,
        outcome.error === undefined ? undefined : { cause: outcome.error }
      );
    } catch (error) {
      if (this.pendingResolutions.get(input.deliveryId) === controller) {
        this.pendingResolutions.delete(input.deliveryId);
      }
      if (resolved !== undefined && controller.signal.aborted) {
        releaseResolved?.();
      }
      if (error instanceof RendererPresentationNotExposedError) throw error;
      if (error instanceof AudioInfrastructureError) throw error;
      if (controller.signal.aborted) {
        throw new RendererPresentationNotExposedError(
          "Audio delivery was cancelled before physical playback started",
          { cause: error }
        );
      }
      throw new RendererPresentationNotExposedError(
        "Audio source could not be resolved for physical playback",
        { cause: error }
      );
    }
  }

  public setOutputDeviceId(deviceId: string | undefined): void {
    this.outputDeviceId = normalizeOutputDeviceId(deviceId);
  }

  public cancelDelivery(deliveryId: DeliveryId): void {
    this.pendingResolutions.get(deliveryId)?.abort();
    this.pendingResolutions.delete(deliveryId);
    this.playback.cancel(deliveryId);
  }

  public interruptCurrent(): void {
    this.playback.interruptCurrent();
    this.notifySpeaking(false);
  }

  public clearQueued(): void {
    this.resolutionEpoch += 1;
    this.abortPendingResolutions();
    this.playback.clearQueued();
  }

  public cancelAll(): void {
    this.resolutionEpoch += 1;
    this.abortPendingResolutions();
    this.playback.cancelAll();
    this.notifySpeaking(false);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.playback.dispose();
  }

  private notifySpeaking(speaking: boolean): void {
    const observer = this.onSpeakingChanged;
    if (observer === undefined) return;
    try {
      observer(speaking);
    } catch {
      // UI status is observational only. It must never change physical
      // exposure/completion acknowledgement semantics.
    }
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  private abortPendingResolutions(): void {
    for (const controller of this.pendingResolutions.values()) {
      controller.abort();
    }
    this.pendingResolutions.clear();
  }
}

async function waitForAudioResolution(
  resolution: Promise<ResolvedAudioSource>,
  controller: AbortController,
  timeoutMs: number
): Promise<ResolvedAudioSource> {
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new RendererPresentationNotExposedError(
        timedOut
          ? "Audio source resolution timed out before physical playback"
          : "Audio source resolution was cancelled before physical playback"
      ));
    };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new RendererPresentationNotExposedError(
        "Audio source resolution timed out before physical playback"
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([resolution, aborted, timeout]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
    if (onAbort !== undefined) controller.signal.removeEventListener("abort", onAbort);
  }
}

function releaseLateResolvedSource(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  try {
    const release = Reflect.get(value, "release") as unknown;
    if (typeof release === "function") Reflect.apply(release, value, []);
  } catch {
    // Late resource cleanup is best-effort; admission was already revoked.
  }
}

async function waitForPlaybackStart(
  started: Promise<boolean>,
  timeoutMs: number
): Promise<"STARTED" | "SETTLED_WITHOUT_START" | "TIMED_OUT"> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"TIMED_OUT">((resolve) => {
    timeoutId = globalThis.setTimeout(() => resolve("TIMED_OUT"), timeoutMs);
  });
  try {
    return await Promise.race([
      started.then((value) => value ? "STARTED" as const : "SETTLED_WITHOUT_START" as const),
      timeout
    ]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

async function enforcePlaybackCompletionDeadline(
  result: Promise<unknown>,
  cancel: () => void,
  timeoutMs: number
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"TIMED_OUT">((resolve) => {
    timeoutId = globalThis.setTimeout(() => resolve("TIMED_OUT"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      result.then(() => "SETTLED" as const, () => "SETTLED" as const),
      timeout
    ]);
    if (outcome === "TIMED_OUT") cancel();
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

function validateResolvedSource(value: unknown): asserts value is ResolvedAudioSource {
  if (typeof value !== "object" || value === null) {
    throw new Error("Resolved audio source is invalid");
  }
  const record = value as Record<string, unknown>;
  const source = record["source"];
  const release = record["release"];
  if (
    typeof source !== "string"
    || source.length === 0
    || source.length > 16_384
    || (release !== undefined && typeof release !== "function")
  ) {
    throw new Error("Resolved audio source is invalid");
  }
}

function normalizeOutputDeviceId(deviceId: string | undefined): string | undefined {
  if (deviceId === undefined || deviceId === "" || deviceId === "default") return undefined;
  if (
    typeof deviceId !== "string"
    || deviceId.length > 512
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(deviceId)
  ) {
    throw new AudioInfrastructureError(
      "INVALID_REQUEST",
      "Audio output device identifier is invalid"
    );
  }
  return deviceId;
}

function createReleaseOnce(resolved: ResolvedAudioSource): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      resolved.release?.();
    } catch {
      // Object URL/resource release is best-effort and must not rewrite physical
      // exposure acknowledgement state.
    }
  };
}

function isDefinitelyNotEnqueued(error: unknown): boolean {
  return error instanceof AudioInfrastructureError
    && (
      error.code === "INVALID_REQUEST"
      || error.code === "QUEUE_FULL"
      || error.code === "DISPOSED"
    );
}

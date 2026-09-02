import type { DeliveryId } from "../../../../packages/domain/src/index.js";
import {
  RendererPresentationNotExposedError,
  type AudioPlayer
} from "../renderer-client.js";
import type { BrowserAudioPlayback } from "./playback.js";
import { AudioInfrastructureError } from "./types.js";

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
  private resolutionEpoch = 0;
  private disposed = false;
  private outputDeviceId: string | undefined;

  public constructor(
    private readonly playback: BrowserAudioPlayback,
    private readonly options: QueuedRendererAudioPlayerOptions = {}
  ) {
    this.outputDeviceId = normalizeOutputDeviceId(options.outputDeviceId);
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
    const controller = new AbortController();
    const prior = this.pendingResolutions.get(input.deliveryId);
    if (prior !== undefined) {
      throw new RendererPresentationNotExposedError(
        "Audio delivery is already resolving"
      );
    }
    this.pendingResolutions.set(input.deliveryId, controller);

    let resolved: ResolvedAudioSource | undefined;
    let releaseResolved: (() => void) | undefined;
    try {
      const resolver = this.options.resolveAudioSource;
      resolved = resolver === undefined
        ? { source: input.audioRef }
        : await resolver(input.audioRef, input.deliveryId, controller.signal);
      validateResolvedSource(resolved);
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
              this.options.onSpeakingChanged?.(true);
              await input.callbacks.onStarted();
            },
            onCompleted: async () => {
              this.options.onSpeakingChanged?.(false);
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
          this.options.onSpeakingChanged?.(false);
          releaseOwnedSource();
        },
        () => {
          this.options.onSpeakingChanged?.(false);
          releaseOwnedSource();
        }
      );

      const started = await handle.started;
      if (started) return;

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
    this.options.onSpeakingChanged?.(false);
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
    this.options.onSpeakingChanged?.(false);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    this.playback.dispose();
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

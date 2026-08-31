import {
  RendererPresentationNotExposedError,
  type AudioPlayer
} from "../renderer-client.js";
import { AudioInfrastructureError } from "./types.js";
import type {
  AudioPlaybackHandle,
  BrowserAudioPlayback
} from "./playback.js";

export class QueuedRendererAudioPlayer implements AudioPlayer {
  public constructor(private readonly playback: BrowserAudioPlayback) {}

  public async playAudio(input: Parameters<AudioPlayer["playAudio"]>[0]): Promise<void> {
    let handle: AudioPlaybackHandle;
    try {
      handle = this.playback.enqueue({
        id: input.deliveryId,
        source: input.audioRef,
        callbacks: {
          onStarted: input.callbacks.onStarted,
          onCompleted: input.callbacks.onCompleted
        }
      });
    } catch (error) {
      if (isDefinitelyNotEnqueued(error)) {
        throw new RendererPresentationNotExposedError(
          "Audio playback could not be queued",
          { cause: error }
        );
      }
      throw error;
    }

    const started = await handle.started;
    if (started) return;

    const outcome = await handle.result;
    throw new RendererPresentationNotExposedError(
      `Audio playback did not start (${outcome.status})`,
      outcome.error === undefined ? undefined : { cause: outcome.error }
    );
  }

  public cancelDelivery(deliveryId: string): void {
    this.playback.cancel(deliveryId);
  }

  public interruptCurrent(): void {
    this.playback.interruptCurrent();
  }

  public clearQueued(): void {
    this.playback.clearQueued();
  }

  public dispose(): void {
    this.playback.dispose();
  }
}

function isDefinitelyNotEnqueued(error: unknown): boolean {
  return error instanceof AudioInfrastructureError
    && (
      error.code === "QUEUE_FULL"
      || error.code === "DISPOSED"
      || error.code === "INVALID_REQUEST"
    );
}

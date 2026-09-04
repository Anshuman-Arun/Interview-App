import type {
  BoardAction,
  DeliveryId,
  SessionId
} from "../../../packages/domain/src/index.js";
import {
  RendererAcknowledgementCommandSchema,
  RendererStreamMessageSchema,
  RendererStreamSessionIdSchema,
  type RendererAcknowledgementCommand,
  type RendererStreamMessage
} from "../../../packages/delivery/src/index.js";

export interface RendererAcknowledgementSender {
  readonly send: (command: RendererAcknowledgementCommand) => Promise<void>;
}

export interface TextPresenter {
  readonly presentText: (text: string, deliveryId: DeliveryId) => void | Promise<void>;
}

export interface AudioPlaybackCallbacks {
  readonly onStarted: () => void | Promise<void>;
  readonly onCompleted: () => void | Promise<void>;
}

export interface AudioPlayer {
  readonly playAudio: (input: {
    readonly deliveryId: DeliveryId;
    readonly audioRef: string;
    readonly text: string;
    readonly callbacks: AudioPlaybackCallbacks;
  }) => void | Promise<void>;
}

export interface WhiteboardPresenter {
  readonly presentWhiteboard: (action: BoardAction, deliveryId: DeliveryId) => void | Promise<void>;
}

export interface RendererClientOptions {
  readonly sessionId: SessionId;
  readonly acknowledgementSender: RendererAcknowledgementSender;
  readonly textPresenter: TextPresenter;
  readonly audioPlayer: AudioPlayer;
  readonly whiteboardPresenter?: WhiteboardPresenter;
  readonly maxTrackedDeliveries?: number;
  readonly requestIdFactory?: () => string;
}

export interface RendererDeliverySnapshot {
  readonly deliveryId: DeliveryId;
  readonly phase: "RECEIVED" | "EXPOSED" | "COMPLETED";
  readonly exposedAcknowledged: boolean;
  readonly completedAcknowledged: boolean;
}

export interface RendererHandleResult {
  readonly deliveryId: DeliveryId;
  readonly duplicate: boolean;
  readonly phase: RendererDeliverySnapshot["phase"] | "NOT_EXPOSED";
}

interface TrackedDelivery {
  readonly deliveryId: DeliveryId;
  readonly fingerprint: string;
  phase: RendererDeliverySnapshot["phase"];
  exposureBegan: boolean;
  presentationCompleted: boolean;
  exposedRequestId?: string;
  completedRequestId?: string;
  exposedAcknowledged: boolean;
  completedAcknowledged: boolean;
  acknowledgementTail: Promise<void>;
  exposedAcknowledgementFailures: number;
  completedAcknowledgementFailures: number;
  acknowledgementRetryTimer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_MAX_TRACKED_DELIVERIES = 256;
const MAX_TRACKED_DELIVERIES = 4_096;
const MAX_ACKNOWLEDGEMENT_RETRIES = 3;
const ACKNOWLEDGEMENT_RETRY_BASE_MS = 50;

export class RendererPresentationNotExposedError extends Error {}

export class RendererClient {
  private readonly sessionId: SessionId;
  private readonly acknowledgementSender: RendererAcknowledgementSender;
  private readonly textPresenter: TextPresenter;
  private readonly audioPlayer: AudioPlayer;
  private readonly whiteboardPresenter: WhiteboardPresenter | undefined;
  private readonly maxTrackedDeliveries: number;
  private readonly requestIdFactory: () => string;
  private readonly tracked = new Map<DeliveryId, TrackedDelivery>();

  public constructor(options: RendererClientOptions) {
    this.sessionId = RendererStreamSessionIdSchema.parse(options.sessionId);
    const maxTrackedDeliveries = options.maxTrackedDeliveries ?? DEFAULT_MAX_TRACKED_DELIVERIES;
    if (
      !Number.isSafeInteger(maxTrackedDeliveries)
      || maxTrackedDeliveries < 1
      || maxTrackedDeliveries > MAX_TRACKED_DELIVERIES
    ) {
      throw new Error("Renderer delivery cache bound must be a safe integer within the hard limit");
    }
    this.acknowledgementSender = options.acknowledgementSender;
    this.textPresenter = options.textPresenter;
    this.audioPlayer = options.audioPlayer;
    this.whiteboardPresenter = options.whiteboardPresenter;
    this.maxTrackedDeliveries = maxTrackedDeliveries;
    this.requestIdFactory = options.requestIdFactory ?? defaultRequestIdFactory;
  }

  public async handleMessage(input: unknown): Promise<RendererHandleResult> {
    const message = RendererStreamMessageSchema.parse(input);
    const command = message.command;
    const fingerprint = contentFingerprint(command.content);
    const existing = this.tracked.get(command.deliveryId);

    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error("DeliveryId was reused with different renderer content");
      }
      await this.scheduleAcknowledgementFlush(existing);
      return {
        deliveryId: existing.deliveryId,
        duplicate: true,
        phase: existing.phase
      };
    }

    this.reserveCacheSlot();
    const entry: TrackedDelivery = {
      deliveryId: command.deliveryId,
      fingerprint,
      phase: "RECEIVED",
      exposureBegan: false,
      presentationCompleted: false,
      exposedAcknowledged: false,
      completedAcknowledged: false,
      acknowledgementTail: Promise.resolve(),
      exposedAcknowledgementFailures: 0,
      completedAcknowledgementFailures: 0,
      acknowledgementRetryTimer: undefined
    };
    this.tracked.set(command.deliveryId, entry);

    try {
      switch (command.content.medium) {
        case "TEXT":
          await this.textPresenter.presentText(command.content.text, command.deliveryId);
          await this.markExposureBegan(entry);
          await this.markPresentationCompleted(entry);
          break;
        case "AUDIO":
          await this.audioPlayer.playAudio({
            deliveryId: command.deliveryId,
            audioRef: command.content.audioRef,
            text: command.content.text,
            callbacks: {
              onStarted: () => this.markExposureBegan(entry),
              onCompleted: () => this.markPresentationCompleted(entry)
            }
          });
          break;
        case "WHITEBOARD":
          if (this.whiteboardPresenter === undefined) {
            throw new RendererPresentationNotExposedError("WHITEBOARD renderer transport is contract-only in Phase 0");
          }
          await this.whiteboardPresenter.presentWhiteboard(command.content.action, command.deliveryId);
          await this.markExposureBegan(entry);
          await this.markPresentationCompleted(entry);
          break;
      }
    } catch (error) {
      if (error instanceof RendererPresentationNotExposedError && !entry.exposureBegan) {
        const reason = error.message.trim().slice(0, 512)
          || "Renderer confirmed presentation did not begin";
        await this.acknowledgementSender.send(
          RendererAcknowledgementCommandSchema.parse({
            protocolVersion: 1,
            type: "ACK_DELIVERY_NOT_EXPOSED",
            requestId: this.requestIdFactory(),
            sessionId: this.sessionId,
            deliveryId: command.deliveryId,
            reason
          })
        );
        this.tracked.delete(command.deliveryId);
        return {
          deliveryId: command.deliveryId,
          duplicate: false,
          phase: "NOT_EXPOSED"
        };
      }
      throw error;
    }

    return {
      deliveryId: entry.deliveryId,
      duplicate: false,
      phase: entry.phase
    };
  }

  public snapshot(): readonly RendererDeliverySnapshot[] {
    return Array.from(this.tracked.values(), (entry) => ({
      deliveryId: entry.deliveryId,
      phase: entry.phase,
      exposedAcknowledged: entry.exposedAcknowledged,
      completedAcknowledged: entry.completedAcknowledged
    }));
  }

  private async markExposureBegan(entry: TrackedDelivery): Promise<void> {
    if (entry.exposureBegan) {
      await this.scheduleAcknowledgementFlush(entry);
      return;
    }
    entry.exposureBegan = true;
    entry.phase = "EXPOSED";
    entry.exposedRequestId = this.requestIdFactory();
    await this.scheduleAcknowledgementFlush(entry);
  }

  private async markPresentationCompleted(entry: TrackedDelivery): Promise<void> {
    if (!entry.exposureBegan) {
      throw new Error("Presentation cannot complete before exposure begins");
    }
    if (entry.presentationCompleted) {
      await this.scheduleAcknowledgementFlush(entry);
      return;
    }
    entry.presentationCompleted = true;
    entry.phase = "COMPLETED";
    entry.completedRequestId = this.requestIdFactory();
    await this.scheduleAcknowledgementFlush(entry);
  }

  private scheduleAcknowledgementFlush(entry: TrackedDelivery): Promise<void> {
    const flush = async (): Promise<void> => this.flushAcknowledgements(entry);
    entry.acknowledgementTail = entry.acknowledgementTail.then(flush, flush);
    return entry.acknowledgementTail;
  }

  private async flushAcknowledgements(entry: TrackedDelivery): Promise<void> {
    if (entry.exposureBegan && !entry.exposedAcknowledged) {
      if (entry.exposedRequestId === undefined) throw new Error("Missing exposure RequestId");
      const command = RendererAcknowledgementCommandSchema.parse({
        protocolVersion: 1,
        type: "ACK_DELIVERY_EXPOSED",
        requestId: entry.exposedRequestId,
        sessionId: this.sessionId,
        deliveryId: entry.deliveryId
      });
      try {
        await this.acknowledgementSender.send(command);
        entry.exposedAcknowledged = true;
        entry.exposedAcknowledgementFailures = 0;
        this.clearAcknowledgementRetry(entry);
      } catch {
        entry.exposedAcknowledgementFailures += 1;
        this.scheduleAcknowledgementRetry(
          entry,
          entry.exposedAcknowledgementFailures
        );
        return;
      }
    }

    if (entry.presentationCompleted && entry.exposedAcknowledged && !entry.completedAcknowledged) {
      if (entry.completedRequestId === undefined) throw new Error("Missing completion RequestId");
      const command = RendererAcknowledgementCommandSchema.parse({
        protocolVersion: 1,
        type: "ACK_DELIVERY_COMPLETED",
        requestId: entry.completedRequestId,
        sessionId: this.sessionId,
        deliveryId: entry.deliveryId
      });
      try {
        await this.acknowledgementSender.send(command);
        entry.completedAcknowledged = true;
        entry.completedAcknowledgementFailures = 0;
        this.clearAcknowledgementRetry(entry);
      } catch {
        entry.completedAcknowledgementFailures += 1;
        this.scheduleAcknowledgementRetry(
          entry,
          entry.completedAcknowledgementFailures
        );
        return;
      }
    }
  }

  private scheduleAcknowledgementRetry(
    entry: TrackedDelivery,
    failureCount: number
  ): void {
    if (
      failureCount > MAX_ACKNOWLEDGEMENT_RETRIES
      || entry.acknowledgementRetryTimer !== undefined
      || entry.completedAcknowledged
    ) return;

    const delayMs = ACKNOWLEDGEMENT_RETRY_BASE_MS * 2 ** (failureCount - 1);
    entry.acknowledgementRetryTimer = globalThis.setTimeout(() => {
      entry.acknowledgementRetryTimer = undefined;
      if (!this.tracked.has(entry.deliveryId)) return;
      void this.scheduleAcknowledgementFlush(entry);
    }, delayMs);
  }

  private clearAcknowledgementRetry(entry: TrackedDelivery): void {
    if (entry.acknowledgementRetryTimer === undefined) return;
    globalThis.clearTimeout(entry.acknowledgementRetryTimer);
    entry.acknowledgementRetryTimer = undefined;
  }

  private reserveCacheSlot(): void {
    if (this.tracked.size < this.maxTrackedDeliveries) return;

    for (const [deliveryId, entry] of this.tracked) {
      if (entry.completedAcknowledged) {
        this.tracked.delete(deliveryId);
        return;
      }
    }

    throw new Error("Renderer delivery cache capacity reached with no safely evictable entry");
  }
}

export class DomTextPresenter implements TextPresenter {
  public constructor(private readonly container: HTMLElement) {}

  public presentText(text: string, deliveryId: DeliveryId): void {
    if (!this.container.isConnected) {
      throw new RendererPresentationNotExposedError("Text renderer container is not attached to the document");
    }
    const element = this.container.ownerDocument.createElement("div");
    element.dataset.deliveryId = deliveryId;
    element.textContent = text;
    this.container.append(element);
  }
}

export class HtmlAudioPlayer implements AudioPlayer {
  public constructor(
    private readonly createAudio: (audioRef: string) => HTMLAudioElement = (audioRef) => new Audio(audioRef)
  ) {}

  public async playAudio(input: {
    readonly deliveryId: DeliveryId;
    readonly audioRef: string;
    readonly text: string;
    readonly callbacks: AudioPlaybackCallbacks;
  }): Promise<void> {
    const audio = this.createAudio(input.audioRef);
    const playbackState = { started: false, completed: false };

    audio.addEventListener("playing", () => {
      if (playbackState.started) return;
      playbackState.started = true;
      void input.callbacks.onStarted();
    });

    audio.addEventListener("ended", () => {
      if (playbackState.completed) return;
      playbackState.completed = true;
      void input.callbacks.onCompleted();
    });

    try {
      await audio.play();
    } catch (error) {
      if (!playbackState.started) throw new RendererPresentationNotExposedError("Audio playback did not start", { cause: error });
      throw error;
    }
  }
}

function defaultRequestIdFactory(): string {
  return `request_${globalThis.crypto.randomUUID()}`;
}

function contentFingerprint(content: RendererStreamMessage["command"]["content"]): string {
  switch (content.medium) {
    case "TEXT":
      return `TEXT\u0000${content.text}`;
    case "AUDIO":
      return `AUDIO\u0000${content.text}\u0000${content.audioRef}`;
    case "WHITEBOARD":
      return `WHITEBOARD\u0000${JSON.stringify(content.action)}`;
  }
}

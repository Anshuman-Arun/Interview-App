import type {
  BoardAction,
  DeliveryId,
  SessionId
} from "../../../packages/domain/src/index.js";
import {
  RendererAcknowledgementCommandSchema,
  RendererStreamMessageSchema,
  RendererStreamSessionIdSchema,
  type RendererAcknowledgementCommand
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
  readonly phase: RendererDeliverySnapshot["phase"];
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
}

const DEFAULT_MAX_TRACKED_DELIVERIES = 256;

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
    if (!Number.isInteger(options.maxTrackedDeliveries ?? DEFAULT_MAX_TRACKED_DELIVERIES)
      || (options.maxTrackedDeliveries ?? DEFAULT_MAX_TRACKED_DELIVERIES) < 1) {
      throw new Error("Renderer delivery cache bound must be a positive integer");
    }
    this.acknowledgementSender = options.acknowledgementSender;
    this.textPresenter = options.textPresenter;
    this.audioPlayer = options.audioPlayer;
    this.whiteboardPresenter = options.whiteboardPresenter;
    this.maxTrackedDeliveries = options.maxTrackedDeliveries ?? DEFAULT_MAX_TRACKED_DELIVERIES;
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
      acknowledgementTail: Promise.resolve()
    };
    this.tracked.set(command.deliveryId, entry);

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
          throw new Error("WHITEBOARD renderer transport is contract-only in Phase 0");
        }
        await this.whiteboardPresenter.presentWhiteboard(command.content.action, command.deliveryId);
        await this.markExposureBegan(entry);
        await this.markPresentationCompleted(entry);
        break;
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
      } catch {
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
      } catch {
        return;
      }
    }
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
      throw new Error("Text renderer container is not attached to the document");
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
    let started = false;
    let completed = false;

    audio.addEventListener("playing", () => {
      if (started) return;
      started = true;
      void input.callbacks.onStarted();
    });

    audio.addEventListener("ended", () => {
      if (completed) return;
      completed = true;
      void input.callbacks.onCompleted();
    });

    await audio.play();
  }
}

function defaultRequestIdFactory(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure random UUID generation is unavailable");
  }
  return `request_${globalThis.crypto.randomUUID()}`;
}

function contentFingerprint(content: RendererStreamMessageSchema["_output"]["command"]["content"]): string {
  switch (content.medium) {
    case "TEXT":
      return `TEXT\u0000${content.text}`;
    case "AUDIO":
      return `AUDIO\u0000${content.text}\u0000${content.audioRef}`;
    case "WHITEBOARD":
      return `WHITEBOARD\u0000${JSON.stringify(content.action)}`;
  }
}

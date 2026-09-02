import { describe, expect, it } from "vitest";
import {
  newDeliveryId,
  newSessionId,
  type DeliveryId
} from "../packages/domain/src/index.js";
import {
  MAX_RENDERER_STREAM_MESSAGE_BYTES,
  RendererAcknowledgementCommandSchema,
  RendererStreamMessageSchema,
  type RendererAcknowledgementCommand,
  type RendererStreamMessage
} from "../packages/delivery/src/index.js";
import {
  RendererClient,
  RendererPresentationNotExposedError,
  consumeAuthenticatedRendererStream,
  type AudioPlaybackCallbacks,
  type AudioPlayer,
  type RendererAcknowledgementSender,
  type TextPresenter
} from "../apps/web/src/index.js";

class RecordingAcknowledgementSender implements RendererAcknowledgementSender {
  public readonly commands: RendererAcknowledgementCommand[] = [];

  public async send(command: RendererAcknowledgementCommand): Promise<void> {
    this.commands.push(RendererAcknowledgementCommandSchema.parse(command));
  }
}

class HoldingAudioPlayer implements AudioPlayer {
  public playCount = 0;
  public callbacks: AudioPlaybackCallbacks | undefined;

  public playAudio(input: {
    readonly deliveryId: DeliveryId;
    readonly audioRef: string;
    readonly text: string;
    readonly callbacks: AudioPlaybackCallbacks;
  }): void {
    this.playCount += 1;
    this.callbacks = input.callbacks;
  }
}

function requestIdFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `request_00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

function textMessage(deliveryId = newDeliveryId(), text = "Visible probe"): RendererStreamMessage {
  return RendererStreamMessageSchema.parse({
    protocolVersion: 1,
    type: "DELIVERY_COMMAND",
    command: {
      deliveryId,
      content: { medium: "TEXT", text }
    }
  });
}

function audioMessage(deliveryId = newDeliveryId()): RendererStreamMessage {
  return RendererStreamMessageSchema.parse({
    protocolVersion: 1,
    type: "DELIVERY_COMMAND",
    command: {
      deliveryId,
      content: {
        medium: "AUDIO",
        text: "Spoken probe",
        audioRef: "/fixtures/probe.wav"
      }
    }
  });
}

describe("renderer DeliveryId deduplication", () => {
  it("does not expose TEXT until the presenter has inserted it, then acknowledges exposure and completion separately", async () => {
    const acknowledgements = new RecordingAcknowledgementSender();
    const visible: DeliveryId[] = [];
    let releasePresentation: (() => void) | undefined;
    const presenter: TextPresenter = {
      presentText: (_text, deliveryId) => new Promise<void>((resolve) => {
        releasePresentation = () => {
          visible.push(deliveryId);
          resolve();
        };
      })
    };
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: acknowledgements,
      textPresenter: presenter,
      audioPlayer: new HoldingAudioPlayer(),
      requestIdFactory: requestIdFactory()
    });
    const message = textMessage();

    const handling = client.handleMessage(message);
    await Promise.resolve();

    expect(client.snapshot()).toEqual([{
      deliveryId: message.command.deliveryId,
      phase: "RECEIVED",
      exposedAcknowledged: false,
      completedAcknowledged: false
    }]);
    expect(visible).toEqual([]);
    expect(acknowledgements.commands).toEqual([]);

    if (releasePresentation === undefined) throw new Error("Text presenter was not invoked");
    releasePresentation();
    await handling;

    expect(visible).toEqual([message.command.deliveryId]);
    expect(acknowledgements.commands.map((command) => command.type)).toEqual([
      "ACK_DELIVERY_EXPOSED",
      "ACK_DELIVERY_COMPLETED"
    ]);
    expect(client.snapshot()[0]?.phase).toBe("COMPLETED");
  });

  it("does not duplicate visible text for a repeated DeliveryId", async () => {
    const acknowledgements = new RecordingAcknowledgementSender();
    const visible: DeliveryId[] = [];
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: acknowledgements,
      textPresenter: {
        presentText: (_text, deliveryId) => {
          visible.push(deliveryId);
        }
      },
      audioPlayer: new HoldingAudioPlayer(),
      requestIdFactory: requestIdFactory()
    });
    const message = textMessage();

    const first = await client.handleMessage(message);
    const duplicate = await client.handleMessage(message);

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(visible).toEqual([message.command.deliveryId]);
    expect(acknowledgements.commands).toHaveLength(2);
  });

  it("retries the same DeliveryId only after a presenter proves exposure never began", async () => {
    let attempts = 0;
    const visible: DeliveryId[] = [];
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: new RecordingAcknowledgementSender(),
      textPresenter: {
        presentText: (_text, deliveryId) => {
          attempts += 1;
          if (attempts === 1) throw new RendererPresentationNotExposedError("fixture proves no insertion occurred");
          visible.push(deliveryId);
        }
      },
      audioPlayer: new HoldingAudioPlayer(),
      requestIdFactory: requestIdFactory()
    });
    const message = textMessage();

    await expect(client.handleMessage(message)).rejects.toThrow("proves no insertion");
    expect(client.snapshot()).toEqual([]);
    const retried = await client.handleMessage(message);

    expect(retried.duplicate).toBe(false);
    expect(attempts).toBe(2);
    expect(visible).toEqual([message.command.deliveryId]);
  });

  it("suppresses retry after an ambiguous presenter failure", async () => {
    let attempts = 0;
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: new RecordingAcknowledgementSender(),
      textPresenter: {
        presentText: () => {
          attempts += 1;
          throw new Error("presentation outcome unknown");
        }
      },
      audioPlayer: new HoldingAudioPlayer(),
      requestIdFactory: requestIdFactory()
    });
    const message = textMessage();

    await expect(client.handleMessage(message)).rejects.toThrow("outcome unknown");
    const duplicate = await client.handleMessage(message);

    expect(duplicate).toMatchObject({ duplicate: true, phase: "RECEIVED" });
    expect(attempts).toBe(1);
  });

  it("does not restart AUDIO when bytes are received again and exposes only on the playback-start callback", async () => {
    const acknowledgements = new RecordingAcknowledgementSender();
    const audio = new HoldingAudioPlayer();
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: acknowledgements,
      textPresenter: { presentText: () => undefined },
      audioPlayer: audio,
      requestIdFactory: requestIdFactory()
    });
    const message = audioMessage();

    await client.handleMessage(message);
    await client.handleMessage(message);

    expect(audio.playCount).toBe(1);
    expect(client.snapshot()[0]?.phase).toBe("RECEIVED");
    expect(acknowledgements.commands).toEqual([]);

    if (audio.callbacks === undefined) throw new Error("Audio callbacks were not installed");
    await audio.callbacks.onStarted();

    expect(client.snapshot()[0]?.phase).toBe("EXPOSED");
    expect(acknowledgements.commands.map((command) => command.type)).toEqual([
      "ACK_DELIVERY_EXPOSED"
    ]);

    await audio.callbacks.onCompleted();
    await client.handleMessage(message);

    expect(audio.playCount).toBe(1);
    expect(client.snapshot()[0]?.phase).toBe("COMPLETED");
    expect(acknowledgements.commands.map((command) => command.type)).toEqual([
      "ACK_DELIVERY_EXPOSED",
      "ACK_DELIVERY_COMPLETED"
    ]);
  });

  it("retries transient acknowledgements without replaying presentation or changing RequestIds", async () => {
    const attempts = new Map<string, number>();
    const requestIds = new Map<string, Set<string>>();
    const sender: RendererAcknowledgementSender = {
      send: async (command) => {
        const parsed = RendererAcknowledgementCommandSchema.parse(command);
        const count = (attempts.get(parsed.type) ?? 0) + 1;
        attempts.set(parsed.type, count);
        const ids = requestIds.get(parsed.type) ?? new Set<string>();
        ids.add(parsed.requestId);
        requestIds.set(parsed.type, ids);

        if (parsed.type === "ACK_DELIVERY_EXPOSED" && count < 3) {
          throw new Error("transient exposed acknowledgement failure");
        }
        if (parsed.type === "ACK_DELIVERY_COMPLETED" && count < 2) {
          throw new Error("transient completion acknowledgement failure");
        }
      }
    };
    const visible: DeliveryId[] = [];
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: sender,
      textPresenter: {
        presentText: (_text, deliveryId) => {
          visible.push(deliveryId);
        }
      },
      audioPlayer: new HoldingAudioPlayer(),
      requestIdFactory: requestIdFactory()
    });
    const message = textMessage();

    await client.handleMessage(message);
    await waitFor(() => {
      const snapshot = client.snapshot()[0];
      return snapshot !== undefined
        && snapshot.exposedAcknowledged
        && snapshot.completedAcknowledged;
    });

    expect(visible).toEqual([message.command.deliveryId]);
    expect(attempts.get("ACK_DELIVERY_EXPOSED")).toBe(3);
    expect(attempts.get("ACK_DELIVERY_COMPLETED")).toBe(2);
    expect(requestIds.get("ACK_DELIVERY_EXPOSED")?.size).toBe(1);
    expect(requestIds.get("ACK_DELIVERY_COMPLETED")?.size).toBe(1);
  });

  it("rejects renderer cache limits that do not provide a real finite bound", () => {
    const base = {
      sessionId: newSessionId(),
      acknowledgementSender: new RecordingAcknowledgementSender(),
      textPresenter: { presentText: () => undefined },
      audioPlayer: new HoldingAudioPlayer()
    };
    expect(() => new RendererClient({
      ...base,
      maxTrackedDeliveries: Number.MAX_SAFE_INTEGER
    })).toThrow(/hard limit/u);
    expect(() => new RendererClient({
      ...base,
      maxTrackedDeliveries: 1.5
    })).toThrow(/safe integer/u);
  });

  it("fails closed if one DeliveryId is reused for different content", async () => {
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: new RecordingAcknowledgementSender(),
      textPresenter: { presentText: () => undefined },
      audioPlayer: new HoldingAudioPlayer(),
      requestIdFactory: requestIdFactory()
    });
    const deliveryId = newDeliveryId();

    await client.handleMessage(textMessage(deliveryId, "first"));
    await expect(client.handleMessage(textMessage(deliveryId, "different"))).rejects.toThrow(
      "DeliveryId was reused"
    );
  });

  it("keeps unacknowledged in-flight IDs rather than evicting them when the bounded cache is full", async () => {
    const audio = new HoldingAudioPlayer();
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: new RecordingAcknowledgementSender(),
      textPresenter: { presentText: () => undefined },
      audioPlayer: audio,
      maxTrackedDeliveries: 1,
      requestIdFactory: requestIdFactory()
    });

    await client.handleMessage(audioMessage());
    await expect(client.handleMessage(audioMessage())).rejects.toThrow("cache capacity");
    expect(audio.playCount).toBe(1);
  });



  it("fails closed on malformed or oversized inbound stream events", async () => {
    const sessionId = newSessionId();
    const renderer = new RendererClient({
      sessionId,
      acknowledgementSender: new RecordingAcknowledgementSender(),
      textPresenter: { presentText: () => undefined },
      audioPlayer: new HoldingAudioPlayer(),
      requestIdFactory: requestIdFactory()
    });

    await expect(consumeAuthenticatedRendererStream({
      streamUrl: "http://127.0.0.1:1/v1/renderer-stream",
      sessionId,
      authenticatedFetch: staticSseFetch("event: delivery\ndata: {not-json}\n\n")
    }, renderer)).rejects.toThrow("not valid JSON");

    const oversized = `event: delivery\ndata: ${"x".repeat(MAX_RENDERER_STREAM_MESSAGE_BYTES + 1)}\n\n`;
    await expect(consumeAuthenticatedRendererStream({
      streamUrl: "http://127.0.0.1:1/v1/renderer-stream",
      sessionId,
      authenticatedFetch: staticSseFetch(oversized)
    }, renderer)).rejects.toThrow(/exceeded its bound/u);

    expect(renderer.snapshot()).toEqual([]);
  });

  it("strict runtime schemas reject extra fields, unknown message types, and malformed IDs", () => {
    const valid = textMessage();

    expect(RendererStreamMessageSchema.safeParse({
      ...valid,
      arbitrary: true
    }).success).toBe(false);

    expect(RendererStreamMessageSchema.safeParse({
      protocolVersion: 1,
      type: "UNKNOWN",
      command: valid.command
    }).success).toBe(false);

    expect(RendererStreamMessageSchema.safeParse({
      ...valid,
      command: {
        ...valid.command,
        deliveryId: "delivery-not-a-uuid"
      }
    }).success).toBe(false);

    const acknowledgement = {
      protocolVersion: 1,
      type: "ACK_DELIVERY_EXPOSED",
      requestId: requestIdFactory()(),
      sessionId: newSessionId(),
      deliveryId: newDeliveryId()
    };
    expect(RendererAcknowledgementCommandSchema.safeParse({
      ...acknowledgement,
      arbitrary: true
    }).success).toBe(false);
  });
});

function staticSseFetch(body: string): typeof fetch {
  return async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}


async function waitFor(
  condition: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for renderer acknowledgement retry");
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  DeliveryAtomSchema,
  DisclosureIdSchema,
  newDeliveryId,
  newGenerationId,
  newRequestId,
  newSessionId,
  type DeliveryAtom,
  type DeliveryId,
  type DisclosureId,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  SessionRuntimeRegistry,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import {
  LoopbackCommandServer,
  type BoundLoopbackAddress
} from "../apps/server/src/loopback-command-server.js";
import {
  RendererStreamServer,
  type BoundRendererStreamAddress
} from "../apps/server/src/renderer-stream-server.js";
import {
  RendererClient,
  consumeAuthenticatedRendererStream,
  createLoopbackAcknowledgementSender,
  type AudioPlaybackCallbacks,
  type AudioPlayer,
  type RendererHandleResult
} from "../apps/web/src/index.js";

const CLIENT_TOKEN = "renderer-audio-crash-client-token-long-enough";
const CLIENT_ORIGIN = "http://127.0.0.1:5173";

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

class CountingRendererClient extends RendererClient {
  public handledMessageCount = 0;

  public override async handleMessage(input: unknown): Promise<RendererHandleResult> {
    this.handledMessageCount += 1;
    return super.handleMessage(input);
  }
}

describe("renderer audio crash and reconnect semantics", () => {
  it("reissues the same DeliveryId after disconnect before exposure without restarting audio", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const commandServer = new LoopbackCommandServer({
      security: security(),
      registry
    });
    const streamServer = new RendererStreamServer({
      security: security(),
      registry
    });

    try {
      const commandAddress = await commandServer.start();
      const streamAddress = await streamServer.start();
      const sessionId = newSessionId();
      await primeCommandServer(commandAddress, sessionId);
      const writer = registry.get(sessionId);
      const atom = await queueAudio(writer);

      const audio = new HoldingAudioPlayer();
      const renderer = new CountingRendererClient({
        sessionId,
        acknowledgementSender: createLoopbackAcknowledgementSender({
          commandUrl: `${commandAddress.url}/v1/commands`,
          clientToken: CLIENT_TOKEN,
          fetchImpl: fetchWithOrigin
        }),
        textPresenter: { presentText: () => undefined },
        audioPlayer: audio
      });

      const firstController = new AbortController();
      const firstConsumer = consume(streamAddress, sessionId, renderer, firstController);
      await waitFor(() => streamServer.activeConnectionCount() === 1);

      const firstPublish = await streamServer.publishDelivery(sessionId, atom.deliveryId);
      expect(firstPublish).toEqual({
        outcome: "SENT",
        deliveryId: atom.deliveryId,
        status: "DELIVERING"
      });
      await waitFor(() => renderer.handledMessageCount === 1);

      expect(audio.playCount).toBe(1);
      expect(renderer.snapshot()[0]?.phase).toBe("RECEIVED");
      expect(writer.getState().deliveries[atom.deliveryId]?.status).toBe("DELIVERING");

      firstController.abort();
      await firstConsumer;
      await waitFor(() => streamServer.activeConnectionCount() === 0);

      const secondController = new AbortController();
      const secondConsumer = consume(streamAddress, sessionId, renderer, secondController);
      await waitFor(() => streamServer.activeConnectionCount() === 1);

      const secondPublish = await streamServer.publishDelivery(sessionId, atom.deliveryId);
      expect(secondPublish).toEqual({
        outcome: "SENT",
        deliveryId: atom.deliveryId,
        status: "DELIVERING"
      });
      await waitFor(() => renderer.handledMessageCount === 2);

      expect(renderer.snapshot()).toHaveLength(1);
      expect(renderer.snapshot()[0]?.deliveryId).toBe(atom.deliveryId);
      expect(renderer.snapshot()[0]?.phase).toBe("RECEIVED");
      expect(audio.playCount).toBe(1);

      secondController.abort();
      await secondConsumer;
    } finally {
      await streamServer.stop();
      await commandServer.stop();
      store.close();
    }
  });

  it("recovers exposure-with-lost-ack as POSSIBLY_EXPOSED after application restart and never replays it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "renderer-audio-crash-"));
    const databasePath = join(directory, "events.sqlite");
    const disclosureId = DisclosureIdSchema.parse("disclosure_audio_crash_fixture");
    let store = new SqliteEventStore(databasePath);
    let streamServer: RendererStreamServer | undefined;

    try {
      let registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const atom = await queueAudio(writer, [disclosureId]);

      streamServer = new RendererStreamServer({
        security: security(),
        registry
      });
      let streamAddress = await streamServer.start();

      const audio = new HoldingAudioPlayer();
      const renderer = new CountingRendererClient({
        sessionId,
        acknowledgementSender: {
          send: async () => {
            throw new Error("simulated acknowledgement transport loss");
          }
        },
        textPresenter: { presentText: () => undefined },
        audioPlayer: audio
      });

      const firstController = new AbortController();
      const firstConsumer = consume(streamAddress, sessionId, renderer, firstController);
      await waitFor(() => streamServer?.activeConnectionCount() === 1);
      await streamServer.publishDelivery(sessionId, atom.deliveryId);
      await waitFor(() => renderer.handledMessageCount === 1);

      if (audio.callbacks === undefined) throw new Error("Audio callbacks were not installed");
      await audio.callbacks.onStarted();

      expect(renderer.snapshot()[0]?.phase).toBe("EXPOSED");
      expect(renderer.snapshot()[0]?.exposedAcknowledged).toBe(false);
      expect(writer.getState().deliveries[atom.deliveryId]?.status).toBe("DELIVERING");

      firstController.abort();
      await firstConsumer;
      await streamServer.stop();
      streamServer = undefined;
      store.close();

      store = new SqliteEventStore(databasePath);
      registry = new SessionRuntimeRegistry(store);
      streamServer = new RendererStreamServer({
        security: security(),
        registry
      });
      streamAddress = await streamServer.start();

      const freshAudio = new HoldingAudioPlayer();
      const freshRenderer = new CountingRendererClient({
        sessionId,
        acknowledgementSender: { send: async () => undefined },
        textPresenter: { presentText: () => undefined },
        audioPlayer: freshAudio
      });
      const reconnectController = new AbortController();
      const reconnectConsumer = consume(streamAddress, sessionId, freshRenderer, reconnectController);
      await waitFor(() => streamServer?.activeConnectionCount() === 1);

      const restartedWriter = registry.get(sessionId);
      await waitFor(() =>
        restartedWriter.getState().deliveries[atom.deliveryId]?.status === "POSSIBLY_EXPOSED"
      );

      expect(restartedWriter.getState().disclosureLedger).toContain(disclosureId);
      expect(await streamServer.publishDelivery(sessionId, atom.deliveryId)).toEqual({
        outcome: "NOT_DELIVERABLE",
        deliveryId: atom.deliveryId,
        status: "POSSIBLY_EXPOSED"
      });
      expect(freshRenderer.handledMessageCount).toBe(0);
      expect(freshAudio.playCount).toBe(0);

      reconnectController.abort();
      await reconnectConsumer;
    } finally {
      if (streamServer !== undefined) await streamServer.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not replay audio after persisted EXPOSED when the renderer crashes before COMPLETED", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const commandServer = new LoopbackCommandServer({
      security: security(),
      registry
    });
    const streamServer = new RendererStreamServer({
      security: security(),
      registry
    });

    try {
      const commandAddress = await commandServer.start();
      const streamAddress = await streamServer.start();
      const sessionId = newSessionId();
      await primeCommandServer(commandAddress, sessionId);
      const writer = registry.get(sessionId);
      const atom = await queueAudio(writer);

      const audio = new HoldingAudioPlayer();
      const renderer = new CountingRendererClient({
        sessionId,
        acknowledgementSender: createLoopbackAcknowledgementSender({
          commandUrl: `${commandAddress.url}/v1/commands`,
          clientToken: CLIENT_TOKEN,
          fetchImpl: fetchWithOrigin
        }),
        textPresenter: { presentText: () => undefined },
        audioPlayer: audio
      });

      const firstController = new AbortController();
      const firstConsumer = consume(streamAddress, sessionId, renderer, firstController);
      await waitFor(() => streamServer.activeConnectionCount() === 1);
      await streamServer.publishDelivery(sessionId, atom.deliveryId);
      await waitFor(() => renderer.handledMessageCount === 1);

      if (audio.callbacks === undefined) throw new Error("Audio callbacks were not installed");
      await audio.callbacks.onStarted();
      await waitFor(() => writer.getState().deliveries[atom.deliveryId]?.status === "EXPOSED");

      firstController.abort();
      await firstConsumer;
      await waitFor(() => streamServer.activeConnectionCount() === 0);

      const freshAudio = new HoldingAudioPlayer();
      const freshRenderer = new CountingRendererClient({
        sessionId,
        acknowledgementSender: createLoopbackAcknowledgementSender({
          commandUrl: `${commandAddress.url}/v1/commands`,
          clientToken: CLIENT_TOKEN,
          fetchImpl: fetchWithOrigin
        }),
        textPresenter: { presentText: () => undefined },
        audioPlayer: freshAudio
      });
      const reconnectController = new AbortController();
      const reconnectConsumer = consume(streamAddress, sessionId, freshRenderer, reconnectController);
      await waitFor(() => streamServer.activeConnectionCount() === 1);

      expect(await streamServer.publishDelivery(sessionId, atom.deliveryId)).toEqual({
        outcome: "NOT_DELIVERABLE",
        deliveryId: atom.deliveryId,
        status: "EXPOSED"
      });
      expect(freshRenderer.handledMessageCount).toBe(0);
      expect(freshAudio.playCount).toBe(0);
      expect(writer.getState().deliveries[atom.deliveryId]?.status).toBe("EXPOSED");

      reconnectController.abort();
      await reconnectConsumer;
    } finally {
      await streamServer.stop();
      await commandServer.stop();
      store.close();
    }
  });
});

function security() {
  return {
    host: "127.0.0.1" as const,
    allowedOrigins: new Set([CLIENT_ORIGIN]),
    clientToken: CLIENT_TOKEN
  };
}

async function queueAudio(
  writer: ReturnType<SessionRuntimeRegistry["get"]>,
  disclosureIds: readonly DisclosureId[] = []
): Promise<DeliveryAtom> {
  const atom = DeliveryAtomSchema.parse({
    deliveryId: newDeliveryId(),
    generationId: newGenerationId(),
    content: {
      medium: "AUDIO",
      text: "Deterministic audio fixture",
      audioRef: "/fixtures/deterministic-audio.wav"
    },
    disclosureIds,
    effectiveDisclosureLevel: disclosureIds.length === 0 ? 0 : 2,
    status: "VALIDATED"
  });
  await writer.execute(
    createCommandEnvelope({ sessionId: writer.sessionId, producer: "renderer-audio-test-fixture" }),
    z.object({ queued: z.literal(true) }).strict(),
    () => ({
      drafts: [{
        source: "APPLICATION",
        type: "DELIVERY_QUEUED",
        payload: { atom }
      }],
      result: { queued: true as const }
    })
  );
  return atom;
}

async function primeCommandServer(address: BoundLoopbackAddress, sessionId: SessionId): Promise<void> {
  const response = await fetch(`${address.url}/v1/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: CLIENT_ORIGIN,
      "x-interview-client-token": CLIENT_TOKEN
    },
    body: JSON.stringify({
      protocolVersion: 1,
      type: "GET_SESSION_SUMMARY",
      requestId: newRequestId(),
      sessionId
    })
  });
  if (!response.ok) throw new Error("Failed to prime authenticated command runtime");
}

function consume(
  address: BoundRendererStreamAddress,
  sessionId: SessionId,
  renderer: RendererClient,
  controller: AbortController
): Promise<void> {
  return consumeAuthenticatedRendererStream({
    streamUrl: address.streamUrl,
    sessionId,
    clientToken: CLIENT_TOKEN,
    fetchImpl: fetchWithOrigin,
    signal: controller.signal
  }, renderer);
}

const fetchWithOrigin: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("origin", CLIENT_ORIGIN);
  return fetch(input, { ...init, headers });
};

async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for renderer audio condition");
}

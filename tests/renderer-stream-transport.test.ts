import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryAtomSchema,
  DeliveryAcknowledgedResponseSchema,
  ProtocolErrorResponseSchema,
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
  DeliveryCoordinator,
  RendererStreamErrorResponseSchema
} from "../packages/delivery/src/index.js";
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
import { SessionRecoveryCoordinator } from "../apps/server/src/session-recovery-coordinator.js";
import {
  RendererClient,
  consumeAuthenticatedRendererStream,
  createLoopbackAcknowledgementSender,
  type AudioPlayer
} from "../apps/web/src/index.js";

const CLIENT_TOKEN = "renderer-stream-test-client-token-long-enough";
const CLIENT_ORIGIN = "http://127.0.0.1:5173";

describe("authenticated renderer stream transport", () => {
  let store: SqliteEventStore;
  let registry: SessionRuntimeRegistry;
  let sessions: SessionRecoveryCoordinator;
  let commandServer: LoopbackCommandServer;
  let commandAddress: BoundLoopbackAddress;
  let streamServer: RendererStreamServer;
  let streamAddress: BoundRendererStreamAddress;

  beforeEach(async () => {
    store = new SqliteEventStore(":memory:");
    registry = new SessionRuntimeRegistry(store);
    sessions = new SessionRecoveryCoordinator(registry);
    commandServer = new LoopbackCommandServer({
      security: {
        host: "127.0.0.1",
        allowedOrigins: new Set([CLIENT_ORIGIN]),
        clientToken: CLIENT_TOKEN
      },
      sessions
    });
    streamServer = new RendererStreamServer({
      security: {
        host: "127.0.0.1",
        allowedOrigins: new Set([CLIENT_ORIGIN]),
        clientToken: CLIENT_TOKEN
      },
      sessions
    });
    commandAddress = await commandServer.start();
    streamAddress = await streamServer.start();
  });

  afterEach(async () => {
    await streamServer.stop();
    await commandServer.stop();
    store.close();
  });

  it("moves TEXT and AUDIO through the same stable-ID stream and acknowledgement lifecycle", async () => {
    const sessionId = newSessionId();
    await primeCommandServer(commandAddress, sessionId);

    const writer = registry.get(sessionId);
    const textAtom = await queueDelivery(writer, {
      medium: "TEXT",
      text: "Why must that step be true?"
    });
    const audioAtom = await queueDelivery(writer, {
      medium: "AUDIO",
      text: "Can you justify that implication?",
      audioRef: "/fixtures/deterministic-probe.wav"
    });

    const visibleText: DeliveryId[] = [];
    const playedAudio: DeliveryId[] = [];
    const audioPlayer: AudioPlayer = {
      playAudio: async (input) => {
        playedAudio.push(input.deliveryId);
        await input.callbacks.onStarted();
        await input.callbacks.onCompleted();
      }
    };

    const renderer = new RendererClient({
      sessionId,
      acknowledgementSender: createLoopbackAcknowledgementSender({
        commandUrl: `${commandAddress.url}/v1/commands`,
        authenticatedFetch: fetchWithAuth
      }),
      textPresenter: {
        presentText: (_text, deliveryId) => {
          visibleText.push(deliveryId);
        }
      },
      audioPlayer
    });

    const controller = new AbortController();
    const consumer = consumeAuthenticatedRendererStream({
      streamUrl: streamAddress.streamUrl,
      sessionId,
      authenticatedFetch: fetchWithAuth,
      signal: controller.signal
    }, renderer);

    await waitFor(() => streamServer.activeConnectionCount() === 1);

    expect(await streamServer.publishDelivery(sessionId, textAtom.deliveryId)).toEqual({
      outcome: "SENT",
      deliveryId: textAtom.deliveryId,
      status: "DELIVERING"
    });
    expect(await streamServer.publishDelivery(sessionId, audioAtom.deliveryId)).toEqual({
      outcome: "SENT",
      deliveryId: audioAtom.deliveryId,
      status: "DELIVERING"
    });

    await waitFor(() =>
      writer.getState().deliveries[textAtom.deliveryId]?.status === "COMPLETED"
      && writer.getState().deliveries[audioAtom.deliveryId]?.status === "COMPLETED"
    );

    expect(visibleText).toEqual([textAtom.deliveryId]);
    expect(playedAudio).toEqual([audioAtom.deliveryId]);
    expect(renderer.snapshot().map((entry) => entry.deliveryId)).toEqual([
      textAtom.deliveryId,
      audioAtom.deliveryId
    ]);

    for (const deliveryId of [textAtom.deliveryId, audioAtom.deliveryId]) {
      const lifecycle = deliveryLifecycle(store.load(sessionId), deliveryId);
      expect(lifecycle).toEqual([
        "DELIVERY_QUEUED",
        "DELIVERY_STARTED",
        "DELIVERY_EXPOSED",
        "DELIVERY_COMPLETED"
      ]);
    }

    controller.abort();
    await consumer;
  });

  it("leaves a queued delivery untouched when no renderer is connected", async () => {
    const sessionId = newSessionId();
    await primeCommandServer(commandAddress, sessionId);
    const writer = registry.get(sessionId);
    const atom = await queueDelivery(writer, { medium: "TEXT", text: "queued only" });

    expect(await streamServer.publishDelivery(sessionId, atom.deliveryId)).toEqual({
      outcome: "NO_CLIENT",
      deliveryId: atom.deliveryId
    });
    expect(writer.getState().deliveries[atom.deliveryId]?.status).toBe("QUEUED");
    expect(deliveryLifecycle(store.load(sessionId), atom.deliveryId)).toEqual(["DELIVERY_QUEUED"]);
  });

  it("rejects unauthorized, malformed, oversized, and excess stream attachments before attaching", async () => {
    const sessionId = newSessionId();
    const attach = {
      protocolVersion: 1,
      type: "ATTACH_RENDERER_STREAM",
      sessionId
    };

    const missingToken = await fetch(streamAddress.streamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: CLIENT_ORIGIN
      },
      body: JSON.stringify(attach)
    });
    expect(missingToken.status).toBe(401);
    expect(RendererStreamErrorResponseSchema.parse(await missingToken.json() as unknown).error.code).toBe("UNAUTHORIZED");

    const wrongOrigin = await fetch(streamAddress.streamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://attacker.invalid",
        "x-interview-client-token": CLIENT_TOKEN
      },
      body: JSON.stringify(attach)
    });
    expect(wrongOrigin.status).toBe(403);

    const malformed = await fetch(streamAddress.streamUrl, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ ...attach, arbitrary: true })
    });
    expect(malformed.status).toBe(400);
    expect(RendererStreamErrorResponseSchema.parse(await malformed.json() as unknown).error.code).toBe("INVALID_STREAM_REQUEST");

    const oversized = await fetch(streamAddress.streamUrl, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ ...attach, padding: "x".repeat(9 * 1024) })
    });
    expect(oversized.status).toBe(413);
    expect(RendererStreamErrorResponseSchema.parse(await oversized.json() as unknown).error.code).toBe("BODY_TOO_LARGE");

    const preflight = await fetch(streamAddress.streamUrl, {
      method: "OPTIONS",
      headers: { origin: CLIENT_ORIGIN }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);

    const controller = new AbortController();
    const first = await fetch(streamAddress.streamUrl, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify(attach),
      signal: controller.signal
    });
    expect(first.status).toBe(200);
    expect(streamServer.activeConnectionCount()).toBe(1);

    const duplicateSession = await fetch(streamAddress.streamUrl, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify(attach)
    });
    expect(duplicateSession.status).toBe(409);
    expect(RendererStreamErrorResponseSchema.parse(await duplicateSession.json() as unknown).error.code).toBe("TOO_MANY_CONNECTIONS");

    controller.abort();
    await first.body?.cancel().catch(() => undefined);
    await waitFor(() => streamServer.activeConnectionCount() === 0);
  });

  it("fails closed before starting an oversized outbound delivery", async () => {
    const sessionId = newSessionId();
    await primeCommandServer(commandAddress, sessionId);
    const writer = registry.get(sessionId);
    const atom = await queueDelivery(writer, {
      medium: "TEXT",
      text: "x".repeat(70 * 1024)
    });

    const controller = new AbortController();
    const response = await fetch(streamAddress.streamUrl, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        protocolVersion: 1,
        type: "ATTACH_RENDERER_STREAM",
        sessionId
      }),
      signal: controller.signal
    });
    expect(response.status).toBe(200);

    const result = await streamServer.publishDelivery(sessionId, atom.deliveryId);
    expect(result).toEqual({
      outcome: "MESSAGE_TOO_LARGE",
      deliveryId: atom.deliveryId,
      status: "QUEUED"
    });
    expect(writer.getState().deliveries[atom.deliveryId]?.status).toBe("QUEUED");

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });

  it("uses the existing authenticated command path for idempotent EXPOSED and COMPLETED acknowledgements", async () => {
    const sessionId = newSessionId();
    await primeCommandServer(commandAddress, sessionId);
    const writer = registry.get(sessionId);
    const atom = await queueDelivery(writer, { medium: "TEXT", text: "ack fixture" });
    await new DeliveryCoordinator(writer).markStarted(atom.deliveryId);

    const eventCountBeforeUnauthorized = store.eventCount(sessionId);
    const wrongToken = await postAcknowledgement(commandAddress, {
      protocolVersion: 1,
      type: "ACK_DELIVERY_EXPOSED",
      requestId: newRequestId(),
      sessionId,
      deliveryId: atom.deliveryId
    }, { token: "wrong-token-that-is-also-long-enough" });
    expect(wrongToken.status).toBe(401);

    const wrongOrigin = await postAcknowledgement(commandAddress, {
      protocolVersion: 1,
      type: "ACK_DELIVERY_EXPOSED",
      requestId: newRequestId(),
      sessionId,
      deliveryId: atom.deliveryId
    }, { origin: "http://attacker.invalid" });
    expect(wrongOrigin.status).toBe(403);
    expect(store.eventCount(sessionId)).toBe(eventCountBeforeUnauthorized);

    const malformed = await fetch(`${commandAddress.url}/v1/commands`, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: "{not-json"
    });
    expect(malformed.status).toBe(400);
    expect(ProtocolErrorResponseSchema.parse(await malformed.json() as unknown).error.code).toBe("INVALID_COMMAND");

    const oversized = await fetch(`${commandAddress.url}/v1/commands`, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ padding: "x".repeat(70 * 1024) })
    });
    expect(oversized.status).toBe(413);
    expect(ProtocolErrorResponseSchema.parse(await oversized.json() as unknown).error.code).toBe("BODY_TOO_LARGE");

    const exposedCommand = {
      protocolVersion: 1 as const,
      type: "ACK_DELIVERY_EXPOSED" as const,
      requestId: newRequestId(),
      sessionId,
      deliveryId: atom.deliveryId
    };
    const firstExposed = DeliveryAcknowledgedResponseSchema.parse(
      await (await postAcknowledgement(commandAddress, exposedCommand)).json() as unknown
    );
    const eventCountAfterExposed = store.eventCount(sessionId);
    const duplicateExposed = DeliveryAcknowledgedResponseSchema.parse(
      await (await postAcknowledgement(commandAddress, exposedCommand)).json() as unknown
    );
    expect(duplicateExposed).toEqual(firstExposed);
    expect(store.eventCount(sessionId)).toBe(eventCountAfterExposed);

    const completedCommand = {
      protocolVersion: 1 as const,
      type: "ACK_DELIVERY_COMPLETED" as const,
      requestId: newRequestId(),
      sessionId,
      deliveryId: atom.deliveryId
    };
    const firstCompleted = DeliveryAcknowledgedResponseSchema.parse(
      await (await postAcknowledgement(commandAddress, completedCommand)).json() as unknown
    );
    const eventCountAfterCompleted = store.eventCount(sessionId);
    const duplicateCompleted = DeliveryAcknowledgedResponseSchema.parse(
      await (await postAcknowledgement(commandAddress, completedCommand)).json() as unknown
    );
    expect(duplicateCompleted).toEqual(firstCompleted);
    expect(store.eventCount(sessionId)).toBe(eventCountAfterCompleted);
    expect(writer.getState().deliveries[atom.deliveryId]?.status).toBe("COMPLETED");
  });

  it("never includes the client token in events, transport results, renderer state, errors, or console logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const sessionId = newSessionId();
      await primeCommandServer(commandAddress, sessionId);
      const writer = registry.get(sessionId);
      const atom = await queueDelivery(writer, { medium: "TEXT", text: "secret isolation fixture" });

      const unauthorized = await fetch(streamAddress.streamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: CLIENT_ORIGIN,
          "x-interview-client-token": "invalid-client-token-that-is-long-enough"
        },
        body: JSON.stringify({
          protocolVersion: 1,
          type: "ATTACH_RENDERER_STREAM",
          sessionId
        })
      });
      const unauthorizedText = await unauthorized.text();

      const renderer = new RendererClient({
        sessionId,
        acknowledgementSender: { send: async () => undefined },
        textPresenter: { presentText: () => undefined },
        audioPlayer: { playAudio: () => undefined }
      });

      const serialized = JSON.stringify({
        events: store.load(sessionId),
        publishWithoutClient: await streamServer.publishDelivery(sessionId, atom.deliveryId),
        rendererState: renderer.snapshot(),
        unauthorizedText
      });

      expect(serialized).not.toContain(CLIENT_TOKEN);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

async function queueDelivery(
  writer: ReturnType<SessionRuntimeRegistry["get"]>,
  content: DeliveryAtom["content"],
  disclosureIds: readonly DisclosureId[] = []
): Promise<DeliveryAtom> {
  const atom = DeliveryAtomSchema.parse({
    deliveryId: newDeliveryId(),
    generationId: newGenerationId(),
    content,
    disclosureIds,
    effectiveDisclosureLevel: 0,
    status: "VALIDATED"
  });
  await writer.execute(
    createCommandEnvelope({ sessionId: writer.sessionId, producer: "renderer-transport-test-fixture" }),
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
  const response = await postAcknowledgement(address, {
    protocolVersion: 1,
    type: "GET_SESSION_SUMMARY",
    requestId: newRequestId(),
    sessionId
  });
  if (!response.ok) throw new Error("Failed to prime authenticated command runtime");
}

async function postAcknowledgement(
  address: BoundLoopbackAddress,
  body: unknown,
  overrides: { readonly token?: string; readonly origin?: string } = {}
): Promise<Response> {
  return fetch(`${address.url}/v1/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: overrides.origin ?? CLIENT_ORIGIN,
      "x-interview-client-token": overrides.token ?? CLIENT_TOKEN
    },
    body: JSON.stringify(body)
  });
}

function authenticatedHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: CLIENT_ORIGIN,
    "x-interview-client-token": CLIENT_TOKEN
  };
}

const fetchWithAuth: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("origin", CLIENT_ORIGIN);
  headers.set("x-interview-client-token", CLIENT_TOKEN);
  return fetch(input, { ...init, headers });
};

async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for renderer transport condition");
}

function deliveryLifecycle(
  events: ReturnType<SqliteEventStore["load"]>,
  deliveryId: DeliveryId
): string[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case "DELIVERY_QUEUED":
        return event.payload.atom.deliveryId === deliveryId ? [event.type] : [];
      case "DELIVERY_STARTED":
      case "DELIVERY_EXPOSED":
      case "DELIVERY_COMPLETED":
      case "DELIVERY_CANCELLED":
      case "DELIVERY_POSSIBLY_EXPOSED":
        return event.payload.deliveryId === deliveryId ? [event.type] : [];
      default:
        return [];
    }
  });
}

import { afterEach, describe, expect, it } from "vitest";
import {
  newSessionId,
  type DeliveryId,
  type SessionId
} from "../packages/domain/src/index.js";
import { replaySession } from "../packages/events/src/index.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import {
  RendererClient,
  type TextPresenter
} from "../apps/web/src/renderer-client.js";
import {
  consumeAuthenticatedRendererStream,
  createLoopbackAcknowledgementSender
} from "../apps/web/src/renderer-stream.js";
import { createAndStartServer } from "../apps/server/src/server.js";

const TEST_CLIENT_TOKEN = "executable_server_test_token_min_32_chars_long_001";
const TEST_ORIGIN = "http://127.0.0.1:5173";

describe("Executable Server Orchestration & End-to-End Delivery", () => {
  let serverInstance: Awaited<ReturnType<typeof createAndStartServer>> | undefined;

  afterEach(async () => {
    if (serverInstance !== undefined) {
      await serverInstance.stop();
      serverInstance = undefined;
    }
  });

  it("boots loopback server, authenticates client, and orchestrates end-to-end typed turn with SSE delivery and ACKs", async () => {
    serverInstance = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0, // Ephemeral
      rendererStreamPort: 0, // Ephemeral
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [TEST_ORIGIN],
      databasePath: ":memory:"
    });

    const commandUrl = serverInstance.bound.command.url;
    const streamUrl = serverInstance.bound.rendererStream.streamUrl;

    const authenticatedFetch: typeof fetch = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", TEST_ORIGIN);
      headers.set("x-interview-client-token", TEST_CLIENT_TOKEN);
      return fetch(input, { ...init, headers });
    };

    const commandClient = new BrowserCommandClient({
      baseUrl: commandUrl,
      clientToken: TEST_CLIENT_TOKEN,
      fetchImpl: authenticatedFetch
    });

    const sessionId: SessionId = newSessionId();

    // 1. Start Session
    const startResult = await commandClient.startSession(sessionId);
    expect(startResult.ok).toBe(true);
    expect(startResult.sessionId).toBe(sessionId);

    // 2. Connect Renderer Stream Client (SSE)
    const presentedTexts: Array<{ text: string; deliveryId: DeliveryId }> = [];
    const textPresenter: TextPresenter = {
      presentText: (text, deliveryId) => {
        presentedTexts.push({ text, deliveryId });
      }
    };

    const ackSender = createLoopbackAcknowledgementSender({
      commandUrl: `${commandUrl}/v1/commands`,
      authenticatedFetch
    });

    const rendererClient = new RendererClient({
      sessionId,
      acknowledgementSender: ackSender,
      textPresenter,
      audioPlayer: {
        playAudio: async ({ callbacks }) => {
          await callbacks.onStarted();
          await callbacks.onCompleted();
        }
      }
    });

    const streamAbortController = new AbortController();
    const streamPromise = consumeAuthenticatedRendererStream(
      {
        streamUrl,
        sessionId,
        authenticatedFetch,
        signal: streamAbortController.signal
      },
      rendererClient
    );

    // Wait slightly for SSE connection to register
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 3. Commit typed student reasoning input
    const studentInput = "Let the six people be vertices of K_6. Pick vertex A with 5 incident edges. By the Pigeonhole Principle, at least three must have the same color, say red.";
    const inputResult = await commandClient.commitTypedInput(sessionId, studentInput);
    expect(inputResult.ok).toBe(true);
    expect(inputResult.turnId).toBeDefined();

    // 4. Wait for SSE delivery to arrive and be acknowledged
    const startTime = Date.now();
    while (presentedTexts.length === 0 && Date.now() - startTime < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(presentedTexts.length).toBeGreaterThanOrEqual(1);
    const delivered = presentedTexts[0];
    expect(delivered).toBeDefined();
    expect(delivered?.text).toContain("vertex A");

    // Allow ACK loop to flush to server
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 5. Check session summary reflects completed delivery
    const summary = await commandClient.getSessionSummary(sessionId);
    expect(summary.started).toBe(true);
    expect(summary.deliveryStatuses[delivered?.deliveryId as DeliveryId]).toBe("COMPLETED");

    // 6. Abort stream cleanly
    streamAbortController.abort();
    await streamPromise.catch(() => undefined);

    // 7. Verify replay purity from the SQLite event store
    const events = serverInstance.store.load(sessionId);
    expect(events.length).toBeGreaterThan(5);

    const replayed = replaySession(sessionId, events);
    const liveState = serverInstance.registry.get(sessionId).getState();
    expect(replayed).toEqual(liveState);
  });

  it("enforces loopback origin protection and client token authorization", async () => {
    serverInstance = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [TEST_ORIGIN],
      databasePath: ":memory:"
    });

    const commandUrl = `${serverInstance.bound.command.url}/v1/commands`;

    // 1. Rejected Origin
    const forbiddenOriginRes = await fetch(commandUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "http://malicious-website.com",
        "x-interview-client-token": TEST_CLIENT_TOKEN
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: "req_bad_origin",
        type: "START_SESSION",
        sessionId: newSessionId()
      })
    });
    expect(forbiddenOriginRes.status).toBe(403);

    // 2. Unauthorized token
    const unauthorizedRes = await fetch(commandUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": TEST_ORIGIN,
        "x-interview-client-token": "wrong_token_1234567890123456789012345"
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: "req_bad_token",
        type: "START_SESSION",
        sessionId: newSessionId()
      })
    });
    expect(unauthorizedRes.status).toBe(401);
  });
});

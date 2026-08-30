import { afterEach, describe, expect, it } from "vitest";
import {
  newSessionId,
  type DeliveryId,
  type RequestId,
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

  it("handles duplicate and concurrent COMMIT_TYPED_INPUT idempotently without duplicate generations", async () => {
    serverInstance = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [TEST_ORIGIN],
      databasePath: ":memory:"
    });

    const commandUrl = serverInstance.bound.command.url;
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
    await commandClient.startSession(sessionId);

    // Send concurrent duplicate requests with same requestId
    const dupRequestId = "req_dup_1" as RequestId;
    const [res1, res2] = await Promise.all([
      commandClient.commitTypedInput(sessionId, "Step 1: Vertices of K_6", {
        requestId: dupRequestId
      }),
      commandClient.commitTypedInput(sessionId, "Step 1: Vertices of K_6", {
        requestId: dupRequestId
      })
    ]);

    expect(res1.turnId).toBe(res2.turnId);
    expect(res1.inputEpisodeId).toBe(res2.inputEpisodeId);

    // Wait for orchestration
    await new Promise((resolve) => setTimeout(resolve, 200));

    const state = serverInstance.registry.get(sessionId).getState();
    const generationsForTurn = Object.values(state.generations).filter(
      (g) => g.basis.turnId === res1.turnId
    );
    expect(generationsForTurn.length).toBeLessThanOrEqual(1);
  });

  it("recovers un-orchestrated turns after simulated crash between input commit and generation", async () => {
    const dbPath = ":memory:";
    serverInstance = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [TEST_ORIGIN],
      databasePath: dbPath
    });

    const sessionId: SessionId = newSessionId();
    const writer = serverInstance.registry.get(sessionId);
    const { TurnCoordinator } = await import("../packages/interview-engine/src/index.js");
    const { sixPeopleProblem } = await import("../packages/problems/src/index.js");

    const turns = new TurnCoordinator(writer);
    await turns.startSession(sixPeopleProblem);

    // Simulate crash after input commit: turn committed into event store, but server crashed before generation start
    const { turnId } = await turns.commitInput("Student reasoned before crash");
    expect(turnId).toBeDefined();

    const stateBeforeRecovery = writer.getState();
    expect(Object.keys(stateBeforeRecovery.generations)).toHaveLength(0);

    // Now trigger orchestrator recovery
    await serverInstance.runtime.orchestrator.recoverPendingTurns(sessionId);

    // Wait for generation to complete
    await new Promise((resolve) => setTimeout(resolve, 150));

    const stateAfterRecovery = writer.getState();
    expect(Object.keys(stateAfterRecovery.generations).length).toBeGreaterThanOrEqual(1);
  });

  it("persists all events and recovers exact session state across server process close and reopen with file-backed SQLite", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "interview-sqlite-test-"));
    const dbFile = path.join(tempDir, "test-session.sqlite");

    try {
      // 1. First server instance
      const server1 = await createAndStartServer({
        host: "127.0.0.1",
        commandPort: 0,
        rendererStreamPort: 0,
        clientToken: TEST_CLIENT_TOKEN,
        allowedOrigins: [TEST_ORIGIN],
        databasePath: dbFile
      });

      const client1 = new BrowserCommandClient({
        baseUrl: server1.bound.command.url,
        clientToken: TEST_CLIENT_TOKEN,
        fetchImpl: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("Origin", TEST_ORIGIN);
          headers.set("x-interview-client-token", TEST_CLIENT_TOKEN);
          return fetch(input, { ...init, headers });
        }
      });

      const sessionId: SessionId = newSessionId();
      await client1.startSession(sessionId);
      await client1.commitTypedInput(sessionId, "Step 1 on persistent disk");

      // Wait for turn to orchestrate and persist
      await new Promise((resolve) => setTimeout(resolve, 150));

      const state1 = server1.registry.get(sessionId).getState();
      expect(state1.started).toBe(true);

      // Stop first server
      await server1.stop();

      // 2. Second server instance reopening the exact same sqlite file
      const server2 = await createAndStartServer({
        host: "127.0.0.1",
        commandPort: 0,
        rendererStreamPort: 0,
        clientToken: TEST_CLIENT_TOKEN,
        allowedOrigins: [TEST_ORIGIN],
        databasePath: dbFile
      });

      const client2 = new BrowserCommandClient({
        baseUrl: server2.bound.command.url,
        clientToken: TEST_CLIENT_TOKEN,
        fetchImpl: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("Origin", TEST_ORIGIN);
          headers.set("x-interview-client-token", TEST_CLIENT_TOKEN);
          return fetch(input, { ...init, headers });
        }
      });

      const summary = await client2.getSessionSummary(sessionId);
      expect(summary.started).toBe(true);
      expect(summary.sequence).toBe(state1.sequence);

      const state2 = server2.registry.get(sessionId).getState();
      expect(state2).toEqual(state1);

      await server2.stop();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  newSessionId,
  type LocalTransportSecurity
} from "../packages/domain/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { SessionRuntimeRegistry } from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { LocalInterviewTransportRuntime } from "../apps/server/src/local-interview-transport-runtime.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import {
  RendererClient,
  type AudioPlayer,
  type TextPresenter
} from "../apps/web/src/renderer-client.js";
import {
  consumeAuthenticatedRendererStream,
  createLoopbackAcknowledgementSender
} from "../apps/web/src/renderer-stream.js";

describe("Durable Local Session Lifecycle & Restart Recovery", () => {
  it("persists, recovers, resumes, completes, and archives sessions across server restarts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "interview-durable-session-"));
    const dbPath = path.join(tmpDir, "session.sqlite");
    const clientToken = "test_token_with_more_than_32_characters_12345";
    const origin = "http://127.0.0.1:5173";

    const createAuthenticatedFetch = (reqOrigin: string) => {
      return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        if (!headers.has("origin")) {
          headers.set("origin", reqOrigin);
        }
        if (!headers.has("x-interview-client-token")) {
          headers.set("x-interview-client-token", clientToken);
        }
        return fetch(input, { ...init, headers });
      };
    };

    const authenticatedFetch = createAuthenticatedFetch(origin);

    const security: LocalTransportSecurity = {
      host: "127.0.0.1",
      clientToken,
      allowedOrigins: new Set([origin])
    };

    const sid = newSessionId();

    // -------------------------------------------------------------
    // Epoch 1: Initial server lifecycle & session start
    // -------------------------------------------------------------
    const store1 = new SqliteEventStore(dbPath);
    const registry1 = new SessionRuntimeRegistry(store1);
    const runtime1 = new LocalInterviewTransportRuntime({
      security,
      registry: registry1,
      store: store1
    });

    const bound1 = await runtime1.start();

    const client1 = new BrowserCommandClient({
      baseUrl: bound1.command.url,
      clientToken,
      fetchImpl: authenticatedFetch
    });

    const startRes = await client1.startSession(sid);
    expect(startRes.ok).toBe(true);
    expect(startRes.sessionId).toBe(sid);

    const input1 = await client1.commitTypedInput(
      sid,
      "Let V = {v1, v2, v3, v4, v5, v6}. By Pigeonhole Principle, v1 has >= 3 edges of same color."
    );
    expect(input1.ok).toBe(true);
    await runtime1.orchestrator.waitForAll();
    await registry1.get(sid).waitForIdle();

    const summary1 = await client1.getSessionSummary(sid);
    expect(summary1.started).toBe(true);
    const endEpoch1Sequence = summary1.sequence;
    expect(endEpoch1Sequence).toBeGreaterThanOrEqual(6);

    const sessionList1 = await client1.listSessions();
    expect(sessionList1.length).toBe(1);
    expect(sessionList1[0]?.sessionId).toBe(sid);
    expect(sessionList1[0]?.status).toBe("ACTIVE");
    expect(sessionList1[0]?.sequence).toBe(endEpoch1Sequence);

    // Gracefully shut down Epoch 1
    await runtime1.stop();
    store1.close();

    // -------------------------------------------------------------
    // Epoch 2: Server restart against identical SQLite file
    // -------------------------------------------------------------
    const store2 = new SqliteEventStore(dbPath);
    const registry2 = new SessionRuntimeRegistry(store2);
    const runtime2 = new LocalInterviewTransportRuntime({
      security,
      registry: registry2,
      store: store2
    });

    const bound2 = await runtime2.start();

    const client2 = new BrowserCommandClient({
      baseUrl: bound2.command.url,
      clientToken,
      fetchImpl: authenticatedFetch
    });

    // 1. Verify session enumeration on fresh server
    const sessionList2 = await client2.listSessions();
    expect(sessionList2.length).toBe(1);
    expect(sessionList2[0]?.sessionId).toBe(sid);
    expect(sessionList2[0]?.problemId).toBe(sixPeopleProblem.id);
    expect(sessionList2[0]?.status).toBe("ACTIVE");
    expect(sessionList2[0]?.sequence).toBe(endEpoch1Sequence);

    // 2. Resume session
    const resumeRes = await client2.resumeSession(sid);
    expect(resumeRes.ok).toBe(true);
    expect(resumeRes.sessionId).toBe(sid);
    expect(resumeRes.started).toBe(true);
    expect(resumeRes.status).toBe("ACTIVE");
    expect(resumeRes.sequence).toBe(endEpoch1Sequence + 1); // +1 from SESSION_RESUMED event

    // 3. Connect Renderer Stream to verify reconnect
    const receivedTexts: string[] = [];
    const textPresenter: TextPresenter = {
      presentText: (text: string) => {
        receivedTexts.push(text);
      }
    };
    const audioPlayer: AudioPlayer = {
      playAudio: (input) => {
        void input.callbacks.onStarted();
        void input.callbacks.onCompleted();
      }
    };
    const acknowledgementSender = createLoopbackAcknowledgementSender({
      commandUrl: `${bound2.command.url}/v1/commands`,
      authenticatedFetch
    });
    const rendererClient = new RendererClient({
      sessionId: sid,
      acknowledgementSender,
      audioPlayer,
      textPresenter
    });

    const streamAbort = new AbortController();
    const streamPromise = consumeAuthenticatedRendererStream(
      {
        streamUrl: bound2.rendererStream.streamUrl,
        sessionId: sid,
        authenticatedFetch,
        signal: streamAbort.signal
      },
      rendererClient
    );

    // 4. Submit reasoning turn in resumed session
    const input2 = await client2.commitTypedInput(
      sid,
      "Assume without loss of generality that edges (v1,v2), (v1,v3), (v1,v4) are all red."
    );
    expect(input2.ok).toBe(true);
    await runtime2.orchestrator.waitForAll();
    await registry2.get(sid).waitForIdle();

    // 5. Complete session
    const completeRes = await client2.completeSession(sid, "Proof completed successfully.");
    expect(completeRes.ok).toBe(true);
    expect(completeRes.sessionId).toBe(sid);

    // 6. Archive session
    const archiveRes = await client2.archiveSession(sid, "Archived for long-term audit.");
    expect(archiveRes.ok).toBe(true);
    expect(archiveRes.sessionId).toBe(sid);

    // 7. Verify session list shows archived
    const sessionList3 = await client2.listSessions();
    expect(sessionList3.length).toBe(1);
    expect(sessionList3[0]?.status).toBe("ARCHIVED");

    // Clean up
    streamAbort.abort();
    await streamPromise;
    await runtime2.stop();
    store2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

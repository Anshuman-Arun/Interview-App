import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  newDeliveryId,
  newRequestId,
  newSessionId,
  type LocalTransportSecurity,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope,
  type SessionWriter
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { LocalInterviewTransportRuntime } from "../apps/server/src/local-interview-transport-runtime.js";
import { SessionRecoveryCoordinator } from "../apps/server/src/session-recovery-coordinator.js";

interface StoreWithDatabase {
  readonly database: DatabaseSync;
}

function liveWriterCount(writers: ReadonlySet<SessionWriter>): number {
  return [...writers].filter((writer) => !writer.isClosed()).length;
}

describe("durable session repair regressions", () => {
  it("rejects semantically invalid event drafts before authoritative persistence", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sessionId = newSessionId();
    const writer = registry.get(sessionId);
    const deliveryId = newDeliveryId();
    const requestId = newRequestId();
    const envelope = createCommandEnvelope({
      sessionId,
      requestId,
      producer: "repair-regression"
    });

    await expect(writer.execute(
      envelope,
      { operation: "START_DELIVERY", payload: { deliveryId } },
      z.literal(true),
      () => ({
        drafts: [{
          source: "APPLICATION",
          type: "DELIVERY_STARTED",
          payload: { deliveryId }
        }],
        result: true as const
      })
    )).rejects.toThrow(/Unknown delivery/u);

    expect(store.eventCount(sessionId)).toBe(0);
    expect(store.getProcessedResult(sessionId, requestId)).toEqual({ found: false });
    expect(writer.getState().sequence).toBe(0);

    await expect(new TurnCoordinator(writer).startSession(sixPeopleProblem))
      .resolves.toBeUndefined();
    expect(store.eventCount(sessionId)).toBe(2);

    await registry.closeAll();
    store.close();
  });

  it("never creates a second writer when getAsync is immediately followed by get", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sessionId = newSessionId();

    const opening = registry.getAsync(sessionId);
    expect(() => registry.get(sessionId)).toThrow(/opening/u);

    const writer = await opening;
    expect(registry.get(sessionId)).toBe(writer);
    expect(registry.getActiveSessionIds()).toEqual([sessionId]);

    await registry.closeAll();
    store.close();
  });

  it("returns the synchronous writer to every concurrent getAsync caller", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sessionId = newSessionId();

    const writer = registry.get(sessionId);
    const asyncWriters = await Promise.all(
      Array.from({ length: 12 }, async () => registry.getAsync(sessionId))
    );

    expect(asyncWriters.every((candidate) => candidate === writer)).toBe(true);
    expect(registry.getActiveSessionIds()).toEqual([sessionId]);

    await registry.closeAll();
    store.close();
  });

  it("serializes opening against close and returns only the reopened writer", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sessionId = newSessionId();
    const observed = new Set<SessionWriter>();

    const opening = registry.getAsync(sessionId).then((writer) => {
      observed.add(writer);
      return writer;
    });
    const closing = registry.close(sessionId);
    const reopening = registry.getAsync(sessionId).then((writer) => {
      observed.add(writer);
      return writer;
    });

    const [firstObserved, reopened] = await Promise.all([opening, reopening]);
    await closing;

    expect(firstObserved).toBe(reopened);
    expect(reopened.isClosed()).toBe(false);
    expect(liveWriterCount(observed)).toBe(1);
    expect(registry.get(sessionId)).toBe(reopened);

    await registry.closeAll();
    store.close();
  });

  it("serializes close against reopen, drains admitted work, and replays identical state", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sessionId = newSessionId();
    const original = registry.get(sessionId);
    const turns = new TurnCoordinator(original);

    await turns.startSession(sixPeopleProblem);
    const admitted = turns.commitInput("A durable reasoning step");
    const closing = registry.close(sessionId);
    const reopening = registry.getAsync(sessionId);

    await admitted;
    await closing;
    const before = JSON.parse(JSON.stringify(original.getState())) as unknown;
    const reopened = await reopening;

    expect(reopened).not.toBe(original);
    expect(original.isClosed()).toBe(true);
    expect(reopened.isClosed()).toBe(false);
    expect(reopened.getState()).toEqual(before);

    await registry.closeAll();
    store.close();
  });

  it("maintains at most one observable live writer under deterministic mixed registry operations", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sessionId = newSessionId();
    const observed = new Set<SessionWriter>();
    let state = 0x5eed1234;

    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };

    for (let index = 0; index < 160; index += 1) {
      const operation = next() % 5;
      if (operation === 0) {
        await registry.close(sessionId);
        const pending = registry.getAsync(sessionId);
        expect(() => registry.get(sessionId)).toThrow(/opening|closing/u);
        observed.add(await pending);
      } else if (operation === 1) {
        const writer = registry.get(sessionId);
        observed.add(writer);
        const peers = await Promise.all([
          registry.getAsync(sessionId),
          registry.getAsync(sessionId),
          registry.getAsync(sessionId)
        ]);
        peers.forEach((peer) => observed.add(peer));
        expect(peers.every((peer) => peer === writer)).toBe(true);
      } else if (operation === 2) {
        const writer = await registry.getAsync(sessionId);
        observed.add(writer);
        const closing = registry.close(sessionId);
        const reopening = registry.getAsync(sessionId);
        await closing;
        observed.add(await reopening);
      } else if (operation === 3) {
        const opening = registry.getAsync(sessionId);
        const closing = registry.close(sessionId);
        const reopening = registry.getAsync(sessionId);
        observed.add(await opening);
        await closing;
        observed.add(await reopening);
      } else {
        await registry.close(sessionId);
        const reopened = registry.get(sessionId);
        observed.add(reopened);
      }

      expect(liveWriterCount(observed)).toBeLessThanOrEqual(1);
      expect(registry.getActiveSessionIds().length).toBeLessThanOrEqual(1);
    }

    await registry.closeAll();
    expect(liveWriterCount(observed)).toBe(0);
    store.close();
  });

  it("closeAll blocks new admission while draining and leaves no live writer", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const first = registry.get(newSessionId());
    const secondId = newSessionId();
    const secondOpening = registry.getAsync(secondId);
    const closingAll = registry.closeAll();

    expect(() => registry.get(newSessionId())).toThrow(/closing all/u);
    await expect(registry.getAsync(newSessionId())).rejects.toThrow(/closing all/u);

    await secondOpening.catch(() => undefined);
    await closingAll;
    expect(first.isClosed()).toBe(true);
    expect(registry.getActiveSessionIds()).toEqual([]);

    const reusable = registry.get(newSessionId());
    expect(reusable.isClosed()).toBe(false);
    await registry.closeAll();
    store.close();
  });

  it("clears a failed asynchronous opening instead of permanently poisoning the session entry", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sessionId = newSessionId();
    const originalLoad = store.load.bind(store);
    let failNextLoad = true;

    store.load = (candidateSessionId) => {
      if (failNextLoad) {
        failNextLoad = false;
        throw new Error("synthetic open failure");
      }
      return originalLoad(candidateSessionId);
    };

    await expect(registry.getAsync(sessionId)).rejects.toThrow("synthetic open failure");
    expect(registry.getActiveSessionIds()).toEqual([]);

    const recovered = await registry.getAsync(sessionId);
    expect(recovered.isClosed()).toBe(false);
    expect(registry.get(sessionId)).toBe(recovered);

    await registry.closeAll();
    store.close();
  });

  it("keeps the closeAll admission barrier until every close settles even when one close fails", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const first = registry.get(newSessionId());
    const second = registry.get(newSessionId());

    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    first.close = async () => {
      throw new Error("synthetic close failure");
    };
    second.close = async () => {
      await secondGate;
    };

    const closingAll = registry.closeAll();
    await Promise.resolve();

    expect(() => registry.get(newSessionId())).toThrow(/closing all/u);
    await expect(registry.getAsync(newSessionId())).rejects.toThrow(/closing all/u);

    let settled = false;
    void closingAll.then(
      () => { settled = true; },
      () => { settled = true; }
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSecond();
    await expect(closingAll).rejects.toThrow(/failed to close/u);
    expect(registry.getActiveSessionIds()).toEqual([]);

    const reusable = registry.get(newSessionId());
    expect(reusable.isClosed()).toBe(false);
    await registry.closeAll();
    store.close();
  });

  it("serves authoritative listing and history without creating a read-only writer", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sessionId = newSessionId();
    const writer = registry.get(sessionId);
    const turns = new TurnCoordinator(writer);

    await turns.startSession(sixPeopleProblem);
    await turns.commitInput("Persist this student turn.");
    await registry.close(sessionId);
    expect(registry.getActiveSessionIds()).toEqual([]);

    const sessions = new SessionRecoveryCoordinator(registry);
    expect(sessions.listSessions()).toHaveLength(1);
    expect(sessions.listSessions()[0]?.sessionId).toBe(sessionId);

    const history = sessions.getHistory(sessionId);
    expect(history.some((entry) => entry.role === "STUDENT" && entry.text === "Persist this student turn.")).toBe(true);
    expect(registry.getActiveSessionIds()).toEqual([]);

    store.close();
  });

  it("serializes transport start against stop so a late start cannot resurrect a stopped runtime", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const origin = "http://127.0.0.1:5173";
    const security: LocalTransportSecurity = {
      host: "127.0.0.1",
      clientToken: "transport_race_test_token_with_32_chars",
      allowedOrigins: new Set([origin])
    };
    const runtime = new LocalInterviewTransportRuntime({ security, registry, store });
    const originalRendererStart = runtime.rendererStreamServer.start.bind(runtime.rendererStreamServer);

    let rendererStartEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      rendererStartEntered = resolve;
    });
    let releaseRendererStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRendererStart = resolve;
    });

    runtime.rendererStreamServer.start = async () => {
      rendererStartEntered();
      await gate;
      return originalRendererStart();
    };

    const starting = runtime.start();
    await entered;
    const stopping = runtime.stop();

    releaseRendererStart();
    await starting;
    await stopping;

    const restarted = await runtime.start();
    const probe = await fetch(`${restarted.command.url}/v1/commands`, {
      method: "OPTIONS",
      headers: { origin }
    });
    expect(probe.status).toBe(204);

    await runtime.stop();
    store.close();
  });

  it("preserves renderer-start and command-rollback failures together", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const security: LocalTransportSecurity = {
      host: "127.0.0.1",
      clientToken: "startup_rollback_failure_token_with_32_chars",
      allowedOrigins: new Set(["http://127.0.0.1:5173"])
    };
    const runtime = new LocalInterviewTransportRuntime({ security, registry, store });

    const rendererStart = vi.spyOn(runtime.rendererStreamServer, "start")
      .mockRejectedValueOnce(new Error("synthetic renderer start failure"));
    const originalCommandStop = runtime.commandServer.stop.bind(runtime.commandServer);
    const commandStop = vi.spyOn(runtime.commandServer, "stop")
      .mockRejectedValueOnce(new Error("synthetic command rollback failure"))
      .mockImplementation(() => originalCommandStop());

    let caught: unknown;
    try {
      await runtime.start();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) {
      throw new Error("Expected aggregate startup failure");
    }
    expect(caught.errors.map((error) => String(error))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("synthetic renderer start failure"),
        expect.stringContaining("synthetic command rollback failure")
      ])
    );

    rendererStart.mockRestore();
    await runtime.stop();
    commandStop.mockRestore();
    store.close();
  });

  it("blocks restart after partial shutdown failure until cleanup succeeds", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const origin = "http://127.0.0.1:5173";
    const security: LocalTransportSecurity = {
      host: "127.0.0.1",
      clientToken: "partial_shutdown_retry_token_with_32_chars",
      allowedOrigins: new Set([origin])
    };
    const runtime = new LocalInterviewTransportRuntime({ security, registry, store });
    const firstBound = await runtime.start();

    const originalCloseAll = registry.closeAll.bind(registry);
    const closeAllSpy = vi.spyOn(registry, "closeAll")
      .mockRejectedValueOnce(new Error("synthetic registry shutdown failure"))
      .mockImplementation(() => originalCloseAll());

    await expect(runtime.stop()).rejects.toThrow(/Local interview transport shutdown failed/u);
    await expect(runtime.start()).rejects.toThrow(/cannot restart after a failed shutdown/u);

    await expect(runtime.stop()).resolves.toBeUndefined();
    const secondBound = await runtime.start();
    expect(secondBound.command.url).not.toBe("");
    expect(secondBound.rendererStream.streamUrl).not.toBe("");
    expect(secondBound).not.toBe(firstBound);

    await runtime.stop();
    closeAllSpy.mockRestore();
    store.close();
  });

  it("drains accepted orchestration before renderer and writer teardown", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const origin = "http://127.0.0.1:5173";
    const security: LocalTransportSecurity = {
      host: "127.0.0.1",
      clientToken: "shutdown_drain_test_token_with_32_chars",
      allowedOrigins: new Set([origin])
    };
    const runtime = new LocalInterviewTransportRuntime({ security, registry, store });
    const sessionId = newSessionId();
    const admittedWriter = registry.get(sessionId);
    await runtime.start();

    let drainEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      drainEntered = resolve;
    });
    let releaseDrain!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    runtime.orchestrator.waitForAll = async () => {
      drainEntered();
      await gate;
    };

    const originalRendererStop = runtime.rendererStreamServer.stop.bind(runtime.rendererStreamServer);
    let rendererStopped = false;
    runtime.rendererStreamServer.stop = async () => {
      rendererStopped = true;
      await originalRendererStop();
    };

    const stopping = runtime.stop();
    await entered;
    expect(rendererStopped).toBe(false);
    expect(registry.getActiveSessionIds()).toEqual([sessionId]);
    expect(admittedWriter.isClosed()).toBe(false);

    releaseDrain();
    await stopping;
    expect(rendererStopped).toBe(true);
    expect(admittedWriter.isClosed()).toBe(true);
    expect(registry.getActiveSessionIds()).toEqual([]);

    store.close();
  });

  it("timestamps lifecycle transitions when the serialized command commits", async () => {
    vi.useFakeTimers();
    try {
      const store = new SqliteEventStore(":memory:");
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const turns = new TurnCoordinator(registry.get(sessionId));

      vi.setSystemTime(new Date("2026-08-30T20:00:00.000Z"));
      await turns.startSession(sixPeopleProblem);

      const completing = turns.completeSession();
      vi.setSystemTime(new Date("2026-08-30T20:00:05.000Z"));
      const completed = await completing;
      expect(completed.completedAt).toBe("2026-08-30T20:00:05.000Z");

      const archiving = turns.archiveSession();
      vi.setSystemTime(new Date("2026-08-30T20:00:10.000Z"));
      const archived = await archiving;
      expect(archived.archivedAt).toBe("2026-08-30T20:00:10.000Z");

      await registry.closeAll();
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed for every unknown session command and renderer attachment without artifacts", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const origin = "http://127.0.0.1:5173";
    const token = "repair_test_client_token_with_at_least_32_chars";
    const security: LocalTransportSecurity = {
      host: "127.0.0.1",
      clientToken: token,
      allowedOrigins: new Set([origin])
    };
    const runtime = new LocalInterviewTransportRuntime({ security, registry, store });
    const bound = await runtime.start();
    const sessionId = newSessionId();
    const deliveryId = newDeliveryId();

    const post = async (body: unknown, url = `${bound.command.url}/v1/commands`): Promise<Response> =>
      fetch(url, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-interview-client-token": token
        },
        body: JSON.stringify(body)
      });

    const commands: readonly Record<string, unknown>[] = [
      { protocolVersion: 1, requestId: newRequestId(), sessionId, type: "RESUME_SESSION" },
      { protocolVersion: 1, requestId: newRequestId(), sessionId, type: "COMPLETE_SESSION" },
      { protocolVersion: 1, requestId: newRequestId(), sessionId, type: "ARCHIVE_SESSION" },
      { protocolVersion: 1, requestId: newRequestId(), sessionId, type: "COMMIT_TYPED_INPUT", text: "phantom" },
      { protocolVersion: 1, requestId: newRequestId(), sessionId, type: "GET_SESSION_SUMMARY" },
      { protocolVersion: 1, requestId: newRequestId(), sessionId, type: "RECONNECT_DELIVERY", deliveryId },
      { protocolVersion: 1, requestId: newRequestId(), sessionId, type: "ACK_DELIVERY_EXPOSED", deliveryId },
      { protocolVersion: 1, requestId: newRequestId(), sessionId, type: "ACK_DELIVERY_COMPLETED", deliveryId }
    ];

    for (const command of commands) {
      const response = await post(command);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" }
      });
      expect(registry.getActiveSessionIds()).toEqual([]);
      expect(store.eventCount(sessionId)).toBe(0);
    }

    const streamResponse = await post(
      { protocolVersion: 1, type: "ATTACH_RENDERER_STREAM", sessionId },
      bound.rendererStream.streamUrl
    );
    expect(streamResponse.status).toBe(404);
    await expect(streamResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" }
    });
    expect(runtime.rendererStreamServer.activeConnectionCount()).toBe(0);
    expect(registry.getActiveSessionIds()).toEqual([]);

    const database = (store as unknown as StoreWithDatabase).database;
    const processed = database.prepare(
      "SELECT COUNT(*) AS count FROM processed_requests WHERE session_id = ?"
    ).get(sessionId) as { count: number };
    const projection = database.prepare(
      "SELECT COUNT(*) AS count FROM session_index WHERE session_id = ?"
    ).get(sessionId) as { count: number };
    expect(processed.count).toBe(0);
    expect(projection.count).toBe(0);
    expect((runtime.sessions as unknown as { recoveries: Map<SessionId, unknown> }).recoveries.size).toBe(0);

    await runtime.stop();
    store.close();
  });

  it("rejects an unsupported requested problem before creating a session runtime or event", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const origin = "http://127.0.0.1:5173";
    const token = "problem_admission_test_token_with_at_least_32_chars";
    const security: LocalTransportSecurity = {
      host: "127.0.0.1",
      clientToken: token,
      allowedOrigins: new Set([origin])
    };
    const runtime = new LocalInterviewTransportRuntime({ security, registry, store });
    const bound = await runtime.start();
    const sessionId = newSessionId();

    const response = await fetch(`${bound.command.url}/v1/commands`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-interview-client-token": token
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: newRequestId(),
        sessionId,
        type: "START_SESSION",
        problemId: "not-a-real-problem"
      })
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      protocolVersion: 1,
      ok: false,
      error: { code: "NOT_FOUND" }
    });
    expect(store.hasSession(sessionId)).toBe(false);
    expect(store.eventCount(sessionId)).toBe(0);
    expect(registry.getActiveSessionIds()).toEqual([]);

    await runtime.stop();
    store.close();
  });

  it("returns a typed protocol conflict for RequestId reuse with a different command", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const origin = "http://127.0.0.1:5173";
    const token = "request_conflict_test_token_with_at_least_32_chars";
    const security: LocalTransportSecurity = {
      host: "127.0.0.1",
      clientToken: token,
      allowedOrigins: new Set([origin])
    };
    const runtime = new LocalInterviewTransportRuntime({ security, registry, store });
    const bound = await runtime.start();
    const sessionId = newSessionId();
    const requestId = newRequestId();

    const post = async (body: unknown): Promise<Response> =>
      fetch(`${bound.command.url}/v1/commands`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-interview-client-token": token
        },
        body: JSON.stringify(body)
      });

    const started = await post({
      protocolVersion: 1,
      requestId,
      sessionId,
      type: "START_SESSION"
    });
    expect(started.status).toBe(200);

    const conflict = await post({
      protocolVersion: 1,
      requestId,
      sessionId,
      type: "COMMIT_TYPED_INPUT",
      text: "same request id, different command"
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      protocolVersion: 1,
      ok: false,
      error: { code: "CONFLICT" }
    });

    await runtime.stop();
    store.close();
  });

  it("enforces lifecycle admission before start, after completion, and after archive", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);

    const neverStartedId = newSessionId();
    const neverStarted = new TurnCoordinator(registry.get(neverStartedId));
    await expect(neverStarted.completeSession()).rejects.toThrow(/Cannot complete/u);
    await expect(neverStarted.archiveSession()).rejects.toThrow(/Cannot archive/u);
    await expect(neverStarted.commitInput("not started")).rejects.toThrow(/Cannot commit input/u);
    expect(store.eventCount(neverStartedId)).toBe(0);

    const completedId = newSessionId();
    const completedWriter = registry.get(completedId);
    const completed = new TurnCoordinator(completedWriter);
    await completed.startSession(sixPeopleProblem);
    await completed.completeSession();
    await expect(completed.commitInput("after completion")).rejects.toThrow(/Cannot commit input/u);
    await completed.archiveSession();
    await expect(completed.commitInput("after archive")).rejects.toThrow(/Cannot commit input/u);

    const duplicateId = newSessionId();
    const duplicate = new TurnCoordinator(registry.get(duplicateId));
    const requestId = newRequestId();
    const startEnvelope = createCommandEnvelope({
      sessionId: duplicateId,
      requestId,
      producer: "repair-regression"
    });
    await duplicate.startSession(sixPeopleProblem, startEnvelope);
    await expect(duplicate.startSession(sixPeopleProblem, startEnvelope)).resolves.toBeUndefined();
    const conflictEnvelope = createCommandEnvelope({
      sessionId: duplicateId,
      requestId,
      producer: "repair-regression"
    });
    await expect(duplicate.commitInput("conflicting reuse", conflictEnvelope)).rejects.toMatchObject({
      code: "REQUEST_ID_CONFLICT"
    });

    await registry.closeAll();
    store.close();
  });
});

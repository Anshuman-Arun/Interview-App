import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  InterviewSessionConfigurationSchema,
  newRequestId,
  newSessionId
} from "../packages/domain/src/index.js";
import {
  CorruptEventStreamError,
  RequestIdConflictError,
  SqliteEventStore,
  StaleSessionWriterError
} from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  SessionRuntimeRegistry,
  SessionWriter,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";

interface StoreWithDatabase {
  readonly database: DatabaseSync;
}

describe("Durable Session Repository & Rebuildable Projection", () => {
  it("creates, enumerates, and reports session existence", async () => {
    const store = new SqliteEventStore(":memory:");
    const sid1 = newSessionId();
    const sid2 = newSessionId();

    expect(store.hasSession(sid1)).toBe(false);
    expect(store.hasSession(sid2)).toBe(false);
    expect(store.listSessionIds()).toEqual([]);
    expect(store.listSessions()).toEqual([]);

    const registry = new SessionRuntimeRegistry(store);
    const writer1 = registry.get(sid1);
    const turns1 = new TurnCoordinator(writer1);
    await turns1.startSession(sixPeopleProblem);

    expect(store.hasSession(sid1)).toBe(true);
    expect(store.hasSession(sid2)).toBe(false);
    expect(store.listSessionIds()).toEqual([sid1]);

    const sessions = store.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.sessionId).toBe(sid1);
    expect(sessions[0]?.problemId).toBe(sixPeopleProblem.id);
    expect(sessions[0]?.status).toBe("ACTIVE");
    expect(sessions[0]?.sequence).toBe(2);
    expect(sessions[0]?.eventCount).toBe(2);

    const writer2 = registry.get(sid2);
    const turns2 = new TurnCoordinator(writer2);
    await turns2.startSession(sixPeopleProblem);

    expect([...store.listSessionIds()].sort()).toEqual([sid1, sid2].sort());
    expect(store.listSessions().length).toBe(2);

    store.close();
  });

  it("does not let a stale writer masquerade as a successful duplicate retry", async () => {
    const store = new SqliteEventStore(":memory:");
    const sid = newSessionId();
    const writerA = SessionWriter.open(store, sid);
    const writerB = SessionWriter.open(store, sid);
    const envelope = createCommandEnvelope({
      sessionId: sid,
      producer: "stale-duplicate-regression"
    });
    const identity = {
      operation: "TEST_SESSION_START",
      payload: {}
    } as const;
    const configuration = InterviewSessionConfigurationSchema.parse({
      configurationVersion: 1,
      mode: "OXFORD_MATHEMATICS",
      problem: {
        id: sixPeopleProblem.id,
        version: sixPeopleProblem.version
      },
      difficulty: sixPeopleProblem.interviewer.difficulty,
      interventionPolicy: "BALANCED"
    });
    const execute = (writer: SessionWriter) => writer.execute(
      envelope,
      identity,
      z.literal(true),
      () => ({
        drafts: [{
          source: "APPLICATION" as const,
          type: "SESSION_STARTED" as const,
          payload: {
            startedAt: new Date().toISOString(),
            configuration
          }
        }],
        result: true as const
      })
    );

    await expect(execute(writerA)).resolves.toMatchObject({
      duplicate: false,
      appendedEventCount: 1,
      value: true
    });
    await expect(execute(writerB)).rejects.toBeInstanceOf(StaleSessionWriterError);
    expect(writerB.getState().sequence).toBe(0);
    expect(store.eventCount(sid)).toBe(1);

    await Promise.all([writerA.close(), writerB.close()]);
    store.close();
  });

  it("rejects stale writers before they can poison the authoritative event stream", async () => {
    const store = new SqliteEventStore(":memory:");
    const sid = newSessionId();
    const writerA = SessionWriter.open(store, sid);
    const writerB = SessionWriter.open(store, sid);

    await new TurnCoordinator(writerA).startSession(sixPeopleProblem);
    expect(store.eventCount(sid)).toBe(2);
    expect(writerA.getState().sequence).toBe(2);
    expect(writerB.getState().sequence).toBe(0);

    await expect(new TurnCoordinator(writerB).startSession(sixPeopleProblem))
      .rejects.toBeInstanceOf(StaleSessionWriterError);

    expect(store.eventCount(sid)).toBe(2);
    const replayed = SessionWriter.open(store, sid);
    expect(replayed.getState()).toEqual(writerA.getState());
    expect(replayed.getState().status).toBe("ACTIVE");

    await Promise.all([writerA.close(), writerB.close(), replayed.close()]);
    store.close();
  });

  it("fails closed on non-contiguous or corrupt event sequences", async () => {
    const store = new SqliteEventStore(":memory:");
    const sid = newSessionId();
    const registry = new SessionRuntimeRegistry(store);
    const writer = registry.get(sid);
    const turns = new TurnCoordinator(writer);
    await turns.startSession(sixPeopleProblem);

    const events = store.load(sid);
    expect(events.length).toBe(2);
    expect(events[0]?.sequence).toBe(1);
    expect(events[1]?.sequence).toBe(2);

    const db = (store as unknown as StoreWithDatabase).database;

    // Corrupt the sequence in sqlite directly: update sequence 2 to 3 in event_json and column (creating a gap)
    const row = db.prepare(
      "SELECT event_json FROM session_events WHERE session_id = ? AND sequence = 2"
    ).get(sid) as { event_json: string } | undefined;
    if (row === undefined) throw new Error("Row not found");
    const parsed = JSON.parse(row.event_json) as { sequence: number };
    parsed.sequence = 3;
    db.prepare(
      "UPDATE session_events SET sequence = 3, event_json = ? WHERE session_id = ? AND sequence = 2"
    ).run(JSON.stringify(parsed), sid);

    expect(() => store.load(sid)).toThrow(CorruptEventStreamError);

    // Now set it to sequence 0 in event_json and column (non-1 start)
    const row1 = db.prepare(
      "SELECT event_json FROM session_events WHERE session_id = ? AND sequence = 1"
    ).get(sid) as { event_json: string } | undefined;
    if (row1 === undefined) throw new Error("Row not found");
    const parsed1 = JSON.parse(row1.event_json) as { sequence: number };
    parsed1.sequence = 0;
    db.prepare(
      "UPDATE session_events SET sequence = 0, event_json = ? WHERE session_id = ? AND sequence = 1"
    ).run(JSON.stringify(parsed1), sid);

    expect(() => store.load(sid)).toThrow(CorruptEventStreamError);

    store.close();
  });

  it("rebuilds session index projection purely from authoritative session_events table", async () => {
    const store = new SqliteEventStore(":memory:");
    const sid = newSessionId();
    const registry = new SessionRuntimeRegistry(store);
    const writer = registry.get(sid);
    const turns = new TurnCoordinator(writer);

    await turns.startSession(sixPeopleProblem);
    await turns.commitInput("My reasoning step 1");
    await turns.completeSession(undefined, "Interview completed with full proof.");

    const initialSummary = store.listSessions();
    expect(initialSummary.length).toBe(1);
    expect(initialSummary[0]?.status).toBe("COMPLETED");
    expect(initialSummary[0]?.sequence).toBe(7);

    const db = (store as unknown as StoreWithDatabase).database;
    // Drop/wipe session_index projection completely. Reads repair it from the
    // authoritative stream rather than treating the cache as session truth.
    db.exec("DELETE FROM session_index;");
    const rebuiltSummary = store.listSessions();
    expect(rebuiltSummary.length).toBe(1);
    expect(rebuiltSummary[0]?.sessionId).toBe(sid);
    expect(rebuiltSummary[0]?.problemId).toBe(sixPeopleProblem.id);
    expect(rebuiltSummary[0]?.status).toBe("COMPLETED");
    expect(rebuiltSummary[0]?.sequence).toBe(7);
    expect(rebuiltSummary[0]?.eventCount).toBe(7);

    store.close();
  });

  it("ignores phantom projection rows when determining authoritative session existence", () => {
    const store = new SqliteEventStore(":memory:");
    const phantomSessionId = newSessionId();
    const db = (store as unknown as StoreWithDatabase).database;
    db.prepare(`
      INSERT INTO session_index
        (session_id, problem_id, problem_version, status, sequence, created_at, updated_at, event_count)
      VALUES (?, NULL, NULL, 'ACTIVE', 99, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 99)
    `).run(phantomSessionId);

    expect(store.hasSession(phantomSessionId)).toBe(false);
    expect(store.listSessionIds()).not.toContain(phantomSessionId);
    expect(store.listSessions()).toEqual([]);
    store.close();
  });

  it("commits authoritative events even when the projection cannot be updated", async () => {
    const store = new SqliteEventStore(":memory:");
    const sid = newSessionId();
    const db = (store as unknown as StoreWithDatabase).database;
    db.exec(`
      CREATE TRIGGER reject_projection_insert
      BEFORE INSERT ON session_index
      BEGIN
        SELECT RAISE(ABORT, 'projection unavailable');
      END;
    `);

    const registry = new SessionRuntimeRegistry(store);
    await expect(new TurnCoordinator(registry.get(sid)).startSession(sixPeopleProblem)).resolves.toBeUndefined();
    expect(store.load(sid)).toHaveLength(2);
    expect(store.hasSession(sid)).toBe(true);

    await registry.closeAll();
    store.close();
  });

  it("detects conflicting RequestId reuse across commands", async () => {
    const store = new SqliteEventStore(":memory:");
    const sid = newSessionId();
    const registry = new SessionRuntimeRegistry(store);
    const writer = registry.get(sid);
    const turns = new TurnCoordinator(writer);

    const sharedRequestId = newRequestId();
    const env1 = createCommandEnvelope({
      sessionId: sid,
      requestId: sharedRequestId,
      producer: "test"
    });

    await turns.startSession(sixPeopleProblem, env1);

    // Identical replay succeeds idempotently
    await expect(turns.startSession(sixPeopleProblem, env1)).resolves.toBeUndefined();

    // Conflicting reuse with different payload fails with RequestIdConflictError
    const env2 = createCommandEnvelope({
      sessionId: sid,
      requestId: sharedRequestId,
      producer: "test"
    });
    await expect(turns.commitInput("Different text", env2)).rejects.toThrow(RequestIdConflictError);

    store.close();
  });
});

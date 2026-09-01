import { describe, expect, it } from "vitest";
import { newSessionId } from "../packages/domain/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  SessionRuntimeRegistry,
  TurnCoordinator
} from "../packages/interview-engine/src/index.js";

describe("SessionRuntimeRegistry & Single-Flight Concurrency", () => {
  it("guarantees single-flight initialization and identical writer instance per SessionId", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sid = newSessionId();

    const [writer1, writer2, writer3] = await Promise.all([
      registry.getAsync(sid),
      registry.getAsync(sid),
      registry.getAsync(sid)
    ]);

    expect(writer1).toBe(writer2);
    expect(writer2).toBe(writer3);
    expect(registry.get(sid)).toBe(writer1);

    store.close();
  });

  it("ensures distinct sessions progress independently", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sidA = newSessionId();
    const sidB = newSessionId();

    const writerA = registry.get(sidA);
    const writerB = registry.get(sidB);

    expect(writerA).not.toBe(writerB);

    const turnsA = new TurnCoordinator(writerA);
    const turnsB = new TurnCoordinator(writerB);

    await Promise.all([
      turnsA.startSession(sixPeopleProblem),
      turnsB.startSession(sixPeopleProblem)
    ]);

    expect(writerA.getState().sequence).toBe(2);
    expect(writerB.getState().sequence).toBe(2);

    await turnsA.commitInput("Input for session A");
    expect(writerA.getState().sequence).toBe(6);
    expect(writerB.getState().sequence).toBe(2);

    store.close();
  });

  it("closes writer deterministically, waits for idle, and guards against closed execution", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sid = newSessionId();
    const writer = registry.get(sid);
    const turns = new TurnCoordinator(writer);

    await turns.startSession(sixPeopleProblem);
    expect(writer.isClosed()).toBe(false);

    await registry.close(sid);
    expect(writer.isClosed()).toBe(true);

    // Attempting to execute on closed writer fails
    await expect(turns.commitInput("Input on closed writer")).rejects.toThrow(
      "SessionWriter is closed and cannot execute commands"
    );

    // Re-getting session opens a fresh writer reconstructed from SQLite
    const reopenedWriter = await registry.getAsync(sid);
    expect(reopenedWriter).not.toBe(writer);
    expect(reopenedWriter.isClosed()).toBe(false);
    expect(reopenedWriter.getState().sequence).toBe(2);

    const reopenedTurns = new TurnCoordinator(reopenedWriter);
    await reopenedTurns.commitInput("Input on reopened writer");
    expect(reopenedWriter.getState().sequence).toBe(6);

    await registry.closeAll();
    expect(reopenedWriter.isClosed()).toBe(true);

    store.close();
  });

  it("drains commands admitted before close and never returns the closed writer on async reopen", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sid = newSessionId();
    const writer = registry.get(sid);
    const turns = new TurnCoordinator(writer);

    const admittedStart = turns.startSession(sixPeopleProblem);
    const closing = registry.close(sid);

    await expect(admittedStart).resolves.toBeUndefined();
    await closing;
    expect(store.eventCount(sid)).toBe(2);

    const reopened = await registry.getAsync(sid);
    expect(reopened).not.toBe(writer);
    expect(reopened.isClosed()).toBe(false);
    expect(reopened.getState().sequence).toBe(2);

    await registry.closeAll();
    store.close();
  });
});

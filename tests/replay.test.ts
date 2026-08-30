import { describe, expect, it } from "vitest";
import { CURRENT_EVENT_SCHEMA_VERSION, EventUpcasterRegistry, replaySession } from "../packages/events/src/index.js";
import { createCoreHarness, authorizeSafeProbe } from "./harness.js";

describe("event replay and upcasting", () => {
  it("replays SQLite as the only authoritative state", async () => {
    const harness = await createCoreHarness();
    try {
      await authorizeSafeProbe(harness);
      const events = harness.store.load(harness.sessionId);
      expect(replaySession(harness.sessionId, events)).toEqual(harness.writer.getState());
    } finally {
      harness.store.close();
    }
  });

  it("fails when an old event has no registered upcast path", () => {
    const registry = new EventUpcasterRegistry();
    expect(() => registry.toCurrent({ schemaVersion: 0 })).toThrow(/No event upcaster/);
  });

  it("upcasts schema-v1 events through the built-in path", async () => {
    const harness = await createCoreHarness();
    try {
      const current = harness.store.load(harness.sessionId)[0];
      if (current === undefined) throw new Error("Expected an event");
      const legacy = { ...current, schemaVersion: 1 };
      expect(new EventUpcasterRegistry().toCurrent(legacy)).toMatchObject({
        eventId: current.eventId,
        schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
        type: current.type
      });
    } finally {
      harness.store.close();
    }
  });
});


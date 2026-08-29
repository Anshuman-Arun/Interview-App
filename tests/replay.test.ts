import { describe, expect, it } from "vitest";
import { EventUpcasterRegistry, replaySession } from "../packages/events/src/index.js";
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
});


import { describe, expect, it } from "vitest";
import {
  newEventId,
  newRequestId
} from "../packages/domain/src/index.js";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  EventUpcasterRegistry,
  SessionEventSchema,
  replaySession
} from "../packages/events/src/index.js";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
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

  it("rejects persisted clean cancellation after physical delivery has already started", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      await new DeliveryCoordinator(harness.writer).markStarted(atom.deliveryId);
      const events = harness.store.load(harness.sessionId);
      const requestId = newRequestId();
      const forgedCancellation = SessionEventSchema.parse({
        eventId: newEventId(),
        sessionId: harness.sessionId,
        sequence: events.length + 1,
        schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
        source: "APPLICATION",
        wallTime: new Date(0).toISOString(),
        elapsedMs: 0,
        causationId: requestId,
        correlationId: requestId,
        type: "DELIVERY_CANCELLED",
        payload: {
          deliveryId: atom.deliveryId,
          reason: "forged clean cancellation after renderer command"
        }
      });

      expect(() =>
        replaySession(harness.sessionId, [...events, forgedCancellation])
      ).toThrow(/DELIVERING -> CANCELLED/u);
    } finally {
      harness.store.close();
    }
  });

  it("fails when an old event has no registered upcast path", () => {
    const registry = new EventUpcasterRegistry();
    expect(() => registry.toCurrent({ schemaVersion: 0 })).toThrow(/No event upcaster/);
  });

  it("replays a pre-v3 SESSION_STARTED event without inventing configuration", async () => {
    const harness = await createCoreHarness();
    try {
      const current = harness.store.load(harness.sessionId)[0];
      if (current === undefined || current.type !== "SESSION_STARTED") {
        throw new Error("Expected SESSION_STARTED as the first event");
      }
      const legacy = {
        ...current,
        schemaVersion: 2,
        payload: { startedAt: current.payload.startedAt }
      };
      const upcast = new EventUpcasterRegistry().toCurrent(legacy);
      expect(upcast.type).toBe("SESSION_STARTED");
      if (upcast.type !== "SESSION_STARTED") return;
      expect(upcast.payload.configuration).toBeUndefined();
      expect(upcast.schemaVersion).toBe(CURRENT_EVENT_SCHEMA_VERSION);
    } finally {
      harness.store.close();
    }
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


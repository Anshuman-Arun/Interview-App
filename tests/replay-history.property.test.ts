import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  SessionEventSchema,
  type SessionEvent
} from "../packages/events/src/index.js";
import type { SessionId } from "../packages/domain/src/index.js";
import {
  projectReplayTimeline,
  projectSessionHistory
} from "../packages/replay/src/index.js";

const sessionId = "session-replay-property" as SessionId;

function event(
  sequence: number,
  type: "SESSION_STARTED" | "PROBLEM_PRESENTED" | "SESSION_RESUMED"
): SessionEvent {
  return SessionEventSchema.parse({
    eventId: `property-event-${String(sequence)}`,
    sessionId,
    sequence,
    schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
    source: "APPLICATION",
    wallTime: `2026-08-31T19:10:${String(sequence % 60).padStart(2, "0")}.000Z`,
    elapsedMs: sequence,
    causationId: `property-cause-${String(sequence)}`,
    correlationId: `property-correlation-${String(sequence)}`,
    type,
    payload: type === "SESSION_STARTED"
      ? { startedAt: "2026-08-31T19:10:00.000Z" }
      : type === "PROBLEM_PRESENTED"
        ? {
            problemId: "property-problem",
            problemVersion: "1.0.0",
            prompt: "Property-test public prompt"
          }
        : { resumedAt: "2026-08-31T19:10:30.000Z" }
  });
}

function history(resumeCount: number): readonly SessionEvent[] {
  return [
    event(1, "SESSION_STARTED"),
    event(2, "PROBLEM_PRESENTED"),
    ...Array.from({ length: resumeCount }, (_, index) =>
      event(index + 3, "SESSION_RESUMED")
    )
  ];
}

function reorderObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderObject);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).reverse();
  return Object.fromEntries(entries.map(([key, child]) => [key, reorderObject(child)]));
}

describe("replay/history determinism properties", () => {
  it("is invariant to caller event order and object insertion order and never mutates input", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 0, max: 60 }),
      async (resumeCount) => {
        const authoritative = history(resumeCount);
        const reordered = [...authoritative]
          .reverse()
          .map((item) => reorderObject(item));
        const before = JSON.stringify(reordered);

        const canonicalTimeline = projectReplayTimeline(authoritative);
        const reorderedTimeline = projectReplayTimeline(reordered);
        const firstHistory = projectSessionHistory(reordered);
        const secondHistory = projectSessionHistory(reordered);

        expect(reorderedTimeline).toEqual(canonicalTimeline);
        expect(firstHistory).toEqual(secondHistory);
        expect(JSON.stringify(reordered)).toBe(before);
        expect(firstHistory.lifecycle.resumedCount).toBe(resumeCount);
      }
    ), { numRuns: 40 });
  });

  it("reports deterministic event and timeline truncation for over-limit histories", () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 80 }),
      fc.integer({ min: 1, max: 20 }),
      (resumeCount, requestedLimit) => {
        const events = history(resumeCount);
        const limit = Math.min(requestedLimit, events.length);
        const timelineLimit = Math.max(1, Math.floor(limit / 2));
        const projected = projectReplayTimeline(events, {
          bounds: {
            maxEvents: limit,
            maxTimelineEntries: timelineLimit
          }
        });

        expect(projected.eventTruncation).toEqual({
          truncated: events.length > limit,
          limit,
          remainingCount: Math.max(0, events.length - limit)
        });
        expect(projected.timelineTruncation).toEqual({
          truncated: limit > timelineLimit,
          limit: timelineLimit,
          remainingCount: Math.max(0, limit - timelineLimit)
        });
        expect(projected.entries).toHaveLength(Math.min(limit, timelineLimit));
      }
    ), { numRuns: 50 });
  });

  it("projects large within-bound histories without hidden loss", () => {
    const events = history(2_000);
    const projection = projectReplayTimeline(events, {
      bounds: {
        maxEvents: 2_100,
        maxTimelineEntries: 2_100
      }
    });
    expect(projection.complete).toBe(true);
    expect(projection.entries).toHaveLength(events.length);
    expect(projection.eventTruncation.remainingCount).toBe(0);
    expect(projection.timelineTruncation.remainingCount).toBe(0);
  });
});

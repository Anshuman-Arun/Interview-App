import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EvidenceValueSchema,
  evidenceKeyToString,
  newEventId,
  newRequestId,
  type EvidenceKey,
  type EvidenceRating
} from "../packages/domain/src/index.js";
import { CURRENT_EVENT_SCHEMA_VERSION, SessionEventSchema, reduceSessionEvent, replaySession } from "../packages/events/src/index.js";
import { createCommandEnvelope } from "../packages/interview-engine/src/index.js";
import { createCoreHarness, type CoreHarness } from "./harness.js";

const milestoneProgressKey: EvidenceKey = {
  problemId: "oxford-six-people",
  subject: { kind: "MILESTONE", milestoneId: "model-relations" },
  dimension: "PROGRESS"
};

describe("scoped evidence supersession", () => {
  it("retains history and explicitly supersedes the prior active value", async () => {
    const harness = await createCoreHarness();
    await propose(harness, "PROGRESSING");
    await propose(harness, "COMPLETE");

    const key = evidenceKeyToString(milestoneProgressKey);
    const history = harness.writer.getState().evidenceHistory[key];
    expect(history).toHaveLength(2);
    expect(history?.[0]).toMatchObject({ status: "SUPERSEDED", value: { value: "PROGRESSING" } });
    expect(history?.[0]?.supersededByEventId).toBe(history?.[1]?.evidenceEventId);
    expect(history?.[1]).toMatchObject({ status: "ACTIVE", value: { value: "COMPLETE" } });
    expect(harness.writer.getState().studentEvidence[key]?.value).toBe("COMPLETE");
    expect(replaySession(harness.sessionId, harness.store.load(harness.sessionId))).toEqual(harness.writer.getState());
    harness.store.close();
  });

  it("makes active evidence stale after transcript self-correction and permits fresh replacement", async () => {
    const harness = await createCoreHarness();
    await propose(harness, "PROGRESSING");
    const key = evidenceKeyToString(milestoneProgressKey);
    const activeId = harness.writer.getState().evidenceHistory[key]?.[0]?.evidenceEventId;

    await harness.turns.correctTranscript("I retract the earlier representation and want to restate it.");
    expect(harness.writer.getState().studentEvidence[key]).toBeUndefined();
    expect(harness.writer.getState().evidenceHistory[key]?.[0]).toMatchObject({
      evidenceEventId: activeId,
      status: "STALE",
      invalidationReason: "Transcript correction made the supporting interpretation stale"
    });

    await propose(harness, "PROGRESSING");
    expect(harness.writer.getState().evidenceHistory[key]).toHaveLength(2);
    expect(harness.writer.getState().evidenceHistory[key]?.[1]?.status).toBe("ACTIVE");
    expect(harness.writer.getState().studentEvidence[key]?.value).toBe("PROGRESSING");
    expect(replaySession(harness.sessionId, harness.store.load(harness.sessionId))).toEqual(harness.writer.getState());
    harness.store.close();
  });

  it("rejects reducer transitions that omit supersession or identify the wrong active record", async () => {
    const harness = await createCoreHarness();
    await propose(harness, "PROGRESSING");
    const state = harness.writer.getState();
    const currentEvidenceEventId = state.evidenceHistory[evidenceKeyToString(milestoneProgressKey)]?.[0]?.evidenceEventId;
    expect(currentEvidenceEventId).toBeDefined();
    if (currentEvidenceEventId === undefined) throw new Error("Expected active evidence");
    const causationId = newRequestId();
    const value = EvidenceValueSchema.parse({
      value: "COMPLETE",
      inferenceConfidence: 0.9,
      evidenceEventIds: [currentEvidenceEventId],
      lastUpdatedSequence: state.sequence + 1
    });
    const missingSupersession = SessionEventSchema.parse({
      eventId: newEventId(),
      sessionId: harness.sessionId,
      sequence: state.sequence + 1,
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      source: "APPLICATION",
      wallTime: new Date().toISOString(),
      elapsedMs: 0,
      causationId,
      correlationId: causationId,
      type: "STUDENT_EVIDENCE_UPDATED",
      payload: { key: milestoneProgressKey, value }
    });
    expect(() => reduceSessionEvent(state, missingSupersession)).toThrow("explicitly supersede");

    const wrongInvalidation = SessionEventSchema.parse({
      ...missingSupersession,
      eventId: newEventId(),
      type: "STUDENT_EVIDENCE_INVALIDATED",
      payload: {
        key: milestoneProgressKey,
        invalidatesEventId: newEventId(),
        reason: "invalid target"
      }
    });
    expect(() => reduceSessionEvent(state, wrongInvalidation)).toThrow("identify the active record");
    harness.store.close();
  });

  it("preserves history and active-value invariants under randomized updates and corrections", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(
        fc.constant({ kind: "CORRECT" as const, value: "PROGRESSING" as const }),
        fc.constant({ kind: "CORRECT" as const, value: "STALLED" as const }),
        fc.constant({ kind: "CORRECT" as const, value: "COMPLETE" as const }),
        fc.constant({ kind: "CORRECTION" as const })
      ), { minLength: 1, maxLength: 15 }),
      async (actions) => {
        const harness = await createCoreHarness();
        try {
          for (const action of actions) {
            if (action.kind === "CORRECTION") {
              await harness.turns.correctTranscript(`Correction at sequence ${String(harness.writer.getState().sequence)}`);
            } else {
              await propose(harness, action.value);
            }
            const state = harness.writer.getState();
            const key = evidenceKeyToString(milestoneProgressKey);
            const active = (state.evidenceHistory[key] ?? []).filter((record) => record.status === "ACTIVE");
            expect(active.length).toBeLessThanOrEqual(1);
            expect(state.studentEvidence[key]).toEqual(active[0]?.value);
            expect(replaySession(harness.sessionId, harness.store.load(harness.sessionId))).toEqual(state);
          }
        } finally {
          harness.store.close();
        }
      }
    ), { numRuns: 25 });
  });
});

async function propose(harness: CoreHarness, proposedValue: EvidenceRating): Promise<void> {
  const evidenceEventId = harness.writer.getState().eventIds.at(-1);
  if (evidenceEventId === undefined) throw new Error("Evidence provenance is unavailable");
  await harness.turns.processEvidenceProposal({
    envelope: createCommandEnvelope({ sessionId: harness.sessionId, producer: "mock-evidence", correlationId: newRequestId() }),
    proposal: {
      key: milestoneProgressKey,
      proposedValue,
      inferenceConfidence: 0.9,
      evidenceEventIds: [evidenceEventId]
    }
  });
}

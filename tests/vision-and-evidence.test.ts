import { describe, expect, it } from "vitest";
import { BoardObservationSchema, EventIdSchema, evidenceKeyToString } from "../packages/domain/src/index.js";
import { createCommandEnvelope } from "../packages/interview-engine/src/index.js";
import { createCoreHarness } from "./harness.js";

describe("vision and student evidence callbacks", () => {
  it("accepts a fresh vision result and durably deduplicates its callback", async () => {
    const harness = await createCoreHarness();
    try {
      const request = await harness.turns.requestVision("main-work", ["shape-1"]);
      const envelope = createCommandEnvelope({
        sessionId: harness.sessionId,
        producer: "mock-vision",
        correlationId: request.visionRequestId,
        sourceRevision: request.sourceBoardRevision
      });
      const observation = BoardObservationSchema.parse({
        regionId: "main-work",
        sourceBoardRevision: request.sourceBoardRevision,
        relevantShapeIds: ["shape-1"],
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        interpretation: "A two-colour complete graph",
        confidence: 0.9
      });
      const first = await harness.turns.processVisionResult({ envelope, observation });
      const count = harness.store.eventCount(harness.sessionId);
      const duplicate = await harness.turns.processVisionResult({ envelope, observation });
      expect(first).toEqual({ accepted: true });
      expect(duplicate).toEqual(first);
      expect(harness.store.eventCount(harness.sessionId)).toBe(count);
      expect(harness.writer.getState().visionRequests[request.visionRequestId]?.status).toBe("ACCEPTED");
    } finally {
      harness.store.close();
    }
  });

  it("discards a late vision result after its source board changes", async () => {
    const harness = await createCoreHarness();
    try {
      const request = await harness.turns.requestVision("main-work", ["shape-1"]);
      await harness.turns.commitBoardPatch("shape-1 was replaced");
      const result = await harness.turns.processVisionResult({
        envelope: createCommandEnvelope({ sessionId: harness.sessionId, producer: "mock-vision", correlationId: request.visionRequestId, sourceRevision: request.sourceBoardRevision }),
        observation: {
          regionId: "main-work",
          sourceBoardRevision: request.sourceBoardRevision,
          relevantShapeIds: ["shape-1"],
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          interpretation: "stale interpretation",
          confidence: 0.99
        }
      });
      expect(result.accepted).toBe(false);
      expect(harness.writer.getState().visionRequests[request.visionRequestId]?.status).toBe("DISCARDED");
    } finally {
      harness.store.close();
    }
  });

  it("commits authoritative scoped evidence only with valid provenance and confidence", async () => {
    const harness = await createCoreHarness();
    try {
      const evidenceEventId = EventIdSchema.parse(harness.writer.getState().eventIds.at(-1));
      const proposal = {
        key: { problemId: "oxford-six-people", subject: { kind: "MILESTONE" as const, milestoneId: "model-relations" }, dimension: "PROGRESS" as const },
        proposedValue: "PROGRESSING" as const,
        inferenceConfidence: 0.9,
        evidenceEventIds: [evidenceEventId]
      };
      const result = await harness.turns.processEvidenceProposal({
        envelope: createCommandEnvelope({ sessionId: harness.sessionId, producer: "mock-evidence" }),
        proposal
      });
      const key = evidenceKeyToString(proposal.key);
      expect(result).toEqual({ committed: true, key });
      expect(harness.writer.getState().studentEvidence[key]?.value).toBe("PROGRESSING");
      const evidenceEvent = harness.store.load(harness.sessionId)
        .findLast((event) => event.type === "STUDENT_EVIDENCE_UPDATED");
      expect(evidenceEvent).toBeDefined();
      expect(harness.writer.getState().studentEvidence[key]?.lastUpdatedSequence)
        .toBe(evidenceEvent?.sequence);
    } finally {
      harness.store.close();
    }
  });

  it("retains a low-confidence proposal without making it authoritative", async () => {
    const harness = await createCoreHarness();
    try {
      const evidenceEventId = EventIdSchema.parse(harness.writer.getState().eventIds.at(-1));
      const result = await harness.turns.processEvidenceProposal({
        envelope: createCommandEnvelope({ sessionId: harness.sessionId, producer: "mock-evidence" }),
        proposal: {
          key: { problemId: "oxford-six-people", subject: { kind: "SKILL", skillId: "graph-modeling" }, dimension: "UNDERSTANDING" },
          proposedValue: "PARTIAL",
          inferenceConfidence: 0.4,
          evidenceEventIds: [evidenceEventId]
        }
      });
      expect(result.committed).toBe(false);
      expect(harness.writer.getState().evidenceProposals).toHaveLength(1);
      expect(Object.keys(harness.writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });
});

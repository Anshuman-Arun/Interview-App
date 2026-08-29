import { describe, expect, it } from "vitest";
import {
  BoardObservationSchema,
  BoardActionSchema,
  GenerationBasisSchema,
  newSessionId
} from "../packages/domain/src/index.js";
import { initialSessionState } from "../packages/events/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  assessVisionFreshness,
  isGenerationBasisStillCompatible
} from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { createCoreHarness, providerEnvelope } from "./harness.js";

describe("compatibility and disclosure gates", () => {
  it("returns UNKNOWN when generation provenance cannot be established", () => {
    const basis = GenerationBasisSchema.parse({
      contextEpoch: 0,
      committedInputSequence: 1,
      transcriptRevision: 0,
      boardRevision: 0,
      problemStateRevision: 0,
      policyRevision: 0,
      turnId: "missing-turn"
    });
    expect(isGenerationBasisStillCompatible(basis, initialSessionState(newSessionId()))).toBe("UNKNOWN");
  });

  it("rejects a late generation after a board revision", async () => {
    const harness = await createCoreHarness();
    try {
      await harness.turns.commitBoardPatch("student replaced the relevant equation");
      const result = await harness.turns.processProposal({
        envelope: providerEnvelope(harness),
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: harness.safeProbe },
        validator: harness.validator
      });
      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("INCOMPATIBLE");
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("SUPERSEDED");
    } finally {
      harness.store.close();
    }
  });

  it("increments Context Epoch on transcript correction and invalidates prior basis", async () => {
    const harness = await createCoreHarness();
    try {
      const priorEpoch = harness.writer.getState().contextEpoch;
      const basis = harness.writer.getState().generations[harness.generationId]?.basis;
      expect(basis).toBeDefined();
      if (basis === undefined) throw new Error("Missing generation basis");
      await harness.turns.correctTranscript("corrected student statement");
      expect(harness.writer.getState().contextEpoch).toBe(priorEpoch + 1);
      expect(isGenerationBasisStillCompatible(basis, harness.writer.getState())).toBe("INCOMPATIBLE");
    } finally {
      harness.store.close();
    }
  });

  it("discards a late vision observation after the board revision changes", async () => {
    const harness = await createCoreHarness();
    try {
      const observation = BoardObservationSchema.parse({
        regionId: "work-region",
        sourceBoardRevision: harness.writer.getState().boardRevision,
        relevantShapeIds: ["shape-1"],
        bounds: { x: 0, y: 0, width: 100, height: 50 },
        interpretation: "student equation",
        confidence: 0.9
      });
      expect(assessVisionFreshness(observation, harness.writer.getState())).toBe("FRESH");
      await harness.turns.commitBoardPatch("shape-1 changed");
      expect(assessVisionFreshness(observation, harness.writer.getState())).toBe("STALE");
    } finally {
      harness.store.close();
    }
  });

  it("ignores model-claimed level and rejects protected leakage", () => {
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([]));
    const result = validator.validate({
      proposal: {
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: "Choose any person and use the pigeonhole principle on five relationships."
      },
      request: { requiredAction: "PROBE_JUSTIFICATION", maximumDisclosure: 0 },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });
    expect(result.accepted).toBe(false);
    expect(result.analysis?.effectiveDisclosureLevel).toBeGreaterThan(0);
  });

  it("fails closed when semantic validation is uncertain", () => {
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([]));
    const result = validator.validate({
      proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: "Perhaps think about a suitable invariant." },
      request: { requiredAction: "PROBE_JUSTIFICATION", maximumDisclosure: 0 },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("Expected uncertain proposal rejection");
    expect(result.reason).toMatch(/uncertain/i);
  });

  it("runtime validation prevents AI mutation of the student layer", () => {
    expect(() => BoardActionSchema.parse({
      operation: "highlight",
      layer: "STUDENT",
      targetShapeId: "student-shape-1",
      annotationPurpose: "hint"
    })).toThrow();
  });
});

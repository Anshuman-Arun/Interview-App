import { describe, expect, it } from "vitest";
import {
  BoardObservationSchema,
  BoardActionSchema,
  GenerationBasisSchema,
  newSessionId
} from "../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import { initialSessionState } from "../packages/events/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  assessVisionFreshness,
  createCommandEnvelope,
  isGenerationBasisStillCompatible
} from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { authorizeSafeProbe, createCoreHarness, providerEnvelope } from "./harness.js";

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

  it("refuses to stamp an older turn with the latest committed generation basis", async () => {
    const harness = await createCoreHarness();
    try {
      await harness.turns.commitInput("A newer student turn supersedes the old response target.");
      await expect(
        harness.turns.startGeneration(
          harness.inputEpisodeId,
          harness.turnId,
          "stale-turn-provider"
        )
      ).rejects.toThrow(/latest committed Turn/u);
    } finally {
      harness.store.close();
    }
  });

  it("rejects and supersedes a provider callback whose envelope does not match its generation basis", async () => {
    const harness = await createCoreHarness();
    try {
      const basis = harness.writer.getState().generations[harness.generationId]?.basis;
      expect(basis).toBeDefined();
      if (basis === undefined) throw new Error("missing generation basis");

      const result = await harness.turns.processProposal({
        envelope: createCommandEnvelope({
          sessionId: harness.sessionId,
          producer: "mock-model",
          inputEpisodeId: harness.inputEpisodeId,
          turnId: harness.turnId,
          generationId: harness.generationId,
          contextEpoch: basis.contextEpoch,
          sourceRevision: basis.committedInputSequence + 1
        }),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          speechText: harness.safeProbe
        },
        validator: harness.validator
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toMatch(/callback basis/u);
      expect(harness.writer.getState().generations[harness.generationId]?.status)
        .toBe("SUPERSEDED");
      expect(Object.keys(harness.writer.getState().deliveries)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("rejects an otherwise compatible proposal when new authoritative evidence makes its selected action stale", async () => {
    const harness = await createCoreHarness();
    try {
      const state = harness.writer.getState();
      const turn = state.turns[harness.turnId];
      expect(turn).toBeDefined();
      if (turn === undefined) throw new Error("missing turn");
      const evidenceEventId = state.eventIds[turn.committedSequence - 1];
      expect(evidenceEventId).toBeDefined();
      if (evidenceEventId === undefined) throw new Error("missing evidence provenance");

      const evidence = await harness.turns.processEvidenceProposal({
        envelope: createCommandEnvelope({
          sessionId: harness.sessionId,
          producer: "evidence-test",
          inputEpisodeId: harness.inputEpisodeId,
          turnId: harness.turnId
        }),
        proposal: {
          key: {
            problemId: sixPeopleProblem.id,
            subject: { kind: "MILESTONE", milestoneId: "model-relations" },
            dimension: "PROGRESS"
          },
          proposedValue: "PROGRESSING",
          inferenceConfidence: 0.95,
          evidenceEventIds: [evidenceEventId]
        }
      });
      expect(evidence.committed).toBe(true);

      const result = await harness.turns.processProposal({
        envelope: providerEnvelope(harness),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          speechText: harness.safeProbe
        },
        validator: harness.validator
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toMatch(/action is stale/u);
      expect(harness.writer.getState().generations[harness.generationId]?.status)
        .toBe("SUPERSEDED");

      const refreshed = await harness.turns.selectAction(harness.turnId, sixPeopleProblem);
      expect(refreshed.requiredAction).toBe("WAIT");
      expect(harness.writer.getState().pedagogicalActions[harness.turnId]?.requiredAction)
        .toBe("WAIT");
    } finally {
      harness.store.close();
    }
  });

  it("cancels queued output and supersedes its generation when authoritative evidence changes before delivery", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("QUEUED");

      const state = harness.writer.getState();
      const turn = state.turns[harness.turnId];
      expect(turn).toBeDefined();
      if (turn === undefined) throw new Error("missing turn");
      const evidenceEventId = state.eventIds[turn.committedSequence - 1];
      expect(evidenceEventId).toBeDefined();
      if (evidenceEventId === undefined) throw new Error("missing evidence provenance");

      const evidence = await harness.turns.processEvidenceProposal({
        envelope: createCommandEnvelope({
          sessionId: harness.sessionId,
          producer: "evidence-test",
          inputEpisodeId: harness.inputEpisodeId,
          turnId: harness.turnId
        }),
        proposal: {
          key: {
            problemId: sixPeopleProblem.id,
            subject: { kind: "MILESTONE", milestoneId: "model-relations" },
            dimension: "PROGRESS"
          },
          proposedValue: "PROGRESSING",
          inferenceConfidence: 0.95,
          evidenceEventIds: [evidenceEventId]
        }
      });

      expect(evidence.committed).toBe(true);
      expect(harness.writer.getState().generations[harness.generationId]?.status)
        .toBe("SUPERSEDED");
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status)
        .toBe("CANCELLED");
    } finally {
      harness.store.close();
    }
  });

  it("marks in-progress output POSSIBLY_EXPOSED when authoritative evidence invalidates its policy", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const deliveries = new DeliveryCoordinator(harness.writer);
      await deliveries.markStarted(atom.deliveryId);
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("DELIVERING");

      const state = harness.writer.getState();
      const turn = state.turns[harness.turnId];
      expect(turn).toBeDefined();
      if (turn === undefined) throw new Error("missing turn");
      const evidenceEventId = state.eventIds[turn.committedSequence - 1];
      expect(evidenceEventId).toBeDefined();
      if (evidenceEventId === undefined) throw new Error("missing evidence provenance");

      const evidence = await harness.turns.processEvidenceProposal({
        envelope: createCommandEnvelope({
          sessionId: harness.sessionId,
          producer: "evidence-test",
          inputEpisodeId: harness.inputEpisodeId,
          turnId: harness.turnId
        }),
        proposal: {
          key: {
            problemId: sixPeopleProblem.id,
            subject: { kind: "MILESTONE", milestoneId: "model-relations" },
            dimension: "PROGRESS"
          },
          proposedValue: "PROGRESSING",
          inferenceConfidence: 0.95,
          evidenceEventIds: [evidenceEventId]
        }
      });

      expect(evidence.committed).toBe(true);
      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("SUPERSEDED");
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    } finally {
      harness.store.close();
    }
  });

  it("barge-in supersedes a validated generation and cancels queued output before exposure", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("VALIDATED");
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("QUEUED");

      await harness.turns.beginUtterance();

      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("SUPERSEDED");
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("CANCELLED");
    } finally {
      harness.store.close();
    }
  });

  it("board revision marks already-started stale output POSSIBLY_EXPOSED", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const deliveries = new DeliveryCoordinator(harness.writer);
      await deliveries.markStarted(atom.deliveryId);
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("DELIVERING");

      await harness.turns.commitBoardPatch("student replaced the relevant board argument");

      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("SUPERSEDED");
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    } finally {
      harness.store.close();
    }
  });

  it("transcript correction marks already-started stale output POSSIBLY_EXPOSED", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const deliveries = new DeliveryCoordinator(harness.writer);
      await deliveries.markStarted(atom.deliveryId);
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("DELIVERING");

      await harness.turns.correctTranscript("corrected student reasoning");

      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("SUPERSEDED");
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    } finally {
      harness.store.close();
    }
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

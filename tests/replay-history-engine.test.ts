import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  DeliveryAtomSchema,
  EvidenceValueSchema,
  SessionEvaluationSchema,
  evidenceKeyToString,
  newDeliveryId,
  newRequestId,
  newSessionId,
  type EvidenceKey,
  type SessionId
} from "../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  SessionEventSchema,
  type SessionEvent
} from "../packages/events/src/index.js";
import {
  QuantResearchCoordinator,
  SessionRuntimeRegistry,
  SessionWriter,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import {
  QUANT_RESEARCH_GENERATOR_VERSION,
  QUANT_RESEARCH_RNG_VERSION,
  QUANT_RESEARCH_VERSION,
  type QuantResearchScenarioDefinition
} from "../packages/local-compute/src/index.js";
import {
  DEFAULT_REPLAY_BOUNDS,
  ReplayProjectionError,
  projectLongitudinalHistory,
  projectReplayTimeline,
  projectSessionHistory
} from "../packages/replay/src/index.js";
import { MAX_REPLAY_EVALUATION_COLLECTION_ITEMS } from "../packages/replay/src/bounds.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { authorizeSafeProbe, createCoreHarness, type CoreHarness } from "./harness.js";

const evidenceKey: EvidenceKey = {
  problemId: sixPeopleProblem.id,
  subject: { kind: "MILESTONE", milestoneId: "model-relations" },
  dimension: "PROGRESS"
};

function event(
  sessionId: SessionId,
  sequence: number,
  type: SessionEvent["type"],
  payload: unknown,
  source: "APPLICATION" | "USER" | "PROVIDER" | "RENDERER" | "WORKER" | "RECOVERY" = "APPLICATION"
): SessionEvent {
  return SessionEventSchema.parse({
    eventId: `event_${sessionId}_${String(sequence)}`,
    sessionId,
    sequence,
    schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
    source,
    wallTime: `2026-08-31T19:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    elapsedMs: sequence * 10,
    causationId: `request_cause_${sessionId}_${String(sequence)}`,
    correlationId: `request_corr_${sessionId}_${String(sequence)}`,
    type,
    payload
  });
}

function base(sessionId: SessionId, problemId = "problem-a", version = "1.0.0"): readonly SessionEvent[] {
  return [
    event(sessionId, 1, "SESSION_STARTED", { startedAt: "2026-08-31T19:00:01.000Z" }),
    event(sessionId, 2, "PROBLEM_PRESENTED", { problemId, problemVersion: version, prompt: "Public prompt" })
  ];
}

function groundedEvaluation(input: {
  readonly sessionId: SessionId;
  readonly problemId: string;
  readonly problemVersion: string;
  readonly score: number | null;
  readonly totalTurns: number;
  readonly evidenceEventId?: string | undefined;
  readonly lifecycle?: {
    readonly sessionStatus: "COMPLETED" | "ARCHIVED";
    readonly completionState:
      | "COMPLETED"
      | "ARCHIVED_INCOMPLETE"
      | "ARCHIVED_COMPLETED";
  };
  readonly disclosedInterventions?: readonly unknown[];
}) {
  const supportLevel = input.score === null ? "INSUFFICIENT" as const : "STRONG" as const;
  const dimension = (name: string) => input.score === null
    ? {
        score: null,
        supportLevel: "INSUFFICIENT" as const,
        evidenceRefs: [],
        notScoredReason: `${name} is intentionally unsupported in this replay fixture.`
      }
    : {
        score: input.score,
        supportLevel: "STRONG" as const,
        evidenceRefs: [{
          kind: "EVIDENCE_EVENT" as const,
          id: input.evidenceEventId ?? (() => {
            throw new Error("Scored grounded fixture requires authoritative evidence");
          })()
        }]
      };
  const includedDimensions = input.score === null
    ? []
    : [
        "technicalCorrectness",
        "rigor",
        "independence",
        "communication",
        "errorRecovery"
      ] as const;
  const omittedDimensions = input.score === null
    ? [
        "technicalCorrectness",
        "rigor",
        "independence",
        "communication",
        "errorRecovery"
      ] as const
    : [];

  return SessionEvaluationSchema.parse({
    sessionId: input.sessionId,
    problemId: input.problemId,
    problemVersion: input.problemVersion,
    evaluatedAt: "2026-08-31T20:00:00.000Z",
    rubric: {
      correctnessWeight: 0.35,
      rigorWeight: 0.20,
      independenceWeight: 0.20,
      communicationWeight: 0.15,
      errorRecoveryWeight: 0.10
    },
    lifecycle: {
      sessionStatus: input.lifecycle?.sessionStatus ?? "COMPLETED",
      completionState: input.lifecycle?.completionState ?? "COMPLETED",
      totalTurns: input.totalTurns
    },
    scores: {
      technicalCorrectness: input.score,
      rigor: input.score,
      independence: input.score,
      communication: input.score,
      hintResponsiveness: input.score,
      errorRecovery: input.score,
      compositeScore: input.score
    },
    dimensionResults: {
      technicalCorrectness: dimension("technicalCorrectness"),
      rigor: dimension("rigor"),
      independence: dimension("independence"),
      communication: dimension("communication"),
      hintResponsiveness: dimension("hintResponsiveness"),
      errorRecovery: dimension("errorRecovery")
    },
    composite: {
      status: input.score === null ? "NOT_SCORED" : "FULL",
      supportLevel,
      includedDimensions,
      omittedDimensions
    },
    milestones: [],
    disclosedInterventions: input.disclosedInterventions ?? [],
    unassistedMilestoneCount: 0,
    assistedMilestoneCount: 0,
    totalTurns: input.totalTurns,
    keyStrengths: ["Grounded fixture"],
    areasForImprovement: ["Grounded fixture"],
    summaryAssessment: "Grounded replay evaluation fixture."
  });
}

function basis() {
  return {
    contextEpoch: 0,
    committedInputSequence: 6,
    transcriptRevision: 0,
    boardRevision: 0,
    problemStateRevision: 0,
    policyRevision: 0,
    inputEpisodeId: "episode-verification",
    turnId: "turn-verification"
  };
}

async function addEvidence(harness: CoreHarness, value: "PROGRESSING" | "COMPLETE"): Promise<void> {
  const supportingEvent = harness.writer.getState().eventIds.at(-1);
  if (supportingEvent === undefined) throw new Error("Missing evidence provenance");
  await harness.turns.processEvidenceProposal({
    envelope: createCommandEnvelope({
      sessionId: harness.sessionId,
      producer: "replay-evidence-test",
      correlationId: newRequestId()
    }),
    proposal: {
      key: evidenceKey,
      proposedValue: value,
      inferenceConfidence: 0.95,
      evidenceEventIds: [supportingEvent]
    }
  });
}

async function queueAudio(harness: CoreHarness) {
  await authorizeSafeProbe(harness);
  const atom = DeliveryAtomSchema.parse({
    deliveryId: newDeliveryId(),
    generationId: harness.generationId,
    content: {
      medium: "AUDIO",
      text: harness.safeProbe,
      audioRef: "/fixture/audio.wav"
    },
    disclosureIds: [],
    effectiveDisclosureLevel: 0,
    status: "VALIDATED"
  });
  await harness.writer.execute(
    createCommandEnvelope({ sessionId: harness.sessionId, producer: "replay-audio-test" }),
    { operation: "QUEUE_REPLAY_AUDIO", payload: { deliveryId: atom.deliveryId } },
    z.object({ queued: z.literal(true) }).strict(),
    () => ({
      drafts: [{ source: "APPLICATION", type: "DELIVERY_QUEUED", payload: { atom } }],
      result: { queued: true as const }
    })
  );
  return atom;
}

async function queueWhiteboard(harness: CoreHarness, action: unknown) {
  await authorizeSafeProbe(harness);
  const atom = DeliveryAtomSchema.parse({
    deliveryId: newDeliveryId(),
    generationId: harness.generationId,
    content: {
      medium: "WHITEBOARD",
      action
    },
    disclosureIds: [],
    effectiveDisclosureLevel: 0,
    status: "VALIDATED"
  });
  await harness.writer.execute(
    createCommandEnvelope({ sessionId: harness.sessionId, producer: "replay-whiteboard-test" }),
    { operation: "QUEUE_REPLAY_WHITEBOARD", payload: { deliveryId: atom.deliveryId } },
    z.object({ queued: z.literal(true) }).strict(),
    () => ({
      drafts: [{ source: "APPLICATION", type: "DELIVERY_QUEUED", payload: { atom } }],
      result: { queued: true as const }
    })
  );
  return atom;
}

describe("replay/history projections", () => {
  it("defers Quant Research deterministic semantics without exposing private snapshot state", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = SessionWriter.open(store, sessionId);
    const coordinator = new QuantResearchCoordinator(writer);
    const definition: QuantResearchScenarioDefinition = {
      family: "MODEL_COMPARISON",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      seed: 1234,
      config: { observationCount: 10, noiseRadius: 2, outlierShift: 30 }
    };

    try {
      await coordinator.initialize(definition);
      await coordinator.applyAction({
        actionId: "replay-quant-model-1",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      });
      await coordinator.applyAction({
        actionId: "replay-quant-model-2",
        kind: "CHOOSE_OPTION",
        option: "CONSTANT"
      });

      const events = store.load(sessionId);
      const timeline = projectReplayTimeline(events);
      expect(timeline.complete).toBe(false);
      expect(timeline.issues).toContainEqual({
        code: "SPECIALIZED_DOMAIN_VALIDATION_REQUIRED",
        sequence: 3,
        eventType: "QUANT_RESEARCH_SCENARIO_INITIALIZED"
      });
      expect(timeline.entries[2]).toMatchObject({
        kind: "QUANT_RESEARCH_SCENARIO_INITIALIZED",
        stateValidation: "SPECIALIZED_DOMAIN_UNVERIFIED",
        quantResearch: {
          phase: "INITIALIZED",
          family: "MODEL_COMPARISON",
          authoritativeSnapshotPersisted: true,
          specializedValidationRequired: true
        }
      });
      expect(timeline.entries[3]).toMatchObject({
        kind: "QUANT_RESEARCH_ACTION_ACCEPTED",
        stateValidation: "SPECIALIZED_DOMAIN_UNVERIFIED",
        quantResearch: {
          phase: "ACTION_ACCEPTED",
          actionId: "replay-quant-model-1",
          actionKind: "CHOOSE_OPTION"
        }
      });
      const serialized = JSON.stringify(timeline);
      expect(serialized).not.toContain("hiddenModel");
      expect(serialized).not.toContain("gradingData");
      expect(serialized).not.toContain("generatedParameters");
      expect(serialized).not.toContain('"seed"');
      expect(serialized).not.toContain('"config"');
      expect(serialized).not.toContain('"overallScore"');
      expect(serialized).not.toContain('"metrics"');

      const history = projectSessionHistory(events);
      expect(history.currentStateAvailable).toBe(false);
      expect(history.validatedThroughSequence).toBe(2);
      expect(history.countsComplete).toBe(false);
      expect(history.lifecycle.status).toBe("UNKNOWN");
      expect(coordinator.replay().result.status).toBe("COMPLETE");
    } finally {
      await writer.close();
      store.close();
    }
  });

  it("uses authoritative sequence for exact one/multi-turn chronology", async () => {
    const harness = await createCoreHarness();
    try {
      await harness.turns.commitInput("Second committed turn.");
      const events = harness.store.load(harness.sessionId);
      const timeline = projectReplayTimeline([...events].reverse());
      expect(timeline.entries.map((entry) => entry.provenance.sequence))
        .toEqual(events.map((item) => item.sequence));
      const turns = timeline.entries.filter((entry) => entry.kind === "TURN_COMMITTED");
      expect(turns).toHaveLength(2);
      expect(turns[0]?.relations.turnId).toBe(harness.turnId);
      expect(turns[1]?.text?.text).toBe("Second committed turn.");

      const history = projectSessionHistory(events);
      expect(history.currentStateAvailable).toBe(true);
      expect(history.lifecycle.status).toBe("ACTIVE");
      expect(history.lifecycle.completed).toBe(false);
      expect(history.counts.turns).toBe(2);
    } finally {
      harness.store.close();
    }
  });

  it("keeps rejected generated material out of user-visible replay content", async () => {
    const harness = await createCoreHarness();
    const marker = "REJECTED_PRIVATE_MATERIAL_SHOULD_NOT_REPLAY";
    try {
      const result = await harness.turns.processProposal({
        envelope: createCommandEnvelope({
          sessionId: harness.sessionId,
          producer: "mock-model",
          inputEpisodeId: harness.inputEpisodeId,
          turnId: harness.turnId,
          generationId: harness.generationId
        }),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          speechText: marker
        },
        validator: harness.validator
      });
      expect(result.accepted).toBe(false);

      const projection = projectReplayTimeline(harness.store.load(harness.sessionId));
      const generated = projection.entries.find((entry) => entry.kind === "MODEL_PROPOSAL_RECEIVED");
      expect(generated?.generation?.proposalTextPersisted).toBe(true);
      expect(JSON.stringify(projection)).not.toContain(marker);
      expect(projection.entries.some((entry) => entry.delivery !== undefined)).toBe(false);
    } finally {
      harness.store.close();
    }
  });

  it("withholds unexposed delivery and internal model/verifier text from replay surfaces", async () => {
    const queuedHarness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(queuedHarness);
      const queued = projectReplayTimeline(
        queuedHarness.store.load(queuedHarness.sessionId)
      );
      expect(
        queued.entries.find((entry) =>
          entry.kind === "DELIVERY_QUEUED"
          && entry.delivery?.deliveryId === atom.deliveryId
        )?.delivery?.text
      ).toBeUndefined();
      expect(JSON.stringify(queued)).not.toContain(queuedHarness.safeProbe);

      const protectedMarker = "disclosure_unexposed_marker_must_stay_private";
      const withProtectedMarker = queuedHarness.store.load(queuedHarness.sessionId)
        .map((item) => {
          if (item.type === "PROPOSAL_VALIDATED") {
            return SessionEventSchema.parse({
              ...item,
              payload: {
                ...item.payload,
                analysis: {
                  ...item.payload.analysis,
                  effectiveDisclosureIds: [protectedMarker]
                }
              }
            });
          }
          if (
            item.type === "DELIVERY_QUEUED"
            && item.payload.atom.deliveryId === atom.deliveryId
          ) {
            return SessionEventSchema.parse({
              ...item,
              payload: {
                atom: {
                  ...item.payload.atom,
                  disclosureIds: [protectedMarker]
                }
              }
            });
          }
          return item;
        });
      const protectedQueued = projectReplayTimeline(withProtectedMarker);
      const protectedQueuedDelivery = protectedQueued.entries.find((entry) =>
        entry.kind === "DELIVERY_QUEUED"
      )?.delivery;
      expect(protectedQueuedDelivery?.disclosure.disclosureIdCount).toBe(1);
      expect(protectedQueuedDelivery?.disclosure.disclosureIds).toBeUndefined();
      expect(JSON.stringify(protectedQueued)).not.toContain(protectedMarker);

      await new DeliveryCoordinator(queuedHarness.writer)
        .cancelBeforeExposure(atom.deliveryId, "cancel before exposure");
      const cancelled = projectSessionHistory(
        queuedHarness.store.load(queuedHarness.sessionId)
      );
      expect(JSON.stringify(cancelled)).not.toContain(queuedHarness.safeProbe);
    } finally {
      queuedHarness.store.close();
    }

    const exposedHarness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(exposedHarness);
      const coordinator = new DeliveryCoordinator(exposedHarness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.acknowledgeExposed(atom.deliveryId);
      expect(JSON.stringify(projectReplayTimeline(
        exposedHarness.store.load(exposedHarness.sessionId)
      ))).toContain(exposedHarness.safeProbe);
    } finally {
      exposedHarness.store.close();
    }

    const boardHarness = await createCoreHarness();
    try {
      const atom = await queueWhiteboard(boardHarness, {
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "student-shape-private-purpose",
        annotationPurpose: boardHarness.safeProbe
      });
      const coordinator = new DeliveryCoordinator(boardHarness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.acknowledgeExposed(atom.deliveryId);
      const replay = projectReplayTimeline(
        boardHarness.store.load(boardHarness.sessionId)
      );
      expect(JSON.stringify(replay)).not.toContain(boardHarness.safeProbe);
      expect(replay.entries.find((entry) =>
        entry.kind === "DELIVERY_EXPOSED"
      )?.delivery?.boardAction).toMatchObject({
        operation: "circle",
        targetShapeId: "student-shape-private-purpose"
      });
    } finally {
      boardHarness.store.close();
    }

    const internalHarness = await createCoreHarness();
    try {
      const marker = "INTERNAL_REPLAY_MARKER_MUST_STAY_PRIVATE";
      const baseEvents = internalHarness.store.load(internalHarness.sessionId);
      const generation = internalHarness.writer.getState()
        .generations[internalHarness.generationId];
      const turn = baseEvents.find((item) => item.type === "TURN_COMMITTED");
      if (generation === undefined || turn?.type !== "TURN_COMMITTED") {
        throw new Error("Missing internal replay fixture provenance");
      }

      const policyRedacted = baseEvents.map((item) =>
        item.type === "PEDAGOGICAL_ACTION_SELECTED"
          ? SessionEventSchema.parse({
              ...item,
              payload: {
                ...item.payload,
                request: { ...item.payload.request, target: marker }
              }
            })
          : item
      );
      expect(JSON.stringify(projectReplayTimeline(policyRedacted)))
        .not.toContain(marker);

      const proposalRequestId = "request-private-formal";
      const formalHistory = [
        ...baseEvents,
        event(internalHarness.sessionId, baseEvents.length + 1,
          "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED", {
            generationId: internalHarness.generationId,
            proposalRequestId,
            proposal: {
              candidateFormalInterpretation: marker,
              interpretationConfidence: 0.8
            }
          }, "PROVIDER"),
        event(internalHarness.sessionId, baseEvents.length + 2,
          "FORMAL_INTERPRETATION_PROPOSAL_REJECTED", {
            generationId: internalHarness.generationId,
            reason: "formal proposal rejected"
          })
      ];
      expect(JSON.stringify(projectSessionHistory(formalHistory)))
        .not.toContain(marker);

      const verificationHistory = [
        ...baseEvents,
        event(internalHarness.sessionId, baseEvents.length + 1,
          "VERIFICATION_REQUESTED", {
            verificationRequestId: "request-private-verification",
            verifier: "deterministic-verifier",
            basis: generation.basis,
            candidateFormalInterpretation: marker,
            interpretationConfidence: 0.8,
            evidenceKey: {
              problemId: sixPeopleProblem.id,
              subject: { kind: "CLAIM", claimId: "private-replay-claim" },
              dimension: "CORRECTNESS"
            },
            evidenceEventIds: [turn.eventId]
          }),
        event(internalHarness.sessionId, baseEvents.length + 2,
          "VERIFICATION_RESULT_ACCEPTED", {
            verificationRequestId: "request-private-verification",
            result: {
              status: "UNRESOLVED",
              interpretationConfidence: 0.8,
              verifier: "deterministic-verifier",
              reason: marker
            }
          })
      ];
      expect(JSON.stringify(projectSessionHistory(verificationHistory)))
        .not.toContain(marker);

      const claimedIdHistory = [
        ...baseEvents,
        event(internalHarness.sessionId, baseEvents.length + 1,
          "MODEL_PROPOSAL_RECEIVED", {
            generationId: internalHarness.generationId,
            proposal: {
              realizedAction: "PROBE_JUSTIFICATION",
              claimedDisclosureLevel: 0,
              claimedDisclosureIds: [marker],
              speechText: internalHarness.safeProbe
            }
          }, "PROVIDER"),
        event(internalHarness.sessionId, baseEvents.length + 2,
          "PROPOSAL_REJECTED", {
            generationId: internalHarness.generationId,
            reason: "proposal rejected"
          })
      ];
      expect(JSON.stringify(projectReplayTimeline(claimedIdHistory)))
        .not.toContain(marker);
    } finally {
      internalHarness.store.close();
    }
  });

  it("distinguishes exposed, cancelled, possibly exposed, audio, and whiteboard deliveries", async () => {
    const exposedHarness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(exposedHarness);
      const coordinator = new DeliveryCoordinator(exposedHarness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.acknowledgeExposed(atom.deliveryId);
      const exposed = projectReplayTimeline(exposedHarness.store.load(exposedHarness.sessionId))
        .entries.find((entry) => entry.kind === "DELIVERY_EXPOSED");
      expect(exposed?.delivery).toMatchObject({
        medium: "TEXT",
        status: "EXPOSED",
        presentationState: "PRESENTED"
      });
      expect(exposed?.delivery?.text?.text).toBe(exposedHarness.safeProbe);
      await coordinator.acknowledgeCompleted(atom.deliveryId);
      const completedEntry = projectReplayTimeline(
        exposedHarness.store.load(exposedHarness.sessionId)
      ).entries.find((entry) => entry.kind === "DELIVERY_COMPLETED");
      expect(completedEntry?.delivery?.presentationState).toBe("PRESENTED");
      expect(completedEntry?.delivery?.text).toBeUndefined();
      expect(completedEntry?.delivery?.disclosure.disclosureIds).toBeUndefined();
    } finally {
      exposedHarness.store.close();
    }

    const cancelledHarness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(cancelledHarness);
      const queued = projectReplayTimeline(cancelledHarness.store.load(cancelledHarness.sessionId))
        .entries.find((entry) => entry.kind === "DELIVERY_QUEUED");
      expect(queued?.delivery?.presentationState).toBe("AUTHORIZED");
      expect(queued?.delivery?.persistedAtomStatus).toBe("VALIDATED");
      expect(queued?.delivery?.status).toBe("QUEUED");
      await new DeliveryCoordinator(cancelledHarness.writer)
        .cancelBeforeExposure(atom.deliveryId, cancelledHarness.safeProbe);
      const cancelledProjection = projectReplayTimeline(
        cancelledHarness.store.load(cancelledHarness.sessionId)
      );
      const cancelled = cancelledProjection.entries.find((entry) =>
        entry.kind === "DELIVERY_CANCELLED"
      );
      expect(cancelled?.delivery?.presentationState).toBe("CANCELLED");
      expect(cancelled?.text).toBeUndefined();
      expect(JSON.stringify(cancelledProjection)).not.toContain(cancelledHarness.safeProbe);
    } finally {
      cancelledHarness.store.close();
    }

    const possibleHarness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(possibleHarness);
      const coordinator = new DeliveryCoordinator(possibleHarness.writer);
      await coordinator.markStarted(atom.deliveryId);
      const deliveringProjection = projectReplayTimeline(
        possibleHarness.store.load(possibleHarness.sessionId)
      );
      const delivering = deliveringProjection.entries.find((entry) =>
        entry.kind === "DELIVERY_STARTED"
      )?.delivery;
      expect(delivering?.presentationState).toBe("DELIVERING");
      expect(delivering?.text).toBeUndefined();
      expect(delivering?.disclosure.disclosureIds).toBeUndefined();
      expect(JSON.stringify(deliveringProjection)).not.toContain(possibleHarness.safeProbe);

      await coordinator.markPossiblyExposed(atom.deliveryId, possibleHarness.safeProbe);
      const history = projectSessionHistory(possibleHarness.store.load(possibleHarness.sessionId));
      expect(history.counts.possiblyExposedInterventions).toBe(1);
      expect(history.counts.exposedInterventions).toBe(0);
      const possiblyExposed = history.timeline.entries.find((entry) =>
        entry.kind === "DELIVERY_POSSIBLY_EXPOSED"
      )?.delivery;
      expect(possiblyExposed?.presentationState).toBe("POSSIBLY_PRESENTED");
      expect(possiblyExposed?.text).toBeUndefined();
      expect(possiblyExposed?.disclosure.disclosureIds).toBeUndefined();
      expect(JSON.stringify(history)).not.toContain(possibleHarness.safeProbe);
    } finally {
      possibleHarness.store.close();
    }

    const audioHarness = await createCoreHarness();
    try {
      const atom = await queueAudio(audioHarness);
      const coordinator = new DeliveryCoordinator(audioHarness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.markPossiblyExposed(atom.deliveryId, "audio may have begun");
      const audio = projectReplayTimeline(audioHarness.store.load(audioHarness.sessionId))
        .entries.find((entry) => entry.kind === "DELIVERY_POSSIBLY_EXPOSED");
      expect(audio?.delivery).toMatchObject({
        medium: "AUDIO",
        audioReferenceRecorded: true,
        presentationState: "POSSIBLY_PRESENTED"
      });
      expect(audio?.delivery?.text).toBeUndefined();
      expect(JSON.stringify(audio)).not.toContain(audioHarness.safeProbe);
    } finally {
      audioHarness.store.close();
    }

    const boardHarness = await createCoreHarness();
    try {
      const atom = await queueWhiteboard(boardHarness, {
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "student-shape-1",
        expectedShapeRevision: 4,
        annotationPurpose: boardHarness.safeProbe
      });
      const coordinator = new DeliveryCoordinator(boardHarness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.acknowledgeExposed(atom.deliveryId);
      const board = projectReplayTimeline(boardHarness.store.load(boardHarness.sessionId))
        .entries.find((entry) => entry.kind === "DELIVERY_EXPOSED");
      expect(board?.delivery?.boardAction).toMatchObject({
        operation: "circle",
        targetShapeId: "student-shape-1",
        expectedShapeRevision: 4
      });
    } finally {
      boardHarness.store.close();
    }
  });

  it("reports proposal-received as the observed generation state on an incomplete prefix", async () => {
    const harness = await createCoreHarness();
    try {
      await authorizeSafeProbe(harness);
      const events = harness.store.load(harness.sessionId);
      const proposalReceived = events.find((item) =>
        item.type === "MODEL_PROPOSAL_RECEIVED"
        && item.payload.generationId === harness.generationId
      );
      if (proposalReceived === undefined) {
        throw new Error("Missing proposal-received fixture");
      }

      const prefix = projectSessionHistory(events, {
        bounds: { maxEvents: proposalReceived.sequence }
      });
      const generation = prefix.generationHistory.find((item) =>
        item.generationId === harness.generationId
      );
      expect(prefix.currentStateAvailable).toBe(false);
      expect(generation).toMatchObject({
        status: "PROPOSAL_RECEIVED",
        statusIsCurrent: false
      });
    } finally {
      harness.store.close();
    }
  });

  it("retains generation basis, supersession, and downstream delivery provenance", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      await harness.turns.supersedeGeneration(harness.generationId, "student changed direction");
      const generation = projectSessionHistory(harness.store.load(harness.sessionId))
        .generationHistory.find((item) => item.generationId === harness.generationId);
      expect(generation).toMatchObject({
        generationId: harness.generationId,
        status: "SUPERSEDED",
        deliveryIds: [atom.deliveryId]
      });
      expect(generation?.basis.turnId).toBe(harness.turnId);
      expect(generation?.superseded?.reason.text).toBe("student changed direction");
    } finally {
      harness.store.close();
    }
  });

  it("projects conservative file-restart recovery once without visible replay duplication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "replay-history-restart-"));
    const databasePath = join(directory, "events.sqlite");
    let store = new SqliteEventStore(databasePath);
    try {
      const harness = await createCoreHarness(store);
      const atom = await authorizeSafeProbe(harness);
      await new DeliveryCoordinator(harness.writer).markStarted(atom.deliveryId);
      const sessionId = harness.sessionId;
      store.close();

      store = new SqliteEventStore(databasePath);
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      await new DeliveryCoordinator(writer).recoverUncertainDeliveries();
      const history = projectSessionHistory(store.load(sessionId));

      expect(history.lifecycle.recoveryOriginPossiblyExposedCount).toBe(1);
      expect(history.counts.possiblyExposedInterventions).toBe(1);
      expect(history.timeline.entries.filter((entry) =>
        entry.kind === "DELIVERY_POSSIBLY_EXPOSED"
      )).toHaveLength(1);
      expect(history.timeline.entries.filter((entry) =>
        entry.delivery?.deliveryId === atom.deliveryId
        && entry.delivery.presentationState === "PRESENTED"
      )).toHaveLength(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("retains superseded/stale evidence evolution and latest-current evidence", async () => {
    const harness = await createCoreHarness();
    try {
      await addEvidence(harness, "PROGRESSING");
      await addEvidence(harness, "COMPLETE");
      await harness.turns.correctTranscript("I retract that line and restate it.");
      await addEvidence(harness, "PROGRESSING");

      const history = projectSessionHistory(harness.store.load(harness.sessionId));
      expect(history.evidenceHistory.map((item) => item.transition))
        .toEqual(["UPDATED", "UPDATED", "INVALIDATED", "UPDATED"]);
      expect(history.evidenceSummary).toEqual({
        recordedUpdates: 3,
        recordedInvalidations: 1,
        currentActive: 1,
        superseded: 1,
        stale: 1
      });
      expect(history.currentEvidence[0]?.value.value).toBe("PROGRESSING");
      expect(history.evidenceHistory[1]?.supersedesEventId)
        .toBe(history.evidenceHistory[0]?.evidenceEventId);
      expect(history.evidenceHistory[2]?.invalidatesEventId)
        .toBe(history.evidenceHistory[1]?.evidenceEventId);
      expect(history.evidenceHistory.filter((item) => item.transition === "UPDATED")
        .map((item) => item.finalStatus))
        .toEqual(["SUPERSEDED", "STALE", "ACTIVE"]);
    } finally {
      harness.store.close();
    }
  });

  it("preserves accepted/contradicted/unresolved verification and keeps discarded callbacks non-authoritative", () => {
    const sessionId = "session-verification" as SessionId;
    const start = event(sessionId, 1, "SESSION_STARTED", {
      startedAt: "2026-08-31T19:00:01.000Z"
    });
    const problem = event(sessionId, 2, "PROBLEM_PRESENTED", {
      problemId: sixPeopleProblem.id,
      problemVersion: sixPeopleProblem.version,
      prompt: "Public prompt"
    });
    const key: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "claim-1" },
      dimension: "CORRECTNESS"
    };
    const episodeStarted = event(sessionId, 3, "INPUT_EPISODE_STARTED", {
      inputEpisodeId: "episode-verification"
    }, "USER");
    const episodeUpdated = event(sessionId, 4, "INPUT_EPISODE_UPDATED", {
      inputEpisodeId: "episode-verification",
      modality: "TYPING",
      semanticContent: "A claim to verify"
    }, "USER");
    const episodeCommitted = event(sessionId, 5, "INPUT_EPISODE_COMMITTED", {
      inputEpisodeId: "episode-verification"
    });
    const turn = event(sessionId, 6, "TURN_COMMITTED", {
      turnId: "turn-verification",
      inputEpisodeId: "episode-verification",
      studentText: "A claim to verify"
    });
    const events: SessionEvent[] = [
      start,
      problem,
      episodeStarted,
      episodeUpdated,
      episodeCommitted,
      turn
    ];
    let sequence = 7;

    for (const [index, status] of ["VERIFIED", "CONTRADICTED", "UNRESOLVED"].entries()) {
      const requestId = `verification-${String(index)}`;
      const requestEvent = event(sessionId, sequence, "VERIFICATION_REQUESTED", {
        verificationRequestId: requestId,
        verifier: "deterministic-verifier",
        basis: basis(),
        candidateFormalInterpretation: `formal claim ${String(index)}`,
        interpretationConfidence: 1,
        evidenceKey: key,
        evidenceEventIds: [turn.eventId]
      });
      events.push(requestEvent);
      sequence += 1;
      events.push(event(sessionId, sequence, "VERIFICATION_RESULT_ACCEPTED", {
        verificationRequestId: requestId,
        result: {
          status,
          interpretationConfidence: 1,
          verifier: "deterministic-verifier",
          reason: `result ${status}`
        }
      }));
      sequence += 1;

      if (status === "VERIFIED") {
        const value = EvidenceValueSchema.parse({
          value: "CORRECT",
          inferenceConfidence: 1,
          evidenceEventIds: [turn.eventId, requestEvent.eventId],
          lastUpdatedSequence: sequence
        });
        events.push(event(sessionId, sequence, "STUDENT_EVIDENCE_UPDATED", {
          key,
          value
        }));
        sequence += 1;
      }
    }

    events.push(event(sessionId, sequence, "VERIFICATION_REQUESTED", {
      verificationRequestId: "verification-discarded",
      verifier: "deterministic-verifier",
      basis: basis(),
      candidateFormalInterpretation: "stale callback claim",
      interpretationConfidence: 0.9,
      evidenceKey: key,
      evidenceEventIds: [turn.eventId]
    }));
    sequence += 1;
    events.push(event(sessionId, sequence, "VERIFICATION_RESULT_DISCARDED", {
      verificationRequestId: "verification-discarded",
      reason: "callback basis became stale"
    }));

    const history = projectSessionHistory(events);
    expect(history.verificationSummary).toEqual({
      statusIsCurrent: true,
      pending: 0,
      verified: 1,
      contradicted: 1,
      unresolved: 1,
      discarded: 1
    });
    const discarded = history.verificationHistory.find((item) =>
      item.verificationRequestId === "verification-discarded"
    );
    expect(discarded?.status).toBe("DISCARDED");
    expect(discarded?.result).toBeUndefined();

    const duplicate = [
      ...events,
      event(sessionId, sequence + 1, "VERIFICATION_RESULT_DISCARDED", {
        verificationRequestId: "verification-discarded",
        reason: "duplicate callback"
      })
    ];
    expect(() => projectSessionHistory(duplicate))
      .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    expect(() => projectReplayTimeline(duplicate))
      .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
  });

  it("computes verification summaries over the full validated prefix, not the bounded row list", () => {
    const sessionId = "session-verification-bounds" as SessionId;
    const start = event(sessionId, 1, "SESSION_STARTED", {
      startedAt: "2026-08-31T19:00:01.000Z"
    });
    const problem = event(sessionId, 2, "PROBLEM_PRESENTED", {
      problemId: sixPeopleProblem.id,
      problemVersion: sixPeopleProblem.version,
      prompt: "Public prompt"
    });
    const episodeStarted = event(sessionId, 3, "INPUT_EPISODE_STARTED", {
      inputEpisodeId: "episode-verification"
    }, "USER");
    const episodeUpdated = event(sessionId, 4, "INPUT_EPISODE_UPDATED", {
      inputEpisodeId: "episode-verification",
      modality: "TYPING",
      semanticContent: "A claim to verify"
    }, "USER");
    const episodeCommitted = event(sessionId, 5, "INPUT_EPISODE_COMMITTED", {
      inputEpisodeId: "episode-verification"
    });
    const turn = event(sessionId, 6, "TURN_COMMITTED", {
      turnId: "turn-verification",
      inputEpisodeId: "episode-verification",
      studentText: "A claim to verify"
    });

    const events: SessionEvent[] = [
      start,
      problem,
      episodeStarted,
      episodeUpdated,
      episodeCommitted,
      turn
    ];
    const key: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "bounded-verification-claim" },
      dimension: "CORRECTNESS"
    };
    let sequence = 7;
    for (let index = 0; index < 1_001; index += 1) {
      events.push(event(sessionId, sequence, "VERIFICATION_REQUESTED", {
        verificationRequestId: `verification-bounded-${String(index)}`,
        verifier: "deterministic-verifier",
        basis: basis(),
        candidateFormalInterpretation: `claim ${String(index)}`,
        interpretationConfidence: 0.8,
        evidenceKey: key,
        evidenceEventIds: [turn.eventId]
      }));
      sequence += 1;
    }

    const history = projectSessionHistory(events);
    expect(history.verificationHistory).toHaveLength(1_000);
    expect(history.verificationTruncation).toEqual({
      truncated: true,
      limit: 1_000,
      remainingCount: 1
    });
    expect(history.verificationSummary.pending).toBe(1_001);
    expect(history.verificationHistoryComplete).toBe(false);
    expect(history.verificationHistory.every((entry) => entry.statusIsCurrent))
      .toBe(true);

    const truncatedPrefix = projectSessionHistory(events, {
      bounds: { maxEvents: 7 }
    });
    expect(truncatedPrefix.currentStateAvailable).toBe(false);
    expect(truncatedPrefix.verificationHistory[0]?.status).toBe("PENDING");
    expect(truncatedPrefix.verificationHistory[0]?.statusIsCurrent).toBe(false);
    expect(truncatedPrefix.verificationSummary.statusIsCurrent).toBe(false);
  });

  it("handles lifecycle states, mixed v1/v2 upcasts, future events, and explicit bounds safely", () => {
    const emptyTimeline = projectReplayTimeline([]);
    expect(emptyTimeline.complete).toBe(false);
    expect(emptyTimeline.issues).toContainEqual({ code: "CURRENT_STATE_UNAVAILABLE" });

    const empty = projectSessionHistory([]);
    expect(empty.currentStateAvailable).toBe(false);
    expect(empty.lifecycle.status).toBe("UNKNOWN");
    expect(empty.lifecycle.completed).toBeNull();
    expect(empty.lifecycle.historyComplete).toBe(false);

    const sessionId = "session-lifecycle" as SessionId;
    const active = base(sessionId, "lifecycle");
    const resumed = [...active, event(sessionId, 3, "SESSION_RESUMED", {
      resumedAt: "2026-08-31T19:01:00.000Z"
    })];
    const completed = [...resumed, event(sessionId, 4, "SESSION_COMPLETED", {
      completedAt: "2026-08-31T19:02:00.000Z"
    })];
    const archived = [...completed, event(sessionId, 5, "SESSION_ARCHIVED", {
      archivedAt: "2026-08-31T19:03:00.000Z"
    })];
    expect(projectSessionHistory(active).lifecycle.status).toBe("ACTIVE");
    expect(projectSessionHistory(resumed).lifecycle.resumedCount).toBe(1);
    expect(projectSessionHistory(completed).lifecycle.status).toBe("COMPLETED");
    expect(projectSessionHistory(archived).lifecycle.status).toBe("ARCHIVED");

    const archivedDirectly = [
      ...active,
      event(sessionId, 3, "SESSION_ARCHIVED", {
        archivedAt: "2026-08-31T19:01:30.000Z"
      })
    ];
    expect(projectSessionHistory(archivedDirectly).lifecycle.activeElapsedDurationMs)
      .toBe(20);

    const mixed = [{ ...active[0], schemaVersion: 1 }, active[1]];
    const before = JSON.stringify(mixed);
    const upcast = projectSessionHistory(mixed);
    expect(upcast.timeline.entries[0]?.provenance).toMatchObject({
      persistedSchemaVersion: 1,
      logicalSchemaVersion: CURRENT_EVENT_SCHEMA_VERSION
    });
    expect(JSON.stringify(mixed)).toBe(before);

    const privateMarker = "UNKNOWN_PRIVATE_PAYLOAD_MARKER";
    const future = {
      eventId: "event-future",
      sessionId: "session-future",
      sequence: 1,
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION + 1,
      source: "APPLICATION",
      wallTime: "2026-08-31T19:00:01.000Z",
      elapsedMs: 10,
      causationId: "request-future-cause",
      correlationId: "request-future-correlation",
      type: "FUTURE_EVENT",
      payload: { privateMaterial: privateMarker }
    };
    const unknown = projectSessionHistory([future]);
    expect(unknown.currentStateAvailable).toBe(false);
    expect(unknown.timeline.complete).toBe(false);
    expect(unknown.timeline.entries[0]?.kind).toBe("UNKNOWN_EVENT");
    expect(JSON.stringify(unknown)).not.toContain(privateMarker);

    const currentSchemaUnknown = {
      ...future,
      eventId: "event-current-unknown",
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      type: "UNRECOGNIZED_CURRENT_SCHEMA_EVENT"
    };
    const currentUnknownProjection = projectReplayTimeline([currentSchemaUnknown]);
    expect(currentUnknownProjection.complete).toBe(false);
    expect(currentUnknownProjection.entries[0]?.kind).toBe("UNKNOWN_EVENT");
    expect(JSON.stringify(currentUnknownProjection)).not.toContain(privateMarker);

    const longText = "🙂".repeat(20);
    const boundedSessionId = "session-bounds" as SessionId;
    const boundedEvents = [
      ...base(boundedSessionId, "bounds"),
      event(boundedSessionId, 3, "INPUT_EPISODE_STARTED", {
        inputEpisodeId: "episode-bounds"
      }, "USER"),
      event(boundedSessionId, 4, "INPUT_EPISODE_UPDATED", {
        inputEpisodeId: "episode-bounds",
        modality: "TYPING",
        semanticContent: longText
      }, "USER"),
      event(boundedSessionId, 5, "INPUT_EPISODE_COMMITTED", {
        inputEpisodeId: "episode-bounds"
      }),
      event(boundedSessionId, 6, "TURN_COMMITTED", {
        turnId: "turn-bounds",
        inputEpisodeId: "episode-bounds",
        studentText: longText
      }),
      event(boundedSessionId, 7, "SESSION_COMPLETED", {
        completedAt: "2026-08-31T19:01:00.000Z"
      })
    ];
    const bounded = projectReplayTimeline(boundedEvents, {
      bounds: { maxEvents: 6, maxTimelineEntries: 4, maxTextPreviewChars: 5 }
    });
    expect(bounded.eventTruncation.remainingCount).toBe(1);
    expect(bounded.timelineTruncation.remainingCount).toBe(2);
    expect(bounded.entries[3]?.text).toEqual({
      text: "🙂🙂🙂🙂🙂",
      originalLength: 20,
      truncated: true
    });
    const boundedHistory = projectSessionHistory(boundedEvents, {
      bounds: { maxEvents: 6, maxTimelineEntries: 4, maxTextPreviewChars: 5 }
    });
    expect(boundedHistory.lifecycle.completed).toBeNull();
    expect(boundedHistory.countsComplete).toBe(false);
  });

  it("rejects interactions whose authoritative producer requires an active session", () => {
    const completedId = "session-terminal-completed" as SessionId;
    const completed = [
      ...base(completedId, "terminal-completed"),
      event(completedId, 3, "SESSION_COMPLETED", {
        completedAt: "2026-08-31T19:01:00.000Z"
      }),
      event(completedId, 4, "INPUT_EPISODE_STARTED", {
        inputEpisodeId: "episode-after-completion"
      }, "USER")
    ];
    expect(() => projectSessionHistory(completed))
      .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));

    const archivedId = "session-terminal-archived" as SessionId;
    const archived = [
      ...base(archivedId, "terminal-archived"),
      event(archivedId, 3, "SESSION_ARCHIVED", {
        archivedAt: "2026-08-31T19:01:00.000Z"
      }),
      event(archivedId, 4, "SESSION_RESUMED", {
        resumedAt: "2026-08-31T19:02:00.000Z"
      })
    ];
    expect(() => projectReplayTimeline(archived))
      .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
  });

  it("allows producer-valid cleanup events after session completion", async () => {
    const harness = await createCoreHarness();
    try {
      const utteranceId = await harness.turns.beginUtterance();
      await harness.turns.completeSession();
      await harness.turns.discardUtterance(
        utteranceId,
        "late VAD cleanup after completion"
      );

      const projected = projectSessionHistory(
        harness.store.load(harness.sessionId)
      );
      expect(projected.lifecycle.status).toBe("COMPLETED");
      expect(projected.timeline.entries.at(-1)).toMatchObject({
        kind: "UTTERANCE_DISCARDED",
        relations: { utteranceId }
      });
    } finally {
      harness.store.close();
    }
  });

  it("allows a producer-valid late vision callback after completion", async () => {
    const harness = await createCoreHarness();
    try {
      const request = await harness.turns.requestVision("late-result", ["shape-late"]);
      await harness.turns.completeSession();

      const result = await harness.turns.processVisionResult({
        envelope: createCommandEnvelope({
          sessionId: harness.sessionId,
          producer: "late-vision-worker",
          correlationId: request.visionRequestId,
          sourceRevision: request.sourceBoardRevision
        }),
        observation: {
          regionId: "late-result",
          sourceBoardRevision: request.sourceBoardRevision,
          relevantShapeIds: ["shape-late"],
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          interpretation: "late but still fresh observation",
          confidence: 0.9
        }
      });
      expect(result).toEqual({ accepted: true });

      const projected = projectSessionHistory(
        harness.store.load(harness.sessionId)
      );
      expect(projected.lifecycle.status).toBe("COMPLETED");
      expect(projected.timeline.entries.at(-1)).toMatchObject({
        kind: "VISION_RESULT_ACCEPTED"
      });
    } finally {
      harness.store.close();
    }
  });

  it("allows late renderer completion for an already exposed delivery after archival", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const coordinator = new DeliveryCoordinator(harness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.acknowledgeExposed(atom.deliveryId);
      await harness.turns.completeSession();
      await harness.turns.archiveSession();
      await coordinator.acknowledgeCompleted(atom.deliveryId);

      const projected = projectSessionHistory(
        harness.store.load(harness.sessionId)
      );
      expect(projected.lifecycle.status).toBe("ARCHIVED");
      expect(projected.timeline.entries.at(-1)).toMatchObject({
        kind: "DELIVERY_COMPLETED",
        delivery: {
          status: "COMPLETED",
          presentationState: "PRESENTED"
        }
      });
    } finally {
      harness.store.close();
    }
  });

  it("rejects queued content or disclosure metadata that does not match the validated proposal", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const authoritative = harness.store.load(harness.sessionId);
      const tamperedText = authoritative.map((item) => {
        if (item.type !== "DELIVERY_QUEUED" || item.payload.atom.deliveryId !== atom.deliveryId) {
          return item;
        }
        return SessionEventSchema.parse({
          ...item,
          payload: {
            atom: {
              ...item.payload.atom,
              content: {
                medium: "TEXT",
                text: "content that was never validated"
              }
            }
          }
        });
      });
      expect(() => projectReplayTimeline(tamperedText))
        .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));

      const tamperedDisclosure = authoritative.map((item) => {
        if (item.type !== "DELIVERY_QUEUED" || item.payload.atom.deliveryId !== atom.deliveryId) {
          return item;
        }
        return SessionEventSchema.parse({
          ...item,
          payload: {
            atom: {
              ...item.payload.atom,
              effectiveDisclosureLevel: 1
            }
          }
        });
      });
      expect(() => projectSessionHistory(tamperedDisclosure))
        .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      harness.store.close();
    }
  });

  it("rejects duplicate delivery realizations under fresh DeliveryIds", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const authoritative = harness.store.load(harness.sessionId);
      const duplicateAtom = DeliveryAtomSchema.parse({
        ...atom,
        deliveryId: newDeliveryId(),
        status: "VALIDATED"
      });
      expect(() => projectSessionHistory([
        ...authoritative,
        event(
          harness.sessionId,
          authoritative.length + 1,
          "DELIVERY_QUEUED",
          { atom: duplicateAtom }
        )
      ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      harness.store.close();
    }
  });

  it("rejects new delivery queueing after the validated generation basis becomes stale", async () => {
    const harness = await createCoreHarness();
    try {
      await authorizeSafeProbe(harness);
      await harness.turns.commitInput("A later turn makes the old generation stale.");

      const staleAudio = DeliveryAtomSchema.parse({
        deliveryId: newDeliveryId(),
        generationId: harness.generationId,
        content: {
          medium: "AUDIO",
          text: harness.safeProbe,
          audioRef: "/fixture/stale-audio.wav"
        },
        disclosureIds: [],
        effectiveDisclosureLevel: 0,
        status: "VALIDATED"
      });
      const authoritative = harness.store.load(harness.sessionId);
      expect(() => projectSessionHistory([
        ...authoritative,
        event(
          harness.sessionId,
          authoritative.length + 1,
          "DELIVERY_QUEUED",
          { atom: staleAudio }
        )
      ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      harness.store.close();
    }
  });

  it("rejects new delivery queueing after completion even when the old basis is otherwise unchanged", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const coordinator = new DeliveryCoordinator(harness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.acknowledgeExposed(atom.deliveryId);
      await coordinator.acknowledgeCompleted(atom.deliveryId);
      await harness.turns.completeSession();

      const postTerminalAudio = DeliveryAtomSchema.parse({
        deliveryId: newDeliveryId(),
        generationId: harness.generationId,
        content: {
          medium: "AUDIO",
          text: harness.safeProbe,
          audioRef: "/fixture/post-terminal-audio.wav"
        },
        disclosureIds: [],
        effectiveDisclosureLevel: 0,
        status: "VALIDATED"
      });
      const authoritative = harness.store.load(harness.sessionId);
      expect(() => projectSessionHistory([
        ...authoritative,
        event(
          harness.sessionId,
          authoritative.length + 1,
          "DELIVERY_QUEUED",
          { atom: postTerminalAudio }
        )
      ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      harness.store.close();
    }
  });

  it("rejects verification provenance that does not match its formal proposal and generation basis", async () => {
    const harness = await createCoreHarness();
    try {
      const authoritative = harness.store.load(harness.sessionId);
      const generation = harness.writer.getState().generations[harness.generationId];
      const turn = authoritative.find((item) => item.type === "TURN_COMMITTED");
      if (generation === undefined || turn?.type !== "TURN_COMMITTED") {
        throw new Error("Missing generation fixture provenance");
      }
      const proposalRequestId = "request-formal-proposal";
      const formal = event(
        harness.sessionId,
        authoritative.length + 1,
        "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED",
        {
          generationId: harness.generationId,
          proposalRequestId,
          proposal: {
            candidateFormalInterpretation: "candidate statement",
            interpretationConfidence: 0.95
          }
        },
        "PROVIDER"
      );
      const mismatchedRequest = event(
        harness.sessionId,
        authoritative.length + 2,
        "VERIFICATION_REQUESTED",
        {
          verificationRequestId: "request-formal-verification",
          verifier: "deterministic-verifier",
          basis: generation.basis,
          candidateFormalInterpretation: "different statement",
          interpretationConfidence: 0.95,
          evidenceKey: {
            problemId: sixPeopleProblem.id,
            subject: { kind: "CLAIM", claimId: "formal-claim" },
            dimension: "CORRECTNESS"
          },
          evidenceEventIds: [turn.eventId],
          sourceGenerationId: harness.generationId,
          sourceProposalRequestId: proposalRequestId
        }
      );

      expect(() => projectSessionHistory([
        ...authoritative,
        formal,
        mismatchedRequest
      ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      harness.store.close();
    }
  });

  it("requires verification evidence provenance to include its committed Turn", async () => {
    const harness = await createCoreHarness();
    try {
      const authoritative = harness.store.load(harness.sessionId);
      const generation = harness.writer.getState().generations[harness.generationId];
      const unrelated = authoritative.find((item) => item.type === "SESSION_STARTED");
      if (generation === undefined || unrelated === undefined) {
        throw new Error("Missing verification provenance fixture");
      }

      const request = event(
        harness.sessionId,
        authoritative.length + 1,
        "VERIFICATION_REQUESTED",
        {
          verificationRequestId: "request-missing-turn-provenance",
          verifier: "deterministic-verifier",
          basis: generation.basis,
          candidateFormalInterpretation: "candidate statement",
          interpretationConfidence: 0.9,
          evidenceKey: {
            problemId: sixPeopleProblem.id,
            subject: { kind: "CLAIM", claimId: "claim-missing-turn-provenance" },
            dimension: "CORRECTNESS"
          },
          evidenceEventIds: [unrelated.eventId]
        }
      );

      expect(() => projectSessionHistory([...authoritative, request]))
        .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      harness.store.close();
    }
  });

  it("enforces hard upper limits on caller-supplied replay bounds", () => {
    const history = base("session-hard-bounds" as SessionId, "hard-bounds");
    expect(() => projectReplayTimeline(history, {
      bounds: { maxEvents: DEFAULT_REPLAY_BOUNDS.maxEvents + 1 }
    })).toThrow(RangeError);
    expect(() => projectSessionHistory(history, {
      bounds: { maxTextPreviewChars: 0 }
    })).toThrow(RangeError);

    const throwingBounds = new Proxy({}, {
      get: () => {
        throw new Error("PRIVATE_REPLAY_BOUNDS_MARKER");
      }
    });
    try {
      projectReplayTimeline(history, { bounds: throwingBounds });
      throw new Error("Expected throwing replay bounds rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect(String(error)).toContain("Invalid replay bounds");
      expect(String(error)).not.toContain("PRIVATE_REPLAY_BOUNDS_MARKER");
    }

    const throwingTimelineOptions = new Proxy({}, {
      get: (_target, property): unknown => {
        if (property === "bounds") {
          throw new Error("PRIVATE_TIMELINE_OPTIONS_MARKER");
        }
        return undefined;
      }
    });
    try {
      projectReplayTimeline(history, throwingTimelineOptions);
      throw new Error("Expected throwing timeline options rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect(String(error)).not.toContain("PRIVATE_TIMELINE_OPTIONS_MARKER");
    }

    const throwingEvaluationOptions = new Proxy({}, {
      get: (_target, property): unknown => {
        if (property === "evaluation") {
          throw new Error("PRIVATE_EVALUATION_OPTIONS_MARKER");
        }
        return undefined;
      }
    });
    try {
      projectSessionHistory(history, throwingEvaluationOptions);
      throw new Error("Expected throwing evaluation options rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayProjectionError);
      expect(error).toMatchObject({ code: "EVALUATION_MISMATCH" });
      expect(String(error)).not.toContain("PRIVATE_EVALUATION_OPTIONS_MARKER");
    }

    const throwingLongitudinalOptions = new Proxy({}, {
      get: (_target, property): unknown => {
        if (property === "bounds") {
          throw new Error("PRIVATE_LONGITUDINAL_OPTIONS_MARKER");
        }
        return undefined;
      }
    });
    try {
      projectLongitudinalHistory([], throwingLongitudinalOptions);
      throw new Error("Expected throwing longitudinal options rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect(String(error)).not.toContain("PRIVATE_LONGITUDINAL_OPTIONS_MARKER");
    }
  });

  it("rejects event sources that cannot author the claimed authoritative transition", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const coordinator = new DeliveryCoordinator(harness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.acknowledgeExposed(atom.deliveryId);
      const authoritative = harness.store.load(harness.sessionId);
      const forged = authoritative.map((item) =>
        item.type === "DELIVERY_EXPOSED"
          ? SessionEventSchema.parse({ ...item, source: "APPLICATION" })
          : item
      );
      expect(() => projectReplayTimeline(forged))
        .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      harness.store.close();
    }
  });

  it("accepts rejected evidence proposals but rejects evidence updates with no authoritative origin", () => {
    const sessionId = "session-evidence-origin" as SessionId;
    const history = base(sessionId, "evidence-origin");
    const rejectedProposal = event(sessionId, 3, "EVIDENCE_PROPOSED", {
      proposal: {
        key: {
          problemId: "different-problem",
          subject: { kind: "SKILL", skillId: "untrusted-skill" },
          dimension: "PROGRESS"
        },
        proposedValue: "COMPLETE",
        inferenceConfidence: 0.2,
        evidenceEventIds: ["missing-support"]
      }
    }, "PROVIDER");
    const rejected = projectSessionHistory([...history, rejectedProposal]);
    expect(rejected.evidenceSummary.recordedUpdates).toBe(0);
    expect(rejected.currentEvidence).toEqual([]);
    const rejectedTimeline = projectReplayTimeline([...history, rejectedProposal]);
    expect(rejectedTimeline.entries.find((entry) =>
      entry.kind === "EVIDENCE_PROPOSED"
    )?.evidence).toBeUndefined();
    expect(JSON.stringify(rejectedTimeline)).not.toContain("untrusted-skill");

    const key: EvidenceKey = {
      problemId: "evidence-origin",
      subject: { kind: "SKILL", skillId: "forged-skill" },
      dimension: "PROGRESS"
    };
    const forgedValue = EvidenceValueSchema.parse({
      value: "COMPLETE",
      inferenceConfidence: 1,
      evidenceEventIds: [history[1]?.eventId],
      lastUpdatedSequence: 3
    });
    expect(() => projectSessionHistory([
      ...history,
      event(sessionId, 3, "STUDENT_EVIDENCE_UPDATED", {
        key,
        value: forgedValue
      })
    ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
  });

  it("requires WHITEBOARD InputEpisode semantics to come from the paired board patch", () => {
    const sessionId = "session-whiteboard-provenance" as SessionId;
    const started = [
      ...base(sessionId, "whiteboard-provenance"),
      event(sessionId, 3, "INPUT_EPISODE_STARTED", {
        inputEpisodeId: "episode-whiteboard-provenance"
      }, "USER")
    ];
    const patch = event(sessionId, 4, "BOARD_PATCH_COMMITTED", {
      boardRevision: 1,
      summary: "student drew the diagonal"
    }, "USER");
    const update = SessionEventSchema.parse({
      ...event(sessionId, 5, "INPUT_EPISODE_UPDATED", {
        inputEpisodeId: "episode-whiteboard-provenance",
        modality: "WHITEBOARD",
        semanticContent: "student drew the diagonal"
      }, "USER"),
      causationId: patch.causationId,
      correlationId: patch.correlationId
    });
    const valid = [
      ...started,
      patch,
      update,
      event(sessionId, 6, "INPUT_EPISODE_COMMITTED", {
        inputEpisodeId: "episode-whiteboard-provenance"
      }),
      event(sessionId, 7, "TURN_COMMITTED", {
        turnId: "turn-whiteboard-provenance",
        inputEpisodeId: "episode-whiteboard-provenance",
        studentText: "student drew the diagonal"
      })
    ];
    expect(projectSessionHistory(valid).counts.turns).toBe(1);

    const forged = valid.map((item) =>
      item.type === "INPUT_EPISODE_UPDATED"
        ? SessionEventSchema.parse({
            ...item,
            correlationId: "different-whiteboard-command"
          })
        : item
    );
    expect(() => projectReplayTimeline(forged))
      .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));

    expect(() => projectReplayTimeline([
      ...started,
      event(sessionId, 4, "INPUT_EPISODE_UPDATED", {
        inputEpisodeId: "episode-whiteboard-provenance",
        modality: "WHITEBOARD",
        semanticContent: "invented board work"
      }, "USER")
    ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
  });

  it("requires SPEECH InputEpisode semantics to come from TRANSCRIPT_FINALIZED", () => {
    const sessionId = "session-speech-provenance" as SessionId;
    const history = [
      ...base(sessionId, "speech-provenance"),
      event(sessionId, 3, "INPUT_EPISODE_STARTED", {
        inputEpisodeId: "episode-speech-provenance"
      }, "USER"),
      event(sessionId, 4, "INPUT_EPISODE_UPDATED", {
        inputEpisodeId: "episode-speech-provenance",
        modality: "SPEECH",
        semanticContent: "forged speech without STT provenance"
      })
    ];
    expect(() => projectReplayTimeline(history))
      .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
  });

  it("rejects turn text that is not the committed InputEpisode semantic content", () => {
    const sessionId = "session-turn-mismatch" as SessionId;
    const events = [
      ...base(sessionId, "turn-mismatch"),
      event(sessionId, 3, "INPUT_EPISODE_STARTED", {
        inputEpisodeId: "episode-turn-mismatch"
      }, "USER"),
      event(sessionId, 4, "INPUT_EPISODE_UPDATED", {
        inputEpisodeId: "episode-turn-mismatch",
        modality: "TYPING",
        semanticContent: "authoritative student input"
      }, "USER"),
      event(sessionId, 5, "INPUT_EPISODE_COMMITTED", {
        inputEpisodeId: "episode-turn-mismatch"
      }),
      event(sessionId, 6, "TURN_COMMITTED", {
        turnId: "turn-mismatch",
        inputEpisodeId: "episode-turn-mismatch",
        studentText: "different invented turn text"
      })
    ];
    expect(() => projectSessionHistory(events))
      .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
  });

  it("requires barge-in onset to invalidate already active output before unrelated transitions", async () => {
    const activeHarness = await createCoreHarness();
    try {
      const authoritative = activeHarness.store.load(activeHarness.sessionId);
      const sequence = authoritative.length + 1;
      expect(() => projectReplayTimeline([
        ...authoritative,
        event(activeHarness.sessionId, sequence, "UTTERANCE_STARTED", {
          utteranceId: "utterance-barge-active"
        }, "USER"),
        event(activeHarness.sessionId, sequence + 1, "SESSION_RESUMED", {
          resumedAt: "2026-08-31T19:30:00.000Z"
        })
      ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      activeHarness.store.close();
    }

    const queuedHarness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(queuedHarness);
      const authoritative = queuedHarness.store.load(queuedHarness.sessionId);
      const sequence = authoritative.length + 1;
      expect(() => projectReplayTimeline([
        ...authoritative,
        event(queuedHarness.sessionId, sequence, "UTTERANCE_STARTED", {
          utteranceId: "utterance-barge-queued"
        }, "USER"),
        event(queuedHarness.sessionId, sequence + 1, "DELIVERY_STARTED", {
          deliveryId: atom.deliveryId
        })
      ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      queuedHarness.store.close();
    }
  });

  it("validates accepted vision and local-compute payloads against their authoritative requests", () => {
    const visionSessionId = "session-vision-validation" as SessionId;
    const visionEvents = [
      ...base(visionSessionId, "vision-validation"),
      event(visionSessionId, 3, "VISION_REQUESTED", {
        visionRequestId: "vision-request",
        sourceBoardRevision: 0,
        regionId: "region-a",
        relevantShapeIds: ["shape-a"]
      }),
      event(visionSessionId, 4, "VISION_RESULT_ACCEPTED", {
        visionRequestId: "vision-request",
        observation: {
          regionId: "region-a",
          sourceBoardRevision: 0,
          relevantShapeIds: ["shape-a"],
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          interpretation: "worker observation",
          confidence: 0.9
        }
      }, "WORKER")
    ];
    expect(projectSessionHistory(visionEvents).currentStateAvailable).toBe(true);
    expect(() => projectSessionHistory([
      ...visionEvents.slice(0, -1),
      event(visionSessionId, 4, "VISION_RESULT_ACCEPTED", {
        visionRequestId: "vision-request",
        observation: {
          regionId: "different-region",
          sourceBoardRevision: 0,
          relevantShapeIds: ["shape-a"],
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          interpretation: "fabricated stale observation",
          confidence: 0.9
        }
      }, "WORKER")
    ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));

    const computeSessionId = "session-compute-validation" as SessionId;
    const speechText = "  alpha   beta ";
    const computeEvents = [
      ...base(computeSessionId, "compute-validation"),
      event(computeSessionId, 3, "UTTERANCE_STARTED", {
        utteranceId: "utterance-compute"
      }, "USER"),
      event(computeSessionId, 4, "INPUT_EPISODE_STARTED", {
        inputEpisodeId: "episode-compute"
      }),
      event(computeSessionId, 5, "TRANSCRIPT_FINALIZED", {
        utteranceId: "utterance-compute",
        inputEpisodeId: "episode-compute",
        transcriptRevision: 1,
        text: speechText
      }, "WORKER"),
      event(computeSessionId, 6, "INPUT_EPISODE_UPDATED", {
        inputEpisodeId: "episode-compute",
        modality: "SPEECH",
        semanticContent: speechText
      }),
      event(computeSessionId, 7, "INPUT_EPISODE_COMMITTED", {
        inputEpisodeId: "episode-compute"
      }),
      event(computeSessionId, 8, "TURN_COMMITTED", {
        turnId: "turn-compute",
        inputEpisodeId: "episode-compute",
        studentText: speechText
      }),
      event(computeSessionId, 9, "LOCAL_COMPUTE_REQUESTED", {
        computeRequestId: "compute-request",
        operation: "ANALYZE_TRANSCRIPT",
        inputEpisodeId: "episode-compute",
        sourceTranscriptRevision: 1
      }),
      event(computeSessionId, 10, "LOCAL_COMPUTE_RESULT_ACCEPTED", {
        computeRequestId: "compute-request",
        operation: "ANALYZE_TRANSCRIPT",
        sourceTranscriptRevision: 1,
        normalizedText: "alpha beta",
        tokenCount: 2
      })
    ];
    expect(projectReplayTimeline(computeEvents).complete).toBe(true);
    expect(() => projectReplayTimeline([
      ...computeEvents.slice(0, -1),
      event(computeSessionId, 10, "LOCAL_COMPUTE_RESULT_ACCEPTED", {
        computeRequestId: "compute-request",
        operation: "ANALYZE_TRANSCRIPT",
        sourceTranscriptRevision: 1,
        normalizedText: "wrong",
        tokenCount: 1
      })
    ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
  });

  it("fails sanitized on oversized replay identifiers without changing authoritative schemas", async () => {
    const oversized = "x".repeat(513);
    const metadataSessionId = "session-oversized-metadata" as SessionId;
    const metadataHistory = base(metadataSessionId, "oversized-metadata").map(
      (item, index) => index === 0 ? { ...item, eventId: oversized } : item
    );
    try {
      projectReplayTimeline(metadataHistory);
      throw new Error("Expected oversized metadata rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayProjectionError);
      expect(error).toMatchObject({ code: "INVALID_EVENT_METADATA" });
      expect(String(error)).not.toContain(oversized);
    }

    const harness = await createCoreHarness();
    try {
      const oversizedProvider = harness.store.load(harness.sessionId).map((item) =>
        item.type === "MODEL_GENERATION_STARTED"
          ? {
              ...item,
              payload: { ...item.payload, provider: oversized }
            }
          : item
      );
      expect(() => projectSessionHistory(oversizedProvider))
        .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      harness.store.close();
    }
  });

  it("rejects reducer-valid delivery transitions that violate generation and exposure authority", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      await harness.turns.supersedeGeneration(
        harness.generationId,
        "generation no longer current"
      );
      const authoritative = harness.store.load(harness.sessionId);
      const nextSequence = authoritative.length + 1;

      const startedAfterSupersession = [
        ...authoritative,
        event(harness.sessionId, nextSequence, "DELIVERY_STARTED", {
          deliveryId: atom.deliveryId
        })
      ];
      expect(() => projectReplayTimeline(startedAfterSupersession))
        .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));

      const lateAtom = DeliveryAtomSchema.parse({
        ...atom,
        deliveryId: newDeliveryId(),
        status: "VALIDATED"
      });
      const queuedAfterSupersession = [
        ...authoritative,
        event(harness.sessionId, nextSequence, "DELIVERY_QUEUED", {
          atom: lateAtom
        })
      ];
      expect(() => projectSessionHistory(queuedAfterSupersession))
        .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      harness.store.close();
    }

    const cancellationHarness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(cancellationHarness);
      await new DeliveryCoordinator(cancellationHarness.writer).markStarted(atom.deliveryId);
      const authoritative = cancellationHarness.store.load(cancellationHarness.sessionId);
      const unsafeCancellation = [
        ...authoritative,
        event(
          cancellationHarness.sessionId,
          authoritative.length + 1,
          "DELIVERY_CANCELLED",
          {
            deliveryId: atom.deliveryId,
            reason: "incorrectly treating an in-flight delivery as unseen"
          }
        )
      ];
      expect(() => projectReplayTimeline(unsafeCancellation))
        .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
    } finally {
      cancellationHarness.store.close();
    }
  });

  it("treats an unknown event as a semantic boundary and withholds later known payloads", () => {
    const sessionId = "session-unknown-boundary" as SessionId;
    const secret = "LATER_KNOWN_PAYLOAD_MUST_NOT_BE_INTERPRETED";
    const knownPrefix = base(sessionId, "future-boundary");
    const unknownEvent = {
      eventId: "event-unknown-boundary",
      sessionId,
      sequence: 3,
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION + 1,
      source: "APPLICATION",
      wallTime: "2026-08-31T19:00:03.000Z",
      elapsedMs: 30,
      causationId: "request-unknown-boundary-cause",
      correlationId: "request-unknown-boundary-correlation",
      type: "FUTURE_STATE_TRANSITION",
      payload: { hiddenState: "future-only" }
    };
    const laterKnown = event(sessionId, 4, "SESSION_COMPLETED", {
      completedAt: "2026-08-31T19:00:04.000Z",
      summary: secret
    });
    const history = projectSessionHistory([
      ...knownPrefix,
      unknownEvent,
      laterKnown
    ]);

    expect(history.currentStateAvailable).toBe(false);
    expect(history.validatedThroughSequence).toBe(2);
    expect(history.observedThroughSequence).toBe(4);
    expect(history.lifecycle.status).toBe("UNKNOWN");
    expect(history.lifecycle.completed).toBeNull();
    expect(history.countsComplete).toBe(false);
    expect(history.timeline.entries[2]?.stateValidation).toBe("UNKNOWN_EVENT");
    expect(history.timeline.entries[3]).toMatchObject({
      kind: "SESSION_COMPLETED",
      stateValidation: "UNAVAILABLE_AFTER_UNKNOWN"
    });
    expect(JSON.stringify(history)).not.toContain(secret);

    const invalidPrefix = [
      ...knownPrefix,
      event(sessionId, 3, "INPUT_EPISODE_COMMITTED", {
        inputEpisodeId: "missing-episode"
      }),
      {
        ...unknownEvent,
        eventId: "event-unknown-after-invalid-prefix",
        sequence: 4
      }
    ];
    expect(() => projectReplayTimeline(invalidPrefix))
      .toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEMANTICS" }));
  });

  it("validates projected-prefix sequence and event identity while explicitly truncating the tail", () => {
    const sessionId = "session-tail-corruption" as SessionId;
    const valid = [
      ...base(sessionId, "tail"),
      event(sessionId, 3, "SESSION_RESUMED", {
        resumedAt: "2026-08-31T19:01:03.000Z"
      }),
      event(sessionId, 4, "SESSION_RESUMED", {
        resumedAt: "2026-08-31T19:01:04.000Z"
      })
    ];

    const truncatedTail = [
      valid[0],
      valid[1],
      valid[2],
      { ...valid[3], sequence: 3 }
    ];
    const bounded = projectReplayTimeline(truncatedTail, {
      bounds: { maxEvents: 2 }
    });
    expect(bounded.complete).toBe(false);
    expect(bounded.eventTruncation).toEqual({
      truncated: true,
      limit: 2,
      remainingCount: 2
    });

    const duplicatePrefixSequence = [
      valid[0],
      { ...valid[1], sequence: 1 },
      valid[2]
    ];
    expect(() => projectReplayTimeline(duplicatePrefixSequence, {
      bounds: { maxEvents: 2 }
    })).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEQUENCE" }));

    const duplicateEventId = [
      valid[0],
      valid[1],
      { ...valid[2], eventId: valid[1]?.eventId }
    ];
    expect(() => projectSessionHistory(duplicateEventId))
      .toThrow(expect.objectContaining({ code: "INVALID_EVENT_IDENTITY" }));
  });

  it("bounds evidence provenance arrays without losing explicit truncation metadata", () => {
    const sessionId = "session-provenance-bounds" as SessionId;
    const prefix = [
      ...base(sessionId, "provenance"),
      event(sessionId, 3, "SESSION_RESUMED", {
        resumedAt: "2026-08-31T19:01:03.000Z"
      }),
      event(sessionId, 4, "SESSION_RESUMED", {
        resumedAt: "2026-08-31T19:01:04.000Z"
      }),
      event(sessionId, 5, "SESSION_RESUMED", {
        resumedAt: "2026-08-31T19:01:05.000Z"
      })
    ];
    const provenanceIds = prefix.map((item) => item.eventId);
    const key: EvidenceKey = {
      problemId: "provenance",
      subject: { kind: "SKILL", skillId: "bounded-provenance" },
      dimension: "PROGRESS"
    };
    const value = EvidenceValueSchema.parse({
      value: "PROGRESSING",
      inferenceConfidence: 0.9,
      evidenceEventIds: provenanceIds,
      lastUpdatedSequence: 7
    });
    const history = projectSessionHistory([
      ...prefix,
      event(sessionId, 6, "EVIDENCE_PROPOSED", {
        proposal: {
          key,
          proposedValue: "PROGRESSING",
          inferenceConfidence: 0.9,
          evidenceEventIds: provenanceIds
        }
      }, "PROVIDER"),
      event(sessionId, 7, "STUDENT_EVIDENCE_UPDATED", { key, value })
    ], {
      bounds: { maxProvenanceIds: 2 }
    });

    expect(history.currentEvidence[0]?.value.evidenceEventIds).toHaveLength(2);
    expect(history.currentEvidence[0]?.value.evidenceEventIdsTruncation).toEqual({
      truncated: true,
      limit: 2,
      remainingCount: 3
    });
    expect(history.evidenceHistory[0]?.value?.evidenceEventIds).toHaveLength(2);
    expect(history.timeline.entries[6]?.evidence?.supportingEventIds).toHaveLength(2);
    expect(history.timeline.entries[6]?.evidence?.supportingEventIdsTruncation)
      .toEqual({ truncated: true, limit: 2, remainingCount: 3 });
  });

  it("sanitizes throwing accessors at replay and longitudinal validation boundaries", () => {
    const throwingEvent = {};
    Object.defineProperty(throwingEvent, "eventId", {
      enumerable: true,
      get: () => {
        throw new Error("PRIVATE_GETTER_EVENT_MARKER");
      }
    });

    try {
      projectReplayTimeline([throwingEvent]);
      throw new Error("Expected throwing event accessor rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayProjectionError);
      expect(error).toMatchObject({ code: "INVALID_EVENT_METADATA" });
      expect(String(error)).not.toContain("PRIVATE_GETTER_EVENT_MARKER");
    }

    const statefulSessionId = "session-stateful-event" as SessionId;
    const statefulStart = {
      ...event(statefulSessionId, 1, "SESSION_STARTED", {
        startedAt: "2026-08-31T19:00:01.000Z"
      })
    };
    let eventTypeReads = 0;
    Object.defineProperty(statefulStart, "type", {
      enumerable: true,
      configurable: true,
      get: () => {
        eventTypeReads += 1;
        return eventTypeReads === 1 ? "PROBLEM_PRESENTED" : "SESSION_STARTED";
      }
    });
    expect(() => projectSessionHistory([
      statefulStart,
      event(statefulSessionId, 2, "PROBLEM_PRESENTED", {
        problemId: "stateful-event",
        problemVersion: "1",
        prompt: "Public prompt"
      })
    ])).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SCHEMA" }));
    expect(eventTypeReads).toBe(1);

    const revokedEventProxy = Proxy.revocable<unknown[]>([], {});
    revokedEventProxy.revoke();
    expect(() => projectReplayTimeline(revokedEventProxy.proxy))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const revokedSummaryProxy = Proxy.revocable<unknown[]>([], {});
    revokedSummaryProxy.revoke();
    expect(() => projectLongitudinalHistory(revokedSummaryProxy.proxy))
      .toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));

    const throwingEventArray = new Proxy<unknown[]>([], {
      get: (_target, property): unknown => {
        if (property === "length") {
          throw new Error("PRIVATE_EVENT_ARRAY_MARKER");
        }
        return undefined;
      }
    });
    try {
      projectReplayTimeline(throwingEventArray);
      throw new Error("Expected throwing event array rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayProjectionError);
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      expect(String(error)).not.toContain("PRIVATE_EVENT_ARRAY_MARKER");
    }

    const hiddenEventSessionId = "session-hidden-by-length" as SessionId;
    const inconsistentEventArray = new Proxy<unknown[]>([], {
      get: (_target, property): unknown => {
        if (property === "length") return 0;
        if (property === Symbol.iterator) {
          return function* () {
            yield event(hiddenEventSessionId, 1, "SESSION_STARTED", {
              startedAt: "2026-08-31T19:00:01.000Z"
            });
          };
        }
        return undefined;
      }
    });
    expect(() => projectReplayTimeline(inconsistentEventArray))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const throwingSummaryArray = new Proxy<unknown[]>([], {
      get: (target, property): unknown => {
        if (property === Symbol.iterator) {
          return () => {
            throw new Error("PRIVATE_SUMMARY_ARRAY_MARKER");
          };
        }
        if (property === "length") return target.length;
        return undefined;
      }
    });
    try {
      projectLongitudinalHistory(throwingSummaryArray);
      throw new Error("Expected throwing summary array rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayProjectionError);
      expect(error).toMatchObject({ code: "INVALID_SESSION_SUMMARY" });
      expect(String(error)).not.toContain("PRIVATE_SUMMARY_ARRAY_MARKER");
    }

    const hiddenSummary = projectSessionHistory(
      base("session-hidden-summary" as SessionId, "hidden-summary")
    );
    const inconsistentSummaryArray = new Proxy<unknown[]>([], {
      get: (_target, property): unknown => {
        if (property === "length") return 0;
        if (property === Symbol.iterator) {
          return function* () {
            yield hiddenSummary;
          };
        }
        return undefined;
      }
    });
    expect(() => projectLongitudinalHistory(inconsistentSummaryArray))
      .toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));

    const throwingSummary = {};
    Object.defineProperty(throwingSummary, "sessionId", {
      enumerable: true,
      get: () => {
        throw new Error("PRIVATE_GETTER_SUMMARY_MARKER");
      }
    });

    try {
      projectLongitudinalHistory([throwingSummary]);
      throw new Error("Expected throwing summary accessor rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayProjectionError);
      expect(error).toMatchObject({ code: "INVALID_SESSION_SUMMARY" });
      expect(String(error)).not.toContain("PRIVATE_GETTER_SUMMARY_MARKER");
    }

    const evaluationSessionId = "session-throwing-evaluation" as SessionId;
    const completed = [
      ...base(evaluationSessionId, "throwing-evaluation"),
      event(evaluationSessionId, 3, "SESSION_COMPLETED", {
        completedAt: "2026-08-31T19:10:00.000Z"
      })
    ];
    const throwingEvaluation = {};
    Object.defineProperty(throwingEvaluation, "keyStrengths", {
      enumerable: true,
      get: () => {
        throw new Error("PRIVATE_GETTER_EVALUATION_MARKER");
      }
    });

    try {
      projectSessionHistory(completed, { evaluation: throwingEvaluation });
      throw new Error("Expected throwing evaluation accessor rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayProjectionError);
      expect(error).toMatchObject({ code: "EVALUATION_MISMATCH" });
      expect(String(error)).not.toContain("PRIVATE_GETTER_EVALUATION_MARKER");
    }
  });

  it("fails sanitized on corrupt caller histories and validates linked evaluations", () => {
    const sessionId = "session-invalid" as SessionId;
    const active = base(sessionId, "evaluation", "1.0.0");
    const valid = [
      ...active,
      event(sessionId, 3, "SESSION_COMPLETED", {
        completedAt: "2026-08-31T19:10:00.000Z"
      })
    ];
    const invalidInputs = [
      [{ ...valid[0] }, { ...valid[1], sequence: 1 }],
      [{ ...valid[0] }, { ...valid[1], sequence: 3 }],
      [valid[0], { ...valid[1], sessionId: "different-session" }],
      [valid[0], { ...valid[1], payload: { problemId: "sensitive-marker", problemVersion: "", prompt: "" } }]
    ];

    for (const input of invalidInputs) {
      try {
        projectSessionHistory(input);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ReplayProjectionError);
        expect(String(error)).not.toContain("sensitive-marker");
      }
    }

    const evaluation = groundedEvaluation({
      sessionId,
      problemId: "evaluation",
      problemVersion: "1.0.0",
      score: 82,
      totalTurns: 0,
      evidenceEventId: valid[1]?.eventId
    });
    expect(projectSessionHistory(valid, { evaluation }).evaluation?.scores.compositeScore).toBe(82);

    const statefulEvaluation = { ...evaluation };
    let keyStrengthReads = 0;
    Object.defineProperty(statefulEvaluation, "keyStrengths", {
      enumerable: true,
      configurable: true,
      get: () => {
        keyStrengthReads += 1;
        return keyStrengthReads === 1
          ? ["Grounded"]
          : Array.from(
              { length: MAX_REPLAY_EVALUATION_COLLECTION_ITEMS + 1 },
              () => "should never be re-read"
            );
      }
    });
    expect(projectSessionHistory(valid, {
      evaluation: statefulEvaluation
    }).evaluation?.scores.compositeScore).toBe(82);
    expect(keyStrengthReads).toBe(1);

    expect(() => projectSessionHistory(active, { evaluation }))
      .toThrow(expect.objectContaining({ code: "EVALUATION_MISMATCH" }));
    expect(() => projectSessionHistory(valid, {
      evaluation: { ...evaluation, problemVersion: "2.0.0" }
    })).toThrow(expect.objectContaining({ code: "EVALUATION_MISMATCH" }));

    expect(() => projectSessionHistory(valid, {
      evaluation: {
        ...evaluation,
        keyStrengths: Array.from(
          { length: MAX_REPLAY_EVALUATION_COLLECTION_ITEMS + 1 },
          () => "oversized imported feedback"
        )
      }
    })).toThrow(expect.objectContaining({ code: "EVALUATION_MISMATCH" }));
  });
});

  it("accepts grounded archived-incomplete evaluations without inventing completion or zero scores", () => {
    const sessionId = "session-archived-evaluation" as SessionId;
    const events = [
      ...base(sessionId, "archived-evaluation", "1"),
      event(sessionId, 3, "SESSION_ARCHIVED", {
        archivedAt: "2026-08-31T19:05:00.000Z"
      })
    ];
    const evaluation = groundedEvaluation({
      sessionId,
      problemId: "archived-evaluation",
      problemVersion: "1",
      score: null,
      totalTurns: 0,
      lifecycle: {
        sessionStatus: "ARCHIVED",
        completionState: "ARCHIVED_INCOMPLETE"
      }
    });

    const history = projectSessionHistory(events, { evaluation });
    expect(history.lifecycle).toMatchObject({
      status: "ARCHIVED",
      completed: false,
      archived: true
    });
    expect(history.evaluation).toMatchObject({
      lifecycle: {
        sessionStatus: "ARCHIVED",
        completionState: "ARCHIVED_INCOMPLETE"
      },
      scores: {
        compositeScore: null
      },
      composite: {
        status: "NOT_SCORED",
        supportLevel: "INSUFFICIENT"
      }
    });
  });

  it("rejects attached evaluations whose disclosure provenance disagrees with authoritative delivery", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const coordinator = new DeliveryCoordinator(harness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.acknowledgeExposed(atom.deliveryId);
      await harness.turns.completeSession();

      const evaluation = groundedEvaluation({
        sessionId: harness.sessionId,
        problemId: sixPeopleProblem.id,
        problemVersion: sixPeopleProblem.version,
        score: 50,
        totalTurns: 1,
        evidenceEventId: harness.writer.getState().eventIds.at(-1),
        disclosedInterventions: [{
          deliveryId: atom.deliveryId,
          generationId: atom.generationId,
          turnId: harness.turnId,
          disclosureLevel: atom.effectiveDisclosureLevel,
          disclosureIds: [...atom.disclosureIds],
          relatedMilestoneIds: [],
          deliveryStatus: "EXPOSED",
          summary: "bounded evaluation fixture"
        }]
      });

      const events = harness.store.load(harness.sessionId);
      expect(projectSessionHistory(events, { evaluation }).evaluation)
        .toMatchObject({ disclosedInterventionCount: 1, totalTurns: 1 });

      expect(() => projectSessionHistory(events, {
        evaluation: {
          ...evaluation,
          disclosedInterventions: evaluation.disclosedInterventions.map((item) => ({
            ...item,
            deliveryStatus: "POSSIBLY_EXPOSED"
          }))
        }
      })).toThrow(expect.objectContaining({ code: "EVALUATION_MISMATCH" }));

      expect(() => projectSessionHistory(events, {
        evaluation: {
          ...evaluation,
          evaluatedAt: "not-an-iso-datetime"
        }
      })).toThrow(expect.objectContaining({ code: "EVALUATION_MISMATCH" }));
    } finally {
      harness.store.close();
    }
  });

describe("longitudinal projection", () => {
  function evaluated(
    sessionId: SessionId,
    problemId: string,
    version: string,
    score: number | null,
    value: "PROGRESSING" | "COMPLETE",
    startedAt = "2026-08-31T19:00:01.000Z",
    skillId = "shared-exact-skill"
  ) {
    const started = event(sessionId, 1, "SESSION_STARTED", {
      startedAt
    });
    const problem = event(sessionId, 2, "PROBLEM_PRESENTED", {
      problemId,
      problemVersion: version,
      prompt: "prompt"
    });
    const key: EvidenceKey = {
      problemId,
      subject: { kind: "SKILL", skillId },
      dimension: "PROGRESS"
    };
    const evidence = EvidenceValueSchema.parse({
      value,
      inferenceConfidence: 0.9,
      evidenceEventIds: [problem.eventId],
      lastUpdatedSequence: 4
    });
    const historyEvents = [
      started,
      problem,
      event(sessionId, 3, "EVIDENCE_PROPOSED", {
        proposal: {
          key,
          proposedValue: value,
          inferenceConfidence: 0.9,
          evidenceEventIds: [problem.eventId]
        }
      }, "PROVIDER"),
      event(sessionId, 4, "STUDENT_EVIDENCE_UPDATED", {
        key,
        value: evidence
      }),
      event(sessionId, 5, "SESSION_COMPLETED", {
        completedAt: "2026-08-31T19:05:00.000Z"
      })
    ];
    const evaluation = groundedEvaluation({
      sessionId,
      problemId,
      problemVersion: version,
      score,
      totalTurns: 0,
      evidenceEventId: problem.eventId
    });
    return projectSessionHistory(historyEvents, { evaluation });
  }

  it("aggregates only exact comparable problems/evidence and truncates sessions explicitly", () => {
    expect(projectLongitudinalHistory([]).includedSessionCount).toBe(0);

    const first = evaluated(
      "session-long-a" as SessionId,
      "same",
      "1",
      60,
      "PROGRESSING",
      "2026-08-31T19:00:01.000Z"
    );
    const second = evaluated(
      "session-long-b" as SessionId,
      "same",
      "1",
      80,
      "COMPLETE",
      "2026-08-31T19:01:01.000Z"
    );
    const otherVersion = evaluated(
      "session-long-c" as SessionId,
      "same",
      "2",
      95,
      "COMPLETE",
      "2026-08-31T19:02:01.000Z"
    );
    const result = projectLongitudinalHistory([otherVersion, second, first]);

    expect(result.completedSessions).toBe(3);
    expect(result.sessionsWithUnknownCompletion).toBe(0);
    expect(result.problemsAttempted).toBe(2);
    expect(result.assistanceEligibleSessionCount).toBe(3);
    expect(result.sessionsExcludedFromAssistanceStatistics).toBe(0);
    expect(result.sessionsExcludedFromEvidencePatterns).toBe(0);
    expect(result.repeatedProblems).toEqual([{
      problemId: "same",
      problemVersion: "1",
      attemptCount: 2
    }]);
    expect(result.evaluationStatistics.find((item) =>
      item.problemVersion === "1"
    )?.average.compositeScore).toBe(70);
    expect(result.improvement).toEqual([{
      problemId: "same",
      problemVersion: "1",
      fromSessionId: "session-long-a",
      toSessionId: "session-long-b",
      compositeScoreDelta: 20
    }]);
    expect(result.improvementComparisonsSkipped).toBe(0);
    expect(result.comparability.skillTaxonomyAvailable).toBe(false);
    expect(result.evidencePatterns.some((item) =>
      item.key.subject.kind === "SKILL"
      && item.key.subject.skillId === "shared-exact-skill"
      && item.sessionCount >= 2
    )).toBe(true);

    const bounded = projectLongitudinalHistory([first, second, otherVersion], {
      bounds: { maxSessions: 2 }
    });
    expect(bounded.sessionTruncation).toEqual({
      truncated: true,
      limit: 2,
      remainingCount: 1
    });
    expect(() => projectLongitudinalHistory([first, first]))
      .toThrow(expect.objectContaining({ code: "DUPLICATE_SESSION" }));
  });

  it("uses locale-independent code-unit ordering for deterministic aggregate output", () => {
    const zeta = evaluated(
      "session-order-zeta" as SessionId,
      "Zeta",
      "1",
      60,
      "PROGRESSING",
      "2026-08-31T20:10:01.000Z"
    );
    const alpha = evaluated(
      "session-order-alpha" as SessionId,
      "alpha",
      "1",
      70,
      "PROGRESSING",
      "2026-08-31T20:11:01.000Z"
    );
    const accented = evaluated(
      "session-order-accented" as SessionId,
      "éclair",
      "1",
      80,
      "PROGRESSING",
      "2026-08-31T20:12:01.000Z"
    );

    const result = projectLongitudinalHistory([accented, alpha, zeta]);
    expect(result.evaluationStatistics.map((entry) => entry.problemId))
      .toEqual(["Zeta", "alpha", "éclair"]);
  });

  it("deep-validates only the deterministically included maxSessions subset", () => {
    const included = evaluated(
      "session-bounded-include" as SessionId,
      "bounded",
      "1",
      70,
      "PROGRESSING",
      "2026-08-31T18:00:00.000Z"
    );
    const excludedOversized = {
      sessionId: "session-bounded-exclude",
      lifecycle: {
        startedAt: "2099-01-01T00:00:00.000Z",
        completed: true,
        historyComplete: true
      },
      currentEvidence: Array.from(
        { length: DEFAULT_REPLAY_BOUNDS.maxEvidenceHistoryEntries + 1 },
        () => ({ deliberatelyMalformed: true })
      )
    };

    const result = projectLongitudinalHistory(
      [excludedOversized, included],
      { bounds: { maxSessions: 1 } }
    );
    expect(result.includedSessionCount).toBe(1);
    expect(result.totalInputSessions).toBe(2);
    expect(result.sessionTruncation.remainingCount).toBe(1);
    expect(result.evaluationStatistics[0]?.problemId).toBe("bounded");
  });

  it("orders recorded ISO start instants rather than comparing timestamp strings", () => {
    const first = evaluated(
      "session-time-first" as SessionId,
      "time-order",
      "1",
      50,
      "PROGRESSING",
      "2026-08-31T18:00:00Z"
    );
    const second = evaluated(
      "session-time-second" as SessionId,
      "time-order",
      "1",
      80,
      "COMPLETE",
      "2026-08-31T18:00:00.500Z"
    );

    const result = projectLongitudinalHistory([second, first]);
    expect(result.improvement).toEqual([{
      problemId: "time-order",
      problemVersion: "1",
      fromSessionId: "session-time-first",
      toSessionId: "session-time-second",
      compositeScoreDelta: 30
    }]);
  });

  it("excludes unsupported grounded scores instead of treating them as zero", () => {
    const scored = evaluated(
      "session-grounded-scored" as SessionId,
      "grounded-null",
      "1",
      80,
      "PROGRESSING",
      "2026-08-31T20:20:01.000Z"
    );
    const unscored = evaluated(
      "session-grounded-unscored" as SessionId,
      "grounded-null",
      "1",
      null,
      "PROGRESSING",
      "2026-08-31T20:21:01.000Z"
    );

    const result = projectLongitudinalHistory([scored, unscored]);
    const stats = result.evaluationStatistics[0];
    expect(stats?.sessionCount).toBe(2);
    expect(stats?.scoredSessionCount.compositeScore).toBe(1);
    expect(stats?.average.compositeScore).toBe(80);
    expect(stats?.median.compositeScore).toBe(80);
    expect(result.improvement).toEqual([]);
    expect(result.improvementComparisonsSkipped).toBe(1);
  });

  it("uses collision-safe structured identities for problems and evidence", () => {
    const problemCollisionA = evaluated(
      "session-problem-collision-a" as SessionId,
      "a\u0000b",
      "c",
      60,
      "PROGRESSING",
      "2026-08-31T20:00:01.000Z"
    );
    const problemCollisionB = evaluated(
      "session-problem-collision-b" as SessionId,
      "a",
      "b\u0000c",
      70,
      "COMPLETE",
      "2026-08-31T20:01:01.000Z"
    );
    const problemResult = projectLongitudinalHistory([
      problemCollisionA,
      problemCollisionB
    ]);
    expect(problemResult.problemsAttempted).toBe(2);
    expect(problemResult.repeatedProblems).toEqual([]);

    const evidenceCollisionA = evaluated(
      "session-evidence-collision-a" as SessionId,
      "p|SKILL|x",
      "1",
      60,
      "PROGRESSING",
      "2026-08-31T20:02:01.000Z",
      "y"
    );
    const evidenceCollisionB = evaluated(
      "session-evidence-collision-b" as SessionId,
      "p",
      "1",
      70,
      "COMPLETE",
      "2026-08-31T20:03:01.000Z",
      "x|SKILL|y"
    );
    expect(
      evidenceCollisionA.currentEvidence[0]?.keyString
    ).toBe(evidenceCollisionB.currentEvidence[0]?.keyString);

    const evidenceResult = projectLongitudinalHistory([
      evidenceCollisionA,
      evidenceCollisionB
    ]);
    expect(evidenceResult.evidencePatterns).toHaveLength(2);
    expect(evidenceResult.evidencePatterns.every((item) =>
      item.sessionCount === 1
    )).toBe(true);
  });

  it("accepts direct archival without inventing completion", () => {
    const sessionId = "session-direct-archive-longitudinal" as SessionId;
    const summary = projectSessionHistory([
      ...base(sessionId, "direct-archive", "1"),
      event(sessionId, 3, "SESSION_ARCHIVED", {
        archivedAt: "2026-08-31T21:00:00.000Z"
      })
    ]);
    expect(summary.lifecycle).toMatchObject({
      status: "ARCHIVED",
      completed: false,
      archived: true
    });

    const result = projectLongitudinalHistory([summary]);
    expect(result.includedSessionCount).toBe(1);
    expect(result.completedSessions).toBe(0);
    expect(result.sessionsWithUnknownCompletion).toBe(0);
  });

  it("rejects malformed longitudinal summaries and does not invent chronological improvement on ties", () => {
    const first = evaluated(
      "session-malformed-a" as SessionId,
      "ordered",
      "1",
      50,
      "PROGRESSING",
      "2026-08-31T21:00:00.000Z"
    );
    const second = evaluated(
      "session-malformed-b" as SessionId,
      "ordered",
      "1",
      80,
      "COMPLETE",
      "2026-08-31T21:00:00.000Z"
    );

    const tied = projectLongitudinalHistory([second, first]);
    expect(tied.improvement).toEqual([]);
    expect(tied.improvementComparisonsSkipped).toBe(1);

    expect(() => projectLongitudinalHistory([{
      ...first,
      counts: { ...first.counts, exposedInterventions: -1 }
    }])).toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));

    expect(() => projectLongitudinalHistory([{
      ...first,
      evaluation: first.evaluation === undefined
        ? undefined
        : {
            ...first.evaluation,
            scores: {
              ...first.evaluation.scores,
              compositeScore: Number.NaN
            }
          }
    }])).toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));

    expect(() => projectLongitudinalHistory([{
      ...first,
      evaluation: undefined,
      totalEventCount: DEFAULT_REPLAY_BOUNDS.maxEvents + 1,
      observedThroughSequence: DEFAULT_REPLAY_BOUNDS.maxEvents + 1,
      validatedThroughSequence: DEFAULT_REPLAY_BOUNDS.maxEvents + 1
    }])).toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));

    expect(() => projectLongitudinalHistory([{
      ...first,
      evaluation: undefined,
      counts: {
        ...first.counts,
        exposedInterventions: first.totalEventCount + 1
      }
    }])).toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));

    expect(() => projectLongitudinalHistory([{
      ...first,
      evaluation: undefined,
      lifecycle: {
        ...first.lifecycle,
        status: "ACTIVE",
        completed: true,
        archived: false
      }
    }])).toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));

    expect(() => projectLongitudinalHistory([{
      ...first,
      evaluation: undefined,
      counts: {
        ...first.counts,
        deliveries: 0,
        exposedInterventions: 1
      }
    }])).toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));

    const originalEvidence = first.currentEvidence[0];
    if (originalEvidence === undefined) {
      throw new Error("Missing longitudinal evidence fixture");
    }
    const duplicateEvidenceKey: EvidenceKey = {
      problemId: originalEvidence.key.problemId,
      subject: { kind: "SKILL", skillId: "duplicate-event-id-key" },
      dimension: originalEvidence.key.dimension
    };
    expect(() => projectLongitudinalHistory([{
      ...first,
      evaluation: undefined,
      currentEvidence: [
        originalEvidence,
        {
          ...originalEvidence,
          key: duplicateEvidenceKey,
          keyString: evidenceKeyToString(duplicateEvidenceKey)
        }
      ]
    }])).toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));

    const statefulSummary = { ...first, evaluation: undefined };
    let sessionIdReads = 0;
    Object.defineProperty(statefulSummary, "sessionId", {
      enumerable: true,
      configurable: true,
      get: () => {
        sessionIdReads += 1;
        return sessionIdReads === 1
          ? first.sessionId
          : "session-mutated-after-selection";
      }
    });
    expect(() => projectLongitudinalHistory([statefulSummary]))
      .toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));
    expect(sessionIdReads).toBeGreaterThanOrEqual(2);

    expect(() => projectLongitudinalHistory([projectSessionHistory([])]))
      .toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  DeliveryAtomSchema,
  EvidenceValueSchema,
  SessionEvaluationSchema,
  newDeliveryId,
  newRequestId,
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
  SessionRuntimeRegistry,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import {
  ReplayProjectionError,
  projectLongitudinalHistory,
  projectReplayTimeline,
  projectSessionHistory
} from "../packages/replay/src/index.js";
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
      text: "Authoritative audio transcript metadata",
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

describe("replay/history projections", () => {
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
    } finally {
      exposedHarness.store.close();
    }

    const cancelledHarness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(cancelledHarness);
      const queued = projectReplayTimeline(cancelledHarness.store.load(cancelledHarness.sessionId))
        .entries.find((entry) => entry.kind === "DELIVERY_QUEUED");
      expect(queued?.delivery?.presentationState).toBe("AUTHORIZED");
      expect(queued?.delivery?.status).toBe("QUEUED");
      await new DeliveryCoordinator(cancelledHarness.writer)
        .cancelBeforeExposure(atom.deliveryId, "cancelled before renderer exposure");
      const cancelled = projectReplayTimeline(cancelledHarness.store.load(cancelledHarness.sessionId))
        .entries.find((entry) => entry.kind === "DELIVERY_CANCELLED");
      expect(cancelled?.delivery?.presentationState).toBe("CANCELLED");
    } finally {
      cancelledHarness.store.close();
    }

    const possibleHarness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(possibleHarness);
      const coordinator = new DeliveryCoordinator(possibleHarness.writer);
      await coordinator.markStarted(atom.deliveryId);
      await coordinator.markPossiblyExposed(atom.deliveryId, "transport uncertainty");
      const history = projectSessionHistory(possibleHarness.store.load(possibleHarness.sessionId));
      expect(history.counts.possiblyExposedInterventions).toBe(1);
      expect(history.counts.exposedInterventions).toBe(0);
      expect(history.timeline.entries.find((entry) =>
        entry.kind === "DELIVERY_POSSIBLY_EXPOSED"
      )?.delivery?.presentationState).toBe("POSSIBLY_PRESENTED");
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
    } finally {
      audioHarness.store.close();
    }

    const boardHarness = await createCoreHarness();
    try {
      const outcome = await boardHarness.turns.processProposal({
        envelope: createCommandEnvelope({
          sessionId: boardHarness.sessionId,
          producer: "mock-model",
          inputEpisodeId: boardHarness.inputEpisodeId,
          turnId: boardHarness.turnId,
          generationId: boardHarness.generationId
        }),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          boardActions: [{
            operation: "circle",
            layer: "AI_ANNOTATION",
            targetShapeId: "student-shape-1",
            expectedShapeRevision: 4,
            annotationPurpose: boardHarness.safeProbe
          }]
        },
        validator: boardHarness.validator
      });
      const atom = outcome.deliveryAtoms[0];
      if (atom === undefined) throw new Error("Expected whiteboard delivery");
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
        deliveryIds: [atom.deliveryId],
        lateEventAfterSupersession: false
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

      expect(history.lifecycle.conservativeRecoveryCount).toBe(1);
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
  });

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
    });
    const episodeUpdated = event(sessionId, 4, "INPUT_EPISODE_UPDATED", {
      inputEpisodeId: "episode-verification",
      modality: "TYPING",
      semanticContent: "A claim to verify"
    });
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
      events.push(event(sessionId, sequence, "VERIFICATION_REQUESTED", {
        verificationRequestId: requestId,
        verifier: "deterministic-verifier",
        basis: basis(),
        candidateFormalInterpretation: `formal claim ${String(index)}`,
        interpretationConfidence: 1,
        evidenceKey: key,
        evidenceEventIds: [turn.eventId]
      }));
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

  it("handles lifecycle states, mixed v1/v2 upcasts, future events, and explicit bounds safely", () => {
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
      }),
      event(boundedSessionId, 4, "INPUT_EPISODE_UPDATED", {
        inputEpisodeId: "episode-bounds",
        modality: "TYPING",
        semanticContent: longText
      }),
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
    expect(history.knownThroughSequence).toBe(4);
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

  it("validates sequence and event identity across the entire raw history beyond projection bounds", () => {
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

    const duplicateTailSequence = [
      valid[0],
      valid[1],
      valid[2],
      { ...valid[3], sequence: 3 }
    ];
    expect(() => projectReplayTimeline(duplicateTailSequence, {
      bounds: { maxEvents: 2 }
    })).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SEQUENCE" }));

    const gappedTail = [
      valid[0],
      valid[1],
      valid[2],
      { ...valid[3], sequence: 5 }
    ];
    expect(() => projectReplayTimeline(gappedTail, {
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
      lastUpdatedSequence: 6
    });
    const history = projectSessionHistory([
      ...prefix,
      event(sessionId, 6, "STUDENT_EVIDENCE_UPDATED", { key, value })
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
    expect(history.timeline.entries[5]?.evidence?.supportingEventIds).toHaveLength(2);
    expect(history.timeline.entries[5]?.evidence?.supportingEventIdsTruncation)
      .toEqual({ truncated: true, limit: 2, remainingCount: 3 });
  });

  it("fails sanitized on corrupt caller histories and validates linked evaluations", () => {
    const sessionId = "session-invalid" as SessionId;
    const valid = base(sessionId, "evaluation", "1.0.0");
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

    const evaluation = SessionEvaluationSchema.parse({
      sessionId,
      problemId: "evaluation",
      problemVersion: "1.0.0",
      evaluatedAt: "2026-08-31T20:00:00.000Z",
      scores: {
        technicalCorrectness: 80,
        rigor: 75,
        independence: 90,
        communication: 85,
        hintResponsiveness: 88,
        errorRecovery: 70,
        compositeScore: 82
      },
      milestones: [],
      disclosedInterventions: [],
      unassistedMilestoneCount: 0,
      assistedMilestoneCount: 0,
      totalTurns: 0,
      keyStrengths: ["Grounded"],
      areasForImprovement: ["Practice"],
      summaryAssessment: "Summary"
    });
    expect(projectSessionHistory(valid, { evaluation }).evaluation?.scores.compositeScore).toBe(82);
    expect(() => projectSessionHistory(valid, {
      evaluation: { ...evaluation, problemVersion: "2.0.0" }
    })).toThrow(expect.objectContaining({ code: "EVALUATION_MISMATCH" }));
  });
});

describe("longitudinal projection", () => {
  function evaluated(
    sessionId: SessionId,
    problemId: string,
    version: string,
    score: number,
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
    const evidence = EvidenceValueSchema.parse({
      value,
      inferenceConfidence: 0.9,
      evidenceEventIds: [turn.eventId],
      lastUpdatedSequence: 3
    });
    const historyEvents = [
      started,
      problem,
      event(sessionId, 3, "STUDENT_EVIDENCE_UPDATED", {
        key: {
          problemId,
          subject: { kind: "SKILL", skillId },
          dimension: "PROGRESS"
        },
        value: evidence
      }),
      event(sessionId, 4, "SESSION_COMPLETED", {
        completedAt: "2026-08-31T19:05:00.000Z"
      })
    ];
    const evaluation = SessionEvaluationSchema.parse({
      sessionId,
      problemId,
      problemVersion: version,
      evaluatedAt: "2026-08-31T20:00:00.000Z",
      scores: {
        technicalCorrectness: score,
        rigor: score,
        independence: score,
        communication: score,
        hintResponsiveness: score,
        errorRecovery: score,
        compositeScore: score
      },
      milestones: [],
      disclosedInterventions: [],
      unassistedMilestoneCount: 0,
      assistedMilestoneCount: 0,
      totalTurns: 0,
      keyStrengths: ["x"],
      areasForImprovement: ["y"],
      summaryAssessment: "z"
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

    expect(() => projectLongitudinalHistory([projectSessionHistory([])]))
      .toThrow(expect.objectContaining({ code: "INVALID_SESSION_SUMMARY" }));
  });
});

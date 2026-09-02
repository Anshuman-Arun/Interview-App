import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  BoardRevisionSchema,
  evidenceKeyToString,
  newRequestId,
  newSessionId,
  type AuthoritativeStudentShape,
  type SessionId,
  type WhiteboardVisionSnapshotUpload
} from "../packages/domain/src/index.js";
import {
  DeterministicFakeVisionBackend,
  RuleBasedVisionEvidenceInterpreter,
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope,
  decidePedagogicalPolicy,
  type VisionInferenceBackend
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { createValidatedImageSnapshot } from "../packages/vision/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  SessionRecoveryCoordinator
} from "../apps/server/src/session-recovery-coordinator.js";
import {
  WhiteboardVisionCoordinator
} from "../apps/server/src/whiteboard-vision-coordinator.js";

function graphShape(revision = 1, x = 0): AuthoritativeStudentShape {
  return {
    id: "shape:graph-model",
    type: "rectangle",
    bounds: { x, y: 0, width: 100, height: 100 },
    revision,
    createdAt: 1,
    lastModifiedAt: revision
  };
}

function pngBase64(width = 16, height = 16): string {
  const data = Buffer.alloc(width * height * 4, 255);
  return PNG.sync.write(
    { width, height, data },
    { colorType: 6, inputColorType: 6, bitDepth: 8 }
  ).toString("base64");
}

function upload(
  sessionId: SessionId,
  changes: Partial<WhiteboardVisionSnapshotUpload> = {}
): WhiteboardVisionSnapshotUpload {
  return {
    protocolVersion: 1,
    requestId: newRequestId(),
    sessionId,
    sourceBoardRevision: BoardRevisionSchema.parse(1),
    snapshotId: "snapshot-current",
    capturedAtMs: 10,
    declaredWidth: 16,
    declaredHeight: 16,
    region: {
      regionId: "region-graph",
      bounds: { x: -10, y: -10, width: 140, height: 140 },
      relevantShapeIds: ["shape:graph-model"]
    },
    relevantShapeRevisions: [{
      shapeId: "shape:graph-model",
      expectedRevision: 1
    }],
    requestedObservationKind: "ANY",
    pngBase64: pngBase64(),
    ...changes
  };
}

async function startedBoardSession() {
  const store = new SqliteEventStore(":memory:");
  const registry = new SessionRuntimeRegistry(store);
  const sessionId = newSessionId();
  const writer = registry.get(sessionId);
  const turns = new TurnCoordinator(writer);
  await turns.startSession(sixPeopleProblem);
  const { turnId } = await turns.commitInput(
    "I am trying to represent the relationships as a graph."
  );
  const board = await turns.commitBoardMutation({
    baseBoardRevision: BoardRevisionSchema.parse(0),
    added: [graphShape()],
    updated: [],
    deleted: []
  });
  if (!board.committed) throw new Error("Board fixture did not commit");
  const sessions = new SessionRecoveryCoordinator(registry, store);
  return { store, registry, sessionId, writer, turns, turnId, sessions };
}

function progressInterpreter(): RuleBasedVisionEvidenceInterpreter {
  return new RuleBasedVisionEvidenceInterpreter([{
    observationKind: "DIAGRAM_RELATION",
    subject: { kind: "MILESTONE", milestoneId: "model-relations" },
    dimension: "PROGRESS",
    proposedValue: "PROGRESSING",
    minConfidence: 0.8
  }]);
}

describe("application whiteboard vision integration", () => {
  it("admits current deterministic vision, bridges scoped evidence, and changes normal Socratic policy", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "The student modeled the people as a two-relation graph.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      evidenceInterpreter: progressInterpreter()
    });

    try {
      const before = decidePedagogicalPolicy(
        harness.writer.getState(),
        harness.turnId,
        sixPeopleProblem
      );
      expect(before.realizationRequest.requiredAction).not.toBe("WAIT");

      const request = upload(harness.sessionId);
      const result = await coordinator.process(request);
      expect(result).toEqual({
        protocolVersion: 1,
        requestId: request.requestId,
        sessionId: harness.sessionId,
        status: "ACCEPTED",
        observationCount: 1,
        evidenceCommittedCount: 1
      });
      expect(backend.analyzeCallCount).toBe(1);

      const state = harness.writer.getState();
      const visionState = state.visionRequests[request.requestId];
      expect(visionState?.status).toBe("ACCEPTED");
      expect(visionState?.acceptedObservation?.snapshotBasis.snapshotId)
        .toBe("snapshot-current");
      expect(visionState?.resultEventId).toBeDefined();

      const key = evidenceKeyToString({
        problemId: sixPeopleProblem.id,
        subject: { kind: "MILESTONE", milestoneId: "model-relations" },
        dimension: "PROGRESS"
      });
      expect(state.studentEvidence[key]).toMatchObject({
        value: "PROGRESSING",
        inferenceConfidence: 0.95
      });

      const after = decidePedagogicalPolicy(
        state,
        harness.turnId,
        sixPeopleProblem
      );
      expect(after.classification).toBe("PRODUCTIVE_PROGRESS");
      expect(after.realizationRequest.requiredAction).toBe("WAIT");
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("accepts an observation about a subset of shapes while preserving the complete request dependency basis", async () => {
    const harness = await startedBoardSession();
    await harness.turns.commitBoardMutation({
      baseBoardRevision: BoardRevisionSchema.parse(1),
      added: [{
        id: "shape:graph-label",
        type: "text",
        bounds: { x: 110, y: 0, width: 30, height: 30 },
        text: "K6",
        revision: 1,
        createdAt: 1,
        lastModifiedAt: 1
      }],
      updated: [],
      deleted: []
    });
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "The main graph shape encodes the relationship model.",
      confidence: 0.94,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend
    });

    try {
      const request = upload(harness.sessionId, {
        sourceBoardRevision: BoardRevisionSchema.parse(2),
        region: {
          regionId: "region-graph",
          bounds: { x: -10, y: -10, width: 170, height: 140 },
          relevantShapeIds: ["shape:graph-label", "shape:graph-model"]
        },
        relevantShapeRevisions: [
          { shapeId: "shape:graph-label", expectedRevision: 1 },
          { shapeId: "shape:graph-model", expectedRevision: 1 }
        ]
      });
      const result = await coordinator.process(request);
      expect(result.status).toBe("ACCEPTED");

      const accepted = harness.writer.getState()
        .visionRequests[request.requestId]?.acceptedObservation;
      expect(accepted?.sourceRelevantShapeIds).toEqual([
        "shape:graph-label",
        "shape:graph-model"
      ]);
      expect(accepted?.observation.relevantShapeIds).toEqual([
        "shape:graph-model"
      ]);
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("keeps vision evidence across unrelated out-of-region edits but invalidates it when a supporting shape revision changes", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "The graph representation is present.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      evidenceInterpreter: progressInterpreter()
    });

    try {
      const request = upload(harness.sessionId);
      const admitted = await coordinator.process(request);
      expect(admitted.status).toBe("ACCEPTED");

      const key = evidenceKeyToString({
        problemId: sixPeopleProblem.id,
        subject: { kind: "MILESTONE", milestoneId: "model-relations" },
        dimension: "PROGRESS"
      });
      expect(harness.writer.getState().studentEvidence[key]?.value).toBe("PROGRESSING");

      const outside = await harness.turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(1),
        added: [{
          id: "shape:outside-region",
          type: "rectangle",
          bounds: { x: 500, y: 500, width: 20, height: 20 },
          revision: 1,
          createdAt: 1,
          lastModifiedAt: 1
        }],
        updated: [],
        deleted: []
      });
      expect(outside).toMatchObject({
        committed: true,
        boardRevision: BoardRevisionSchema.parse(2)
      });
      expect(harness.writer.getState().studentEvidence[key]?.value).toBe("PROGRESSING");

      const supportingChange = await harness.turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(2),
        added: [],
        updated: [{
          beforeRevision: 1,
          shape: graphShape(2, 20)
        }],
        deleted: []
      });
      expect(supportingChange).toMatchObject({
        committed: true,
        boardRevision: BoardRevisionSchema.parse(3)
      });
      const state = harness.writer.getState();
      expect(state.studentEvidence[key]).toBeUndefined();
      expect(state.evidenceHistory[key]?.at(-1)).toMatchObject({
        status: "STALE",
        invalidationReason: "Authoritative whiteboard changed the supporting vision basis"
      });
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("invalidates vision evidence when region membership changes even if all previously bound shapes are untouched", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "The graph representation is present.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      evidenceInterpreter: progressInterpreter()
    });

    try {
      await coordinator.process(upload(harness.sessionId));
      const key = evidenceKeyToString({
        problemId: sixPeopleProblem.id,
        subject: { kind: "MILESTONE", milestoneId: "model-relations" },
        dimension: "PROGRESS"
      });
      expect(harness.writer.getState().studentEvidence[key]).toBeDefined();

      await harness.turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(1),
        added: [{
          id: "shape:new-region-member",
          type: "text",
          bounds: { x: 15, y: 15, width: 15, height: 15 },
          text: "new",
          revision: 1,
          createdAt: 1,
          lastModifiedAt: 1
        }],
        updated: [],
        deleted: []
      });

      expect(harness.writer.getState().studentEvidence[key]).toBeUndefined();
      expect(harness.writer.getState().evidenceHistory[key]?.at(-1)?.status)
        .toBe("STALE");
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("invalidates all vision-derived evidence when a summary-only board patch destroys shape authority", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "The graph representation is present.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      evidenceInterpreter: progressInterpreter()
    });

    try {
      await coordinator.process(upload(harness.sessionId));
      const key = evidenceKeyToString({
        problemId: sixPeopleProblem.id,
        subject: { kind: "MILESTONE", milestoneId: "model-relations" },
        dimension: "PROGRESS"
      });
      expect(harness.writer.getState().studentEvidence[key]).toBeDefined();

      await harness.turns.commitBoardPatch("legacy summary-only board update");

      const state = harness.writer.getState();
      expect(state.boardShapeAuthorityKnown).toBe(false);
      expect(state.studentEvidence[key]).toBeUndefined();
      expect(state.evidenceHistory[key]?.at(-1)).toMatchObject({
        status: "STALE",
        invalidationReason: "Whiteboard shape authority became unknown after a summary-only board update"
      });
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("accepts a low-confidence observation without promoting it to authoritative evidence", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "Possible graph representation.",
      confidence: 0.6,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      evidenceInterpreter: progressInterpreter()
    });

    try {
      const result = await coordinator.process(upload(harness.sessionId));
      expect(result.status).toBe("ACCEPTED");
      expect(result.observationCount).toBe(1);
      expect(result.evidenceCommittedCount).toBe(0);
      expect(Object.keys(harness.writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("rejects a late backend result after the relevant shape revision changes even when the backend ignores cancellation", async () => {
    const harness = await startedBoardSession();
    const fake = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "Late graph interpretation.",
      confidence: 0.99,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const started = deferred<undefined>();
    const release = deferred<undefined>();
    const ignoringBackend: VisionInferenceBackend = {
      provenance: fake.provenance,
      analyze: async (request) => {
        started.resolve(undefined);
        await release.promise;
        return fake.analyze(request, { signal: new AbortController().signal });
      }
    };
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend: ignoringBackend,
      evidenceInterpreter: progressInterpreter()
    });

    try {
      const request = upload(harness.sessionId);
      const pending = coordinator.process(request);
      await started.promise;

      const changed = await harness.turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(1),
        added: [],
        updated: [{
          beforeRevision: 1,
          shape: graphShape(2, 25)
        }],
        deleted: []
      });
      expect(changed).toMatchObject({
        committed: true,
        boardRevision: BoardRevisionSchema.parse(2)
      });
      expect(coordinator.supersedeStaleRequests(harness.sessionId)).toBe(1);

      release.resolve(undefined);
      const result = await pending;
      expect(result.status).toBe("REJECTED");
      expect(result.reason).toMatch(/STALE_|FRESHNESS_|REQUEST_CANCELLED/u);
      expect(result.evidenceCommittedCount).toBe(0);
      expect(Object.keys(harness.writer.getState().studentEvidence)).toHaveLength(0);
      expect(harness.writer.getState().visionRequests[request.requestId]?.status)
        .toBe("DISCARDED");
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("coalesces concurrent identical snapshot requests into one backend execution", async () => {
    const harness = await startedBoardSession();
    const fake = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "One shared inference.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const started = deferred<undefined>();
    const release = deferred<undefined>();
    const backend: VisionInferenceBackend = {
      provenance: fake.provenance,
      analyze: async (request) => {
        started.resolve(undefined);
        await release.promise;
        return fake.analyze(request, { signal: new AbortController().signal });
      }
    };
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend
    });

    try {
      const request = upload(harness.sessionId);
      const first = coordinator.process(request);
      await started.promise;
      const duplicate = coordinator.process(request);
      release.resolve(undefined);

      const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
      expect(duplicateResult).toEqual(firstResult);
      expect(firstResult.status).toBe("ACCEPTED");
      expect(fake.analyzeCallCount).toBe(1);
      expect(harness.writer.getState().visionRequests[request.requestId]?.status)
        .toBe("ACCEPTED");
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("terminally discards a recovered pending request when its board basis became stale", async () => {
    const harness = await startedBoardSession();
    const request = upload(harness.sessionId);
    const encodedBytes = Buffer.from(request.pngBase64, "base64");
    const snapshot = createValidatedImageSnapshot({
      snapshotId: request.snapshotId,
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: request.sourceBoardRevision,
      capturedAtMs: request.capturedAtMs,
      mimeType: "image/png",
      declaredWidth: request.declaredWidth,
      declaredHeight: request.declaredHeight,
      encodedBytes
    });
    await harness.turns.requestVision(
      request.region.regionId,
      request.region.relevantShapeIds,
      {
        visionRequestId: request.requestId,
        snapshotBasis: {
          snapshotId: request.snapshotId,
          snapshotHash: snapshot.metadata.contentDigest,
          preprocessingVersion: "whiteboard-snapshot-v1",
          sourceBoardRevision: request.sourceBoardRevision
        },
        relevantShapeRevisions: request.relevantShapeRevisions,
        regionBounds: request.region.bounds,
        requestedObservationKind: request.requestedObservationKind
      }
    );
    expect(harness.writer.getState().visionRequests[request.requestId]?.status)
      .toBe("PENDING");

    await harness.turns.commitBoardMutation({
      baseBoardRevision: BoardRevisionSchema.parse(1),
      added: [],
      updated: [{
        beforeRevision: 1,
        shape: graphShape(2, 20)
      }],
      deleted: []
    });

    const backend = new DeterministicFakeVisionBackend([]);
    const restarted = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend
    });
    try {
      const result = await restarted.process(request);
      expect(result).toMatchObject({
        status: "REJECTED",
        reason: "STALE_BOARD"
      });
      expect(backend.analyzeCallCount).toBe(0);
      expect(harness.writer.getState().visionRequests[request.requestId]).toMatchObject({
        status: "DISCARDED",
        discardReason: "STALE_BOARD"
      });
    } finally {
      restarted.shutdown();
      harness.store.close();
    }
  });

  it("replays a durable accepted outcome after coordinator restart without requiring a backend", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "Durable accepted graph observation.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const request = upload(harness.sessionId);
    const firstCoordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend
    });

    try {
      const first = await firstCoordinator.process(request);
      expect(first.status).toBe("ACCEPTED");
      expect(backend.analyzeCallCount).toBe(1);
      firstCoordinator.shutdown();

      await harness.turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(1),
        added: [{
          id: "shape:later-unrelated",
          type: "rectangle",
          bounds: { x: 500, y: 500, width: 20, height: 20 },
          revision: 1,
          createdAt: 1,
          lastModifiedAt: 1
        }],
        updated: [],
        deleted: []
      });

      const restarted = new WhiteboardVisionCoordinator({
        sessions: harness.sessions
      });
      try {
        const replay = await restarted.process(request);
        expect(replay).toEqual(first);
        expect(backend.analyzeCallCount).toBe(1);

        const conflict = await restarted.process({
          ...request,
          snapshotId: "snapshot-conflicting-after-restart"
        });
        expect(conflict).toMatchObject({
          status: "REJECTED",
          reason: "CONFLICTING_REQUEST_ID"
        });

        const replayAgain = await restarted.process(request);
        expect(replayAgain).toEqual(first);
      } finally {
        restarted.shutdown();
      }
    } finally {
      firstCoordinator.shutdown();
      harness.store.close();
    }
  });

  it("treats a throwing vision evidence interpreter as no evidence without losing an accepted observation", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "Observation remains authoritative even if interpretation policy fails.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      evidenceInterpreter: {
        propose: () => {
          throw new Error("malicious evidence interpreter");
        }
      }
    });

    try {
      const request = upload(harness.sessionId);
      const result = await coordinator.process(request);
      expect(result).toMatchObject({
        status: "ACCEPTED",
        observationCount: 1,
        evidenceCommittedCount: 0
      });
      expect(harness.writer.getState().visionRequests[request.requestId]?.status)
        .toBe("ACCEPTED");
      expect(Object.keys(harness.writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("keeps the first request-ID tombstone immutable when a conflicting duplicate arrives", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "Graph model.",
      confidence: 0.9,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend
    });

    try {
      const original = upload(harness.sessionId);
      const first = await coordinator.process(original);
      expect(first.status).toBe("ACCEPTED");

      const conflicting = {
        ...original,
        snapshotId: "snapshot-conflicting"
      };
      const conflict = await coordinator.process(conflicting);
      expect(conflict).toMatchObject({
        status: "REJECTED",
        reason: "CONFLICTING_REQUEST_ID"
      });

      const replay = await coordinator.process(original);
      expect(replay).toEqual(first);
      expect(backend.analyzeCallCount).toBe(1);
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("refuses vision-derived evidence when the board changes after observation admission but before evidence commit", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "Current graph model.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend
    });

    try {
      const request = upload(harness.sessionId);
      const visionResult = await coordinator.process(request);
      expect(visionResult.status).toBe("ACCEPTED");

      const acceptedRequest = harness.writer.getState().visionRequests[request.requestId];
      const eventId = acceptedRequest?.resultEventId;
      const admittedAtBoardRevision =
        acceptedRequest?.acceptedObservation?.admittedAtBoardRevision;
      if (eventId === undefined || admittedAtBoardRevision === undefined) {
        throw new Error("Expected persisted accepted vision provenance");
      }

      await harness.turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(1),
        added: [],
        updated: [{
          beforeRevision: 1,
          shape: graphShape(2, 20)
        }],
        deleted: []
      });

      const evidence = await harness.turns.processEvidenceProposal({
        envelope: createCommandEnvelope({
          sessionId: harness.sessionId,
          producer: "vision-evidence-race"
        }),
        proposal: {
          key: {
            problemId: sixPeopleProblem.id,
            subject: { kind: "MILESTONE", milestoneId: "model-relations" },
            dimension: "PROGRESS"
          },
          proposedValue: "PROGRESSING",
          inferenceConfidence: 0.95,
          evidenceEventIds: [eventId]
        },
        requiredBoardRevision: admittedAtBoardRevision
      });

      expect(evidence.committed).toBe(false);
      expect(evidence.reason).toMatch(/board freshness/u);
      expect(Object.keys(harness.writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("bounds a backend that never settles and records a timeout discard", async () => {
    const harness = await startedBoardSession();
    const provenance = new DeterministicFakeVisionBackend([]).provenance;
    const backend: VisionInferenceBackend = {
      provenance,
      analyze: async () => new Promise<never>(() => {
        // Deliberately ignores cancellation and never settles.
      })
    };
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      backendTimeoutMs: 10
    });

    try {
      const request = upload(harness.sessionId);
      const result = await coordinator.process(request);
      expect(result).toMatchObject({
        status: "REJECTED",
        reason: "BACKEND_TIMEOUT",
        observationCount: 0,
        evidenceCommittedCount: 0
      });
      expect(harness.writer.getState().visionRequests[request.requestId]?.status)
        .toBe("DISCARDED");
      expect(Object.keys(harness.writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("fails closed for malformed image bytes, stale snapshot basis, and unavailable production vision", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend
    });
    const unavailable = new WhiteboardVisionCoordinator({
      sessions: harness.sessions
    });

    try {
      const malformed = upload(harness.sessionId, {
        pngBase64: Buffer.from("not-a-png", "utf8").toString("base64")
      });
      await expect(coordinator.process(malformed)).resolves.toMatchObject({
        status: "REJECTED",
        reason: "INVALID_IMAGE"
      });
      expect(backend.analyzeCallCount).toBe(0);

      await harness.turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(1),
        added: [],
        updated: [{
          beforeRevision: 1,
          shape: graphShape(2, 10)
        }],
        deleted: []
      });
      await expect(coordinator.process(upload(harness.sessionId))).resolves.toMatchObject({
        status: "REJECTED",
        reason: "STALE_BOARD"
      });
      expect(backend.analyzeCallCount).toBe(0);

      const unavailableRequest = upload(harness.sessionId, {
        requestId: newRequestId(),
        sourceBoardRevision: BoardRevisionSchema.parse(2),
        relevantShapeRevisions: [{
          shapeId: "shape:graph-model",
          expectedRevision: 2
        }]
      });
      const unavailableResult = await unavailable.process(unavailableRequest);
      expect(unavailableResult).toMatchObject({
        status: "VISION_UNAVAILABLE",
        reason: "No production vision inference backend is configured"
      });
      expect(harness.writer.getState().visionRequests[unavailableRequest.requestId])
        .toMatchObject({
          status: "DISCARDED",
          discardReason: "VISION_UNAVAILABLE"
        });

      unavailable.shutdown();
      const callsBeforeRestart = backend.analyzeCallCount;
      const restartedWithBackend = new WhiteboardVisionCoordinator({
        sessions: harness.sessions,
        backend
      });
      try {
        await expect(restartedWithBackend.process(unavailableRequest))
          .resolves.toEqual(unavailableResult);
        expect(backend.analyzeCallCount).toBe(callsBeforeRestart);
      } finally {
        restartedWithBackend.shutdown();
      }
    } finally {
      coordinator.shutdown();
      unavailable.shutdown();
      harness.store.close();
    }
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

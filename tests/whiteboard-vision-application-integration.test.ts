import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  AcceptedBoardObservationSchema,
  BoardRevisionSchema,
  RequestIdSchema,
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
import {
  ManagedLocalVisionBackend,
  type LocalVisionWorkerClient
} from "../apps/desktop/src/runtime/vision-backend.js";

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

async function persistAcceptedPendingEvidenceBridge(input: {
  readonly turns: TurnCoordinator;
  readonly sessionId: SessionId;
  readonly request: WhiteboardVisionSnapshotUpload;
  readonly interpreterFingerprint: string;
}): Promise<void> {
  const encodedBytes = Buffer.from(input.request.pngBase64, "base64");
  const snapshot = createValidatedImageSnapshot({
    snapshotId: input.request.snapshotId,
    sourceType: "WHITEBOARD_SNAPSHOT",
    sourceRevision: input.request.sourceBoardRevision,
    capturedAtMs: input.request.capturedAtMs,
    mimeType: "image/png",
    declaredWidth: input.request.declaredWidth,
    declaredHeight: input.request.declaredHeight,
    encodedBytes
  });
  const snapshotBasis = {
    snapshotId: input.request.snapshotId,
    snapshotHash: snapshot.metadata.contentDigest,
    preprocessingVersion: "whiteboard-snapshot-v1",
    sourceBoardRevision: input.request.sourceBoardRevision
  };

  await input.turns.requestVision(
    input.request.region.regionId,
    input.request.region.relevantShapeIds,
    {
      visionRequestId: input.request.requestId,
      snapshotBasis,
      relevantShapeRevisions: input.request.relevantShapeRevisions,
      regionBounds: input.request.region.bounds,
      requestedObservationKind: input.request.requestedObservationKind
    }
  );

  const accepted = AcceptedBoardObservationSchema.parse({
    requestId: input.request.requestId,
    sessionId: input.sessionId,
    proposalId: "proposal-crash-boundary",
    observationKind: "DIAGRAM_RELATION",
    observation: {
      regionId: input.request.region.regionId,
      sourceBoardRevision: input.request.sourceBoardRevision,
      relevantShapeIds: ["shape:graph-model"],
      bounds: input.request.region.bounds,
      interpretation: "The graph representation is productive.",
      confidence: 0.95
    },
    snapshotBasis,
    sourceRelevantShapeIds: input.request.region.relevantShapeIds,
    shapeRevisionBindings: input.request.relevantShapeRevisions,
    backend: {
      backendId: "crash-boundary-fixture",
      backendVersion: "1",
      providerId: "fixture",
      modelId: "fixture-model",
      modelVersion: "1",
      visionCapabilityVersion: "1"
    },
    admittedAtBoardRevision: input.request.sourceBoardRevision,
    freshnessProof: "EXACT_BOARD_REVISION"
  });

  const persisted = await input.turns.processVisionResult({
    envelope: createCommandEnvelope({
      sessionId: input.sessionId,
      producer: "test-vision-admission",
      correlationId: input.request.requestId,
      sourceRevision: input.request.sourceBoardRevision
    }),
    observation: accepted.observation,
    admission: accepted,
    evidenceInterpreterFingerprint: input.interpreterFingerprint
  });
  if (!persisted.accepted) throw new Error("Crash-boundary fixture vision result was not accepted");
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

  it("binds the validated snapshot payload privately to backend execution", async () => {
    const harness = await startedBoardSession();
    const fake = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "The image payload is available to inference.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    let observedBytes: Buffer | undefined;
    let observedDigest: string | undefined;
    const backend: VisionInferenceBackend = {
      provenance: fake.provenance,
      analyze: async (request, options) => {
        if (options.imagePayload === undefined) {
          throw new Error("Whiteboard inference did not receive its validated image payload");
        }
        observedDigest = options.imagePayload.metadata.contentDigest;
        observedBytes = Buffer.from(options.imagePayload.readBytes());
        return fake.analyze(request, { signal: options.signal });
      }
    };
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend
    });

    try {
      const request = upload(harness.sessionId);
      const result = await coordinator.process(request);
      expect(result.status).toBe("ACCEPTED");
      expect(observedBytes).toEqual(Buffer.from(request.pngBase64, "base64"));

      const persisted = harness.writer.getState().visionRequests[request.requestId];
      expect(persisted?.snapshotBasis?.snapshotHash).toBe(observedDigest);
      expect(JSON.stringify(persisted)).not.toContain(request.pngBase64);
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

  it("resumes an accepted-but-pending evidence bridge after restart without rerunning vision", async () => {
    const harness = await startedBoardSession();
    const request = upload(harness.sessionId);
    const acceptedFingerprint = "a".repeat(64);
    await persistAcceptedPendingEvidenceBridge({
      turns: harness.turns,
      sessionId: harness.sessionId,
      request,
      interpreterFingerprint: acceptedFingerprint
    });

    const interruptedState = harness.writer.getState();
    expect(interruptedState.visionRequests[request.requestId]).toMatchObject({
      status: "ACCEPTED",
      evidenceBridge: {
        status: "PENDING",
        interpreterFingerprint: acceptedFingerprint
      }
    });
    expect(Object.keys(interruptedState.studentEvidence)).toHaveLength(0);

    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "This backend must not be called during accepted-result recovery.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    let turnRecoverySawEvidence = false;
    harness.sessions.setTurnRecoveryDelegate({
      recoverPendingTurns: async () => {
        turnRecoverySawEvidence = Object.keys(harness.writer.getState().studentEvidence).length === 1;
        return "COMPLETE" as const;
      }
    });
    const resumedCoordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      evidenceInterpreter: {
        fingerprint: acceptedFingerprint,
        propose: (context) => progressInterpreter().propose(context)
      }
    });
    try {
      await harness.sessions.ensureRecovered(harness.sessionId);
      expect(turnRecoverySawEvidence).toBe(true);
      expect(backend.analyzeCallCount).toBe(0);
      expect(harness.writer.getState().visionRequests[request.requestId]?.evidenceBridge)
        .toMatchObject({
          status: "COMPLETED",
          decision: "PROPOSAL",
          interpreterFingerprint: acceptedFingerprint,
          evidenceCommitted: true
        });

      const resumed = await resumedCoordinator.process(request);
      expect(resumed).toMatchObject({
        status: "ACCEPTED",
        observationCount: 1,
        evidenceCommittedCount: 1
      });
      expect(backend.analyzeCallCount).toBe(0);
    } finally {
      resumedCoordinator.shutdown();
      harness.store.close();
    }
  });

  it("fails closed under a changed interpreter fingerprint and remains resumable by the original interpreter", async () => {
    const harness = await startedBoardSession();
    const request = upload(harness.sessionId);
    const acceptedFingerprint = "b".repeat(64);
    await persistAcceptedPendingEvidenceBridge({
      turns: harness.turns,
      sessionId: harness.sessionId,
      request,
      interpreterFingerprint: acceptedFingerprint
    });

    const mismatched = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      evidenceInterpreter: {
        fingerprint: "c".repeat(64),
        propose: () => {
          throw new Error("Mismatched interpreter must never execute");
        }
      }
    });
    try {
      await expect(harness.sessions.ensureRecovered(harness.sessionId))
        .rejects.toThrow(/EVIDENCE_INTERPRETER_MISMATCH/u);
      expect(harness.writer.getState().visionRequests[request.requestId]?.evidenceBridge)
        .toMatchObject({ status: "PENDING", interpreterFingerprint: acceptedFingerprint });
      expect(Object.keys(harness.writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      mismatched.shutdown();
    }

    const resumed = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      evidenceInterpreter: {
        fingerprint: acceptedFingerprint,
        propose: (context) => progressInterpreter().propose(context)
      }
    });
    try {
      await harness.sessions.ensureRecovered(harness.sessionId);
      expect(await resumed.process(request)).toMatchObject({
        status: "ACCEPTED",
        evidenceCommittedCount: 1
      });
    } finally {
      resumed.shutdown();
      harness.store.close();
    }
  });

  it("resumes a durable evidence decision after restart without rerunning the interpreter", async () => {
    const harness = await startedBoardSession();
    const request = upload(harness.sessionId);
    const acceptedFingerprint = "d".repeat(64);
    await persistAcceptedPendingEvidenceBridge({
      turns: harness.turns,
      sessionId: harness.sessionId,
      request,
      interpreterFingerprint: acceptedFingerprint
    });

    const requestState = harness.writer.getState().visionRequests[request.requestId];
    if (
      requestState?.acceptedObservation === undefined
      || requestState.resultEventId === undefined
    ) {
      throw new Error("Expected an accepted observation at the bridge crash boundary");
    }
    const interpreter = progressInterpreter();
    const proposal = interpreter.propose({
      observation: requestState.acceptedObservation,
      problemId: sixPeopleProblem.id,
      evidenceEventId: requestState.resultEventId
    });
    if (proposal === undefined) throw new Error("Expected the fixture interpreter to propose evidence");

    await harness.turns.recordVisionEvidenceBridgeDecision({
      envelope: createCommandEnvelope({
        sessionId: harness.sessionId,
        producer: "test-crash-boundary",
        correlationId: request.requestId
      }),
      interpreterFingerprint: acceptedFingerprint,
      proposal
    });
    expect(harness.writer.getState().visionRequests[request.requestId]?.evidenceBridge)
      .toMatchObject({ status: "DECIDED", decision: "PROPOSAL" });
    expect(Object.keys(harness.writer.getState().studentEvidence)).toHaveLength(0);

    let proposeCalls = 0;
    const resumedCoordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      evidenceInterpreter: {
        fingerprint: acceptedFingerprint,
        propose: () => {
          proposeCalls += 1;
          throw new Error("A durable bridge decision must not be reinterpreted");
        }
      }
    });
    try {
      await harness.sessions.ensureRecovered(harness.sessionId);
      expect(proposeCalls).toBe(0);
      const resumed = await resumedCoordinator.process(request);
      expect(resumed).toMatchObject({
        status: "ACCEPTED",
        observationCount: 1,
        evidenceCommittedCount: 1
      });
      expect(proposeCalls).toBe(0);

      const replay = await resumedCoordinator.process(request);
      expect(replay).toEqual(resumed);
      expect(proposeCalls).toBe(0);
    } finally {
      resumedCoordinator.shutdown();
      harness.store.close();
    }
  });

  it("finishes a bridge when evidence admission persisted but the completion event did not", async () => {
    const harness = await startedBoardSession();
    const request = upload(harness.sessionId);
    const acceptedFingerprint = "9".repeat(64);
    await persistAcceptedPendingEvidenceBridge({
      turns: harness.turns,
      sessionId: harness.sessionId,
      request,
      interpreterFingerprint: acceptedFingerprint
    });

    const requestState = harness.writer.getState().visionRequests[request.requestId];
    if (
      requestState?.acceptedObservation === undefined
      || requestState.resultEventId === undefined
    ) {
      throw new Error("Expected accepted vision state for completion crash fixture");
    }
    const proposal = progressInterpreter().propose({
      observation: requestState.acceptedObservation,
      problemId: sixPeopleProblem.id,
      evidenceEventId: requestState.resultEventId
    });
    if (proposal === undefined) throw new Error("Expected fixture evidence proposal");

    await harness.turns.recordVisionEvidenceBridgeDecision({
      envelope: createCommandEnvelope({
        sessionId: harness.sessionId,
        producer: "test-crash-boundary",
        correlationId: request.requestId
      }),
      interpreterFingerprint: acceptedFingerprint,
      proposal
    });
    const evidenceResult = await harness.turns.processEvidenceProposal({
      envelope: createCommandEnvelope({
        sessionId: harness.sessionId,
        producer: "vision-evidence",
        requestId: RequestIdSchema.parse(`vision-evidence-commit:${request.requestId}`),
        correlationId: request.requestId
      }),
      proposal,
      requiredBoardRevision: requestState.acceptedObservation.admittedAtBoardRevision
    });
    expect(evidenceResult.committed).toBe(true);
    expect(harness.writer.getState().visionRequests[request.requestId]?.evidenceBridge)
      .toMatchObject({ status: "DECIDED", decision: "PROPOSAL" });
    const proposedBeforeRecovery = harness.store.load(harness.sessionId)
      .filter((event) => event.type === "EVIDENCE_PROPOSED").length;
    expect(proposedBeforeRecovery).toBe(1);

    const resumedCoordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions
    });
    try {
      await harness.sessions.ensureRecovered(harness.sessionId);
      expect(harness.writer.getState().visionRequests[request.requestId]?.evidenceBridge)
        .toMatchObject({
          status: "COMPLETED",
          decision: "PROPOSAL",
          evidenceCommitted: true
        });
      expect(harness.store.load(harness.sessionId)
        .filter((event) => event.type === "EVIDENCE_PROPOSED")).toHaveLength(1);
      expect(await resumedCoordinator.process(request)).toMatchObject({
        status: "ACCEPTED",
        evidenceCommittedCount: 1
      });
    } finally {
      resumedCoordinator.shutdown();
      harness.store.close();
    }
  });

  it("isolates authoritative accepted observations from interpreter mutation attempts", async () => {
    const harness = await startedBoardSession();
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "Authoritative interpretation must remain unchanged.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      evidenceInterpreter: {
        fingerprint: "e".repeat(64),
        propose: (context) => {
          const mutable = context.observation as unknown as {
            observation: { interpretation: string };
          };
          mutable.observation.interpretation = "MUTATED BY INTERPRETER";
          return undefined;
        }
      }
    });

    try {
      const request = upload(harness.sessionId);
      expect(await coordinator.process(request)).toMatchObject({
        status: "ACCEPTED",
        evidenceCommittedCount: 0
      });
      expect(
        harness.writer.getState().visionRequests[request.requestId]
          ?.acceptedObservation?.observation.interpretation
      ).toBe("Authoritative interpretation must remain unchanged.");
      expect(harness.writer.getState().visionRequests[request.requestId]?.evidenceBridge)
        .toMatchObject({ status: "DECIDED", decision: "NO_PROPOSAL" });
    } finally {
      coordinator.shutdown();
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
        fingerprint: "f".repeat(64),
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

  it("enforces a coordinator-wide backend reservation cap across sessions", async () => {
    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    const sessions = new SessionRecoveryCoordinator(registry, store);
    const sessionIds: SessionId[] = [];

    for (let index = 0; index < 17; index += 1) {
      const sessionId = newSessionId();
      sessionIds.push(sessionId);
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      const committed = await turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(0),
        added: [graphShape()],
        updated: [],
        deleted: []
      });
      if (!committed.committed) throw new Error("Global vision-cap fixture did not commit");
    }

    const fake = new DeterministicFakeVisionBackend([{
      observationKind: "DIAGRAM_RELATION",
      interpretation: "Bounded shared backend execution.",
      confidence: 0.95,
      relevantShapeIds: ["shape:graph-model"]
    }]);
    const allStarted = deferred<undefined>();
    const release = deferred<undefined>();
    let startedCount = 0;
    const backend: VisionInferenceBackend = {
      provenance: fake.provenance,
      analyze: async (request, options) => {
        startedCount += 1;
        if (startedCount === 16) allStarted.resolve(undefined);
        await release.promise;
        return fake.analyze(request, options);
      }
    };
    const coordinator = new WhiteboardVisionCoordinator({
      sessions,
      backend,
      backendTimeoutMs: 5_000
    });

    try {
      const firstSixteen = sessionIds.slice(0, 16).map((sessionId) =>
        coordinator.process(upload(sessionId))
      );
      await allStarted.promise;

      const seventeenthSession = sessionIds[16];
      if (seventeenthSession === undefined) throw new Error("Missing saturation session");
      const overflowRequest = upload(seventeenthSession);
      const overflow = await coordinator.process(overflowRequest);
      expect(overflow).toMatchObject({
        status: "REJECTED",
        reason: "RESOURCE_LIMIT",
        observationCount: 0,
        evidenceCommittedCount: 0
      });
      expect(startedCount).toBe(16);
      expect(registry.get(seventeenthSession).getState().visionRequests[overflowRequest.requestId])
        .toMatchObject({
          status: "DISCARDED",
          discardReason: "RESOURCE_LIMIT"
        });

      release.resolve(undefined);
      const admitted = await Promise.all(firstSixteen);
      expect(admitted.every((result) => result.status === "ACCEPTED")).toBe(true);
      expect(startedCount).toBe(16);
    } finally {
      release.resolve(undefined);
      coordinator.shutdown();
      store.close();
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

  it("runs the production local backend adapter through observation admission and allowed evidence", async () => {
    const harness = await startedBoardSession();
    const backend = new ManagedLocalVisionBackend(localVisionClient(async () => ({
      observationKind: "DIAGRAM_RELATION",
      interpretation: "Visible bounded diagram relation.",
      confidenceClass: "HIGH"
    })));
    const interpreter = new RuleBasedVisionEvidenceInterpreter([{
      observationKind: "DIAGRAM_RELATION",
      subject: { kind: "MILESTONE", milestoneId: "model-relations" },
      dimension: "PROGRESS",
      proposedValue: "PROGRESSING",
      minConfidence: 0.7
    }]);
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend,
      evidenceInterpreter: interpreter
    });

    try {
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

      const state = harness.writer.getState();
      const persisted = state.visionRequests[request.requestId];
      expect(persisted?.status).toBe("ACCEPTED");
      expect(persisted?.acceptedObservation).toMatchObject({
        sessionId: harness.sessionId,
        sourceBoardRevision: BoardRevisionSchema.parse(1),
        observationKind: "DIAGRAM_RELATION",
        backend: {
          backendId: "desktop-local-vision",
          providerId: "local-offline",
          modelId: "rapid-latex-ocr-hybrid"
        }
      });
      const key = evidenceKeyToString({
        problemId: sixPeopleProblem.id,
        subject: { kind: "MILESTONE", milestoneId: "model-relations" },
        dimension: "PROGRESS"
      });
      expect(state.studentEvidence[key]).toMatchObject({
        value: "PROGRESSING",
        inferenceConfidence: 0.75
      });
    } finally {
      coordinator.shutdown();
      harness.store.close();
    }
  });

  it("rejects a late production-adapter result after the bound shape changes", async () => {
    const harness = await startedBoardSession();
    const started = deferred<undefined>();
    const release = deferred<undefined>();
    const backend = new ManagedLocalVisionBackend(localVisionClient(async () => {
      started.resolve(undefined);
      await release.promise;
      return {
        observationKind: "EQUATION",
        interpretation: "Visible expression: x^2 + y^2 = 1",
        confidenceClass: "HIGH"
      };
    }));
    const coordinator = new WhiteboardVisionCoordinator({
      sessions: harness.sessions,
      backend
    });

    try {
      const request = upload(harness.sessionId);
      const pending = coordinator.process(request);
      await started.promise;

      await harness.turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(1),
        added: [],
        updated: [{
          beforeRevision: 1,
          shape: graphShape(2, 30)
        }],
        deleted: []
      });
      expect(coordinator.supersedeStaleRequests(harness.sessionId)).toBe(1);

      release.resolve(undefined);
      const result = await pending;
      expect(result.status).toBe("REJECTED");
      expect(result.reason).toMatch(/STALE_|FRESHNESS_|REQUEST_CANCELLED/u);
      expect(result.evidenceCommittedCount).toBe(0);
      expect(harness.writer.getState().visionRequests[request.requestId])
        .toMatchObject({ status: "DISCARDED" });
      expect(Object.keys(harness.writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      coordinator.shutdown();
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

function localVisionClient(
  postJson: (pathname: string, body: unknown, options: unknown) => Promise<unknown>
): LocalVisionWorkerClient {
  return {
    postJson,
    workerInstanceIdentity: () => "fixture:vision:ready",
    markHealthy: () => undefined,
    recycleAfterUncertainRequest: async () => undefined
  } as unknown as LocalVisionWorkerClient;
}

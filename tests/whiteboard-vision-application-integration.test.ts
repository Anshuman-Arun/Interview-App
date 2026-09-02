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
  decidePedagogicalPolicy,
  type VisionInferenceBackend
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
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
    const started = deferred<void>();
    const release = deferred<void>();
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
      await expect(unavailable.process(unavailableRequest)).resolves.toMatchObject({
        status: "VISION_UNAVAILABLE",
        reason: "No production vision inference backend is configured"
      });
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

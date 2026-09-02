import { describe, expect, it } from "vitest";
import {
  BoardStateResponseSchema,
  WhiteboardVisionSnapshotResponseSchema,
  WhiteboardVisionSnapshotUploadSchema,
  newEventId,
  newRequestId,
  newSessionId
} from "../packages/domain/src/index.js";
import { normalizeStudentShape } from "../apps/web/src/whiteboard/normalized-board.js";
import {
  SessionEventSchema,
  initialSessionState,
  reduceSessionEvent
} from "../packages/events/src/index.js";

function visionRequestedEvent(input: {
  readonly sessionId: ReturnType<typeof newSessionId>;
  readonly visionRequestId: ReturnType<typeof newRequestId>;
  readonly sequence: number;
  readonly sourceBoardRevision?: number;
  readonly relevantShapeIds?: readonly string[];
  readonly bindingShapeIds?: readonly string[];
}) {
  const sourceBoardRevision = input.sourceBoardRevision ?? 0;
  const relevantShapeIds = input.relevantShapeIds ?? ["shape:a"];
  const bindingShapeIds = input.bindingShapeIds ?? relevantShapeIds;
  return SessionEventSchema.parse({
    eventId: newEventId(),
    sessionId: input.sessionId,
    sequence: input.sequence,
    schemaVersion: 3,
    source: "APPLICATION",
    wallTime: "2026-09-01T00:00:00.000Z",
    elapsedMs: input.sequence,
    causationId: newRequestId(),
    correlationId: input.visionRequestId,
    type: "VISION_REQUESTED",
    payload: {
      visionRequestId: input.visionRequestId,
      sourceBoardRevision,
      regionId: "region:test",
      relevantShapeIds,
      snapshotBasis: {
        snapshotId: "snapshot:test",
        snapshotHash: "a".repeat(64),
        preprocessingVersion: "test-v1",
        sourceBoardRevision
      },
      relevantShapeRevisions: bindingShapeIds.map((shapeId) => ({
        shapeId,
        expectedRevision: 1
      })),
      regionBounds: { x: 0, y: 0, width: 10, height: 10 },
      requestedObservationKind: "ANY"
    }
  });
}

describe("authoritative whiteboard and vision runtime contracts", () => {
  it("rejects impossible whiteboard vision response status/count combinations", () => {
    const common = {
      protocolVersion: 1 as const,
      requestId: newRequestId(),
      sessionId: newSessionId()
    };

    expect(WhiteboardVisionSnapshotResponseSchema.safeParse({
      ...common,
      status: "ACCEPTED",
      observationCount: 0,
      evidenceCommittedCount: 0
    }).success).toBe(false);

    expect(WhiteboardVisionSnapshotResponseSchema.safeParse({
      ...common,
      status: "REJECTED",
      reason: "STALE_BOARD",
      observationCount: 1,
      evidenceCommittedCount: 0
    }).success).toBe(false);

    expect(WhiteboardVisionSnapshotResponseSchema.safeParse({
      ...common,
      status: "ACCEPTED",
      observationCount: 1,
      evidenceCommittedCount: 1
    }).success).toBe(true);
  });

  it("rejects whiteboard snapshot dimensions whose pixel product exceeds the preprocessing cap", () => {
    expect(WhiteboardVisionSnapshotUploadSchema.safeParse({
      protocolVersion: 1,
      requestId: newRequestId(),
      sessionId: newSessionId(),
      sourceBoardRevision: 1,
      snapshotId: "snapshot:oversized-pixels",
      capturedAtMs: 1,
      declaredWidth: 4096,
      declaredHeight: 4096,
      region: {
        regionId: "region:test",
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        relevantShapeIds: ["shape:a"]
      },
      relevantShapeRevisions: [{
        shapeId: "shape:a",
        expectedRevision: 1
      }],
      requestedObservationKind: "ANY",
      pngBase64: "AAAA"
    }).success).toBe(false);
  });

  it("normalizes metadata-free legacy student shapes deterministically", () => {
    const legacyShape = {
      id: "shape:legacy",
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "rectangle", w: 30, h: 40 },
      meta: {}
    };
    const bounds = {
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      minX: 10,
      minY: 20,
      maxX: 40,
      maxY: 60
    };

    const first = normalizeStudentShape(legacyShape, bounds);
    const second = normalizeStudentShape(legacyShape, bounds);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      createdAt: 0,
      lastModifiedAt: 0,
      revision: 1
    });
  });

  it("rejects duplicate board-state shape identities", () => {
    expect(BoardStateResponseSchema.safeParse({
      protocolVersion: 1,
      ok: true,
      type: "BOARD_STATE",
      requestId: newRequestId(),
      sessionId: newSessionId(),
      boardRevision: 1,
      shapeAuthorityKnown: true,
      shapeRevisions: [
        { shapeId: "shape:a", revision: 1, contentSha256: "a".repeat(64) },
        { shapeId: "shape:a", revision: 2, contentSha256: "b".repeat(64) }
      ]
    }).success).toBe(false);
  });

  it("rejects persisted vision requests with duplicate dependencies, incomplete bindings, or mismatched snapshot revision", () => {
    const sessionId = newSessionId();
    const visionRequestId = newRequestId();

    expect(() => visionRequestedEvent({
      sessionId,
      visionRequestId,
      sequence: 1,
      relevantShapeIds: ["shape:a", "shape:a"]
    })).toThrow();

    expect(() => visionRequestedEvent({
      sessionId,
      visionRequestId,
      sequence: 1,
      relevantShapeIds: ["shape:a", "shape:b"],
      bindingShapeIds: ["shape:a"]
    })).toThrow();

    const mismatched = {
      ...visionRequestedEvent({
        sessionId,
        visionRequestId,
        sequence: 1
      }),
      payload: {
        ...visionRequestedEvent({
          sessionId,
          visionRequestId,
          sequence: 1
        }).payload,
        snapshotBasis: {
          snapshotId: "snapshot:test",
          snapshotHash: "a".repeat(64),
          preprocessingVersion: "test-v1",
          sourceBoardRevision: 2
        }
      }
    };
    expect(SessionEventSchema.safeParse(mismatched).success).toBe(false);
  });

  it("treats duplicate persisted vision request IDs as replay corruption", () => {
    const sessionId = newSessionId();
    const visionRequestId = newRequestId();
    let state = initialSessionState(sessionId);
    state = reduceSessionEvent(state, visionRequestedEvent({
      sessionId,
      visionRequestId,
      sequence: 1
    }));

    expect(() => reduceSessionEvent(state, visionRequestedEvent({
      sessionId,
      visionRequestId,
      sequence: 2
    }))).toThrow(/already exists/u);
  });
});

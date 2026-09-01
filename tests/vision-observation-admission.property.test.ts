import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BoardRevisionSchema,
  VISION_PROTOCOL_VERSION,
  VisionInferenceRequestSchema,
  newRequestId,
  newSessionId
} from "../packages/domain/src/index.js";
import { admitVisionBackendResult } from "../packages/interview-engine/src/vision-admission.js";

describe("vision observation admission properties", () => {
  it("is deterministic and never accepts a stale broad-board result", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 10_000 }),
      fc.boolean(),
      (revision, boardAdvanced) => {
        const sourceBoardRevision = BoardRevisionSchema.parse(revision);
        const request = VisionInferenceRequestSchema.parse({
          protocolVersion: VISION_PROTOCOL_VERSION,
          requestId: newRequestId(),
          sessionId: newSessionId(),
          sourceBoardRevision,
          snapshotBasis: {
            snapshotId: "snapshot-" + String(revision),
            snapshotHash: "c".repeat(64),
            preprocessingVersion: "property-v1",
            sourceBoardRevision
          },
          region: {
            regionId: "property-region",
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            relevantShapeIds: ["shape:a"]
          },
          relevantShapeRevisions: [],
          requestedObservationKind: "ANY"
        });
        const backend = {
          backendId: "property-backend",
          backendVersion: "1",
          providerId: "property-provider",
          modelId: "property-model",
          modelVersion: "1",
          visionCapabilityVersion: "1"
        };
        const rawResult = {
          protocolVersion: VISION_PROTOCOL_VERSION,
          requestId: request.requestId,
          sessionId: request.sessionId,
          sourceBoardRevision,
          snapshotBasis: request.snapshotBasis,
          regionId: request.region.regionId,
          backend,
          proposals: [{
            proposalId: "proposal-1",
            requestId: request.requestId,
            sessionId: request.sessionId,
            sourceBoardRevision,
            snapshotBasis: request.snapshotBasis,
            regionId: request.region.regionId,
            relevantShapeIds: ["shape:a"],
            observationKind: "TEXT",
            interpretation: "bounded perception",
            confidence: 0.5
          }]
        };
        const currentRevision = BoardRevisionSchema.parse(revision + (boardAdvanced ? 1 : 0));
        const authority = { sessionId: request.sessionId, boardRevision: currentRevision };
        const first = admitVisionBackendResult({
          request,
          rawResult,
          authority,
          expectedBackend: backend
        });
        const second = admitVisionBackendResult({
          request,
          rawResult,
          authority,
          expectedBackend: backend
        });
        expect(second).toEqual(first);
        if (boardAdvanced) {
          expect(first).toMatchObject({ accepted: false, reason: "STALE_BOARD" });
        } else {
          expect(first.accepted).toBe(true);
        }
      }
    ), { numRuns: 150 });
  });

  it("accepts an advanced board only when every bound shape revision still matches", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 10_000 }),
      fc.integer({ min: 0, max: 10_000 }),
      fc.boolean(),
      (sourceRevision, shapeRevision, changeShape) => {
        const sourceBoardRevision = BoardRevisionSchema.parse(sourceRevision);
        const request = VisionInferenceRequestSchema.parse({
          protocolVersion: VISION_PROTOCOL_VERSION,
          requestId: newRequestId(),
          sessionId: newSessionId(),
          sourceBoardRevision,
          snapshotBasis: {
            snapshotId: "snapshot-narrow-" + String(sourceRevision),
            snapshotHash: "d".repeat(64),
            preprocessingVersion: "property-v1",
            sourceBoardRevision
          },
          region: {
            regionId: "property-narrow-region",
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            relevantShapeIds: ["shape:a"]
          },
          relevantShapeRevisions: [{ shapeId: "shape:a", expectedRevision: shapeRevision }],
          requestedObservationKind: "ANY"
        });
        const backend = {
          backendId: "property-backend",
          backendVersion: "1",
          providerId: "property-provider",
          modelId: "property-model",
          modelVersion: "1",
          visionCapabilityVersion: "1"
        };
        const rawResult = {
          protocolVersion: VISION_PROTOCOL_VERSION,
          requestId: request.requestId,
          sessionId: request.sessionId,
          sourceBoardRevision,
          snapshotBasis: request.snapshotBasis,
          regionId: request.region.regionId,
          backend,
          proposals: [{
            proposalId: "proposal-1",
            requestId: request.requestId,
            sessionId: request.sessionId,
            sourceBoardRevision,
            snapshotBasis: request.snapshotBasis,
            regionId: request.region.regionId,
            relevantShapeIds: ["shape:a"],
            observationKind: "TEXT",
            interpretation: "bounded perception",
            confidence: 0.5
          }]
        };
        const outcome = admitVisionBackendResult({
          request,
          rawResult,
          authority: {
            sessionId: request.sessionId,
            boardRevision: BoardRevisionSchema.parse(sourceRevision + 1),
            currentShapeRevisions: [{
              shapeId: "shape:a",
              currentRevision: shapeRevision + (changeShape ? 1 : 0)
            }],
            regionCompatibility: "COMPATIBLE"
          },
          expectedBackend: backend
        });
        if (changeShape) {
          expect(outcome).toMatchObject({ accepted: false, reason: "STALE_SHAPE" });
        } else {
          expect(outcome.accepted).toBe(true);
          if (outcome.accepted) {
            expect(outcome.observations[0]?.freshnessProof).toBe("SHAPE_AND_REGION_COMPATIBLE");
          }
        }
      }
    ), { numRuns: 150 });
  });

});

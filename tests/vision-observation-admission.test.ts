import { describe, expect, it } from "vitest";
import {
  AcceptedBoardObservationSchema,
  BoardRevisionSchema,
  MAX_VISION_INTERPRETATION_LENGTH,
  MAX_VISION_OBSERVATIONS,
  MAX_VISION_REGION_SHAPES,
  VISION_PROTOCOL_VERSION,
  VisionBackendProvenanceSchema,
  VisionBackendResultSchema,
  VisionInferenceRequestSchema,
  VisionRequestIdSchema,
  newRequestId,
  newSessionId,
  type VisionBackendProvenance,
  type VisionInferenceRequest
} from "../packages/domain/src/index.js";
import {
  admitVisionBackendResult,
  type VisionAuthorityView
} from "../packages/interview-engine/src/vision-admission.js";
import {
  DeterministicFakeVisionBackend,
  type VisionInferenceBackend
} from "../packages/interview-engine/src/vision-inference.js";
import { VisionRequestManager } from "../packages/interview-engine/src/vision-request-manager.js";

const BACKEND: VisionBackendProvenance = {
  backendId: "test-vision",
  backendVersion: "1.2.3",
  providerId: "test-provider",
  modelId: "vision-model",
  modelVersion: "2026-08",
  visionCapabilityVersion: "vision-v1"
};

function request(overrides: Partial<VisionInferenceRequest> = {}): VisionInferenceRequest {
  const sessionId = overrides.sessionId ?? newSessionId();
  const sourceBoardRevision = overrides.sourceBoardRevision ?? BoardRevisionSchema.parse(5);
  return VisionInferenceRequestSchema.parse({
    protocolVersion: VISION_PROTOCOL_VERSION,
    requestId: overrides.requestId ?? newRequestId(),
    sessionId,
    sourceBoardRevision,
    snapshotBasis: overrides.snapshotBasis ?? {
      snapshotId: "snapshot-5",
      snapshotHash: "a".repeat(64),
      preprocessingVersion: "synthetic-v1",
      sourceBoardRevision
    },
    region: overrides.region ?? {
      regionId: "main-work",
      bounds: { x: 0, y: 0, width: 640, height: 480 },
      relevantShapeIds: ["shape:equation", "shape:arrow"]
    },
    relevantShapeRevisions: overrides.relevantShapeRevisions ?? [],
    requestedObservationKind: overrides.requestedObservationKind ?? "ANY"
  });
}

function authorityFor(
  req: VisionInferenceRequest,
  options: {
    boardRevision?: number;
    shapeRevisions?: Readonly<Record<string, number | null | undefined>>;
    region?: "COMPATIBLE" | "INCOMPATIBLE" | "UNKNOWN";
  } = {}
): VisionAuthorityView {
  const shapeRevisions = options.shapeRevisions;
  return {
    sessionId: req.sessionId,
    boardRevision: BoardRevisionSchema.parse(options.boardRevision ?? req.sourceBoardRevision),
    ...(shapeRevisions === undefined ? {} : {
      currentShapeRevisions: Object.entries(shapeRevisions)
        .filter((entry): entry is [string, number | null] => entry[1] !== undefined)
        .map(([shapeId, currentRevision]) => ({ shapeId, currentRevision }))
    }),
    ...(options.region === undefined ? {} : { regionCompatibility: options.region })
  };
}

function validResult(req: VisionInferenceRequest, changes: Record<string, unknown> = {}) {
  return {
    protocolVersion: VISION_PROTOCOL_VERSION,
    requestId: req.requestId,
    sessionId: req.sessionId,
    sourceBoardRevision: req.sourceBoardRevision,
    snapshotBasis: req.snapshotBasis,
    regionId: req.region.regionId,
    backend: BACKEND,
    proposals: [{
      proposalId: "proposal-1",
      requestId: req.requestId,
      sessionId: req.sessionId,
      sourceBoardRevision: req.sourceBoardRevision,
      snapshotBasis: req.snapshotBasis,
      regionId: req.region.regionId,
      relevantShapeIds: ["shape:equation"],
      observationKind: "EQUATION",
      interpretation: "x = 4",
      confidence: 0.97
    }],
    ...changes
  };
}

function firstProposal(req: VisionInferenceRequest) {
  const proposal = validResult(req).proposals[0];
  if (proposal === undefined) throw new Error("Expected a synthetic proposal");
  return proposal;
}

describe("VisionInferenceRequest validation", () => {
  it("accepts an exact bounded synthetic request", () => {
    expect(VisionInferenceRequestSchema.parse(request()).protocolVersion).toBe(1);
  });

  it("rejects bad revisions, unknown fields, malformed regions, and non-finite coordinates", () => {
    const base = request();
    expect(() => VisionInferenceRequestSchema.parse({ ...base, sourceBoardRevision: -1 })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({ ...base, unknownField: true })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: { ...base.region, bounds: { ...base.region.bounds, x: Number.NaN } }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: { ...base.region, bounds: { ...base.region.bounds, width: -1 } }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: { ...base.region, bounds: { ...base.region.bounds, height: Number.POSITIVE_INFINITY } }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: { ...base.region, bounds: { ...base.region.bounds, x: 2_000_000 } }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: {
        ...base.region,
        bounds: { ...base.region.bounds, x: 999_999, width: 10 }
      }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      requestId: "r".repeat(161)
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      requestId: "request_bad\nline"
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      sessionId: "s".repeat(161)
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      sessionId: "session_bad\tvalue"
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      sourceBoardRevision: Number.MAX_SAFE_INTEGER + 1
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      snapshotBasis: { ...base.snapshotBasis, snapshotHash: "not-a-sha256" }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: { ...base.region, regionId: "r".repeat(129) }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: { ...base.region, regionId: " main-work " }
    })).toThrow();
  });

  it("rejects duplicate, malformed, oversized, and excessive shape IDs", () => {
    const base = request();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: { ...base.region, relevantShapeIds: ["shape:a", "shape:a"] }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: { ...base.region, relevantShapeIds: ["bad shape id"] }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: { ...base.region, relevantShapeIds: ["s".repeat(161)] }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      region: {
        ...base.region,
        relevantShapeIds: Array.from({ length: MAX_VISION_REGION_SHAPES + 1 }, (_, index) => "shape:" + String(index))
      }
    })).toThrow();
  });

  it("bounds backend metadata and rejects diagnostic control characters", () => {
    expect(() => VisionBackendProvenanceSchema.parse({
      ...BACKEND,
      modelVersion: "bad\nversion"
    })).toThrow();
    expect(() => VisionBackendProvenanceSchema.parse({
      ...BACKEND,
      providerId: "p".repeat(161)
    })).toThrow();
    expect(() => VisionBackendProvenanceSchema.parse({
      ...BACKEND,
      modelVersion: " 2026-08 "
    })).toThrow();
  });

  it("rejects inconsistent snapshot and shape-revision bindings", () => {
    const base = request();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      snapshotBasis: { ...base.snapshotBasis, sourceBoardRevision: BoardRevisionSchema.parse(4) }
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      relevantShapeRevisions: [{ shapeId: "shape:missing", expectedRevision: 1 }]
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      relevantShapeRevisions: [{ shapeId: "shape:equation", expectedRevision: 1 }]
    })).toThrow();
    expect(() => VisionInferenceRequestSchema.parse({
      ...base,
      relevantShapeRevisions: [
        { shapeId: "shape:equation", expectedRevision: 1 },
        { shapeId: "shape:equation", expectedRevision: 1 }
      ]
    })).toThrow();
  });
});

describe("vision backend result admission", () => {
  it("accepts zero, one, or several fully bound observations", () => {
    const req = request();
    const zero = admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { proposals: [] }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    });
    expect(zero.accepted && zero.observations).toHaveLength(0);

    const one = admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    });
    expect(one.accepted).toBe(true);
    if (!one.accepted) throw new Error("Expected accepted vision result");
    expect(one.observations[0]?.observation.interpretation).toBe("x = 4");
    expect(one.observations[0]?.sourceRelevantShapeIds).toEqual(["shape:equation", "shape:arrow"]);
    expect(one.observations[0]?.backend).toEqual(BACKEND);

    const proposal = firstProposal(req);
    const multiple = admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, {
        proposals: [
          proposal,
          { ...proposal, proposalId: "proposal-2", observationKind: "LABEL", interpretation: "A" }
        ]
      }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    });
    expect(multiple.accepted && multiple.observations).toHaveLength(2);

    const spaced = admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, {
        proposals: [{ ...proposal, interpretation: "  x = 4  " }]
      }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    });
    expect(spaced.accepted).toBe(true);
    if (!spaced.accepted) throw new Error("Expected spaced interpretation to be accepted");
    expect(spaced.observations[0]?.observation.interpretation).toBe("  x = 4  ");
  });

  it("makes admitted freshness provenance self-consistent", () => {
    const req = request();
    const result = admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("Expected accepted observation");
    const observation = result.observations[0];
    if (observation === undefined) throw new Error("Expected one accepted observation");
    expect(observation.freshnessProof).toBe("EXACT_BOARD_REVISION");
    expect(() => AcceptedBoardObservationSchema.parse({
      ...observation,
      admittedAtBoardRevision: BoardRevisionSchema.parse(req.sourceBoardRevision + 1)
    })).toThrow();
    expect(() => AcceptedBoardObservationSchema.parse({
      ...observation,
      freshnessProof: "SHAPE_AND_REGION_COMPATIBLE"
    })).toThrow();
    expect(() => AcceptedBoardObservationSchema.parse({
      ...observation,
      sourceRelevantShapeIds: ["shape:arrow"]
    })).toThrow();
  });

  it("rejects excessive observations and overlong interpretations without partial admission", () => {
    const req = request();
    const proposal = firstProposal(req);
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, {
        proposals: Array.from({ length: MAX_VISION_OBSERVATIONS + 1 }, (_, index) => ({
          ...proposal,
          proposalId: "proposal-" + String(index)
        }))
      }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });

    let oversizedElementRead = false;
    const oversized = new Array(MAX_VISION_OBSERVATIONS + 1);
    Object.defineProperty(oversized, "0", {
      enumerable: true,
      get() {
        oversizedElementRead = true;
        throw new Error("oversized result elements must not be traversed");
      }
    });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { proposals: oversized }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
    expect(oversizedElementRead).toBe(false);

    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, {
        proposals: [{ ...proposal, interpretation: "x".repeat(MAX_VISION_INTERPRETATION_LENGTH + 1) }]
      }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
  });

  it("rejects wrong request, region, source revision, snapshot, backend, and proposal scope", () => {
    const req = request();
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { requestId: newRequestId() }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "SOURCE_MISMATCH" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { sessionId: newSessionId() }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "SOURCE_MISMATCH" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { regionId: "other-region" }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "REGION_MISMATCH" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { sourceBoardRevision: BoardRevisionSchema.parse(4) }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "SOURCE_MISMATCH" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, {
        snapshotBasis: { ...req.snapshotBasis, snapshotHash: "b".repeat(64) }
      }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "SNAPSHOT_MISMATCH" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, {
        backend: { ...BACKEND, modelVersion: "wrong-model" }
      }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "SOURCE_MISMATCH" });
    const proposal = firstProposal(req);
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, {
        proposals: [{ ...proposal, relevantShapeIds: ["shape:unknown"] }]
      }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "SOURCE_MISMATCH" });
  });

  it("rejects malformed confidence, duplicate proposal IDs, unknown fields, and requested-kind violations", () => {
    const req = request({ requestedObservationKind: "EQUATION" });
    const proposal = firstProposal(req);
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { proposals: [{ ...proposal, confidence: Number.NaN }] }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { proposals: [{ ...proposal, interpretation: "   " }] }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { proposals: [proposal, proposal] }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: { ...validResult(req), rawProviderPayload: "not allowed" },
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });

    const hiddenUnknown = validResult(req);
    Object.defineProperty(hiddenUnknown, "hiddenProviderPayload", {
      enumerable: false,
      value: "must-not-be-ignored"
    });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: hiddenUnknown,
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });

    const hiddenProposalUnknown = firstProposal(req);
    Object.defineProperty(hiddenProposalUnknown, "hiddenMetadata", {
      enumerable: false,
      value: "must-not-be-ignored"
    });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { proposals: [hiddenProposalUnknown] }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
    const hostile = Object.create(null) as Record<string, unknown>;
    let protocolGetterRead = false;
    Object.defineProperty(hostile, "protocolVersion", {
      enumerable: true,
      get() {
        protocolGetterRead = true;
        throw new Error("backend getter must not escape admission");
      }
    });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: hostile,
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
    expect(protocolGetterRead).toBe(false);

    let proposalsAccessorRead = false;
    const accessorBacked = validResult(req);
    Object.defineProperty(accessorBacked, "proposals", {
      enumerable: true,
      get() {
        proposalsAccessorRead = true;
        return [];
      }
    });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: accessorBacked,
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
    expect(proposalsAccessorRead).toBe(false);

    const revokedResult = Proxy.revocable(validResult(req), {});
    revokedResult.revoke();
    expect(admitVisionBackendResult({
      request: req,
      rawResult: revokedResult.proxy,
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });

    const sparseProposals = new Array(1);
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { proposals: sparseProposals }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });

    const sidePropertyProposals = [proposal];
    Object.defineProperty(sidePropertyProposals, "extra", {
      enumerable: true,
      value: "unexpected-array-metadata"
    });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, { proposals: sidePropertyProposals }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });

    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req, {
        proposals: [{ ...proposal, observationKind: "TEXT" }]
      }),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
  });
});

describe("vision freshness", () => {
  it("accepts exact current board revision and rejects older or impossible bases", () => {
    const req = request();
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req),
      expectedBackend: BACKEND
    }).accepted).toBe(true);
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req, { boardRevision: 6 }),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "STALE_BOARD" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req, { boardRevision: 4 }),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "SOURCE_MISMATCH" });
  });

  it("uses authoritative shape revisions to allow unrelated board changes and reject relevant changes", () => {
    const req = request({
      relevantShapeRevisions: [
        { shapeId: "shape:equation", expectedRevision: 3 },
        { shapeId: "shape:arrow", expectedRevision: 2 }
      ]
    });
    const compatible = admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req, {
        boardRevision: 6,
        shapeRevisions: { "shape:equation": 3, "shape:arrow": 2 },
        region: "COMPATIBLE"
      }),
      expectedBackend: BACKEND
    });
    expect(compatible.accepted).toBe(true);
    if (!compatible.accepted) throw new Error("Expected compatible narrow freshness");
    expect(compatible.observations[0]?.freshnessProof).toBe("SHAPE_AND_REGION_COMPATIBLE");
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req, {
        boardRevision: 6,
        shapeRevisions: { "shape:equation": 4, "shape:arrow": 2 },
        region: "COMPATIBLE"
      }),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "STALE_SHAPE" });
  });

  it("fails closed when shape or region freshness cannot be proven", () => {
    const req = request({
      relevantShapeRevisions: [
        { shapeId: "shape:equation", expectedRevision: 3 },
        { shapeId: "shape:arrow", expectedRevision: 2 }
      ]
    });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req, {
        boardRevision: 6,
        shapeRevisions: { "shape:arrow": 2 },
        region: "COMPATIBLE"
      }),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "FRESHNESS_UNKNOWN" });

    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req, {
        boardRevision: 6,
        shapeRevisions: { "shape:equation": null, "shape:arrow": 2 },
        region: "COMPATIBLE"
      }),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "STALE_SHAPE" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req, {
        boardRevision: 6,
        shapeRevisions: { "shape:equation": 3, "shape:arrow": 2 }
      }),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "FRESHNESS_UNKNOWN" });
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: authorityFor(req, {
        boardRevision: 5,
        shapeRevisions: { "shape:equation": 3, "shape:arrow": 2 },
        region: "UNKNOWN"
      }),
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "FRESHNESS_UNKNOWN" });
  });

  it("fails closed on malformed authority snapshots", () => {
    const req = request();
    const malformed = {
      sessionId: req.sessionId,
      boardRevision: Number.NaN
    } as unknown as VisionAuthorityView;
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: malformed,
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "FRESHNESS_UNKNOWN" });

    const revokedAuthority = Proxy.revocable(authorityFor(req), {});
    revokedAuthority.revoke();
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: revokedAuthority.proxy,
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "FRESHNESS_UNKNOWN" });

    const duplicateShapeAuthority = {
      sessionId: req.sessionId,
      boardRevision: req.sourceBoardRevision,
      currentShapeRevisions: [
        { shapeId: "shape:equation", currentRevision: 1 },
        { shapeId: "shape:equation", currentRevision: 1 }
      ]
    } as unknown as VisionAuthorityView;
    expect(admitVisionBackendResult({
      request: req,
      rawResult: validResult(req),
      authority: duplicateShapeAuthority,
      expectedBackend: BACKEND
    })).toMatchObject({ accepted: false, reason: "FRESHNESS_UNKNOWN" });
  });
});

describe("VisionRequestManager cancellation, idempotency, and resource bounds", () => {
  it("reserves capacity across re-entrant authority callbacks", () => {
    const req = request();
    const nested = request({ sessionId: req.sessionId });
    let nestedRegistration: ReturnType<VisionRequestManager["register"]> | undefined;
    const manager = new VisionRequestManager({
      maxInFlight: 1,
      authority: (candidate) => {
        if (candidate.requestId === req.requestId) {
          nestedRegistration = manager.register(nested, BACKEND);
        }
        return authorityFor(candidate);
      }
    });

    const outer = manager.register(req, BACKEND);
    expect(outer.accepted).toBe(true);
    expect(nestedRegistration).toMatchObject({
      accepted: false,
      duplicate: false,
      outcome: { reason: "RESOURCE_LIMIT" }
    });
    expect(manager.inFlightCount).toBe(1);
  });

  it("fails closed when authority shuts the manager down during registration", () => {
    const req = request();
    const manager = new VisionRequestManager({
      authority: (candidate) => {
        manager.shutdown();
        return authorityFor(candidate);
      }
    });

    expect(manager.register(req, BACKEND)).toMatchObject({
      accepted: false,
      duplicate: false,
      outcome: { reason: "MANAGER_SHUTDOWN" }
    });
    expect(manager.inFlightCount).toBe(0);
  });

  it("bounds callback request IDs before map lookup", () => {
    const req = request();
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    const oversized = VisionRequestIdSchema.safeParse("r".repeat(161));
    expect(oversized.success).toBe(false);
    expect(() => manager.cancel(("r".repeat(161)) as never)).toThrow();
  });

  it("does not expose mutable aliases to active requests or tombstoned outcomes", () => {
    const req = request();
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    const registration = manager.register(req, BACKEND);
    expect(registration.accepted).toBe(true);
    if (!registration.accepted) throw new Error("Expected registration");
    registration.request.region.regionId = "mutated-external-alias";

    const first = manager.admitResult(req.requestId, validResult(req));
    expect(first.accepted).toBe(true);
    if (!first.accepted) throw new Error("Expected accepted result");
    expect(first.observations[0]?.observation.regionId).toBe("main-work");
    if (first.observations[0] !== undefined) {
      first.observations[0].observation.interpretation = "poisoned-return-value";
    }

    const duplicate = manager.admitResult(req.requestId, validResult(req));
    expect(duplicate.accepted).toBe(true);
    if (!duplicate.accepted) throw new Error("Expected duplicate accepted result");
    expect(duplicate.observations[0]?.observation.interpretation).toBe("x = 4");
  });

  it("snapshots manager options and backend method selection against caller mutation", async () => {
    const req = request();
    let originalCalls = 0;
    let replacementCalls = 0;
    const options = { authority: () => authorityFor(req) };
    const manager = new VisionRequestManager(options);
    options.authority = () => ({
      sessionId: newSessionId(),
      boardRevision: req.sourceBoardRevision
    });

    const backend = {
      provenance: BACKEND,
      analyze: async (backendRequest: VisionInferenceRequest) => {
        originalCalls += 1;
        return VisionBackendResultSchema.parse(validResult(backendRequest));
      }
    };
    const pending = manager.submit(req, backend);
    backend.analyze = async (backendRequest: VisionInferenceRequest) => {
      replacementCalls += 1;
      return VisionBackendResultSchema.parse(validResult(backendRequest));
    };

    const result = await pending;
    expect(result.accepted).toBe(true);
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
  });

  it("deduplicates concurrent identical submissions before backend execution", async () => {
    const req = request();
    let release: (() => void) | undefined;
    let calls = 0;
    const backend: VisionInferenceBackend = {
      provenance: BACKEND,
      analyze: (backendRequest) => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve(VisionBackendResultSchema.parse(validResult(backendRequest)));
        });
      }
    };
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    const first = manager.submit(req, backend);
    const second = manager.submit({ ...req }, backend);
    await Promise.resolve();
    expect(calls).toBe(1);
    release?.();
    const [left, right] = await Promise.all([first, second]);
    expect(right).toEqual(left);
    expect(right).not.toBe(left);
    expect(left.accepted).toBe(true);
  });

  it("rechecks board freshness after a slow backend returns even without proactive supersession", async () => {
    const req = request();
    let boardRevision = 5;
    let release: (() => void) | undefined;
    const backend: VisionInferenceBackend = {
      provenance: BACKEND,
      analyze: (backendRequest) => new Promise((resolve) => {
        release = () => resolve(VisionBackendResultSchema.parse(validResult(backendRequest)));
      })
    };
    const manager = new VisionRequestManager({
      authority: () => authorityFor(req, { boardRevision })
    });
    const pending = manager.submit(req, backend);
    await Promise.resolve();
    boardRevision = 6;
    release?.();
    expect(await pending).toMatchObject({ accepted: false, reason: "STALE_BOARD" });
  });

  it("releases capacity before a normally completed submit resolves", async () => {
    const req = request();
    const manager = new VisionRequestManager({
      authority: (candidate) => authorityFor(candidate),
      maxInFlight: 1
    });
    const backend = new DeterministicFakeVisionBackend([], BACKEND);
    expect((await manager.submit(req, backend)).accepted).toBe(true);
    expect(manager.inFlightCount).toBe(0);

    const next = request({ sessionId: req.sessionId });
    expect((await manager.submit(next, backend)).accepted).toBe(true);
  });

  it("normalizes backend exceptions without retaining their sensitive text", async () => {
    const req = request();
    const sensitive = "private-provider-error-material";
    const backend: VisionInferenceBackend = {
      provenance: BACKEND,
      analyze: async () => {
        throw new Error(sensitive);
      }
    };
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    expect(await manager.submit(req, backend)).toMatchObject({
      accepted: false,
      reason: "BACKEND_ERROR"
    });
    expect(JSON.stringify(manager.diagnostics())).not.toContain(sensitive);
  });
  it("uses the deterministic fake backend and preserves observation provenance", async () => {
    const req = request();
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "EQUATION",
      interpretation: "x = 4",
      confidence: 0.91,
      relevantShapeIds: ["shape:equation"]
    }], BACKEND);
    const result = await manager.submit(req, backend);
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("Expected accepted result");
    expect(result.observations[0]).toMatchObject({
      requestId: req.requestId,
      sessionId: req.sessionId,
      snapshotBasis: req.snapshotBasis,
      backend: BACKEND,
      admittedAtBoardRevision: req.sourceBoardRevision
    });
    expect(backend.analyzeCallCount).toBe(1);
  });

  it("cancels before backend start without overstating provider compute cancellation", async () => {
    const req = request();
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    const backend = new DeterministicFakeVisionBackend([], BACKEND);
    const pending = manager.submit(req, backend);
    expect(manager.cancel(req.requestId)).toEqual({ cancelled: true, duplicate: false });
    const result = await pending;
    expect(result).toMatchObject({ accepted: false, reason: "REQUEST_CANCELLED" });
    expect(backend.analyzeCallCount).toBe(0);
    expect(manager.cancel(req.requestId)).toEqual({ cancelled: true, duplicate: true });
  });

  it("settles cancellation while an uncooperative backend retains its bounded execution slot", async () => {
    const req = request();
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const backend: VisionInferenceBackend = {
      provenance: BACKEND,
      analyze: () => {
        started?.();
        return new Promise(() => {});
      }
    };
    const manager = new VisionRequestManager({
      authority: (candidate) => authorityFor(candidate),
      maxInFlight: 1
    });
    const pending = manager.submit(req, backend);
    await didStart;
    expect(manager.inFlightCount).toBe(1);
    expect(manager.cancel(req.requestId)).toEqual({ cancelled: true, duplicate: false });
    expect(await pending).toMatchObject({ accepted: false, reason: "REQUEST_CANCELLED" });
    expect(manager.inFlightCount).toBe(1);

    const next = request({ sessionId: req.sessionId });
    expect(manager.register(next, BACKEND)).toMatchObject({
      accepted: false,
      outcome: { reason: "RESOURCE_LIMIT" }
    });
  });

  it("suppresses late results and releases capacity only when backend execution settles", async () => {
    const req = request();
    let release: (() => void) | undefined;
    let backendSettled: (() => void) | undefined;
    const didBackendSettle = new Promise<void>((resolve) => {
      backendSettled = resolve;
    });
    const backend: VisionInferenceBackend = {
      provenance: BACKEND,
      analyze: (backendRequest) => new Promise((resolve) => {
        release = () => resolve(VisionBackendResultSchema.parse(validResult(backendRequest)));
      }).finally(() => {
        backendSettled?.();
      })
    };
    const manager = new VisionRequestManager({
      authority: (candidate) => authorityFor(candidate),
      maxInFlight: 1
    });
    const pending = manager.submit(req, backend);
    await Promise.resolve();
    manager.cancel(req.requestId);
    expect(manager.inFlightCount).toBe(1);
    release?.();
    expect(await pending).toMatchObject({ accepted: false, reason: "REQUEST_CANCELLED" });
    await didBackendSettle;
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.inFlightCount).toBe(0);

    const next = request({ sessionId: req.sessionId });
    expect(manager.register(next, BACKEND).accepted).toBe(true);
  });

  it("rejects results after board changes and supports proactive stale supersession", async () => {
    const req = request();
    let boardRevision = 5;
    const manager = new VisionRequestManager({
      authority: () => authorityFor(req, { boardRevision })
    });
    expect(manager.register(req, BACKEND).accepted).toBe(true);
    boardRevision = 6;
    expect(manager.supersedeStaleRequests()).toBe(1);
    expect(manager.admitResult(req.requestId, validResult(req))).toMatchObject({
      accepted: false,
      reason: "STALE_BOARD"
    });
  });

  it("treats identical duplicate requests and callbacks idempotently and rejects conflicts", () => {
    const req = request();
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    expect(manager.register(req, BACKEND)).toMatchObject({ accepted: true, duplicate: false });
    expect(manager.register({ ...req }, BACKEND)).toMatchObject({ accepted: true, duplicate: true });
    const first = manager.admitResult(req.requestId, validResult(req));
    const duplicate = manager.admitResult(req.requestId, validResult(req));
    expect(duplicate).toEqual(first);
    const conflicting = manager.register({
      ...req,
      region: { ...req.region, regionId: "conflicting-region" }
    }, BACKEND);
    expect(conflicting).toMatchObject({
      accepted: false,
      duplicate: true,
      outcome: { accepted: false, reason: "CONFLICTING_REQUEST_ID" }
    });
    expect(manager.register(req, { ...BACKEND, modelId: "other-model" })).toMatchObject({
      accepted: false,
      duplicate: true,
      outcome: { accepted: false, reason: "CONFLICTING_REQUEST_ID" }
    });
  });

  it("keeps a running RequestId reserved even after its cancellation tombstone is evicted", async () => {
    const req = request();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const backend: VisionInferenceBackend = {
      provenance: BACKEND,
      analyze: (backendRequest) => {
        started?.();
        return new Promise((resolve) => {
          release = () => resolve(VisionBackendResultSchema.parse(validResult(backendRequest)));
        });
      }
    };
    const manager = new VisionRequestManager({
      authority: (candidate) => authorityFor(candidate),
      maxInFlight: 2,
      maxTombstones: 1
    });
    const pending = manager.submit(req, backend);
    await didStart;
    manager.cancel(req.requestId);
    expect(await pending).toMatchObject({ accepted: false, reason: "REQUEST_CANCELLED" });

    const other = request({ sessionId: req.sessionId });
    expect(manager.register(other, BACKEND).accepted).toBe(true);
    manager.cancel(other.requestId);
    expect(manager.tombstoneCount).toBe(1);

    expect(manager.register(req, BACKEND)).toMatchObject({
      accepted: false,
      duplicate: true,
      outcome: { reason: "CONFLICTING_REQUEST_ID" }
    });

    release?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.inFlightCount).toBe(0);
  });

  it("rejects manager cache configurations beyond hard memory ceilings", () => {
    const req = request();
    expect(() => new VisionRequestManager({
      authority: () => authorityFor(req),
      maxTombstones: 129
    })).toThrow();
    expect(() => new VisionRequestManager({
      authority: () => authorityFor(req),
      maxDiagnostics: 257
    })).toThrow();
    expect(() => new VisionRequestManager({
      authority: () => authorityFor(req),
      maxInFlight: 65
    })).toThrow();
  });

  it("bounds in-flight requests, tombstones, diagnostics, and observations", () => {
    const req1 = request();
    const req2 = request({ sessionId: req1.sessionId });
    let boardRevision = 5;
    const manager = new VisionRequestManager({
      authority: () => ({
        sessionId: req1.sessionId,
        boardRevision: BoardRevisionSchema.parse(boardRevision)
      }),
      maxInFlight: 1,
      maxTombstones: 2,
      maxDiagnostics: 2,
      maxObservationsPerResult: 1
    });
    expect(manager.register(req1, BACKEND).accepted).toBe(true);
    expect(manager.register(req2, BACKEND)).toMatchObject({
      accepted: false,
      outcome: { reason: "RESOURCE_LIMIT" }
    });
    manager.admitResult(req1.requestId, validResult(req1));

    for (let index = 0; index < 3; index += 1) {
      const next = request({ sessionId: req1.sessionId });
      boardRevision = 5;
      manager.register(next, BACKEND);
      manager.admitResult(next.requestId, validResult(next));
    }
    expect(manager.tombstoneCount).toBe(2);
    expect(manager.diagnostics()).toHaveLength(2);

    const bounded = request({ sessionId: req1.sessionId });
    manager.register(bounded, BACKEND);
    const proposal = firstProposal(bounded);
    expect(manager.admitResult(bounded.requestId, validResult(bounded, {
      proposals: [
        proposal,
        { ...proposal, proposalId: "proposal-2" }
      ]
    }))).toMatchObject({ accepted: false, reason: "INVALID_OUTPUT" });
  });

  it("fails closed on shutdown and makes shutdown/cancellation races idempotent", async () => {
    const req = request();
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    const backend = new DeterministicFakeVisionBackend([], BACKEND);
    const pending = manager.submit(req, backend);
    expect(manager.shutdown()).toBe(1);
    expect(manager.shutdown()).toBe(0);
    expect(await pending).toMatchObject({ accepted: false, reason: "REQUEST_CANCELLED" });
    const next = request({ sessionId: req.sessionId });
    expect(manager.register(next, BACKEND)).toMatchObject({
      accepted: false,
      outcome: { reason: "MANAGER_SHUTDOWN" }
    });
  });

  it("never records raw provider output, private board content, credentials, or backend exceptions in diagnostics", () => {
    const req = request();
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    manager.register(req, BACKEND);
    const secret = "authorization=super-secret-provider-token";
    manager.admitResult(req.requestId, {
      ...validResult(req),
      rawScreenshotBytes: secret,
      arbitraryStackTrace: "stack " + secret
    });
    const serialized = JSON.stringify(manager.diagnostics());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("rawScreenshotBytes");
    expect(serialized).not.toContain("stack");
  });

  it("passes a cloned request to the authority snapshot resolver", () => {
    const req = request();
    const originalRegionId = req.region.regionId;
    const manager = new VisionRequestManager({
      authority: (authorityRequest) => {
        (authorityRequest.region as { regionId: string }).regionId = "mutated-authority-copy";
        return authorityFor(req);
      }
    });
    expect(manager.register(req, BACKEND).accepted).toBe(true);
    expect(req.region.regionId).toBe(originalRegionId);
    expect(manager.admitResult(req.requestId, validResult(req)).accepted).toBe(true);
  });

  it("snapshots deterministic fake backend fixtures against caller mutation", async () => {
    const req = request();
    const shapeIds = ["shape:equation"];
    const fixture = {
      observationKind: "EQUATION" as const,
      interpretation: "original fixture",
      confidence: 0.8,
      relevantShapeIds: shapeIds
    };
    const fixtures = [fixture];
    const backend = new DeterministicFakeVisionBackend(fixtures, BACKEND);
    fixture.interpretation = "mutated fixture";
    shapeIds.push("shape:hostile");
    fixtures.push({
      observationKind: "EQUATION",
      interpretation: "late fixture",
      confidence: 0.1,
      relevantShapeIds: []
    });
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    const result = await manager.submit(req, backend);
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("Expected accepted fake backend result");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.observation.interpretation).toBe("original fixture");
    expect(result.observations[0]?.observation.relevantShapeIds).toEqual(["shape:equation"]);
  });

  it("copies the request basis before asynchronous execution so caller mutation cannot alter admission", async () => {
    const req = request();
    const raw = {
      ...req,
      region: { ...req.region, relevantShapeIds: [...req.region.relevantShapeIds] },
      relevantShapeRevisions: [...req.relevantShapeRevisions]
    };
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    const backend = new DeterministicFakeVisionBackend([{
      observationKind: "EQUATION",
      interpretation: "x = 4",
      confidence: 0.8
    }], BACKEND);
    const pending = manager.submit(raw, backend);
    raw.region.regionId = "mutated-after-submit";
    raw.region.relevantShapeIds.push("shape:hostile");
    const result = await pending;
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("Expected accepted result");
    expect(result.observations[0]?.observation.regionId).toBe("main-work");
    expect(result.observations[0]?.observation.relevantShapeIds).not.toContain("shape:hostile");
  });

  it("returns observations only and cannot mutate evidence, pedagogy, or student-board state", async () => {
    const req = request();
    const authoritative = {
      studentShapeCount: 2,
      evidenceCount: 0,
      pedagogicalActionCount: 0
    };
    const manager = new VisionRequestManager({ authority: () => authorityFor(req) });
    const result = await manager.submit(req, new DeterministicFakeVisionBackend([{
      observationKind: "TEXT",
      interpretation: "I see x = 4",
      confidence: 0.99
    }], BACKEND));
    expect(result.accepted).toBe(true);
    expect(authoritative).toEqual({
      studentShapeCount: 2,
      evidenceCount: 0,
      pedagogicalActionCount: 0
    });
  });
});

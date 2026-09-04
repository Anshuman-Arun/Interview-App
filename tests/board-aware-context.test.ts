import { describe, expect, it } from "vitest";
import {
  AcceptedBoardObservationSchema,
  AuthoritativeStudentShapeSchema,
  BoardActionSchema,
  BoardRevisionSchema,
  BoardSceneContextSchema,
  DeliveryAtomSchema,
  DeliveryIdSchema,
  GenerationBasisSchema,
  GenerationIdSchema,
  InterviewerProposalSchema,
  TurnIdSchema,
  MAX_BOARD_ACTION_POINTS,
  MAX_BOARD_SCENE_BYTES,
  MAX_BOARD_SCENE_SHAPES,
  newRequestId,
  newSessionId,
  type AuthoritativeStudentShape
} from "../packages/domain/src/index.js";
import {
  initialSessionState,
  type SessionState
} from "../packages/events/src/index.js";
import {
  boardSceneContextSerializedBytes,
  buildBoardSceneContext,
  validateProposalBoardReferences
} from "../packages/interview-engine/src/index.js";

function shape(
  id: string,
  lastModifiedAt: number,
  text = "x",
  revision = 1,
  type: AuthoritativeStudentShape["type"] = "text"
): AuthoritativeStudentShape {
  return AuthoritativeStudentShapeSchema.parse({
    id,
    type,
    bounds: { x: lastModifiedAt, y: 0, width: 120, height: 40 },
    text,
    revision,
    createdAt: 1,
    lastModifiedAt
  });
}

function stateWithShapes(
  shapes: readonly AuthoritativeStudentShape[],
  revision = 1
): SessionState {
  return {
    ...initialSessionState(newSessionId()),
    boardRevision: BoardRevisionSchema.parse(revision),
    boardShapes: Object.fromEntries(shapes.map((item) => [item.id, item]))
  };
}

describe("bounded provider board scene", () => {
  it("omits boardScene for an empty board", () => {
    const state = initialSessionState(newSessionId());
    expect(buildBoardSceneContext(state, state.boardRevision)).toBeUndefined();
  });

  it("binds the scene to the exact authoritative board revision", () => {
    const state = stateWithShapes([shape("shape:eq", 2, "x^2 + y^2 = 1", 1, "formula")], 3);
    expect(() =>
      buildBoardSceneContext(state, BoardRevisionSchema.parse(2))
    ).toThrow("Board scene revision does not match the generation basis");

    const scene = buildBoardSceneContext(state, state.boardRevision);
    expect(scene?.boardRevision).toBe(3);
    expect(scene?.shapes[0]).toMatchObject({
      shapeId: "shape:eq",
      shapeRevision: 1,
      type: "formula",
      text: "x^2 + y^2 = 1"
    });
  });

  it("orders deterministically by semantic relevance, recency, type, then shape ID", () => {
    const state = stateWithShapes([
      shape("shape:z", 10, "oldest"),
      shape("shape:b", 30, "newer"),
      shape("shape:a", 30, "same recency")
    ]);
    const first = buildBoardSceneContext(state, state.boardRevision);
    const second = buildBoardSceneContext(state, state.boardRevision);
    expect(first).toEqual(second);
    expect(first?.shapes.map((item) => item.shapeId)).toEqual([
      "shape:a",
      "shape:b",
      "shape:z"
    ]);
  });

  it("includes only admitted sufficiently confident semantic observations", () => {
    const sessionId = newSessionId();
    const requestId = newRequestId();
    const revision = BoardRevisionSchema.parse(4);
    const target = shape("shape:eq", 10, "", 2, "formula");
    const accepted = AcceptedBoardObservationSchema.parse({
      requestId,
      sessionId,
      proposalId: "proposal:eq",
      observationKind: "EQUATION",
      observation: {
        regionId: "region:eq",
        sourceBoardRevision: revision,
        relevantShapeIds: [target.id],
        bounds: { x: 0, y: 0, width: 120, height: 40 },
        interpretation: "x^2 + y^2 = 1",
        confidence: 0.91
      },
      snapshotBasis: {
        snapshotId: "snapshot:eq",
        snapshotHash: "a".repeat(64),
        preprocessingVersion: "vision-v1",
        sourceBoardRevision: revision
      },
      sourceRelevantShapeIds: [target.id],
      shapeRevisionBindings: [{ shapeId: target.id, expectedRevision: target.revision }],
      backend: {
        backendId: "local-vision",
        backendVersion: "1",
        providerId: "local",
        modelId: "formula-ocr",
        modelVersion: "1",
        visionCapabilityVersion: "1"
      },
      admittedAtBoardRevision: revision,
      freshnessProof: "EXACT_BOARD_REVISION"
    });
    const state: SessionState = {
      ...initialSessionState(sessionId),
      boardRevision: revision,
      boardShapes: { [target.id]: target },
      visionRequests: {
        [requestId]: {
          visionRequestId: requestId,
          sourceBoardRevision: revision,
          regionId: "region:eq",
          relevantShapeIds: [target.id],
          status: "ACCEPTED",
          acceptedObservation: accepted
        }
      }
    };

    expect(buildBoardSceneContext(state, revision)?.shapes[0]?.semanticObservation)
      .toMatchObject({
        kind: "EQUATION",
        interpretation: "x^2 + y^2 = 1",
        confidence: 0.91,
        sourceBoardRevision: revision
      });

    const lowConfidence = AcceptedBoardObservationSchema.parse({
      ...accepted,
      proposalId: "proposal:low",
      observation: { ...accepted.observation, confidence: 0.4 }
    });
    const lowState: SessionState = {
      ...state,
      visionRequests: {
        [requestId]: {
          ...state.visionRequests[requestId]!,
          acceptedObservation: lowConfidence
        }
      }
    };
    expect(buildBoardSceneContext(lowState, revision)?.shapes[0]?.semanticObservation)
      .toBeUndefined();
  });

  it("prefers the most recently admitted same-revision semantic observation", () => {
    const sessionId = newSessionId();
    const revision = BoardRevisionSchema.parse(5);
    const target = shape("shape:eq", 10, "", 2, "formula");
    const olderRequestId = newRequestId();
    const newerRequestId = newRequestId();

    const accepted = (
      requestId: typeof olderRequestId,
      proposalId: string,
      interpretation: string,
      confidence: number
    ) => AcceptedBoardObservationSchema.parse({
      requestId,
      sessionId,
      proposalId,
      observationKind: "EQUATION",
      observation: {
        regionId: "region:eq",
        sourceBoardRevision: revision,
        relevantShapeIds: [target.id],
        bounds: target.bounds,
        interpretation,
        confidence
      },
      snapshotBasis: {
        snapshotId: `snapshot:${proposalId}`,
        snapshotHash: "b".repeat(64),
        preprocessingVersion: "vision-v1",
        sourceBoardRevision: revision
      },
      sourceRelevantShapeIds: [target.id],
      shapeRevisionBindings: [{ shapeId: target.id, expectedRevision: target.revision }],
      backend: {
        backendId: "local-vision",
        backendVersion: "1",
        providerId: "local",
        modelId: "formula-ocr",
        modelVersion: "1",
        visionCapabilityVersion: "1"
      },
      admittedAtBoardRevision: revision,
      freshnessProof: "EXACT_BOARD_REVISION"
    });

    const state: SessionState = {
      ...initialSessionState(sessionId),
      boardRevision: revision,
      boardShapes: { [target.id]: target },
      visionRequests: {
        [olderRequestId]: {
          visionRequestId: olderRequestId,
          sourceBoardRevision: revision,
          regionId: "region:eq",
          relevantShapeIds: [target.id],
          status: "ACCEPTED",
          acceptedObservation: accepted(
            olderRequestId,
            "proposal:older",
            "older but higher confidence",
            0.99
          ),
          resultSequence: 10
        },
        [newerRequestId]: {
          visionRequestId: newerRequestId,
          sourceBoardRevision: revision,
          regionId: "region:eq",
          relevantShapeIds: [target.id],
          status: "ACCEPTED",
          acceptedObservation: accepted(
            newerRequestId,
            "proposal:newer",
            "newer admitted interpretation",
            0.8
          ),
          resultSequence: 20
        }
      }
    };

    expect(buildBoardSceneContext(state, revision)?.shapes[0]?.semanticObservation?.interpretation)
      .toBe("newer admitted interpretation");
  });

  it("selects recent exposed AI annotations by authoritative turn/replay order, not random IDs", () => {
    const revision = BoardRevisionSchema.parse(1);
    const sessionId = newSessionId();
    const deliveries: Record<string, SessionState["deliveries"][string]> = {};
    const generations: Record<string, SessionState["generations"][string]> = {};

    for (let index = 1; index <= 7; index += 1) {
      const generationId = GenerationIdSchema.parse(`generation:${String(index)}`);
      const deliveryId = DeliveryIdSchema.parse(
        `delivery:${String(8 - index)}-lexical-reverse`
      );
      const turnId = TurnIdSchema.parse(`turn:${String(index)}`);
      generations[generationId] = {
        generationId,
        basis: GenerationBasisSchema.parse({
          contextEpoch: 0,
          committedInputSequence: index,
          transcriptRevision: 0,
          boardRevision: revision,
          problemStateRevision: 0,
          policyRevision: 0,
          turnId
        }),
        provider: "mock",
        status: "VALIDATED"
      };
      deliveries[deliveryId] = DeliveryAtomSchema.parse({
        deliveryId,
        generationId,
        content: {
          medium: "WHITEBOARD",
          action: {
            operation: "write_text",
            layer: "AI_ANNOTATION",
            content: `hint ${String(index)}`,
            annotationPurpose: `annotation ${String(index)}`
          }
        },
        disclosureIds: [],
        effectiveDisclosureLevel: 0,
        status: "COMPLETED"
      });
    }

    const state: SessionState = {
      ...initialSessionState(sessionId),
      boardRevision: revision,
      deliveries,
      generations
    };
    const scene = buildBoardSceneContext(state, revision);
    expect(scene?.aiAnnotations).toHaveLength(6);
    expect(scene?.aiAnnotations.map((item) => item.deliveryId)).toEqual([
      "delivery:1-lexical-reverse",
      "delivery:2-lexical-reverse",
      "delivery:3-lexical-reverse",
      "delivery:4-lexical-reverse",
      "delivery:5-lexical-reverse",
      "delivery:6-lexical-reverse"
    ]);
  });

  it("hard-bounds shape count, per-shape text, and aggregate serialized bytes", () => {
    const shapes = Array.from({ length: 80 }, (_, index) =>
      shape(
        `shape:${String(index).padStart(3, "0")}`,
        index + 1,
        "x".repeat(8_000)
      )
    );
    const state = stateWithShapes(shapes, 9);
    const scene = buildBoardSceneContext(state, state.boardRevision);
    expect(scene).toBeDefined();
    expect(scene!.shapes.length).toBeLessThanOrEqual(MAX_BOARD_SCENE_SHAPES);
    expect(boardSceneContextSerializedBytes(scene!)).toBeLessThanOrEqual(MAX_BOARD_SCENE_BYTES);
    expect(scene!.shapes.every((item) => (item.text?.length ?? 0) <= 384)).toBe(true);
  });

  it("fails closed when authoritative shape state is unknown", () => {
    const state: SessionState = {
      ...stateWithShapes([shape("shape:a", 1)], 2),
      boardShapeAuthorityKnown: false
    };
    expect(() => buildBoardSceneContext(state, state.boardRevision))
      .toThrow("Authoritative board shape state is unavailable");
  });
});

describe("controlled BoardAction DSL", () => {
  it("accepts bounded placement and geometry primitives", () => {
    expect(BoardActionSchema.parse({
      operation: "write_equation",
      layer: "AI_ANNOTATION",
      content: "y = sqrt(1-x^2)",
      placement: {
        anchorShapeId: "shape:eq",
        anchorRevision: 2,
        position: "RIGHT",
        offsetX: 12,
        offsetY: 0
      },
      annotationPurpose: "support the spoken probe"
    }).operation).toBe("write_equation");

    expect(BoardActionSchema.parse({
      operation: "draw_segment",
      layer: "AI_ANNOTATION",
      points: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
      annotationPurpose: "mark the relevant segment"
    }).operation).toBe("draw_segment");

    expect(BoardActionSchema.parse({
      operation: "draw_arrow_between",
      layer: "AI_ANNOTATION",
      fromShapeId: "shape:a",
      fromShapeRevision: 1,
      toShapeId: "shape:b",
      toShapeRevision: 3,
      annotationPurpose: "connect the two candidate objects"
    }).operation).toBe("draw_arrow_between");

    expect(BoardActionSchema.parse({
      operation: "draw_rectangle",
      layer: "AI_ANNOTATION",
      placement: { x: 20, y: 30 },
      width: 120,
      height: 80,
      annotationPurpose: "sketch an auxiliary box"
    }).operation).toBe("draw_rectangle");
  });

  it("rejects malformed or unbounded geometry and arbitrary tldraw blobs", () => {
    expect(BoardActionSchema.safeParse({
      operation: "draw_segment",
      layer: "AI_ANNOTATION",
      points: [{ x: 0, y: 0 }],
      annotationPurpose: "bad segment"
    }).success).toBe(false);

    expect(BoardActionSchema.safeParse({
      operation: "draw_polyline",
      layer: "AI_ANNOTATION",
      points: Array.from({ length: MAX_BOARD_ACTION_POINTS + 1 }, (_, i) => ({ x: i, y: i })),
      annotationPurpose: "too many points"
    }).success).toBe(false);

    expect(BoardActionSchema.safeParse({
      operation: "draw_rectangle",
      layer: "AI_ANNOTATION",
      placement: { x: 0, y: 0 },
      width: Number.POSITIVE_INFINITY,
      height: 10,
      annotationPurpose: "non-finite"
    }).success).toBe(false);

    expect(BoardActionSchema.safeParse({
      operation: "circle",
      layer: "AI_ANNOTATION",
      targetShapeId: "shape:a",
      expectedShapeRevision: 1,
      annotationPurpose: "attempt prop smuggling",
      props: { geo: "rectangle", color: "red" }
    }).success).toBe(false);
  });

  it("caps one interviewer turn at twelve board actions", () => {
    const action = {
      operation: "draw_segment" as const,
      layer: "AI_ANNOTATION" as const,
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      annotationPurpose: "small mark"
    };
    expect(InterviewerProposalSchema.safeParse({
      realizedAction: "FOCUS_ATTENTION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      speechText: "Look here.",
      boardActions: Array.from({ length: 13 }, () => action)
    }).success).toBe(false);
  });
});

describe("board target admission", () => {
  const scene = BoardSceneContextSchema.parse({
    boardRevision: 7,
    shapes: [
      {
        shapeId: "shape:a",
        shapeRevision: 2,
        type: "formula",
        bounds: { x: 0, y: 0, width: 100, height: 30 },
        text: "x = y"
      },
      {
        shapeId: "shape:b",
        shapeRevision: 4,
        type: "stroke",
        bounds: { x: 200, y: 0, width: 80, height: 40 }
      }
    ],
    aiAnnotations: []
  });

  it("accepts exact scene targets and rejects invented or stale targets", () => {
    const exact = InterviewerProposalSchema.parse({
      realizedAction: "FOCUS_ATTENTION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      speechText: "Focus on this equality.",
      boardActions: [{
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: "shape:a",
        expectedShapeRevision: 2,
        annotationPurpose: "focus current equality"
      }]
    });
    expect(validateProposalBoardReferences(exact, scene)).toBeUndefined();

    const invented = InterviewerProposalSchema.parse({
      ...exact,
      boardActions: [{
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: "shape:invented",
        expectedShapeRevision: 1,
        annotationPurpose: "invalid invented target"
      }]
    });
    expect(validateProposalBoardReferences(invented, scene))
      .toContain("was not present in the compiled board scene");

    const stale = InterviewerProposalSchema.parse({
      ...exact,
      boardActions: [{
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: "shape:a",
        expectedShapeRevision: 1,
        annotationPurpose: "stale target"
      }]
    });
    expect(validateProposalBoardReferences(stale, scene))
      .toContain("revision does not match");
  });

  it("requires exact revisions for shape-relative geometry", () => {
    const proposal = InterviewerProposalSchema.parse({
      realizedAction: "FOCUS_ATTENTION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      boardActions: [{
        operation: "draw_arrow_between",
        layer: "AI_ANNOTATION",
        fromShapeId: "shape:a",
        fromShapeRevision: 2,
        toShapeId: "shape:b",
        toShapeRevision: 4,
        annotationPurpose: "compare these two"
      }]
    });
    expect(validateProposalBoardReferences(proposal, scene)).toBeUndefined();
  });

  it("does not let a provider address arbitrary AI canvas IDs for erasure", () => {
    const proposal = InterviewerProposalSchema.parse({
      realizedAction: "FOCUS_ATTENTION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      boardActions: [{
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        targetShapeId: "shape:ai_guess",
        expectedShapeRevision: 1,
        annotationPurpose: "attempt arbitrary erase"
      }]
    });
    expect(validateProposalBoardReferences(proposal, scene))
      .toContain("cannot address an AI annotation");
  });
});

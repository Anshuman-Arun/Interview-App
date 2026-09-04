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
  bindTargetlessAiAnnotationErases,
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

  it("rejects internally inconsistent board-scene completeness metadata", () => {
    expect(BoardSceneContextSchema.safeParse({
      boardRevision: 1,
      studentShapeCount: 0,
      includedStudentShapeCount: 0,
      omittedStudentShapeCount: 0,
      studentShapesTruncated: false,
      aiAnnotationCount: 0,
      includedAiAnnotationCount: 0,
      aiAnnotationsTruncated: false,
      aiAnnotationStateUncertain: false,
      shapes: [{
        shapeId: "shape:unexpected",
        shapeRevision: 1,
        type: "text",
        bounds: { x: 0, y: 0, width: 100, height: 40 },
        text: "present despite zero included count"
      }],
      semanticRelations: [],
      aiAnnotations: []
    }).success).toBe(false);
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
    const originalRequest = state.visionRequests[requestId];
    if (originalRequest === undefined) throw new Error("Expected vision request fixture");
    const lowState: SessionState = {
      ...state,
      visionRequests: {
        [requestId]: {
          ...originalRequest,
          acceptedObservation: lowConfidence
        }
      }
    };
    expect(buildBoardSceneContext(lowState, revision)?.shapes[0]?.semanticObservation)
      .toBeUndefined();
  });

  it("preserves an admitted relationship observation as one bounded scene-level relation", () => {
    const sessionId = newSessionId();
    const revision = BoardRevisionSchema.parse(6);
    const requestId = newRequestId();
    const a = shape("shape:a", 10, "", 1, "stroke");
    const b = shape("shape:b", 11, "", 1, "stroke");
    const cShape = shape("shape:c", 12, "", 1, "stroke");
    const accepted = AcceptedBoardObservationSchema.parse({
      requestId,
      sessionId,
      proposalId: "proposal:triangle",
      observationKind: "DIAGRAM_RELATION",
      observation: {
        regionId: "region:triangle",
        sourceBoardRevision: revision,
        relevantShapeIds: [a.id, b.id, cShape.id],
        bounds: { x: 0, y: 0, width: 160, height: 80 },
        interpretation: "A, B, and C form the visible triangle",
        confidence: 0.94
      },
      snapshotBasis: {
        snapshotId: "snapshot:triangle",
        snapshotHash: "b".repeat(64),
        preprocessingVersion: "vision-v1",
        sourceBoardRevision: revision
      },
      sourceRelevantShapeIds: [a.id, b.id, cShape.id],
      shapeRevisionBindings: [
        { shapeId: a.id, expectedRevision: 1 },
        { shapeId: b.id, expectedRevision: 1 },
        { shapeId: cShape.id, expectedRevision: 1 }
      ],
      backend: {
        backendId: "local-vision",
        backendVersion: "1",
        providerId: "local",
        modelId: "diagram",
        modelVersion: "1",
        visionCapabilityVersion: "1"
      },
      admittedAtBoardRevision: revision,
      freshnessProof: "EXACT_BOARD_REVISION"
    });
    const state: SessionState = {
      ...initialSessionState(sessionId),
      boardRevision: revision,
      boardShapes: {
        [a.id]: a,
        [b.id]: b,
        [cShape.id]: cShape
      },
      visionRequests: {
        [requestId]: {
          visionRequestId: requestId,
          regionId: "region:triangle",
          relevantShapeIds: [a.id, b.id, cShape.id],
          sourceBoardRevision: revision,
          status: "ACCEPTED",
          acceptedObservation: accepted,
          resultSequence: 1
        }
      }
    };

    const scene = buildBoardSceneContext(state, revision);
    expect(scene?.semanticRelations).toHaveLength(1);
    expect(scene?.semanticRelations[0]).toMatchObject({
      observationId: requestId,
      kind: "DIAGRAM_RELATION",
      relevantShapeIds: [a.id, b.id, cShape.id],
      interpretation: "A, B, and C form the visible triangle",
      sourceBoardRevision: revision
    });
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
    expect(scene?.aiAnnotationCount).toBe(7);
    expect(scene?.includedAiAnnotationCount).toBe(6);
    expect(scene?.aiAnnotationsTruncated).toBe(true);
    expect(scene?.aiAnnotations.map((item) => item.annotationId)).toEqual([
      "delivery:1-lexical-reverse",
      "delivery:2-lexical-reverse",
      "delivery:3-lexical-reverse",
      "delivery:4-lexical-reverse",
      "delivery:5-lexical-reverse",
      "delivery:6-lexical-reverse"
    ]);
    expect(scene?.aiAnnotations.map((item) => item.content)).toEqual([
      "hint 7",
      "hint 6",
      "hint 5",
      "hint 4",
      "hint 3",
      "hint 2"
    ]);
  });

  it("replays exposed erase actions so removed AI annotations are not advertised to the provider", () => {
    const revision = BoardRevisionSchema.parse(1);
    const sessionId = newSessionId();
    const deliveries: Record<string, SessionState["deliveries"][string]> = {};
    const generations: Record<string, SessionState["generations"][string]> = {};

    for (let index = 1; index <= 3; index += 1) {
      const generationId = GenerationIdSchema.parse(`generation:erase:${String(index)}`);
      generations[generationId] = {
        generationId,
        basis: GenerationBasisSchema.parse({
          contextEpoch: 0,
          committedInputSequence: index,
          transcriptRevision: 0,
          boardRevision: revision,
          problemStateRevision: 0,
          policyRevision: 0,
          turnId: TurnIdSchema.parse(`turn:erase:${String(index)}`)
        }),
        provider: "mock",
        status: "VALIDATED"
      };
    }

    const firstId = DeliveryIdSchema.parse("delivery:erase:first");
    const secondId = DeliveryIdSchema.parse("delivery:erase:second");
    const eraseId = DeliveryIdSchema.parse("delivery:erase:latest");
    deliveries[firstId] = DeliveryAtomSchema.parse({
      deliveryId: firstId,
      generationId: GenerationIdSchema.parse("generation:erase:1"),
      content: {
        medium: "WHITEBOARD",
        action: {
          operation: "write_text",
          layer: "AI_ANNOTATION",
          content: "first",
          annotationPurpose: "first annotation"
        }
      },
      disclosureIds: [],
      effectiveDisclosureLevel: 0,
      status: "COMPLETED"
    });
    deliveries[secondId] = DeliveryAtomSchema.parse({
      deliveryId: secondId,
      generationId: GenerationIdSchema.parse("generation:erase:2"),
      content: {
        medium: "WHITEBOARD",
        action: {
          operation: "write_text",
          layer: "AI_ANNOTATION",
          content: "second",
          annotationPurpose: "second annotation"
        }
      },
      disclosureIds: [],
      effectiveDisclosureLevel: 0,
      status: "COMPLETED"
    });
    deliveries[eraseId] = DeliveryAtomSchema.parse({
      deliveryId: eraseId,
      generationId: GenerationIdSchema.parse("generation:erase:3"),
      content: {
        medium: "WHITEBOARD",
        action: {
          operation: "erase_ai_annotation",
          layer: "AI_ANNOTATION",
          annotationPurpose: "withdraw latest annotation"
        }
      },
      disclosureIds: [],
      effectiveDisclosureLevel: 0,
      status: "COMPLETED"
    });

    const state: SessionState = {
      ...initialSessionState(sessionId),
      boardRevision: revision,
      deliveries,
      generations
    };
    const scene = buildBoardSceneContext(state, revision);
    expect(scene?.aiAnnotations.map((item) => item.annotationId)).toEqual([firstId]);
    expect(scene?.aiAnnotationCount).toBe(1);
    expect(scene?.includedAiAnnotationCount).toBe(1);
    expect(scene?.aiAnnotationsTruncated).toBe(false);

    const targetedEraseId = DeliveryIdSchema.parse("delivery:erase:targeted");
    const targetedState: SessionState = {
      ...state,
      deliveries: {
        ...state.deliveries,
        [eraseId]: DeliveryAtomSchema.parse({
          deliveryId: eraseId,
          generationId: GenerationIdSchema.parse("generation:erase:3"),
          content: {
            medium: "WHITEBOARD",
            action: {
              operation: "erase_ai_annotation",
              layer: "AI_ANNOTATION",
              targetAnnotationId: firstId,
              annotationPurpose: "withdraw first annotation"
            }
          },
          disclosureIds: [],
          effectiveDisclosureLevel: 0,
          status: "COMPLETED"
        }),
        [targetedEraseId]: DeliveryAtomSchema.parse({
          deliveryId: targetedEraseId,
          generationId: GenerationIdSchema.parse("generation:erase:3"),
          content: {
            medium: "WHITEBOARD",
            action: {
              operation: "write_text",
              layer: "AI_ANNOTATION",
              content: "third",
              annotationPurpose: "third annotation"
            }
          },
          disclosureIds: [],
          effectiveDisclosureLevel: 0,
          status: "COMPLETED"
        })
      }
    };
    const targetedScene = buildBoardSceneContext(targetedState, revision);
    expect(targetedScene?.aiAnnotations.map((item) => item.annotationId)).toContain(targetedEraseId);
    expect(targetedScene?.aiAnnotations.map((item) => item.annotationId)).not.toContain(firstId);
  });

  it("suppresses prior AI annotation history when physical whiteboard visibility is uncertain", () => {
    const revision = BoardRevisionSchema.parse(1);
    const sessionId = newSessionId();
    const generationId = GenerationIdSchema.parse("generation:uncertain:1");
    const eraseGenerationId = GenerationIdSchema.parse("generation:uncertain:2");
    const annotationId = DeliveryIdSchema.parse("delivery:uncertain:annotation");
    const uncertainEraseId = DeliveryIdSchema.parse("delivery:uncertain:erase");
    const generations: Record<string, SessionState["generations"][string]> = {
      [generationId]: {
        generationId,
        basis: GenerationBasisSchema.parse({
          contextEpoch: 0,
          committedInputSequence: 1,
          transcriptRevision: 0,
          boardRevision: revision,
          problemStateRevision: 0,
          policyRevision: 0,
          turnId: TurnIdSchema.parse("turn:uncertain:1")
        }),
        provider: "mock",
        status: "VALIDATED"
      },
      [eraseGenerationId]: {
        generationId: eraseGenerationId,
        basis: GenerationBasisSchema.parse({
          contextEpoch: 0,
          committedInputSequence: 2,
          transcriptRevision: 0,
          boardRevision: revision,
          problemStateRevision: 0,
          policyRevision: 0,
          turnId: TurnIdSchema.parse("turn:uncertain:2")
        }),
        provider: "mock",
        status: "VALIDATED"
      }
    };
    const deliveries: Record<string, SessionState["deliveries"][string]> = {
      [annotationId]: DeliveryAtomSchema.parse({
        deliveryId: annotationId,
        generationId,
        content: {
          medium: "WHITEBOARD",
          action: {
            operation: "write_text",
            layer: "AI_ANNOTATION",
            content: "visible hint",
            annotationPurpose: "prior visible annotation"
          }
        },
        disclosureIds: [],
        effectiveDisclosureLevel: 0,
        status: "COMPLETED"
      }),
      [uncertainEraseId]: DeliveryAtomSchema.parse({
        deliveryId: uncertainEraseId,
        generationId: eraseGenerationId,
        content: {
          medium: "WHITEBOARD",
          action: {
            operation: "erase_ai_annotation",
            layer: "AI_ANNOTATION",
            targetAnnotationId: annotationId,
            annotationPurpose: "ambiguous physical erase"
          }
        },
        disclosureIds: [],
        effectiveDisclosureLevel: 0,
        status: "POSSIBLY_EXPOSED"
      })
    };
    const state: SessionState = {
      ...initialSessionState(sessionId),
      boardRevision: revision,
      deliveries,
      generations
    };

    const scene = buildBoardSceneContext(state, revision);
    expect(scene?.aiAnnotationStateUncertain).toBe(true);
    expect(scene?.aiAnnotationCount).toBe(0);
    expect(scene?.includedAiAnnotationCount).toBe(0);
    expect(scene?.aiAnnotations).toEqual([]);
  });

  it("drops narrow-freshness semantics after any later board revision without a new region proof", () => {
    const sessionId = newSessionId();
    const sourceRevision = BoardRevisionSchema.parse(1);
    const admittedRevision = BoardRevisionSchema.parse(2);
    const currentRevision = BoardRevisionSchema.parse(3);
    const requestId = newRequestId();
    const target = shape("shape:eq", 10, "", 2, "formula");
    const accepted = AcceptedBoardObservationSchema.parse({
      requestId,
      sessionId,
      proposalId: "proposal:narrow",
      observationKind: "EQUATION",
      observation: {
        regionId: "region:eq",
        sourceBoardRevision: sourceRevision,
        relevantShapeIds: [target.id],
        bounds: target.bounds,
        interpretation: "x^2 + y^2 = 1",
        confidence: 0.95
      },
      snapshotBasis: {
        snapshotId: "snapshot:narrow",
        snapshotHash: "c".repeat(64),
        preprocessingVersion: "vision-v1",
        sourceBoardRevision: sourceRevision
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
      admittedAtBoardRevision: admittedRevision,
      freshnessProof: "SHAPE_AND_REGION_COMPATIBLE"
    });
    const state: SessionState = {
      ...initialSessionState(sessionId),
      boardRevision: currentRevision,
      boardShapes: { [target.id]: target },
      visionRequests: {
        [requestId]: {
          visionRequestId: requestId,
          sourceBoardRevision: sourceRevision,
          regionId: "region:eq",
          relevantShapeIds: [target.id],
          status: "ACCEPTED",
          acceptedObservation: accepted,
          resultSequence: 12
        }
      }
    };

    expect(buildBoardSceneContext(state, currentRevision)?.shapes[0]?.semanticObservation)
      .toBeUndefined();
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
    if (scene === undefined) throw new Error("Expected bounded board scene");
    expect(scene.shapes.length).toBeLessThanOrEqual(MAX_BOARD_SCENE_SHAPES);
    expect(boardSceneContextSerializedBytes(scene)).toBeLessThanOrEqual(MAX_BOARD_SCENE_BYTES);
    expect(scene.shapes.every((item) => (item.text?.length ?? 0) <= 384)).toBe(true);
    expect(scene.studentShapeCount).toBe(80);
    expect(scene.includedStudentShapeCount).toBe(scene.shapes.length);
    expect(scene.omittedStudentShapeCount).toBe(80 - scene.shapes.length);
    expect(scene.studentShapesTruncated).toBe(true);
    expect(scene.contentBounds).toBeDefined();
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
      operation: "write_text",
      layer: "AI_ANNOTATION",
      content: "misplaced",
      placement: { x: 0, y: 0, position: "RIGHT" },
      annotationPurpose: "absolute placement cannot carry relative direction"
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
    studentShapeCount: 2,
    includedStudentShapeCount: 2,
    omittedStudentShapeCount: 0,
    studentShapesTruncated: false,
    aiAnnotationCount: 1,
    includedAiAnnotationCount: 1,
    aiAnnotationsTruncated: false,
    aiAnnotationStateUncertain: false,
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
    semanticRelations: [],
    aiAnnotations: [{
      annotationId: DeliveryIdSchema.parse("delivery:scene:annotation"),
      operation: "circle",
      purpose: "prior circle",
      targetShapeId: "shape:a",
      targetShapeRevision: 2
    }]
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

  it("requires exact revisions for bounded local-region targets", () => {
    const exact = InterviewerProposalSchema.parse({
      realizedAction: "FOCUS_ATTENTION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      boardActions: [{
        operation: "point_at",
        layer: "AI_ANNOTATION",
        targetRegion: {
          shapeId: "shape:a",
          shapeRevision: 2,
          xFraction: 0.5,
          yFraction: 0,
          widthFraction: 0.25,
          heightFraction: 1
        },
        annotationPurpose: "point at one term"
      }]
    });
    expect(validateProposalBoardReferences(exact, scene)).toBeUndefined();

    const stale = InterviewerProposalSchema.parse({
      ...exact,
      boardActions: [{
        operation: "point_at",
        layer: "AI_ANNOTATION",
        targetRegion: {
          shapeId: "shape:a",
          shapeRevision: 1,
          xFraction: 0.5,
          yFraction: 0
        },
        annotationPurpose: "stale local target"
      }]
    });
    expect(validateProposalBoardReferences(stale, scene)).toContain("revision does not match");
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

  it("binds targetless erase to the exact newest provider-visible logical annotation", () => {
    const targetless = InterviewerProposalSchema.parse({
      realizedAction: "FOCUS_ATTENTION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      boardActions: [{
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        annotationPurpose: "erase latest visible annotation"
      }]
    });
    expect(validateProposalBoardReferences(targetless, scene)).toBeUndefined();
    const bound = bindTargetlessAiAnnotationErases(targetless, scene);
    expect(bound.boardActions?.[0]).toMatchObject({
      operation: "erase_ai_annotation",
      targetAnnotationId: DeliveryIdSchema.parse("delivery:scene:annotation")
    });
  });

  it("rejects more logical erase actions than the exact provider-visible scene can satisfy", () => {
    const overErase = InterviewerProposalSchema.parse({
      realizedAction: "FOCUS_ATTENTION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      boardActions: [
        {
          operation: "erase_ai_annotation",
          layer: "AI_ANNOTATION",
          annotationPurpose: "remove latest annotation"
        },
        {
          operation: "erase_ai_annotation",
          layer: "AI_ANNOTATION",
          annotationPurpose: "try to remove another annotation"
        }
      ]
    });
    expect(validateProposalBoardReferences(overErase, scene))
      .toContain("No provider-visible AI annotation is available");
  });

  it("accepts only provider-visible logical annotation IDs for erasure", () => {
    expect(InterviewerProposalSchema.safeParse({
      realizedAction: "FOCUS_ATTENTION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      boardActions: [{
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        targetShapeId: "shape:ai_guess",
        expectedShapeRevision: 1,
        annotationPurpose: "attempt arbitrary renderer erase"
      }]
    }).success).toBe(false);

    const exact = InterviewerProposalSchema.parse({
      realizedAction: "FOCUS_ATTENTION",
      claimedDisclosureLevel: 0,
      claimedDisclosureIds: [],
      boardActions: [{
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        targetAnnotationId: DeliveryIdSchema.parse("delivery:scene:annotation"),
        annotationPurpose: "erase prior circle"
      }]
    });
    expect(validateProposalBoardReferences(exact, scene)).toBeUndefined();

    const unknown = InterviewerProposalSchema.parse({
      ...exact,
      boardActions: [{
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        targetAnnotationId: DeliveryIdSchema.parse("delivery:scene:unknown"),
        annotationPurpose: "erase unknown annotation"
      }]
    });
    expect(validateProposalBoardReferences(unknown, scene))
      .toContain("was not present");
  });
});

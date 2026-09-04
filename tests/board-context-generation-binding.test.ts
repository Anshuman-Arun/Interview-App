import { describe, expect, it } from "vitest";
import {
  AcceptedBoardObservationSchema,
  AuthoritativeStudentShapeSchema,
  BoardRevisionSchema,
  newSessionId
} from "../packages/domain/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  ContextCoordinator,
  DisclosureValidator,
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";

describe("board provider-context generation binding", () => {
  it("supersedes same-board-revision output when newly admitted vision changes the compiled scene", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = new SessionRuntimeRegistry(store).get(sessionId);
    const turns = new TurnCoordinator(writer);

    try {
      await turns.startSession(sixPeopleProblem);
      const target = AuthoritativeStudentShapeSchema.parse({
        id: "shape:eq",
        type: "formula",
        bounds: { x: 20, y: 30, width: 180, height: 40 },
        text: "x^2 + y^2 = 1",
        revision: 1,
        createdAt: 1,
        lastModifiedAt: 1
      });
      await turns.commitBoardMutation({
        baseBoardRevision: BoardRevisionSchema.parse(0),
        added: [target],
        updated: [],
        deleted: []
      });

      const { inputEpisodeId, turnId } = await turns.commitInput(
        "I think this equation is useful."
      );
      await turns.selectAction(turnId, sixPeopleProblem);
      const { generationId, basis } = await turns.startGeneration(
        inputEpisodeId,
        turnId,
        "mock-board-aware-provider"
      );

      const compilationCommand = await new ContextCoordinator(writer).compileForGeneration({
        generationId,
        problem: sixPeopleProblem
      });
      const compilation = compilationCommand.value;
      expect(compilation.compiled).toBe(true);
      if (!compilation.compiled) throw new Error("Expected provider context compilation");
      expect(compilation.context.boardScene?.shapes[0]?.semanticObservation).toBeUndefined();

      const requested = await turns.requestVision("region:eq", [target.id], {
        relevantShapeRevisions: [{
          shapeId: target.id,
          expectedRevision: target.revision
        }],
        regionBounds: target.bounds,
        requestedObservationKind: "EQUATION"
      });
      expect(requested.sourceBoardRevision).toBe(basis.boardRevision);

      const observation = {
        regionId: "region:eq",
        sourceBoardRevision: basis.boardRevision,
        relevantShapeIds: [target.id],
        bounds: target.bounds,
        interpretation: "x^2 + y^2 = 1",
        confidence: 0.93
      };
      const admission = AcceptedBoardObservationSchema.parse({
        requestId: requested.visionRequestId,
        sessionId,
        proposalId: "proposal:eq",
        observationKind: "EQUATION",
        observation,
        snapshotBasis: {
          snapshotId: "snapshot:eq",
          snapshotHash: "a".repeat(64),
          preprocessingVersion: "vision-v1",
          sourceBoardRevision: basis.boardRevision
        },
        sourceRelevantShapeIds: [target.id],
        shapeRevisionBindings: [{
          shapeId: target.id,
          expectedRevision: target.revision
        }],
        backend: {
          backendId: "local-vision",
          backendVersion: "1",
          providerId: "local",
          modelId: "formula-ocr",
          modelVersion: "1",
          visionCapabilityVersion: "1"
        },
        admittedAtBoardRevision: basis.boardRevision,
        freshnessProof: "EXACT_BOARD_REVISION"
      });
      const vision = await turns.processVisionResult({
        envelope: createCommandEnvelope({
          sessionId,
          producer: "local-vision",
          correlationId: requested.visionRequestId,
          sourceRevision: requested.sourceBoardRevision
        }),
        observation,
        admission
      });
      expect(vision.accepted).toBe(true);
      expect(writer.getState().boardRevision).toBe(basis.boardRevision);

      const currentRequest = writer.getState().pedagogicalActions[turnId];
      if (currentRequest === undefined) throw new Error("Expected pedagogical action");
      const result = await turns.processProposal({
        envelope: createCommandEnvelope({
          sessionId,
          producer: "mock-board-aware-provider",
          inputEpisodeId,
          turnId,
          generationId,
          contextEpoch: basis.contextEpoch,
          sourceRevision: basis.committedInputSequence
        }),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: currentRequest.requiredAction,
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          boardActions: [{
            operation: "highlight",
            layer: "AI_ANNOTATION",
            targetShapeId: target.id,
            expectedShapeRevision: target.revision,
            annotationPurpose: "focus on the equation"
          }]
        },
        validator: new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([]))
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toMatch(/provider context changed after compilation/u);
      expect(writer.getState().generations[generationId]?.status).toBe("SUPERSEDED");
      expect(Object.keys(writer.getState().deliveries)).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

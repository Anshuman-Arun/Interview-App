import { describe, expect, it } from "vitest";
import {
  newSessionId,
  type DeliveryAtom,
  type GenerationId,
  type InputEpisodeId,
  type TurnId
} from "../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  ContextCoordinator,
  DisclosureValidator,
  SessionRuntimeRegistry,
  TurnCoordinator,
  buildBoardSceneContext,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  InMemoryTldrawEditor,
  TldrawWhiteboardAdapter
} from "../apps/web/src/tldraw-whiteboard-adapter.js";

interface StartedTurn {
  readonly inputEpisodeId: InputEpisodeId;
  readonly turnId: TurnId;
  readonly generationId: GenerationId;
}

describe("stateful collaborative board interaction", () => {
  it("keeps logical AI annotations consistent across three turns and session replay", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const sessionId = newSessionId();
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const turns = new TurnCoordinator(writer);
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const safeTexts = [
        "What does this equation tell you geometrically?",
        "focus the current equation",
        "What can you isolate from the equation before going further?",
        "y^2 = 1 - x^2",
        "write one auxiliary relation",
        "How does that new relation help with your next step?",
        "remove the obsolete circle"
      ];
      const validator = new DisclosureValidator(
        new ClosedWorldDisclosureAnalyzer(safeTexts)
      );

      await turns.startSession(sixPeopleProblem);
      const firstMutation = await turns.commitBoardMutation({
        baseBoardRevision: writer.getState().boardRevision,
        added: [{
          id: "shape:eq",
          type: "formula",
          bounds: { x: 100, y: 100, width: 220, height: 48 },
          text: "x^2 + y^2 = 1",
          revision: 1,
          createdAt: 1,
          lastModifiedAt: 1
        }],
        updated: [],
        deleted: []
      });
      expect(firstMutation.committed).toBe(true);

      const turnA = await startTurn(
        turns,
        writer,
        "I wrote x^2 + y^2 = 1.",
        "mock-collaborative-board"
      );
      const compilationA = await compileTurn(writer, turnA.generationId);
      expect(compilationA.boardScene?.aiAnnotations).toHaveLength(0);
      expect(compilationA.boardScene?.shapes.map((shape) => shape.shapeId))
        .toContain("shape:eq");

      const resultA = await turns.processProposal({
        envelope: providerEnvelope(writer, turnA),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: requiredAction(writer, turnA.generationId),
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          speechText: "What does this equation tell you geometrically?",
          boardActions: [{
            operation: "circle",
            layer: "AI_ANNOTATION",
            targetShapeId: "shape:eq",
            expectedShapeRevision: 1,
            annotationPurpose: "focus the current equation"
          }]
        },
        validator
      });
      expect(resultA.accepted).toBe(true);
      if (!resultA.accepted) throw new Error(resultA.reason);
      const circleAtom = resultA.deliveryAtoms.find(
        (atom) =>
          atom.content.medium === "WHITEBOARD"
          && atom.content.action.operation === "circle"
      );
      if (circleAtom === undefined) throw new Error("Expected circle delivery");
      await exposeAtoms(writer, adapter, resultA.deliveryAtoms);

      const secondMutation = await turns.commitBoardMutation({
        baseBoardRevision: writer.getState().boardRevision,
        added: [{
          id: "shape:reasoning",
          type: "formula",
          bounds: { x: 100, y: 180, width: 220, height: 48 },
          text: "I can isolate y^2",
          revision: 1,
          createdAt: 2,
          lastModifiedAt: 2
        }],
        updated: [],
        deleted: []
      });
      expect(secondMutation.committed).toBe(true);

      const turnB = await startTurn(
        turns,
        writer,
        "I think I can isolate one term now.",
        "mock-collaborative-board"
      );
      const compilationB = await compileTurn(writer, turnB.generationId);
      expect(compilationB.boardScene?.aiAnnotations.map((item) => item.annotationId))
        .toContain(circleAtom.deliveryId);

      const resultB = await turns.processProposal({
        envelope: providerEnvelope(writer, turnB),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: requiredAction(writer, turnB.generationId),
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          speechText: "What can you isolate from the equation before going further?",
          boardActions: [{
            operation: "write_equation",
            layer: "AI_ANNOTATION",
            content: "y^2 = 1 - x^2",
            placement: {
              anchorShapeId: "shape:eq",
              anchorRevision: 1,
              position: "RIGHT"
            },
            annotationPurpose: "write one auxiliary relation"
          }]
        },
        validator
      });
      expect(resultB.accepted).toBe(true);
      if (!resultB.accepted) throw new Error(resultB.reason);
      const auxiliaryAtom = resultB.deliveryAtoms.find(
        (atom) =>
          atom.content.medium === "WHITEBOARD"
          && atom.content.action.operation === "write_equation"
      );
      if (auxiliaryAtom === undefined) throw new Error("Expected auxiliary equation delivery");
      await exposeAtoms(writer, adapter, resultB.deliveryAtoms);

      const turnC = await startTurn(
        turns,
        writer,
        "The circle is no longer useful; the auxiliary equation is.",
        "mock-collaborative-board"
      );
      const compilationC = await compileTurn(writer, turnC.generationId);
      expect(compilationC.boardScene?.aiAnnotations.map((item) => item.annotationId))
        .toEqual(expect.arrayContaining([circleAtom.deliveryId, auxiliaryAtom.deliveryId]));

      const resultC = await turns.processProposal({
        envelope: providerEnvelope(writer, turnC),
        problem: sixPeopleProblem,
        proposal: {
          realizedAction: requiredAction(writer, turnC.generationId),
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          speechText: "How does that new relation help with your next step?",
          boardActions: [{
            operation: "erase_ai_annotation",
            layer: "AI_ANNOTATION",
            targetAnnotationId: circleAtom.deliveryId,
            annotationPurpose: "remove the obsolete circle"
          }]
        },
        validator
      });
      expect(resultC.accepted).toBe(true);
      if (!resultC.accepted) throw new Error(resultC.reason);
      await exposeAtoms(writer, adapter, resultC.deliveryAtoms);

      const visibleIds = adapter.getCanvasSnapshot().aiAnnotations
        .map((item) => item.annotationId);
      expect(visibleIds).toContain(auxiliaryAtom.deliveryId);
      expect(visibleIds).not.toContain(circleAtom.deliveryId);

      const serverScene = buildBoardSceneContext(
        writer.getState(),
        writer.getState().boardRevision
      );
      expect(serverScene?.aiAnnotations.map((item) => item.annotationId))
        .toEqual(visibleIds);

      const replayedWriter = new SessionRuntimeRegistry(store).get(sessionId);
      const replayedScene = buildBoardSceneContext(
        replayedWriter.getState(),
        replayedWriter.getState().boardRevision
      );
      expect(replayedScene?.aiAnnotations.map((item) => item.annotationId))
        .toEqual(visibleIds);
      expect(replayedScene?.aiAnnotations[0]).toMatchObject({
        annotationId: auxiliaryAtom.deliveryId,
        operation: "write_equation",
        content: "y^2 = 1 - x^2",
        placement: {
          anchorShapeId: "shape:eq",
          anchorRevision: 1,
          position: "RIGHT"
        },
        purpose: "write one auxiliary relation"
      });
    } finally {
      store.close();
    }
  });
});

async function startTurn(
  turns: TurnCoordinator,
  writer: ReturnType<SessionRuntimeRegistry["get"]>,
  studentText: string,
  provider: string
): Promise<StartedTurn> {
  const { inputEpisodeId, turnId } = await turns.commitInput(studentText);
  await turns.selectAction(turnId, sixPeopleProblem);
  const { generationId } = await turns.startGeneration(
    inputEpisodeId,
    turnId,
    provider
  );
  return { inputEpisodeId, turnId, generationId };
}

async function compileTurn(
  writer: ReturnType<SessionRuntimeRegistry["get"]>,
  generationId: GenerationId
) {
  const compiled = await new ContextCoordinator(writer).compileForGeneration({
    generationId,
    problem: sixPeopleProblem
  });
  if (!compiled.value.compiled) {
    throw new Error(`Context compilation failed: ${compiled.value.reason}`);
  }
  return compiled.value.context;
}

function providerEnvelope(
  writer: ReturnType<SessionRuntimeRegistry["get"]>,
  turn: StartedTurn
) {
  const generation = writer.getState().generations[turn.generationId];
  if (generation === undefined) throw new Error("Generation fixture is unavailable");
  return createCommandEnvelope({
    sessionId: writer.sessionId,
    producer: generation.provider,
    inputEpisodeId: turn.inputEpisodeId,
    turnId: turn.turnId,
    generationId: turn.generationId,
    contextEpoch: generation.basis.contextEpoch,
    sourceRevision: generation.basis.committedInputSequence
  });
}

function requiredAction(
  writer: ReturnType<SessionRuntimeRegistry["get"]>,
  generationId: GenerationId
) {
  const generation = writer.getState().generations[generationId];
  if (generation?.pedagogicalAction === undefined) {
    throw new Error("Generation pedagogical action is unavailable");
  }
  return generation.pedagogicalAction.requiredAction;
}

async function exposeAtoms(
  writer: ReturnType<SessionRuntimeRegistry["get"]>,
  adapter: TldrawWhiteboardAdapter,
  atoms: readonly DeliveryAtom[]
): Promise<void> {
  const delivery = new DeliveryCoordinator(writer);
  for (const atom of atoms) {
    await delivery.markStarted(atom.deliveryId);
    if (atom.content.medium === "WHITEBOARD") {
      await adapter.presentWhiteboard(atom.content.action, atom.deliveryId);
    }
    await delivery.acknowledgeExposed(atom.deliveryId);
    await delivery.acknowledgeCompleted(atom.deliveryId);
  }
}

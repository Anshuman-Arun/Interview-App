import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BoardObservationSchema, newSessionId } from "../packages/domain/src/index.js";
import { SessionRuntimeRegistry, TurnCoordinator, createCommandEnvelope } from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";

describe("randomized multimodal and vision callback schedules", () => {
  it("preserves strict sequence, episode cohesion, vision finality, and callback idempotency", async () => {
    const schedules = fc.array(
      fc.constantFrom("BOARD", "TYPE", "FALSE_SPEECH", "SPEECH", "VISION" as const),
      { minLength: 1, maxLength: 8 }
    ).filter((items) => items.includes("VISION"));

    await fc.assert(fc.asyncProperty(schedules, async (operations) => {
      const store = new SqliteEventStore(":memory:");
      try {
        const writer = new SessionRuntimeRegistry(store).get(newSessionId());
        const turns = new TurnCoordinator(writer);
        await turns.startSession(sixPeopleProblem);
        const initialUtterance = await turns.beginUtterance();
        const episode = await turns.finalizeUtterance({ utteranceId: initialUtterance, text: "initial speech" });
        const vision = await turns.requestVision("region", ["shape-1"]);
        const visionEnvelope = createCommandEnvelope({
          sessionId: writer.sessionId,
          producer: "property-vision",
          correlationId: vision.visionRequestId,
          sourceRevision: vision.sourceBoardRevision
        });
        const visionObservation = BoardObservationSchema.parse({
          regionId: "region",
          sourceBoardRevision: vision.sourceBoardRevision,
          relevantShapeIds: ["shape-1"],
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          interpretation: "work",
          confidence: 0.8
        });
        let firstVisionResult: Awaited<ReturnType<typeof turns.processVisionResult>> | undefined;

        for (const [index, operation] of operations.entries()) {
          if (operation === "BOARD") await turns.appendBoardInput(episode.inputEpisodeId, `board ${String(index)}`);
          if (operation === "TYPE") await turns.appendTypedInput(episode.inputEpisodeId, `typed ${String(index)}`);
          if (operation === "FALSE_SPEECH") {
            const utteranceId = await turns.beginUtterance();
            await turns.discardUtterance(utteranceId, "property false onset");
          }
          if (operation === "SPEECH") {
            const utteranceId = await turns.beginUtterance();
            await turns.finalizeUtterance({ utteranceId, inputEpisodeId: episode.inputEpisodeId, text: `speech ${String(index)}` });
          }
          if (operation === "VISION") {
            const result = await turns.processVisionResult({ envelope: visionEnvelope, observation: visionObservation });
            if (firstVisionResult === undefined) firstVisionResult = result;
            else expect(result).toEqual(firstVisionResult);
          }
        }
        await turns.commitInputEpisode(episode.inputEpisodeId);
        const events = store.load(writer.sessionId);
        expect(events.every((event, index) => event.sequence === index + 1)).toBe(true);
        expect(writer.getState().visionRequests[vision.visionRequestId]?.status).not.toBe("PENDING");
        expect(writer.getState().inputEpisodes[episode.inputEpisodeId]?.status).toBe("COMMITTED");
        expect(writer.getState().eventIds).toHaveLength(events.length);
      } finally {
        store.close();
      }
    }), { numRuns: 40, seed: 20260829 });
  });
});

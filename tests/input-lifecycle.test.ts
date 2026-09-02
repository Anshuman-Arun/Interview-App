import { describe, expect, it } from "vitest";
import { newSessionId } from "../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import { replaySession } from "../packages/events/src/index.js";
import { SessionRuntimeRegistry, TurnCoordinator } from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { authorizeSafeProbe, createCoreHarness } from "./harness.js";

describe("utterance and multimodal InputEpisode lifecycle", () => {
  it("discards a false VAD onset without committing a Turn", async () => {
    const harness = await createCoreHarness();
    try {
      const priorTurnCount = Object.keys(harness.writer.getState().turns).length;
      const utteranceId = await harness.turns.beginUtterance();
      await harness.turns.discardUtterance(utteranceId, "false onset");
      expect(harness.writer.getState().utterances[utteranceId]?.status).toBe("DISCARDED");
      expect(Object.keys(harness.writer.getState().turns)).toHaveLength(priorTurnCount);
      expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("SUPERSEDED");
    } finally {
      harness.store.close();
    }
  });

  it("commits speech, board work, then speech as one InputEpisode and one Turn", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const writer = new SessionRuntimeRegistry(store).get(newSessionId());
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);
      const first = await turns.beginUtterance();
      const episode = await turns.finalizeUtterance({ utteranceId: first, text: "If I colour each relationship," });
      await turns.appendBoardInput(episode.inputEpisodeId, "draws a two-colour complete graph");
      const second = await turns.beginUtterance();
      await turns.finalizeUtterance({ utteranceId: second, inputEpisodeId: episode.inputEpisodeId, text: "then I can choose a vertex." });
      const turnId = await turns.commitInputEpisode(episode.inputEpisodeId);

      expect(writer.getState().inputEpisodes[episode.inputEpisodeId]?.inputs.map((item) => item.modality)).toEqual([
        "SPEECH", "WHITEBOARD", "SPEECH"
      ]);
      expect(writer.getState().turns[turnId]?.studentText).toContain("two-colour complete graph");
      expect(writer.getState().transcriptRevision).toBe(2);
      expect(writer.getState().boardRevision).toBe(1);
      expect(store.load(writer.sessionId).filter((event) => event.type === "TURN_COMMITTED")).toHaveLength(1);
      expect(replaySession(writer.sessionId, store.load(writer.sessionId))).toEqual(writer.getState());
    } finally {
      store.close();
    }
  });

  it("keeps terminal session transitions behind active input episodes", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const writer = new SessionRuntimeRegistry(store).get(newSessionId());
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const utteranceId = await turns.beginUtterance();
      const finalized = await turns.finalizeUtterance({
        utteranceId,
        text: "This finalized speech still needs a committed turn."
      });

      await expect(turns.completeSession()).rejects.toThrow(/input episode is active/u);
      await expect(turns.archiveSession()).rejects.toThrow(/input episode is active/u);
      expect(writer.getState().status).toBe("ACTIVE");
      expect(writer.getState().inputEpisodes[finalized.inputEpisodeId]?.status).toBe("ACTIVE");

      await turns.commitInputEpisode(finalized.inputEpisodeId);
      await expect(turns.completeSession()).resolves.toMatchObject({ completed: true });
      expect(writer.getState().status).toBe("COMPLETED");
    } finally {
      store.close();
    }
  });

  it("rejects late finalization while still allowing producer-valid cleanup after terminal state", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const writer = new SessionRuntimeRegistry(store).get(newSessionId());
      const turns = new TurnCoordinator(writer);
      await turns.startSession(sixPeopleProblem);

      const utteranceId = await turns.beginUtterance();
      await turns.completeSession();

      expect(writer.getState().status).toBe("COMPLETED");
      expect(writer.getState().utterances[utteranceId]?.status).toBe("CAPTURING");
      await expect(turns.finalizeUtterance({
        utteranceId,
        text: "late transcript"
      })).rejects.toThrow(/Cannot finalize utterance in status COMPLETED/u);

      await turns.discardUtterance(utteranceId, "late worker cleanup after completion");
      expect(writer.getState().utterances[utteranceId]?.status).toBe("DISCARDED");
    } finally {
      store.close();
    }
  });

  it("cancels a queued delivery and conservatively marks an in-flight delivery on speech onset", async () => {
    const queuedHarness = await createCoreHarness();
    try {
      const queued = await authorizeSafeProbe(queuedHarness);
      await queuedHarness.turns.beginUtterance();
      expect(queuedHarness.writer.getState().deliveries[queued.deliveryId]?.status).toBe("CANCELLED");
    } finally {
      queuedHarness.store.close();
    }

    const inFlightHarness = await createCoreHarness();
    try {
      const inFlight = await authorizeSafeProbe(inFlightHarness);
      await new DeliveryCoordinator(inFlightHarness.writer).markStarted(inFlight.deliveryId);
      await inFlightHarness.turns.beginUtterance();
      expect(inFlightHarness.writer.getState().deliveries[inFlight.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    } finally {
      inFlightHarness.store.close();
    }
  });
});

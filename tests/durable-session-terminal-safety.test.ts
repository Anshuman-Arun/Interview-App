import { describe, expect, it } from "vitest";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import { SessionRuntimeRegistry } from "../packages/interview-engine/src/index.js";
import { SessionRecoveryCoordinator } from "../apps/server/src/session-recovery-coordinator.js";
import { ServerTurnOrchestrator } from "../apps/server/src/turn-orchestrator.js";
import {
  authorizeSafeProbe,
  createCoreHarness
} from "./harness.js";

describe("durable terminal session safety", () => {
  it("supersedes in-flight generation and rejects new work after completion", async () => {
    const harness = await createCoreHarness();
    expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("ACTIVE");

    await harness.turns.completeSession();

    expect(harness.writer.getState().status).toBe("COMPLETED");
    expect(harness.writer.getState().generations[harness.generationId]?.status).toBe("SUPERSEDED");
    await expect(harness.turns.beginUtterance()).rejects.toThrow(/Cannot begin utterance/u);
    await expect(harness.turns.requestVision("terminal", [])).rejects.toThrow(/Cannot request vision/u);
    await expect(harness.turns.selectAction(harness.turnId)).rejects.toThrow(/Cannot select pedagogical action/u);
    await expect(
      harness.turns.startGeneration(harness.inputEpisodeId, harness.turnId, "late-provider")
    ).rejects.toThrow(/Cannot start generation/u);
    await expect(harness.turns.commitBoardPatch("late board mutation"))
      .rejects.toThrow(/Cannot commit board patch/u);
    await expect(harness.turns.correctTranscript("late transcript mutation"))
      .rejects.toThrow(/Cannot correct transcript/u);

    harness.store.close();
  });

  it("cancels queued delivery when a session becomes terminal", async () => {
    const harness = await createCoreHarness();
    const atom = await authorizeSafeProbe(harness);
    const deliveries = new DeliveryCoordinator(harness.writer);
    expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("QUEUED");

    await harness.turns.completeSession();

    expect(harness.writer.getState().status).toBe("COMPLETED");
    expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("CANCELLED");
    await expect(deliveries.markStarted(atom.deliveryId)).rejects.toThrow();

    harness.store.close();
  });

  it("preserves uncertainty for a delivery that had started before completion", async () => {
    const harness = await createCoreHarness();
    const atom = await authorizeSafeProbe(harness);
    const deliveries = new DeliveryCoordinator(harness.writer);
    await deliveries.markStarted(atom.deliveryId);

    await harness.turns.completeSession();

    expect(harness.writer.getState().status).toBe("COMPLETED");
    expect(harness.writer.getState().deliveries[atom.deliveryId]?.status)
      .toBe("POSSIBLY_EXPOSED");
    expect(harness.writer.getState().disclosureLedger)
      .toEqual(expect.arrayContaining(atom.disclosureIds));

    harness.store.close();
  });

  it("allows only the final acknowledgement for content already exposed before completion", async () => {
    const harness = await createCoreHarness();
    const atom = await authorizeSafeProbe(harness);
    const deliveries = new DeliveryCoordinator(harness.writer);
    await deliveries.markStarted(atom.deliveryId);
    await deliveries.acknowledgeExposed(atom.deliveryId);

    await harness.turns.completeSession();

    expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("EXPOSED");
    await expect(deliveries.acknowledgeCompleted(atom.deliveryId)).resolves.toBe(true);
    expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("COMPLETED");

    harness.store.close();
  });

  it("does not restart unfinished turns when recovering a terminal session", async () => {
    const harness = await createCoreHarness();
    await harness.turns.completeSession();
    const eventCount = harness.store.eventCount(harness.sessionId);
    await harness.writer.close();

    const registry = new SessionRuntimeRegistry(harness.store);
    const sessions = new SessionRecoveryCoordinator(registry, harness.store);
    const orchestrator = new ServerTurnOrchestrator(sessions, () => undefined);
    sessions.setTurnRecoveryDelegate(orchestrator);

    await sessions.ensureRecovered(harness.sessionId);

    expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);
    expect(registry.get(harness.sessionId).getState().status).toBe("COMPLETED");

    await registry.closeAll();
    harness.store.close();
  });
});

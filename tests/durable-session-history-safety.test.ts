import { describe, expect, it } from "vitest";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import { SessionRuntimeRegistry } from "../packages/interview-engine/src/index.js";
import { SessionRecoveryCoordinator } from "../apps/server/src/session-recovery-coordinator.js";
import {
  authorizeSafeProbe,
  createCoreHarness
} from "./harness.js";

function interviewerHistory(
  recovery: SessionRecoveryCoordinator,
  sessionId: Parameters<SessionRecoveryCoordinator["getHistory"]>[0]
) {
  return recovery.getHistory(sessionId).filter((entry) => entry.role === "INTERVIEWER");
}

describe("durable presentation history safety", () => {
  it("never reconstructs queued, delivering, or possibly-exposed content as visible transcript", async () => {
    const harness = await createCoreHarness();
    const recovery = new SessionRecoveryCoordinator(
      new SessionRuntimeRegistry(harness.store),
      harness.store
    );
    const atom = await authorizeSafeProbe(harness);
    const deliveries = new DeliveryCoordinator(harness.writer);

    expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("QUEUED");
    expect(interviewerHistory(recovery, harness.sessionId)).toEqual([]);

    await deliveries.markStarted(atom.deliveryId);
    expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("DELIVERING");
    expect(interviewerHistory(recovery, harness.sessionId)).toEqual([]);

    await deliveries.markPossiblyExposed(
      atom.deliveryId,
      "test disconnect after physical delivery may have begun"
    );
    expect(harness.writer.getState().deliveries[atom.deliveryId]?.status)
      .toBe("POSSIBLY_EXPOSED");
    expect(interviewerHistory(recovery, harness.sessionId)).toEqual([]);

    harness.store.close();
  });

  it("reconstructs only persisted exposed/completed interviewer deliveries", async () => {
    const harness = await createCoreHarness();
    const recovery = new SessionRecoveryCoordinator(
      new SessionRuntimeRegistry(harness.store),
      harness.store
    );
    const atom = await authorizeSafeProbe(harness);
    const deliveries = new DeliveryCoordinator(harness.writer);

    await deliveries.markStarted(atom.deliveryId);
    await deliveries.acknowledgeExposed(atom.deliveryId);

    expect(interviewerHistory(recovery, harness.sessionId)).toEqual([
      expect.objectContaining({
        role: "INTERVIEWER",
        deliveryId: atom.deliveryId,
        text: harness.safeProbe,
        status: "EXPOSED"
      })
    ]);

    await deliveries.acknowledgeCompleted(atom.deliveryId);
    expect(interviewerHistory(recovery, harness.sessionId)).toEqual([
      expect.objectContaining({
        role: "INTERVIEWER",
        deliveryId: atom.deliveryId,
        text: harness.safeProbe,
        status: "COMPLETED"
      })
    ]);

    harness.store.close();
  });

  it("orders interviewer history at physical exposure rather than queue time", async () => {
    const harness = await createCoreHarness();
    const recovery = new SessionRecoveryCoordinator(
      new SessionRuntimeRegistry(harness.store),
      harness.store
    );
    const atom = await authorizeSafeProbe(harness);
    const deliveries = new DeliveryCoordinator(harness.writer);

    await deliveries.markStarted(atom.deliveryId);
    const laterStudent = await harness.turns.commitInput(
      "This student turn was committed after delivery start but before exposure acknowledgement."
    );
    await deliveries.acknowledgeExposed(atom.deliveryId);

    const history = recovery.getHistory(harness.sessionId);
    const laterStudentEntry = history.find(
      (entry) => entry.role === "STUDENT" && entry.turnId === laterStudent.turnId
    );
    const interviewerEntry = history.find(
      (entry) => entry.role === "INTERVIEWER" && entry.deliveryId === atom.deliveryId
    );
    if (laterStudentEntry === undefined || interviewerEntry === undefined) {
      throw new Error("Expected both later student and interviewer history entries");
    }

    expect(interviewerEntry.sequence).toBeGreaterThan(laterStudentEntry.sequence);
    expect(history.indexOf(interviewerEntry)).toBeGreaterThan(history.indexOf(laterStudentEntry));

    harness.store.close();
  });

});

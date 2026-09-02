import { createHash } from "node:crypto";
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

  it("does not duplicate a text response when its derived audio is also exposed", async () => {
    const harness = await createCoreHarness();
    const recovery = new SessionRecoveryCoordinator(
      new SessionRuntimeRegistry(harness.store),
      harness.store
    );
    const source = await authorizeSafeProbe(harness);
    const deliveries = new DeliveryCoordinator(harness.writer);

    await deliveries.markStarted(source.deliveryId);
    await deliveries.acknowledgeExposed(source.deliveryId);

    const audio = await harness.turns.queueAudioDeliveryFromValidatedText({
      sourceDeliveryId: source.deliveryId,
      generationId: source.generationId,
      text: harness.safeProbe,
      textSha256: createHash("sha256").update(harness.safeProbe, "utf8").digest("hex"),
      audioRef: `audio_v1_${"a".repeat(64)}`
    });
    if (audio === undefined) throw new Error("Expected derived audio delivery");
    await deliveries.markStarted(audio.deliveryId);
    await deliveries.acknowledgeExposed(audio.deliveryId);
    await deliveries.acknowledgeCompleted(audio.deliveryId);

    const interviewer = interviewerHistory(recovery, harness.sessionId);
    expect(interviewer).toHaveLength(1);
    expect(interviewer[0]).toEqual(expect.objectContaining({
      role: "INTERVIEWER",
      deliveryId: source.deliveryId,
      text: harness.safeProbe,
      status: "EXPOSED"
    }));

    harness.store.close();
  });

  it("preserves a derived audio exposure when the source text never received an exposure acknowledgement", async () => {
    const harness = await createCoreHarness();
    const recovery = new SessionRecoveryCoordinator(
      new SessionRuntimeRegistry(harness.store),
      harness.store
    );
    const source = await authorizeSafeProbe(harness);
    const deliveries = new DeliveryCoordinator(harness.writer);

    await deliveries.markStarted(source.deliveryId);

    const audio = await harness.turns.queueAudioDeliveryFromValidatedText({
      sourceDeliveryId: source.deliveryId,
      generationId: source.generationId,
      text: harness.safeProbe,
      textSha256: createHash("sha256").update(harness.safeProbe, "utf8").digest("hex"),
      audioRef: `audio_v1_${"b".repeat(64)}`
    });
    if (audio === undefined) throw new Error("Expected derived audio delivery");
    await deliveries.markStarted(audio.deliveryId);
    await deliveries.acknowledgeExposed(audio.deliveryId);
    await deliveries.acknowledgeCompleted(audio.deliveryId);

    const interviewer = interviewerHistory(recovery, harness.sessionId);
    expect(interviewer).toHaveLength(1);
    expect(interviewer[0]).toEqual(expect.objectContaining({
      role: "INTERVIEWER",
      deliveryId: audio.deliveryId,
      text: harness.safeProbe,
      status: "COMPLETED"
    }));

    harness.store.close();
  });

  it("preserves the first physical exposure when audio precedes its source text", async () => {
    const harness = await createCoreHarness();
    const recovery = new SessionRecoveryCoordinator(
      new SessionRuntimeRegistry(harness.store),
      harness.store
    );
    const source = await authorizeSafeProbe(harness);
    const deliveries = new DeliveryCoordinator(harness.writer);

    await deliveries.markStarted(source.deliveryId);

    const audio = await harness.turns.queueAudioDeliveryFromValidatedText({
      sourceDeliveryId: source.deliveryId,
      generationId: source.generationId,
      text: harness.safeProbe,
      textSha256: createHash("sha256").update(harness.safeProbe, "utf8").digest("hex"),
      audioRef: `audio_v1_${"c".repeat(64)}`
    });
    if (audio === undefined) throw new Error("Expected derived audio delivery");
    await deliveries.markStarted(audio.deliveryId);
    await deliveries.acknowledgeExposed(audio.deliveryId);

    await deliveries.acknowledgeExposed(source.deliveryId);

    const interviewer = interviewerHistory(recovery, harness.sessionId);
    expect(interviewer).toHaveLength(1);
    expect(interviewer[0]).toEqual(expect.objectContaining({
      role: "INTERVIEWER",
      deliveryId: audio.deliveryId,
      text: harness.safeProbe
    }));

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

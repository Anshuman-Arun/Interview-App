import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import { SessionRuntimeRegistry, createCommandEnvelope } from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { authorizeSafeProbe, createCoreHarness, providerEnvelope } from "./harness.js";

describe("durable idempotency", () => {
  it("deduplicates provider results with the same RequestId", async () => {
    const harness = await createCoreHarness();
    try {
      const envelope = providerEnvelope(harness);
      const atom = await authorizeSafeProbe(harness, envelope);
      const count = harness.store.eventCount(harness.sessionId);
      const duplicate = await harness.turns.processProposal({
        envelope,
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: harness.safeProbe },
        validator: harness.validator
      });
      expect(duplicate.accepted).toBe(true);
      expect(duplicate.deliveryAtoms[0]?.deliveryId).toBe(atom.deliveryId);
      expect(harness.store.eventCount(harness.sessionId)).toBe(count);
    } finally {
      harness.store.close();
    }
  });

  it("deduplicates renderer acknowledgements across a restarted writer", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const firstDelivery = new DeliveryCoordinator(harness.writer);
      await firstDelivery.markStarted(atom.deliveryId);
      const ackEnvelope = createCommandEnvelope({ sessionId: harness.sessionId, producer: "renderer" });
      await firstDelivery.acknowledgeExposed(atom.deliveryId, ackEnvelope);
      const count = harness.store.eventCount(harness.sessionId);
      const restartedWriter = new SessionRuntimeRegistry(harness.store).get(harness.sessionId);
      const restartedDelivery = new DeliveryCoordinator(restartedWriter);
      await restartedDelivery.acknowledgeExposed(atom.deliveryId, ackEnvelope);
      expect(harness.store.eventCount(harness.sessionId)).toBe(count);
      expect(restartedWriter.getState().deliveries[atom.deliveryId]?.status).toBe("EXPOSED");
    } finally {
      harness.store.close();
    }
  });

  it("serializes concurrent authoritative transitions", async () => {
    const harness = await createCoreHarness();
    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => harness.turns.commitBoardPatch(`patch ${String(index)}`)));
      const events = harness.store.load(harness.sessionId);
      expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
      expect(harness.writer.getState().boardRevision).toBe(20);
    } finally {
      harness.store.close();
    }
  });

  it("returns a persisted duplicate result before rerunning its transition handler", async () => {
    const harness = await createCoreHarness();
    try {
      const envelope = createCommandEnvelope({ sessionId: harness.sessionId, producer: "external-callback" });
      const resultSchema = z.object({ stable: z.literal("result") }).strict();
      const identity = { operation: "TEST_STABLE_RESULT", payload: {} } as const;
      const first = await harness.writer.execute(envelope, identity, resultSchema, () => ({ drafts: [], result: { stable: "result" } }));
      const second = await harness.writer.execute(envelope, identity, resultSchema, () => {
        throw new Error("duplicate handler must not run");
      });
      expect(first.duplicate).toBe(false);
      expect(second).toEqual({ duplicate: true, value: { stable: "result" }, appendedEventCount: 0 });
    } finally {
      harness.store.close();
    }
  });

  it("does not persist events or idempotency metadata when a command result fails runtime validation", async () => {
    const harness = await createCoreHarness();
    try {
      const envelope = createCommandEnvelope({ sessionId: harness.sessionId, producer: "invalid-result-test" });
      const count = harness.store.eventCount(harness.sessionId);
      await expect(harness.writer.execute(
        envelope,
        { operation: "TEST_RESULT_VALIDATION", payload: {} },
        z.object({ accepted: z.literal(true) }).strict(),
        () => ({ drafts: [], result: { accepted: false as true } })
      )).rejects.toThrow();
      expect(harness.store.eventCount(harness.sessionId)).toBe(count);
      const valid = await harness.writer.execute(
        envelope,
        { operation: "TEST_RESULT_VALIDATION", payload: {} },
        z.object({ accepted: z.literal(true) }).strict(),
        () => ({ drafts: [], result: { accepted: true as const } })
      );
      expect(valid.duplicate).toBe(false);
    } finally {
      harness.store.close();
    }
  });
});

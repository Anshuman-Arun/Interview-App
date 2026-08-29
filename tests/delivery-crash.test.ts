import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DeliveryAtomSchema,
  newDeliveryId
} from "../packages/domain/src/index.js";
import { DeliveryCoordinator, MockRenderer } from "../packages/delivery/src/index.js";
import { SessionRuntimeRegistry, createCommandEnvelope } from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { authorizeSafeProbe, createCoreHarness } from "./harness.js";

describe("delivery crash boundaries", () => {
  it("leaves a queued atom undisclosed when no command was sent", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const restarted = new SessionRuntimeRegistry(harness.store).get(harness.sessionId);
      const recovered = await new DeliveryCoordinator(restarted).recoverUncertainDeliveries();
      expect(recovered).toEqual([]);
      expect(restarted.getState().deliveries[atom.deliveryId]?.status).toBe("QUEUED");
    } finally {
      harness.store.close();
    }
  });

  it("marks started but unacknowledged delivery POSSIBLY_EXPOSED after restart", async () => {
    const harness = await createCoreHarness();
    try {
      const protectedDisclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
      if (protectedDisclosure === undefined) throw new Error("Problem fixture has no protected disclosure");
      const disclosureId = protectedDisclosure.id;
      const deliveryId = newDeliveryId();
      const atom = DeliveryAtomSchema.parse({
        deliveryId,
        generationId: harness.generationId,
        content: { medium: "TEXT", text: "reviewed hint" },
        disclosureIds: [disclosureId],
        effectiveDisclosureLevel: 2,
        status: "VALIDATED"
      });
      await harness.writer.execute(createCommandEnvelope({ sessionId: harness.sessionId, producer: "test-authorizer" }), z.object({ queued: z.literal(true) }).strict(), () => ({
        drafts: [{ source: "APPLICATION", type: "DELIVERY_QUEUED", payload: { atom } }],
        result: { queued: true }
      }));
      await new DeliveryCoordinator(harness.writer).markStarted(deliveryId);
      const restarted = new SessionRuntimeRegistry(harness.store).get(harness.sessionId);
      await new DeliveryCoordinator(restarted).recoverUncertainDeliveries();
      expect(restarted.getState().deliveries[deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
      expect(restarted.getState().disclosureLedger).toContain(disclosureId);
    } finally {
      harness.store.close();
    }
  });

  it("treats renderer exposure before lost acknowledgement as possible and never duplicates display on retry", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const delivery = new DeliveryCoordinator(harness.writer);
      const command = await delivery.markStarted(atom.deliveryId);
      const renderer = new MockRenderer();
      await renderer.deliver(command);
      await renderer.deliver(command);
      expect(renderer.visibleDeliveryIds).toEqual([atom.deliveryId]);
      const restarted = new SessionRuntimeRegistry(harness.store).get(harness.sessionId);
      await new DeliveryCoordinator(restarted).recoverUncertainDeliveries();
      expect(restarted.getState().deliveries[atom.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    } finally {
      harness.store.close();
    }
  });

  it("preserves persisted exposure around restart and permits completion", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const delivery = new DeliveryCoordinator(harness.writer);
      await delivery.markStarted(atom.deliveryId);
      await delivery.acknowledgeExposed(atom.deliveryId);
      const restarted = new SessionRuntimeRegistry(harness.store).get(harness.sessionId);
      const recovered = await new DeliveryCoordinator(restarted).recoverUncertainDeliveries();
      expect(recovered).toEqual([]);
      await new DeliveryCoordinator(restarted).acknowledgeCompleted(atom.deliveryId);
      expect(restarted.getState().deliveries[atom.deliveryId]?.status).toBe("COMPLETED");
    } finally {
      harness.store.close();
    }
  });

  it("can cancel a generated hint while it is known not to be exposed", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      await new DeliveryCoordinator(harness.writer).cancelBeforeExposure(atom.deliveryId, "barge-in before renderer command");
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("CANCELLED");
    } finally {
      harness.store.close();
    }
  });
});

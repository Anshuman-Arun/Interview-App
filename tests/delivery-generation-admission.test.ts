import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DeliveryAtomSchema,
  GenerationBasisSchema,
  newDeliveryId,
  newGenerationId,
  newTurnId
} from "../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import { isGenerationBasisStillCompatible } from "../packages/events/src/index.js";
import { createCommandEnvelope } from "../packages/interview-engine/src/index.js";
import { authorizeSafeProbe, createCoreHarness } from "./harness.js";

describe("delivery generation admission", () => {
  it("cancels queued output immediately when its generation basis becomes stale", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      await harness.turns.commitBoardPatch("Board dependency changed before exposure");
      const generation = harness.writer.getState().generations[atom.generationId];
      if (generation === undefined) throw new Error("Missing generation fixture");
      expect(isGenerationBasisStillCompatible(generation.basis, harness.writer.getState())).toBe("INCOMPATIBLE");
      expect(generation.status).toBe("SUPERSEDED");
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("CANCELLED");

      const delivery = new DeliveryCoordinator(harness.writer);
      const eventCount = harness.store.eventCount(harness.sessionId);
      await expect(delivery.markStarted(atom.deliveryId)).rejects.toThrow(/queued delivery/u);
      const reconnected = await delivery.reconnect(atom.deliveryId, createCommandEnvelope({
        sessionId: harness.sessionId,
        producer: "stale-reconnect-test"
      }));
      expect(reconnected).toMatchObject({
        deliveryId: atom.deliveryId,
        status: "CANCELLED"
      });
      expect(reconnected.command).toBeUndefined();
      expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);
    } finally {
      harness.store.close();
    }
  });

  it("rejects UNKNOWN compatibility rather than delivering without turn provenance", async () => {
    const harness = await createCoreHarness();
    try {
      const state = harness.writer.getState();
      if (state.lastCommittedInputSequence === undefined) throw new Error("Missing committed input fixture");
      const generationId = newGenerationId();
      const deliveryId = newDeliveryId();
      const basis = GenerationBasisSchema.parse({
        contextEpoch: state.contextEpoch,
        committedInputSequence: state.lastCommittedInputSequence,
        transcriptRevision: state.transcriptRevision,
        boardRevision: state.boardRevision,
        problemStateRevision: state.problemStateRevision,
        policyRevision: state.policyRevision,
        turnId: newTurnId()
      });
      const atom = DeliveryAtomSchema.parse({
        deliveryId,
        generationId,
        content: { medium: "TEXT", text: "Must never be exposed" },
        disclosureIds: [],
        effectiveDisclosureLevel: 0,
        status: "VALIDATED"
      });
      await harness.writer.execute(
        createCommandEnvelope({ sessionId: harness.sessionId, producer: "unknown-basis-test" }),
        { operation: "QUEUE_UNKNOWN_BASIS_TEST_DELIVERY", payload: { deliveryId, generationId } },
        z.object({ queued: z.literal(true) }).strict(),
        () => ({
          drafts: [
            { source: "APPLICATION", type: "MODEL_GENERATION_STARTED", payload: { generationId, basis, provider: "test-provider" } },
            {
              source: "APPLICATION",
              type: "PROPOSAL_VALIDATED",
              payload: {
                generationId,
                analysis: {
                  status: "SAFE",
                  effectiveDisclosureLevel: 0,
                  effectiveDisclosureIds: [],
                  confidence: 1,
                  reason: "Synthetic admission fixture"
                }
              }
            },
            { source: "APPLICATION", type: "DELIVERY_QUEUED", payload: { atom } }
          ],
          result: { queued: true as const }
        })
      );
      expect(isGenerationBasisStillCompatible(basis, harness.writer.getState())).toBe("UNKNOWN");
      const eventCount = harness.store.eventCount(harness.sessionId);

      await expect(new DeliveryCoordinator(harness.writer).markStarted(deliveryId))
        .rejects.toThrow(/compatibility is UNKNOWN/u);
      expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);
      expect(harness.writer.getState().deliveries[deliveryId]?.status).toBe("QUEUED");
    } finally {
      harness.store.close();
    }
  });

  it("cancels queued atoms when their generation is explicitly superseded", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      await harness.turns.supersedeGeneration(atom.generationId, "Newer student input");
      expect(harness.writer.getState().generations[atom.generationId]?.status).toBe("SUPERSEDED");
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("CANCELLED");
      const eventCount = harness.store.eventCount(harness.sessionId);

      await expect(new DeliveryCoordinator(harness.writer).markStarted(atom.deliveryId))
        .rejects.toThrow(/queued delivery/u);
      expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);
    } finally {
      harness.store.close();
    }
  });
});

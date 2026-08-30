import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  CommandEnvelope,
  DeliveryId
} from "../../packages/domain/src/index.js";
import {
  createCommandEnvelope
} from "../../packages/interview-engine/src/index.js";
import {
  AdversarialFixture,
  createReferenceModel
} from "./fixtures.js";
import {
  ADVERSARIAL_PROPERTY_TIMEOUT_MS,
  deliveryScheduleArbitrary,
  propertyParameters,
  type DeliveryScheduleOperation
} from "./generators.js";
import { assertAlwaysOnInvariants } from "./invariants.js";
import type { AdversarialModel, ModelDeliveryState } from "./model.js";

const RENDERER_EXPOSED_PRIMARY = "renderer.exposed.primary";
const RENDERER_EXPOSED_DUPLICATE = "renderer.exposed.duplicate";
const RENDERER_COMPLETED_PRIMARY = "renderer.completed.primary";
const RENDERER_COMPLETED_DUPLICATE = "renderer.completed.duplicate";

describe("adversarial delivery schedules", () => {
  it("preserves conservative delivery state under acknowledgement, reconnect, barge-in, and restart schedules", async () => {
    await fc.assert(
      fc.asyncProperty(deliveryScheduleArbitrary, async (operations) => {
        const fixture = await AdversarialFixture.create();
        const model = createReferenceModel(fixture);

        try {
          const beforeQueue = fixture.writer.getState().sequence;
          const atom = await fixture.queueSyntheticDelivery();
          model.advanceSequenceBy(
            fixture.writer.getState().sequence - beforeQueue
          );
          model.noteDelivery(atom.deliveryId, "QUEUED");

          const exposedEnvelope = createCommandEnvelope({
            sessionId: fixture.sessionId,
            producer: "adversarial-renderer-exposed"
          });
          const completedEnvelope = createCommandEnvelope({
            sessionId: fixture.sessionId,
            producer: "adversarial-renderer-completed"
          });
          armRendererCallbacks(
            fixture,
            atom.deliveryId,
            exposedEnvelope,
            completedEnvelope
          );

          await assertAlwaysOnInvariants(fixture, model);

          for (const operation of operations) {
            const before = fixture.writer.getState().sequence;
            await executeDeliveryOperation(
              fixture,
              model,
              atom.deliveryId,
              operation
            );
            const after = fixture.writer.getState().sequence;
            model.advanceSequenceBy(after - before);
            await assertAlwaysOnInvariants(fixture, model);
          }
        } finally {
          await fixture.close();
        }
      }),
      propertyParameters("delivery", 2, 8)
    );
  }, ADVERSARIAL_PROPERTY_TIMEOUT_MS);
});

function armRendererCallbacks(
  fixture: AdversarialFixture,
  deliveryId: DeliveryId,
  exposedEnvelope: CommandEnvelope,
  completedEnvelope: CommandEnvelope
): void {
  const expose = () =>
    fixture.delivery.acknowledgeExposed(deliveryId, exposedEnvelope);
  const complete = () =>
    fixture.delivery.acknowledgeCompleted(deliveryId, completedEnvelope);

  fixture.scheduler.schedule(RENDERER_EXPOSED_PRIMARY, expose);
  fixture.scheduler.schedule(RENDERER_EXPOSED_DUPLICATE, expose);
  fixture.scheduler.schedule(RENDERER_COMPLETED_PRIMARY, complete);
  fixture.scheduler.schedule(RENDERER_COMPLETED_DUPLICATE, complete);
}

async function executeDeliveryOperation(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  deliveryId: DeliveryId,
  operation: DeliveryScheduleOperation
): Promise<void> {
  switch (operation) {
    case "START":
      await startDelivery(fixture, model, deliveryId);
      return;
    case "ACK_EXPOSED_PRIMARY":
      await releaseExposed(
        fixture,
        model,
        deliveryId,
        RENDERER_EXPOSED_PRIMARY
      );
      return;
    case "ACK_EXPOSED_DUPLICATE":
      await releaseExposed(
        fixture,
        model,
        deliveryId,
        RENDERER_EXPOSED_DUPLICATE
      );
      return;
    case "ACK_COMPLETED_PRIMARY":
      await releaseCompleted(
        fixture,
        model,
        deliveryId,
        RENDERER_COMPLETED_PRIMARY
      );
      return;
    case "ACK_COMPLETED_DUPLICATE":
      await releaseCompleted(
        fixture,
        model,
        deliveryId,
        RENDERER_COMPLETED_DUPLICATE
      );
      return;
    case "CANCEL_BEFORE_EXPOSURE":
      await cancelBeforeExposure(fixture, model, deliveryId);
      return;
    case "RESTART": {
      const before = requireDeliveryState(model, deliveryId);
      await fixture.restart();
      await fixture.delivery.recoverUncertainDeliveries();
      if (before === "DELIVERING") {
        model.noteDelivery(deliveryId, "POSSIBLY_EXPOSED");
      }
      return;
    }
    case "RECONNECT": {
      const before = requireDeliveryState(model, deliveryId);
      const reconnected = await fixture.delivery.reconnect(
        deliveryId,
        createCommandEnvelope({
          sessionId: fixture.sessionId,
          producer: "adversarial-reconnect"
        })
      );
      expect(reconnected.status).toBe(
        before === "QUEUED" ? "DELIVERING" : before
      );
      if (before === "QUEUED") {
        model.noteDelivery(deliveryId, "DELIVERING");
      }
      return;
    }
    case "BARGE_IN": {
      const before = requireDeliveryState(model, deliveryId);
      await fixture.turns.beginUtterance();
      if (before === "QUEUED") {
        model.noteDelivery(deliveryId, "CANCELLED");
      } else if (before === "DELIVERING") {
        model.noteDelivery(deliveryId, "POSSIBLY_EXPOSED");
      }
      if (model.generations.get(fixture.initialGenerationId) === "ACTIVE") {
        model.noteGeneration(fixture.initialGenerationId, "SUPERSEDED");
      }
      return;
    }
  }
}

async function startDelivery(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  deliveryId: DeliveryId
): Promise<void> {
  const status = requireDeliveryState(model, deliveryId);
  if (status === "QUEUED") {
    await fixture.delivery.markStarted(deliveryId);
    model.noteDelivery(deliveryId, "DELIVERING");
    return;
  }
  await expect(fixture.delivery.markStarted(deliveryId)).rejects.toThrow(
    /queued delivery/u
  );
}

async function releaseExposed(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  deliveryId: DeliveryId,
  label: string
): Promise<void> {
  const status = requireDeliveryState(model, deliveryId);
  if (status === "DELIVERING") {
    await fixture.release(label);
    model.noteDelivery(deliveryId, "EXPOSED");
    return;
  }
  if (status === "EXPOSED" || status === "COMPLETED") {
    await fixture.release(label);
    return;
  }
  await expect(fixture.release(label)).rejects.toThrow();
}

async function releaseCompleted(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  deliveryId: DeliveryId,
  label: string
): Promise<void> {
  const status = requireDeliveryState(model, deliveryId);
  if (status === "EXPOSED") {
    await fixture.release(label);
    model.noteDelivery(deliveryId, "COMPLETED");
    return;
  }
  if (status === "COMPLETED") {
    await fixture.release(label);
    return;
  }
  await expect(fixture.release(label)).rejects.toThrow();
}

async function cancelBeforeExposure(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  deliveryId: DeliveryId
): Promise<void> {
  const status = requireDeliveryState(model, deliveryId);
  if (status === "QUEUED") {
    await fixture.delivery.cancelBeforeExposure(
      deliveryId,
      "adversarial cancel before exposure"
    );
    model.noteDelivery(deliveryId, "CANCELLED");
    return;
  }
  await expect(
    fixture.delivery.cancelBeforeExposure(
      deliveryId,
      "late adversarial cancellation"
    )
  ).rejects.toThrow();
}

function requireDeliveryState(
  model: AdversarialModel,
  deliveryId: DeliveryId
): Exclude<ModelDeliveryState, "GENERATED"> {
  const status = model.deliveries.get(deliveryId);
  if (status === undefined || status === "GENERATED") {
    throw new Error("Reference model is missing delivery state");
  }
  return status;
}

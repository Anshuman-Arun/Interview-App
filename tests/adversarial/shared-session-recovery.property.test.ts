import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DeliveryId } from "../../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../../packages/delivery/src/index.js";
import { replaySession } from "../../packages/events/src/index.js";
import {
  createCommandEnvelope
} from "../../packages/interview-engine/src/index.js";
import {
  SessionRecoveryCoordinator
} from "../../apps/server/src/index.js";
import { DeterministicScheduler } from "./deterministic-scheduler.js";
import { AdversarialFixture } from "./fixtures.js";
import {
  ADVERSARIAL_PROPERTY_TIMEOUT_MS,
  propertyParameters,
  recoveryScheduleArbitrary,
  type RecoveryScheduleOperation
} from "./generators.js";

const LABELS: Readonly<Record<RecoveryScheduleOperation, string>> = {
  COMMAND_RECOVERY: "recovery.command-first-use",
  RENDERER_RECOVERY: "recovery.renderer-first-use",
  SHARED_DUPLICATE_RECOVERY: "recovery.shared-duplicate",
  INDEPENDENT_DUPLICATE_RECOVERY: "recovery.independent-duplicate"
};

describe("adversarial shared session recovery schedules", () => {
  it("coalesces overlapping recovery callers into one conservative recovery event", async () => {
    await fc.assert(
      fc.asyncProperty(recoveryScheduleArbitrary, async (operations) => {
        const fixture = await AdversarialFixture.create();
        const scheduler = new DeterministicScheduler();

        try {
          const atom = await fixture.queueSyntheticDelivery();
          await fixture.delivery.markStarted(atom.deliveryId);
          expect(
            fixture.writer.getState().deliveries[atom.deliveryId]?.status
          ).toBe("DELIVERING");

          await fixture.restart();

          const shared = new SessionRecoveryCoordinator(fixture.registry);
          const independent = new SessionRecoveryCoordinator(fixture.registry);

          scheduler.schedule(
            LABELS.COMMAND_RECOVERY,
            () => shared.ensureRecovered(fixture.sessionId)
          );
          scheduler.schedule(
            LABELS.RENDERER_RECOVERY,
            () => shared.ensureRecovered(fixture.sessionId)
          );
          scheduler.schedule(
            LABELS.SHARED_DUPLICATE_RECOVERY,
            () => shared.ensureRecovered(fixture.sessionId)
          );
          scheduler.schedule(
            LABELS.INDEPENDENT_DUPLICATE_RECOVERY,
            () => independent.ensureRecovered(fixture.sessionId)
          );

          for (const operation of operations) {
            scheduler.release(LABELS[operation]);
          }

          const results = await Promise.all(
            operations.map(async (operation) =>
              scheduler.settle<readonly DeliveryId[]>(LABELS[operation])
            )
          );
          for (const result of results) {
            expect(result).toContain(atom.deliveryId);
          }

          const events = fixture.store.load(fixture.sessionId);
          const recoveryEvents = events.filter(
            (event) => event.type === "DELIVERY_POSSIBLY_EXPOSED"
          );
          expect(recoveryEvents).toHaveLength(1);
          expect(recoveryEvents[0]?.payload.deliveryId).toBe(atom.deliveryId);

          const writer = shared.getWriter(fixture.sessionId);
          expect(writer.getState().deliveries[atom.deliveryId]?.status).toBe(
            "POSSIBLY_EXPOSED"
          );

          const reconnect = await new DeliveryCoordinator(writer).reconnect(
            atom.deliveryId,
            createCommandEnvelope({
              sessionId: fixture.sessionId,
              producer: "adversarial-shared-recovery-reconnect"
            })
          );
          expect(reconnect).toEqual({
            deliveryId: atom.deliveryId,
            status: "POSSIBLY_EXPOSED"
          });

          await shared.ensureRecovered(fixture.sessionId);
          expect(
            fixture.store.load(fixture.sessionId).filter(
              (event) => event.type === "DELIVERY_POSSIBLY_EXPOSED"
            )
          ).toHaveLength(1);

          expect(
            replaySession(
              fixture.sessionId,
              fixture.store.load(fixture.sessionId)
            )
          ).toEqual(writer.getState());
        } finally {
          await scheduler.cancelPendingAndDrain();
          await fixture.close();
        }
      }),
      propertyParameters("shared-recovery", 4, 8)
    );
  }, ADVERSARIAL_PROPERTY_TIMEOUT_MS);
});

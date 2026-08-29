import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import { replaySession } from "../packages/events/src/index.js";
import { SessionRuntimeRegistry, TurnCoordinator } from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { authorizeSafeProbe, createCoreHarness, providerEnvelope } from "./harness.js";

describe("file-backed restart and crash recovery", () => {
  it("reconstructs an in-flight delivery and conservatively records possible exposure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-app-restart-"));
    const databasePath = join(directory, "events.sqlite");
    let store = new SqliteEventStore(databasePath);
    try {
      const harness = await createCoreHarness(store);
      const atom = await authorizeSafeProbe(harness);
      await new DeliveryCoordinator(harness.writer).markStarted(atom.deliveryId);
      const sessionId = harness.sessionId;
      store.close();

      store = new SqliteEventStore(databasePath);
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const recovered = await new DeliveryCoordinator(writer).recoverUncertainDeliveries();
      const events = store.load(sessionId);
      expect(recovered).toEqual([atom.deliveryId]);
      expect(writer.getState().deliveries[atom.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
      expect(replaySession(sessionId, events)).toEqual(writer.getState());
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns the original provider result after the database is closed and reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-app-idempotency-"));
    const databasePath = join(directory, "events.sqlite");
    let store = new SqliteEventStore(databasePath);
    try {
      const harness = await createCoreHarness(store);
      const envelope = providerEnvelope(harness);
      const atom = await authorizeSafeProbe(harness, envelope);
      const sessionId = harness.sessionId;
      const count = store.eventCount(sessionId);
      store.close();

      store = new SqliteEventStore(databasePath);
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const duplicate = await new TurnCoordinator(writer).processProposal({
        envelope,
        problem: sixPeopleProblem,
        proposal: { realizedAction: "PROBE_JUSTIFICATION", claimedDisclosureLevel: 0, claimedDisclosureIds: [], speechText: harness.safeProbe },
        validator: harness.validator
      });
      expect(duplicate.accepted).toBe(true);
      expect(duplicate.deliveryAtoms[0]?.deliveryId).toBe(atom.deliveryId);
      expect(store.eventCount(sessionId)).toBe(count);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});


import { expect } from "vitest";
import {
  isDisclosedStatus,
  type DeliveryId,
  type RequestId
} from "../../packages/domain/src/index.js";
import {
  SessionEventSchema,
  replaySession
} from "../../packages/events/src/index.js";
import {
  SessionRuntimeRegistry,
  isGenerationBasisStillCompatible
} from "../../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../../packages/persistence/src/index.js";
import { ADVERSARIAL_SECRET, type AdversarialFixture } from "./fixtures.js";
import type {
  AdversarialModel,
  ModelDeliveryState,
  ModelGenerationState,
  ModelRequestState
} from "./model.js";

const DELIVERY_MODEL_TO_STATE: Readonly<Record<
  Exclude<ModelDeliveryState, "GENERATED">,
  "QUEUED" | "DELIVERING" | "EXPOSED" | "COMPLETED" | "CANCELLED" | "POSSIBLY_EXPOSED"
>> = {
  QUEUED: "QUEUED",
  DELIVERING: "DELIVERING",
  EXPOSED: "EXPOSED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  POSSIBLY_EXPOSED: "POSSIBLY_EXPOSED"
};

export async function assertAlwaysOnInvariants(
  fixture: AdversarialFixture,
  model: AdversarialModel
): Promise<void> {
  const events = fixture.store.load(fixture.sessionId);
  for (const [index, event] of events.entries()) {
    expect(SessionEventSchema.parse(event)).toEqual(event);
    expect(event.sequence).toBe(index + 1);
  }

  const live = fixture.writer.getState();
  expect(live.sequence).toBe(events.length);
  expect(live.sequence).toBe(model.expectedSequence);
  expect(live.eventIds).toHaveLength(events.length);

  const replayed = replaySession(fixture.sessionId, events);
  expect(replayed).toEqual(live);

  const freshStore = new SqliteEventStore(fixture.databasePath);
  try {
    const freshWriter = new SessionRuntimeRegistry(freshStore).get(fixture.sessionId);
    expect(freshWriter.getState()).toEqual(replayed);
  } finally {
    freshStore.close();
  }

  expect(live.contextEpoch).toBe(model.contextEpoch);
  expect(live.transcriptRevision).toBe(model.transcriptRevision);
  expect(live.boardRevision).toBe(model.boardRevision);
  expect(live.inputEpisodes[model.currentInputEpisodeId]?.status).toBe("COMMITTED");
  expect(live.turns[model.currentTurnId]?.inputEpisodeId).toBe(
    model.currentInputEpisodeId
  );

  for (const [generationId, expected] of model.generations) {
    const expectedStatus: ModelGenerationState = expected;
    expect(live.generations[generationId]?.status).toBe(expectedStatus);
  }

  assertRequestStates(
    model.workerRequests,
    live.localComputeRequests
  );
  assertRequestStates(
    model.verifierRequests,
    live.verificationRequests
  );
  assertRequestStates(
    model.visionRequests,
    live.visionRequests
  );

  for (const [deliveryId, expected] of model.deliveries) {
    if (expected === "GENERATED") continue;
    expect(live.deliveries[deliveryId]?.status).toBe(
      DELIVERY_MODEL_TO_STATE[expected]
    );
  }

  for (const atom of Object.values(live.deliveries)) {
    if (isDisclosedStatus(atom.status)) {
      for (const disclosureId of atom.disclosureIds) {
        expect(live.disclosureLedger).toContain(disclosureId);
      }
    }

    if (atom.status === "EXPOSED" || atom.status === "COMPLETED" || atom.status === "POSSIBLY_EXPOSED") {
      const generation = live.generations[atom.generationId];
      const action = generation?.pedagogicalAction;
      if (action !== undefined) {
        expect(atom.effectiveDisclosureLevel).toBeLessThanOrEqual(
          action.maximumDisclosure
        );
      }
    }
  }

  for (const [key, history] of Object.entries(live.evidenceHistory)) {
    const active = history.filter((record) => record.status === "ACTIVE");
    expect(active.length).toBeLessThanOrEqual(1);
    expect(live.studentEvidence[key]).toEqual(active[0]?.value);
  }

  for (const [key, expectedValue] of model.activeEvidence) {
    expect(live.studentEvidence[key]?.value).toBe(expectedValue);
  }

  assertNoSecretPersistence(fixture, model);
}

export function assertDeliveryStartCompatibility(
  fixture: AdversarialFixture,
  deliveryId: DeliveryId
): void {
  const state = fixture.writer.getState();
  const atom = state.deliveries[deliveryId];
  if (atom === undefined) throw new Error("Delivery is missing from authoritative state");
  const generation = state.generations[atom.generationId];
  if (generation === undefined) return;
  expect(
    isGenerationBasisStillCompatible(generation.basis, state),
    "A delivery must not begin after its generation basis becomes stale or unknown"
  ).toBe("COMPATIBLE");
  expect(generation.status).not.toBe("SUPERSEDED");
}

export function assertNoSecretPersistence(
  fixture: AdversarialFixture,
  model: AdversarialModel
): void {
  expect(JSON.stringify(fixture.store.load(fixture.sessionId))).not.toContain(
    ADVERSARIAL_SECRET
  );

  const requestIds = new Set<RequestId>([
    fixture.providerEnvelope.requestId,
    fixture.visionEnvelope.requestId,
    fixture.workerEnvelope.requestId,
    fixture.verifierEnvelope.requestId,
    ...model.requestFingerprints.keys()
  ]);

  for (const requestId of requestIds) {
    const processed = fixture.store.getProcessedResult(
      fixture.sessionId,
      requestId
    );
    if (processed.found) {
      expect(JSON.stringify(processed.result)).not.toContain(
        ADVERSARIAL_SECRET
      );
    }
  }
}

function assertRequestStates<TRequest extends { readonly status: string }>(
  expected: ReadonlyMap<RequestId, ModelRequestState>,
  actual: Readonly<Record<string, TRequest>>
): void {
  for (const [requestId, expectedStatus] of expected) {
    expect(actual[requestId]?.status).toBe(expectedStatus);
  }
}

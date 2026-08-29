import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  BillingVerification,
  ModelCapabilities,
  ProviderPolicy
} from "../../packages/domain/src/index.js";
import {
  isGenerationBasisStillCompatible
} from "../../packages/interview-engine/src/index.js";
import {
  ProviderPolicyError,
  assertProviderPermitted
} from "../../packages/providers/src/index.js";
import {
  ADVERSARIAL_SECRET,
  CALLBACK_LABELS,
  MILESTONE_EVIDENCE_KEY,
  AdversarialFixture,
  createReferenceModel,
  type ProviderCallbackResult
} from "./fixtures.js";
import {
  coreScheduleArbitrary,
  propertyParameters,
  type CoreScheduleOperation
} from "./generators.js";
import { assertAlwaysOnInvariants } from "./invariants.js";
import type { AdversarialModel } from "./model.js";

describe("adversarial core schedules", () => {
  it("preserves authority, compatibility, disclosure, and billing invariants under generated release order", async () => {
    await fc.assert(
      fc.asyncProperty(coreScheduleArbitrary, async (operations) => {
        const fixture = await AdversarialFixture.create();
        const model = createReferenceModel(fixture);

        try {
          await assertAlwaysOnInvariants(fixture, model);
          for (const operation of operations) {
            const before = fixture.writer.getState().sequence;
            await executeCoreOperation(fixture, model, operation);
            const after = fixture.writer.getState().sequence;
            model.advanceSequenceBy(after - before);
            await assertAlwaysOnInvariants(fixture, model);
          }
        } finally {
          await fixture.close();
        }
      }),
      propertyParameters("core", 0, 12)
    );
  });
});

async function executeCoreOperation(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  operation: CoreScheduleOperation
): Promise<void> {
  switch (operation) {
    case "RELEASE_PROVIDER_PRIMARY":
      await releaseProvider(fixture, model, CALLBACK_LABELS.providerPrimary);
      return;
    case "RELEASE_PROVIDER_DUPLICATE":
      await releaseProvider(fixture, model, CALLBACK_LABELS.providerDuplicate);
      return;
    case "RELEASE_VISION_PRIMARY":
      await releaseVision(fixture, model, CALLBACK_LABELS.visionPrimary);
      return;
    case "RELEASE_VISION_DUPLICATE":
      await releaseVision(fixture, model, CALLBACK_LABELS.visionDuplicate);
      return;
    case "BOARD_REVISION":
      await fixture.turns.commitBoardPatch("adversarial board revision");
      model.noteBoardRevision();
      return;
    case "TYPED_INPUT_COMMIT": {
      const committed = await fixture.turns.commitInput(
        "A later typed commitment changes the authoritative response basis."
      );
      model.noteCommittedInput(committed.inputEpisodeId, committed.turnId);
      return;
    }
    case "TRANSCRIPT_CORRECTION":
      await fixture.turns.correctTranscript("adversarial corrected transcript");
      model.noteTranscriptCorrection();
      return;
    case "SUPERSEDE_GENERATION":
      await supersedeInitialGeneration(fixture, model);
      return;
    case "PROVIDER_SWITCH": {
      if (model.generations.get(fixture.initialGenerationId) === "ACTIVE") {
        await fixture.turns.supersedeGeneration(
          fixture.initialGenerationId,
          "adversarial provider switch"
        );
        model.noteGeneration(fixture.initialGenerationId, "SUPERSEDED");
      }
      const replacement = await fixture.startReplacementGeneration();
      model.noteGeneration(replacement, "ACTIVE");
      return;
    }
    case "EVIDENCE_UPDATE": {
      const committed = await fixture.proposeEvidence("PROGRESSING");
      expect(committed).toBe(true);
      model.noteEvidence(MILESTONE_EVIDENCE_KEY, "PROGRESSING");
      return;
    }
    case "START_QUEUED_DELIVERY": {
      const deliveryId = fixture.queuedDeliveryIds()[0];
      if (deliveryId === undefined) return;
      const state = fixture.writer.getState();
      const atom = state.deliveries[deliveryId];
      if (atom === undefined) throw new Error("Queued delivery disappeared");
      const generation = state.generations[atom.generationId];
      const compatibility = generation === undefined
        ? undefined
        : isGenerationBasisStillCompatible(generation.basis, state);
      const canStart =
        generation !== undefined
        && generation.status !== "SUPERSEDED"
        && generation.status !== "REJECTED"
        && compatibility === "COMPATIBLE";

      if (!canStart) {
        const eventCount = fixture.store.eventCount(fixture.sessionId);
        await expect(
          fixture.delivery.markStarted(deliveryId)
        ).rejects.toThrow(/generation|compatibility|provenance/iu);
        expect(fixture.store.eventCount(fixture.sessionId)).toBe(eventCount);
        expect(
          fixture.writer.getState().deliveries[deliveryId]?.status
        ).toBe("QUEUED");
        return;
      }

      await fixture.delivery.markStarted(deliveryId);
      model.noteDelivery(deliveryId, "DELIVERING");
      expect(compatibility).toBe("COMPATIBLE");
      expect(generation.status).not.toBe("SUPERSEDED");
      expect(generation.status).not.toBe("REJECTED");
      return;
    }
    case "BILLING_CURRENT":
      expect(() => runBillingCheck("CURRENT")).not.toThrow();
      return;
    case "BILLING_MISSING":
      expectPolicyFailure(() => runBillingCheck("MISSING"), "MISSING_BILLING_VERIFICATION");
      return;
    case "BILLING_STALE":
      expectPolicyFailure(() => runBillingCheck("STALE"), "VERIFICATION_STALE");
      return;
    case "BILLING_FUTURE":
      expectPolicyFailure(() => runBillingCheck("FUTURE"), "VERIFICATION_FUTURE");
      return;
    case "BILLING_MALFORMED":
      expectPolicyFailure(() => runBillingCheck("MALFORMED"), "INVALID_BILLING_VERIFICATION");
      return;
  }
}

async function releaseProvider(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  label: string
): Promise<void> {
  const result = await fixture.release<ProviderCallbackResult>(label);
  if (result.accepted) {
    model.noteGeneration(fixture.initialGenerationId, "VALIDATED");
    for (const atom of result.deliveryAtoms) {
      model.noteDelivery(atom.deliveryId, "QUEUED");
    }
    return;
  }

  if (result.reason?.includes("compatibility") === true) {
    model.noteGeneration(fixture.initialGenerationId, "SUPERSEDED");
  }
}

async function releaseVision(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  label: string
): Promise<void> {
  const result = await fixture.release<{ readonly accepted: boolean }>(label);
  if (model.visionRequests.get(fixture.visionRequestId) !== "PENDING") return;
  model.noteRequest(
    "vision",
    fixture.visionRequestId,
    result.accepted ? "ACCEPTED" : "DISCARDED"
  );
}

async function supersedeInitialGeneration(
  fixture: AdversarialFixture,
  model: AdversarialModel
): Promise<void> {
  const status = model.generations.get(fixture.initialGenerationId);
  if (
    status === "ACTIVE"
    || status === "PROPOSAL_RECEIVED"
    || status === "VALIDATED"
    || status === "SUPERSEDED"
  ) {
    await fixture.turns.supersedeGeneration(
      fixture.initialGenerationId,
      "adversarial cancellation"
    );
    model.noteGeneration(fixture.initialGenerationId, "SUPERSEDED");
    return;
  }

  await expect(
    fixture.turns.supersedeGeneration(
      fixture.initialGenerationId,
      "late adversarial cancellation"
    )
  ).rejects.toThrow(/Cannot supersede/u);
}

const CAPABILITIES: ModelCapabilities = {
  inputModalities: new Set(["text"]),
  textStreaming: false,
  structuredOutput: "FINAL_ONLY",
  persistentSession: false,
  resumableSession: false,
  cancellation: "DROP_OUTPUT",
  sessionSurvivesClientAbort: false,
  sessionSurvivesProviderCancel: false,
  usageReporting: false,
  dataUse: "LOCAL_ONLY"
};

const POLICY: ProviderPolicy = {
  allowMeteredUsage: false,
  maximumDataUse: "LOCAL_ONLY",
  billingVerificationMaxAgeMs: 1_000
};

const ADAPTER_VERSION = "adversarial-adapter@1";

function runBillingCheck(
  variant: "CURRENT" | "MISSING" | "STALE" | "FUTURE" | "MALFORMED"
): void {
  const now = new Date("2026-08-29T20:00:00.500Z");
  const base: BillingVerification = {
    billingClass: "VERIFIED_FREE_ONLY",
    enforcementMechanism: "technical no-spend fixture",
    verifiedAt: "2026-08-29T20:00:00.000Z",
    adapterVersion: ADAPTER_VERSION,
    spendImpossible: true
  };
  const billingVerification =
    variant === "MISSING"
      ? undefined
      : variant === "STALE"
        ? { ...base, verifiedAt: "2026-08-29T19:59:58.000Z" }
        : variant === "FUTURE"
          ? { ...base, verifiedAt: "2026-08-29T20:00:01.000Z" }
          : variant === "MALFORMED"
            ? {
                ...base,
                verifiedAt: "not-an-iso-date",
                enforcementMechanism: ADVERSARIAL_SECRET
              }
            : base;

  assertProviderPermitted({
    policy: POLICY,
    capabilities: CAPABILITIES,
    adapterVersion: ADAPTER_VERSION,
    now,
    ...(billingVerification === undefined ? {} : { billingVerification })
  });
}

function expectPolicyFailure(
  operation: () => void,
  code: ProviderPolicyError["code"]
): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProviderPolicyError);
  if (!(caught instanceof ProviderPolicyError)) {
    throw new Error("Expected ProviderPolicyError");
  }
  expect(caught.code).toBe(code);
  expect(String(caught)).not.toContain(ADVERSARIAL_SECRET);
}

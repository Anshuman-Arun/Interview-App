import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CLAIM_EVIDENCE_KEY,
  CALLBACK_LABELS,
  MILESTONE_EVIDENCE_KEY,
  AdversarialFixture,
  createReferenceModel
} from "./fixtures.js";
import {
  ADVERSARIAL_PROPERTY_TIMEOUT_MS,
  propertyParameters,
  restartScheduleArbitrary,
  type RestartScheduleOperation
} from "./generators.js";
import { assertAlwaysOnInvariants } from "./invariants.js";
import type { AdversarialModel } from "./model.js";

describe("adversarial restart and replay schedules", () => {
  it("rebuilds evidence and pending callback authority identically across randomized restarts", async () => {
    await fc.assert(
      fc.asyncProperty(restartScheduleArbitrary, async (operations) => {
        const fixture = await AdversarialFixture.create();
        const model = createReferenceModel(fixture);

        try {
          await assertAlwaysOnInvariants(fixture, model);
          for (const operation of operations) {
            const before = fixture.writer.getState().sequence;
            await executeRestartOperation(fixture, model, operation);
            const after = fixture.writer.getState().sequence;
            model.advanceSequenceBy(after - before);
            await assertAlwaysOnInvariants(fixture, model);
          }
        } finally {
          await fixture.close();
        }
      }),
      propertyParameters("restart", 3, 6)
    );
  }, ADVERSARIAL_PROPERTY_TIMEOUT_MS);
});

async function executeRestartOperation(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  operation: RestartScheduleOperation
): Promise<void> {
  switch (operation) {
    case "EVIDENCE_PROGRESSING": {
      const committed = await fixture.proposeEvidence("PROGRESSING");
      expect(committed).toBe(true);
      model.noteEvidence(MILESTONE_EVIDENCE_KEY, "PROGRESSING");
      model.notePolicyOutputInvalidation();
      return;
    }
    case "EVIDENCE_COMPLETE": {
      const committed = await fixture.proposeEvidence("COMPLETE");
      expect(committed).toBe(true);
      model.noteEvidence(MILESTONE_EVIDENCE_KEY, "COMPLETE");
      model.notePolicyOutputInvalidation();
      return;
    }
    case "TRANSCRIPT_CORRECTION":
      await fixture.turns.correctTranscript(
        "restart schedule corrected transcript"
      );
      model.noteTranscriptCorrection();
      model.notePolicyOutputInvalidation();
      return;
    case "RESTART":
      await fixture.restart();
      return;
    case "RELEASE_WORKER_PRIMARY":
      await releaseWorker(fixture, model, CALLBACK_LABELS.workerPrimary);
      return;
    case "RELEASE_WORKER_DUPLICATE":
      await releaseWorker(fixture, model, CALLBACK_LABELS.workerDuplicate);
      return;
    case "RELEASE_VERIFIER_PRIMARY":
      await releaseVerifier(fixture, model, CALLBACK_LABELS.verifierPrimary);
      return;
    case "RELEASE_VERIFIER_DUPLICATE":
      await releaseVerifier(fixture, model, CALLBACK_LABELS.verifierDuplicate);
      return;
  }
}

async function releaseWorker(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  label: string
): Promise<void> {
  const result = await fixture.release<{
    readonly value: {
      readonly accepted: boolean;
      readonly reason?: string;
    };
  }>(label);

  if (model.workerRequests.get(fixture.workerRequestId) !== "PENDING") return;
  if (result.value.accepted) {
    model.noteRequest("worker", fixture.workerRequestId, "ACCEPTED");
  } else if (result.value.reason !== "REQUEST_NOT_PENDING") {
    model.noteRequest("worker", fixture.workerRequestId, "DISCARDED");
  }
}

async function releaseVerifier(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  label: string
): Promise<void> {
  const result = await fixture.release<{
    readonly value:
      | {
          readonly accepted: true;
          readonly evidenceCommitted: boolean;
        }
      | {
          readonly accepted: false;
          readonly reason: string;
        };
  }>(label);

  if (
    model.verifierRequests.get(
      fixture.verificationWork.verificationRequestId
    ) !== "PENDING"
  ) {
    return;
  }

  if (result.value.accepted) {
    model.noteRequest(
      "verifier",
      fixture.verificationWork.verificationRequestId,
      "ACCEPTED"
    );
    if (result.value.evidenceCommitted) {
      model.noteEvidence(CLAIM_EVIDENCE_KEY, "CORRECT");
    }
    model.notePolicyOutputInvalidation();
  } else if (result.value.reason !== "REQUEST_NOT_PENDING") {
    model.noteRequest(
      "verifier",
      fixture.verificationWork.verificationRequestId,
      "DISCARDED"
    );
  }
}

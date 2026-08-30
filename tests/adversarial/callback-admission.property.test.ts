import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { newRequestId, type RequestId } from "../../packages/domain/src/index.js";
import {
  createCommandEnvelope
} from "../../packages/interview-engine/src/index.js";
import { AbstainingVerifier } from "../../packages/verification/src/index.js";
import {
  CALLBACK_LABELS,
  AdversarialFixture,
  createReferenceModel
} from "./fixtures.js";
import {
  ADVERSARIAL_PROPERTY_TIMEOUT_MS,
  callbackScheduleArbitrary,
  propertyParameters,
  type CallbackScheduleOperation
} from "./generators.js";
import { assertAlwaysOnInvariants } from "./invariants.js";
import type { AdversarialModel, ModelRequestState } from "./model.js";

interface AdmissionResult {
  readonly value: {
    readonly accepted: boolean;
    readonly reason?: string;
  };
}

describe("adversarial callback admission schedules", () => {
  it("keeps worker and verifier callbacks subordinate to current authoritative state", async () => {
    await fc.assert(
      fc.asyncProperty(callbackScheduleArbitrary, async (operations) => {
        const fixture = await AdversarialFixture.create();
        const model = createReferenceModel(fixture);

        try {
          await assertAlwaysOnInvariants(fixture, model);
          for (const operation of operations) {
            const before = fixture.writer.getState().sequence;
            await executeCallbackOperation(fixture, model, operation);
            const after = fixture.writer.getState().sequence;
            model.advanceSequenceBy(after - before);
            await assertAlwaysOnInvariants(fixture, model);
          }
        } finally {
          await fixture.close();
        }
      }),
      propertyParameters("callbacks", 1, 10)
    );
  }, ADVERSARIAL_PROPERTY_TIMEOUT_MS);
});

async function executeCallbackOperation(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  operation: CallbackScheduleOperation
): Promise<void> {
  switch (operation) {
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
    case "TRANSCRIPT_CORRECTION":
      await fixture.turns.correctTranscript("callback schedule transcript correction");
      model.noteTranscriptCorrection();
      return;
    case "BOARD_REVISION":
      await fixture.turns.commitBoardPatch("callback schedule board revision");
      model.noteBoardRevision();
      return;
    case "RESTART":
      await fixture.restart();
      return;
    case "WORKER_TAMPERED":
      await processTamperedWorker(fixture, model);
      return;
    case "WORKER_MISCORRELATED":
      await processMiscorrelatedWorker(fixture);
      return;
    case "VERIFIER_TAMPERED":
      await processTamperedVerifier(fixture, model);
      return;
    case "VERIFIER_SWITCHED":
      await processSwitchedVerifier(fixture, model);
      return;
    case "VERIFIER_MALFORMED":
      await processMalformedVerifier(fixture);
      return;
  }
}

async function releaseWorker(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  label: string
): Promise<void> {
  const result = await fixture.release<AdmissionResult>(label);
  updateRequestFromAdmission(
    model,
    "worker",
    fixture.workerRequestId,
    result.value
  );
}

async function releaseVerifier(
  fixture: AdversarialFixture,
  model: AdversarialModel,
  label: string
): Promise<void> {
  const result = await fixture.release<AdmissionResult>(label);
  updateRequestFromAdmission(
    model,
    "verifier",
    fixture.verificationWork.verificationRequestId,
    result.value
  );

}

async function processTamperedWorker(
  fixture: AdversarialFixture,
  model: AdversarialModel
): Promise<void> {
  const sourceRevision = fixture.workerEnvelope.sourceRevision;
  if (sourceRevision === undefined) {
    throw new Error("Worker fixture is missing source revision");
  }
  const result = await fixture.localCompute.processResult({
    envelope: createCommandEnvelope({
      sessionId: fixture.sessionId,
      producer: "adversarial-worker-tampered",
      correlationId: fixture.workerRequestId,
      sourceRevision
    }),
    response: {
      protocolVersion: 1,
      requestId: fixture.workerRequestId,
      type: "TRANSCRIPT_ANALYSIS_RESULT",
      sourceRevision,
      normalizedText: "tampered output",
      tokenCount: 2
    }
  });
  updateRequestFromAdmission(
    model,
    "worker",
    fixture.workerRequestId,
    result.value
  );
}

async function processMiscorrelatedWorker(
  fixture: AdversarialFixture
): Promise<void> {
  const sourceRevision = fixture.workerEnvelope.sourceRevision;
  if (sourceRevision === undefined) {
    throw new Error("Worker fixture is missing source revision");
  }
  expect(() => fixture.localCompute.processResult({
    envelope: createCommandEnvelope({
      sessionId: fixture.sessionId,
      producer: "adversarial-worker-miscorrelated",
      correlationId: newRequestId(),
      sourceRevision
    }),
    response: {
      protocolVersion: 1,
      requestId: fixture.workerRequestId,
      type: "TRANSCRIPT_ANALYSIS_RESULT",
      sourceRevision,
      normalizedText: "I would prove both cases.",
      tokenCount: 5
    }
  })).toThrow("does not match callback correlationId");
}

async function processTamperedVerifier(
  fixture: AdversarialFixture,
  model: AdversarialModel
): Promise<void> {
  const valid = await fixture.verifier.verify(
    fixture.verificationWork.candidateFormalInterpretation,
    fixture.verificationWork.interpretationConfidence
  );
  const result = await fixture.verification.processResult({
    envelope: verifierEnvelope(fixture, "adversarial-verifier-tampered"),
    result: {
      ...valid,
      status: "CONTRADICTED",
      reason: "tampered supplied result"
    },
    verifier: fixture.verifier
  });
  updateRequestFromAdmission(
    model,
    "verifier",
    fixture.verificationWork.verificationRequestId,
    result.value
  );
}

async function processSwitchedVerifier(
  fixture: AdversarialFixture,
  model: AdversarialModel
): Promise<void> {
  const verifier = new AbstainingVerifier();
  const supplied = await verifier.verify(
    fixture.verificationWork.candidateFormalInterpretation,
    fixture.verificationWork.interpretationConfidence
  );
  const result = await fixture.verification.processResult({
    envelope: verifierEnvelope(fixture, "adversarial-verifier-switched"),
    result: supplied,
    verifier
  });
  updateRequestFromAdmission(
    model,
    "verifier",
    fixture.verificationWork.verificationRequestId,
    result.value
  );
}

async function processMalformedVerifier(
  fixture: AdversarialFixture
): Promise<void> {
  const before = fixture.store.eventCount(fixture.sessionId);
  await expect(
    fixture.verification.processResult({
      envelope: verifierEnvelope(fixture, "adversarial-verifier-malformed"),
      result: {
        status: "VERIFIED",
        arbitrary: true
      },
      verifier: fixture.verifier
    })
  ).rejects.toThrow();
  expect(fixture.store.eventCount(fixture.sessionId)).toBe(before);
}

function verifierEnvelope(
  fixture: AdversarialFixture,
  producer: string
) {
  return createCommandEnvelope({
    sessionId: fixture.sessionId,
    producer,
    correlationId: fixture.verificationWork.verificationRequestId,
    inputEpisodeId: fixture.inputEpisodeId,
    turnId: fixture.turnId,
    contextEpoch: fixture.verificationWork.basis.contextEpoch,
    sourceRevision: fixture.verificationWork.basis.committedInputSequence
  });
}

function updateRequestFromAdmission(
  model: AdversarialModel,
  family: "worker" | "verifier",
  requestId: RequestId,
  result: { readonly accepted: boolean; readonly reason?: string }
): void {
  const current = family === "worker"
    ? model.workerRequests.get(requestId)
    : model.verifierRequests.get(requestId);
  if (current !== "PENDING") return;

  if (result.accepted) {
    model.noteRequest(family, requestId, "ACCEPTED");
    return;
  }
  if (result.reason === "REQUEST_NOT_PENDING" || result.reason === "UNKNOWN_REQUEST") {
    return;
  }
  const terminal: ModelRequestState = "DISCARDED";
  model.noteRequest(family, requestId, terminal);
}

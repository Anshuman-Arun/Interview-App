import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evidenceKeyToString,
  type DeterministicVerifier,
  type EvidenceKey,
  type VerificationResult
} from "../packages/domain/src/index.js";
import { replaySession } from "../packages/events/src/index.js";
import {
  SessionRuntimeRegistry,
  VerificationCoordinator as UnscopedVerificationCoordinator,
  createCommandEnvelope,
  type SessionWriter,
  type VerificationWorkItem
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import {
  AbstainingVerifier,
  TWO_COLOUR_GRAPH_VERIFIER_NAME,
  TwoColourGraphVerifier
} from "../packages/verification/src/index.js";
import { createCoreHarness, type CoreHarness } from "./harness.js";

const claimEvidenceKey: EvidenceKey = {
  problemId: "oxford-six-people",
  subject: { kind: "CLAIM", claimId: "encoded-graph-has-monochromatic-triangle" },
  dimension: "CORRECTNESS"
};

const verificationScopes = [{
  verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
  evidenceKey: claimEvidenceKey
}] as const;

class VerificationCoordinator extends UnscopedVerificationCoordinator {
  public constructor(writer: SessionWriter) {
    super(writer, verificationScopes);
  }
}

describe("deterministic verification admission", () => {
  it("requires an explicit exact verifier-to-evidence authorization before append", async () => {
    const harness = await createCoreHarness();
    const unscoped = new UnscopedVerificationCoordinator(harness.writer);
    const eventCount = harness.store.eventCount(harness.sessionId);
    const request = {
      inputEpisodeId: harness.inputEpisodeId,
      turnId: harness.turnId,
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      candidateFormalInterpretation: completeGraphStatement(6, () => "ACQUAINTANCE"),
      interpretationConfidence: 1,
      evidenceKey: claimEvidenceKey
    };

    await expect(unscoped.requestVerification(request)).rejects.toThrow(
      "Verifier is not authorized for the requested evidence scope"
    );
    expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);

    const wrongClaimCoordinator = new UnscopedVerificationCoordinator(harness.writer, [{
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      evidenceKey: {
        ...claimEvidenceKey,
        subject: { kind: "CLAIM", claimId: "unrelated-student-claim" }
      }
    }]);
    await expect(wrongClaimCoordinator.requestVerification(request)).rejects.toThrow(
      "Verifier is not authorized for the requested evidence scope"
    );
    expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);
    harness.store.close();
  });

  it("rechecks persisted verifier scope before committing correctness evidence", async () => {
    const harness = await createCoreHarness();
    const authorized = new VerificationCoordinator(harness.writer);
    const work = await issue(
      authorized,
      harness,
      completeGraphStatement(6, () => "ACQUAINTANCE"),
      1
    );
    const verifier = new TwoColourGraphVerifier();
    const result = await verifier.verify(work.candidateFormalInterpretation, 1);
    let unauthorizedVerifierCalled = false;
    const unauthorizedVerifier: DeterministicVerifier = {
      verify: async () => {
        unauthorizedVerifierCalled = true;
        return result;
      }
    };
    const unscopedAfterRequest = new UnscopedVerificationCoordinator(harness.writer);
    const admitted = await unscopedAfterRequest.processResult({
      envelope: verificationEnvelope(harness, work),
      result,
      verifier: unauthorizedVerifier
    });

    expect(admitted.value).toEqual({
      accepted: false,
      verificationRequestId: work.verificationRequestId,
      reason: "VERIFIER_SCOPE_UNAUTHORIZED"
    });
    expect(unauthorizedVerifierCalled).toBe(false);
    expect(harness.writer.getState().studentEvidence[evidenceKeyToString(claimEvidenceKey)])
      .toBeUndefined();
    expect(replaySession(harness.sessionId, harness.store.load(harness.sessionId)))
      .toEqual(harness.writer.getState());
    harness.store.close();
  });

  it("atomically admits a recomputed VERIFIED result and scoped evidence", async () => {
    const harness = await createCoreHarness();
    const coordinator = new VerificationCoordinator(harness.writer);
    const work = await issue(coordinator, harness, completeGraphStatement(6, () => "ACQUAINTANCE"), 1);
    const verifier = new TwoColourGraphVerifier();
    const result = await verifier.verify(work.candidateFormalInterpretation, work.interpretationConfidence);
    const callback = verificationEnvelope(harness, work);
    const admitted = await coordinator.processResult({ envelope: callback, result, verifier });

    expect(admitted.value).toEqual({
      accepted: true,
      verificationRequestId: work.verificationRequestId,
      status: "VERIFIED",
      evidenceCommitted: true
    });
    expect(admitted.appendedEventCount).toBe(2);
    expect(harness.writer.getState().verificationRequests[work.verificationRequestId]).toMatchObject({
      status: "ACCEPTED",
      result: { status: "VERIFIED", verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME }
    });
    const evidence = harness.writer.getState().studentEvidence[evidenceKeyToString(claimEvidenceKey)];
    expect(evidence).toMatchObject({ value: "CORRECT", inferenceConfidence: 1 });
    expect(evidence?.evidenceEventIds).toContain(
      harness.writer.getState().verificationRequests[work.verificationRequestId]?.requestedEventId
    );
    expect(replaySession(harness.sessionId, harness.store.load(harness.sessionId))).toEqual(harness.writer.getState());

    const eventCount = harness.store.eventCount(harness.sessionId);
    const duplicate = await coordinator.processResult({ envelope: callback, result, verifier });
    expect(duplicate.duplicate).toBe(true);
    if (!duplicate.value.accepted) throw new Error("Expected persisted accepted result");
    expect(duplicate.value.evidenceCommitted).toBe(true);
    expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);

    const laterDuplicate = await coordinator.processResult({
      envelope: verificationEnvelope(harness, work),
      result,
      verifier
    });
    expect(laterDuplicate.value).toMatchObject({ accepted: false, reason: "REQUEST_NOT_PENDING" });
    expect(laterDuplicate.appendedEventCount).toBe(0);
    expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);
    harness.store.close();
  });

  it("records deterministic abstention without manufacturing correctness evidence", async () => {
    const harness = await createCoreHarness();
    const coordinator = new VerificationCoordinator(harness.writer);
    const work = await issue(coordinator, harness, completeGraphStatement(6, () => "ACQUAINTANCE"), 0.8);
    const verifier = new TwoColourGraphVerifier();
    const result = await verifier.verify(work.candidateFormalInterpretation, work.interpretationConfidence);
    const admitted = await coordinator.processResult({ envelope: verificationEnvelope(harness, work), result, verifier });

    expect(admitted.value).toMatchObject({ accepted: true, status: "UNRESOLVED", evidenceCommitted: false });
    expect(admitted.appendedEventCount).toBe(1);
    expect(harness.writer.getState().studentEvidence[evidenceKeyToString(claimEvidenceKey)]).toBeUndefined();
    harness.store.close();
  });

  it("rejects a verifier that reports a confident status from a low-confidence interpretation", async () => {
    const harness = await createCoreHarness();
    const coordinator = new VerificationCoordinator(harness.writer);
    const work = await issue(
      coordinator,
      harness,
      completeGraphStatement(6, () => "ACQUAINTANCE"),
      0.6
    );
    const invalidLowConfidenceResult: VerificationResult = {
      status: "CONTRADICTED",
      interpretationConfidence: 0.6,
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      reason: "misbehaving verifier should have abstained"
    };
    const verifier: DeterministicVerifier = {
      verify: () => Promise.resolve(invalidLowConfidenceResult)
    };

    const admitted = await coordinator.processResult({
      envelope: verificationEnvelope(harness, work),
      result: invalidLowConfidenceResult,
      verifier
    });

    expect(admitted.value).toMatchObject({
      accepted: false,
      reason: "VERIFIER_OUTPUT_INVALID"
    });
    expect(harness.writer.getState().verificationRequests[work.verificationRequestId]?.status)
      .toBe("DISCARDED");
    expect(harness.writer.getState().studentEvidence[evidenceKeyToString(claimEvidenceKey)])
      .toBeUndefined();
    harness.store.close();
  });

  it("records a contradicted complete K5 interpretation without positive evidence", async () => {
    const harness = await createCoreHarness();
    const coordinator = new VerificationCoordinator(harness.writer);
    const cycle = new Set(["A:B", "B:C", "C:D", "D:E", "A:E"]);
    const work = await issue(coordinator, harness, completeGraphStatement(5, (left, right) =>
      cycle.has(`${left}:${right}`) ? "ACQUAINTANCE" : "STRANGER"
    ), 1);
    const verifier = new TwoColourGraphVerifier();
    const result = await verifier.verify(work.candidateFormalInterpretation, 1);
    const admitted = await coordinator.processResult({ envelope: verificationEnvelope(harness, work), result, verifier });

    expect(admitted.value).toMatchObject({ accepted: true, status: "CONTRADICTED", evidenceCommitted: false });
    expect(harness.writer.getState().studentEvidence[evidenceKeyToString(claimEvidenceKey)]).toBeUndefined();
    harness.store.close();
  });

  it("discards a late result when its authoritative basis becomes stale", async () => {
    const harness = await createCoreHarness();
    const coordinator = new VerificationCoordinator(harness.writer);
    const work = await issue(coordinator, harness, completeGraphStatement(6, () => "ACQUAINTANCE"), 1);
    const verifier = new TwoColourGraphVerifier();
    const result = await verifier.verify(work.candidateFormalInterpretation, 1);
    await harness.turns.correctTranscript("A corrected student statement invalidates the interpretation basis.");
    const admitted = await coordinator.processResult({ envelope: verificationEnvelope(harness, work), result, verifier });

    expect(admitted.value).toMatchObject({ accepted: false, reason: "COMPATIBILITY_INCOMPATIBLE" });
    expect(harness.writer.getState().verificationRequests[work.verificationRequestId]?.status).toBe("DISCARDED");
    expect(harness.writer.getState().studentEvidence[evidenceKeyToString(claimEvidenceKey)]).toBeUndefined();
    harness.store.close();
  });

  it("fails closed on a missing callback basis or tampered verifier result", async () => {
    const missingHarness = await createCoreHarness();
    const missingCoordinator = new VerificationCoordinator(missingHarness.writer);
    const missingWork = await issue(missingCoordinator, missingHarness, completeGraphStatement(6, () => "ACQUAINTANCE"), 1);
    const verifier = new TwoColourGraphVerifier();
    const valid = await verifier.verify(missingWork.candidateFormalInterpretation, 1);
    const missing = await missingCoordinator.processResult({
      envelope: createCommandEnvelope({
        sessionId: missingHarness.sessionId,
        producer: "deterministic-verifier",
        correlationId: missingWork.verificationRequestId
      }),
      result: valid,
      verifier
    });
    expect(missing.value).toMatchObject({ accepted: false, reason: "CALLBACK_BASIS_MISMATCH" });
    missingHarness.store.close();

    const tamperedHarness = await createCoreHarness();
    const tamperedCoordinator = new VerificationCoordinator(tamperedHarness.writer);
    const tamperedWork = await issue(tamperedCoordinator, tamperedHarness, completeGraphStatement(6, () => "ACQUAINTANCE"), 1);
    const tampered = await tamperedCoordinator.processResult({
      envelope: verificationEnvelope(tamperedHarness, tamperedWork),
      result: { ...valid, status: "CONTRADICTED", reason: "tampered" },
      verifier
    });
    expect(tampered.value).toMatchObject({ accepted: false, reason: "RECOMPUTATION_MISMATCH" });
    tamperedHarness.store.close();
  });

  it("rejects verifier switching, execution failure, and invalid runtime output", async () => {
    const switchedHarness = await createCoreHarness();
    const switchedCoordinator = new VerificationCoordinator(switchedHarness.writer);
    const switchedWork = await issue(switchedCoordinator, switchedHarness, completeGraphStatement(6, () => "ACQUAINTANCE"), 1);
    const abstainer = new AbstainingVerifier();
    const abstention = await abstainer.verify(switchedWork.candidateFormalInterpretation, 1);
    const switched = await switchedCoordinator.processResult({
      envelope: verificationEnvelope(switchedHarness, switchedWork),
      result: abstention,
      verifier: abstainer
    });
    expect(switched.value).toMatchObject({ accepted: false, reason: "VERIFIER_IDENTITY_MISMATCH" });
    switchedHarness.store.close();

    const failingHarness = await createCoreHarness();
    const failingCoordinator = new VerificationCoordinator(failingHarness.writer);
    const failingWork = await issue(failingCoordinator, failingHarness, completeGraphStatement(6, () => "ACQUAINTANCE"), 1);
    const throwingVerifier: DeterministicVerifier = { verify: () => Promise.reject(new Error("secret verifier failure")) };
    const plausible: VerificationResult = {
      status: "VERIFIED",
      interpretationConfidence: 1,
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      reason: "plausible but not independently reproduced"
    };
    const failed = await failingCoordinator.processResult({
      envelope: verificationEnvelope(failingHarness, failingWork),
      result: plausible,
      verifier: throwingVerifier
    });
    expect(failed.value).toMatchObject({ accepted: false, reason: "VERIFIER_EXECUTION_FAILED" });
    expect(JSON.stringify(failingHarness.store.load(failingHarness.sessionId))).not.toContain("secret verifier failure");
    failingHarness.store.close();

    const invalidHarness = await createCoreHarness();
    const invalidCoordinator = new VerificationCoordinator(invalidHarness.writer);
    const invalidWork = await issue(invalidCoordinator, invalidHarness, completeGraphStatement(6, () => "ACQUAINTANCE"), 1);
    const invalidVerifier: DeterministicVerifier = {
      verify: () => Promise.resolve({ ...plausible, interpretationConfidence: 2 })
    };
    const invalid = await invalidCoordinator.processResult({
      envelope: verificationEnvelope(invalidHarness, invalidWork),
      result: plausible,
      verifier: invalidVerifier
    });
    expect(invalid.value).toMatchObject({ accepted: false, reason: "VERIFIER_OUTPUT_INVALID" });
    invalidHarness.store.close();
  });

  it("rejects malformed callbacks before append and resumes a pending request after restart", async () => {
    const malformedHarness = await createCoreHarness();
    const malformedCoordinator = new VerificationCoordinator(malformedHarness.writer);
    const malformedWork = await issue(malformedCoordinator, malformedHarness, completeGraphStatement(6, () => "ACQUAINTANCE"), 1);
    const count = malformedHarness.store.eventCount(malformedHarness.sessionId);
    await expect(malformedCoordinator.processResult({
      envelope: verificationEnvelope(malformedHarness, malformedWork),
      result: { status: "VERIFIED", arbitrary: true },
      verifier: new TwoColourGraphVerifier()
    })).rejects.toThrow();
    expect(malformedHarness.store.eventCount(malformedHarness.sessionId)).toBe(count);
    malformedHarness.store.close();

    const directory = mkdtempSync(join(tmpdir(), "interview-verification-"));
    const databasePath = join(directory, "events.sqlite");
    let store = new SqliteEventStore(databasePath);
    try {
      const first = await createCoreHarness(store);
      const firstCoordinator = new VerificationCoordinator(first.writer);
      const work = await issue(firstCoordinator, first, completeGraphStatement(6, () => "ACQUAINTANCE"), 1);
      const result = await new TwoColourGraphVerifier().verify(work.candidateFormalInterpretation, 1);
      store.close();

      store = new SqliteEventStore(databasePath);
      const writer = new SessionRuntimeRegistry(store).get(first.sessionId);
      const admitted = await new VerificationCoordinator(writer).processResult({
        envelope: verificationEnvelope(first, work),
        result,
        verifier: new TwoColourGraphVerifier()
      });
      expect(admitted.value).toMatchObject({ accepted: true, status: "VERIFIED", evidenceCommitted: true });
      expect(replaySession(first.sessionId, store.load(first.sessionId))).toEqual(writer.getState());
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function issue(
  coordinator: VerificationCoordinator,
  harness: CoreHarness,
  candidateFormalInterpretation: string,
  interpretationConfidence: number
): Promise<VerificationWorkItem> {
  return (await coordinator.requestVerification({
    inputEpisodeId: harness.inputEpisodeId,
    turnId: harness.turnId,
    verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
    candidateFormalInterpretation,
    interpretationConfidence,
    evidenceKey: claimEvidenceKey
  })).value;
}

function verificationEnvelope(harness: CoreHarness, work: VerificationWorkItem) {
  return createCommandEnvelope({
    sessionId: harness.sessionId,
    producer: "deterministic-verifier",
    correlationId: work.verificationRequestId,
    inputEpisodeId: harness.inputEpisodeId,
    turnId: harness.turnId,
    contextEpoch: work.basis.contextEpoch,
    sourceRevision: work.basis.committedInputSequence
  });
}

function completeGraphStatement(
  vertexCount: number,
  relationForPair: (left: string, right: string) => "ACQUAINTANCE" | "STRANGER"
): string {
  const vertices = Array.from({ length: vertexCount }, (_, index) => String.fromCharCode(65 + index));
  const edges: Array<{ endpoints: [string, string]; relation: "ACQUAINTANCE" | "STRANGER" }> = [];
  for (let left = 0; left < vertices.length - 1; left += 1) {
    for (let right = left + 1; right < vertices.length; right += 1) {
      const leftVertex = vertices[left];
      const rightVertex = vertices[right];
      if (leftVertex !== undefined && rightVertex !== undefined) {
        edges.push({ endpoints: [leftVertex, rightVertex], relation: relationForPair(leftVertex, rightVertex) });
      }
    }
  }
  return JSON.stringify({
    protocol: "INTERVIEW_APP_TWO_COLOUR_GRAPH_CLAIM",
    protocolVersion: 1,
    problemId: "oxford-six-people",
    problemVersion: "1.0.0",
    claim: "ENCODED_GRAPH_HAS_MONOCHROMATIC_TRIANGLE",
    vertices,
    edges
  });
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evidenceKeyToString,
  newInputEpisodeId,
  newRequestId,
  type EvidenceKey,
  type FormalInterpretationProposal,
  type RequestId
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

describe("formal interpretation proposal admission", () => {
  it("atomically consumes a current generation and opens deterministic verification", async () => {
    const harness = await createCoreHarness();
    const coordinator = new VerificationCoordinator(harness.writer);
    const envelope = proposalEnvelope(harness);
    const proposal = completeGraphProposal(1);

    const admitted = await coordinator.requestVerificationFromProposal({
      envelope,
      proposal,
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      evidenceKey: claimEvidenceKey
    });

    expect(admitted.value.accepted).toBe(true);
    expect(admitted.appendedEventCount).toBe(2);
    if (!admitted.value.accepted) throw new Error("Expected formal interpretation admission");
    const work = admitted.value.workItem;
    expect(work).toMatchObject({
      sourceGenerationId: harness.generationId,
      sourceProposalRequestId: envelope.requestId,
      candidateFormalInterpretation: proposal.candidateFormalInterpretation,
      interpretationConfidence: 1
    });
    expect(harness.writer.getState().generations[harness.generationId]).toMatchObject({
      status: "PROPOSAL_RECEIVED",
      formalInterpretationProposal: proposal
    });
    expect(harness.writer.getState().verificationRequests[work.verificationRequestId]).toMatchObject({
      status: "PENDING",
      sourceGenerationId: harness.generationId,
      sourceProposalRequestId: envelope.requestId
    });
    expect(harness.writer.getState().studentEvidence[evidenceKeyToString(claimEvidenceKey)]).toBeUndefined();
    expect(harness.store.load(harness.sessionId).slice(-2).map((event) => [event.type, event.source])).toEqual([
      ["FORMAL_INTERPRETATION_PROPOSAL_RECEIVED", "PROVIDER"],
      ["VERIFICATION_REQUESTED", "APPLICATION"]
    ]);

    const verifier = new TwoColourGraphVerifier();
    const result = await verifier.verify(work.candidateFormalInterpretation, work.interpretationConfidence);
    const verified = await coordinator.processResult({
      envelope: verificationEnvelope(harness, work),
      result,
      verifier
    });
    expect(verified.value).toMatchObject({ accepted: true, status: "VERIFIED", evidenceCommitted: true });
    expect(harness.writer.getState().studentEvidence[evidenceKeyToString(claimEvidenceKey)]).toMatchObject({
      value: "CORRECT",
      inferenceConfidence: 1
    });
    expect(replaySession(harness.sessionId, harness.store.load(harness.sessionId))).toEqual(harness.writer.getState());
    harness.store.close();
  });

  it("persists one result for a duplicate provider callback and admits only one concurrent callback", async () => {
    const duplicateHarness = await createCoreHarness();
    const duplicateCoordinator = new VerificationCoordinator(duplicateHarness.writer);
    const duplicateEnvelope = proposalEnvelope(duplicateHarness);
    const input = {
      envelope: duplicateEnvelope,
      proposal: completeGraphProposal(1),
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      evidenceKey: claimEvidenceKey
    };
    const first = await duplicateCoordinator.requestVerificationFromProposal(input);
    const count = duplicateHarness.store.eventCount(duplicateHarness.sessionId);
    const duplicate = await duplicateCoordinator.requestVerificationFromProposal(input);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.value).toEqual(first.value);
    expect(duplicateHarness.store.eventCount(duplicateHarness.sessionId)).toBe(count);
    duplicateHarness.store.close();

    const concurrentHarness = await createCoreHarness();
    const concurrentCoordinator = new VerificationCoordinator(concurrentHarness.writer);
    const [left, right] = await Promise.all([
      concurrentCoordinator.requestVerificationFromProposal({
        envelope: proposalEnvelope(concurrentHarness, newRequestId()),
        proposal: completeGraphProposal(1),
        verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
        evidenceKey: claimEvidenceKey
      }),
      concurrentCoordinator.requestVerificationFromProposal({
        envelope: proposalEnvelope(concurrentHarness, newRequestId()),
        proposal: completeGraphProposal(1),
        verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
        evidenceKey: claimEvidenceKey
      })
    ]);
    expect([left.value, right.value].filter((value) => value.accepted)).toHaveLength(1);
    expect([left.value, right.value].filter((value) => !value.accepted)).toEqual([
      expect.objectContaining({ reason: "GENERATION_NOT_ACTIVE" })
    ]);
    expect(Object.values(concurrentHarness.writer.getState().verificationRequests)).toHaveLength(1);
    expect(replaySession(concurrentHarness.sessionId, concurrentHarness.store.load(concurrentHarness.sessionId)))
      .toEqual(concurrentHarness.writer.getState());
    concurrentHarness.store.close();
  });

  it("returns the same admitted work item after application restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "formal-interpretation-admission-"));
    const databasePath = join(directory, "events.sqlite");
    let store = new SqliteEventStore(databasePath);
    try {
      const harness = await createCoreHarness(store);
      const envelope = proposalEnvelope(harness);
      const input = {
        envelope,
        proposal: completeGraphProposal(1),
        verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
        evidenceKey: claimEvidenceKey
      };
      const first = await new VerificationCoordinator(harness.writer).requestVerificationFromProposal(input);
      expect(first.value.accepted).toBe(true);
      const eventCount = store.eventCount(harness.sessionId);
      store.close();

      store = new SqliteEventStore(databasePath);
      const writer = new SessionRuntimeRegistry(store).get(harness.sessionId);
      const duplicate = await new VerificationCoordinator(writer).requestVerificationFromProposal(input);
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.value).toEqual(first.value);
      expect(store.eventCount(harness.sessionId)).toBe(eventCount);
      expect(replaySession(harness.sessionId, store.load(harness.sessionId))).toEqual(writer.getState());
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on callback-basis mismatch and stale or unknown compatibility", async () => {
    const mismatchHarness = await createCoreHarness();
    const mismatchCoordinator = new VerificationCoordinator(mismatchHarness.writer);
    const basis = generationBasis(mismatchHarness);
    const mismatch = await mismatchCoordinator.requestVerificationFromProposal({
      envelope: createCommandEnvelope({
        sessionId: mismatchHarness.sessionId,
        producer: "mock-formal-interpreter",
        generationId: mismatchHarness.generationId,
        inputEpisodeId: mismatchHarness.inputEpisodeId,
        turnId: mismatchHarness.turnId,
        contextEpoch: basis.contextEpoch,
        sourceRevision: basis.committedInputSequence + 1
      }),
      proposal: completeGraphProposal(1),
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      evidenceKey: claimEvidenceKey
    });
    expect(mismatch.value).toMatchObject({ accepted: false, reason: "CALLBACK_BASIS_MISMATCH" });
    expect(mismatchHarness.writer.getState().generations[mismatchHarness.generationId]?.status).toBe("SUPERSEDED");
    expect(Object.values(mismatchHarness.writer.getState().verificationRequests)).toHaveLength(0);
    mismatchHarness.store.close();

    const staleHarness = await createCoreHarness();
    const staleCoordinator = new VerificationCoordinator(staleHarness.writer);
    const staleEnvelope = proposalEnvelope(staleHarness);
    await staleHarness.turns.commitBoardPatch("Student added a new graph edge.");
    const stale = await staleCoordinator.requestVerificationFromProposal({
      envelope: staleEnvelope,
      proposal: completeGraphProposal(1),
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      evidenceKey: claimEvidenceKey
    });
    expect(stale.value).toMatchObject({ accepted: false, reason: "COMPATIBILITY_INCOMPATIBLE" });
    expect(staleHarness.writer.getState().generations[staleHarness.generationId]?.status).toBe("SUPERSEDED");
    staleHarness.store.close();

    const unknownHarness = await createCoreHarness();
    const missingEpisodeId = newInputEpisodeId();
    await expect(
      unknownHarness.turns.startGeneration(
        missingEpisodeId,
        unknownHarness.turnId,
        "mock-formal-interpreter"
      )
    ).rejects.toThrow(/committed InputEpisode/u);
    unknownHarness.store.close();
  });

  it("rejects invalid application scope and malformed provider output without opening verification", async () => {
    const scopeHarness = await createCoreHarness();
    const scopeCoordinator = new VerificationCoordinator(scopeHarness.writer);
    const wrongScope = await scopeCoordinator.requestVerificationFromProposal({
      envelope: proposalEnvelope(scopeHarness),
      proposal: completeGraphProposal(1),
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      evidenceKey: { ...claimEvidenceKey, problemId: "another-problem" }
    });
    expect(wrongScope.value).toMatchObject({ accepted: false, reason: "PROBLEM_SCOPE_MISMATCH" });
    expect(scopeHarness.writer.getState().generations[scopeHarness.generationId]?.status).toBe("REJECTED");
    expect(Object.values(scopeHarness.writer.getState().verificationRequests)).toHaveLength(0);
    scopeHarness.store.close();

    const claimHarness = await createCoreHarness();
    const claimCoordinator = new VerificationCoordinator(claimHarness.writer);
    const wrongClaim = await claimCoordinator.requestVerificationFromProposal({
      envelope: proposalEnvelope(claimHarness),
      proposal: completeGraphProposal(1),
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      evidenceKey: {
        ...claimEvidenceKey,
        subject: { kind: "CLAIM", claimId: "unrelated-student-claim" }
      }
    });
    expect(wrongClaim.value).toMatchObject({
      accepted: false,
      reason: "VERIFIER_SCOPE_UNAUTHORIZED"
    });
    expect(Object.values(claimHarness.writer.getState().verificationRequests)).toHaveLength(0);
    claimHarness.store.close();

    const malformedHarness = await createCoreHarness();
    const malformedCoordinator = new VerificationCoordinator(malformedHarness.writer);
    const count = malformedHarness.store.eventCount(malformedHarness.sessionId);
    const malformed = {
      candidateFormalInterpretation: "{}",
      interpretationConfidence: 2,
      injectedAuthority: "commit correctness directly"
    } as unknown as FormalInterpretationProposal;
    await expect(malformedCoordinator.requestVerificationFromProposal({
      envelope: proposalEnvelope(malformedHarness),
      proposal: malformed,
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      evidenceKey: claimEvidenceKey
    })).rejects.toThrow();
    expect(malformedHarness.store.eventCount(malformedHarness.sessionId)).toBe(count);
    expect(malformedHarness.writer.getState().generations[malformedHarness.generationId]?.status).toBe("ACTIVE");
    malformedHarness.store.close();
  });

  it("admits low-confidence interpretation only to an abstaining verifier path", async () => {
    const harness = await createCoreHarness();
    const coordinator = new VerificationCoordinator(harness.writer);
    const admitted = await coordinator.requestVerificationFromProposal({
      envelope: proposalEnvelope(harness),
      proposal: completeGraphProposal(0.7),
      verifier: TWO_COLOUR_GRAPH_VERIFIER_NAME,
      evidenceKey: claimEvidenceKey
    });
    if (!admitted.value.accepted) throw new Error("Expected bounded proposal admission");
    const work = admitted.value.workItem;
    const verifier = new TwoColourGraphVerifier();
    const result = await verifier.verify(work.candidateFormalInterpretation, work.interpretationConfidence);
    const verified = await coordinator.processResult({
      envelope: verificationEnvelope(harness, work),
      result,
      verifier
    });
    expect(verified.value).toMatchObject({ accepted: true, status: "UNRESOLVED", evidenceCommitted: false });
    expect(harness.writer.getState().studentEvidence[evidenceKeyToString(claimEvidenceKey)]).toBeUndefined();
    harness.store.close();
  });
});

function proposalEnvelope(harness: CoreHarness, requestId?: RequestId) {
  const basis = generationBasis(harness);
  return createCommandEnvelope({
    sessionId: harness.sessionId,
    producer: "mock-formal-interpreter",
    ...(requestId === undefined ? {} : { requestId }),
    generationId: harness.generationId,
    inputEpisodeId: harness.inputEpisodeId,
    turnId: harness.turnId,
    contextEpoch: basis.contextEpoch,
    sourceRevision: basis.committedInputSequence
  });
}

function generationBasis(harness: CoreHarness) {
  const generation = harness.writer.getState().generations[harness.generationId];
  if (generation === undefined) throw new Error("Expected active generation");
  return generation.basis;
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

function completeGraphProposal(interpretationConfidence: number): FormalInterpretationProposal {
  const vertices = ["A", "B", "C", "D", "E", "F"];
  const edges: Array<{ endpoints: [string, string]; relation: "ACQUAINTANCE" }> = [];
  for (let left = 0; left < vertices.length - 1; left += 1) {
    for (let right = left + 1; right < vertices.length; right += 1) {
      const leftVertex = vertices[left];
      const rightVertex = vertices[right];
      if (leftVertex !== undefined && rightVertex !== undefined) {
        edges.push({ endpoints: [leftVertex, rightVertex], relation: "ACQUAINTANCE" });
      }
    }
  }
  return {
    candidateFormalInterpretation: JSON.stringify({
      protocol: "INTERVIEW_APP_TWO_COLOUR_GRAPH_CLAIM",
      protocolVersion: 1,
      problemId: "oxford-six-people",
      problemVersion: "1.0.0",
      claim: "ENCODED_GRAPH_HAS_MONOCHROMATIC_TRIANGLE",
      vertices,
      edges
    }),
    interpretationConfidence
  };
}

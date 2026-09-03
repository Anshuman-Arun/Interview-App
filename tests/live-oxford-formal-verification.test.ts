import { describe, expect, it } from "vitest";
import {
  evidenceKeyToString,
  newRequestId,
  newSessionId,
  type FormalInterpretationRequest
} from "../packages/domain/src/index.js";
import {
  DeterministicFormalInterpretationProvider,
  InterpretationCoordinator,
  SessionRuntimeRegistry,
  TurnCoordinator,
  VerificationCoordinator,
  createCommandEnvelope,
  createCommittedTurnFormalInterpretationRequest,
  decidePedagogicalPolicy,
  echoInterpretationCandidateSource,
  providerResultFor,
  type FormalInterpretationProvider
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { getProblemById } from "../packages/problems/src/index.js";
import {
  MODULAR_ARITHMETIC_PROTOCOL,
  RATIONAL_ARITHMETIC_PROTOCOL
} from "../packages/verification/src/index.js";
import { SessionRecoveryCoordinator } from "../apps/server/src/session-recovery-coordinator.js";
import { ServerTurnOrchestrator } from "../apps/server/src/turn-orchestrator.js";
import {
  StudentReasoningAnalysisCoordinator
} from "../apps/server/src/student-reasoning-analysis-coordinator.js";
import {
  resolveOxfordFormalAnalysisProfile
} from "../apps/server/src/oxford-formal-analysis-catalog.js";

function problem(problemId: string) {
  const value = getProblemById(problemId);
  if (value === undefined) throw new Error("Missing test problem " + problemId);
  return value;
}

function rationalLiteral(numerator: string, denominator = "1") {
  return { kind: "RATIONAL" as const, value: { numerator, denominator } };
}

function statementFor(
  request: FormalInterpretationRequest,
  truth: "CORRECT" | "FALSE"
): string {
  const protocol = request.allowedProtocols[0]?.protocol;
  if (protocol === "RATIONAL_ARITHMETIC") {
    return JSON.stringify({
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: 1,
      claim: {
        kind: "EQUALITY",
        left: rationalLiteral("1", "2"),
        right: truth === "CORRECT"
          ? rationalLiteral("2", "4")
          : rationalLiteral("3", "4")
      }
    });
  }
  if (protocol === "MODULAR_ARITHMETIC") {
    return JSON.stringify({
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: 1,
      claim: {
        kind: "DIVISIBILITY",
        divisor: truth === "CORRECT" ? "2" : "3",
        dividend: { kind: "INTEGER", value: "4" }
      }
    });
  }
  throw new Error("Unexpected protocol in Oxford analysis test");
}

function interpretationResult(
  request: FormalInterpretationRequest,
  truth: "CORRECT" | "FALSE"
) {
  const protocol = request.allowedProtocols[0];
  if (protocol === undefined) throw new Error("Test request has no protocol");
  return providerResultFor(request, [{
    protocolVersion: 1,
    candidateId: "candidate-1",
    protocol,
    formalStatement: statementFor(request, truth),
    confidence: 1,
    target: request.target,
    source: echoInterpretationCandidateSource(request)
  }]);
}

function deterministicProvider(
  truth: "CORRECT" | "FALSE"
): DeterministicFormalInterpretationProvider {
  return new DeterministicFormalInterpretationProvider(
    (request: FormalInterpretationRequest) => interpretationResult(request, truth)
  );
}

describe("live Oxford formal reasoning analysis", () => {
  it("verifies correct claims on several curated Oxford problems and makes policy observe the evidence", async () => {
    for (const problemId of [
      "oxford-domino-chessboard",
      "oxford-euclid-primes",
      "oxford-prefix-sums-mod-n",
      "oxford-triangle-medians",
      "oxford-divisibility-chain"
    ]) {
      const store = new SqliteEventStore(":memory:");
      try {
        const registry = new SessionRuntimeRegistry(store);
        const sessionId = newSessionId();
        const writer = registry.get(sessionId);
        const turns = new TurnCoordinator(writer);
        const selectedProblem = problem(problemId);
        await turns.startSession(selectedProblem);
        const committed = await turns.commitInput(
          "I am making an exact arithmetic subclaim that can be checked deterministically."
        );
        const sessions = new SessionRecoveryCoordinator(registry, store);
        const analysis = new StudentReasoningAnalysisCoordinator(
          sessions,
          deterministicProvider("CORRECT")
        );

        const outcome = await analysis.analyze({
          sessionId,
          turnId: committed.turnId,
          inputEpisodeId: committed.inputEpisodeId
        });

        expect(outcome.status).toBe("ANALYZED");
        if (outcome.status !== "ANALYZED") throw new Error("Expected analysis");
        expect(outcome.interpretation).toMatchObject({
          status: "ACCEPTED",
          verificationStatus: "VERIFIED",
          evidenceCommitted: true
        });

        const profile = resolveOxfordFormalAnalysisProfile(selectedProblem);
        if (profile === undefined) throw new Error("Missing Oxford formal profile");
        const state = writer.getState();
        expect(state.studentEvidence[evidenceKeyToString(profile.target)]).toMatchObject({
          value: "CORRECT",
          inferenceConfidence: 1
        });
        const verification = Object.values(state.verificationRequests)[0];
        expect(verification?.sourceGenerationId).toBeUndefined();
        expect(verification?.result?.status).toBe("VERIFIED");
        expect(state.generations).toEqual({});
        expect(state.deliveries).toEqual({});
        expect(state.disclosureLedger).toEqual([]);

        const decision = decidePedagogicalPolicy(state, committed.turnId, selectedProblem);
        expect(decision).toMatchObject({
          classification: "PRODUCTIVE_PROGRESS",
          reasonCode: "PROGRESS_CONTINUES",
          waitingPreferred: true,
          realizationRequest: { requiredAction: "WAIT" }
        });
      } finally {
        store.close();
      }
    }
  });

  it("preserves a deterministic contradiction as a local-error policy signal without creating false correctness evidence", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-prefix-sums-mod-n");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("I claim 3 divides 4.");

      const outcome = await new StudentReasoningAnalysisCoordinator(
        new SessionRecoveryCoordinator(registry, store),
        deterministicProvider("FALSE")
      ).analyze({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId
      });

      expect(outcome.status).toBe("ANALYZED");
      if (outcome.status !== "ANALYZED") throw new Error("Expected analysis");
      expect(outcome.interpretation).toMatchObject({
        status: "ACCEPTED",
        verificationStatus: "CONTRADICTED",
        evidenceCommitted: false
      });

      const profile = resolveOxfordFormalAnalysisProfile(selectedProblem);
      if (profile === undefined) throw new Error("Missing Oxford formal profile");
      const state = writer.getState();
      expect(state.studentEvidence[evidenceKeyToString(profile.target)]).toBeUndefined();
      const decision = decidePedagogicalPolicy(state, committed.turnId, selectedProblem);
      expect(decision).toMatchObject({
        classification: "LOCAL_ERROR",
        reasonCode: "LOCAL_CORRECTION_NEEDED",
        realizationRequest: { requiredAction: "CHECK_LOCAL_STEP" }
      });
    } finally {
      store.close();
    }
  });

  it("lets ambiguous or unsupported reasoning continue when the interpretation provider abstains", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-domino-chessboard");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("I think symmetry might help, but I am not sure.");

      const provider = new DeterministicFormalInterpretationProvider((request: FormalInterpretationRequest) =>
        providerResultFor(request, [])
      );
      const outcome = await new StudentReasoningAnalysisCoordinator(
        new SessionRecoveryCoordinator(registry, store),
        provider
      ).analyze({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId
      });

      expect(outcome.status).toBe("ANALYZED");
      if (outcome.status !== "ANALYZED") throw new Error("Expected analysis");
      expect(outcome.interpretation).toMatchObject({
        status: "NO_SUPPORTED_INTERPRETATION",
        reason: "NO_INTERPRETATION"
      });
      expect(Object.values(writer.getState().verificationRequests)).toHaveLength(0);

      const decision = decidePedagogicalPolicy(writer.getState(), committed.turnId, selectedProblem);
      expect(decision).toMatchObject({
        classification: "INSUFFICIENT_EVIDENCE",
        reasonCode: "NO_CURRENT_EVIDENCE",
        realizationRequest: { requiredAction: "PROBE_JUSTIFICATION" }
      });
    } finally {
      store.close();
    }
  });

  it("abandons a late old-turn interpretation before it can create verification or evidence", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-euclid-primes");
      await turns.startSession(selectedProblem);
      const oldTurn = await turns.commitInput("For 2, 3, 5 the product plus one is 31.");

      let releaseProvider: ((value: unknown) => void) | undefined;
      let capturedRequest: FormalInterpretationRequest | undefined;
      let markProviderCalled: (() => void) | undefined;
      const providerCalled = new Promise<void>((resolve) => {
        markProviderCalled = resolve;
      });
      const provider: FormalInterpretationProvider = {
        interpret(request) {
          capturedRequest = request;
          markProviderCalled?.();
          return new Promise((resolve) => {
            releaseProvider = resolve;
          });
        }
      };
      const sessions = new SessionRecoveryCoordinator(registry, store);
      const analysis = new StudentReasoningAnalysisCoordinator(sessions, provider, 5_000);
      const pending = analysis.analyze({
        sessionId,
        turnId: oldTurn.turnId,
        inputEpisodeId: oldTurn.inputEpisodeId
      });

      await providerCalled;
      await turns.commitInput("A newer committed line of reasoning supersedes that turn.");
      analysis.supersedeStaleRequests(sessionId);
      if (capturedRequest === undefined || releaseProvider === undefined) {
        throw new Error("Provider did not receive the formal request");
      }
      releaseProvider(interpretationResult(capturedRequest, "CORRECT"));

      const outcome = await pending;
      expect(outcome.status).toBe("ANALYZED");
      if (outcome.status !== "ANALYZED") throw new Error("Expected analysis result");
      expect(outcome.interpretation).toMatchObject({
        status: "STALE",
        reason: "CANCELLED"
      });
      expect(Object.values(writer.getState().verificationRequests)).toHaveLength(0);
      expect(Object.values(writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("keeps a current text claim verifiable when only the whiteboard changes during interpretation", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-triangle-medians");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("The arithmetic ratio check is exact.");

      let releaseProvider: ((value: unknown) => void) | undefined;
      let capturedRequest: FormalInterpretationRequest | undefined;
      let markProviderCalled: (() => void) | undefined;
      const providerCalled = new Promise<void>((resolve) => {
        markProviderCalled = resolve;
      });
      const provider: FormalInterpretationProvider = {
        interpret(request) {
          capturedRequest = request;
          markProviderCalled?.();
          return new Promise((resolve) => {
            releaseProvider = resolve;
          });
        }
      };
      const analysis = new StudentReasoningAnalysisCoordinator(
        new SessionRecoveryCoordinator(registry, store),
        provider,
        5_000
      );
      const pending = analysis.analyze({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId
      });

      await providerCalled;
      const boardCommit = await turns.commitBoardMutation({
        baseBoardRevision: writer.getState().boardRevision,
        added: [{
          id: "student-shape-1",
          type: "text",
          bounds: { x: 0, y: 0, width: 100, height: 24 },
          text: "G",
          revision: 1,
          createdAt: 1,
          lastModifiedAt: 1
        }],
        updated: [],
        deleted: []
      });
      expect(boardCommit.committed).toBe(true);
      if (capturedRequest === undefined || releaseProvider === undefined) {
        throw new Error("Provider did not receive the formal request");
      }
      releaseProvider(interpretationResult(capturedRequest, "CORRECT"));

      const outcome = await pending;
      expect(outcome.status).toBe("ANALYZED");
      if (outcome.status !== "ANALYZED") throw new Error("Expected analysis result");
      expect(outcome.interpretation).toMatchObject({
        status: "ACCEPTED",
        verificationStatus: "VERIFIED",
        evidenceCommitted: true
      });
      expect(Object.values(writer.getState().verificationRequests)[0]?.basis.boardRevision).toBe(1);
    } finally {
      store.close();
    }
  });

  it("runs analysis before live Oxford policy selection in the server orchestrator", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-domino-chessboard");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("Removing two same-colored corners leaves the exact color-count mismatch.");

      const sessions = new SessionRecoveryCoordinator(registry, store);
      const orchestrator = new ServerTurnOrchestrator(
        sessions,
        () => undefined,
        undefined,
        undefined,
        deterministicProvider("CORRECT")
      );
      await orchestrator.orchestrateTurn({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: writer.getState().turns[committed.turnId]?.studentText ?? ""
      });

      const state = writer.getState();
      expect(state.pedagogicalActions[committed.turnId]).toMatchObject({
        requiredAction: "WAIT"
      });
      expect(Object.values(state.verificationRequests)[0]?.result?.status).toBe("VERIFIED");
      expect(Object.values(state.generations)).toHaveLength(0);
      expect(Object.values(state.deliveries)).toHaveLength(0);
      expect(state.disclosureLedger).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("resumes a crash-stranded direct verification idempotently without duplicating evidence", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-euclid-primes");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("31 is congruent to 1 modulo 5.");

      const profile = resolveOxfordFormalAnalysisProfile(selectedProblem);
      if (profile === undefined) throw new Error("Missing Oxford formal profile");
      const request = createCommittedTurnFormalInterpretationRequest(writer, {
        inputEpisodeId: committed.inputEpisodeId,
        turnId: committed.turnId,
        target: profile.target,
        allowedProtocols: profile.allowedProtocols,
        requestId: newRequestId()
      });
      const verifier = profile.scopes[0]?.verifier;
      if (verifier === undefined) throw new Error("Missing verifier scope");

      const verification = new VerificationCoordinator(writer, profile.scopes);
      const admitted = await verification.requestVerification({
        inputEpisodeId: committed.inputEpisodeId,
        turnId: committed.turnId,
        verifier,
        candidateFormalInterpretation: statementFor(request, "CORRECT"),
        interpretationConfidence: 1,
        evidenceKey: profile.target,
        envelope: createCommandEnvelope({
          sessionId,
          producer: "interpretation-coordinator",
          requestId: request.requestId,
          correlationId: request.requestId,
          inputEpisodeId: committed.inputEpisodeId,
          turnId: committed.turnId,
          contextEpoch: request.basis.contextEpoch,
          sourceRevision: request.source.sourceRevision
        })
      });
      expect(admitted.duplicate).toBe(false);
      expect(writer.getState().verificationRequests[request.requestId]?.status).toBe("PENDING");

      // A new coordinator models a restarted process with no in-memory request cache.
      const restarted = new InterpretationCoordinator(
        writer,
        deterministicProvider("CORRECT"),
        profile.scopes
      );
      const outcome = await restarted.interpretAndVerify(request);
      expect(outcome).toMatchObject({
        status: "ACCEPTED",
        verificationStatus: "VERIFIED",
        evidenceCommitted: true,
        duplicateVerificationRequest: true
      });

      const state = writer.getState();
      expect(Object.values(state.verificationRequests)).toHaveLength(1);
      expect(state.studentEvidence[evidenceKeyToString(profile.target)]).toMatchObject({
        value: "CORRECT",
        inferenceConfidence: 1
      });
      expect(state.evidenceHistory[evidenceKeyToString(profile.target)]).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rejects an interpretation-provider attempt to write authoritative evidence directly", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-divisibility-chain");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("I have a numerical divisibility claim.");

      const malicious: FormalInterpretationProvider = {
        interpret(request) {
          return Promise.resolve({
            ...interpretationResult(request, "CORRECT"),
            studentEvidence: {
              value: "CORRECT",
              authority: "provider"
            }
          });
        }
      };
      const outcome = await new StudentReasoningAnalysisCoordinator(
        new SessionRecoveryCoordinator(registry, store),
        malicious
      ).analyze({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId
      });

      expect(outcome.status).toBe("ANALYZED");
      if (outcome.status !== "ANALYZED") throw new Error("Expected analysis");
      expect(outcome.interpretation).toMatchObject({
        status: "INVALID_PROVIDER_OUTPUT",
        reason: "MALFORMED_PROVIDER_RESULT"
      });
      expect(Object.values(writer.getState().verificationRequests)).toHaveLength(0);
      expect(Object.values(writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("continues a supported Oxford interview when no production interpretation provider is configured", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-domino-chessboard");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("Maybe symmetry is useful here.");

      const orchestrator = new ServerTurnOrchestrator(
        new SessionRecoveryCoordinator(registry, store),
        () => undefined
      );
      await orchestrator.orchestrateTurn({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: "Maybe symmetry is useful here."
      });

      const state = writer.getState();
      expect(Object.values(state.verificationRequests)).toHaveLength(0);
      expect(state.pedagogicalActions[committed.turnId]).toMatchObject({
        requiredAction: "PROBE_JUSTIFICATION"
      });
      expect(Object.values(state.generations)).toHaveLength(1);
    } finally {
      store.close();
    }
  });


  it("rejects direct verification admission when transcript authority changes after interpretation", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-euclid-primes");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("31 is congruent to 1 modulo 5.");

      const profile = resolveOxfordFormalAnalysisProfile(selectedProblem);
      if (profile === undefined) throw new Error("Missing Oxford formal profile");
      const request = createCommittedTurnFormalInterpretationRequest(writer, {
        inputEpisodeId: committed.inputEpisodeId,
        turnId: committed.turnId,
        target: profile.target,
        allowedProtocols: profile.allowedProtocols
      });
      const verifier = profile.scopes[0]?.verifier;
      if (verifier === undefined) throw new Error("Missing verifier scope");
      const staleEnvelope = createCommandEnvelope({
        sessionId,
        producer: "interpretation-coordinator",
        inputEpisodeId: committed.inputEpisodeId,
        turnId: committed.turnId,
        contextEpoch: request.basis.contextEpoch,
        sourceRevision: request.source.sourceRevision
      });

      await turns.correctTranscript("The corrected transcript supersedes the interpreted wording.");

      await expect(new VerificationCoordinator(writer, profile.scopes).requestVerification({
        inputEpisodeId: committed.inputEpisodeId,
        turnId: committed.turnId,
        verifier,
        candidateFormalInterpretation: statementFor(request, "CORRECT"),
        interpretationConfidence: 1,
        evidenceKey: profile.target,
        expectedProblemVersion: selectedProblem.version,
        envelope: staleEnvelope
      })).rejects.toThrow("Verification source basis changed before durable admission");
      expect(Object.values(writer.getState().verificationRequests)).toHaveLength(0);
      expect(Object.values(writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("keeps direct text analysis idempotent across board-only changes and process-local coordinator restart", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-triangle-medians");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("The exact ratio arithmetic is 1/2 = 2/4.");
      const sessions = new SessionRecoveryCoordinator(registry, store);
      const provider = deterministicProvider("CORRECT");

      const first = await new StudentReasoningAnalysisCoordinator(
        sessions,
        provider
      ).analyze({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId
      });
      expect(first.status).toBe("ANALYZED");

      const boardCommit = await turns.commitBoardMutation({
        baseBoardRevision: writer.getState().boardRevision,
        added: [{
          id: "board-only-idempotency-shape",
          type: "text",
          bounds: { x: 10, y: 10, width: 100, height: 24 },
          text: "board note",
          revision: 1,
          createdAt: 1,
          lastModifiedAt: 1
        }],
        updated: [],
        deleted: []
      });
      expect(boardCommit.committed).toBe(true);

      const second = await new StudentReasoningAnalysisCoordinator(
        sessions,
        provider
      ).analyze({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId
      });
      expect(second.status).toBe("ANALYZED");
      if (second.status !== "ANALYZED") throw new Error("Expected duplicate analysis");
      expect(second.interpretation).toMatchObject({
        status: "ACCEPTED",
        verificationStatus: "VERIFIED",
        duplicateVerificationRequest: true
      });
      expect(provider.callCount).toBe(2);

      const profile = resolveOxfordFormalAnalysisProfile(selectedProblem);
      if (profile === undefined) throw new Error("Missing Oxford formal profile");
      const state = writer.getState();
      expect(Object.values(state.verificationRequests)).toHaveLength(1);
      expect(state.evidenceHistory[evidenceKeyToString(profile.target)]).toHaveLength(1);
    } finally {
      store.close();
    }
  });


  it("fails closed when the session completes while direct interpretation is still pending", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-euclid-primes");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("The product-plus-one remainder claim is one.");

      let capturedRequest: FormalInterpretationRequest | undefined;
      let releaseProvider: ((value: unknown) => void) | undefined;
      let signalProviderStarted: (() => void) | undefined;
      const providerStarted = new Promise<void>((resolve) => {
        signalProviderStarted = resolve;
      });
      const provider: FormalInterpretationProvider = {
        interpret(request) {
          capturedRequest = request;
          signalProviderStarted?.();
          return new Promise((resolve) => {
            releaseProvider = resolve;
          });
        }
      };
      const analysis = new StudentReasoningAnalysisCoordinator(
        new SessionRecoveryCoordinator(registry, store),
        provider,
        5_000
      );
      const pending = analysis.analyze({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId
      });

      await providerStarted;
      await turns.completeSession();
      if (capturedRequest === undefined || releaseProvider === undefined) {
        throw new Error("Provider did not receive the formal request");
      }
      releaseProvider(interpretationResult(capturedRequest, "CORRECT"));

      const outcome = await pending;
      expect(outcome.status).toBe("ANALYZED");
      if (outcome.status !== "ANALYZED") throw new Error("Expected analysis");
      expect(outcome.interpretation).toMatchObject({
        status: "STALE",
        reason: "SESSION_NOT_ACTIVE"
      });
      expect(Object.values(writer.getState().verificationRequests)).toHaveLength(0);
      expect(Object.values(writer.getState().studentEvidence)).toHaveLength(0);
    } finally {
      store.close();
    }
  });


  it("does not select pedagogy from a turn whose text context changes during live analysis", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const registry = new SessionRuntimeRegistry(store);
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      const selectedProblem = problem("oxford-euclid-primes");
      await turns.startSession(selectedProblem);
      const committed = await turns.commitInput("For every listed prime the Euclid number leaves remainder one.");

      let capturedRequest: FormalInterpretationRequest | undefined;
      let releaseProvider: ((value: unknown) => void) | undefined;
      let signalProviderStarted: (() => void) | undefined;
      const providerStarted = new Promise<void>((resolve) => {
        signalProviderStarted = resolve;
      });
      const provider: FormalInterpretationProvider = {
        interpret(request) {
          capturedRequest = request;
          signalProviderStarted?.();
          return new Promise((resolve) => {
            releaseProvider = resolve;
          });
        }
      };
      const orchestrator = new ServerTurnOrchestrator(
        new SessionRecoveryCoordinator(registry, store),
        () => undefined,
        undefined,
        undefined,
        provider
      );
      const orchestration = orchestrator.orchestrateTurn({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId,
        studentText: writer.getState().turns[committed.turnId]?.studentText ?? ""
      });

      await providerStarted;
      await turns.correctTranscript("The corrected transcript invalidates the earlier interpretation.");
      if (capturedRequest === undefined || releaseProvider === undefined) {
        throw new Error("Provider did not receive the formal request");
      }
      releaseProvider(interpretationResult(capturedRequest, "CORRECT"));
      await orchestration;

      const state = writer.getState();
      expect(state.pedagogicalActions[committed.turnId]).toBeUndefined();
      expect(Object.values(state.verificationRequests)).toHaveLength(0);
      expect(Object.values(state.studentEvidence)).toHaveLength(0);
      expect(Object.values(state.generations)).toHaveLength(0);
      expect(Object.values(state.deliveries)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

});

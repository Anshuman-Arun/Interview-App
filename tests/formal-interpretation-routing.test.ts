import { describe, expect, it } from "vitest";
import {
  FormalInterpretationRequestSchema,
  InterpretationProviderResultSchema,
  newRequestId,
  type EvidenceKey,
  type FormalInterpretationCandidate,
  type FormalInterpretationRequest,
  type FormalProtocolRef
} from "../packages/domain/src/index.js";
import {
  DeterministicFormalInterpretationProvider,
  FormalProtocolRoutingRegistry,
  InterpretationCoordinator,
  VerificationCoordinator,
  createCommandEnvelope,
  createFormalInterpretationRequest,
  echoInterpretationCandidateSource,
  providerResultFor
} from "../packages/interview-engine/src/index.js";
import {
  COMBINATORIAL_COUNTING_PROTOCOL,
  COMBINATORIAL_COUNTING_VERIFIER_NAME,
  DETERMINISTIC_MATH_VERIFIERS,
  FINITE_RECURRENCE_PROTOCOL,
  FINITE_RECURRENCE_VERIFIER_NAME,
  MODULAR_ARITHMETIC_PROTOCOL,
  MODULAR_ARITHMETIC_VERIFIER_NAME,
  ModularArithmeticVerifier,
  PROBABILITY_ARITHMETIC_PROTOCOL,
  PROBABILITY_ARITHMETIC_VERIFIER_NAME,
  RATIONAL_ARITHMETIC_PROTOCOL,
  RATIONAL_ARITHMETIC_VERIFIER_NAME
} from "../packages/verification/src/index.js";
import { createCoreHarness, type CoreHarness } from "./harness.js";

const claimEvidenceKey: EvidenceKey = {
  problemId: "oxford-six-people",
  subject: { kind: "CLAIM", claimId: "eta-formal-math-claim" },
  dimension: "CORRECTNESS"
};

const routingScopes = DETERMINISTIC_MATH_VERIFIERS.map((entry) => ({
  verifier: entry.verifier,
  evidenceKey: claimEvidenceKey
}));

function formalRequest(
  harness: CoreHarness,
  allowedProtocols: readonly FormalProtocolRef[] = [{ protocol: "MODULAR_ARITHMETIC", version: 1 }],
  requestId = newRequestId()
): FormalInterpretationRequest {
  return createFormalInterpretationRequest(harness.writer, {
    generationId: harness.generationId,
    target: claimEvidenceKey,
    allowedProtocols,
    requestId
  });
}

function candidate(
  request: FormalInterpretationRequest,
  input: {
    readonly candidateId?: string;
    readonly protocol?: FormalProtocolRef;
    readonly statement?: string;
    readonly confidence?: number;
  } = {}
): FormalInterpretationCandidate {
  return {
    protocolVersion: 1,
    candidateId: input.candidateId ?? "candidate-1",
    protocol: input.protocol ?? { protocol: "MODULAR_ARITHMETIC", version: 1 },
    formalStatement: input.statement ?? modularStatement("2", "4"),
    confidence: input.confidence ?? 1,
    target: request.target,
    source: echoInterpretationCandidateSource(request)
  };
}

function modularStatement(divisor: string, dividend: string): string {
  return JSON.stringify({
    protocol: MODULAR_ARITHMETIC_PROTOCOL,
    protocolVersion: 1,
    claim: {
      kind: "DIVISIBILITY",
      divisor,
      dividend: { kind: "INTEGER", value: dividend }
    }
  });
}

function rationalLiteral(numerator: string, denominator = "1") {
  return { kind: "RATIONAL" as const, value: { numerator, denominator } };
}

function rationalStatement(): string {
  return JSON.stringify({
    protocol: RATIONAL_ARITHMETIC_PROTOCOL,
    protocolVersion: 1,
    claim: {
      kind: "EQUALITY",
      left: rationalLiteral("1", "2"),
      right: rationalLiteral("2", "4")
    }
  });
}

function unresolvedRationalStatement(): string {
  return JSON.stringify({
    protocol: RATIONAL_ARITHMETIC_PROTOCOL,
    protocolVersion: 1,
    claim: {
      kind: "EQUALITY",
      left: {
        kind: "DIVIDE",
        left: rationalLiteral("1"),
        right: rationalLiteral("0")
      },
      right: rationalLiteral("0")
    }
  });
}

function recurrenceStatement(): string {
  return JSON.stringify({
    protocol: FINITE_RECURRENCE_PROTOCOL,
    protocolVersion: 1,
    initial: [{ numerator: "1", denominator: "1" }],
    recurrence: {
      kind: "LINEAR_PREVIOUS_TERMS",
      coefficients: [{ numerator: "1", denominator: "1" }],
      constant: { numerator: "1", denominator: "1" }
    },
    claim: {
      kind: "VALUE_AT_INDEX",
      index: 2,
      value: { numerator: "3", denominator: "1" }
    }
  });
}

function countingStatement(): string {
  return JSON.stringify({
    protocol: COMBINATORIAL_COUNTING_PROTOCOL,
    protocolVersion: 1,
    claim: { kind: "BINOMIAL", n: 5, k: 2, claimed: "10" }
  });
}

function probabilityStatement(): string {
  return JSON.stringify({
    protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
    protocolVersion: 1,
    claim: {
      kind: "CONDITIONAL_FROM_COUNTS",
      jointCount: 2,
      conditionCount: 3,
      claimedProbability: { numerator: "2", denominator: "3" }
    }
  });
}

describe("formal interpretation request and provider validation", () => {
  it("builds a bounded request from authoritative references instead of a transcript", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      expect(FormalInterpretationRequestSchema.parse(request)).toEqual(request);
      expect(request.problem).toEqual({ id: "oxford-six-people", version: harness.writer.getState().problem?.version });
      expect(request.source.span.text).toBe("I have a claim, but I have not justified it yet.");
      expect(request.source.eventIds).toHaveLength(1);
      expect(request).not.toHaveProperty("transcript");
      expect(request.target).toEqual(claimEvidenceKey);
    } finally {
      harness.store.close();
    }
  });

  it("rejects unknown request fields, malformed evidence scope, and overlong source text", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      expect(FormalInterpretationRequestSchema.safeParse({ ...request, injectedAuthority: true }).success).toBe(false);
      expect(FormalInterpretationRequestSchema.safeParse({
        ...request,
        target: { ...request.target, dimension: "UNDERSTANDING" }
      }).success).toBe(false);
      expect(FormalInterpretationRequestSchema.safeParse({
        ...request,
        source: {
          ...request.source,
          span: { start: 0, end: 4097, text: "x".repeat(4097) }
        }
      }).success).toBe(false);
    } finally {
      harness.store.close();
    }
  });

  it("rejects NaN, infinity, enormous candidate lists, duplicate IDs, and unknown candidate fields", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      const base = candidate(request);
      expect(InterpretationProviderResultSchema.safeParse(providerResultFor(request, [{ ...base, confidence: Number.NaN } as FormalInterpretationCandidate])).success).toBe(false);
      expect(InterpretationProviderResultSchema.safeParse({
        protocolVersion: 1,
        requestId: request.requestId,
        candidates: [{ ...base, confidence: Number.POSITIVE_INFINITY }]
      }).success).toBe(false);
      expect(InterpretationProviderResultSchema.safeParse({
        protocolVersion: 1,
        requestId: request.requestId,
        candidates: Array.from({ length: 9 }, (_, index) => ({ ...base, candidateId: `candidate-${String(index)}` }))
      }).success).toBe(false);
      expect(InterpretationProviderResultSchema.safeParse({
        protocolVersion: 1,
        requestId: request.requestId,
        candidates: [base, { ...base }]
      }).success).toBe(false);
      expect(InterpretationProviderResultSchema.safeParse({
        protocolVersion: 1,
        requestId: request.requestId,
        candidates: [{ ...base, verifier: "attacker-selected-verifier@1" }]
      }).success).toBe(false);
    } finally {
      harness.store.close();
    }
  });
});

describe("formal protocol routing and ambiguity", () => {
  it("routes every merged deterministic verifier family through the application registry", async () => {
    const cases = [
      {
        protocol: { protocol: "MODULAR_ARITHMETIC", version: 1 } satisfies FormalProtocolRef,
        statement: modularStatement("2", "4"),
        verifier: MODULAR_ARITHMETIC_VERIFIER_NAME
      },
      {
        protocol: { protocol: "RATIONAL_ARITHMETIC", version: 1 } satisfies FormalProtocolRef,
        statement: rationalStatement(),
        verifier: RATIONAL_ARITHMETIC_VERIFIER_NAME
      },
      {
        protocol: { protocol: "FINITE_RECURRENCE", version: 1 } satisfies FormalProtocolRef,
        statement: recurrenceStatement(),
        verifier: FINITE_RECURRENCE_VERIFIER_NAME
      },
      {
        protocol: { protocol: "COMBINATORIAL_COUNTING", version: 1 } satisfies FormalProtocolRef,
        statement: countingStatement(),
        verifier: COMBINATORIAL_COUNTING_VERIFIER_NAME
      },
      {
        protocol: { protocol: "PROBABILITY_ARITHMETIC", version: 1 } satisfies FormalProtocolRef,
        statement: probabilityStatement(),
        verifier: PROBABILITY_ARITHMETIC_VERIFIER_NAME
      }
    ] as const;

    for (const testCase of cases) {
      const harness = await createCoreHarness();
      try {
        const request = formalRequest(harness, [testCase.protocol]);
        const provider = new DeterministicFormalInterpretationProvider(
          providerResultFor(request, [candidate(request, {
            protocol: testCase.protocol,
            statement: testCase.statement
          })])
        );
        const result = await new InterpretationCoordinator(harness.writer, provider, routingScopes)
          .interpretAndVerify(request);
        expect(result).toMatchObject({
          status: "ACCEPTED",
          verifier: testCase.verifier,
          verificationStatus: "VERIFIED"
        });
        expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(1);
      } finally {
        harness.store.close();
      }
    }
  });

  it("abstains on materially distinct candidates instead of selecting highest confidence", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [
        candidate(request, { candidateId: "high", statement: modularStatement("2", "4"), confidence: 1 }),
        candidate(request, { candidateId: "lower", statement: modularStatement("3", "6"), confidence: 0.8 })
      ]));
      const result = await new InterpretationCoordinator(harness.writer, provider, routingScopes).interpretAndVerify(request);
      expect(result).toMatchObject({ status: "AMBIGUOUS", reason: "AMBIGUOUS_MULTIPLE" });
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("collapses identical normalized candidates and retains the conservative minimum confidence", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      const parsed = JSON.parse(modularStatement("2", "4")) as {
        protocol: string;
        protocolVersion: number;
        claim: unknown;
      };
      const reordered = JSON.stringify({
        claim: parsed.claim,
        protocolVersion: parsed.protocolVersion,
        protocol: parsed.protocol
      });

      const acceptedProvider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [
        candidate(request, { candidateId: "z", statement: modularStatement("2", "4") }),
        candidate(request, { candidateId: "a", statement: reordered })
      ]));
      const accepted = await new InterpretationCoordinator(harness.writer, acceptedProvider, routingScopes)
        .interpretAndVerify(request);
      expect(accepted).toMatchObject({ status: "ACCEPTED", candidateId: "a", verificationStatus: "VERIFIED" });
    } finally {
      harness.store.close();
    }

    const conservativeHarness = await createCoreHarness();
    try {
      const request = formalRequest(conservativeHarness);
      const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [
        candidate(request, { candidateId: "one", confidence: 1 }),
        candidate(request, { candidateId: "two", confidence: 0.7 })
      ]));
      const result = await new InterpretationCoordinator(conservativeHarness.writer, provider, routingScopes)
        .interpretAndVerify(request);
      expect(result).toMatchObject({
        status: "NO_SUPPORTED_INTERPRETATION",
        reason: "INSUFFICIENT_CONFIDENCE"
      });
      expect(Object.values(conservativeHarness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      conservativeHarness.store.close();
    }
  });

  it("distinguishes unsupported protocol, unavailable verifier, unauthorized scope, and protocol mismatch", async () => {
    const unsupportedHarness = await createCoreHarness();
    try {
      const request = formalRequest(unsupportedHarness, [{ protocol: "ARBITRARY_THEOREM_PROVER", version: 1 }]);
      const provider = new DeterministicFormalInterpretationProvider({ protocolVersion: 1, requestId: request.requestId, candidates: [] });
      const result = await new InterpretationCoordinator(unsupportedHarness.writer, provider, routingScopes).interpretAndVerify(request);
      expect(result).toMatchObject({ status: "UNSUPPORTED_PROTOCOL", reason: "UNSUPPORTED_REQUEST_PROTOCOL" });
      expect(provider.callCount).toBe(0);
    } finally {
      unsupportedHarness.store.close();
    }

    const unavailableHarness = await createCoreHarness();
    try {
      const request = formalRequest(unavailableHarness);
      const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [candidate(request)]));
      const router = new FormalProtocolRoutingRegistry(routingScopes, undefined, []);
      const result = await new InterpretationCoordinator(unavailableHarness.writer, provider, routingScopes, { router })
        .interpretAndVerify(request);
      expect(result).toMatchObject({ status: "VERIFIER_UNAVAILABLE", reason: "VERIFIER_MISSING" });
    } finally {
      unavailableHarness.store.close();
    }

    const unauthorizedHarness = await createCoreHarness();
    try {
      const request = formalRequest(unauthorizedHarness);
      const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [candidate(request)]));
      const result = await new InterpretationCoordinator(unauthorizedHarness.writer, provider, [])
        .interpretAndVerify(request);
      expect(result).toMatchObject({ status: "VERIFIER_UNAUTHORIZED", reason: "VERIFIER_SCOPE_UNAUTHORIZED" });
    } finally {
      unauthorizedHarness.store.close();
    }

    const mismatchHarness = await createCoreHarness();
    try {
      const request = formalRequest(mismatchHarness);
      const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [
        candidate(request, { statement: rationalStatement() })
      ]));
      const result = await new InterpretationCoordinator(mismatchHarness.writer, provider, routingScopes)
        .interpretAndVerify(request);
      expect(result).toMatchObject({ status: "INVALID_PROPOSAL", reason: "PROTOCOL_MISMATCH" });
      expect(Object.values(mismatchHarness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      mismatchHarness.store.close();
    }
  });

  it("rejects provider attempts to change source, target, or inject a verifier", async () => {
    const sourceHarness = await createCoreHarness();
    try {
      const request = formalRequest(sourceHarness);
      const wrong = candidate(request);
      const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [{
        ...wrong,
        source: { ...wrong.source, sourceRevision: wrong.source.sourceRevision + 1 }
      }]));
      const result = await new InterpretationCoordinator(sourceHarness.writer, provider, routingScopes).interpretAndVerify(request);
      expect(result).toMatchObject({ status: "SOURCE_MISMATCH", reason: "CANDIDATE_SOURCE_MISMATCH" });
    } finally {
      sourceHarness.store.close();
    }

    const targetHarness = await createCoreHarness();
    try {
      const request = formalRequest(targetHarness);
      const wrongTarget = {
        ...request.target,
        subject: { kind: "CLAIM" as const, claimId: "different-claim" }
      };
      const provider = new DeterministicFormalInterpretationProvider({
        protocolVersion: 1,
        requestId: request.requestId,
        candidates: [{ ...candidate(request), target: wrongTarget }]
      });
      const result = await new InterpretationCoordinator(targetHarness.writer, provider, routingScopes).interpretAndVerify(request);
      expect(result).toMatchObject({ status: "TARGET_MISMATCH", reason: "CANDIDATE_TARGET_MISMATCH" });
    } finally {
      targetHarness.store.close();
    }

    const injectedHarness = await createCoreHarness();
    try {
      const request = formalRequest(injectedHarness);
      const provider = new DeterministicFormalInterpretationProvider({
        protocolVersion: 1,
        requestId: request.requestId,
        candidates: [{ ...candidate(request), verifier: "attacker-selected-verifier@1" }]
      });
      const result = await new InterpretationCoordinator(injectedHarness.writer, provider, routingScopes)
        .interpretAndVerify(request);
      expect(result).toMatchObject({ status: "INVALID_PROVIDER_OUTPUT", reason: "MALFORMED_PROVIDER_RESULT" });
      expect(Object.values(injectedHarness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      injectedHarness.store.close();
    }
  });
});

describe("interpretation confidence and deterministic result semantics", () => {
  it("does not dispatch a low-confidence single interpretation", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [
        candidate(request, { confidence: 0.999 })
      ]));
      const result = await new InterpretationCoordinator(harness.writer, provider, routingScopes).interpretAndVerify(request);
      expect(result).toMatchObject({
        status: "NO_SUPPORTED_INTERPRETATION",
        reason: "INSUFFICIENT_CONFIDENCE"
      });
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("preserves VERIFIED, CONTRADICTED, and verifier-level UNRESOLVED", async () => {
    const cases = [
      {
        protocol: { protocol: "MODULAR_ARITHMETIC", version: 1 } satisfies FormalProtocolRef,
        statement: modularStatement("2", "4"),
        expected: "VERIFIED"
      },
      {
        protocol: { protocol: "MODULAR_ARITHMETIC", version: 1 } satisfies FormalProtocolRef,
        statement: modularStatement("2", "3"),
        expected: "CONTRADICTED"
      },
      {
        protocol: { protocol: "RATIONAL_ARITHMETIC", version: 1 } satisfies FormalProtocolRef,
        statement: unresolvedRationalStatement(),
        expected: "UNRESOLVED"
      }
    ] as const;

    for (const testCase of cases) {
      const harness = await createCoreHarness();
      try {
        const request = formalRequest(harness, [testCase.protocol]);
        const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [
          candidate(request, { protocol: testCase.protocol, statement: testCase.statement })
        ]));
        const result = await new InterpretationCoordinator(harness.writer, provider, routingScopes).interpretAndVerify(request);
        expect(result).toMatchObject({ status: "ACCEPTED", verificationStatus: testCase.expected });
      } finally {
        harness.store.close();
      }
    }
  });
});

describe("staleness, terminal sessions, idempotency, and races", () => {
  it("fails closed after board revision, transcript/context change, or explicit supersession", async () => {
    for (const mutation of ["BOARD", "TRANSCRIPT", "SUPERSEDE"] as const) {
      const harness = await createCoreHarness();
      try {
        const request = formalRequest(harness);
        if (mutation === "BOARD") await harness.turns.commitBoardPatch("basis-changing patch");
        if (mutation === "TRANSCRIPT") await harness.turns.correctTranscript("corrected source");
        if (mutation === "SUPERSEDE") await harness.turns.supersedeGeneration(harness.generationId, "test supersession");
        const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [candidate(request)]));
        const result = await new InterpretationCoordinator(harness.writer, provider, routingScopes).interpretAndVerify(request);
        expect(result.status).toBe("STALE");
        expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
      } finally {
        harness.store.close();
      }
    }
  });

  it("rejects a late callback after basis changes during provider inference", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      let release: ((value: unknown) => void) | undefined;
      const pending = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      const provider = new DeterministicFormalInterpretationProvider(async () => pending);
      const coordinator = new InterpretationCoordinator(harness.writer, provider, routingScopes);
      const execution = coordinator.interpretAndVerify(request);
      await harness.turns.commitBoardPatch("changed while provider was running");
      if (release === undefined) throw new Error("Expected delayed provider release function");
      release(providerResultFor(request, [candidate(request)]));
      const result = await execution;
      expect(result).toMatchObject({ status: "STALE", reason: "BASIS_INCOMPATIBLE" });
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("rejects a late callback after the session completes", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      let release: ((value: unknown) => void) | undefined;
      const pending = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      const provider = new DeterministicFormalInterpretationProvider(async () => pending);
      const coordinator = new InterpretationCoordinator(harness.writer, provider, routingScopes);
      const execution = coordinator.interpretAndVerify(request);
      await harness.turns.completeSession();
      if (release === undefined) throw new Error("Expected delayed provider release function");
      release(providerResultFor(request, [candidate(request)]));
      const result = await execution;
      expect(result).toMatchObject({ status: "STALE", reason: "SESSION_NOT_ACTIVE" });
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("deduplicates same request retries and durably rejects conflicting request reuse", async () => {
    const harness = await createCoreHarness();
    try {
      const requestId = newRequestId();
      const request = formalRequest(harness, [{ protocol: "MODULAR_ARITHMETIC", version: 1 }], requestId);
      const provider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [candidate(request)]));
      const coordinator = new InterpretationCoordinator(harness.writer, provider, routingScopes);
      const firstPromise = coordinator.interpretAndVerify(request);
      const duplicatePromise = coordinator.interpretAndVerify(request);
      expect(duplicatePromise).toBe(firstPromise);
      const first = await firstPromise;
      const duplicate = await duplicatePromise;
      expect(duplicate).toEqual(first);
      expect(provider.callCount).toBe(1);
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(1);

      const replayProvider = new DeterministicFormalInterpretationProvider(providerResultFor(request, [candidate(request)]));
      const replay = await new InterpretationCoordinator(harness.writer, replayProvider, routingScopes)
        .interpretAndVerify(request);
      expect(replay).toMatchObject({ status: "ACCEPTED", duplicateVerificationRequest: true });
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(1);

      const conflictingRequest: FormalInterpretationRequest = {
        ...request,
        allowedProtocols: [{ protocol: "RATIONAL_ARITHMETIC", version: 1 }]
      };
      const conflictingProvider = new DeterministicFormalInterpretationProvider(providerResultFor(conflictingRequest, [
        candidate(conflictingRequest, {
          protocol: { protocol: "RATIONAL_ARITHMETIC", version: 1 },
          statement: rationalStatement()
        })
      ]));
      const conflict = await new InterpretationCoordinator(harness.writer, conflictingProvider, routingScopes)
        .interpretAndVerify(conflictingRequest);
      expect(conflict).toMatchObject({ status: "INVALID_REQUEST", reason: "REQUEST_ID_CONFLICT" });
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(1);
    } finally {
      harness.store.close();
    }
  });

  it("cancels provider inference without opening verification and bounds simultaneous work", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      const secondRequest = { ...request, requestId: newRequestId() };
      let release: ((value: unknown) => void) | undefined;
      const pending = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      const provider = new DeterministicFormalInterpretationProvider(async () => pending);
      const coordinator = new InterpretationCoordinator(harness.writer, provider, routingScopes, { maxInFlight: 1 });
      const first = coordinator.interpretAndVerify(request);
      const capacity = await coordinator.interpretAndVerify(secondRequest);
      expect(capacity).toMatchObject({ status: "RESOURCE_LIMIT", reason: "IN_FLIGHT_LIMIT" });
      expect(coordinator.cancel(request.requestId)).toBe(true);
      if (release === undefined) throw new Error("Expected delayed provider release function");
      release(providerResultFor(request, [candidate(request)]));
      expect(await first).toMatchObject({ status: "STALE", reason: "CANCELLED" });
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("makes VerificationCoordinator terminal-session admission atomic for requests and results", async () => {
    const closedHarness = await createCoreHarness();
    try {
      const request = formalRequest(closedHarness);
      await closedHarness.turns.completeSession();
      const verification = new VerificationCoordinator(closedHarness.writer, [{
        verifier: MODULAR_ARITHMETIC_VERIFIER_NAME,
        evidenceKey: claimEvidenceKey
      }]);
      const result = await verification.requestVerificationFromProposal({
        envelope: createCommandEnvelope({
          sessionId: closedHarness.sessionId,
          producer: "test-interpreter",
          generationId: closedHarness.generationId,
          inputEpisodeId: closedHarness.inputEpisodeId,
          turnId: closedHarness.turnId,
          contextEpoch: request.basis.contextEpoch,
          sourceRevision: request.basis.committedInputSequence
        }),
        proposal: {
          candidateFormalInterpretation: modularStatement("2", "4"),
          interpretationConfidence: 1
        },
        verifier: MODULAR_ARITHMETIC_VERIFIER_NAME,
        evidenceKey: claimEvidenceKey,
        expectedProblemVersion: request.problem.version
      });
      expect(result.value).toMatchObject({ accepted: false, reason: "SESSION_NOT_ACTIVE" });
    } finally {
      closedHarness.store.close();
    }

    const resultHarness = await createCoreHarness();
    try {
      const request = formalRequest(resultHarness);
      const verification = new VerificationCoordinator(resultHarness.writer, [{
        verifier: MODULAR_ARITHMETIC_VERIFIER_NAME,
        evidenceKey: claimEvidenceKey
      }]);
      const admitted = await verification.requestVerificationFromProposal({
        envelope: createCommandEnvelope({
          sessionId: resultHarness.sessionId,
          producer: "test-interpreter",
          generationId: resultHarness.generationId,
          inputEpisodeId: resultHarness.inputEpisodeId,
          turnId: resultHarness.turnId,
          contextEpoch: request.basis.contextEpoch,
          sourceRevision: request.basis.committedInputSequence
        }),
        proposal: {
          candidateFormalInterpretation: modularStatement("2", "4"),
          interpretationConfidence: 1
        },
        verifier: MODULAR_ARITHMETIC_VERIFIER_NAME,
        evidenceKey: claimEvidenceKey,
        expectedProblemVersion: request.problem.version
      });
      if (!admitted.value.accepted) throw new Error("Expected verification request admission");
      const verifier = new ModularArithmeticVerifier();
      const verifierResult = await verifier.verify(
        admitted.value.workItem.candidateFormalInterpretation,
        admitted.value.workItem.interpretationConfidence
      );
      await resultHarness.turns.completeSession();
      const processed = await verification.processResult({
        envelope: createCommandEnvelope({
          sessionId: resultHarness.sessionId,
          producer: "deterministic-verifier",
          correlationId: admitted.value.workItem.verificationRequestId,
          inputEpisodeId: resultHarness.inputEpisodeId,
          turnId: resultHarness.turnId,
          contextEpoch: admitted.value.workItem.basis.contextEpoch,
          sourceRevision: admitted.value.workItem.basis.committedInputSequence
        }),
        result: verifierResult,
        verifier
      });
      expect(processed.value).toMatchObject({ accepted: false, reason: "SESSION_NOT_ACTIVE" });
      expect(resultHarness.writer.getState().verificationRequests[admitted.value.workItem.verificationRequestId])
        .toMatchObject({ status: "DISCARDED", discardReason: "SESSION_NOT_ACTIVE" });
    } finally {
      resultHarness.store.close();
    }
  });
});

describe("privacy-safe diagnostics", () => {
  it("does not leak provider exceptions or raw malformed provider content", async () => {
    const harness = await createCoreHarness();
    try {
      const request = formalRequest(harness);
      const provider = new DeterministicFormalInterpretationProvider(() => {
        throw new Error("SECRET_CANONICAL_SOLUTION_SHOULD_NOT_LEAK");
      });
      const coordinator = new InterpretationCoordinator(harness.writer, provider, routingScopes);
      const result = await coordinator.interpretAndVerify(request);
      expect(result).toMatchObject({ status: "INVALID_PROVIDER_OUTPUT", reason: "PROVIDER_FAILURE" });
      expect(JSON.stringify(result)).not.toContain("SECRET_CANONICAL_SOLUTION_SHOULD_NOT_LEAK");
      expect(JSON.stringify(coordinator.getDiagnostics())).not.toContain("SECRET_CANONICAL_SOLUTION_SHOULD_NOT_LEAK");
      expect(coordinator.getDiagnostics().every((diagnostic) => !("sourceText" in diagnostic))).toBe(true);
    } finally {
      harness.store.close();
    }
  });
});

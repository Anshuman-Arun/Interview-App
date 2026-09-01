import { describe, expect, it } from "vitest";
import { VerificationResultSchema, type DeterministicVerifier } from "../packages/domain/src/index.js";
import {
  COMBINATORIAL_COUNTING_PROTOCOL,
  COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
  COMBINATORIAL_COUNTING_VERIFIER_NAME,
  CombinatorialCountingVerifier,
  FINITE_RECURRENCE_PROTOCOL,
  FINITE_RECURRENCE_PROTOCOL_VERSION,
  FINITE_RECURRENCE_VERIFIER_NAME,
  FiniteRecurrenceVerifier
} from "../packages/verification/src/index.js";

const rational = (numerator: string, denominator = "1") => ({ numerator, denominator });

async function verifyJson(verifier: DeterministicVerifier, value: unknown) {
  const result = await verifier.verify(JSON.stringify(value), 1);
  expect(VerificationResultSchema.parse(result)).toEqual(result);
  return result;
}

describe("finite recurrence verifier", () => {
  const fibonacciBase = {
    protocol: FINITE_RECURRENCE_PROTOCOL,
    protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
    initial: [rational("0"), rational("1")],
    recurrence: {
      kind: "LINEAR_PREVIOUS_TERMS" as const,
      coefficients: [rational("1"), rational("1")],
      constant: rational("0")
    }
  };

  it("verifies a finite indexed recurrence value", async () => {
    const result = await verifyJson(new FiniteRecurrenceVerifier(), {
      ...fibonacciBase,
      claim: { kind: "VALUE_AT_INDEX", index: 10, value: rational("55") }
    });
    expect(result).toMatchObject({ status: "VERIFIED", verifier: FINITE_RECURRENCE_VERIFIER_NAME });
  });

  it("contradicts a wrong prefix and abstains on inconsistent recurrence order", async () => {
    const wrong = await verifyJson(new FiniteRecurrenceVerifier(), {
      ...fibonacciBase,
      claim: {
        kind: "GENERATED_PREFIX",
        values: ["0", "1", "1", "2", "4"].map((value) => rational(value))
      }
    });
    expect(wrong.status).toBe("CONTRADICTED");

    const malformed = await verifyJson(new FiniteRecurrenceVerifier(), {
      ...fibonacciBase,
      recurrence: { ...fibonacciBase.recurrence, coefficients: [rational("1")] },
      claim: { kind: "VALUE_AT_INDEX", index: 3, value: rational("2") }
    });
    expect(malformed.status).toBe("UNRESOLVED");
    expect(malformed.reason).toContain("MALFORMED_INTERPRETATION");
  });
});

describe("combinatorial counting verifier", () => {
  it("checks exact standard counting formulas", async () => {
    const verifier = new CombinatorialCountingVerifier();
    const claims = [
      { kind: "BINOMIAL", n: 10, k: 3, claimed: "120" },
      { kind: "PERMUTATION", n: 5, k: 3, claimed: "60" },
      { kind: "COMBINATIONS_WITH_REPETITION", types: 4, selections: 3, claimed: "20" },
      { kind: "INCLUSION_EXCLUSION_TWO", leftCount: 10, rightCount: 8, intersectionCount: 3, claimedUnionCount: "15" }
    ];
    for (const claim of claims) {
      const result = await verifyJson(verifier, {
        protocol: COMBINATORIAL_COUNTING_PROTOCOL,
        protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
        claim
      });
      expect(result).toMatchObject({ status: "VERIFIED", verifier: COMBINATORIAL_COUNTING_VERIFIER_NAME });
    }

    const wrong = await verifyJson(verifier, {
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: { kind: "BINOMIAL", n: 10, k: 3, claimed: "121" }
    });
    expect(wrong.status).toBe("CONTRADICTED");
  });

  it("abstains on impossible two-set inclusion/exclusion inputs", async () => {
    const result = await verifyJson(new CombinatorialCountingVerifier(), {
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: {
        kind: "INCLUSION_EXCLUSION_TWO",
        leftCount: 2,
        rightCount: 5,
        intersectionCount: 3,
        claimedUnionCount: "4"
      }
    });
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reason).toContain("MALFORMED_INTERPRETATION");
  });

  it("abstains rather than treating unsupported counting operations as false", async () => {
    const result = await verifyJson(new CombinatorialCountingVerifier(), {
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: { kind: "STIRLING_NUMBER", n: 8, k: 3, claimed: "966" }
    });
    expect(result.status).toBe("UNRESOLVED");
  });
});

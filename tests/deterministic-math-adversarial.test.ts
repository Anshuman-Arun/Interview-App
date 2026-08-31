import { describe, expect, it } from "vitest";
import {
  BoundedMathError,
  COMBINATORIAL_COUNTING_PROTOCOL,
  COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
  CombinatorialCountingVerifier,
  DETERMINISTIC_MATH_VERIFIERS,
  FINITE_RECURRENCE_PROTOCOL,
  FINITE_RECURRENCE_PROTOCOL_VERSION,
  FiniteRecurrenceVerifier,
  IntegerStringSchema,
  MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS,
  MAX_POWER_EXPONENT,
  MAX_PROBABILITY_OUTCOMES,
  MAX_RECURRENCE_SEQUENCE_LENGTH,
  MODULAR_ARITHMETIC_PROTOCOL,
  MODULAR_ARITHMETIC_PROTOCOL_VERSION,
  ModularArithmeticVerifier,
  PROBABILITY_ARITHMETIC_PROTOCOL,
  PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
  ProbabilityArithmeticVerifier,
  createDeterministicMathVerifier,
  equalRationals,
  evaluateIntegerExpression,
  gcd,
  multiplyRationals,
  parseBoundedInteger,
  rational,
  serializeRational,
  type ExactRational,
  type IntegerExpression
} from "../packages/verification/src/index.js";

const integer = (value: string) => ({ kind: "INTEGER" as const, value });
const fraction = (numerator: string, denominator = "1") => ({ numerator, denominator });

async function verifyJson(
  verifier: { verify(statement: string, interpretationConfidence: number): Promise<unknown> },
  value: unknown
) {
  return verifier.verify(JSON.stringify(value), 1) as Promise<{
    status: "VERIFIED" | "CONTRADICTED" | "UNRESOLVED";
    verifier: string;
    reason: string;
  }>;
}

describe("adversarial deterministic math verification", () => {
  it("rejects noncanonical integer spellings including negative zero", () => {
    for (const value of ["-0", "00", "-00", "+1", " 1", "1 "]) {
      expect(IntegerStringSchema.safeParse(value).success).toBe(false);
      expect(() => parseBoundedInteger(value)).toThrow(BoundedMathError);
    }
  });

  it("normalizes forged rational utility inputs instead of trusting caller invariants", () => {
    const forgedHalf: ExactRational = { numerator: 2n, denominator: 4n };
    const forgedNegativeDenominator: ExactRational = { numerator: -2n, denominator: -4n };

    expect(equalRationals(forgedHalf, rational(1n, 2n))).toBe(true);
    expect(serializeRational(forgedNegativeDenominator)).toEqual({ numerator: "1", denominator: "2" });
    expect(() => serializeRational({ numerator: 1n, denominator: 0n })).toThrow(BoundedMathError);
  });

  it("cross-cancels exact rational multiplication before enforcing intermediate limits", () => {
    const scale = 10n ** 3000n;
    const leftValue = scale + 7n;
    const rightValue = scale + 9n;
    const left = rational(leftValue, rightValue);
    const right = rational(rightValue, leftValue);

    expect(serializeRational(multiplyRationals(left, right))).toEqual({
      numerator: "1",
      denominator: "1"
    });
  });

  it("bounds direct bigint utility inputs rather than only parsed string inputs", () => {
    const oversized = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS + 1));
    expect(() => gcd(oversized, 1n)).toThrow(BoundedMathError);
  });

  it("fails closed for invalid direct integer-expression shapes", () => {
    for (const exponent of [-1, 1.5, MAX_POWER_EXPONENT + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => evaluateIntegerExpression({
        kind: "POWER",
        base: integer("2"),
        exponent
      })).toThrow(BoundedMathError);
    }

    expect(() => evaluateIntegerExpression({
      kind: "POWER",
      base: integer("0"),
      exponent: 0
    })).toThrow(BoundedMathError);

    expect(() => evaluateIntegerExpression({ kind: "SUM", terms: [] })).toThrow(BoundedMathError);
  });

  it("enforces the expression depth boundary for direct utility calls", () => {
    let atLimit: IntegerExpression = integer("1");
    for (let depth = 1; depth < 24; depth += 1) {
      atLimit = { kind: "NEGATE", operand: atLimit };
    }
    expect(evaluateIntegerExpression(atLimit)).toBe(-1n);

    const tooDeep: IntegerExpression = { kind: "NEGATE", operand: atLimit };
    expect(() => evaluateIntegerExpression(tooDeep)).toThrow(BoundedMathError);
  });

  it("abstains on zero-to-zero rather than verifying an ambiguous arithmetic convention", async () => {
    const result = await verifyJson(new ModularArithmeticVerifier(), {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "CONGRUENCE",
        left: { kind: "POWER", base: integer("0"), exponent: 0 },
        right: integer("1"),
        modulus: "2"
      }
    });
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reason).toContain("ARITHMETIC_UNDEFINED");
  });

  it("reports combinations-with-repetition expansion overflow as a resource limit", async () => {
    const result = await verifyJson(new CombinatorialCountingVerifier(), {
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: {
        kind: "COMBINATIONS_WITH_REPETITION",
        types: 1000,
        selections: 2,
        claimed: "0"
      }
    });
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reason).toContain("RESOURCE_LIMIT");
  });

  it("rejects semantically invalid probability values at the structured boundary", async () => {
    const verifier = new ProbabilityArithmeticVerifier();
    const invalidClaims = [
      {
        kind: "FINITE_EXPECTATION",
        outcomes: [{ probability: fraction("-1", "2"), value: fraction("1") }],
        claimedExpectation: fraction("-1", "2")
      },
      {
        kind: "CONDITIONAL_FROM_COUNTS",
        jointCount: 1,
        conditionCount: 2,
        claimedProbability: fraction("2")
      },
      {
        kind: "CONDITIONAL_FROM_PROBABILITIES",
        jointProbability: fraction("0"),
        conditionProbability: fraction("0"),
        claimedProbability: fraction("0")
      },
      {
        kind: "BAYES",
        prior: fraction("1", "2"),
        likelihoodGivenHypothesis: fraction("1", "2"),
        evidenceProbability: fraction("0"),
        claimedPosterior: fraction("1", "2")
      }
    ];

    for (const claim of invalidClaims) {
      const result = await verifyJson(verifier, {
        protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
        protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
        claim
      });
      expect(result.status).toBe("UNRESOLVED");
      expect(result.reason).toContain("MALFORMED_INTERPRETATION");
    }
  });

  it("classifies an internally inconsistent finite distribution as malformed rather than false", async () => {
    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes: [
          { probability: fraction("1", "2"), value: fraction("1") },
          { probability: fraction("1", "4"), value: fraction("3") }
        ],
        claimedExpectation: fraction("5", "4")
      }
    });
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reason).toContain("MALFORMED_INTERPRETATION");
  });

  it("accepts exactly the configured maximum number of probability outcomes", async () => {
    const outcomes = Array.from({ length: MAX_PROBABILITY_OUTCOMES }, () => ({
      probability: fraction("1", String(MAX_PROBABILITY_OUTCOMES)),
      value: fraction("1")
    }));
    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes,
        claimedExpectation: fraction("1")
      }
    });
    expect(result.status).toBe("VERIFIED");
  });

  it("locks recurrence coefficient order and permits the maximum supported index", async () => {
    const ordered = await verifyJson(new FiniteRecurrenceVerifier(), {
      protocol: FINITE_RECURRENCE_PROTOCOL,
      protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
      initial: [fraction("2"), fraction("3")],
      recurrence: {
        kind: "LINEAR_PREVIOUS_TERMS",
        coefficients: [fraction("10"), fraction("1")],
        constant: fraction("5")
      },
      claim: { kind: "VALUE_AT_INDEX", index: 2, value: fraction("37") }
    });
    expect(ordered.status).toBe("VERIFIED");

    const boundary = await verifyJson(new FiniteRecurrenceVerifier(), {
      protocol: FINITE_RECURRENCE_PROTOCOL,
      protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
      initial: [fraction("0")],
      recurrence: {
        kind: "LINEAR_PREVIOUS_TERMS",
        coefficients: [fraction("1")],
        constant: fraction("1")
      },
      claim: {
        kind: "VALUE_AT_INDEX",
        index: MAX_RECURRENCE_SEQUENCE_LENGTH - 1,
        value: fraction(String(MAX_RECURRENCE_SEQUENCE_LENGTH - 1))
      }
    });
    expect(boundary.status).toBe("VERIFIED");
  });

  it("deep-freezes registry metadata and keeps identities unique and non-authoritative", async () => {
    expect(Object.isFrozen(DETERMINISTIC_MATH_VERIFIERS)).toBe(true);
    expect(new Set(DETERMINISTIC_MATH_VERIFIERS.map((entry) => entry.verifier)).size)
      .toBe(DETERMINISTIC_MATH_VERIFIERS.length);
    expect(new Set(DETERMINISTIC_MATH_VERIFIERS.map((entry) => `${entry.protocol}@${String(entry.protocolVersion)}`)).size)
      .toBe(DETERMINISTIC_MATH_VERIFIERS.length);

    for (const entry of DETERMINISTIC_MATH_VERIFIERS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Reflect.set(entry as object, "verifier", "tampered-verifier@1")).toBe(false);
      expect(entry).not.toHaveProperty("evidenceKey");
      expect(entry).not.toHaveProperty("problemId");

      const verifier = createDeterministicMathVerifier(entry.verifier);
      expect(verifier).toBeDefined();
      if (verifier === undefined) throw new Error("Expected registered verifier factory");
      const malformed = await verifier.verify("null", 1);
      expect(malformed.status).toBe("UNRESOLVED");
      expect(malformed.verifier).toBe(entry.verifier);
    }
  });
});

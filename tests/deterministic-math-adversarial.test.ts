import { describe, expect, it } from "vitest";
import type { DeterministicVerifier, VerificationResult } from "../packages/domain/src/index.js";
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
  IntermediateIntegerStringSchema,
  PositiveIntegerStringSchema,
  MAX_INTEGER_DECIMAL_DIGITS,
  MAX_FINITE_CONTAINER_ITEMS,
  MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS,
  MAX_POWER_EXPONENT,
  MAX_PROBABILITY_OUTCOMES,
  MAX_RECURRENCE_SEQUENCE_LENGTH,
  MAX_VARIADIC_EXPRESSION_TERMS,
  MODULAR_ARITHMETIC_PROTOCOL,
  MODULAR_ARITHMETIC_PROTOCOL_VERSION,
  ModularArithmeticVerifier,
  PROBABILITY_ARITHMETIC_PROTOCOL,
  PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
  ProbabilityArithmeticVerifier,
  addRationals,
  areCongruent,
  binomial,
  createDeterministicMathVerifier,
  compareRationals,
  divideRationals,
  equalRationals,
  evaluateIntegerExpression,
  gcd,
  multiplyRationals,
  productIntegers,
  productRationals,
  parseBoundedInteger,
  parseBoundedIntermediateInteger,
  rational,
  serializeRational,
  sumIntegers,
  sumRationals,
  type ExactRational,
  type IntegerExpression
} from "../packages/verification/src/index.js";

const integer = (value: string) => ({ kind: "INTEGER" as const, value });
const fraction = (numerator: string, denominator = "1") => ({ numerator, denominator });

async function verifyJson(verifier: DeterministicVerifier, value: unknown): Promise<VerificationResult> {
  return verifier.verify(JSON.stringify(value), 1);
}

describe("adversarial deterministic math verification", () => {
  it("rejects noncanonical integer spellings including negative zero", () => {
    for (const value of ["-0", "00", "-00", "+1", " 1", "1 "]) {
      expect(IntegerStringSchema.safeParse(value).success).toBe(false);
      expect(() => parseBoundedInteger(value)).toThrow(BoundedMathError);
    }
  });

  it("enforces integer bounds before numeric conversion and fails closed on runtime type misuse", () => {
    const oversized = "9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS + 100_000);
    expect(PositiveIntegerStringSchema.safeParse(oversized).success).toBe(false);

    expect(() => parseBoundedInteger(17)).toThrow(BoundedMathError);
  });

  it("checks congruence without creating an avoidable over-limit subtraction", async () => {
    const maximum = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS));
    expect(areCongruent(maximum, -maximum, 2n)).toBe(true);

    const operand = "9".repeat(MAX_INTEGER_DECIMAL_DIGITS);
    const product = {
      kind: "PRODUCT" as const,
      terms: Array.from({ length: 16 }, () => integer(operand))
    };
    const result = await verifyJson(new ModularArithmeticVerifier(), {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "CONGRUENCE",
        left: product,
        right: { kind: "NEGATE", operand: product },
        modulus: "2"
      }
    });
    expect(result.status).toBe("VERIFIED");
  });

  it("classifies sign-aware integer digit overflow as a resource limit", async () => {
    for (const operand of [
      "9".repeat(MAX_INTEGER_DECIMAL_DIGITS + 1),
      `-${"9".repeat(MAX_INTEGER_DECIMAL_DIGITS + 1)}`
    ]) {
      const result = await verifyJson(new ModularArithmeticVerifier(), {
        protocol: MODULAR_ARITHMETIC_PROTOCOL,
        protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
        claim: { kind: "DIVISIBILITY", divisor: "1", dividend: integer(operand) }
      });
      expect(result.status).toBe("UNRESOLVED");
      expect(result.reason).toContain("RESOURCE_LIMIT");
    }

    for (const claimed of [
      "9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS + 1),
      `-${"9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS + 1)}`
    ]) {
      const result = await verifyJson(new CombinatorialCountingVerifier(), {
        protocol: COMBINATORIAL_COUNTING_PROTOCOL,
        protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
        claim: { kind: "BINOMIAL", n: 1, k: 1, claimed }
      });
      expect(result.status).toBe("UNRESOLVED");
      expect(result.reason).toContain("RESOURCE_LIMIT");
    }
  });

  it("enforces exact claimed-result digit boundaries", () => {
    const atLimit = "9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS);
    const overLimit = "9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS + 1);

    expect(IntermediateIntegerStringSchema.safeParse(atLimit).success).toBe(true);
    expect(parseBoundedIntermediateInteger(atLimit).toString()).toBe(atLimit);
    expect(IntermediateIntegerStringSchema.safeParse(overLimit).success).toBe(false);
    expect(() => parseBoundedIntermediateInteger(overLimit)).toThrow(BoundedMathError);
  });

  it("normalizes forged rational utility inputs instead of trusting caller invariants", () => {
    const forgedHalf: ExactRational = { numerator: 2n, denominator: 4n };
    const forgedNegativeDenominator: ExactRational = { numerator: -2n, denominator: -4n };

    expect(equalRationals(forgedHalf, rational(1n, 2n))).toBe(true);
    expect(serializeRational(forgedNegativeDenominator)).toEqual({ numerator: "1", denominator: "2" });
    expect(() => serializeRational({ numerator: 1n, denominator: 0n })).toThrow(BoundedMathError);
  });

  it("cancels rational addition before rejecting an avoidable carry overflow", () => {
    const maximumOdd = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS));
    const half = rational(maximumOdd, 2n);

    expect(addRationals(half, half)).toEqual(rational(maximumOdd, 1n));
  });

  it("does not bound rational common-denominator expansion before cancellation", () => {
    const scale = 10n ** 1999n;
    const leftDenominator = scale + 7n;
    const rightDenominator = scale + 9n;
    const multiplier = scale + 11n;
    const left = rational(leftDenominator * multiplier - 1n, leftDenominator);
    const right = rational(1n - rightDenominator * multiplier, rightDenominator);
    const expected = rational(leftDenominator - rightDenominator, leftDenominator * rightDenominator);

    expect(addRationals(left, right)).toEqual(expected);
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

  it("compares bounded rationals without oversized subtraction or cross-products", () => {
    const maximum = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS));

    expect(compareRationals(rational(maximum, 1n), rational(-maximum, 1n))).toBe(1);
    expect(compareRationals(rational(-maximum, 1n), rational(maximum, 1n))).toBe(-1);
    expect(compareRationals(rational(maximum, 1n), rational(maximum, 1n))).toBe(0);

    const denominator = 10n ** BigInt(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS - 1);
    const left = rational(denominator - 1n, denominator);
    const right = rational(denominator - 2n, denominator - 1n);
    expect(compareRationals(left, right)).toBe(1);
    expect(compareRationals(right, left)).toBe(-1);
  });

  it("bounds exported finite aggregate helpers by the shared container limit", () => {
    expect(sumIntegers(Array.from({ length: MAX_FINITE_CONTAINER_ITEMS }, () => 1n)))
      .toBe(BigInt(MAX_FINITE_CONTAINER_ITEMS));
    const maximum = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS));
    expect(sumIntegers([maximum, maximum, -maximum])).toBe(maximum);
    expect(sumRationals(Array.from({ length: MAX_FINITE_CONTAINER_ITEMS }, () => rational(1n, 1n))))
      .toEqual(rational(BigInt(MAX_FINITE_CONTAINER_ITEMS), 1n));

    expect(() => sumIntegers(
      Array.from({ length: MAX_FINITE_CONTAINER_ITEMS + 1 }, () => 1n)
    )).toThrow(BoundedMathError);
    expect(() => sumRationals(
      Array.from({ length: MAX_FINITE_CONTAINER_ITEMS + 1 }, () => rational(1n, 1n))
    )).toThrow(BoundedMathError);
  });

  it("keeps variadic integer sums exact across cancelling bounded terms", async () => {
    const operand = "9".repeat(MAX_INTEGER_DECIMAL_DIGITS);
    const largeProduct = {
      kind: "PRODUCT" as const,
      terms: Array.from({ length: 16 }, () => integer(operand))
    };
    const result = await verifyJson(new ModularArithmeticVerifier(), {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "DIVISIBILITY",
        divisor: "1",
        dividend: {
          kind: "SUM",
          terms: [
            largeProduct,
            largeProduct,
            { kind: "NEGATE", operand: largeProduct }
          ]
        }
      }
    });

    expect(result.status).toBe("VERIFIED");
  });

  it("recognizes a zero product without overflowing earlier bounded factors", async () => {
    const maximum = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS));

    expect(productIntegers([maximum, maximum, 0n])).toBe(0n);
    expect(productRationals([
      rational(maximum, 1n),
      rational(maximum, 1n),
      rational(0n, 1n)
    ])).toEqual(rational(0n, 1n));

    const operand = "9".repeat(MAX_INTEGER_DECIMAL_DIGITS);
    const result = await verifyJson(new ModularArithmeticVerifier(), {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "DIVISIBILITY",
        divisor: "7",
        dividend: {
          kind: "PRODUCT",
          terms: [
            ...Array.from({ length: 17 }, () => integer(operand)),
            integer("0")
          ]
        }
      }
    });
    expect(result.status).toBe("VERIFIED");
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

    expect(evaluateIntegerExpression({
      kind: "POWER",
      base: integer("1"),
      exponent: MAX_POWER_EXPONENT
    })).toBe(1n);

    expect(evaluateIntegerExpression({
      kind: "SUM",
      terms: Array.from({ length: MAX_VARIADIC_EXPRESSION_TERMS }, () => integer("1"))
    })).toBe(BigInt(MAX_VARIADIC_EXPRESSION_TERMS));

    expect(() => evaluateIntegerExpression({ kind: "SUM", terms: [] })).toThrow(BoundedMathError);
    expect(() => evaluateIntegerExpression({
      kind: "SUM",
      terms: Array.from({ length: MAX_VARIADIC_EXPRESSION_TERMS + 1 }, () => integer("1"))
    })).toThrow(BoundedMathError);
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

  it("fails closed on runtime statement and confidence type violations", async () => {
    const verifier = new ModularArithmeticVerifier() as unknown as {
      verify(statement: unknown, interpretationConfidence: unknown): Promise<VerificationResult>;
    };

    for (const statement of [null, undefined, 17, {}, []]) {
      const result = await verifier.verify(statement, 1);
      expect(result.status).toBe("UNRESOLVED");
      expect(result.reason).toContain("MALFORMED_INTERPRETATION");
    }

    for (const confidence of ["1", null, {}, 1n]) {
      const result = await verifier.verify("{}", confidence);
      expect(result.status).toBe("UNRESOLVED");
      expect(result.reason).toContain("INVALID_INTERPRETATION_CONFIDENCE");
    }
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

  it("represents exact verifier results larger than the operand-literal limit", async () => {
    const largeBinomial = binomial(1000, 500).toString();
    expect(largeBinomial.length).toBeGreaterThan(MAX_INTEGER_DECIMAL_DIGITS);
    const counting = await verifyJson(new CombinatorialCountingVerifier(), {
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: { kind: "BINOMIAL", n: 1000, k: 500, claimed: largeBinomial }
    });
    expect(counting.status).toBe("VERIFIED");

    const operand = "9".repeat(MAX_INTEGER_DECIMAL_DIGITS);
    const recurrenceValue = (BigInt(operand) * BigInt(operand)).toString();
    expect(recurrenceValue.length).toBeGreaterThan(MAX_INTEGER_DECIMAL_DIGITS);
    const recurrence = await verifyJson(new FiniteRecurrenceVerifier(), {
      protocol: FINITE_RECURRENCE_PROTOCOL,
      protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
      initial: [fraction(operand)],
      recurrence: {
        kind: "LINEAR_PREVIOUS_TERMS",
        coefficients: [fraction(operand)],
        constant: fraction("0")
      },
      claim: { kind: "VALUE_AT_INDEX", index: 1, value: fraction(recurrenceValue) }
    });
    expect(recurrence.status).toBe("VERIFIED");

    const denominatorA = 10n ** 255n + 7n;
    const denominatorB = 10n ** 255n + 9n;
    const expectation = serializeRational(rational(
      denominatorA + denominatorB,
      2n * denominatorA * denominatorB
    ));
    expect(expectation.denominator.length).toBeGreaterThan(MAX_INTEGER_DECIMAL_DIGITS);
    const probability = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes: [
          { probability: fraction("1", "2"), value: fraction("1", denominatorA.toString()) },
          { probability: fraction("1", "2"), value: fraction("1", denominatorB.toString()) }
        ],
        claimedExpectation: expectation
      }
    });
    expect(probability.status).toBe("VERIFIED");
  });

  it("accepts bounded intermediate-sized claimed probabilities", async () => {
    const scale = 10n ** 254n;
    const left = scale + 7n;
    const right = scale + 11n;
    const joint = rational(left, 4n * left + 1n);
    const condition = rational(right, 2n * right + 1n);
    const claimed = serializeRational(divideRationals(joint, condition));
    expect(Math.max(claimed.numerator.length, claimed.denominator.length))
      .toBeGreaterThan(MAX_INTEGER_DECIMAL_DIGITS);

    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "CONDITIONAL_FROM_PROBABILITIES",
        jointProbability: serializeRational(joint),
        conditionProbability: serializeRational(condition),
        claimedProbability: claimed
      }
    });
    expect(result.status).toBe("VERIFIED");
  });

  it("supports combinations with repetition across the full bounded input domain", async () => {
    const result = await verifyJson(new CombinatorialCountingVerifier(), {
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: {
        kind: "COMBINATIONS_WITH_REPETITION",
        types: 1000,
        selections: 2,
        claimed: "500500"
      }
    });
    expect(result.status).toBe("VERIFIED");
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
      },
      {
        kind: "BAYES",
        prior: fraction("1"),
        likelihoodGivenHypothesis: fraction("1", "5"),
        evidenceProbability: fraction("4", "5"),
        claimedPosterior: fraction("1", "4")
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

  it("contradicts false probability answers even when the claimed value lies outside [0, 1]", async () => {
    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "CONDITIONAL_FROM_COUNTS",
        jointCount: 1,
        conditionCount: 2,
        claimedProbability: fraction("2")
      }
    });
    expect(result.status).toBe("CONTRADICTED");
    expect(result.reason).toContain("CLAIM_CONTRADICTED");
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

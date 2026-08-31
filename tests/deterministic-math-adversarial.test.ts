import { describe, expect, it } from "vitest";
import {
  VerificationResultSchema,
  type DeterministicVerifier,
  type VerificationResult
} from "../packages/domain/src/index.js";
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
  MAX_WIDE_RATIONAL_WORK_DECIMAL_DIGITS,
  MODULAR_ARITHMETIC_PROTOCOL,
  MODULAR_ARITHMETIC_PROTOCOL_VERSION,
  ModularArithmeticVerifier,
  PROBABILITY_ARITHMETIC_PROTOCOL,
  PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
  ProbabilityArithmeticVerifier,
  RATIONAL_ARITHMETIC_PROTOCOL,
  RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
  RationalArithmeticVerifier,
  addRationals,
  areCongruent,
  binomial,
  createDeterministicMathVerifier,
  compareRationals,
  divideRationals,
  equalRationals,
  evaluateIntegerExpression,
  evaluateRationalExpression,
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
  type IntegerExpression,
  type RationalExpression
} from "../packages/verification/src/index.js";

const integer = (value: string) => ({ kind: "INTEGER" as const, value });
const fraction = (numerator: string, denominator = "1") => ({ numerator, denominator });
const fractionExpression = (numerator: string, denominator = "1") => ({
  kind: "RATIONAL" as const,
  value: fraction(numerator, denominator)
});

function primePowerAtLeastDigits(base: bigint, minimumDigits: number): bigint {
  let value = 1n;
  while (value.toString().length < minimumDigits) value *= base;
  return value;
}

async function verifyJson(verifier: DeterministicVerifier, value: unknown): Promise<VerificationResult> {
  const result = await verifier.verify(JSON.stringify(value), 1);
  expect(VerificationResultSchema.parse(result)).toEqual(result);
  return result;
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

    const malformedOversized = `+${"9".repeat(MAX_INTEGER_DECIMAL_DIGITS + 100_000)}`;
    try {
      parseBoundedInteger(malformedOversized);
      throw new Error("Expected oversized integer input to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedMathError);
      expect((error as BoundedMathError).code).toBe("INTEGER_LIMIT_EXCEEDED");
    }

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

  it("does not misclassify malformed integer spelling as a resource limit", async () => {
    for (const operand of [
      `+${"9".repeat(MAX_INTEGER_DECIMAL_DIGITS)}`,
      ` ${"9".repeat(MAX_INTEGER_DECIMAL_DIGITS)}`,
      `${"9".repeat(MAX_INTEGER_DECIMAL_DIGITS)} `
    ]) {
      try {
        parseBoundedInteger(operand);
        throw new Error("Expected malformed integer input to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(BoundedMathError);
        expect((error as BoundedMathError).code).toBe("INVALID_INTEGER");
      }

      const result = await verifyJson(new ModularArithmeticVerifier(), {
        protocol: MODULAR_ARITHMETIC_PROTOCOL,
        protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
        claim: { kind: "DIVISIBILITY", divisor: "1", dividend: integer(operand) }
      });
      expect(result.status).toBe("UNRESOLVED");
      expect(result.reason).toContain("MALFORMED_INTERPRETATION");
      expect(result.reason).not.toContain("RESOURCE_LIMIT");
    }
  });

  it("treats malformed integers beyond the lexical window as resource overflows", async () => {
    const operand = `+${"9".repeat(MAX_INTEGER_DECIMAL_DIGITS + 2)}`;
    const result = await verifyJson(new ModularArithmeticVerifier(), {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: { kind: "DIVISIBILITY", divisor: "1", dividend: integer(operand) }
    });
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reason).toContain("RESOURCE_LIMIT");
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

  it("treats a maximum-size claimed result as a false claim rather than malformed", async () => {
    const claimed = "9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS);
    const result = await verifyJson(new CombinatorialCountingVerifier(), {
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: { kind: "BINOMIAL", n: 1, k: 1, claimed }
    });
    expect(result.status).toBe("CONTRADICTED");
    expect(result.reason).toContain("CLAIM_CONTRADICTED");
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

  it("compares bounded rationals with wider comparison-only temporaries", () => {
    const maximum = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS));

    expect(compareRationals(rational(maximum, 1n), rational(-maximum, 1n))).toBe(1);
    expect(compareRationals(rational(-maximum, 1n), rational(maximum, 1n))).toBe(-1);
    expect(compareRationals(rational(maximum, 1n), rational(maximum, 1n))).toBe(0);

    const denominator = 10n ** BigInt(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS - 1);
    const left = rational(denominator - 1n, denominator);
    const right = rational(denominator - 2n, denominator - 1n);
    expect((left.numerator * right.denominator).toString().length)
      .toBeGreaterThan(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS);
    expect(compareRationals(left, right)).toBe(1);
    expect(compareRationals(right, left)).toBe(-1);
  });

  it("bounds exported finite aggregate helpers by the shared container limit", () => {
    const integerOnes = Array.from({ length: MAX_FINITE_CONTAINER_ITEMS }, () => 1n);
    const rationalOnes = Array.from(
      { length: MAX_FINITE_CONTAINER_ITEMS },
      () => rational(1n, 1n)
    );
    expect(sumIntegers(integerOnes)).toBe(BigInt(MAX_FINITE_CONTAINER_ITEMS));
    expect(productIntegers(integerOnes)).toBe(1n);
    expect(sumRationals(rationalOnes))
      .toEqual(rational(BigInt(MAX_FINITE_CONTAINER_ITEMS), 1n));
    expect(productRationals(rationalOnes)).toEqual(rational(1n, 1n));

    const maximum = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS));
    expect(sumIntegers([maximum, maximum, -maximum])).toBe(maximum);

    const oversizedIntegers = Array.from(
      { length: MAX_FINITE_CONTAINER_ITEMS + 1 },
      () => 1n
    );
    const oversizedRationals = Array.from(
      { length: MAX_FINITE_CONTAINER_ITEMS + 1 },
      () => rational(1n, 1n)
    );
    expect(() => sumIntegers(oversizedIntegers)).toThrow(BoundedMathError);
    expect(() => productIntegers(oversizedIntegers)).toThrow(BoundedMathError);
    expect(() => sumRationals(oversizedRationals)).toThrow(BoundedMathError);
    expect(() => productRationals(oversizedRationals)).toThrow(BoundedMathError);
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

  it("cancels exact rational identity pairs before aggregate-order overflow", async () => {
    const maximum = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS));
    expect(sumRationals([
      rational(maximum, 1n),
      rational(maximum, 1n),
      rational(-maximum, 1n)
    ])).toEqual(rational(maximum, 1n));
    expect(productRationals([
      rational(maximum, 1n),
      rational(maximum, 1n),
      rational(1n, maximum),
      rational(1n, maximum)
    ])).toEqual(rational(1n, 1n));

    const operand = "9".repeat(MAX_INTEGER_DECIMAL_DIGITS);
    const largeMagnitude = {
      kind: "PRODUCT" as const,
      terms: Array.from({ length: 16 }, () => fractionExpression(operand))
    };
    const inverseMagnitude = {
      kind: "PRODUCT" as const,
      terms: Array.from({ length: 16 }, () => fractionExpression("1", operand))
    };

    const sumResult = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: {
          kind: "SUM",
          terms: [
            largeMagnitude,
            largeMagnitude,
            { kind: "NEGATE", operand: largeMagnitude }
          ]
        },
        right: largeMagnitude
      }
    });
    expect(sumResult.status).toBe("VERIFIED");

    const productResult = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: {
          kind: "PRODUCT",
          terms: [
            largeMagnitude,
            largeMagnitude,
            inverseMagnitude,
            inverseMagnitude
          ]
        },
        right: fractionExpression("1")
      }
    });
    expect(productResult.status).toBe("VERIFIED");
  });

  it("sums bounded rational terms independent of non-pairwise cancellation order", async () => {
    const maximumOdd = BigInt("9".repeat(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS));
    expect(sumRationals([
      rational(maximumOdd, 1n),
      rational(maximumOdd, 1n),
      rational(-maximumOdd, 2n),
      rational(-maximumOdd, 2n),
      rational(-maximumOdd, 2n),
      rational(-maximumOdd, 2n)
    ])).toEqual(rational(0n, 1n));

    const operand = "9".repeat(MAX_INTEGER_DECIMAL_DIGITS);
    const largeMagnitude = {
      kind: "PRODUCT" as const,
      terms: Array.from({ length: 16 }, () => fractionExpression(operand))
    };
    const negativeHalf = {
      kind: "NEGATE" as const,
      operand: {
        kind: "DIVIDE" as const,
        left: largeMagnitude,
        right: fractionExpression("2")
      }
    };

    const result = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: {
          kind: "SUM",
          terms: [
            largeMagnitude,
            largeMagnitude,
            negativeHalf,
            negativeHalf,
            negativeHalf,
            negativeHalf
          ]
        },
        right: fractionExpression("0")
      }
    });
    expect(result.status).toBe("VERIFIED");
  });

  it("accumulates cross-denominator rational sums before enforcing the reduced-result bound", async () => {
    const specs: readonly (readonly [bigint, bigint])[] = [
      [2n, 756n], [3n, 468n], [5n, 324n], [7n, 270n], [11n, 216n],
      [13n, 198n], [17n, 180n], [23n, 162n], [29n, 162n], [31n, 144n],
      [37n, 144n], [41n, 144n], [43n, 144n], [47n, 126n], [53n, 126n],
      [59n, 126n], [61n, 126n], [67n, 126n], [71n, 126n]
    ];
    const parts = specs.map(([base, exponent]) => {
      const q = base ** exponent;
      expect(q % 19n).toBe(1n);
      const denominator = 19n * q;
      expect(denominator.toString().length).toBeLessThanOrEqual(MAX_INTEGER_DECIMAL_DIGITS);
      return {
        tiny: fractionExpression("1", denominator.toString()),
        complement: fractionExpression((q - 1n).toString(), denominator.toString())
      };
    });

    const result = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: {
          kind: "SUM",
          terms: [
            ...parts.map((part) => part.tiny),
            ...parts.map((part) => part.complement)
          ]
        },
        right: fractionExpression("1")
      }
    });
    expect(result.status).toBe("VERIFIED");
  });

  it("bounds wide rational sum work while preserving the in-budget cancellation case", async () => {
    const bases = [
      2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n,
      41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n,
      97n, 101n, 103n, 107n, 109n, 113n, 127n, 131n, 137n, 139n, 149n, 151n
    ] as const;
    const denominators = bases.map((base) => primePowerAtLeastDigits(base, 239));
    for (const denominator of denominators) {
      expect(denominator.toString().length).toBeGreaterThanOrEqual(239);
      expect(denominator.toString().length).toBeLessThanOrEqual(241);
    }

    const underWorkProduct = denominators.slice(0, 35).reduce(
      (product, denominator) => product * denominator,
      1n
    );
    const finalDenominator = denominators[35];
    if (finalDenominator === undefined) throw new Error("Expected 36 work-bound denominators");
    const overWorkProduct = underWorkProduct * finalDenominator;
    expect(underWorkProduct.toString().length)
      .toBeLessThanOrEqual(MAX_WIDE_RATIONAL_WORK_DECIMAL_DIGITS);
    expect(overWorkProduct.toString().length)
      .toBeGreaterThan(MAX_WIDE_RATIONAL_WORK_DECIMAL_DIGITS);

    const cancellationTerms = (count: number) => denominators.slice(0, count).flatMap(
      (denominator) => [
        fractionExpression("1", denominator.toString()),
        fractionExpression("1", denominator.toString()),
        fractionExpression("-2", denominator.toString())
      ]
    );

    const withinBudget = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: { kind: "SUM", terms: cancellationTerms(35) },
        right: fractionExpression("0")
      }
    });
    expect(withinBudget.status).toBe("VERIFIED");

    const overBudget = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: { kind: "SUM", terms: cancellationTerms(36) },
        right: fractionExpression("0")
      }
    });
    expect(overBudget.status).toBe("UNRESOLVED");
    expect(overBudget.reason).toContain("RESOURCE_LIMIT");
  });

  it("cross-cancels rational product factors even without exact reciprocal pairs", async () => {
    const leftScale = 10n ** 3000n + 7n;
    const rightScale = 10n ** 3000n + 11n;
    expect(productRationals([
      rational(2n * leftScale, 1n),
      rational(rightScale, 1n),
      rational(1n, leftScale),
      rational(1n, 2n * rightScale)
    ])).toEqual(rational(1n, 1n));

    const operandA = "9".repeat(MAX_INTEGER_DECIMAL_DIGITS);
    const operandB = `${"9".repeat(MAX_INTEGER_DECIMAL_DIGITS - 1)}8`;
    const largeA = {
      kind: "PRODUCT" as const,
      terms: Array.from({ length: 8 }, () => fractionExpression(operandA))
    };
    const largeB = {
      kind: "PRODUCT" as const,
      terms: Array.from({ length: 8 }, () => fractionExpression(operandB))
    };
    const inverseA = {
      kind: "PRODUCT" as const,
      terms: Array.from({ length: 8 }, () => fractionExpression("1", operandA))
    };
    const inverseTwoB = {
      kind: "PRODUCT" as const,
      terms: [
        fractionExpression("1", "2"),
        ...Array.from({ length: 8 }, () => fractionExpression("1", operandB))
      ]
    };

    const result = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: {
          kind: "PRODUCT",
          terms: [
            { kind: "MULTIPLY", left: fractionExpression("2"), right: largeA },
            largeB,
            inverseA,
            inverseTwoB
          ]
        },
        right: fractionExpression("1")
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

  it("distinguishes malformed direct expressions from configured resource overflows", () => {
    for (const exponent of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        evaluateIntegerExpression({
          kind: "POWER",
          base: integer("2"),
          exponent
        });
        throw new Error("Expected malformed exponent to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(BoundedMathError);
        expect((error as BoundedMathError).code).toBe("INVALID_EXPRESSION");
      }
    }

    try {
      evaluateIntegerExpression({
        kind: "POWER",
        base: integer("2"),
        exponent: MAX_POWER_EXPONENT + 1
      });
      throw new Error("Expected exponent resource limit to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedMathError);
      expect((error as BoundedMathError).code).toBe("INTERMEDIATE_LIMIT_EXCEEDED");
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

    try {
      evaluateIntegerExpression({ kind: "SUM", terms: [] });
      throw new Error("Expected empty integer sum to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedMathError);
      expect((error as BoundedMathError).code).toBe("INVALID_EXPRESSION");
    }

    try {
      evaluateIntegerExpression({
        kind: "SUM",
        terms: Array.from({ length: MAX_VARIADIC_EXPRESSION_TERMS + 1 }, () => integer("1"))
      });
      throw new Error("Expected integer term resource limit to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedMathError);
      expect((error as BoundedMathError).code).toBe("INTERMEDIATE_LIMIT_EXCEEDED");
    }

    try {
      evaluateRationalExpression({
        kind: "PRODUCT",
        terms: Array.from(
          { length: MAX_VARIADIC_EXPRESSION_TERMS + 1 },
          () => fractionExpression("1")
        )
      });
      throw new Error("Expected rational term resource limit to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedMathError);
      expect((error as BoundedMathError).code).toBe("INTERMEDIATE_LIMIT_EXCEEDED");
    }
  });

  it("enforces the exact expression-node boundary in both grammars", async () => {
    const integerFourNode = () => ({
      kind: "NEGATE" as const,
      operand: {
        kind: "ADD" as const,
        left: integer("1"),
        right: integer("1")
      }
    });
    const integerThreeNode = {
      kind: "ADD" as const,
      left: integer("1"),
      right: integer("1")
    };
    const integerAtLimit = {
      kind: "SUM" as const,
      terms: [
        ...Array.from({ length: 127 }, integerFourNode),
        integerThreeNode
      ]
    };
    const integerOverLimit = {
      kind: "SUM" as const,
      terms: Array.from({ length: 128 }, integerFourNode)
    };

    const integerAccepted = await verifyJson(new ModularArithmeticVerifier(), {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "DIVISIBILITY",
        divisor: "1",
        dividend: integerAtLimit
      }
    });
    expect(integerAccepted.status).toBe("VERIFIED");

    const integerRejected = await verifyJson(new ModularArithmeticVerifier(), {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "DIVISIBILITY",
        divisor: "1",
        dividend: integerOverLimit
      }
    });
    expect(integerRejected.status).toBe("UNRESOLVED");
    expect(integerRejected.reason).toContain("RESOURCE_LIMIT");

    const rationalFourNode = () => ({
      kind: "NEGATE" as const,
      operand: {
        kind: "ADD" as const,
        left: fractionExpression("1"),
        right: fractionExpression("1")
      }
    });
    const rationalThreeNode = {
      kind: "ADD" as const,
      left: fractionExpression("1"),
      right: fractionExpression("1")
    };
    const rationalAtLimit = {
      kind: "SUM" as const,
      terms: [
        ...Array.from({ length: 127 }, rationalFourNode),
        rationalThreeNode
      ]
    };
    const rationalOverLimit = {
      kind: "SUM" as const,
      terms: Array.from({ length: 128 }, rationalFourNode)
    };

    const rationalAccepted = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: rationalAtLimit,
        right: fractionExpression("-252")
      }
    });
    expect(rationalAccepted.status).toBe("VERIFIED");

    const rationalRejected = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: rationalOverLimit,
        right: fractionExpression("0")
      }
    });
    expect(rationalRejected.status).toBe("UNRESOLVED");
    expect(rationalRejected.reason).toContain("RESOURCE_LIMIT");
  });

  it("enforces the expression depth boundary for both direct evaluators", () => {
    let integerAtLimit: IntegerExpression = integer("1");
    for (let depth = 1; depth < 24; depth += 1) {
      integerAtLimit = { kind: "NEGATE", operand: integerAtLimit };
    }
    expect(evaluateIntegerExpression(integerAtLimit)).toBe(-1n);

    const integerTooDeep: IntegerExpression = { kind: "NEGATE", operand: integerAtLimit };
    expect(() => evaluateIntegerExpression(integerTooDeep)).toThrow(BoundedMathError);

    let rationalAtLimit: RationalExpression = fractionExpression("1");
    for (let depth = 1; depth < 24; depth += 1) {
      rationalAtLimit = { kind: "NEGATE", operand: rationalAtLimit };
    }
    expect(evaluateRationalExpression(rationalAtLimit)).toEqual(rational(-1n, 1n));

    const rationalTooDeep = { kind: "NEGATE" as const, operand: rationalAtLimit };
    expect(() => evaluateRationalExpression(rationalTooDeep)).toThrow(BoundedMathError);
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
    const simple = await verifyJson(new CombinatorialCountingVerifier(), {
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: {
        kind: "COMBINATIONS_WITH_REPETITION",
        types: 1000,
        selections: 2,
        claimed: "500500"
      }
    });
    expect(simple.status).toBe("VERIFIED");

    const corner = await verifyJson(new CombinatorialCountingVerifier(), {
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: {
        kind: "COMBINATIONS_WITH_REPETITION",
        types: 1000,
        selections: 1000,
        claimed: "1024075813494744857167581251490412522198212443990698516910191318835874093101041877914466497091305103100732383159999011846207740899002262396009023774884630789281506448317160323574255761976258256138842943057697731280739536893342320772222668088068850369278369072948150356532552279797572399443731031843592572759142755865831381268318865423414661276945248719297407158775153918982221854050425818624137313957085083099418824204217707154088929735188732825942377573403748473374619015165509093616490048342837292801262749550590567626767329443970983326837452255653055048155953135171251146577955554488366981995574560"
      }
    });
    expect(corner.status).toBe("VERIFIED");
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
        jointCount: 3,
        conditionCount: 2,
        claimedProbability: fraction("3", "2")
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

  it("normalizes valid probability mass independently of outcome order", async () => {
    const denominatorSpecs: readonly (readonly [bigint, bigint])[] = [
      [2n, 730n], [3n, 461n], [5n, 314n], [7n, 260n], [11n, 211n],
      [13n, 197n], [17n, 178n], [23n, 161n], [29n, 150n], [31n, 147n],
      [37n, 139n], [41n, 136n], [43n, 134n], [47n, 131n], [53n, 127n],
      [59n, 124n], [61n, 123n], [67n, 120n], [71n, 118n]
    ];
    const parts = denominatorSpecs.map(([base, exponent]) => {
      const scale = base ** exponent;
      const denominator = 19n * scale;
      return {
        tiny: {
          probability: fraction("1", denominator.toString()),
          value: fraction("0")
        },
        complement: {
          probability: fraction((scale - 1n).toString(), denominator.toString()),
          value: fraction("0")
        }
      };
    });

    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes: [
          ...parts.map((part) => part.tiny),
          ...parts.map((part) => part.complement)
        ],
        claimedExpectation: fraction("0")
      }
    });
    expect(result.status).toBe("VERIFIED");
  });

  it("validates probability complements even when reduction changes their denominators", async () => {
    const specs: readonly (readonly [bigint, bigint])[] = [
      [2n, 756n], [3n, 468n], [5n, 324n], [7n, 270n], [11n, 216n],
      [13n, 198n], [17n, 180n], [23n, 162n], [29n, 162n], [31n, 144n],
      [37n, 144n], [41n, 144n], [43n, 144n], [47n, 126n], [53n, 126n],
      [59n, 126n], [61n, 126n], [67n, 126n], [71n, 126n]
    ];
    const parts = specs.map(([base, exponent]) => {
      const q = base ** exponent;
      expect(q % 19n).toBe(1n);
      const denominator = 19n * q;
      expect(denominator.toString().length).toBeLessThanOrEqual(MAX_INTEGER_DECIMAL_DIGITS);
      return {
        tiny: {
          probability: fraction("1", denominator.toString()),
          value: fraction("0")
        },
        complement: {
          probability: fraction((q - 1n).toString(), denominator.toString()),
          value: fraction("0")
        },
        qDigits: q.toString().length
      };
    });
    expect(parts.reduce((total, part) => total + part.qDigits, 0))
      .toBeGreaterThan(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS);

    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes: [
          ...parts.map((part) => part.tiny),
          ...parts.map((part) => part.complement)
        ],
        claimedExpectation: fraction("0")
      }
    });
    expect(result.status).toBe("VERIFIED");
  });

  it("keeps finite-expectation status independent of outcome ordering", async () => {
    const bases = [
      3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n,
      43n, 47n, 53n, 59n, 61n, 67n, 71n, 73n, 79n, 89n, 97n, 101n,
      103n, 107n, 109n, 113n, 127n, 131n, 137n, 139n, 149n, 151n,
      157n, 163n, 167n, 173n, 179n, 181n, 191n, 193n, 197n, 199n,
      211n, 223n, 227n, 229n, 233n, 239n, 241n, 251n, 257n, 263n,
      269n, 271n, 277n, 281n, 283n, 293n, 307n, 311n, 313n, 317n,
      331n, 337n, 347n, 349n, 353n, 359n, 367n, 373n, 379n, 383n,
      389n, 397n, 401n, 409n, 419n, 421n, 431n, 433n, 439n
    ] as const;
    expect(bases).toHaveLength(83);

    const denominators = bases.map((base) => primePowerAtLeastDigits(base, 100));
    let magnitude = 1n;
    while ((magnitude * 997n).toString().length <= MAX_INTEGER_DECIMAL_DIGITS) {
      magnitude *= 997n;
    }
    expect(magnitude.toString().length).toBeLessThanOrEqual(MAX_INTEGER_DECIMAL_DIGITS);

    const denominatorProduct = denominators.reduce(
      (product, denominator) => product * denominator,
      1n
    );
    const positiveNumerator = magnitude * denominators.reduce(
      (sum, denominator) => sum + denominatorProduct / denominator,
      0n
    );
    expect(denominatorProduct.toString().length)
      .toBeLessThanOrEqual(MAX_WIDE_RATIONAL_WORK_DECIMAL_DIGITS);
    expect(positiveNumerator.toString().length)
      .toBeGreaterThan(MAX_WIDE_RATIONAL_WORK_DECIMAL_DIGITS);

    const probabilityDenominator = String(2 * denominators.length);
    const positives = denominators.map((denominator) => ({
      probability: fraction("1", probabilityDenominator),
      value: fraction(magnitude.toString(), denominator.toString())
    }));
    const negatives = denominators.map((denominator) => ({
      probability: fraction("1", probabilityDenominator),
      value: fraction((-magnitude).toString(), denominator.toString())
    }));
    const alternating = denominators.flatMap((denominator) => [
      {
        probability: fraction("1", probabilityDenominator),
        value: fraction(magnitude.toString(), denominator.toString())
      },
      {
        probability: fraction("1", probabilityDenominator),
        value: fraction((-magnitude).toString(), denominator.toString())
      }
    ]);

    for (const outcomes of [[...positives, ...negatives], alternating]) {
      const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
        protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
        protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
        claim: {
          kind: "FINITE_EXPECTATION",
          outcomes,
          claimedExpectation: fraction("0")
        }
      });
      expect(result.status).toBe("VERIFIED");
    }
  });

  it("abstains before probability normalization exceeds the exact-work budget", async () => {
    const bases = [
      2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n,
      41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n,
      97n, 101n, 103n, 107n, 109n, 113n, 127n, 131n, 137n, 139n, 149n, 151n
    ] as const;
    const scales = bases.map((base) => primePowerAtLeastDigits(base, 239));
    const scaleProduct = scales.reduce((product, scale) => product * scale, 1n);
    expect(scaleProduct.toString().length)
      .toBeGreaterThan(MAX_WIDE_RATIONAL_WORK_DECIMAL_DIGITS);

    const outcomes = scales.flatMap((scale) => {
      const denominator = 36n * scale;
      return [
        {
          probability: fraction("1", denominator.toString()),
          value: fraction("0")
        },
        {
          probability: fraction((scale - 1n).toString(), denominator.toString()),
          value: fraction("0")
        }
      ];
    });

    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes,
        claimedExpectation: fraction("0")
      }
    });
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reason).toContain("RESOURCE_LIMIT");
  });

  it("cancels exact expectation terms before aggregate denominator overflow", async () => {
    const denominatorSpecs: readonly (readonly [bigint, bigint])[] = [
      [2n, 764n], [3n, 482n], [5n, 329n], [7n, 272n], [11n, 220n],
      [13n, 206n], [17n, 186n], [19n, 179n], [23n, 168n], [29n, 157n],
      [31n, 154n], [37n, 146n], [41n, 142n], [43n, 140n], [47n, 137n],
      [53n, 133n], [59n, 129n], [61n, 128n], [67n, 125n], [71n, 124n]
    ];
    const denominators = denominatorSpecs.map(([base, exponent]) => (base ** exponent).toString());
    const positiveOutcomes = denominators.map((denominator) => ({
      probability: fraction("1", "40"),
      value: fraction("1", denominator)
    }));
    const negativeOutcomes = denominators.map((denominator) => ({
      probability: fraction("1", "40"),
      value: fraction("-1", denominator)
    }));

    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes: [...positiveOutcomes, ...negativeOutcomes],
        claimedExpectation: fraction("0")
      }
    });
    expect(result.status).toBe("VERIFIED");
  });

  it("accumulates non-pairwise cancelling expectation terms before enforcing the final bound", async () => {
    const specs: readonly (readonly [bigint, bigint])[] = [
      [2n, 756n], [3n, 468n], [5n, 324n], [7n, 270n], [11n, 216n],
      [13n, 198n], [17n, 180n], [23n, 162n], [29n, 162n], [31n, 144n],
      [37n, 144n], [41n, 144n], [43n, 144n], [47n, 126n], [53n, 126n],
      [59n, 126n], [61n, 126n], [67n, 126n], [71n, 126n]
    ];
    const groups = specs.map(([base, exponent]) => {
      const q = base ** exponent;
      const denominator = 57n * q;
      const negativeValueDenominator = 3n * q - 2n;
      expect(denominator.toString().length).toBeLessThanOrEqual(MAX_INTEGER_DECIMAL_DIGITS);
      expect(negativeValueDenominator.toString().length).toBeLessThanOrEqual(MAX_INTEGER_DECIMAL_DIGITS);
      return {
        positives: [
          { probability: fraction("1", denominator.toString()), value: fraction("1") },
          { probability: fraction("1", denominator.toString()), value: fraction("1") }
        ],
        negative: {
          probability: fraction(negativeValueDenominator.toString(), denominator.toString()),
          value: fraction("-2", negativeValueDenominator.toString())
        }
      };
    });

    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes: [
          ...groups.flatMap((group) => group.positives),
          ...groups.map((group) => group.negative)
        ],
        claimedExpectation: fraction("0")
      }
    });
    expect(result.status).toBe("VERIFIED");
  });

  it("validates a finite distribution before performing potentially expensive expectation arithmetic", async () => {
    const primes = [
      2, 3, 5, 7, 11, 13, 17, 19, 23, 29,
      31, 37, 41, 43, 47, 53, 59, 61, 67, 71,
      73, 79, 83, 89, 97, 101, 103, 107, 109, 113
    ];
    const outcomes = primes.map((prime, index) => ({
      probability: index === primes.length - 1 ? fraction("1") : fraction("1", "100"),
      value: fraction("1", (BigInt(prime) ** 120n).toString())
    }));

    const result = await verifyJson(new ProbabilityArithmeticVerifier(), {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes,
        claimedExpectation: fraction("0")
      }
    });
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reason).toContain("MALFORMED_INTERPRETATION");
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

  it("contradicts a recurrence prefix as soon as an early value is wrong", async () => {
    const growth = "9".repeat(MAX_INTEGER_DECIMAL_DIGITS);
    const result = await verifyJson(new FiniteRecurrenceVerifier(), {
      protocol: FINITE_RECURRENCE_PROTOCOL,
      protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
      initial: [fraction("1")],
      recurrence: {
        kind: "LINEAR_PREVIOUS_TERMS",
        coefficients: [fraction(growth)],
        constant: fraction("0")
      },
      claim: {
        kind: "GENERATED_PREFIX",
        values: [
          fraction("2"),
          ...Array.from({ length: 19 }, () => fraction("0"))
        ]
      }
    });
    expect(result.status).toBe("CONTRADICTED");
    expect(result.reason).toContain("CLAIM_CONTRADICTED");
  });

  it("reduces non-pairwise recurrence cancellation before enforcing the state bound", async () => {
    const scale = 10n ** 120n;
    const multiplier = 10n ** 16n;
    const firstCoefficient = multiplier * scale;
    const secondCoefficient = -(multiplier - 1n) * scale * scale;
    const boundedExpected = scale ** 34n;

    expect(firstCoefficient.toString().length).toBeLessThanOrEqual(MAX_INTEGER_DECIMAL_DIGITS);
    expect((-secondCoefficient).toString().length).toBeLessThanOrEqual(MAX_INTEGER_DECIMAL_DIGITS);
    expect(boundedExpected.toString().length).toBeLessThanOrEqual(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS);
    expect((multiplier * boundedExpected).toString().length)
      .toBeGreaterThan(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS);

    const base = {
      protocol: FINITE_RECURRENCE_PROTOCOL,
      protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
      initial: [fraction("1"), fraction(scale.toString()), fraction((scale * scale).toString())],
      recurrence: {
        kind: "LINEAR_PREVIOUS_TERMS" as const,
        coefficients: [
          fraction(firstCoefficient.toString()),
          fraction(secondCoefficient.toString()),
          fraction("0")
        ],
        constant: fraction("0")
      }
    };

    const bounded = await verifyJson(new FiniteRecurrenceVerifier(), {
      ...base,
      claim: {
        kind: "VALUE_AT_INDEX",
        index: 34,
        value: fraction(boundedExpected.toString())
      }
    });
    expect(bounded.status).toBe("VERIFIED");

    const overLimit = await verifyJson(new FiniteRecurrenceVerifier(), {
      ...base,
      claim: {
        kind: "VALUE_AT_INDEX",
        index: 35,
        value: fraction("0")
      }
    });
    expect(overLimit.status).toBe("UNRESOLVED");
    expect(overLimit.reason).toContain("RESOURCE_LIMIT");
  });

  it("cancels exact oversized recurrence contributions before enforcing the state bound", async () => {
    const scale = 10n ** 120n;
    const scaleText = scale.toString();
    const scaleSquaredText = (scale * scale).toString();
    const boundedExpected = (scale ** 34n).toString();

    expect(boundedExpected.length).toBeLessThanOrEqual(MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS);

    const bounded = await verifyJson(new FiniteRecurrenceVerifier(), {
      protocol: FINITE_RECURRENCE_PROTOCOL,
      protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
      initial: [fraction("1"), fraction("1"), fraction(scaleText)],
      recurrence: {
        kind: "LINEAR_PREVIOUS_TERMS",
        coefficients: [
          fraction(scaleText),
          fraction(scaleText),
          fraction(`-${scaleSquaredText}`)
        ],
        constant: fraction("0")
      },
      claim: {
        kind: "VALUE_AT_INDEX",
        index: 69,
        value: fraction(boundedExpected)
      }
    });
    expect(bounded.status).toBe("VERIFIED");

    const overLimit = await verifyJson(new FiniteRecurrenceVerifier(), {
      protocol: FINITE_RECURRENCE_PROTOCOL,
      protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
      initial: [fraction("1"), fraction("1"), fraction(scaleText)],
      recurrence: {
        kind: "LINEAR_PREVIOUS_TERMS",
        coefficients: [
          fraction(scaleText),
          fraction(scaleText),
          fraction(`-${scaleSquaredText}`)
        ],
        constant: fraction("0")
      },
      claim: {
        kind: "VALUE_AT_INDEX",
        index: 70,
        value: fraction("0")
      }
    });
    expect(overLimit.status).toBe("UNRESOLVED");
    expect(overLimit.reason).toContain("RESOURCE_LIMIT");
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

  it("supports maximum recurrence order through the maximum checked index", async () => {
    const coefficients = [
      fraction("1"),
      ...Array.from({ length: 15 }, () => fraction("0"))
    ];
    const initial = Array.from({ length: 16 }, (_, index) => fraction(String(index)));
    const result = await verifyJson(new FiniteRecurrenceVerifier(), {
      protocol: FINITE_RECURRENCE_PROTOCOL,
      protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
      initial,
      recurrence: {
        kind: "LINEAR_PREVIOUS_TERMS",
        coefficients,
        constant: fraction("0")
      },
      claim: {
        kind: "VALUE_AT_INDEX",
        index: MAX_RECURRENCE_SEQUENCE_LENGTH - 1,
        value: fraction("15")
      }
    });
    expect(result.status).toBe("VERIFIED");
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

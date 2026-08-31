import { describe, expect, it } from "vitest";
import { VerificationResultSchema } from "../packages/domain/src/index.js";
import {
  COMBINATORIAL_COUNTING_PROTOCOL,
  COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
  COMBINATORIAL_COUNTING_VERIFIER_NAME,
  CombinatorialCountingVerifier,
  DETERMINISTIC_MATH_VERIFIERS,
  FINITE_RECURRENCE_PROTOCOL,
  FINITE_RECURRENCE_PROTOCOL_VERSION,
  FINITE_RECURRENCE_VERIFIER_NAME,
  FiniteRecurrenceVerifier,
  MAX_COMBINATORIAL_N,
  MAX_INTEGER_DECIMAL_DIGITS,
  MAX_MATH_STATEMENT_CHARACTERS,
  MAX_RECURRENCE_SEQUENCE_LENGTH,
  MODULAR_ARITHMETIC_PROTOCOL,
  MODULAR_ARITHMETIC_PROTOCOL_VERSION,
  MODULAR_ARITHMETIC_VERIFIER_NAME,
  ModularArithmeticVerifier,
  PROBABILITY_ARITHMETIC_VERIFIER_NAME,
  RATIONAL_ARITHMETIC_VERIFIER_NAME,
  createDeterministicMathVerifier
} from "../packages/verification/src/index.js";

const integer = (value: string) => ({ kind: "INTEGER" as const, value });
const rational = (numerator: string, denominator = "1") => ({ numerator, denominator });

describe("deterministic math verifier invariants", () => {
  it("abstains for low/invalid confidence, malformed JSON, and oversized statements", async () => {
    const verifier = new ModularArithmeticVerifier();
    const valid = JSON.stringify({
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: { kind: "DIVISIBILITY", divisor: "2", dividend: integer("4") }
    });

    expect((await verifier.verify(valid, 0.75)).status).toBe("UNRESOLVED");
    expect((await verifier.verify("{not-json", 1)).status).toBe("UNRESOLVED");
    expect((await verifier.verify("[".padEnd(MAX_MATH_STATEMENT_CHARACTERS + 1, " "), 1)).status).toBe("UNRESOLVED");

    for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      const result = await verifier.verify(valid, confidence);
      expect(VerificationResultSchema.parse(result)).toEqual(result);
      expect(result.status).toBe("UNRESOLVED");
    }
  });

  it("enforces exact arithmetic intermediate limits", async () => {
    const result = await new ModularArithmeticVerifier().verify(JSON.stringify({
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "CONGRUENCE",
        left: {
          kind: "POWER",
          base: integer("9".repeat(MAX_INTEGER_DECIMAL_DIGITS)),
          exponent: 1024
        },
        right: integer("0"),
        modulus: "7"
      }
    }), 1);
    expect(result).toMatchObject({ status: "UNRESOLVED" });
    expect(result.reason).toContain("RESOURCE_LIMIT");
  });

  it("enforces recurrence and combinatorial cardinality bounds", async () => {
    const recurrence = await new FiniteRecurrenceVerifier().verify(JSON.stringify({
      protocol: FINITE_RECURRENCE_PROTOCOL,
      protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
      initial: [rational("0")],
      recurrence: {
        kind: "LINEAR_PREVIOUS_TERMS",
        coefficients: [rational("1")],
        constant: rational("1")
      },
      claim: { kind: "VALUE_AT_INDEX", index: MAX_RECURRENCE_SEQUENCE_LENGTH, value: rational("0") }
    }), 1);
    expect(recurrence.status).toBe("UNRESOLVED");

    const combinatorial = await new CombinatorialCountingVerifier().verify(JSON.stringify({
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: { kind: "BINOMIAL", n: MAX_COMBINATORIAL_N + 1, k: 1, claimed: "0" }
    }), 1);
    expect(combinatorial.status).toBe("UNRESOLVED");
  });

  it("enforces generic structured-input depth before recursive schema evaluation", async () => {
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 40; depth += 1) deep = { child: deep };
    const result = await new ModularArithmeticVerifier().verify(JSON.stringify({
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: { kind: "DIVISIBILITY", divisor: "2", dividend: integer("4"), extra: deep }
    }), 1);
    expect(result).toMatchObject({ status: "UNRESOLVED" });
    expect(result.reason).toContain("RESOURCE_LIMIT");
  });

  it("is deterministic across repeated exact evaluation", async () => {
    const verifier = new CombinatorialCountingVerifier();
    const statement = JSON.stringify({
      protocol: COMBINATORIAL_COUNTING_PROTOCOL,
      protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
      claim: { kind: "BINOMIAL", n: 100, k: 50, claimed: "100891344545564193334812497256" }
    });
    const first = await verifier.verify(statement, 1);
    const second = await verifier.verify(statement, 1);
    expect(second).toEqual(first);
  });

  it("exposes verifier factories without embedding evidence authorization", () => {
    expect(DETERMINISTIC_MATH_VERIFIERS).toHaveLength(5);
    expect(DETERMINISTIC_MATH_VERIFIERS.map((entry) => entry.verifier)).toEqual([
      MODULAR_ARITHMETIC_VERIFIER_NAME,
      RATIONAL_ARITHMETIC_VERIFIER_NAME,
      FINITE_RECURRENCE_VERIFIER_NAME,
      COMBINATORIAL_COUNTING_VERIFIER_NAME,
      PROBABILITY_ARITHMETIC_VERIFIER_NAME
    ]);
    for (const descriptor of DETERMINISTIC_MATH_VERIFIERS) {
      expect(descriptor).not.toHaveProperty("evidenceKey");
      expect(descriptor).not.toHaveProperty("problemId");
      expect(createDeterministicMathVerifier(descriptor.verifier)).toBeDefined();
    }
    expect(createDeterministicMathVerifier("unknown-verifier@1")).toBeUndefined();
  });
});

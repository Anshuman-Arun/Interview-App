import { describe, expect, it } from "vitest";
import { VerificationResultSchema, type DeterministicVerifier } from "../packages/domain/src/index.js";
import {
  MAX_PROBABILITY_OUTCOMES,
  MODULAR_ARITHMETIC_PROTOCOL,
  MODULAR_ARITHMETIC_PROTOCOL_VERSION,
  MODULAR_ARITHMETIC_VERIFIER_NAME,
  ModularArithmeticVerifier,
  PROBABILITY_ARITHMETIC_PROTOCOL,
  PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
  PROBABILITY_ARITHMETIC_VERIFIER_NAME,
  ProbabilityArithmeticVerifier,
  RATIONAL_ARITHMETIC_PROTOCOL,
  RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
  RATIONAL_ARITHMETIC_VERIFIER_NAME,
  RationalArithmeticVerifier
} from "../packages/verification/src/index.js";

const integer = (value: string) => ({ kind: "INTEGER" as const, value });
const rational = (numerator: string, denominator = "1") => ({ numerator, denominator });
const rationalExpression = (numerator: string, denominator = "1") => ({
  kind: "RATIONAL" as const,
  value: rational(numerator, denominator)
});

async function verifyJson(verifier: DeterministicVerifier, value: unknown, confidence = 1) {
  const result = await verifier.verify(JSON.stringify(value), confidence);
  expect(VerificationResultSchema.parse(result)).toEqual(result);
  return result;
}

describe("deterministic arithmetic verifiers", () => {
  it("verifies normalized negative congruences and contradicts false divisibility", async () => {
    const verifier = new ModularArithmeticVerifier();
    const congruence = await verifyJson(verifier, {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "CONGRUENCE",
        left: { kind: "ADD", left: integer("-8"), right: integer("3") },
        right: integer("2"),
        modulus: "7"
      }
    });
    expect(congruence).toMatchObject({ status: "VERIFIED", verifier: MODULAR_ARITHMETIC_VERIFIER_NAME });

    const divisibility = await verifyJson(verifier, {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: { kind: "DIVISIBILITY", divisor: "4", dividend: integer("10") }
    });
    expect(divisibility.status).toBe("CONTRADICTED");

    const zeroDividesZero = await verifyJson(verifier, {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: { kind: "DIVISIBILITY", divisor: "0", dividend: integer("0") }
    });
    expect(zeroDividesZero.status).toBe("VERIFIED");

    const zeroDividesNonzero = await verifyJson(verifier, {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: { kind: "DIVISIBILITY", divisor: "0", dividend: integer("1") }
    });
    expect(zeroDividesNonzero.status).toBe("CONTRADICTED");
  });

  it("abstains on invalid modular input and unsupported prose", async () => {
    const invalid = await verifyJson(new ModularArithmeticVerifier(), {
      protocol: MODULAR_ARITHMETIC_PROTOCOL,
      protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
      claim: { kind: "CONGRUENCE", left: integer("1"), right: integer("1"), modulus: "0" }
    });
    expect(invalid.status).toBe("UNRESOLVED");
    const prose = await new ModularArithmeticVerifier().verify("a is congruent to b", 1);
    expect(prose.status).toBe("UNRESOLVED");
  });

  it("verifies exact structured rational equality without floating point", async () => {
    const result = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: {
          kind: "ADD",
          left: rationalExpression("1", "2"),
          right: rationalExpression("1", "3")
        },
        right: rationalExpression("5", "6")
      }
    });
    expect(result).toMatchObject({ status: "VERIFIED", verifier: RATIONAL_ARITHMETIC_VERIFIER_NAME });
  });

  it("distinguishes false rational equality from undefined arithmetic", async () => {
    const falseEquality = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: { kind: "EQUALITY", left: rationalExpression("1", "2"), right: rationalExpression("2", "3") }
    });
    expect(falseEquality.status).toBe("CONTRADICTED");

    const divisionByZero = await verifyJson(new RationalArithmeticVerifier(), {
      protocol: RATIONAL_ARITHMETIC_PROTOCOL,
      protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "EQUALITY",
        left: { kind: "DIVIDE", left: rationalExpression("1"), right: rationalExpression("0") },
        right: rationalExpression("0")
      }
    });
    expect(divisionByZero.status).toBe("UNRESOLVED");
    expect(divisionByZero.reason).toContain("ARITHMETIC_UNDEFINED");
  });

  it("checks expectation, conditional probability, and Bayes arithmetic exactly", async () => {
    const verifier = new ProbabilityArithmeticVerifier();
    const expectation = await verifyJson(verifier, {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes: [
          { probability: rational("1", "2"), value: rational("1") },
          { probability: rational("1", "2"), value: rational("3") }
        ],
        claimedExpectation: rational("2")
      }
    });
    expect(expectation.status).toBe("VERIFIED");

    const countConditional = await verifyJson(verifier, {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "CONDITIONAL_FROM_COUNTS",
        jointCount: 2,
        conditionCount: 5,
        claimedProbability: rational("4", "10")
      }
    });
    expect(countConditional.status).toBe("VERIFIED");

    const probabilityConditional = await verifyJson(verifier, {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "CONDITIONAL_FROM_PROBABILITIES",
        jointProbability: rational("1", "4"),
        conditionProbability: rational("1", "2"),
        claimedProbability: rational("-1", "-2")
      }
    });
    expect(probabilityConditional.status).toBe("VERIFIED");

    const bayes = await verifyJson(verifier, {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "BAYES",
        prior: rational("1", "4"),
        likelihoodGivenHypothesis: rational("1", "2"),
        evidenceProbability: rational("1", "4"),
        claimedPosterior: rational("2", "4")
      }
    });
    expect(bayes).toMatchObject({ status: "VERIFIED", verifier: PROBABILITY_ARITHMETIC_VERIFIER_NAME });
  });

  it("abstains on invalid probability models and outcome resource overflow", async () => {
    const verifier = new ProbabilityArithmeticVerifier();
    const notNormalized = await verifyJson(verifier, {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: {
        kind: "FINITE_EXPECTATION",
        outcomes: [
          { probability: rational("1", "2"), value: rational("1") },
          { probability: rational("1", "4"), value: rational("3") }
        ],
        claimedExpectation: rational("5", "4")
      }
    });
    expect(notNormalized.status).toBe("UNRESOLVED");

    const tooManyOutcomes = Array.from({ length: MAX_PROBABILITY_OUTCOMES + 1 }, () => ({
      probability: rational("0"),
      value: rational("0")
    }));
    const excessive = await verifyJson(verifier, {
      protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
      protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
      claim: { kind: "FINITE_EXPECTATION", outcomes: tooManyOutcomes, claimedExpectation: rational("0") }
    });
    expect(excessive.status).toBe("UNRESOLVED");
  });
});

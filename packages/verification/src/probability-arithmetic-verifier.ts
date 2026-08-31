import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import { IntermediateRationalInputSchema, RationalInputSchema } from "./rational-expression.js";
import { MAX_COMBINATORIAL_N, MAX_PROBABILITY_OUTCOMES } from "./limits.js";
import {
  BoundedMathError,
  addRationals,
  assertIntermediateIntegerBound,
  compareRationals,
  divideRationals,
  equalRationals,
  multiplyRationals,
  parseIntermediateRationalInput,
  parseRationalInput,
  rational,
  subtractRationals,
  type ExactRational
} from "./math-utils.js";
import { booleanClaimResult, mathFailure, prepareStructuredStatement } from "./verifier-common.js";

export const PROBABILITY_ARITHMETIC_PROTOCOL = "INTERVIEW_APP_PROBABILITY_ARITHMETIC_CLAIM" as const;
export const PROBABILITY_ARITHMETIC_PROTOCOL_VERSION = 1 as const;
export const PROBABILITY_ARITHMETIC_VERIFIER_NAME = "deterministic-probability-arithmetic-verifier@1" as const;

const CountSchema = z.number().int().min(0).max(MAX_COMBINATORIAL_N);
const PositiveCountSchema = z.number().int().min(1).max(MAX_COMBINATORIAL_N);

function isProbabilityInput(value: z.infer<typeof RationalInputSchema>): boolean {
  try {
    const parsed = parseRationalInput(value);
    return compareRationals(parsed, rational(0n, 1n)) >= 0
      && compareRationals(parsed, rational(1n, 1n)) <= 0;
  } catch {
    return false;
  }
}

function isPositiveProbabilityInput(value: z.infer<typeof RationalInputSchema>): boolean {
  if (!isProbabilityInput(value)) return false;
  try {
    return parseRationalInput(value).numerator > 0n;
  } catch {
    return false;
  }
}

export const ProbabilityInputSchema = RationalInputSchema.refine(
  isProbabilityInput,
  "Probability must lie between 0 and 1 inclusive"
);

export const PositiveProbabilityInputSchema = RationalInputSchema.refine(
  isPositiveProbabilityInput,
  "Probability must be greater than 0 and at most 1"
);

export const ProbabilityResultSchema = IntermediateRationalInputSchema;

export const ProbabilityArithmeticClaimSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("FINITE_EXPECTATION"),
    outcomes: z.array(z.object({ probability: ProbabilityInputSchema, value: RationalInputSchema }).strict())
      .min(1).max(MAX_PROBABILITY_OUTCOMES),
    claimedExpectation: IntermediateRationalInputSchema
  }).strict(),
  z.object({
    kind: z.literal("CONDITIONAL_FROM_COUNTS"),
    jointCount: CountSchema,
    conditionCount: PositiveCountSchema,
    claimedProbability: ProbabilityResultSchema
  }).strict().superRefine((value, context) => {
    if (value.jointCount > value.conditionCount) {
      context.addIssue({ code: "custom", path: ["jointCount"], message: "Joint count cannot exceed the conditioning count" });
    }
  }),
  z.object({
    kind: z.literal("CONDITIONAL_FROM_PROBABILITIES"),
    jointProbability: ProbabilityInputSchema,
    conditionProbability: PositiveProbabilityInputSchema,
    claimedProbability: ProbabilityResultSchema
  }).strict(),
  z.object({
    kind: z.literal("BAYES"),
    prior: ProbabilityInputSchema,
    likelihoodGivenHypothesis: ProbabilityInputSchema,
    evidenceProbability: PositiveProbabilityInputSchema,
    claimedPosterior: ProbabilityResultSchema
  }).strict()
]);

export const ProbabilityArithmeticInterpretationSchema = z.object({
  protocol: z.literal(PROBABILITY_ARITHMETIC_PROTOCOL),
  protocolVersion: z.literal(PROBABILITY_ARITHMETIC_PROTOCOL_VERSION),
  claim: ProbabilityArithmeticClaimSchema
}).strict();
export type ProbabilityArithmeticInterpretation = z.infer<typeof ProbabilityArithmeticInterpretationSchema>;

function assertProbability(value: ExactRational, label: string): ExactRational {
  const zero = rational(0n, 1n);
  const one = rational(1n, 1n);
  if (compareRationals(value, zero) < 0 || compareRationals(value, one) > 0) {
    throw new BoundedMathError("INVALID_PROBABILITY", `${label} must lie between 0 and 1 inclusive`);
  }
  return value;
}

function probabilityNormalizationGcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

interface WideRationalAccumulator {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function addToWideAccumulator(
  total: WideRationalAccumulator,
  value: ExactRational
): WideRationalAccumulator {
  const commonFactor = probabilityNormalizationGcd(total.denominator, value.denominator);
  const leftScale = value.denominator / commonFactor;
  const rightScale = total.denominator / commonFactor;
  const numerator = total.numerator * leftScale + value.numerator * rightScale;
  const denominator = total.denominator * leftScale;
  const cancellation = probabilityNormalizationGcd(numerator, denominator);
  return {
    numerator: numerator / cancellation,
    denominator: denominator / cancellation
  };
}

function assertProbabilityMassIsOne(values: readonly ExactRational[]): void {
  const groups = new Map<string, { denominator: bigint; numerator: bigint }>();
  for (const value of values) {
    const key = value.denominator.toString();
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { denominator: value.denominator, numerator: value.numerator });
    } else {
      existing.numerator += value.numerator;
    }
  }

  let total: WideRationalAccumulator = { numerator: 0n, denominator: 1n };
  for (const { numerator, denominator } of groups.values()) {
    // Probability inputs are individually limited to 256 decimal digits and
    // there are at most MAX_PROBABILITY_OUTCOMES entries. Therefore this exact
    // normalization denominator is bounded by the product of the supplied
    // denominators even when it is larger than the 4,096-digit result/state
    // limit. It is validation-only and is never exposed as an ExactRational.
    total = addToWideAccumulator(total, { numerator, denominator });

    if (total.numerator > total.denominator) {
      throw new BoundedMathError(
        "INVALID_PROBABILITY",
        "Finite expectation probabilities cannot sum to more than 1"
      );
    }
  }

  if (total.numerator !== total.denominator) {
    throw new BoundedMathError(
      "INVALID_PROBABILITY",
      "Finite expectation probabilities must sum exactly to 1"
    );
  }
}

function evaluateProbabilityClaim(
  claim: z.infer<typeof ProbabilityArithmeticClaimSchema>
): { readonly actual: ExactRational; readonly claimed: ExactRational } {
  switch (claim.kind) {
    case "FINITE_EXPECTATION": {
      const outcomes = claim.outcomes.map((outcome) => ({
        probability: assertProbability(parseRationalInput(outcome.probability), "Outcome probability"),
        value: outcome.value
      }));
      assertProbabilityMassIsOne(outcomes.map((outcome) => outcome.probability));

      const expectationTerms = outcomes.map((outcome) =>
        multiplyRationals(outcome.probability, parseRationalInput(outcome.value))
      );
      let expectationTotal: WideRationalAccumulator = { numerator: 0n, denominator: 1n };
      for (const term of expectationTerms) {
        expectationTotal = addToWideAccumulator(expectationTotal, term);
      }
      const expectation = rational(
        assertIntermediateIntegerBound(expectationTotal.numerator),
        assertIntermediateIntegerBound(expectationTotal.denominator)
      );
      return { actual: expectation, claimed: parseIntermediateRationalInput(claim.claimedExpectation) };
    }
    case "CONDITIONAL_FROM_COUNTS":
      return {
        actual: rational(BigInt(claim.jointCount), BigInt(claim.conditionCount)),
        claimed: parseIntermediateRationalInput(claim.claimedProbability)
      };
    case "CONDITIONAL_FROM_PROBABILITIES": {
      const joint = assertProbability(parseRationalInput(claim.jointProbability), "Joint probability");
      const condition = assertProbability(parseRationalInput(claim.conditionProbability), "Condition probability");
      if (condition.numerator === 0n) {
        throw new BoundedMathError("INVALID_PROBABILITY", "Condition probability must be positive");
      }
      if (compareRationals(joint, condition) > 0) {
        throw new BoundedMathError("INVALID_PROBABILITY", "Joint probability cannot exceed the conditioning probability");
      }
      return { actual: divideRationals(joint, condition), claimed: parseIntermediateRationalInput(claim.claimedProbability) };
    }
    case "BAYES": {
      const prior = assertProbability(parseRationalInput(claim.prior), "Prior probability");
      const likelihood = assertProbability(parseRationalInput(claim.likelihoodGivenHypothesis), "Conditional likelihood");
      const evidence = assertProbability(parseRationalInput(claim.evidenceProbability), "Evidence probability");
      if (evidence.numerator === 0n) {
        throw new BoundedMathError("INVALID_PROBABILITY", "Evidence probability must be positive");
      }
      const joint = multiplyRationals(prior, likelihood);
      const maximumEvidence = addRationals(joint, subtractRationals(rational(1n, 1n), prior));
      if (compareRationals(evidence, joint) < 0 || compareRationals(evidence, maximumEvidence) > 0) {
        throw new BoundedMathError(
          "INVALID_PROBABILITY",
          "Bayes inputs are inconsistent with any probability assigned to the complementary hypothesis"
        );
      }
      const posterior = divideRationals(joint, evidence);
      assertProbability(posterior, "Computed posterior probability");
      return { actual: posterior, claimed: parseIntermediateRationalInput(claim.claimedPosterior) };
    }
  }
}

export class ProbabilityArithmeticVerifier implements DeterministicVerifier {
  public async verify(statement: string, interpretationConfidence: number): Promise<VerificationResult> {
    const prepared = prepareStructuredStatement(
      statement,
      interpretationConfidence,
      PROBABILITY_ARITHMETIC_VERIFIER_NAME,
      ProbabilityArithmeticInterpretationSchema
    );
    if (!prepared.ok) return prepared.result;

    try {
      const evaluated = evaluateProbabilityClaim(prepared.data.claim);
      return booleanClaimResult(
        equalRationals(evaluated.actual, evaluated.claimed),
        prepared.interpretationConfidence,
        PROBABILITY_ARITHMETIC_VERIFIER_NAME,
        "Exact rational probability arithmetic matches the supplied claim",
        "Exact rational probability arithmetic does not match the supplied claim"
      );
    } catch (error) {
      return mathFailure(error, prepared.interpretationConfidence, PROBABILITY_ARITHMETIC_VERIFIER_NAME);
    }
  }
}

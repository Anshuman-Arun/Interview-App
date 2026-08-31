import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import { RationalInputSchema } from "./rational-expression.js";
import { MAX_COMBINATORIAL_N, MAX_PROBABILITY_OUTCOMES } from "./limits.js";
import {
  BoundedMathError,
  addRationals,
  compareRationals,
  divideRationals,
  equalRationals,
  multiplyRationals,
  parseRationalInput,
  rational,
  type ExactRational
} from "./math-utils.js";
import { booleanClaimResult, mathFailure, prepareStructuredStatement } from "./verifier-common.js";

export const PROBABILITY_ARITHMETIC_PROTOCOL = "INTERVIEW_APP_PROBABILITY_ARITHMETIC_CLAIM" as const;
export const PROBABILITY_ARITHMETIC_PROTOCOL_VERSION = 1 as const;
export const PROBABILITY_ARITHMETIC_VERIFIER_NAME = "deterministic-probability-arithmetic-verifier@1" as const;

const CountSchema = z.number().int().min(0).max(MAX_COMBINATORIAL_N);
const PositiveCountSchema = z.number().int().min(1).max(MAX_COMBINATORIAL_N);

export const ProbabilityArithmeticClaimSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("FINITE_EXPECTATION"),
    outcomes: z.array(z.object({ probability: RationalInputSchema, value: RationalInputSchema }).strict())
      .min(1).max(MAX_PROBABILITY_OUTCOMES),
    claimedExpectation: RationalInputSchema
  }).strict(),
  z.object({
    kind: z.literal("CONDITIONAL_FROM_COUNTS"),
    jointCount: CountSchema,
    conditionCount: PositiveCountSchema,
    claimedProbability: RationalInputSchema
  }).strict().superRefine((value, context) => {
    if (value.jointCount > value.conditionCount) {
      context.addIssue({ code: "custom", path: ["jointCount"], message: "Joint count cannot exceed the conditioning count" });
    }
  }),
  z.object({
    kind: z.literal("CONDITIONAL_FROM_PROBABILITIES"),
    jointProbability: RationalInputSchema,
    conditionProbability: RationalInputSchema,
    claimedProbability: RationalInputSchema
  }).strict(),
  z.object({
    kind: z.literal("BAYES"),
    prior: RationalInputSchema,
    likelihoodGivenHypothesis: RationalInputSchema,
    evidenceProbability: RationalInputSchema,
    claimedPosterior: RationalInputSchema
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
    throw new BoundedMathError("INVALID_COMBINATORIAL_ARGUMENT", `${label} must lie between 0 and 1 inclusive`);
  }
  return value;
}

function evaluateProbabilityClaim(
  claim: z.infer<typeof ProbabilityArithmeticClaimSchema>
): { readonly actual: ExactRational; readonly claimed: ExactRational } {
  switch (claim.kind) {
    case "FINITE_EXPECTATION": {
      let totalProbability = rational(0n, 1n);
      let expectation = rational(0n, 1n);
      for (const outcome of claim.outcomes) {
        const probability = assertProbability(parseRationalInput(outcome.probability), "Outcome probability");
        totalProbability = addRationals(totalProbability, probability);
        expectation = addRationals(expectation, multiplyRationals(probability, parseRationalInput(outcome.value)));
      }
      if (!equalRationals(totalProbability, rational(1n, 1n))) {
        throw new BoundedMathError("INVALID_COMBINATORIAL_ARGUMENT", "Finite expectation probabilities must sum exactly to 1");
      }
      return { actual: expectation, claimed: parseRationalInput(claim.claimedExpectation) };
    }
    case "CONDITIONAL_FROM_COUNTS":
      return {
        actual: rational(BigInt(claim.jointCount), BigInt(claim.conditionCount)),
        claimed: parseRationalInput(claim.claimedProbability)
      };
    case "CONDITIONAL_FROM_PROBABILITIES": {
      const joint = assertProbability(parseRationalInput(claim.jointProbability), "Joint probability");
      const condition = assertProbability(parseRationalInput(claim.conditionProbability), "Condition probability");
      if (condition.numerator === 0n) throw new BoundedMathError("DIVISION_BY_ZERO", "Condition probability must be positive");
      if (compareRationals(joint, condition) > 0) {
        throw new BoundedMathError("INVALID_COMBINATORIAL_ARGUMENT", "Joint probability cannot exceed the conditioning probability");
      }
      return { actual: divideRationals(joint, condition), claimed: parseRationalInput(claim.claimedProbability) };
    }
    case "BAYES": {
      const prior = assertProbability(parseRationalInput(claim.prior), "Prior probability");
      const likelihood = assertProbability(parseRationalInput(claim.likelihoodGivenHypothesis), "Conditional likelihood");
      const evidence = assertProbability(parseRationalInput(claim.evidenceProbability), "Evidence probability");
      if (evidence.numerator === 0n) throw new BoundedMathError("DIVISION_BY_ZERO", "Evidence probability must be positive");
      const posterior = divideRationals(multiplyRationals(prior, likelihood), evidence);
      assertProbability(posterior, "Computed posterior probability");
      return { actual: posterior, claimed: parseRationalInput(claim.claimedPosterior) };
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

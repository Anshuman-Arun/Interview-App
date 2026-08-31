import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import { MAX_RECURRENCE_ORDER, MAX_RECURRENCE_SEQUENCE_LENGTH } from "./limits.js";
import { IntermediateRationalInputSchema, RationalInputSchema } from "./rational-expression.js";
import {
  equalRationals,
  multiplyRationals,
  parseIntermediateRationalInput,
  parseRationalInput,
  sumRationals,
  type ExactRational
} from "./math-utils.js";
import { booleanClaimResult, mathFailure, prepareStructuredStatement } from "./verifier-common.js";

export const FINITE_RECURRENCE_PROTOCOL = "INTERVIEW_APP_FINITE_RECURRENCE_CLAIM" as const;
export const FINITE_RECURRENCE_PROTOCOL_VERSION = 1 as const;
export const FINITE_RECURRENCE_VERIFIER_NAME = "deterministic-finite-recurrence-verifier@1" as const;

const RecurrenceRuleSchema = z.object({
  kind: z.literal("LINEAR_PREVIOUS_TERMS"),
  coefficients: z.array(RationalInputSchema).min(1).max(MAX_RECURRENCE_ORDER),
  constant: RationalInputSchema
}).strict();

const RecurrenceClaimSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("GENERATED_PREFIX"),
    values: z.array(IntermediateRationalInputSchema).min(1).max(MAX_RECURRENCE_SEQUENCE_LENGTH)
  }).strict(),
  z.object({
    kind: z.literal("VALUE_AT_INDEX"),
    index: z.number().int().min(0).max(MAX_RECURRENCE_SEQUENCE_LENGTH - 1),
    value: IntermediateRationalInputSchema
  }).strict()
]);

export const FiniteRecurrenceInterpretationSchema = z.object({
  protocol: z.literal(FINITE_RECURRENCE_PROTOCOL),
  protocolVersion: z.literal(FINITE_RECURRENCE_PROTOCOL_VERSION),
  initial: z.array(RationalInputSchema).min(1).max(MAX_RECURRENCE_ORDER),
  recurrence: RecurrenceRuleSchema,
  claim: RecurrenceClaimSchema
}).strict().superRefine((value, context) => {
  if (value.initial.length !== value.recurrence.coefficients.length) {
    context.addIssue({ code: "custom", path: ["initial"], message: "Initial-condition count must equal recurrence order" });
  }
});
export type FiniteRecurrenceInterpretation = z.infer<typeof FiniteRecurrenceInterpretationSchema>;

interface RecurrenceContribution {
  readonly coefficient: ExactRational;
  readonly previous: ExactRational;
}

function productsAreAdditiveInverses(
  left: RecurrenceContribution,
  right: RecurrenceContribution
): boolean {
  // Each coefficient is an operand-sized rational and each previous value is
  // already an intermediate-sized rational. Cross-products here are therefore
  // bounded comparison temporaries, not recurrence states.
  const leftNumerator = left.coefficient.numerator * left.previous.numerator;
  const leftDenominator = left.coefficient.denominator * left.previous.denominator;
  const rightNumerator = right.coefficient.numerator * right.previous.numerator;
  const rightDenominator = right.coefficient.denominator * right.previous.denominator;
  return leftNumerator * rightDenominator === -(rightNumerator * leftDenominator);
}

function recurrenceStep(
  sequence: readonly ExactRational[],
  coefficients: readonly ExactRational[],
  constant: ExactRational
): ExactRational {
  const contributions: RecurrenceContribution[] = coefficients.map((coefficient, index) => {
    const previous = sequence[sequence.length - index - 1];
    if (previous === undefined) {
      throw new Error("Recurrence evaluation encountered an impossible missing term");
    }
    return { coefficient, previous };
  });
  const cancelled = new Set<number>();

  for (let left = 0; left < contributions.length; left += 1) {
    if (cancelled.has(left)) continue;
    const leftContribution = contributions[left];
    if (leftContribution === undefined) continue;

    for (let right = left + 1; right < contributions.length; right += 1) {
      if (cancelled.has(right)) continue;
      const rightContribution = contributions[right];
      if (
        rightContribution !== undefined
        && productsAreAdditiveInverses(leftContribution, rightContribution)
      ) {
        cancelled.add(left);
        cancelled.add(right);
        break;
      }
    }
  }

  const terms: ExactRational[] = [constant];
  for (let index = 0; index < contributions.length; index += 1) {
    if (cancelled.has(index)) continue;
    const contribution = contributions[index];
    if (contribution === undefined) continue;
    terms.push(multiplyRationals(contribution.coefficient, contribution.previous));
  }
  return sumRationals(terms);
}

function extendSequence(
  initial: readonly ExactRational[],
  coefficients: readonly ExactRational[],
  constant: ExactRational,
  requiredLength: number
): readonly ExactRational[] {
  const sequence = [...initial];
  while (sequence.length < requiredLength) {
    sequence.push(recurrenceStep(sequence, coefficients, constant));
  }
  return sequence;
}

export class FiniteRecurrenceVerifier implements DeterministicVerifier {
  public async verify(statement: string, interpretationConfidence: number): Promise<VerificationResult> {
    const prepared = prepareStructuredStatement(
      statement,
      interpretationConfidence,
      FINITE_RECURRENCE_VERIFIER_NAME,
      FiniteRecurrenceInterpretationSchema
    );
    if (!prepared.ok) return prepared.result;

    try {
      const initial = prepared.data.initial.map(parseRationalInput);
      const coefficients = prepared.data.recurrence.coefficients.map(parseRationalInput);
      const constant = parseRationalInput(prepared.data.recurrence.constant);
      const claim = prepared.data.claim;

      if (claim.kind === "VALUE_AT_INDEX") {
        const sequence = extendSequence(initial, coefficients, constant, claim.index + 1);
        const actual = sequence[claim.index];
        if (actual === undefined) throw new Error("Recurrence index unexpectedly unavailable");
        return booleanClaimResult(
          equalRationals(actual, parseIntermediateRationalInput(claim.value)),
          prepared.interpretationConfidence,
          FINITE_RECURRENCE_VERIFIER_NAME,
          "Finite recurrence evaluation matches the claimed indexed value",
          "Finite recurrence evaluation does not match the claimed indexed value"
        );
      }

      const sequence = extendSequence(initial, coefficients, constant, claim.values.length);
      const claimed = claim.values.map(parseIntermediateRationalInput);
      const matches = claimed.every((value, index) => {
        const actual = sequence[index];
        return actual !== undefined && equalRationals(actual, value);
      });
      return booleanClaimResult(
        matches,
        prepared.interpretationConfidence,
        FINITE_RECURRENCE_VERIFIER_NAME,
        "Finite recurrence evaluation matches every supplied prefix value",
        "Finite recurrence evaluation disagrees with at least one supplied prefix value"
      );
    } catch (error) {
      return mathFailure(error, prepared.interpretationConfidence, FINITE_RECURRENCE_VERIFIER_NAME);
    }
  }
}

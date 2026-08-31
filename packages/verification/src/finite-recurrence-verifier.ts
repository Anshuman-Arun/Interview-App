import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import { MAX_RECURRENCE_ORDER, MAX_RECURRENCE_SEQUENCE_LENGTH } from "./limits.js";
import { IntermediateRationalInputSchema, RationalInputSchema } from "./rational-expression.js";
import {
  equalRationals,
  gcd,
  parseIntermediateRationalInput,
  parseRationalInput,
  rational,
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

interface WideRecurrenceContribution {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function wideRecurrenceProduct(
  coefficient: ExactRational,
  previous: ExactRational
): WideRecurrenceContribution {
  // Both inputs are already normalized and individually bounded. Cross-cancel
  // before multiplying so this produces the canonical reduced product without
  // applying the 4,096-digit recurrence-state bound yet.
  const leftCancellation = gcd(coefficient.numerator, previous.denominator);
  const rightCancellation = gcd(previous.numerator, coefficient.denominator);
  return {
    numerator:
      (coefficient.numerator / leftCancellation)
      * (previous.numerator / rightCancellation),
    denominator:
      (coefficient.denominator / rightCancellation)
      * (previous.denominator / leftCancellation)
  };
}

function wideContributionKey(value: WideRecurrenceContribution): string {
  return `${value.numerator.toString()}/${value.denominator.toString()}`;
}

function recurrenceStep(
  sequence: readonly ExactRational[],
  coefficients: readonly ExactRational[],
  constant: ExactRational
): ExactRational {
  const unmatched = new Map<string, { value: WideRecurrenceContribution; count: number }>();

  coefficients.forEach((coefficient, index) => {
    const previous = sequence[sequence.length - index - 1];
    if (previous === undefined) {
      throw new Error("Recurrence evaluation encountered an impossible missing term");
    }

    const contribution = wideRecurrenceProduct(coefficient, previous);
    if (contribution.numerator === 0n) return;

    const oppositeKey = wideContributionKey({
      numerator: -contribution.numerator,
      denominator: contribution.denominator
    });
    const opposite = unmatched.get(oppositeKey);
    if (opposite !== undefined && opposite.count > 0) {
      opposite.count -= 1;
      if (opposite.count === 0) unmatched.delete(oppositeKey);
      return;
    }

    const key = wideContributionKey(contribution);
    const existing = unmatched.get(key);
    if (existing === undefined) unmatched.set(key, { value: contribution, count: 1 });
    else existing.count += 1;
  });

  const terms: ExactRational[] = [constant];
  for (const entry of unmatched.values()) {
    const term = rational(entry.value.numerator, entry.value.denominator);
    for (let index = 0; index < entry.count; index += 1) terms.push(term);
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

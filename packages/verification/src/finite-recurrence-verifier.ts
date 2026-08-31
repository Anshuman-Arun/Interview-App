import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import { MAX_RECURRENCE_ORDER, MAX_RECURRENCE_SEQUENCE_LENGTH } from "./limits.js";
import { IntermediateRationalInputSchema, RationalInputSchema } from "./rational-expression.js";
import {
  assertIntermediateIntegerBound,
  equalRationals,
  parseIntermediateRationalInput,
  parseRationalInput,
  rational,
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

interface WideRecurrenceValue {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function recurrenceWideGcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function wideRecurrenceProduct(
  coefficient: ExactRational,
  previous: ExactRational
): WideRecurrenceValue {
  const leftCancellation = recurrenceWideGcd(coefficient.numerator, previous.denominator);
  const rightCancellation = recurrenceWideGcd(previous.numerator, coefficient.denominator);
  return {
    numerator:
      (coefficient.numerator / leftCancellation)
      * (previous.numerator / rightCancellation),
    denominator:
      (coefficient.denominator / rightCancellation)
      * (previous.denominator / leftCancellation)
  };
}

function addWideRecurrenceValues(
  left: WideRecurrenceValue,
  right: WideRecurrenceValue
): WideRecurrenceValue {
  const commonFactor = recurrenceWideGcd(left.denominator, right.denominator);
  const leftScale = right.denominator / commonFactor;
  const rightScale = left.denominator / commonFactor;
  const numerator = left.numerator * leftScale + right.numerator * rightScale;
  const denominator = left.denominator * leftScale;
  const cancellation = recurrenceWideGcd(numerator, denominator);
  return {
    numerator: numerator / cancellation,
    denominator: denominator / cancellation
  };
}

function recurrenceStep(
  sequence: readonly ExactRational[],
  coefficients: readonly ExactRational[],
  constant: ExactRational
): ExactRational {
  // A recurrence step is one exact bounded linear combination. Individual
  // coefficient×state products may exceed the reduced-state limit and then
  // cancel. With order <= MAX_RECURRENCE_ORDER, these validation/evaluation
  // temporaries are still bounded by the configured coefficient/state sizes.
  let total: WideRecurrenceValue = {
    numerator: constant.numerator,
    denominator: constant.denominator
  };

  coefficients.forEach((coefficient, index) => {
    const previous = sequence[sequence.length - index - 1];
    if (previous === undefined) {
      throw new Error("Recurrence evaluation encountered an impossible missing term");
    }
    total = addWideRecurrenceValues(total, wideRecurrenceProduct(coefficient, previous));
  });

  return rational(
    assertIntermediateIntegerBound(total.numerator),
    assertIntermediateIntegerBound(total.denominator)
  );
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

import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import { MAX_RECURRENCE_ORDER, MAX_RECURRENCE_SEQUENCE_LENGTH } from "./limits.js";
import { IntermediateRationalInputSchema, RationalInputSchema } from "./rational-expression.js";
import {
  addRationals,
  equalRationals,
  multiplyRationals,
  parseIntermediateRationalInput,
  parseRationalInput,
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

function extendSequence(
  initial: readonly ExactRational[],
  coefficients: readonly ExactRational[],
  constant: ExactRational,
  requiredLength: number
): readonly ExactRational[] {
  const sequence = [...initial];
  while (sequence.length < requiredLength) {
    let next = constant;
    for (let offset = 1; offset <= coefficients.length; offset += 1) {
      const coefficient = coefficients[offset - 1];
      const previous = sequence[sequence.length - offset];
      if (coefficient === undefined || previous === undefined) {
        throw new Error("Recurrence evaluation encountered an impossible missing term");
      }
      next = addRationals(next, multiplyRationals(coefficient, previous));
    }
    sequence.push(next);
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

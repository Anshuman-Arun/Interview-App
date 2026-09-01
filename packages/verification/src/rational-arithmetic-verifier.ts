import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import { RationalExpressionSchema, evaluateRationalExpression } from "./rational-expression.js";
import { equalRationals } from "./math-utils.js";
import { booleanClaimResult, mathFailure, prepareStructuredStatement } from "./verifier-common.js";

export const RATIONAL_ARITHMETIC_PROTOCOL = "INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM" as const;
export const RATIONAL_ARITHMETIC_PROTOCOL_VERSION = 1 as const;
export const RATIONAL_ARITHMETIC_VERIFIER_NAME = "deterministic-rational-arithmetic-verifier@1" as const;

export const RationalArithmeticInterpretationSchema = z.object({
  protocol: z.literal(RATIONAL_ARITHMETIC_PROTOCOL),
  protocolVersion: z.literal(RATIONAL_ARITHMETIC_PROTOCOL_VERSION),
  claim: z.object({
    kind: z.literal("EQUALITY"),
    left: RationalExpressionSchema,
    right: RationalExpressionSchema
  }).strict()
}).strict();
export type RationalArithmeticInterpretation = z.infer<typeof RationalArithmeticInterpretationSchema>;

export class RationalArithmeticVerifier implements DeterministicVerifier {
  public async verify(statement: string, interpretationConfidence: number): Promise<VerificationResult> {
    const prepared = prepareStructuredStatement(
      statement,
      interpretationConfidence,
      RATIONAL_ARITHMETIC_VERIFIER_NAME,
      RationalArithmeticInterpretationSchema
    );
    if (!prepared.ok) return prepared.result;

    try {
      const left = evaluateRationalExpression(prepared.data.claim.left);
      const right = evaluateRationalExpression(prepared.data.claim.right);
      return booleanClaimResult(
        equalRationals(left, right),
        prepared.interpretationConfidence,
        RATIONAL_ARITHMETIC_VERIFIER_NAME,
        "Exact normalized rational evaluation proves the supplied equality",
        "Exact normalized rational evaluation disproves the supplied equality"
      );
    } catch (error) {
      return mathFailure(error, prepared.interpretationConfidence, RATIONAL_ARITHMETIC_VERIFIER_NAME);
    }
  }
}

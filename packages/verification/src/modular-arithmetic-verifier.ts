import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import {
  IntegerExpressionSchema,
  IntegerStringSchema,
  PositiveIntegerStringSchema,
  evaluateIntegerExpression
} from "./integer-expression.js";
import { areCongruent, isDivisibleBy, parseBoundedInteger } from "./math-utils.js";
import { booleanClaimResult, mathFailure, prepareStructuredStatement } from "./verifier-common.js";

export const MODULAR_ARITHMETIC_PROTOCOL = "INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM" as const;
export const MODULAR_ARITHMETIC_PROTOCOL_VERSION = 1 as const;
export const MODULAR_ARITHMETIC_VERIFIER_NAME = "deterministic-modular-arithmetic-verifier@1" as const;

export const ModularArithmeticClaimSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("CONGRUENCE"),
    left: IntegerExpressionSchema,
    right: IntegerExpressionSchema,
    modulus: PositiveIntegerStringSchema
  }).strict(),
  z.object({
    kind: z.literal("DIVISIBILITY"),
    divisor: IntegerStringSchema,
    dividend: IntegerExpressionSchema
  }).strict()
]);

export const ModularArithmeticInterpretationSchema = z.object({
  protocol: z.literal(MODULAR_ARITHMETIC_PROTOCOL),
  protocolVersion: z.literal(MODULAR_ARITHMETIC_PROTOCOL_VERSION),
  claim: ModularArithmeticClaimSchema
}).strict();
export type ModularArithmeticInterpretation = z.infer<typeof ModularArithmeticInterpretationSchema>;

export class ModularArithmeticVerifier implements DeterministicVerifier {
  public async verify(statement: string, interpretationConfidence: number): Promise<VerificationResult> {
    const prepared = prepareStructuredStatement(
      statement,
      interpretationConfidence,
      MODULAR_ARITHMETIC_VERIFIER_NAME,
      ModularArithmeticInterpretationSchema
    );
    if (!prepared.ok) return prepared.result;

    try {
      const claim = prepared.data.claim;
      if (claim.kind === "CONGRUENCE") {
        const left = evaluateIntegerExpression(claim.left);
        const right = evaluateIntegerExpression(claim.right);
        const modulus = parseBoundedInteger(claim.modulus);
        return booleanClaimResult(
          areCongruent(left, right, modulus),
          prepared.interpretationConfidence,
          MODULAR_ARITHMETIC_VERIFIER_NAME,
          "Exact integer evaluation satisfies the supplied congruence",
          "Exact integer evaluation does not satisfy the supplied congruence"
        );
      }

      const divisor = parseBoundedInteger(claim.divisor);
      const dividend = evaluateIntegerExpression(claim.dividend);
      return booleanClaimResult(
        isDivisibleBy(dividend, divisor),
        prepared.interpretationConfidence,
        MODULAR_ARITHMETIC_VERIFIER_NAME,
        "Exact integer evaluation satisfies the supplied divisibility claim",
        "Exact integer evaluation does not satisfy the supplied divisibility claim"
      );
    } catch (error) {
      return mathFailure(error, prepared.interpretationConfidence, MODULAR_ARITHMETIC_VERIFIER_NAME);
    }
  }
}

import { z } from "zod";
import type { DeterministicVerifier, VerificationResult } from "../../domain/src/index.js";
import { IntermediateIntegerStringSchema } from "./integer-expression.js";
import { MAX_COMBINATORIAL_N } from "./limits.js";
import {
  binomial,
  combinationsWithRepetition,
  parseBoundedIntermediateInteger,
  permutations
} from "./math-utils.js";
import { booleanClaimResult, mathFailure, prepareStructuredStatement } from "./verifier-common.js";

export const COMBINATORIAL_COUNTING_PROTOCOL = "INTERVIEW_APP_COMBINATORIAL_COUNTING_CLAIM" as const;
export const COMBINATORIAL_COUNTING_PROTOCOL_VERSION = 1 as const;
export const COMBINATORIAL_COUNTING_VERIFIER_NAME = "deterministic-combinatorial-counting-verifier@1" as const;

const BoundedCountSchema = z.number().int().min(0).max(MAX_COMBINATORIAL_N);

export const CombinatorialCountingClaimSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("BINOMIAL"), n: BoundedCountSchema, k: BoundedCountSchema, claimed: IntermediateIntegerStringSchema }).strict(),
  z.object({ kind: z.literal("PERMUTATION"), n: BoundedCountSchema, k: BoundedCountSchema, claimed: IntermediateIntegerStringSchema }).strict(),
  z.object({
    kind: z.literal("COMBINATIONS_WITH_REPETITION"),
    types: BoundedCountSchema,
    selections: BoundedCountSchema,
    claimed: IntermediateIntegerStringSchema
  }).strict(),
  z.object({
    kind: z.literal("INCLUSION_EXCLUSION_TWO"),
    leftCount: BoundedCountSchema,
    rightCount: BoundedCountSchema,
    intersectionCount: BoundedCountSchema,
    claimedUnionCount: IntermediateIntegerStringSchema
  }).strict().superRefine((value, context) => {
    if (value.intersectionCount > value.leftCount || value.intersectionCount > value.rightCount) {
      context.addIssue({ code: "custom", path: ["intersectionCount"], message: "Intersection count cannot exceed either set count" });
    }
  })
]);

export const CombinatorialCountingInterpretationSchema = z.object({
  protocol: z.literal(COMBINATORIAL_COUNTING_PROTOCOL),
  protocolVersion: z.literal(COMBINATORIAL_COUNTING_PROTOCOL_VERSION),
  claim: CombinatorialCountingClaimSchema
}).strict();
export type CombinatorialCountingInterpretation = z.infer<typeof CombinatorialCountingInterpretationSchema>;

function expectedCount(claim: z.infer<typeof CombinatorialCountingClaimSchema>): bigint {
  switch (claim.kind) {
    case "BINOMIAL": return binomial(claim.n, claim.k);
    case "PERMUTATION": return permutations(claim.n, claim.k);
    case "COMBINATIONS_WITH_REPETITION": return combinationsWithRepetition(claim.types, claim.selections);
    case "INCLUSION_EXCLUSION_TWO": return BigInt(claim.leftCount + claim.rightCount - claim.intersectionCount);
  }
}

function claimedCount(claim: z.infer<typeof CombinatorialCountingClaimSchema>): bigint {
  return parseBoundedIntermediateInteger(claim.kind === "INCLUSION_EXCLUSION_TWO" ? claim.claimedUnionCount : claim.claimed);
}

export class CombinatorialCountingVerifier implements DeterministicVerifier {
  public async verify(statement: string, interpretationConfidence: number): Promise<VerificationResult> {
    const prepared = prepareStructuredStatement(
      statement,
      interpretationConfidence,
      COMBINATORIAL_COUNTING_VERIFIER_NAME,
      CombinatorialCountingInterpretationSchema
    );
    if (!prepared.ok) return prepared.result;

    try {
      return booleanClaimResult(
        expectedCount(prepared.data.claim) === claimedCount(prepared.data.claim),
        prepared.interpretationConfidence,
        COMBINATORIAL_COUNTING_VERIFIER_NAME,
        "Exact finite counting formula matches the supplied claim",
        "Exact finite counting formula does not match the supplied claim"
      );
    } catch (error) {
      return mathFailure(error, prepared.interpretationConfidence, COMBINATORIAL_COUNTING_VERIFIER_NAME);
    }
  }
}

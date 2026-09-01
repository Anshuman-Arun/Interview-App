import { z } from "zod";
import {
  EvaluationEvidenceRefSchema,
  type EvaluationEvidenceRef
} from "../../domain/src/index.js";

export const FallibleQualitativeEvaluationProposalSchema = z.object({
  dimension: z.literal("communication"),
  score: z.number().min(0).max(100),
  evidenceRefs: z.array(EvaluationEvidenceRefSchema).min(1),
  rationale: z.string().min(1).max(500)
}).strict().superRefine((proposal, ctx) => {
  const unique = new Set(
    proposal.evidenceRefs.map((ref) => ref.kind + "\u0000" + ref.id)
  );
  if (unique.size !== proposal.evidenceRefs.length) {
    ctx.addIssue({
      code: "custom",
      message: "Qualitative proposal evidence references must be unique"
    });
  }
});

export type FallibleQualitativeEvaluationProposal = z.infer<
  typeof FallibleQualitativeEvaluationProposalSchema
>;

export interface GroundedQualitativeEvaluationFacts {
  readonly allowedEvidenceRefs: readonly EvaluationEvidenceRef[];
}

export type QualitativeProposalValidation =
  | {
      readonly accepted: true;
      readonly proposal: FallibleQualitativeEvaluationProposal;
    }
  | {
      readonly accepted: false;
      readonly reason:
        | "INVALID_PROPOSAL"
        | "NO_GROUNDED_EVIDENCE"
        | "UNSUPPORTED_EVIDENCE_REFERENCE";
    };

/**
 * Validates provenance only. A successful result does not make a model-proposed
 * qualitative score authoritative and is intentionally not consumed by the
 * deterministic SessionEvaluation scorer.
 */
export function validateFallibleQualitativeEvaluationProposal(
  facts: GroundedQualitativeEvaluationFacts,
  rawProposal: unknown
): QualitativeProposalValidation {
  const parsed = FallibleQualitativeEvaluationProposalSchema.safeParse(rawProposal);
  if (!parsed.success) {
    return { accepted: false, reason: "INVALID_PROPOSAL" };
  }
  const proposal = parsed.data;
  if (facts.allowedEvidenceRefs.length === 0) {
    return { accepted: false, reason: "NO_GROUNDED_EVIDENCE" };
  }

  const allowed = new Set(
    facts.allowedEvidenceRefs.map((ref) => ref.kind + ":" + ref.id)
  );
  const supported = proposal.evidenceRefs.every((ref) =>
    allowed.has(ref.kind + ":" + ref.id)
  );
  if (!supported) {
    return { accepted: false, reason: "UNSUPPORTED_EVIDENCE_REFERENCE" };
  }

  return { accepted: true, proposal };
}

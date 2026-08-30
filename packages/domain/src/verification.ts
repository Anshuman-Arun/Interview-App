import { z } from "zod";

export const FormalInterpretationProposalSchema = z.object({
  candidateFormalInterpretation: z.string().min(1).max(100_000),
  interpretationConfidence: z.number().min(0).max(1)
}).strict();
export type FormalInterpretationProposal = z.infer<typeof FormalInterpretationProposalSchema>;

export const VerificationStatusSchema = z.enum(["VERIFIED", "CONTRADICTED", "UNRESOLVED"]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VerificationResultSchema = z.object({
  status: VerificationStatusSchema,
  interpretationConfidence: z.number().min(0).max(1),
  verifier: z.string().min(1),
  reason: z.string().min(1).max(500)
}).strict();
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export interface DeterministicVerifier {
  readonly verify: (statement: string, interpretationConfidence: number) => Promise<VerificationResult>;
}

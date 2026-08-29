import { z } from "zod";
import { EventIdSchema } from "./ids.js";

export const EvidenceDimensionSchema = z.enum([
  "PROGRESS", "CORRECTNESS", "UNDERSTANDING", "JUSTIFICATION", "STUDENT_CONFIDENCE"
]);
export const EvidenceSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CLAIM"), claimId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("MILESTONE"), milestoneId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("SKILL"), skillId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("APPROACH"), approachId: z.string().min(1) }).strict()
]);
export const EvidenceKeySchema = z.object({
  problemId: z.string().min(1),
  subject: EvidenceSubjectSchema,
  dimension: EvidenceDimensionSchema
}).strict();
export const EvidenceValueSchema = z.object({
  value: z.string().min(1),
  inferenceConfidence: z.number().min(0).max(1),
  evidenceEventIds: z.array(EventIdSchema).min(1),
  lastUpdatedSequence: z.number().int().positive()
}).strict();
export const EvidenceProposalSchema = z.object({
  key: EvidenceKeySchema,
  proposedValue: z.string().min(1),
  inferenceConfidence: z.number().min(0).max(1),
  evidenceEventIds: z.array(EventIdSchema).min(1)
}).strict();

export type EvidenceKey = z.infer<typeof EvidenceKeySchema>;
export type EvidenceValue = z.infer<typeof EvidenceValueSchema>;
export type EvidenceProposal = z.infer<typeof EvidenceProposalSchema>;


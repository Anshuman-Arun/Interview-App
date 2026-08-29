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
export const EvidenceRatingSchema = z.enum([
  "PROGRESSING", "STALLED", "REGRESSING", "COMPLETE", "UNKNOWN",
  "CORRECT", "LOCAL_ERROR", "STRUCTURAL_ERROR",
  "UNDERSTANDS", "PARTIAL", "MISUNDERSTOOD_PROBLEM",
  "JUSTIFIED", "INCOMPLETE", "UNJUSTIFIED", "NOT_APPLICABLE",
  "CONFIDENT", "UNCERTAIN"
]);
export const EvidenceValueSchema = z.object({
  value: EvidenceRatingSchema,
  inferenceConfidence: z.number().min(0).max(1),
  evidenceEventIds: z.array(EventIdSchema).min(1),
  lastUpdatedSequence: z.number().int().positive()
}).strict();
export const EvidenceProposalSchema = z.object({
  key: EvidenceKeySchema,
  proposedValue: EvidenceRatingSchema,
  inferenceConfidence: z.number().min(0).max(1),
  evidenceEventIds: z.array(EventIdSchema).min(1)
}).strict();

export type EvidenceKey = z.infer<typeof EvidenceKeySchema>;
export type EvidenceValue = z.infer<typeof EvidenceValueSchema>;
export type EvidenceProposal = z.infer<typeof EvidenceProposalSchema>;

const valuesByDimension: Readonly<Record<EvidenceKey["dimension"], ReadonlySet<z.infer<typeof EvidenceRatingSchema>>>> = {
  PROGRESS: new Set(["PROGRESSING", "STALLED", "REGRESSING", "COMPLETE", "UNKNOWN"]),
  CORRECTNESS: new Set(["CORRECT", "LOCAL_ERROR", "STRUCTURAL_ERROR", "UNKNOWN"]),
  UNDERSTANDING: new Set(["UNDERSTANDS", "PARTIAL", "MISUNDERSTOOD_PROBLEM", "UNKNOWN"]),
  JUSTIFICATION: new Set(["JUSTIFIED", "INCOMPLETE", "UNJUSTIFIED", "NOT_APPLICABLE"]),
  STUDENT_CONFIDENCE: new Set(["CONFIDENT", "UNCERTAIN", "UNKNOWN"])
};

export const isEvidenceValueAllowed = (key: EvidenceKey, value: z.infer<typeof EvidenceRatingSchema>): boolean =>
  valuesByDimension[key.dimension].has(value);

export function evidenceKeyToString(key: EvidenceKey): string {
  const subjectId = key.subject.kind === "CLAIM"
    ? key.subject.claimId
    : key.subject.kind === "MILESTONE"
      ? key.subject.milestoneId
      : key.subject.kind === "SKILL"
        ? key.subject.skillId
        : key.subject.approachId;
  return `${key.problemId}|${key.subject.kind}|${subjectId}|${key.dimension}`;
}

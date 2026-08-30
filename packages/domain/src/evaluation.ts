import { z } from "zod";
import { DisclosureLevelSchema } from "./pedagogy.js";
import { SessionIdSchema, TurnIdSchema } from "./ids.js";

export const EvaluationRubricSchema = z.object({
  correctnessWeight: z.number().min(0).max(1).default(0.35),
  rigorWeight: z.number().min(0).max(1).default(0.20),
  independenceWeight: z.number().min(0).max(1).default(0.20),
  communicationWeight: z.number().min(0).max(1).default(0.15),
  errorRecoveryWeight: z.number().min(0).max(1).default(0.10)
});
export type EvaluationRubric = z.infer<typeof EvaluationRubricSchema>;

export const EvaluationScoreBreakdownSchema = z.object({
  technicalCorrectness: z.number().min(0).max(100),
  rigor: z.number().min(0).max(100),
  independence: z.number().min(0).max(100),
  communication: z.number().min(0).max(100),
  hintResponsiveness: z.number().min(0).max(100),
  errorRecovery: z.number().min(0).max(100),
  compositeScore: z.number().min(0).max(100)
});
export type EvaluationScoreBreakdown = z.infer<typeof EvaluationScoreBreakdownSchema>;

export const MilestoneEvaluationSchema = z.object({
  milestoneId: z.string().min(1),
  description: z.string().min(1),
  achieved: z.boolean(),
  achievedAtTurnId: TurnIdSchema.optional(),
  assistanceLevel: DisclosureLevelSchema
});
export type MilestoneEvaluation = z.infer<typeof MilestoneEvaluationSchema>;

export const DisclosedInterventionRecordSchema = z.object({
  turnId: TurnIdSchema,
  disclosureLevel: DisclosureLevelSchema,
  disclosureIds: z.array(z.string()),
  deliveryStatus: z.enum(["EXPOSED", "POSSIBLY_EXPOSED"]),
  summary: z.string().min(1)
});
export type DisclosedInterventionRecord = z.infer<typeof DisclosedInterventionRecordSchema>;

export const SessionEvaluationSchema = z.object({
  sessionId: SessionIdSchema,
  problemId: z.string().min(1),
  problemVersion: z.string().min(1),
  evaluatedAt: z.string().min(1),
  scores: EvaluationScoreBreakdownSchema,
  milestones: z.array(MilestoneEvaluationSchema),
  disclosedInterventions: z.array(DisclosedInterventionRecordSchema),
  unassistedMilestoneCount: z.number().int().nonnegative(),
  assistedMilestoneCount: z.number().int().nonnegative(),
  totalTurns: z.number().int().nonnegative(),
  keyStrengths: z.array(z.string()),
  areasForImprovement: z.array(z.string()),
  summaryAssessment: z.string().min(1)
});
export type SessionEvaluation = z.infer<typeof SessionEvaluationSchema>;

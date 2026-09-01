import { z } from "zod";
import { DisclosureLevelSchema } from "./pedagogy.js";
import {
  DeliveryIdSchema,
  GenerationIdSchema,
  SessionIdSchema,
  TurnIdSchema
} from "./ids.js";

const ScoreSchema = z.number().min(0).max(100);
const NullableScoreSchema = ScoreSchema.nullable();

export const EvaluationRubricSchema = z.object({
  correctnessWeight: z.number().min(0).max(1).default(0.35),
  rigorWeight: z.number().min(0).max(1).default(0.20),
  independenceWeight: z.number().min(0).max(1).default(0.20),
  communicationWeight: z.number().min(0).max(1).default(0.15),
  errorRecoveryWeight: z.number().min(0).max(1).default(0.10)
}).strict().refine((rubric) => {
  const total =
    rubric.correctnessWeight +
    rubric.rigorWeight +
    rubric.independenceWeight +
    rubric.communicationWeight +
    rubric.errorRecoveryWeight;
  return Number.isFinite(total) && Math.abs(total - 1) <= 1e-9;
}, {
  message: "Evaluation rubric weights must sum to 1"
});
export type EvaluationRubric = z.infer<typeof EvaluationRubricSchema>;

export const EvaluationSupportLevelSchema = z.enum([
  "STRONG",
  "MODERATE",
  "WEAK",
  "INSUFFICIENT"
]);
export type EvaluationSupportLevel = z.infer<typeof EvaluationSupportLevelSchema>;

export const EvaluationDimensionNameSchema = z.enum([
  "technicalCorrectness",
  "rigor",
  "independence",
  "communication",
  "hintResponsiveness",
  "errorRecovery"
]);
export type EvaluationDimensionName = z.infer<typeof EvaluationDimensionNameSchema>;

export const CompositeDimensionNameSchema = z.enum([
  "technicalCorrectness",
  "rigor",
  "independence",
  "communication",
  "errorRecovery"
]);
export type CompositeDimensionName = z.infer<typeof CompositeDimensionNameSchema>;

export const EvaluationEvidenceRefSchema = z.object({
  kind: z.enum([
    "EVIDENCE_EVENT",
    "VERIFICATION_REQUEST",
    "DELIVERY",
    "TURN",
    "MILESTONE"
  ]),
  id: z.string().min(1)
}).strict();
export type EvaluationEvidenceRef = z.infer<typeof EvaluationEvidenceRefSchema>;

export const EvaluationDimensionResultSchema = z.object({
  score: NullableScoreSchema,
  supportLevel: EvaluationSupportLevelSchema,
  evidenceRefs: z.array(EvaluationEvidenceRefSchema),
  notScoredReason: z.string().min(1).optional()
}).strict().superRefine((result, ctx) => {
  if (result.score === null && result.notScoredReason === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Unscored evaluation dimensions require a notScoredReason"
    });
  }
  if (result.score !== null && result.notScoredReason !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Scored evaluation dimensions cannot include notScoredReason"
    });
  }
  if (result.supportLevel === "INSUFFICIENT" && result.score !== null) {
    ctx.addIssue({
      code: "custom",
      message: "Insufficiently supported evaluation dimensions cannot have a score"
    });
  }
});
export type EvaluationDimensionResult = z.infer<typeof EvaluationDimensionResultSchema>;

export const EvaluationDimensionResultsSchema = z.object({
  technicalCorrectness: EvaluationDimensionResultSchema,
  rigor: EvaluationDimensionResultSchema,
  independence: EvaluationDimensionResultSchema,
  communication: EvaluationDimensionResultSchema,
  hintResponsiveness: EvaluationDimensionResultSchema,
  errorRecovery: EvaluationDimensionResultSchema
}).strict();
export type EvaluationDimensionResults = z.infer<typeof EvaluationDimensionResultsSchema>;

export const EvaluationScoreBreakdownSchema = z.object({
  technicalCorrectness: NullableScoreSchema,
  rigor: NullableScoreSchema,
  independence: NullableScoreSchema,
  communication: NullableScoreSchema,
  hintResponsiveness: NullableScoreSchema,
  errorRecovery: NullableScoreSchema,
  compositeScore: NullableScoreSchema
}).strict();
export type EvaluationScoreBreakdown = z.infer<typeof EvaluationScoreBreakdownSchema>;

export const EvaluationCompositeMetadataSchema = z.object({
  status: z.enum(["FULL", "PARTIAL", "NOT_SCORED"]),
  supportLevel: EvaluationSupportLevelSchema,
  includedDimensions: z.array(CompositeDimensionNameSchema),
  omittedDimensions: z.array(CompositeDimensionNameSchema)
}).strict();
export type EvaluationCompositeMetadata = z.infer<typeof EvaluationCompositeMetadataSchema>;

export const EvaluationLifecycleSchema = z.object({
  sessionStatus: z.enum(["CREATED", "ACTIVE", "COMPLETED", "ARCHIVED"]),
  completionState: z.enum([
    "NOT_STARTED",
    "IN_PROGRESS",
    "COMPLETED",
    "ARCHIVED_INCOMPLETE",
    "ARCHIVED_COMPLETED"
  ]),
  totalTurns: z.number().int().nonnegative()
}).strict();
export type EvaluationLifecycle = z.infer<typeof EvaluationLifecycleSchema>;

export const MilestoneEvaluationSchema = z.object({
  milestoneId: z.string().min(1),
  description: z.string().min(1),
  achieved: z.boolean(),
  achievedAtTurnId: TurnIdSchema.optional(),
  assistanceLevel: DisclosureLevelSchema,
  supportLevel: EvaluationSupportLevelSchema,
  evidenceRefs: z.array(EvaluationEvidenceRefSchema),
  assistanceDisclosureIds: z.array(z.string().min(1)),
  approachIds: z.array(z.string().min(1)),
  notAchievedReason: z.string().min(1).optional()
}).strict();
export type MilestoneEvaluation = z.infer<typeof MilestoneEvaluationSchema>;

export const DisclosedInterventionRecordSchema = z.object({
  deliveryId: DeliveryIdSchema,
  generationId: GenerationIdSchema,
  turnId: TurnIdSchema.optional(),
  disclosureLevel: DisclosureLevelSchema,
  disclosureIds: z.array(z.string().min(1)),
  relatedMilestoneIds: z.array(z.string().min(1)),
  deliveryStatus: z.enum(["EXPOSED", "POSSIBLY_EXPOSED"]),
  summary: z.string().min(1)
}).strict();
export type DisclosedInterventionRecord = z.infer<typeof DisclosedInterventionRecordSchema>;

export const SessionEvaluationSchema = z.object({
  sessionId: SessionIdSchema,
  problemId: z.string().min(1),
  problemVersion: z.string().min(1),
  evaluatedAt: z.iso.datetime(),
  rubric: EvaluationRubricSchema,
  lifecycle: EvaluationLifecycleSchema,
  scores: EvaluationScoreBreakdownSchema,
  dimensionResults: EvaluationDimensionResultsSchema,
  composite: EvaluationCompositeMetadataSchema,
  milestones: z.array(MilestoneEvaluationSchema),
  disclosedInterventions: z.array(DisclosedInterventionRecordSchema),
  unassistedMilestoneCount: z.number().int().nonnegative(),
  assistedMilestoneCount: z.number().int().nonnegative(),
  totalTurns: z.number().int().nonnegative(),
  keyStrengths: z.array(z.string()),
  areasForImprovement: z.array(z.string()),
  summaryAssessment: z.string().min(1)
}).strict();
export type SessionEvaluation = z.infer<typeof SessionEvaluationSchema>;

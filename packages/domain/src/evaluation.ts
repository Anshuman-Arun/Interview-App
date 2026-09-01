import { z } from "zod";
import { DisclosureLevelSchema } from "./pedagogy.js";
import {
  DeliveryIdSchema,
  DisclosureIdSchema,
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
  if (result.score === null && result.supportLevel !== "INSUFFICIENT") {
    ctx.addIssue({
      code: "custom",
      message: "Unscored evaluation dimensions must have insufficient support"
    });
  }
  if (result.score !== null && result.evidenceRefs.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Scored evaluation dimensions require grounded evidence references"
    });
  }
  if (!hasUniqueEvaluationRefs(result.evidenceRefs)) {
    ctx.addIssue({
      code: "custom",
      message: "Evaluation dimension evidence references must be unique"
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
}).strict().superRefine((metadata, ctx) => {
  if (new Set(metadata.includedDimensions).size !== metadata.includedDimensions.length) {
    ctx.addIssue({
      code: "custom",
      message: "Composite included dimensions must be unique"
    });
  }
  if (new Set(metadata.omittedDimensions).size !== metadata.omittedDimensions.length) {
    ctx.addIssue({
      code: "custom",
      message: "Composite omitted dimensions must be unique"
    });
  }
  const included = new Set(metadata.includedDimensions);
  if (metadata.omittedDimensions.some((dimension) => included.has(dimension))) {
    ctx.addIssue({
      code: "custom",
      message: "Composite included and omitted dimensions must be disjoint"
    });
  }
});
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
  assistanceDisclosureIds: z.array(DisclosureIdSchema),
  approachIds: z.array(z.string().min(1)),
  notAchievedReason: z.string().min(1).optional()
}).strict().superRefine((milestone, ctx) => {
  if (milestone.achieved && milestone.notAchievedReason !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Achieved milestone evaluations cannot contain a notAchievedReason"
    });
  }
  if (!milestone.achieved && milestone.notAchievedReason === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Incomplete milestone evaluations require a notAchievedReason"
    });
  }
  if (!milestone.achieved && milestone.achievedAtTurnId !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Incomplete milestone evaluations cannot contain achievedAtTurnId"
    });
  }
  if (milestone.achieved && milestone.supportLevel === "INSUFFICIENT") {
    ctx.addIssue({
      code: "custom",
      message: "Achieved milestone evaluations require supported evidence"
    });
  }
  if (milestone.achieved && milestone.evidenceRefs.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Achieved milestone evaluations require evidence references"
    });
  }
  if (!hasUniqueEvaluationRefs(milestone.evidenceRefs)) {
    ctx.addIssue({
      code: "custom",
      message: "Milestone evidence references must be unique"
    });
  }
  if (new Set(milestone.assistanceDisclosureIds).size !== milestone.assistanceDisclosureIds.length) {
    ctx.addIssue({
      code: "custom",
      message: "Milestone assistance disclosure IDs must be unique"
    });
  }
  if (new Set(milestone.approachIds).size !== milestone.approachIds.length) {
    ctx.addIssue({
      code: "custom",
      message: "Milestone approach IDs must be unique"
    });
  }
});
export type MilestoneEvaluation = z.infer<typeof MilestoneEvaluationSchema>;

export const DisclosedInterventionRecordSchema = z.object({
  deliveryId: DeliveryIdSchema,
  generationId: GenerationIdSchema,
  turnId: TurnIdSchema.optional(),
  disclosureLevel: DisclosureLevelSchema,
  disclosureIds: z.array(DisclosureIdSchema),
  relatedMilestoneIds: z.array(z.string().min(1)),
  deliveryStatus: z.enum(["EXPOSED", "COMPLETED", "POSSIBLY_EXPOSED"]),
  summary: z.string().min(1)
}).strict().superRefine((intervention, ctx) => {
  if (new Set(intervention.disclosureIds).size !== intervention.disclosureIds.length) {
    ctx.addIssue({
      code: "custom",
      message: "Intervention disclosure IDs must be unique"
    });
  }
  if (new Set(intervention.relatedMilestoneIds).size !== intervention.relatedMilestoneIds.length) {
    ctx.addIssue({
      code: "custom",
      message: "Intervention related milestone IDs must be unique"
    });
  }
});
export type DisclosedInterventionRecord = z.infer<typeof DisclosedInterventionRecordSchema>;

function hasUniqueEvaluationRefs(
  refs: readonly EvaluationEvidenceRef[]
): boolean {
  return new Set(refs.map((ref) => ref.kind + "\u0000" + ref.id)).size === refs.length;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((value) => values.has(value));
}

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
  keyStrengths: z.array(z.string().min(1)),
  areasForImprovement: z.array(z.string().min(1)),
  summaryAssessment: z.string().min(1)
}).strict().superRefine((evaluation, ctx) => {
  const dimensionNames = [
    "technicalCorrectness",
    "rigor",
    "independence",
    "communication",
    "hintResponsiveness",
    "errorRecovery"
  ] as const;
  if (dimensionNames.some(
    (name) => evaluation.scores[name] !== evaluation.dimensionResults[name].score
  )) {
    ctx.addIssue({
      code: "custom",
      message: "Evaluation score breakdown must match dimensionResults"
    });
  }

  if (evaluation.totalTurns !== evaluation.lifecycle.totalTurns) {
    ctx.addIssue({
      code: "custom",
      message: "Evaluation totalTurns must match lifecycle totalTurns"
    });
  }

  const expectedUnassisted = evaluation.milestones.filter(
    (milestone) => milestone.achieved && milestone.assistanceLevel === 0
  ).length;
  const expectedAssisted = evaluation.milestones.filter(
    (milestone) => milestone.achieved && milestone.assistanceLevel > 0
  ).length;
  if (
    evaluation.unassistedMilestoneCount !== expectedUnassisted ||
    evaluation.assistedMilestoneCount !== expectedAssisted
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Evaluation milestone counts must match milestone results"
    });
  }

  if (
    new Set(evaluation.milestones.map((milestone) => milestone.milestoneId)).size !==
    evaluation.milestones.length
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Session evaluation milestone IDs must be unique"
    });
  }
  if (
    new Set(evaluation.disclosedInterventions.map((item) => item.deliveryId)).size !==
    evaluation.disclosedInterventions.length
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Session evaluation intervention delivery IDs must be unique"
    });
  }

  const weighted = [
    ["technicalCorrectness", evaluation.rubric.correctnessWeight],
    ["rigor", evaluation.rubric.rigorWeight],
    ["independence", evaluation.rubric.independenceWeight],
    ["communication", evaluation.rubric.communicationWeight],
    ["errorRecovery", evaluation.rubric.errorRecoveryWeight]
  ] as const;
  const positiveWeight = weighted.filter(([, weight]) => weight > 0);
  const expectedIncluded = positiveWeight
    .filter(([name]) => evaluation.dimensionResults[name].score !== null)
    .map(([name]) => name);
  const expectedOmitted = positiveWeight
    .filter(([name]) => evaluation.dimensionResults[name].score === null)
    .map(([name]) => name);

  if (!sameStringSet(evaluation.composite.includedDimensions, expectedIncluded)) {
    ctx.addIssue({
      code: "custom",
      message: "Composite included dimensions do not match supported weighted dimensions"
    });
  }
  if (!sameStringSet(evaluation.composite.omittedDimensions, expectedOmitted)) {
    ctx.addIssue({
      code: "custom",
      message: "Composite omitted dimensions do not match unsupported weighted dimensions"
    });
  }

  const expectedStatus =
    expectedIncluded.length === 0
      ? "NOT_SCORED"
      : expectedOmitted.length === 0
        ? "FULL"
        : "PARTIAL";
  if (evaluation.composite.status !== expectedStatus) {
    ctx.addIssue({
      code: "custom",
      message: "Composite status does not match weighted dimension coverage"
    });
  }

  if (expectedIncluded.length === 0) {
    if (
      evaluation.scores.compositeScore !== null ||
      evaluation.composite.supportLevel !== "INSUFFICIENT"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Unscored composite metadata is internally inconsistent"
      });
    }
  } else {
    const includedWeights = weighted.filter(
      ([name, weight]) =>
        weight > 0 && evaluation.dimensionResults[name].score !== null
    );
    const totalWeight = includedWeights.reduce((sum, [, weight]) => sum + weight, 0);
    const weightedTotal = includedWeights.reduce((sum, [name, weight]) => {
      const score = evaluation.dimensionResults[name].score;
      return sum + (score === null ? 0 : score * weight);
    }, 0);
    const expectedCompositeScore = Math.max(
      0,
      Math.min(100, Math.round(weightedTotal / totalWeight))
    );
    if (evaluation.scores.compositeScore !== expectedCompositeScore) {
      ctx.addIssue({
        code: "custom",
        message: "Composite score does not match the supported weighted dimensions"
      });
    }

    const supportRank = {
      INSUFFICIENT: 0,
      WEAK: 1,
      MODERATE: 2,
      STRONG: 3
    } as const;
    const supportByRank = [
      "INSUFFICIENT",
      "WEAK",
      "MODERATE",
      "STRONG"
    ] as const;
    const weakestRank = Math.min(
      ...expectedIncluded.map(
        (name) => supportRank[evaluation.dimensionResults[name].supportLevel]
      )
    );
    const expectedSupportRank =
      expectedStatus === "PARTIAL"
        ? Math.min(weakestRank, supportRank.MODERATE)
        : weakestRank;
    if (
      evaluation.composite.supportLevel !== supportByRank[expectedSupportRank]
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Composite support does not match included dimension support"
      });
    }
  }
});
export type SessionEvaluation = z.infer<typeof SessionEvaluationSchema>;

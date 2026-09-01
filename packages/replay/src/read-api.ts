import { z } from "zod";
import {
  DisclosureLevelSchema,
  EvaluationDimensionNameSchema,
  EvaluationEvidenceRefSchema,
  EvaluationSupportLevelSchema,
  EvidenceKeySchema,
  SessionIdSchema,
  type EvaluationDimensionName,
  type SessionEvaluation
} from "../../domain/src/index.js";
import {
  MAX_REPLAY_IDENTIFIER_CHARS,
  previewText,
  takeBounded,
  type TruncationInfo
} from "./bounds.js";
import type {
  LongitudinalHistoryProjection,
  ReplayTimelineEntry,
  SessionHistoryProjection
} from "./types.js";

export const MAX_EVALUATION_READ_MILESTONES = 500;
export const MAX_EVALUATION_READ_INTERVENTIONS = 500;
export const MAX_EVALUATION_READ_EVIDENCE_REFS = 128;
export const MAX_HISTORY_READ_SESSIONS = 100;
export const MAX_HISTORY_READ_STATISTICS = 100;
export const MAX_HISTORY_READ_IMPROVEMENTS = 100;
export const MAX_REPLAY_READ_ENTRIES = 1_000;
export const MAX_READ_TEXT_CHARS = 1_000;

const NonnegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);
const PositiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "Expected a positive safe integer" }
);
const BoundedSessionIdSchema = SessionIdSchema.refine(
  (value) => value.length <= MAX_REPLAY_IDENTIFIER_CHARS,
  { message: "Session identifier exceeds the read-model limit" }
);
const BoundedIdentifierSchema = z.string().min(1).max(MAX_REPLAY_IDENTIFIER_CHARS);
const BoundedTextSchema = z.string().max(MAX_READ_TEXT_CHARS);
const NullableScoreSchema = z.number().min(0).max(100).nullable();

export const ReadTruncationSchema = z.object({
  truncated: z.boolean(),
  limit: PositiveSafeIntegerSchema,
  remainingCount: NonnegativeSafeIntegerSchema
}).strict().superRefine((value, context) => {
  if (
    (value.truncated && value.remainingCount === 0)
    || (!value.truncated && value.remainingCount !== 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Read truncation metadata is internally inconsistent"
    });
  }
});

const ReadEvidenceRefSchema = EvaluationEvidenceRefSchema.extend({
  id: BoundedIdentifierSchema
}).strict();

export const GroundedReadFailureReasonSchema = z.enum([
  "SESSION_NOT_TERMINAL",
  "EXACT_PROBLEM_UNAVAILABLE",
  "AUTHORITATIVE_HISTORY_UNAVAILABLE",
  "READ_LIMIT_EXCEEDED",
  "EVALUATION_UNAVAILABLE",
  "REPLAY_UNAVAILABLE"
]);
export type GroundedReadFailureReason = z.infer<typeof GroundedReadFailureReasonSchema>;

export const GroundedEvaluationDimensionSchema = z.object({
  name: EvaluationDimensionNameSchema,
  score: NullableScoreSchema,
  supportLevel: EvaluationSupportLevelSchema,
  evidenceRefs: z.array(ReadEvidenceRefSchema).max(MAX_EVALUATION_READ_EVIDENCE_REFS),
  evidenceRefTruncation: ReadTruncationSchema,
  notScoredReason: BoundedTextSchema.optional()
}).strict().superRefine((result, context) => {
  if (result.score === null && result.notScoredReason === undefined) {
    context.addIssue({
      code: "custom",
      message: "Unscored read dimensions require a reason"
    });
  }
  if (result.score !== null && result.notScoredReason !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Scored read dimensions cannot carry a not-scored reason"
    });
  }
  if ((result.score === null) !== (result.supportLevel === "INSUFFICIENT")) {
    context.addIssue({
      code: "custom",
      message: "Read dimension score and support are inconsistent"
    });
  }
});

export type GroundedEvaluationDimension = z.infer<
  typeof GroundedEvaluationDimensionSchema
>;

export const GroundedEvaluationMilestoneSchema = z.object({
  milestoneId: BoundedIdentifierSchema,
  achieved: z.boolean(),
  achievedAtTurnId: BoundedIdentifierSchema.optional(),
  assistanceLevel: DisclosureLevelSchema,
  supportLevel: EvaluationSupportLevelSchema,
  evidenceRefs: z.array(ReadEvidenceRefSchema).max(MAX_EVALUATION_READ_EVIDENCE_REFS),
  evidenceRefTruncation: ReadTruncationSchema,
  assistanceDisclosureCount: NonnegativeSafeIntegerSchema
}).strict();

export const GroundedEvaluationInterventionSchema = z.object({
  deliveryId: BoundedIdentifierSchema,
  turnId: BoundedIdentifierSchema.optional(),
  disclosureLevel: DisclosureLevelSchema,
  deliveryStatus: z.enum(["EXPOSED", "COMPLETED", "POSSIBLY_EXPOSED"]),
  disclosureAssociationCount: NonnegativeSafeIntegerSchema,
  relatedMilestoneIds: z.array(BoundedIdentifierSchema).max(64),
  relatedMilestoneTruncation: ReadTruncationSchema
}).strict();

export const GroundedEvaluationReadModelSchema = z.object({
  sessionId: BoundedSessionIdSchema,
  problemId: BoundedIdentifierSchema,
  problemVersion: BoundedIdentifierSchema,
  evaluatedAt: z.iso.datetime(),
  lifecycle: z.object({
    sessionStatus: z.enum(["COMPLETED", "ARCHIVED"]),
    completionState: z.enum(["COMPLETED", "ARCHIVED_INCOMPLETE", "ARCHIVED_COMPLETED"])
  }).strict(),
  composite: z.object({
    score: NullableScoreSchema,
    status: z.enum(["FULL", "PARTIAL", "NOT_SCORED"]),
    supportLevel: EvaluationSupportLevelSchema,
    includedDimensions: z.array(EvaluationDimensionNameSchema).max(5),
    omittedDimensions: z.array(EvaluationDimensionNameSchema).max(5)
  }).strict(),
  dimensions: z.array(GroundedEvaluationDimensionSchema).length(6),
  milestoneSummary: z.object({
    achieved: NonnegativeSafeIntegerSchema,
    total: NonnegativeSafeIntegerSchema,
    unassisted: NonnegativeSafeIntegerSchema,
    assisted: NonnegativeSafeIntegerSchema
  }).strict(),
  milestones: z.array(GroundedEvaluationMilestoneSchema)
    .max(MAX_EVALUATION_READ_MILESTONES),
  milestoneTruncation: ReadTruncationSchema,
  disclosedInterventions: z.array(GroundedEvaluationInterventionSchema)
    .max(MAX_EVALUATION_READ_INTERVENTIONS),
  interventionTruncation: ReadTruncationSchema,
  summaryAssessment: BoundedTextSchema,
  keyStrengths: z.array(BoundedTextSchema).max(20),
  strengthsTruncation: ReadTruncationSchema,
  areasForImprovement: z.array(BoundedTextSchema).max(20),
  improvementTruncation: ReadTruncationSchema
}).strict();
export type GroundedEvaluationReadModel = z.infer<typeof GroundedEvaluationReadModelSchema>;

export const SessionEvaluationReadResponseSchema = z.discriminatedUnion("available", [
  z.object({
    protocolVersion: z.literal(1),
    type: z.literal("SESSION_EVALUATION_READ"),
    sessionId: BoundedSessionIdSchema,
    available: z.literal(true),
    evaluation: GroundedEvaluationReadModelSchema
  }).strict(),
  z.object({
    protocolVersion: z.literal(1),
    type: z.literal("SESSION_EVALUATION_READ"),
    sessionId: BoundedSessionIdSchema,
    available: z.literal(false),
    reason: GroundedReadFailureReasonSchema
  }).strict()
]);
export type SessionEvaluationReadResponse = z.infer<typeof SessionEvaluationReadResponseSchema>;

const TextPreviewReadSchema = z.object({
  text: z.string().max(512),
  originalLength: NonnegativeSafeIntegerSchema,
  truncated: z.boolean()
}).strict();

const ReplayRelationsReadSchema = z.object({
  utteranceId: BoundedIdentifierSchema.optional(),
  inputEpisodeId: BoundedIdentifierSchema.optional(),
  turnId: BoundedIdentifierSchema.optional(),
  generationId: BoundedIdentifierSchema.optional(),
  deliveryId: BoundedIdentifierSchema.optional(),
  requestId: BoundedIdentifierSchema.optional()
}).strict();

export const ReplayReadCategorySchema = z.enum([
  "STUDENT",
  "INTERVIEWER_DELIVERY",
  "WHITEBOARD",
  "VERIFICATION",
  "EVIDENCE",
  "LIFECYCLE",
  "RECOVERY",
  "SYSTEM"
]);
export type ReplayReadCategory = z.infer<typeof ReplayReadCategorySchema>;

export const ReplayReadEntrySchema = z.object({
  sequence: PositiveSafeIntegerSchema,
  eventId: BoundedIdentifierSchema,
  occurredAt: z.iso.datetime(),
  kind: z.string().min(1).max(128),
  summary: z.string().min(1).max(256),
  category: ReplayReadCategorySchema,
  stateValidation: z.enum([
    "VALIDATED",
    "SPECIALIZED_DOMAIN_UNVERIFIED",
    "UNKNOWN_EVENT",
    "UNAVAILABLE_AFTER_UNKNOWN"
  ]),
  source: z.string().min(1).max(128),
  relations: ReplayRelationsReadSchema,
  text: TextPreviewReadSchema.optional(),
  delivery: z.object({
    medium: z.enum(["TEXT", "AUDIO", "WHITEBOARD"]),
    status: z.enum([
      "VALIDATED",
      "QUEUED",
      "DELIVERING",
      "EXPOSED",
      "COMPLETED",
      "CANCELLED",
      "POSSIBLY_EXPOSED"
    ]),
    presentationState: z.enum([
      "GENERATED",
      "AUTHORIZED",
      "DELIVERING",
      "PRESENTED",
      "POSSIBLY_PRESENTED",
      "CANCELLED"
    ]),
    effectiveDisclosureLevel: DisclosureLevelSchema,
    disclosureIdCount: NonnegativeSafeIntegerSchema,
    contentWithheld: z.boolean(),
    boardAction: z.object({
      operation: z.string().min(1).max(128),
      content: TextPreviewReadSchema.optional(),
      targetShapeId: BoundedIdentifierSchema.optional(),
      expectedShapeRevision: NonnegativeSafeIntegerSchema.optional()
    }).strict().optional()
  }).strict().optional(),
  verification: z.object({
    phase: z.enum(["REQUESTED", "ACCEPTED", "DISCARDED"]),
    verificationRequestId: BoundedIdentifierSchema,
    verifier: z.string().min(1).max(256).optional(),
    evidenceKey: EvidenceKeySchema.optional(),
    resultStatus: z.enum(["VERIFIED", "CONTRADICTED", "UNRESOLVED"]).optional(),
    interpretationConfidence: z.number().min(0).max(1).optional()
  }).strict().optional(),
  evidence: z.object({
    transition: z.enum(["UPDATED", "INVALIDATED"]),
    key: EvidenceKeySchema,
    value: z.string().min(1).max(128).optional(),
    inferenceConfidence: z.number().min(0).max(1).optional()
  }).strict().optional()
}).strict();
export type ReplayReadEntry = z.infer<typeof ReplayReadEntrySchema>;

export const SessionReplayReadModelSchema = z.object({
  sessionId: BoundedSessionIdSchema,
  problem: z.object({
    problemId: BoundedIdentifierSchema,
    problemVersion: BoundedIdentifierSchema
  }).strict().optional(),
  lifecycle: z.object({
    status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED", "UNKNOWN"]),
    historyComplete: z.boolean(),
    started: z.boolean().nullable(),
    completed: z.boolean().nullable(),
    archived: z.boolean().nullable(),
    resumedCount: NonnegativeSafeIntegerSchema,
    recoveryOriginPossiblyExposedCount: NonnegativeSafeIntegerSchema
  }).strict(),
  currentStateAvailable: z.boolean(),
  complete: z.boolean(),
  validatedThroughSequence: NonnegativeSafeIntegerSchema,
  observedThroughSequence: NonnegativeSafeIntegerSchema,
  totalEventCount: NonnegativeSafeIntegerSchema,
  counts: z.object({
    turns: NonnegativeSafeIntegerSchema,
    deliveries: NonnegativeSafeIntegerSchema,
    exposedInterventions: NonnegativeSafeIntegerSchema,
    possiblyExposedInterventions: NonnegativeSafeIntegerSchema,
    cancelledInterventions: NonnegativeSafeIntegerSchema
  }).strict(),
  evidenceSummary: z.object({
    recordedUpdates: NonnegativeSafeIntegerSchema,
    recordedInvalidations: NonnegativeSafeIntegerSchema,
    currentActive: NonnegativeSafeIntegerSchema.optional(),
    superseded: NonnegativeSafeIntegerSchema.optional(),
    stale: NonnegativeSafeIntegerSchema.optional()
  }).strict(),
  verificationSummary: z.object({
    statusIsCurrent: z.boolean(),
    pending: NonnegativeSafeIntegerSchema,
    verified: NonnegativeSafeIntegerSchema,
    contradicted: NonnegativeSafeIntegerSchema,
    unresolved: NonnegativeSafeIntegerSchema,
    discarded: NonnegativeSafeIntegerSchema
  }).strict(),
  entries: z.array(ReplayReadEntrySchema).max(MAX_REPLAY_READ_ENTRIES),
  eventTruncation: ReadTruncationSchema,
  timelineTruncation: ReadTruncationSchema,
  issues: z.array(z.object({
    code: z.enum([
      "UNKNOWN_EVENT_SEMANTICS",
      "EVENT_LIMIT_REACHED",
      "TIMELINE_LIMIT_REACHED",
      "SPECIALIZED_DOMAIN_VALIDATION_REQUIRED",
      "CURRENT_STATE_UNAVAILABLE"
    ]),
    sequence: NonnegativeSafeIntegerSchema.optional(),
    eventType: z.string().min(1).max(128).optional()
  }).strict()).max(32)
}).strict();
export type SessionReplayReadModel = z.infer<typeof SessionReplayReadModelSchema>;

export const SessionReplayReadResponseSchema = z.discriminatedUnion("available", [
  z.object({
    protocolVersion: z.literal(1),
    type: z.literal("SESSION_REPLAY_READ"),
    sessionId: BoundedSessionIdSchema,
    available: z.literal(true),
    replay: SessionReplayReadModelSchema
  }).strict(),
  z.object({
    protocolVersion: z.literal(1),
    type: z.literal("SESSION_REPLAY_READ"),
    sessionId: BoundedSessionIdSchema,
    available: z.literal(false),
    reason: GroundedReadFailureReasonSchema
  }).strict()
]);
export type SessionReplayReadResponse = z.infer<typeof SessionReplayReadResponseSchema>;

const ScoreBreakdownReadSchema = z.object({
  technicalCorrectness: NullableScoreSchema,
  rigor: NullableScoreSchema,
  independence: NullableScoreSchema,
  communication: NullableScoreSchema,
  hintResponsiveness: NullableScoreSchema,
  errorRecovery: NullableScoreSchema,
  compositeScore: NullableScoreSchema
}).strict();

const ScoredSessionCountSchema = z.object({
  technicalCorrectness: NonnegativeSafeIntegerSchema,
  rigor: NonnegativeSafeIntegerSchema,
  independence: NonnegativeSafeIntegerSchema,
  communication: NonnegativeSafeIntegerSchema,
  hintResponsiveness: NonnegativeSafeIntegerSchema,
  errorRecovery: NonnegativeSafeIntegerSchema,
  compositeScore: NonnegativeSafeIntegerSchema
}).strict();

export const SessionHistoryCardSchema = z.object({
  sessionId: BoundedSessionIdSchema,
  problemId: BoundedIdentifierSchema.optional(),
  problemVersion: BoundedIdentifierSchema.optional(),
  status: z.enum(["CREATED", "ACTIVE", "COMPLETED", "ARCHIVED", "UNKNOWN"]),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
  eventCount: NonnegativeSafeIntegerSchema.optional(),
  readStatus: z.enum(["AVAILABLE", "UNAVAILABLE", "BUDGET_EXCLUDED"]),
  replayComplete: z.boolean().optional(),
  evaluation: z.object({
    compositeScore: NullableScoreSchema,
    compositeStatus: z.enum(["FULL", "PARTIAL", "NOT_SCORED"]),
    supportLevel: EvaluationSupportLevelSchema
  }).strict().optional()
}).strict().superRefine((card, context) => {
  if (
    card.readStatus === "AVAILABLE"
    && (
      card.status === "UNKNOWN"
      || card.createdAt === undefined
      || card.updatedAt === undefined
      || card.eventCount === undefined
      || card.replayComplete === undefined
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Available history cards require complete bounded metadata"
    });
  }
  if (card.readStatus !== "AVAILABLE" && card.evaluation !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Unavailable history cards cannot carry evaluation summaries"
    });
  }
});

export const LongitudinalReadModelSchema = z.object({
  includedSessionCount: NonnegativeSafeIntegerSchema,
  sessionTruncation: ReadTruncationSchema,
  completedSessions: NonnegativeSafeIntegerSchema,
  problemsAttempted: NonnegativeSafeIntegerSchema,
  repeatedProblems: z.array(z.object({
    problemId: BoundedIdentifierSchema,
    problemVersion: BoundedIdentifierSchema,
    attemptCount: PositiveSafeIntegerSchema
  }).strict()).max(MAX_HISTORY_READ_STATISTICS),
  repeatedProblemsTruncation: ReadTruncationSchema,
  evaluationStatistics: z.array(z.object({
    problemId: BoundedIdentifierSchema,
    problemVersion: BoundedIdentifierSchema,
    sessionCount: PositiveSafeIntegerSchema,
    scoredSessionCount: ScoredSessionCountSchema,
    average: ScoreBreakdownReadSchema,
    median: ScoreBreakdownReadSchema
  }).strict()).max(MAX_HISTORY_READ_STATISTICS),
  evaluationStatisticsTruncation: ReadTruncationSchema,
  improvement: z.array(z.object({
    problemId: BoundedIdentifierSchema,
    problemVersion: BoundedIdentifierSchema,
    fromSessionId: BoundedSessionIdSchema,
    toSessionId: BoundedSessionIdSchema,
    compositeScoreDelta: z.number().min(-100).max(100)
  }).strict()).max(MAX_HISTORY_READ_IMPROVEMENTS),
  improvementTruncation: ReadTruncationSchema,
  improvementComparisonsSkipped: NonnegativeSafeIntegerSchema,
  comparability: z.object({
    problems: z.literal("EXACT_PROBLEM_ID_AND_VERSION"),
    evidence: z.literal("EXACT_EVIDENCE_KEY_ONLY"),
    skillTaxonomyAvailable: z.literal(false)
  }).strict()
}).strict();
export type LongitudinalReadModel = z.infer<typeof LongitudinalReadModelSchema>;

export const SessionHistoryReadResponseSchema = z.object({
  protocolVersion: z.literal(1),
  type: z.literal("SESSION_HISTORY_READ"),
  sessions: z.array(SessionHistoryCardSchema).max(MAX_HISTORY_READ_SESSIONS),
  sessionTruncation: ReadTruncationSchema,
  longitudinal: LongitudinalReadModelSchema
}).strict();
export type SessionHistoryReadResponse = z.infer<typeof SessionHistoryReadResponseSchema>;

const DIMENSION_ORDER = [
  "technicalCorrectness",
  "rigor",
  "independence",
  "communication",
  "hintResponsiveness",
  "errorRecovery"
] as const satisfies readonly EvaluationDimensionName[];

function boundedText(value: string): string {
  return previewText(value, MAX_READ_TEXT_CHARS).text;
}

function boundedFeedback(values: readonly string[]): {
  readonly values: readonly string[];
  readonly truncation: TruncationInfo;
} {
  const safe = values.map(boundedText);
  return takeBounded(safe, 20);
}

function projectEvidenceRefs(
  refs: SessionEvaluation["dimensionResults"][EvaluationDimensionName]["evidenceRefs"]
): {
  readonly values: readonly z.infer<typeof ReadEvidenceRefSchema>[];
  readonly truncation: TruncationInfo;
} {
  const bounded = takeBounded(refs, MAX_EVALUATION_READ_EVIDENCE_REFS);
  return {
    values: bounded.values.map((ref) => ReadEvidenceRefSchema.parse(ref)),
    truncation: bounded.truncation
  };
}

export function projectGroundedEvaluationReadModel(
  evaluation: SessionEvaluation
): GroundedEvaluationReadModel {
  if (
    evaluation.lifecycle.sessionStatus !== "COMPLETED"
    && evaluation.lifecycle.sessionStatus !== "ARCHIVED"
  ) {
    throw new Error("Grounded evaluation read model is terminal-session only");
  }

  const dimensions = DIMENSION_ORDER.map((name) => {
    const result = evaluation.dimensionResults[name];
    const refs = projectEvidenceRefs(result.evidenceRefs);
    return {
      name,
      score: result.score,
      supportLevel: result.supportLevel,
      evidenceRefs: refs.values,
      evidenceRefTruncation: refs.truncation,
      ...(result.notScoredReason === undefined
        ? {}
        : { notScoredReason: boundedText(result.notScoredReason) })
    };
  });

  const milestones = takeBounded(
    evaluation.milestones,
    MAX_EVALUATION_READ_MILESTONES
  );
  const projectedMilestones = milestones.values.map((milestone) => {
    const refs = projectEvidenceRefs(milestone.evidenceRefs);
    return {
      milestoneId: milestone.milestoneId,
      achieved: milestone.achieved,
      ...(milestone.achievedAtTurnId === undefined
        ? {}
        : { achievedAtTurnId: milestone.achievedAtTurnId }),
      assistanceLevel: milestone.assistanceLevel,
      supportLevel: milestone.supportLevel,
      evidenceRefs: refs.values,
      evidenceRefTruncation: refs.truncation,
      assistanceDisclosureCount: milestone.assistanceDisclosureIds.length
    };
  });

  const interventions = takeBounded(
    evaluation.disclosedInterventions,
    MAX_EVALUATION_READ_INTERVENTIONS
  );
  const projectedInterventions = interventions.values.map((intervention) => {
    const related = takeBounded(intervention.relatedMilestoneIds, 64);
    return {
      deliveryId: intervention.deliveryId,
      ...(intervention.turnId === undefined ? {} : { turnId: intervention.turnId }),
      disclosureLevel: intervention.disclosureLevel,
      deliveryStatus: intervention.deliveryStatus,
      disclosureAssociationCount: intervention.disclosureIds.length,
      relatedMilestoneIds: related.values,
      relatedMilestoneTruncation: related.truncation
    };
  });

  const strengths = boundedFeedback(evaluation.keyStrengths);
  const improvements = boundedFeedback(evaluation.areasForImprovement);

  return GroundedEvaluationReadModelSchema.parse({
    sessionId: evaluation.sessionId,
    problemId: evaluation.problemId,
    problemVersion: evaluation.problemVersion,
    evaluatedAt: evaluation.evaluatedAt,
    lifecycle: {
      sessionStatus: evaluation.lifecycle.sessionStatus,
      completionState: evaluation.lifecycle.completionState
    },
    composite: {
      score: evaluation.scores.compositeScore,
      status: evaluation.composite.status,
      supportLevel: evaluation.composite.supportLevel,
      includedDimensions: evaluation.composite.includedDimensions,
      omittedDimensions: evaluation.composite.omittedDimensions
    },
    dimensions,
    milestoneSummary: {
      achieved: evaluation.milestones.filter((milestone) => milestone.achieved).length,
      total: evaluation.milestones.length,
      unassisted: evaluation.unassistedMilestoneCount,
      assisted: evaluation.assistedMilestoneCount
    },
    milestones: projectedMilestones,
    milestoneTruncation: milestones.truncation,
    disclosedInterventions: projectedInterventions,
    interventionTruncation: interventions.truncation,
    summaryAssessment: boundedText(evaluation.summaryAssessment),
    keyStrengths: strengths.values,
    strengthsTruncation: strengths.truncation,
    areasForImprovement: improvements.values,
    improvementTruncation: improvements.truncation
  });
}

function replayCategory(entry: ReplayTimelineEntry): ReplayReadCategory {
  if (entry.kind === "TURN_COMMITTED") return "STUDENT";
  if (entry.kind === "BOARD_PATCH_COMMITTED") return "WHITEBOARD";
  if (
    entry.kind === "VERIFICATION_REQUESTED"
    || entry.kind === "VERIFICATION_RESULT_ACCEPTED"
    || entry.kind === "VERIFICATION_RESULT_DISCARDED"
  ) {
    return "VERIFICATION";
  }
  if (
    entry.kind === "STUDENT_EVIDENCE_UPDATED"
    || entry.kind === "STUDENT_EVIDENCE_INVALIDATED"
  ) {
    return "EVIDENCE";
  }
  if (
    entry.kind === "DELIVERY_QUEUED"
    || entry.kind === "DELIVERY_STARTED"
    || entry.kind === "DELIVERY_EXPOSED"
    || entry.kind === "DELIVERY_COMPLETED"
    || entry.kind === "DELIVERY_CANCELLED"
    || entry.kind === "DELIVERY_POSSIBLY_EXPOSED"
  ) {
    if (
      entry.kind === "DELIVERY_POSSIBLY_EXPOSED"
      && entry.provenance.source === "RECOVERY"
    ) {
      return "RECOVERY";
    }
    return "INTERVIEWER_DELIVERY";
  }
  if (entry.kind === "SESSION_RESUMED") return "RECOVERY";
  if (
    entry.kind === "SESSION_STARTED"
    || entry.kind === "SESSION_COMPLETED"
    || entry.kind === "SESSION_ARCHIVED"
  ) {
    return "LIFECYCLE";
  }
  return "SYSTEM";
}

function safeReplayText(entry: ReplayTimelineEntry): ReplayTimelineEntry["text"] | undefined {
  const category = replayCategory(entry);
  if (category === "STUDENT" || category === "WHITEBOARD") return entry.text;
  if (entry.kind === "DELIVERY_EXPOSED") return entry.delivery?.text;
  return undefined;
}

function projectReplayEntry(entry: ReplayTimelineEntry): ReplayReadEntry {
  const text = safeReplayText(entry);
  const delivery = entry.delivery === undefined
    ? undefined
    : {
        medium: entry.delivery.medium,
        status: entry.delivery.status,
        presentationState: entry.delivery.presentationState,
        effectiveDisclosureLevel: entry.delivery.disclosure.effectiveDisclosureLevel,
        disclosureIdCount: entry.delivery.disclosure.disclosureIdCount,
        contentWithheld:
          entry.kind !== "DELIVERY_EXPOSED"
          || (
            entry.delivery.text === undefined
            && entry.delivery.boardAction === undefined
          ),
        ...(entry.kind === "DELIVERY_EXPOSED" && entry.delivery.boardAction !== undefined
          ? { boardAction: entry.delivery.boardAction }
          : {})
      };

  const verification = entry.verification === undefined
    ? undefined
    : {
        phase: entry.verification.phase,
        verificationRequestId: entry.verification.verificationRequestId,
        ...(entry.verification.verifier === undefined
          ? {}
          : { verifier: entry.verification.verifier }),
        ...(entry.verification.evidenceKey === undefined
          ? {}
          : { evidenceKey: entry.verification.evidenceKey }),
        ...(entry.verification.resultStatus === undefined
          ? {}
          : { resultStatus: entry.verification.resultStatus }),
        ...(entry.verification.interpretationConfidence === undefined
          ? {}
          : { interpretationConfidence: entry.verification.interpretationConfidence })
      };

  const evidence =
    entry.evidence === undefined || entry.evidence.transition === "PROPOSED"
      ? undefined
      : {
          transition: entry.evidence.transition,
          key: entry.evidence.key,
          ...(entry.evidence.value === undefined ? {} : { value: entry.evidence.value }),
          ...(entry.evidence.inferenceConfidence === undefined
            ? {}
            : { inferenceConfidence: entry.evidence.inferenceConfidence })
        };

  return ReplayReadEntrySchema.parse({
    sequence: entry.provenance.sequence,
    eventId: entry.provenance.eventId,
    occurredAt: entry.provenance.wallTime,
    kind: entry.kind,
    summary: entry.summary,
    category: replayCategory(entry),
    stateValidation: entry.stateValidation,
    source: entry.provenance.source,
    relations: entry.relations,
    ...(text === undefined ? {} : { text }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(verification === undefined ? {} : { verification }),
    ...(evidence === undefined ? {} : { evidence })
  });
}

function combineReadTruncation(
  upstream: TruncationInfo,
  local: TruncationInfo
): TruncationInfo {
  const remainingCount = upstream.remainingCount + local.remainingCount;
  return {
    truncated: remainingCount > 0,
    limit: Math.min(upstream.limit, local.limit),
    remainingCount
  };
}

export function projectSessionReplayReadModel(
  history: SessionHistoryProjection
): SessionReplayReadModel {
  if (history.sessionId === null) {
    throw new Error("Replay read model requires a session identity");
  }

  const entryWindow = takeBounded(
    history.timeline.entries,
    MAX_REPLAY_READ_ENTRIES
  );
  const combinedTimelineTruncation = combineReadTruncation(
    history.timeline.timelineTruncation,
    entryWindow.truncation
  );
  const issueValues = entryWindow.truncation.truncated
    && !history.timeline.issues.some((issue) => issue.code === "TIMELINE_LIMIT_REACHED")
      ? [...history.timeline.issues, { code: "TIMELINE_LIMIT_REACHED" as const }]
      : [...history.timeline.issues];
  const issues = takeBounded(issueValues, 32).values;

  return SessionReplayReadModelSchema.parse({
    sessionId: history.sessionId,
    ...(history.problem === undefined ? {} : { problem: history.problem }),
    lifecycle: {
      status: history.lifecycle.status,
      historyComplete: history.lifecycle.historyComplete,
      started: history.lifecycle.started,
      completed: history.lifecycle.completed,
      archived: history.lifecycle.archived,
      resumedCount: history.lifecycle.resumedCount,
      recoveryOriginPossiblyExposedCount:
        history.lifecycle.recoveryOriginPossiblyExposedCount
    },
    currentStateAvailable: history.currentStateAvailable,
    complete: history.timeline.complete && !entryWindow.truncation.truncated,
    validatedThroughSequence: history.validatedThroughSequence,
    observedThroughSequence: history.observedThroughSequence,
    totalEventCount: history.totalEventCount,
    counts: {
      turns: history.counts.turns,
      deliveries: history.counts.deliveries,
      exposedInterventions: history.counts.exposedInterventions,
      possiblyExposedInterventions: history.counts.possiblyExposedInterventions,
      cancelledInterventions: history.counts.cancelledInterventions
    },
    evidenceSummary: history.evidenceSummary,
    verificationSummary: history.verificationSummary,
    entries: entryWindow.values.map(projectReplayEntry),
    eventTruncation: history.timeline.eventTruncation,
    timelineTruncation: combinedTimelineTruncation,
    issues
  });
}

export function projectLongitudinalReadModel(
  history: LongitudinalHistoryProjection
): LongitudinalReadModel {
  const repeatedProblems = takeBounded(
    history.repeatedProblems,
    MAX_HISTORY_READ_STATISTICS
  );
  const evaluationStatistics = takeBounded(
    history.evaluationStatistics,
    MAX_HISTORY_READ_STATISTICS
  );
  const improvement = takeBounded(
    history.improvement,
    MAX_HISTORY_READ_IMPROVEMENTS
  );

  return LongitudinalReadModelSchema.parse({
    includedSessionCount: history.includedSessionCount,
    sessionTruncation: history.sessionTruncation,
    completedSessions: history.completedSessions,
    problemsAttempted: history.problemsAttempted,
    repeatedProblems: repeatedProblems.values,
    repeatedProblemsTruncation: repeatedProblems.truncation,
    evaluationStatistics: evaluationStatistics.values,
    evaluationStatisticsTruncation: evaluationStatistics.truncation,
    improvement: improvement.values,
    improvementTruncation: improvement.truncation,
    improvementComparisonsSkipped: history.improvementComparisonsSkipped,
    comparability: history.comparability
  });
}

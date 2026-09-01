import { z } from "zod";
import {
  DeliveryStatusSchema,
  DisclosureLevelSchema,
  EvidenceKeySchema,
  EvidenceRatingSchema,
  EvaluationSupportLevelSchema,
  SessionEvaluationSchema,
  SessionStatusSchema,
  StoredSessionSummarySchema
} from "../../domain/src/index.js";

const SafeNonnegativeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);
const SafePositiveIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "Expected a positive safe integer" }
);
const BoundedIdentifierSchema = z.string().min(1).max(512);

export const ProductReadFailureReasonSchema = z.enum([
  "SESSION_NOT_FOUND",
  "SESSION_NOT_TERMINAL",
  "EXACT_PROBLEM_UNAVAILABLE",
  "HISTORY_UNAVAILABLE",
  "HISTORY_TOO_LARGE",
  "EVALUATION_UNAVAILABLE"
]);
export type ProductReadFailureReason = z.infer<typeof ProductReadFailureReasonSchema>;

export const ProductTruncationSchema = z.object({
  truncated: z.boolean(),
  limit: SafePositiveIntegerSchema,
  remainingCount: SafeNonnegativeIntegerSchema
}).strict();

export const ProductTextPreviewSchema = z.object({
  text: z.string(),
  originalLength: SafeNonnegativeIntegerSchema,
  truncated: z.boolean()
}).strict();

export const ProductEvaluationReadResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    evaluation: SessionEvaluationSchema
  }).strict(),
  z.object({
    available: z.literal(false),
    reason: ProductReadFailureReasonSchema
  }).strict()
]);
export type ProductEvaluationReadResponse = z.infer<
  typeof ProductEvaluationReadResponseSchema
>;

export const ProductReplayCategorySchema = z.enum([
  "STUDENT",
  "INTERVIEWER_DELIVERY",
  "WHITEBOARD",
  "VERIFICATION",
  "EVIDENCE",
  "LIFECYCLE",
  "SYSTEM"
]);
export type ProductReplayCategory = z.infer<typeof ProductReplayCategorySchema>;

export const ProductReplayTimelineEntrySchema = z.object({
  eventId: BoundedIdentifierSchema,
  sequence: SafePositiveIntegerSchema,
  occurredAt: z.iso.datetime(),
  category: ProductReplayCategorySchema,
  summary: z.string().min(1).max(200),
  stateValidation: z.enum([
    "VALIDATED",
    "SPECIALIZED_DOMAIN_UNVERIFIED",
    "UNKNOWN_EVENT",
    "UNAVAILABLE_AFTER_UNKNOWN"
  ]),
  relations: z.object({
    turnId: BoundedIdentifierSchema.optional(),
    inputEpisodeId: BoundedIdentifierSchema.optional(),
    deliveryId: BoundedIdentifierSchema.optional(),
    requestId: BoundedIdentifierSchema.optional()
  }).strict(),
  text: ProductTextPreviewSchema.optional(),
  delivery: z.object({
    status: DeliveryStatusSchema,
    presentationState: z.enum([
      "GENERATED",
      "AUTHORIZED",
      "DELIVERING",
      "PRESENTED",
      "POSSIBLY_PRESENTED",
      "CANCELLED"
    ]),
    effectiveDisclosureLevel: DisclosureLevelSchema,
    disclosureIdCount: SafeNonnegativeIntegerSchema,
    contentWithheld: z.boolean()
  }).strict().optional(),
  evidence: z.object({
    transition: z.enum(["UPDATED", "INVALIDATED"]),
    key: EvidenceKeySchema,
    value: EvidenceRatingSchema.optional(),
    inferenceConfidence: z.number().min(0).max(1).optional()
  }).strict().optional(),
  verification: z.object({
    phase: z.enum(["REQUESTED", "ACCEPTED", "DISCARDED"]),
    verificationRequestId: BoundedIdentifierSchema,
    resultStatus: z.enum(["VERIFIED", "CONTRADICTED", "UNRESOLVED"]).optional()
  }).strict().optional()
}).strict();

export const ProductReplayReadResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    sessionId: BoundedIdentifierSchema,
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
      resumedCount: SafeNonnegativeIntegerSchema,
      recoveryOriginPossiblyExposedCount: SafeNonnegativeIntegerSchema,
      startedAt: z.iso.datetime().optional(),
      completedAt: z.iso.datetime().optional(),
      archivedAt: z.iso.datetime().optional()
    }).strict(),
    counts: z.object({
      turns: SafeNonnegativeIntegerSchema,
      deliveries: SafeNonnegativeIntegerSchema,
      exposedInterventions: SafeNonnegativeIntegerSchema,
      possiblyExposedInterventions: SafeNonnegativeIntegerSchema,
      cancelledInterventions: SafeNonnegativeIntegerSchema
    }).strict(),
    complete: z.boolean(),
    currentStateAvailable: z.boolean(),
    validatedThroughSequence: SafeNonnegativeIntegerSchema,
    observedThroughSequence: SafeNonnegativeIntegerSchema,
    totalEventCount: SafeNonnegativeIntegerSchema,
    timeline: z.array(ProductReplayTimelineEntrySchema).max(5_000),
    timelineTruncation: ProductTruncationSchema,
    evidenceSummary: z.object({
      recordedUpdates: SafeNonnegativeIntegerSchema,
      recordedInvalidations: SafeNonnegativeIntegerSchema,
      currentActive: SafeNonnegativeIntegerSchema.optional(),
      superseded: SafeNonnegativeIntegerSchema.optional(),
      stale: SafeNonnegativeIntegerSchema.optional()
    }).strict(),
    verificationSummary: z.object({
      statusIsCurrent: z.boolean(),
      pending: SafeNonnegativeIntegerSchema,
      verified: SafeNonnegativeIntegerSchema,
      contradicted: SafeNonnegativeIntegerSchema,
      unresolved: SafeNonnegativeIntegerSchema,
      discarded: SafeNonnegativeIntegerSchema
    }).strict(),
    issues: z.array(z.object({
      code: z.enum([
        "UNKNOWN_EVENT_SEMANTICS",
        "EVENT_LIMIT_REACHED",
        "TIMELINE_LIMIT_REACHED",
        "SPECIALIZED_DOMAIN_VALIDATION_REQUIRED",
        "CURRENT_STATE_UNAVAILABLE"
      ]),
      sequence: SafePositiveIntegerSchema.optional(),
      eventType: z.string().max(128).optional()
    }).strict()).max(64)
  }).strict(),
  z.object({
    available: z.literal(false),
    reason: ProductReadFailureReasonSchema
  }).strict()
]);
export type ProductReplayReadResponse = z.infer<typeof ProductReplayReadResponseSchema>;

const NullableScoreSchema = z.number().min(0).max(100).nullable();

export const ProductHistoryEvaluationSummarySchema = z.object({
  compositeScore: NullableScoreSchema,
  compositeStatus: z.enum(["FULL", "PARTIAL", "NOT_SCORED"]),
  supportLevel: EvaluationSupportLevelSchema
}).strict();

export const ProductHistorySessionSchema = StoredSessionSummarySchema.extend({
  sessionId: BoundedIdentifierSchema,
  problemId: BoundedIdentifierSchema.optional(),
  problemVersion: BoundedIdentifierSchema.optional(),
  reviewAvailable: z.boolean(),
  evaluation: ProductHistoryEvaluationSummarySchema.optional()
}).strict();

export const ProductLongitudinalEvaluationStatisticsSchema = z.object({
  problemId: BoundedIdentifierSchema,
  problemVersion: BoundedIdentifierSchema,
  sessionCount: SafeNonnegativeIntegerSchema,
  scoredSessionCount: z.object({
    technicalCorrectness: SafeNonnegativeIntegerSchema,
    rigor: SafeNonnegativeIntegerSchema,
    independence: SafeNonnegativeIntegerSchema,
    communication: SafeNonnegativeIntegerSchema,
    hintResponsiveness: SafeNonnegativeIntegerSchema,
    errorRecovery: SafeNonnegativeIntegerSchema,
    compositeScore: SafeNonnegativeIntegerSchema
  }).strict(),
  average: z.object({
    technicalCorrectness: NullableScoreSchema,
    rigor: NullableScoreSchema,
    independence: NullableScoreSchema,
    communication: NullableScoreSchema,
    hintResponsiveness: NullableScoreSchema,
    errorRecovery: NullableScoreSchema,
    compositeScore: NullableScoreSchema
  }).strict(),
  median: z.object({
    technicalCorrectness: NullableScoreSchema,
    rigor: NullableScoreSchema,
    independence: NullableScoreSchema,
    communication: NullableScoreSchema,
    hintResponsiveness: NullableScoreSchema,
    errorRecovery: NullableScoreSchema,
    compositeScore: NullableScoreSchema
  }).strict()
}).strict();

export const ProductHistoryReadResponseSchema = z.object({
  sessions: z.array(ProductHistorySessionSchema).max(500),
  sessionTruncation: ProductTruncationSchema,
  longitudinal: z.object({
    completedSessions: SafeNonnegativeIntegerSchema,
    problemsAttempted: SafeNonnegativeIntegerSchema,
    repeatedProblems: z.array(z.object({
      problemId: BoundedIdentifierSchema,
      problemVersion: BoundedIdentifierSchema,
      attemptCount: SafePositiveIntegerSchema
    }).strict()).max(500),
    evaluationStatistics: z.array(ProductLongitudinalEvaluationStatisticsSchema).max(500),
    improvement: z.array(z.object({
      problemId: BoundedIdentifierSchema,
      problemVersion: BoundedIdentifierSchema,
      fromSessionId: BoundedIdentifierSchema,
      toSessionId: BoundedIdentifierSchema,
      compositeScoreDelta: z.number().min(-100).max(100)
    }).strict()).max(500),
    improvementComparisonsSkipped: SafeNonnegativeIntegerSchema,
    comparability: z.object({
      problems: z.literal("EXACT_PROBLEM_ID_AND_VERSION"),
      evidence: z.literal("EXACT_EVIDENCE_KEY_ONLY"),
      skillTaxonomyAvailable: z.literal(false)
    }).strict()
  }).strict()
}).strict();
export type ProductHistoryReadResponse = z.infer<typeof ProductHistoryReadResponseSchema>;

export const ProductReadSessionStatusSchema = SessionStatusSchema;

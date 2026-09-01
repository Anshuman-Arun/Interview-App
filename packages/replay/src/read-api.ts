import { z } from "zod";
import {
  CompositeDimensionNameSchema,
  DisclosureLevelSchema,
  EvaluationDimensionNameSchema,
  EvaluationEvidenceRefSchema,
  EvaluationSupportLevelSchema,
  EvidenceKeySchema,
  SessionIdSchema,
  type EvaluationDimensionName,
  type SessionEvaluation
} from "../../domain/src/index.js";
import type { EventType } from "../../events/src/index.js";
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

export const MAX_EVALUATION_READ_MILESTONES = 100;
export const MAX_EVALUATION_READ_INTERVENTIONS = 100;
export const MAX_EVALUATION_READ_EVIDENCE_REFS = 32;
export const MAX_EVALUATION_READ_RELATED_MILESTONES = 32;
export const MAX_HISTORY_READ_SESSIONS = 100;
export const MAX_HISTORY_READ_STATISTICS = 100;
export const MAX_HISTORY_READ_IMPROVEMENTS = 100;
export const MAX_REPLAY_READ_ENTRIES = 1_000;
export const MAX_READ_TEXT_CHARS = 1_000;

const DIMENSION_ORDER = [
  "technicalCorrectness",
  "rigor",
  "independence",
  "communication",
  "hintResponsiveness",
  "errorRecovery"
] as const satisfies readonly EvaluationDimensionName[];

function codePointLength(value: string): number {
  let length = 0;
  for (const character of value) {
    length += Math.min(character.length, 1);
  }
  return length;
}

const NonnegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);
const PositiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "Expected a positive safe integer" }
);
const BoundedSessionIdSchema = SessionIdSchema.superRefine((value, context) => {
  if (value.length > MAX_REPLAY_IDENTIFIER_CHARS || value === "." || value === "..") {
    context.addIssue({
      code: "custom",
      message: "Session identifier exceeds the read-model limit"
    });
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "/" || character === "\\" || code <= 31 || code === 127) {
      context.addIssue({
        code: "custom",
        message: "Session identifier is unsafe for the bounded read path"
      });
      break;
    }
  }
});
const BoundedIdentifierSchema = z.string().min(1).max(MAX_REPLAY_IDENTIFIER_CHARS);
const BoundedTextSchema = z.string().refine(
  (value) => codePointLength(value) <= MAX_READ_TEXT_CHARS,
  { message: "Text exceeds the read-model code-point limit" }
);
const NullableScoreSchema = z.number().min(0).max(100).nullable();

const BoundedEvidenceKeySchema = EvidenceKeySchema.superRefine((key, context) => {
  const subjectId = key.subject.kind === "CLAIM"
    ? key.subject.claimId
    : key.subject.kind === "MILESTONE"
      ? key.subject.milestoneId
      : key.subject.kind === "SKILL"
        ? key.subject.skillId
        : key.subject.approachId;
  if (
    key.problemId.length > MAX_REPLAY_IDENTIFIER_CHARS
    || subjectId.length > MAX_REPLAY_IDENTIFIER_CHARS
  ) {
    context.addIssue({
      code: "custom",
      message: "Evidence key identifier exceeds the read-model limit"
    });
  }
});

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
  if (
    new Set(result.evidenceRefs.map((ref) => ref.kind + ":" + ref.id)).size
      !== result.evidenceRefs.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Read dimension evidence references must be unique"
    });
  }
  if (
    result.evidenceRefTruncation.truncated
      ? result.evidenceRefs.length !== result.evidenceRefTruncation.limit
      : result.evidenceRefs.length > result.evidenceRefTruncation.limit
  ) {
    context.addIssue({
      code: "custom",
      message: "Read dimension evidence truncation does not match the retained references"
    });
  }
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
}).strict().superRefine((milestone, context) => {
  if (
    new Set(milestone.evidenceRefs.map((ref) => ref.kind + ":" + ref.id)).size
      !== milestone.evidenceRefs.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Milestone read evidence references must be unique"
    });
  }
  if (
    milestone.evidenceRefTruncation.truncated
      ? milestone.evidenceRefs.length !== milestone.evidenceRefTruncation.limit
      : milestone.evidenceRefs.length > milestone.evidenceRefTruncation.limit
  ) {
    context.addIssue({
      code: "custom",
      message: "Milestone read evidence truncation is inconsistent"
    });
  }
  if (
    (milestone.assistanceLevel === 0)
      !== (milestone.assistanceDisclosureCount === 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Milestone assistance level/count are inconsistent"
    });
  }
});

export const GroundedEvaluationInterventionSchema = z.object({
  deliveryId: BoundedIdentifierSchema,
  turnId: BoundedIdentifierSchema.optional(),
  disclosureLevel: DisclosureLevelSchema,
  deliveryStatus: z.enum(["EXPOSED", "COMPLETED", "POSSIBLY_EXPOSED"]),
  disclosureAssociationCount: NonnegativeSafeIntegerSchema,
  relatedMilestoneIds: z.array(BoundedIdentifierSchema)
    .max(MAX_EVALUATION_READ_RELATED_MILESTONES),
  relatedMilestoneTruncation: ReadTruncationSchema
}).strict().superRefine((intervention, context) => {
  if (
    new Set(intervention.relatedMilestoneIds).size
      !== intervention.relatedMilestoneIds.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Intervention milestone associations must be unique"
    });
  }
  if (
    intervention.relatedMilestoneTruncation.truncated
      ? intervention.relatedMilestoneIds.length
        !== intervention.relatedMilestoneTruncation.limit
      : intervention.relatedMilestoneIds.length
        > intervention.relatedMilestoneTruncation.limit
  ) {
    context.addIssue({
      code: "custom",
      message: "Intervention milestone truncation is inconsistent"
    });
  }
});

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
    includedDimensions: z.array(CompositeDimensionNameSchema).max(5),
    omittedDimensions: z.array(CompositeDimensionNameSchema).max(5)
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
}).strict().superRefine((evaluation, context) => {
  const dimensions = new Map(
    evaluation.dimensions.map((dimension) => [dimension.name, dimension] as const)
  );
  if (
    new Set(evaluation.milestones.map((milestone) => milestone.milestoneId)).size
      !== evaluation.milestones.length
    || new Set(
      evaluation.disclosedInterventions.map((intervention) => intervention.deliveryId)
    ).size !== evaluation.disclosedInterventions.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Evaluation read collections must have unique authoritative identities"
    });
  }
  if (
    dimensions.size !== DIMENSION_ORDER.length
    || DIMENSION_ORDER.some((name) => !dimensions.has(name))
  ) {
    context.addIssue({
      code: "custom",
      message: "Grounded evaluation dimensions must contain each supported dimension exactly once"
    });
  }

  const included = new Set(evaluation.composite.includedDimensions);
  const omitted = new Set(evaluation.composite.omittedDimensions);
  if (
    included.size !== evaluation.composite.includedDimensions.length
    || omitted.size !== evaluation.composite.omittedDimensions.length
    || evaluation.composite.includedDimensions.some((name) => omitted.has(name))
  ) {
    context.addIssue({
      code: "custom",
      message: "Composite included/omitted dimensions must be unique and disjoint"
    });
  }
  for (const name of included) {
    if (dimensions.get(name)?.score === null) {
      context.addIssue({
        code: "custom",
        message: "Composite cannot include an unscored dimension"
      });
    }
  }
  for (const name of omitted) {
    if (dimensions.get(name)?.score !== null) {
      context.addIssue({
        code: "custom",
        message: "Composite omitted dimensions must be unscored"
      });
    }
  }

  if (evaluation.composite.status === "NOT_SCORED") {
    if (
      evaluation.composite.score !== null
      || evaluation.composite.supportLevel !== "INSUFFICIENT"
      || evaluation.composite.includedDimensions.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Not-scored composite metadata is inconsistent"
      });
    }
  } else if (
    evaluation.composite.score === null
    || evaluation.composite.supportLevel === "INSUFFICIENT"
    || evaluation.composite.includedDimensions.length === 0
    || (
      evaluation.composite.status === "FULL"
        ? evaluation.composite.omittedDimensions.length !== 0
        : evaluation.composite.omittedDimensions.length === 0
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Scored composite metadata is inconsistent"
    });
  }

  if (
    evaluation.milestoneSummary.achieved > evaluation.milestoneSummary.total
    || evaluation.milestoneSummary.unassisted
      + evaluation.milestoneSummary.assisted
      !== evaluation.milestoneSummary.achieved
    || evaluation.milestones.length
      + evaluation.milestoneTruncation.remainingCount
      !== evaluation.milestoneSummary.total
  ) {
    context.addIssue({
      code: "custom",
      message: "Milestone summary is inconsistent with the bounded milestone projection"
    });
  }

  for (const milestone of evaluation.milestones) {
    if (
      (!milestone.achieved && milestone.achievedAtTurnId !== undefined)
      || (milestone.achieved && milestone.supportLevel === "INSUFFICIENT")
    ) {
      context.addIssue({
        code: "custom",
        message: "Milestone achievement metadata is inconsistent"
      });
      break;
    }
  }
});
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
]).superRefine((response, context) => {
  if (response.available && response.evaluation.sessionId !== response.sessionId) {
    context.addIssue({
      code: "custom",
      message: "Evaluation read response session identity is inconsistent"
    });
  }
});
export type SessionEvaluationReadResponse = z.infer<typeof SessionEvaluationReadResponseSchema>;

const TextPreviewReadSchema = z.object({
  text: z.string().refine(
    (value) => codePointLength(value) <= 512,
    { message: "Text preview exceeds the read-model code-point limit" }
  ),
  originalLength: NonnegativeSafeIntegerSchema,
  truncated: z.boolean()
}).strict().superRefine((preview, context) => {
  const visibleLength = codePointLength(preview.text);
  if (preview.originalLength < visibleLength) {
    context.addIssue({
      code: "custom",
      message: "Text preview original length is smaller than rendered content"
    });
  }
  if (preview.truncated && preview.originalLength <= visibleLength) {
    context.addIssue({
      code: "custom",
      message: "Truncated text preview must omit at least one code point"
    });
  }
  if (!preview.truncated && preview.originalLength !== visibleLength) {
    context.addIssue({
      code: "custom",
      message: "Untruncated text preview length is inconsistent"
    });
  }
});

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

const SAFE_REPLAY_SUMMARY_BY_KIND = {
  SESSION_STARTED: "Session started",
  PROBLEM_PRESENTED: "Problem presented",
  QUANT_RESEARCH_SCENARIO_INITIALIZED: "Quant Research scenario initialized",
  QUANT_RESEARCH_ACTION_ACCEPTED: "Quant Research action accepted",
  QUANT_RESEARCH_SCENARIO_COMPLETED: "Quant Research scenario completed",
  UTTERANCE_STARTED: "Speech utterance started",
  UTTERANCE_DISCARDED: "Speech utterance discarded",
  INPUT_EPISODE_STARTED: "Input episode started",
  INPUT_EPISODE_UPDATED: "Input episode updated",
  INPUT_EPISODE_COMMITTED: "Input episode committed",
  TURN_COMMITTED: "Turn committed",
  TRANSCRIPT_FINALIZED: "Transcript finalized",
  TRANSCRIPT_CORRECTED: "Transcript corrected",
  BOARD_PATCH_COMMITTED: "Whiteboard changed",
  VISION_REQUESTED: "Vision verification requested",
  VISION_RESULT_ACCEPTED: "Vision result accepted",
  VISION_RESULT_DISCARDED: "Vision result discarded",
  LOCAL_COMPUTE_REQUESTED: "Local compute requested",
  LOCAL_COMPUTE_RESULT_ACCEPTED: "Local compute result accepted",
  LOCAL_COMPUTE_RESULT_DISCARDED: "Local compute result discarded",
  VERIFICATION_REQUESTED: "Verification requested",
  VERIFICATION_RESULT_ACCEPTED: "Verification result accepted",
  VERIFICATION_RESULT_DISCARDED: "Verification result discarded",
  EVIDENCE_PROPOSED: "Evidence proposed",
  STUDENT_EVIDENCE_UPDATED: "Evidence updated",
  STUDENT_EVIDENCE_INVALIDATED: "Evidence marked stale",
  PEDAGOGICAL_ACTION_SELECTED: "Pedagogical policy decision",
  MODEL_GENERATION_STARTED: "Generation started",
  GENERATION_CONTEXT_COMPILED: "Generation context compiled",
  MODEL_PROPOSAL_RECEIVED: "Generated proposal persisted",
  FORMAL_INTERPRETATION_PROPOSAL_RECEIVED: "Formal interpretation proposal persisted",
  FORMAL_INTERPRETATION_PROPOSAL_REJECTED: "Formal interpretation proposal rejected",
  MODEL_GENERATION_SUPERSEDED: "Generation superseded",
  PROPOSAL_VALIDATED: "Generated proposal authorized",
  PROPOSAL_REJECTED: "Generated proposal rejected",
  DELIVERY_QUEUED: "Delivery authorized and queued",
  DELIVERY_STARTED: "Delivery started",
  DELIVERY_EXPOSED: "Delivery exposed",
  DELIVERY_COMPLETED: "Delivery completed",
  DELIVERY_CANCELLED: "Delivery cancelled before known exposure",
  DELIVERY_POSSIBLY_EXPOSED: "Delivery possibly exposed",
  POLICY_REVISION_CHANGED: "Policy revision changed",
  PROBLEM_STATE_REVISION_CHANGED: "Problem-state revision changed",
  SESSION_COMPLETED: "Session completed",
  SESSION_ARCHIVED: "Session archived",
  SESSION_RESUMED: "Session resumed",
  UNKNOWN_EVENT: "Unknown authoritative event; payload intentionally withheld"
} as const satisfies Readonly<Record<EventType | "UNKNOWN_EVENT", string>>;

function expectedReplayReadCategory(
  kind: string,
  source: string
): ReplayReadCategory {
  if (
    kind === "TURN_COMMITTED"
    || kind === "UTTERANCE_STARTED"
    || kind === "UTTERANCE_DISCARDED"
    || kind === "INPUT_EPISODE_STARTED"
    || kind === "INPUT_EPISODE_UPDATED"
    || kind === "INPUT_EPISODE_COMMITTED"
    || kind === "TRANSCRIPT_FINALIZED"
    || kind === "TRANSCRIPT_CORRECTED"
  ) return "STUDENT";
  if (kind === "BOARD_PATCH_COMMITTED") return "WHITEBOARD";
  if (
    kind === "VERIFICATION_REQUESTED"
    || kind === "VERIFICATION_RESULT_ACCEPTED"
    || kind === "VERIFICATION_RESULT_DISCARDED"
  ) return "VERIFICATION";
  if (
    kind === "STUDENT_EVIDENCE_UPDATED"
    || kind === "STUDENT_EVIDENCE_INVALIDATED"
  ) return "EVIDENCE";
  if (
    kind === "DELIVERY_QUEUED"
    || kind === "DELIVERY_STARTED"
    || kind === "DELIVERY_EXPOSED"
    || kind === "DELIVERY_COMPLETED"
    || kind === "DELIVERY_CANCELLED"
    || kind === "DELIVERY_POSSIBLY_EXPOSED"
  ) {
    return kind === "DELIVERY_POSSIBLY_EXPOSED" && source === "RECOVERY"
      ? "RECOVERY"
      : "INTERVIEWER_DELIVERY";
  }
  if (kind === "SESSION_RESUMED") return "RECOVERY";
  if (
    kind === "SESSION_STARTED"
    || kind === "PROBLEM_PRESENTED"
    || kind === "SESSION_COMPLETED"
    || kind === "SESSION_ARCHIVED"
  ) return "LIFECYCLE";
  return "SYSTEM";
}

const REPLAY_DELIVERY_EVENT_KINDS = new Set([
  "DELIVERY_QUEUED",
  "DELIVERY_STARTED",
  "DELIVERY_EXPOSED",
  "DELIVERY_COMPLETED",
  "DELIVERY_CANCELLED",
  "DELIVERY_POSSIBLY_EXPOSED"
]);

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
    evidenceKey: BoundedEvidenceKeySchema.optional(),
    resultStatus: z.enum(["VERIFIED", "CONTRADICTED", "UNRESOLVED"]).optional(),
    interpretationConfidence: z.number().min(0).max(1).optional()
  }).strict().optional(),
  evidence: z.object({
    transition: z.enum(["UPDATED", "INVALIDATED"]),
    key: BoundedEvidenceKeySchema,
    value: z.string().min(1).max(128).optional(),
    inferenceConfidence: z.number().min(0).max(1).optional()
  }).strict().optional()
}).strict().superRefine((entry, context) => {
  const safeSummary = (
    SAFE_REPLAY_SUMMARY_BY_KIND as Readonly<Record<string, string | undefined>>
  )[entry.kind];
  const expectedSummary = entry.stateValidation === "UNAVAILABLE_AFTER_UNKNOWN"
    ? "Known event after unknown semantic boundary; payload intentionally withheld"
    : safeSummary;
  if (
    expectedSummary === undefined
    || entry.summary !== expectedSummary
    || entry.category !== expectedReplayReadCategory(entry.kind, entry.source)
  ) {
    context.addIssue({
      code: "custom",
      message: "Replay label metadata is inconsistent with its authoritative event kind"
    });
  }

  const isUnknownBoundaryEntry =
    entry.stateValidation === "UNKNOWN_EVENT"
    || entry.stateValidation === "UNAVAILABLE_AFTER_UNKNOWN";
  if (
    (entry.kind === "UNKNOWN_EVENT") !== (entry.stateValidation === "UNKNOWN_EVENT")
  ) {
    context.addIssue({
      code: "custom",
      message: "Unknown replay events require the unknown-event validation state"
    });
  }
  if (
    isUnknownBoundaryEntry
    && (
      Object.keys(entry.relations).length !== 0
      || entry.text !== undefined
      || entry.delivery !== undefined
      || entry.verification !== undefined
      || entry.evidence !== undefined
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Replay payload must remain withheld at an unknown semantic boundary"
    });
  }

  const textMayBeRendered =
    !isUnknownBoundaryEntry
    && (
      entry.kind === "TURN_COMMITTED"
      || entry.kind === "BOARD_PATCH_COMMITTED"
      || entry.kind === "DELIVERY_EXPOSED"
    );
  if (entry.text !== undefined && !textMayBeRendered) {
    context.addIssue({
      code: "custom",
      message: "Replay read text is not allowed for this event kind"
    });
  }

  if (
    entry.delivery !== undefined
    && !REPLAY_DELIVERY_EVENT_KINDS.has(entry.kind)
  ) {
    context.addIssue({
      code: "custom",
      message: "Replay delivery detail is attached to a non-delivery event"
    });
  }

  const deliveryExpectation = entry.kind === "DELIVERY_QUEUED"
    ? { status: "QUEUED", presentationState: "AUTHORIZED" }
    : entry.kind === "DELIVERY_STARTED"
      ? { status: "DELIVERING", presentationState: "DELIVERING" }
      : entry.kind === "DELIVERY_EXPOSED"
        ? { status: "EXPOSED", presentationState: "PRESENTED" }
        : entry.kind === "DELIVERY_COMPLETED"
          ? { status: "COMPLETED", presentationState: "PRESENTED" }
          : entry.kind === "DELIVERY_CANCELLED"
            ? { status: "CANCELLED", presentationState: "CANCELLED" }
            : entry.kind === "DELIVERY_POSSIBLY_EXPOSED"
              ? { status: "POSSIBLY_EXPOSED", presentationState: "POSSIBLY_PRESENTED" }
              : undefined;

  if (entry.delivery !== undefined) {
    if (
      deliveryExpectation === undefined
      || entry.delivery.status !== deliveryExpectation.status
      || entry.delivery.presentationState !== deliveryExpectation.presentationState
      || entry.relations.deliveryId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Replay delivery metadata is inconsistent with its authoritative event"
      });
    }
    if (
      entry.kind !== "DELIVERY_EXPOSED"
      && (
        !entry.delivery.contentWithheld
        || entry.delivery.boardAction !== undefined
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Non-exposed delivery content must remain withheld"
      });
    }
    if (entry.kind === "DELIVERY_EXPOSED" && entry.delivery.contentWithheld) {
      context.addIssue({
        code: "custom",
        message: "Authoritatively exposed delivery content cannot be marked withheld"
      });
    }
  } else if (
    deliveryExpectation !== undefined
    && entry.stateValidation !== "UNAVAILABLE_AFTER_UNKNOWN"
  ) {
    context.addIssue({
      code: "custom",
      message: "Validated delivery events require bounded delivery metadata"
    });
  }

  const verificationPhase = entry.kind === "VERIFICATION_REQUESTED"
    ? "REQUESTED"
    : entry.kind === "VERIFICATION_RESULT_ACCEPTED"
      ? "ACCEPTED"
      : entry.kind === "VERIFICATION_RESULT_DISCARDED"
        ? "DISCARDED"
        : undefined;
  if (entry.verification !== undefined) {
    if (
      verificationPhase === undefined
      || entry.verification.phase !== verificationPhase
      || entry.relations.requestId !== entry.verification.verificationRequestId
    ) {
      context.addIssue({
        code: "custom",
        message: "Replay verification metadata is inconsistent with its authoritative event"
      });
    }
  } else if (
    verificationPhase !== undefined
    && entry.stateValidation !== "UNAVAILABLE_AFTER_UNKNOWN"
  ) {
    context.addIssue({
      code: "custom",
      message: "Validated verification events require bounded verification metadata"
    });
  }

  const evidenceTransition = entry.kind === "STUDENT_EVIDENCE_UPDATED"
    ? "UPDATED"
    : entry.kind === "STUDENT_EVIDENCE_INVALIDATED"
      ? "INVALIDATED"
      : undefined;
  if (entry.evidence !== undefined) {
    if (
      evidenceTransition === undefined
      || entry.evidence.transition !== evidenceTransition
    ) {
      context.addIssue({
        code: "custom",
        message: "Replay evidence metadata is inconsistent with its authoritative event"
      });
    }
  } else if (
    evidenceTransition !== undefined
    && entry.stateValidation !== "UNAVAILABLE_AFTER_UNKNOWN"
  ) {
    context.addIssue({
      code: "custom",
      message: "Validated evidence events require bounded evidence metadata"
    });
  }
});
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
}).strict().superRefine((replay, context) => {
  if (
    replay.validatedThroughSequence > replay.observedThroughSequence
    || replay.observedThroughSequence > replay.totalEventCount
  ) {
    context.addIssue({
      code: "custom",
      message: "Replay validated/observed sequence bounds are inconsistent"
    });
  }
  const eventIds = new Set<string>();
  for (const [index, entry] of replay.entries.entries()) {
    if (
      entry.sequence !== index + 1
      || entry.sequence > replay.observedThroughSequence
      || eventIds.has(entry.eventId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Replay entries must be a unique contiguous authoritative prefix"
      });
      break;
    }
    eventIds.add(entry.eventId);
  }
  if (
    replay.complete
    && (
      !replay.currentStateAvailable
      || replay.eventTruncation.truncated
      || replay.timelineTruncation.truncated
      || replay.issues.length > 0
      || replay.entries.length !== replay.totalEventCount
      || replay.validatedThroughSequence !== replay.totalEventCount
      || replay.observedThroughSequence !== replay.totalEventCount
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "A complete replay cannot carry truncation, issues, or unavailable current state"
    });
  }
  if (replay.eventTruncation.truncated && replay.currentStateAvailable) {
    context.addIssue({
      code: "custom",
      message: "Event-truncated replay cannot claim current authoritative state"
    });
  }
});
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
]).superRefine((response, context) => {
  if (response.available && response.replay.sessionId !== response.sessionId) {
    context.addIssue({
      code: "custom",
      message: "Replay read response session identity is inconsistent"
    });
  }
});
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
  if (
    card.evaluation !== undefined
    && card.status !== "COMPLETED"
    && card.status !== "ARCHIVED"
  ) {
    context.addIssue({
      code: "custom",
      message: "Only terminal history cards may carry evaluation summaries"
    });
  }
  if (
    card.evaluation !== undefined
    && (
      (card.evaluation.compositeScore === null)
      !== (card.evaluation.compositeStatus === "NOT_SCORED")
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "History evaluation score/status are inconsistent"
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
  }).strict().superRefine((statistics, context) => {
    for (const name of Object.keys(statistics.scoredSessionCount) as Array<
      keyof typeof statistics.scoredSessionCount
    >) {
      const scoredCount = statistics.scoredSessionCount[name];
      if (scoredCount > statistics.sessionCount) {
        context.addIssue({
          code: "custom",
          message: "Scored-session count exceeds the evaluated-session count"
        });
      }
      const shouldBeNull = scoredCount === 0;
      if (
        (statistics.average[name] === null) !== shouldBeNull
        || (statistics.median[name] === null) !== shouldBeNull
      ) {
        context.addIssue({
          code: "custom",
          message: "Longitudinal score nullability does not match its denominator"
        });
      }
    }
  })).max(MAX_HISTORY_READ_STATISTICS),
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
}).strict().superRefine((history, context) => {
  if (
    history.completedSessions > history.includedSessionCount
    || history.problemsAttempted > history.includedSessionCount
  ) {
    context.addIssue({
      code: "custom",
      message: "Longitudinal aggregate counts exceed the included session population"
    });
  }
  if (
    history.evaluationStatistics.some(
      (statistics) => statistics.sessionCount > history.includedSessionCount
    )
    || history.repeatedProblems.some(
      (problem) =>
        problem.attemptCount < 2
        || problem.attemptCount > history.includedSessionCount
    )
    || history.improvement.some(
      (record) => record.fromSessionId === record.toSessionId
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Longitudinal detail is inconsistent with the included session population"
    });
  }
  const statisticKeys = history.evaluationStatistics.map(
    (statistics) => JSON.stringify([statistics.problemId, statistics.problemVersion])
  );
  const repeatedKeys = history.repeatedProblems.map(
    (problem) => JSON.stringify([problem.problemId, problem.problemVersion])
  );
  if (
    new Set(statisticKeys).size !== statisticKeys.length
    || new Set(repeatedKeys).size !== repeatedKeys.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Longitudinal problem aggregates must be unique"
    });
  }
});
export type LongitudinalReadModel = z.infer<typeof LongitudinalReadModelSchema>;

export const SessionHistoryReadResponseSchema = z.object({
  protocolVersion: z.literal(1),
  type: z.literal("SESSION_HISTORY_READ"),
  sessions: z.array(SessionHistoryCardSchema).max(MAX_HISTORY_READ_SESSIONS),
  sessionTruncation: ReadTruncationSchema,
  longitudinal: LongitudinalReadModelSchema
}).strict().superRefine((history, context) => {
  const sessionIds = new Set(history.sessions.map((session) => session.sessionId));
  if (sessionIds.size !== history.sessions.length) {
    context.addIssue({
      code: "custom",
      message: "History read response contains duplicate session identities"
    });
  }
  if (
    history.longitudinal.includedSessionCount > history.sessions.length
    || history.longitudinal.sessionTruncation.remainingCount
      < history.sessionTruncation.remainingCount
  ) {
    context.addIssue({
      code: "custom",
      message: "Longitudinal coverage cannot exceed retained session-card coverage"
    });
  }
});
export type SessionHistoryReadResponse = z.infer<typeof SessionHistoryReadResponseSchema>;

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
    const related = takeBounded(intervention.relatedMilestoneIds, MAX_EVALUATION_READ_RELATED_MILESTONES);
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
  return expectedReplayReadCategory(entry.kind, entry.provenance.source);
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

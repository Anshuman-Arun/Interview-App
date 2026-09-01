import { z } from "zod";
import {
  BoardRevisionSchema,
  ContextEpochSchema,
  ContextCompilationManifestSchema,
  DeliveryAtomSchema,
  DeliveryIdSchema,
  DisclosureAnalysisSchema,
  EvidenceKeySchema,
  EvidenceProposalSchema,
  EvidenceValueSchema,
  EventIdSchema,
  FormalInterpretationProposalSchema,
  GenerationBasisSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  InterviewerProposalSchema,
  PolicyRevisionSchema,
  ProviderContextSpecFingerprintSchema,
  ProviderRuntimeNameSchema,
  ProblemStateRevisionSchema,
  RealizationRequestSchema,
  RequestIdSchema,
  SessionIdSchema,
  TranscriptRevisionSchema,
  TurnIdSchema,
  UtteranceIdSchema,
  BoardObservationSchema,
  VerificationResultSchema
} from "../../domain/src/index.js";

export const CURRENT_EVENT_SCHEMA_VERSION = 2 as const;
export const EventSourceSchema = z.enum(["APPLICATION", "USER", "PROVIDER", "RENDERER", "WORKER", "RECOVERY"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

const PositiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "Expected a positive safe integer" }
);
const NonnegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);

const SafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value),
  { message: "Expected a safe integer" }
);
const QuantResearchVersionTagSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/u);
const QuantResearchFamilySchema = z.enum([
  "BAYESIAN_UPDATING",
  "SAMPLING_ESTIMATION",
  "EXPERIMENTAL_ALLOCATION",
  "MODEL_COMPARISON",
  "CONSTRAINED_OPTIMIZATION"
]);
const QuantResearchScoreSchema = z.number().int().min(0).max(100);
const QuantResearchActionIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u);
const QuantResearchFiniteInputSchema = z.number().min(-1_000_000).max(1_000_000);
const QuantResearchRationalSchema = z.object({
  numerator: SafeIntegerSchema,
  denominator: PositiveSafeIntegerSchema
}).strict();
const QuantResearchAllocationSchema = z.object({
  a: NonnegativeSafeIntegerSchema,
  b: NonnegativeSafeIntegerSchema
}).strict();
const QuantResearchOptimizationPointSchema = z.object({
  x: NonnegativeSafeIntegerSchema,
  y: NonnegativeSafeIntegerSchema
}).strict();
const QuantResearchModelPointSchema = z.object({
  x: NonnegativeSafeIntegerSchema,
  y: SafeIntegerSchema
}).strict();

export const QuantResearchScenarioDefinitionEventSchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("BAYESIAN_UPDATING"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      priorAlpha: z.number().int().min(1).max(100),
      priorBeta: z.number().int().min(1).max(100),
      observationCount: z.number().int().min(2).max(32),
      perturbedPriorAlpha: z.number().int().min(1).max(100),
      perturbedPriorBeta: z.number().int().min(1).max(100)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("SAMPLING_ESTIMATION"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      maxSamples: z.number().int().min(3).max(32),
      populationSize: z.number().int().min(8).max(128),
      centerMin: z.number().int().min(-100).max(100),
      centerMax: z.number().int().min(-100).max(100),
      noiseRadius: z.number().int().min(1).max(20),
      outlierShift: z.number().int().min(1).max(50)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("EXPERIMENTAL_ALLOCATION"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      totalBudget: z.number().int().min(4).max(100),
      costA: z.number().int().min(1).max(20),
      costB: z.number().int().min(1).max(20),
      perturbedCostA: z.number().int().min(1).max(20),
      perturbedCostB: z.number().int().min(1).max(20),
      noiseA: z.number().int().min(1).max(10),
      noiseB: z.number().int().min(1).max(10)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("MODEL_COMPARISON"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      observationCount: z.number().int().min(6).max(30),
      noiseRadius: z.number().int().min(1).max(10),
      outlierShift: z.number().int().min(1).max(50)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("CONSTRAINED_OPTIMIZATION"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      budget: z.number().int().min(5).max(60),
      perturbedBudget: z.number().int().min(5).max(60),
      maxX: z.number().int().min(1).max(60),
      maxY: z.number().int().min(1).max(60),
      perturbedPenalty: z.number().int().min(0).max(20)
    }).strict()
  }).strict()
]);
export type QuantResearchScenarioDefinitionEvent = z.infer<typeof QuantResearchScenarioDefinitionEventSchema>;

export const QuantResearchActionEventSchema = z.discriminatedUnion("kind", [
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("SUBMIT_PROBABILITY"),
    value: z.number().min(0).max(1)
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("REQUEST_OBSERVATION"),
    count: z.number().int().min(1).max(32)
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("SUBMIT_NUMERIC_ESTIMATE"),
    value: QuantResearchFiniteInputSchema
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("ALLOCATE_SAMPLE"),
    a: z.number().int().min(0).max(100),
    b: z.number().int().min(0).max(100)
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("CHOOSE_OPTION"),
    option: z.enum(["A", "B", "CONSTANT", "LINEAR"])
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("SUBMIT_PARAMETERS"),
    values: z.array(QuantResearchFiniteInputSchema).min(1).max(8)
  }).strict()
]);
export type QuantResearchActionEvent = z.infer<typeof QuantResearchActionEventSchema>;

const QuantResearchEvidenceCategorySchema = z.enum([
  "NUMERICAL_CORRECTNESS",
  "CALIBRATION",
  "ADAPTATION",
  "SAMPLE_EFFICIENCY",
  "CONSISTENCY",
  "OBJECTIVE_QUALITY",
  "CONSTRAINT_DISCIPLINE",
  "ROBUSTNESS"
]);
const QuantResearchEvidenceEventSchema = z.object({
  category: QuantResearchEvidenceCategorySchema,
  stage: z.string().min(1).max(64),
  score: QuantResearchScoreSchema,
  summary: z.string().min(1).max(1_000)
}).strict();
const QuantResearchMetricsEventSchema = z.object({
  NUMERICAL_CORRECTNESS: QuantResearchScoreSchema.optional(),
  CALIBRATION: QuantResearchScoreSchema.optional(),
  ADAPTATION: QuantResearchScoreSchema.optional(),
  SAMPLE_EFFICIENCY: QuantResearchScoreSchema.optional(),
  CONSISTENCY: QuantResearchScoreSchema.optional(),
  OBJECTIVE_QUALITY: QuantResearchScoreSchema.optional(),
  CONSTRAINT_DISCIPLINE: QuantResearchScoreSchema.optional(),
  ROBUSTNESS: QuantResearchScoreSchema.optional()
}).strict();

export const QuantResearchResultEventSchema = z.object({
  status: z.enum(["IN_PROGRESS", "COMPLETE"]),
  family: QuantResearchFamilySchema,
  version: QuantResearchVersionTagSchema,
  generatorVersion: QuantResearchVersionTagSchema,
  rngVersion: QuantResearchVersionTagSchema,
  acceptedActionCount: z.number().int().min(0).max(64),
  overallScore: QuantResearchScoreSchema,
  metrics: QuantResearchMetricsEventSchema,
  evidence: z.array(QuantResearchEvidenceEventSchema).max(16)
}).strict();
export type QuantResearchResultEvent = z.infer<typeof QuantResearchResultEventSchema>;

export const QuantResearchAuthoritativeSnapshotEventSchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("BAYESIAN_UPDATING"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      observations: z.array(z.boolean()).min(2).max(32),
      successes: z.number().int().min(0).max(32)
    }).strict(),
    gradingData: z.object({
      priorPredictive: QuantResearchRationalSchema,
      posterior: QuantResearchRationalSchema,
      perturbedPosterior: QuantResearchRationalSchema
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("SAMPLING_ESTIMATION"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      hiddenCenter: SafeIntegerSchema,
      hiddenPopulation: z.array(SafeIntegerSchema).min(8).max(128),
      sampleOrder: z.array(NonnegativeSafeIntegerSchema).min(8).max(128),
      contaminatedObservation: SafeIntegerSchema
    }).strict(),
    gradingData: z.object({
      validatedCenter: SafeIntegerSchema
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("EXPERIMENTAL_ALLOCATION"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      hiddenMeanA: SafeIntegerSchema,
      hiddenMeanB: SafeIntegerSchema,
      sequenceA: z.array(SafeIntegerSchema).min(4).max(100),
      sequenceB: z.array(SafeIntegerSchema).min(4).max(100)
    }).strict(),
    gradingData: z.object({
      baseOptimalVariance: QuantResearchRationalSchema,
      baseOptimalAllocations: z.array(QuantResearchAllocationSchema).min(1).max(100),
      perturbedOptimalVariance: QuantResearchRationalSchema,
      perturbedOptimalAllocations: z.array(QuantResearchAllocationSchema).min(1).max(100)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("MODEL_COMPARISON"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      hiddenModel: z.enum(["CONSTANT", "LINEAR"]),
      hiddenIntercept: SafeIntegerSchema,
      hiddenSlope: SafeIntegerSchema,
      points: z.array(QuantResearchModelPointSchema).min(6).max(30),
      perturbedPoints: z.array(QuantResearchModelPointSchema).min(6).max(30)
    }).strict(),
    gradingData: z.object({
      validatedModel: z.enum(["CONSTANT", "LINEAR"])
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("CONSTRAINED_OPTIMIZATION"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      coefficientX: SafeIntegerSchema,
      coefficientY: SafeIntegerSchema,
      basePenalty: NonnegativeSafeIntegerSchema
    }).strict(),
    gradingData: z.object({
      baseBestObjective: SafeIntegerSchema,
      baseOptimalPoints: z.array(QuantResearchOptimizationPointSchema).min(1).max(128),
      perturbedBestObjective: SafeIntegerSchema,
      perturbedOptimalPoints: z.array(QuantResearchOptimizationPointSchema).min(1).max(128)
    }).strict()
  }).strict()
]);
export type QuantResearchAuthoritativeSnapshotEvent = z.infer<typeof QuantResearchAuthoritativeSnapshotEventSchema>;

const metadata = {
  eventId: EventIdSchema,
  sessionId: SessionIdSchema,
  sequence: PositiveSafeIntegerSchema,
  schemaVersion: z.literal(CURRENT_EVENT_SCHEMA_VERSION),
  source: EventSourceSchema,
  wallTime: z.iso.datetime(),
  elapsedMs: NonnegativeSafeIntegerSchema,
  causationId: RequestIdSchema,
  correlationId: RequestIdSchema
};

const event = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) =>
  z.object({ ...metadata, type: z.literal(type), payload }).strict();

export const SessionEventSchema = z.discriminatedUnion("type", [
  event("SESSION_STARTED", z.object({ startedAt: z.iso.datetime() }).strict()),
  event("PROBLEM_PRESENTED", z.object({
    problemId: z.string().min(1),
    problemVersion: z.string().min(1),
    prompt: z.string().min(1),
    providerContextSpecSha256: ProviderContextSpecFingerprintSchema.optional()
  }).strict()),
  event("QUANT_RESEARCH_SCENARIO_INITIALIZED", z.object({
    definition: QuantResearchScenarioDefinitionEventSchema,
    authoritativeSnapshot: QuantResearchAuthoritativeSnapshotEventSchema
  }).strict()),
  event("QUANT_RESEARCH_ACTION_ACCEPTED", z.object({
    action: QuantResearchActionEventSchema
  }).strict()),
  event("QUANT_RESEARCH_SCENARIO_COMPLETED", z.object({
    result: QuantResearchResultEventSchema
  }).strict()),
  event("UTTERANCE_STARTED", z.object({ utteranceId: UtteranceIdSchema }).strict()),
  event("UTTERANCE_DISCARDED", z.object({ utteranceId: UtteranceIdSchema, reason: z.string().min(1) }).strict()),
  event("INPUT_EPISODE_STARTED", z.object({ inputEpisodeId: InputEpisodeIdSchema }).strict()),
  event("INPUT_EPISODE_UPDATED", z.object({ inputEpisodeId: InputEpisodeIdSchema, modality: z.enum(["SPEECH", "TYPING", "WHITEBOARD"]), semanticContent: z.string().min(1) }).strict()),
  event("INPUT_EPISODE_COMMITTED", z.object({ inputEpisodeId: InputEpisodeIdSchema }).strict()),
  event("TURN_COMMITTED", z.object({ turnId: TurnIdSchema, inputEpisodeId: InputEpisodeIdSchema, studentText: z.string().min(1) }).strict()),
  event("TRANSCRIPT_FINALIZED", z.object({ utteranceId: UtteranceIdSchema, inputEpisodeId: InputEpisodeIdSchema, transcriptRevision: TranscriptRevisionSchema, text: z.string().min(1) }).strict()),
  event("TRANSCRIPT_CORRECTED", z.object({ transcriptRevision: TranscriptRevisionSchema, contextEpoch: ContextEpochSchema, correctedText: z.string().min(1) }).strict()),
  event("BOARD_PATCH_COMMITTED", z.object({ boardRevision: BoardRevisionSchema, summary: z.string().min(1) }).strict()),
  event("VISION_REQUESTED", z.object({ visionRequestId: RequestIdSchema, sourceBoardRevision: BoardRevisionSchema, regionId: z.string().min(1), relevantShapeIds: z.array(z.string().min(1)).min(1) }).strict()),
  event("VISION_RESULT_ACCEPTED", z.object({ visionRequestId: RequestIdSchema, observation: BoardObservationSchema }).strict()),
  event("VISION_RESULT_DISCARDED", z.object({ visionRequestId: RequestIdSchema, reason: z.string().min(1) }).strict()),
  event("LOCAL_COMPUTE_REQUESTED", z.object({
    computeRequestId: RequestIdSchema,
    operation: z.literal("ANALYZE_TRANSCRIPT"),
    inputEpisodeId: InputEpisodeIdSchema,
    sourceTranscriptRevision: TranscriptRevisionSchema
  }).strict()),
  event("LOCAL_COMPUTE_RESULT_ACCEPTED", z.object({
    computeRequestId: RequestIdSchema,
    operation: z.literal("ANALYZE_TRANSCRIPT"),
    sourceTranscriptRevision: TranscriptRevisionSchema,
    normalizedText: z.string(),
    tokenCount: z.number().int().nonnegative()
  }).strict()),
  event("LOCAL_COMPUTE_RESULT_DISCARDED", z.object({
    computeRequestId: RequestIdSchema,
    operation: z.literal("ANALYZE_TRANSCRIPT"),
    reason: z.string().min(1)
  }).strict()),
  event("VERIFICATION_REQUESTED", z.object({
    verificationRequestId: RequestIdSchema,
    verifier: z.string().min(1),
    basis: GenerationBasisSchema,
    candidateFormalInterpretation: z.string().min(1).max(100_000),
    interpretationConfidence: z.number().min(0).max(1),
    evidenceKey: EvidenceKeySchema,
    evidenceEventIds: z.array(EventIdSchema).min(1),
    sourceGenerationId: GenerationIdSchema.optional(),
    sourceProposalRequestId: RequestIdSchema.optional()
  }).strict()),
  event("VERIFICATION_RESULT_ACCEPTED", z.object({
    verificationRequestId: RequestIdSchema,
    result: VerificationResultSchema
  }).strict()),
  event("VERIFICATION_RESULT_DISCARDED", z.object({
    verificationRequestId: RequestIdSchema,
    reason: z.string().min(1)
  }).strict()),
  event("EVIDENCE_PROPOSED", z.object({ proposal: EvidenceProposalSchema }).strict()),
  event("STUDENT_EVIDENCE_UPDATED", z.object({
    key: EvidenceKeySchema,
    value: EvidenceValueSchema,
    supersedesEventId: EventIdSchema.optional()
  }).strict()),
  event("STUDENT_EVIDENCE_INVALIDATED", z.object({
    key: EvidenceKeySchema,
    invalidatesEventId: EventIdSchema,
    reason: z.string().min(1)
  }).strict()),
  event("PEDAGOGICAL_ACTION_SELECTED", z.object({ turnId: TurnIdSchema, request: RealizationRequestSchema }).strict()),
  event("MODEL_GENERATION_STARTED", z.object({
    generationId: GenerationIdSchema,
    basis: GenerationBasisSchema,
    provider: ProviderRuntimeNameSchema
  }).strict()),
  event("GENERATION_CONTEXT_COMPILED", z.object({
    generationId: GenerationIdSchema,
    manifest: ContextCompilationManifestSchema
  }).strict()),
  event("MODEL_PROPOSAL_RECEIVED", z.object({ generationId: GenerationIdSchema, proposal: InterviewerProposalSchema }).strict()),
  event("FORMAL_INTERPRETATION_PROPOSAL_RECEIVED", z.object({
    generationId: GenerationIdSchema,
    proposalRequestId: RequestIdSchema,
    proposal: FormalInterpretationProposalSchema
  }).strict()),
  event("FORMAL_INTERPRETATION_PROPOSAL_REJECTED", z.object({
    generationId: GenerationIdSchema,
    reason: z.string().min(1)
  }).strict()),
  event("MODEL_GENERATION_SUPERSEDED", z.object({ generationId: GenerationIdSchema, reason: z.string().min(1) }).strict()),
  event("PROPOSAL_VALIDATED", z.object({ generationId: GenerationIdSchema, analysis: DisclosureAnalysisSchema }).strict()),
  event("PROPOSAL_REJECTED", z.object({ generationId: GenerationIdSchema, reason: z.string().min(1) }).strict()),
  event("DELIVERY_QUEUED", z.object({ atom: DeliveryAtomSchema }).strict()),
  event("DELIVERY_STARTED", z.object({ deliveryId: DeliveryIdSchema }).strict()),
  event("DELIVERY_EXPOSED", z.object({ deliveryId: DeliveryIdSchema }).strict()),
  event("DELIVERY_COMPLETED", z.object({ deliveryId: DeliveryIdSchema }).strict()),
  event("DELIVERY_CANCELLED", z.object({ deliveryId: DeliveryIdSchema, reason: z.string().min(1) }).strict()),
  event("DELIVERY_POSSIBLY_EXPOSED", z.object({ deliveryId: DeliveryIdSchema, reason: z.string().min(1) }).strict()),
  event("POLICY_REVISION_CHANGED", z.object({ policyRevision: PolicyRevisionSchema, contextEpoch: ContextEpochSchema, reason: z.string().min(1) }).strict()),
  event("PROBLEM_STATE_REVISION_CHANGED", z.object({ problemStateRevision: ProblemStateRevisionSchema, contextEpoch: ContextEpochSchema, reason: z.string().min(1) }).strict()),
  event("SESSION_COMPLETED", z.object({ completedAt: z.iso.datetime(), summary: z.string().min(1).optional() }).strict()),
  event("SESSION_ARCHIVED", z.object({ archivedAt: z.iso.datetime(), reason: z.string().min(1).optional() }).strict()),
  event("SESSION_RESUMED", z.object({ resumedAt: z.iso.datetime() }).strict())
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type EventType = SessionEvent["type"];
export type EventBody = SessionEvent extends infer TEvent
  ? TEvent extends SessionEvent
    ? Pick<TEvent, "type" | "payload">
    : never
  : never;
export type EventDraft = EventBody & { readonly source: EventSource };

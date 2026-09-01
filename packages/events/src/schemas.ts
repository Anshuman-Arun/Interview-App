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
  event("MODEL_GENERATION_STARTED", z.object({ generationId: GenerationIdSchema, basis: GenerationBasisSchema, provider: z.string().min(1) }).strict()),
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

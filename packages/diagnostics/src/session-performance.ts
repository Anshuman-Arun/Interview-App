import { z } from "zod";
import { SessionIdSchema } from "../../domain/src/index.js";

const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NonnegativeFiniteSchema = z.number().nonnegative();
const BoundedBytesSchema = NonnegativeSafeIntegerSchema;

export const RemoteReasoningOperationKindSchema = z.enum([
  "INTERVIEWER_REALIZATION",
  "FORMAL_INTERPRETATION"
]);
export type RemoteReasoningOperationKind = z.infer<typeof RemoteReasoningOperationKindSchema>;

export const RemoteReasoningOutcomeSchema = z.enum([
  "SUCCESS",
  "ABSTAINED",
  "TIMEOUT",
  "CANCELLED",
  "POLICY_DENIED",
  "PROVIDER_UNAVAILABLE",
  "MALFORMED",
  "FAILED"
]);
export type RemoteReasoningOutcome = z.infer<typeof RemoteReasoningOutcomeSchema>;

export const SessionLatencySummarySchema = z.object({
  count: NonnegativeSafeIntegerSchema,
  medianMs: NonnegativeFiniteSchema.nullable(),
  slowestMs: NonnegativeFiniteSchema.nullable()
}).strict();
export type SessionLatencySummary = z.infer<typeof SessionLatencySummarySchema>;

export const RemoteOutcomeCountsSchema = z.object({
  SUCCESS: NonnegativeSafeIntegerSchema,
  ABSTAINED: NonnegativeSafeIntegerSchema,
  TIMEOUT: NonnegativeSafeIntegerSchema,
  CANCELLED: NonnegativeSafeIntegerSchema,
  POLICY_DENIED: NonnegativeSafeIntegerSchema,
  PROVIDER_UNAVAILABLE: NonnegativeSafeIntegerSchema,
  MALFORMED: NonnegativeSafeIntegerSchema,
  FAILED: NonnegativeSafeIntegerSchema
}).strict();

export const SessionPerformanceSummarySchema = z.object({
  measuredBy: z.literal("Interview App"),
  partial: z.boolean(),
  candidateSubstantiveTurns: NonnegativeSafeIntegerSchema,
  remote: z.object({
    interviewerCalls: NonnegativeSafeIntegerSchema,
    formalInterpretationCalls: NonnegativeSafeIntegerSchema,
    totalCalls: NonnegativeSafeIntegerSchema,
    interviewerLatency: SessionLatencySummarySchema,
    formalInterpretationLatency: SessionLatencySummarySchema,
    outcomes: RemoteOutcomeCountsSchema,
    requestBytes: BoundedBytesSchema,
    compiledContextBytes: BoundedBytesSchema,
    responseBytes: BoundedBytesSchema
  }).strict(),
  formalInterpretation: z.object({
    attempts: NonnegativeSafeIntegerSchema,
    accepted: NonnegativeSafeIntegerSchema,
    abstentions: NonnegativeSafeIntegerSchema,
    timeouts: NonnegativeSafeIntegerSchema,
    cancelled: NonnegativeSafeIntegerSchema,
    failedOrMalformed: NonnegativeSafeIntegerSchema,
    verification: z.object({
      VERIFIED: NonnegativeSafeIntegerSchema,
      CONTRADICTED: NonnegativeSafeIntegerSchema,
      UNRESOLVED: NonnegativeSafeIntegerSchema
    }).strict()
  }).strict(),
  local: z.object({
    voiceInputSessions: NonnegativeSafeIntegerSchema,
    committedUtterances: NonnegativeSafeIntegerSchema,
    stt: z.object({
      finalizations: NonnegativeSafeIntegerSchema,
      failures: NonnegativeSafeIntegerSchema,
      cancellations: NonnegativeSafeIntegerSchema,
      latency: SessionLatencySummarySchema
    }).strict(),
    tts: z.object({
      requests: NonnegativeSafeIntegerSchema,
      successes: NonnegativeSafeIntegerSchema,
      failures: NonnegativeSafeIntegerSchema,
      cancellations: NonnegativeSafeIntegerSchema,
      bargeInInterruptions: NonnegativeSafeIntegerSchema,
      latency: SessionLatencySummarySchema
    }).strict(),
    vision: z.object({
      requests: NonnegativeSafeIntegerSchema,
      inferenceCompletions: NonnegativeSafeIntegerSchema,
      acceptedObservations: NonnegativeSafeIntegerSchema,
      staleRejections: NonnegativeSafeIntegerSchema,
      otherRejections: NonnegativeSafeIntegerSchema,
      inferenceFailures: NonnegativeSafeIntegerSchema,
      latency: SessionLatencySummarySchema
    }).strict()
  }).strict()
}).strict().superRefine((summary, context) => {
  const boundedSum = (...values: readonly number[]): number =>
    values.reduce(
      (total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value),
      0
    );
  const issue = (message: string): void => {
    context.addIssue({ code: "custom", message });
  };

  if (
    summary.remote.totalCalls
    !== boundedSum(
      summary.remote.interviewerCalls,
      summary.remote.formalInterpretationCalls
    )
  ) {
    issue("Remote call totals are inconsistent");
  }
  if (
    boundedSum(...Object.values(summary.remote.outcomes))
    !== summary.remote.totalCalls
  ) {
    issue("Remote outcome totals are inconsistent");
  }
  if (summary.remote.interviewerLatency.count > summary.remote.interviewerCalls) {
    issue("Interviewer latency samples exceed interviewer calls");
  }
  if (
    summary.remote.formalInterpretationLatency.count
    > summary.remote.formalInterpretationCalls
  ) {
    issue("Formal latency samples exceed formal calls");
  }

  const formalResults = boundedSum(
    summary.formalInterpretation.accepted,
    summary.formalInterpretation.abstentions,
    summary.formalInterpretation.timeouts,
    summary.formalInterpretation.cancelled,
    summary.formalInterpretation.failedOrMalformed
  );
  if (formalResults > summary.formalInterpretation.attempts) {
    issue("Formal interpretation results exceed attempts");
  }
  if (
    boundedSum(
      summary.formalInterpretation.verification.VERIFIED,
      summary.formalInterpretation.verification.CONTRADICTED,
      summary.formalInterpretation.verification.UNRESOLVED
    ) !== summary.formalInterpretation.accepted
  ) {
    issue("Formal verification totals are inconsistent with accepted interpretations");
  }

  const sttTerminal = boundedSum(
    summary.local.stt.finalizations,
    summary.local.stt.failures,
    summary.local.stt.cancellations
  );
  if (summary.local.stt.latency.count > sttTerminal) {
    issue("STT latency samples exceed terminal STT outcomes");
  }

  const ttsTerminal = boundedSum(
    summary.local.tts.successes,
    summary.local.tts.failures,
    summary.local.tts.cancellations
  );
  if (ttsTerminal > summary.local.tts.requests) {
    issue("TTS terminal outcomes exceed TTS requests");
  }
  if (summary.local.tts.latency.count > ttsTerminal) {
    issue("TTS latency samples exceed terminal TTS outcomes");
  }
  if (summary.local.tts.bargeInInterruptions > summary.local.tts.requests) {
    issue("TTS barge-in interruptions exceed TTS requests");
  }

  const visionInferenceTerminal = boundedSum(
    summary.local.vision.inferenceCompletions,
    summary.local.vision.inferenceFailures
  );
  if (visionInferenceTerminal > summary.local.vision.requests) {
    issue("Vision terminal inference outcomes exceed vision requests");
  }
  if (summary.local.vision.latency.count > visionInferenceTerminal) {
    issue("Vision latency samples exceed terminal inference outcomes");
  }
  if (
    boundedSum(
      summary.local.vision.acceptedObservations,
      summary.local.vision.staleRejections,
      summary.local.vision.otherRejections
    ) > visionInferenceTerminal
  ) {
    issue("Vision admission outcomes exceed terminal inference outcomes");
  }
});
export type SessionPerformanceSummary = z.infer<typeof SessionPerformanceSummarySchema>;

export const SessionPerformanceReadResponseSchema = z.object({
  protocolVersion: z.literal(1),
  type: z.literal("SESSION_PERFORMANCE_READ"),
  sessionId: SessionIdSchema,
  available: z.boolean(),
  partial: z.boolean(),
  summary: SessionPerformanceSummarySchema.optional()
}).strict().superRefine((response, context) => {
  if (response.available !== (response.summary !== undefined)) {
    context.addIssue({ code: "custom", message: "Performance availability and summary are inconsistent" });
  }
  if (response.summary !== undefined && response.summary.partial !== response.partial) {
    context.addIssue({ code: "custom", message: "Performance partial flags are inconsistent" });
  }
});
export type SessionPerformanceReadResponse = z.infer<typeof SessionPerformanceReadResponseSchema>;

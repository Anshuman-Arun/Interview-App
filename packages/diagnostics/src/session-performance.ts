import { z } from "zod";
import { SessionIdSchema, VerificationStatusSchema } from "../../domain/src/index.js";

const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NonnegativeFiniteSchema = z.number().finite().nonnegative();
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
    verification: z.record(VerificationStatusSchema, NonnegativeSafeIntegerSchema)
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
  if (summary.remote.totalCalls !== summary.remote.interviewerCalls + summary.remote.formalInterpretationCalls) {
    context.addIssue({ code: "custom", message: "Remote call totals are inconsistent" });
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

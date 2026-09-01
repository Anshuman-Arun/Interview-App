import { z } from "zod";
import { RequestIdSchema, UtteranceIdSchema } from "../../domain/src/index.js";

export const SPEECH_PROTOCOL_VERSION = 1 as const;
export const MAX_SPEECH_FRAME_DURATION_MS = 100;
export const MAX_SPEECH_UTTERANCE_DURATION_MS = 60_000;
export const MAX_SPEECH_BUFFERED_PCM_BYTES = 12 * 1024 * 1024;
export const MAX_SPEECH_CONCURRENT_STREAMS = 4;
export const MAX_SPEECH_TRANSCRIPT_CHARS = 20_000;
export const MAX_SPEECH_WORD_TIMINGS = 1_000;
export const MAX_SPEECH_DIAGNOSTICS = 32;
export const MAX_SPEECH_DIAGNOSTIC_CHARS = 256;

export const SpeechProtocolVersionSchema = z.literal(SPEECH_PROTOCOL_VERSION);
export const SpeechStreamIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
export type SpeechStreamId = z.infer<typeof SpeechStreamIdSchema>;

export const SpeechSampleRateSchema = z.union([z.literal(16_000), z.literal(48_000)]);
export type SpeechSampleRate = z.infer<typeof SpeechSampleRateSchema>;

export const SpeechChannelCountSchema = z.literal(1);
export const SpeechSampleFormatSchema = z.literal("F32LE");

const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const FiniteNonnegativeNumberSchema = z.number().nonnegative();

export const SpeechPcmFrameEnvelopeSchema = z.object({
  protocolVersion: SpeechProtocolVersionSchema,
  requestId: RequestIdSchema,
  streamId: SpeechStreamIdSchema,
  sequence: NonnegativeSafeIntegerSchema,
  sampleRate: SpeechSampleRateSchema,
  channels: SpeechChannelCountSchema,
  sampleFormat: SpeechSampleFormatSchema,
  frameSamples: PositiveSafeIntegerSchema,
  payloadByteLength: PositiveSafeIntegerSchema,
  timestampMs: FiniteNonnegativeNumberSchema
}).strict().superRefine((value, context) => {
  const expectedBytes = value.frameSamples * value.channels * 4;
  if (value.payloadByteLength !== expectedBytes) {
    context.addIssue({
      code: "custom",
      message: "PCM payload byte length does not match frame metadata",
      path: ["payloadByteLength"]
    });
  }
  const durationMs = value.frameSamples / value.sampleRate * 1_000;
  if (durationMs > MAX_SPEECH_FRAME_DURATION_MS) {
    context.addIssue({
      code: "custom",
      message: "PCM frame exceeds maximum duration",
      path: ["frameSamples"]
    });
  }
});
export type SpeechPcmFrameEnvelope = z.infer<typeof SpeechPcmFrameEnvelopeSchema>;

const SpeechControlBaseSchema = z.object({
  protocolVersion: SpeechProtocolVersionSchema,
  requestId: RequestIdSchema,
  streamId: SpeechStreamIdSchema
});

export const SpeechFlushRequestSchema = SpeechControlBaseSchema.extend({
  type: z.literal("FLUSH_SPEECH")
}).strict();

export const SpeechCancelRequestSchema = SpeechControlBaseSchema.extend({
  type: z.literal("CANCEL_SPEECH")
}).strict();

export const SpeechShutdownRequestSchema = z.object({
  protocolVersion: SpeechProtocolVersionSchema,
  requestId: RequestIdSchema,
  type: z.literal("SHUTDOWN_SPEECH_WORKER")
}).strict();

export const SpeechControlRequestSchema = z.discriminatedUnion("type", [
  SpeechFlushRequestSchema,
  SpeechCancelRequestSchema,
  SpeechShutdownRequestSchema
]);
export type SpeechControlRequest = z.infer<typeof SpeechControlRequestSchema>;

export const SpeechFinalizationReasonSchema = z.enum([
  "SILENCE",
  "MAX_DURATION",
  "FLUSH"
]);
export type SpeechFinalizationReason = z.infer<typeof SpeechFinalizationReasonSchema>;

export const SpeechDiscardReasonSchema = z.enum([
  "FALSE_START",
  "TOO_SHORT",
  "CANCELLED"
]);
export type SpeechDiscardReason = z.infer<typeof SpeechDiscardReasonSchema>;

export const SourceAudioBasisSchema = z.object({
  streamId: SpeechStreamIdSchema,
  firstSequence: NonnegativeSafeIntegerSchema,
  lastSequence: NonnegativeSafeIntegerSchema,
  startTimestampMs: FiniteNonnegativeNumberSchema,
  endTimestampMs: FiniteNonnegativeNumberSchema,
  sampleRate: SpeechSampleRateSchema,
  channels: SpeechChannelCountSchema,
  sampleCount: PositiveSafeIntegerSchema,
  pcmSha256: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict().superRefine((value, context) => {
  if (value.lastSequence < value.firstSequence) {
    context.addIssue({ code: "custom", message: "Audio basis sequence range is reversed", path: ["lastSequence"] });
  }
  if (value.endTimestampMs < value.startTimestampMs) {
    context.addIssue({ code: "custom", message: "Audio basis timestamp range is reversed", path: ["endTimestampMs"] });
  }
});
export type SourceAudioBasis = z.infer<typeof SourceAudioBasisSchema>;

export const TranscriptWordTimingSchema = z.object({
  word: z.string().min(1).max(128),
  startMs: FiniteNonnegativeNumberSchema,
  endMs: FiniteNonnegativeNumberSchema,
  confidence: z.number().min(0).max(1).optional()
}).strict().superRefine((value, context) => {
  if (value.endMs < value.startMs) {
    context.addIssue({ code: "custom", message: "Word timing end precedes start", path: ["endMs"] });
  }
});
export type TranscriptWordTiming = z.infer<typeof TranscriptWordTimingSchema>;

export const SpeechModelIdentitySchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(100)
}).strict();
export type SpeechModelIdentity = z.infer<typeof SpeechModelIdentitySchema>;

export const TranscriptCandidateSchema = z.object({
  requestId: RequestIdSchema,
  utteranceId: UtteranceIdSchema,
  text: z.string().max(MAX_SPEECH_TRANSCRIPT_CHARS),
  isFinal: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  words: z.array(TranscriptWordTimingSchema).max(MAX_SPEECH_WORD_TIMINGS).optional(),
  model: SpeechModelIdentitySchema,
  sourceAudioBasis: SourceAudioBasisSchema
}).strict();
export type TranscriptCandidate = z.infer<typeof TranscriptCandidateSchema>;

export const SpeechWorkerErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_FRAME",
  "REQUEST_ID_CONFLICT",
  "STREAM_CONFLICT",
  "OUT_OF_ORDER_FRAME",
  "RESOURCE_LIMIT",
  "STREAM_NOT_FOUND",
  "STREAM_FINALIZED",
  "RECOGNIZER_FAILURE",
  "RECOGNIZER_PROTOCOL_ERROR",
  "CANCELLED",
  "SHUTTING_DOWN",
  "INTERNAL_ERROR"
]);
export type SpeechWorkerErrorCode = z.infer<typeof SpeechWorkerErrorCodeSchema>;

const WorkerEventBaseSchema = z.object({
  protocolVersion: SpeechProtocolVersionSchema,
  requestId: RequestIdSchema,
  streamId: SpeechStreamIdSchema
});

export const SpeechStartedEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("SPEECH_STARTED"),
  utteranceId: UtteranceIdSchema,
  atTimestampMs: FiniteNonnegativeNumberSchema
}).strict();

export const SpeechPossibleEndpointEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("POSSIBLE_ENDPOINT"),
  utteranceId: UtteranceIdSchema,
  silenceMs: FiniteNonnegativeNumberSchema
}).strict();

export const SpeechUtteranceFinalizedEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("UTTERANCE_FINALIZED"),
  utteranceId: UtteranceIdSchema,
  finalizationReason: SpeechFinalizationReasonSchema,
  speechFrameCount: NonnegativeSafeIntegerSchema,
  durationMs: FiniteNonnegativeNumberSchema,
  sourceAudioBasis: SourceAudioBasisSchema
}).strict();

export const SpeechUtteranceDiscardedEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("UTTERANCE_DISCARDED"),
  utteranceId: UtteranceIdSchema.optional(),
  reason: SpeechDiscardReasonSchema
}).strict();

export const SpeechTranscriptEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("TRANSCRIPT_CANDIDATE"),
  candidate: TranscriptCandidateSchema
}).strict();

export const SpeechCancelledEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("SPEECH_CANCELLED"),
  cancellation: z.enum(["RUNTIME_ABORT_REQUESTED", "SUPPRESS_LATE_RESULT_ONLY", "NOT_RECOGNIZING"])
}).strict();

export const SpeechWorkerErrorEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("SPEECH_WORKER_ERROR"),
  code: SpeechWorkerErrorCodeSchema,
  message: z.string().min(1).max(160)
}).strict();

export const SpeechWorkerEventSchema = z.discriminatedUnion("type", [
  SpeechStartedEventSchema,
  SpeechPossibleEndpointEventSchema,
  SpeechUtteranceFinalizedEventSchema,
  SpeechUtteranceDiscardedEventSchema,
  SpeechTranscriptEventSchema,
  SpeechCancelledEventSchema,
  SpeechWorkerErrorEventSchema
]);
export type SpeechWorkerEvent = z.infer<typeof SpeechWorkerEventSchema>;

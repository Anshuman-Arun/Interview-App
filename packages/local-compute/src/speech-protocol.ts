import { z } from "zod";
import { RequestIdSchema, UtteranceIdSchema } from "../../domain/src/index.js";

export const SPEECH_PROTOCOL_VERSION = 1 as const;
export const MAX_SPEECH_FRAME_DURATION_MS = 100;
export const MAX_SPEECH_UTTERANCE_DURATION_MS = 60_000;
export const MAX_SPEECH_PRE_SPEECH_DURATION_MS = 10_000;
export const MAX_SPEECH_TIMESTAMP_DRIFT_MS = 250;
export const MAX_SPEECH_TIMESTAMP_MS = Number.MAX_SAFE_INTEGER - MAX_SPEECH_UTTERANCE_DURATION_MS;
export const MAX_SPEECH_BUFFERED_PCM_BYTES = 12 * 1024 * 1024;
export const MAX_SPEECH_CONCURRENT_STREAMS = 4;
export const MAX_SPEECH_IN_FLIGHT_REQUESTS = 64;
export const MAX_SPEECH_REMEMBERED_MESSAGES = 1_024;
export const MAX_SPEECH_REMEMBERED_RESULT_CHARS = 4 * 1024 * 1024;
export const MAX_SPEECH_TRANSCRIPT_CHARS = 20_000;
export const MAX_SPEECH_WORD_TIMINGS = 1_000;
export const MAX_SPEECH_TRANSCRIPT_RESULT_CACHE = 1_024;
export const MAX_SPEECH_DIAGNOSTICS = 32;
export const MAX_SPEECH_DIAGNOSTIC_CHARS = 256;
export const DEFAULT_SPEECH_VAD_TIMEOUT_MS = 2_000;
export const MAX_SPEECH_VAD_TIMEOUT_MS = 5_000;
export const DEFAULT_SPEECH_RECOGNIZER_TIMEOUT_MS = 30_000;
export const MAX_SPEECH_RECOGNIZER_TIMEOUT_MS = 60_000;
export const DEFAULT_SPEECH_CANCELLATION_TIMEOUT_MS = 500;
export const MAX_SPEECH_CANCELLATION_TIMEOUT_MS = 2_000;

export const SpeechProtocolVersionSchema = z.literal(SPEECH_PROTOCOL_VERSION);
const SpeechIdentityPattern = /^[A-Za-z0-9._:-]+$/u;
export const SpeechRequestIdSchema = RequestIdSchema.refine(
  (value) => value.length <= 128 && SpeechIdentityPattern.test(value),
  { message: "Speech request ID is invalid or exceeds maximum length" }
);
export const SpeechUtteranceIdSchema = UtteranceIdSchema.refine(
  (value) => value.length <= 128 && SpeechIdentityPattern.test(value),
  { message: "Speech utterance ID is invalid or exceeds maximum length" }
);
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
const SpeechTimestampMsSchema = z.number().nonnegative().max(MAX_SPEECH_TIMESTAMP_MS);

export const SpeechPcmFrameEnvelopeSchema = z.object({
  protocolVersion: SpeechProtocolVersionSchema,
  requestId: SpeechRequestIdSchema,
  streamId: SpeechStreamIdSchema,
  sequence: NonnegativeSafeIntegerSchema,
  sampleRate: SpeechSampleRateSchema,
  channels: SpeechChannelCountSchema,
  sampleFormat: SpeechSampleFormatSchema,
  frameSamples: PositiveSafeIntegerSchema,
  payloadByteLength: PositiveSafeIntegerSchema,
  timestampMs: SpeechTimestampMsSchema
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

export const SpeechFrameHeuristicsSchema = z.object({
  appearsIncomplete: z.boolean().optional()
}).strict();
export type SpeechFrameHeuristics = z.infer<typeof SpeechFrameHeuristicsSchema>;

const SpeechControlBaseSchema = z.object({
  protocolVersion: SpeechProtocolVersionSchema,
  requestId: SpeechRequestIdSchema,
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
  requestId: SpeechRequestIdSchema,
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
  "NO_SPEECH_TIMEOUT",
  "CANCELLED"
]);
export type SpeechDiscardReason = z.infer<typeof SpeechDiscardReasonSchema>;

export const SourceAudioBasisSchema = z.object({
  streamId: SpeechStreamIdSchema,
  firstSequence: NonnegativeSafeIntegerSchema,
  lastSequence: NonnegativeSafeIntegerSchema,
  startTimestampMs: SpeechTimestampMsSchema,
  endTimestampMs: SpeechTimestampMsSchema,
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
  const audioDurationMs = value.sampleCount / value.sampleRate * 1_000;
  if (audioDurationMs > MAX_SPEECH_UTTERANCE_DURATION_MS + 0.001) {
    context.addIssue({ code: "custom", message: "Audio basis exceeds maximum utterance duration", path: ["sampleCount"] });
  }
  const timestampSpanMs = value.endTimestampMs - value.startTimestampMs;
  if (timestampSpanMs + 0.001 < audioDurationMs) {
    context.addIssue({ code: "custom", message: "Audio basis timestamp span is shorter than its PCM duration", path: ["endTimestampMs"] });
  }
  if (timestampSpanMs > audioDurationMs + MAX_SPEECH_TIMESTAMP_DRIFT_MS + 0.001) {
    context.addIssue({ code: "custom", message: "Audio basis timestamp drift exceeds limit", path: ["endTimestampMs"] });
  }
  const frameCount = value.lastSequence - value.firstSequence + 1;
  const maxSamplesPerFrame = value.sampleRate * MAX_SPEECH_FRAME_DURATION_MS / 1_000;
  const minimumFrameCount = Math.ceil(value.sampleCount / maxSamplesPerFrame);
  if (frameCount < minimumFrameCount || frameCount > value.sampleCount) {
    context.addIssue({ code: "custom", message: "Audio basis sequence span is inconsistent with its sample count", path: ["lastSequence"] });
  }
});
export type SourceAudioBasis = z.infer<typeof SourceAudioBasisSchema>;

const safeBoundedMetadataTextSchema = (maxLength: number, label: string) => z.string()
  .min(1)
  .max(maxLength)
  .refine((value) => value.trim().length > 0, { message: `${label} must not be blank` })
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), { message: `${label} contains unsafe control/format characters` });

const safeRecognizerWordSchema = (maxLength: number) =>
  safeBoundedMetadataTextSchema(maxLength, "Recognizer word metadata");
const safeModelIdentityTextSchema = (maxLength: number) =>
  safeBoundedMetadataTextSchema(maxLength, "Model identity");

export const TranscriptWordTimingSchema = z.object({
  word: safeRecognizerWordSchema(128),
  startMs: z.number().nonnegative().max(MAX_SPEECH_UTTERANCE_DURATION_MS),
  endMs: z.number().nonnegative().max(MAX_SPEECH_UTTERANCE_DURATION_MS),
  confidence: z.number().min(0).max(1).optional()
}).strict().superRefine((value, context) => {
  if (value.endMs < value.startMs) {
    context.addIssue({ code: "custom", message: "Word timing end precedes start", path: ["endMs"] });
  }
});
export type TranscriptWordTiming = z.infer<typeof TranscriptWordTimingSchema>;

export const SpeechModelIdentitySchema = z.object({
  name: safeModelIdentityTextSchema(100),
  version: safeModelIdentityTextSchema(100)
}).strict();
export type SpeechModelIdentity = z.infer<typeof SpeechModelIdentitySchema>;

export const TranscriptCandidateSchema = z.object({
  requestId: SpeechRequestIdSchema,
  utteranceId: SpeechUtteranceIdSchema,
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
  "VAD_FAILURE",
  "VAD_PROTOCOL_ERROR",
  "VAD_TIMEOUT",
  "RECOGNIZER_FAILURE",
  "RECOGNIZER_PROTOCOL_ERROR",
  "RECOGNIZER_TIMEOUT",
  "CANCELLED",
  "SHUTTING_DOWN",
  "INTERNAL_ERROR"
]);
export type SpeechWorkerErrorCode = z.infer<typeof SpeechWorkerErrorCodeSchema>;

const WorkerEventBaseSchema = z.object({
  protocolVersion: SpeechProtocolVersionSchema,
  requestId: SpeechRequestIdSchema,
  streamId: SpeechStreamIdSchema
});

export const SpeechStartedEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("SPEECH_STARTED"),
  utteranceId: SpeechUtteranceIdSchema,
  atTimestampMs: SpeechTimestampMsSchema
}).strict();

export const SpeechPossibleEndpointEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("POSSIBLE_ENDPOINT"),
  utteranceId: SpeechUtteranceIdSchema,
  silenceMs: z.number().nonnegative().max(MAX_SPEECH_UTTERANCE_DURATION_MS)
}).strict();

export const SpeechUtteranceFinalizedEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("UTTERANCE_FINALIZED"),
  utteranceId: SpeechUtteranceIdSchema,
  finalizationReason: SpeechFinalizationReasonSchema,
  speechFrameCount: NonnegativeSafeIntegerSchema,
  durationMs: z.number().nonnegative().max(MAX_SPEECH_UTTERANCE_DURATION_MS),
  sourceAudioBasis: SourceAudioBasisSchema
}).strict().superRefine((value, context) => {
  if (value.sourceAudioBasis.streamId !== value.streamId) {
    context.addIssue({ code: "custom", message: "Finalized event stream does not match audio basis", path: ["sourceAudioBasis", "streamId"] });
  }
  const audioDurationMs = value.sourceAudioBasis.sampleCount / value.sourceAudioBasis.sampleRate * 1_000;
  if (Math.abs(value.durationMs - audioDurationMs) > 0.001) {
    context.addIssue({ code: "custom", message: "Finalized event duration does not match audio basis", path: ["durationMs"] });
  }
  const frameCount = value.sourceAudioBasis.lastSequence - value.sourceAudioBasis.firstSequence + 1;
  if (value.speechFrameCount > frameCount) {
    context.addIssue({ code: "custom", message: "Speech frame count exceeds finalized audio frame count", path: ["speechFrameCount"] });
  }
});

export const SpeechUtteranceDiscardedEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("UTTERANCE_DISCARDED"),
  utteranceId: SpeechUtteranceIdSchema.optional(),
  reason: SpeechDiscardReasonSchema
}).strict();

export const SpeechTranscriptEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("TRANSCRIPT_CANDIDATE"),
  candidate: TranscriptCandidateSchema
}).strict().superRefine((value, context) => {
  if (value.candidate.requestId !== value.requestId) {
    context.addIssue({ code: "custom", message: "Transcript event request does not match candidate", path: ["candidate", "requestId"] });
  }
  if (value.candidate.sourceAudioBasis.streamId !== value.streamId) {
    context.addIssue({ code: "custom", message: "Transcript event stream does not match candidate audio basis", path: ["candidate", "sourceAudioBasis", "streamId"] });
  }
});

export const SpeechCancelledEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("SPEECH_CANCELLED"),
  cancellation: z.enum(["RUNTIME_ABORT_REQUESTED", "SUPPRESS_LATE_RESULT_ONLY", "NOT_RECOGNIZING"])
}).strict();

export const SpeechWorkerErrorEventSchema = WorkerEventBaseSchema.extend({
  type: z.literal("SPEECH_WORKER_ERROR"),
  code: SpeechWorkerErrorCodeSchema,
  message: safeBoundedMetadataTextSchema(160, "Speech worker error message")
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

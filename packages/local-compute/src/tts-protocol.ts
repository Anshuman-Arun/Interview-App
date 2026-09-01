import { createHash } from "node:crypto";
import { z } from "zod";
import { RequestIdSchema } from "../../domain/src/index.js";

export const TTS_PROTOCOL_VERSION = 1 as const;

export const TTS_LIMITS = Object.freeze({
  maxTextCharacters: 12_000,
  maxTextUtf8Bytes: 48_000,
  maxRequestIdCharacters: 128,
  maxVoiceCharacters: 64,
  maxSupportedVoices: 256,
  maxSupportedLanguages: 8,
  maxSupportedSampleRates: 4,
  maxModelPathCharacters: 4_096,
  maxSegmentCharacters: 600,
  maxSegmentDurationMs: 20_000,
  maxSegments: 64,
  maxEstimatedDurationMs: 120_000,
  maxOutputDurationMs: 120_000,
  maxPcmBytes: 12 * 1024 * 1024,
  maxAbsolutePcmSample: 1,
  maxChunkFrames: 4_096,
  maxChunks: 4_096,
  maxConcurrentRequests: 2,
  maxRuntimeCancellationWaitMs: 250,
  maxRememberedRequests: 1_024,
  maxDiagnostics: 64
});

export const TtsLanguageSchema = z.enum(["en-US", "en-GB"]);
export type TtsLanguage = z.infer<typeof TtsLanguageSchema>;

export const TtsSampleRateSchema = z.union([
  z.literal(22_050),
  z.literal(24_000),
  z.literal(44_100),
  z.literal(48_000)
]);
export type TtsSampleRate = z.infer<typeof TtsSampleRateSchema>;

export const TtsOutputFormatSchema = z.literal("PCM_F32LE");
export type TtsOutputFormat = z.infer<typeof TtsOutputFormatSchema>;

export const TtsRequestIdSchema = RequestIdSchema.refine(
  (value) => value.length <= TTS_LIMITS.maxRequestIdCharacters
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value),
  { message: "TTS requestId is malformed or exceeds its limit" }
);

export const TtsVoiceSchema = z.string().superRefine((value, context) => {
  if (value.length === 0) {
    context.addIssue({ code: "custom", message: "TTS voice must not be empty" });
    return;
  }
  if (value.length > TTS_LIMITS.maxVoiceCharacters) {
    context.addIssue({ code: "custom", message: "TTS voice exceeds the metadata limit" });
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    context.addIssue({ code: "custom", message: "TTS voice is malformed" });
  }
});

function hasForbiddenControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x08
        || code === 0x0b
        || code === 0x0c
        || (code >= 0x0e && code <= 0x1f)
        || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function hasForbiddenUnicodeScalar(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const isNoncharacter = (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
      || (codePoint & 0xffff) === 0xfffe
      || (codePoint & 0xffff) === 0xffff;
    const isBidiControl = codePoint === 0x061c
      || codePoint === 0x200e
      || codePoint === 0x200f
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
      || codePoint === 0xfeff;
    if (isNoncharacter || isBidiControl) return true;
  }
  return false;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

const TtsTextSchema = z.string()
  .min(1)
  .max(TTS_LIMITS.maxTextCharacters)
  .superRefine((value, context) => {
    if (value.length > TTS_LIMITS.maxTextCharacters) return;
    if (value.trim().length === 0) {
      context.addIssue({ code: "custom", message: "TTS text must contain non-whitespace content" });
    }
    if (hasForbiddenControlCharacter(value)) {
      context.addIssue({ code: "custom", message: "TTS text contains unsupported control characters" });
    }
    if (hasLoneSurrogate(value)) {
      context.addIssue({ code: "custom", message: "TTS text contains malformed Unicode" });
    }
    if (hasForbiddenUnicodeScalar(value)) {
      context.addIssue({ code: "custom", message: "TTS text contains unsupported Unicode control/noncharacter code points" });
    }
    if (Buffer.byteLength(value, "utf8") > TTS_LIMITS.maxTextUtf8Bytes) {
      context.addIssue({ code: "custom", message: "TTS text exceeds the UTF-8 byte limit" });
    }
  });

export const TtsSynthesizeRequestSchema = z.object({
  protocolVersion: z.literal(TTS_PROTOCOL_VERSION),
  type: z.literal("SYNTHESIZE"),
  requestId: TtsRequestIdSchema,
  text: TtsTextSchema,
  voice: TtsVoiceSchema,
  speed: z.number()
    .refine(Number.isFinite, { message: "TTS speed must be finite" })
    .min(0.5)
    .max(2),
  language: TtsLanguageSchema,
  sampleRate: TtsSampleRateSchema,
  outputFormat: TtsOutputFormatSchema
}).strict();
export type TtsSynthesizeRequest = z.infer<typeof TtsSynthesizeRequestSchema>;

export const TtsCancelRequestSchema = z.object({
  protocolVersion: z.literal(TTS_PROTOCOL_VERSION),
  type: z.literal("CANCEL_SYNTHESIS"),
  requestId: TtsRequestIdSchema
}).strict();
export type TtsCancelRequest = z.infer<typeof TtsCancelRequestSchema>;

export const TtsIncomingMessageSchema = z.discriminatedUnion("type", [
  TtsSynthesizeRequestSchema,
  TtsCancelRequestSchema
]);
export type TtsIncomingMessage = z.infer<typeof TtsIncomingMessageSchema>;

const HashSchema = z.string().superRefine((value, context) => {
  if (value.length !== 64) {
    context.addIssue({ code: "custom", message: "Hash must contain exactly 64 hexadecimal characters" });
    return;
  }
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    context.addIssue({ code: "custom", message: "Hash must be lowercase hexadecimal" });
  }
});
const SafeIdentityTextSchema = z.string().superRefine((value, context) => {
  if (value.length === 0) {
    context.addIssue({ code: "custom", message: "Model identity metadata must not be empty" });
    return;
  }
  if (value.length > 80) {
    context.addIssue({ code: "custom", message: "Model identity metadata exceeds its limit" });
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+:-]*$/u.test(value)) {
    context.addIssue({ code: "custom", message: "Model identity metadata is malformed" });
    return;
  }
  if (value.startsWith("/")
      || /^[A-Za-z]:\//u.test(value)
      || /^[A-Za-z][A-Za-z0-9+.-]*:\//u.test(value)
      || value.includes("//")
      || value.includes("../")
      || value.includes("/..")) {
    context.addIssue({
      code: "custom",
      message: "Model identity must not contain an absolute/path-traversal form"
    });
  }
});

export const TtsModelIdentitySchema = z.object({
  engine: SafeIdentityTextSchema,
  modelId: SafeIdentityTextSchema,
  modelVersion: SafeIdentityTextSchema,
  runtimeVersion: SafeIdentityTextSchema,
  waveformDeterminism: z.enum(["BYTE_STABLE", "NOT_GUARANTEED"])
}).strict();
export type TtsModelIdentity = z.infer<typeof TtsModelIdentitySchema>;

export const TtsAudioBeginSchema = z.object({
  protocolVersion: z.literal(TTS_PROTOCOL_VERSION),
  type: z.literal("AUDIO_BEGIN"),
  requestId: TtsRequestIdSchema,
  requestBasisHash: HashSchema,
  normalizedTextHash: HashSchema,
  sequence: z.literal(0),
  segmentCount: z.number().int().positive().max(TTS_LIMITS.maxSegments),
  sampleRate: TtsSampleRateSchema,
  channels: z.literal(1),
  sampleFormat: z.literal("F32LE"),
  model: TtsModelIdentitySchema
}).strict();
export type TtsAudioBegin = z.infer<typeof TtsAudioBeginSchema>;

const MAX_CHUNK_BASE64_CHARACTERS = Math.ceil(
  (TTS_LIMITS.maxChunkFrames * Float32Array.BYTES_PER_ELEMENT) / 3
) * 4 + 8;

const Base64Schema = z.string().superRefine((value, context) => {
  if (value.length > MAX_CHUNK_BASE64_CHARACTERS) {
    context.addIssue({ code: "custom", message: "PCM base64 payload exceeds the chunk limit" });
    return;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    context.addIssue({ code: "custom", message: "PCM base64 payload is malformed" });
  }
});

export interface TtsChunkBasisFields {
  readonly requestBasisHash: string;
  readonly sequence: number;
  readonly segmentIndex: number;
  readonly segmentHash: string;
  readonly chunkIndex: number;
  readonly finalInSegment: boolean;
  readonly sampleRate: TtsSampleRate;
  readonly frameCount: number;
  readonly byteLength: number;
  readonly pcmHash: string;
}

export function computeTtsChunkBasisHash(fields: TtsChunkBasisFields): string {
  return createHash("sha256").update(JSON.stringify({
    protocolVersion: TTS_PROTOCOL_VERSION,
    requestBasisHash: fields.requestBasisHash,
    sequence: fields.sequence,
    segmentIndex: fields.segmentIndex,
    segmentHash: fields.segmentHash,
    chunkIndex: fields.chunkIndex,
    finalInSegment: fields.finalInSegment,
    sampleRate: fields.sampleRate,
    channels: 1,
    sampleFormat: "F32LE",
    frameCount: fields.frameCount,
    byteLength: fields.byteLength,
    pcmHash: fields.pcmHash
  })).digest("hex");
}

export const TtsAudioChunkSchema = z.object({
  protocolVersion: z.literal(TTS_PROTOCOL_VERSION),
  type: z.literal("AUDIO_CHUNK"),
  requestId: TtsRequestIdSchema,
  requestBasisHash: HashSchema,
  sequence: z.number().int().positive().max(TTS_LIMITS.maxChunks),
  segmentIndex: z.number().int().nonnegative().max(TTS_LIMITS.maxSegments - 1),
  segmentHash: HashSchema,
  pcmHash: HashSchema,
  chunkBasisHash: HashSchema,
  chunkIndex: z.number().int().nonnegative().max(TTS_LIMITS.maxChunks - 1),
  finalInSegment: z.boolean(),
  sampleRate: TtsSampleRateSchema,
  channels: z.literal(1),
  sampleFormat: z.literal("F32LE"),
  frameCount: z.number().int().positive().max(TTS_LIMITS.maxChunkFrames),
  byteLength: z.number().int().positive().max(TTS_LIMITS.maxChunkFrames * 4),
  audioBase64: Base64Schema
}).strict().superRefine((value, context) => {
  if (value.audioBase64.length > MAX_CHUNK_BASE64_CHARACTERS
      || value.requestBasisHash.length !== 64
      || value.segmentHash.length !== 64
      || value.pcmHash.length !== 64
      || value.chunkBasisHash.length !== 64) {
    return;
  }
  if (value.sequence !== value.chunkIndex + 1) {
    context.addIssue({
      code: "custom",
      path: ["sequence"],
      message: "Chunk sequence must equal chunkIndex + 1"
    });
  }
  if (value.byteLength !== value.frameCount * 4) {
    context.addIssue({ code: "custom", path: ["byteLength"], message: "PCM byte length does not match frame count" });
    return;
  }
  const decoded = Buffer.from(value.audioBase64, "base64");
  if (decoded.byteLength !== value.byteLength || decoded.toString("base64") !== value.audioBase64) {
    context.addIssue({ code: "custom", path: ["audioBase64"], message: "PCM base64 payload is not canonical" });
    return;
  }
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  for (let byteOffset = 0; byteOffset < decoded.byteLength; byteOffset += Float32Array.BYTES_PER_ELEMENT) {
    const sample = view.getFloat32(byteOffset, true);
    if (!Number.isFinite(sample) || Math.abs(sample) > TTS_LIMITS.maxAbsolutePcmSample) {
      context.addIssue({
        code: "custom",
        path: ["audioBase64"],
        message: "PCM base64 payload contains an invalid float32 sample"
      });
      return;
    }
  }
  const computedPcmHash = createHash("sha256").update(decoded).digest("hex");
  if (value.pcmHash !== computedPcmHash) {
    context.addIssue({ code: "custom", path: ["pcmHash"], message: "PCM hash does not match audio bytes" });
  }
  const computedBasisHash = computeTtsChunkBasisHash({
    requestBasisHash: value.requestBasisHash,
    sequence: value.sequence,
    segmentIndex: value.segmentIndex,
    segmentHash: value.segmentHash,
    chunkIndex: value.chunkIndex,
    finalInSegment: value.finalInSegment,
    sampleRate: value.sampleRate,
    frameCount: value.frameCount,
    byteLength: value.byteLength,
    pcmHash: computedPcmHash
  });
  if (value.chunkBasisHash !== computedBasisHash) {
    context.addIssue({ code: "custom", path: ["chunkBasisHash"], message: "Chunk basis hash does not match chunk metadata" });
  }
});
export type TtsAudioChunk = z.infer<typeof TtsAudioChunkSchema>;

export const TtsAudioEndSchema = z.object({
  protocolVersion: z.literal(TTS_PROTOCOL_VERSION),
  type: z.literal("AUDIO_END"),
  requestId: TtsRequestIdSchema,
  requestBasisHash: HashSchema,
  sequence: z.number().int().positive().max(TTS_LIMITS.maxChunks + 1),
  segmentsSynthesized: z.number().int().positive().max(TTS_LIMITS.maxSegments),
  totalFrames: z.number().int().positive().max(Math.floor(TTS_LIMITS.maxPcmBytes / 4)),
  totalBytes: z.number().int().positive().max(TTS_LIMITS.maxPcmBytes),
  audioHash: HashSchema,
  durationMs: z.number().positive().max(TTS_LIMITS.maxOutputDurationMs),
  sampleRate: TtsSampleRateSchema,
  channels: z.literal(1),
  sampleFormat: z.literal("F32LE"),
  model: TtsModelIdentitySchema
}).strict().superRefine((value, context) => {
  if (value.totalBytes !== value.totalFrames * 4) {
    context.addIssue({ code: "custom", path: ["totalBytes"], message: "PCM total bytes do not match total frames" });
  }
  const expectedDurationMs = (value.totalFrames / value.sampleRate) * 1_000;
  if (Math.abs(expectedDurationMs - value.durationMs) > 1) {
    context.addIssue({ code: "custom", path: ["durationMs"], message: "PCM duration does not match total frames" });
  }
});
export type TtsAudioEnd = z.infer<typeof TtsAudioEndSchema>;

export const TtsStreamMessageSchema = z.discriminatedUnion("type", [
  TtsAudioBeginSchema,
  TtsAudioChunkSchema,
  TtsAudioEndSchema
]);
export type TtsStreamMessage = z.infer<typeof TtsStreamMessageSchema>;

export const TtsErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "UNSUPPORTED_VOICE",
  "UNSUPPORTED_LANGUAGE",
  "UNSUPPORTED_SAMPLE_RATE",
  "MODEL_UNAVAILABLE",
  "SYNTHESIS_FAILED",
  "OUTPUT_INVALID",
  "RESOURCE_LIMIT",
  "CANCELLED",
  "REQUEST_ID_CONFLICT",
  "SHUTDOWN",
  "INTERNAL_ERROR"
]);
export type TtsErrorCode = z.infer<typeof TtsErrorCodeSchema>;

export const TtsCancellationResultSchema = z.object({
  protocolVersion: z.literal(TTS_PROTOCOL_VERSION),
  type: z.literal("CANCEL_RESULT"),
  requestId: TtsRequestIdSchema,
  accepted: z.boolean(),
  runtimeCancellation: z.enum(["NOT_NEEDED", "REQUESTED", "UNSUPPORTED"])
}).strict().superRefine((value, context) => {
  if (!value.accepted && value.runtimeCancellation !== "NOT_NEEDED") {
    context.addIssue({
      code: "custom",
      path: ["runtimeCancellation"],
      message: "A rejected cancellation cannot claim a runtime cancellation attempt"
    });
  }
});
export type TtsCancellationResult = z.infer<typeof TtsCancellationResultSchema>;

export const TtsWorkerErrorResultSchema = z.object({
  protocolVersion: z.literal(TTS_PROTOCOL_VERSION),
  type: z.literal("TTS_ERROR"),
  requestId: TtsRequestIdSchema,
  code: TtsErrorCodeSchema,
  message: z.string().min(1).max(120)
}).strict();
export type TtsWorkerErrorResult = z.infer<typeof TtsWorkerErrorResultSchema>;

export const TtsOutgoingMessageSchema = z.discriminatedUnion("type", [
  TtsAudioBeginSchema,
  TtsAudioChunkSchema,
  TtsAudioEndSchema,
  TtsCancellationResultSchema,
  TtsWorkerErrorResultSchema
]);
export type TtsOutgoingMessage = z.infer<typeof TtsOutgoingMessageSchema>;

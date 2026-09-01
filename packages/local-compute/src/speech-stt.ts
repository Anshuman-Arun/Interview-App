import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MAX_SPEECH_TRANSCRIPT_CHARS,
  MAX_SPEECH_TRANSCRIPT_RESULT_CACHE,
  MAX_SPEECH_UTTERANCE_DURATION_MS,
  MAX_SPEECH_WORD_TIMINGS,
  SourceAudioBasisSchema,
  SpeechModelIdentitySchema,
  SpeechRequestIdSchema,
  SpeechUtteranceIdSchema,
  TranscriptCandidateSchema,
  TranscriptWordTimingSchema,
  type SourceAudioBasis,
  type SpeechModelIdentity,
  type TranscriptCandidate,
  type TranscriptWordTiming
} from "./speech-protocol.js";
import type { RequestId, UtteranceId } from "../../domain/src/index.js";

export class SpeechRecognizerProtocolError extends Error {}

export interface RecognizerAudioInput {
  readonly requestId: RequestId;
  readonly utteranceId: UtteranceId;
  readonly pcmBytes: Uint8Array;
  readonly sourceAudioBasis: SourceAudioBasis;
}

export const RecognizerCancellationCapabilitySchema = z.enum(["NONE", "RUNTIME_ABORT"]);
export type RecognizerCancellationCapability = z.infer<typeof RecognizerCancellationCapabilitySchema>;

export interface SpeechRecognizer {
  readonly modelIdentity: SpeechModelIdentity;
  readonly cancellationCapability: RecognizerCancellationCapability;
  recognize(input: RecognizerAudioInput, signal: AbortSignal): Promise<unknown>;
  cancel?(requestId: RequestId): Promise<unknown>;
}

export class DeterministicFakeRecognizer implements SpeechRecognizer {
  public readonly modelIdentity = Object.freeze({ name: "deterministic-fake", version: "1" } as const);
  public readonly cancellationCapability: RecognizerCancellationCapability = "RUNTIME_ABORT";
  private readonly cancelled = new Set<RequestId>();
  private readonly maxCancelledIds = 1_024;

  private readonly responseFactory: (input: RecognizerAudioInput) => unknown;

  public constructor(
    responseFactory: (input: RecognizerAudioInput) => unknown = (input) => ({
      requestId: input.requestId,
      utteranceId: input.utteranceId,
      text: "deterministic transcript",
      isFinal: true,
      model: { name: "deterministic-fake", version: "1" },
      sourceAudioBasis: input.sourceAudioBasis
    })
  ) {
    if (typeof responseFactory !== "function") throw new Error("Fake recognizer response factory must be a function");
    this.responseFactory = responseFactory;
  }

  public async recognize(input: RecognizerAudioInput, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted || this.cancelled.has(input.requestId)) throw abortError();
    const response = this.responseFactory(input);
    this.cancelled.delete(input.requestId);
    return response;
  }

  public async cancel(requestId: RequestId): Promise<boolean> {
    const boundedRequestId = SpeechRequestIdSchema.parse(requestId);
    this.cancelled.add(boundedRequestId);
    while (this.cancelled.size > this.maxCancelledIds) {
      const oldest = this.cancelled.values().next().value;
      if (oldest === undefined) break;
      this.cancelled.delete(oldest);
    }
    return true;
  }
}

export interface MoonshineRuntimeResult {
  readonly text: string;
  readonly confidence?: number;
  readonly words?: readonly TranscriptWordTiming[];
}

export interface MoonshineRuntime {
  readonly runtimeVersion: string;
  readonly supportsAbort: boolean;
  transcribe(input: {
    readonly requestId: RequestId;
    readonly utteranceId: UtteranceId;
    readonly pcmBytes: Uint8Array;
    readonly sampleRate: number;
    readonly modelPath: string;
    readonly configPath?: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  cancel?(requestId: RequestId): Promise<unknown>;
}

export interface MoonshineRecognizerOptions {
  readonly runtime: MoonshineRuntime;
  readonly modelPath: string;
  readonly configPath?: string;
  readonly modelName?: string;
  readonly modelVersion: string;
}

export class MoonshineSpeechRecognizer implements SpeechRecognizer {
  public readonly modelIdentity: SpeechModelIdentity;
  public readonly cancellationCapability: RecognizerCancellationCapability;
  private readonly modelPath: string;
  private readonly configPath: string | undefined;
  private readonly supportsAbort: boolean;
  private readonly transcribeRuntime: MoonshineRuntime["transcribe"];
  private readonly cancelRuntime: MoonshineRuntime["cancel"];

  public constructor(options: MoonshineRecognizerOptions) {
    const rawOptions: unknown = options;
    if (!isRecord(rawOptions)) throw new Error("Moonshine recognizer options must be an object");
    const rawRuntime = rawOptions.runtime;
    if (!isRecord(rawRuntime)) throw new Error("Moonshine runtime must be an object");

    this.modelPath = validateLocalPath(rawOptions.modelPath, "Moonshine model path");
    this.configPath = rawOptions.configPath === undefined
      ? undefined
      : validateLocalPath(rawOptions.configPath, "Moonshine config path");
    validateRuntimeIdentity(rawRuntime.runtimeVersion, "Moonshine runtime version");
    this.supportsAbort = validateBoolean(rawRuntime.supportsAbort, "Moonshine runtime abort capability");
    this.transcribeRuntime = bindMoonshineTranscribe(rawRuntime.transcribe, rawRuntime);
    this.cancelRuntime = bindMoonshineCancel(rawRuntime.cancel, rawRuntime);

    const modelName = rawOptions.modelName;
    if (modelName !== undefined && typeof modelName !== "string") {
      throw new Error("Moonshine model name must be a string when provided");
    }
    if (typeof rawOptions.modelVersion !== "string") {
      throw new Error("Moonshine model version must be a string");
    }
    const name = modelName?.trim() || "moonshine";
    this.modelIdentity = Object.freeze(SpeechModelIdentitySchema.parse({
      name,
      version: rawOptions.modelVersion.trim()
    }));
    this.cancellationCapability = this.supportsAbort ? "RUNTIME_ABORT" : "NONE";
  }

  public async recognize(input: RecognizerAudioInput, signal: AbortSignal): Promise<unknown> {
    const rawInput: unknown = input;
    if (!isRecord(rawInput)) throw new Error("Moonshine recognition input must be an object");
    preflightBoundedString(rawInput.requestId, 128, "Moonshine request ID");
    preflightBoundedString(rawInput.utteranceId, 128, "Moonshine utterance ID");
    preflightSourceAudioBasis(rawInput.sourceAudioBasis, "Moonshine source audio basis");
    const requestId = SpeechRequestIdSchema.parse(rawInput.requestId);
    const utteranceId = SpeechUtteranceIdSchema.parse(rawInput.utteranceId);
    const sourceAudioBasis = SourceAudioBasisSchema.parse(rawInput.sourceAudioBasis);
    if (!(rawInput.pcmBytes instanceof Uint8Array)) {
      throw new Error("Moonshine PCM input must be a Uint8Array");
    }
    if (isSharedBackingBuffer(rawInput.pcmBytes.buffer)) {
      throw new Error("Moonshine PCM input must not use shared mutable backing storage");
    }
    const expectedBytes = sourceAudioBasis.sampleCount * sourceAudioBasis.channels * 4;
    if (rawInput.pcmBytes.byteLength !== expectedBytes) {
      throw new Error("Moonshine PCM length does not match its source audio basis");
    }
    const runtimePcmBytes = new Uint8Array(rawInput.pcmBytes);
    if (sha256(runtimePcmBytes) !== sourceAudioBasis.pcmSha256) {
      throw new Error("Moonshine PCM bytes do not match the source audio basis");
    }
    const durationMs = sourceAudioBasis.sampleCount / sourceAudioBasis.sampleRate * 1_000;
    if (durationMs > MAX_SPEECH_UTTERANCE_DURATION_MS + 0.001) {
      throw new Error("Moonshine input exceeds maximum utterance duration");
    }
    const rawRuntimeResult = await this.transcribeRuntime({
      requestId,
      utteranceId,
      pcmBytes: runtimePcmBytes,
      sampleRate: sourceAudioBasis.sampleRate,
      modelPath: this.modelPath,
      ...(this.configPath === undefined ? {} : { configPath: this.configPath }),
      ...(this.supportsAbort ? { signal } : {})
    });
    let runtimeResult: z.infer<typeof MoonshineRuntimeResultSchema>;
    try {
      runtimeResult = parseMoonshineRuntimeResult(rawRuntimeResult);
    } catch {
      throw new SpeechRecognizerProtocolError("Moonshine runtime returned invalid bounded output");
    }
    if (sha256(runtimePcmBytes) !== sourceAudioBasis.pcmSha256) {
      throw new SpeechRecognizerProtocolError("Moonshine runtime mutated PCM input");
    }
    try {
      return validateTranscriptCandidate({
      requestId,
      utteranceId,
      text: runtimeResult.text,
      isFinal: true,
      ...(runtimeResult.confidence === undefined ? {} : { confidence: runtimeResult.confidence }),
      ...(runtimeResult.words === undefined ? {} : { words: runtimeResult.words }),
      model: this.modelIdentity,
      sourceAudioBasis
      }, {
        requestId,
        utteranceId,
        sourceAudioBasis,
        modelIdentity: this.modelIdentity
      });
    } catch (error) {
      if (error instanceof SpeechRecognizerProtocolError) throw error;
      throw new SpeechRecognizerProtocolError("Moonshine runtime candidate failed bounded validation");
    }
  }

  public async cancel(requestId: RequestId): Promise<boolean> {
    if (!this.supportsAbort || this.cancelRuntime === undefined) return false;
    preflightBoundedString(requestId, 128, "Moonshine cancellation request ID");
    const boundedRequestId = SpeechRequestIdSchema.parse(requestId);
    return (await this.cancelRuntime(boundedRequestId)) === true;
  }
}

const MoonshineRuntimeResultSchema = z.object({
  text: z.string().max(MAX_SPEECH_TRANSCRIPT_CHARS),
  confidence: z.number().min(0).max(1).optional(),
  words: z.array(TranscriptWordTimingSchema).max(MAX_SPEECH_WORD_TIMINGS).optional()
}).strict();

function parseMoonshineRuntimeResult(raw: unknown): z.infer<typeof MoonshineRuntimeResultSchema> {
  if (!isRecord(raw)) throw new Error("Moonshine runtime result must be an object");
  assertAllowedOwnEnumerableKeys(raw, MOONSHINE_RESULT_KEYS, "Moonshine runtime result");
  if (typeof raw.text !== "string") throw new Error("Moonshine runtime transcript must be text");
  if (raw.text.length > MAX_SPEECH_TRANSCRIPT_CHARS) {
    throw new Error("Moonshine runtime transcript exceeds maximum length");
  }
  preflightWordTimings(raw.words, "Moonshine runtime word timings");
  return MoonshineRuntimeResultSchema.parse({
    text: raw.text,
    ...(raw.confidence === undefined ? {} : { confidence: raw.confidence }),
    ...(raw.words === undefined ? {} : { words: raw.words })
  });
}

export interface TranscriptValidationBasis {
  readonly requestId: RequestId;
  readonly utteranceId: UtteranceId;
  readonly sourceAudioBasis: SourceAudioBasis;
  readonly modelIdentity?: SpeechModelIdentity;
}

export function validateTranscriptCandidate(raw: unknown, expected: TranscriptValidationBasis): TranscriptCandidate {
  preflightBoundedString(expected.requestId, 128, "Expected recognizer request ID");
  preflightBoundedString(expected.utteranceId, 128, "Expected recognizer utterance ID");
  preflightSourceAudioBasis(expected.sourceAudioBasis, "Expected recognizer source audio basis");
  if (expected.modelIdentity !== undefined) {
    preflightModelIdentity(expected.modelIdentity, "Expected recognizer model identity");
  }
  const expectedRequestId = SpeechRequestIdSchema.parse(expected.requestId);
  const expectedUtteranceId = SpeechUtteranceIdSchema.parse(expected.utteranceId);
  const expectedSourceAudioBasis = SourceAudioBasisSchema.parse(expected.sourceAudioBasis);
  const expectedModelIdentity = expected.modelIdentity === undefined
    ? undefined
    : SpeechModelIdentitySchema.parse(expected.modelIdentity);
  if (!isRecord(raw)) throw new Error("Recognizer result must be an object");
  assertAllowedOwnEnumerableKeys(raw, TRANSCRIPT_CANDIDATE_KEYS, "Recognizer result");
  preflightBoundedString(raw.requestId, 128, "Recognizer request ID");
  preflightBoundedString(raw.utteranceId, 128, "Recognizer utterance ID");
  preflightWordTimings(raw.words, "Recognizer word timing metadata");
  preflightModelIdentity(raw.model, "Recognizer model identity");
  preflightSourceAudioBasis(raw.sourceAudioBasis, "Recognizer source audio basis");
  const normalizedText = normalizeTranscriptText(raw.text);
  const candidate = TranscriptCandidateSchema.parse({
    requestId: raw.requestId,
    utteranceId: raw.utteranceId,
    text: normalizedText,
    isFinal: raw.isFinal,
    ...(raw.confidence === undefined ? {} : { confidence: raw.confidence }),
    ...(raw.words === undefined ? {} : { words: raw.words }),
    model: raw.model,
    sourceAudioBasis: raw.sourceAudioBasis
  });
  if (candidate.requestId !== expectedRequestId) throw new Error("Recognizer result requestId does not match request");
  if (candidate.utteranceId !== expectedUtteranceId) throw new Error("Recognizer result utteranceId does not match utterance");
  if (!sameAudioBasis(candidate.sourceAudioBasis, expectedSourceAudioBasis)) {
    throw new Error("Recognizer result source audio basis does not match request");
  }
  if (expectedModelIdentity !== undefined
      && (candidate.model.name !== expectedModelIdentity.name
        || candidate.model.version !== expectedModelIdentity.version)) {
    throw new Error("Recognizer result model identity does not match configured recognizer");
  }

  const utteranceDurationMs = expectedSourceAudioBasis.sampleCount / expectedSourceAudioBasis.sampleRate * 1_000;
  let previousEnd = 0;
  for (const word of candidate.words ?? []) {
    if (word.endMs > utteranceDurationMs + 1) throw new Error("Recognizer word timing exceeds utterance duration");
    if (word.startMs + 0.001 < previousEnd) throw new Error("Recognizer word timings overlap or reverse");
    previousEnd = word.endMs;
  }
  return candidate;
}

export function normalizeTranscriptText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Recognizer transcript text must be a string");
  if (value.length > MAX_SPEECH_TRANSCRIPT_CHARS) throw new Error("Recognizer transcript exceeds maximum length");
  if (containsUnpairedSurrogate(value)) throw new Error("Recognizer transcript contains invalid Unicode");
  const normalized = Array.from(value)
    .map((character) => isUnsafeTranscriptCharacter(character) ? " " : character)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length > MAX_SPEECH_TRANSCRIPT_CHARS) throw new Error("Recognizer transcript exceeds maximum length");
  return normalized;
}

function sameAudioBasis(left: SourceAudioBasis, right: SourceAudioBasis): boolean {
  return left.streamId === right.streamId
    && left.firstSequence === right.firstSequence
    && left.lastSequence === right.lastSequence
    && left.startTimestampMs === right.startTimestampMs
    && left.endTimestampMs === right.endTimestampMs
    && left.sampleRate === right.sampleRate
    && left.sampleCount === right.sampleCount
    && left.pcmSha256 === right.pcmSha256;
}

function isUnsafeTranscriptCharacter(character: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(character);
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function validateLocalPath(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const path = value.trim();
  if (path.length === 0 || path.length > 1_024) throw new Error(`${label} is invalid`);
  const windowsDrivePath = /^[A-Za-z]:[\\/]/u.test(path);
  const uriLikePath = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path);
  const uncLikePath = /^(?:\\\\|\/\/)/u.test(path);
  if ((uriLikePath && !windowsDrivePath) || uncLikePath || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(path)) {
    throw new Error(`${label} must be an explicitly supplied safe local filesystem path`);
  }
  return path;
}

function validateRuntimeIdentity(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

const TRANSCRIPT_CANDIDATE_KEYS = new Set([
  "requestId",
  "utteranceId",
  "text",
  "isFinal",
  "confidence",
  "words",
  "model",
  "sourceAudioBasis"
]);
const MOONSHINE_RESULT_KEYS = new Set(["text", "confidence", "words"]);
const WORD_TIMING_KEYS = new Set(["word", "startMs", "endMs", "confidence"]);
const MODEL_IDENTITY_KEYS = new Set(["name", "version"]);
const SOURCE_AUDIO_BASIS_KEYS = new Set([
  "streamId",
  "firstSequence",
  "lastSequence",
  "startTimestampMs",
  "endTimestampMs",
  "sampleRate",
  "channels",
  "sampleCount",
  "pcmSha256"
]);

function preflightWordTimings(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return;
  if (value.length > MAX_SPEECH_WORD_TIMINGS) {
    throw new Error(`${label} exceeds maximum entry count`);
  }
  for (const word of value) {
    if (!isRecord(word)) continue;
    assertAllowedOwnEnumerableKeys(word, WORD_TIMING_KEYS, "Recognizer word timing");
    if (typeof word.word !== "string" || word.word.length === 0 || word.word.length > 128) {
      throw new Error(`${label} contains word text outside bounded metadata limits`);
    }
  }
}

function preflightModelIdentity(value: unknown, label: string): void {
  if (!isRecord(value)) return;
  assertAllowedOwnEnumerableKeys(value, MODEL_IDENTITY_KEYS, label);
  preflightBoundedString(value.name, 100, `${label} name`);
  preflightBoundedString(value.version, 100, `${label} version`);
}

function preflightSourceAudioBasis(value: unknown, label: string): void {
  if (!isRecord(value)) return;
  assertAllowedOwnEnumerableKeys(value, SOURCE_AUDIO_BASIS_KEYS, label);
  preflightBoundedString(value.streamId, 128, `${label} stream ID`);
  if (typeof value.pcmSha256 !== "string" || value.pcmSha256.length !== 64) {
    throw new Error(`${label} PCM hash must contain exactly 64 characters`);
  }
}

function preflightBoundedString(value: unknown, maximumLength: number, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`${label} exceeds bounded string limits`);
  }
}

function assertAllowedOwnEnumerableKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key) && !allowed.has(key)) {
      throw new Error(`${label} contains an unexpected field`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function abortError(): Error {
  const error = new Error("Recognition cancelled");
  error.name = "AbortError";
  return error;
}

export interface TranscriptAdmission {
  readonly duplicate: boolean;
  readonly candidate: TranscriptCandidate;
}

interface RememberedTranscript {
  readonly fingerprint: string;
}

export class TranscriptResultGate {
  private readonly remembered = new Map<RequestId, RememberedTranscript>();

  public constructor(private readonly maxEntries = 128) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > MAX_SPEECH_TRANSCRIPT_RESULT_CACHE) {
      throw new Error("Transcript result cache bound must be within the hard speech cache limit");
    }
  }

  public admit(raw: unknown, expected: TranscriptValidationBasis): TranscriptAdmission {
    const candidate = validateTranscriptCandidate(raw, expected);
    const fingerprint = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
    const prior = this.remembered.get(candidate.requestId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) throw new Error("Recognizer reused a result requestId with conflicting content");
      return { duplicate: true, candidate };
    }
    this.remembered.set(candidate.requestId, { fingerprint });
    if (this.remembered.size > this.maxEntries) {
      const oldest = this.remembered.keys().next().value;
      if (oldest !== undefined) this.remembered.delete(oldest);
    }
    return { duplicate: false, candidate };
  }
}


function bindMoonshineTranscribe(value: unknown, owner: unknown): MoonshineRuntime["transcribe"] {
  if (typeof value !== "function") throw new Error("Moonshine runtime transcribe callback is required");
  return value.bind(owner) as MoonshineRuntime["transcribe"];
}

function bindMoonshineCancel(
  value: unknown,
  owner: unknown
): NonNullable<MoonshineRuntime["cancel"]> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") throw new Error("Moonshine runtime cancel callback must be a function when provided");
  return value.bind(owner) as NonNullable<MoonshineRuntime["cancel"]>;
}


function isSharedBackingBuffer(buffer: ArrayBufferLike): boolean {
  return typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
}

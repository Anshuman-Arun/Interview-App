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

export interface RecognizerAudioInput {
  readonly requestId: RequestId;
  readonly utteranceId: UtteranceId;
  readonly pcmBytes: Uint8Array;
  readonly sourceAudioBasis: SourceAudioBasis;
}

export type RecognizerCancellationCapability = "NONE" | "RUNTIME_ABORT";

export interface SpeechRecognizer {
  readonly modelIdentity: SpeechModelIdentity;
  readonly cancellationCapability: RecognizerCancellationCapability;
  recognize(input: RecognizerAudioInput, signal: AbortSignal): Promise<unknown>;
  cancel?(requestId: RequestId): Promise<boolean>;
}

export class DeterministicFakeRecognizer implements SpeechRecognizer {
  public readonly modelIdentity = { name: "deterministic-fake", version: "1" } as const;
  public readonly cancellationCapability: RecognizerCancellationCapability = "RUNTIME_ABORT";
  private readonly cancelled = new Set<RequestId>();
  private readonly maxCancelledIds = 1_024;

  public constructor(
    private readonly responseFactory: (input: RecognizerAudioInput) => unknown = (input) => ({
      requestId: input.requestId,
      utteranceId: input.utteranceId,
      text: "deterministic transcript",
      isFinal: true,
      model: { name: "deterministic-fake", version: "1" },
      sourceAudioBasis: input.sourceAudioBasis
    })
  ) {}

  public async recognize(input: RecognizerAudioInput, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted || this.cancelled.has(input.requestId)) throw abortError();
    const response = this.responseFactory(input);
    this.cancelled.delete(input.requestId);
    return response;
  }

  public async cancel(requestId: RequestId): Promise<boolean> {
    this.cancelled.add(requestId);
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

  public constructor(private readonly options: MoonshineRecognizerOptions) {
    this.modelPath = validateLocalPath(options.modelPath, "Moonshine model path");
    this.configPath = options.configPath === undefined
      ? undefined
      : validateLocalPath(options.configPath, "Moonshine config path");
    validateRuntimeIdentity(options.runtime.runtimeVersion, "Moonshine runtime version");
    if (typeof options.runtime.supportsAbort !== "boolean") throw new Error("Moonshine runtime abort capability must be boolean");
    if (typeof options.runtime.transcribe !== "function") throw new Error("Moonshine runtime transcribe callback is required");
    const name = options.modelName?.trim() || "moonshine";
    this.modelIdentity = SpeechModelIdentitySchema.parse({
      name,
      version: options.modelVersion.trim()
    });
    this.cancellationCapability = options.runtime.supportsAbort ? "RUNTIME_ABORT" : "NONE";
  }

  public async recognize(input: RecognizerAudioInput, signal: AbortSignal): Promise<unknown> {
    const requestId = SpeechRequestIdSchema.parse(input.requestId);
    const utteranceId = SpeechUtteranceIdSchema.parse(input.utteranceId);
    const sourceAudioBasis = SourceAudioBasisSchema.parse(input.sourceAudioBasis);
    const expectedBytes = sourceAudioBasis.sampleCount * sourceAudioBasis.channels * 4;
    if (input.pcmBytes.byteLength !== expectedBytes) {
      throw new Error("Moonshine PCM length does not match its source audio basis");
    }
    const durationMs = sourceAudioBasis.sampleCount / sourceAudioBasis.sampleRate * 1_000;
    if (durationMs > MAX_SPEECH_UTTERANCE_DURATION_MS + 0.001) {
      throw new Error("Moonshine input exceeds maximum utterance duration");
    }
    const runtimeResult = MoonshineRuntimeResultSchema.parse(await this.options.runtime.transcribe({
      pcmBytes: input.pcmBytes,
      sampleRate: sourceAudioBasis.sampleRate,
      modelPath: this.modelPath,
      ...(this.configPath === undefined ? {} : { configPath: this.configPath }),
      ...(this.options.runtime.supportsAbort ? { signal } : {})
    }));
    return {
      requestId,
      utteranceId,
      text: runtimeResult.text,
      isFinal: true,
      ...(runtimeResult.confidence === undefined ? {} : { confidence: runtimeResult.confidence }),
      ...(runtimeResult.words === undefined ? {} : { words: runtimeResult.words }),
      model: this.modelIdentity,
      sourceAudioBasis
    };
  }

  public async cancel(requestId: RequestId): Promise<boolean> {
    if (!this.options.runtime.supportsAbort || this.options.runtime.cancel === undefined) return false;
    return (await this.options.runtime.cancel(requestId)) === true;
  }
}

const MoonshineRuntimeResultSchema = z.object({
  text: z.string().max(MAX_SPEECH_TRANSCRIPT_CHARS),
  confidence: z.number().min(0).max(1).optional(),
  words: z.array(TranscriptWordTimingSchema).max(MAX_SPEECH_WORD_TIMINGS).optional()
}).strict();

export interface TranscriptValidationBasis {
  readonly requestId: RequestId;
  readonly utteranceId: UtteranceId;
  readonly sourceAudioBasis: SourceAudioBasis;
  readonly modelIdentity?: SpeechModelIdentity;
}

export function validateTranscriptCandidate(raw: unknown, expected: TranscriptValidationBasis): TranscriptCandidate {
  if (!isRecord(raw)) throw new Error("Recognizer result must be an object");
  if (Array.isArray(raw.words) && raw.words.length > MAX_SPEECH_WORD_TIMINGS) {
    throw new Error("Recognizer word timing metadata exceeds maximum entry count");
  }
  const normalizedText = normalizeTranscriptText(raw.text);
  const candidate = TranscriptCandidateSchema.parse({ ...raw, text: normalizedText });
  if (candidate.requestId !== expected.requestId) throw new Error("Recognizer result requestId does not match request");
  if (candidate.utteranceId !== expected.utteranceId) throw new Error("Recognizer result utteranceId does not match utterance");
  if (!sameAudioBasis(candidate.sourceAudioBasis, expected.sourceAudioBasis)) {
    throw new Error("Recognizer result source audio basis does not match request");
  }
  if (expected.modelIdentity !== undefined
      && (candidate.model.name !== expected.modelIdentity.name
        || candidate.model.version !== expected.modelIdentity.version)) {
    throw new Error("Recognizer result model identity does not match configured recognizer");
  }

  const utteranceDurationMs = expected.sourceAudioBasis.sampleCount / expected.sourceAudioBasis.sampleRate * 1_000;
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
  const code = character.codePointAt(0);
  if (code === undefined) return true;
  if ((code <= 0x1F && code !== 0x09 && code !== 0x0A && code !== 0x0D) || code === 0x7F) return true;
  return code === 0x200B
    || code === 0x2060
    || code === 0xFEFF
    || (code >= 0x202A && code <= 0x202E)
    || (code >= 0x2066 && code <= 0x2069);
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

function validateLocalPath(value: string, label: string): string {
  const path = value.trim();
  if (path.length === 0 || path.length > 1_024) throw new Error(`${label} is invalid`);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(path) || /[\p{Cc}\p{Cf}]/u.test(path)) {
    throw new Error(`${label} must be an explicitly supplied safe local path, not a URL`);
  }
  return path;
}

function validateRuntimeIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 100 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const fingerprint = JSON.stringify(candidate);
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

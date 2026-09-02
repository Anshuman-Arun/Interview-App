import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  TTS_LIMITS,
  TtsLanguageSchema,
  TtsModelIdentitySchema,
  TtsSampleRateSchema,
  TtsSynthesizeRequestSchema,
  TtsVoiceSchema,
  type TtsLanguage,
  type TtsModelIdentity,
  type TtsSampleRate,
  type TtsSynthesizeRequest,
  type TtsErrorCode
} from "./tts-protocol.js";

const ESTIMATED_CHARACTERS_PER_SECOND = 14;

export class TtsWorkerError extends Error {
  public constructor(
    public readonly code: TtsErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface TtsTextSegment {
  readonly index: number;
  readonly text: string;
  readonly textHash: string;
  readonly estimatedDurationMs: number;
}

export interface PlannedTtsRequest {
  readonly request: TtsSynthesizeRequest;
  readonly normalizedText: string;
  readonly normalizedTextHash: string;
  readonly requestBasisHash: string;
  readonly segments: readonly TtsTextSegment[];
  readonly estimatedDurationMs: number;
}

export interface TtsSegmentSynthesisRequest {
  readonly requestId: TtsSynthesizeRequest["requestId"];
  readonly segmentIndex: number;
  readonly text: string;
  readonly voice: string;
  readonly speed: number;
  readonly language: TtsLanguage;
  readonly sampleRate: TtsSampleRate;
}

export interface SynthesizedPcm {
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: number;
  readonly samples: Float32Array;
}

export interface ValidatedPcm {
  readonly sampleRate: TtsSampleRate;
  readonly channels: 1;
  readonly durationMs: number;
  readonly frameCount: number;
  readonly byteLength: number;
  readonly samples: Float32Array;
}

export interface SpeechSynthesizer {
  readonly identity: TtsModelIdentity;
  readonly supportedVoices: ReadonlySet<string>;
  readonly supportedLanguages: ReadonlySet<TtsLanguage>;
  readonly supportedSampleRates: ReadonlySet<TtsSampleRate>;
  synthesize(request: TtsSegmentSynthesisRequest): Promise<SynthesizedPcm>;
  cancel?(requestId: TtsSynthesizeRequest["requestId"]): Promise<"REQUESTED" | "UNSUPPORTED">;
  close?(): Promise<void>;
}

export interface SpeechSynthesizerSnapshot {
  readonly identity: TtsModelIdentity;
  readonly supportedVoices: readonly string[];
  readonly supportedLanguages: readonly TtsLanguage[];
  readonly supportedSampleRates: readonly TtsSampleRate[];
  readonly synthesize: (request: TtsSegmentSynthesisRequest) => Promise<SynthesizedPcm>;
  readonly cancel?: (requestId: TtsSynthesizeRequest["requestId"]) => Promise<unknown>;
}

function boundedSetValues(
  value: unknown,
  limit: number,
  label: string
): readonly unknown[] {
  if (!(value instanceof Set)) {
    throw new TtsWorkerError("MODEL_UNAVAILABLE", `Speech synthesizer ${label} metadata must be a Set`);
  }
  const values: unknown[] = [];
  try {
    const iterator = Set.prototype.values.call(value) as IterableIterator<unknown>;
    for (const item of iterator) {
      if (values.length >= limit) {
        throw new TtsWorkerError("MODEL_UNAVAILABLE", `Speech synthesizer advertises too many ${label}`);
      }
      values.push(item);
    }
  } catch (error) {
    if (error instanceof TtsWorkerError) throw error;
    throw new TtsWorkerError("MODEL_UNAVAILABLE", `Speech synthesizer ${label} metadata could not be inspected`);
  }
  return values;
}

export function snapshotSpeechSynthesizer(
  synthesizer: unknown
): SpeechSynthesizerSnapshot {
  if (synthesizer === null || typeof synthesizer !== "object") {
    throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer is invalid");
  }

  try {
    const candidate = synthesizer as {
      readonly identity?: unknown;
      readonly supportedVoices?: unknown;
      readonly supportedLanguages?: unknown;
      readonly supportedSampleRates?: unknown;
      readonly synthesize?: unknown;
      readonly cancel?: unknown;
    };
    if (typeof candidate.synthesize !== "function") {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer does not provide synthesis");
    }
    if (candidate.cancel !== undefined && typeof candidate.cancel !== "function") {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer cancellation metadata is invalid");
    }

    const identity = TtsModelIdentitySchema.safeParse(candidate.identity);
    if (!identity.success) {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer identity is invalid");
    }

    const rawVoices = boundedSetValues(
      candidate.supportedVoices,
      TTS_LIMITS.maxSupportedVoices,
      "voices"
    );
    const voices: string[] = [];
    for (const voice of rawVoices) {
      const parsedVoice = TtsVoiceSchema.safeParse(voice);
      if (!parsedVoice.success) {
        throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer advertises an invalid voice");
      }
      voices.push(parsedVoice.data);
    }
    if (voices.length === 0) {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer advertises no voices");
    }

    const rawLanguages = boundedSetValues(
      candidate.supportedLanguages,
      TTS_LIMITS.maxSupportedLanguages,
      "languages"
    );
    const languages: TtsLanguage[] = [];
    for (const language of rawLanguages) {
      const parsedLanguage = TtsLanguageSchema.safeParse(language);
      if (!parsedLanguage.success) {
        throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer advertises an invalid language");
      }
      languages.push(parsedLanguage.data);
    }
    if (languages.length === 0) {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer advertises no languages");
    }

    const rawSampleRates = boundedSetValues(
      candidate.supportedSampleRates,
      TTS_LIMITS.maxSupportedSampleRates,
      "sample rates"
    );
    const sampleRates: TtsSampleRate[] = [];
    for (const sampleRate of rawSampleRates) {
      const parsedSampleRate = TtsSampleRateSchema.safeParse(sampleRate);
      if (!parsedSampleRate.success) {
        throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer advertises an invalid sample rate");
      }
      sampleRates.push(parsedSampleRate.data);
    }
    if (sampleRates.length === 0) {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer advertises no sample rates");
    }

    const synthesize = candidate.synthesize as SpeechSynthesizer["synthesize"];
    const cancel = candidate.cancel as SpeechSynthesizer["cancel"];
    return Object.freeze({
      identity: Object.freeze(identity.data),
      supportedVoices: Object.freeze([...new Set(voices)]),
      supportedLanguages: Object.freeze([...new Set(languages)]),
      supportedSampleRates: Object.freeze([...new Set(sampleRates)]),
      synthesize: synthesize.bind(synthesizer as SpeechSynthesizer),
      ...(cancel === undefined
        ? {}
        : {
            cancel: async (requestId: TtsSynthesizeRequest["requestId"]) =>
              cancel.call(synthesizer as SpeechSynthesizer, requestId) as unknown
          })
    });
  } catch {
    throw new TtsWorkerError("MODEL_UNAVAILABLE", "Speech synthesizer metadata could not be inspected");
  }
}

export interface TtsPlanningLimits {
  readonly maxSegmentCharacters?: number;
  readonly maxSegments?: number;
  readonly maxSegmentDurationMs?: number;
  readonly maxEstimatedDurationMs?: number;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeTtsText(input: string): string {
  return input
    .replace(/\r\n?/gu, "\n")
    .normalize("NFC")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function estimatedDurationMs(text: string, speed: number): number {
  const characterCount = Array.from(text).length;
  const seconds = characterCount / (ESTIMATED_CHARACTERS_PER_SECOND * speed);
  return Math.max(80, Math.ceil(seconds * 1_000));
}

function isSentenceBoundary(character: string): boolean {
  return character === "." || character === "?" || character === "!";
}

function isSecondaryBoundary(character: string): boolean {
  return character === ";" || character === ":" || character === ",";
}

function chooseSegmentCut(codePoints: readonly string[], limit: number): number {
  if (codePoints.length <= limit) return codePoints.length;
  const minimumPreferredCut = Math.max(1, Math.floor(limit * 0.5));

  for (let index = limit - 1; index >= minimumPreferredCut; index -= 1) {
    const character = codePoints[index];
    const next = codePoints[index + 1];
    if (character !== undefined && isSentenceBoundary(character)
        && (next === undefined || /\s/u.test(next))) {
      return index + 1;
    }
  }

  for (let index = limit - 1; index >= minimumPreferredCut; index -= 1) {
    const character = codePoints[index];
    const next = codePoints[index + 1];
    if (character !== undefined && isSecondaryBoundary(character)
        && (next === undefined || /\s/u.test(next))) {
      return index + 1;
    }
  }

  for (let index = limit - 1; index >= minimumPreferredCut; index -= 1) {
    const character = codePoints[index];
    if (character !== undefined && /\s/u.test(character)) return index;
  }

  return limit;
}

export function planTtsSegments(
  normalizedText: string,
  speed: number,
  limits: TtsPlanningLimits = {}
): readonly TtsTextSegment[] {
  if (normalizedText.length === 0) {
    throw new TtsWorkerError("INVALID_REQUEST", "Normalized TTS text is empty");
  }
  if (normalizedText.length > TTS_LIMITS.maxTextCharacters
      || Buffer.byteLength(normalizedText, "utf8") > TTS_LIMITS.maxTextUtf8Bytes) {
    throw new TtsWorkerError("RESOURCE_LIMIT", "TTS segmentation input exceeds the hard text limit");
  }
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new TtsWorkerError("INVALID_REQUEST", "TTS speed is outside supported bounds");
  }

  const maxSegmentCharacters = limits.maxSegmentCharacters ?? TTS_LIMITS.maxSegmentCharacters;
  const maxSegments = limits.maxSegments ?? TTS_LIMITS.maxSegments;
  const maxSegmentDurationMs = limits.maxSegmentDurationMs ?? TTS_LIMITS.maxSegmentDurationMs;
  const maxEstimatedDurationMs = limits.maxEstimatedDurationMs ?? TTS_LIMITS.maxEstimatedDurationMs;
  if (!Number.isSafeInteger(maxSegmentCharacters) || maxSegmentCharacters <= 0
      || maxSegmentCharacters > TTS_LIMITS.maxSegmentCharacters
      || !Number.isSafeInteger(maxSegments) || maxSegments <= 0
      || maxSegments > TTS_LIMITS.maxSegments
      || !Number.isSafeInteger(maxSegmentDurationMs) || maxSegmentDurationMs <= 0
      || maxSegmentDurationMs > TTS_LIMITS.maxSegmentDurationMs
      || !Number.isSafeInteger(maxEstimatedDurationMs) || maxEstimatedDurationMs <= 0
      || maxEstimatedDurationMs > TTS_LIMITS.maxEstimatedDurationMs) {
    throw new TtsWorkerError("INTERNAL_ERROR", "TTS planning limits must stay within hard bounds");
  }

  const durationCharacterLimit = Math.max(
    1,
    Math.floor((maxSegmentDurationMs / 1_000) * ESTIMATED_CHARACTERS_PER_SECOND * speed)
  );
  const segmentCharacterLimit = Math.min(maxSegmentCharacters, durationCharacterLimit);
  const remaining = Array.from(normalizedText);
  const segments: TtsTextSegment[] = [];
  let totalEstimatedDurationMs = 0;

  while (remaining.length > 0) {
    while (remaining.length > 0 && /^\s$/u.test(remaining[0] ?? "")) remaining.shift();
    if (remaining.length === 0) break;

    const cut = chooseSegmentCut(remaining, segmentCharacterLimit);
    const text = remaining.splice(0, Math.max(1, cut)).join("").trim();
    if (text.length === 0) continue;

    const durationMs = estimatedDurationMs(text, speed);
    totalEstimatedDurationMs += durationMs;
    if (totalEstimatedDurationMs > maxEstimatedDurationMs) {
      throw new TtsWorkerError("RESOURCE_LIMIT", "Estimated TTS duration exceeds the request limit");
    }
    if (segments.length >= maxSegments) {
      throw new TtsWorkerError("RESOURCE_LIMIT", "TTS request exceeds the segment limit");
    }
    segments.push(Object.freeze({
      index: segments.length,
      text,
      textHash: sha256(text),
      estimatedDurationMs: durationMs
    }));
  }

  if (segments.length === 0) throw new TtsWorkerError("INVALID_REQUEST", "TTS request has no speakable text");
  return Object.freeze(segments);
}

function canonicalRequestBasis(
  request: TtsSynthesizeRequest,
  normalizedText: string
): string {
  return JSON.stringify({
    protocolVersion: request.protocolVersion,
    type: request.type,
    requestId: request.requestId,
    text: request.text,
    normalizedText,
    voice: request.voice,
    speed: request.speed,
    language: request.language,
    sampleRate: request.sampleRate,
    outputFormat: request.outputFormat
  });
}

function maxEstimatedDurationForSampleRate(sampleRate: TtsSampleRate): number {
  const maxFramesByBytes = Math.floor(TTS_LIMITS.maxPcmBytes / 4);
  const maxDurationByBytesMs = Math.floor((maxFramesByBytes / sampleRate) * 1_000);
  return Math.min(
    TTS_LIMITS.maxEstimatedDurationMs,
    TTS_LIMITS.maxOutputDurationMs,
    maxDurationByBytesMs
  );
}

export function planTtsRequest(input: unknown): PlannedTtsRequest {
  let parsed: ReturnType<typeof TtsSynthesizeRequestSchema.safeParse>;
  try {
    parsed = TtsSynthesizeRequestSchema.safeParse(input);
  } catch {
    throw new TtsWorkerError("INVALID_REQUEST", "TTS request failed validation");
  }
  if (!parsed.success) {
    throw new TtsWorkerError("INVALID_REQUEST", "TTS request failed validation");
  }
  const request = parsed.data;
  const normalizedText = normalizeTtsText(request.text);
  if (normalizedText.length === 0) {
    throw new TtsWorkerError("INVALID_REQUEST", "TTS request has no speakable text");
  }
  if (normalizedText.length > TTS_LIMITS.maxTextCharacters
      || Buffer.byteLength(normalizedText, "utf8") > TTS_LIMITS.maxTextUtf8Bytes) {
    throw new TtsWorkerError("RESOURCE_LIMIT", "Normalized TTS text exceeds the synthesis-input limit");
  }
  const segments = planTtsSegments(normalizedText, request.speed, {
    maxEstimatedDurationMs: maxEstimatedDurationForSampleRate(request.sampleRate)
  });
  return Object.freeze({
    request: Object.freeze({ ...request }),
    normalizedText,
    normalizedTextHash: sha256(normalizedText),
    requestBasisHash: sha256(canonicalRequestBasis(request, normalizedText)),
    segments,
    estimatedDurationMs: segments.reduce((sum, segment) => sum + segment.estimatedDurationMs, 0)
  });
}

const SynthesizedPcmSchema = z.object({
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  durationMs: z.number().refine(Number.isFinite).positive(),
  samples: z.instanceof(Float32Array)
}).strict();

const TypedArrayPrototype = Object.getPrototypeOf(Float32Array.prototype) as object;
const TypedArrayLengthDescriptor = Object.getOwnPropertyDescriptor(TypedArrayPrototype, "length");
const TypedArrayByteLengthDescriptor = Object.getOwnPropertyDescriptor(TypedArrayPrototype, "byteLength");

function readFloat32ArrayShape(samples: Float32Array): {
  readonly frameCount: number;
  readonly byteLength: number;
} {
  if (!ArrayBuffer.isView(samples)
      || TypedArrayLengthDescriptor?.get === undefined
      || TypedArrayByteLengthDescriptor?.get === undefined) {
    throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned invalid PCM storage");
  }
  try {
    const frameCount = TypedArrayLengthDescriptor.get.call(samples) as unknown;
    const byteLength = TypedArrayByteLengthDescriptor.get.call(samples) as unknown;
    if (typeof frameCount !== "number"
        || typeof byteLength !== "number"
        || !Number.isSafeInteger(frameCount)
        || !Number.isSafeInteger(byteLength)
        || frameCount < 0
        || byteLength !== frameCount * Float32Array.BYTES_PER_ELEMENT) {
      throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned invalid PCM storage");
    }
    return { frameCount, byteLength };
  } catch (error) {
    if (error instanceof TtsWorkerError) throw error;
    throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned invalid PCM storage");
  }
}

export function snapshotAndValidatePcm(
  input: unknown,
  expectedSampleRate: TtsSampleRate
): ValidatedPcm {
  let parsed: ReturnType<typeof SynthesizedPcmSchema.safeParse>;
  try {
    parsed = SynthesizedPcmSchema.safeParse(input);
  } catch {
    throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned malformed PCM metadata");
  }
  if (!parsed.success) {
    throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned malformed PCM metadata");
  }

  if (parsed.data.sampleRate !== expectedSampleRate) {
    throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned the wrong sample rate");
  }
  if (parsed.data.channels !== 1) {
    throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned an unsupported channel count");
  }

  const sourceSamples = parsed.data.samples;
  const sourceShape = readFloat32ArrayShape(sourceSamples);
  if (sourceShape.frameCount === 0) {
    throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned empty PCM");
  }
  if (sourceShape.byteLength > TTS_LIMITS.maxPcmBytes) {
    throw new TtsWorkerError("RESOURCE_LIMIT", "Synthesizer PCM exceeds the byte limit");
  }
  const actualDurationMs = (sourceShape.frameCount / expectedSampleRate) * 1_000;
  if (actualDurationMs > TTS_LIMITS.maxOutputDurationMs) {
    throw new TtsWorkerError("RESOURCE_LIMIT", "Synthesizer PCM exceeds the duration limit");
  }
  if (Math.abs(actualDurationMs - parsed.data.durationMs) > 1) {
    throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer duration metadata does not match PCM");
  }

  let snapshot: Float32Array;
  try {
    snapshot = new Float32Array(sourceSamples);
  } catch {
    throw new TtsWorkerError("RESOURCE_LIMIT", "Synthesizer PCM could not be safely snapshotted");
  }
  for (const sample of snapshot) {
    if (!Number.isFinite(sample)) {
      throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned non-finite PCM");
    }
    if (Math.abs(sample) > TTS_LIMITS.maxAbsolutePcmSample) {
      throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer returned out-of-range PCM");
    }
  }

  const snapshotShape = readFloat32ArrayShape(snapshot);
  if (snapshotShape.frameCount !== sourceShape.frameCount
      || snapshotShape.byteLength !== sourceShape.byteLength) {
    throw new TtsWorkerError("OUTPUT_INVALID", "Synthesizer PCM changed during snapshot");
  }

  return Object.freeze({
    sampleRate: expectedSampleRate,
    channels: 1,
    durationMs: actualDurationMs,
    frameCount: snapshotShape.frameCount,
    byteLength: snapshotShape.byteLength,
    samples: snapshot
  });
}

export function encodePcmF32Le(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(index * 4, samples[index] ?? 0, true);
  }
  return bytes;
}

function seedFromText(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  return digest.readUInt32LE(0);
}

export class DeterministicFakeSpeechSynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity = Object.freeze({
    engine: "deterministic-fake",
    modelId: "fake-tts",
    modelVersion: "1",
    runtimeVersion: "typescript",
    waveformDeterminism: "BYTE_STABLE"
  });
  public readonly supportedVoices = new Set(["fake-neutral", "af_heart"]);
  public readonly supportedLanguages = new Set<TtsLanguage>(["en-US", "en-GB"]);
  public readonly supportedSampleRates = new Set<TtsSampleRate>([22_050, 24_000, 44_100, 48_000]);

  public async synthesize(request: TtsSegmentSynthesisRequest): Promise<SynthesizedPcm> {
    const durationMs = Math.max(
      120,
      Math.min(20_000, estimatedDurationMs(request.text, request.speed))
    );
    const frameCount = Math.max(1, Math.round((durationMs / 1_000) * request.sampleRate));
    const samples = new Float32Array(frameCount);
    const seed = seedFromText(
      `${request.text}\0${request.voice}\0${request.language}\0${String(request.speed)}\0${String(request.sampleRate)}`
    );
    const period = 48 + (seed % 160);
    const phaseOffset = seed % period;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const phase = (frame + phaseOffset) % period;
      const normalized = phase / Math.max(1, period - 1);
      samples[frame] = (normalized * 2 - 1) * 0.08;
    }
    return {
      sampleRate: request.sampleRate,
      channels: 1,
      durationMs: (frameCount / request.sampleRate) * 1_000,
      samples
    };
  }

  public async cancel(): Promise<"UNSUPPORTED"> {
    return "UNSUPPORTED";
  }
}

export interface KokoroRuntimeSynthesisResult {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: number;
}

export interface KokoroRuntimeSession {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly runtimeVersion: string;
  readonly supportedVoices: readonly string[];
  readonly supportedLanguages: readonly TtsLanguage[];
  readonly supportedSampleRates: readonly TtsSampleRate[];
  synthesize(input: {
    readonly requestId: TtsSynthesizeRequest["requestId"];
    readonly text: string;
    readonly voice: string;
    readonly speed: number;
    readonly language: TtsLanguage;
    readonly sampleRate: TtsSampleRate;
  }): Promise<KokoroRuntimeSynthesisResult>;
  cancel?(requestId: string): Promise<void>;
  close?(): Promise<void>;
}

export interface KokoroRuntime {
  initialize(options: {
    readonly modelPath: string;
    readonly configPath?: string;
  }): Promise<KokoroRuntimeSession>;
}

export interface KokoroSpeechSynthesizerOptions {
  readonly runtime: KokoroRuntime;
  readonly modelPath: string;
  readonly configPath?: string;
}

function validateExplicitModelPath(path: unknown, label: string): asserts path is string {
  if (typeof path !== "string"
      || path.length === 0
      || path.length > TTS_LIMITS.maxModelPathCharacters
      || path.includes("\0")
      || !isAbsolute(path)) {
    throw new TtsWorkerError("MODEL_UNAVAILABLE", `${label} must be a bounded explicit absolute path`);
  }
}

const KokoroVoiceListSchema = z.array(TtsVoiceSchema)
  .min(1)
  .max(TTS_LIMITS.maxSupportedVoices);
const KokoroLanguageListSchema = z.array(
  z.enum(["en-US", "en-GB"])
).min(1).max(TTS_LIMITS.maxSupportedLanguages);
const KokoroSampleRateListSchema = z.array(
  TtsSampleRateSchema
).min(1).max(TTS_LIMITS.maxSupportedSampleRates);

export class KokoroSpeechSynthesizer implements SpeechSynthesizer {
  public readonly identity: TtsModelIdentity;
  private readonly voiceSet: ReadonlySet<string>;
  private readonly languageSet: ReadonlySet<TtsLanguage>;
  private readonly sampleRateSet: ReadonlySet<TtsSampleRate>;
  private readonly runtimeSynthesize: KokoroRuntimeSession["synthesize"];
  private readonly runtimeCancel: KokoroRuntimeSession["cancel"];
  private readonly runtimeClose: KokoroRuntimeSession["close"];

  private constructor(sessionInput: unknown) {
    if (sessionInput === null || typeof sessionInput !== "object") {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro runtime session is invalid");
    }
    const session = sessionInput as {
      readonly modelId?: unknown;
      readonly modelVersion?: unknown;
      readonly runtimeVersion?: unknown;
      readonly supportedVoices?: unknown;
      readonly supportedLanguages?: unknown;
      readonly supportedSampleRates?: unknown;
      readonly synthesize?: unknown;
      readonly cancel?: unknown;
      readonly close?: unknown;
    };
    if (typeof session.synthesize !== "function"
        || (session.cancel !== undefined && typeof session.cancel !== "function")
        || (session.close !== undefined && typeof session.close !== "function")) {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro runtime session is invalid");
    }
    const parsedIdentity = TtsModelIdentitySchema.safeParse({
      engine: "kokoro",
      modelId: session.modelId,
      modelVersion: session.modelVersion,
      runtimeVersion: session.runtimeVersion,
      waveformDeterminism: "NOT_GUARANTEED"
    });
    if (!parsedIdentity.success) {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro runtime reported invalid model identity");
    }
    if (!Array.isArray(session.supportedVoices)
        || session.supportedVoices.length === 0
        || session.supportedVoices.length > TTS_LIMITS.maxSupportedVoices
        || !Array.isArray(session.supportedLanguages)
        || session.supportedLanguages.length === 0
        || session.supportedLanguages.length > TTS_LIMITS.maxSupportedLanguages
        || !Array.isArray(session.supportedSampleRates)
        || session.supportedSampleRates.length === 0
        || session.supportedSampleRates.length > TTS_LIMITS.maxSupportedSampleRates) {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro runtime reported invalid capability metadata");
    }
    const voices = KokoroVoiceListSchema.safeParse(session.supportedVoices);
    const languages = KokoroLanguageListSchema.safeParse(session.supportedLanguages);
    const sampleRates = KokoroSampleRateListSchema.safeParse(session.supportedSampleRates);
    if (!voices.success || !languages.success || !sampleRates.success) {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro runtime reported invalid capability metadata");
    }
    const stableVoices = new Set(voices.data);
    const stableLanguages = new Set(languages.data);
    const stableSampleRates = new Set(sampleRates.data);
    this.identity = Object.freeze(parsedIdentity.data);
    this.voiceSet = stableVoices;
    this.languageSet = stableLanguages;
    this.sampleRateSet = stableSampleRates;
    this.runtimeSynthesize = (session.synthesize as KokoroRuntimeSession["synthesize"])
      .bind(sessionInput as KokoroRuntimeSession);
    this.runtimeCancel = (session.cancel as KokoroRuntimeSession["cancel"])?.bind(
      sessionInput as KokoroRuntimeSession
    );
    this.runtimeClose = (session.close as KokoroRuntimeSession["close"])?.bind(
      sessionInput as KokoroRuntimeSession
    );
  }

  public get supportedVoices(): ReadonlySet<string> {
    return new Set(this.voiceSet);
  }

  public get supportedLanguages(): ReadonlySet<TtsLanguage> {
    return new Set(this.languageSet);
  }

  public get supportedSampleRates(): ReadonlySet<TtsSampleRate> {
    return new Set(this.sampleRateSet);
  }

  public static async create(options: KokoroSpeechSynthesizerOptions): Promise<KokoroSpeechSynthesizer>;
  public static async create(options: unknown): Promise<KokoroSpeechSynthesizer> {
    try {
      if (options === null || typeof options !== "object") {
        throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro runtime configuration is invalid");
      }
      const candidate = options as {
        readonly runtime?: unknown;
        readonly modelPath?: unknown;
        readonly configPath?: unknown;
      };
      if (candidate.runtime === null || typeof candidate.runtime !== "object") {
        throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro runtime configuration is invalid");
      }
      const initialize = (candidate.runtime as { readonly initialize?: unknown }).initialize;
      if (typeof initialize !== "function") {
        throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro runtime configuration is invalid");
      }
      if (typeof candidate.modelPath !== "string"
          || (candidate.configPath !== undefined && typeof candidate.configPath !== "string")) {
        throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro model path configuration is invalid");
      }
      validateExplicitModelPath(candidate.modelPath, "Kokoro model path");
      if (candidate.configPath !== undefined) {
        validateExplicitModelPath(candidate.configPath, "Kokoro config path");
      }
      const runtime = candidate.runtime as KokoroRuntime;
      const initializeRuntime = initialize as KokoroRuntime["initialize"];
      const session = await initializeRuntime.call(
        runtime,
        candidate.configPath === undefined
          ? { modelPath: candidate.modelPath }
          : { modelPath: candidate.modelPath, configPath: candidate.configPath }
      );
      return new KokoroSpeechSynthesizer(session);
    } catch {
      throw new TtsWorkerError("MODEL_UNAVAILABLE", "Kokoro runtime initialization failed");
    }
  }

  public async synthesize(request: TtsSegmentSynthesisRequest): Promise<SynthesizedPcm> {
    if (!this.voiceSet.has(request.voice)) {
      throw new TtsWorkerError("UNSUPPORTED_VOICE", "Requested TTS voice is unavailable");
    }
    if (!this.languageSet.has(request.language)) {
      throw new TtsWorkerError("UNSUPPORTED_LANGUAGE", "Requested TTS language is unavailable");
    }
    if (!this.sampleRateSet.has(request.sampleRate)) {
      throw new TtsWorkerError("UNSUPPORTED_SAMPLE_RATE", "Requested TTS sample rate is unavailable");
    }
    try {
      return await this.runtimeSynthesize({
        requestId: request.requestId,
        text: request.text,
        voice: request.voice,
        speed: request.speed,
        language: request.language,
        sampleRate: request.sampleRate
      });
    } catch {
      throw new TtsWorkerError("SYNTHESIS_FAILED", "Kokoro synthesis failed");
    }
  }

  public async cancel(requestId: TtsSynthesizeRequest["requestId"]): Promise<"REQUESTED" | "UNSUPPORTED"> {
    if (this.runtimeCancel === undefined) return "UNSUPPORTED";
    try {
      await this.runtimeCancel(requestId);
      return "REQUESTED";
    } catch {
      return "UNSUPPORTED";
    }
  }

  public async close(): Promise<void> {
    if (this.runtimeClose === undefined) return;
    try {
      await this.runtimeClose();
    } catch {
      throw new TtsWorkerError("INTERNAL_ERROR", "Kokoro runtime close failed");
    }
  }
}

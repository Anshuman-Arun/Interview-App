import { z } from "zod";
import {
  MAX_SPEECH_FRAME_DURATION_MS,
  MAX_SPEECH_UTTERANCE_DURATION_MS,
  type SpeechStreamId
} from "./speech-protocol.js";
import { snapshotPcmFrame, type PcmFrameSnapshot } from "./speech-pcm.js";

export const VadObservationSchema = z.object({
  speechProbability: z.number().min(0).max(1)
}).strict();
export type VadObservation = z.infer<typeof VadObservationSchema>;

export class VadBackendProtocolError extends Error {}

export interface VadBackend {
  classify(frame: PcmFrameSnapshot, signal?: AbortSignal): Promise<VadObservation>;
}

export class DeterministicEnergyVadBackend implements VadBackend {
  public constructor(private readonly rmsThreshold = 0.02) {
    if (!Number.isFinite(rmsThreshold) || rmsThreshold < 0 || rmsThreshold > 1) {
      throw new Error("RMS threshold must be within [0, 1]");
    }
  }

  public async classify(frame: PcmFrameSnapshot): Promise<VadObservation> {
    const boundedFrame = snapshotPcmFrame(frame.envelope, frame.bytes);
    const view = new DataView(boundedFrame.bytes.buffer, boundedFrame.bytes.byteOffset, boundedFrame.bytes.byteLength);
    let squared = 0;
    const count = boundedFrame.bytes.byteLength / 4;
    for (let offset = 0; offset < boundedFrame.bytes.byteLength; offset += 4) {
      const sample = view.getFloat32(offset, true);
      squared += sample * sample;
    }
    const rms = count === 0 ? 0 : Math.sqrt(squared / count);
    return { speechProbability: rms >= this.rmsThreshold ? 1 : 0 };
  }
}

export interface SileroVadRuntime {
  readonly runtimeVersion: string;
  score(input: {
    readonly pcmBytes: Uint8Array;
    readonly sampleRate: number;
    readonly streamId: SpeechStreamId;
    readonly modelPath: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export class SileroVadBackend implements VadBackend {
  private readonly modelPath: string;
  private readonly scoreRuntime: SileroVadRuntime["score"];

  public constructor(runtime: SileroVadRuntime, modelPath: string) {
    const rawRuntime: unknown = runtime;
    if (!isRecord(rawRuntime)) throw new Error("Silero runtime must be an object");
    this.modelPath = validateLocalModelPath(modelPath, "Silero model path");
    validateRuntimeIdentity(rawRuntime.runtimeVersion, "Silero runtime version");
    this.scoreRuntime = bindSileroScore(rawRuntime.score, rawRuntime);
  }

  public async classify(frame: PcmFrameSnapshot, signal?: AbortSignal): Promise<VadObservation> {
    const boundedFrame = snapshotPcmFrame(frame.envelope, frame.bytes);
    const rawProbability = await this.scoreRuntime({
      pcmBytes: boundedFrame.bytes,
      sampleRate: boundedFrame.envelope.sampleRate,
      streamId: boundedFrame.envelope.streamId,
      modelPath: this.modelPath,
      ...(signal === undefined ? {} : { signal })
    });
    if (typeof rawProbability !== "number") {
      throw new VadBackendProtocolError("Silero speech probability must be numeric");
    }
    try {
      validateProbability(rawProbability, "Silero speech probability");
    } catch {
      throw new VadBackendProtocolError("Silero speech probability is outside the bounded range");
    }
    return { speechProbability: rawProbability };
  }
}

export class ScriptedVadBackend implements VadBackend {
  private index = 0;
  private readonly probabilities: readonly number[];

  public constructor(probabilities: readonly number[]) {
    this.probabilities = [...probabilities];
  }

  public async classify(): Promise<VadObservation> {
    const probability = this.probabilities[this.index] ?? 0;
    this.index += 1;
    return { speechProbability: probability };
  }
}

export type VoiceActivityState = "SILENCE" | "POSSIBLE_SPEECH" | "SPEECH" | "POSSIBLE_END" | "FINALIZED" | "CANCELLED";

export interface VoiceActivityConfig {
  readonly onsetThreshold: number;
  readonly continuationThreshold: number;
  readonly onsetHysteresisMs: number;
}

export interface VoiceActivitySnapshot {
  readonly state: VoiceActivityState;
  readonly speechMs: number;
  readonly silenceMs: number;
  readonly utteranceMs: number;
}

export interface VoiceActivityStep extends VoiceActivitySnapshot {
  readonly speechClassified: boolean;
  readonly speechStarted: boolean;
  readonly possibleEndpoint: boolean;
  readonly falseStart: boolean;
}

const DEFAULT_VAD_CONFIG: VoiceActivityConfig = {
  onsetThreshold: 0.65,
  continuationThreshold: 0.45,
  onsetHysteresisMs: 60
};

const VoiceActivityConfigSchema = z.object({
  onsetThreshold: z.number().min(0).max(1),
  continuationThreshold: z.number().min(0).max(1),
  onsetHysteresisMs: z.number().positive().max(MAX_SPEECH_UTTERANCE_DURATION_MS)
}).strict();

export class VoiceActivityStateMachine {
  private state: VoiceActivityState = "SILENCE";
  private candidateSpeechMs = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private utteranceMs = 0;
  private readonly config: VoiceActivityConfig;

  public constructor(config: VoiceActivityConfig = DEFAULT_VAD_CONFIG) {
    const parsed = VoiceActivityConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error("VAD configuration is invalid");
    if (parsed.data.continuationThreshold > parsed.data.onsetThreshold) {
      throw new Error("Continuation threshold must not exceed onset threshold");
    }
    this.config = Object.freeze({ ...parsed.data });
  }

  public step(probability: number, durationMs: number): VoiceActivityStep {
    validateProbability(probability, "speechProbability");
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_SPEECH_FRAME_DURATION_MS) {
      throw new Error("VAD frame duration is invalid");
    }
    if (this.state === "FINALIZED" || this.state === "CANCELLED") {
      throw new Error(`Cannot advance VAD in terminal state ${this.state}`);
    }
    if (this.state !== "SILENCE"
        && this.utteranceMs + durationMs > MAX_SPEECH_UTTERANCE_DURATION_MS + 0.001) {
      throw new Error("VAD utterance duration would exceed the global limit");
    }

    let speechStarted = false;
    let falseStart = false;
    let speechClassified = false;

    if (this.state === "SILENCE") {
      if (probability >= this.config.onsetThreshold) {
        this.state = "POSSIBLE_SPEECH";
        this.candidateSpeechMs = durationMs;
        this.utteranceMs = durationMs;
        speechClassified = true;
        if (this.candidateSpeechMs >= this.config.onsetHysteresisMs) {
          this.state = "SPEECH";
          this.speechMs = this.candidateSpeechMs;
          this.candidateSpeechMs = 0;
          speechStarted = true;
        }
      }
      return this.result(speechClassified, speechStarted, falseStart);
    }

    this.utteranceMs += durationMs;

    if (this.state === "POSSIBLE_SPEECH") {
      if (probability >= this.config.onsetThreshold) {
        speechClassified = true;
        this.candidateSpeechMs += durationMs;
        if (this.candidateSpeechMs >= this.config.onsetHysteresisMs) {
          this.state = "SPEECH";
          this.speechMs = this.candidateSpeechMs;
          this.candidateSpeechMs = 0;
          this.silenceMs = 0;
          speechStarted = true;
        }
      } else {
        falseStart = true;
        this.reset();
      }
      return this.result(speechClassified, speechStarted, falseStart);
    }

    if (probability >= this.config.continuationThreshold) {
      speechClassified = true;
      this.state = "SPEECH";
      this.speechMs += durationMs;
      this.silenceMs = 0;
    } else {
      this.state = "POSSIBLE_END";
      this.silenceMs += durationMs;
    }
    return this.result(speechClassified, speechStarted, falseStart);
  }

  public finalize(): void {
    if (this.state === "CANCELLED") throw new Error("Cancelled VAD cannot be finalized");
    this.state = "FINALIZED";
  }

  public cancel(): void {
    if (this.state === "FINALIZED") throw new Error("Finalized VAD cannot be cancelled");
    this.state = "CANCELLED";
  }

  public reset(): void {
    this.state = "SILENCE";
    this.candidateSpeechMs = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utteranceMs = 0;
  }

  public snapshot(): VoiceActivitySnapshot {
    return {
      state: this.state,
      speechMs: this.speechMs,
      silenceMs: this.silenceMs,
      utteranceMs: this.utteranceMs
    };
  }

  private result(speechClassified: boolean, speechStarted: boolean, falseStart: boolean): VoiceActivityStep {
    const snapshot = this.snapshot();
    return {
      ...snapshot,
      speechClassified,
      speechStarted,
      possibleEndpoint: snapshot.state === "POSSIBLE_END",
      falseStart
    };
  }
}

export interface EndpointingConfig {
  readonly minimumSpeechMs: number;
  readonly minimumSilenceMs: number;
  readonly incompleteSilenceMs: number;
  readonly maximumPauseMs: number;
  readonly maximumUtteranceMs: number;
}

export interface EndpointingInput extends VoiceActivitySnapshot {
  readonly appearsIncomplete?: boolean;
  readonly explicitFlush?: boolean;
}

const EndpointingInputSchema = z.object({
  state: z.enum(["SILENCE", "POSSIBLE_SPEECH", "SPEECH", "POSSIBLE_END", "FINALIZED", "CANCELLED"]),
  speechMs: z.number().nonnegative().max(MAX_SPEECH_UTTERANCE_DURATION_MS),
  silenceMs: z.number().nonnegative().max(MAX_SPEECH_UTTERANCE_DURATION_MS),
  utteranceMs: z.number().nonnegative().max(MAX_SPEECH_UTTERANCE_DURATION_MS),
  appearsIncomplete: z.boolean().optional(),
  explicitFlush: z.boolean().optional()
}).strict().superRefine((value, context) => {
  if (value.speechMs > value.utteranceMs + 0.001) {
    context.addIssue({ code: "custom", message: "Speech duration cannot exceed utterance duration", path: ["speechMs"] });
  }
  if (value.silenceMs > value.utteranceMs + 0.001) {
    context.addIssue({ code: "custom", message: "Silence duration cannot exceed utterance duration", path: ["silenceMs"] });
  }
  if (value.speechMs + value.silenceMs > value.utteranceMs + 0.001) {
    context.addIssue({ code: "custom", message: "Speech plus trailing silence cannot exceed utterance duration", path: ["utteranceMs"] });
  }

  if (value.state === "SILENCE"
      && (value.speechMs !== 0 || value.silenceMs !== 0 || value.utteranceMs !== 0)) {
    context.addIssue({ code: "custom", message: "Silent VAD state must have zero accumulated durations", path: ["state"] });
  }
  if (value.state === "POSSIBLE_SPEECH"
      && (value.speechMs !== 0 || value.silenceMs !== 0 || value.utteranceMs <= 0)) {
    context.addIssue({ code: "custom", message: "Possible-speech VAD state has inconsistent durations", path: ["state"] });
  }
  if (value.state === "SPEECH"
      && (value.speechMs <= 0 || value.silenceMs !== 0 || value.utteranceMs <= 0)) {
    context.addIssue({ code: "custom", message: "Speech VAD state has inconsistent durations", path: ["state"] });
  }
  if (value.state === "POSSIBLE_END"
      && (value.speechMs <= 0 || value.silenceMs <= 0 || value.utteranceMs <= 0)) {
    context.addIssue({ code: "custom", message: "Possible-end VAD state has inconsistent durations", path: ["state"] });
  }
});

export type EndpointingDecision =
  | { readonly kind: "CONTINUE" }
  | { readonly kind: "DISCARD"; readonly reason: "TOO_SHORT" }
  | { readonly kind: "FINALIZE"; readonly reason: "SILENCE" | "MAX_DURATION" | "FLUSH" };

const DEFAULT_ENDPOINT_CONFIG: EndpointingConfig = {
  minimumSpeechMs: 120,
  minimumSilenceMs: 500,
  incompleteSilenceMs: 900,
  maximumPauseMs: 1_500,
  maximumUtteranceMs: MAX_SPEECH_UTTERANCE_DURATION_MS
};

const EndpointingConfigSchema = z.object({
  minimumSpeechMs: z.number().positive(),
  minimumSilenceMs: z.number().positive(),
  incompleteSilenceMs: z.number().positive(),
  maximumPauseMs: z.number().positive(),
  maximumUtteranceMs: z.number().positive()
}).strict();

export class AdaptiveEndpointingPolicy {
  private readonly config: EndpointingConfig;

  public constructor(config: EndpointingConfig = DEFAULT_ENDPOINT_CONFIG) {
    const parsed = EndpointingConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error("Endpointing configuration is invalid");
    if (parsed.data.minimumSilenceMs > parsed.data.maximumPauseMs) {
      throw new Error("Minimum endpoint silence cannot exceed maximum pause");
    }
    if (parsed.data.incompleteSilenceMs < parsed.data.minimumSilenceMs) {
      throw new Error("Incomplete-utterance silence cannot be shorter than normal endpoint silence");
    }
    if (parsed.data.maximumUtteranceMs > MAX_SPEECH_UTTERANCE_DURATION_MS) {
      throw new Error("Endpointing cannot exceed the global utterance duration limit");
    }
    if (parsed.data.minimumSpeechMs > parsed.data.maximumUtteranceMs) {
      throw new Error("Minimum speech duration cannot exceed maximum utterance duration");
    }
    this.config = Object.freeze({ ...parsed.data });
  }

  public getMaximumUtteranceMs(): number {
    return this.config.maximumUtteranceMs;
  }

  public decide(input: EndpointingInput): EndpointingDecision {
    const boundedInput = EndpointingInputSchema.parse(input);
    if (boundedInput.state === "FINALIZED" || boundedInput.state === "CANCELLED") {
      throw new Error("Endpointing cannot advance a terminal VAD state");
    }
    if (boundedInput.explicitFlush === true) {
      return boundedInput.speechMs < this.config.minimumSpeechMs
        ? { kind: "DISCARD", reason: "TOO_SHORT" }
        : { kind: "FINALIZE", reason: "FLUSH" };
    }
    if (boundedInput.utteranceMs >= this.config.maximumUtteranceMs) {
      return boundedInput.speechMs < this.config.minimumSpeechMs
        ? { kind: "DISCARD", reason: "TOO_SHORT" }
        : { kind: "FINALIZE", reason: "MAX_DURATION" };
    }
    if (boundedInput.state !== "POSSIBLE_END") return { kind: "CONTINUE" };

    const requiredSilence = boundedInput.appearsIncomplete === true
      ? this.config.incompleteSilenceMs
      : this.config.minimumSilenceMs;
    if (boundedInput.silenceMs < Math.min(requiredSilence, this.config.maximumPauseMs)) {
      return { kind: "CONTINUE" };
    }
    return boundedInput.speechMs < this.config.minimumSpeechMs
      ? { kind: "DISCARD", reason: "TOO_SHORT" }
      : { kind: "FINALIZE", reason: "SILENCE" };
  }
}

function validateProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be within [0, 1]`);
  }
}

function validateLocalModelPath(value: unknown, label: string): string {
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


function bindSileroScore(value: unknown, owner: unknown): SileroVadRuntime["score"] {
  if (typeof value !== "function") throw new Error("Silero runtime score callback is required");
  return value.bind(owner) as SileroVadRuntime["score"];
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

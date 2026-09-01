import { z } from "zod";
import { MAX_SPEECH_FRAME_DURATION_MS, MAX_SPEECH_UTTERANCE_DURATION_MS } from "./speech-protocol.js";
import type { PcmFrameSnapshot } from "./speech-pcm.js";

export interface VadObservation {
  readonly speechProbability: number;
}

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
    const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
    let squared = 0;
    const count = frame.bytes.byteLength / 4;
    for (let offset = 0; offset < frame.bytes.byteLength; offset += 4) {
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
    readonly modelPath: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export class SileroVadBackend implements VadBackend {
  public constructor(
    private readonly runtime: SileroVadRuntime,
    private readonly modelPath: string
  ) {
    validateLocalModelPath(modelPath, "Silero model path");
    validateRuntimeIdentity(runtime.runtimeVersion, "Silero runtime version");
  }

  public async classify(frame: PcmFrameSnapshot, signal?: AbortSignal): Promise<VadObservation> {
    const rawProbability = await this.runtime.score({
      pcmBytes: frame.bytes,
      sampleRate: frame.envelope.sampleRate,
      modelPath: this.modelPath.trim(),
      ...(signal === undefined ? {} : { signal })
    });
    if (typeof rawProbability !== "number") throw new Error("Silero speech probability must be numeric");
    validateProbability(rawProbability, "Silero speech probability");
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

export class VoiceActivityStateMachine {
  private state: VoiceActivityState = "SILENCE";
  private candidateSpeechMs = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private utteranceMs = 0;

  public constructor(private readonly config: VoiceActivityConfig = DEFAULT_VAD_CONFIG) {
    validateProbability(config.onsetThreshold, "onsetThreshold");
    validateProbability(config.continuationThreshold, "continuationThreshold");
    if (config.continuationThreshold > config.onsetThreshold) {
      throw new Error("Continuation threshold must not exceed onset threshold");
    }
    if (!Number.isFinite(config.onsetHysteresisMs) || config.onsetHysteresisMs <= 0) {
      throw new Error("Onset hysteresis must be positive");
    }
    if (config.onsetHysteresisMs > MAX_SPEECH_UTTERANCE_DURATION_MS) {
      throw new Error("Onset hysteresis cannot exceed the maximum utterance duration");
    }
  }

  public step(probability: number, durationMs: number): VoiceActivityStep {
    validateProbability(probability, "speechProbability");
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_SPEECH_FRAME_DURATION_MS) {
      throw new Error("VAD frame duration is invalid");
    }
    if (this.state === "FINALIZED" || this.state === "CANCELLED") {
      throw new Error(`Cannot advance VAD in terminal state ${this.state}`);
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

export class AdaptiveEndpointingPolicy {
  public constructor(private readonly config: EndpointingConfig = DEFAULT_ENDPOINT_CONFIG) {
    for (const [name, value] of Object.entries(config)) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    }
    if (config.minimumSilenceMs > config.maximumPauseMs) {
      throw new Error("Minimum endpoint silence cannot exceed maximum pause");
    }
    if (config.incompleteSilenceMs < config.minimumSilenceMs || config.incompleteSilenceMs > config.maximumPauseMs) {
      throw new Error("Incomplete-utterance silence must be within the endpoint pause bounds");
    }
    if (config.maximumUtteranceMs > MAX_SPEECH_UTTERANCE_DURATION_MS) {
      throw new Error("Endpointing cannot exceed the global utterance duration limit");
    }
    if (config.minimumSpeechMs > config.maximumUtteranceMs) {
      throw new Error("Minimum speech duration cannot exceed maximum utterance duration");
    }
  }

  public getMaximumUtteranceMs(): number {
    return this.config.maximumUtteranceMs;
  }

  public decide(input: EndpointingInput): EndpointingDecision {
    const boundedInput = EndpointingInputSchema.parse(input);
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

function validateLocalModelPath(value: string, label: string): void {
  const path = value.trim();
  if (path.length === 0 || path.length > 1_024) throw new Error(`${label} is invalid`);
  const windowsDrivePath = /^[A-Za-z]:[\\/]/u.test(path);
  const uriLikePath = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path);
  const uncLikePath = /^(?:\\\\|\/\/)/u.test(path);
  if ((uriLikePath && !windowsDrivePath) || uncLikePath || /[\p{Cc}\p{Cf}]/u.test(path)) {
    throw new Error(`${label} must be an explicitly supplied safe local filesystem path`);
  }
}

function validateRuntimeIdentity(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 100 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

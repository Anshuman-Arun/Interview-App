import { z } from "zod";
import {
  InputEpisodeIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  type DeliveryId,
  type InputEpisodeId,
  type SessionId,
  type TurnId
} from "../../../packages/domain/src/index.js";
import {
  SpeechRequestIdSchema,
  SpeechSampleRateSchema,
  SpeechStreamIdSchema,
  SpeechWorkerEventSchema,
  TTS_LIMITS,
  type SpeechWorkerEvent
} from "../../../packages/local-compute/src/index.js";
import type { ResolvedAudioSource } from "./audio/renderer-adapter.js";
import type { AudioFrame } from "./audio/types.js";

const MAX_VOICE_RESPONSE_BYTES = 512 * 1024;
const MAX_VOICE_RESPONSE_CHUNKS = 256;
const FAILED_OPEN_CANCEL_TIMEOUT_MS = 1_000;
const MAX_WAV_ASSET_BYTES = Math.floor(TTS_LIMITS.maxPcmBytes / 2) + 44;
const MAX_WAV_ASSET_CHUNKS = 4_096;
const TARGET_SPEECH_SAMPLE_RATE = 48_000 as const;
const AUDIO_REF_PATTERN = /^audio_v1_[0-9a-f]{64}$/u;

const VoiceOpenResponseSchema = z.object({
  protocolVersion: z.literal(1),
  ok: z.literal(true),
  type: z.literal("VOICE_STREAM_OPENED"),
  sessionId: SessionIdSchema,
  streamId: SpeechStreamIdSchema,
  sampleRate: SpeechSampleRateSchema
}).strict();

const VoiceCancelResponseSchema = z.object({
  protocolVersion: z.literal(1),
  ok: z.literal(true),
  type: z.literal("VOICE_STREAM_CANCELLED"),
  streamId: SpeechStreamIdSchema
}).strict();

const VoiceCommitSchema = z.object({
  inputEpisodeId: InputEpisodeIdSchema,
  turnId: TurnIdSchema,
  text: z.string().min(1).max(20_000)
}).strict();

const VoiceFrameResponseSchema = z.object({
  protocolVersion: z.literal(1),
  ok: z.literal(true),
  type: z.enum(["VOICE_FRAME_RESULT", "VOICE_FLUSH_RESULT"]),
  events: z.array(SpeechWorkerEventSchema).max(64),
  terminal: z.boolean(),
  commit: VoiceCommitSchema.optional()
}).strict();

export interface BrowserVoiceCommit {
  readonly inputEpisodeId: InputEpisodeId;
  readonly turnId: TurnId;
  readonly text: string;
}

export interface BrowserVoiceFrameResult {
  readonly events: readonly SpeechWorkerEvent[];
  readonly terminal: boolean;
  readonly commit?: BrowserVoiceCommit;
  /**
   * True only when MAX_DURATION finalization proves the frame that triggered
   * finalization was outside SourceAudioBasis and must seed a fresh stream.
   */
  readonly carryCurrentFrameToNextStream?: boolean;
}

export interface BrowserVoiceClientOptions {
  readonly baseUrl: string;
  readonly authenticatedFetch: typeof fetch;
}

export class BrowserVoiceStream {
  private sequence = 0;
  private timestampMs = 0;
  private closed = false;
  private operationInFlight = false;
  private resamplerSourceRate: number | undefined;
  private sourceSamplesSeen = 0;
  private targetSamplesEmitted = 0;
  private previousSourceSample: number | undefined;

  public constructor(
    private readonly client: BrowserVoiceClient,
    public readonly sessionId: SessionId,
    public readonly streamId: string
  ) {}

  public async sendFrame(frame: AudioFrame, signal?: AbortSignal): Promise<BrowserVoiceFrameResult> {
    if (this.closed) throw new Error("Voice stream is closed");
    if (this.operationInFlight) {
      throw new Error("Voice stream does not permit overlapping frame/flush operations");
    }
    if (
      frame.channelCount !== 1
      || !(frame.samples instanceof Float32Array)
      || frame.samples.length < 1
    ) {
      throw new Error("Voice transport accepts non-empty mono Float32 microphone frames only");
    }

    const preview = previewStreamingResample({
      samples: frame.samples,
      sourceRate: frame.sampleRate,
      targetRate: TARGET_SPEECH_SAMPLE_RATE,
      previousSourceRate: this.resamplerSourceRate,
      sourceSamplesSeen: this.sourceSamplesSeen,
      targetSamplesEmitted: this.targetSamplesEmitted,
      previousSourceSample: this.previousSourceSample
    });
    if (
      preview.samples.length < 1
      || preview.samples.length > TARGET_SPEECH_SAMPLE_RATE / 10
    ) {
      throw new Error("Microphone frame exceeds the bounded speech duration after resampling");
    }

    const admittedSequence = this.sequence;
    this.operationInFlight = true;
    try {
      const result = await this.client.sendFrame({
        sessionId: this.sessionId,
        streamId: this.streamId,
        sequence: admittedSequence,
        timestampMs: this.timestampMs,
        samples: preview.samples,
        ...(signal === undefined ? {} : { signal })
      });

      // Commit resampler phase only after the transport result is admitted.
      // A failed/aborted request may therefore be retried without consuming
      // local PCM or advancing sequence/timestamp identity.
      this.resamplerSourceRate = preview.sourceRate;
      this.sourceSamplesSeen = preview.sourceSamplesSeen;
      this.targetSamplesEmitted = preview.targetSamplesEmitted;
      this.previousSourceSample = preview.previousSourceSample;
      this.sequence += 1;
      this.timestampMs += preview.samples.length / TARGET_SPEECH_SAMPLE_RATE * 1_000;
      if (result.terminal) this.closed = true;
      const carryCurrentFrameToNextStream = result.events.some((event) =>
        event.type === "UTTERANCE_FINALIZED"
        && event.finalizationReason === "MAX_DURATION"
        && event.sourceAudioBasis.lastSequence < admittedSequence
      );
      return carryCurrentFrameToNextStream
        ? { ...result, carryCurrentFrameToNextStream: true }
        : result;
    } finally {
      this.operationInFlight = false;
    }
  }

  public async flush(signal?: AbortSignal): Promise<BrowserVoiceFrameResult> {
    if (this.closed) return { events: [], terminal: true };
    if (this.operationInFlight) {
      throw new Error("Voice stream does not permit overlapping frame/flush operations");
    }
    this.operationInFlight = true;
    try {
      const result = await this.client.flush(this.sessionId, this.streamId, signal);
      if (result.terminal) this.closed = true;
      return result;
    } finally {
      this.operationInFlight = false;
    }
  }

  public async cancel(signal?: AbortSignal): Promise<void> {
    // Close frame admission immediately, but keep the transport cancellation
    // itself retryable. A lost/aborted first cancel response must not make the
    // known server-side stream identity impossible to retire on a later
    // bounded attempt.
    this.closed = true;
    await this.client.cancel(this.sessionId, this.streamId, signal);
  }

  public get isClosed(): boolean {
    return this.closed;
  }
}

export class BrowserVoiceClient {
  private readonly baseUrl: string;
  private readonly authenticatedFetch: typeof fetch;

  public constructor(options: BrowserVoiceClientOptions) {
    const rawOptions: unknown = options;
    if (typeof rawOptions !== "object" || rawOptions === null) {
      throw new Error("Browser voice client options are invalid");
    }
    let baseUrl: unknown;
    let authenticatedFetch: unknown;
    try {
      baseUrl = Reflect.get(rawOptions, "baseUrl");
      authenticatedFetch = Reflect.get(rawOptions, "authenticatedFetch");
    } catch (error) {
      throw new Error("Browser voice client options could not be inspected", { cause: error });
    }
    if (typeof baseUrl !== "string" || typeof authenticatedFetch !== "function") {
      throw new Error("Browser voice client options are invalid");
    }
    this.baseUrl = exactLoopbackOrigin(baseUrl);
    this.authenticatedFetch = authenticatedFetch as typeof fetch;
  }

  public async openStream(sessionIdInput: SessionId, signal?: AbortSignal): Promise<BrowserVoiceStream> {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const streamId = `speech_stream_${globalThis.crypto.randomUUID()}`;
    try {
      const opened = VoiceOpenResponseSchema.parse(await this.requestJson("/v1/voice/streams", {
        protocolVersion: 1,
        sessionId,
        streamId,
        sampleRate: TARGET_SPEECH_SAMPLE_RATE
      }, signal));
      if (
        opened.sessionId !== sessionId
        || opened.streamId !== streamId
        || opened.sampleRate !== TARGET_SPEECH_SAMPLE_RATE
      ) {
        throw new Error("Voice stream-open response did not match the admitted request");
      }
      return new BrowserVoiceStream(this, sessionId, streamId);
    } catch (error) {
      // The server may have accepted the stream even if the success response
      // was lost locally. Retire the known identity with an independent,
      // bounded cancellation before exposing the failure to the hook.
      await this.bestEffortCancelFailedOpen(sessionId, streamId);
      throw error;
    }
  }

  public async resolveAudioSource(
    sessionIdInput: SessionId,
    audioRef: string,
    _deliveryId: DeliveryId,
    signal: AbortSignal
  ): Promise<ResolvedAudioSource> {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    if (
      typeof audioRef !== "string"
      || audioRef.length !== 73
      || !AUDIO_REF_PATTERN.test(audioRef)
    ) {
      throw new Error("Renderer audio reference is not a bounded local logical reference");
    }
    const response = await this.authenticatedFetch(
      `${this.baseUrl}/v1/voice/audio/${encodeURIComponent(audioRef)}`,
      {
        method: "GET",
        headers: {
          "x-interview-session-id": sessionId
        },
        cache: "no-store",
        signal
      }
    );
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`Audio asset resolution failed with HTTP ${String(response.status)}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "audio/wav") {
      await cancelResponseBody(response);
      throw new Error("Audio asset response has an unexpected content type");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      if (
        declared.length === 0
        || declared.length > 16
        || !/^[1-9][0-9]*$/u.test(declared)
      ) {
        await cancelResponseBody(response);
        throw new Error("Audio asset declared size is malformed");
      }
      const parsed = Number(declared);
      if (!Number.isSafeInteger(parsed) || parsed > MAX_WAV_ASSET_BYTES) {
        await cancelResponseBody(response);
        throw new Error("Audio asset declared size is outside the browser bound");
      }
    }
    const audioBytes = await readBoundedResponseBytes(
      response,
      MAX_WAV_ASSET_BYTES,
      MAX_WAV_ASSET_CHUNKS,
      "Audio asset"
    );
    if (audioBytes.byteLength === 0) {
      throw new Error("Audio asset body is outside the browser bound");
    }
    const blob = new Blob([audioBytes], { type: "audio/wav" });
    const urlFactory = globalThis.URL;
    if (
      typeof urlFactory.createObjectURL !== "function"
      || typeof urlFactory.revokeObjectURL !== "function"
    ) {
      throw new Error("Browser Blob URL playback is unavailable");
    }
    const objectUrl = urlFactory.createObjectURL(blob);
    let released = false;
    return {
      source: objectUrl,
      release: () => {
        if (released) return;
        released = true;
        urlFactory.revokeObjectURL(objectUrl);
      }
    };
  }

  public async sendFrame(input: {
    readonly sessionId: SessionId;
    readonly streamId: string;
    readonly sequence: number;
    readonly timestampMs: number;
    readonly samples: Float32Array;
    readonly signal?: AbortSignal;
  }): Promise<BrowserVoiceFrameResult> {
    const sessionId = SessionIdSchema.parse(input.sessionId);
    const streamId = SpeechStreamIdSchema.parse(input.streamId);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new Error("Voice frame sequence is invalid");
    }
    if (
      !(input.samples instanceof Float32Array)
      || input.samples.length < 1
      || input.samples.length > TARGET_SPEECH_SAMPLE_RATE / 10
    ) {
      throw new Error("Voice frame PCM is outside the bounded transport shape");
    }
    const payload = encodeF32Le(input.samples);
    const requestId = SpeechRequestIdSchema.parse(
      `request_${globalThis.crypto.randomUUID()}`
    );
    const response = await this.authenticatedFetch(
      `${this.baseUrl}/v1/voice/frames`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-interview-session-id": sessionId,
          "x-speech-stream-id": streamId,
          "x-speech-request-id": requestId,
          "x-speech-sequence": String(input.sequence),
          "x-speech-sample-rate": String(TARGET_SPEECH_SAMPLE_RATE),
          "x-speech-frame-samples": String(input.samples.length),
          "x-speech-timestamp-ms": finiteTimestamp(input.timestampMs)
        },
        body: payload,
        cache: "no-store",
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }
    );
    return parseVoiceFrameResponse(
      response,
      "VOICE_FRAME_RESULT",
      streamId,
      requestId
    );
  }

  public async flush(
    sessionId: SessionId,
    streamId: string,
    signal?: AbortSignal
  ): Promise<BrowserVoiceFrameResult> {
    const boundedSessionId = SessionIdSchema.parse(sessionId);
    const boundedStreamId = SpeechStreamIdSchema.parse(streamId);
    const requestId = SpeechRequestIdSchema.parse(
      `request_${globalThis.crypto.randomUUID()}`
    );
    const response = await this.requestJsonResponse("/v1/voice/flush", {
      protocolVersion: 1,
      sessionId: boundedSessionId,
      streamId: boundedStreamId,
      requestId
    }, signal);
    return parseVoiceFrameResponse(
      response,
      "VOICE_FLUSH_RESULT",
      boundedStreamId,
      requestId
    );
  }

  public async cancel(
    sessionId: SessionId,
    streamId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const boundedSessionId = SessionIdSchema.parse(sessionId);
    const boundedStreamId = SpeechStreamIdSchema.parse(streamId);
    const cancelled = VoiceCancelResponseSchema.parse(await this.requestJson("/v1/voice/cancel", {
      protocolVersion: 1,
      sessionId: boundedSessionId,
      streamId: boundedStreamId,
      requestId: `request_${globalThis.crypto.randomUUID()}`
    }, signal));
    if (cancelled.streamId !== boundedStreamId) {
      throw new Error("Voice stream-cancel response did not match the admitted request");
    }
  }

  private async bestEffortCancelFailedOpen(
    sessionId: SessionId,
    streamId: string
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), FAILED_OPEN_CANCEL_TIMEOUT_MS);
    try {
      await this.cancel(sessionId, streamId, controller.signal);
    } catch {
      // The server-side idle lease and transport-drop cleanup remain the final
      // fail-closed backstops if this independent cancellation cannot arrive.
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private async requestJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.requestJsonResponse(path, body, signal);
    return parseBoundedJson(response);
  }

  private requestJsonResponse(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return this.authenticatedFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      ...(signal === undefined ? {} : { signal })
    }).then((response) => {
      if (!response.ok) {
        return parseBoundedJson(response).then((parsed) => {
          const message = safeProtocolMessage(parsed);
          throw new Error(
            message ?? `Voice transport request failed with HTTP ${String(response.status)}`
          );
        });
      }
      return response;
    });
  }
}

export function deriveDefaultVoiceBaseUrl(commandBaseUrl: string): string {
  const parsed = new URL(commandBaseUrl);
  const port = parsed.port.length === 0
    ? (parsed.protocol === "https:" ? 443 : 80)
    : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_533) {
    throw new Error("Cannot derive the bounded voice port from the command endpoint");
  }
  parsed.port = String(port + 2);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return exactLoopbackOrigin(parsed.toString());
}

function exactLoopbackOrigin(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error("Voice endpoint must be a bounded URL string");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("Voice endpoint must be a valid URL", { cause: error });
  }
  if (
    parsed.protocol !== "http:"
    || (
      parsed.hostname !== "127.0.0.1"
      && parsed.hostname !== "localhost"
      && parsed.hostname !== "[::1]"
    )
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/"
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error("Voice endpoint must be an exact HTTP loopback origin");
  }
  return parsed.origin;
}

async function parseVoiceFrameResponse(
  response: Response,
  expectedType: "VOICE_FRAME_RESULT" | "VOICE_FLUSH_RESULT",
  expectedStreamId: string,
  expectedRequestId: string
): Promise<BrowserVoiceFrameResult> {
  if (!response.ok) {
    const parsed = await parseBoundedJson(response);
    throw new Error(
      safeProtocolMessage(parsed)
      ?? `Voice transport request failed with HTTP ${String(response.status)}`
    );
  }
  const parsed = VoiceFrameResponseSchema.parse(await parseBoundedJson(response));
  if (
    parsed.type !== expectedType
    || parsed.events.some((event) =>
      event.streamId !== expectedStreamId
      || event.requestId !== expectedRequestId
    )
  ) {
    throw new Error("Voice transport response did not match the admitted stream/request");
  }
  if (
    parsed.commit !== undefined
    && (
      !parsed.terminal
      || !parsed.events.some((event) =>
        event.type === "TRANSCRIPT_CANDIDATE"
        && event.candidate.text === parsed.commit?.text
      )
    )
  ) {
    throw new Error("Voice commit response does not match its admitted transcript event");
  }
  return {
    events: parsed.events,
    terminal: parsed.terminal,
    ...(parsed.commit === undefined ? {} : {
      commit: {
        inputEpisodeId: parsed.commit.inputEpisodeId,
        turnId: parsed.commit.turnId,
        text: parsed.commit.text
      }
    })
  };
}

async function parseBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await cancelResponseBody(response);
    throw new Error("Voice transport response has an unexpected content type");
  }
  const bytes = await readBoundedResponseBytes(
    response,
    MAX_VOICE_RESPONSE_BYTES,
    MAX_VOICE_RESPONSE_CHUNKS,
    "Voice transport response"
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Voice transport response is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Voice transport response is not valid JSON");
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Rejection cleanup is best-effort and must not replace the admission error.
  }
}

async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  maximumChunks: number,
  label: string
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  let declaredBytes: number | undefined;
  if (declared !== null) {
    if (
      declared.length === 0
      || declared.length > 16
      || !/^(?:0|[1-9][0-9]*)$/u.test(declared)
    ) {
      await cancelResponseBody(response);
      throw new Error(`${label} declared size is malformed`);
    }
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed > maximumBytes) {
      await cancelResponseBody(response);
      throw new Error(`${label} declared size exceeds the browser bound`);
    }
    declaredBytes = parsed;
  }
  if (response.body === null) throw new Error(`${label} has no response body`);

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  let chunkCount = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunkCount += 1;
      total += chunk.value.byteLength;
      if (chunkCount > maximumChunks || total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} body exceeds the browser bound`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader cleanup must not obscure the bounded response result.
    }
  }

  if (declaredBytes !== undefined && total !== declaredBytes) {
    throw new Error(`${label} body length does not match Content-Length`);
  }

  const output = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function safeProtocolMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = Reflect.get(value, "error") as unknown;
  if (typeof error !== "object" || error === null) return undefined;
  const message = Reflect.get(error, "message") as unknown;
  return typeof message === "string" && message.length <= 256 ? message : undefined;
}

function encodeF32Le(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === undefined || !Number.isFinite(sample) || Math.abs(sample) > 1.000_001) {
      throw new Error("Microphone frame contains an invalid normalized sample");
    }
    view.setFloat32(index * 4, Math.max(-1, Math.min(1, sample)), true);
  }
  return buffer;
}

interface StreamingResamplePreview {
  readonly samples: Float32Array;
  readonly sourceRate: number;
  readonly sourceSamplesSeen: number;
  readonly targetSamplesEmitted: number;
  readonly previousSourceSample: number;
}

function previewStreamingResample(input: {
  readonly samples: Float32Array;
  readonly sourceRate: number;
  readonly targetRate: number;
  readonly previousSourceRate: number | undefined;
  readonly sourceSamplesSeen: number;
  readonly targetSamplesEmitted: number;
  readonly previousSourceSample: number | undefined;
}): StreamingResamplePreview {
  if (
    !Number.isSafeInteger(input.sourceRate)
    || input.sourceRate < 8_000
    || input.sourceRate > 384_000
    || !Number.isSafeInteger(input.targetRate)
    || input.targetRate <= 0
  ) {
    throw new Error("Microphone frame resampling size is invalid");
  }
  if (
    input.previousSourceRate !== undefined
    && input.previousSourceRate !== input.sourceRate
  ) {
    throw new Error("Microphone sample rate changed within an active voice stream");
  }
  if (
    !Number.isSafeInteger(input.sourceSamplesSeen)
    || input.sourceSamplesSeen < 0
    || !Number.isSafeInteger(input.targetSamplesEmitted)
    || input.targetSamplesEmitted < 0
  ) {
    throw new Error("Microphone streaming resampler state is invalid");
  }

  const startSourceIndex = input.sourceSamplesSeen;
  const endSourceIndex = startSourceIndex + input.samples.length - 1;
  if (!Number.isSafeInteger(endSourceIndex)) {
    throw new Error("Microphone frame resampling size is invalid");
  }

  const scaledEnd = endSourceIndex * input.targetRate;
  if (!Number.isSafeInteger(scaledEnd)) {
    throw new Error("Microphone frame resampling size is invalid");
  }
  const maximumTargetIndex = Math.floor(scaledEnd / input.sourceRate);
  const outputLength = maximumTargetIndex - input.targetSamplesEmitted + 1;
  if (
    !Number.isSafeInteger(outputLength)
    || outputLength < 1
    || outputLength > input.targetRate / 10
  ) {
    throw new Error("Microphone frame exceeds the bounded speech duration after resampling");
  }

  if (input.sourceRate === input.targetRate) {
    if (outputLength !== input.samples.length) {
      throw new Error("Microphone streaming resampler lost identity-rate continuity");
    }
    const last = input.samples[input.samples.length - 1];
    if (last === undefined) throw new Error("Microphone frame is unexpectedly empty");
    return {
      samples: new Float32Array(input.samples),
      sourceRate: input.sourceRate,
      sourceSamplesSeen: endSourceIndex + 1,
      targetSamplesEmitted: input.targetSamplesEmitted + outputLength,
      previousSourceSample: last
    };
  }

  const output = new Float32Array(outputLength);
  const sampleAt = (globalIndex: number): number => {
    if (globalIndex === startSourceIndex - 1) {
      if (input.previousSourceSample === undefined) {
        throw new Error("Microphone streaming resampler lost its boundary sample");
      }
      return input.previousSourceSample;
    }
    const localIndex = globalIndex - startSourceIndex;
    const sample = input.samples[localIndex];
    if (
      !Number.isSafeInteger(localIndex)
      || localIndex < 0
      || localIndex >= input.samples.length
      || sample === undefined
    ) {
      throw new Error("Microphone streaming resampler requested unavailable PCM");
    }
    return sample;
  };

  for (let offset = 0; offset < outputLength; offset += 1) {
    const targetIndex = input.targetSamplesEmitted + offset;
    const numerator = targetIndex * input.sourceRate;
    if (!Number.isSafeInteger(numerator)) {
      throw new Error("Microphone frame resampling size is invalid");
    }
    const leftIndex = Math.floor(numerator / input.targetRate);
    const remainder = numerator - leftIndex * input.targetRate;
    const rightIndex = remainder === 0 ? leftIndex : leftIndex + 1;
    if (rightIndex > endSourceIndex || leftIndex < startSourceIndex - 1) {
      throw new Error("Microphone streaming resampler crossed an unavailable boundary");
    }
    const left = sampleAt(leftIndex);
    const right = sampleAt(rightIndex);
    const fraction = remainder / input.targetRate;
    output[offset] = left + (right - left) * fraction;
  }

  const last = input.samples[input.samples.length - 1];
  if (last === undefined) throw new Error("Microphone frame is unexpectedly empty");
  return {
    samples: output,
    sourceRate: input.sourceRate,
    sourceSamplesSeen: endSourceIndex + 1,
    targetSamplesEmitted: input.targetSamplesEmitted + outputLength,
    previousSourceSample: last
  };
}

function finiteTimestamp(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Voice stream timestamp is invalid");
  }
  return Number(value.toFixed(6)).toString();
}

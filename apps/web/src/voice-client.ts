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
  SpeechSampleRateSchema,
  SpeechStreamIdSchema,
  SpeechWorkerEventSchema,
  type SpeechWorkerEvent
} from "../../../packages/local-compute/src/index.js";
import type { ResolvedAudioSource } from "./audio/renderer-adapter.js";
import type { AudioFrame } from "./audio/types.js";

const MAX_VOICE_RESPONSE_BYTES = 512 * 1024;
const FAILED_OPEN_CANCEL_TIMEOUT_MS = 1_000;
const MAX_WAV_ASSET_BYTES = 8 * 1024 * 1024;
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
}

export interface BrowserVoiceClientOptions {
  readonly baseUrl: string;
  readonly authenticatedFetch: typeof fetch;
}

export class BrowserVoiceStream {
  private sequence = 0;
  private timestampMs = 0;
  private closed = false;

  public constructor(
    private readonly client: BrowserVoiceClient,
    public readonly sessionId: SessionId,
    public readonly streamId: string
  ) {}

  public async sendFrame(frame: AudioFrame, signal?: AbortSignal): Promise<BrowserVoiceFrameResult> {
    if (this.closed) throw new Error("Voice stream is closed");
    if (
      frame.channelCount !== 1
      || !(frame.samples instanceof Float32Array)
      || frame.samples.length < 1
    ) {
      throw new Error("Voice transport accepts non-empty mono Float32 microphone frames only");
    }
    if (!Number.isFinite(frame.sampleRate) || frame.sampleRate <= 0) {
      throw new Error("Microphone frame sample rate is invalid");
    }
    const targetLength = resampledLength(
      frame.samples.length,
      frame.sampleRate,
      TARGET_SPEECH_SAMPLE_RATE
    );
    if (targetLength < 1 || targetLength > TARGET_SPEECH_SAMPLE_RATE / 10) {
      throw new Error("Microphone frame exceeds the bounded speech duration");
    }

    const samples = resampleMono(
      frame.samples,
      frame.sampleRate,
      TARGET_SPEECH_SAMPLE_RATE,
      targetLength
    );
    const result = await this.client.sendFrame({
      sessionId: this.sessionId,
      streamId: this.streamId,
      sequence: this.sequence,
      timestampMs: this.timestampMs,
      samples,
      ...(signal === undefined ? {} : { signal })
    });
    this.sequence += 1;
    this.timestampMs += samples.length / TARGET_SPEECH_SAMPLE_RATE * 1_000;
    if (result.terminal) this.closed = true;
    return result;
  }

  public async flush(signal?: AbortSignal): Promise<BrowserVoiceFrameResult> {
    if (this.closed) return { events: [], terminal: true };
    const result = await this.client.flush(this.sessionId, this.streamId, signal);
    if (result.terminal) this.closed = true;
    return result;
  }

  public async cancel(signal?: AbortSignal): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.cancel(this.sessionId, this.streamId, signal);
  }

  public get isClosed(): boolean {
    return this.closed;
  }
}

export class BrowserVoiceClient {
  private readonly baseUrl: string;

  public constructor(private readonly options: BrowserVoiceClientOptions) {
    this.baseUrl = exactLoopbackOrigin(options.baseUrl);
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
    if (!AUDIO_REF_PATTERN.test(audioRef)) {
      throw new Error("Renderer audio reference is not a bounded local logical reference");
    }
    const response = await this.options.authenticatedFetch(
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
      throw new Error(`Audio asset resolution failed with HTTP ${String(response.status)}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "audio/wav") {
      throw new Error("Audio asset response has an unexpected content type");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const parsed = Number(declared);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_WAV_ASSET_BYTES) {
        throw new Error("Audio asset declared size is outside the browser bound");
      }
    }
    const audioBytes = await readBoundedResponseBytes(
      response,
      MAX_WAV_ASSET_BYTES,
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
    const payload = encodeF32Le(input.samples);
    const response = await this.options.authenticatedFetch(
      `${this.baseUrl}/v1/voice/frames`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-interview-session-id": input.sessionId,
          "x-speech-stream-id": input.streamId,
          "x-speech-request-id": `request_${globalThis.crypto.randomUUID()}`,
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
    return parseVoiceFrameResponse(response);
  }

  public async flush(
    sessionId: SessionId,
    streamId: string,
    signal?: AbortSignal
  ): Promise<BrowserVoiceFrameResult> {
    const response = await this.requestJsonResponse("/v1/voice/flush", {
      protocolVersion: 1,
      sessionId,
      streamId,
      requestId: `request_${globalThis.crypto.randomUUID()}`
    }, signal);
    return parseVoiceFrameResponse(response);
  }

  public async cancel(
    sessionId: SessionId,
    streamId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const cancelled = VoiceCancelResponseSchema.parse(await this.requestJson("/v1/voice/cancel", {
      protocolVersion: 1,
      sessionId,
      streamId,
      requestId: `request_${globalThis.crypto.randomUUID()}`
    }, signal));
    if (cancelled.streamId !== streamId) {
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
    return this.options.authenticatedFetch(`${this.baseUrl}${path}`, {
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
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
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

async function parseVoiceFrameResponse(response: Response): Promise<BrowserVoiceFrameResult> {
  if (!response.ok) {
    const parsed = await parseBoundedJson(response);
    throw new Error(
      safeProtocolMessage(parsed)
      ?? `Voice transport request failed with HTTP ${String(response.status)}`
    );
  }
  const parsed = VoiceFrameResponseSchema.parse(await parseBoundedJson(response));
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
  const bytes = await readBoundedResponseBytes(
    response,
    MAX_VOICE_RESPONSE_BYTES,
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

async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  label: string
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      throw new Error(`${label} declared size is malformed`);
    }
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed > maximumBytes) {
      throw new Error(`${label} declared size exceeds the browser bound`);
    }
  }
  if (response.body === null) throw new Error(`${label} has no response body`);

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
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

function resampledLength(
  sampleCount: number,
  sourceRate: number,
  targetRate: number
): number {
  const scaled = sampleCount * targetRate / sourceRate;
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) {
    throw new Error("Microphone frame resampling size is invalid");
  }
  return Math.max(1, Math.round(scaled));
}

function resampleMono(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
  targetLength: number
): Float32Array {
  if (sourceRate === targetRate) return new Float32Array(samples);
  const output = new Float32Array(targetLength);
  if (samples.length === 1) {
    output.fill(samples[0] ?? 0);
    return output;
  }
  const scale = (samples.length - 1) / Math.max(1, targetLength - 1);
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * scale;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    const left = samples[leftIndex] ?? 0;
    const right = samples[rightIndex] ?? left;
    output[index] = left + (right - left) * fraction;
  }
  return output;
}

function finiteTimestamp(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Voice stream timestamp is invalid");
  }
  return Number(value.toFixed(6)).toString();
}

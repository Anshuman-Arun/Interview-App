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
  SpeechWorkerEventSchema,
  type SpeechWorkerEvent
} from "../../../packages/local-compute/src/index.js";
import type { ResolvedAudioSource } from "./audio/renderer-adapter.js";
import type { AudioFrame } from "./audio/types.js";

const MAX_VOICE_RESPONSE_CHARS = 512 * 1024;
const MAX_WAV_ASSET_BYTES = 8 * 1024 * 1024;
const TARGET_SPEECH_SAMPLE_RATE = 48_000 as const;
const AUDIO_REF_PATTERN = /^audio_v1_[0-9a-f]{64}$/u;

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
    if (frame.channelCount !== 1 || frame.samples.length < 1) {
      throw new Error("Voice transport accepts mono microphone frames only");
    }
    if (!Number.isFinite(frame.sampleRate) || frame.sampleRate <= 0) {
      throw new Error("Microphone frame sample rate is invalid");
    }

    const samples = resampleMono(frame.samples, frame.sampleRate, TARGET_SPEECH_SAMPLE_RATE);
    if (samples.length < 1 || samples.length > TARGET_SPEECH_SAMPLE_RATE / 10) {
      throw new Error("Microphone frame exceeds the bounded speech duration");
    }
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
    await this.requestJson("/v1/voice/streams", {
      protocolVersion: 1,
      sessionId,
      streamId,
      sampleRate: TARGET_SPEECH_SAMPLE_RATE
    }, signal);
    return new BrowserVoiceStream(this, sessionId, streamId);
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
    const blob = await response.blob();
    if (blob.size <= 0 || blob.size > MAX_WAV_ASSET_BYTES) {
      throw new Error("Audio asset body is outside the browser bound");
    }
    const urlFactory = globalThis.URL;
    if (
      typeof urlFactory?.createObjectURL !== "function"
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
    await this.requestJson("/v1/voice/cancel", {
      protocolVersion: 1,
      sessionId,
      streamId,
      requestId: `request_${globalThis.crypto.randomUUID()}`
    }, signal);
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
  const text = await response.text();
  if (text.length > MAX_VOICE_RESPONSE_CHARS) {
    throw new Error("Voice transport response exceeds the browser bound");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Voice transport response is not valid JSON");
  }
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

function resampleMono(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number
): Float32Array {
  if (sourceRate === targetRate) return new Float32Array(samples);
  const targetLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
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

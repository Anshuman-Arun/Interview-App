import type { SessionId } from "../../../packages/domain/src/index.js";
import type { AudioFrame } from "./types.js";
import type { ResolvedAudioSource } from "./renderer-adapter.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const AUDIO_REF_PATTERN = /^audio_v1_[0-9a-f]{64}$/u;
const STREAM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export interface VoiceTransportEvent {
  readonly protocolVersion: 1;
  readonly type: string;
  readonly requestId: string;
  readonly streamId: string;
  readonly utteranceId?: string;
  readonly [key: string]: unknown;
}

export interface VoiceFrameResult {
  readonly events: readonly VoiceTransportEvent[];
  readonly terminal: boolean;
  readonly commit?: {
    readonly inputEpisodeId: string;
    readonly turnId: string;
    readonly text: string;
  };
}

export interface BrowserVoiceTransportClientOptions {
  readonly baseUrl: string;
  readonly authenticatedFetch: typeof fetch;
}

export class BrowserVoiceTransportClient {
  private readonly baseUrl: string;
  private readonly authenticatedFetch: typeof fetch;

  public constructor(options: BrowserVoiceTransportClientOptions) {
    this.baseUrl = exactVoiceOrigin(options.baseUrl);
    this.authenticatedFetch = options.authenticatedFetch;
  }

  public async openStream(
    sessionId: SessionId,
    streamId: string,
    sampleRate: 16_000 | 48_000,
    signal?: AbortSignal
  ): Promise<void> {
    validateStreamId(streamId);
    await this.requestJson("/v1/voice/streams", {
      protocolVersion: 1,
      sessionId,
      streamId,
      sampleRate
    }, signal);
  }

  public async sendFrame(
    sessionId: SessionId,
    streamId: string,
    frame: AudioFrame,
    signal?: AbortSignal
  ): Promise<VoiceFrameResult> {
    validateStreamId(streamId);
    if (frame.channelCount !== 1) {
      throw new Error("Voice transport requires mono browser PCM");
    }
    if (frame.sampleRate !== 16_000 && frame.sampleRate !== 48_000) {
      throw new Error("Voice transport requires 16 kHz or 48 kHz browser PCM");
    }
    if (
      !Number.isSafeInteger(frame.sequence)
      || frame.sequence < 0
      || !Number.isFinite(frame.capturedAtMs)
      || frame.capturedAtMs < 0
      || !(frame.samples instanceof Float32Array)
      || frame.samples.length === 0
    ) {
      throw new Error("Browser PCM frame is malformed");
    }

    const samples = new Float32Array(frame.samples);
    const bytes = new Uint8Array(samples.byteLength);
    const output = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index];
      if (value === undefined || !Number.isFinite(value)) {
        throw new Error("Browser PCM frame contains a non-finite sample");
      }
      output.setFloat32(index * 4, value, true);
    }

    const requestId = newRequestId();
    const response = await this.authenticatedFetch(`${this.baseUrl}/v1/voice/frames`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-interview-session-id": sessionId,
        "x-speech-stream-id": streamId,
        "x-speech-request-id": requestId,
        "x-speech-sequence": String(frame.sequence),
        "x-speech-sample-rate": String(frame.sampleRate),
        "x-speech-frame-samples": String(samples.length),
        "x-speech-timestamp-ms": finiteTimestamp(frame.capturedAtMs)
      },
      body: bytes,
      ...(signal === undefined ? {} : { signal })
    });
    return parseVoiceFrameResult(response);
  }

  public async flush(
    sessionId: SessionId,
    streamId: string,
    signal?: AbortSignal
  ): Promise<VoiceFrameResult> {
    validateStreamId(streamId);
    const value = await this.requestJson("/v1/voice/flush", {
      protocolVersion: 1,
      sessionId,
      streamId,
      requestId: newRequestId()
    }, signal);
    return parseVoiceResultObject(value);
  }

  public async cancel(
    sessionId: SessionId,
    streamId: string,
    signal?: AbortSignal
  ): Promise<void> {
    validateStreamId(streamId);
    await this.requestJson("/v1/voice/cancel", {
      protocolVersion: 1,
      sessionId,
      streamId,
      requestId: newRequestId()
    }, signal);
  }

  public async resolveAudioSource(
    sessionId: SessionId,
    audioRef: string,
    signal: AbortSignal
  ): Promise<ResolvedAudioSource> {
    if (!AUDIO_REF_PATTERN.test(audioRef)) {
      throw new Error("Audio delivery reference is malformed");
    }
    const response = await this.authenticatedFetch(
      `${this.baseUrl}/v1/voice/audio/${encodeURIComponent(audioRef)}`,
      {
        method: "GET",
        headers: { "x-interview-session-id": sessionId },
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
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length <= 0 || length > 16 * 1024 * 1024) {
        throw new Error("Audio asset response length is invalid");
      }
    }

    const blob = await response.blob();
    if (signal.aborted) throw new DOMException("Audio asset resolution aborted", "AbortError");
    if (blob.size <= 0 || blob.size > 16 * 1024 * 1024) {
      throw new Error("Audio asset exceeds the browser playback bound");
    }
    const objectUrl = URL.createObjectURL(blob);
    let released = false;
    return {
      source: objectUrl,
      release: () => {
        if (released) return;
        released = true;
        URL.revokeObjectURL(objectUrl);
      }
    };
  }

  private async requestJson(
    path: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const response = await this.authenticatedFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal })
    });
    const text = await boundedResponseText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error("Voice transport returned malformed JSON");
    }
    if (!response.ok) {
      throw new Error(`Voice transport request failed with HTTP ${String(response.status)}`);
    }
    return parsed;
  }
}

export function deriveDefaultVoiceUrl(commandBaseUrl: string): string {
  const parsed = new URL(commandBaseUrl);
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/"
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error("Command server base URL must be an exact HTTP loopback origin");
  }
  const port = parsed.port.length === 0 ? 80 : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65533) {
    throw new Error("Command server port cannot derive a voice transport port");
  }
  parsed.port = String(port + 2);
  return parsed.origin;
}

function exactVoiceOrigin(value: string): string {
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
    throw new Error("Voice transport URL must be an exact HTTP loopback origin");
  }
  return parsed.origin;
}

function validateStreamId(value: string): void {
  if (!STREAM_ID_PATTERN.test(value)) throw new Error("Voice stream ID is invalid");
}

function newRequestId(): string {
  return `request_${globalThis.crypto.randomUUID()}`;
}

function finiteTimestamp(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Browser audio timestamp is invalid");
  }
  return String(Math.round(value * 1_000) / 1_000);
}

async function parseVoiceFrameResult(response: Response): Promise<VoiceFrameResult> {
  const text = await boundedResponseText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Voice transport returned malformed JSON");
  }
  if (!response.ok) {
    throw new Error(`Voice frame request failed with HTTP ${String(response.status)}`);
  }
  return parseVoiceResultObject(parsed);
}

function parseVoiceResultObject(value: unknown): VoiceFrameResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("Voice transport response is malformed");
  }
  const record = value as Record<string, unknown>;
  if (record["protocolVersion"] !== 1 || record["ok"] !== true || !Array.isArray(record["events"])) {
    throw new Error("Voice transport response is malformed");
  }
  const events = record["events"].map((event) => {
    if (typeof event !== "object" || event === null) {
      throw new Error("Voice transport event is malformed");
    }
    const candidate = event as Record<string, unknown>;
    if (
      candidate["protocolVersion"] !== 1
      || typeof candidate["type"] !== "string"
      || typeof candidate["requestId"] !== "string"
      || typeof candidate["streamId"] !== "string"
    ) {
      throw new Error("Voice transport event is malformed");
    }
    return { ...candidate } as VoiceTransportEvent;
  });
  const terminal = record["terminal"];
  if (typeof terminal !== "boolean") throw new Error("Voice transport terminal flag is malformed");

  const commit = record["commit"];
  if (commit === undefined) return { events, terminal };
  if (typeof commit !== "object" || commit === null) {
    throw new Error("Voice transport commit result is malformed");
  }
  const committed = commit as Record<string, unknown>;
  if (
    typeof committed["inputEpisodeId"] !== "string"
    || typeof committed["turnId"] !== "string"
    || typeof committed["text"] !== "string"
  ) {
    throw new Error("Voice transport commit result is malformed");
  }
  return {
    events,
    terminal,
    commit: {
      inputEpisodeId: committed["inputEpisodeId"],
      turnId: committed["turnId"],
      text: committed["text"]
    }
  };
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RESPONSE_BYTES) {
      throw new Error("Voice transport response exceeds its bounded size");
    }
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Voice transport response exceeds its bounded size");
  }
  return text;
}

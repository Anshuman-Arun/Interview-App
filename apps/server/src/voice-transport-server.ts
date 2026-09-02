import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  SessionIdSchema,
  newRequestId,
  type LocalTransportSecurity
} from "../../../packages/domain/src/index.js";
import {
  MAX_SPEECH_FRAME_DURATION_MS,
  SpeechPcmFrameEnvelopeSchema,
  SpeechRequestIdSchema,
  SpeechSampleRateSchema,
  SpeechStreamIdSchema
} from "../../../packages/local-compute/src/index.js";
import type {
  EphemeralAudioAssetStore,
  VoiceInputCoordinator,
  VoiceIngressResult
} from "./voice-runtime.js";

const VOICE_OPEN_PATH = "/v1/voice/streams";
const VOICE_FRAME_PATH = "/v1/voice/frames";
const VOICE_FLUSH_PATH = "/v1/voice/flush";
const VOICE_CANCEL_PATH = "/v1/voice/cancel";
const VOICE_AUDIO_PREFIX = "/v1/voice/audio/";
const MAX_CONTROL_BYTES = 4 * 1024;
const MAX_FRAME_BYTES = Math.ceil(48_000 * (MAX_SPEECH_FRAME_DURATION_MS / 1_000)) * 4;
const DEFAULT_MAX_FRAME_REQUESTS = 8;
const VOICE_HTTP_REQUEST_TIMEOUT_MS = 5_000;
const VOICE_HTTP_HEADERS_TIMEOUT_MS = 5_000;
const VOICE_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BODY_CHUNKS = 128;
const AUDIO_REF_PATTERN = /^audio_v1_[0-9a-f]{64}$/u;
const MAX_CLIENT_TOKEN_CHARACTERS = 256;
const MAX_ALLOWED_ORIGINS = 16;
const MAX_ALLOWED_ORIGIN_CHARACTERS = 2_048;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);
const LOOPBACK_ORIGIN_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "x-interview-client-token",
  "x-interview-session-id",
  "x-speech-stream-id",
  "x-speech-request-id",
  "x-speech-sequence",
  "x-speech-sample-rate",
  "x-speech-frame-samples",
  "x-speech-timestamp-ms"
]);
const CORS_ALLOW_HEADERS = [...ALLOWED_REQUEST_HEADERS].join(", ");

const OpenStreamSchema = z.object({
  protocolVersion: z.literal(1),
  sessionId: SessionIdSchema,
  streamId: SpeechStreamIdSchema,
  sampleRate: SpeechSampleRateSchema
}).strict();

const ControlSchema = z.object({
  protocolVersion: z.literal(1),
  sessionId: SessionIdSchema,
  streamId: SpeechStreamIdSchema,
  requestId: SpeechRequestIdSchema
}).strict();

export interface VoiceTransportServerOptions {
  readonly security: LocalTransportSecurity;
  readonly assets: EphemeralAudioAssetStore;
  readonly coordinator?: VoiceInputCoordinator;
  readonly port?: number;
  readonly maxFrameRequests?: number;
}

export interface BoundVoiceTransportAddress {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly url: string;
}

class VoiceHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * Dedicated authenticated binary ingress for continuous PCM. The command
 * transport remains JSON-only and bounded; PCM frames are never tunneled as
 * giant base64 command payloads.
 */
export class VoiceTransportServer {
  private readonly server: Server;
  private readonly security: LocalTransportSecurity;
  private readonly maxFrameRequests: number;
  private activeFrameRequests = 0;
  private boundAddress: BoundVoiceTransportAddress | undefined;
  private stopping = false;
  private stoppingPromise: Promise<void> | undefined;

  public constructor(private readonly options: VoiceTransportServerOptions) {
    this.security = snapshotSecurity(options.security);
    const maxFrameRequests = options.maxFrameRequests ?? DEFAULT_MAX_FRAME_REQUESTS;
    if (!Number.isSafeInteger(maxFrameRequests) || maxFrameRequests < 1 || maxFrameRequests > 64) {
      throw new Error("Voice frame concurrency limit is invalid");
    }
    this.maxFrameRequests = maxFrameRequests;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    // These deadlines bound only receipt of the local HTTP request and idle
    // keep-alive sockets. VAD/STT execution begins after the bounded body is
    // admitted and remains governed by the speech worker's own timeouts.
    this.server.requestTimeout = VOICE_HTTP_REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = VOICE_HTTP_HEADERS_TIMEOUT_MS;
    this.server.keepAliveTimeout = VOICE_HTTP_KEEP_ALIVE_TIMEOUT_MS;
  }

  public async start(): Promise<BoundVoiceTransportAddress> {
    if (this.stopping) throw new Error("Voice transport server is shutting down");
    if (this.boundAddress !== undefined) return this.boundAddress;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen({
        host: this.security.host,
        port: this.options.port ?? 0,
        exclusive: true
      }, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Voice transport server has no TCP address");
    }
    this.boundAddress = toBoundAddress(this.security.host, address);
    return this.boundAddress;
  }

  public stop(): Promise<void> {
    if (this.stoppingPromise !== undefined) return this.stoppingPromise;
    this.stopping = true;
    const stopping = this.stopFully();
    this.stoppingPromise = stopping;
    const clearSuccess = (): void => {
      if (this.stoppingPromise !== stopping) return;
      this.stoppingPromise = undefined;
      this.stopping = false;
    };
    const clearFailure = (): void => {
      if (this.stoppingPromise === stopping) this.stoppingPromise = undefined;
      // Keep the admission guard closed after an ambiguous shutdown failure.
      // A later stop() retry may complete cleanup, but start()/handle() must not
      // accept new work until that succeeds.
    };
    void stopping.then(clearSuccess, clearFailure);
    return stopping;
  }

  private async stopFully(): Promise<void> {
    if (!this.server.listening) {
      this.boundAddress = undefined;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error === undefined ? resolve() : reject(error));
    });
    this.boundAddress = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = headerValue(request, "origin");
    try {
      if (request.method === "OPTIONS") {
        this.authorizeOrigin(origin);
        const allowedMethod = allowedPreflightMethod(request.url);
        if (allowedMethod === undefined) {
          throw new VoiceHttpError(404, "NOT_FOUND", "Voice endpoint not found");
        }
        assertValidPreflight(request, allowedMethod);
        sendPreflight(response, origin, allowedMethod);
        return;
      }

      this.authorize(request, origin);
      if (this.stopping) {
        throw new VoiceHttpError(503, "SHUTTING_DOWN", "Voice transport is shutting down");
      }

      if (request.method === "GET" && request.url?.startsWith(VOICE_AUDIO_PREFIX)) {
        this.handleAudioAsset(request, response, origin);
        return;
      }

      if (request.method !== "POST") {
        throw new VoiceHttpError(404, "NOT_FOUND", "Voice endpoint not found");
      }
      if (request.url === VOICE_OPEN_PATH) {
        await this.handleOpen(request, response, origin);
        return;
      }
      if (request.url === VOICE_FRAME_PATH) {
        await this.handleFrame(request, response, origin);
        return;
      }
      if (request.url === VOICE_FLUSH_PATH) {
        await this.handleControl(request, response, origin, "FLUSH");
        return;
      }
      if (request.url === VOICE_CANCEL_PATH) {
        await this.handleControl(request, response, origin, "CANCEL");
        return;
      }
      throw new VoiceHttpError(404, "NOT_FOUND", "Voice endpoint not found");
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const classified = classifyError(error);
      sendJson(response, classified.status, {
        protocolVersion: 1,
        ok: false,
        error: { code: classified.code, message: classified.message }
      }, this.allowedOrigin(origin) ? origin : undefined);
    }
  }

  private async handleOpen(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string | undefined
  ): Promise<void> {
    const coordinator = this.requireCoordinator();
    assertJsonContentType(request);
    const body = await readBody(request, MAX_CONTROL_BYTES);
    const parsed = OpenStreamSchema.safeParse(parseJson(body));
    if (!parsed.success) throw new VoiceHttpError(400, "INVALID_CONTROL", "Voice stream request is invalid");
    let transportDropped = false;
    const markTransportDropped = (): void => {
      if (!response.writableEnded) transportDropped = true;
    };
    const onResponseClose = (): void => {
      if (!response.writableEnded) markTransportDropped();
    };
    request.once("aborted", markTransportDropped);
    response.once("close", onResponseClose);
    try {
      try {
        await coordinator.openStream(parsed.data.sessionId, parsed.data.streamId, parsed.data.sampleRate);
      } catch (error) {
        if (transportDropped) return;
        throw classifyCoordinatorError(error);
      }
      if (transportDropped || response.destroyed) {
        await coordinator.cancelStream(
          parsed.data.sessionId,
          parsed.data.streamId,
          newRequestId()
        ).catch(() => undefined);
        return;
      }
      sendJson(response, 200, {
        protocolVersion: 1,
        ok: true,
        type: "VOICE_STREAM_OPENED",
        sessionId: parsed.data.sessionId,
        streamId: parsed.data.streamId,
        sampleRate: parsed.data.sampleRate
      }, origin);
    } finally {
      request.off("aborted", markTransportDropped);
      response.off("close", onResponseClose);
    }
  }

  private async handleFrame(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string | undefined
  ): Promise<void> {
    if (this.activeFrameRequests >= this.maxFrameRequests) {
      throw new VoiceHttpError(429, "TOO_MANY_FRAMES", "Voice frame concurrency limit reached");
    }
    const coordinator = this.requireCoordinator();
    const contentType = headerValue(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/octet-stream") {
      throw new VoiceHttpError(415, "INVALID_CONTENT_TYPE", "PCM frames require application/octet-stream");
    }

    const sessionId = SessionIdSchema.safeParse(headerValue(request, "x-interview-session-id"));
    const streamId = SpeechStreamIdSchema.safeParse(headerValue(request, "x-speech-stream-id"));
    const requestId = SpeechRequestIdSchema.safeParse(headerValue(request, "x-speech-request-id"));
    const sequence = parseHeaderSafeInteger(request, "x-speech-sequence");
    const sampleRate = SpeechSampleRateSchema.safeParse(parseHeaderSafeInteger(request, "x-speech-sample-rate"));
    const frameSamples = parseHeaderSafeInteger(request, "x-speech-frame-samples");
    const timestampMs = parseHeaderFiniteNumber(request, "x-speech-timestamp-ms");
    if (!sessionId.success || !streamId.success || !requestId.success || !sampleRate.success) {
      throw new VoiceHttpError(400, "INVALID_FRAME", "PCM frame identity metadata is invalid");
    }

    const expectedBytes = frameSamples * 4;
    if (
      !Number.isSafeInteger(expectedBytes)
      || expectedBytes < 1
      || expectedBytes > MAX_FRAME_BYTES
    ) {
      throw new VoiceHttpError(413, "FRAME_TOO_LARGE", "PCM frame exceeds the transport size limit");
    }
    const declaredLength = headerValue(request, "content-length");
    if (declaredLength !== undefined) {
      const parsedLength = parseStrictNonnegativeInteger(declaredLength);
      if (parsedLength !== expectedBytes) {
        throw new VoiceHttpError(400, "INVALID_FRAME", "PCM Content-Length does not match frame metadata");
      }
    }

    let transportDropped = false;
    const cancelDroppedStream = (): void => {
      if (transportDropped || response.writableEnded) return;
      transportDropped = true;
      void coordinator.cancelStream(
        sessionId.data,
        streamId.data,
        newRequestId()
      ).catch(() => undefined);
    };
    const onResponseClose = (): void => {
      if (!response.writableEnded) cancelDroppedStream();
    };
    request.once("aborted", cancelDroppedStream);
    response.once("close", onResponseClose);

    this.activeFrameRequests += 1;
    try {
      const payload = await readBinaryBody(request, expectedBytes, expectedBytes);
      if (transportDropped) return;
      const envelope = SpeechPcmFrameEnvelopeSchema.safeParse({
        protocolVersion: 1,
        requestId: requestId.data,
        streamId: streamId.data,
        sequence,
        sampleRate: sampleRate.data,
        channels: 1,
        sampleFormat: "F32LE",
        frameSamples,
        payloadByteLength: payload.byteLength,
        timestampMs
      });
      if (!envelope.success) {
        throw new VoiceHttpError(400, "INVALID_FRAME", "PCM frame metadata failed bounded validation");
      }

      let result: VoiceIngressResult;
      try {
        result = await coordinator.submitFrame(sessionId.data, envelope.data, payload);
      } catch (error) {
        throw classifyCoordinatorError(error);
      }
      if (transportDropped || response.destroyed) return;
      sendJson(response, 200, {
        protocolVersion: 1,
        ok: true,
        type: "VOICE_FRAME_RESULT",
        events: result.events,
        terminal: result.terminal,
        ...(result.commit === undefined ? {} : { commit: result.commit })
      }, origin);
    } finally {
      request.off("aborted", cancelDroppedStream);
      response.off("close", onResponseClose);
      this.activeFrameRequests = Math.max(0, this.activeFrameRequests - 1);
    }
  }

  private async handleControl(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string | undefined,
    action: "FLUSH" | "CANCEL"
  ): Promise<void> {
    const coordinator = this.requireCoordinator();
    assertJsonContentType(request);
    const body = await readBody(request, MAX_CONTROL_BYTES);
    const parsed = ControlSchema.safeParse(parseJson(body));
    if (!parsed.success) throw new VoiceHttpError(400, "INVALID_CONTROL", "Voice control request is invalid");

    if (action === "CANCEL") {
      await coordinator.cancelStream(
        parsed.data.sessionId,
        parsed.data.streamId,
        parsed.data.requestId
      );
      sendJson(response, 200, {
        protocolVersion: 1,
        ok: true,
        type: "VOICE_STREAM_CANCELLED",
        streamId: parsed.data.streamId
      }, origin);
      return;
    }

    let transportDropped = false;
    const cancelDroppedStream = (): void => {
      if (transportDropped || response.writableEnded) return;
      transportDropped = true;
      void coordinator.cancelStream(
        parsed.data.sessionId,
        parsed.data.streamId,
        newRequestId()
      ).catch(() => undefined);
    };
    const onResponseClose = (): void => {
      if (!response.writableEnded) cancelDroppedStream();
    };
    request.once("aborted", cancelDroppedStream);
    response.once("close", onResponseClose);
    try {
      let result: VoiceIngressResult;
      try {
        result = await coordinator.flush(
          parsed.data.sessionId,
          parsed.data.streamId,
          parsed.data.requestId
        );
      } catch (error) {
        if (transportDropped) return;
        throw classifyCoordinatorError(error);
      }
      if (transportDropped || response.destroyed) return;
      sendJson(response, 200, {
        protocolVersion: 1,
        ok: true,
        type: "VOICE_FLUSH_RESULT",
        events: result.events,
        terminal: result.terminal,
        ...(result.commit === undefined ? {} : { commit: result.commit })
      }, origin);
    } finally {
      request.off("aborted", cancelDroppedStream);
      response.off("close", onResponseClose);
    }
  }

  private handleAudioAsset(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string | undefined
  ): void {
    const rawUrl = request.url ?? "";
    if (rawUrl.includes("?") || rawUrl.includes("#")) {
      throw new VoiceHttpError(404, "NOT_FOUND", "Audio asset endpoint not found");
    }
    const encodedRef = rawUrl.slice(VOICE_AUDIO_PREFIX.length);
    if (
      encodedRef.length !== 73
      || !/^audio_v1_[0-9a-f]{64}$/u.test(encodedRef)
    ) {
      throw new VoiceHttpError(404, "NOT_FOUND", "Audio asset reference is invalid");
    }
    let audioRef: string;
    try {
      audioRef = decodeURIComponent(encodedRef);
    } catch {
      throw new VoiceHttpError(404, "NOT_FOUND", "Audio asset reference is invalid");
    }
    if (audioRef !== encodedRef || !AUDIO_REF_PATTERN.test(audioRef)) {
      throw new VoiceHttpError(404, "NOT_FOUND", "Audio asset reference is invalid");
    }
    const sessionId = SessionIdSchema.safeParse(headerValue(request, "x-interview-session-id"));
    if (!sessionId.success) {
      throw new VoiceHttpError(400, "INVALID_AUDIO_REQUEST", "Audio asset session binding is invalid");
    }
    const asset = this.options.assets.take(sessionId.data, audioRef);
    if (asset === undefined) {
      throw new VoiceHttpError(404, "AUDIO_ASSET_MISSING", "Audio asset is unavailable");
    }

    response.writeHead(200, {
      "content-type": "audio/wav",
      "content-length": asset.bytes.byteLength,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(origin === undefined ? {} : {
        "access-control-allow-origin": origin,
        vary: "Origin"
      })
    });
    response.end(Buffer.from(asset.bytes));
  }

  private requireCoordinator(): VoiceInputCoordinator {
    if (this.options.coordinator === undefined) {
      throw new VoiceHttpError(
        503,
        "VOICE_RUNTIME_UNAVAILABLE",
        "Local speech/TTS model runtime has not been configured"
      );
    }
    return this.options.coordinator;
  }

  private authorize(request: IncomingMessage, origin: string | undefined): void {
    const token = headerValue(request, "x-interview-client-token");
    if (token === undefined || !constantTimeEquals(token, this.security.clientToken)) {
      throw new VoiceHttpError(401, "UNAUTHORIZED", "Client authentication failed");
    }
    this.authorizeOrigin(origin);
  }

  private authorizeOrigin(origin: string | undefined): void {
    if (origin === undefined || !this.security.allowedOrigins.has(origin)) {
      throw new VoiceHttpError(403, "ORIGIN_FORBIDDEN", "Client origin is not allowed");
    }
  }

  private allowedOrigin(origin: string | undefined): boolean {
    return origin !== undefined && this.security.allowedOrigins.has(origin);
  }
}

function snapshotSecurity(security: LocalTransportSecurity): LocalTransportSecurity {
  if (
    typeof security !== "object"
    || security === null
    || !LOOPBACK_HOSTS.has(security.host)
  ) {
    throw new Error("Voice transport may bind only to a loopback address");
  }
  if (
    typeof security.clientToken !== "string"
    || security.clientToken.length < 32
    || security.clientToken.length > MAX_CLIENT_TOKEN_CHARACTERS
    || /[\r\n]/u.test(security.clientToken)
  ) {
    throw new Error("Voice transport client token must contain between 32 and 256 safe characters");
  }
  if (!(security.allowedOrigins instanceof Set)) {
    throw new Error("Voice transport requires a Set of exact client origins");
  }

  const origins = new Set<string>();
  let iterator: IterableIterator<unknown>;
  try {
    iterator = Set.prototype.values.call(security.allowedOrigins) as IterableIterator<unknown>;
  } catch {
    throw new Error("Voice transport origin allowlist could not be inspected");
  }
  try {
    for (const rawOrigin of iterator) {
      if (origins.size >= MAX_ALLOWED_ORIGINS) {
        throw new Error("Voice transport client origin allowlist exceeds its bound");
      }
      if (
        typeof rawOrigin !== "string"
        || rawOrigin.length === 0
        || rawOrigin.length > MAX_ALLOWED_ORIGIN_CHARACTERS
      ) {
        throw new Error("Voice allowed origin is invalid or exceeds its bounded length");
      }
      let parsed: URL;
      try {
        parsed = new URL(rawOrigin);
      } catch {
        throw new Error("Voice allowed origin is not a valid URL origin");
      }
      if (
        parsed.origin !== rawOrigin
        || parsed.protocol !== "http:"
        || !LOOPBACK_ORIGIN_HOSTS.has(parsed.hostname)
        || parsed.username.length > 0
        || parsed.password.length > 0
      ) {
        throw new Error("Voice allowed origins must be exact HTTP loopback origins");
      }
      origins.add(rawOrigin);
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Voice transport origin allowlist could not be inspected");
  }
  if (origins.size === 0) {
    throw new Error("Voice transport requires at least one exact client origin");
  }

  return Object.freeze({
    host: security.host,
    clientToken: security.clientToken,
    allowedOrigins: origins
  });
}

function assertJsonContentType(request: IncomingMessage): void {
  const contentType = headerValue(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new VoiceHttpError(415, "INVALID_CONTENT_TYPE", "Voice control requests require application/json");
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new VoiceHttpError(400, "INVALID_CONTROL", "Voice control body is not valid JSON");
  }
}

function parseHeaderSafeInteger(request: IncomingMessage, name: string): number {
  const value = headerValue(request, name);
  if (value === undefined) throw new VoiceHttpError(400, "INVALID_FRAME", `Missing ${name} header`);
  return parseStrictNonnegativeInteger(value);
}

function parseStrictNonnegativeInteger(value: string): number {
  if (value.length === 0 || value.length > 16 || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new VoiceHttpError(400, "INVALID_FRAME", "PCM numeric header is malformed");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new VoiceHttpError(400, "INVALID_FRAME", "PCM numeric header exceeds the safe integer range");
  }
  return parsed;
}

function parseHeaderFiniteNumber(request: IncomingMessage, name: string): number {
  const value = headerValue(request, name);
  if (
    value === undefined
    || value.length === 0
    || value.length > 32
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)
  ) {
    throw new VoiceHttpError(400, "INVALID_FRAME", `Invalid ${name} header`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new VoiceHttpError(400, "INVALID_FRAME", `Invalid ${name} header`);
  }
  return parsed;
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
  const bytes = await readBinaryBody(request, maximumBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new VoiceHttpError(400, "INVALID_CONTROL", "Voice control body is not valid UTF-8");
  }
}

async function readBinaryBody(
  request: IncomingMessage,
  maximumBytes: number,
  exactBytes?: number
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  let chunkCount = 0;
  for await (const chunk of request) {
    chunkCount += 1;
    if (chunkCount > MAX_REQUEST_BODY_CHUNKS) {
      throw new VoiceHttpError(413, "BODY_TOO_FRAGMENTED", "Voice request body exceeds its chunk bound");
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > maximumBytes) {
      throw new VoiceHttpError(413, "BODY_TOO_LARGE", "Voice request body exceeds its bounded size");
    }
    chunks.push(buffer);
  }
  if (exactBytes !== undefined && total !== exactBytes) {
    throw new VoiceHttpError(400, "INVALID_FRAME", "PCM body length does not match frame metadata");
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function constantTimeEquals(received: string, expected: string): boolean {
  if (received.length > MAX_CLIENT_TOKEN_CHARACTERS || received.length !== expected.length) {
    return false;
  }
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function allowedPreflightMethod(rawUrl: string | undefined): "GET" | "POST" | undefined {
  if (
    rawUrl === VOICE_OPEN_PATH
    || rawUrl === VOICE_FRAME_PATH
    || rawUrl === VOICE_FLUSH_PATH
    || rawUrl === VOICE_CANCEL_PATH
  ) {
    return "POST";
  }
  if (
    rawUrl === undefined
    || rawUrl.includes("?")
    || rawUrl.includes("#")
    || !rawUrl.startsWith(VOICE_AUDIO_PREFIX)
  ) return undefined;
  const encodedRef = rawUrl.slice(VOICE_AUDIO_PREFIX.length);
  if (
    encodedRef.length !== 73
    || !/^audio_v1_[0-9a-f]{64}$/u.test(encodedRef)
  ) return undefined;
  return "GET";
}

function assertValidPreflight(
  request: IncomingMessage,
  allowedMethod: "GET" | "POST"
): void {
  const requestedMethod = headerValue(request, "access-control-request-method")?.trim().toUpperCase();
  if (requestedMethod !== allowedMethod) {
    throw new VoiceHttpError(400, "INVALID_PREFLIGHT", "Voice preflight method does not match the endpoint");
  }
  const requestedHeaders = headerValue(request, "access-control-request-headers");
  if (requestedHeaders === undefined || requestedHeaders.trim().length === 0) return;
  if (requestedHeaders.length > 1_024) {
    throw new VoiceHttpError(400, "INVALID_PREFLIGHT", "Voice preflight header list exceeds its bound");
  }
  const headers = requestedHeaders.split(",");
  if (headers.length > ALLOWED_REQUEST_HEADERS.size) {
    throw new VoiceHttpError(400, "INVALID_PREFLIGHT", "Voice preflight requested too many headers");
  }
  for (const header of headers) {
    const normalized = header.trim().toLowerCase();
    if (normalized.length === 0 || !ALLOWED_REQUEST_HEADERS.has(normalized)) {
      throw new VoiceHttpError(400, "INVALID_PREFLIGHT", "Voice preflight requested an unsupported header");
    }
  }
}

function sendPreflight(
  response: ServerResponse,
  origin: string | undefined,
  allowedMethod: "GET" | "POST"
): void {
  if (origin === undefined) throw new Error("Authorized voice preflight is missing Origin");
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": allowedMethod,
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-max-age": "300",
    "cache-control": "no-store",
    "content-length": "0",
    vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
  });
  response.end();
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string
): void {
  const json = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  if (origin !== undefined) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(json);
}

function classifyCoordinatorError(error: unknown): VoiceHttpError {
  if (error instanceof VoiceHttpError) return error;
  const message = error instanceof Error ? error.message : "";
  if (
    message.includes("sequence")
    || message.includes("frame")
    || message.includes("PCM")
  ) {
    return new VoiceHttpError(409, "FRAME_CONFLICT", "PCM frame conflicts with current speech stream state");
  }
  if (message.includes("already has") || message.includes("conflicts")) {
    return new VoiceHttpError(409, "STREAM_CONFLICT", "Speech stream conflicts with current session state");
  }
  if (message.includes("concurrency limit")) {
    return new VoiceHttpError(429, "TOO_MANY_STREAMS", "Speech stream concurrency limit reached");
  }
  if (message.includes("not bound") || message.includes("does not exist")) {
    return new VoiceHttpError(404, "STREAM_NOT_FOUND", "Speech stream is unavailable");
  }
  if (message.includes("active authoritative session")) {
    return new VoiceHttpError(409, "SESSION_INACTIVE", "Authoritative session is not active");
  }
  return new VoiceHttpError(500, "VOICE_RUNTIME_ERROR", "Voice runtime operation failed");
}

function classifyError(error: unknown): VoiceHttpError {
  if (error instanceof VoiceHttpError) return error;
  return new VoiceHttpError(500, "INTERNAL_ERROR", "Voice transport request could not be completed");
}

function toBoundAddress(
  host: "127.0.0.1" | "::1",
  address: AddressInfo
): BoundVoiceTransportAddress {
  const bracketed = host === "::1" ? `[${host}]` : host;
  return { host, port: address.port, url: `http://${bracketed}:${String(address.port)}` };
}

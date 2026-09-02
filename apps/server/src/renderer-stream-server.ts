import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  DeliveryId,
  DeliveryStatus,
  LocalTransportSecurity,
  SessionId
} from "../../../packages/domain/src/index.js";
import {
  DeliveryCoordinator,
  MAX_RENDERER_STREAM_ATTACH_BYTES,
  MAX_RENDERER_STREAM_MESSAGE_BYTES,
  RendererStreamAttachRequestSchema,
  RendererStreamDeliveryCommandSchema,
  RendererStreamDeliveryIdSchema,
  RendererStreamErrorResponseSchema,
  RendererStreamMessageSchema,
  RendererStreamSessionIdSchema,
  type RendererStreamErrorResponse
} from "../../../packages/delivery/src/index.js";
import {
  createCommandEnvelope
} from "../../../packages/interview-engine/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);
const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_MAX_CONNECTIONS_PER_SESSION = 1;
const RENDERER_DRAIN_TIMEOUT_MS = 2_000;

export interface RendererStreamServerOptions {
  readonly security: LocalTransportSecurity;
  readonly sessions: SessionRecoveryCoordinator;
  readonly port?: number;
  readonly maxConnections?: number;
  readonly maxConnectionsPerSession?: number;
  readonly maxMessageBytes?: number;
  readonly audioAssetAvailable?: (sessionId: SessionId, audioRef: string) => boolean;
  readonly onDeliverySent?: (sessionId: SessionId, deliveryId: DeliveryId) => void | Promise<void>;
}

export interface BoundRendererStreamAddress {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly url: string;
  readonly streamUrl: string;
}

export type RendererStreamPublishResult =
  | {
    readonly outcome: "SENT";
    readonly deliveryId: DeliveryId;
    readonly status: "DELIVERING";
  }
  | {
    readonly outcome: "NO_CLIENT";
    readonly deliveryId: DeliveryId;
  }
  | {
    readonly outcome: "NOT_DELIVERABLE";
    readonly deliveryId: DeliveryId;
    readonly status: DeliveryStatus;
  }
  | {
    readonly outcome: "MESSAGE_TOO_LARGE";
    readonly deliveryId: DeliveryId;
    readonly status: DeliveryStatus;
  };

interface ActiveConnection {
  readonly sessionId: SessionId;
  readonly response: ServerResponse;
  readonly sentDeliveryIds: Set<DeliveryId>;
}

class RendererStreamHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: RendererStreamErrorResponse["error"]["code"],
    message: string
  ) {
    super(message);
  }
}

export class RendererStreamServer {
  private readonly server: Server;
  private readonly connections = new Map<SessionId, Set<ActiveConnection>>();
  private readonly maxConnections: number;
  private readonly maxConnectionsPerSession: number;
  private readonly maxMessageBytes: number;
  private readonly publicationTails = new Map<SessionId, Promise<void>>();
  private readonly disconnectClassifications = new Map<SessionId, Promise<void>>();
  private connectionCount = 0;
  private boundAddress: BoundRendererStreamAddress | undefined;
  private stoppingRequested = false;
  private stoppingPromise: Promise<void> | undefined;

  public constructor(private readonly options: RendererStreamServerOptions) {
    validateSecurity(options.security);
    this.maxConnections = positiveInteger(options.maxConnections ?? DEFAULT_MAX_CONNECTIONS, "maxConnections");
    this.maxConnectionsPerSession = positiveInteger(
      options.maxConnectionsPerSession ?? DEFAULT_MAX_CONNECTIONS_PER_SESSION,
      "maxConnectionsPerSession"
    );
    this.maxMessageBytes = positiveInteger(
      options.maxMessageBytes ?? MAX_RENDERER_STREAM_MESSAGE_BYTES,
      "maxMessageBytes"
    );
    if (this.maxMessageBytes > MAX_RENDERER_STREAM_MESSAGE_BYTES) {
      throw new Error("Renderer stream message bound may not exceed the protocol maximum");
    }

    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  public async start(): Promise<BoundRendererStreamAddress> {
    if (this.stoppingRequested) {
      throw new Error("Renderer stream server is shutting down");
    }
    if (this.boundAddress !== undefined) return this.boundAddress;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen({
        host: this.options.security.host,
        port: this.options.port ?? 0,
        exclusive: true
      }, () => {
        this.server.off("error", onError);
        resolve();
      });
    });

    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Renderer stream server has no TCP address");
    }
    this.boundAddress = toBoundAddress(this.options.security.host, address);
    return this.boundAddress;
  }

  public stop(): Promise<void> {
    if (this.stoppingPromise !== undefined) return this.stoppingPromise;

    this.stoppingRequested = true;
    const stopping = this.stopFully();
    this.stoppingPromise = stopping;
    const clearSuccess = (): void => {
      if (this.stoppingPromise !== stopping) return;
      this.stoppingPromise = undefined;
      this.stoppingRequested = false;
    };
    const clearFailure = (): void => {
      if (this.stoppingPromise === stopping) {
        this.stoppingPromise = undefined;
      }
      // Keep stoppingRequested true after a failed shutdown. A retry may finish
      // cleanup, but new delivery/attach work must not enter an ambiguous server.
    };
    void stopping.then(clearSuccess, clearFailure);
    return stopping;
  }

  private async stopFully(): Promise<void> {
    // Publications admitted before shutdown own renderer connection state.
    // Drain them before disconnect classification so every delivery they start
    // is included in the uncertainty pass below.
    await Promise.all([...this.publicationTails.values()]);

    const activeConnections = [...this.connections.values()].flatMap((set) => [...set]);
    for (const connection of activeConnections) {
      if (!connection.response.destroyed) connection.response.end();
      this.removeConnection(connection);
    }

    const classificationResults = await Promise.allSettled(
      [...this.disconnectClassifications.values()]
    );
    const classificationFailures = classificationResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result): unknown => result.reason as unknown);

    this.connections.clear();
    this.connectionCount = 0;

    let closeFailure: unknown;
    if (this.server.listening) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server.close((error) => error === undefined ? resolve() : reject(error));
        });
        this.boundAddress = undefined;
      } catch (error) {
        closeFailure = error;
      }
    } else {
      this.boundAddress = undefined;
    }

    const failures: unknown[] = [
      ...classificationFailures,
      ...(closeFailure === undefined ? [] : [closeFailure])
    ];
    if (failures.length > 0) {
      throw new AggregateError(failures, "Renderer stream shutdown failed");
    }
  }

  public activeConnectionCount(): number {
    return this.connectionCount;
  }

  public async publishDelivery(
    sessionIdInput: SessionId,
    deliveryIdInput: DeliveryId
  ): Promise<RendererStreamPublishResult> {
    if (this.stoppingRequested) {
      throw new Error("Renderer stream server is shutting down");
    }
    const sessionId = RendererStreamSessionIdSchema.parse(sessionIdInput);
    const deliveryId = RendererStreamDeliveryIdSchema.parse(deliveryIdInput);
    const result = await this.serializePublication(sessionId, async () =>
      this.publishDeliveryNow(sessionId, deliveryId)
    );
    if (result.outcome === "SENT" && this.options.onDeliverySent !== undefined) {
      try {
        await this.options.onDeliverySent(sessionId, deliveryId);
      } catch {
        // Post-publication work such as TTS may fail closed without changing
        // the already-authoritative delivery transition.
      }
    }
    return result;
  }

  private async publishDeliveryNow(
    sessionId: SessionId,
    deliveryId: DeliveryId
  ): Promise<RendererStreamPublishResult> {
    const connection = this.firstLiveConnection(sessionId);

    if (connection === undefined) {
      return { outcome: "NO_CLIENT", deliveryId };
    }

    const writer = this.options.sessions.getWriter(sessionId);
    await this.options.sessions.ensureRecovered(sessionId);

    const atom = writer.getState().deliveries[deliveryId];
    if (atom === undefined) {
      throw new Error("Renderer stream publish referenced an unknown delivery");
    }

    if (atom.status !== "QUEUED" && atom.status !== "DELIVERING") {
      return { outcome: "NOT_DELIVERABLE", deliveryId, status: atom.status };
    }

    if (
      atom.content.medium === "AUDIO"
      && this.options.audioAssetAvailable !== undefined
      && !safelyCheckAudioAsset(
        this.options.audioAssetAvailable,
        sessionId,
        atom.content.audioRef
      )
    ) {
      const deliveries = new DeliveryCoordinator(writer);
      if (atom.status === "QUEUED") {
        await deliveries.cancelBeforeExposure(
          deliveryId,
          "Ephemeral audio asset is unavailable before physical delivery"
        );
        return { outcome: "NOT_DELIVERABLE", deliveryId, status: "CANCELLED" };
      }
      await deliveries.markPossiblyExposed(
        deliveryId,
        "Audio delivery began but its ephemeral asset is unavailable for safe replay"
      );
      return { outcome: "NOT_DELIVERABLE", deliveryId, status: "POSSIBLY_EXPOSED" };
    }

    if (atom.status === "DELIVERING" && connection.sentDeliveryIds.has(deliveryId)) {
      return { outcome: "SENT", deliveryId, status: "DELIVERING" };
    }

    const previewCommand = RendererStreamDeliveryCommandSchema.parse({
      deliveryId,
      content: atom.content
    });
    const previewMessage = RendererStreamMessageSchema.parse({
      protocolVersion: 1,
      type: "DELIVERY_COMMAND",
      command: previewCommand
    });

    if (sseByteLength(previewMessage) > this.maxMessageBytes) {
      return { outcome: "MESSAGE_TOO_LARGE", deliveryId, status: atom.status };
    }

    if (rendererConnectionClosed(connection.response)) {
      this.removeConnection(connection);
      return { outcome: "NO_CLIENT", deliveryId };
    }

    connection.sentDeliveryIds.add(deliveryId);
    try {
      const envelope = createCommandEnvelope({
        sessionId,
        producer: "renderer-stream-transport"
      });
      const reconnected = await new DeliveryCoordinator(writer).reconnect(deliveryId, envelope);
      if (reconnected.command === undefined) {
        connection.sentDeliveryIds.delete(deliveryId);
        return { outcome: "NOT_DELIVERABLE", deliveryId, status: reconnected.status };
      }

      const message = RendererStreamMessageSchema.parse({
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command: reconnected.command
      });
      const wire = encodeSse(message);
      if (Buffer.byteLength(wire, "utf8") > this.maxMessageBytes) {
        connection.sentDeliveryIds.delete(deliveryId);
        return { outcome: "MESSAGE_TOO_LARGE", deliveryId, status: reconnected.status };
      }

      // reconnect() persists DELIVERING before this transport performs the
      // physical write. Another authority transition (notably
      // beginUtterance()) may run while reconnect() is awaited. Re-read the
      // authoritative atom with no further await before response.write(), so a
      // delivery invalidated in that gap can never begin physical exposure.
      const beforePhysicalWrite = writer.getState().deliveries[deliveryId];
      if (beforePhysicalWrite === undefined) {
        connection.sentDeliveryIds.delete(deliveryId);
        throw new Error("Renderer delivery disappeared before physical write");
      }
      if (beforePhysicalWrite.status !== "DELIVERING") {
        connection.sentDeliveryIds.delete(deliveryId);
        return {
          outcome: "NOT_DELIVERABLE",
          deliveryId,
          status: beforePhysicalWrite.status
        };
      }
      if (rendererConnectionClosed(connection.response)) {
        this.removeConnection(connection);
        return { outcome: "NO_CLIENT", deliveryId };
      }

      let acceptedWithoutBackpressure: boolean;
      try {
        acceptedWithoutBackpressure = connection.response.write(wire);
      } catch {
        await new DeliveryCoordinator(writer).markPossiblyExposed(
          deliveryId,
          "Renderer write failed after physical delivery became uncertain"
        );
        this.removeConnection(connection);
        return {
          outcome: "NOT_DELIVERABLE",
          deliveryId,
          status: "POSSIBLY_EXPOSED"
        };
      }
      if (!acceptedWithoutBackpressure) {
        const drained = await waitForRendererDrain(connection.response);
        if (!drained) {
          if (!connection.response.destroyed) connection.response.destroy();
          this.removeConnection(connection);
        }
      }
      return { outcome: "SENT", deliveryId, status: "DELIVERING" };
    } catch (error) {
      if (writer.getState().deliveries[deliveryId]?.status !== "DELIVERING") {
        connection.sentDeliveryIds.delete(deliveryId);
      }
      throw error;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = headerValue(request, "origin");

    try {
      if (request.method === "OPTIONS" && request.url === "/v1/renderer-stream") {
        this.authorizeOrigin(origin);
        sendPreflight(response, origin);
        return;
      }

      this.authorize(request, origin);
      if (request.method !== "POST" || request.url !== "/v1/renderer-stream") {
        throw new RendererStreamHttpError(404, "NOT_FOUND", "Endpoint not found");
      }

      const contentType = headerValue(request, "content-type");
      if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new RendererStreamHttpError(
          415,
          "INVALID_CONTENT_TYPE",
          "Content-Type must be application/json"
        );
      }

      const attach = parseAttachRequest(await readBody(request));
      if (!this.options.sessions.hasSession(attach.sessionId)) {
        throw new RendererStreamHttpError(404, "NOT_FOUND", "Session not found");
      }
      this.assertConnectionCapacity(attach.sessionId);

      await this.awaitDisconnectClassification(attach.sessionId);
      await this.options.sessions.ensureRecovered(attach.sessionId);
      if (this.stoppingRequested) {
        throw new RendererStreamHttpError(
          503,
          "INTERNAL_ERROR",
          "Renderer stream server is shutting down"
        );
      }
      await this.attach(response, attach.sessionId, origin);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const classified = classifyError(error);
      sendJsonError(response, classified, this.allowedOrigin(origin) ? origin : undefined);
    }
  }

  private async attach(
    response: ServerResponse,
    sessionId: SessionId,
    origin: string | undefined
  ): Promise<void> {
    if (origin === undefined) throw new Error("Authorized renderer stream is missing Origin");
    // Recovery/classification above may yield. Re-check immediately before
    // headers + connection insertion so concurrent attaches cannot both pass
    // an earlier capacity snapshot.
    this.assertConnectionCapacity(sessionId);

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": origin,
      vary: "Origin"
    });
    response.flushHeaders();

    const connection: ActiveConnection = { sessionId, response, sentDeliveryIds: new Set() };
    const sessionConnections = this.connections.get(sessionId) ?? new Set<ActiveConnection>();
    sessionConnections.add(connection);
    this.connections.set(sessionId, sessionConnections);
    this.connectionCount += 1;

    let removed = false;
    const cleanup = (): void => {
      if (removed) return;
      removed = true;
      this.removeConnection(connection);
    };
    response.once("close", cleanup);
    response.once("finish", cleanup);

    await this.drainQueuedDeliveries(connection);
  }

  private assertConnectionCapacity(sessionId: SessionId): void {
    if (this.connectionCount >= this.maxConnections) {
      throw new RendererStreamHttpError(
        429,
        "TOO_MANY_CONNECTIONS",
        "Renderer stream connection limit reached"
      );
    }
    const sessionConnections = this.connections.get(sessionId);
    if ((sessionConnections?.size ?? 0) >= this.maxConnectionsPerSession) {
      throw new RendererStreamHttpError(
        409,
        "TOO_MANY_CONNECTIONS",
        "Renderer stream session already has the maximum number of clients"
      );
    }
  }

  private firstLiveConnection(sessionId: SessionId): ActiveConnection | undefined {
    const set = this.connections.get(sessionId);
    if (set === undefined) return undefined;
    for (const connection of set) {
      if (!connection.response.destroyed && !connection.response.writableEnded) return connection;
      this.removeConnection(connection);
    }
    return undefined;
  }

  private removeConnection(connection: ActiveConnection): void {
    const set = this.connections.get(connection.sessionId);
    if (set === undefined || !set.delete(connection)) return;
    this.connectionCount = Math.max(0, this.connectionCount - 1);
    if (set.size === 0) this.connections.delete(connection.sessionId);

    const previous = this.disconnectClassifications.get(connection.sessionId);
    const classification = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => this.classifyUncertainDisconnect(connection));
    this.disconnectClassifications.set(connection.sessionId, classification);
    void classification.catch(() => undefined);
    const clearClassification = (): void => {
      if (this.disconnectClassifications.get(connection.sessionId) === classification) {
        this.disconnectClassifications.delete(connection.sessionId);
      }
    };
    void classification.then(clearClassification, clearClassification);
  }

  private async classifyUncertainDisconnect(connection: ActiveConnection): Promise<void> {
    if (connection.sentDeliveryIds.size === 0) return;
    const writer = this.options.sessions.getWriter(connection.sessionId);
    const deliveries = new DeliveryCoordinator(writer);
    for (const deliveryId of connection.sentDeliveryIds) {
      await deliveries.markPossiblyExposed(
        deliveryId,
        "Renderer connection ended after the delivery command may have been observed"
      );
    }
  }

  private async awaitDisconnectClassification(sessionId: SessionId): Promise<void> {
    await this.disconnectClassifications.get(sessionId);
  }

  private async drainQueuedDeliveries(connection: ActiveConnection): Promise<void> {
    const writer = this.options.sessions.getWriter(connection.sessionId);
    const queuedDeliveryIds = Object.values(writer.getState().deliveries)
      .filter((atom) => atom.status === "QUEUED")
      .map((atom) => atom.deliveryId);
    for (const deliveryId of queuedDeliveryIds) {
      if (connection.response.destroyed || connection.response.writableEnded) return;
      await this.publishDelivery(connection.sessionId, deliveryId);
    }
  }

  private serializePublication<TResult>(
    sessionId: SessionId,
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    const previous = this.publicationTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.publicationTails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.publicationTails.get(sessionId) === tail) {
        this.publicationTails.delete(sessionId);
      }
    });
    return result;
  }

  private authorize(request: IncomingMessage, origin: string | undefined): void {
    const token = headerValue(request, "x-interview-client-token");
    if (token === undefined || !constantTimeEquals(token, this.options.security.clientToken)) {
      throw new RendererStreamHttpError(401, "UNAUTHORIZED", "Client authentication failed");
    }
    this.authorizeOrigin(origin);
  }

  private authorizeOrigin(origin: string | undefined): void {
    if (origin === undefined || !this.options.security.allowedOrigins.has(origin)) {
      throw new RendererStreamHttpError(403, "ORIGIN_FORBIDDEN", "Client origin is not allowed");
    }
  }

  private allowedOrigin(origin: string | undefined): boolean {
    return origin !== undefined && this.options.security.allowedOrigins.has(origin);
  }

}

function validateSecurity(security: LocalTransportSecurity): void {
  if (!LOOPBACK_HOSTS.has(security.host)) {
    throw new Error("Renderer stream server may bind only to a loopback address");
  }
  if (
    typeof security.clientToken !== "string"
    || security.clientToken.length < 32
    || /[\r\n]/u.test(security.clientToken)
  ) {
    throw new Error("Client token must contain at least 32 characters");
  }
  if (security.allowedOrigins.size === 0) {
    throw new Error("At least one exact client origin is required");
  }
  for (const origin of security.allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) {
      throw new Error("Allowed origins must be exact URL origins without paths");
    }
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function toBoundAddress(
  host: "127.0.0.1" | "::1",
  address: AddressInfo
): BoundRendererStreamAddress {
  const bracketedHost = host === "::1" ? `[${host}]` : host;
  const url = `http://${bracketedHost}:${String(address.port)}`;
  return {
    host,
    port: address.port,
    url,
    streamUrl: `${url}/v1/renderer-stream`
  };
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function constantTimeEquals(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length
    && timingSafeEqual(receivedBytes, expectedBytes);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_RENDERER_STREAM_ATTACH_BYTES) {
      throw new RendererStreamHttpError(
        413,
        "BODY_TOO_LARGE",
        "Renderer stream request exceeds the size limit"
      );
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseAttachRequest(body: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new RendererStreamHttpError(
      400,
      "INVALID_STREAM_REQUEST",
      "Renderer stream request is not valid JSON"
    );
  }

  const result = RendererStreamAttachRequestSchema.safeParse(parsed);
  if (!result.success) {
    throw new RendererStreamHttpError(
      400,
      "INVALID_STREAM_REQUEST",
      "Renderer stream request does not match protocol version 1"
    );
  }
  return result.data;
}

function encodeSse(message: ReturnType<typeof RendererStreamMessageSchema.parse>): string {
  return `event: delivery\ndata: ${JSON.stringify(message)}\n\n`;
}

function sseByteLength(message: ReturnType<typeof RendererStreamMessageSchema.parse>): number {
  return Buffer.byteLength(encodeSse(message), "utf8");
}

function classifyError(error: unknown): RendererStreamHttpError {
  if (error instanceof RendererStreamHttpError) return error;
  return new RendererStreamHttpError(500, "INTERNAL_ERROR", "Renderer stream request could not be completed");
}

function sendPreflight(response: ServerResponse, origin: string | undefined): void {
  if (origin === undefined) throw new Error("Allowed preflight is missing Origin");
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-interview-client-token",
    "access-control-max-age": "300",
    "cache-control": "no-store",
    vary: "Origin"
  });
  response.end();
}

function sendJsonError(
  response: ServerResponse,
  error: RendererStreamHttpError,
  origin: string | undefined
): void {
  const body = RendererStreamErrorResponseSchema.parse({
    protocolVersion: 1,
    ok: false,
    error: {
      code: error.code,
      message: error.message
    }
  });
  const json = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(json),
    "x-content-type-options": "nosniff"
  };
  if (origin !== undefined) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  response.writeHead(error.status, headers);
  response.end(json);
}

function waitForRendererDrain(response: ServerResponse): Promise<boolean> {
  if (rendererConnectionClosed(response)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (drained: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      resolve(drained);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const onError = (): void => finish(false);
    const timer = setTimeout(() => finish(false), RENDERER_DRAIN_TIMEOUT_MS);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

function rendererConnectionClosed(response: ServerResponse): boolean {
  return response.destroyed || response.writableEnded;
}

function safelyCheckAudioAsset(
  check: (sessionId: SessionId, audioRef: string) => boolean,
  sessionId: SessionId,
  audioRef: string
): boolean {
  try {
    return check(sessionId, audioRef);
  } catch {
    return false;
  }
}

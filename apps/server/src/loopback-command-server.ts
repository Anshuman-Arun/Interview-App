import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ClientCommandSchema,
  ProtocolErrorResponseSchema,
  ProtocolSuccessResponseSchema,
  type ClientCommand,
  type LocalTransportSecurity,
  type ProtocolErrorResponse,
  type ProtocolSuccessResponse
} from "../../../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../../../packages/delivery/src/index.js";
import {
  TurnCoordinator,
  createCommandEnvelope
} from "../../../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../../../packages/problems/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";
import type { ServerTurnOrchestrator } from "./turn-orchestrator.js";

const MAX_COMMAND_BYTES = 64 * 1024;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);
const COMMAND_PATH = "/v1/commands";
const CORS_ALLOWED_METHOD = "POST";
const CORS_ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "x-interview-client-token"
]);
const CORS_ALLOW_HEADERS = "content-type, x-interview-client-token";

export interface LoopbackCommandServerOptions {
  readonly security: LocalTransportSecurity;
  readonly sessions: SessionRecoveryCoordinator;
  readonly orchestrator?: ServerTurnOrchestrator;
  readonly port?: number;
}

export interface BoundLoopbackAddress {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly url: string;
}

class ProtocolHttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: ProtocolErrorResponse["error"]["code"],
    message: string
  ) {
    super(message);
  }
}

export class LoopbackCommandServer {
  private readonly server: Server;
  private boundAddress: BoundLoopbackAddress | undefined;

  public constructor(private readonly options: LoopbackCommandServerOptions) {
    if (!LOOPBACK_HOSTS.has(options.security.host)) {
      throw new Error("The command server may bind only to a loopback address");
    }
    if (options.security.clientToken.length < 32) throw new Error("Client token must contain at least 32 characters");
    if (options.security.allowedOrigins.size === 0) throw new Error("At least one exact client origin is required");
    for (const origin of options.security.allowedOrigins) {
      const parsed = new URL(origin);
      if (parsed.origin !== origin) throw new Error("Allowed origins must be exact URL origins without paths");
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  public async start(): Promise<BoundLoopbackAddress> {
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
    if (address === null || typeof address === "string") throw new Error("Loopback server has no TCP address");
    this.boundAddress = toBoundAddress(this.options.security.host, address);
    return this.boundAddress;
  }

  public async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error === undefined ? resolve() : reject(error));
    });
    this.boundAddress = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = headerValue(request, "origin");
    try {
      if (request.method === "OPTIONS" && request.url === COMMAND_PATH) {
        this.authorizeOrigin(origin);
        assertValidPreflight(request);
        sendPreflight(response, origin);
        return;
      }
      this.authorize(request, origin);
      if (request.method !== "POST" || request.url !== COMMAND_PATH) {
        throw new ProtocolHttpError(404, "NOT_FOUND", "Endpoint not found");
      }
      const contentType = headerValue(request, "content-type");
      if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new ProtocolHttpError(415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json");
      }
      const command = parseCommand(await readBody(request));
      const result = await this.dispatch(command);
      sendJson(response, 200, ProtocolSuccessResponseSchema.parse(result), origin);
    } catch (error) {
      const protocolError = classifyError(error);
      sendJson(response, protocolError.status, ProtocolErrorResponseSchema.parse({
        protocolVersion: 1,
        ok: false,
        error: { code: protocolError.code, message: protocolError.message }
      }), this.allowedOrigin(origin) ? origin : undefined);
    }
  }

  private authorize(request: IncomingMessage, origin: string | undefined): void {
    const token = headerValue(request, "x-interview-client-token");
    if (token === undefined || !constantTimeEquals(token, this.options.security.clientToken)) {
      throw new ProtocolHttpError(401, "UNAUTHORIZED", "Client authentication failed");
    }
    this.authorizeOrigin(origin);
  }

  private authorizeOrigin(origin: string | undefined): void {
    if (origin === undefined || !this.options.security.allowedOrigins.has(origin)) {
      throw new ProtocolHttpError(403, "ORIGIN_FORBIDDEN", "Client origin is not allowed");
    }
  }

  private allowedOrigin(origin: string | undefined): boolean {
    return origin !== undefined && this.options.security.allowedOrigins.has(origin);
  }

  private async dispatch(command: ClientCommand): Promise<ProtocolSuccessResponse> {
    const writer = this.options.sessions.getWriter(command.sessionId);
    await this.options.sessions.ensureRecovered(command.sessionId);
    const envelope = createCommandEnvelope({
      sessionId: command.sessionId,
      requestId: command.requestId,
      producer: "authenticated-local-client"
    });
    switch (command.type) {
      case "START_SESSION": {
        await new TurnCoordinator(writer).startSession(sixPeopleProblem, envelope);
        return {
          protocolVersion: 1,
          ok: true,
          type: "SESSION_STARTED",
          requestId: command.requestId,
          sessionId: command.sessionId
        };
      }
      case "COMMIT_TYPED_INPUT": {
        const committed = await new TurnCoordinator(writer).commitInput(command.text, envelope);
        if (this.options.orchestrator !== undefined) {
          void this.options.orchestrator.orchestrateTurn({
            sessionId: command.sessionId,
            turnId: committed.turnId,
            inputEpisodeId: committed.inputEpisodeId,
            studentText: command.text
          }).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Turn orchestration error: ${message}`);
          });
        }
        return {
          protocolVersion: 1,
          ok: true,
          type: "INPUT_COMMITTED",
          requestId: command.requestId,
          inputEpisodeId: committed.inputEpisodeId,
          turnId: committed.turnId
        };
      }
      case "GET_SESSION_SUMMARY": {
        const state = writer.getState();
        return {
          protocolVersion: 1,
          ok: true,
          type: "SESSION_SUMMARY",
          requestId: command.requestId,
          sessionId: command.sessionId,
          sequence: state.sequence,
          started: state.started,
          contextEpoch: state.contextEpoch,
          deliveryStatuses: Object.fromEntries(
            Object.values(state.deliveries).map((atom) => [atom.deliveryId, atom.status])
          )
        };
      }
      case "RECONNECT_DELIVERY": {
        const reconnected = await new DeliveryCoordinator(writer).reconnect(command.deliveryId, envelope);
        return {
          protocolVersion: 1,
          ok: true,
          type: "DELIVERY_RECONNECT",
          requestId: command.requestId,
          ...reconnected
        };
      }
      case "ACK_DELIVERY_EXPOSED": {
        await new DeliveryCoordinator(writer).acknowledgeExposed(command.deliveryId, envelope);
        return {
          protocolVersion: 1,
          ok: true,
          type: "DELIVERY_ACKNOWLEDGED",
          requestId: command.requestId,
          deliveryId: command.deliveryId,
          acknowledgement: "EXPOSED"
        };
      }
      case "ACK_DELIVERY_COMPLETED": {
        await new DeliveryCoordinator(writer).acknowledgeCompleted(command.deliveryId, envelope);
        return {
          protocolVersion: 1,
          ok: true,
          type: "DELIVERY_ACKNOWLEDGED",
          requestId: command.requestId,
          deliveryId: command.deliveryId,
          acknowledgement: "COMPLETED"
        };
      }
    }
  }

}

function toBoundAddress(host: "127.0.0.1" | "::1", address: AddressInfo): BoundLoopbackAddress {
  const bracketedHost = host === "::1" ? `[${host}]` : host;
  return { host, port: address.port, url: `http://${bracketedHost}:${String(address.port)}` };
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function constantTimeEquals(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_COMMAND_BYTES) throw new ProtocolHttpError(413, "BODY_TOO_LARGE", "Command body exceeds the size limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseCommand(body: string): ClientCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new ProtocolHttpError(400, "INVALID_COMMAND", "Command body is not valid JSON");
  }
  const command = ClientCommandSchema.safeParse(parsed);
  if (!command.success) throw new ProtocolHttpError(400, "INVALID_COMMAND", "Command does not match protocol version 1");
  return command.data;
}

function classifyError(error: unknown): ProtocolHttpError {
  if (error instanceof ProtocolHttpError) return error;
  if (error instanceof Error && (error.message === "Session already started" || error.message.startsWith("Cannot "))) {
    return new ProtocolHttpError(409, "CONFLICT", "Command conflicts with current session state");
  }
  if (error instanceof Error && error.message.startsWith("Unknown delivery")) {
    return new ProtocolHttpError(404, "NOT_FOUND", "Delivery not found");
  }
  return new ProtocolHttpError(500, "INTERNAL_ERROR", "Command could not be completed");
}

function assertValidPreflight(request: IncomingMessage): void {
  const requestedMethod = headerValue(request, "access-control-request-method");
  if (requestedMethod?.trim().toUpperCase() !== CORS_ALLOWED_METHOD) {
    throw new ProtocolHttpError(
      400,
      "INVALID_COMMAND",
      "CORS preflight requests may target only POST"
    );
  }

  const requestedHeaders = headerValue(request, "access-control-request-headers");
  if (requestedHeaders === undefined || requestedHeaders.trim().length === 0) return;

  for (const header of requestedHeaders.split(",")) {
    const normalized = header.trim().toLowerCase();
    if (normalized.length === 0 || !CORS_ALLOWED_HEADERS.has(normalized)) {
      throw new ProtocolHttpError(
        400,
        "INVALID_COMMAND",
        "CORS preflight requested a header that is not allowed"
      );
    }
  }
}

function sendPreflight(response: ServerResponse, origin: string | undefined): void {
  if (origin === undefined) throw new Error("Allowed preflight is missing Origin");
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": CORS_ALLOWED_METHOD,
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
  body: ProtocolSuccessResponse | ProtocolErrorResponse,
  origin?: string
): void {
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
  response.writeHead(status, headers);
  response.end(json);
}

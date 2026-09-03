import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authoritativeBoardShapeCanonicalJson,
  ClientCommandSchema,
  MAX_WHITEBOARD_VISION_BASE64_LENGTH,
  ProtocolErrorResponseSchema,
  WhiteboardVisionSnapshotUploadSchema,
  ProtocolSuccessResponseSchema,
  SessionIdSchema,
  type ClientCommand,
  type LocalTransportSecurity,
  type SessionId,
  type ProtocolErrorResponse,
  type ProtocolSuccessResponse
} from "../../../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../../../packages/delivery/src/index.js";
import {
  TurnCoordinator,
  createCommandEnvelope,
  replayQuantResearchPublicState,
  replayQuantTradingSessionState
} from "../../../packages/interview-engine/src/index.js";
import { RequestIdConflictError } from "../../../packages/persistence/src/index.js";
import {
  QuantResearchError,
  QuantTraderActionError
} from "../../../packages/local-compute/src/index.js";
import { MAX_REPLAY_IDENTIFIER_CHARS } from "../../../packages/replay/src/index.js";
import {
  LegacyUninitializedQuantSessionError,
  type SessionRecoveryCoordinator
} from "./session-recovery-coordinator.js";
import type { SessionReadService } from "./session-read-service.js";
import type { ServerTurnOrchestrator } from "./turn-orchestrator.js";
import type { WhiteboardVisionCoordinator } from "./whiteboard-vision-coordinator.js";
import {
  listInterviewCatalogEntries,
  resolveInterviewSessionConfiguration,
  resolveSessionStateComposition,
  toInterviewProblemPublicView
} from "./interview-session-composition.js";
import { createLegacyDefaultSessionConfiguration } from "./legacy-session-compatibility.js";
import { ProductionSessionRuntime } from "./production-session-runtime.js";
import { ProviderRuntimeResolver } from "./provider-runtime.js";

const MAX_COMMAND_BYTES = 64 * 1024;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);
const COMMAND_PATH = "/v1/commands";
const WHITEBOARD_MUTATION_PATH = "/v1/whiteboard-mutations";
const WHITEBOARD_VISION_PATH = "/v1/whiteboard-vision";
const MAX_WHITEBOARD_MUTATION_BODY_BYTES = 8 * 1024 * 1024;
const MAX_WHITEBOARD_VISION_BODY_BYTES = MAX_WHITEBOARD_VISION_BASE64_LENGTH + 64 * 1024;
const SESSION_READ_HISTORY_PATH = "/v1/read/sessions";
const CORS_COMMAND_METHOD = "POST";
const CORS_READ_METHOD = "GET";
const CORS_ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "x-interview-client-token"
]);
const CORS_ALLOW_HEADERS = "content-type, x-interview-client-token";

export interface LoopbackCommandServerOptions {
  readonly security: LocalTransportSecurity;
  readonly sessions: SessionRecoveryCoordinator;
  readonly reads?: SessionReadService;
  readonly orchestrator?: ServerTurnOrchestrator;
  readonly productionRuntime?: ProductionSessionRuntime;
  readonly providerRuntimeResolver?: ProviderRuntimeResolver;
  readonly whiteboardVision?: WhiteboardVisionCoordinator;
  readonly onSessionTerminal?: (sessionId: SessionId) => void | Promise<void>;
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
  private readonly productionRuntime: ProductionSessionRuntime;
  private readonly providerRuntimeResolver: ProviderRuntimeResolver;
  private boundAddress: BoundLoopbackAddress | undefined;

  public constructor(private readonly options: LoopbackCommandServerOptions) {
    if (!LOOPBACK_HOSTS.has(options.security.host)) {
      throw new Error("The command server may bind only to a loopback address");
    }
    if (
      typeof options.security.clientToken !== "string"
      || options.security.clientToken.length < 32
      || /[\r\n]/u.test(options.security.clientToken)
    ) {
      throw new Error("Client token must contain at least 32 characters");
    }
    if (options.security.allowedOrigins.size === 0) throw new Error("At least one exact client origin is required");
    for (const origin of options.security.allowedOrigins) {
      const parsed = new URL(origin);
      if (parsed.origin !== origin) throw new Error("Allowed origins must be exact URL origins without paths");
    }
    this.productionRuntime = options.productionRuntime ?? new ProductionSessionRuntime();
    this.providerRuntimeResolver = options.providerRuntimeResolver ?? new ProviderRuntimeResolver();
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
      if (request.method === "OPTIONS") {
        const allowedMethod = allowedPreflightMethod(request.url);
        if (allowedMethod === undefined) {
          throw new ProtocolHttpError(404, "NOT_FOUND", "Endpoint not found");
        }
        this.authorizeOrigin(origin);
        assertValidPreflight(request, allowedMethod);
        sendPreflight(response, origin, allowedMethod);
        return;
      }
      this.authorize(request, origin);

      if (request.method === CORS_READ_METHOD) {
        const route = parseReadRoute(request.url);
        if (route === undefined || this.options.reads === undefined) {
          throw new ProtocolHttpError(404, "NOT_FOUND", "Endpoint not found");
        }
        const result = this.dispatchRead(route);
        sendJson(response, 200, result, origin);
        return;
      }

      if (
        request.method !== CORS_COMMAND_METHOD
        || (
          request.url !== COMMAND_PATH
          && request.url !== WHITEBOARD_MUTATION_PATH
          && request.url !== WHITEBOARD_VISION_PATH
        )
      ) {
        throw new ProtocolHttpError(404, "NOT_FOUND", "Endpoint not found");
      }
      const contentType = headerValue(request, "content-type");
      if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new ProtocolHttpError(415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json");
      }

      if (request.url === WHITEBOARD_VISION_PATH) {
        const coordinator = this.options.whiteboardVision;
        if (coordinator === undefined) {
          throw new ProtocolHttpError(503, "INTERNAL_ERROR", "Whiteboard vision coordinator is unavailable");
        }
        const body = await readBody(request, MAX_WHITEBOARD_VISION_BODY_BYTES, "Whiteboard vision body");
        let parsed: unknown;
        try {
          parsed = JSON.parse(body) as unknown;
        } catch {
          throw new ProtocolHttpError(400, "INVALID_COMMAND", "Whiteboard vision body is not valid JSON");
        }
        const upload = WhiteboardVisionSnapshotUploadSchema.safeParse(parsed);
        if (!upload.success) {
          throw new ProtocolHttpError(
            400,
            "INVALID_COMMAND",
            "Whiteboard vision body does not match protocol version 1"
          );
        }
        const result = await coordinator.process(upload.data);
        sendJson(response, 200, result, origin);
        return;
      }

      const isWhiteboardMutation = request.url === WHITEBOARD_MUTATION_PATH;
      const command = parseCommand(await readBody(
        request,
        isWhiteboardMutation ? MAX_WHITEBOARD_MUTATION_BODY_BYTES : MAX_COMMAND_BYTES,
        isWhiteboardMutation ? "Whiteboard mutation body" : "Command body"
      ));
      if (isWhiteboardMutation && command.type !== "COMMIT_BOARD_MUTATION") {
        throw new ProtocolHttpError(
          400,
          "INVALID_COMMAND",
          "Whiteboard mutation endpoint accepts only COMMIT_BOARD_MUTATION"
        );
      }
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

  private scheduleSessionTerminalCleanup(sessionId: SessionId): void {
    const cleanup = this.options.onSessionTerminal;
    if (cleanup === undefined) return;
    try {
      void Promise.resolve(cleanup(sessionId)).catch(() => undefined);
    } catch {
      // Durable terminal authority has already committed. Cleanup is
      // best-effort and must never rewrite that outcome.
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

  private dispatchRead(route: ReadRoute): unknown {
    const reads = this.options.reads;
    if (reads === undefined) {
      throw new ProtocolHttpError(404, "NOT_FOUND", "Endpoint not found");
    }

    if (route.kind === "HISTORY") {
      return reads.readHistory();
    }

    const result = route.kind === "EVALUATION"
      ? reads.readEvaluation(route.sessionId)
      : reads.readReplay(route.sessionId);
    if (result === null) {
      throw new ProtocolHttpError(404, "NOT_FOUND", "Session not found");
    }
    return result;
  }

  private async dispatch(command: ClientCommand): Promise<ProtocolSuccessResponse> {
    if (command.type === "LIST_INTERVIEW_CATALOG") {
      return {
        protocolVersion: 1,
        ok: true,
        type: "INTERVIEW_CATALOG",
        requestId: command.requestId,
        entries: [...listInterviewCatalogEntries()]
      };
    }

    if (command.type === "LIST_PROVIDER_OPTIONS") {
      return {
        protocolVersion: 1,
        ok: true,
        type: "PROVIDER_OPTIONS",
        requestId: command.requestId,
        options: [...await this.providerRuntimeResolver.listLaunchOptions()]
      };
    }

    if (command.type === "LIST_SESSIONS") {
      const sessions = this.options.sessions.listSessions();
      return {
        protocolVersion: 1,
        ok: true,
        type: "SESSIONS_LIST",
        requestId: command.requestId,
        sessions: [...sessions]
      };
    }

    let startComposition: ReturnType<typeof resolveInterviewSessionConfiguration> | undefined;
    if (command.type === "START_SESSION" || command.type === "START_CONFIGURED_SESSION") {
      try {
        startComposition = resolveInterviewSessionConfiguration(
          command.type === "START_SESSION"
            ? createLegacyDefaultSessionConfiguration(command.problemId)
            : command.configuration
        );
      } catch {
        throw new ProtocolHttpError(
          404,
          "NOT_FOUND",
          "Configured interview target is not available"
        );
      }
    }

    if (command.type === "START_CONFIGURED_SESSION") {
      const composition = startComposition;
      if (composition === undefined) {
        throw new Error("Validated configured session composition is missing");
      }
      const provider = await this.providerRuntimeResolver.evaluateLaunchOption(
        composition.configuration.providerSelection
      );
      if (provider.availability !== "AVAILABLE") {
        throw new ProtocolHttpError(
          409,
          "CONFLICT",
          providerLaunchFailureMessage(provider.reason)
        );
      }
    }

    const isStartCommand =
      command.type === "START_SESSION" || command.type === "START_CONFIGURED_SESSION";
    if (!isStartCommand && !this.options.sessions.hasSession(command.sessionId)) {
      throw new ProtocolHttpError(404, "NOT_FOUND", "Session not found");
    }

    if (!isStartCommand) {
      // Recovery owns writer opening for existing sessions. This ordering lets
      // migration/corruption admission inspect persisted events before modern
      // reducer construction, while normal recovery still returns the canonical
      // process-local writer through SessionRuntimeRegistry.
      await this.options.sessions.ensureRecovered(command.sessionId);
    }
    const writer = await this.options.sessions.getWriterAsync(command.sessionId);
    let recoveredComposition: ReturnType<typeof resolveSessionStateComposition> | undefined;
    if (!isStartCommand) {
      recoveredComposition = resolveSessionStateComposition(writer.getState());
    }
    const envelope = createCommandEnvelope({
      sessionId: command.sessionId,
      requestId: command.requestId,
      producer: "authenticated-local-client"
    });
    switch (command.type) {
      case "START_SESSION": {
        const composition = startComposition;
        if (composition === undefined || composition.mode !== "OXFORD_MATHEMATICS") {
          throw new Error("Validated legacy START_SESSION composition is missing or incompatible");
        }

        try {
          await new TurnCoordinator(writer).startSession(composition.problem, envelope);
        } catch (error) {
          if (error instanceof RequestIdConflictError) throw error;
          if (error instanceof Error && error.message === "Session already started") {
            throw new ProtocolHttpError(409, "CONFLICT", "Session is already started");
          }
          throw error;
        }
        await this.options.sessions.ensureRecovered(command.sessionId);
        return {
          protocolVersion: 1,
          ok: true,
          type: "SESSION_STARTED",
          requestId: command.requestId,
          sessionId: command.sessionId
        };
      }
      case "START_CONFIGURED_SESSION": {
        const composition = startComposition;
        if (composition === undefined) {
          throw new Error("Validated configured session composition is missing");
        }

        try {
          await this.productionRuntime.startConfigured(writer, composition, envelope);
        } catch (error) {
          if (error instanceof RequestIdConflictError) throw error;
          if (error instanceof Error && error.message === "Session already started") {
            throw new ProtocolHttpError(409, "CONFLICT", "Session is already started");
          }
          throw error;
        }
        await this.options.sessions.ensureRecovered(command.sessionId);
        const problem = toInterviewProblemPublicView(composition);
        return {
          protocolVersion: 1,
          ok: true,
          type: "CONFIGURED_SESSION_STARTED",
          requestId: command.requestId,
          sessionId: command.sessionId,
          configuration: composition.configuration,
          ...(problem === undefined ? {} : { problem })
        };
      }
      case "RESUME_SESSION": {
        await new TurnCoordinator(writer).resumeSession(envelope);
        const state = writer.getState();
        return {
          protocolVersion: 1,
          ok: true,
          type: "SESSION_RESUMED",
          requestId: command.requestId,
          sessionId: command.sessionId,
          sequence: state.sequence,
          started: state.started,
          status: state.status,
          ...(
            recoveredComposition?.mode === "OXFORD_MATHEMATICS"
            && state.problem?.id !== undefined
              ? { problemId: state.problem.id }
              : {}
          ),
          contextEpoch: state.contextEpoch,
          deliveryStatuses: Object.fromEntries(
            Object.values(state.deliveries).map((atom) => [atom.deliveryId, atom.status])
          ),
          history: [...this.options.sessions.getHistory(command.sessionId)]
        };
      }
      case "COMPLETE_SESSION": {
        if (
          recoveredComposition !== undefined
          && recoveredComposition.mode !== "OXFORD_MATHEMATICS"
        ) {
          throw new ProtocolHttpError(
            409,
            "CONFLICT",
            "Quant sessions complete only through deterministic scenario progression"
          );
        }
        const completed = await new TurnCoordinator(writer).completeSession(envelope, command.summary);
        this.scheduleSessionTerminalCleanup(command.sessionId);
        return {
          protocolVersion: 1,
          ok: true,
          type: "SESSION_COMPLETED",
          requestId: command.requestId,
          sessionId: command.sessionId,
          completedAt: completed.completedAt
        };
      }
      case "ARCHIVE_SESSION": {
        if (
          recoveredComposition !== undefined
          && recoveredComposition.mode !== "OXFORD_MATHEMATICS"
          && writer.getState().status === "ACTIVE"
        ) {
          throw new ProtocolHttpError(
            409,
            "CONFLICT",
            "Active quant sessions cannot be archived before deterministic completion"
          );
        }
        const archived = await new TurnCoordinator(writer).archiveSession(envelope, command.reason);
        this.scheduleSessionTerminalCleanup(command.sessionId);
        return {
          protocolVersion: 1,
          ok: true,
          type: "SESSION_ARCHIVED",
          requestId: command.requestId,
          sessionId: command.sessionId,
          archivedAt: archived.archivedAt
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
          }).catch(() => {
            // Handle error safely without printing raw exception details
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
      case "COMMIT_BOARD_MUTATION": {
        const committed = await new TurnCoordinator(writer).commitBoardMutation(
          command.mutation,
          envelope
        );
        if (committed.committed) {
          this.options.whiteboardVision?.supersedeStaleRequests(command.sessionId);
        }
        return {
          protocolVersion: 1,
          ok: true,
          type: "BOARD_MUTATION_COMMITTED",
          requestId: command.requestId,
          sessionId: command.sessionId,
          committed: committed.committed,
          boardRevision: committed.boardRevision,
          ...(committed.reason === undefined ? {} : { reason: committed.reason })
        };
      }
      case "GET_BOARD_STATE": {
        const state = writer.getState();
        return {
          protocolVersion: 1,
          ok: true,
          type: "BOARD_STATE",
          requestId: command.requestId,
          sessionId: command.sessionId,
          boardRevision: state.boardRevision,
          shapeAuthorityKnown: state.boardShapeAuthorityKnown,
          shapeRevisions: Object.values(state.boardShapes)
            .map((shape) => ({
              shapeId: shape.id,
              revision: shape.revision,
              contentSha256: createHash("sha256")
                .update(authoritativeBoardShapeCanonicalJson(shape), "utf8")
                .digest("hex")
            }))
            .sort((left, right) => left.shapeId.localeCompare(right.shapeId))
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
          status: state.status,
          contextEpoch: state.contextEpoch,
          deliveryStatuses: Object.fromEntries(
            Object.values(state.deliveries).map((atom) => [atom.deliveryId, atom.status])
          ),
          history: [...this.options.sessions.getHistory(command.sessionId)]
        };
      }
      case "GET_INTERVIEW_SESSION_CONTEXT": {
        const composition = recoveredComposition;
        if (composition === undefined) {
          throw new Error("Recovered session composition is missing");
        }
        const problem = toInterviewProblemPublicView(composition);
        return {
          protocolVersion: 1,
          ok: true,
          type: "INTERVIEW_SESSION_CONTEXT",
          requestId: command.requestId,
          sessionId: command.sessionId,
          configuration: composition.configuration,
          configurationSource:
            writer.getState().configuration === undefined
              ? "LEGACY_COMPATIBILITY"
              : "CONFIGURED",
          ...(problem === undefined ? {} : { problem })
        };
      }
      case "GET_QUANT_SESSION_STATE": {
        const composition = recoveredComposition;
        if (composition === undefined) {
          throw new Error("Recovered session composition is missing");
        }
        if (composition.mode === "OXFORD_MATHEMATICS") {
          throw new ProtocolHttpError(409, "CONFLICT", "Session is not a quant session");
        }
        const quant = this.productionRuntime.readQuantState(writer, composition);
        return quant.mode === "QUANT_TRADING"
          ? {
              protocolVersion: 1,
              ok: true,
              type: "QUANT_TRADING_STATE",
              requestId: command.requestId,
              sessionId: command.sessionId,
              state: quant.state
            }
          : {
              protocolVersion: 1,
              ok: true,
              type: "QUANT_RESEARCH_STATE",
              requestId: command.requestId,
              sessionId: command.sessionId,
              state: quant.state
            };
      }
      case "SUBMIT_QUANT_TRADING_ACTION": {
        const composition = recoveredComposition;
        if (composition === undefined) {
          throw new Error("Recovered session composition is missing");
        }
        if (composition.mode !== "QUANT_TRADING") {
          throw new ProtocolHttpError(409, "CONFLICT", "Session is not a Quant Trading session");
        }
        await this.productionRuntime.applyTradingAction(
          writer,
          composition,
          command.action,
          command.expectedRound,
          envelope
        );
        const committedState = writer.getStateAfterRequest(command.requestId);
        if (committedState === undefined) {
          throw new Error("Quant Trading RequestId has no authoritative event group");
        }
        const projected = replayQuantTradingSessionState(committedState);
        if (writer.getState().status === "COMPLETED") {
          this.scheduleSessionTerminalCleanup(command.sessionId);
        }
        return {
          protocolVersion: 1,
          ok: true,
          type: "QUANT_TRADING_STATE",
          requestId: command.requestId,
          sessionId: command.sessionId,
          state: projected
        };
      }
      case "SUBMIT_QUANT_RESEARCH_ACTION": {
        const composition = recoveredComposition;
        if (composition === undefined) {
          throw new Error("Recovered session composition is missing");
        }
        if (composition.mode !== "QUANT_RESEARCH") {
          throw new ProtocolHttpError(409, "CONFLICT", "Session is not a Quant Research session");
        }
        await this.productionRuntime.applyResearchAction(
          writer,
          composition,
          command.action,
          command.expectedActionCount,
          envelope
        );
        const committedState = writer.getStateAfterRequest(command.requestId);
        if (committedState === undefined) {
          throw new Error("Quant Research RequestId has no authoritative event group");
        }
        const projected = replayQuantResearchPublicState(committedState);
        if (writer.getState().status === "COMPLETED") {
          this.scheduleSessionTerminalCleanup(command.sessionId);
        }
        return {
          protocolVersion: 1,
          ok: true,
          type: "QUANT_RESEARCH_STATE",
          requestId: command.requestId,
          sessionId: command.sessionId,
          state: projected
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

type ReadRoute =
  | { readonly kind: "HISTORY" }
  | { readonly kind: "EVALUATION"; readonly sessionId: SessionId }
  | { readonly kind: "REPLAY"; readonly sessionId: SessionId };

function parseReadRoute(rawUrl: string | undefined): ReadRoute | undefined {
  if (rawUrl === undefined || rawUrl.includes("?") || rawUrl.includes("#")) {
    return undefined;
  }
  if (rawUrl === SESSION_READ_HISTORY_PATH) {
    return { kind: "HISTORY" };
  }

  const match = /^\/v1\/read\/sessions\/([^/]+)\/(evaluation|replay)$/u.exec(rawUrl);
  if (match === null) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (
    decoded.length === 0
    || decoded.length > MAX_REPLAY_IDENTIFIER_CHARS
    || decoded === "."
    || decoded === ".."
    || containsUnsafeReadPathCharacter(decoded)
  ) {
    return undefined;
  }

  const parsed = SessionIdSchema.safeParse(decoded);
  if (!parsed.success) return undefined;
  return match[2] === "evaluation"
    ? { kind: "EVALUATION", sessionId: parsed.data }
    : { kind: "REPLAY", sessionId: parsed.data };
}

function containsUnsafeReadPathCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "/" || character === "\\" || code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function allowedPreflightMethod(rawUrl: string | undefined): "GET" | "POST" | undefined {
  if (
    rawUrl === COMMAND_PATH
    || rawUrl === WHITEBOARD_MUTATION_PATH
    || rawUrl === WHITEBOARD_VISION_PATH
  ) return CORS_COMMAND_METHOD;
  return parseReadRoute(rawUrl) === undefined ? undefined : CORS_READ_METHOD;
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

async function readBody(
  request: IncomingMessage,
  maxBytes: number = MAX_COMMAND_BYTES,
  bodyLabel: string = "Command body"
): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) {
      throw new ProtocolHttpError(
        413,
        "BODY_TOO_LARGE",
        `${bodyLabel} exceeds the size limit`
      );
    }
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

function providerLaunchFailureMessage(
  reason: import("../../../packages/domain/src/index.js").ProviderLaunchAvailabilityReason | undefined
): string {
  switch (reason) {
    case "CREDENTIALS_REQUIRED":
      return "Selected provider requires configured authentication";
    case "DISABLED":
      return "Selected provider is disabled";
    case "RUNTIME_CONFIGURATION_UNAVAILABLE":
      return "Selected provider runtime configuration is unavailable";
    case "RUNTIME_DEPENDENCY_UNAVAILABLE":
      return "Selected provider runtime dependency is unavailable";
    case "POLICY_UNAVAILABLE":
      return "Selected provider policy could not be verified";
    case "POLICY_DENIED":
      return "Selected provider is denied by the current safety policy";
    case "CAPABILITY_UNAVAILABLE":
      return "Selected provider does not satisfy required capabilities";
    case "PROVIDER_UNAVAILABLE":
      return "Selected provider is unavailable";
    case "UNKNOWN":
    default:
      return "Selected provider readiness could not be verified";
  }
}

function classifyError(error: unknown): ProtocolHttpError {
  if (error instanceof ProtocolHttpError) return error;
  if (error instanceof RequestIdConflictError) {
    return new ProtocolHttpError(409, "CONFLICT", "RequestId conflicts with an earlier command");
  }
  if (error instanceof LegacyUninitializedQuantSessionError) {
    return new ProtocolHttpError(
      409,
      "CONFLICT",
      "Legacy Quant session has no deterministic scenario state; start a new Quant session"
    );
  }
  if (error instanceof QuantTraderActionError) {
    const invalid = new Set([
      "INVALID_ACTION",
      "INVALID_QUOTE",
      "INVALID_TICK",
      "QUOTE_SIZE_LIMIT",
      "HARD_POSITION_LIMIT"
    ]);
    return invalid.has(error.code)
      ? new ProtocolHttpError(400, "INVALID_COMMAND", "Quant Trading action is invalid")
      : new ProtocolHttpError(409, "CONFLICT", "Quant Trading action conflicts with current scenario state");
  }
  if (error instanceof QuantResearchError) {
    if (error.code === "INVALID_DEFINITION") {
      return new ProtocolHttpError(500, "INTERNAL_ERROR", "Quant Research scenario initialization failed");
    }
    return error.code === "INVALID_ACTION"
      ? new ProtocolHttpError(400, "INVALID_COMMAND", "Quant Research action is invalid")
      : new ProtocolHttpError(409, "CONFLICT", "Quant Research action conflicts with current scenario state");
  }
  if (error instanceof Error && (error.message === "Session already started" || error.message.startsWith("Cannot "))) {
    return new ProtocolHttpError(409, "CONFLICT", "Command conflicts with current session state");
  }
  if (error instanceof Error && error.message.startsWith("Unknown delivery")) {
    return new ProtocolHttpError(404, "NOT_FOUND", "Delivery not found");
  }
  return new ProtocolHttpError(500, "INTERNAL_ERROR", "Command could not be completed");
}

function assertValidPreflight(
  request: IncomingMessage,
  allowedMethod: "GET" | "POST"
): void {
  const requestedMethod = headerValue(request, "access-control-request-method");
  if (requestedMethod?.trim().toUpperCase() !== allowedMethod) {
    throw new ProtocolHttpError(
      400,
      "INVALID_COMMAND",
      "CORS preflight method does not match the requested endpoint"
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

function sendPreflight(
  response: ServerResponse,
  origin: string | undefined,
  allowedMethod: "GET" | "POST"
): void {
  if (origin === undefined) throw new Error("Allowed preflight is missing Origin");
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

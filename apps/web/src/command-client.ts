import type { z } from "zod";
import {
  BoardMutationCommittedResponseSchema,
  BoardStateResponseSchema,
  ClientCommandSchema,
  ConfiguredSessionStartedResponseSchema,
  DeliveryAcknowledgedResponseSchema,
  DeliveryReconnectResponseSchema,
  InputCommittedResponseSchema,
  InterviewCatalogResponseSchema,
  InterviewSessionConfigurationSchema,
  InterviewSessionContextResponseSchema,
  ProviderOptionsResponseSchema,
  ProtocolErrorResponseSchema,
  QuantResearchStateResponseSchema,
  QuantTradingStateResponseSchema,
  RequestIdSchema,
  SessionArchivedResponseSchema,
  SessionCompletedResponseSchema,
  SessionResumedResponseSchema,
  SessionStartedResponseSchema,
  SessionSummaryResponseSchema,
  SessionsListResponseSchema,
  type ClientCommand,
  type DeliveryId,
  type NormalizedBoardMutation,
  type InterviewCatalogEntry,
  type InterviewSessionConfiguration,
  type ProviderLaunchOption,
  type ProtocolErrorResponse,
  type ProtocolSuccessResponse,
  type QuantResearchCandidateAction,
  type QuantTradingCandidateAction,
  type RequestId,
  type SessionId,
  type StoredSessionSummary
} from "../../../packages/domain/src/index.js";

type SessionStartedResponse = z.infer<typeof SessionStartedResponseSchema>;
type ConfiguredSessionStartedResponse = z.infer<typeof ConfiguredSessionStartedResponseSchema>;
type InterviewSessionContextResponse = z.infer<typeof InterviewSessionContextResponseSchema>;
type InterviewCatalogResponse = z.infer<typeof InterviewCatalogResponseSchema>;
type ProviderOptionsResponse = z.infer<typeof ProviderOptionsResponseSchema>;
type SessionResumedResponse = z.infer<typeof SessionResumedResponseSchema>;
type SessionCompletedResponse = z.infer<typeof SessionCompletedResponseSchema>;
type SessionArchivedResponse = z.infer<typeof SessionArchivedResponseSchema>;
type InputCommittedResponse = z.infer<typeof InputCommittedResponseSchema>;
type BoardMutationCommittedResponse = z.infer<typeof BoardMutationCommittedResponseSchema>;
type BoardStateResponse = z.infer<typeof BoardStateResponseSchema>;
type SessionSummaryResponse = z.infer<typeof SessionSummaryResponseSchema>;
type QuantTradingStateResponse = z.infer<typeof QuantTradingStateResponseSchema>;
type QuantResearchStateResponse = z.infer<typeof QuantResearchStateResponseSchema>;
type QuantSessionStateResponse = QuantTradingStateResponse | QuantResearchStateResponse;
type DeliveryReconnectResponse = z.infer<typeof DeliveryReconnectResponseSchema>;
type DeliveryAcknowledgedResponse = z.infer<typeof DeliveryAcknowledgedResponseSchema>;

export interface BrowserCommandClientOptions {
  readonly baseUrl: string;
  readonly clientToken?: string;
  /**
   * Non-secret marker used only when the trusted Electron boundary replaces it
   * with the per-launch credential before the request leaves the renderer.
   */
  readonly externalAuthenticationHeaderValue?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestIdFactory?: () => RequestId;
}

export interface BrowserCommandRequestOptions {
  readonly requestId?: RequestId;
  readonly signal?: AbortSignal;
}

export type BrowserCommandTransportErrorKind = "ABORTED" | "NETWORK";

export class BrowserCommandTransportError extends Error {
  public constructor(
    public readonly kind: BrowserCommandTransportErrorKind,
    public readonly requestId: RequestId
  ) {
    super(kind === "ABORTED" ? "Command request was aborted" : "Command transport failed");
    this.name = "BrowserCommandTransportError";
  }
}

export type BrowserCommandResponseErrorReason =
  | "INVALID_CONTENT_TYPE"
  | "MALFORMED_JSON"
  | "SCHEMA_MISMATCH"
  | "REQUEST_ID_MISMATCH"
  | "CORRELATION_MISMATCH";

export class BrowserCommandResponseError extends Error {
  public constructor(
    public readonly reason: BrowserCommandResponseErrorReason,
    public readonly requestId: RequestId,
    public readonly status: number
  ) {
    super("Command server returned an invalid response");
    this.name = "BrowserCommandResponseError";
  }
}

const SAFE_PROVIDER_PROTOCOL_MESSAGES: ReadonlySet<string> = new Set([
  "Selected provider requires configured authentication",
  "Selected provider is disabled",
  "Selected provider runtime configuration is unavailable",
  "Selected provider runtime dependency is unavailable",
  "Selected provider policy could not be verified",
  "Selected provider is denied by the current safety policy",
  "Selected provider does not satisfy required capabilities",
  "Selected provider is unavailable",
  "Selected provider readiness could not be verified"
]);

function safeProtocolMessage(
  code: ProtocolErrorResponse["error"]["code"],
  message: string
): string | undefined {
  return code === "CONFLICT" && SAFE_PROVIDER_PROTOCOL_MESSAGES.has(message)
    ? message
    : undefined;
}

export class BrowserCommandProtocolError extends Error {
  public readonly code: ProtocolErrorResponse["error"]["code"];

  public constructor(
    public readonly status: number,
    code: ProtocolErrorResponse["error"]["code"],
    public readonly requestId: RequestId,
    public readonly publicMessage?: string
  ) {
    super(publicMessage ?? `Command rejected with protocol error ${code}`);
    this.name = "BrowserCommandProtocolError";
    this.code = code;
  }
}

export class BrowserCommandClient {
  readonly #commandUrl: string;
  readonly #whiteboardMutationUrl: string;
  readonly #authenticationHeaderValue: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestIdFactory: () => RequestId;

  public constructor(options: BrowserCommandClientOptions) {
    const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    this.#commandUrl = `${baseUrl}/v1/commands`;
    this.#whiteboardMutationUrl = `${baseUrl}/v1/whiteboard-mutations`;
    if (
      options.clientToken !== undefined
      && options.externalAuthenticationHeaderValue !== undefined
    ) {
      throw new Error("Command client authentication configuration is ambiguous");
    }
    if (options.externalAuthenticationHeaderValue !== undefined) {
      if (options.externalAuthenticationHeaderValue !== "desktop-managed-v1") {
        throw new Error("External authentication marker is invalid");
      }
      this.#authenticationHeaderValue = options.externalAuthenticationHeaderValue;
    } else {
      if (
        typeof options.clientToken !== "string"
        || options.clientToken.length < 32
        || /[\r\n]/u.test(options.clientToken)
      ) {
        throw new Error("Client token must contain at least 32 characters");
      }
      this.#authenticationHeaderValue = options.clientToken;
    }
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#requestIdFactory = options.requestIdFactory ?? defaultRequestIdFactory;
  }

  public async startSession(
    sessionId: SessionId,
    options: BrowserCommandRequestOptions = {}
  ): Promise<SessionStartedResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "START_SESSION",
      requestId,
      sessionId
    });
    const result = await this.send(
      command,
      (value) => SessionStartedResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async startConfiguredSession(
    sessionId: SessionId,
    configurationInput: InterviewSessionConfiguration,
    options: BrowserCommandRequestOptions = {}
  ): Promise<ConfiguredSessionStartedResponse> {
    const requestId = this.resolveRequestId(options);
    const configuration = InterviewSessionConfigurationSchema.parse(configurationInput);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "START_CONFIGURED_SESSION",
      requestId,
      sessionId,
      configuration
    });
    const result = await this.send(
      command,
      (value) => ConfiguredSessionStartedResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async getInterviewSessionContext(
    sessionId: SessionId,
    options: BrowserCommandRequestOptions = {}
  ): Promise<InterviewSessionContextResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "GET_INTERVIEW_SESSION_CONTEXT",
      requestId,
      sessionId
    });
    const result = await this.send(
      command,
      (value) => InterviewSessionContextResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async getQuantSessionState(
    sessionId: SessionId,
    options: BrowserCommandRequestOptions = {}
  ): Promise<QuantSessionStateResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "GET_QUANT_SESSION_STATE",
      requestId,
      sessionId
    });
    const result = await this.send(
      command,
      (value) => {
        const trading = QuantTradingStateResponseSchema.safeParse(value);
        return trading.success ? trading.data : QuantResearchStateResponseSchema.parse(value);
      },
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async submitQuantTradingAction(
    sessionId: SessionId,
    expectedRound: number,
    action: QuantTradingCandidateAction,
    options: BrowserCommandRequestOptions = {}
  ): Promise<QuantTradingStateResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_TRADING_ACTION",
      requestId,
      sessionId,
      expectedRound,
      action
    });
    const result = await this.send(
      command,
      (value) => QuantTradingStateResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async submitQuantResearchAction(
    sessionId: SessionId,
    expectedActionCount: number,
    action: QuantResearchCandidateAction,
    options: BrowserCommandRequestOptions = {}
  ): Promise<QuantResearchStateResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "SUBMIT_QUANT_RESEARCH_ACTION",
      requestId,
      sessionId,
      expectedActionCount,
      action
    });
    const result = await this.send(
      command,
      (value) => QuantResearchStateResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async listInterviewCatalog(
    options: BrowserCommandRequestOptions = {}
  ): Promise<readonly InterviewCatalogEntry[]> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "LIST_INTERVIEW_CATALOG",
      requestId
    });
    const result: InterviewCatalogResponse = await this.send(
      command,
      (value) => InterviewCatalogResponseSchema.parse(value),
      options.signal
    );
    return result.entries;
  }

  public async listProviderOptions(
    options: BrowserCommandRequestOptions = {}
  ): Promise<readonly ProviderLaunchOption[]> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "LIST_PROVIDER_OPTIONS",
      requestId
    });
    const result: ProviderOptionsResponse = await this.send(
      command,
      (value) => ProviderOptionsResponseSchema.parse(value),
      options.signal
    );
    return result.options;
  }

  public async listSessions(
    options: BrowserCommandRequestOptions = {}
  ): Promise<readonly StoredSessionSummary[]> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "LIST_SESSIONS",
      requestId
    });
    const result = await this.send(
      command,
      (value) => SessionsListResponseSchema.parse(value),
      options.signal
    );
    return result.sessions;
  }

  public async resumeSession(
    sessionId: SessionId,
    options: BrowserCommandRequestOptions = {}
  ): Promise<SessionResumedResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "RESUME_SESSION",
      requestId,
      sessionId
    });
    const result = await this.send(
      command,
      (value) => SessionResumedResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async completeSession(
    sessionId: SessionId,
    summary?: string,
    options: BrowserCommandRequestOptions = {}
  ): Promise<SessionCompletedResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "COMPLETE_SESSION",
      requestId,
      sessionId,
      ...(summary !== undefined ? { summary } : {})
    });
    const result = await this.send(
      command,
      (value) => SessionCompletedResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async archiveSession(
    sessionId: SessionId,
    reason?: string,
    options: BrowserCommandRequestOptions = {}
  ): Promise<SessionArchivedResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "ARCHIVE_SESSION",
      requestId,
      sessionId,
      ...(reason !== undefined ? { reason } : {})
    });
    const result = await this.send(
      command,
      (value) => SessionArchivedResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async commitTypedInput(
    sessionId: SessionId,
    text: string,
    options: BrowserCommandRequestOptions = {}
  ): Promise<InputCommittedResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "COMMIT_TYPED_INPUT",
      requestId,
      sessionId,
      text
    });
    return this.send(
      command,
      (value) => InputCommittedResponseSchema.parse(value),
      options.signal
    );
  }

  public async commitBoardMutation(
    sessionId: SessionId,
    mutation: NormalizedBoardMutation,
    options: BrowserCommandRequestOptions = {}
  ): Promise<BoardMutationCommittedResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "COMMIT_BOARD_MUTATION",
      requestId,
      sessionId,
      mutation
    });
    const result = await this.send(
      command,
      (value) => BoardMutationCommittedResponseSchema.parse(value),
      options.signal,
      this.#whiteboardMutationUrl
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async getBoardState(
    sessionId: SessionId,
    options: BrowserCommandRequestOptions = {}
  ): Promise<BoardStateResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "GET_BOARD_STATE",
      requestId,
      sessionId
    });
    const result = await this.send(
      command,
      (value) => BoardStateResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async getSessionSummary(
    sessionId: SessionId,
    options: BrowserCommandRequestOptions = {}
  ): Promise<SessionSummaryResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "GET_SESSION_SUMMARY",
      requestId,
      sessionId
    });
    const result = await this.send(
      command,
      (value) => SessionSummaryResponseSchema.parse(value),
      options.signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  public async reconnectDelivery(
    sessionId: SessionId,
    deliveryId: DeliveryId,
    options: BrowserCommandRequestOptions = {}
  ): Promise<DeliveryReconnectResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type: "RECONNECT_DELIVERY",
      requestId,
      sessionId,
      deliveryId
    });
    const result = await this.send(
      command,
      (value) => DeliveryReconnectResponseSchema.parse(value),
      options.signal
    );
    this.assertDeliveryCorrelation(result.deliveryId, deliveryId, requestId);
    return result;
  }

  public acknowledgeDeliveryExposed(
    sessionId: SessionId,
    deliveryId: DeliveryId,
    options: BrowserCommandRequestOptions = {}
  ): Promise<DeliveryAcknowledgedResponse> {
    return this.acknowledgeDelivery(
      "ACK_DELIVERY_EXPOSED",
      "EXPOSED",
      sessionId,
      deliveryId,
      options
    );
  }

  public acknowledgeDeliveryCompleted(
    sessionId: SessionId,
    deliveryId: DeliveryId,
    options: BrowserCommandRequestOptions = {}
  ): Promise<DeliveryAcknowledgedResponse> {
    return this.acknowledgeDelivery(
      "ACK_DELIVERY_COMPLETED",
      "COMPLETED",
      sessionId,
      deliveryId,
      options
    );
  }

  private async acknowledgeDelivery(
    type: "ACK_DELIVERY_EXPOSED" | "ACK_DELIVERY_COMPLETED",
    acknowledgement: "EXPOSED" | "COMPLETED",
    sessionId: SessionId,
    deliveryId: DeliveryId,
    options: BrowserCommandRequestOptions
  ): Promise<DeliveryAcknowledgedResponse> {
    const requestId = this.resolveRequestId(options);
    const command = ClientCommandSchema.parse({
      protocolVersion: 1,
      type,
      requestId,
      sessionId,
      deliveryId
    });
    const result = await this.send(
      command,
      (value) => DeliveryAcknowledgedResponseSchema.parse(value),
      options.signal
    );
    if (result.deliveryId !== deliveryId || result.acknowledgement !== acknowledgement) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
    return result;
  }

  private async send<TResult extends ProtocolSuccessResponse>(
    command: ClientCommand,
    parseSuccess: (value: unknown) => TResult,
    signal: AbortSignal | undefined,
    endpoint: string = this.#commandUrl
  ): Promise<TResult> {
    if (isSignalAborted(signal)) {
      throw new BrowserCommandTransportError("ABORTED", command.requestId);
    }

    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-interview-client-token": this.#authenticationHeaderValue
      },
      body: JSON.stringify(command),
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer"
    };
    if (signal !== undefined) init.signal = signal;

    let response: Response;
    try {
      response = await this.#fetchImpl(endpoint, init);
    } catch {
      throw new BrowserCommandTransportError(
        isSignalAborted(signal) ? "ABORTED" : "NETWORK",
        command.requestId
      );
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new BrowserCommandResponseError(
        "INVALID_CONTENT_TYPE",
        command.requestId,
        response.status
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      throw new BrowserCommandTransportError(
        isSignalAborted(signal) ? "ABORTED" : "NETWORK",
        command.requestId
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch {
      throw new BrowserCommandResponseError(
        "MALFORMED_JSON",
        command.requestId,
        response.status
      );
    }

    if (!response.ok) {
      let protocolError: ProtocolErrorResponse;
      try {
        protocolError = ProtocolErrorResponseSchema.parse(payload);
      } catch {
        throw new BrowserCommandResponseError(
          "SCHEMA_MISMATCH",
          command.requestId,
          response.status
        );
      }
      throw new BrowserCommandProtocolError(
        response.status,
        protocolError.error.code,
        command.requestId,
        safeProtocolMessage(protocolError.error.code, protocolError.error.message)
      );
    }

    let result: TResult;
    try {
      result = parseSuccess(payload);
    } catch {
      throw new BrowserCommandResponseError(
        "SCHEMA_MISMATCH",
        command.requestId,
        response.status
      );
    }

    if (result.requestId !== command.requestId) {
      throw new BrowserCommandResponseError(
        "REQUEST_ID_MISMATCH",
        command.requestId,
        response.status
      );
    }

    return result;
  }

  private resolveRequestId(options: BrowserCommandRequestOptions): RequestId {
    return RequestIdSchema.parse(options.requestId ?? this.#requestIdFactory());
  }

  private assertDeliveryCorrelation(
    actual: DeliveryId,
    expected: DeliveryId,
    requestId: RequestId
  ): void {
    if (actual !== expected) {
      throw new BrowserCommandResponseError(
        "CORRELATION_MISMATCH",
        requestId,
        200
      );
    }
  }
}

function normalizeLoopbackBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Command server base URL must be a valid URL");
  }

  if (parsed.protocol !== "http:") {
    throw new Error("Command server base URL must use HTTP loopback transport");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
    throw new Error("Command server base URL must target a loopback host");
  }
  if (
    parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.pathname !== "/"
  ) {
    throw new Error("Command server base URL must be an exact origin without credentials or paths");
  }

  return parsed.origin;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function defaultRequestIdFactory(): RequestId {
  return RequestIdSchema.parse(`request_${globalThis.crypto.randomUUID()}`);
}

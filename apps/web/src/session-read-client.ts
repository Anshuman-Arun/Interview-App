import {
  ProtocolErrorResponseSchema,
  type ProtocolErrorResponse,
  type SessionId
} from "../../../packages/domain/src/index.js";
import {
  SessionEvaluationReadResponseSchema,
  SessionHistoryReadResponseSchema,
  SessionReplayReadResponseSchema,
  type SessionEvaluationReadResponse,
  type SessionHistoryReadResponse,
  type SessionReplayReadResponse
} from "../../../packages/replay/src/index.js";

export interface BrowserSessionReadClientOptions {
  readonly baseUrl: string;
  readonly clientToken?: string;
  readonly externalAuthenticationHeaderValue?: string;
  readonly fetchImpl?: typeof fetch;
}

export type BrowserSessionReadTransportErrorKind = "ABORTED" | "NETWORK";

export class BrowserSessionReadTransportError extends Error {
  public constructor(public readonly kind: BrowserSessionReadTransportErrorKind) {
    super(kind === "ABORTED" ? "Session read was aborted" : "Session read transport failed");
    this.name = "BrowserSessionReadTransportError";
  }
}

export class BrowserSessionReadResponseError extends Error {
  public constructor(
    public readonly reason:
      | "INVALID_CONTENT_TYPE"
      | "MALFORMED_JSON"
      | "SCHEMA_MISMATCH"
      | "CORRELATION_MISMATCH",
    public readonly status: number
  ) {
    super("Session read server returned an invalid response");
    this.name = "BrowserSessionReadResponseError";
  }
}

export class BrowserSessionReadProtocolError extends Error {
  public readonly code: ProtocolErrorResponse["error"]["code"];

  public constructor(
    public readonly status: number,
    code: ProtocolErrorResponse["error"]["code"]
  ) {
    super(`Session read rejected with protocol error ${code}`);
    this.name = "BrowserSessionReadProtocolError";
    this.code = code;
  }
}

export class BrowserSessionReadClient {
  readonly #baseUrl: string;
  readonly #authenticationHeaderValue: string;
  readonly #fetchImpl: typeof fetch;

  public constructor(options: BrowserSessionReadClientOptions) {
    this.#baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    if (
      options.clientToken !== undefined
      && options.externalAuthenticationHeaderValue !== undefined
    ) {
      throw new Error("Session read client authentication configuration is ambiguous");
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
  }

  public async getEvaluation(
    sessionId: SessionId,
    signal?: AbortSignal
  ): Promise<SessionEvaluationReadResponse> {
    const result = await this.read(
      `/v1/read/sessions/${encodeURIComponent(sessionId)}/evaluation`,
      (value) => SessionEvaluationReadResponseSchema.parse(value),
      signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserSessionReadResponseError("CORRELATION_MISMATCH", 200);
    }
    return result;
  }

  public async getReplay(
    sessionId: SessionId,
    signal?: AbortSignal
  ): Promise<SessionReplayReadResponse> {
    const result = await this.read(
      `/v1/read/sessions/${encodeURIComponent(sessionId)}/replay`,
      (value) => SessionReplayReadResponseSchema.parse(value),
      signal
    );
    if (result.sessionId !== sessionId) {
      throw new BrowserSessionReadResponseError("CORRELATION_MISMATCH", 200);
    }
    return result;
  }

  public getHistory(signal?: AbortSignal): Promise<SessionHistoryReadResponse> {
    return this.read(
      "/v1/read/sessions",
      (value) => SessionHistoryReadResponseSchema.parse(value),
      signal
    );
  }

  private async read<TResult>(
    path: string,
    parse: (value: unknown) => TResult,
    signal: AbortSignal | undefined
  ): Promise<TResult> {
    if (isSignalAborted(signal)) {
      throw new BrowserSessionReadTransportError("ABORTED");
    }

    const init: RequestInit = {
      method: "GET",
      headers: {
        "x-interview-client-token": this.#authenticationHeaderValue
      },
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer"
    };
    if (signal !== undefined) init.signal = signal;

    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#baseUrl}${path}`, init);
    } catch {
      throw new BrowserSessionReadTransportError(
        isSignalAborted(signal) ? "ABORTED" : "NETWORK"
      );
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new BrowserSessionReadResponseError(
        "INVALID_CONTENT_TYPE",
        response.status
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new BrowserSessionReadResponseError(
        "MALFORMED_JSON",
        response.status
      );
    }

    if (!response.ok) {
      let protocolError: ProtocolErrorResponse;
      try {
        protocolError = ProtocolErrorResponseSchema.parse(payload);
      } catch {
        throw new BrowserSessionReadResponseError(
          "SCHEMA_MISMATCH",
          response.status
        );
      }
      throw new BrowserSessionReadProtocolError(
        response.status,
        protocolError.error.code
      );
    }

    try {
      return parse(payload);
    } catch {
      throw new BrowserSessionReadResponseError(
        "SCHEMA_MISMATCH",
        response.status
      );
    }
  }
}

function normalizeLoopbackBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Session read server base URL must be a valid URL");
  }

  if (parsed.protocol !== "http:") {
    throw new Error("Session read server base URL must use HTTP loopback transport");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
    throw new Error("Session read server base URL must target a loopback host");
  }
  if (
    parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.pathname !== "/"
  ) {
    throw new Error("Session read server base URL must be an exact origin without credentials or paths");
  }

  return parsed.origin;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

import {
  SessionEvaluationReadResponseSchema,
  SessionHistoryReadResponseSchema,
  SessionReplayReadResponseSchema,
  type SessionEvaluationReadResponse,
  type SessionHistoryReadResponse,
  type SessionReplayReadResponse
} from "../../../packages/replay/src/index.js";
import type { SessionId } from "../../../packages/domain/src/index.js";

export interface BrowserReadClientOptions {
  readonly baseUrl: string;
  readonly clientToken?: string;
  readonly externalAuthenticationHeaderValue?: string;
  readonly fetchImpl?: typeof fetch;
}

export type BrowserReadTransportErrorKind = "ABORTED" | "NETWORK";

export class BrowserReadTransportError extends Error {
  public constructor(public readonly kind: BrowserReadTransportErrorKind) {
    super(kind === "ABORTED" ? "Read request was aborted" : "Read transport failed");
    this.name = "BrowserReadTransportError";
  }
}

export type BrowserReadResponseErrorReason =
  | "HTTP_ERROR"
  | "INVALID_CONTENT_TYPE"
  | "MALFORMED_JSON"
  | "SCHEMA_MISMATCH";

export class BrowserReadResponseError extends Error {
  public constructor(
    public readonly reason: BrowserReadResponseErrorReason,
    public readonly status: number
  ) {
    super("Read server returned an invalid response");
    this.name = "BrowserReadResponseError";
  }
}

export class BrowserReadClient {
  readonly #baseUrl: string;
  readonly #authenticationHeaderValue: string;
  readonly #fetchImpl: typeof fetch;

  public constructor(options: BrowserReadClientOptions) {
    this.#baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    if (
      options.clientToken !== undefined
      && options.externalAuthenticationHeaderValue !== undefined
    ) {
      throw new Error("Read client authentication configuration is ambiguous");
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

  public getEvaluation(
    sessionId: SessionId,
    signal?: AbortSignal
  ): Promise<SessionEvaluationReadResponse> {
    return this.send(
      `/v1/read/sessions/${encodeURIComponent(sessionId)}/evaluation`,
      (value) => SessionEvaluationReadResponseSchema.parse(value),
      signal
    );
  }

  public getReplay(
    sessionId: SessionId,
    signal?: AbortSignal
  ): Promise<SessionReplayReadResponse> {
    return this.send(
      `/v1/read/sessions/${encodeURIComponent(sessionId)}/replay`,
      (value) => SessionReplayReadResponseSchema.parse(value),
      signal
    );
  }

  public getHistory(signal?: AbortSignal): Promise<SessionHistoryReadResponse> {
    return this.send(
      "/v1/read/sessions",
      (value) => SessionHistoryReadResponseSchema.parse(value),
      signal
    );
  }

  private async send<TResult>(
    path: string,
    parse: (value: unknown) => TResult,
    signal: AbortSignal | undefined
  ): Promise<TResult> {
    if (signal?.aborted === true) {
      throw new BrowserReadTransportError("ABORTED");
    }

    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#baseUrl}${path}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-interview-client-token": this.#authenticationHeaderValue
        },
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer",
        ...(signal === undefined ? {} : { signal })
      });
    } catch {
      throw new BrowserReadTransportError(
        signal?.aborted === true ? "ABORTED" : "NETWORK"
      );
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new BrowserReadResponseError("INVALID_CONTENT_TYPE", response.status);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new BrowserReadTransportError(
        signal?.aborted === true ? "ABORTED" : "NETWORK"
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new BrowserReadResponseError("MALFORMED_JSON", response.status);
    }
    if (!response.ok) {
      throw new BrowserReadResponseError("HTTP_ERROR", response.status);
    }

    try {
      return parse(value);
    } catch {
      throw new BrowserReadResponseError("SCHEMA_MISMATCH", response.status);
    }
  }
}

function normalizeLoopbackBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Read server base URL must be a valid URL");
  }
  if (parsed.protocol !== "http:") {
    throw new Error("Read server base URL must use HTTP loopback transport");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
    throw new Error("Read server base URL must target a loopback host");
  }
  if (
    parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.pathname !== "/"
  ) {
    throw new Error("Read server base URL must be an exact origin without credentials or paths");
  }
  return parsed.origin;
}

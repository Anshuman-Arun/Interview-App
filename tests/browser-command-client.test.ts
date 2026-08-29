import { describe, expect, it } from "vitest";
import {
  DeliveryIdSchema,
  RequestIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  InputEpisodeIdSchema,
  type RequestId
} from "../packages/domain/src/index.js";
import {
  BrowserCommandClient,
  BrowserCommandProtocolError,
  BrowserCommandResponseError,
  BrowserCommandTransportError
} from "../apps/web/src/command-client.js";

const CLIENT_TOKEN = "phase0-browser-command-client-token-long-enough";
const BASE_URL = "http://127.0.0.1:43123";
const SESSION_ID = SessionIdSchema.parse("session_browser_test");
const DELIVERY_ID = DeliveryIdSchema.parse("delivery_browser_test");

describe("browser command client", () => {
  it("sends an authenticated loopback POST without ambient browser credentials", async () => {
    const requestId = RequestIdSchema.parse("request_start");
    const calls: FetchCall[] = [];
    const client = createClient({
      calls,
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "SESSION_STARTED",
        requestId,
        sessionId: SESSION_ID
      })
    });

    const result = await client.startSession(SESSION_ID);

    expect(result.requestId).toBe(requestId);
    expect(calls).toHaveLength(1);
    const call = requireCall(calls);
    expect(String(call.input)).toBe(`${BASE_URL}/v1/commands`);
    expect(call.init.method).toBe("POST");
    expect(call.init.credentials).toBe("omit");
    expect(call.init.mode).toBe("cors");
    expect(call.init.redirect).toBe("error");
    expect(call.init.referrerPolicy).toBe("no-referrer");
    expect(call.init.cache).toBe("no-store");

    const headers = new Headers(call.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-interview-client-token")).toBe(CLIENT_TOKEN);
    expect(headers.has("origin")).toBe(false);

    const body = String(call.init.body);
    expect(JSON.parse(body)).toEqual({
      protocolVersion: 1,
      type: "START_SESSION",
      requestId,
      sessionId: SESSION_ID
    });
    expect(body).not.toContain(CLIENT_TOKEN);
    expect(String(call.input)).not.toContain(CLIENT_TOKEN);
  });

  it("serializes COMMIT_TYPED_INPUT with the caller text and no credential material", async () => {
    const requestId = RequestIdSchema.parse("request_input");
    const inputEpisodeId = InputEpisodeIdSchema.parse("episode_browser_test");
    const turnId = TurnIdSchema.parse("turn_browser_test");
    const calls: FetchCall[] = [];
    const client = createClient({
      calls,
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "INPUT_COMMITTED",
        requestId,
        inputEpisodeId,
        turnId
      })
    });

    const result = await client.commitTypedInput(SESSION_ID, "I think the graph must contain a triangle.");

    expect(result).toEqual({
      protocolVersion: 1,
      ok: true,
      type: "INPUT_COMMITTED",
      requestId,
      inputEpisodeId,
      turnId
    });
    expect(JSON.parse(String(requireCall(calls).init.body))).toEqual({
      protocolVersion: 1,
      type: "COMMIT_TYPED_INPUT",
      requestId,
      sessionId: SESSION_ID,
      text: "I think the graph must contain a triangle."
    });
  });

  it("parses a strict session summary response", async () => {
    const requestId = RequestIdSchema.parse("request_summary");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "SESSION_SUMMARY",
        requestId,
        sessionId: SESSION_ID,
        sequence: 7,
        started: true,
        contextEpoch: 2,
        deliveryStatuses: {
          [DELIVERY_ID]: "EXPOSED"
        }
      })
    });

    const result = await client.getSessionSummary(SESSION_ID);
    expect(result.deliveryStatuses[DELIVERY_ID]).toBe("EXPOSED");
    expect(result.sequence).toBe(7);
  });

  it("serializes reconnect and verifies the returned DeliveryId", async () => {
    const requestId = RequestIdSchema.parse("request_reconnect");
    const calls: FetchCall[] = [];
    const client = createClient({
      calls,
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "DELIVERY_RECONNECT",
        requestId,
        deliveryId: DELIVERY_ID,
        status: "POSSIBLY_EXPOSED"
      })
    });

    const result = await client.reconnectDelivery(SESSION_ID, DELIVERY_ID);

    expect(result.status).toBe("POSSIBLY_EXPOSED");
    expect(JSON.parse(String(requireCall(calls).init.body)).type).toBe("RECONNECT_DELIVERY");
  });

  it.each([
    {
      method: "acknowledgeDeliveryExposed" as const,
      commandType: "ACK_DELIVERY_EXPOSED",
      acknowledgement: "EXPOSED" as const,
      requestId: RequestIdSchema.parse("request_ack_exposed")
    },
    {
      method: "acknowledgeDeliveryCompleted" as const,
      commandType: "ACK_DELIVERY_COMPLETED",
      acknowledgement: "COMPLETED" as const,
      requestId: RequestIdSchema.parse("request_ack_completed")
    }
  ])("serializes $commandType and verifies acknowledgement correlation", async (testCase) => {
    const calls: FetchCall[] = [];
    const client = createClient({
      calls,
      requestIdFactory: () => testCase.requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "DELIVERY_ACKNOWLEDGED",
        requestId: testCase.requestId,
        deliveryId: DELIVERY_ID,
        acknowledgement: testCase.acknowledgement
      })
    });

    const result = await client[testCase.method](SESSION_ID, DELIVERY_ID);

    expect(result.acknowledgement).toBe(testCase.acknowledgement);
    expect(JSON.parse(String(requireCall(calls).init.body)).type).toBe(testCase.commandType);
  });

  it("preserves an explicitly supplied RequestId across an uncertain retry", async () => {
    const requestId = RequestIdSchema.parse("request_retry_stable");
    const inputEpisodeId = InputEpisodeIdSchema.parse("episode_retry");
    const turnId = TurnIdSchema.parse("turn_retry");
    const calls: FetchCall[] = [];
    let attempt = 0;
    const fetchImpl = asFetch(async (input, init) => {
      calls.push({ input, init: requireInit(init) });
      attempt += 1;
      if (attempt === 1) throw new Error(`network exploded with ${CLIENT_TOKEN}`);
      return jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "INPUT_COMMITTED",
        requestId,
        inputEpisodeId,
        turnId
      });
    });
    const client = new BrowserCommandClient({
      baseUrl: BASE_URL,
      clientToken: CLIENT_TOKEN,
      fetchImpl
    });

    let firstError: unknown;
    try {
      await client.commitTypedInput(SESSION_ID, "retry me", { requestId });
    } catch (error) {
      firstError = error;
    }

    expect(firstError).toBeInstanceOf(BrowserCommandTransportError);
    if (!(firstError instanceof BrowserCommandTransportError)) {
      throw new Error("Expected BrowserCommandTransportError");
    }
    expect(firstError.kind).toBe("NETWORK");
    expect(firstError.requestId).toBe(requestId);
    expect(String(firstError)).not.toContain(CLIENT_TOKEN);

    const second = await client.commitTypedInput(SESSION_ID, "retry me", { requestId });
    expect(second.requestId).toBe(requestId);
    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.init.body)).toBe(String(calls[1]?.init.body));
  });

  it("creates a fresh RequestId for each new logical call when none is supplied", async () => {
    const requestIds = [
      RequestIdSchema.parse("request_generated_1"),
      RequestIdSchema.parse("request_generated_2")
    ];
    let index = 0;
    const calls: FetchCall[] = [];
    const fetchImpl = asFetch(async (input, init) => {
      const call = { input, init: requireInit(init) };
      calls.push(call);
      const command = JSON.parse(String(call.init.body)) as { requestId: RequestId };
      return jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "SESSION_STARTED",
        requestId: command.requestId,
        sessionId: SESSION_ID
      });
    });
    const client = new BrowserCommandClient({
      baseUrl: BASE_URL,
      clientToken: CLIENT_TOKEN,
      fetchImpl,
      requestIdFactory: () => {
        const value = requestIds[index];
        if (value === undefined) throw new Error("RequestId factory exhausted");
        index += 1;
        return value;
      }
    });

    await client.startSession(SESSION_ID);
    await client.startSession(SESSION_ID);

    expect(JSON.parse(String(calls[0]?.init.body)).requestId).toBe(requestIds[0]);
    expect(JSON.parse(String(calls[1]?.init.body)).requestId).toBe(requestIds[1]);
  });

  it("does not call fetch for a signal that is already aborted", async () => {
    let fetchCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const requestId = RequestIdSchema.parse("request_preaborted");
    const client = new BrowserCommandClient({
      baseUrl: BASE_URL,
      clientToken: CLIENT_TOKEN,
      requestIdFactory: () => requestId,
      fetchImpl: asFetch(async () => {
        fetchCalls += 1;
        throw new Error("should not execute");
      })
    });

    await expect(client.startSession(SESSION_ID, {
      signal: controller.signal
    })).rejects.toMatchObject({
      name: "BrowserCommandTransportError",
      kind: "ABORTED",
      requestId
    });
    expect(fetchCalls).toBe(0);
  });

  it("classifies an in-flight aborted fetch without retaining the thrown cause", async () => {
    const controller = new AbortController();
    const requestId = RequestIdSchema.parse("request_aborted");
    const client = new BrowserCommandClient({
      baseUrl: BASE_URL,
      clientToken: CLIENT_TOKEN,
      requestIdFactory: () => requestId,
      fetchImpl: asFetch(async () => {
        controller.abort();
        throw new Error(`abort details ${CLIENT_TOKEN}`);
      })
    });

    let caught: unknown;
    try {
      await client.startSession(SESSION_ID, { signal: controller.signal });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrowserCommandTransportError);
    if (!(caught instanceof BrowserCommandTransportError)) {
      throw new Error("Expected BrowserCommandTransportError");
    }
    expect(caught.kind).toBe("ABORTED");
    expect(caught.requestId).toBe(requestId);
    expect(String(caught)).not.toContain(CLIENT_TOKEN);
  });

  it("turns a valid server protocol error into a typed error without retaining its message", async () => {
    const requestId = RequestIdSchema.parse("request_conflict");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: false,
        error: {
          code: "CONFLICT",
          message: `server message containing ${CLIENT_TOKEN}`
        }
      }, 409)
    });

    let caught: unknown;
    try {
      await client.startSession(SESSION_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrowserCommandProtocolError);
    if (!(caught instanceof BrowserCommandProtocolError)) {
      throw new Error("Expected BrowserCommandProtocolError");
    }
    expect(caught.status).toBe(409);
    expect(caught.code).toBe("CONFLICT");
    expect(caught.requestId).toBe(requestId);
    expect(String(caught)).not.toContain(CLIENT_TOKEN);
    expect(String(caught)).not.toContain("server message");
  });

  it("rejects a non-JSON content type before parsing the body", async () => {
    const requestId = RequestIdSchema.parse("request_bad_content_type");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: new Response(CLIENT_TOKEN, {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    });

    await expect(client.startSession(SESSION_ID)).rejects.toMatchObject({
      name: "BrowserCommandResponseError",
      reason: "INVALID_CONTENT_TYPE",
      requestId,
      status: 200
    });
  });

  it("rejects malformed JSON with a fixed response error", async () => {
    const requestId = RequestIdSchema.parse("request_bad_json");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: new Response("{bad-json", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });

    await expect(client.startSession(SESSION_ID)).rejects.toMatchObject({
      name: "BrowserCommandResponseError",
      reason: "MALFORMED_JSON",
      requestId
    });
  });

  it("rejects a success body with extra fields under the strict protocol schema", async () => {
    const requestId = RequestIdSchema.parse("request_extra_field");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "SESSION_STARTED",
        requestId,
        sessionId: SESSION_ID,
        unexpected: true
      })
    });

    await expect(client.startSession(SESSION_ID)).rejects.toMatchObject({
      name: "BrowserCommandResponseError",
      reason: "SCHEMA_MISMATCH",
      requestId
    });
  });

  it("rejects a success response for the wrong command type", async () => {
    const requestId = RequestIdSchema.parse("request_wrong_type");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "INPUT_COMMITTED",
        requestId,
        inputEpisodeId: InputEpisodeIdSchema.parse("episode_wrong_type"),
        turnId: TurnIdSchema.parse("turn_wrong_type")
      })
    });

    await expect(client.startSession(SESSION_ID)).rejects.toMatchObject({
      reason: "SCHEMA_MISMATCH",
      requestId
    });
  });

  it("rejects a response carrying a different RequestId", async () => {
    const requestId = RequestIdSchema.parse("request_expected");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "SESSION_STARTED",
        requestId: RequestIdSchema.parse("request_other"),
        sessionId: SESSION_ID
      })
    });

    await expect(client.startSession(SESSION_ID)).rejects.toMatchObject({
      reason: "REQUEST_ID_MISMATCH",
      requestId
    });
  });

  it("rejects a start response correlated to a different SessionId", async () => {
    const requestId = RequestIdSchema.parse("request_wrong_session");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "SESSION_STARTED",
        requestId,
        sessionId: SessionIdSchema.parse("session_other")
      })
    });

    await expect(client.startSession(SESSION_ID)).rejects.toMatchObject({
      reason: "CORRELATION_MISMATCH",
      requestId
    });
  });

  it("rejects a reconnect response correlated to a different DeliveryId", async () => {
    const requestId = RequestIdSchema.parse("request_wrong_delivery");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "DELIVERY_RECONNECT",
        requestId,
        deliveryId: DeliveryIdSchema.parse("delivery_other"),
        status: "DELIVERING"
      })
    });

    await expect(
      client.reconnectDelivery(SESSION_ID, DELIVERY_ID)
    ).rejects.toMatchObject({
      reason: "CORRELATION_MISMATCH",
      requestId
    });
  });

  it("rejects an acknowledgement with the wrong phase", async () => {
    const requestId = RequestIdSchema.parse("request_wrong_ack");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "DELIVERY_ACKNOWLEDGED",
        requestId,
        deliveryId: DELIVERY_ID,
        acknowledgement: "COMPLETED"
      })
    });

    await expect(
      client.acknowledgeDeliveryExposed(SESSION_ID, DELIVERY_ID)
    ).rejects.toMatchObject({
      reason: "CORRELATION_MISMATCH",
      requestId
    });
  });

  it("rejects an HTTP error whose body is not a strict protocol error", async () => {
    const requestId = RequestIdSchema.parse("request_invalid_error");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: jsonResponse({
        protocolVersion: 1,
        ok: true,
        type: "SESSION_STARTED",
        requestId,
        sessionId: SESSION_ID
      }, 500)
    });

    await expect(client.startSession(SESSION_ID)).rejects.toMatchObject({
      reason: "SCHEMA_MISMATCH",
      requestId,
      status: 500
    });
  });

  it("does not expose the private token through ordinary object serialization", () => {
    const client = new BrowserCommandClient({
      baseUrl: BASE_URL,
      clientToken: CLIENT_TOKEN,
      fetchImpl: asFetch(async () => {
        throw new Error("unused");
      })
    });

    expect(JSON.stringify(client)).toBe("{}");
    expect(Object.keys(client)).toEqual([]);
    expect(String(client)).not.toContain(CLIENT_TOKEN);
  });

  it.each([
    "https://127.0.0.1:43123",
    "http://localhost:43123",
    "http://example.com:43123",
    "http://127.0.0.1:43123/path",
    "http://127.0.0.1:43123/?query=yes",
    "http://127.0.0.1:43123/#fragment",
    "http://user:pass@127.0.0.1:43123"
  ])("rejects non-exact or non-loopback base URL %s", (baseUrl) => {
    expect(() => new BrowserCommandClient({
      baseUrl,
      clientToken: CLIENT_TOKEN,
      fetchImpl: asFetch(async () => {
        throw new Error("unused");
      })
    })).toThrow();
  });

  it("accepts an IPv6 loopback origin", () => {
    expect(() => new BrowserCommandClient({
      baseUrl: "http://[::1]:43123",
      clientToken: CLIENT_TOKEN,
      fetchImpl: asFetch(async () => {
        throw new Error("unused");
      })
    })).not.toThrow();
  });

  it("rejects a short client token before any request can be made", () => {
    expect(() => new BrowserCommandClient({
      baseUrl: BASE_URL,
      clientToken: "short",
      fetchImpl: asFetch(async () => {
        throw new Error("unused");
      })
    })).toThrow("Client token must contain at least 32 characters");
  });

  it("does not retain raw malformed-response content in its error", async () => {
    const requestId = RequestIdSchema.parse("request_secret_response");
    const client = createClient({
      requestIdFactory: () => requestId,
      response: new Response(`not-json ${CLIENT_TOKEN}`, {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });

    let caught: unknown;
    try {
      await client.startSession(SESSION_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrowserCommandResponseError);
    expect(String(caught)).not.toContain(CLIENT_TOKEN);
  });
});

interface FetchCall {
  readonly input: Parameters<typeof fetch>[0];
  readonly init: RequestInit;
}

function createClient(options: {
  readonly response: Response;
  readonly requestIdFactory: () => RequestId;
  readonly calls?: FetchCall[];
}): BrowserCommandClient {
  const calls = options.calls;
  return new BrowserCommandClient({
    baseUrl: BASE_URL,
    clientToken: CLIENT_TOKEN,
    requestIdFactory: options.requestIdFactory,
    fetchImpl: asFetch(async (input, init) => {
      calls?.push({ input, init: requireInit(init) });
      return options.response.clone();
    })
  });
}

function asFetch(
  implementation: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => Promise<Response>
): typeof fetch {
  return implementation as typeof fetch;
}

function requireInit(init: RequestInit | undefined): RequestInit {
  if (init === undefined) throw new Error("Expected fetch RequestInit");
  return init;
}

function requireCall(calls: readonly FetchCall[]): FetchCall {
  const call = calls[0];
  if (call === undefined) throw new Error("Expected one fetch call");
  return call;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

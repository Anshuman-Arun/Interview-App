import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProtocolErrorResponseSchema,
  SessionStartedResponseSchema,
  newRequestId,
  newSessionId
} from "../packages/domain/src/index.js";
import { SessionRuntimeRegistry } from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import {
  LoopbackCommandServer,
  type BoundLoopbackAddress
} from "../apps/server/src/loopback-command-server.js";

const CLIENT_TOKEN = "phase0-cors-test-client-token-that-is-long-enough";
const CLIENT_ORIGIN = "http://127.0.0.1:5173";
const ATTACKER_ORIGIN = "http://attacker.invalid";

describe("loopback command browser CORS boundary", () => {
  let store: SqliteEventStore;
  let server: LoopbackCommandServer;
  let address: BoundLoopbackAddress;

  beforeEach(async () => {
    store = new SqliteEventStore(":memory:");
    server = new LoopbackCommandServer({
      security: {
        host: "127.0.0.1",
        allowedOrigins: new Set([CLIENT_ORIGIN]),
        clientToken: CLIENT_TOKEN
      },
      registry: new SessionRuntimeRegistry(store)
    });
    address = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    store.close();
  });

  it("answers an allowed preflight without requiring the client token or mutating session state", async () => {
    const sessionId = newSessionId();
    const response = await preflight(address, {
      origin: CLIENT_ORIGIN,
      method: "POST",
      headers: "X-INTERVIEW-CLIENT-TOKEN, Content-Type"
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type, x-interview-client-token"
    );
    expect(response.headers.get("access-control-max-age")).toBe("300");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
    );
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(JSON.stringify([...response.headers])).not.toContain(CLIENT_TOKEN);
    expect(store.eventCount(sessionId)).toBe(0);
  });

  it("allows a POST preflight that requests no non-simple headers", async () => {
    const response = await preflight(address, {
      origin: CLIENT_ORIGIN,
      method: "post"
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
  });

  it.each([
    { name: "missing", origin: undefined },
    { name: "foreign", origin: ATTACKER_ORIGIN },
    { name: "near-match", origin: `${CLIENT_ORIGIN}/` }
  ])("rejects a $name preflight origin without reflecting it", async ({ origin }) => {
    const sessionId = newSessionId();
    const response = await preflight(address, {
      origin,
      method: "POST",
      headers: "content-type, x-interview-client-token"
    });

    expect(response.status).toBe(403);
    expect(
      ProtocolErrorResponseSchema.parse(await response.json()).error.code
    ).toBe("ORIGIN_FORBIDDEN");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(store.eventCount(sessionId)).toBe(0);
  });

  it.each(["GET", "DELETE", "PATCH", ""])(
    "rejects preflight method %j before command dispatch",
    async (method) => {
      const sessionId = newSessionId();
      const response = await preflight(address, {
        origin: CLIENT_ORIGIN,
        method,
        headers: "content-type, x-interview-client-token"
      });

      expect(response.status).toBe(400);
      expect(
        ProtocolErrorResponseSchema.parse(await response.json()).error.code
      ).toBe("INVALID_COMMAND");
      expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
      expect(store.eventCount(sessionId)).toBe(0);
    }
  );

  it.each([
    "x-evil",
    "content-type, x-interview-client-token, authorization",
    "*",
    "content-type, , x-interview-client-token"
  ])("rejects disallowed preflight header list %j", async (headers) => {
    const sessionId = newSessionId();
    const response = await preflight(address, {
      origin: CLIENT_ORIGIN,
      method: "POST",
      headers
    });

    expect(response.status).toBe(400);
    expect(
      ProtocolErrorResponseSchema.parse(await response.json()).error.code
    ).toBe("INVALID_COMMAND");
    expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(store.eventCount(sessionId)).toBe(0);
  });

  it("returns exact CORS headers on a successful browser POST", async () => {
    const sessionId = newSessionId();
    const response = await postCommand(address, startCommand(sessionId), {
      origin: CLIENT_ORIGIN,
      token: CLIENT_TOKEN
    });

    expect(response.status).toBe(200);
    expect(
      SessionStartedResponseSchema.parse(await response.json()).sessionId
    ).toBe(sessionId);
    expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(store.eventCount(sessionId)).toBe(2);
  });

  it("lets an allowed browser origin read authentication failures without exposing the token", async () => {
    const sessionId = newSessionId();
    const response = await postCommand(address, startCommand(sessionId), {
      origin: CLIENT_ORIGIN,
      token: undefined
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(
      ProtocolErrorResponseSchema.parse(JSON.parse(body) as unknown).error.code
    ).toBe("UNAUTHORIZED");
    expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(body).not.toContain(CLIENT_TOKEN);
    expect(JSON.stringify([...response.headers])).not.toContain(CLIENT_TOKEN);
    expect(store.eventCount(sessionId)).toBe(0);
  });

  it("does not emit an allow-origin header for a rejected browser origin", async () => {
    const sessionId = newSessionId();
    const response = await postCommand(address, startCommand(sessionId), {
      origin: ATTACKER_ORIGIN,
      token: CLIENT_TOKEN
    });

    expect(response.status).toBe(403);
    expect(
      ProtocolErrorResponseSchema.parse(await response.json()).error.code
    ).toBe("ORIGIN_FORBIDDEN");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(store.eventCount(sessionId)).toBe(0);
  });

  it("fails closed when an actual command omits Origin", async () => {
    const sessionId = newSessionId();
    const response = await postCommand(address, startCommand(sessionId), {
      origin: undefined,
      token: CLIENT_TOKEN
    });

    expect(response.status).toBe(403);
    expect(
      ProtocolErrorResponseSchema.parse(await response.json()).error.code
    ).toBe("ORIGIN_FORBIDDEN");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(store.eventCount(sessionId)).toBe(0);
  });

  it("rejects non-POST command methods and still scopes CORS to the allowed origin", async () => {
    const sessionId = newSessionId();
    const response = await fetch(`${address.url}/v1/commands`, {
      method: "GET",
      headers: {
        origin: CLIENT_ORIGIN,
        "x-interview-client-token": CLIENT_TOKEN
      }
    });

    expect(response.status).toBe(404);
    expect(
      ProtocolErrorResponseSchema.parse(await response.json()).error.code
    ).toBe("NOT_FOUND");
    expect(response.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
    expect(response.headers.get("access-control-allow-headers")).toBeNull();
    expect(store.eventCount(sessionId)).toBe(0);
  });
});

function startCommand(sessionId: ReturnType<typeof newSessionId>) {
  return {
    protocolVersion: 1 as const,
    type: "START_SESSION" as const,
    requestId: newRequestId(),
    sessionId
  };
}

async function preflight(
  address: BoundLoopbackAddress,
  options: {
    readonly origin?: string | undefined;
    readonly method: string;
    readonly headers?: string | undefined;
  }
): Promise<Response> {
  const headers: Record<string, string> = {
    "access-control-request-method": options.method
  };
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.headers !== undefined) {
    headers["access-control-request-headers"] = options.headers;
  }

  return fetch(`${address.url}/v1/commands`, {
    method: "OPTIONS",
    headers
  });
}

async function postCommand(
  address: BoundLoopbackAddress,
  body: unknown,
  options: {
    readonly origin?: string | undefined;
    readonly token?: string | undefined;
  }
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.token !== undefined) {
    headers["x-interview-client-token"] = options.token;
  }

  return fetch(`${address.url}/v1/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

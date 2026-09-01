import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DeliveryReconnectResponseSchema,
  DeliveryAcknowledgedResponseSchema,
  InputCommittedResponseSchema,
  ProtocolErrorResponseSchema,
  SessionStartedResponseSchema,
  newRequestId,
  newSessionId,
  type SessionId
} from "../packages/domain/src/index.js";
import { DeliveryCoordinator, MockRenderer } from "../packages/delivery/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { LoopbackCommandServer, type BoundLoopbackAddress } from "../apps/server/src/loopback-command-server.js";
import { SessionRecoveryCoordinator } from "../apps/server/src/session-recovery-coordinator.js";

const CLIENT_TOKEN = "phase0-test-client-token-that-is-long-enough";
const CLIENT_ORIGIN = "http://127.0.0.1:5173";

describe("authenticated loopback command protocol", () => {
  let store: SqliteEventStore;
  let registry: SessionRuntimeRegistry;
  let sessions: SessionRecoveryCoordinator;
  let server: LoopbackCommandServer;
  let address: BoundLoopbackAddress;

  beforeEach(async () => {
    store = new SqliteEventStore(":memory:");
    registry = new SessionRuntimeRegistry(store);
    sessions = new SessionRecoveryCoordinator(registry);
    server = new LoopbackCommandServer({
      security: {
        host: "127.0.0.1",
        allowedOrigins: new Set([CLIENT_ORIGIN]),
        clientToken: CLIENT_TOKEN
      },
      sessions
    });
    address = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    store.close();
  });

  it("binds only to the configured loopback address and rejects unauthorized clients before mutation", async () => {
    expect(address.host).toBe("127.0.0.1");
    expect(new URL(address.url).hostname).toBe("127.0.0.1");
    const sessionId = newSessionId();
    const command = startCommand(sessionId);

    const missingToken = await postCommand(address, command, { token: undefined });
    expect(missingToken.status).toBe(401);
    expect(ProtocolErrorResponseSchema.parse(await missingToken.json()).error.code).toBe("UNAUTHORIZED");

    const wrongOrigin = await postCommand(address, command, { origin: "http://attacker.invalid" });
    expect(wrongOrigin.status).toBe(403);
    expect(ProtocolErrorResponseSchema.parse(await wrongOrigin.json()).error.code).toBe("ORIGIN_FORBIDDEN");
    expect(store.eventCount(sessionId)).toBe(0);
  });

  it("supports exact-Origin browser preflight and emits no wildcard credential policy", async () => {
    const preflight = await fetch(`${address.url}/v1/commands`, {
      method: "OPTIONS",
      headers: {
        origin: CLIENT_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-interview-client-token"
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(preflight.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-interview-client-token");

    const forbidden = await fetch(`${address.url}/v1/commands`, {
      method: "OPTIONS",
      headers: { origin: "http://attacker.invalid" }
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("access-control-allow-origin")).toBeNull();

    const command = await postCommand(address, startCommand(newSessionId()));
    expect(command.status).toBe(200);
    expect(command.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(command.headers.get("vary")).toContain("Origin");
  });

  it("rejects malformed or non-JSON protocol commands without returning validation internals", async () => {
    const malformedJson = await postRaw(address, "{not-json", "application/json");
    expect(malformedJson.status).toBe(400);
    const malformedBody = JSON.stringify(await malformedJson.json());
    expect(malformedBody).not.toContain("ZodError");
    expect(malformedBody).not.toContain(CLIENT_TOKEN);

    const extraField = await postCommand(address, { ...startCommand(newSessionId()), clientToken: CLIENT_TOKEN });
    expect(extraField.status).toBe(400);
    expect(ProtocolErrorResponseSchema.parse(await extraField.json()).error.code).toBe("INVALID_COMMAND");

    const wrongContentType = await postRaw(address, JSON.stringify(startCommand(newSessionId())), "text/plain");
    expect(wrongContentType.status).toBe(415);
    expect(ProtocolErrorResponseSchema.parse(await wrongContentType.json()).error.code).toBe("INVALID_CONTENT_TYPE");
  });

  it("durably deduplicates session start and typed input using the browser RequestId", async () => {
    const sessionId = newSessionId();
    const start = startCommand(sessionId);
    const firstStart = SessionStartedResponseSchema.parse(await (await postCommand(address, start)).json());
    const secondStart = SessionStartedResponseSchema.parse(await (await postCommand(address, start)).json());
    expect(secondStart).toEqual(firstStart);
    expect(store.eventCount(sessionId)).toBe(2);

    const input = {
      protocolVersion: 1 as const,
      type: "COMMIT_TYPED_INPUT" as const,
      requestId: newRequestId(),
      sessionId,
      text: "authorization=do-not-echo api_key=also-do-not-echo"
    };
    const firstResponse = await postCommand(address, input);
    const firstText = await firstResponse.text();
    const firstInput = InputCommittedResponseSchema.parse(JSON.parse(firstText) as unknown);
    const secondResponse = await postCommand(address, input);
    const secondText = await secondResponse.text();
    const secondInput = InputCommittedResponseSchema.parse(JSON.parse(secondText) as unknown);

    expect(secondInput).toEqual(firstInput);
    expect(store.eventCount(sessionId)).toBe(6);
    expect(firstText).not.toContain("do-not-echo");
    expect(firstText).not.toContain("api_key");
    expect(secondText).not.toContain(CLIENT_TOKEN);
  });

  it("reissues the same DeliveryId on reconnect and relies on renderer idempotency", async () => {
    const sessionId = newSessionId();
    await postCommand(address, startCommand(sessionId));
    const inputResponse = InputCommittedResponseSchema.parse(await (await postCommand(address, {
      protocolVersion: 1,
      type: "COMMIT_TYPED_INPUT",
      requestId: newRequestId(),
      sessionId,
      text: "I have a claim but no justification."
    })).json());

    const writer = registry.get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.selectAction(inputResponse.turnId, sixPeopleProblem);
    const generation = await turns.startGeneration(inputResponse.inputEpisodeId, inputResponse.turnId, "mock-model");
    const safeProbe = "Why must that step be true?";
    const proposal = await turns.processProposal({
      envelope: createCommandEnvelope({
        sessionId,
        producer: "mock-model",
        inputEpisodeId: inputResponse.inputEpisodeId,
        turnId: inputResponse.turnId,
        generationId: generation.generationId
      }),
      problem: sixPeopleProblem,
      proposal: {
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: safeProbe
      },
      validator: new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([safeProbe]))
    });
    const atom = proposal.deliveryAtoms[0];
    if (atom === undefined) throw new Error("Expected a queued delivery atom");

    const reconnect = {
      protocolVersion: 1 as const,
      type: "RECONNECT_DELIVERY" as const,
      requestId: newRequestId(),
      sessionId,
      deliveryId: atom.deliveryId
    };
    const first = DeliveryReconnectResponseSchema.parse(await (await postCommand(address, reconnect)).json());
    const eventCountAfterStart = store.eventCount(sessionId);
    const duplicate = DeliveryReconnectResponseSchema.parse(await (await postCommand(address, reconnect)).json());
    const laterReconnect = DeliveryReconnectResponseSchema.parse(await (await postCommand(address, {
      ...reconnect,
      requestId: newRequestId()
    })).json());

    expect(first.status).toBe("DELIVERING");
    expect(duplicate).toEqual(first);
    expect(laterReconnect.command).toEqual(first.command);
    expect(laterReconnect.deliveryId).toBe(atom.deliveryId);
    expect(store.eventCount(sessionId)).toBe(eventCountAfterStart);

    if (first.command === undefined || laterReconnect.command === undefined) throw new Error("Expected reconnect commands");
    const renderer = new MockRenderer();
    await renderer.deliver(first.command);
    await renderer.deliver(laterReconnect.command);
    expect(renderer.visibleDeliveryIds).toEqual([atom.deliveryId]);

    const exposedAck = {
      protocolVersion: 1 as const,
      type: "ACK_DELIVERY_EXPOSED" as const,
      requestId: newRequestId(),
      sessionId,
      deliveryId: atom.deliveryId
    };
    const exposed = DeliveryAcknowledgedResponseSchema.parse(await (await postCommand(address, exposedAck)).json());
    const eventCountAfterExposure = store.eventCount(sessionId);
    const duplicateExposed = DeliveryAcknowledgedResponseSchema.parse(await (await postCommand(address, exposedAck)).json());
    expect(exposed.acknowledgement).toBe("EXPOSED");
    expect(duplicateExposed).toEqual(exposed);
    expect(store.eventCount(sessionId)).toBe(eventCountAfterExposure);

    const completed = DeliveryAcknowledgedResponseSchema.parse(await (await postCommand(address, {
      protocolVersion: 1,
      type: "ACK_DELIVERY_COMPLETED",
      requestId: newRequestId(),
      sessionId,
      deliveryId: atom.deliveryId
    })).json());
    expect(completed.acknowledgement).toBe("COMPLETED");
    expect(writer.getState().deliveries[atom.deliveryId]?.status).toBe("COMPLETED");

    const summaryText = await (await postCommand(address, {
      protocolVersion: 1,
      type: "GET_SESSION_SUMMARY",
      requestId: newRequestId(),
      sessionId
    })).text();
    expect(summaryText).not.toContain(CLIENT_TOKEN);
    expect(summaryText).not.toContain(sixPeopleProblem.private.canonicalSolution);
  });

  it("recovers persisted in-flight delivery before reconnect after application restart", async () => {
    await server.stop();
    const sessionId = newSessionId();
    const originalRegistry = new SessionRuntimeRegistry(store);
    const originalWriter = originalRegistry.get(sessionId);
    const originalTurns = new TurnCoordinator(originalWriter);
    await originalTurns.startSession(sixPeopleProblem);
    const input = await originalTurns.commitInput("I have not justified the claim.");
    await originalTurns.selectAction(input.turnId, sixPeopleProblem);
    const generation = await originalTurns.startGeneration(input.inputEpisodeId, input.turnId, "mock-model");
    const safeProbe = "Why must that step be true?";
    const proposal = await originalTurns.processProposal({
      envelope: createCommandEnvelope({
        sessionId,
        producer: "mock-model",
        inputEpisodeId: input.inputEpisodeId,
        turnId: input.turnId,
        generationId: generation.generationId
      }),
      problem: sixPeopleProblem,
      proposal: {
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: safeProbe
      },
      validator: new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([safeProbe]))
    });
    const atom = proposal.deliveryAtoms[0];
    if (atom === undefined) throw new Error("Expected a queued delivery atom");
    await new DeliveryCoordinator(originalWriter).markStarted(atom.deliveryId);
    expect(originalWriter.getState().deliveries[atom.deliveryId]?.status).toBe("DELIVERING");

    registry = new SessionRuntimeRegistry(store);
    sessions = new SessionRecoveryCoordinator(registry);
    server = new LoopbackCommandServer({
      security: {
        host: "127.0.0.1",
        allowedOrigins: new Set([CLIENT_ORIGIN]),
        clientToken: CLIENT_TOKEN
      },
      sessions
    });
    address = await server.start();

    const recovered = DeliveryReconnectResponseSchema.parse(await (await postCommand(address, {
      protocolVersion: 1,
      type: "RECONNECT_DELIVERY",
      requestId: newRequestId(),
      sessionId,
      deliveryId: atom.deliveryId
    })).json());
    expect(recovered.status).toBe("POSSIBLY_EXPOSED");
    expect(recovered.command).toBeUndefined();
    expect(registry.get(sessionId).getState().deliveries[atom.deliveryId]?.status).toBe("POSSIBLY_EXPOSED");
    expect(store.load(sessionId).at(-1)?.type).toBe("DELIVERY_POSSIBLY_EXPOSED");
  });
});

function startCommand(sessionId: SessionId): {
  readonly protocolVersion: 1;
  readonly type: "START_SESSION";
  readonly requestId: ReturnType<typeof newRequestId>;
  readonly sessionId: SessionId;
} {
  return { protocolVersion: 1, type: "START_SESSION", requestId: newRequestId(), sessionId };
}

async function postCommand(
  address: BoundLoopbackAddress,
  body: unknown,
  overrides: { readonly token?: string | undefined; readonly origin?: string } = {}
): Promise<Response> {
  const token = Object.hasOwn(overrides, "token") ? overrides.token : CLIENT_TOKEN;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: overrides.origin ?? CLIENT_ORIGIN
  };
  if (token !== undefined) headers["x-interview-client-token"] = token;
  return fetch(`${address.url}/v1/commands`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function postRaw(address: BoundLoopbackAddress, body: string, contentType: string): Promise<Response> {
  return fetch(`${address.url}/v1/commands`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      origin: CLIENT_ORIGIN,
      "x-interview-client-token": CLIENT_TOKEN
    },
    body
  });
}

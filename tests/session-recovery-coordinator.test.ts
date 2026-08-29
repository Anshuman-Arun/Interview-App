import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionSummaryResponseSchema,
  newRequestId,
  type DeliveryId,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  DeliveryCoordinator,
  RendererStreamAttachRequestSchema
} from "../packages/delivery/src/index.js";
import { SessionRuntimeRegistry } from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import {
  LocalInterviewTransportRuntime,
  SessionRecoveryCoordinator
} from "../apps/server/src/index.js";
import { authorizeSafeProbe, createCoreHarness } from "./harness.js";

const CLIENT_TOKEN = "shared-recovery-client-token-that-is-long-enough";
const CLIENT_ORIGIN = "http://127.0.0.1:5173";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("shared session recovery coordination", () => {
  it("coalesces command and renderer first use into one conservative recovery event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shared-session-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "events.sqlite");

    let store = new SqliteEventStore(databasePath);
    const fixture = await createDeliveringFixture(store);
    store.close();

    store = new SqliteEventStore(databasePath);
    const runtime = new LocalInterviewTransportRuntime({
      security: security(),
      registry: new SessionRuntimeRegistry(store)
    });

    try {
      const [firstBound, duplicateBound] = await Promise.all([
        runtime.start(),
        runtime.start()
      ]);
      expect(duplicateBound).toEqual(firstBound);

      const streamAbort = new AbortController();
      const streamRequest = fetch(firstBound.rendererStream.streamUrl, {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify(RendererStreamAttachRequestSchema.parse({
          protocolVersion: 1,
          type: "ATTACH_RENDERER_STREAM",
          sessionId: fixture.sessionId
        })),
        signal: streamAbort.signal
      });
      const summaryRequest = fetch(`${firstBound.command.url}/v1/commands`, {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          protocolVersion: 1,
          type: "GET_SESSION_SUMMARY",
          requestId: newRequestId(),
          sessionId: fixture.sessionId
        })
      });

      const [streamResponse, summaryResponse] = await Promise.all([
        streamRequest,
        summaryRequest
      ]);
      expect(streamResponse.status).toBe(200);
      const summary = SessionSummaryResponseSchema.parse(await summaryResponse.json());
      expect(summary.deliveryStatuses[fixture.deliveryId]).toBe("POSSIBLY_EXPOSED");

      const recoveryEvents = store.load(fixture.sessionId)
        .filter((event) => event.type === "DELIVERY_POSSIBLY_EXPOSED");
      expect(recoveryEvents).toHaveLength(1);
      expect(recoveryEvents[0]?.payload.deliveryId).toBe(fixture.deliveryId);
      expect(await runtime.rendererStreamServer.publishDelivery(
        fixture.sessionId,
        fixture.deliveryId
      )).toEqual({
        outcome: "NOT_DELIVERABLE",
        deliveryId: fixture.deliveryId,
        status: "POSSIBLY_EXPOSED"
      });

      await runtime.sessions.ensureRecovered(fixture.sessionId);
      expect(store.load(fixture.sessionId)
        .filter((event) => event.type === "DELIVERY_POSSIBLY_EXPOSED"))
        .toHaveLength(1);

      streamAbort.abort();
      await streamResponse.body?.cancel().catch(() => undefined);
    } finally {
      await runtime.stop();
      store.close();
    }
  }, 15_000);

  it("keeps duplicate recovery callers idempotent at the serialized transition boundary", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const fixture = await createDeliveringFixture(store);
      const registry = new SessionRuntimeRegistry(store);
      const first = new SessionRecoveryCoordinator(registry);
      const second = new SessionRecoveryCoordinator(registry);

      const [firstResult, secondResult] = await Promise.all([
        first.ensureRecovered(fixture.sessionId),
        second.ensureRecovered(fixture.sessionId)
      ]);

      expect(firstResult).toContain(fixture.deliveryId);
      expect(secondResult).toContain(fixture.deliveryId);
      expect(store.load(fixture.sessionId)
        .filter((event) => event.type === "DELIVERY_POSSIBLY_EXPOSED"))
        .toHaveLength(1);
      expect(registry.get(fixture.sessionId).getState().deliveries[fixture.deliveryId]?.status)
        .toBe("POSSIBLY_EXPOSED");
    } finally {
      store.close();
    }
  });
});

async function createDeliveringFixture(store: SqliteEventStore): Promise<{
  readonly sessionId: SessionId;
  readonly deliveryId: DeliveryId;
}> {
  const harness = await createCoreHarness(store);
  const atom = await authorizeSafeProbe(harness);
  await new DeliveryCoordinator(harness.writer).markStarted(atom.deliveryId);
  expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("DELIVERING");
  return { sessionId: harness.sessionId, deliveryId: atom.deliveryId };
}

function security() {
  return {
    host: "127.0.0.1" as const,
    allowedOrigins: new Set([CLIENT_ORIGIN]),
    clientToken: CLIENT_TOKEN
  };
}

function authenticatedHeaders(): Record<string, string> {
  return {
    origin: CLIENT_ORIGIN,
    "content-type": "application/json",
    "x-interview-client-token": CLIENT_TOKEN
  };
}

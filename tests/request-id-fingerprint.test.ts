import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { newRequestId, newSessionId } from "../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../packages/delivery/src/index.js";
import { SessionRuntimeRegistry, createCommandEnvelope, fingerprintCommand } from "../packages/interview-engine/src/index.js";
import { RequestIdConflictError, SqliteEventStore } from "../packages/persistence/src/index.js";
import { authorizeSafeProbe, createCoreHarness } from "./harness.js";

const temporaryDirectories: string[] = [];
const StableResultSchema = z.object({ stable: z.literal(true) }).strict();

function temporaryDatabase(prefix: string): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "events.sqlite") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RequestId command fingerprints", () => {
  it("canonicalizes object key order while retaining operation and value identity", () => {
    const sessionId = newSessionId();
    const envelope = createCommandEnvelope({ sessionId, producer: "canonicalization-test" });
    const first = fingerprintCommand(envelope, {
      operation: "CANONICAL_TEST",
      payload: { outer: { beta: 2, alpha: 1 }, enabled: true }
    });
    const reordered = fingerprintCommand(envelope, {
      operation: "CANONICAL_TEST",
      payload: { enabled: true, outer: { alpha: 1, beta: 2 } }
    });
    const changed = fingerprintCommand(envelope, {
      operation: "CANONICAL_TEST",
      payload: { enabled: true, outer: { alpha: 1, beta: 3 } }
    });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("fails closed when exposed and completed acknowledgements reuse one RequestId", async () => {
    const harness = await createCoreHarness();
    try {
      const atom = await authorizeSafeProbe(harness);
      const delivery = new DeliveryCoordinator(harness.writer);
      await delivery.markStarted(atom.deliveryId);
      const envelope = createCommandEnvelope({ sessionId: harness.sessionId, producer: "renderer" });
      await delivery.acknowledgeExposed(atom.deliveryId, envelope);
      const eventCount = harness.store.eventCount(harness.sessionId);

      await expect(delivery.acknowledgeCompleted(atom.deliveryId, envelope))
        .rejects.toBeInstanceOf(RequestIdConflictError);
      expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);
      expect(harness.writer.getState().deliveries[atom.deliveryId]?.status).toBe("EXPOSED");
    } finally {
      harness.store.close();
    }
  });

  it("retains conflict detection after closing and reopening SQLite", async () => {
    const database = temporaryDatabase("interview-request-fingerprint-restart-");
    const firstStore = new SqliteEventStore(database.path);
    const harness = await createCoreHarness(firstStore);
    const atom = await authorizeSafeProbe(harness);
    const firstDelivery = new DeliveryCoordinator(harness.writer);
    await firstDelivery.markStarted(atom.deliveryId);
    const envelope = createCommandEnvelope({ sessionId: harness.sessionId, producer: "renderer" });
    await firstDelivery.acknowledgeExposed(atom.deliveryId, envelope);
    firstStore.close();

    const reopenedStore = new SqliteEventStore(database.path);
    try {
      const restartedWriter = new SessionRuntimeRegistry(reopenedStore).get(harness.sessionId);
      await expect(new DeliveryCoordinator(restartedWriter).acknowledgeCompleted(atom.deliveryId, envelope))
        .rejects.toBeInstanceOf(RequestIdConflictError);
      expect(restartedWriter.getState().deliveries[atom.deliveryId]?.status).toBe("EXPOSED");
    } finally {
      reopenedStore.close();
    }
  });

  it("serializes simultaneous conflicting submissions so exactly one identity wins", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = newSessionId();
    const writer = new SessionRuntimeRegistry(store).get(sessionId);
    const envelope = createCommandEnvelope({ sessionId, producer: "concurrency-test" });
    try {
      const outcomes = await Promise.allSettled([
        writer.execute(envelope, { operation: "CONCURRENT_ALPHA", payload: { value: 1 } }, StableResultSchema, () => ({ drafts: [], result: { stable: true as const } })),
        writer.execute(envelope, { operation: "CONCURRENT_BETA", payload: { value: 2 } }, StableResultSchema, () => ({ drafts: [], result: { stable: true as const } }))
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejection = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejection?.status === "rejected" ? rejection.reason : undefined).toBeInstanceOf(RequestIdConflictError);
    } finally {
      store.close();
    }
  });

  it("fails closed for legacy processed requests that have no command fingerprint", async () => {
    const database = temporaryDatabase("interview-request-fingerprint-legacy-");
    const sessionId = newSessionId();
    const requestId = newRequestId();
    const legacyDatabase = new DatabaseSync(database.path);
    legacyDatabase.exec(`
      CREATE TABLE processed_requests (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (session_id, request_id)
      ) STRICT;
    `);
    legacyDatabase.prepare("INSERT INTO processed_requests (session_id, request_id, result_json) VALUES (?, ?, ?)")
      .run(sessionId, requestId, JSON.stringify({ stable: true }));
    legacyDatabase.close();

    const store = new SqliteEventStore(database.path);
    try {
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const envelope = createCommandEnvelope({ sessionId, producer: "legacy-test", requestId });
      await expect(writer.execute(
        envelope,
        { operation: "LEGACY_RETRY", payload: {} },
        StableResultSchema,
        () => ({ drafts: [], result: { stable: true as const } })
      )).rejects.toBeInstanceOf(RequestIdConflictError);
      expect(store.eventCount(sessionId)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("persists only a fixed-length hash, never raw command identity payloads", async () => {
    const database = temporaryDatabase("interview-request-fingerprint-secret-");
    const store = new SqliteEventStore(database.path);
    const sessionId = newSessionId();
    const writer = new SessionRuntimeRegistry(store).get(sessionId);
    const envelope = createCommandEnvelope({ sessionId, producer: "secret-boundary-test" });
    const sentinel = "must-not-be-persisted-command-secret";
    await writer.execute(
      envelope,
      { operation: "SECRET_BOUNDARY_TEST", payload: { providerCredential: sentinel } },
      StableResultSchema,
      () => ({ drafts: [], result: { stable: true as const } })
    );
    store.close();

    const inspectionDatabase = new DatabaseSync(database.path, { readOnly: true });
    try {
      const row = inspectionDatabase.prepare(
        "SELECT command_fingerprint, result_json FROM processed_requests WHERE session_id = ? AND request_id = ?"
      ).get(sessionId, envelope.requestId) as { command_fingerprint: string; result_json: string };
      expect(row.command_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(row)).not.toContain(sentinel);
    } finally {
      inspectionDatabase.close();
    }
  });
});

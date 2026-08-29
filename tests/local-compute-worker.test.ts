import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRequestId } from "../packages/domain/src/index.js";
import {
  LocalComputeRequestSchema,
  LocalComputeWorkerClient,
  buildRestrictedWorkerEnvironment,
  type LocalComputeWorkerState
} from "../packages/local-compute/src/index.js";

const PYTHON = process.env.PYTHON_EXECUTABLE ?? (process.platform === "win32" ? "python" : "python3");
const PRODUCTION_WORKER = resolve("workers/python/local_compute_worker.py");
const FIXTURE_WORKER = resolve("workers/python/test_fixture_worker.py");

describe("local compute worker boundary", () => {
  const clients: LocalComputeWorkerClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map(async (client) => client.stop()));
  });

  it("strictly validates protocol-v1 requests", () => {
    const valid = {
      protocolVersion: 1,
      requestId: newRequestId(),
      type: "ANALYZE_TRANSCRIPT",
      sourceRevision: 3,
      text: "student statement"
    };
    expect(LocalComputeRequestSchema.parse(valid)).toEqual(valid);
    expect(() => LocalComputeRequestSchema.parse({ ...valid, protocolVersion: 2 })).toThrow();
    expect(() => LocalComputeRequestSchema.parse({ ...valid, sourceRevision: -1 })).toThrow();
    expect(() => LocalComputeRequestSchema.parse({ ...valid, arbitraryPayload: {} })).toThrow();
  });

  it("runs a real isolated Python worker and correlates source revision", async () => {
    const client = track(clients, new LocalComputeWorkerClient({ executable: PYTHON, scriptPath: PRODUCTION_WORKER }));
    await client.start();
    const health = await client.request({
      protocolVersion: 1,
      requestId: newRequestId(),
      type: "HEALTH_CHECK"
    });
    expect(health).toMatchObject({ type: "HEALTH_RESULT", workerVersion: "phase0-python-worker@1" });

    const request = {
      protocolVersion: 1 as const,
      requestId: newRequestId(),
      type: "ANALYZE_TRANSCRIPT" as const,
      sourceRevision: 7,
      text: "  I   would\nprove   both cases.  "
    };
    const result = await client.request(request);
    expect(result).toMatchObject({
      type: "TRANSCRIPT_ANALYSIS_RESULT",
      sourceRevision: 7,
      normalizedText: "I would prove both cases.",
      tokenCount: 5
    });
    expect(await client.request(request)).toEqual(result);
    await expect(client.request({ ...request, text: "different content" })).rejects.toMatchObject({
      code: "REQUEST_ID_CONFLICT"
    });
  });

  it("ignores duplicate result lines after resolving a RequestId", async () => {
    const client = track(clients, fixtureClient("duplicate"));
    await client.start();
    const first = await client.request({
      protocolVersion: 1,
      requestId: newRequestId(),
      type: "HEALTH_CHECK"
    });
    expect(first.type).toBe("HEALTH_RESULT");
    const second = await client.request({
      protocolVersion: 1,
      requestId: newRequestId(),
      type: "HEALTH_CHECK"
    });
    expect(second.type).toBe("HEALTH_RESULT");
    expect(client.getState()).toBe("RUNNING");
  });

  it("fails closed and interrupts the process on malformed or stale-basis output", async () => {
    for (const mode of ["malformed", "wrong_revision"] as const) {
      const client = track(clients, fixtureClient(mode));
      await client.start();
      await expect(client.request({
        protocolVersion: 1,
        requestId: newRequestId(),
        type: "ANALYZE_TRANSCRIPT",
        sourceRevision: 4,
        text: "candidate statement"
      })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
      await waitForState(client, "STOPPED");
    }
  });

  it("times out late work and exposes honest local-process interruption semantics", async () => {
    const delayed = track(clients, fixtureClient("delayed", 30));
    await delayed.start();
    await expect(delayed.request({
      protocolVersion: 1,
      requestId: newRequestId(),
      type: "HEALTH_CHECK"
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    await waitForState(delayed, "STOPPED");

    const explicit = track(clients, new LocalComputeWorkerClient({ executable: PYTHON, scriptPath: PRODUCTION_WORKER }));
    await explicit.start();
    const interruption = await explicit.interrupt("authorization=worker-test-secret");
    expect(interruption).toEqual({ semantics: "INTERRUPT_LOCAL_PROCESS", signalSent: true });
    expect(explicit.getDiagnostics().join(" ")).not.toContain("worker-test-secret");
    expect(explicit.getDiagnostics().join(" ")).toContain("[REDACTED]");
    await waitForState(explicit, "STOPPED");
  });

  it("passes only an allowlisted environment and has no persistence authority", async () => {
    const environment = buildRestrictedWorkerEnvironment({
      PATH: "safe-path",
      SYSTEMROOT: "safe-root",
      GEMINI_API_KEY: "must-not-cross-boundary",
      INTERVIEW_CLIENT_TOKEN: "must-not-cross-boundary"
    });
    expect(environment).toEqual({ PATH: "safe-path", SYSTEMROOT: "safe-root" });

    const pythonSource = await readFile(PRODUCTION_WORKER, "utf8");
    expect(pythonSource).not.toMatch(/^\s*(?:from|import)\s+(?:sqlite3|socket|subprocess)\b/mu);
    const supervisorSource = await readFile(resolve("packages/local-compute/src/worker-client.ts"), "utf8");
    expect(supervisorSource).not.toMatch(/packages\/(?:events|persistence)|SessionWriter|SqliteEventStore/u);
  });
});

function fixtureClient(mode: string, requestTimeoutMs = 1_000): LocalComputeWorkerClient {
  return new LocalComputeWorkerClient({
    executable: PYTHON,
    scriptPath: FIXTURE_WORKER,
    additionalArguments: [mode],
    requestTimeoutMs
  });
}

function track(clients: LocalComputeWorkerClient[], client: LocalComputeWorkerClient): LocalComputeWorkerClient {
  clients.push(client);
  return client;
}

async function waitForState(client: LocalComputeWorkerClient, expected: LocalComputeWorkerState): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (client.getState() !== expected && Date.now() < deadline) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  expect(client.getState()).toBe(expected);
}

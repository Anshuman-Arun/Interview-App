import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRequestId, newSessionId } from "../packages/domain/src/index.js";
import { replaySession } from "../packages/events/src/index.js";
import {
  LocalComputeCoordinator,
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import { LocalComputeWorkerClient } from "../packages/local-compute/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";

const PYTHON = process.env.PYTHON_EXECUTABLE ?? (process.platform === "win32" ? "python" : "python3");
const PRODUCTION_WORKER = resolve("workers/python/local_compute_worker.py");

describe("local compute result admission", () => {
  const clients: LocalComputeWorkerClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map(async (client) => client.stop()));
  });

  it("admits a real worker result once and replay reconstructs identical state", async () => {
    const harness = await speechHarness();
    const coordinator = new LocalComputeCoordinator(harness.writer);
    const issued = await coordinator.requestTranscriptAnalysis(harness.inputEpisodeId);
    const client = new LocalComputeWorkerClient({ executable: PYTHON, scriptPath: PRODUCTION_WORKER });
    clients.push(client);
    await client.start();
    const response = await client.request(issued.value);
    const envelope = callbackEnvelope(harness.sessionId, issued.value.requestId, issued.value.sourceRevision);
    const accepted = await coordinator.processResult({ envelope, response });

    expect(accepted.value).toEqual({ accepted: true, computeRequestId: issued.value.requestId });
    expect(accepted.appendedEventCount).toBe(1);
    expect(harness.writer.getState().localComputeRequests[issued.value.requestId]).toMatchObject({
      status: "ACCEPTED",
      result: { normalizedText: "I would prove both cases.", tokenCount: 5 }
    });
    expect(replaySession(harness.sessionId, harness.store.load(harness.sessionId))).toEqual(harness.writer.getState());

    const eventCount = harness.store.eventCount(harness.sessionId);
    const exactDuplicate = await coordinator.processResult({ envelope, response });
    expect(exactDuplicate.duplicate).toBe(true);
    expect(exactDuplicate.value.accepted).toBe(true);
    expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);

    const laterDuplicate = await coordinator.processResult({
      envelope: callbackEnvelope(harness.sessionId, issued.value.requestId, issued.value.sourceRevision),
      response
    });
    expect(laterDuplicate.value).toEqual({
      accepted: false,
      computeRequestId: issued.value.requestId,
      reason: "REQUEST_NOT_PENDING"
    });
    expect(laterDuplicate.appendedEventCount).toBe(0);
    expect(harness.store.eventCount(harness.sessionId)).toBe(eventCount);
    harness.store.close();
  });

  it("discards a late result after transcript correction", async () => {
    const harness = await speechHarness();
    const coordinator = new LocalComputeCoordinator(harness.writer);
    const request = (await coordinator.requestTranscriptAnalysis(harness.inputEpisodeId)).value;
    await harness.turns.correctTranscript("I would instead prove one case directly.");
    const result = await coordinator.processResult({
      envelope: callbackEnvelope(harness.sessionId, request.requestId, request.sourceRevision),
      response: validResponse(request.requestId, request.sourceRevision)
    });
    expect(result.value).toMatchObject({ accepted: false, reason: "STALE_SOURCE_REVISION" });
    expect(harness.writer.getState().localComputeRequests[request.requestId]?.status).toBe("DISCARDED");
    harness.store.close();
  });

  it("fails closed when callback basis is absent or worker analysis is tampered", async () => {
    const missingBasis = await speechHarness();
    const missingCoordinator = new LocalComputeCoordinator(missingBasis.writer);
    const missingRequest = (await missingCoordinator.requestTranscriptAnalysis(missingBasis.inputEpisodeId)).value;
    const missing = await missingCoordinator.processResult({
      envelope: createCommandEnvelope({
        sessionId: missingBasis.sessionId,
        producer: "local-compute-worker",
        correlationId: missingRequest.requestId
      }),
      response: validResponse(missingRequest.requestId, missingRequest.sourceRevision)
    });
    expect(missing.value).toMatchObject({ accepted: false, reason: "CALLBACK_BASIS_MISSING" });
    missingBasis.store.close();

    const tampered = await speechHarness();
    const tamperedCoordinator = new LocalComputeCoordinator(tampered.writer);
    const tamperedRequest = (await tamperedCoordinator.requestTranscriptAnalysis(tampered.inputEpisodeId)).value;
    const rejected = await tamperedCoordinator.processResult({
      envelope: callbackEnvelope(tampered.sessionId, tamperedRequest.requestId, tamperedRequest.sourceRevision),
      response: {
        ...validResponse(tamperedRequest.requestId, tamperedRequest.sourceRevision),
        normalizedText: "unearned conclusion",
        tokenCount: 2
      }
    });
    expect(rejected.value).toMatchObject({ accepted: false, reason: "DETERMINISTIC_VALIDATION_FAILED" });
    tampered.store.close();
  });

  it("validates malformed and miscorrelated callbacks before authoritative append", async () => {
    const harness = await speechHarness();
    const coordinator = new LocalComputeCoordinator(harness.writer);
    const request = (await coordinator.requestTranscriptAnalysis(harness.inputEpisodeId)).value;
    const count = harness.store.eventCount(harness.sessionId);
    expect(() => coordinator.processResult({
      envelope: callbackEnvelope(harness.sessionId, request.requestId, request.sourceRevision),
      response: { ...validResponse(request.requestId, request.sourceRevision), arbitraryPayload: true }
    })).toThrow();
    expect(() => coordinator.processResult({
      envelope: callbackEnvelope(harness.sessionId, newRequestId(), request.sourceRevision),
      response: validResponse(request.requestId, request.sourceRevision)
    })).toThrow("does not match");
    expect(harness.store.eventCount(harness.sessionId)).toBe(count);
    expect(harness.writer.getState().localComputeRequests[request.requestId]?.status).toBe("PENDING");
    harness.store.close();
  });

  it("persists only a bounded error code, never an untrusted worker message", async () => {
    const harness = await speechHarness();
    const coordinator = new LocalComputeCoordinator(harness.writer);
    const request = (await coordinator.requestTranscriptAnalysis(harness.inputEpisodeId)).value;
    const secret = "authorization=must-not-enter-event-stream";
    const result = await coordinator.processResult({
      envelope: callbackEnvelope(harness.sessionId, request.requestId, request.sourceRevision),
      response: {
        protocolVersion: 1,
        requestId: request.requestId,
        type: "WORKER_ERROR",
        code: "INTERNAL_ERROR",
        message: secret
      }
    });
    expect(result.value).toMatchObject({ accepted: false, reason: "WORKER_ERROR" });
    expect(JSON.stringify(harness.store.load(harness.sessionId))).not.toContain(secret);
    harness.store.close();
  });

  it("admits a pending result after application restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-local-compute-"));
    const databasePath = join(directory, "events.sqlite");
    let store = new SqliteEventStore(databasePath);
    try {
      const first = await speechHarness(store);
      const request = (await new LocalComputeCoordinator(first.writer).requestTranscriptAnalysis(first.inputEpisodeId)).value;
      const sessionId = first.sessionId;
      store.close();

      store = new SqliteEventStore(databasePath);
      const writer = new SessionRuntimeRegistry(store).get(sessionId);
      const result = await new LocalComputeCoordinator(writer).processResult({
        envelope: callbackEnvelope(sessionId, request.requestId, request.sourceRevision),
        response: validResponse(request.requestId, request.sourceRevision)
      });
      expect(result.value.accepted).toBe(true);
      expect(writer.getState().localComputeRequests[request.requestId]?.status).toBe("ACCEPTED");
      expect(replaySession(sessionId, store.load(sessionId))).toEqual(writer.getState());
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function speechHarness(store = new SqliteEventStore(":memory:")) {
  const sessionId = newSessionId();
  const writer = new SessionRuntimeRegistry(store).get(sessionId);
  const turns = new TurnCoordinator(writer);
  await turns.startSession(sixPeopleProblem);
  const utteranceId = await turns.beginUtterance();
  const finalized = await turns.finalizeUtterance({ utteranceId, text: "  I   would\nprove   both cases.  " });
  await turns.commitInputEpisode(finalized.inputEpisodeId);
  return { store, sessionId, writer, turns, inputEpisodeId: finalized.inputEpisodeId };
}

function callbackEnvelope(sessionId: ReturnType<typeof newSessionId>, computeRequestId: ReturnType<typeof newRequestId>, sourceRevision: number) {
  return createCommandEnvelope({
    sessionId,
    producer: "local-compute-worker",
    correlationId: computeRequestId,
    sourceRevision
  });
}

function validResponse(requestId: ReturnType<typeof newRequestId>, sourceRevision: number) {
  return {
    protocolVersion: 1 as const,
    requestId,
    type: "TRANSCRIPT_ANALYSIS_RESULT" as const,
    sourceRevision,
    normalizedText: "I would prove both cases.",
    tokenCount: 5
  };
}

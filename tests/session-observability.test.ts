import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionIdSchema } from "../packages/domain/src/index.js";
import {
  SessionPerformanceReadResponseSchema
} from "../packages/diagnostics/src/index.js";
import {
  SessionObservability
} from "../apps/server/src/session-observability.js";

describe("SessionObservability", () => {
  it("measures remote work with monotonic elapsed time and application bytes", () => {
    let now = 10;
    const metrics = new SessionObservability(undefined, () => now);
    const sessionId = SessionIdSchema.parse("session-observability-1");

    const interviewer = metrics.beginRemoteOperation({
      sessionId,
      operation: "INTERVIEWER_REALIZATION",
      providerId: "provider",
      modelId: "model"
    });
    interviewer.setSizes({
      requestBytes: 100,
      compiledContextBytes: 80,
      responseBytes: 30
    });
    now = 35;
    interviewer.finish("SUCCESS");

    const formal = metrics.beginRemoteOperation({
      sessionId,
      operation: "FORMAL_INTERPRETATION",
      providerId: "provider",
      modelId: "model"
    });
    formal.setSizes({ requestBytes: 40, compiledContextBytes: 30, responseBytes: 10 });
    now = 45;
    formal.finish("ABSTAINED");

    const read = SessionPerformanceReadResponseSchema.parse(metrics.read(sessionId));
    expect(read.available).toBe(true);
    if (!read.available || read.summary === undefined) throw new Error("expected metrics");
    expect(read.summary.remote).toMatchObject({
      interviewerCalls: 1,
      formalInterpretationCalls: 1,
      totalCalls: 2,
      requestBytes: 140,
      compiledContextBytes: 110,
      responseBytes: 40
    });
    expect(read.summary.remote.interviewerLatency.medianMs).toBe(25);
    expect(read.summary.remote.formalInterpretationLatency.medianMs).toBe(10);
    expect(read.summary.remote.outcomes.ABSTAINED).toBe(1);
  });

  it("tracks formal verification separately from interpretation admission", () => {
    const metrics = new SessionObservability();
    const sessionId = SessionIdSchema.parse("session-observability-2");

    metrics.recordFormalAttempt(sessionId);
    metrics.recordFormalResult(sessionId, {
      kind: "ACCEPTED",
      verificationStatus: "CONTRADICTED"
    });
    metrics.recordFormalAttempt(sessionId);
    metrics.recordFormalResult(sessionId, { kind: "ABSTAINED" });
    metrics.recordFormalAttempt(sessionId);
    metrics.recordFormalResult(sessionId, { kind: "TIMEOUT" });

    const read = metrics.read(sessionId);
    expect(read.available).toBe(true);
    if (!read.available || read.summary === undefined) throw new Error("expected metrics");
    expect(read.summary.formalInterpretation).toMatchObject({
      attempts: 3,
      accepted: 1,
      abstentions: 1,
      timeouts: 1
    });
    expect(read.summary.formalInterpretation.verification.CONTRADICTED).toBe(1);
  });

  it("bounds retained remote attempts instead of growing without limit", () => {
    let now = 0;
    const metrics = new SessionObservability(undefined, () => now);
    const sessionId = SessionIdSchema.parse("session-observability-3");

    for (let index = 0; index < 300; index += 1) {
      const handle = metrics.beginRemoteOperation({
        sessionId,
        operation: "INTERVIEWER_REALIZATION",
        providerId: "provider",
        modelId: "model"
      });
      now += 1;
      handle.finish("SUCCESS");
    }

    const read = metrics.read(sessionId);
    expect(read.available).toBe(true);
    if (!read.available || read.summary === undefined) throw new Error("expected metrics");
    expect(read.summary.remote.totalCalls).toBe(300);
    expect(read.summary.partial).toBe(true);
  });

  it("recovers persisted metrics after restart without semantic replay dependency", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-"));
    const databasePath = join(directory, "session.sqlite");
    const sessionId = SessionIdSchema.parse("session-observability-recovery");
    try {
      const first = SessionObservability.create(databasePath, () => 10);
      const handle = first.beginRemoteOperation({
        sessionId,
        operation: "INTERVIEWER_REALIZATION",
        providerId: "provider",
        modelId: "model"
      });
      handle.finish("SUCCESS");
      first.close();

      const recovered = SessionObservability.create(databasePath, () => 20);
      const read = recovered.read(sessionId);
      expect(read.available).toBe(true);
      expect(read.summary?.remote.totalCalls).toBe(1);
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("degrades to partial in-memory metrics when persistence is unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-unavailable-"));
    const sessionId = SessionIdSchema.parse("session-observability-unavailable");
    try {
      const metrics = SessionObservability.create(directory, () => 0);
      expect(() => metrics.recordVoiceInputSession(sessionId)).not.toThrow();
      const read = metrics.read(sessionId);
      expect(read.available).toBe(true);
      expect(read.partial).toBe(true);
      metrics.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats malformed persisted telemetry as unavailable rather than authoritative", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-malformed-"));
    const databasePath = join(directory, "session.sqlite");
    const sessionId = SessionIdSchema.parse("session-observability-malformed");
    try {
      const initial = SessionObservability.create(databasePath);
      initial.close();
      const database = new DatabaseSync(databasePath);
      database.prepare(
        "INSERT INTO session_observability(session_id, metrics_json, updated_at) VALUES (?, ?, ?)"
      ).run(sessionId, "{not-json", new Date(0).toISOString());
      database.close();

      const recovered = SessionObservability.create(databasePath);
      expect(recovered.read(sessionId)).toMatchObject({
        available: false,
        partial: false
      });
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not expose provider token, quota, billing, or payload fields", () => {
    const metrics = new SessionObservability();
    const sessionId = SessionIdSchema.parse("session-observability-4");
    metrics.recordVoiceInputSession(sessionId);
    metrics.recordCandidateSubstantiveTurn(sessionId, "turn-1");
    metrics.recordCandidateSubstantiveTurn(sessionId, "turn-1");

    const serialized = JSON.stringify(metrics.read(sessionId)).toLowerCase();

    expect(metrics.read(sessionId).summary?.candidateSubstantiveTurns).toBe(1);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("quota");
    expect(serialized).not.toContain("billing");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("audio");
    expect(serialized).not.toContain("png");
  });
});

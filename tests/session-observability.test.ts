import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionIdSchema } from "../packages/domain/src/index.js";
import {
  SessionLatencySummarySchema,
  SessionPerformanceReadResponseSchema
} from "../packages/diagnostics/src/index.js";
import {
  SessionObservability
} from "../apps/server/src/session-observability.js";
import { SessionReadService } from "../apps/server/src/session-read-service.js";

describe("SessionLatencySummarySchema", () => {
  it("rejects impossible empty and non-empty latency summaries", () => {
    expect(SessionLatencySummarySchema.safeParse({
      count: 0,
      medianMs: 1,
      slowestMs: 1
    }).success).toBe(false);
    expect(SessionLatencySummarySchema.safeParse({
      count: 1,
      medianMs: null,
      slowestMs: null
    }).success).toBe(false);
    expect(SessionLatencySummarySchema.safeParse({
      count: 1,
      medianMs: 20,
      slowestMs: 10
    }).success).toBe(false);
    expect(SessionLatencySummarySchema.safeParse({
      count: 1,
      medianMs: 10,
      slowestMs: 10
    }).success).toBe(true);
  });
});

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

  it("freezes candidate turn count when exact dedup retention saturates", () => {
    const metrics = new SessionObservability();
    const sessionId = SessionIdSchema.parse("session-observability-turn-saturation");

    for (let index = 0; index < 512; index += 1) {
      metrics.recordCandidateSubstantiveTurn(sessionId, `turn-${String(index)}`);
    }
    metrics.recordCandidateSubstantiveTurn(sessionId, "turn-over-cap");
    metrics.recordCandidateSubstantiveTurn(sessionId, "turn-0");

    const read = metrics.read(sessionId);
    expect(read.available).toBe(true);
    expect(read.partial).toBe(true);
    expect(read.summary?.candidateSubstantiveTurns).toBe(512);
  });

  it("recovers a started remote call after restart as partial without inventing an outcome", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-pending-remote-"));
    const databasePath = join(directory, "session.sqlite");
    const sessionId = SessionIdSchema.parse("session-observability-pending-remote");
    try {
      const first = SessionObservability.create(databasePath, () => 10);
      first.beginRemoteOperation({
        sessionId,
        operation: "INTERVIEWER_REALIZATION",
        providerId: "provider",
        modelId: "model"
      });
      first.close();

      const recovered = SessionObservability.create(databasePath, () => 20);
      const read = recovered.read(sessionId);
      expect(read.available).toBe(true);
      expect(read.partial).toBe(true);
      if (!read.available || read.summary === undefined) {
        throw new Error("expected partial recovered metrics");
      }
      expect(read.summary.remote.totalCalls).toBe(1);
      expect(Object.values(read.summary.remote.outcomes).reduce(
        (total, count) => total + count,
        0
      )).toBe(0);
      expect(read.summary.remote.interviewerLatency.count).toBe(0);
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers an unfinished local timing interval after restart as partial", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-pending-local-"));
    const databasePath = join(directory, "session.sqlite");
    const sessionId = SessionIdSchema.parse("session-observability-pending-local");
    try {
      const first = SessionObservability.create(databasePath, () => 10);
      first.beginLocalTiming(sessionId, "STT");
      first.close();

      const recovered = SessionObservability.create(databasePath, () => 20);
      const read = recovered.read(sessionId);
      expect(read.available).toBe(true);
      expect(read.partial).toBe(true);
      expect(read.summary?.local.stt).toMatchObject({
        finalizations: 0,
        failures: 0,
        cancellations: 0
      });
      expect(read.summary?.local.stt.latency.count).toBe(0);
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
        partial: true
      });
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("drops broken monotonic samples without losing operation outcomes", () => {
    const clock = [10, Number.NaN, 20, 15];
    const metrics = new SessionObservability(
      undefined,
      () => clock.shift() ?? Number.POSITIVE_INFINITY
    );
    const sessionId = SessionIdSchema.parse("session-observability-bad-clock");

    const remote = metrics.beginRemoteOperation({
      sessionId,
      operation: "INTERVIEWER_REALIZATION",
      providerId: "provider",
      modelId: "model"
    });
    remote.finish("SUCCESS");

    metrics.recordTtsRequest(sessionId);
    const local = metrics.beginLocalTiming(sessionId, "TTS");
    local.finish("SUCCESS");

    const read = metrics.read(sessionId);
    expect(read.available).toBe(true);
    expect(read.partial).toBe(true);
    expect(read.summary?.remote.totalCalls).toBe(1);
    expect(read.summary?.remote.outcomes.SUCCESS).toBe(1);
    expect(read.summary?.remote.interviewerLatency).toEqual({
      count: 0,
      medianMs: null,
      slowestMs: null
    });
    expect(read.summary?.local.tts.successes).toBe(1);
    expect(read.summary?.local.tts.latency).toEqual({
      count: 0,
      medianMs: null,
      slowestMs: null
    });
  });

  it("keeps post-start persistence failure non-authoritative and marks data partial", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-write-failure-"));
    const databasePath = join(directory, "session.sqlite");
    const sessionId = SessionIdSchema.parse("session-observability-write-failure");
    try {
      const metrics = SessionObservability.create(databasePath);
      metrics.close();

      expect(() => metrics.recordVoiceInputSession(sessionId)).not.toThrow();
      const read = metrics.read(sessionId);
      expect(read.available).toBe(true);
      expect(read.partial).toBe(true);
      expect(read.summary?.local.voiceInputSessions).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers from a corrupt row without pretending the lost history is complete", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-corrupt-recovery-"));
    const databasePath = join(directory, "session.sqlite");
    const sessionId = SessionIdSchema.parse("session-observability-corrupt-recovery");
    try {
      const initial = SessionObservability.create(databasePath);
      initial.recordVoiceInputSession(sessionId);
      initial.close();

      const database = new DatabaseSync(databasePath);
      database.prepare(
        "UPDATE session_observability SET metrics_json = ? WHERE session_id = ?"
      ).run("{broken-json", sessionId);
      database.close();

      const recovered = SessionObservability.create(databasePath);
      expect(recovered.read(sessionId)).toMatchObject({
        available: false,
        partial: true
      });

      expect(() => recovered.recordCommittedUtterance(sessionId)).not.toThrow();
      const repaired = recovered.read(sessionId);
      expect(repaired.available).toBe(true);
      expect(repaired.partial).toBe(true);
      expect(repaired.summary?.local.committedUtterances).toBe(1);
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed persisted attempt identities and byte counters as partial telemetry", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-invalid-attempt-"));
    const databasePath = join(directory, "session.sqlite");
    const sessionId = SessionIdSchema.parse("session-observability-invalid-attempt");
    try {
      const initial = SessionObservability.create(databasePath, () => 1);
      const handle = initial.beginRemoteOperation({
        sessionId,
        operation: "INTERVIEWER_REALIZATION",
        providerId: "provider",
        modelId: "model"
      });
      handle.finish("SUCCESS");
      initial.close();

      const database = new DatabaseSync(databasePath);
      const row = database.prepare(
        "SELECT metrics_json FROM session_observability WHERE session_id = ?"
      ).get(sessionId) as { metrics_json: string };
      const parsed = JSON.parse(row.metrics_json) as {
        remoteAttempts: Array<{ operation: string; requestBytes: number }>;
      };
      if (parsed.remoteAttempts[0] === undefined) throw new Error("missing attempt fixture");
      parsed.remoteAttempts[0].operation = "NOT_A_REAL_OPERATION";
      parsed.remoteAttempts[0].requestBytes = -1;
      database.prepare(
        "UPDATE session_observability SET metrics_json = ? WHERE session_id = ?"
      ).run(JSON.stringify(parsed), sessionId);
      database.close();

      const recovered = SessionObservability.create(databasePath);
      expect(() => recovered.read(sessionId)).not.toThrow();
      expect(recovered.read(sessionId)).toMatchObject({
        available: false,
        partial: true
      });
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never lets performance telemetry prove session existence when authority is unreadable", () => {
    const sessionId = SessionIdSchema.parse("session-observability-authority-unreadable");
    const readTelemetry = vi.fn(() => {
      throw new Error("telemetry must not be consulted");
    });
    const reads = new SessionReadService({
      source: {
        hasSession: () => {
          throw new Error("authoritative store unavailable");
        },
        sessionCount: () => 0,
        listRecentSessionIds: () => [],
        eventCount: () => 0,
        loadEvents: () => []
      },
      performanceSource: { read: readTelemetry }
    });

    expect(reads.readPerformance(sessionId)).toMatchObject({
      available: false,
      partial: true,
      sessionId
    });
    expect(readTelemetry).not.toHaveBeenCalled();
  });

  it("ignores malformed runtime operation labels without affecting interview code", () => {
    const metrics = new SessionObservability();
    const sessionId = SessionIdSchema.parse("session-observability-invalid-operation");

    expect(() => {
      const handle = metrics.beginRemoteOperation({
        sessionId,
        operation: "INVALID_OPERATION" as never,
        providerId: "provider",
        modelId: "model"
      });
      handle.finish("SUCCESS");
    }).not.toThrow();

    expect(metrics.read(sessionId)).toMatchObject({
      available: false,
      partial: false
    });
  });

  it("rejects logically inconsistent persisted aggregates instead of presenting them as usage", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-inconsistent-"));
    const databasePath = join(directory, "session.sqlite");
    const sessionId = SessionIdSchema.parse("session-observability-inconsistent");
    try {
      const initial = SessionObservability.create(databasePath, () => 1);
      const handle = initial.beginRemoteOperation({
        sessionId,
        operation: "INTERVIEWER_REALIZATION",
        providerId: "provider",
        modelId: "model"
      });
      handle.finish("SUCCESS");
      initial.close();

      const database = new DatabaseSync(databasePath);
      const row = database.prepare(
        "SELECT metrics_json FROM session_observability WHERE session_id = ?"
      ).get(sessionId) as { metrics_json: string };
      const parsed = JSON.parse(row.metrics_json) as {
        remoteTotals: { outcomes: { SUCCESS: number } };
      };
      parsed.remoteTotals.outcomes.SUCCESS = 0;
      database.prepare(
        "UPDATE session_observability SET metrics_json = ? WHERE session_id = ?"
      ).run(JSON.stringify(parsed), sessionId);
      database.close();

      const recovered = SessionObservability.create(databasePath);
      expect(recovered.read(sessionId)).toMatchObject({
        available: false,
        partial: true
      });
      recovered.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces the persisted session retention bound", () => {
    const directory = mkdtempSync(join(tmpdir(), "interview-observability-retention-"));
    const databasePath = join(directory, "session.sqlite");
    try {
      const metrics = SessionObservability.create(databasePath);
      for (let index = 0; index < 105; index += 1) {
        metrics.recordVoiceInputSession(
          SessionIdSchema.parse(`session-observability-retention-${String(index).padStart(3, "0")}`)
        );
      }
      metrics.close();

      const database = new DatabaseSync(databasePath);
      const row = database.prepare(
        "SELECT COUNT(*) AS count FROM session_observability"
      ).get() as { count: number };
      database.close();
      expect(row.count).toBe(100);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("makes duplicate terminal callbacks idempotent for remote and local timing", () => {
    const metrics = new SessionObservability(undefined, () => 10);
    const sessionId = SessionIdSchema.parse("session-observability-idempotent-terminal");

    const remote = metrics.beginRemoteOperation({
      sessionId,
      operation: "INTERVIEWER_REALIZATION",
      providerId: "provider",
      modelId: "model"
    });
    remote.finish("SUCCESS");
    remote.finish("FAILED");

    metrics.recordTtsRequest(sessionId);
    const local = metrics.beginLocalTiming(sessionId, "TTS");
    local.finish("SUCCESS");
    local.finish("FAILURE");

    const read = metrics.read(sessionId);
    expect(read.available).toBe(true);
    expect(read.summary?.remote.totalCalls).toBe(1);
    expect(read.summary?.remote.outcomes.SUCCESS).toBe(1);
    expect(read.summary?.remote.outcomes.FAILED).toBe(0);
    expect(read.summary?.local.tts).toMatchObject({
      requests: 1,
      successes: 1,
      failures: 0,
      cancellations: 0
    });
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

import { describe, expect, it } from "vitest";
import {
  DiagnosticSnapshotSchema,
  RuntimeFingerprintSchema,
  SubsystemHealthSchema,
  TimingRecorder,
  aggregateTimings,
  canonicalizeDiagnosticConfiguration,
  captureRuntimeFingerprint,
  createDiagnosticSnapshot,
  fingerprintDiagnosticConfiguration,
  sanitizeDiagnosticRecord,
  sanitizeDiagnosticText,
  sanitizeErrorMetadata,
  serializeDiagnosticSnapshot,
  toDiagnosticProviderCapabilities,
  type OperationTiming
} from "../packages/diagnostics/src/index.js";

describe("runtime diagnostics", () => {
  it("fingerprints equivalent configuration independent of object-key insertion order", () => {
    const first = fingerprintDiagnosticConfiguration({
      provider: { model: "flash", reasoning: "medium" },
      flags: { vision: true, voice: false }
    });
    const reordered = fingerprintDiagnosticConfiguration({
      flags: { voice: false, vision: true },
      provider: { reasoning: "medium", model: "flash" }
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(reordered).toBe(first);
  });

  it("changes the fingerprint when non-secret configuration changes", () => {
    expect(fingerprintDiagnosticConfiguration({ mode: "medium", retries: 2 }))
      .not.toBe(fingerprintDiagnosticConfiguration({ mode: "high", retries: 2 }));
  });

  it("sanitizes secret fields before canonical fingerprinting", () => {
    const first = { mode: "test", apiKey: "first-private-value" };
    const second = { apiKey: "second-private-value", mode: "test" };
    const canonical = canonicalizeDiagnosticConfiguration(first);

    expect(canonical).not.toContain("first-private-value");
    expect(canonical).toContain("[REDACTED]");
    expect(fingerprintDiagnosticConfiguration(first)).toBe(fingerprintDiagnosticConfiguration(second));
  });

  it("recursively sanitizes fields, strings, bearer tokens, and error metadata", () => {
    const sanitized = sanitizeDiagnosticRecord({
      tokenCount: 42,
      headers: { Authorization: "Bearer header-private" },
      apiKey: "field-private",
      message: "request failed Authorization: Bearer inline-private",
      nested: ["Bearer standalone-private", { client_token: "client-private" }]
    });
    const error = Object.assign(new Error("provider failed Bearer error-private"), {
      providerSecret: "error-field-private"
    });
    const errorMetadata = sanitizeErrorMetadata(error);
    const serialized = JSON.stringify({ sanitized, errorMetadata });

    expect(sanitized.tokenCount).toBe(42);
    for (const secret of [
      "header-private",
      "field-private",
      "inline-private",
      "standalone-private",
      "client-private",
      "error-private",
      "error-field-private"
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(sanitizeDiagnosticText("status=ok")).toBe("status=ok");
  });

  it("captures available runtime metadata while omitting unavailable optional values", () => {
    const runtime = captureRuntimeFingerprint();

    expect(runtime.runtime.platform.length).toBeGreaterThan(0);
    expect(runtime.runtime.architecture.length).toBeGreaterThan(0);
    expect(runtime.runtime.nodeVersion.length).toBeGreaterThan(0);
    expect(runtime).not.toHaveProperty("applicationVersion");
    expect(runtime).not.toHaveProperty("buildCommitSha");
    expect(runtime).not.toHaveProperty("eventSchemaVersion");
    expect(runtime).not.toHaveProperty("configurationSha256");
  });

  it("validates supplied runtime metadata", () => {
    const runtime = captureRuntimeFingerprint({
      applicationVersion: "0.1.0",
      buildCommitSha: "27090745ccc34367b0edc1622de9d11ca04b808f",
      pythonVersion: "3.13.7",
      eventSchemaVersion: 2,
      configuration: { provider: "mock", retries: 1 },
      problem: {
        id: "six-people",
        version: "1",
        sha256: "a".repeat(64)
      },
      verifiers: [{ id: "phase0-abstaining-verifier", version: "1" }],
      workers: [{ id: "local-compute", version: "1", capabilities: ["HEALTH_CHECK"] }]
    });

    expect(RuntimeFingerprintSchema.parse(runtime)).toEqual(runtime);
    expect(runtime.configurationSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => RuntimeFingerprintSchema.parse({
      ...runtime,
      buildCommitSha: "not-a-sha"
    })).toThrow();
  });

  it("serializes existing provider capabilities without Set-valued JSON fields", () => {
    const capabilities = toDiagnosticProviderCapabilities({
      inputModalities: new Set(["image", "text"]),
      textStreaming: true,
      structuredOutput: "FINAL_ONLY",
      persistentSession: false,
      resumableSession: false,
      cancellation: "DROP_OUTPUT",
      sessionSurvivesClientAbort: false,
      sessionSurvivesProviderCancel: false,
      usageReporting: true,
      reasoningLevels: ["high", "medium"],
      dataUse: "REMOTE_NO_TRAINING"
    });

    expect(capabilities.inputModalities).toEqual(["image", "text"]);
    expect(JSON.parse(JSON.stringify(capabilities))).toEqual(capabilities);
  });

  it("records monotonic latency spans and rejects double completion", () => {
    let now = 100;
    const recorder = new TimingRecorder({ now: () => now });
    const span = recorder.start("compile", "CONTEXT_COMPILATION", {
      Authorization: "Bearer timing-private",
      stage: "main"
    });
    now = 112.5;
    const sample = span.finish("SUCCESS");

    expect(sample.elapsedMs).toBe(12.5);
    expect(sample.outcome).toBe("SUCCESS");
    expect(JSON.stringify(sample)).not.toContain("timing-private");
    expect(recorder.getSamples()).toHaveLength(1);
    expect(() => span.finish()).toThrow(/already been finished/u);
  });

  it("records failure and cancellation outcomes", () => {
    let now = 0;
    const recorder = new TimingRecorder({ now: () => now });
    const failed = recorder.start("verify", "VERIFICATION");
    now = 8;
    expect(failed.finish("FAILURE").outcome).toBe("FAILURE");
    const cancelled = recorder.start("provider", "PROVIDER_REQUEST");
    now = 13;
    expect(cancelled.finish("CANCELLED").outcome).toBe("CANCELLED");
  });

  it("aggregates count, extrema, mean, percentiles, and outcomes correctly", () => {
    const samples: OperationTiming[] = [
      { operation: "provider", category: "PROVIDER_REQUEST", elapsedMs: 10, outcome: "SUCCESS" },
      { operation: "provider", category: "PROVIDER_REQUEST", elapsedMs: 20, outcome: "FAILURE" },
      { operation: "provider", category: "PROVIDER_REQUEST", elapsedMs: 30, outcome: "CANCELLED" }
    ];
    const aggregate = aggregateTimings(samples)[0];

    expect(aggregate).toMatchObject({
      count: 3,
      minMs: 10,
      maxMs: 30,
      meanMs: 20,
      p50Ms: 20,
      p95Ms: 30,
      outcomes: { SUCCESS: 1, FAILURE: 1, CANCELLED: 1 }
    });
  });

  it("validates informational subsystem health states", () => {
    const health = SubsystemHealthSchema.parse({
      subsystem: "LOCAL_WORKER",
      componentId: "python-worker",
      state: "DEGRADED",
      observedAt: "2026-08-30T20:00:00.000Z",
      detail: "fallback path active"
    });

    expect(health.state).toBe("DEGRADED");
    expect(() => SubsystemHealthSchema.parse({
      subsystem: "PROVIDER",
      state: "AUTHORITATIVE"
    })).toThrow();
  });

  it("assembles secret-safe, JSON-serializable diagnostic snapshots", () => {
    const runtime = captureRuntimeFingerprint({
      eventSchemaVersion: 2,
      configuration: { provider: "mock" }
    });
    const snapshot = createDiagnosticSnapshot({
      runtime,
      generatedAt: new Date("2026-08-30T20:00:00.000Z"),
      timings: [{
        operation: "provider",
        category: "PROVIDER_REQUEST",
        elapsedMs: 15,
        outcome: "FAILURE",
        tags: { apiKey: "snapshot-timing-private" }
      }],
      health: [{
        subsystem: "PROVIDER",
        state: "UNAVAILABLE",
        detail: "Authorization: Bearer snapshot-health-private",
        metadata: { clientToken: "snapshot-client-private" }
      }],
      extra: {
        status: "developer-report",
        provider_secret: "snapshot-extra-private"
      }
    });
    const json = serializeDiagnosticSnapshot(snapshot);

    expect(() => DiagnosticSnapshotSchema.parse(JSON.parse(json))).not.toThrow();
    for (const secret of [
      "snapshot-timing-private",
      "snapshot-health-private",
      "snapshot-client-private",
      "snapshot-extra-private"
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(snapshot.timingAggregates[0]?.count).toBe(1);
  });
});

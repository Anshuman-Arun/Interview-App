import { describe, expect, it } from "vitest";
import {
  DiagnosticSnapshotSchema,
  DiagnosticConfigurationError,
  DIAGNOSTIC_SANITIZATION_LIMITS,
  MAX_SNAPSHOT_HEALTH_OBSERVATIONS,
  MAX_SNAPSHOT_TIMINGS,
  MAX_SERIALIZED_DIAGNOSTIC_SNAPSHOT_BYTES,
  MAX_TIMING_SAMPLES,
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
  sanitizeDiagnosticValue,
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
    expect(fingerprintDiagnosticConfiguration({ mode: "test", token: "first-token" }))
      .toBe(fingerprintDiagnosticConfiguration({ token: "second-token", mode: "test" }));
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
    expect(sanitizeDiagnosticText("Basic\tstandalone-basic-private"))
      .toBe("Basic [REDACTED]");
    expect(sanitizeDiagnosticText('{"password":"quoted-password-private"}'))
      .toBe('{"password":"[REDACTED]"}');
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

    const sanitizedCapabilities = toDiagnosticProviderCapabilities({
      inputModalities: new Set(["text"]),
      textStreaming: false,
      structuredOutput: "NONE",
      persistentSession: false,
      resumableSession: false,
      cancellation: "NONE",
      sessionSurvivesClientAbort: false,
      sessionSurvivesProviderCancel: false,
      usageReporting: false,
      reasoningLevels: ["Bearer capability-private"],
      dataUse: "LOCAL_ONLY"
    });
    expect(JSON.stringify(sanitizedCapabilities)).not.toContain("capability-private");
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

  it("redacts generic token fields and every caller-controlled snapshot string surface", () => {
    const runtime = captureRuntimeFingerprint({
      applicationVersion: "Bearer application-private",
      provider: {
        id: "Bearer provider-id-private",
        model: "Basic provider-model-private"
      },
      problem: {
        id: "Bearer problem-id-private",
        version: "token=problem-version-private"
      },
      verifiers: [{
        id: "Bearer verifier-id-private",
        version: "token=verifier-version-private",
        capabilities: ["Basic verifier-capability-private"]
      }]
    });
    const snapshot = createDiagnosticSnapshot({
      runtime,
      timings: [{
        operation: "Bearer timing-operation-private",
        category: "OTHER",
        elapsedMs: 1,
        outcome: "SUCCESS",
        tags: { token: "generic-token-private" }
      }],
      health: [{
        subsystem: "OTHER",
        componentId: "Bearer health-component-private",
        state: "UNKNOWN"
      }]
    });
    const json = serializeDiagnosticSnapshot(snapshot);

    for (const secret of [
      "application-private",
      "provider-id-private",
      "provider-model-private",
      "problem-id-private",
      "problem-version-private",
      "verifier-id-private",
      "verifier-version-private",
      "verifier-capability-private",
      "timing-operation-private",
      "generic-token-private",
      "health-component-private"
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("rejects non-JSON and ambiguous configuration values instead of hashing collisions", () => {
    expect(fingerprintDiagnosticConfiguration({ value: 1 }))
      .not.toBe(fingerprintDiagnosticConfiguration({ value: "1" }));

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const configuration of [
      { value: 1n },
      { value: Number.NaN },
      { value: undefined },
      { value: new Map([["mode", "test"]]) },
      { value: (): void => undefined },
      cyclic
    ]) {
      expect(() => fingerprintDiagnosticConfiguration(configuration))
        .toThrow(DiagnosticConfigurationError);
    }
  });

  it("canonicalizes keys with locale-independent code-unit ordering", () => {
    expect(canonicalizeDiagnosticConfiguration({ "ä": 1, z: 2, A: 3 }))
      .toBe('{"A":3,"z":2,"ä":1}');
  });

  it("does not invoke accessors while sanitizing or fingerprinting", () => {
    let getterCalls = 0;
    const record = Object.defineProperty({}, "danger", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "Bearer getter-private";
      }
    });

    expect(sanitizeDiagnosticValue(record)).toEqual({ danger: "[ACCESSOR_OMITTED]" });
    expect(getterCalls).toBe(0);
    expect(() => fingerprintDiagnosticConfiguration(record)).toThrow(/accessor/u);
    expect(getterCalls).toBe(0);
  });

  it("bounds deep, wide, and long hostile diagnostic values", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < 100; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const sanitizedDeep = JSON.stringify(sanitizeDiagnosticValue(root));
    const sanitizedWide = sanitizeDiagnosticValue(
      Array.from({ length: DIAGNOSTIC_SANITIZATION_LIMITS.maxArrayItems + 100 }, (_, index) => index)
    );
    const sanitizedLong = sanitizeDiagnosticText(
      `${"x".repeat(DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength * 2)} Bearer omitted-private`
    );

    expect(sanitizedDeep).toContain("[TRUNCATED]");
    expect(Array.isArray(sanitizedWide) ? sanitizedWide.length : 0)
      .toBe(DIAGNOSTIC_SANITIZATION_LIMITS.maxArrayItems + 1);
    expect(sanitizedLong.length).toBeLessThanOrEqual(DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength);
    expect(sanitizedLong).not.toContain("omitted-private");
  });

  it("handles uninspectable proxies without allowing diagnostics to throw", () => {
    const revocable = Proxy.revocable({ token: "proxy-private" }, {});
    revocable.revoke();
    expect(() => sanitizeDiagnosticValue(revocable.proxy)).not.toThrow();
    expect(sanitizeDiagnosticValue(revocable.proxy)).toBe("[UNINSPECTABLE_OBJECT]");
  });

  it("retains a bounded timing window and deeply freezes recorded metadata", () => {
    let now = 0;
    const recorder = new TimingRecorder({ now: () => now, maxSamples: 2 });
    const first = recorder.start("first", "OTHER", { nested: { value: "original" } });
    now = 1;
    const firstSample = first.finish();
    const nested = firstSample.tags?.nested;
    expect(Object.isFrozen(firstSample)).toBe(true);
    expect(Object.isFrozen(firstSample.tags)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      expect(Reflect.set(nested, "value", "mutated")).toBe(false);
    }

    now = 2;
    recorder.start("second", "OTHER").finish();
    now = 3;
    recorder.start("third", "OTHER").finish();
    expect(recorder.getSamples().map((sample) => sample.operation)).toEqual(["second", "third"]);
    expect(recorder.getDroppedSampleCount()).toBe(1);
    expect(() => aggregateTimings(Array.from(
      { length: MAX_TIMING_SAMPLES + 1 },
      () => ({
        operation: "bounded",
        category: "OTHER" as const,
        elapsedMs: 1,
        outcome: "SUCCESS" as const
      })
    ))).toThrow(/at most/u);
  });

  it("bounds snapshot observation collections to their most recent entries", () => {
    const runtime = captureRuntimeFingerprint();
    const timings: OperationTiming[] = Array.from(
      { length: MAX_SNAPSHOT_TIMINGS + 3 },
      (_, index) => ({
        operation: `operation-${String(index)}`,
        category: "OTHER",
        elapsedMs: index,
        outcome: "SUCCESS"
      })
    );
    const health = Array.from(
      { length: MAX_SNAPSHOT_HEALTH_OBSERVATIONS + 2 },
      (_, index) => ({
        subsystem: "OTHER" as const,
        componentId: `component-${String(index)}`,
        state: "HEALTHY" as const
      })
    );
    const snapshot = createDiagnosticSnapshot({ runtime, timings, health });

    expect(snapshot.timings).toHaveLength(MAX_SNAPSHOT_TIMINGS);
    expect(snapshot.timings[0]?.operation).toBe("operation-3");
    expect(snapshot.health).toHaveLength(MAX_SNAPSHOT_HEALTH_OBSERVATIONS);
    expect(snapshot.health[0]?.componentId).toBe("component-2");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.timings)).toBe(true);
  });

  it("refuses to serialize snapshots beyond the hard byte limit", () => {
    const payload = "x".repeat(DIAGNOSTIC_SANITIZATION_LIMITS.maxStringLength);
    const snapshot = DiagnosticSnapshotSchema.parse({
      schemaVersion: 1,
      generatedAt: "2026-08-30T20:00:00.000Z",
      runtime: captureRuntimeFingerprint(),
      timings: Array.from({ length: MAX_SNAPSHOT_TIMINGS }, (_, index) => ({
        operation: `large-${String(index)}`,
        category: "OTHER" as const,
        elapsedMs: index,
        outcome: "SUCCESS" as const,
        tags: { first: payload, second: payload }
      })),
      timingAggregates: [],
      health: []
    });

    expect(JSON.stringify(snapshot).length).toBeGreaterThan(MAX_SERIALIZED_DIAGNOSTIC_SNAPSHOT_BYTES);
    expect(() => serializeDiagnosticSnapshot(snapshot, 0)).toThrow(/byte limit/u);
  });
});

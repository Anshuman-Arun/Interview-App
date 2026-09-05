import { describe, expect, it } from "vitest";
import {
  MAX_STARTUP_STAGES,
  MAX_STAGE_DETAIL_CHARS,
  STARTUP_STAGE_PROCESS_START,
  STARTUP_STAGE_STARTUP_WINDOW_VISIBLE,
  STARTUP_STAGE_RUNTIME_START,
  STARTUP_STAGE_RUNTIME_READY,
  STARTUP_STAGE_MAIN_WINDOW_READY,
  STARTUP_STAGE_COMPLETED,
  StartupTracker,
  sanitizeStartupDetail
} from "../apps/desktop/src/startup-tracker.js";

describe("desktop startup tracker", () => {
  it("initializes with process_start stage", () => {
    const tracker = new StartupTracker();
    const report = tracker.getReport();
    expect(report.stages).toHaveLength(1);
    expect(report.stages[0]?.stage).toBe(STARTUP_STAGE_PROCESS_START);
    expect(report.stages[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.success).toBe(false);
  });

  it("records subsequent stages with monotonic elapsed timings", async () => {
    const tracker = new StartupTracker();
    tracker.recordStage(STARTUP_STAGE_STARTUP_WINDOW_VISIBLE, "window opened");
    await new Promise((resolve) => setTimeout(resolve, 10));
    tracker.recordStage(STARTUP_STAGE_RUNTIME_START, "starting speech/tts/vision");
    await new Promise((resolve) => setTimeout(resolve, 10));
    tracker.recordStage(STARTUP_STAGE_RUNTIME_READY, "workers active");
    tracker.recordStage(STARTUP_STAGE_MAIN_WINDOW_READY);

    const report = tracker.complete(true);
    expect(report.success).toBe(true);
    expect(report.stages.length).toBe(6); // process_start + 4 intermediate + completed
    expect(report.stages[5]?.stage).toBe(STARTUP_STAGE_COMPLETED);

    let lastElapsed = -1;
    for (const stage of report.stages) {
      expect(stage.elapsedMs).toBeGreaterThanOrEqual(lastElapsed);
      lastElapsed = stage.elapsedMs;
    }
  });

  it("sanitizes and redacts tokens and sensitive headers from details", () => {
    expect(sanitizeStartupDetail(undefined)).toBeUndefined();
    expect(sanitizeStartupDetail("")).toBeUndefined();
    expect(sanitizeStartupDetail("Normal startup message")).toBe("Normal startup message");

    // Redacts long hex tokens
    const withToken = "Worker token: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(sanitizeStartupDetail(withToken)).toBe("Worker token: [REDACTED]");

    // Redacts auth header
    const withAuth = "Authorization: Bearer mySecretToken12345";
    expect(sanitizeStartupDetail(withAuth)).toContain("[REDACTED]");

    // Clamps long strings
    const longString = "Z".repeat(300);
    const sanitized = sanitizeStartupDetail(longString);
    expect(sanitized?.length).toBe(MAX_STAGE_DETAIL_CHARS);
  });

  it("bounds maximum recorded stages to prevent memory growth", () => {
    const tracker = new StartupTracker();
    for (let i = 0; i < MAX_STARTUP_STAGES + 20; i++) {
      tracker.recordStage(`stage_${i}`);
    }
    const report = tracker.getReport();
    expect(report.stages.length).toBeLessThanOrEqual(MAX_STARTUP_STAGES);
  });

  it("records failure reason upon completion", () => {
    const tracker = new StartupTracker();
    const report = tracker.complete(false, "Timeout waiting for worker token: 0123456789abcdef0123456789abcdef");
    expect(report.success).toBe(false);
    expect(report.failureReason).toBe("Timeout waiting for worker token: [REDACTED]");
  });
});

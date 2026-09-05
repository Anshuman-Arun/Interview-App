export const MAX_STARTUP_STAGES = 32;
export const MAX_STAGE_DETAIL_CHARS = 128;

export const STARTUP_STAGE_PROCESS_START = "process_start";
export const STARTUP_STAGE_STARTUP_WINDOW_VISIBLE = "startup_window_visible";
export const STARTUP_STAGE_RUNTIME_START = "runtime_start";
export const STARTUP_STAGE_RUNTIME_READY = "runtime_ready";
export const STARTUP_STAGE_FRONTEND_START = "frontend_start";
export const STARTUP_STAGE_BACKEND_START = "backend_start";
export const STARTUP_STAGE_BACKEND_READY = "backend_ready";
export const STARTUP_STAGE_MAIN_WINDOW_READY = "main_window_ready";
export const STARTUP_STAGE_COMPLETED = "completed";

export interface StartupStageRecord {
  readonly stage: string;
  readonly elapsedMs: number;
  readonly detail?: string | undefined;
}

export interface StartupTimingReport {
  readonly totalElapsedMs: number;
  readonly stages: readonly StartupStageRecord[];
  readonly success: boolean;
  readonly failureReason?: string | undefined;
}

const HEX_TOKEN_PATTERN = /\b[0-9a-fA-F]{16,}\b/g;
const AUTH_HEADER_PATTERN = /\bbearer\s+[^\s,]+/gi;
const KEY_VALUE_SECRET_PATTERN = /\b(token|secret|password|api_?key)\s*[:=]\s*[^\s,]+/gi;

export function sanitizeStartupDetail(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return undefined;
  let sanitized = raw
    .replace(AUTH_HEADER_PATTERN, "Bearer [REDACTED]")
    .replace(KEY_VALUE_SECRET_PATTERN, "$1: [REDACTED]")
    .replace(HEX_TOKEN_PATTERN, "[REDACTED]")
    .trim();
  if (sanitized.length > MAX_STAGE_DETAIL_CHARS) {
    sanitized = sanitized.slice(0, MAX_STAGE_DETAIL_CHARS);
  }
  return sanitized.length > 0 ? sanitized : undefined;
}

export class StartupTracker {
  private readonly startTime: number;
  private readonly stages: StartupStageRecord[] = [];
  private finished = false;
  private success = false;
  private failureReason?: string | undefined;

  constructor(startTime: number = performance.now()) {
    this.startTime = startTime;
    this.recordStage(STARTUP_STAGE_PROCESS_START);
  }

  public recordStage(stage: string, detail?: string): void {
    if (this.finished || this.stages.length >= MAX_STARTUP_STAGES) return;
    const elapsedMs = Math.max(0, Math.round(performance.now() - this.startTime));
    const sanitizedDetail = sanitizeStartupDetail(detail);
    this.stages.push(
      Object.freeze({
        stage: stage.slice(0, 64),
        elapsedMs,
        ...(sanitizedDetail === undefined ? {} : { detail: sanitizedDetail })
      })
    );
  }

  public complete(success: boolean, failureReason?: string): StartupTimingReport {
    if (!this.finished) {
      this.success = success;
      this.failureReason = sanitizeStartupDetail(failureReason);
      this.recordStage(STARTUP_STAGE_COMPLETED, success ? "success" : this.failureReason);
      this.finished = true;
    }
    return this.getReport();
  }

  public getReport(): StartupTimingReport {
    const totalElapsedMs = Math.max(0, Math.round(performance.now() - this.startTime));
    return Object.freeze({
      totalElapsedMs,
      stages: Object.freeze([...this.stages]),
      success: this.success,
      ...(this.failureReason === undefined ? {} : { failureReason: this.failureReason })
    });
  }
}

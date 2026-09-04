import { DatabaseSync } from "node:sqlite";
import {
  SessionIdSchema,
  type SessionId,
  type VerificationStatus
} from "../../../packages/domain/src/index.js";
import {
  RemoteReasoningOperationKindSchema,
  RemoteReasoningOutcomeSchema,
  SessionPerformanceReadResponseSchema,
  SessionPerformanceSummarySchema,
  type RemoteReasoningOperationKind,
  type RemoteReasoningOutcome,
  type SessionPerformanceReadResponse,
  type SessionPerformanceSummary
} from "../../../packages/diagnostics/src/index.js";
import type { ProviderCallObserver } from "../../../packages/interview-engine/src/provider-coordinator.js";

const MAX_REMOTE_ATTEMPTS_PER_SESSION = 256;
const MAX_LATENCY_SAMPLES_PER_KIND = 128;
const MAX_PERSISTED_METRICS_BYTES = 512 * 1024;
const MAX_PERSISTED_SESSIONS = 100;
const MAX_CANDIDATE_TURN_IDS = 512;
const MAX_IDENTIFIER_LENGTH = 128;

type LocalTimingKind = "STT" | "TTS" | "VISION";

interface RemoteAttempt {
  readonly operation: RemoteReasoningOperationKind;
  readonly providerId: string;
  readonly modelId: string;
  readonly startedAt: string;
  readonly elapsedMs: number | null;
  readonly outcome: RemoteReasoningOutcome;
  readonly requestBytes: number;
  readonly compiledContextBytes: number;
  readonly responseBytes: number;
}

interface SessionMetrics {
  partial: boolean;
  candidateSubstantiveTurns: number;
  candidateTurnIds: string[];
  remoteAttempts: RemoteAttempt[];
  remoteTotals: {
    interviewerCalls: number;
    formalInterpretationCalls: number;
    outcomes: Record<RemoteReasoningOutcome, number>;
    requestBytes: number;
    compiledContextBytes: number;
    responseBytes: number;
  };
  formal: {
    attempts: number;
    accepted: number;
    abstentions: number;
    timeouts: number;
    cancelled: number;
    failedOrMalformed: number;
    verification: Record<string, number>;
  };
  local: {
    voiceInputSessions: number;
    committedUtterances: number;
    sttFinalizations: number;
    sttFailures: number;
    sttCancellations: number;
    ttsRequests: number;
    ttsSuccesses: number;
    ttsFailures: number;
    ttsCancellations: number;
    ttsBargeInInterruptions: number;
    visionRequests: number;
    visionInferenceCompletions: number;
    visionAcceptedObservations: number;
    visionStaleRejections: number;
    visionOtherRejections: number;
    visionInferenceFailures: number;
  };
  latencies: Record<LocalTimingKind, number[]>;
}

export interface RemoteOperationHandle {
  readonly startedAt: string;
  setSizes(input: {
    readonly requestBytes?: number;
    readonly compiledContextBytes?: number;
    readonly responseBytes?: number;
  }): void;
  finish(outcome: RemoteReasoningOutcome): void;
}

export interface LocalTimingHandle {
  finish(outcome: "SUCCESS" | "FAILURE" | "CANCELLED"): void;
}

function emptyMetrics(partial = false): SessionMetrics {
  return {
    partial,
    candidateSubstantiveTurns: 0,
    candidateTurnIds: [],
    remoteAttempts: [],
    remoteTotals: {
      interviewerCalls: 0,
      formalInterpretationCalls: 0,
      outcomes: {
        SUCCESS: 0,
        ABSTAINED: 0,
        TIMEOUT: 0,
        CANCELLED: 0,
        POLICY_DENIED: 0,
        PROVIDER_UNAVAILABLE: 0,
        MALFORMED: 0,
        FAILED: 0
      },
      requestBytes: 0,
      compiledContextBytes: 0,
      responseBytes: 0
    },
    formal: {
      attempts: 0,
      accepted: 0,
      abstentions: 0,
      timeouts: 0,
      cancelled: 0,
      failedOrMalformed: 0,
      verification: {
        VERIFIED: 0,
        CONTRADICTED: 0,
        UNRESOLVED: 0
      }
    },
    local: {
      voiceInputSessions: 0,
      committedUtterances: 0,
      sttFinalizations: 0,
      sttFailures: 0,
      sttCancellations: 0,
      ttsRequests: 0,
      ttsSuccesses: 0,
      ttsFailures: 0,
      ttsCancellations: 0,
      ttsBargeInInterruptions: 0,
      visionRequests: 0,
      visionInferenceCompletions: 0,
      visionAcceptedObservations: 0,
      visionStaleRejections: 0,
      visionOtherRejections: 0,
      visionInferenceFailures: 0
    },
    latencies: { STT: [], TTS: [], VISION: [] }
  };
}

function boundedIdentifier(value: string): string {
  const normalized = value.trim();
  return (normalized.length === 0 ? "unknown" : normalized).slice(0, MAX_IDENTIFIER_LENGTH);
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function addBounded(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, boundedCount(left) + boundedCount(right));
}

function cloneMetrics(metrics: SessionMetrics): SessionMetrics {
  return structuredClone(metrics);
}

function parsePersistedMetrics(value: unknown): SessionMetrics | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const parsed = value as Partial<SessionMetrics>;
  if (
    typeof parsed.partial !== "boolean"
    || typeof parsed.candidateSubstantiveTurns !== "number"
    || !Number.isSafeInteger(parsed.candidateSubstantiveTurns)
    || parsed.candidateSubstantiveTurns < 0
    || !Array.isArray(parsed.candidateTurnIds)
    || parsed.candidateTurnIds.length > MAX_CANDIDATE_TURN_IDS
    || parsed.candidateTurnIds.some((turnId) => typeof turnId !== "string" || turnId.length === 0 || turnId.length > MAX_IDENTIFIER_LENGTH)
    || !Array.isArray(parsed.remoteAttempts)
    || typeof parsed.remoteTotals !== "object"
    || typeof parsed.formal !== "object"
    || typeof parsed.local !== "object"
    || typeof parsed.latencies !== "object"
  ) return undefined;
  try {
    const metrics = structuredClone(parsed) as SessionMetrics;
    if (metrics.remoteAttempts.length > MAX_REMOTE_ATTEMPTS_PER_SESSION) return undefined;
    if (
      !Number.isSafeInteger(metrics.remoteTotals.interviewerCalls)
      || metrics.remoteTotals.interviewerCalls < 0
      || !Number.isSafeInteger(metrics.remoteTotals.formalInterpretationCalls)
      || metrics.remoteTotals.formalInterpretationCalls < 0
      || !Number.isSafeInteger(metrics.remoteTotals.requestBytes)
      || metrics.remoteTotals.requestBytes < 0
      || !Number.isSafeInteger(metrics.remoteTotals.compiledContextBytes)
      || metrics.remoteTotals.compiledContextBytes < 0
      || !Number.isSafeInteger(metrics.remoteTotals.responseBytes)
      || metrics.remoteTotals.responseBytes < 0
    ) return undefined;
    for (const outcome of RemoteReasoningOutcomeSchema.options) {
      const count = metrics.remoteTotals.outcomes[outcome];
      if (!Number.isSafeInteger(count) || count < 0) return undefined;
    }
    for (const attempt of metrics.remoteAttempts) {
      RemoteReasoningOperationKindSchema.parse(attempt.operation);
      RemoteReasoningOutcomeSchema.parse(attempt.outcome);
      if (
        typeof attempt.providerId !== "string"
        || attempt.providerId.length === 0
        || attempt.providerId.length > MAX_IDENTIFIER_LENGTH
        || typeof attempt.modelId !== "string"
        || attempt.modelId.length === 0
        || attempt.modelId.length > MAX_IDENTIFIER_LENGTH
        || typeof attempt.startedAt !== "string"
        || attempt.startedAt.length === 0
        || (
          attempt.elapsedMs !== null
          && (!Number.isFinite(attempt.elapsedMs) || attempt.elapsedMs < 0)
        )
        || !Number.isSafeInteger(attempt.requestBytes)
        || attempt.requestBytes < 0
        || !Number.isSafeInteger(attempt.compiledContextBytes)
        || attempt.compiledContextBytes < 0
        || !Number.isSafeInteger(attempt.responseBytes)
        || attempt.responseBytes < 0
      ) return undefined;
    }
    for (const kind of ["STT", "TTS", "VISION"] as const) {
      const samples = metrics.latencies[kind];
      if (
        !Array.isArray(samples)
        || samples.length > MAX_LATENCY_SAMPLES_PER_KIND
        || samples.some((sample) => !Number.isFinite(sample) || sample < 0)
      ) return undefined;
    }
    return metrics;
  } catch {
    return undefined;
  }
}

class SessionMetricsStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS session_observability (
        session_id TEXT PRIMARY KEY,
        metrics_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  public read(sessionId: SessionId): {
    readonly metrics?: SessionMetrics;
    readonly corrupt: boolean;
  } {
    const row = this.#database.prepare(
      "SELECT metrics_json FROM session_observability WHERE session_id = ?"
    ).get(sessionId) as { metrics_json: string } | undefined;
    if (row === undefined) return { corrupt: false };
    if (Buffer.byteLength(row.metrics_json, "utf8") > MAX_PERSISTED_METRICS_BYTES) {
      return { corrupt: true };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metrics_json) as unknown;
    } catch {
      return { corrupt: true };
    }
    const metrics = parsePersistedMetrics(parsed);
    return metrics === undefined
      ? { corrupt: true }
      : { metrics, corrupt: false };
  }

  public write(sessionId: SessionId, metrics: SessionMetrics): void {
    const json = JSON.stringify(metrics);
    if (Buffer.byteLength(json, "utf8") > MAX_PERSISTED_METRICS_BYTES) {
      throw new Error("Session metrics exceed bounded persistence size");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO session_observability(session_id, metrics_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          metrics_json = excluded.metrics_json,
          updated_at = excluded.updated_at
      `).run(sessionId, json, new Date().toISOString());
      this.#database.prepare(`
        DELETE FROM session_observability
        WHERE session_id NOT IN (
          SELECT session_id
          FROM session_observability
          ORDER BY updated_at DESC, session_id DESC
          LIMIT ?
        )
      `).run(MAX_PERSISTED_SESSIONS);
      this.#database.exec("COMMIT");
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // A broken sidecar must remain isolated from interview authority.
      }
      throw error;
    }
  }

  public close(): void {
    this.#database.close();
  }
}

export class SessionObservability {
  readonly #cache = new Map<SessionId, SessionMetrics>();
  readonly #corruptOrUnreadableSessions = new Set<SessionId>();
  readonly #store: SessionMetricsStore | undefined;
  readonly #now: () => number;

  public static create(databasePath: string, now?: () => number): SessionObservability {
    try {
      return new SessionObservability(new SessionMetricsStore(databasePath), now);
    } catch {
      return new SessionObservability(undefined, now, true);
    }
  }

  public constructor(
    store?: SessionMetricsStore,
    now: () => number = () => globalThis.performance.now(),
    private readonly persistenceUnavailable = false
  ) {
    this.#store = store;
    this.#now = now;
  }

  public beginRemoteOperation(input: {
    readonly sessionId: SessionId;
    readonly operation: RemoteReasoningOperationKind;
    readonly providerId: string;
    readonly modelId: string;
  }): RemoteOperationHandle {
    const parsedSessionId = SessionIdSchema.safeParse(input.sessionId);
    const parsedOperation = RemoteReasoningOperationKindSchema.safeParse(input.operation);
    if (!parsedSessionId.success || !parsedOperation.success) return noOpRemoteOperationHandle();
    const sessionId = parsedSessionId.data;
    const operation = parsedOperation.data;
    const startedMonotonic = this.safeNow();
    const startedAt = safeWallTime();
    let requestBytes = 0;
    let compiledContextBytes = 0;
    let responseBytes = 0;
    let finished = false;
    return {
      startedAt,
      setSizes: (sizes) => {
        try {
          if (finished) return;
          if (sizes.requestBytes !== undefined) requestBytes = boundedCount(sizes.requestBytes);
          if (sizes.compiledContextBytes !== undefined) {
            compiledContextBytes = boundedCount(sizes.compiledContextBytes);
          }
          if (sizes.responseBytes !== undefined) responseBytes = boundedCount(sizes.responseBytes);
        } catch {
          // Telemetry sizing is best-effort and must never escape into runtime work.
        }
      },
      finish: (outcome) => {
        if (finished) return;
        finished = true;
        try {
          const parsedOutcome = RemoteReasoningOutcomeSchema.safeParse(outcome);
          if (!parsedOutcome.success) return;
          const elapsedMs = elapsedSince(startedMonotonic, this.safeNow());
          this.mutate(sessionId, (metrics) => {
            const attempt: RemoteAttempt = {
              operation,
              providerId: boundedIdentifier(input.providerId),
              modelId: boundedIdentifier(input.modelId),
              startedAt,
              elapsedMs,
              outcome: parsedOutcome.data,
              requestBytes,
              compiledContextBytes,
              responseBytes
            };
            if (elapsedMs === null) metrics.partial = true;
            if (operation === "INTERVIEWER_REALIZATION") {
              metrics.remoteTotals.interviewerCalls =
                addBounded(metrics.remoteTotals.interviewerCalls, 1);
            } else {
              metrics.remoteTotals.formalInterpretationCalls =
                addBounded(metrics.remoteTotals.formalInterpretationCalls, 1);
            }
            metrics.remoteTotals.outcomes[attempt.outcome] =
              addBounded(metrics.remoteTotals.outcomes[attempt.outcome], 1);
            metrics.remoteTotals.requestBytes =
              addBounded(metrics.remoteTotals.requestBytes, attempt.requestBytes);
            metrics.remoteTotals.compiledContextBytes =
              addBounded(metrics.remoteTotals.compiledContextBytes, attempt.compiledContextBytes);
            metrics.remoteTotals.responseBytes =
              addBounded(metrics.remoteTotals.responseBytes, attempt.responseBytes);
            if (metrics.remoteAttempts.length === MAX_REMOTE_ATTEMPTS_PER_SESSION) {
              metrics.remoteAttempts.shift();
              metrics.partial = true;
            }
            metrics.remoteAttempts.push(attempt);
          });
        } catch {
          // Telemetry completion is never an interview/provider failure gate.
        }
      }
    };
  }

  public recordCandidateSubstantiveTurn(sessionId: SessionId, turnIdInput: string): void {
    const turnId = boundedIdentifier(turnIdInput);
    this.increment(sessionId, (metrics) => {
      if (metrics.candidateTurnIds.includes(turnId)) return;
      metrics.candidateSubstantiveTurns = addBounded(metrics.candidateSubstantiveTurns, 1);
      if (metrics.candidateTurnIds.length === MAX_CANDIDATE_TURN_IDS) {
        metrics.candidateTurnIds.shift();
        metrics.partial = true;
      }
      metrics.candidateTurnIds.push(turnId);
    });
  }

  public createInterviewerObserver(input: {
    readonly sessionId: SessionId;
    readonly providerId: string;
    readonly modelId: string;
  }): ProviderCallObserver {
    const handles = new Map<string, RemoteOperationHandle>();
    return {
      onStarted: ({ generationId, context }) => {
        const handle = this.beginRemoteOperation({
          sessionId: input.sessionId,
          operation: "INTERVIEWER_REALIZATION",
          providerId: input.providerId,
          modelId: input.modelId
        });
        handle.setSizes({
          requestBytes: serializedApplicationBytes({
            context,
            generationId
          }),
          compiledContextBytes: serializedApplicationBytes(context)
        });
        handles.set(generationId, handle);
      },
      onProposal: ({ generationId, proposal }) => {
        handles.get(generationId)?.setSizes({
          responseBytes: serializedApplicationBytes(proposal)
        });
      },
      onFinished: ({ generationId, outcome }) => {
        const handle = handles.get(generationId);
        handles.delete(generationId);
        handle?.finish(outcome);
      }
    };
  }

  public recordFormalAttempt(sessionId: SessionId): void {
    this.increment(sessionId, (metrics) => {
      metrics.formal.attempts = addBounded(metrics.formal.attempts, 1);
    });
  }

  public recordFormalResult(
    sessionId: SessionId,
    result:
      | { readonly kind: "ACCEPTED"; readonly verificationStatus: VerificationStatus }
      | { readonly kind: "ABSTAINED" | "TIMEOUT" | "CANCELLED" | "FAILED_OR_MALFORMED" }
  ): void {
    this.increment(sessionId, (metrics) => {
      if (result.kind === "ACCEPTED") {
        metrics.formal.accepted = addBounded(metrics.formal.accepted, 1);
        metrics.formal.verification[result.verificationStatus] =
          addBounded(metrics.formal.verification[result.verificationStatus] ?? 0, 1);
      } else if (result.kind === "ABSTAINED") {
        metrics.formal.abstentions = addBounded(metrics.formal.abstentions, 1);
      } else if (result.kind === "TIMEOUT") {
        metrics.formal.timeouts = addBounded(metrics.formal.timeouts, 1);
      } else if (result.kind === "CANCELLED") {
        metrics.formal.cancelled = addBounded(metrics.formal.cancelled, 1);
      } else {
        metrics.formal.failedOrMalformed = addBounded(metrics.formal.failedOrMalformed, 1);
      }
    });
  }

  public beginLocalTiming(sessionIdInput: SessionId, kind: LocalTimingKind): LocalTimingHandle {
    const parsedSessionId = SessionIdSchema.safeParse(sessionIdInput);
    if (!parsedSessionId.success) return noOpLocalTimingHandle();
    const sessionId = parsedSessionId.data;
    const started = this.safeNow();
    let finished = false;
    return {
      finish: (outcome) => {
        if (finished) return;
        finished = true;
        try {
          const elapsed = elapsedSince(started, this.safeNow());
          this.mutate(sessionId, (metrics) => {
            if (elapsed === null) {
              metrics.partial = true;
            } else {
              const samples = metrics.latencies[kind];
              if (samples.length === MAX_LATENCY_SAMPLES_PER_KIND) {
                samples.shift();
                metrics.partial = true;
              }
              samples.push(elapsed);
            }
            if (kind === "STT") {
              if (outcome === "SUCCESS") metrics.local.sttFinalizations = addBounded(metrics.local.sttFinalizations, 1);
              else if (outcome === "CANCELLED") metrics.local.sttCancellations = addBounded(metrics.local.sttCancellations, 1);
              else metrics.local.sttFailures = addBounded(metrics.local.sttFailures, 1);
            } else if (kind === "TTS") {
              if (outcome === "SUCCESS") metrics.local.ttsSuccesses = addBounded(metrics.local.ttsSuccesses, 1);
              else if (outcome === "CANCELLED") metrics.local.ttsCancellations = addBounded(metrics.local.ttsCancellations, 1);
              else metrics.local.ttsFailures = addBounded(metrics.local.ttsFailures, 1);
            } else {
              if (outcome === "SUCCESS") metrics.local.visionInferenceCompletions = addBounded(metrics.local.visionInferenceCompletions, 1);
              else metrics.local.visionInferenceFailures = addBounded(metrics.local.visionInferenceFailures, 1);
            }
          });
        } catch {
          // Local timing must remain observational even if its clock fails.
        }
      }
    };
  }

  public recordSttFailure(sessionId: SessionId): void {
    this.increment(sessionId, (m) => {
      m.local.sttFailures = addBounded(m.local.sttFailures, 1);
    });
  }

  public recordSttCancellation(sessionId: SessionId): void {
    this.increment(sessionId, (m) => {
      m.local.sttCancellations = addBounded(m.local.sttCancellations, 1);
    });
  }

  public recordVoiceInputSession(sessionId: SessionId): void {
    this.increment(sessionId, (m) => { m.local.voiceInputSessions = addBounded(m.local.voiceInputSessions, 1); });
  }
  public recordCommittedUtterance(sessionId: SessionId): void {
    this.increment(sessionId, (m) => { m.local.committedUtterances = addBounded(m.local.committedUtterances, 1); });
  }
  public recordTtsRequest(sessionId: SessionId): void {
    this.increment(sessionId, (m) => { m.local.ttsRequests = addBounded(m.local.ttsRequests, 1); });
  }
  public recordTtsCancellation(sessionId: SessionId): void {
    this.increment(sessionId, (m) => { m.local.ttsCancellations = addBounded(m.local.ttsCancellations, 1); });
  }
  public recordBargeIn(sessionId: SessionId): void {
    this.increment(sessionId, (m) => { m.local.ttsBargeInInterruptions = addBounded(m.local.ttsBargeInInterruptions, 1); });
  }
  public recordVisionRequest(sessionId: SessionId): void {
    this.increment(sessionId, (m) => { m.local.visionRequests = addBounded(m.local.visionRequests, 1); });
  }
  public recordVisionAccepted(sessionId: SessionId): void {
    this.increment(sessionId, (m) => { m.local.visionAcceptedObservations = addBounded(m.local.visionAcceptedObservations, 1); });
  }
  public recordVisionRejected(sessionId: SessionId, stale: boolean): void {
    this.increment(sessionId, (m) => {
      if (stale) m.local.visionStaleRejections = addBounded(m.local.visionStaleRejections, 1);
      else m.local.visionOtherRejections = addBounded(m.local.visionOtherRejections, 1);
    });
  }

  public read(sessionIdInput: SessionId): SessionPerformanceReadResponse {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const metrics = this.load(sessionId);
    const unavailable = () => SessionPerformanceReadResponseSchema.parse({
      protocolVersion: 1,
      type: "SESSION_PERFORMANCE_READ",
      sessionId,
      available: false,
      partial: this.persistenceUnavailable || this.#corruptOrUnreadableSessions.has(sessionId)
    });
    if (metrics === undefined) return unavailable();
    try {
      const summary = this.project(metrics);
      return SessionPerformanceReadResponseSchema.parse({
        protocolVersion: 1,
        type: "SESSION_PERFORMANCE_READ",
        sessionId,
        available: true,
        partial: summary.partial,
        summary
      });
    } catch {
      this.#cache.delete(sessionId);
      this.rememberCorruptOrUnreadable(sessionId);
      return unavailable();
    }
  }

  public close(): void {
    try {
      this.#store?.close();
    } catch {
      // Observability teardown is best effort.
    }
  }

  private increment(sessionId: SessionId, operation: (metrics: SessionMetrics) => void): void {
    const parsed = SessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return;
    this.mutate(parsed.data, operation);
  }

  private mutate(sessionId: SessionId, operation: (metrics: SessionMetrics) => void): void {
    try {
      const metrics = this.load(sessionId) ?? emptyMetrics(
        this.persistenceUnavailable || this.#corruptOrUnreadableSessions.has(sessionId)
      );
      operation(metrics);
      this.rememberInCache(sessionId, metrics);
      try {
        this.#store?.write(sessionId, metrics);
      } catch {
        metrics.partial = true;
        this.rememberCorruptOrUnreadable(sessionId);
      }
    } catch {
      // Metrics must never be an authority, admission, delivery, or failure gate.
    }
  }

  private load(sessionId: SessionId): SessionMetrics | undefined {
    const cached = this.#cache.get(sessionId);
    if (cached !== undefined) return cached;
    try {
      const persisted = this.#store?.read(sessionId);
      if (persisted?.corrupt === true) {
        this.rememberCorruptOrUnreadable(sessionId);
        return undefined;
      }
      if (persisted?.metrics !== undefined) {
        this.rememberInCache(sessionId, persisted.metrics);
        return persisted.metrics;
      }
    } catch {
      this.rememberCorruptOrUnreadable(sessionId);
      return undefined;
    }
    return undefined;
  }

  private safeNow(): number | undefined {
    try {
      const value = this.#now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private rememberInCache(sessionId: SessionId, metrics: SessionMetrics): void {
    this.#cache.delete(sessionId);
    this.#cache.set(sessionId, metrics);
    while (this.#cache.size > MAX_PERSISTED_SESSIONS) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  private rememberCorruptOrUnreadable(sessionId: SessionId): void {
    this.#corruptOrUnreadableSessions.delete(sessionId);
    this.#corruptOrUnreadableSessions.add(sessionId);
    while (this.#corruptOrUnreadableSessions.size > MAX_PERSISTED_SESSIONS) {
      const oldest = this.#corruptOrUnreadableSessions.values().next().value;
      if (oldest === undefined) break;
      this.#corruptOrUnreadableSessions.delete(oldest);
    }
  }

  private project(metricsInput: SessionMetrics): SessionPerformanceSummary {
    const metrics = cloneMetrics(metricsInput);
    const interviewer = metrics.remoteAttempts.filter((a) => a.operation === "INTERVIEWER_REALIZATION");
    const formal = metrics.remoteAttempts.filter((a) => a.operation === "FORMAL_INTERPRETATION");
    return SessionPerformanceSummarySchema.parse({
      measuredBy: "Interview App",
      partial: metrics.partial || this.persistenceUnavailable,
      candidateSubstantiveTurns: metrics.candidateSubstantiveTurns,
      remote: {
        interviewerCalls: metrics.remoteTotals.interviewerCalls,
        formalInterpretationCalls: metrics.remoteTotals.formalInterpretationCalls,
        totalCalls: addBounded(
          metrics.remoteTotals.interviewerCalls,
          metrics.remoteTotals.formalInterpretationCalls
        ),
        interviewerLatency: latencySummary(interviewer.flatMap((a) =>
          a.elapsedMs === null ? [] : [a.elapsedMs]
        )),
        formalInterpretationLatency: latencySummary(formal.flatMap((a) =>
          a.elapsedMs === null ? [] : [a.elapsedMs]
        )),
        outcomes: metrics.remoteTotals.outcomes,
        requestBytes: metrics.remoteTotals.requestBytes,
        compiledContextBytes: metrics.remoteTotals.compiledContextBytes,
        responseBytes: metrics.remoteTotals.responseBytes
      },
      formalInterpretation: {
        attempts: metrics.formal.attempts,
        accepted: metrics.formal.accepted,
        abstentions: metrics.formal.abstentions,
        timeouts: metrics.formal.timeouts,
        cancelled: metrics.formal.cancelled,
        failedOrMalformed: metrics.formal.failedOrMalformed,
        verification: metrics.formal.verification
      },
      local: {
        voiceInputSessions: metrics.local.voiceInputSessions,
        committedUtterances: metrics.local.committedUtterances,
        stt: {
          finalizations: metrics.local.sttFinalizations,
          failures: metrics.local.sttFailures,
          cancellations: metrics.local.sttCancellations,
          latency: latencySummary(metrics.latencies.STT)
        },
        tts: {
          requests: metrics.local.ttsRequests,
          successes: metrics.local.ttsSuccesses,
          failures: metrics.local.ttsFailures,
          cancellations: metrics.local.ttsCancellations,
          bargeInInterruptions: metrics.local.ttsBargeInInterruptions,
          latency: latencySummary(metrics.latencies.TTS)
        },
        vision: {
          requests: metrics.local.visionRequests,
          inferenceCompletions: metrics.local.visionInferenceCompletions,
          acceptedObservations: metrics.local.visionAcceptedObservations,
          staleRejections: metrics.local.visionStaleRejections,
          otherRejections: metrics.local.visionOtherRejections,
          inferenceFailures: metrics.local.visionInferenceFailures,
          latency: latencySummary(metrics.latencies.VISION)
        }
      }
    });
  }
}

function latencySummary(samplesInput: readonly number[]): {
  readonly count: number;
  readonly medianMs: number | null;
  readonly slowestMs: number | null;
} {
  if (samplesInput.length === 0) return { count: 0, medianMs: null, slowestMs: null };
  const samples = [...samplesInput].sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 === 0
    ? ((samples[middle - 1] ?? 0) + (samples[middle] ?? 0)) / 2
    : samples[middle] ?? 0;
  return { count: samples.length, medianMs: median, slowestMs: samples.at(-1) ?? 0 };
}

export function serializedApplicationBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json).byteLength;
  } catch {
    return 0;
  }
}


function elapsedSince(started: number | undefined, ended: number | undefined): number | null {
  if (
    started === undefined
    || ended === undefined
    || !Number.isFinite(started)
    || !Number.isFinite(ended)
    || ended < started
  ) {
    return null;
  }
  return ended - started;
}

function safeWallTime(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

function noOpRemoteOperationHandle(): RemoteOperationHandle {
  return {
    startedAt: "1970-01-01T00:00:00.000Z",
    setSizes: () => undefined,
    finish: () => undefined
  };
}

function noOpLocalTimingHandle(): LocalTimingHandle {
  return {
    finish: () => undefined
  };
}

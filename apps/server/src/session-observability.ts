import { DatabaseSync } from "node:sqlite";
import {
  SessionIdSchema,
  type SessionId,
  type VerificationStatus,
  type ReasoningProvider,
  type ReasoningSession,
  type ReasoningTurnInput,
  type InterviewerProposal
} from "../../../packages/domain/src/index.js";
import {
  RemoteReasoningOutcomeSchema,
  SessionPerformanceReadResponseSchema,
  SessionPerformanceSummarySchema,
  type RemoteReasoningOperationKind,
  type RemoteReasoningOutcome,
  type SessionPerformanceReadResponse,
  type SessionPerformanceSummary
} from "../../../packages/diagnostics/src/index.js";

const MAX_REMOTE_ATTEMPTS_PER_SESSION = 256;
const MAX_LATENCY_SAMPLES_PER_KIND = 128;
const MAX_PERSISTED_METRICS_BYTES = 512 * 1024;
const MAX_IDENTIFIER_LENGTH = 128;

type LocalTimingKind = "STT" | "TTS" | "VISION";

interface RemoteAttempt {
  readonly operation: RemoteReasoningOperationKind;
  readonly providerId: string;
  readonly modelId: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly outcome: RemoteReasoningOutcome;
  readonly requestBytes: number;
  readonly compiledContextBytes: number;
  readonly responseBytes: number;
}

interface SessionMetrics {
  partial: boolean;
  candidateSubstantiveTurns: number;
  remoteAttempts: RemoteAttempt[];
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
    remoteAttempts: [],
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
    || !Number.isSafeInteger(parsed.candidateSubstantiveTurns)
    || parsed.candidateSubstantiveTurns < 0
    || !Array.isArray(parsed.remoteAttempts)
    || typeof parsed.formal !== "object"
    || parsed.formal === null
    || typeof parsed.local !== "object"
    || parsed.local === null
    || typeof parsed.latencies !== "object"
    || parsed.latencies === null
  ) return undefined;
  try {
    const metrics = structuredClone(parsed) as SessionMetrics;
    if (metrics.remoteAttempts.length > MAX_REMOTE_ATTEMPTS_PER_SESSION) return undefined;
    for (const attempt of metrics.remoteAttempts) {
      RemoteReasoningOutcomeSchema.parse(attempt.outcome);
      if (
        (attempt.operation !== "INTERVIEWER_REALIZATION" && attempt.operation !== "FORMAL_INTERPRETATION")
        || typeof attempt.providerId !== "string"
        || typeof attempt.modelId !== "string"
        || !Number.isFinite(attempt.elapsedMs)
        || attempt.elapsedMs < 0
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

  public read(sessionId: SessionId): SessionMetrics | undefined {
    const row = this.#database.prepare(
      "SELECT metrics_json FROM session_observability WHERE session_id = ?"
    ).get(sessionId) as { metrics_json: string } | undefined;
    if (row === undefined || Buffer.byteLength(row.metrics_json, "utf8") > MAX_PERSISTED_METRICS_BYTES) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metrics_json) as unknown;
    } catch {
      return undefined;
    }
    return parsePersistedMetrics(parsed);
  }

  public write(sessionId: SessionId, metrics: SessionMetrics): void {
    const json = JSON.stringify(metrics);
    if (Buffer.byteLength(json, "utf8") > MAX_PERSISTED_METRICS_BYTES) {
      throw new Error("Session metrics exceed bounded persistence size");
    }
    this.#database.prepare(`
      INSERT INTO session_observability(session_id, metrics_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        metrics_json = excluded.metrics_json,
        updated_at = excluded.updated_at
    `).run(sessionId, json, new Date().toISOString());
  }

  public close(): void {
    this.#database.close();
  }
}

export class SessionObservability {
  readonly #cache = new Map<SessionId, SessionMetrics>();
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
    const sessionId = SessionIdSchema.parse(input.sessionId);
    const startedMonotonic = this.#now();
    const startedAt = new Date().toISOString();
    let requestBytes = 0;
    let compiledContextBytes = 0;
    let responseBytes = 0;
    let finished = false;
    return {
      startedAt,
      setSizes: (sizes) => {
        if (finished) return;
        if (sizes.requestBytes !== undefined) requestBytes = boundedCount(sizes.requestBytes);
        if (sizes.compiledContextBytes !== undefined) {
          compiledContextBytes = boundedCount(sizes.compiledContextBytes);
        }
        if (sizes.responseBytes !== undefined) responseBytes = boundedCount(sizes.responseBytes);
      },
      finish: (outcome) => {
        if (finished) return;
        finished = true;
        const elapsedMs = Math.max(0, this.#now() - startedMonotonic);
        this.mutate(sessionId, (metrics) => {
          const attempt: RemoteAttempt = {
            operation: input.operation,
            providerId: boundedIdentifier(input.providerId),
            modelId: boundedIdentifier(input.modelId),
            startedAt,
            elapsedMs,
            outcome: RemoteReasoningOutcomeSchema.parse(outcome),
            requestBytes,
            compiledContextBytes,
            responseBytes
          };
          if (metrics.remoteAttempts.length === MAX_REMOTE_ATTEMPTS_PER_SESSION) {
            metrics.remoteAttempts.shift();
            metrics.partial = true;
          }
          metrics.remoteAttempts.push(attempt);
        });
      }
    };
  }

  public recordCandidateSubstantiveTurn(sessionId: SessionId): void {
    this.increment(sessionId, (metrics) => {
      metrics.candidateSubstantiveTurns = addBounded(metrics.candidateSubstantiveTurns, 1);
    });
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
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const started = this.#now();
    let finished = false;
    return {
      finish: (outcome) => {
        if (finished) return;
        finished = true;
        const elapsed = Math.max(0, this.#now() - started);
        this.mutate(sessionId, (metrics) => {
          const samples = metrics.latencies[kind];
          if (samples.length === MAX_LATENCY_SAMPLES_PER_KIND) {
            samples.shift();
            metrics.partial = true;
          }
          samples.push(elapsed);
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
      }
    };
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
    if (metrics === undefined) {
      return SessionPerformanceReadResponseSchema.parse({
        protocolVersion: 1,
        type: "SESSION_PERFORMANCE_READ",
        sessionId,
        available: false,
        partial: this.persistenceUnavailable
      });
    }
    const summary = this.project(metrics);
    return SessionPerformanceReadResponseSchema.parse({
      protocolVersion: 1,
      type: "SESSION_PERFORMANCE_READ",
      sessionId,
      available: true,
      partial: summary.partial,
      summary
    });
  }

  public close(): void {
    try {
      this.#store?.close();
    } catch {
      // Observability teardown is best effort.
    }
  }

  private increment(sessionId: SessionId, operation: (metrics: SessionMetrics) => void): void {
    this.mutate(SessionIdSchema.parse(sessionId), operation);
  }

  private mutate(sessionId: SessionId, operation: (metrics: SessionMetrics) => void): void {
    try {
      const metrics = this.load(sessionId) ?? emptyMetrics(this.persistenceUnavailable);
      operation(metrics);
      this.#cache.set(sessionId, metrics);
      try {
        this.#store?.write(sessionId, metrics);
      } catch {
        metrics.partial = true;
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
      if (persisted !== undefined) {
        this.#cache.set(sessionId, persisted);
        return persisted;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private project(metricsInput: SessionMetrics): SessionPerformanceSummary {
    const metrics = cloneMetrics(metricsInput);
    const interviewer = metrics.remoteAttempts.filter((a) => a.operation === "INTERVIEWER_REALIZATION");
    const formal = metrics.remoteAttempts.filter((a) => a.operation === "FORMAL_INTERPRETATION");
    const outcomeCounts = {
      SUCCESS: 0, ABSTAINED: 0, TIMEOUT: 0, CANCELLED: 0,
      POLICY_DENIED: 0, PROVIDER_UNAVAILABLE: 0, MALFORMED: 0, FAILED: 0
    };
    for (const attempt of metrics.remoteAttempts) outcomeCounts[attempt.outcome] += 1;
    const requestBytes = metrics.remoteAttempts.reduce((sum, a) => addBounded(sum, a.requestBytes), 0);
    const contextBytes = metrics.remoteAttempts.reduce((sum, a) => addBounded(sum, a.compiledContextBytes), 0);
    const responseBytes = metrics.remoteAttempts.reduce((sum, a) => addBounded(sum, a.responseBytes), 0);
    return SessionPerformanceSummarySchema.parse({
      measuredBy: "Interview App",
      partial: metrics.partial || this.persistenceUnavailable,
      candidateSubstantiveTurns: metrics.candidateSubstantiveTurns,
      remote: {
        interviewerCalls: interviewer.length,
        formalInterpretationCalls: formal.length,
        totalCalls: metrics.remoteAttempts.length,
        interviewerLatency: latencySummary(interviewer.map((a) => a.elapsedMs)),
        formalInterpretationLatency: latencySummary(formal.map((a) => a.elapsedMs)),
        outcomes: outcomeCounts,
        requestBytes,
        compiledContextBytes: contextBytes,
        responseBytes
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


export function instrumentReasoningProvider(input: {
  readonly provider: ReasoningProvider;
  readonly observability: SessionObservability;
  readonly sessionId: SessionId;
  readonly providerId: string;
  readonly modelId: string;
}): ReasoningProvider {
  const provider = input.provider;
  return {
    name: provider.name,
    adapterVersion: provider.adapterVersion,
    capabilities: provider.capabilities,
    verifyBillingSafety: (verificationInput) =>
      provider.verifyBillingSafety(verificationInput),
    createSession: async (): Promise<ReasoningSession> => {
      const session = await provider.createSession();
      const cancelled = new Set<string>();
      return {
        sendTurn: (turnInput: ReasoningTurnInput): AsyncIterable<InterviewerProposal> => {
          const handle = input.observability.beginRemoteOperation({
            sessionId: input.sessionId,
            operation: "INTERVIEWER_REALIZATION",
            providerId: input.providerId,
            modelId: input.modelId
          });
          handle.setSizes({
            requestBytes: serializedApplicationBytes(turnInput),
            compiledContextBytes: serializedApplicationBytes(turnInput.context)
          });
          const stream = session.sendTurn(turnInput);
          return (async function* (): AsyncIterable<InterviewerProposal> {
            let responseBytes = 0;
            let finished = false;
            try {
              for await (const proposal of stream) {
                responseBytes = addBounded(responseBytes, serializedApplicationBytes(proposal));
                yield proposal;
              }
              handle.setSizes({ responseBytes });
              handle.finish(cancelled.has(turnInput.generationId) ? "CANCELLED" : "SUCCESS");
              finished = true;
            } catch (error) {
              handle.setSizes({ responseBytes });
              handle.finish(cancelled.has(turnInput.generationId) ? "CANCELLED" : "FAILED");
              finished = true;
              throw error;
            } finally {
              if (!finished) {
                handle.setSizes({ responseBytes });
                handle.finish(cancelled.has(turnInput.generationId) ? "CANCELLED" : "SUCCESS");
              }
            }
          })();
        },
        ...(session.cancelTurn === undefined
          ? {}
          : {
              cancelTurn: async (generationId) => {
                cancelled.add(generationId);
                return session.cancelTurn?.(generationId) ?? { semantics: "NONE" as const };
              }
            }),
        close: () => session.close()
      };
    }
  };
}

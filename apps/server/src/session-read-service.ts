import {
  SessionIdSchema,
  type InterviewProblem,
  type SessionId,
  type StoredSessionSummary
} from "../../../packages/domain/src/index.js";
import {
  replaySession,
  type SessionEvent,
  type SessionState
} from "../../../packages/events/src/index.js";
import {
  createProviderContextSpecFingerprintSync,
  evaluateInterviewSession
} from "../../../packages/interview-engine/src/index.js";
import {
  problemCatalog
} from "../../../packages/problems/src/index.js";
import {
  DEFAULT_REPLAY_BOUNDS,
  MAX_HISTORY_READ_SESSIONS,
  SessionEvaluationReadResponseSchema,
  SessionHistoryReadResponseSchema,
  SessionReplayReadResponseSchema,
  projectGroundedEvaluationReadModel,
  projectLongitudinalHistory,
  projectLongitudinalReadModel,
  projectSessionHistory,
  projectSessionReplayReadModel,
  type GroundedReadFailureReason,
  type SessionEvaluationReadResponse,
  type SessionHistoryReadResponse,
  type SessionReplayReadResponse
} from "../../../packages/replay/src/index.js";

const HISTORY_TOTAL_EVENT_BUDGET = 50_000;
const HISTORY_TIMELINE_ENTRY_LIMIT = 1_000;
const HISTORY_TEXT_PREVIEW_LIMIT = 512;

export interface SessionReadSource {
  readonly hasSession: (sessionId: SessionId) => boolean;
  readonly sessionCount: () => number;
  readonly listRecentSessionIds: (limit: number) => readonly SessionId[];
  readonly eventCount: (sessionId: SessionId) => number;
  readonly loadEvents: (sessionId: SessionId) => readonly SessionEvent[];
}

export interface ExactSessionProblemResolver {
  readonly resolve: (
    problemId: string,
    problemVersion: string
  ) => InterviewProblem | undefined;
}

export interface SessionReadServiceOptions {
  readonly source: SessionReadSource;
  readonly problemResolver?: ExactSessionProblemResolver;
}

export function createCatalogSessionProblemResolver(
  problems: readonly InterviewProblem[] = problemCatalog
): ExactSessionProblemResolver {
  const byIdentity = new Map(
    problems.map((problem) => [
      JSON.stringify([problem.id, problem.version]),
      problem
    ] as const)
  );
  return {
    resolve(problemId, problemVersion) {
      return byIdentity.get(JSON.stringify([problemId, problemVersion]));
    }
  };
}

interface LoadedAuthoritativeSession {
  readonly summary: StoredSessionSummary;
  readonly events: readonly SessionEvent[];
  readonly state: SessionState;
}

function safeReadFailure(
  type: "SESSION_EVALUATION_READ" | "SESSION_REPLAY_READ",
  sessionId: SessionId,
  reason: GroundedReadFailureReason
): SessionEvaluationReadResponse | SessionReplayReadResponse {
  const value = {
    protocolVersion: 1 as const,
    type,
    sessionId,
    available: false as const,
    reason
  };
  return type === "SESSION_EVALUATION_READ"
    ? SessionEvaluationReadResponseSchema.parse(value)
    : SessionReplayReadResponseSchema.parse(value);
}

function boundedIdentity(value: string | undefined): string | undefined {
  if (
    value === undefined
    || value.length === 0
    || value.length > 512
    || containsControlCharacter(value)
  ) {
    return undefined;
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function historyTruncation(total: number, retained: number): {
  readonly truncated: boolean;
  readonly limit: number;
  readonly remainingCount: number;
} {
  return {
    truncated: retained < total,
    limit: MAX_HISTORY_READ_SESSIONS,
    remainingCount: Math.max(0, total - retained)
  };
}

function summaryFromAuthoritativeEvents(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  state: Readonly<SessionState>
): StoredSessionSummary | undefined {
  const first = events[0];
  const last = events.at(-1);
  if (
    first === undefined
    || last === undefined
    || events.length !== state.sequence
    || first.sessionId !== sessionId
    || last.sessionId !== sessionId
  ) {
    return undefined;
  }

  return {
    sessionId,
    ...(state.problem === undefined
      ? {}
      : {
          problemId: state.problem.id,
          problemVersion: state.problem.version
        }),
    status: state.status,
    sequence: state.sequence,
    createdAt: first.wallTime,
    updatedAt: last.wallTime,
    eventCount: events.length
  };
}

export class SessionReadService {
  readonly #source: SessionReadSource;
  readonly #problemResolver: ExactSessionProblemResolver;

  public constructor(options: SessionReadServiceOptions) {
    this.#source = options.source;
    this.#problemResolver =
      options.problemResolver ?? createCatalogSessionProblemResolver();
  }

  public hasSession(sessionId: SessionId): boolean {
    return this.#source.hasSession(sessionId);
  }

  public readEvaluation(
    rawSessionId: SessionId
  ): SessionEvaluationReadResponse | null {
    const sessionId = SessionIdSchema.parse(rawSessionId);
    const known = this.sessionKnown(sessionId);
    if (known === false) return null;
    if (known === undefined) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionEvaluationReadResponse;
    }

    const expectedEventCount = this.readEventCount(sessionId);
    if (expectedEventCount === undefined) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionEvaluationReadResponse;
    }
    if (expectedEventCount > DEFAULT_REPLAY_BOUNDS.maxEvents) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "READ_LIMIT_EXCEEDED"
      ) as SessionEvaluationReadResponse;
    }

    const loaded = this.loadAuthoritative(sessionId, expectedEventCount);
    if (loaded === undefined) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionEvaluationReadResponse;
    }
    if (
      loaded.state.status !== "COMPLETED"
      && loaded.state.status !== "ARCHIVED"
    ) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "SESSION_NOT_TERMINAL"
      ) as SessionEvaluationReadResponse;
    }

    const evaluation = this.evaluateLoaded(loaded);
    if (!evaluation.available) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        evaluation.reason
      ) as SessionEvaluationReadResponse;
    }

    try {
      return SessionEvaluationReadResponseSchema.parse({
        protocolVersion: 1,
        type: "SESSION_EVALUATION_READ",
        sessionId,
        available: true,
        evaluation: projectGroundedEvaluationReadModel(evaluation.value)
      });
    } catch {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "EVALUATION_UNAVAILABLE"
      ) as SessionEvaluationReadResponse;
    }
  }

  public readReplay(rawSessionId: SessionId): SessionReplayReadResponse | null {
    const sessionId = SessionIdSchema.parse(rawSessionId);
    const known = this.sessionKnown(sessionId);
    if (known === false) return null;
    if (known === undefined) {
      return safeReadFailure(
        "SESSION_REPLAY_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionReplayReadResponse;
    }

    const expectedEventCount = this.readEventCount(sessionId);
    if (expectedEventCount === undefined) {
      return safeReadFailure(
        "SESSION_REPLAY_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionReplayReadResponse;
    }
    if (expectedEventCount > DEFAULT_REPLAY_BOUNDS.maxEvents) {
      return safeReadFailure(
        "SESSION_REPLAY_READ",
        sessionId,
        "READ_LIMIT_EXCEEDED"
      ) as SessionReplayReadResponse;
    }

    const loaded = this.loadAuthoritative(sessionId, expectedEventCount);
    if (loaded === undefined) {
      return safeReadFailure(
        "SESSION_REPLAY_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionReplayReadResponse;
    }

    let history: ReturnType<typeof projectSessionHistory>;
    try {
      history = projectSessionHistory(loaded.events, {
        bounds: {
          maxEvents: DEFAULT_REPLAY_BOUNDS.maxEvents,
          maxTimelineEntries: HISTORY_TIMELINE_ENTRY_LIMIT,
          maxSessions: DEFAULT_REPLAY_BOUNDS.maxSessions,
          maxTextPreviewChars: HISTORY_TEXT_PREVIEW_LIMIT,
          maxDisclosureIds: DEFAULT_REPLAY_BOUNDS.maxDisclosureIds,
          maxProvenanceIds: DEFAULT_REPLAY_BOUNDS.maxProvenanceIds,
          maxEvidenceHistoryEntries:
            DEFAULT_REPLAY_BOUNDS.maxEvidenceHistoryEntries,
          maxVerificationEntries: DEFAULT_REPLAY_BOUNDS.maxVerificationEntries,
          maxGenerationEntries: DEFAULT_REPLAY_BOUNDS.maxGenerationEntries
        }
      });
    } catch {
      return safeReadFailure(
        "SESSION_REPLAY_READ",
        sessionId,
        "REPLAY_UNAVAILABLE"
      ) as SessionReplayReadResponse;
    }

    try {
      return SessionReplayReadResponseSchema.parse({
        protocolVersion: 1,
        type: "SESSION_REPLAY_READ",
        sessionId,
        available: true,
        replay: projectSessionReplayReadModel(history)
      });
    } catch {
      return safeReadFailure(
        "SESSION_REPLAY_READ",
        sessionId,
        "REPLAY_UNAVAILABLE"
      ) as SessionReplayReadResponse;
    }
  }

  public readHistory(): SessionHistoryReadResponse {
    const inventory = this.readInventory();
    const cards: SessionHistoryReadResponse["sessions"][number][] = [];
    const longitudinalInputs: ReturnType<typeof projectSessionHistory>[] = [];
    let consumedEvents = 0;

    for (const sessionId of inventory.sessionIds) {
      if (boundedIdentity(sessionId) === undefined) continue;

      const expectedEventCount = this.readEventCount(sessionId);
      if (expectedEventCount === undefined || expectedEventCount === 0) {
        cards.push({
          sessionId,
          status: "UNKNOWN",
          readStatus: "UNAVAILABLE"
        });
        continue;
      }
      if (
        expectedEventCount > DEFAULT_REPLAY_BOUNDS.maxEvents
        || consumedEvents + expectedEventCount > HISTORY_TOTAL_EVENT_BUDGET
      ) {
        cards.push({
          sessionId,
          status: "UNKNOWN",
          eventCount: expectedEventCount,
          readStatus: "BUDGET_EXCLUDED"
        });
        continue;
      }
      consumedEvents += expectedEventCount;

      const loaded = this.loadAuthoritative(sessionId, expectedEventCount);
      if (loaded === undefined) {
        cards.push({
          sessionId,
          status: "UNKNOWN",
          eventCount: expectedEventCount,
          readStatus: "UNAVAILABLE"
        });
        continue;
      }

      const summary = loaded.summary;
      const safeProblemId = boundedIdentity(summary.problemId);
      const safeProblemVersion = boundedIdentity(summary.problemVersion);
      const cardBase = {
        sessionId: summary.sessionId,
        ...(safeProblemId === undefined ? {} : { problemId: safeProblemId }),
        ...(safeProblemVersion === undefined
          ? {}
          : { problemVersion: safeProblemVersion }),
        status: summary.status,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        eventCount: summary.eventCount
      };

      let initialHistory: ReturnType<typeof projectSessionHistory>;
      try {
        initialHistory = projectSessionHistory(loaded.events, {
          bounds: {
            maxTimelineEntries: HISTORY_TIMELINE_ENTRY_LIMIT
          }
        });
      } catch {
        cards.push({
          ...cardBase,
          readStatus: "UNAVAILABLE"
        });
        continue;
      }

      let history = initialHistory;
      if (
        initialHistory.currentStateAvailable
        && (loaded.state.status === "COMPLETED" || loaded.state.status === "ARCHIVED")
      ) {
        const evaluation = this.evaluateLoaded(loaded);
        if (evaluation.available) {
          try {
            history = projectSessionHistory(loaded.events, {
              bounds: {
                maxTimelineEntries: HISTORY_TIMELINE_ENTRY_LIMIT
              },
              evaluation: evaluation.value
            });
          } catch {
            history = initialHistory;
          }
        }
      }

      longitudinalInputs.push(history);
      cards.push({
        ...cardBase,
        readStatus: "AVAILABLE",
        replayComplete: history.timeline.complete,
        ...(history.evaluation === undefined
          ? {}
          : {
              evaluation: {
                compositeScore: history.evaluation.scores.compositeScore,
                compositeStatus: history.evaluation.composite.status,
                supportLevel: history.evaluation.composite.supportLevel
              }
            })
      });
    }

    let longitudinal;
    try {
      longitudinal = projectLongitudinalReadModel(
        projectLongitudinalHistory(longitudinalInputs, {
          bounds: {
            maxSessions: MAX_HISTORY_READ_SESSIONS
          }
        })
      );
    } catch {
      longitudinal = projectLongitudinalReadModel(
        projectLongitudinalHistory([], {
          bounds: {
            maxSessions: MAX_HISTORY_READ_SESSIONS
          }
        })
      );
    }

    return SessionHistoryReadResponseSchema.parse({
      protocolVersion: 1,
      type: "SESSION_HISTORY_READ",
      sessions: cards,
      sessionTruncation: historyTruncation(inventory.totalSessionCount, cards.length),
      longitudinal
    });
  }

  private sessionKnown(sessionId: SessionId): boolean | undefined {
    try {
      return this.#source.hasSession(sessionId);
    } catch {
      return undefined;
    }
  }

  private readEventCount(sessionId: SessionId): number | undefined {
    try {
      const count = this.#source.eventCount(sessionId);
      return nonnegativeSafeInteger(count) ? count : undefined;
    } catch {
      return undefined;
    }
  }

  private readInventory(): {
    readonly totalSessionCount: number;
    readonly sessionIds: readonly SessionId[];
  } {
    const totalSessionCount = this.#source.sessionCount();
    if (!nonnegativeSafeInteger(totalSessionCount)) {
      throw new Error("Authoritative session inventory count is invalid");
    }

    const sessionIds = this.#source.listRecentSessionIds(MAX_HISTORY_READ_SESSIONS);
    if (
      sessionIds.length > MAX_HISTORY_READ_SESSIONS
      || sessionIds.length > totalSessionCount
      || new Set(sessionIds).size !== sessionIds.length
    ) {
      throw new Error("Authoritative session inventory is invalid");
    }
    return { totalSessionCount, sessionIds: [...sessionIds] };
  }

  private loadAuthoritative(
    sessionId: SessionId,
    expectedEventCount: number
  ): LoadedAuthoritativeSession | undefined {
    try {
      const events = this.#source.loadEvents(sessionId);
      if (events.length !== expectedEventCount || events.length === 0) {
        return undefined;
      }
      const state = replaySession(sessionId, events);
      const summary = summaryFromAuthoritativeEvents(sessionId, events, state);
      if (summary === undefined) return undefined;
      return { summary, events, state };
    } catch {
      return undefined;
    }
  }

  private evaluateLoaded(
    loaded: LoadedAuthoritativeSession
  ):
    | {
        readonly available: true;
        readonly value: ReturnType<typeof evaluateInterviewSession>;
      }
    | {
        readonly available: false;
        readonly reason: GroundedReadFailureReason;
      } {
    const state = loaded.state;
    if (state.status !== "COMPLETED" && state.status !== "ARCHIVED") {
      return { available: false, reason: "SESSION_NOT_TERMINAL" };
    }
    if (state.problem === undefined) {
      return { available: false, reason: "EXACT_PROBLEM_UNAVAILABLE" };
    }

    const problem = this.#problemResolver.resolve(
      state.problem.id,
      state.problem.version
    );
    if (problem === undefined) {
      return { available: false, reason: "EXACT_PROBLEM_UNAVAILABLE" };
    }

    try {
      if (
        state.problem.providerContextSpecSha256 === undefined
        || problem.public.prompt !== state.problem.prompt
        || createProviderContextSpecFingerprintSync(problem)
          !== state.problem.providerContextSpecSha256
      ) {
        return { available: false, reason: "EXACT_PROBLEM_UNAVAILABLE" };
      }
    } catch {
      return { available: false, reason: "EXACT_PROBLEM_UNAVAILABLE" };
    }

    try {
      return {
        available: true,
        value: evaluateInterviewSession(state, problem)
      };
    } catch {
      return { available: false, reason: "EVALUATION_UNAVAILABLE" };
    }
  }
}

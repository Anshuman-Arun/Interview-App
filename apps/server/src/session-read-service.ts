import {
  SessionIdSchema,
  type InterviewProblem,
  type SessionId
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
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function historyTruncation(
  total: number,
  retained: number
): SessionHistoryReadResponse["sessionTruncation"] {
  return {
    truncated: retained < total,
    limit: MAX_HISTORY_READ_SESSIONS,
    remainingCount: Math.max(0, total - retained)
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
    const existence = this.safeHasSession(sessionId);
    if (existence === false) return null;
    if (existence === undefined) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionEvaluationReadResponse;
    }

    const eventCount = this.safeEventCount(sessionId);
    if (eventCount === undefined) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionEvaluationReadResponse;
    }
    if (eventCount > DEFAULT_REPLAY_BOUNDS.maxEvents) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "READ_LIMIT_EXCEEDED"
      ) as SessionEvaluationReadResponse;
    }

    const loaded = this.loadAuthoritative(sessionId, eventCount);
    if (loaded === undefined) {
      return safeReadFailure(
        "SESSION_EVALUATION_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionEvaluationReadResponse;
    }

    if (loaded.state.status !== "COMPLETED" && loaded.state.status !== "ARCHIVED") {
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
    const existence = this.safeHasSession(sessionId);
    if (existence === false) return null;
    if (existence === undefined) {
      return safeReadFailure(
        "SESSION_REPLAY_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionReplayReadResponse;
    }

    const eventCount = this.safeEventCount(sessionId);
    if (eventCount === undefined) {
      return safeReadFailure(
        "SESSION_REPLAY_READ",
        sessionId,
        "AUTHORITATIVE_HISTORY_UNAVAILABLE"
      ) as SessionReplayReadResponse;
    }
    if (eventCount > DEFAULT_REPLAY_BOUNDS.maxEvents) {
      return safeReadFailure(
        "SESSION_REPLAY_READ",
        sessionId,
        "READ_LIMIT_EXCEEDED"
      ) as SessionReplayReadResponse;
    }

    const loaded = this.loadAuthoritative(sessionId, eventCount);
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
    const recentSessionIds = this.#source.listRecentSessionIds(
      MAX_HISTORY_READ_SESSIONS
    );
    const totalSessions = this.#source.sessionCount();
    if (
      !Number.isSafeInteger(totalSessions)
      || totalSessions < recentSessionIds.length
    ) {
      throw new Error("Persisted session inventory is inconsistent");
    }

    const cards: SessionHistoryReadResponse["sessions"][number][] = [];
    const longitudinalInputs: ReturnType<typeof projectSessionHistory>[] = [];
    let consumedEvents = 0;

    for (const sessionId of recentSessionIds) {
      if (boundedIdentity(sessionId) === undefined) continue;

      const eventCount = this.safeEventCount(sessionId);
      if (eventCount === undefined) {
        cards.push({
          sessionId,
          status: "UNKNOWN",
          readStatus: "UNAVAILABLE"
        });
        continue;
      }

      if (
        eventCount > DEFAULT_REPLAY_BOUNDS.maxEvents
        || consumedEvents + eventCount > HISTORY_TOTAL_EVENT_BUDGET
      ) {
        cards.push({
          sessionId,
          status: "UNKNOWN",
          eventCount,
          readStatus: "BUDGET_EXCLUDED"
        });
        continue;
      }
      consumedEvents += eventCount;

      const loaded = this.loadAuthoritative(sessionId, eventCount);
      if (loaded === undefined) {
        cards.push({
          sessionId,
          status: "UNKNOWN",
          eventCount,
          readStatus: "UNAVAILABLE"
        });
        continue;
      }

      const firstEvent = loaded.events[0];
      const lastEvent = loaded.events.at(-1);
      if (firstEvent === undefined || lastEvent === undefined) {
        cards.push({
          sessionId,
          status: "UNKNOWN",
          eventCount,
          readStatus: "UNAVAILABLE"
        });
        continue;
      }

      const safeProblemId = boundedIdentity(loaded.state.problem?.id);
      const safeProblemVersion = boundedIdentity(loaded.state.problem?.version);
      const cardBase = {
        sessionId,
        ...(safeProblemId === undefined ? {} : { problemId: safeProblemId }),
        ...(safeProblemVersion === undefined
          ? {}
          : { problemVersion: safeProblemVersion }),
        status: loaded.state.status,
        createdAt: firstEvent.wallTime,
        updatedAt: lastEvent.wallTime,
        eventCount
      } as const;

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
        && (
          loaded.state.status === "COMPLETED"
          || loaded.state.status === "ARCHIVED"
        )
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
      sessionTruncation: historyTruncation(totalSessions, cards.length),
      longitudinal
    });
  }

  private safeHasSession(sessionId: SessionId): boolean | undefined {
    try {
      return this.#source.hasSession(sessionId);
    } catch {
      return undefined;
    }
  }

  private safeEventCount(sessionId: SessionId): number | undefined {
    try {
      const count = this.#source.eventCount(sessionId);
      return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
    } catch {
      return undefined;
    }
  }

  private loadAuthoritative(
    sessionId: SessionId,
    expectedEventCount: number
  ): LoadedAuthoritativeSession | undefined {
    try {
      const events = this.#source.loadEvents(sessionId);
      if (events.length !== expectedEventCount) return undefined;
      const state = replaySession(sessionId, events);
      if (state.sequence !== expectedEventCount) return undefined;
      return { events, state };
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

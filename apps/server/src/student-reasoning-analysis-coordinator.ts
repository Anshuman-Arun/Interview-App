import { createHash } from "node:crypto";
import {
  RequestIdSchema,
  type InputEpisodeId,
  type RequestId,
  type SessionId,
  type TurnId
} from "../../../packages/domain/src/index.js";
import {
  InterpretationCoordinator,
  createCommittedTurnFormalInterpretationRequest,
  type FormalInterpretationProvider,
  type InterpretationExecutionOutcome
} from "../../../packages/interview-engine/src/index.js";
import type { SessionState } from "../../../packages/events/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";
import {
  resolveOxfordFormalAnalysisProfile,
  type OxfordFormalAnalysisProfile
} from "./oxford-formal-analysis-catalog.js";
import {
  isOxfordFormalAnalysisSourceRelevant
} from "./oxford-formal-candidate-admission.js";

export const DEFAULT_STUDENT_REASONING_ANALYSIS_TIMEOUT_MS = 1_500 as const;
export const MAX_STUDENT_REASONING_ANALYSIS_IN_FLIGHT = 2 as const;
export const MAX_STUDENT_REASONING_ANALYSIS_SESSION_CONTEXTS = 128 as const;

export type StudentReasoningAnalysisOutcome =
  | {
      readonly status: "ANALYZED";
      readonly interpretation: InterpretationExecutionOutcome;
    }
  | {
      readonly status: "SKIPPED";
      readonly reason:
        | "UNSUPPORTED_PROBLEM"
        | "SOURCE_NOT_RELEVANT"
        | "EMPTY_SOURCE"
        | "STALE_SOURCE"
        | "RESOURCE_LIMIT"
        | "TIME_LIMIT"
        | "SHUTDOWN"
        | "ANALYSIS_FAILURE";
    };

export class UnavailableFormalInterpretationProvider implements FormalInterpretationProvider {
  public interpret(request: Parameters<FormalInterpretationProvider["interpret"]>[0]): Promise<unknown> {
    return Promise.resolve({
      protocolVersion: 1,
      requestId: request.requestId,
      candidates: []
    });
  }
}

interface SessionAnalysisContext {
  readonly profileKey: string;
  readonly coordinator: InterpretationCoordinator;
  readonly active: Map<RequestId, {
    readonly turnId: TurnId;
    readonly inputEpisodeId: InputEpisodeId;
  }>;
}

export class StudentReasoningAnalysisCoordinator {
  private readonly contexts = new Map<SessionId, SessionAnalysisContext>();
  private shuttingDown = false;

  public constructor(
    private readonly sessions: SessionRecoveryCoordinator,
    private readonly provider: FormalInterpretationProvider = new UnavailableFormalInterpretationProvider(),
    private readonly timeoutMs: number = DEFAULT_STUDENT_REASONING_ANALYSIS_TIMEOUT_MS
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("Student reasoning analysis timeout must be a bounded positive integer");
    }
  }

  public async analyze(input: {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
    readonly inputEpisodeId: InputEpisodeId;
  }): Promise<StudentReasoningAnalysisOutcome> {
    if (this.shuttingDown) return { status: "SKIPPED", reason: "SHUTDOWN" };

    const writer = this.sessions.getWriter(input.sessionId);
    const state = writer.getState();
    const turn = state.turns[input.turnId];
    if (
      !state.started
      || state.status !== "ACTIVE"
      || (
        state.configuration !== undefined
        && state.configuration.mode !== "OXFORD_MATHEMATICS"
      )
      || state.problem === undefined
      || turn === undefined
      || turn.inputEpisodeId !== input.inputEpisodeId
      || state.lastCommittedInputSequence === undefined
      || turn.committedSequence !== state.lastCommittedInputSequence
    ) {
      return { status: "SKIPPED", reason: "STALE_SOURCE" };
    }
    if (turn.studentText.length === 0) return { status: "SKIPPED", reason: "EMPTY_SOURCE" };

    const profile = resolveOxfordFormalAnalysisProfile(state.problem);
    if (profile === undefined) return { status: "SKIPPED", reason: "UNSUPPORTED_PROBLEM" };
    if (!isOxfordFormalAnalysisSourceRelevant(profile, turn.studentText)) {
      return { status: "SKIPPED", reason: "SOURCE_NOT_RELEVANT" };
    }

    let context: SessionAnalysisContext | undefined;
    try {
      context = this.contextFor(input.sessionId, profile);
    } catch {
      return { status: "SKIPPED", reason: "ANALYSIS_FAILURE" };
    }
    if (context === undefined || context.active.size >= MAX_STUDENT_REASONING_ANALYSIS_IN_FLIGHT) {
      return { status: "SKIPPED", reason: "RESOURCE_LIMIT" };
    }

    let request;
    try {
      const requestId = analysisRequestId(input.sessionId, input.turnId, input.inputEpisodeId, state, profile);
      request = createCommittedTurnFormalInterpretationRequest(writer, {
        inputEpisodeId: input.inputEpisodeId,
        turnId: input.turnId,
        target: profile.target,
        allowedProtocols: profile.allowedProtocols,
        requestId
      });
    } catch {
      return { status: "SKIPPED", reason: "STALE_SOURCE" };
    }

    context.active.set(request.requestId, {
      turnId: input.turnId,
      inputEpisodeId: input.inputEpisodeId
    });

    const execution = context.coordinator.interpretAndVerify(request);
    const trackedExecution = execution.finally(() => {
      context.active.delete(request.requestId);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeLimit = new Promise<StudentReasoningAnalysisOutcome>((resolve) => {
      timeout = setTimeout(() => {
        this.abandon(context, request.requestId);
        resolve({ status: "SKIPPED", reason: "TIME_LIMIT" });
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        trackedExecution.then((interpretation) => ({
          status: "ANALYZED" as const,
          interpretation
        })).catch(() => ({
          status: "SKIPPED" as const,
          reason: "ANALYSIS_FAILURE" as const
        })),
        timeLimit
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      void trackedExecution.catch(() => undefined);
    }
  }

  public supersedeStaleRequests(sessionId: SessionId): void {
    const context = this.contexts.get(sessionId);
    if (context === undefined) return;

    const state = this.sessions.getWriter(sessionId).getState();
    const latest = state.lastCommittedInputSequence;
    for (const [requestId, source] of context.active) {
      const turn = state.turns[source.turnId];
      if (
        state.status !== "ACTIVE"
        || turn === undefined
        || turn.inputEpisodeId !== source.inputEpisodeId
        || latest === undefined
        || turn.committedSequence !== latest
      ) {
        this.abandon(context, requestId);
      }
    }
  }

  public shutdown(): void {
    this.shuttingDown = true;
    for (const context of this.contexts.values()) {
      for (const requestId of context.active.keys()) {
        this.abandon(context, requestId);
      }
    }
  }

  public resume(): void {
    this.shuttingDown = false;
  }

  private abandon(context: SessionAnalysisContext, requestId: RequestId): void {
    context.coordinator.abandon(requestId);
    try {
      const cancel: unknown = Reflect.get(this.provider, "cancel");
      if (typeof cancel !== "function") return;
      const result: unknown = Reflect.apply(cancel, this.provider, [requestId]);
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Physical provider cancellation is best-effort only. A malformed or
      // failing optional cancellation hook must never escape timeout,
      // supersession, or shutdown and cannot change authoritative admission.
    }
  }

  private contextFor(
    sessionId: SessionId,
    profile: OxfordFormalAnalysisProfile
  ): SessionAnalysisContext | undefined {
    const profileKey = profile.problemId + "\u0000" + profile.problemVersion;
    const existing = this.contexts.get(sessionId);
    if (existing !== undefined) {
      if (existing.profileKey !== profileKey) {
        throw new Error("Session formal-analysis profile changed unexpectedly");
      }
      // Refresh insertion order so bounded eviction behaves as an LRU over
      // idle per-session analysis contexts.
      this.contexts.delete(sessionId);
      this.contexts.set(sessionId, existing);
      return existing;
    }

    while (this.contexts.size >= MAX_STUDENT_REASONING_ANALYSIS_SESSION_CONTEXTS) {
      const evictable = [...this.contexts.entries()].find(([, context]) =>
        context.active.size === 0 && !context.coordinator.hasActiveWork()
      );
      if (evictable === undefined) return undefined;
      this.contexts.delete(evictable[0]);
    }

    const created: SessionAnalysisContext = {
      profileKey,
      coordinator: new InterpretationCoordinator(
        this.sessions.getWriter(sessionId),
        this.provider,
        profile.scopes,
        { maxInFlight: MAX_STUDENT_REASONING_ANALYSIS_IN_FLIGHT }
      ),
      active: new Map()
    };
    this.contexts.set(sessionId, created);
    return created;
  }
}

function analysisRequestId(
  sessionId: SessionId,
  turnId: TurnId,
  inputEpisodeId: InputEpisodeId,
  state: Readonly<SessionState>,
  profile: OxfordFormalAnalysisProfile
): RequestId {
  const basis = [
    sessionId,
    inputEpisodeId,
    turnId,
    state.contextEpoch,
    state.lastCommittedInputSequence,
    state.transcriptRevision,
    state.problemStateRevision,
    state.policyRevision,
    profile.problemId,
    profile.problemVersion,
    profile.target.subject.kind === "CLAIM"
      ? "CLAIM:" + profile.target.subject.claimId
      : profile.target.subject.kind === "MILESTONE"
        ? "MILESTONE:" + profile.target.subject.milestoneId
        : profile.target.subject.kind,
    ...profile.allowedProtocols.flatMap((protocol) => [protocol.protocol, protocol.version])
  ];
  const digest = createHash("sha256").update(JSON.stringify(basis)).digest("hex");
  return RequestIdSchema.parse("formal_analysis_" + digest);
}
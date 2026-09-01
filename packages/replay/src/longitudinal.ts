import type { SessionId } from "../../domain/src/index.js";
import {
  resolveReplayBounds,
  truncationInfo,
  type ReplayBounds
} from "./bounds.js";
import { ReplayProjectionError } from "./provenance.js";
import type {
  LongitudinalEvaluationStatistics,
  LongitudinalEvidencePattern,
  LongitudinalHistoryProjection,
  LongitudinalImprovementRecord,
  LongitudinalRepeatedProblem,
  ReplayEvaluationSummary,
  SessionHistoryProjection
} from "./types.js";

export interface LongitudinalHistoryOptions {
  readonly bounds?: Partial<ReplayBounds>;
}

function sessionSortKey(session: SessionHistoryProjection): string {
  return session.lifecycle.startedAt
    ?? session.lifecycle.createdAt
    ?? "";
}

function compareSessions(
  left: SessionHistoryProjection,
  right: SessionHistoryProjection
): number {
  const timeOrder = sessionSortKey(left).localeCompare(sessionSortKey(right));
  if (timeOrder !== 0) return timeOrder;
  return (left.sessionId ?? "").localeCompare(right.sessionId ?? "");
}

function exactProblemKey(session: SessionHistoryProjection): string | undefined {
  if (session.problem === undefined) return undefined;
  return `${session.problem.problemId}\u0000${session.problem.problemVersion}`;
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[midpoint] ?? 0;
  const left = ordered[midpoint - 1] ?? 0;
  const right = ordered[midpoint] ?? 0;
  return (left + right) / 2;
}

function aggregateScores(
  evaluations: readonly ReplayEvaluationSummary[]
): {
  readonly average: ReplayEvaluationSummary["scores"];
  readonly median: ReplayEvaluationSummary["scores"];
} {
  const dimensions = {
    technicalCorrectness: evaluations.map((entry) => entry.scores.technicalCorrectness),
    rigor: evaluations.map((entry) => entry.scores.rigor),
    independence: evaluations.map((entry) => entry.scores.independence),
    communication: evaluations.map((entry) => entry.scores.communication),
    hintResponsiveness: evaluations.map((entry) => entry.scores.hintResponsiveness),
    errorRecovery: evaluations.map((entry) => entry.scores.errorRecovery),
    compositeScore: evaluations.map((entry) => entry.scores.compositeScore)
  };
  return {
    average: {
      technicalCorrectness: average(dimensions.technicalCorrectness),
      rigor: average(dimensions.rigor),
      independence: average(dimensions.independence),
      communication: average(dimensions.communication),
      hintResponsiveness: average(dimensions.hintResponsiveness),
      errorRecovery: average(dimensions.errorRecovery),
      compositeScore: average(dimensions.compositeScore)
    },
    median: {
      technicalCorrectness: median(dimensions.technicalCorrectness),
      rigor: median(dimensions.rigor),
      independence: median(dimensions.independence),
      communication: median(dimensions.communication),
      hintResponsiveness: median(dimensions.hintResponsiveness),
      errorRecovery: median(dimensions.errorRecovery),
      compositeScore: median(dimensions.compositeScore)
    }
  };
}

export function projectLongitudinalHistory(
  sessionSummaries: readonly SessionHistoryProjection[],
  options: LongitudinalHistoryOptions = {}
): LongitudinalHistoryProjection {
  const bounds = resolveReplayBounds(options.bounds);
  const seenSessionIds = new Set<SessionId>();
  for (const session of sessionSummaries) {
    if (session.sessionId === null) continue;
    if (seenSessionIds.has(session.sessionId)) {
      throw new ReplayProjectionError("DUPLICATE_SESSION");
    }
    seenSessionIds.add(session.sessionId);
  }

  const ordered = [...sessionSummaries].sort(compareSessions);
  const included = ordered.slice(0, bounds.maxSessions);
  const problemGroups = new Map<string, SessionHistoryProjection[]>();
  const evidenceGroups = new Map<string, {
    sessionIds: Set<string>;
    values: Map<string, number>;
  }>();

  for (const session of included) {
    const problemKey = exactProblemKey(session);
    if (problemKey !== undefined) {
      const group = problemGroups.get(problemKey) ?? [];
      group.push(session);
      problemGroups.set(problemKey, group);
    }

    if (!session.currentStateAvailable) continue;
    for (const evidence of session.currentEvidence) {
      const group = evidenceGroups.get(evidence.keyString) ?? {
        sessionIds: new Set<string>(),
        values: new Map<string, number>()
      };
      const sessionIdentity = session.sessionId ?? `anonymous:${String(session.knownThroughSequence)}`;
      if (!group.sessionIds.has(sessionIdentity)) {
        group.sessionIds.add(sessionIdentity);
        group.values.set(
          evidence.value.value,
          (group.values.get(evidence.value.value) ?? 0) + 1
        );
      }
      evidenceGroups.set(evidence.keyString, group);
    }
  }

  const repeatedProblems: LongitudinalRepeatedProblem[] = [];
  const evaluationStatistics: LongitudinalEvaluationStatistics[] = [];
  const improvement: LongitudinalImprovementRecord[] = [];

  for (const sessions of problemGroups.values()) {
    const first = sessions[0];
    if (first?.problem === undefined) continue;
    const exact = [...sessions].sort(compareSessions);

    if (exact.length > 1) {
      repeatedProblems.push({
        problemId: first.problem.problemId,
        problemVersion: first.problem.problemVersion,
        attemptCount: exact.length
      });
    }

    const evaluated = exact.filter((session) =>
      session.evaluation !== undefined
      && session.sessionId !== null
    );
    if (evaluated.length > 0) {
      const evaluations = evaluated.flatMap((session) =>
        session.evaluation === undefined ? [] : [session.evaluation]
      );
      const scores = aggregateScores(evaluations);
      evaluationStatistics.push({
        problemId: first.problem.problemId,
        problemVersion: first.problem.problemVersion,
        sessionCount: evaluations.length,
        average: scores.average,
        median: scores.median
      });

      for (let index = 1; index < evaluated.length; index += 1) {
        const previous = evaluated[index - 1];
        const current = evaluated[index];
        if (
          previous?.sessionId === null
          || current?.sessionId === null
          || previous?.evaluation === undefined
          || current?.evaluation === undefined
        ) {
          continue;
        }
        improvement.push({
          problemId: first.problem.problemId,
          problemVersion: first.problem.problemVersion,
          fromSessionId: previous.sessionId,
          toSessionId: current.sessionId,
          compositeScoreDelta:
            current.evaluation.scores.compositeScore
            - previous.evaluation.scores.compositeScore
        });
      }
    }
  }

  const evidencePatterns: LongitudinalEvidencePattern[] = [...evidenceGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([keyString, group]) => ({
      keyString,
      sessionCount: group.sessionIds.size,
      observedValues: Object.fromEntries(
        [...group.values.entries()].sort(([left], [right]) => left.localeCompare(right))
      )
    }));

  repeatedProblems.sort((left, right) =>
    left.problemId.localeCompare(right.problemId)
    || left.problemVersion.localeCompare(right.problemVersion)
  );
  evaluationStatistics.sort((left, right) =>
    left.problemId.localeCompare(right.problemId)
    || left.problemVersion.localeCompare(right.problemVersion)
  );
  improvement.sort((left, right) =>
    left.problemId.localeCompare(right.problemId)
    || left.problemVersion.localeCompare(right.problemVersion)
    || left.fromSessionId.localeCompare(right.fromSessionId)
    || left.toSessionId.localeCompare(right.toSessionId)
  );

  const exactProblems = new Set(
    included.flatMap((session) => {
      const key = exactProblemKey(session);
      return key === undefined ? [] : [key];
    })
  );

  return {
    totalInputSessions: sessionSummaries.length,
    includedSessionCount: included.length,
    sessionTruncation: truncationInfo(sessionSummaries.length, bounds.maxSessions),
    completedSessions: included.filter((session) => session.lifecycle.completed).length,
    problemsAttempted: exactProblems.size,
    sessionsWithAssistance: included.filter((session) =>
      session.counts.exposedInterventions > 0
      || session.counts.possiblyExposedInterventions > 0
    ).length,
    totalExposedInterventions: included.reduce(
      (sum, session) => sum + session.counts.exposedInterventions,
      0
    ),
    totalPossiblyExposedInterventions: included.reduce(
      (sum, session) => sum + session.counts.possiblyExposedInterventions,
      0
    ),
    repeatedProblems,
    evaluationStatistics,
    improvement,
    evidencePatterns,
    excludedIncompleteSessions: included.filter((session) => !session.currentStateAvailable).length,
    comparability: {
      problems: "EXACT_PROBLEM_ID_AND_VERSION",
      evidence: "EXACT_EVIDENCE_KEY_ONLY",
      skillTaxonomyAvailable: false
    },
    bounds
  };
}

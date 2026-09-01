import { z } from "zod";
import {
  EvidenceKeySchema,
  EvidenceRatingSchema,
  EventIdSchema,
  SessionIdSchema,
  evidenceKeyToString,
  type EvidenceKey,
  type SessionId
} from "../../domain/src/index.js";
import {
  resolveReplayBounds,
  truncationInfo,
  type ReplayBounds
} from "./bounds.js";
import {
  replayEvidenceIdentity,
  replayProblemIdentity
} from "./identity.js";
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

const SafeNonnegativeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);
const SafePositiveIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "Expected a positive safe integer" }
);

const TruncationSchema = z.object({
  truncated: z.boolean(),
  limit: SafePositiveIntegerSchema,
  remainingCount: SafeNonnegativeIntegerSchema
}).strict().superRefine((value, context) => {
  if (
    (value.truncated && value.remainingCount === 0)
    || (!value.truncated && value.remainingCount !== 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Truncation metadata is internally inconsistent"
    });
  }
});

const ReplayEvidenceValueInputSchema = z.object({
  value: EvidenceRatingSchema,
  inferenceConfidence: z.number().min(0).max(1),
  evidenceEventIds: z.array(EventIdSchema),
  evidenceEventIdsTruncation: TruncationSchema,
  lastUpdatedSequence: SafePositiveIntegerSchema
}).strict();

const ScoreSchema = z.number().min(0).max(100);
const EvaluationInputSchema = z.object({
  sessionId: SessionIdSchema,
  problemId: z.string().min(1),
  problemVersion: z.string().min(1),
  evaluatedAt: z.string().min(1),
  scores: z.object({
    technicalCorrectness: ScoreSchema,
    rigor: ScoreSchema,
    independence: ScoreSchema,
    communication: ScoreSchema,
    hintResponsiveness: ScoreSchema,
    errorRecovery: ScoreSchema,
    compositeScore: ScoreSchema
  }).strict(),
  milestoneCount: SafeNonnegativeIntegerSchema,
  achievedMilestoneCount: SafeNonnegativeIntegerSchema,
  unassistedMilestoneCount: SafeNonnegativeIntegerSchema,
  assistedMilestoneCount: SafeNonnegativeIntegerSchema,
  disclosedInterventionCount: SafeNonnegativeIntegerSchema,
  totalTurns: SafeNonnegativeIntegerSchema
}).strict();

const LongitudinalSessionInputSchema = z.object({
  sessionId: SessionIdSchema,
  problem: z.object({
    problemId: z.string().min(1),
    problemVersion: z.string().min(1)
  }).strict().optional(),
  lifecycle: z.object({
    startedAt: z.iso.datetime().optional(),
    completed: z.boolean().nullable()
  }).strict(),
  counts: z.object({
    exposedInterventions: SafeNonnegativeIntegerSchema,
    possiblyExposedInterventions: SafeNonnegativeIntegerSchema
  }).strict(),
  currentStateAvailable: z.boolean(),
  currentEvidenceTruncation: TruncationSchema,
  currentEvidence: z.array(z.object({
    keyString: z.string(),
    key: EvidenceKeySchema,
    value: ReplayEvidenceValueInputSchema,
    evidenceEventId: EventIdSchema
  }).strict()),
  evaluation: EvaluationInputSchema.optional()
}).strip();

type LongitudinalSessionInput = z.infer<typeof LongitudinalSessionInputSchema>;

function parseSessionSummaries(
  values: readonly unknown[]
): readonly LongitudinalSessionInput[] {
  if (!Array.isArray(values)) throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");

  const parsed: LongitudinalSessionInput[] = [];
  for (const value of values) {
    const result = LongitudinalSessionInputSchema.safeParse(value);
    if (!result.success) throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");

    const session = result.data;
    if (
      session.evaluation !== undefined
      && (
        session.problem === undefined
        || session.evaluation.sessionId !== session.sessionId
        || session.evaluation.problemId !== session.problem.problemId
        || session.evaluation.problemVersion !== session.problem.problemVersion
      )
    ) {
      throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
    }

    for (const evidence of session.currentEvidence) {
      if (
        session.problem === undefined
        || evidence.key.problemId !== session.problem.problemId
        || evidence.keyString !== evidenceKeyToString(evidence.key)
      ) {
        throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
      }
    }

    parsed.push(session);
  }
  return parsed;
}

function sessionSortKey(session: LongitudinalSessionInput): string {
  return session.lifecycle.startedAt ?? "";
}

function compareSessions(
  left: LongitudinalSessionInput,
  right: LongitudinalSessionInput
): number {
  const timeOrder = sessionSortKey(left).localeCompare(sessionSortKey(right));
  if (timeOrder !== 0) return timeOrder;
  return left.sessionId.localeCompare(right.sessionId);
}

function exactProblemKey(session: LongitudinalSessionInput): string | undefined {
  if (session.problem === undefined) return undefined;
  return replayProblemIdentity(session.problem.problemId, session.problem.problemVersion);
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
  sessionSummaries: readonly unknown[],
  options: LongitudinalHistoryOptions = {}
): LongitudinalHistoryProjection {
  const bounds = resolveReplayBounds(options.bounds);
  const parsedSessions = parseSessionSummaries(sessionSummaries);
  const seenSessionIds = new Set<SessionId>();
  for (const session of parsedSessions) {
    if (seenSessionIds.has(session.sessionId)) {
      throw new ReplayProjectionError("DUPLICATE_SESSION");
    }
    seenSessionIds.add(session.sessionId);
  }

  const ordered = [...parsedSessions].sort(compareSessions);
  const included = ordered.slice(0, bounds.maxSessions);
  const problemGroups = new Map<string, LongitudinalSessionInput[]>();
  const evidenceGroups = new Map<string, {
    key: EvidenceKey;
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

    if (
      !session.currentStateAvailable
      || session.currentEvidenceTruncation.truncated
    ) continue;

    for (const evidence of session.currentEvidence) {
      const identity = replayEvidenceIdentity(evidence.key);
      const group = evidenceGroups.get(identity) ?? {
        key: evidence.key,
        sessionIds: new Set<string>(),
        values: new Map<string, number>()
      };
      if (!group.sessionIds.has(session.sessionId)) {
        group.sessionIds.add(session.sessionId);
        group.values.set(
          evidence.value.value,
          (group.values.get(evidence.value.value) ?? 0) + 1
        );
      }
      evidenceGroups.set(identity, group);
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

    const evaluated = exact.filter((session): session is LongitudinalSessionInput & {
      readonly evaluation: z.infer<typeof EvaluationInputSchema>;
    } => session.evaluation !== undefined);

    if (evaluated.length > 0) {
      const evaluations: ReplayEvaluationSummary[] = evaluated.map((session) => session.evaluation);
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
        if (previous === undefined || current === undefined) continue;
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
    .map(([, group]) => ({
      key: group.key,
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

  const assistanceEligible = included.filter((session) => session.currentStateAvailable);
  const evidenceExcluded = included.filter((session) =>
    !session.currentStateAvailable
    || session.currentEvidenceTruncation.truncated
  ).length;

  return {
    totalInputSessions: sessionSummaries.length,
    includedSessionCount: included.length,
    sessionTruncation: truncationInfo(sessionSummaries.length, bounds.maxSessions),
    completedSessions: included.filter((session) => session.lifecycle.completed === true).length,
    sessionsWithUnknownCompletion: included.filter((session) => session.lifecycle.completed === null).length,
    problemsAttempted: exactProblems.size,
    assistanceEligibleSessionCount: assistanceEligible.length,
    sessionsWithAssistance: assistanceEligible.filter((session) =>
      session.counts.exposedInterventions > 0
      || session.counts.possiblyExposedInterventions > 0
    ).length,
    totalExposedInterventions: assistanceEligible.reduce(
      (sum, session) => sum + session.counts.exposedInterventions,
      0
    ),
    totalPossiblyExposedInterventions: assistanceEligible.reduce(
      (sum, session) => sum + session.counts.possiblyExposedInterventions,
      0
    ),
    sessionsExcludedFromAssistanceStatistics: included.length - assistanceEligible.length,
    repeatedProblems,
    evaluationStatistics,
    improvement,
    evidencePatterns,
    sessionsExcludedFromEvidencePatterns: evidenceExcluded,
    sessionsWithIncompleteProjection: included.filter((session) => !session.currentStateAvailable).length,
    comparability: {
      problems: "EXACT_PROBLEM_ID_AND_VERSION",
      evidence: "EXACT_EVIDENCE_KEY_ONLY",
      skillTaxonomyAvailable: false
    },
    bounds
  };
}

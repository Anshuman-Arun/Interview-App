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
  DEFAULT_REPLAY_BOUNDS,
  MAX_REPLAY_IDENTIFIER_CHARS,
  resolveReplayBounds,
  truncationInfo,
  type ReplayBounds
} from "./bounds.js";
import {
  compareReplayStrings,
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
  ReplayEvaluationSummary
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
  evidenceEventIds: z.array(EventIdSchema).max(DEFAULT_REPLAY_BOUNDS.maxProvenanceIds),
  evidenceEventIdsTruncation: TruncationSchema,
  lastUpdatedSequence: SafePositiveIntegerSchema
}).strict();

const ScoreSchema = z.number().min(0).max(100);
const NullableScoreSchema = ScoreSchema.nullable();
const SupportLevelSchema = z.enum(["STRONG", "MODERATE", "WEAK", "INSUFFICIENT"]);
const CompositeDimensionSchema = z.enum([
  "technicalCorrectness",
  "rigor",
  "independence",
  "communication",
  "errorRecovery"
]);
const EvaluationInputSchema = z.object({
  sessionId: SessionIdSchema,
  problemId: z.string().min(1),
  problemVersion: z.string().min(1),
  evaluatedAt: z.iso.datetime(),
  lifecycle: z.object({
    sessionStatus: z.enum(["COMPLETED", "ARCHIVED"]),
    completionState: z.enum([
      "COMPLETED",
      "ARCHIVED_INCOMPLETE",
      "ARCHIVED_COMPLETED"
    ])
  }).strict(),
  scores: z.object({
    technicalCorrectness: NullableScoreSchema,
    rigor: NullableScoreSchema,
    independence: NullableScoreSchema,
    communication: NullableScoreSchema,
    hintResponsiveness: NullableScoreSchema,
    errorRecovery: NullableScoreSchema,
    compositeScore: NullableScoreSchema
  }).strict(),
  support: z.object({
    technicalCorrectness: SupportLevelSchema,
    rigor: SupportLevelSchema,
    independence: SupportLevelSchema,
    communication: SupportLevelSchema,
    hintResponsiveness: SupportLevelSchema,
    errorRecovery: SupportLevelSchema
  }).strict(),
  composite: z.object({
    status: z.enum(["FULL", "PARTIAL", "NOT_SCORED"]),
    supportLevel: SupportLevelSchema,
    includedDimensions: z.array(CompositeDimensionSchema).max(5),
    omittedDimensions: z.array(CompositeDimensionSchema).max(5)
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
    status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED", "UNKNOWN"]),
    startedAt: z.iso.datetime().optional(),
    completed: z.boolean().nullable(),
    archived: z.boolean().nullable(),
    historyComplete: z.boolean()
  }),
  counts: z.object({
    turns: SafeNonnegativeIntegerSchema,
    deliveries: SafeNonnegativeIntegerSchema,
    exposedInterventions: SafeNonnegativeIntegerSchema,
    possiblyExposedInterventions: SafeNonnegativeIntegerSchema,
    cancelledInterventions: SafeNonnegativeIntegerSchema,
    inFlightDeliveries: SafeNonnegativeIntegerSchema.optional()
  }),
  countsComplete: z.boolean(),
  currentStateAvailable: z.boolean(),
  validatedThroughSequence: SafeNonnegativeIntegerSchema,
  observedThroughSequence: SafeNonnegativeIntegerSchema,
  totalEventCount: SafeNonnegativeIntegerSchema,
  currentEvidenceTruncation: TruncationSchema,
  currentEvidence: z.array(z.object({
    keyString: z.string(),
    key: EvidenceKeySchema,
    value: ReplayEvidenceValueInputSchema,
    evidenceEventId: EventIdSchema
  }).strict()).max(DEFAULT_REPLAY_BOUNDS.maxEvidenceHistoryEntries),
  evaluation: EvaluationInputSchema.optional()
});

type LongitudinalSessionInput = z.infer<typeof LongitudinalSessionInputSchema>;

const LongitudinalSessionEnvelopeSchema = z.object({
  sessionId: SessionIdSchema,
  lifecycle: z.object({
    startedAt: z.iso.datetime().optional()
  })
});
type LongitudinalSessionEnvelope = z.infer<typeof LongitudinalSessionEnvelopeSchema>;

interface SelectedSessionInput {
  readonly raw: unknown;
  readonly envelope: LongitudinalSessionEnvelope;
}


function identifierWithinReplayLimit(value: string): boolean {
  return value.length <= MAX_REPLAY_IDENTIFIER_CHARS;
}

function evidenceKeyIdentifiersWithinReplayLimit(key: EvidenceKey): boolean {
  if (!identifierWithinReplayLimit(key.problemId)) return false;
  switch (key.subject.kind) {
    case "CLAIM":
      return identifierWithinReplayLimit(key.subject.claimId);
    case "MILESTONE":
      return identifierWithinReplayLimit(key.subject.milestoneId);
    case "SKILL":
      return identifierWithinReplayLimit(key.subject.skillId);
    case "APPROACH":
      return identifierWithinReplayLimit(key.subject.approachId);
  }
}

function truncationMatchesLength(
  truncation: z.infer<typeof TruncationSchema>,
  length: number
): boolean {
  return truncation.truncated
    ? length === truncation.limit
    : length <= truncation.limit;
}

function parseSelectedSessionSummary(
  value: unknown,
  expectedEnvelope: LongitudinalSessionEnvelope
): LongitudinalSessionInput {
  let result: ReturnType<typeof LongitudinalSessionInputSchema.safeParse>;
  try {
    result = LongitudinalSessionInputSchema.safeParse(value);
  } catch {
    throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
  }
  if (!result.success) throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");

  const session = result.data;
  if (
    session.sessionId !== expectedEnvelope.sessionId
    || session.lifecycle.startedAt !== expectedEnvelope.lifecycle.startedAt
    || !identifierWithinReplayLimit(session.sessionId)
    || (session.problem !== undefined
      && (
        !identifierWithinReplayLimit(session.problem.problemId)
        || !identifierWithinReplayLimit(session.problem.problemVersion)
      ))
    || session.currentStateAvailable !== session.lifecycle.historyComplete
    || session.currentStateAvailable !== session.countsComplete
    || (session.lifecycle.historyComplete
      && (
        session.lifecycle.completed === null
        || session.lifecycle.archived === null
      ))
    || (session.currentStateAvailable
      && (
        session.problem === undefined
        || session.lifecycle.startedAt === undefined
        || session.lifecycle.status === "UNKNOWN"
        || session.counts.inFlightDeliveries === undefined
      ))
    || (!session.currentStateAvailable && session.lifecycle.status !== "UNKNOWN")
    || (session.lifecycle.status === "ACTIVE"
      && (
        session.lifecycle.completed !== false
        || session.lifecycle.archived !== false
      ))
    || (session.lifecycle.status === "COMPLETED"
      && (
        session.lifecycle.completed !== true
        || session.lifecycle.archived !== false
      ))
    || (session.lifecycle.status === "ARCHIVED"
      && session.lifecycle.archived !== true)
    || session.validatedThroughSequence > session.observedThroughSequence
    || session.observedThroughSequence > session.totalEventCount
    || (session.currentStateAvailable
      && (
        session.validatedThroughSequence !== session.observedThroughSequence
        || session.observedThroughSequence !== session.totalEventCount
        || session.totalEventCount > DEFAULT_REPLAY_BOUNDS.maxEvents
        || session.counts.turns > session.totalEventCount
        || session.counts.deliveries > session.totalEventCount
        || session.counts.exposedInterventions
          + session.counts.possiblyExposedInterventions
          + session.counts.cancelledInterventions
          > session.counts.deliveries
        || session.counts.inFlightDeliveries === undefined
        || session.counts.inFlightDeliveries > session.counts.deliveries
        || ((session.lifecycle.status === "COMPLETED"
          || session.lifecycle.status === "ARCHIVED")
          && session.counts.inFlightDeliveries !== 0)
        || session.currentEvidence.length > session.totalEventCount
      ))
    || session.currentEvidenceTruncation.limit
      > DEFAULT_REPLAY_BOUNDS.maxEvidenceHistoryEntries
    || (!session.currentStateAvailable && session.currentEvidence.length !== 0)
    || !truncationMatchesLength(
      session.currentEvidenceTruncation,
      session.currentEvidence.length
    )
  ) {
    throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
  }

  if (session.evaluation !== undefined) {
    const evaluation = session.evaluation;
    const expectedEvaluationLifecycle =
      session.lifecycle.status === "COMPLETED"
        ? {
            sessionStatus: "COMPLETED" as const,
            completionState: "COMPLETED" as const
          }
        : session.lifecycle.status === "ARCHIVED"
          ? {
              sessionStatus: "ARCHIVED" as const,
              completionState: session.lifecycle.completed === true
                ? "ARCHIVED_COMPLETED" as const
                : "ARCHIVED_INCOMPLETE" as const
            }
          : undefined;
    const scoreSupportPairs = [
      [evaluation.scores.technicalCorrectness, evaluation.support.technicalCorrectness],
      [evaluation.scores.rigor, evaluation.support.rigor],
      [evaluation.scores.independence, evaluation.support.independence],
      [evaluation.scores.communication, evaluation.support.communication],
      [evaluation.scores.hintResponsiveness, evaluation.support.hintResponsiveness],
      [evaluation.scores.errorRecovery, evaluation.support.errorRecovery]
    ] as const;
    const included = new Set(evaluation.composite.includedDimensions);
    const omitted = new Set(evaluation.composite.omittedDimensions);
    if (
      !session.currentStateAvailable
      || expectedEvaluationLifecycle === undefined
      || session.problem === undefined
      || !identifierWithinReplayLimit(evaluation.sessionId)
      || !identifierWithinReplayLimit(evaluation.problemId)
      || !identifierWithinReplayLimit(evaluation.problemVersion)
      || evaluation.sessionId !== session.sessionId
      || evaluation.problemId !== session.problem.problemId
      || evaluation.problemVersion !== session.problem.problemVersion
      || evaluation.lifecycle.sessionStatus !== expectedEvaluationLifecycle.sessionStatus
      || evaluation.lifecycle.completionState !== expectedEvaluationLifecycle.completionState
      || evaluation.totalTurns !== session.counts.turns
      || evaluation.achievedMilestoneCount > evaluation.milestoneCount
      || evaluation.unassistedMilestoneCount
        + evaluation.assistedMilestoneCount
        !== evaluation.achievedMilestoneCount
      || evaluation.disclosedInterventionCount
        !== session.counts.exposedInterventions
          + session.counts.possiblyExposedInterventions
      || scoreSupportPairs.some(([score, support]) =>
        (score === null) !== (support === "INSUFFICIENT")
      )
      || included.size !== evaluation.composite.includedDimensions.length
      || omitted.size !== evaluation.composite.omittedDimensions.length
      || [...included].some((dimension) => omitted.has(dimension))
      || (evaluation.composite.status === "NOT_SCORED")
        !== (evaluation.scores.compositeScore === null)
    ) {
      throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
    }
  }

  const evidenceIdentities = new Set<string>();
  const currentEvidenceEventIds = new Set<string>();
  for (const evidence of session.currentEvidence) {
    const identity = replayEvidenceIdentity(evidence.key);
    if (
      session.problem === undefined
      || !identifierWithinReplayLimit(evidence.evidenceEventId)
      || !evidenceKeyIdentifiersWithinReplayLimit(evidence.key)
      || evidence.value.evidenceEventIds.some((eventId) =>
        !identifierWithinReplayLimit(eventId)
      )
      || evidence.value.evidenceEventIdsTruncation.limit
        > DEFAULT_REPLAY_BOUNDS.maxProvenanceIds
      || evidence.value.lastUpdatedSequence > session.validatedThroughSequence
      || evidence.key.problemId !== session.problem.problemId
      || evidence.keyString !== evidenceKeyToString(evidence.key)
      || evidenceIdentities.has(identity)
      || currentEvidenceEventIds.has(evidence.evidenceEventId)
      || !truncationMatchesLength(
        evidence.value.evidenceEventIdsTruncation,
        evidence.value.evidenceEventIds.length
      )
    ) {
      throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
    }
    evidenceIdentities.add(identity);
    currentEvidenceEventIds.add(evidence.evidenceEventId);
  }

  return session;
}

function recordedStartTime(startedAt: string | undefined): number | undefined {
  if (startedAt === undefined) return undefined;
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareRecordedStartTimes(
  leftStartedAt: string | undefined,
  rightStartedAt: string | undefined
): number {
  const left = recordedStartTime(leftStartedAt);
  const right = recordedStartTime(rightStartedAt);
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left - right;
}

function compareSessionEnvelopes(
  left: SelectedSessionInput,
  right: SelectedSessionInput
): number {
  const timeOrder = compareRecordedStartTimes(
    left.envelope.lifecycle.startedAt,
    right.envelope.lifecycle.startedAt
  );
  if (timeOrder !== 0) return timeOrder;
  return compareReplayStrings(left.envelope.sessionId, right.envelope.sessionId);
}

function insertBoundedCandidate(
  candidates: SelectedSessionInput[],
  candidate: SelectedSessionInput,
  maxSessions: number
): void {
  if (maxSessions <= 0) return;
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const current = candidates[middle];
    if (current === undefined || compareSessionEnvelopes(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  if (low >= maxSessions && candidates.length >= maxSessions) return;
  candidates.splice(low, 0, candidate);
  if (candidates.length > maxSessions) candidates.pop();
}

function selectAndParseSessionSummaries(
  values: readonly unknown[],
  maxSessions: number,
  totalInputSessions: number
): readonly LongitudinalSessionInput[] {
  let valuesIsArray: boolean;
  try {
    valuesIsArray = Array.isArray(values);
  } catch {
    throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
  }
  if (!valuesIsArray) throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");

  const seenSessionIds = new Set<SessionId>();
  const candidates: SelectedSessionInput[] = [];
  let iteratedSessionCount = 0;
  try {
    for (const raw of values) {
      iteratedSessionCount += 1;
      if (iteratedSessionCount > totalInputSessions) {
        throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
      }
      let parsed: ReturnType<typeof LongitudinalSessionEnvelopeSchema.safeParse>;
      try {
        parsed = LongitudinalSessionEnvelopeSchema.safeParse(raw);
      } catch {
        throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
      }
      if (!parsed.success || !identifierWithinReplayLimit(parsed.data.sessionId)) {
        throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
      }
      if (seenSessionIds.has(parsed.data.sessionId)) {
        throw new ReplayProjectionError("DUPLICATE_SESSION");
      }
      seenSessionIds.add(parsed.data.sessionId);
      insertBoundedCandidate(
        candidates,
        { raw, envelope: parsed.data },
        maxSessions
      );
    }
  } catch (error) {
    if (error instanceof ReplayProjectionError) throw error;
    throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
  }
  if (iteratedSessionCount !== totalInputSessions) {
    throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
  }

  return candidates.map((candidate) =>
    parseSelectedSessionSummary(candidate.raw, candidate.envelope)
  );
}

function compareSessions(
  left: LongitudinalSessionInput,
  right: LongitudinalSessionInput
): number {
  const timeOrder = compareRecordedStartTimes(
    left.lifecycle.startedAt,
    right.lifecycle.startedAt
  );
  if (timeOrder !== 0) return timeOrder;
  return compareReplayStrings(left.sessionId, right.sessionId);
}

function exactProblemKey(session: LongitudinalSessionInput): string | undefined {
  if (session.problem === undefined) return undefined;
  return replayProblemIdentity(session.problem.problemId, session.problem.problemVersion);
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[midpoint] ?? null;
  const left = ordered[midpoint - 1];
  const right = ordered[midpoint];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

type EvaluationScoreKey = keyof ReplayEvaluationSummary["scores"];

const EVALUATION_SCORE_KEYS = [
  "technicalCorrectness",
  "rigor",
  "independence",
  "communication",
  "hintResponsiveness",
  "errorRecovery",
  "compositeScore"
] as const satisfies readonly EvaluationScoreKey[];

function scoredValues(
  evaluations: readonly ReplayEvaluationSummary[],
  key: EvaluationScoreKey
): number[] {
  return evaluations.flatMap((entry) => {
    const value = entry.scores[key];
    return value === null ? [] : [value];
  });
}

function aggregateScores(
  evaluations: readonly ReplayEvaluationSummary[]
): {
  readonly scoredSessionCount: LongitudinalEvaluationStatistics["scoredSessionCount"];
  readonly average: ReplayEvaluationSummary["scores"];
  readonly median: ReplayEvaluationSummary["scores"];
} {
  const values = Object.fromEntries(
    EVALUATION_SCORE_KEYS.map((key) => [key, scoredValues(evaluations, key)])
  ) as Record<EvaluationScoreKey, number[]>;

  const scoredSessionCount = Object.fromEntries(
    EVALUATION_SCORE_KEYS.map((key) => [key, values[key].length])
  ) as LongitudinalEvaluationStatistics["scoredSessionCount"];

  return {
    scoredSessionCount,
    average: {
      technicalCorrectness: average(values.technicalCorrectness),
      rigor: average(values.rigor),
      independence: average(values.independence),
      communication: average(values.communication),
      hintResponsiveness: average(values.hintResponsiveness),
      errorRecovery: average(values.errorRecovery),
      compositeScore: average(values.compositeScore)
    },
    median: {
      technicalCorrectness: median(values.technicalCorrectness),
      rigor: median(values.rigor),
      independence: median(values.independence),
      communication: median(values.communication),
      hintResponsiveness: median(values.hintResponsiveness),
      errorRecovery: median(values.errorRecovery),
      compositeScore: median(values.compositeScore)
    }
  };
}

export function projectLongitudinalHistory(
  sessionSummaries: readonly unknown[],
  options: LongitudinalHistoryOptions = {}
): LongitudinalHistoryProjection {
  let bounds: ReplayBounds;
  try {
    bounds = resolveReplayBounds(options.bounds);
  } catch {
    throw new RangeError("Invalid replay bounds");
  }
  let inputIsArray: boolean;
  try {
    inputIsArray = Array.isArray(sessionSummaries);
  } catch {
    throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
  }
  if (!inputIsArray) {
    throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
  }
  let totalInputSessions: number;
  try {
    totalInputSessions = sessionSummaries.length;
  } catch {
    throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
  }
  if (!Number.isSafeInteger(totalInputSessions) || totalInputSessions < 0) {
    throw new ReplayProjectionError("INVALID_SESSION_SUMMARY");
  }
  const included = selectAndParseSessionSummaries(
    sessionSummaries,
    bounds.maxSessions,
    totalInputSessions
  );
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
  let improvementComparisonsSkipped = 0;

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
        scoredSessionCount: scores.scoredSessionCount,
        average: scores.average,
        median: scores.median
      });

      for (let index = 1; index < evaluated.length; index += 1) {
        const previous = evaluated[index - 1];
        const current = evaluated[index];
        if (previous === undefined || current === undefined) continue;
        const previousStartedAt = recordedStartTime(previous.lifecycle.startedAt);
        const currentStartedAt = recordedStartTime(current.lifecycle.startedAt);
        if (
          previousStartedAt === undefined
          || currentStartedAt === undefined
          || previousStartedAt >= currentStartedAt
        ) {
          improvementComparisonsSkipped += 1;
          continue;
        }
        const previousComposite = previous.evaluation.scores.compositeScore;
        const currentComposite = current.evaluation.scores.compositeScore;
        if (previousComposite === null || currentComposite === null) {
          improvementComparisonsSkipped += 1;
          continue;
        }
        improvement.push({
          problemId: first.problem.problemId,
          problemVersion: first.problem.problemVersion,
          fromSessionId: previous.sessionId,
          toSessionId: current.sessionId,
          compositeScoreDelta: currentComposite - previousComposite
        });
      }
    }
  }

  const evidencePatterns: LongitudinalEvidencePattern[] = [...evidenceGroups.entries()]
    .sort(([left], [right]) => compareReplayStrings(left, right))
    .map(([, group]) => ({
      key: group.key,
      sessionCount: group.sessionIds.size,
      observedValues: Object.fromEntries(
        [...group.values.entries()].sort(([left], [right]) => compareReplayStrings(left, right))
      )
    }));

  repeatedProblems.sort((left, right) =>
    compareReplayStrings(left.problemId, right.problemId)
    || compareReplayStrings(left.problemVersion, right.problemVersion)
  );
  evaluationStatistics.sort((left, right) =>
    compareReplayStrings(left.problemId, right.problemId)
    || compareReplayStrings(left.problemVersion, right.problemVersion)
  );
  improvement.sort((left, right) =>
    compareReplayStrings(left.problemId, right.problemId)
    || compareReplayStrings(left.problemVersion, right.problemVersion)
    || compareReplayStrings(left.fromSessionId, right.fromSessionId)
    || compareReplayStrings(left.toSessionId, right.toSessionId)
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
    totalInputSessions,
    includedSessionCount: included.length,
    sessionTruncation: truncationInfo(totalInputSessions, bounds.maxSessions),
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
    improvementComparisonsSkipped,
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

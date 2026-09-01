import {
  EvaluationRubricSchema,
  SessionEvaluationSchema,
  evidenceKeyToString,
  isDisclosedStatus,
  type CompositeDimensionName,
  type DisclosureLevel,
  type DisclosedInterventionRecord,
  type EvaluationDimensionResult,
  type EvaluationDimensionResults,
  type EvaluationEvidenceRef,
  type EvaluationRubric,
  type EvaluationSupportLevel,
  type EvidenceKey,
  type InterviewProblem,
  type MilestoneEvaluation,
  type SessionEvaluation
} from "../../domain/src/index.js";
import type {
  EvidenceRecordState,
  SessionState,
  VerificationRequestState
} from "../../events/src/index.js";

const DEFAULT_RUBRIC: EvaluationRubric = {
  correctnessWeight: 0.35,
  rigorWeight: 0.20,
  independenceWeight: 0.20,
  communicationWeight: 0.15,
  errorRecoveryWeight: 0.10
};

const DETERMINISTIC_FALLBACK_EVALUATED_AT = "1970-01-01T00:00:00.000Z";

const LIMITS = {
  turns: 10_000,
  evidenceRecords: 50_000,
  deliveries: 20_000,
  verificationRequests: 20_000,
  milestones: 5_000,
  disclosureRefs: 50_000
} as const;

const SUPPORT_RANK: Readonly<Record<EvaluationSupportLevel, number>> = {
  INSUFFICIENT: 0,
  WEAK: 1,
  MODERATE: 2,
  STRONG: 3
};

const NEGATIVE_RECOVERY_RATINGS = new Set([
  "LOCAL_ERROR",
  "STRUCTURAL_ERROR",
  "MISUNDERSTOOD_PROBLEM",
  "UNJUSTIFIED",
  "REGRESSING"
]);

const POSITIVE_RECOVERY_RATINGS = new Set([
  "CORRECT",
  "UNDERSTANDS",
  "JUSTIFIED",
  "COMPLETE",
  "PROGRESSING"
]);

export interface EvaluationOptions {
  readonly evaluatedAt?: string;
}

interface DisclosureExposure {
  readonly disclosureId: string;
  readonly level: DisclosureLevel;
  readonly possiblyExposed: boolean;
  readonly earliestBasisSequence?: number;
  readonly deliveryRefs: readonly EvaluationEvidenceRef[];
}

interface MilestoneFacts {
  readonly evaluation: MilestoneEvaluation;
  readonly achievedSequence?: number;
  readonly attributionUncertain: boolean;
  readonly priorAssistanceRefs: readonly EvaluationEvidenceRef[];
}

interface DimensionComputation {
  readonly result: EvaluationDimensionResult;
  readonly positiveCount?: number;
  readonly negativeCount?: number;
  readonly unresolvedCount?: number;
  readonly recoveryCount?: number;
  readonly failureCount?: number;
}

export function evaluateInterviewSession(
  state: Readonly<SessionState>,
  problem: InterviewProblem,
  customRubric: Partial<EvaluationRubric> = {},
  options: EvaluationOptions = {}
): SessionEvaluation {
  assertEvaluationInputBounds(state, problem);
  assertProblemIdentity(state, problem);

  const rubric = EvaluationRubricSchema.parse({
    ...DEFAULT_RUBRIC,
    ...customRubric
  });

  const turnsList = Object.values(state.turns).sort(
    (left, right) =>
      left.committedSequence - right.committedSequence ||
      left.turnId.localeCompare(right.turnId)
  );

  const activeEvidence = collectActiveEvidence(state, problem.id);
  const verificationByEvidenceKey = collectAcceptedVerifications(state, problem.id);
  const disclosureData = collectDisclosureData(state, problem);

  const milestoneFacts = evaluateMilestones(
    problem,
    activeEvidence,
    verificationByEvidenceKey,
    disclosureData.exposuresByDisclosureId
  );
  const milestones = milestoneFacts.map((item) => item.evaluation);

  const correctness = evaluateTechnicalCorrectness(
    activeEvidence,
    verificationByEvidenceKey,
    milestoneFacts
  );
  const rigor = evaluateRigor(problem, activeEvidence);
  const independence = evaluateIndependence(milestoneFacts);
  const communication = unsupportedDimension(
    "Current application-owned evidence does not contain a validated communication-quality signal."
  );
  const hintResponsiveness = evaluateHintResponsiveness(
    problem,
    milestoneFacts,
    disclosureData.exposuresByDisclosureId
  );
  const errorRecovery = evaluateErrorRecovery(state, problem.id);

  const dimensionResults: EvaluationDimensionResults = {
    technicalCorrectness: correctness.result,
    rigor: rigor.result,
    independence: independence.result,
    communication,
    hintResponsiveness: hintResponsiveness.result,
    errorRecovery: errorRecovery.result
  };

  const composite = computeComposite(dimensionResults, rubric);

  const unassistedMilestoneCount = milestones.filter(
    (milestone) => milestone.achieved && milestone.assistanceLevel === 0
  ).length;
  const assistedMilestoneCount = milestones.filter(
    (milestone) => milestone.achieved && milestone.assistanceLevel > 0
  ).length;

  const keyStrengths = buildStrengths(
    dimensionResults,
    milestoneFacts,
    correctness,
    rigor,
    errorRecovery
  );
  const areasForImprovement = buildImprovementAreas(
    dimensionResults,
    correctness,
    rigor,
    errorRecovery,
    assistedMilestoneCount
  );
  const lifecycle = evaluateLifecycle(state, turnsList.length);
  const summaryAssessment = buildSummary(
    lifecycle.completionState,
    composite.score,
    composite.metadata.status,
    composite.metadata.includedDimensions.length,
    composite.metadata.omittedDimensions,
    correctness.unresolvedCount ?? 0
  );

  const evaluatedAt =
    options.evaluatedAt ??
    state.completedAt ??
    state.archivedAt ??
    DETERMINISTIC_FALLBACK_EVALUATED_AT;

  return SessionEvaluationSchema.parse({
    sessionId: state.sessionId,
    problemId: problem.id,
    problemVersion: problem.version,
    evaluatedAt,
    rubric,
    lifecycle,
    scores: {
      technicalCorrectness: dimensionResults.technicalCorrectness.score,
      rigor: dimensionResults.rigor.score,
      independence: dimensionResults.independence.score,
      communication: dimensionResults.communication.score,
      hintResponsiveness: dimensionResults.hintResponsiveness.score,
      errorRecovery: dimensionResults.errorRecovery.score,
      compositeScore: composite.score
    },
    dimensionResults,
    composite: composite.metadata,
    milestones,
    disclosedInterventions: disclosureData.interventions,
    unassistedMilestoneCount,
    assistedMilestoneCount,
    totalTurns: turnsList.length,
    keyStrengths,
    areasForImprovement,
    summaryAssessment
  });
}

function assertProblemIdentity(
  state: Readonly<SessionState>,
  problem: InterviewProblem
): void {
  if (
    state.problem !== undefined &&
    (state.problem.id !== problem.id || state.problem.version !== problem.version)
  ) {
    throw new Error("Evaluation problem identity does not match the authoritative session state");
  }
}

function assertEvaluationInputBounds(
  state: Readonly<SessionState>,
  problem: InterviewProblem
): void {
  const turnCount = Object.keys(state.turns).length;
  if (turnCount > LIMITS.turns) {
    throw new Error("Evaluation input exceeds the supported turn bound");
  }

  let evidenceRecordCount = 0;
  for (const history of Object.values(state.evidenceHistory)) {
    evidenceRecordCount += history.length;
    if (evidenceRecordCount > LIMITS.evidenceRecords) {
      throw new Error("Evaluation input exceeds the supported evidence-history bound");
    }
  }

  const deliveryCount = Object.keys(state.deliveries).length;
  if (deliveryCount > LIMITS.deliveries) {
    throw new Error("Evaluation input exceeds the supported delivery bound");
  }

  const verificationCount = Object.keys(state.verificationRequests).length;
  if (verificationCount > LIMITS.verificationRequests) {
    throw new Error("Evaluation input exceeds the supported verification bound");
  }

  if (problem.interviewer.reasoningGraph.milestones.length > LIMITS.milestones) {
    throw new Error("Evaluation input exceeds the supported milestone bound");
  }

  let disclosureRefCount = 0;
  for (const delivery of Object.values(state.deliveries)) {
    disclosureRefCount += delivery.disclosureIds.length;
    if (disclosureRefCount > LIMITS.disclosureRefs) {
      throw new Error("Evaluation input exceeds the supported disclosure-reference bound");
    }
  }
}

function collectActiveEvidence(
  state: Readonly<SessionState>,
  problemId: string
): ReadonlyMap<string, EvidenceRecordState> {
  const active = new Map<string, EvidenceRecordState>();
  const histories = Object.entries(state.evidenceHistory).sort(([left], [right]) =>
    left.localeCompare(right)
  );

  for (const [key, history] of histories) {
    const activeRecords = history.filter((record) => record.status === "ACTIVE");
    if (activeRecords.length > 1) {
      throw new Error("Evaluation encountered multiple active records for one evidence key");
    }
    const record = activeRecords[0];
    if (record !== undefined && record.key.problemId === problemId) {
      active.set(key, record);
    }
  }
  return active;
}

function collectAcceptedVerifications(
  state: Readonly<SessionState>,
  problemId: string
): ReadonlyMap<string, readonly VerificationRequestState[]> {
  const byKey = new Map<string, VerificationRequestState[]>();
  const accepted = Object.values(state.verificationRequests)
    .filter(
      (request) =>
        request.status === "ACCEPTED" &&
        request.result !== undefined &&
        request.evidenceKey.problemId === problemId
    )
    .sort(
      (left, right) =>
        left.basis.committedInputSequence - right.basis.committedInputSequence ||
        left.verificationRequestId.localeCompare(right.verificationRequestId)
    );

  for (const request of accepted) {
    const key = evidenceKeyToString(request.evidenceKey);
    const current = byKey.get(key) ?? [];
    current.push(request);
    byKey.set(key, current);
  }
  return byKey;
}

function collectDisclosureData(
  state: Readonly<SessionState>,
  problem: InterviewProblem
): {
  readonly interventions: readonly DisclosedInterventionRecord[];
  readonly exposuresByDisclosureId: ReadonlyMap<string, DisclosureExposure>;
} {
  const disclosureToMilestones = new Map<string, string[]>();
  for (const milestone of problem.interviewer.reasoningGraph.milestones) {
    for (const disclosureId of milestone.protectedDisclosureIds) {
      const current = disclosureToMilestones.get(disclosureId) ?? [];
      current.push(milestone.id);
      disclosureToMilestones.set(disclosureId, current);
    }
  }

  const exposuresMutable = new Map<string, {
    level: DisclosureLevel;
    possiblyExposed: boolean;
    earliestBasisSequence?: number;
    deliveryRefs: EvaluationEvidenceRef[];
  }>();

  const interventions: DisclosedInterventionRecord[] = [];
  const deliveries = Object.values(state.deliveries)
    .filter((delivery) => isDisclosedStatus(delivery.status))
    .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));

  for (const delivery of deliveries) {
    const generation = state.generations[delivery.generationId];
    const relatedMilestoneIds = Array.from(
      new Set(
        delivery.disclosureIds.flatMap(
          (disclosureId) => disclosureToMilestones.get(disclosureId) ?? []
        )
      )
    ).sort();

    const deliveryStatus =
      delivery.status === "POSSIBLY_EXPOSED" ? "POSSIBLY_EXPOSED" as const : "EXPOSED" as const;
    const medium = delivery.content.medium;
    const summary =
      deliveryStatus +
      " " +
      medium +
      " assistance at disclosure level " +
      String(delivery.effectiveDisclosureLevel) +
      " with " +
      String(delivery.disclosureIds.length) +
      " disclosure reference(s).";

    interventions.push({
      deliveryId: delivery.deliveryId,
      generationId: delivery.generationId,
      ...(generation === undefined ? {} : { turnId: generation.basis.turnId }),
      disclosureLevel: delivery.effectiveDisclosureLevel,
      disclosureIds: [...delivery.disclosureIds].sort(),
      relatedMilestoneIds,
      deliveryStatus,
      summary
    });

    for (const disclosureId of delivery.disclosureIds) {
      const current = exposuresMutable.get(disclosureId);
      const basisSequence = generation?.basis.committedInputSequence;
      const deliveryRef = evaluationRef("DELIVERY", delivery.deliveryId);
      if (current === undefined) {
        exposuresMutable.set(disclosureId, {
          level: delivery.effectiveDisclosureLevel,
          possiblyExposed: delivery.status === "POSSIBLY_EXPOSED",
          ...(basisSequence === undefined ? {} : { earliestBasisSequence: basisSequence }),
          deliveryRefs: [deliveryRef]
        });
      } else {
        current.level = Math.max(current.level, delivery.effectiveDisclosureLevel) as DisclosureLevel;
        current.possiblyExposed ||= delivery.status === "POSSIBLY_EXPOSED";
        if (
          basisSequence !== undefined &&
          (current.earliestBasisSequence === undefined || basisSequence < current.earliestBasisSequence)
        ) {
          current.earliestBasisSequence = basisSequence;
        }
        current.deliveryRefs.push(deliveryRef);
      }
    }
  }

  const exposures = new Map<string, DisclosureExposure>();
  for (const [disclosureId, exposure] of exposuresMutable) {
    exposures.set(disclosureId, {
      disclosureId,
      level: exposure.level,
      possiblyExposed: exposure.possiblyExposed,
      ...(exposure.earliestBasisSequence === undefined
        ? {}
        : { earliestBasisSequence: exposure.earliestBasisSequence }),
      deliveryRefs: uniqueRefs(exposure.deliveryRefs)
    });
  }

  return {
    interventions,
    exposuresByDisclosureId: exposures
  };
}

function evaluateMilestones(
  problem: InterviewProblem,
  activeEvidence: ReadonlyMap<string, EvidenceRecordState>,
  verificationByEvidenceKey: ReadonlyMap<string, readonly VerificationRequestState[]>,
  exposuresByDisclosureId: ReadonlyMap<string, DisclosureExposure>
): readonly MilestoneFacts[] {
  const graph = problem.interviewer.reasoningGraph;
  const milestoneById = new Map(graph.milestones.map((milestone) => [milestone.id, milestone] as const));
  const base = new Map<string, {
    achieved: boolean;
    achievedSequence?: number;
    supportLevel: EvaluationSupportLevel;
    evidenceRefs: EvaluationEvidenceRef[];
    notAchievedReason?: string;
    achievedAtTurnId?: MilestoneEvaluation["achievedAtTurnId"];
  }>();

  for (const milestone of graph.milestones) {
    const progress = getActiveEvidence(
      activeEvidence,
      problem.id,
      { kind: "MILESTONE", milestoneId: milestone.id },
      "PROGRESS"
    );
    const correctness = getActiveEvidence(
      activeEvidence,
      problem.id,
      { kind: "MILESTONE", milestoneId: milestone.id },
      "CORRECTNESS"
    );
    const justification = getActiveEvidence(
      activeEvidence,
      problem.id,
      { kind: "MILESTONE", milestoneId: milestone.id },
      "JUSTIFICATION"
    );
    const understanding = getActiveEvidence(
      activeEvidence,
      problem.id,
      { kind: "MILESTONE", milestoneId: milestone.id },
      "UNDERSTANDING"
    );

    const records = [progress, correctness, justification, understanding].filter(
      (record): record is EvidenceRecordState => record !== undefined
    );
    const contradiction =
      progress?.value.value === "REGRESSING" ||
      correctness?.value.value === "LOCAL_ERROR" ||
      correctness?.value.value === "STRUCTURAL_ERROR" ||
      understanding?.value.value === "MISUNDERSTOOD_PROBLEM";

    const directComplete = progress?.value.value === "COMPLETE";
    const substantiatedComplete =
      correctness?.value.value === "CORRECT" &&
      (justification?.value.value === "JUSTIFIED" ||
        justification?.value.value === "NOT_APPLICABLE");
    const achieved = (directComplete || substantiatedComplete) && !contradiction;

    const evidenceRefs = uniqueRefs(
      records.flatMap((record) => [
        evaluationRef("EVIDENCE_EVENT", record.evidenceEventId),
        ...record.value.evidenceEventIds.map((eventId) =>
          evaluationRef("EVIDENCE_EVENT", eventId)
        )
      ])
    );

    const relevantVerificationRequests = records.flatMap((record) =>
      verificationByEvidenceKey.get(evidenceKeyToString(record.key)) ?? []
    );
    for (const request of relevantVerificationRequests) {
      evidenceRefs.push(evaluationRef("VERIFICATION_REQUEST", request.verificationRequestId));
    }

    const achievedSequence = achieved
      ? Math.max(
          ...records
            .filter((record) =>
              record.value.value === "COMPLETE" ||
              record.value.value === "CORRECT" ||
              record.value.value === "JUSTIFIED" ||
              record.value.value === "NOT_APPLICABLE"
            )
            .map((record) => record.value.lastUpdatedSequence)
        )
      : undefined;

    let supportLevel = supportFromEvidenceRecords(records, relevantVerificationRequests.length > 0);
    if (achieved && directComplete && supportLevel === "WEAK" && (progress?.value.inferenceConfidence ?? 0) >= 0.8) {
      supportLevel = "MODERATE";
    }

    const achievedAtTurnId = achieved
      ? findTurnForEvidence(records, verificationByEvidenceKey)
      : undefined;

    base.set(milestone.id, {
      achieved,
      ...(achievedSequence === undefined ? {} : { achievedSequence }),
      supportLevel,
      evidenceRefs: uniqueRefs([
        evaluationRef("MILESTONE", milestone.id),
        ...evidenceRefs
      ]),
      ...(achievedAtTurnId === undefined ? {} : { achievedAtTurnId }),
      ...(achieved
        ? {}
        : {
            notAchievedReason: contradiction
              ? "Active scoped evidence contradicts milestone completion."
              : "No active scoped evidence establishes milestone completion."
          })
    });
  }

  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const current = incoming.get(edge.to) ?? [];
    current.push(edge.from);
    incoming.set(edge.to, current);
  }

  const facts: MilestoneFacts[] = [];
  for (const milestone of graph.milestones) {
    const baseResult = base.get(milestone.id);
    if (baseResult === undefined) {
      throw new Error("Evaluation could not resolve a reasoning-graph milestone");
    }

    let supportLevel = baseResult.supportLevel;
    if (baseResult.achieved) {
      const predecessorIds = (incoming.get(milestone.id) ?? []).filter((predecessorId) => {
        const predecessor = milestoneById.get(predecessorId);
        return predecessor !== undefined &&
          predecessor.approachIds.some((approachId) => milestone.approachIds.includes(approachId));
      });
      const requiredContextIds = Array.from(
        new Set([...predecessorIds, ...milestone.optionalPrerequisiteIds])
      );
      if (
        requiredContextIds.length > 0 &&
        !requiredContextIds.some((id) => base.get(id)?.achieved === true)
      ) {
        supportLevel = downgradeSupport(supportLevel);
      }
    }

    let assistanceLevel: DisclosureLevel = 0;
    const assistanceDisclosureIds: string[] = [];
    const priorAssistanceRefs: EvaluationEvidenceRef[] = [];
    let attributionUncertain = false;

    for (const disclosureId of milestone.protectedDisclosureIds) {
      const exposure = exposuresByDisclosureId.get(disclosureId);
      if (exposure === undefined) continue;

      const definitelyPrior =
        baseResult.achievedSequence !== undefined &&
        exposure.earliestBasisSequence !== undefined &&
        exposure.earliestBasisSequence < baseResult.achievedSequence;
      const definitelyAfter =
        baseResult.achievedSequence !== undefined &&
        exposure.earliestBasisSequence !== undefined &&
        exposure.earliestBasisSequence >= baseResult.achievedSequence;

      if (definitelyAfter) continue;

      if (!definitelyPrior) attributionUncertain = true;
      assistanceLevel = Math.max(assistanceLevel, exposure.level) as DisclosureLevel;
      assistanceDisclosureIds.push(disclosureId);
      priorAssistanceRefs.push(...exposure.deliveryRefs);
    }

    if (attributionUncertain && assistanceLevel > 0) {
      supportLevel = minSupport(supportLevel, "WEAK");
    }

    const evaluation: MilestoneEvaluation = {
      milestoneId: milestone.id,
      description: milestone.description,
      achieved: baseResult.achieved,
      ...(baseResult.achievedAtTurnId === undefined
        ? {}
        : { achievedAtTurnId: baseResult.achievedAtTurnId }),
      assistanceLevel,
      supportLevel,
      evidenceRefs: uniqueRefs([
        ...baseResult.evidenceRefs,
        ...priorAssistanceRefs
      ]),
      assistanceDisclosureIds: Array.from(new Set(assistanceDisclosureIds)).sort(),
      approachIds: [...milestone.approachIds].sort(),
      ...(baseResult.notAchievedReason === undefined
        ? {}
        : { notAchievedReason: baseResult.notAchievedReason })
    };

    facts.push({
      evaluation,
      ...(baseResult.achievedSequence === undefined
        ? {}
        : { achievedSequence: baseResult.achievedSequence }),
      attributionUncertain,
      priorAssistanceRefs: uniqueRefs(priorAssistanceRefs)
    });
  }

  return facts;
}

function evaluateTechnicalCorrectness(
  activeEvidence: ReadonlyMap<string, EvidenceRecordState>,
  verificationByEvidenceKey: ReadonlyMap<string, readonly VerificationRequestState[]>,
  milestoneFacts: readonly MilestoneFacts[]
): DimensionComputation {
  const sampleBySubject = new Map<string, {
    score: number;
    sequence: number;
    supportLevel: EvaluationSupportLevel;
    refs: EvaluationEvidenceRef[];
    positive: boolean;
    negative: boolean;
  }>();
  const unresolvedRefs: EvaluationEvidenceRef[] = [];

  for (const record of activeEvidence.values()) {
    if (record.key.dimension !== "CORRECTNESS") continue;
    const score = correctnessRatingScore(record.value.value);
    const subject = subjectKey(record.key);
    if (score !== null) {
      sampleBySubject.set(subject, {
        score,
        sequence: record.value.lastUpdatedSequence,
        supportLevel: supportFromCount(1, record.value.inferenceConfidence, false),
        refs: uniqueRefs([
          evaluationRef("EVIDENCE_EVENT", record.evidenceEventId),
          ...record.value.evidenceEventIds.map((id) => evaluationRef("EVIDENCE_EVENT", id))
        ]),
        positive: score === 100,
        negative: score < 100
      });
    }
  }

  for (const requests of verificationByEvidenceKey.values()) {
    const latest = requests.at(-1);
    if (latest?.result === undefined) continue;
    const requestRef = evaluationRef("VERIFICATION_REQUEST", latest.verificationRequestId);
    if (latest.result.status === "UNRESOLVED") {
      unresolvedRefs.push(requestRef);
      continue;
    }

    const score = latest.result.status === "VERIFIED" ? 100 : 0;
    const subject = subjectKey(latest.evidenceKey);
    const existing = sampleBySubject.get(subject);
    const verificationSequence = latest.basis.committedInputSequence;
    if (existing === undefined || verificationSequence >= existing.sequence) {
      sampleBySubject.set(subject, {
        score,
        sequence: verificationSequence,
        supportLevel: supportFromCount(1, latest.result.interpretationConfidence, true),
        refs: [requestRef],
        positive: score === 100,
        negative: score === 0
      });
    } else {
      existing.refs.push(requestRef);
      existing.supportLevel = maxSupport(
        existing.supportLevel,
        supportFromCount(1, latest.result.interpretationConfidence, true)
      );
    }

  }

  for (const milestone of milestoneFacts) {
    if (!milestone.evaluation.achieved) continue;
    const subject = "MILESTONE:" + milestone.evaluation.milestoneId;
    if (!sampleBySubject.has(subject)) {
      sampleBySubject.set(subject, {
        score: 100,
        sequence: milestone.achievedSequence ?? 0,
        supportLevel: milestone.evaluation.supportLevel,
        refs: milestone.evaluation.evidenceRefs,
        positive: true,
        negative: false
      });
    }
  }

  const samples = [...sampleBySubject.values()];
  if (samples.length === 0) {
    return {
      result: unsupportedDimension(
        unresolvedRefs.length > 0
          ? "Verification remained unresolved and no active correctness evidence established a score."
          : "No active scoped correctness evidence, verified claim, or achieved milestone supports a correctness score.",
        unresolvedRefs
      ),
      positiveCount: 0,
      negativeCount: 0,
      unresolvedCount: unresolvedRefs.length
    };
  }

  const score = roundScore(
    samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length
  );
  const supportLevel = aggregateSampleSupport(samples.map((sample) => sample.supportLevel));
  const refs = uniqueRefs([
    ...samples.flatMap((sample) => sample.refs),
    ...unresolvedRefs
  ]);

  return {
    result: scoredDimension(score, supportLevel, refs),
    positiveCount: samples.filter((sample) => sample.positive).length,
    negativeCount: samples.filter((sample) => sample.negative).length,
    unresolvedCount: unresolvedRefs.length
  };
}

function evaluateRigor(
  problem: InterviewProblem,
  activeEvidence: ReadonlyMap<string, EvidenceRecordState>
): DimensionComputation {
  const samples: Array<{
    score: number;
    confidence: number;
    refs: EvaluationEvidenceRef[];
  }> = [];

  for (const record of activeEvidence.values()) {
    if (record.key.problemId !== problem.id || record.key.dimension !== "JUSTIFICATION") continue;
    const baseScore = rigorRatingScore(record.value.value);
    if (baseScore === null) continue;

    const correctness = getActiveEvidence(
      activeEvidence,
      problem.id,
      record.key.subject,
      "CORRECTNESS"
    );
    let score = baseScore;
    if (correctness?.value.value === "STRUCTURAL_ERROR") score = 0;
    if (correctness?.value.value === "LOCAL_ERROR") score = Math.min(score, 50);

    samples.push({
      score,
      confidence: Math.min(
        record.value.inferenceConfidence,
        correctness?.value.inferenceConfidence ?? 1
      ),
      refs: uniqueRefs([
        evaluationRef("EVIDENCE_EVENT", record.evidenceEventId),
        ...record.value.evidenceEventIds.map((id) => evaluationRef("EVIDENCE_EVENT", id)),
        ...(correctness === undefined
          ? []
          : [evaluationRef("EVIDENCE_EVENT", correctness.evidenceEventId)])
      ])
    });
  }

  if (samples.length === 0) {
    return {
      result: unsupportedDimension(
        "No active scoped justification evidence supports a rigor score."
      )
    };
  }

  const score = roundScore(
    samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length
  );
  const minConfidence = Math.min(...samples.map((sample) => sample.confidence));
  return {
    result: scoredDimension(
      score,
      supportFromCount(samples.length, minConfidence, false),
      uniqueRefs(samples.flatMap((sample) => sample.refs))
    ),
    positiveCount: samples.filter((sample) => sample.score === 100).length,
    negativeCount: samples.filter((sample) => sample.score < 100).length
  };
}

function evaluateIndependence(
  milestoneFacts: readonly MilestoneFacts[]
): DimensionComputation {
  const achieved = milestoneFacts.filter((item) => item.evaluation.achieved);
  if (achieved.length === 0) {
    return {
      result: unsupportedDimension(
        "Independence is not scored because no milestone has grounded achievement evidence."
      )
    };
  }

  let total = 0;
  let attributionUncertain = false;
  const refs: EvaluationEvidenceRef[] = [];

  for (const milestone of achieved) {
    const assistanceCount = milestone.evaluation.assistanceDisclosureIds.length;
    let milestoneScore = independenceScoreForLevel(milestone.evaluation.assistanceLevel);
    if (assistanceCount > 1) {
      milestoneScore = Math.max(0, milestoneScore - Math.min(20, (assistanceCount - 1) * 10));
    }
    total += milestoneScore;
    attributionUncertain ||= milestone.attributionUncertain;
    refs.push(...milestone.evaluation.evidenceRefs);
  }

  let supportLevel = supportFromCount(achieved.length, 1, false);
  if (attributionUncertain) supportLevel = minSupport(supportLevel, "WEAK");

  return {
    result: scoredDimension(
      roundScore(total / achieved.length),
      supportLevel,
      uniqueRefs(refs)
    )
  };
}

function evaluateHintResponsiveness(
  problem: InterviewProblem,
  milestoneFacts: readonly MilestoneFacts[],
  exposuresByDisclosureId: ReadonlyMap<string, DisclosureExposure>
): DimensionComputation {
  const factsByMilestone = new Map(
    milestoneFacts.map((item) => [item.evaluation.milestoneId, item] as const)
  );
  let opportunities = 0;
  let associatedProgress = 0;
  const refs: EvaluationEvidenceRef[] = [];

  for (const milestone of problem.interviewer.reasoningGraph.milestones) {
    const fact = factsByMilestone.get(milestone.id);
    if (fact === undefined) continue;

    const relevant = milestone.protectedDisclosureIds
      .map((id) => exposuresByDisclosureId.get(id))
      .filter((item): item is DisclosureExposure => item !== undefined);

    if (relevant.length === 0) continue;

    const earliestKnownPrior = relevant.some(
      (exposure) =>
        exposure.earliestBasisSequence !== undefined &&
        (
          fact.achievedSequence === undefined ||
          exposure.earliestBasisSequence < fact.achievedSequence
        )
    );
    if (!earliestKnownPrior) continue;

    opportunities += 1;
    refs.push(
      evaluationRef("MILESTONE", milestone.id),
      ...relevant.flatMap((exposure) => exposure.deliveryRefs)
    );
    if (fact.evaluation.achieved) {
      associatedProgress += 1;
      refs.push(...fact.evaluation.evidenceRefs);
    }
  }

  if (opportunities === 0) {
    return {
      result: unsupportedDimension(
        "No specifically attributable delivered assistance preceded a related milestone outcome."
      )
    };
  }

  return {
    result: scoredDimension(
      roundScore((associatedProgress / opportunities) * 100),
      "WEAK",
      uniqueRefs(refs)
    ),
    positiveCount: associatedProgress,
    negativeCount: opportunities - associatedProgress
  };
}

function evaluateErrorRecovery(
  state: Readonly<SessionState>,
  problemId: string
): DimensionComputation {
  let recoveryCount = 0;
  let failureCount = 0;
  const refs: EvaluationEvidenceRef[] = [];
  const unresolvedApproachErrors: Array<{
    approachId: string;
    sequence: number;
    refs: EvaluationEvidenceRef[];
  }> = [];
  const positiveApproachRecords: Array<{
    approachId: string;
    sequence: number;
    refs: EvaluationEvidenceRef[];
  }> = [];

  const histories = Object.values(state.evidenceHistory)
    .filter((history) => history.some((record) => record.key.problemId === problemId));

  for (const history of histories) {
    const records = [...history]
      .filter((record) => record.key.problemId === problemId)
      .sort(
        (left, right) =>
          left.value.lastUpdatedSequence - right.value.lastUpdatedSequence ||
          left.evidenceEventId.localeCompare(right.evidenceEventId)
      );
    if (records.length === 0) continue;

    let inErrorEpisode = false;
    let errorRefs: EvaluationEvidenceRef[] = [];
    let errorSequence = 0;
    for (const record of records) {
      const recordRefs = [
        evaluationRef("EVIDENCE_EVENT", record.evidenceEventId),
        ...record.value.evidenceEventIds.map((id) => evaluationRef("EVIDENCE_EVENT", id))
      ];
      const negative =
        NEGATIVE_RECOVERY_RATINGS.has(record.value.value) ||
        record.status === "STALE";
      const positive =
        POSITIVE_RECOVERY_RATINGS.has(record.value.value) &&
        record.status !== "STALE";

      if (!inErrorEpisode && negative) {
        inErrorEpisode = true;
        errorSequence = record.value.lastUpdatedSequence;
        errorRefs = recordRefs;
        continue;
      }

      if (inErrorEpisode && negative) {
        errorRefs.push(...recordRefs);
        continue;
      }

      if (inErrorEpisode && positive) {
        recoveryCount += 1;
        refs.push(...errorRefs, ...recordRefs);
        inErrorEpisode = false;
        errorRefs = [];
      }
    }

    const subject = records[0]?.key.subject;
    if (inErrorEpisode) {
      if (subject?.kind === "APPROACH") {
        unresolvedApproachErrors.push({
          approachId: subject.approachId,
          sequence: errorSequence,
          refs: uniqueRefs(errorRefs)
        });
      } else {
        failureCount += 1;
        refs.push(...errorRefs);
      }
    }

    if (subject?.kind === "APPROACH") {
      for (const record of records) {
        if (
          POSITIVE_RECOVERY_RATINGS.has(record.value.value) &&
          record.status !== "STALE"
        ) {
          positiveApproachRecords.push({
            approachId: subject.approachId,
            sequence: record.value.lastUpdatedSequence,
            refs: [evaluationRef("EVIDENCE_EVENT", record.evidenceEventId)]
          });
        }
      }
    }

  }

  for (const error of unresolvedApproachErrors) {
    const switched = positiveApproachRecords.find(
      (candidate) =>
        candidate.approachId !== error.approachId &&
        candidate.sequence > error.sequence
    );
    if (switched === undefined) {
      failureCount += 1;
      refs.push(...error.refs);
    } else {
      recoveryCount += 1;
      refs.push(...error.refs, ...switched.refs);
    }
  }

  const opportunities = recoveryCount + failureCount;
  if (opportunities === 0) {
    return {
      result: unsupportedDimension(
        "No grounded error or invalidated-evidence transition created an error-recovery opportunity."
      ),
      recoveryCount: 0,
      failureCount: 0
    };
  }

  return {
    result: scoredDimension(
      roundScore((recoveryCount / opportunities) * 100),
      supportFromCount(opportunities, 1, false),
      uniqueRefs(refs)
    ),
    recoveryCount,
    failureCount
  };
}

function computeComposite(
  dimensions: EvaluationDimensionResults,
  rubric: EvaluationRubric
): {
  readonly score: number | null;
  readonly metadata: SessionEvaluation["composite"];
} {
  const weighted: readonly [CompositeDimensionName, number][] = [
    ["technicalCorrectness", rubric.correctnessWeight],
    ["rigor", rubric.rigorWeight],
    ["independence", rubric.independenceWeight],
    ["communication", rubric.communicationWeight],
    ["errorRecovery", rubric.errorRecoveryWeight]
  ];

  const positiveWeight = weighted.filter(([, weight]) => weight > 0);
  const included = positiveWeight.filter(([name]) => dimensions[name].score !== null);
  const omitted = positiveWeight
    .filter(([name]) => dimensions[name].score === null)
    .map(([name]) => name);
  const totalWeight = included.reduce((sum, [, weight]) => sum + weight, 0);

  if (totalWeight <= 0) {
    return {
      score: null,
      metadata: {
        status: "NOT_SCORED",
        supportLevel: "INSUFFICIENT",
        includedDimensions: [],
        omittedDimensions: omitted
      }
    };
  }

  let weightedTotal = 0;
  for (const [name, weight] of included) {
    const score = dimensions[name].score;
    if (score === null) continue;
    weightedTotal += score * weight;
  }

  let supportLevel = included.reduce<EvaluationSupportLevel>(
    (current, [name]) => minSupport(current, dimensions[name].supportLevel),
    "STRONG"
  );
  const status = omitted.length === 0 ? "FULL" as const : "PARTIAL" as const;
  if (status === "PARTIAL") supportLevel = minSupport(supportLevel, "MODERATE");

  return {
    score: roundScore(weightedTotal / totalWeight),
    metadata: {
      status,
      supportLevel,
      includedDimensions: included.map(([name]) => name),
      omittedDimensions: omitted
    }
  };
}

function buildStrengths(
  dimensions: EvaluationDimensionResults,
  milestoneFacts: readonly MilestoneFacts[],
  correctness: DimensionComputation,
  rigor: DimensionComputation,
  recovery: DimensionComputation
): string[] {
  const strengths: string[] = [];
  const achieved = milestoneFacts.filter((item) => item.evaluation.achieved);
  const unassisted = achieved.filter((item) => item.evaluation.assistanceLevel === 0);

  if (
    dimensions.technicalCorrectness.score !== null &&
    dimensions.technicalCorrectness.score >= 80 &&
    SUPPORT_RANK[dimensions.technicalCorrectness.supportLevel] >= SUPPORT_RANK.MODERATE
  ) {
    strengths.push(
      "Authoritative correctness evidence supports " +
      String(correctness.positiveCount ?? 0) +
      " positively scored subject(s) with no turn-count inference."
    );
  }

  if (
    dimensions.rigor.score !== null &&
    dimensions.rigor.score >= 80 &&
    SUPPORT_RANK[dimensions.rigor.supportLevel] >= SUPPORT_RANK.MODERATE
  ) {
    strengths.push(
      "Scoped justification evidence supports the recorded rigor score across " +
      String((rigor.positiveCount ?? 0) + (rigor.negativeCount ?? 0)) +
      " subject(s)."
    );
  }

  if (unassisted.length > 0) {
    strengths.push(
      String(unassisted.length) +
      " achieved milestone(s) have no attributable prior protected disclosure."
    );
  }

  if ((recovery.recoveryCount ?? 0) > 0) {
    strengths.push(
      "The evidence history records " +
      String(recovery.recoveryCount) +
      " error or invalidation episode(s) followed by supported replacement evidence."
    );
  }

  return strengths;
}

function buildImprovementAreas(
  dimensions: EvaluationDimensionResults,
  correctness: DimensionComputation,
  rigor: DimensionComputation,
  recovery: DimensionComputation,
  assistedMilestoneCount: number
): string[] {
  const improvements: string[] = [];

  if (
    dimensions.technicalCorrectness.score !== null &&
    dimensions.technicalCorrectness.score < 70 &&
    (correctness.negativeCount ?? 0) > 0
  ) {
    improvements.push(
      String(correctness.negativeCount) +
      " scored correctness subject(s) remain locally or structurally contradicted."
    );
  }

  if (
    dimensions.rigor.score !== null &&
    dimensions.rigor.score < 70 &&
    (rigor.negativeCount ?? 0) > 0
  ) {
    improvements.push(
      String(rigor.negativeCount) +
      " scoped justification subject(s) remain incomplete, unjustified, or constrained by correctness errors."
    );
  }

  if (assistedMilestoneCount > 0) {
    improvements.push(
      String(assistedMilestoneCount) +
      " achieved milestone(s) are associated with prior exposed or possibly exposed protected assistance."
    );
  }

  if ((recovery.failureCount ?? 0) > 0) {
    improvements.push(
      String(recovery.failureCount) +
      " recorded error episode(s) lack later supported recovery evidence."
    );
  }

  return improvements;
}

function buildSummary(
  completionState: SessionEvaluation["lifecycle"]["completionState"],
  compositeScore: number | null,
  compositeStatus: SessionEvaluation["composite"]["status"],
  includedDimensionCount: number,
  omittedDimensions: readonly CompositeDimensionName[],
  unresolvedCorrectnessCount: number
): string {
  const lifecycleText = {
    NOT_STARTED: "The session has not started.",
    IN_PROGRESS: "The session is incomplete and remains in progress.",
    COMPLETED: "The session reached an authoritative completed state.",
    ARCHIVED_INCOMPLETE: "The session was archived without an authoritative completion event.",
    ARCHIVED_COMPLETED: "The session was completed and later archived."
  }[completionState];

  if (compositeScore === null) {
    return (
      lifecycleText +
      " No composite score was produced because the authoritative record does not support any positively weighted rubric dimension."
    );
  }

  const omittedText =
    omittedDimensions.length === 0
      ? "No positively weighted dimension was omitted."
      : "Unsupported weighted dimensions omitted from the composite: " +
        omittedDimensions.join(", ") +
        ".";

  const unresolvedText =
    unresolvedCorrectnessCount > 0
      ? " " +
        String(unresolvedCorrectnessCount) +
        " accepted verification result(s) remained unresolved."
      : "";

  return (
    lifecycleText +
    " A " +
    compositeStatus.toLowerCase() +
    " grounded composite of " +
    String(compositeScore) +
    "/100 was computed from " +
    String(includedDimensionCount) +
    " supported weighted dimension(s). " +
    omittedText +
    unresolvedText
  );
}

function evaluateLifecycle(
  state: Readonly<SessionState>,
  totalTurns: number
): SessionEvaluation["lifecycle"] {
  let completionState: SessionEvaluation["lifecycle"]["completionState"];
  if (state.status === "CREATED") {
    completionState = "NOT_STARTED";
  } else if (state.status === "ACTIVE") {
    completionState = "IN_PROGRESS";
  } else if (state.status === "COMPLETED") {
    completionState = "COMPLETED";
  } else {
    completionState = state.completedAt === undefined ? "ARCHIVED_INCOMPLETE" : "ARCHIVED_COMPLETED";
  }

  return {
    sessionStatus: state.status,
    completionState,
    totalTurns
  };
}

function getActiveEvidence(
  activeEvidence: ReadonlyMap<string, EvidenceRecordState>,
  problemId: string,
  subject: EvidenceKey["subject"],
  dimension: EvidenceKey["dimension"]
): EvidenceRecordState | undefined {
  return activeEvidence.get(
    evidenceKeyToString({
      problemId,
      subject,
      dimension
    })
  );
}

function findTurnForEvidence(
  records: readonly EvidenceRecordState[],
  verificationByEvidenceKey: ReadonlyMap<string, readonly VerificationRequestState[]>
): MilestoneEvaluation["achievedAtTurnId"] | undefined {
  const candidates = records.flatMap((record) =>
    (verificationByEvidenceKey.get(evidenceKeyToString(record.key)) ?? [])
      .filter((request) => request.status === "ACCEPTED")
  );
  const latest = [...candidates].sort(
    (left, right) =>
      right.basis.committedInputSequence - left.basis.committedInputSequence ||
      right.verificationRequestId.localeCompare(left.verificationRequestId)
  )[0];
  return latest?.basis.turnId;
}

function correctnessRatingScore(value: EvidenceRecordState["value"]["value"]): number | null {
  if (value === "CORRECT") return 100;
  if (value === "LOCAL_ERROR") return 50;
  if (value === "STRUCTURAL_ERROR") return 0;
  return null;
}

function rigorRatingScore(value: EvidenceRecordState["value"]["value"]): number | null {
  if (value === "JUSTIFIED") return 100;
  if (value === "INCOMPLETE") return 50;
  if (value === "UNJUSTIFIED") return 0;
  return null;
}

function independenceScoreForLevel(level: DisclosureLevel): number {
  if (level === 0) return 100;
  if (level === 1) return 90;
  if (level === 2) return 75;
  if (level === 3) return 55;
  if (level === 4) return 30;
  return 10;
}

function supportFromEvidenceRecords(
  records: readonly EvidenceRecordState[],
  verifierBacked: boolean
): EvaluationSupportLevel {
  if (records.length === 0) return "INSUFFICIENT";
  return supportFromCount(
    records.length,
    Math.min(...records.map((record) => record.value.inferenceConfidence)),
    verifierBacked
  );
}

function supportFromCount(
  count: number,
  minimumConfidence: number,
  verifierBacked: boolean
): EvaluationSupportLevel {
  if (count <= 0) return "INSUFFICIENT";
  if (count === 1) {
    return verifierBacked && minimumConfidence >= 0.8 ? "MODERATE" : "WEAK";
  }
  if (count === 2) {
    return minimumConfidence >= 0.5 ? "MODERATE" : "WEAK";
  }
  return minimumConfidence >= 0.8 || verifierBacked ? "STRONG" : "MODERATE";
}

function aggregateSampleSupport(
  supportLevels: readonly EvaluationSupportLevel[]
): EvaluationSupportLevel {
  if (supportLevels.length === 0) return "INSUFFICIENT";

  const weakest = supportLevels.reduce<EvaluationSupportLevel>(
    (current, next) => minSupport(current, next),
    "STRONG"
  );
  if (weakest === "INSUFFICIENT" || weakest === "WEAK") return weakest;

  if (supportLevels.length >= 3 && supportLevels.some((level) => level === "STRONG")) {
    return "STRONG";
  }
  return "MODERATE";
}

function maxSupport(
  left: EvaluationSupportLevel,
  right: EvaluationSupportLevel
): EvaluationSupportLevel {
  return SUPPORT_RANK[left] >= SUPPORT_RANK[right] ? left : right;
}

function downgradeSupport(level: EvaluationSupportLevel): EvaluationSupportLevel {
  if (level === "STRONG") return "MODERATE";
  if (level === "MODERATE") return "WEAK";
  return level;
}

function minSupport(
  left: EvaluationSupportLevel,
  right: EvaluationSupportLevel
): EvaluationSupportLevel {
  return SUPPORT_RANK[left] <= SUPPORT_RANK[right] ? left : right;
}

function scoredDimension(
  score: number,
  supportLevel: EvaluationSupportLevel,
  evidenceRefs: readonly EvaluationEvidenceRef[]
): EvaluationDimensionResult {
  if (supportLevel === "INSUFFICIENT") {
    throw new Error("A scored evaluation dimension cannot have insufficient support");
  }
  return {
    score,
    supportLevel,
    evidenceRefs: uniqueRefs(evidenceRefs)
  };
}

function unsupportedDimension(
  reason: string,
  evidenceRefs: readonly EvaluationEvidenceRef[] = []
): EvaluationDimensionResult {
  return {
    score: null,
    supportLevel: "INSUFFICIENT",
    evidenceRefs: uniqueRefs(evidenceRefs),
    notScoredReason: reason
  };
}

function evaluationRef(
  kind: EvaluationEvidenceRef["kind"],
  id: string
): EvaluationEvidenceRef {
  return { kind, id };
}

function uniqueRefs(
  refs: readonly EvaluationEvidenceRef[]
): EvaluationEvidenceRef[] {
  const byKey = new Map<string, EvaluationEvidenceRef>();
  for (const ref of refs) {
    byKey.set(ref.kind + ":" + ref.id, ref);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
  );
}

function subjectKey(key: EvidenceKey): string {
  const subject = key.subject;
  if (subject.kind === "CLAIM") return "CLAIM:" + subject.claimId;
  if (subject.kind === "MILESTONE") return "MILESTONE:" + subject.milestoneId;
  if (subject.kind === "SKILL") return "SKILL:" + subject.skillId;
  return "APPROACH:" + subject.approachId;
}

function roundScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function generateEvaluationMarkdown(evaluation: SessionEvaluation): string {
  const scoreText = (score: number | null): string =>
    score === null ? "Not scored" : String(score) + "%";
  const weightText = (weight: number): string =>
    String(Math.round(weight * 100)) + "%";

  const milestoneRows = evaluation.milestones.map((milestone) =>
    "| " +
    milestone.milestoneId +
    " | " +
    milestone.description +
    " | " +
    (milestone.achieved ? "Achieved" : "Incomplete") +
    " | Level " +
    String(milestone.assistanceLevel) +
    " | " +
    milestone.supportLevel +
    " |"
  );

  const interventionRows =
    evaluation.disclosedInterventions.length === 0
      ? ["No exposed or possibly exposed protected assistance was recorded."]
      : [
          "| Delivery ID | Level | Status | Related milestones |",
          "| :--- | :---: | :---: | :--- |",
          ...evaluation.disclosedInterventions.map((item) =>
            "| " +
            item.deliveryId +
            " | " +
            String(item.disclosureLevel) +
            " | " +
            item.deliveryStatus +
            " | " +
            (item.relatedMilestoneIds.join(", ") || "none") +
            " |"
          )
        ];

  const strengths =
    evaluation.keyStrengths.length === 0
      ? ["- No strength statement is emitted without grounded support."]
      : evaluation.keyStrengths.map((item) => "- " + item);
  const improvements =
    evaluation.areasForImprovement.length === 0
      ? ["- No improvement claim is emitted without grounded support."]
      : evaluation.areasForImprovement.map((item) => "- " + item);

  return [
    "# Technical Interview Evaluation Report",
    "",
    "**Session ID**: " + evaluation.sessionId,
    "",
    "**Problem**: " + evaluation.problemId + " (v" + evaluation.problemVersion + ")",
    "",
    "**Evaluated At**: " + evaluation.evaluatedAt,
    "",
    "**Composite**: " +
      (evaluation.scores.compositeScore === null
        ? "Not scored"
        : String(evaluation.scores.compositeScore) + " / 100") +
      " (" +
      evaluation.composite.status +
      ", support " +
      evaluation.composite.supportLevel +
      ")",
    "",
    "## 1. Executive Summary",
    "",
    evaluation.summaryAssessment,
    "",
    "## 2. Performance Breakdown",
    "",
    "| Dimension | Score | Support | Rubric weight |",
    "| :--- | :---: | :---: | :---: |",
    "| Technical Correctness | " +
      scoreText(evaluation.scores.technicalCorrectness) +
      " | " +
      evaluation.dimensionResults.technicalCorrectness.supportLevel +
      " | " +
      weightText(evaluation.rubric.correctnessWeight) +
      " |",
    "| Mathematical Rigor | " +
      scoreText(evaluation.scores.rigor) +
      " | " +
      evaluation.dimensionResults.rigor.supportLevel +
      " | " +
      weightText(evaluation.rubric.rigorWeight) +
      " |",
    "| Independence | " +
      scoreText(evaluation.scores.independence) +
      " | " +
      evaluation.dimensionResults.independence.supportLevel +
      " | " +
      weightText(evaluation.rubric.independenceWeight) +
      " |",
    "| Communication | " +
      scoreText(evaluation.scores.communication) +
      " | " +
      evaluation.dimensionResults.communication.supportLevel +
      " | " +
      weightText(evaluation.rubric.communicationWeight) +
      " |",
    "| Error Recovery | " +
      scoreText(evaluation.scores.errorRecovery) +
      " | " +
      evaluation.dimensionResults.errorRecovery.supportLevel +
      " | " +
      weightText(evaluation.rubric.errorRecoveryWeight) +
      " |",
    "| Hint Responsiveness | " +
      scoreText(evaluation.scores.hintResponsiveness) +
      " | " +
      evaluation.dimensionResults.hintResponsiveness.supportLevel +
      " | not in composite |",
    "",
    "## 3. Milestone Progression",
    "",
    "| Milestone ID | Description | Status | Assistance | Support |",
    "| :--- | :--- | :---: | :---: | :---: |",
    ...milestoneRows,
    "",
    "## 4. Authoritative Disclosure Ledger",
    "",
    ...interventionRows,
    "",
    "## 5. Grounded Feedback",
    "",
    "### Key Strengths",
    ...strengths,
    "",
    "### Areas for Growth",
    ...improvements,
    ""
  ].join("\n");
}

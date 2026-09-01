import {
  EvaluationRubricSchema,
  SessionEvaluationSchema,
  assertReasoningGraphIntegrity,
  evidenceKeyToString,
  isDisclosedStatus,
  isEvidenceValueAllowed,
  type CompositeDimensionName,
  type DisclosureId,
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
import { createProviderContextSpecFingerprintSync } from "./context-compiler.js";

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
  disclosureRefs: 50_000,
  reasoningEdges: 50_000,
  approaches: 10_000,
  protectedDisclosures: 20_000,
  events: 250_000,
  evidenceProvenanceRefs: 150_000,
  verificationProvenanceRefs: 100_000,
  reasoningRefs: 100_000,
  problemFingerprintCharacters: 2_000_000,
  problemAuxiliaryItems: 100_000
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
  readonly disclosureId: DisclosureId;
  readonly level: DisclosureLevel;
  readonly deliveryRefs: readonly EvaluationEvidenceRef[];
}

interface MilestoneFacts {
  readonly evaluation: MilestoneEvaluation;
  readonly attributionUncertain: boolean;
  readonly assistanceExposureRefs: readonly EvaluationEvidenceRef[];
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
  assertEvaluationStateConsistency(state, problem);

  const rubric = EvaluationRubricSchema.parse({
    ...DEFAULT_RUBRIC,
    ...customRubric
  });

  const totalTurns = Object.keys(state.turns).length;

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
    state.contextEpoch
  );
  const rigor = evaluateRigor(
    problem,
    activeEvidence,
    verificationByEvidenceKey,
    state.contextEpoch
  );
  const independence = evaluateIndependence(
    milestoneFacts,
    disclosureData.unattributedAssistanceRefs
  );
  const communication = unsupportedDimension(
    "Current application-owned evidence does not contain a validated communication-quality signal."
  );
  const hintResponsiveness = evaluateHintResponsiveness();
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
    errorRecovery
  );
  const lifecycle = evaluateLifecycle(state, totalTurns);
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
    totalTurns,
    keyStrengths,
    areasForImprovement,
    summaryAssessment
  });
}

function assertProblemIdentity(
  state: Readonly<SessionState>,
  problem: InterviewProblem
): void {
  assertReasoningGraphIntegrity(problem.interviewer.reasoningGraph);
  assertProblemDefinitionUniqueness(problem);

  if (state.problem === undefined) {
    const hasAuthoritativeActivity =
      state.started ||
      state.status !== "CREATED" ||
      Object.keys(state.turns).length > 0 ||
      Object.keys(state.evidenceHistory).length > 0 ||
      Object.keys(state.deliveries).length > 0 ||
      Object.keys(state.verificationRequests).length > 0;
    if (hasAuthoritativeActivity) {
      throw new Error("Evaluation cannot score authoritative session activity without a session-bound problem");
    }
    return;
  }

  if (state.problem.id !== problem.id || state.problem.version !== problem.version) {
    throw new Error("Evaluation problem identity does not match the authoritative session state");
  }
  if (state.problem.prompt !== problem.public.prompt) {
    throw new Error("Evaluation problem prompt does not match the authoritative session state");
  }
  if (state.problem.providerContextSpecSha256 === undefined) {
    throw new Error("Evaluation problem definition provenance is unavailable");
  }
  if (createProviderContextSpecFingerprintSync(problem) !== state.problem.providerContextSpecSha256) {
    throw new Error("Evaluation problem definition does not match the session-bound problem fingerprint");
  }
}

function assertProblemDefinitionUniqueness(problem: InterviewProblem): void {
  const graph = problem.interviewer.reasoningGraph;
  assertUniqueStrings(
    graph.approaches.map((approach) => approach.id),
    "reasoning-graph approach"
  );
  assertUniqueStrings(
    graph.milestones.map((milestone) => milestone.id),
    "reasoning-graph milestone"
  );
  assertUniqueStrings(
    problem.interviewer.protectedDisclosures.map((disclosure) => disclosure.id),
    "protected-disclosure"
  );

  const protectedDisclosureIds = new Set(
    problem.interviewer.protectedDisclosures.map((disclosure) => disclosure.id)
  );
  for (const milestone of graph.milestones) {
    assertUniqueStrings(milestone.approachIds, "milestone approach reference");
    assertUniqueStrings(
      milestone.optionalPrerequisiteIds,
      "milestone optional-prerequisite reference"
    );
    assertUniqueStrings(
      milestone.protectedDisclosureIds,
      "milestone protected-disclosure reference"
    );
    for (const disclosureId of milestone.protectedDisclosureIds) {
      if (!protectedDisclosureIds.has(disclosureId)) {
        throw new Error("Evaluation reasoning graph references an unknown protected disclosure");
      }
    }
  }

  const edgeKeys = graph.edges.map((edge) => JSON.stringify([edge.from, edge.to]));
  assertUniqueStrings(edgeKeys, "reasoning-graph edge");
}

function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error("Evaluation problem contains duplicate " + label + " identities");
  }
}

function assertEvaluationStateConsistency(
  state: Readonly<SessionState>,
  problem: InterviewProblem
): void {
  const milestoneIds = new Set(
    problem.interviewer.reasoningGraph.milestones.map((milestone) => milestone.id)
  );
  const approachIds = new Set(
    problem.interviewer.reasoningGraph.approaches.map((approach) => approach.id)
  );
  const activeByKey = new Map<string, EvidenceRecordState>();
  const seenEvidenceEventIds = new Set<string>();
  const authoritativeEventIds = new Set(state.eventIds);
  if (authoritativeEventIds.size !== state.eventIds.length) {
    throw new Error("Evaluation authoritative event history contains duplicate event identities");
  }

  for (const [turnId, turn] of Object.entries(state.turns)) {
    if (turn.turnId !== turnId) {
      throw new Error("Evaluation turn identity does not match its state key");
    }
  }
  for (const [generationId, generation] of Object.entries(state.generations)) {
    if (generation.generationId !== generationId) {
      throw new Error("Evaluation generation identity does not match its state key");
    }
  }
  const protectedDisclosureById = new Map(
    problem.interviewer.protectedDisclosures.map((disclosure) => [disclosure.id, disclosure] as const)
  );
  if (protectedDisclosureById.size !== problem.interviewer.protectedDisclosures.length) {
    throw new Error("Evaluation problem contains duplicate protected-disclosure identities");
  }

  for (const [storedKey, history] of Object.entries(state.evidenceHistory)) {
    if (history.length === 0) {
      throw new Error("Evaluation evidence history cannot contain an empty history");
    }

    let previousSequence = 0;
    for (const [recordIndex, record] of history.entries()) {
      const canonicalKey = evidenceKeyToString(record.key);
      if (canonicalKey !== storedKey) {
        throw new Error("Evaluation evidence history key does not match its scoped evidence record");
      }
      if (seenEvidenceEventIds.has(record.evidenceEventId)) {
        throw new Error("Evaluation evidence history reuses an evidence-event identity");
      }
      seenEvidenceEventIds.add(record.evidenceEventId);
      if (!authoritativeEventIds.has(record.evidenceEventId)) {
        throw new Error("Evaluation evidence record references a non-authoritative evidence event");
      }
      if (
        record.value.evidenceEventIds.some(
          (eventId) => !authoritativeEventIds.has(eventId)
        )
      ) {
        throw new Error("Evaluation evidence provenance references an unknown authoritative event");
      }
      if (!isEvidenceValueAllowed(record.key, record.value.value)) {
        throw new Error("Evaluation evidence record contains a value invalid for its dimension");
      }
      if (
        !Number.isFinite(record.value.inferenceConfidence) ||
        record.value.inferenceConfidence < 0 ||
        record.value.inferenceConfidence > 1
      ) {
        throw new Error("Evaluation evidence record has invalid inference confidence");
      }
      if (record.value.evidenceEventIds.length === 0) {
        throw new Error("Evaluation evidence record has no provenance references");
      }
      if (
        !Number.isSafeInteger(record.value.lastUpdatedSequence) ||
        record.value.lastUpdatedSequence <= 0 ||
        record.value.lastUpdatedSequence > state.sequence
      ) {
        throw new Error("Evaluation evidence record sequence is outside authoritative session bounds");
      }
      if (record.value.lastUpdatedSequence <= previousSequence) {
        throw new Error("Evaluation evidence history is not strictly chronological");
      }
      previousSequence = record.value.lastUpdatedSequence;

      const nextRecord = history[recordIndex + 1];
      if (record.status === "ACTIVE") {
        if (recordIndex !== history.length - 1) {
          throw new Error("Evaluation active evidence must be the final record in its history");
        }
        if (
          record.supersededByEventId !== undefined ||
          record.invalidationReason !== undefined
        ) {
          throw new Error("Evaluation active evidence cannot carry terminal history metadata");
        }
      } else if (record.status === "SUPERSEDED") {
        if (
          record.supersededByEventId === undefined ||
          nextRecord?.evidenceEventId !== record.supersededByEventId
        ) {
          throw new Error("Evaluation superseded evidence must identify the next replacement record");
        }
        if (record.invalidationReason !== undefined) {
          throw new Error("Evaluation superseded evidence cannot carry an invalidation reason");
        }
      } else {
        if (record.invalidationReason === undefined) {
          throw new Error("Evaluation stale evidence must retain an invalidation reason");
        }
        if (record.supersededByEventId !== undefined) {
          throw new Error("Evaluation stale evidence cannot point to a superseding record");
        }
      }

      if (record.key.problemId === problem.id) {
        if (
          record.key.subject.kind === "MILESTONE" &&
          !milestoneIds.has(record.key.subject.milestoneId)
        ) {
          throw new Error("Evaluation evidence references an unknown reasoning-graph milestone");
        }
        if (
          record.key.subject.kind === "APPROACH" &&
          !approachIds.has(record.key.subject.approachId)
        ) {
          throw new Error("Evaluation evidence references an unknown reasoning-graph approach");
        }
      }

      if (record.status === "ACTIVE") {
        if (activeByKey.has(storedKey)) {
          throw new Error("Evaluation encountered multiple active records for one evidence key");
        }
        activeByKey.set(storedKey, record);
      }
    }
  }

  for (const [key, active] of activeByKey) {
    const projected = state.studentEvidence[key];
    if (projected === undefined || !evidenceValuesEqual(projected, active.value)) {
      throw new Error("Evaluation active evidence does not match the authoritative student-evidence projection");
    }
  }
  for (const key of Object.keys(state.studentEvidence)) {
    if (!activeByKey.has(key)) {
      throw new Error("Evaluation student-evidence projection has no matching active history record");
    }
  }

  for (const [requestId, request] of Object.entries(state.verificationRequests)) {
    if (request.verificationRequestId !== requestId) {
      throw new Error("Evaluation verification-request identity does not match its state key");
    }
    if (!authoritativeEventIds.has(request.requestedEventId)) {
      throw new Error("Evaluation verification request references a non-authoritative request event");
    }
    if (
      request.evidenceEventIds.some(
        (eventId) => !authoritativeEventIds.has(eventId)
      )
    ) {
      throw new Error("Evaluation verification request provenance references an unknown authoritative event");
    }
    if (request.status === "ACCEPTED") {
      if (request.result === undefined) {
        throw new Error("Evaluation accepted verification request is missing its result");
      }
      if (
        request.result.verifier !== request.verifier ||
        request.result.interpretationConfidence !== request.interpretationConfidence
      ) {
        throw new Error("Evaluation accepted verification result does not match its request");
      }
    } else if (request.result !== undefined) {
      throw new Error("Evaluation non-accepted verification request cannot contain an accepted result");
    }
    if (request.evidenceKey.problemId === problem.id) {
      if (
        request.evidenceKey.subject.kind !== "CLAIM" ||
        request.evidenceKey.dimension !== "CORRECTNESS"
      ) {
        throw new Error("Evaluation verification evidence must be scoped to claim correctness");
      }
    }
  }

  const exposedDisclosureIds = new Set<DisclosureId>();
  for (const [deliveryId, delivery] of Object.entries(state.deliveries)) {
    if (delivery.deliveryId !== deliveryId) {
      throw new Error("Evaluation delivery identity does not match its state key");
    }
    if (state.generations[delivery.generationId] === undefined) {
      throw new Error("Evaluation delivery references an unknown generation");
    }

    let minimumRequiredLevel: DisclosureLevel = 0;
    for (const disclosureId of delivery.disclosureIds) {
      const disclosure = protectedDisclosureById.get(disclosureId);
      if (disclosure === undefined) {
        throw new Error("Evaluation delivery references a disclosure outside the exact problem definition");
      }
      if (disclosure.minimumDisclosureLevel > minimumRequiredLevel) {
        minimumRequiredLevel = disclosure.minimumDisclosureLevel;
      }
      if (isDisclosedStatus(delivery.status)) exposedDisclosureIds.add(disclosureId);
    }
    if (delivery.effectiveDisclosureLevel < minimumRequiredLevel) {
      throw new Error("Evaluation delivery understates the problem-defined disclosure level");
    }
  }

  const ledgerIds = new Set(state.disclosureLedger);
  if (ledgerIds.size !== state.disclosureLedger.length) {
    throw new Error("Evaluation disclosure ledger contains duplicate disclosure identities");
  }
  if (
    ledgerIds.size !== exposedDisclosureIds.size ||
    [...ledgerIds].some((disclosureId) => !exposedDisclosureIds.has(disclosureId))
  ) {
    throw new Error("Evaluation disclosure ledger does not match exposed delivery state");
  }

  if (state.status === "CREATED") {
    if (state.started) {
      throw new Error("Evaluation created session cannot be marked started");
    }
    if (state.completedAt !== undefined || state.archivedAt !== undefined) {
      throw new Error("Evaluation created session cannot contain terminal timestamps");
    }
  } else if (!state.started) {
    throw new Error("Evaluation non-created session must be marked started");
  }

  if (state.status === "ACTIVE") {
    if (state.completedAt !== undefined || state.archivedAt !== undefined) {
      throw new Error("Evaluation active session cannot contain terminal timestamps");
    }
  } else if (state.status === "COMPLETED") {
    if (state.completedAt === undefined) {
      throw new Error("Evaluation completed session is missing its completion timestamp");
    }
    if (state.archivedAt !== undefined) {
      throw new Error("Evaluation completed session cannot contain an archival timestamp");
    }
  } else if (state.status === "ARCHIVED" && state.archivedAt === undefined) {
    throw new Error("Evaluation archived session is missing its archival timestamp");
  }
}

function evidenceValuesEqual(
  left: EvidenceRecordState["value"],
  right: EvidenceRecordState["value"]
): boolean {
  return left.value === right.value &&
    left.inferenceConfidence === right.inferenceConfidence &&
    left.lastUpdatedSequence === right.lastUpdatedSequence &&
    left.evidenceEventIds.length === right.evidenceEventIds.length &&
    left.evidenceEventIds.every((eventId, index) => eventId === right.evidenceEventIds[index]);
}

function assertEvaluationInputBounds(
  state: Readonly<SessionState>,
  problem: InterviewProblem
): void {
  const turnCount = Object.keys(state.turns).length;
  if (turnCount > LIMITS.turns) {
    throw new Error("Evaluation input exceeds the supported turn bound");
  }
  if (state.eventIds.length > LIMITS.events) {
    throw new Error("Evaluation input exceeds the supported authoritative-event bound");
  }

  let evidenceRecordCount = 0;
  let evidenceProvenanceRefCount = 0;
  for (const history of Object.values(state.evidenceHistory)) {
    evidenceRecordCount += history.length;
    if (evidenceRecordCount > LIMITS.evidenceRecords) {
      throw new Error("Evaluation input exceeds the supported evidence-history bound");
    }
    for (const record of history) {
      evidenceProvenanceRefCount += record.value.evidenceEventIds.length;
      if (evidenceProvenanceRefCount > LIMITS.evidenceProvenanceRefs) {
        throw new Error("Evaluation input exceeds the supported evidence-provenance bound");
      }
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
  let verificationProvenanceRefCount = 0;
  for (const request of Object.values(state.verificationRequests)) {
    verificationProvenanceRefCount += request.evidenceEventIds.length;
    if (verificationProvenanceRefCount > LIMITS.verificationProvenanceRefs) {
      throw new Error("Evaluation input exceeds the supported verification-provenance bound");
    }
  }

  if (problem.interviewer.reasoningGraph.milestones.length > LIMITS.milestones) {
    throw new Error("Evaluation input exceeds the supported milestone bound");
  }
  if (problem.interviewer.reasoningGraph.edges.length > LIMITS.reasoningEdges) {
    throw new Error("Evaluation input exceeds the supported reasoning-edge bound");
  }
  if (problem.interviewer.reasoningGraph.approaches.length > LIMITS.approaches) {
    throw new Error("Evaluation input exceeds the supported approach bound");
  }
  if (problem.interviewer.protectedDisclosures.length > LIMITS.protectedDisclosures) {
    throw new Error("Evaluation input exceeds the supported protected-disclosure bound");
  }

  let reasoningRefCount = 0;
  for (const milestone of problem.interviewer.reasoningGraph.milestones) {
    reasoningRefCount +=
      milestone.approachIds.length +
      milestone.optionalPrerequisiteIds.length +
      milestone.protectedDisclosureIds.length;
    if (reasoningRefCount > LIMITS.reasoningRefs) {
      throw new Error("Evaluation input exceeds the supported reasoning-reference bound");
    }
  }

  let auxiliaryItemCount =
    problem.public.givenInformation.length +
    problem.interviewer.topics.length +
    problem.interviewer.reasoningGraph.commonErrors.length +
    problem.interviewer.reasoningGraph.extensions.length;
  if (auxiliaryItemCount > LIMITS.problemAuxiliaryItems) {
    throw new Error("Evaluation problem exceeds the supported auxiliary-item bound");
  }
  for (const disclosure of problem.interviewer.protectedDisclosures) {
    auxiliaryItemCount += disclosure.equivalentFormulations.length;
    if (auxiliaryItemCount > LIMITS.problemAuxiliaryItems) {
      throw new Error("Evaluation problem exceeds the supported auxiliary-item bound");
    }
  }

  if (problemFingerprintCharacterCount(problem) > LIMITS.problemFingerprintCharacters) {
    throw new Error("Evaluation problem exceeds the supported fingerprint-input bound");
  }

  let disclosureRefCount = 0;
  for (const delivery of Object.values(state.deliveries)) {
    disclosureRefCount += delivery.disclosureIds.length;
    if (disclosureRefCount > LIMITS.disclosureRefs) {
      throw new Error("Evaluation input exceeds the supported disclosure-reference bound");
    }
  }
}

function problemFingerprintCharacterCount(problem: InterviewProblem): number {
  let count = problem.id.length +
    problem.version.length +
    problem.public.prompt.length +
    problem.interviewer.difficulty.length +
    problem.interviewer.reasoningGraph.version.length;

  for (const value of problem.public.givenInformation) count += value.length;
  for (const value of problem.interviewer.topics) count += value.length;
  for (const approach of problem.interviewer.reasoningGraph.approaches) {
    count += approach.id.length + approach.label.length;
  }
  for (const milestone of problem.interviewer.reasoningGraph.milestones) {
    count += milestone.id.length + milestone.description.length;
    for (const value of milestone.approachIds) count += value.length;
    for (const value of milestone.optionalPrerequisiteIds) count += value.length;
    for (const value of milestone.protectedDisclosureIds) count += value.length;
  }
  for (const edge of problem.interviewer.reasoningGraph.edges) {
    count += edge.from.length + edge.to.length;
  }
  for (const error of problem.interviewer.reasoningGraph.commonErrors) {
    count += error.id.length + error.description.length;
  }
  for (const extension of problem.interviewer.reasoningGraph.extensions) {
    count += extension.id.length + extension.prompt.length;
  }
  for (const disclosure of problem.interviewer.protectedDisclosures) {
    count += disclosure.id.length + disclosure.fact.length;
    for (const formulation of disclosure.equivalentFormulations) {
      count += formulation.length;
    }
  }
  return count;
}

function collectActiveEvidence(
  state: Readonly<SessionState>,
  problemId: string
): ReadonlyMap<string, EvidenceRecordState> {
  const active = new Map<string, EvidenceRecordState>();
  const histories = Object.entries(state.evidenceHistory).sort(([left], [right]) =>
    compareStrings(left, right)
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
  const eventOrder = new Map(
    state.eventIds.map((eventId, index) => [eventId, index] as const)
  );
  const accepted = Object.values(state.verificationRequests)
    .filter(
      (request) =>
        request.status === "ACCEPTED" &&
        request.result !== undefined &&
        request.evidenceKey.problemId === problemId
    )
    .sort(
      (left, right) =>
        requireEventOrder(eventOrder, left.requestedEventId) -
          requireEventOrder(eventOrder, right.requestedEventId) ||
        compareStrings(left.verificationRequestId, right.verificationRequestId)
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
  readonly exposuresByDisclosureId: ReadonlyMap<DisclosureId, DisclosureExposure>;
  readonly unattributedAssistanceRefs: readonly EvaluationEvidenceRef[];
} {
  const disclosureToMilestones = new Map<DisclosureId, string[]>();
  const disclosureLevelById = new Map(
    problem.interviewer.protectedDisclosures.map(
      (disclosure) => [disclosure.id, disclosure.minimumDisclosureLevel] as const
    )
  );
  for (const milestone of problem.interviewer.reasoningGraph.milestones) {
    for (const disclosureId of milestone.protectedDisclosureIds) {
      const current = disclosureToMilestones.get(disclosureId) ?? [];
      current.push(milestone.id);
      disclosureToMilestones.set(disclosureId, current);
    }
  }

  const exposuresMutable = new Map<DisclosureId, {
    level: DisclosureLevel;
    deliveryRefs: EvaluationEvidenceRef[];
  }>();

  const interventions: DisclosedInterventionRecord[] = [];
  const unattributedAssistanceRefs: EvaluationEvidenceRef[] = [];
  const deliveries = Object.values(state.deliveries)
    .filter((delivery) => isDisclosedStatus(delivery.status))
    .sort((left, right) => compareStrings(left.deliveryId, right.deliveryId));

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
      delivery.status === "POSSIBLY_EXPOSED"
        ? "POSSIBLY_EXPOSED" as const
        : delivery.status === "COMPLETED"
          ? "COMPLETED" as const
          : "EXPOSED" as const;
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

    if (
      delivery.effectiveDisclosureLevel > 0 &&
      relatedMilestoneIds.length === 0
    ) {
      unattributedAssistanceRefs.push(evaluationRef("DELIVERY", delivery.deliveryId));
    }

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
      const disclosureLevel = disclosureLevelById.get(disclosureId);
      if (disclosureLevel === undefined) {
        throw new Error("Evaluation cannot attribute an unknown protected disclosure");
      }

      const current = exposuresMutable.get(disclosureId);
      const deliveryRef = evaluationRef("DELIVERY", delivery.deliveryId);
      if (current === undefined) {
        exposuresMutable.set(disclosureId, {
          level: disclosureLevel,
          deliveryRefs: [deliveryRef]
        });
      } else {
        current.level = Math.max(current.level, disclosureLevel) as DisclosureLevel;
        current.deliveryRefs.push(deliveryRef);
      }
    }
  }

  const exposures = new Map<DisclosureId, DisclosureExposure>();
  for (const [disclosureId, exposure] of exposuresMutable) {
    exposures.set(disclosureId, {
      disclosureId,
      level: exposure.level,
      deliveryRefs: uniqueRefs(exposure.deliveryRefs)
    });
  }

  return {
    interventions,
    exposuresByDisclosureId: exposures,
    unattributedAssistanceRefs: uniqueRefs(unattributedAssistanceRefs)
  };
}

function evaluateMilestones(
  problem: InterviewProblem,
  activeEvidence: ReadonlyMap<string, EvidenceRecordState>,
  verificationByEvidenceKey: ReadonlyMap<string, readonly VerificationRequestState[]>,
  exposuresByDisclosureId: ReadonlyMap<DisclosureId, DisclosureExposure>
): readonly MilestoneFacts[] {
  const graph = problem.interviewer.reasoningGraph;
  const milestoneById = new Map(graph.milestones.map((milestone) => [milestone.id, milestone] as const));
  const base = new Map<string, {
    achieved: boolean;
    supportLevel: EvaluationSupportLevel;
    evidenceRefs: EvaluationEvidenceRef[];
    notAchievedReason?: string;
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
    const incompleteSupport =
      correctness?.value.value === "UNKNOWN" ||
      understanding?.value.value === "PARTIAL" ||
      justification?.value.value === "INCOMPLETE" ||
      justification?.value.value === "UNJUSTIFIED";

    const evidenceRefs = uniqueRefs(
      records.flatMap((record) => [
        evaluationRef("EVIDENCE_EVENT", record.evidenceEventId),
        ...record.value.evidenceEventIds.map((eventId) =>
          evaluationRef("EVIDENCE_EVENT", eventId)
        )
      ])
    );

    const relevantVerificationRequests = records.flatMap((record) =>
      supportingVerificationRequests(record, verificationByEvidenceKey)
    );
    for (const request of relevantVerificationRequests) {
      evidenceRefs.push(evaluationRef("VERIFICATION_REQUEST", request.verificationRequestId));
    }

    let supportLevel = supportFromEvidenceRecords(records, relevantVerificationRequests.length > 0);
    if (achieved && incompleteSupport) {
      supportLevel = minSupport(supportLevel, "WEAK");
    }

    base.set(milestone.id, {
      achieved,
      supportLevel,
      evidenceRefs: uniqueRefs([
        evaluationRef("MILESTONE", milestone.id),
        ...evidenceRefs
      ]),
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
    const assistanceDisclosureIds: DisclosureId[] = [];
    const assistanceExposureRefs: EvaluationEvidenceRef[] = [];
    let attributionUncertain = false;

    for (const disclosureId of milestone.protectedDisclosureIds) {
      const exposure = exposuresByDisclosureId.get(disclosureId);
      if (exposure === undefined) continue;

      attributionUncertain = true;
      assistanceLevel = Math.max(assistanceLevel, exposure.level) as DisclosureLevel;
      assistanceDisclosureIds.push(disclosureId);
      assistanceExposureRefs.push(...exposure.deliveryRefs);
    }

    if (attributionUncertain && assistanceLevel > 0) {
      supportLevel = minSupport(supportLevel, "WEAK");
    }

    const evaluation: MilestoneEvaluation = {
      milestoneId: milestone.id,
      description: milestone.description,
      achieved: baseResult.achieved,
      assistanceLevel,
      supportLevel,
      evidenceRefs: uniqueRefs([
        ...baseResult.evidenceRefs,
        ...assistanceExposureRefs
      ]),
      assistanceDisclosureIds: Array.from(new Set(assistanceDisclosureIds)).sort(),
      approachIds: [...milestone.approachIds].sort(),
      ...(baseResult.notAchievedReason === undefined
        ? {}
        : { notAchievedReason: baseResult.notAchievedReason })
    };

    facts.push({
      evaluation,
      attributionUncertain,
      assistanceExposureRefs: uniqueRefs(assistanceExposureRefs)
    });
  }

  return facts;
}

function evaluateTechnicalCorrectness(
  activeEvidence: ReadonlyMap<string, EvidenceRecordState>,
  verificationByEvidenceKey: ReadonlyMap<string, readonly VerificationRequestState[]>,
  currentContextEpoch: SessionState["contextEpoch"]
): DimensionComputation {
  const sampleBySubject = new Map<string, {
    score: number;
    supportLevel: EvaluationSupportLevel;
    refs: EvaluationEvidenceRef[];
    positive: boolean;
    negative: boolean;
  }>();
  const activeCorrectnessKeys = new Set<string>();
  const unresolvedRefs: EvaluationEvidenceRef[] = [];
  let unresolvedCount = 0;

  for (const record of activeEvidence.values()) {
    if (record.key.dimension !== "CORRECTNESS") continue;

    const key = evidenceKeyToString(record.key);
    activeCorrectnessKeys.add(key);
    const recordRefs = uniqueRefs([
      evaluationRef("EVIDENCE_EVENT", record.evidenceEventId),
      ...record.value.evidenceEventIds.map((id) => evaluationRef("EVIDENCE_EVENT", id))
    ]);
    const currentRequests = currentVerificationRequests(
      verificationByEvidenceKey.get(key) ?? [],
      currentContextEpoch
    );
    const supportingVerifications = supportingVerificationRequests(
      record,
      verificationByEvidenceKey
    ).filter((request) => request.result?.status === "VERIFIED");
    const contradictions = currentRequests.filter(
      (request) => request.result?.status === "CONTRADICTED"
    );
    const unresolved = currentRequests.filter(
      (request) => request.result?.status === "UNRESOLVED"
    );
    const verificationRefs = uniqueRefs([
      ...supportingVerifications,
      ...contradictions,
      ...unresolved
    ].map((request) =>
      evaluationRef("VERIFICATION_REQUEST", request.verificationRequestId)
    ));

    const baseScore = correctnessRatingScore(record.value.value);
    const positiveConflict = baseScore === 100 && contradictions.length > 0;
    const unresolvedVerifierConflict =
      baseScore === null &&
      contradictions.length > 0 &&
      unresolved.length > 0;
    if (positiveConflict || unresolvedVerifierConflict) {
      unresolvedCount += 1;
      unresolvedRefs.push(...recordRefs, ...verificationRefs);
      continue;
    }

    let score = baseScore;
    let supportLevel = supportFromCount(
      1,
      record.value.inferenceConfidence,
      supportingVerifications.length > 0
    );

    if (contradictions.length > 0) {
      score = 0;
      supportLevel = maxSupport(
        supportLevel,
        supportFromCount(
          1,
          minimumNumber(
            contradictions.map(
              (request) => request.result?.interpretationConfidence ?? 0
            )
          ),
          true
        )
      );
    }

    if (unresolved.length > 0) {
      unresolvedCount += 1;
      unresolvedRefs.push(...unresolved.map((request) =>
        evaluationRef("VERIFICATION_REQUEST", request.verificationRequestId)
      ));
      supportLevel = minSupport(supportLevel, "WEAK");
    }

    if (score === null) {
      unresolvedCount += unresolved.length === 0 ? 1 : 0;
      unresolvedRefs.push(...recordRefs, ...verificationRefs);
      continue;
    }

    sampleBySubject.set(subjectKey(record.key), {
      score,
      supportLevel,
      refs: uniqueRefs([...recordRefs, ...verificationRefs]),
      positive: score === 100,
      negative: score < 100
    });
  }

  for (const [key, requests] of verificationByEvidenceKey) {
    if (activeCorrectnessKeys.has(key)) continue;

    const currentRequests = currentVerificationRequests(
      requests,
      currentContextEpoch
    );
    if (currentRequests.length === 0) continue;

    const contradictions = currentRequests.filter(
      (request) => request.result?.status === "CONTRADICTED"
    );
    const unresolved = currentRequests.filter(
      (request) => request.result?.status === "UNRESOLVED"
    );
    const refs = uniqueRefs([
      ...contradictions,
      ...unresolved
    ].map((request) =>
      evaluationRef("VERIFICATION_REQUEST", request.verificationRequestId)
    ));

    if (contradictions.length > 0 && unresolved.length === 0) {
      const representative = contradictions[0];
      if (representative === undefined) continue;
      sampleBySubject.set(subjectKey(representative.evidenceKey), {
        score: 0,
        supportLevel: supportFromCount(
          1,
          minimumNumber(
            contradictions.map(
              (request) => request.result?.interpretationConfidence ?? 0
            )
          ),
          true
        ),
        refs,
        positive: false,
        negative: true
      });
      continue;
    }

    if (unresolved.length > 0 || contradictions.length > 0) {
      unresolvedCount += 1;
      unresolvedRefs.push(...refs);
    }
  }

  const samples = [...sampleBySubject.values()];
  if (samples.length === 0) {
    return {
      result: unsupportedDimension(
        unresolvedRefs.length > 0
          ? "Current correctness evidence is conflicting or unresolved and does not establish a score."
          : "No active scoped correctness evidence or unambiguous current deterministic contradiction supports a correctness score.",
        unresolvedRefs
      ),
      positiveCount: 0,
      negativeCount: 0,
      unresolvedCount
    };
  }

  const score = roundScore(
    samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length
  );
  let supportLevel = aggregateSampleSupport(samples.map((sample) => sample.supportLevel));
  if (unresolvedCount > 0) {
    supportLevel = minSupport(
      supportLevel,
      unresolvedCount >= samples.length ? "WEAK" : "MODERATE"
    );
  }
  const refs = uniqueRefs([
    ...samples.flatMap((sample) => sample.refs),
    ...unresolvedRefs
  ]);

  return {
    result: scoredDimension(score, supportLevel, refs),
    positiveCount: samples.filter((sample) => sample.positive).length,
    negativeCount: samples.filter((sample) => sample.negative).length,
    unresolvedCount
  };
}

function evaluateRigor(
  problem: InterviewProblem,
  activeEvidence: ReadonlyMap<string, EvidenceRecordState>,
  verificationByEvidenceKey: ReadonlyMap<string, readonly VerificationRequestState[]>,
  currentContextEpoch: SessionState["contextEpoch"]
): DimensionComputation {
  const samples: Array<{
    score: number;
    confidence: number;
    ambiguous: boolean;
    refs: EvaluationEvidenceRef[];
  }> = [];

  for (const record of activeEvidence.values()) {
    if (record.key.problemId !== problem.id || record.key.dimension !== "JUSTIFICATION") continue;
    const baseScore = rigorRatingScore(record.value.value);
    if (baseScore === null) continue;

    const correctnessKey: EvidenceKey = {
      problemId: problem.id,
      subject: record.key.subject,
      dimension: "CORRECTNESS"
    };
    const correctness = getActiveEvidence(
      activeEvidence,
      problem.id,
      record.key.subject,
      "CORRECTNESS"
    );
    const currentRequests = currentVerificationRequests(
      verificationByEvidenceKey.get(evidenceKeyToString(correctnessKey)) ?? [],
      currentContextEpoch
    );
    const contradictions = currentRequests.filter(
      (request) => request.result?.status === "CONTRADICTED"
    );
    const unresolved = currentRequests.filter(
      (request) => request.result?.status === "UNRESOLVED"
    );
    const conflictRequests = [...contradictions, ...unresolved];

    let score = baseScore;
    const verifierConflict = contradictions.length > 0 && unresolved.length > 0;
    let ambiguous = unresolved.length > 0;
    if (correctness?.value.value === "STRUCTURAL_ERROR") score = 0;
    if (correctness?.value.value === "LOCAL_ERROR") score = Math.min(score, 50);

    if (contradictions.length > 0 && !verifierConflict) {
      if (correctness?.value.value === "CORRECT") {
        ambiguous = true;
      } else {
        score = 0;
      }
    }

    samples.push({
      score,
      confidence: minimumNumber([
        record.value.inferenceConfidence,
        correctness?.value.inferenceConfidence ?? 1,
        ...conflictRequests.map(
          (request) => request.result?.interpretationConfidence ?? 1
        )
      ]),
      ambiguous,
      refs: uniqueRefs([
        evaluationRef("EVIDENCE_EVENT", record.evidenceEventId),
        ...record.value.evidenceEventIds.map((id) => evaluationRef("EVIDENCE_EVENT", id)),
        ...(correctness === undefined
          ? []
          : [evaluationRef("EVIDENCE_EVENT", correctness.evidenceEventId)]),
        ...conflictRequests.map((request) =>
          evaluationRef("VERIFICATION_REQUEST", request.verificationRequestId)
        )
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
  const minConfidence = minimumNumber(samples.map((sample) => sample.confidence));
  let supportLevel = supportFromCount(samples.length, minConfidence, false);
  if (samples.some((sample) => sample.ambiguous)) {
    supportLevel = minSupport(supportLevel, "WEAK");
  }
  return {
    result: scoredDimension(
      score,
      supportLevel,
      uniqueRefs(samples.flatMap((sample) => sample.refs))
    ),
    positiveCount: samples.filter((sample) => sample.score === 100).length,
    negativeCount: samples.filter((sample) => sample.score < 100).length
  };
}

function evaluateIndependence(
  milestoneFacts: readonly MilestoneFacts[],
  unattributedAssistanceRefs: readonly EvaluationEvidenceRef[]
): DimensionComputation {
  const achieved = milestoneFacts.filter((item) => item.evaluation.achieved);
  if (achieved.length === 0) {
    return {
      result: unsupportedDimension(
        "Independence is not scored because no milestone has grounded achievement evidence."
      )
    };
  }

  const uncertain = achieved.filter((item) => item.attributionUncertain);
  const uncertaintyRefs = uniqueRefs([
    ...uncertain.flatMap((item) => item.assistanceExposureRefs),
    ...unattributedAssistanceRefs
  ]);
  if (uncertain.length > 0 || unattributedAssistanceRefs.length > 0) {
    return {
      result: unsupportedDimension(
        "Relevant protected assistance was exposed, but authoritative exposure ordering is unavailable, so independence cannot be scored without inventing before/after attribution.",
        uncertaintyRefs
      )
    };
  }

  return {
    result: scoredDimension(
      100,
      supportFromGroundedCount(achieved.length),
      uniqueRefs(achieved.flatMap((item) => item.evaluation.evidenceRefs))
    )
  };
}

function evaluateHintResponsiveness(): DimensionComputation {
  return {
    result: unsupportedDimension(
      "The current authoritative SessionState does not retain delivery exposure ordering, so assistance cannot be shown to precede related progress."
    )
  };
}

function evaluateErrorRecovery(
  state: Readonly<SessionState>,
  problemId: string
): DimensionComputation {
  let recoveryCount = 0;
  let failureCount = 0;
  const refs: EvaluationEvidenceRef[] = [];
  const opportunityConfidences: number[] = [];
  const unresolvedApproachErrors: Array<{
    approachId: string;
    dimension: EvidenceKey["dimension"];
    sequence: number;
    confidence: number;
    refs: EvaluationEvidenceRef[];
  }> = [];
  const positiveApproachRecords: Array<{
    approachId: string;
    dimension: EvidenceKey["dimension"];
    sequence: number;
    confidence: number;
    refs: EvaluationEvidenceRef[];
  }> = [];

  const histories = Object.entries(state.evidenceHistory)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, history]) => history)
    .filter((history) => history.some((record) => record.key.problemId === problemId));

  for (const history of histories) {
    const records = [...history]
      .filter((record) => record.key.problemId === problemId)
      .sort(
        (left, right) =>
          left.value.lastUpdatedSequence - right.value.lastUpdatedSequence ||
          compareStrings(left.evidenceEventId, right.evidenceEventId)
      );
    if (records.length === 0) continue;

    let inErrorEpisode = false;
    let errorRefs: EvaluationEvidenceRef[] = [];
    let errorSequence = 0;
    let errorConfidence = 1;
    for (const record of records) {
      const recordRefs = [
        evaluationRef("EVIDENCE_EVENT", record.evidenceEventId),
        ...record.value.evidenceEventIds.map((id) => evaluationRef("EVIDENCE_EVENT", id))
      ];
      const negative =
        NEGATIVE_RECOVERY_RATINGS.has(record.value.value) &&
        record.status !== "STALE";
      const positive =
        POSITIVE_RECOVERY_RATINGS.has(record.value.value) &&
        record.status !== "STALE";

      if (!inErrorEpisode && negative) {
        inErrorEpisode = true;
        errorSequence = record.value.lastUpdatedSequence;
        errorConfidence = record.value.inferenceConfidence;
        errorRefs = recordRefs;
        continue;
      }

      if (inErrorEpisode && negative) {
        errorSequence = record.value.lastUpdatedSequence;
        errorConfidence = Math.min(errorConfidence, record.value.inferenceConfidence);
        errorRefs.push(...recordRefs);
        continue;
      }

      if (inErrorEpisode && positive) {
        recoveryCount += 1;
        opportunityConfidences.push(
          Math.min(errorConfidence, record.value.inferenceConfidence)
        );
        refs.push(...errorRefs, ...recordRefs);
        inErrorEpisode = false;
        errorConfidence = 1;
        errorRefs = [];
      }
    }

    const subject = records[0]?.key.subject;
    if (inErrorEpisode) {
      if (subject?.kind === "APPROACH") {
        unresolvedApproachErrors.push({
          approachId: subject.approachId,
          dimension: records[0]?.key.dimension ?? "PROGRESS",
          sequence: errorSequence,
          confidence: errorConfidence,
          refs: uniqueRefs(errorRefs)
        });
      } else {
        failureCount += 1;
        opportunityConfidences.push(errorConfidence);
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
            dimension: record.key.dimension,
            sequence: record.value.lastUpdatedSequence,
            confidence: record.value.inferenceConfidence,
            refs: [evaluationRef("EVIDENCE_EVENT", record.evidenceEventId)]
          });
        }
      }
    }

  }

  const positiveByDimension = new Map<
    EvidenceKey["dimension"],
    ReturnType<typeof buildApproachRecoveryIndex>
  >();
  const groupedPositives = new Map<
    EvidenceKey["dimension"],
    typeof positiveApproachRecords
  >();
  for (const record of positiveApproachRecords) {
    const current = groupedPositives.get(record.dimension) ?? [];
    current.push(record);
    groupedPositives.set(record.dimension, current);
  }
  for (const [dimension, records] of groupedPositives) {
    positiveByDimension.set(dimension, buildApproachRecoveryIndex(records));
  }

  for (const error of unresolvedApproachErrors) {
    const switched = findApproachSwitchRecovery(
      positiveByDimension.get(error.dimension),
      error.approachId,
      error.sequence
    );
    if (switched === undefined) {
      failureCount += 1;
      opportunityConfidences.push(error.confidence);
      refs.push(...error.refs);
    } else {
      recoveryCount += 1;
      opportunityConfidences.push(Math.min(error.confidence, switched.confidence));
      refs.push(...error.refs, ...switched.refs);
    }
  }

  const opportunities = recoveryCount + failureCount;
  if (opportunities === 0) {
    return {
      result: unsupportedDimension(
        "No grounded negative-to-supported evidence transition created an error-recovery opportunity."
      ),
      recoveryCount: 0,
      failureCount: 0
    };
  }

  return {
    result: scoredDimension(
      roundScore((recoveryCount / opportunities) * 100),
      supportFromCount(
        opportunities,
        minimumNumber(opportunityConfidences),
        false
      ),
      uniqueRefs(refs)
    ),
    recoveryCount,
    failureCount
  };
}

interface ApproachRecoveryCandidate {
  readonly approachId: string;
  readonly sequence: number;
  readonly confidence: number;
  readonly refs: readonly EvaluationEvidenceRef[];
}

interface ApproachRecoveryIndex {
  readonly records: readonly ApproachRecoveryCandidate[];
  readonly nextDifferentIndex: readonly number[];
}

function buildApproachRecoveryIndex(
  input: readonly ApproachRecoveryCandidate[]
): ApproachRecoveryIndex {
  const records = [...input].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      compareStrings(left.approachId, right.approachId)
  );
  const nextDifferentIndex = new Array<number>(records.length).fill(-1);
  for (let index = records.length - 2; index >= 0; index -= 1) {
    const current = records[index];
    const next = records[index + 1];
    if (current === undefined || next === undefined) continue;
    nextDifferentIndex[index] =
      next.approachId !== current.approachId
        ? index + 1
        : nextDifferentIndex[index + 1] ?? -1;
  }
  return { records, nextDifferentIndex };
}

function findApproachSwitchRecovery(
  index: ApproachRecoveryIndex | undefined,
  excludedApproachId: string,
  afterSequence: number
): ApproachRecoveryCandidate | undefined {
  if (index === undefined) return undefined;
  const { records, nextDifferentIndex } = index;

  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = records[middle];
    if (candidate === undefined || candidate.sequence > afterSequence) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  const first = records[low];
  if (first === undefined) return undefined;
  if (first.approachId !== excludedApproachId) return first;

  const nextIndex = nextDifferentIndex[low] ?? -1;
  return nextIndex < 0 ? undefined : records[nextIndex];
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
    (correctness.positiveCount ?? 0) > 0 &&
    (correctness.negativeCount ?? 0) === 0 &&
    SUPPORT_RANK[dimensions.technicalCorrectness.supportLevel] >= SUPPORT_RANK.MODERATE
  ) {
    strengths.push(
      "Authoritative correctness evidence supports " +
      String(correctness.positiveCount ?? 0) +
      " positively scored subject(s) with no turn-count inference."
    );
  }

  if (
    (rigor.positiveCount ?? 0) > 0 &&
    (rigor.negativeCount ?? 0) === 0 &&
    SUPPORT_RANK[dimensions.rigor.supportLevel] >= SUPPORT_RANK.MODERATE
  ) {
    strengths.push(
      "Scoped justification evidence supports the recorded rigor score across " +
      String((rigor.positiveCount ?? 0) + (rigor.negativeCount ?? 0)) +
      " subject(s)."
    );
  }

  if (unassisted.length > 0 && dimensions.independence.score === 100) {
    strengths.push(
      String(unassisted.length) +
      " achieved milestone(s) have no attributable protected disclosure in the current exposure ledger."
    );
  }

  if (
    (recovery.recoveryCount ?? 0) > 0 &&
    (recovery.failureCount ?? 0) === 0
  ) {
    strengths.push(
      "The evidence history records " +
      String(recovery.recoveryCount) +
      " grounded error episode(s) followed by supported replacement evidence."
    );
  }

  return strengths;
}

function buildImprovementAreas(
  dimensions: EvaluationDimensionResults,
  correctness: DimensionComputation,
  rigor: DimensionComputation,
  recovery: DimensionComputation
): string[] {
  const improvements: string[] = [];

  if ((correctness.negativeCount ?? 0) > 0) {
    improvements.push(
      String(correctness.negativeCount) +
      " scored correctness subject(s) remain locally or structurally contradicted."
    );
  }

  if ((rigor.negativeCount ?? 0) > 0) {
    improvements.push(
      String(rigor.negativeCount) +
      " scoped justification subject(s) remain incomplete, unjustified, or constrained by correctness errors."
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
        " current correctness subject(s) remain unresolved."
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

function currentVerificationRequests(
  requests: readonly VerificationRequestState[],
  currentContextEpoch: SessionState["contextEpoch"]
): VerificationRequestState[] {
  return requests.filter(
    (request) =>
      request.status === "ACCEPTED" &&
      request.result !== undefined &&
      request.basis.contextEpoch === currentContextEpoch
  );
}

function supportingVerificationRequests(
  record: EvidenceRecordState,
  verificationByEvidenceKey: ReadonlyMap<string, readonly VerificationRequestState[]>
): VerificationRequestState[] {
  return (verificationByEvidenceKey.get(evidenceKeyToString(record.key)) ?? [])
    .filter(
      (request) =>
        request.status === "ACCEPTED" &&
        request.result?.status === "VERIFIED" &&
        record.value.evidenceEventIds.includes(request.requestedEventId)
    );
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

function supportFromEvidenceRecords(
  records: readonly EvidenceRecordState[],
  verifierBacked: boolean
): EvaluationSupportLevel {
  if (records.length === 0) return "INSUFFICIENT";
  return supportFromCount(
    records.length,
    minimumNumber(records.map((record) => record.value.inferenceConfidence)),
    verifierBacked
  );
}

function supportFromGroundedCount(
  count: number
): EvaluationSupportLevel {
  if (count <= 0) return "INSUFFICIENT";
  if (count === 1) return "WEAK";
  if (count === 2) return "MODERATE";
  return "STRONG";
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
  if (!verifierBacked) {
    return minimumConfidence >= 0.7 ? "MODERATE" : "WEAK";
  }
  if (count >= 3 && minimumConfidence >= 0.8) return "STRONG";
  return minimumConfidence >= 0.5 ? "MODERATE" : "WEAK";
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

  return supportLevels.length >= 3 ? "STRONG" : "MODERATE";
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
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.id, right.id)
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

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireEventOrder(
  eventOrder: ReadonlyMap<string, number>,
  eventId: string
): number {
  const order = eventOrder.get(eventId);
  if (order === undefined) {
    throw new Error("Evaluation cannot order a non-authoritative event reference");
  }
  return order;
}

function minimumNumber(values: Iterable<number>): number {
  let minimum = Number.POSITIVE_INFINITY;
  let found = false;
  for (const value of values) {
    found = true;
    if (value < minimum) minimum = value;
  }
  if (!found) {
    throw new Error("Evaluation cannot compute support from an empty numeric sample");
  }
  return minimum;
}

function markdownTableCell(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/[\r\n]+/gu, " ");
}

export function generateEvaluationMarkdown(evaluation: SessionEvaluation): string {
  const scoreText = (score: number | null): string =>
    score === null ? "Not scored" : String(score) + "%";
  const weightText = (weight: number): string =>
    String(Math.round(weight * 100)) + "%";

  const milestoneRows = evaluation.milestones.map((milestone) =>
    "| " +
    markdownTableCell(milestone.milestoneId) +
    " | " +
    markdownTableCell(milestone.description) +
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
            markdownTableCell(item.deliveryId) +
            " | " +
            String(item.disclosureLevel) +
            " | " +
            item.deliveryStatus +
            " | " +
            markdownTableCell(item.relatedMilestoneIds.join(", ") || "none") +
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

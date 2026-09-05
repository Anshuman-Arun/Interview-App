import type {
  EvaluationSupportLevel,
  SessionEvaluation
} from "../../domain/src/index.js";
import type { CuratedProblemMetadata } from "./curated-authoring.js";
import {
  OXFORD_CONTENT_CONCEPT_DOMAINS,
  OXFORD_CONTENT_CONCEPTS,
  OXFORD_MATH_DOMAINS,
  OXFORD_REASONING_SKILLS,
  assertOxfordAdaptiveMetadataIntegrity,
  getOxfordSkillEvidenceBasis,
  type OxfordContentConcept,
  type OxfordMathDomain,
  type OxfordReasoningSkill,
  type OxfordSkillEvidenceWeight,
  type OxfordStageRole
} from "./oxford-adaptive-taxonomy.js";

export type OxfordCompetencyTrend =
  | "UNKNOWN"
  | "STABLE"
  | "IMPROVING"
  | "DECLINING";

export type OxfordCompetencyConfidenceBand =
  | "NONE"
  | "LOW"
  | "MEDIUM"
  | "HIGH";

export interface OxfordCompetencyEvidenceSnapshot {
  readonly sessionId: string;
  readonly observedAt: string;
  readonly source: "MILESTONE" | "PROCESS";
  readonly sourceId: string;
  readonly outcome: number;
  readonly effectiveWeight: number;
  readonly supportLevel: EvaluationSupportLevel;
  readonly assistanceLevel?: number;
  readonly stageRole?: OxfordStageRole;
  readonly evidenceRefCount: number;
}

export interface OxfordCompetencyEstimate<T extends string> {
  readonly id: T;
  /**
   * Conservative heuristic index in [0, 1], not a calibrated probability.
   * null means there is no grounded competency evidence.
   */
  readonly estimatedStrength: number | null;
  readonly confidence: number;
  readonly uncertainty: number;
  readonly confidenceBand: OxfordCompetencyConfidenceBand;
  readonly evidenceWeight: number;
  readonly evidenceCount: number;
  readonly exposureCount: number;
  readonly lastPracticedAt?: string;
  readonly trend: OxfordCompetencyTrend;
  readonly recentEvidence: readonly OxfordCompetencyEvidenceSnapshot[];
}

export interface OxfordProfileHistoryEntry {
  readonly sessionId: string;
  readonly problemId: string;
  readonly problemVersion: string;
  readonly familyId: string;
  readonly similarityClusterId?: string;
  readonly practicedAt: string;
  readonly domains: readonly OxfordMathDomain[];
  readonly contentConcepts: readonly OxfordContentConcept[];
  readonly reasoningSkills: readonly OxfordReasoningSkill[];
}

export interface OxfordProfileProcessSummary {
  readonly sessionsWithAssistance: number;
  readonly assistanceExposureCount: number;
  readonly independence: {
    readonly estimatedStrength: number | null;
    readonly confidence: number;
    readonly uncertainty: number;
    readonly evidenceWeight: number;
    readonly evidenceCount: number;
    readonly trend: OxfordCompetencyTrend;
  };
  readonly guidedAdaptationEvidenceCount: number;
  readonly errorRecoveryEvidenceCount: number;
}

export interface OxfordStudentProfileDiagnostics {
  readonly sourceSessionCount: number;
  readonly includedOxfordSessionCount: number;
  readonly duplicateSessionCount: number;
  readonly provisionalSessionCount: number;
  readonly unsupportedMilestoneCount: number;
  readonly unmappedMilestoneCount: number;
  readonly acceptedProcessEvidenceCount: number;
  readonly ignoredProcessEvidenceCount: number;
}

export interface OxfordStudentProfile {
  readonly asOf: string;
  readonly domains: readonly OxfordCompetencyEstimate<OxfordMathDomain>[];
  readonly contentConcepts: readonly OxfordCompetencyEstimate<OxfordContentConcept>[];
  readonly reasoningSkills: readonly OxfordCompetencyEstimate<OxfordReasoningSkill>[];
  readonly recentHistory: readonly OxfordProfileHistoryEntry[];
  readonly process: OxfordProfileProcessSummary;
  readonly diagnostics: OxfordStudentProfileDiagnostics;
}

export interface OxfordErrorRecoveryProcessEvidence {
  readonly kind: "error-recovery";
  readonly id: string;
  readonly errorEventId: string;
  readonly errorSequence: number;
  readonly outcome: "RECOVERED" | "UNRECOVERED";
  readonly recoveryEventId?: string;
  readonly recoverySequence?: number;
  readonly observedThroughEventId?: string;
  readonly observedThroughSequence?: number;
  readonly supportLevel: EvaluationSupportLevel;
  readonly evidenceRefCount?: number;
}

export interface OxfordGuidedAdaptationProcessEvidence {
  readonly kind: "guided-adaptation";
  readonly id: string;
  readonly interventionDeliveryId: string;
  readonly interventionSequence: number;
  readonly subsequentProgressEventId: string;
  readonly subsequentProgressSequence: number;
  /** True only when authoritative evidence says the later progress used the intervention/reframing/new idea. */
  readonly incorporatedIntervention: boolean;
  readonly outcome: "PRODUCTIVE" | "UNPRODUCTIVE";
  readonly supportLevel: EvaluationSupportLevel;
  readonly evidenceRefCount?: number;
}

export type OxfordProcessEvidence =
  | OxfordErrorRecoveryProcessEvidence
  | OxfordGuidedAdaptationProcessEvidence;

export interface OxfordProfileSessionEvidence {
  readonly evaluation: SessionEvaluation;
  readonly metadata: CuratedProblemMetadata;
  readonly practicedAt?: string;
  /**
   * Optional authoritative process relationships. These are never reconstructed
   * from milestone completion, intervention counts, or model prose.
   */
  readonly processEvidence?: readonly OxfordProcessEvidence[];
}

export interface OxfordStudentProfileOptions {
  readonly asOf?: string;
  readonly recentHistoryLimit?: number;
}

interface WeightedObservation {
  readonly sessionId: string;
  readonly observedAt: string;
  readonly source: "MILESTONE" | "PROCESS";
  readonly sourceId: string;
  readonly outcome: number;
  readonly baseWeight: number;
  readonly supportLevel: EvaluationSupportLevel;
  readonly assistanceLevel?: number;
  readonly stageRole?: OxfordStageRole;
  readonly evidenceRefCount: number;
}

interface MutableCompetencyState<T extends string> {
  readonly id: T;
  exposureCount: number;
  lastPracticedAt?: string;
  readonly observations: WeightedObservation[];
}

const PRIOR_STRENGTH = 0.60;
const PRIOR_WEIGHT = 1.25;
const RECENCY_HALF_LIFE_DAYS = 180;
const RECENCY_WEIGHT_FLOOR = 0.35;
const MAX_RECENT_EVIDENCE = 5;
const DEFAULT_RECENT_HISTORY_LIMIT = 12;

const SUPPORT_WEIGHT: Readonly<Record<EvaluationSupportLevel, number>> = Object.freeze({
  STRONG: 1,
  MODERATE: 0.7,
  WEAK: 0.35,
  INSUFFICIENT: 0
});

const SKILL_AUTHOR_WEIGHT: Readonly<Record<OxfordSkillEvidenceWeight, number>> = Object.freeze({
  primary: 1,
  supporting: 0.72,
  secondary: 0.5
});

const FAILURE_WEIGHT_BY_STAGE: Readonly<Record<OxfordStageRole, number>> = Object.freeze({
  "warm-up": 1,
  "technique-check": 0.95,
  core: 0.9,
  "deep-dive": 0.65,
  transfer: 0.55,
  stretch: 0.3
});

const FAILURE_OUTCOME_BY_STAGE: Readonly<Record<OxfordStageRole, number>> = Object.freeze({
  "warm-up": 0.25,
  "technique-check": 0.28,
  core: 0.32,
  "deep-dive": 0.38,
  transfer: 0.42,
  stretch: 0.48
});

export function projectOxfordStudentProfile(
  sourceSessions: readonly OxfordProfileSessionEvidence[],
  options: OxfordStudentProfileOptions = {}
): OxfordStudentProfile {
  if (!Array.isArray(sourceSessions)) {
    throw new TypeError("Oxford profile source sessions must be an array");
  }

  const domainState = createStateMap(OXFORD_MATH_DOMAINS);
  const contentState = createStateMap(OXFORD_CONTENT_CONCEPTS);
  const skillState = createStateMap(OXFORD_REASONING_SKILLS);
  const uniqueSessions = new Map<string, OxfordProfileSessionEvidence>();
  let duplicateSessionCount = 0;

  for (const session of sourceSessions) {
    assertSessionIdentity(session);
    const id = session.evaluation.sessionId;
    const existing = uniqueSessions.get(id);
    if (existing === undefined) {
      uniqueSessions.set(id, session);
      continue;
    }
    if (!sameSessionEvidence(existing, session)) {
      throw new Error(`Conflicting Oxford profile history for session "${id}"`);
    }
    duplicateSessionCount += 1;
  }

  const sessions = [...uniqueSessions.values()].sort(compareSessions);
  const latestPracticeAt = sessions.reduce<string | undefined>((latest, session) => {
    const current = practiceTime(session);
    return latest === undefined || current > latest ? current : latest;
  }, undefined);
  const asOf = canonicalTimestamp(
    options.asOf ?? latestPracticeAt ?? "1970-01-01T00:00:00.000Z",
    "Oxford profile asOf"
  );
  const asOfMs = Date.parse(asOf);

  let includedOxfordSessionCount = 0;
  let provisionalSessionCount = 0;
  let unsupportedMilestoneCount = 0;
  let unmappedMilestoneCount = 0;
  let acceptedProcessEvidenceCount = 0;
  let ignoredProcessEvidenceCount = 0;
  let sessionsWithAssistance = 0;
  let assistanceExposureCount = 0;
  let guidedAdaptationEvidenceCount = 0;
  let errorRecoveryEvidenceCount = 0;
  const independenceObservations: WeightedObservation[] = [];
  const recentHistory: OxfordProfileHistoryEntry[] = [];
  const seenProcessRelationships = new Set<string>();

  for (const session of sessions) {
    if (session.metadata.mode !== "OXFORD_MATHEMATICS") continue;
    includedOxfordSessionCount += 1;

    const adaptive = session.metadata.oxfordAdaptive;
    if (adaptive === undefined) {
      throw new Error(`Oxford profile history for problem "${session.metadata.id}" is missing adaptive metadata`);
    }
    assertOxfordAdaptiveMetadataIntegrity(adaptive);
    const observedAt = practiceTime(session);

    recentHistory.push({
      sessionId: session.evaluation.sessionId,
      problemId: session.evaluation.problemId,
      problemVersion: session.evaluation.problemVersion,
      familyId: adaptive.familyId,
      ...(adaptive.similarityClusterId === undefined
        ? {}
        : { similarityClusterId: adaptive.similarityClusterId }),
      practicedAt: observedAt,
      domains: adaptive.domains,
      contentConcepts: adaptive.contentConcepts,
      reasoningSkills: adaptive.skillEvidence.map((item) => item.skill)
    });

    if (adaptive.status !== "authored") {
      provisionalSessionCount += 1;
      continue;
    }

    recordExposure(domainState, adaptive.domains, observedAt);
    recordExposure(contentState, adaptive.contentConcepts, observedAt);
    recordExposure(skillState, adaptive.skillEvidence.map((item) => item.skill), observedAt);

    const milestoneOwners = new Map<string, {
      readonly role: OxfordStageRole;
      readonly domains: readonly OxfordMathDomain[];
      readonly contentConcepts: readonly OxfordContentConcept[];
      readonly skills: readonly {
        readonly skill: OxfordReasoningSkill;
        readonly weight: OxfordSkillEvidenceWeight;
      }[];
    }>();

    for (const stage of adaptive.stages) {
      for (const milestone of stage.milestones) {
        milestoneOwners.set(milestone.milestoneId, {
          role: stage.role,
          domains: stage.domains,
          contentConcepts: milestone.contentConcepts,
          skills: milestone.skillEvidence
        });
      }
    }

    for (const milestone of session.evaluation.milestones) {
      const owner = milestoneOwners.get(milestone.milestoneId);
      if (owner === undefined) {
        unmappedMilestoneCount += 1;
        continue;
      }
      const support = SUPPORT_WEIGHT[milestone.supportLevel];
      if (
        support === 0
        || (!milestone.achieved && milestone.evidenceRefs.length === 0)
      ) {
        unsupportedMilestoneCount += 1;
        continue;
      }

      const outcome = milestone.achieved
        ? achievedOutcome(milestone.assistanceLevel)
        : FAILURE_OUTCOME_BY_STAGE[owner.role];
      const achievementWeight = milestone.achieved
        ? assistanceWeight(milestone.assistanceLevel)
        : FAILURE_WEIGHT_BY_STAGE[owner.role];
      const commonWeight = support * achievementWeight;
      const sourceId = `milestone:${milestone.milestoneId}`;

      for (const concept of owner.contentConcepts) {
        addObservation(contentState.get(concept), {
          sessionId: session.evaluation.sessionId,
          observedAt,
          source: "MILESTONE",
          sourceId,
          outcome,
          baseWeight: commonWeight,
          supportLevel: milestone.supportLevel,
          assistanceLevel: milestone.assistanceLevel,
          stageRole: owner.role,
          evidenceRefCount: milestone.evidenceRefs.length
        });
      }

      const milestoneDomains = new Set<OxfordMathDomain>();
      for (const concept of owner.contentConcepts) {
        for (const domain of OXFORD_CONTENT_CONCEPT_DOMAINS[concept]) {
          if (owner.domains.includes(domain)) milestoneDomains.add(domain);
        }
      }
      for (const domain of milestoneDomains) {
        addObservation(domainState.get(domain), {
          sessionId: session.evaluation.sessionId,
          observedAt,
          source: "MILESTONE",
          sourceId,
          outcome,
          baseWeight: commonWeight * 0.82,
          supportLevel: milestone.supportLevel,
          assistanceLevel: milestone.assistanceLevel,
          stageRole: owner.role,
          evidenceRefCount: milestone.evidenceRefs.length
        });
      }

      for (const skill of owner.skills) {
        if (getOxfordSkillEvidenceBasis(skill.skill) !== "milestone-grounded") continue;
        addObservation(skillState.get(skill.skill), {
          sessionId: session.evaluation.sessionId,
          observedAt,
          source: "MILESTONE",
          sourceId,
          outcome,
          baseWeight: commonWeight * SKILL_AUTHOR_WEIGHT[skill.weight],
          supportLevel: milestone.supportLevel,
          assistanceLevel: milestone.assistanceLevel,
          stageRole: owner.role,
          evidenceRefCount: milestone.evidenceRefs.length
        });
      }
    }

    const interventions = session.evaluation.disclosedInterventions;
    assistanceExposureCount += interventions.length;
    if (interventions.length > 0) sessionsWithAssistance += 1;

    const independence = session.evaluation.dimensionResults.independence;
    if (independence.score !== null && independence.supportLevel !== "INSUFFICIENT") {
      independenceObservations.push({
        sessionId: session.evaluation.sessionId,
        observedAt,
        source: "PROCESS",
        sourceId: "session-evaluator:independence",
        outcome: independence.score / 100,
        baseWeight: SUPPORT_WEIGHT[independence.supportLevel] * 0.8,
        supportLevel: independence.supportLevel,
        evidenceRefCount: independence.evidenceRefs.length
      });
    }

    let acceptedExplicitErrorRecovery = false;
    for (const relation of session.processEvidence ?? []) {
      const normalized = normalizeProcessObservation(
        session.evaluation.sessionId,
        observedAt,
        relation,
        seenProcessRelationships
      );
      if (normalized === undefined) {
        ignoredProcessEvidenceCount += 1;
        continue;
      }
      acceptedProcessEvidenceCount += 1;
      if (normalized.skill === "error-recovery") {
        acceptedExplicitErrorRecovery = true;
        errorRecoveryEvidenceCount += 1;
      } else {
        guidedAdaptationEvidenceCount += 1;
      }
      addObservation(skillState.get(normalized.skill), normalized.observation);
    }

    /*
     * The grounded session evaluator already derives errorRecovery from
     * authoritative error -> later recovery transitions. Reuse that deterministic
     * projection when no stronger explicit process relation was supplied.
     *
     * There is intentionally no analogous hintResponsiveness -> guided-adaptation
     * shortcut: current state cannot prove exposure-before-progress ordering or
     * that later progress actually incorporated the intervention.
     */
    if (!acceptedExplicitErrorRecovery) {
      const recovery = session.evaluation.dimensionResults.errorRecovery;
      if (recovery.score !== null && recovery.supportLevel !== "INSUFFICIENT") {
        errorRecoveryEvidenceCount += 1;
        addObservation(skillState.get("error-recovery"), {
          sessionId: session.evaluation.sessionId,
          observedAt,
          source: "PROCESS",
          sourceId: "session-evaluator:error-recovery",
          outcome: recovery.score / 100,
          baseWeight: SUPPORT_WEIGHT[recovery.supportLevel] * 0.85,
          supportLevel: recovery.supportLevel,
          evidenceRefCount: recovery.evidenceRefs.length
        });
      }
    }
  }

  const historyLimit = resolveHistoryLimit(options.recentHistoryLimit);
  const recent = [...recentHistory]
    .sort((left, right) =>
      compareIso(right.practicedAt, left.practicedAt)
      || left.sessionId.localeCompare(right.sessionId)
    )
    .slice(0, historyLimit);

  return deepFreeze({
    asOf,
    domains: finalizeState(domainState, asOfMs),
    contentConcepts: finalizeState(contentState, asOfMs),
    reasoningSkills: finalizeState(skillState, asOfMs),
    recentHistory: recent,
    process: {
      sessionsWithAssistance,
      assistanceExposureCount,
      independence: finalizeScalar(independenceObservations, asOfMs),
      guidedAdaptationEvidenceCount,
      errorRecoveryEvidenceCount
    },
    diagnostics: {
      sourceSessionCount: sourceSessions.length,
      includedOxfordSessionCount,
      duplicateSessionCount,
      provisionalSessionCount,
      unsupportedMilestoneCount,
      unmappedMilestoneCount,
      acceptedProcessEvidenceCount,
      ignoredProcessEvidenceCount
    }
  });
}

function normalizeProcessObservation(
  sessionId: string,
  observedAt: string,
  relation: OxfordProcessEvidence,
  seen: Set<string>
): {
  readonly skill: "error-recovery" | "guided-adaptation";
  readonly observation: WeightedObservation;
} | undefined {
  if (
    relation.id.trim().length === 0
    || relation.supportLevel === "INSUFFICIENT"
  ) return undefined;
  const support = SUPPORT_WEIGHT[relation.supportLevel];
  if (support === 0) return undefined;

  if (relation.kind === "error-recovery") {
    if (
      relation.errorEventId.trim().length === 0
      || !validSequence(relation.errorSequence)
    ) return undefined;

    let key: string;
    let outcome: number;
    if (relation.outcome === "RECOVERED") {
      if (
        relation.recoveryEventId === undefined
        || relation.recoveryEventId.trim().length === 0
        || relation.recoverySequence === undefined
        || !validSequence(relation.recoverySequence)
        || relation.recoverySequence <= relation.errorSequence
      ) return undefined;
      key = `${sessionId}\u0000error-recovery\u0000${relation.errorEventId}\u0000${relation.recoveryEventId}`;
      outcome = 0.82;
    } else {
      if (
        relation.observedThroughEventId === undefined
        || relation.observedThroughEventId.trim().length === 0
        || relation.observedThroughSequence === undefined
        || !validSequence(relation.observedThroughSequence)
        || relation.observedThroughSequence <= relation.errorSequence
      ) return undefined;
      key = `${sessionId}\u0000error-recovery\u0000${relation.errorEventId}\u0000${relation.observedThroughEventId}`;
      outcome = 0.28;
    }
    if (seen.has(key)) return undefined;
    seen.add(key);
    return {
      skill: "error-recovery",
      observation: {
        sessionId,
        observedAt,
        source: "PROCESS",
        sourceId: `process:${relation.id}`,
        outcome,
        baseWeight: support * 0.9,
        supportLevel: relation.supportLevel,
        evidenceRefCount: relation.evidenceRefCount ?? 2
      }
    };
  }

  if (
    relation.interventionDeliveryId.trim().length === 0
    || relation.subsequentProgressEventId.trim().length === 0
    || !validSequence(relation.interventionSequence)
    || !validSequence(relation.subsequentProgressSequence)
    || relation.subsequentProgressSequence <= relation.interventionSequence
    || (relation.outcome === "PRODUCTIVE" && !relation.incorporatedIntervention)
  ) return undefined;

  const key = `${sessionId}\u0000guided-adaptation\u0000${relation.interventionDeliveryId}\u0000${relation.subsequentProgressEventId}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  return {
    skill: "guided-adaptation",
    observation: {
      sessionId,
      observedAt,
      source: "PROCESS",
      sourceId: `process:${relation.id}`,
      outcome: relation.outcome === "PRODUCTIVE" ? 0.82 : 0.3,
      baseWeight: support * 0.9,
      supportLevel: relation.supportLevel,
      evidenceRefCount: relation.evidenceRefCount ?? 2
    }
  };
}

function achievedOutcome(assistanceLevel: number): number {
  return clamp(0.86 - Math.min(5, Math.max(0, assistanceLevel)) * 0.055, 0, 1);
}

function assistanceWeight(assistanceLevel: number): number {
  return clamp(1 - Math.min(5, Math.max(0, assistanceLevel)) * 0.07, 0.65, 1);
}

function createStateMap<T extends string>(
  ids: readonly T[]
): Map<T, MutableCompetencyState<T>> {
  return new Map(ids.map((id) => [id, { id, exposureCount: 0, observations: [] }]));
}

function recordExposure<T extends string>(
  state: Map<T, MutableCompetencyState<T>>,
  ids: readonly T[],
  observedAt: string
): void {
  for (const id of new Set(ids)) {
    const item = state.get(id);
    if (item === undefined) continue;
    item.exposureCount += 1;
    if (item.lastPracticedAt === undefined || observedAt > item.lastPracticedAt) {
      item.lastPracticedAt = observedAt;
    }
  }
}

function addObservation<T extends string>(
  state: MutableCompetencyState<T> | undefined,
  observation: WeightedObservation
): void {
  if (state === undefined || observation.baseWeight <= 0) return;
  state.observations.push(observation);
}

function finalizeState<T extends string>(
  state: Map<T, MutableCompetencyState<T>>,
  asOfMs: number
): readonly OxfordCompetencyEstimate<T>[] {
  return [...state.values()].map((item) => finalizeCompetency(item, asOfMs));
}

function finalizeCompetency<T extends string>(
  state: MutableCompetencyState<T>,
  asOfMs: number
): OxfordCompetencyEstimate<T> {
  const weighted = state.observations.map((observation) => ({
    observation,
    effectiveWeight:
      observation.baseWeight * recencyMultiplier(observation.observedAt, asOfMs)
  }));
  const evidenceWeight = weighted.reduce((sum, item) => sum + item.effectiveWeight, 0);
  const evidenceCount = weighted.length;
  const estimatedStrength = evidenceWeight === 0
    ? null
    : (
      PRIOR_STRENGTH * PRIOR_WEIGHT
      + weighted.reduce(
        (sum, item) => sum + item.observation.outcome * item.effectiveWeight,
        0
      )
    ) / (PRIOR_WEIGHT + evidenceWeight);
  const confidence = evidenceWeight === 0 ? 0 : 1 - Math.exp(-evidenceWeight / 3);
  const recentEvidence = weighted
    .sort((left, right) =>
      compareIso(right.observation.observedAt, left.observation.observedAt)
      || left.observation.sessionId.localeCompare(right.observation.sessionId)
      || left.observation.sourceId.localeCompare(right.observation.sourceId)
    )
    .slice(0, MAX_RECENT_EVIDENCE)
    .map(({ observation, effectiveWeight }) => ({
      sessionId: observation.sessionId,
      observedAt: observation.observedAt,
      source: observation.source,
      sourceId: observation.sourceId,
      outcome: round(observation.outcome),
      effectiveWeight: round(effectiveWeight),
      supportLevel: observation.supportLevel,
      ...(observation.assistanceLevel === undefined
        ? {}
        : { assistanceLevel: observation.assistanceLevel }),
      ...(observation.stageRole === undefined
        ? {}
        : { stageRole: observation.stageRole }),
      evidenceRefCount: observation.evidenceRefCount
    }));

  return {
    id: state.id,
    estimatedStrength: estimatedStrength === null ? null : round(estimatedStrength),
    confidence: round(confidence),
    uncertainty: round(1 - confidence),
    confidenceBand: confidenceBand(confidence),
    evidenceWeight: round(evidenceWeight),
    evidenceCount,
    exposureCount: state.exposureCount,
    ...(state.lastPracticedAt === undefined
      ? {}
      : { lastPracticedAt: state.lastPracticedAt }),
    trend: evidenceTrend(state.observations),
    recentEvidence
  };
}

function finalizeScalar(
  observations: readonly WeightedObservation[],
  asOfMs: number
): OxfordProfileProcessSummary["independence"] {
  const weighted = observations.map((observation) => ({
    observation,
    effectiveWeight:
      observation.baseWeight * recencyMultiplier(observation.observedAt, asOfMs)
  }));
  const evidenceWeight = weighted.reduce((sum, item) => sum + item.effectiveWeight, 0);
  const estimatedStrength = evidenceWeight === 0
    ? null
    : (
      PRIOR_STRENGTH * PRIOR_WEIGHT
      + weighted.reduce(
        (sum, item) => sum + item.observation.outcome * item.effectiveWeight,
        0
      )
    ) / (PRIOR_WEIGHT + evidenceWeight);
  const confidence = evidenceWeight === 0 ? 0 : 1 - Math.exp(-evidenceWeight / 3);
  return {
    estimatedStrength: estimatedStrength === null ? null : round(estimatedStrength),
    confidence: round(confidence),
    uncertainty: round(1 - confidence),
    evidenceWeight: round(evidenceWeight),
    evidenceCount: observations.length,
    trend: evidenceTrend(observations)
  };
}

function evidenceTrend(
  observations: readonly WeightedObservation[]
): OxfordCompetencyTrend {
  if (observations.length < 4) return "UNKNOWN";
  const ordered = [...observations].sort((left, right) =>
    compareIso(left.observedAt, right.observedAt)
    || left.sessionId.localeCompare(right.sessionId)
    || left.sourceId.localeCompare(right.sourceId)
  );
  const recent = ordered.slice(-2);
  const previous = ordered.slice(Math.max(0, ordered.length - 5), -2);
  if (previous.length < 2) return "UNKNOWN";
  const recentMean = weightedOutcomeMean(recent);
  const previousMean = weightedOutcomeMean(previous);
  if (recentMean === null || previousMean === null) return "UNKNOWN";
  const delta = recentMean - previousMean;
  if (delta >= 0.08) return "IMPROVING";
  if (delta <= -0.08) return "DECLINING";
  return "STABLE";
}

function weightedOutcomeMean(
  observations: readonly WeightedObservation[]
): number | null {
  const totalWeight = observations.reduce((sum, item) => sum + item.baseWeight, 0);
  if (totalWeight <= 0) return null;
  return observations.reduce(
    (sum, item) => sum + item.outcome * item.baseWeight,
    0
  ) / totalWeight;
}

function recencyMultiplier(observedAt: string, asOfMs: number): number {
  const observedMs = Date.parse(observedAt);
  const ageDays = Math.max(0, (asOfMs - observedMs) / 86_400_000);
  return Math.max(
    RECENCY_WEIGHT_FLOOR,
    Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
  );
}

function confidenceBand(confidence: number): OxfordCompetencyConfidenceBand {
  if (confidence <= 0) return "NONE";
  if (confidence < 0.35) return "LOW";
  if (confidence < 0.7) return "MEDIUM";
  return "HIGH";
}

function assertSessionIdentity(session: OxfordProfileSessionEvidence): void {
  if (session.metadata.id !== session.evaluation.problemId) {
    throw new Error(
      `Oxford profile metadata problem id "${session.metadata.id}" does not match evaluation problem id "${session.evaluation.problemId}"`
    );
  }
  canonicalTimestamp(
    practiceTime(session),
    `Oxford profile session "${session.evaluation.sessionId}" practicedAt`
  );
}

function sameSessionEvidence(
  left: OxfordProfileSessionEvidence,
  right: OxfordProfileSessionEvidence
): boolean {
  return practiceTime(left) === practiceTime(right)
    && JSON.stringify(left.metadata) === JSON.stringify(right.metadata)
    && JSON.stringify(left.evaluation) === JSON.stringify(right.evaluation)
    && JSON.stringify(left.processEvidence ?? []) === JSON.stringify(right.processEvidence ?? []);
}

function compareSessions(
  left: OxfordProfileSessionEvidence,
  right: OxfordProfileSessionEvidence
): number {
  return compareIso(practiceTime(left), practiceTime(right))
    || left.evaluation.sessionId.localeCompare(right.evaluation.sessionId);
}

function practiceTime(session: OxfordProfileSessionEvidence): string {
  return canonicalTimestamp(
    session.practicedAt ?? session.evaluation.evaluatedAt,
    `Oxford profile session "${session.evaluation.sessionId}" time`
  );
}

function canonicalTimestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function resolveHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECENT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000) {
    throw new RangeError("Oxford profile recentHistoryLimit must be an integer in [0,1000]");
  }
  return value;
}

function validSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function compareIso(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

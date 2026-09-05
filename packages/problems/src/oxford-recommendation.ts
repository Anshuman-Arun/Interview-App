import type { CuratedProblemMetadata } from "./curated-authoring.js";
import {
  isOxfordRecommendationReady,
  type OxfordAdaptiveMetadata,
  type OxfordContentConcept,
  type OxfordDifficultyBand,
  type OxfordMathDomain,
  type OxfordPrerequisiteConcept,
  type OxfordReasoningSkill
} from "./oxford-adaptive-taxonomy.js";
import type {
  OxfordCompetencyEstimate,
  OxfordStudentProfile
} from "./oxford-student-profile.js";

export interface OxfordRecommendationCandidate {
  readonly problemId: string;
  readonly problemVersion: string;
  readonly metadata: CuratedProblemMetadata;
}

export type OxfordPrerequisiteStatus = "MET" | "UNMET" | "UNKNOWN";

export interface OxfordRecommendationCooldowns {
  readonly exactProblemSessions?: number;
  readonly familySessions?: number;
  readonly similarityClusterSessions?: number;
}

export interface OxfordRecommendationOptions {
  readonly availableMinutes?: number;
  readonly prerequisites?: Readonly<Partial<Record<OxfordPrerequisiteConcept, OxfordPrerequisiteStatus>>>;
  readonly cooldowns?: OxfordRecommendationCooldowns;
  readonly deliberateExactRepeatIdentities?: readonly string[];
  readonly topK?: number;
  readonly recentDomainWindowSessions?: number;
}

export type OxfordRecommendationExclusionCode =
  | "NOT_OXFORD_MATHEMATICS"
  | "MISSING_ADAPTIVE_METADATA"
  | "PROVISIONAL_LEGACY"
  | "NOT_RECOMMENDATION_READY"
  | "PREREQUISITE_UNMET"
  | "EXACT_REPEAT_COOLDOWN"
  | "FAMILY_COOLDOWN"
  | "SIMILARITY_CLUSTER_COOLDOWN"
  | "SESSION_TOO_LONG"
  | "DIFFICULTY_MISMATCH"
  | "INVALID_METADATA";

export type OxfordRecommendationReasonCode =
  | "COLD_START_DIAGNOSTIC"
  | "APPROPRIATE_CHALLENGE"
  | "CONTENT_DEVELOPMENT"
  | "INFORMATION_GAIN"
  | "REASONING_DEVELOPMENT"
  | "SPACED_EXPOSURE"
  | "TOPIC_DIVERSITY"
  | "RECENT_DECLINE_SUPPORT"
  | "STRONG_CALIBRATION"
  | "SESSION_FIT"
  | "PREREQUISITE_UNCERTAINTY";

export interface OxfordRecommendationScoreBreakdown {
  readonly challengeFit: number;
  readonly contentDevelopment: number;
  readonly informationGain: number;
  readonly reasoningDevelopment: number;
  readonly spacing: number;
  readonly diversity: number;
  readonly trajectory: number;
  readonly calibration: number;
  readonly sessionFit: number;
  readonly diagnosticBreadth: number;
}

export interface OxfordRecommendationSessionFit {
  readonly status: "GOOD" | "TIGHT" | "UNKNOWN";
  readonly softCutoffMinutes: number;
  readonly independentCompletionMinutes: {
    readonly min: number;
    readonly max: number;
  };
  readonly promptedCompletionMinutes: {
    readonly min: number;
    readonly max: number;
  };
  readonly availableMinutes?: number;
}

export interface OxfordRankedRecommendation {
  readonly problemId: string;
  readonly problemVersion: string;
  readonly familyId: string;
  readonly similarityClusterId?: string;
  readonly score: number;
  readonly targetDomains: readonly OxfordMathDomain[];
  readonly targetContentConcepts: readonly OxfordContentConcept[];
  readonly targetReasoningSkills: readonly OxfordReasoningSkill[];
  readonly estimatedSessionFit: OxfordRecommendationSessionFit;
  readonly reasonCodes: readonly OxfordRecommendationReasonCode[];
  /**
   * Backend explanation only. It deliberately contains no prompt, solution,
   * protected-disclosure, provenance-source wording, or candidate-hidden stage detail.
   */
  readonly explanation: string;
  readonly relevantUncertainty: number;
  readonly scoreBreakdown: OxfordRecommendationScoreBreakdown;
}

export interface OxfordRecommendationExclusion {
  readonly problemId: string;
  readonly problemVersion: string;
  readonly familyId?: string;
  readonly codes: readonly OxfordRecommendationExclusionCode[];
  readonly hypotheticalScore?: number;
}

export interface OxfordRecommendationResult {
  readonly coldStart: boolean;
  readonly selected?: OxfordRankedRecommendation;
  readonly alternatives: readonly OxfordRankedRecommendation[];
  readonly exclusions: readonly OxfordRecommendationExclusion[];
  readonly eligibleCandidateCount: number;
}

interface ProfileLookup {
  readonly domains: ReadonlyMap<OxfordMathDomain, OxfordCompetencyEstimate<OxfordMathDomain>>;
  readonly content: ReadonlyMap<OxfordContentConcept, OxfordCompetencyEstimate<OxfordContentConcept>>;
  readonly skills: ReadonlyMap<OxfordReasoningSkill, OxfordCompetencyEstimate<OxfordReasoningSkill>>;
}

interface AbilityEstimate {
  readonly strength: number | null;
  readonly confidence: number;
}

const DIFFICULTY_RANK: Readonly<Record<OxfordDifficultyBand, number>> = Object.freeze({
  "warm-up": 0,
  introductory: 1,
  "introductory-plus": 2,
  standard: 3,
  strong: 4,
  stretch: 5
});

const DEFAULT_EXACT_COOLDOWN = 2;
const DEFAULT_FAMILY_COOLDOWN = 2;
const DEFAULT_CLUSTER_COOLDOWN = 2;
const DEFAULT_TOP_K = 3;
const DEFAULT_RECENT_DOMAIN_WINDOW = 3;

export function recommendNextOxfordProblem(
  profile: OxfordStudentProfile,
  candidates: readonly OxfordRecommendationCandidate[],
  options: OxfordRecommendationOptions = {}
): OxfordRecommendationResult {
  const topK = boundedInteger(options.topK, DEFAULT_TOP_K, 1, 20, "topK");
  const exactCooldown = boundedInteger(
    options.cooldowns?.exactProblemSessions,
    DEFAULT_EXACT_COOLDOWN,
    0,
    50,
    "exactProblemSessions"
  );
  const familyCooldown = boundedInteger(
    options.cooldowns?.familySessions,
    DEFAULT_FAMILY_COOLDOWN,
    0,
    50,
    "familySessions"
  );
  const clusterCooldown = boundedInteger(
    options.cooldowns?.similarityClusterSessions,
    DEFAULT_CLUSTER_COOLDOWN,
    0,
    50,
    "similarityClusterSessions"
  );
  const recentDomainWindow = boundedInteger(
    options.recentDomainWindowSessions,
    DEFAULT_RECENT_DOMAIN_WINDOW,
    0,
    50,
    "recentDomainWindowSessions"
  );
  const availableMinutes = resolveAvailableMinutes(options.availableMinutes);
  const deliberateRepeats = new Set(options.deliberateExactRepeatIdentities ?? []);
  const lookup = createProfileLookup(profile);
  const ability = estimateAbility(profile);
  const coldStart = totalGroundedEvidence(profile) === 0;
  const eligible: OxfordRankedRecommendation[] = [];
  const exclusions: OxfordRecommendationExclusion[] = [];

  for (const candidate of candidates) {
    const exclusionCodes: OxfordRecommendationExclusionCode[] = [];
    const metadata = candidate.metadata;

    if (metadata.id !== candidate.problemId) {
      exclusionCodes.push("INVALID_METADATA");
    }
    if (metadata.mode !== "OXFORD_MATHEMATICS") {
      exclusionCodes.push("NOT_OXFORD_MATHEMATICS");
    }

    const adaptive = metadata.oxfordAdaptive;
    if (adaptive === undefined) {
      exclusionCodes.push("MISSING_ADAPTIVE_METADATA");
    } else {
      if (adaptive.status === "provisional-legacy") {
        exclusionCodes.push("PROVISIONAL_LEGACY");
      }
      if (!isOxfordRecommendationReady(adaptive)) {
        exclusionCodes.push("NOT_RECOMMENDATION_READY");
      }

      if (adaptive.status === "authored" && adaptive.difficulty !== undefined && adaptive.timing !== undefined) {
        if (hasUnmetPrerequisite(adaptive, options.prerequisites)) {
          exclusionCodes.push("PREREQUISITE_UNMET");
        }

        const exactIdentity = problemIdentity(candidate.problemId, candidate.problemVersion);
        const deliberateRepeat = deliberateRepeats.has(exactIdentity);
        if (!deliberateRepeat) {
          if (isExactProblemCoolingDown(profile, candidate, exactCooldown)) {
            exclusionCodes.push("EXACT_REPEAT_COOLDOWN");
          }
          if (isFamilyCoolingDown(profile, adaptive.familyId, familyCooldown)) {
            exclusionCodes.push("FAMILY_COOLDOWN");
          }
          if (
            adaptive.similarityClusterId !== undefined
            && isSimilarityClusterCoolingDown(
              profile,
              adaptive.similarityClusterId,
              clusterCooldown
            )
          ) {
            exclusionCodes.push("SIMILARITY_CLUSTER_COOLDOWN");
          }
        }
        if (
          availableMinutes !== undefined
          && adaptive.timing.promptedCompletionMinutes.min > availableMinutes
        ) {
          exclusionCodes.push("SESSION_TOO_LONG");
        }
        if (isDifficultyMismatch(adaptive, ability)) {
          exclusionCodes.push("DIFFICULTY_MISMATCH");
        }
      }
    }

    const uniqueCodes = [...new Set(exclusionCodes)];
    if (uniqueCodes.length > 0) {
      const hypothetical = canScore(adaptive)
        ? scoreCandidate(
            profile,
            lookup,
            adaptive,
            candidate,
            coldStart,
            availableMinutes,
            recentDomainWindow,
            options.prerequisites
          ).score
        : undefined;
      exclusions.push({
        problemId: candidate.problemId,
        problemVersion: candidate.problemVersion,
        ...(adaptive === undefined ? {} : { familyId: adaptive.familyId }),
        codes: uniqueCodes,
        ...(hypothetical === undefined ? {} : { hypotheticalScore: hypothetical })
      });
      continue;
    }

    if (!canScore(adaptive)) {
      exclusions.push({
        problemId: candidate.problemId,
        problemVersion: candidate.problemVersion,
        ...(adaptive === undefined ? {} : { familyId: adaptive.familyId }),
        codes: ["INVALID_METADATA"]
      });
      continue;
    }

    eligible.push(
      scoreCandidate(
        profile,
        lookup,
        adaptive,
        candidate,
        coldStart,
        availableMinutes,
        recentDomainWindow,
        options.prerequisites
      )
    );
  }

  eligible.sort(compareRanked);
  exclusions.sort((left, right) =>
    (right.hypotheticalScore ?? -1) - (left.hypotheticalScore ?? -1)
    || left.problemId.localeCompare(right.problemId)
    || left.problemVersion.localeCompare(right.problemVersion)
  );

  const selected = eligible[0];
  const alternatives = eligible.slice(1, topK);

  return deepFreeze({
    coldStart,
    ...(selected === undefined ? {} : { selected }),
    alternatives,
    exclusions,
    eligibleCandidateCount: eligible.length
  });
}

function scoreCandidate(
  profile: OxfordStudentProfile,
  lookup: ProfileLookup,
  adaptive: OxfordAdaptiveMetadata & {
    readonly status: "authored";
    readonly difficulty: NonNullable<OxfordAdaptiveMetadata["difficulty"]>;
    readonly timing: NonNullable<OxfordAdaptiveMetadata["timing"]>;
  },
  candidate: OxfordRecommendationCandidate,
  coldStart: boolean,
  availableMinutes: number | undefined,
  recentDomainWindow: number,
  prerequisites: OxfordRecommendationOptions["prerequisites"]
): OxfordRankedRecommendation {
  const challengeFit = challengeScore(profile, adaptive, coldStart);
  const contentDevelopment = developmentScore(
    adaptive.contentConcepts.map((id) => lookup.content.get(id))
  );
  const informationGain = uncertaintyScore([
    ...adaptive.domains.map((id) => lookup.domains.get(id)),
    ...adaptive.contentConcepts.map((id) => lookup.content.get(id)),
    ...adaptive.skillEvidence.map((item) => lookup.skills.get(item.skill))
  ]);
  const reasoningDevelopment = developmentScore(
    adaptive.skillEvidence.map((item) => lookup.skills.get(item.skill))
  );
  const spacing = spacingScore(profile, adaptive);
  const diversity = diversityScore(profile, adaptive, recentDomainWindow);
  const trajectory = trajectoryScore([
    ...adaptive.contentConcepts.map((id) => lookup.content.get(id)),
    ...adaptive.skillEvidence.map((item) => lookup.skills.get(item.skill))
  ]);
  const calibration = calibrationScore(adaptive);
  const sessionFit = sessionFitScore(adaptive, availableMinutes);
  const diagnosticBreadth = diagnosticBreadthScore(adaptive);

  const score = coldStart
    ? (
      0.20 * challengeFit
      + 0.20 * informationGain
      + 0.16 * diagnosticBreadth
      + 0.16 * calibration
      + 0.12 * diversity
      + 0.08 * spacing
      + 0.08 * sessionFit
    )
    : (
      0.22 * challengeFit
      + 0.17 * contentDevelopment
      + 0.17 * informationGain
      + 0.12 * reasoningDevelopment
      + 0.10 * spacing
      + 0.08 * diversity
      + 0.06 * trajectory
      + 0.05 * calibration
      + 0.03 * sessionFit
    );

  const breakdown: OxfordRecommendationScoreBreakdown = {
    challengeFit: round(challengeFit),
    contentDevelopment: round(contentDevelopment),
    informationGain: round(informationGain),
    reasoningDevelopment: round(reasoningDevelopment),
    spacing: round(spacing),
    diversity: round(diversity),
    trajectory: round(trajectory),
    calibration: round(calibration),
    sessionFit: round(sessionFit),
    diagnosticBreadth: round(diagnosticBreadth)
  };
  const reasonCodes = reasonCodesFor(
    breakdown,
    coldStart,
    hasUnknownPrerequisite(adaptive, prerequisites)
  );
  const targetReasoningSkills = adaptive.skillEvidence.map((item) => item.skill);
  const relevantUncertainty = uncertaintyScore([
    ...adaptive.domains.map((id) => lookup.domains.get(id)),
    ...adaptive.contentConcepts.map((id) => lookup.content.get(id)),
    ...targetReasoningSkills.map((id) => lookup.skills.get(id))
  ]);

  return {
    problemId: candidate.problemId,
    problemVersion: candidate.problemVersion,
    familyId: adaptive.familyId,
    ...(adaptive.similarityClusterId === undefined
      ? {}
      : { similarityClusterId: adaptive.similarityClusterId }),
    score: round(score),
    targetDomains: adaptive.domains,
    targetContentConcepts: adaptive.contentConcepts,
    targetReasoningSkills,
    estimatedSessionFit: sessionFitDescription(adaptive, availableMinutes),
    reasonCodes,
    explanation: explanationFor(reasonCodes, coldStart),
    relevantUncertainty: round(relevantUncertainty),
    scoreBreakdown: breakdown
  };
}

function canScore(
  adaptive: OxfordAdaptiveMetadata | undefined
): adaptive is OxfordAdaptiveMetadata & {
  readonly status: "authored";
  readonly difficulty: NonNullable<OxfordAdaptiveMetadata["difficulty"]>;
  readonly timing: NonNullable<OxfordAdaptiveMetadata["timing"]>;
} {
  return adaptive?.status === "authored"
    && adaptive.difficulty !== undefined
    && adaptive.timing !== undefined;
}

function createProfileLookup(profile: OxfordStudentProfile): ProfileLookup {
  return {
    domains: new Map(profile.domains.map((item) => [item.id, item])),
    content: new Map(profile.contentConcepts.map((item) => [item.id, item])),
    skills: new Map(profile.reasoningSkills.map((item) => [item.id, item]))
  };
}

function totalGroundedEvidence(profile: OxfordStudentProfile): number {
  return profile.domains.reduce((sum, item) => sum + item.evidenceCount, 0)
    + profile.contentConcepts.reduce((sum, item) => sum + item.evidenceCount, 0)
    + profile.reasoningSkills.reduce((sum, item) => sum + item.evidenceCount, 0);
}

function estimateAbility(profile: OxfordStudentProfile): AbilityEstimate {
  const observed = [
    ...profile.domains,
    ...profile.contentConcepts,
    ...profile.reasoningSkills
  ].filter((item) =>
    item.estimatedStrength !== null
    && item.confidence > 0
  );
  const totalConfidence = observed.reduce((sum, item) => sum + item.confidence, 0);
  if (totalConfidence <= 0) return { strength: null, confidence: 0 };

  const strength = observed.reduce((sum, item) =>
    sum + (item.estimatedStrength ?? 0) * item.confidence, 0
  ) / totalConfidence;
  const confidence = Math.min(
    1,
    totalConfidence / Math.max(4, observed.length * 0.7)
  );
  return { strength, confidence };
}

function isDifficultyMismatch(
  adaptive: OxfordAdaptiveMetadata & {
    readonly difficulty?: NonNullable<OxfordAdaptiveMetadata["difficulty"]>;
  },
  ability: AbilityEstimate
): boolean {
  if (
    adaptive.difficulty === undefined
    || ability.strength === null
    || ability.confidence < 0.55
  ) return false;

  const targetRank = ability.strength * 5;
  const entryRank = DIFFICULTY_RANK[adaptive.difficulty.entry];
  const ceilingRank = DIFFICULTY_RANK[adaptive.difficulty.ceiling];

  return entryRank > targetRank + 2.1
    || ceilingRank < targetRank - 2.1;
}

function challengeScore(
  profile: OxfordStudentProfile,
  adaptive: OxfordAdaptiveMetadata & {
    readonly difficulty: NonNullable<OxfordAdaptiveMetadata["difficulty"]>;
  },
  coldStart: boolean
): number {
  const ability = estimateAbility(profile);
  if (ability.strength === null) {
    const entry = DIFFICULTY_RANK[adaptive.difficulty.entry];
    const core = DIFFICULTY_RANK[adaptive.difficulty.core];
    if (coldStart) {
      return clamp(
        0.95
        - Math.max(0, entry - 1) * 0.12
        - Math.max(0, core - 3) * 0.08,
        0,
        1
      );
    }
    return 0.65;
  }

  const targetRank = ability.strength * 5;
  const coreRank = DIFFICULTY_RANK[adaptive.difficulty.core];
  const distance = Math.abs(coreRank - targetRank);
  return clamp(1 - distance / 3.2, 0, 1);
}

function developmentScore(
  estimates: readonly (OxfordCompetencyEstimate<string> | undefined)[]
): number {
  if (estimates.length === 0) return 0.5;
  return mean(estimates.map((estimate) => {
    if (estimate?.estimatedStrength === null || estimate === undefined) return 0.5;
    return clamp(
      0.5 + (0.5 - estimate.estimatedStrength) * estimate.confidence,
      0,
      1
    );
  }));
}

function uncertaintyScore(
  estimates: readonly (OxfordCompetencyEstimate<string> | undefined)[]
): number {
  if (estimates.length === 0) return 0.5;
  return mean(estimates.map((estimate) => estimate?.uncertainty ?? 1));
}

function spacingScore(
  profile: OxfordStudentProfile,
  adaptive: OxfordAdaptiveMetadata
): number {
  const targetIds = new Set<string>([
    ...adaptive.domains,
    ...adaptive.contentConcepts,
    ...adaptive.skillEvidence.map((item) => item.skill)
  ]);
  const relevantTimes = [
    ...profile.domains,
    ...profile.contentConcepts,
    ...profile.reasoningSkills
  ].flatMap((item) =>
    targetIds.has(item.id) && item.lastPracticedAt !== undefined
      ? [Date.parse(item.lastPracticedAt)]
      : []
  );
  if (relevantTimes.length === 0) return 1;
  const last = Math.max(...relevantTimes);
  const ageDays = Math.max(0, (Date.parse(profile.asOf) - last) / 86_400_000);
  return clamp(0.2 + ageDays / 112.5, 0.2, 1);
}

function diversityScore(
  profile: OxfordStudentProfile,
  adaptive: OxfordAdaptiveMetadata,
  recentWindow: number
): number {
  if (recentWindow === 0 || profile.recentHistory.length === 0) return 1;
  const recent = profile.recentHistory.slice(0, recentWindow);
  const recentDomains = new Set(recent.flatMap((item) => item.domains));
  if (adaptive.domains.length === 0) return 0.5;
  const overlap = adaptive.domains.filter((domain) => recentDomains.has(domain)).length
    / adaptive.domains.length;
  return clamp(1 - 0.55 * overlap, 0, 1);
}

function trajectoryScore(
  estimates: readonly (OxfordCompetencyEstimate<string> | undefined)[]
): number {
  if (estimates.length === 0) return 0.5;
  const values = estimates.map((estimate) => {
    switch (estimate?.trend) {
      case "DECLINING":
        return 0.75;
      case "IMPROVING":
        return 0.58;
      case "STABLE":
        return 0.5;
      case "UNKNOWN":
      case undefined:
        return 0.5;
    }
  });
  return mean(values);
}

function calibrationScore(
  adaptive: OxfordAdaptiveMetadata & {
    readonly difficulty: NonNullable<OxfordAdaptiveMetadata["difficulty"]>;
    readonly timing: NonNullable<OxfordAdaptiveMetadata["timing"]>;
  }
): number {
  const calibrationValue = (value: "expert-estimate" | "empirically-calibrated" | "unreviewed"): number =>
    value === "empirically-calibrated" ? 1 : value === "expert-estimate" ? 0.75 : 0;
  const confidenceValue = (value: "low" | "medium" | "high"): number =>
    value === "high" ? 0.95 : value === "medium" ? 0.78 : 0.58;

  return mean([
    calibrationValue(adaptive.review.difficultyCalibration),
    calibrationValue(adaptive.review.timingCalibration),
    confidenceValue(adaptive.difficulty.confidence),
    confidenceValue(adaptive.timing.confidence)
  ]);
}

function sessionFitScore(
  adaptive: OxfordAdaptiveMetadata & {
    readonly timing: NonNullable<OxfordAdaptiveMetadata["timing"]>;
  },
  availableMinutes: number | undefined
): number {
  if (availableMinutes === undefined) return 0.75;
  if (adaptive.timing.softCutoffMinutes <= availableMinutes) return 1;
  if (adaptive.timing.promptedCompletionMinutes.max <= availableMinutes) return 0.9;
  if (adaptive.timing.promptedCompletionMinutes.min <= availableMinutes) return 0.65;
  return 0;
}

function diagnosticBreadthScore(adaptive: OxfordAdaptiveMetadata): number {
  const milestoneGroundedSkills = adaptive.skillEvidence.filter((item) =>
    item.skill !== "error-recovery" && item.skill !== "guided-adaptation"
  ).length;
  return clamp(
    0.4 * Math.min(1, adaptive.domains.length / 2)
    + 0.3 * Math.min(1, adaptive.contentConcepts.length / 5)
    + 0.3 * Math.min(1, milestoneGroundedSkills / 4),
    0,
    1
  );
}

function reasonCodesFor(
  breakdown: OxfordRecommendationScoreBreakdown,
  coldStart: boolean,
  prerequisiteUncertainty: boolean
): readonly OxfordRecommendationReasonCode[] {
  const reasons: OxfordRecommendationReasonCode[] = [];
  if (coldStart) reasons.push("COLD_START_DIAGNOSTIC");
  if (breakdown.challengeFit >= 0.72) reasons.push("APPROPRIATE_CHALLENGE");
  if (!coldStart && breakdown.contentDevelopment >= 0.58) reasons.push("CONTENT_DEVELOPMENT");
  if (breakdown.informationGain >= 0.62) reasons.push("INFORMATION_GAIN");
  if (!coldStart && breakdown.reasoningDevelopment >= 0.58) reasons.push("REASONING_DEVELOPMENT");
  if (breakdown.spacing >= 0.68) reasons.push("SPACED_EXPOSURE");
  if (breakdown.diversity >= 0.72) reasons.push("TOPIC_DIVERSITY");
  if (!coldStart && breakdown.trajectory >= 0.62) reasons.push("RECENT_DECLINE_SUPPORT");
  if (breakdown.calibration >= 0.78) reasons.push("STRONG_CALIBRATION");
  if (breakdown.sessionFit >= 0.9) reasons.push("SESSION_FIT");
  if (prerequisiteUncertainty) reasons.push("PREREQUISITE_UNCERTAINTY");
  return reasons;
}

function explanationFor(
  reasonCodes: readonly OxfordRecommendationReasonCode[],
  coldStart: boolean
): string {
  const labels: Partial<Record<OxfordRecommendationReasonCode, string>> = {
    APPROPRIATE_CHALLENGE: "appropriate challenge",
    CONTENT_DEVELOPMENT: "underdeveloped content",
    INFORMATION_GAIN: "useful uncertainty reduction",
    REASONING_DEVELOPMENT: "reasoning-skill development",
    SPACED_EXPOSURE: "spaced exposure",
    TOPIC_DIVERSITY: "recent-topic diversity",
    RECENT_DECLINE_SUPPORT: "recent trajectory",
    STRONG_CALIBRATION: "strong calibration",
    SESSION_FIT: "session-time fit",
    PREREQUISITE_UNCERTAINTY: "known prerequisite uncertainty"
  };
  const details = reasonCodes
    .filter((code) => code !== "COLD_START_DIAGNOSTIC")
    .slice(0, 4)
    .map((code) => labels[code])
    .filter((value): value is string => value !== undefined);

  if (coldStart) {
    return details.length === 0
      ? "Cold-start choice favors accessible diagnostic breadth without assuming unknown competencies are weak."
      : `Cold-start choice favors accessible diagnostic breadth, with ${details.join(", ")}.`;
  }
  return details.length === 0
    ? "Balanced between-interview choice across challenge, coverage, uncertainty, spacing, and realism."
    : `Balanced between-interview choice emphasizing ${details.join(", ")}.`;
}

function sessionFitDescription(
  adaptive: OxfordAdaptiveMetadata & {
    readonly timing: NonNullable<OxfordAdaptiveMetadata["timing"]>;
  },
  availableMinutes: number | undefined
): OxfordRecommendationSessionFit {
  const score = sessionFitScore(adaptive, availableMinutes);
  return {
    status: availableMinutes === undefined ? "UNKNOWN" : score >= 0.9 ? "GOOD" : "TIGHT",
    softCutoffMinutes: adaptive.timing.softCutoffMinutes,
    independentCompletionMinutes: adaptive.timing.independentCompletionMinutes,
    promptedCompletionMinutes: adaptive.timing.promptedCompletionMinutes,
    ...(availableMinutes === undefined ? {} : { availableMinutes })
  };
}

function hasUnmetPrerequisite(
  adaptive: OxfordAdaptiveMetadata,
  prerequisites: OxfordRecommendationOptions["prerequisites"]
): boolean {
  return adaptive.prerequisiteConcepts.some((concept) =>
    prerequisites?.[concept] === "UNMET"
  );
}

function hasUnknownPrerequisite(
  adaptive: OxfordAdaptiveMetadata,
  prerequisites: OxfordRecommendationOptions["prerequisites"]
): boolean {
  if (adaptive.prerequisiteConcepts.length === 0) return false;
  if (prerequisites === undefined) return true;
  return adaptive.prerequisiteConcepts.some((concept) =>
    prerequisites[concept] === undefined
    || prerequisites[concept] === "UNKNOWN"
  );
}

function isExactProblemCoolingDown(
  profile: OxfordStudentProfile,
  candidate: OxfordRecommendationCandidate,
  window: number
): boolean {
  if (window === 0) return false;
  return profile.recentHistory.slice(0, window).some((entry) =>
    entry.problemId === candidate.problemId
    && entry.problemVersion === candidate.problemVersion
  );
}

function isFamilyCoolingDown(
  profile: OxfordStudentProfile,
  familyId: string,
  window: number
): boolean {
  if (window === 0) return false;
  return profile.recentHistory.slice(0, window).some((entry) =>
    entry.familyId === familyId
  );
}

function isSimilarityClusterCoolingDown(
  profile: OxfordStudentProfile,
  clusterId: string,
  window: number
): boolean {
  if (window === 0) return false;
  return profile.recentHistory.slice(0, window).some((entry) =>
    entry.similarityClusterId === clusterId
  );
}

function problemIdentity(problemId: string, problemVersion: string): string {
  return `${problemId}@${problemVersion}`;
}

function compareRanked(
  left: OxfordRankedRecommendation,
  right: OxfordRankedRecommendation
): number {
  return right.score - left.score
    || left.problemId.localeCompare(right.problemId)
    || left.problemVersion.localeCompare(right.problemVersion);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Oxford recommendation ${label} must be an integer in [${String(min)},${String(max)}]`);
  }
  return value;
}

function resolveAvailableMinutes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || value > 240) {
    throw new RangeError("Oxford recommendation availableMinutes must be in (0,240]");
  }
  return value;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

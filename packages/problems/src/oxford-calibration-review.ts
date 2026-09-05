import {
  OXFORD_CALIBRATION_STATUSES,
  OXFORD_CONTENT_CONCEPT_DOMAINS,
  OXFORD_CONTENT_CONCEPTS,
  OXFORD_DIFFICULTY_BANDS,
  OXFORD_MATH_DOMAINS,
  OXFORD_PREREQUISITE_CONCEPTS,
  OXFORD_REASONING_SKILLS,
  OXFORD_SKILL_EVIDENCE_BASIS,
  OXFORD_STAGE_ROLES,
  assertOxfordAdaptiveMetadataIntegrity,
  isOxfordRecommendationReady,
  type OxfordAdaptiveMetadata,
  type OxfordCalibrationStatus,
  type OxfordContentConcept,
  type OxfordDifficultyBand,
  type OxfordEstimateConfidence,
  type OxfordMathDomain,
  type OxfordPrerequisiteConcept,
  type OxfordReasoningSkill,
  type OxfordStageRole,
  type OxfordTimingEstimate
} from "./oxford-adaptive-taxonomy.js";

export const OXFORD_CALIBRATION_REVIEW_SCHEMA_VERSION = 1 as const;

export const OXFORD_DIFFICULTY_FACTORS = [
  "prerequisite-burden",
  "initial-insight-barrier",
  "conceptual-jumps",
  "abstraction",
  "proof-rigor-burden",
  "representation-changes",
  "productive-prompt-dependency",
  "extension-ceiling"
] as const;
export type OxfordDifficultyFactor = (typeof OXFORD_DIFFICULTY_FACTORS)[number];
export type OxfordDifficultyFactorScore = 0 | 1 | 2 | 3;

export const OXFORD_CALIBRATION_EVIDENCE_BASES = [
  "expert-judgment",
  "independent-expert-agreement",
  "empirical-distribution"
] as const;
export type OxfordCalibrationEvidenceBasis =
  (typeof OXFORD_CALIBRATION_EVIDENCE_BASES)[number];

export const OXFORD_EMPIRICAL_CONDITIONING_AXES = [
  "candidate-strength",
  "assistance-history",
  "stage-reached"
] as const;
export type OxfordEmpiricalConditioningAxis =
  (typeof OXFORD_EMPIRICAL_CONDITIONING_AXES)[number];

export const OXFORD_CALIBRATION_REVIEW_DISPOSITIONS = [
  "safe-for-later-calibration",
  "needs-revision",
  "retain-legacy"
] as const;
export type OxfordCalibrationReviewDisposition =
  (typeof OXFORD_CALIBRATION_REVIEW_DISPOSITIONS)[number];

export type OxfordCalibrationReviewSource =
  | "existing-bank"
  | "agent-c"
  | "agent-d"
  | "agent-e";

export interface OxfordCalibrationEvidence {
  readonly basis: OxfordCalibrationEvidenceBasis;
  readonly reviewerCount: number;
  readonly sampleSize?: number;
  readonly conditionedOn?: readonly OxfordEmpiricalConditioningAxis[];
  readonly distributionSummary?: string;
  readonly notes: string;
}

export interface OxfordCalibrationStageDifficultyReview {
  readonly stageId: string;
  readonly role: OxfordStageRole;
  readonly difficulty: OxfordDifficultyBand;
  readonly rationale: string;
}

export interface OxfordCalibrationStageTimingReview {
  readonly stageId: string;
  readonly timing: OxfordTimingEstimate;
  readonly rationale: string;
}

export interface OxfordCalibrationTaxonomyReview {
  readonly domains: readonly OxfordMathDomain[];
  readonly contentConcepts: readonly OxfordContentConcept[];
  readonly prerequisiteConcepts: readonly OxfordPrerequisiteConcept[];
  readonly reasoningSkills: readonly OxfordReasoningSkill[];
  readonly milestoneSkillClaims: readonly {
    readonly milestoneId: string;
    readonly skills: readonly OxfordReasoningSkill[];
  }[];
  readonly rationale: {
    readonly domains: string;
    readonly contentConcepts: string;
    readonly prerequisiteConcepts: string;
    readonly reasoningSkills: string;
  };
}

export interface OxfordCalibrationDifficultyReview {
  readonly recommendedStatus: OxfordCalibrationStatus;
  readonly entry: OxfordDifficultyBand;
  readonly core: OxfordDifficultyBand;
  readonly ceiling: OxfordDifficultyBand;
  readonly confidence: Exclude<OxfordEstimateConfidence, "unknown">;
  readonly factors: Readonly<Record<OxfordDifficultyFactor, OxfordDifficultyFactorScore>>;
  readonly stageAssessments: readonly OxfordCalibrationStageDifficultyReview[];
  readonly evidence: OxfordCalibrationEvidence;
  readonly rationale: string;
}

export interface OxfordCalibrationTimingReview {
  readonly recommendedStatus: OxfordCalibrationStatus;
  readonly estimate: OxfordTimingEstimate;
  readonly stageAssessments: readonly OxfordCalibrationStageTimingReview[];
  readonly evidence: OxfordCalibrationEvidence;
  readonly rationale: string;
}

export interface OxfordCalibrationReviewRecord {
  readonly schemaVersion: typeof OXFORD_CALIBRATION_REVIEW_SCHEMA_VERSION;
  readonly familyId: string;
  readonly source: OxfordCalibrationReviewSource;
  readonly reviewedMetadataStatus: "provisional-legacy" | "authored" | "author-proposal";
  readonly taxonomy: OxfordCalibrationTaxonomyReview;
  readonly difficulty: OxfordCalibrationDifficultyReview;
  readonly timing: OxfordCalibrationTimingReview;
  readonly disposition: OxfordCalibrationReviewDisposition;
  readonly migration: {
    readonly worthMigrating: boolean;
    readonly recommendation: "migrate" | "revise-before-migration" | "retain-legacy";
    readonly rationale: string;
  };
  readonly blockers: readonly string[];
  readonly ownershipBoundaries: {
    readonly originality: "pending-agent-h";
    readonly fidelity: "pending-agent-h";
    readonly mathematicalCorrectness: "pending-agent-i";
  };
  readonly reviewNotes: readonly string[];
}

export interface OxfordCalibrationReviewSummary {
  readonly total: number;
  readonly byDisposition: Readonly<Record<OxfordCalibrationReviewDisposition, number>>;
  readonly byCoreDifficulty: Readonly<Record<OxfordDifficultyBand, number>>;
  readonly byDomain: Readonly<Record<OxfordMathDomain, number>>;
}

const DOMAIN_SET = new Set<string>(OXFORD_MATH_DOMAINS);
const CONTENT_SET = new Set<string>(OXFORD_CONTENT_CONCEPTS);
const PREREQUISITE_SET = new Set<string>(OXFORD_PREREQUISITE_CONCEPTS);
const SKILL_SET = new Set<string>(OXFORD_REASONING_SKILLS);
const STAGE_ROLE_SET = new Set<string>(OXFORD_STAGE_ROLES);
const DIFFICULTY_SET = new Set<string>(OXFORD_DIFFICULTY_BANDS);
const CALIBRATION_STATUS_SET = new Set<string>(OXFORD_CALIBRATION_STATUSES);
const EVIDENCE_BASIS_SET = new Set<string>(OXFORD_CALIBRATION_EVIDENCE_BASES);
const CONDITIONING_AXIS_SET = new Set<string>(OXFORD_EMPIRICAL_CONDITIONING_AXES);
const DISPOSITION_SET = new Set<string>(OXFORD_CALIBRATION_REVIEW_DISPOSITIONS);
const DIFFICULTY_RANK = new Map<OxfordDifficultyBand, number>(
  OXFORD_DIFFICULTY_BANDS.map((band, index) => [band, index])
);
const CALIBRATION_RANK = new Map<OxfordCalibrationStatus, number>(
  OXFORD_CALIBRATION_STATUSES.map((status, index) => [status, index])
);
const CANONICAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function assertOxfordCalibrationReviewRecord(
  record: OxfordCalibrationReviewRecord
): void {
  if (record.schemaVersion !== OXFORD_CALIBRATION_REVIEW_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Oxford calibration review schema version "${String(record.schemaVersion)}"`
    );
  }
  assertCanonicalId(record.familyId, "Oxford calibration family id");

  if (!["existing-bank", "agent-c", "agent-d", "agent-e"].includes(record.source)) {
    throw new Error(`Invalid Oxford calibration review source "${record.source}"`);
  }
  if (
    !["provisional-legacy", "authored", "author-proposal"].includes(
      record.reviewedMetadataStatus
    )
  ) {
    throw new Error(
      `Invalid Oxford reviewed metadata status "${record.reviewedMetadataStatus}"`
    );
  }

  assertTaxonomyReview(record.taxonomy);
  assertDifficultyReview(record.difficulty);
  assertTimingReview(record.timing);

  if (!DISPOSITION_SET.has(record.disposition)) {
    throw new Error(`Invalid Oxford calibration disposition "${record.disposition}"`);
  }
  if (
    !["migrate", "revise-before-migration", "retain-legacy"].includes(
      record.migration.recommendation
    )
  ) {
    throw new Error(
      `Invalid Oxford calibration migration recommendation "${record.migration.recommendation}"`
    );
  }
  assertNonBlank(record.migration.rationale, "Oxford calibration migration rationale");

  if (
    record.ownershipBoundaries.originality !== "pending-agent-h"
    || record.ownershipBoundaries.fidelity !== "pending-agent-h"
    || record.ownershipBoundaries.mathematicalCorrectness !== "pending-agent-i"
  ) {
    throw new Error(
      "Oxford calibration review cannot claim Agent H originality/fidelity or Agent I correctness approval"
    );
  }

  for (const blocker of record.blockers) {
    assertNonBlank(blocker, "Oxford calibration blocker");
  }
  for (const note of record.reviewNotes) {
    assertNonBlank(note, "Oxford calibration review note");
  }

  const difficultyStageIds = record.difficulty.stageAssessments.map((stage) => stage.stageId);
  const timingStageIds = record.timing.stageAssessments.map((stage) => stage.stageId);
  if (difficultyStageIds.length !== timingStageIds.length) {
    throw new Error(
      "Oxford calibration difficulty and timing stage reviews must cover the same stages"
    );
  }
  const timingSet = new Set(timingStageIds);
  if (
    difficultyStageIds.some((stageId) => !timingSet.has(stageId))
    || timingSet.size !== timingStageIds.length
  ) {
    throw new Error(
      "Oxford calibration difficulty and timing stage reviews must cover the same unique stage IDs"
    );
  }
}

export function assertOxfordCalibrationClaimSupport(
  metadata: OxfordAdaptiveMetadata,
  review: OxfordCalibrationReviewRecord
): void {
  assertOxfordAdaptiveMetadataIntegrity(metadata);
  assertOxfordCalibrationReviewRecord(review);

  if (metadata.familyId !== review.familyId) {
    throw new Error(
      `Calibration review family "${review.familyId}" does not match metadata family "${metadata.familyId}"`
    );
  }

  if (metadata.status !== "authored") {
    if (
      metadata.review.difficultyCalibration !== "unreviewed"
      || metadata.review.timingCalibration !== "unreviewed"
    ) {
      throw new Error("Legacy Oxford metadata cannot carry calibration approval");
    }
    return;
  }

  if (metadata.difficulty === undefined || metadata.timing === undefined) {
    throw new Error("Authored Oxford metadata must carry difficulty and timing before calibration");
  }

  assertCalibrationStatusCovered(
    metadata.review.difficultyCalibration,
    review.difficulty.recommendedStatus,
    "difficulty"
  );
  assertCalibrationStatusCovered(
    metadata.review.timingCalibration,
    review.timing.recommendedStatus,
    "timing"
  );

  if (metadata.review.difficultyCalibration !== "unreviewed") {
    if (
      metadata.difficulty.entry !== review.difficulty.entry
      || metadata.difficulty.core !== review.difficulty.core
      || metadata.difficulty.ceiling !== review.difficulty.ceiling
      || metadata.difficulty.confidence !== review.difficulty.confidence
    ) {
      throw new Error(
        "Oxford difficulty calibration approval must match the independently reviewed profile"
      );
    }
    assertEvidenceSupportsClaim(
      metadata.review.difficultyCalibration,
      metadata.difficulty.confidence,
      review.difficulty.evidence,
      "difficulty"
    );
    assertStageDifficultyMatchesMetadata(metadata, review);
  }

  if (metadata.review.timingCalibration !== "unreviewed") {
    if (!sameTimingEstimate(metadata.timing, review.timing.estimate)) {
      throw new Error(
        "Oxford timing calibration approval must match the independently reviewed estimate"
      );
    }
    assertEvidenceSupportsClaim(
      metadata.review.timingCalibration,
      metadata.timing.confidence,
      review.timing.evidence,
      "timing"
    );
    assertStageTimingMatchesMetadata(metadata, review);
  }
}

export function isOxfordCalibrationReviewSupported(
  metadata: OxfordAdaptiveMetadata,
  review: OxfordCalibrationReviewRecord
): boolean {
  try {
    assertOxfordCalibrationClaimSupport(metadata, review);
    return true;
  } catch {
    return false;
  }
}

export function summarizeOxfordCalibrationReviews(
  records: readonly OxfordCalibrationReviewRecord[]
): OxfordCalibrationReviewSummary {
  const byDisposition = Object.fromEntries(
    OXFORD_CALIBRATION_REVIEW_DISPOSITIONS.map((value) => [value, 0])
  ) as Record<OxfordCalibrationReviewDisposition, number>;
  const byCoreDifficulty = Object.fromEntries(
    OXFORD_DIFFICULTY_BANDS.map((value) => [value, 0])
  ) as Record<OxfordDifficultyBand, number>;
  const byDomain = Object.fromEntries(
    OXFORD_MATH_DOMAINS.map((value) => [value, 0])
  ) as Record<OxfordMathDomain, number>;

  for (const record of records) {
    assertOxfordCalibrationReviewRecord(record);
    byDisposition[record.disposition] += 1;
    byCoreDifficulty[record.difficulty.core] += 1;
    for (const domain of record.taxonomy.domains) {
      byDomain[domain] += 1;
    }
  }

  return Object.freeze({
    total: records.length,
    byDisposition: Object.freeze(byDisposition),
    byCoreDifficulty: Object.freeze(byCoreDifficulty),
    byDomain: Object.freeze(byDomain)
  });
}

/**
 * Returns the canonical recommendation-ready result together with the stricter
 * Gauss review-support result. The latter does not replace Agent A's gate.
 */
export function getOxfordCalibrationReviewState(
  metadata: OxfordAdaptiveMetadata,
  review?: OxfordCalibrationReviewRecord
): {
  readonly difficultyCalibrated: boolean;
  readonly timingCalibrated: boolean;
  readonly recommendationReady: boolean;
  readonly independentReviewSupported: boolean;
} {
  let metadataValid = true;
  try {
    assertOxfordAdaptiveMetadataIntegrity(metadata);
  } catch {
    metadataValid = false;
  }

  if (!metadataValid) {
    return {
      difficultyCalibrated: false,
      timingCalibrated: false,
      recommendationReady: false,
      independentReviewSupported: false
    };
  }

  return {
    difficultyCalibrated: metadata.review.difficultyCalibration !== "unreviewed",
    timingCalibrated: metadata.review.timingCalibration !== "unreviewed",
    recommendationReady: isOxfordRecommendationReady(metadata),
    independentReviewSupported:
      review === undefined ? false : isOxfordCalibrationReviewSupported(metadata, review)
  };
}

function assertTaxonomyReview(review: OxfordCalibrationTaxonomyReview): void {
  assertCanonicalMembers(review.domains, DOMAIN_SET, "Oxford review domain");
  assertCanonicalMembers(review.contentConcepts, CONTENT_SET, "Oxford review content concept");
  assertCanonicalMembers(
    review.prerequisiteConcepts,
    PREREQUISITE_SET,
    "Oxford review prerequisite concept"
  );
  assertCanonicalMembers(review.reasoningSkills, SKILL_SET, "Oxford review reasoning skill");

  if (review.domains.length === 0) {
    throw new Error("Oxford calibration taxonomy review must identify at least one domain");
  }
  if (review.contentConcepts.length === 0) {
    throw new Error(
      "Oxford calibration taxonomy review must identify at least one assessed content concept"
    );
  }
  if (review.reasoningSkills.length === 0) {
    throw new Error("Oxford calibration taxonomy review must identify at least one reasoning skill");
  }

  const domainSet = new Set<OxfordMathDomain>(review.domains);
  for (const concept of review.contentConcepts) {
    const parents = OXFORD_CONTENT_CONCEPT_DOMAINS[concept];
    if (!parents.some((parent) => domainSet.has(parent))) {
      throw new Error(
        `Oxford review content concept "${concept}" requires one of parent domains: ${parents.join(", ")}`
      );
    }
  }

  assertNonBlank(review.rationale.domains, "Oxford domain rationale");
  assertNonBlank(review.rationale.contentConcepts, "Oxford content-concept rationale");
  assertNonBlank(
    review.rationale.prerequisiteConcepts,
    "Oxford prerequisite rationale"
  );
  assertNonBlank(review.rationale.reasoningSkills, "Oxford reasoning-skill rationale");

  const milestoneIds = new Set<string>();
  for (const claim of review.milestoneSkillClaims) {
    assertCanonicalId(claim.milestoneId, "Oxford review milestone id");
    if (milestoneIds.has(claim.milestoneId)) {
      throw new Error(
        `Duplicate Oxford review milestone skill claim "${claim.milestoneId}"`
      );
    }
    milestoneIds.add(claim.milestoneId);
    assertCanonicalMembers(
      claim.skills,
      SKILL_SET,
      `Oxford review milestone "${claim.milestoneId}" reasoning skill`
    );
    for (const skill of claim.skills) {
      if (OXFORD_SKILL_EVIDENCE_BASIS[skill] === "process-grounded") {
        throw new Error(
          `Oxford review milestone "${claim.milestoneId}" cannot claim process-grounded skill "${skill}"`
        );
      }
    }
  }
}

function assertDifficultyReview(review: OxfordCalibrationDifficultyReview): void {
  if (!CALIBRATION_STATUS_SET.has(review.recommendedStatus)) {
    throw new Error(
      `Invalid Oxford recommended difficulty calibration status "${review.recommendedStatus}"`
    );
  }
  for (const band of [review.entry, review.core, review.ceiling]) {
    if (!DIFFICULTY_SET.has(band)) {
      throw new Error(`Invalid Oxford review difficulty band "${band}"`);
    }
  }
  if (
    difficultyRank(review.entry) > difficultyRank(review.core)
    || difficultyRank(review.core) > difficultyRank(review.ceiling)
  ) {
    throw new Error("Oxford calibration review must satisfy entry <= core <= ceiling");
  }

  for (const factor of OXFORD_DIFFICULTY_FACTORS) {
    const score = review.factors[factor];
    if (!Number.isInteger(score) || score < 0 || score > 3) {
      throw new Error(
        `Oxford difficulty factor "${factor}" must use an ordinal 0-3 review score`
      );
    }
  }
  if (Object.keys(review.factors).length !== OXFORD_DIFFICULTY_FACTORS.length) {
    throw new Error("Oxford difficulty review must record every canonical calibration factor once");
  }

  assertEvidenceSupportsClaim(
    review.recommendedStatus,
    review.confidence,
    review.evidence,
    "difficulty"
  );
  assertNonBlank(review.rationale, "Oxford difficulty rationale");

  const stageIds = new Set<string>();
  let matchingCore = false;
  for (const stage of review.stageAssessments) {
    assertCanonicalId(stage.stageId, "Oxford calibration stage id");
    if (stageIds.has(stage.stageId)) {
      throw new Error(`Duplicate Oxford difficulty stage review "${stage.stageId}"`);
    }
    stageIds.add(stage.stageId);
    if (!STAGE_ROLE_SET.has(stage.role)) {
      throw new Error(`Invalid Oxford calibration stage role "${stage.role}"`);
    }
    if (!DIFFICULTY_SET.has(stage.difficulty)) {
      throw new Error(`Invalid Oxford calibration stage difficulty "${stage.difficulty}"`);
    }
    if (
      difficultyRank(stage.difficulty) < difficultyRank(review.entry)
      || difficultyRank(stage.difficulty) > difficultyRank(review.ceiling)
    ) {
      throw new Error(
        `Oxford calibration stage "${stage.stageId}" must lie between family entry and ceiling`
      );
    }
    if (stage.role === "core" && stage.difficulty === review.core) {
      matchingCore = true;
    }
    assertNonBlank(stage.rationale, `Oxford stage "${stage.stageId}" difficulty rationale`);
  }

  if (review.stageAssessments.length > 0 && !matchingCore) {
    throw new Error(
      "Oxford calibration stage review must contain a core stage matching family core difficulty"
    );
  }
}

function assertTimingReview(review: OxfordCalibrationTimingReview): void {
  if (!CALIBRATION_STATUS_SET.has(review.recommendedStatus)) {
    throw new Error(
      `Invalid Oxford recommended timing calibration status "${review.recommendedStatus}"`
    );
  }
  assertTimingEstimate(review.estimate, "Oxford family review timing");
  assertEvidenceSupportsClaim(
    review.recommendedStatus,
    review.estimate.confidence,
    review.evidence,
    "timing"
  );
  assertNonBlank(review.rationale, "Oxford timing rationale");

  const stageIds = new Set<string>();
  for (const stage of review.stageAssessments) {
    assertCanonicalId(stage.stageId, "Oxford calibration timing stage id");
    if (stageIds.has(stage.stageId)) {
      throw new Error(`Duplicate Oxford timing stage review "${stage.stageId}"`);
    }
    stageIds.add(stage.stageId);
    assertTimingEstimate(stage.timing, `Oxford stage "${stage.stageId}" review timing`);
    assertNonBlank(stage.rationale, `Oxford stage "${stage.stageId}" timing rationale`);
  }
}

function assertTimingEstimate(estimate: OxfordTimingEstimate, label: string): void {
  assertMinutesRange(estimate.firstMeaningfulInsightMinutes, `${label} first insight`);
  assertMinutesRange(estimate.independentCompletionMinutes, `${label} independent completion`);
  assertMinutesRange(estimate.promptedCompletionMinutes, `${label} prompted completion`);
  if (estimate.optionalExtensionMinutes !== undefined) {
    assertMinutesRange(estimate.optionalExtensionMinutes, `${label} optional extension`);
  }
  if (!Number.isFinite(estimate.softCutoffMinutes) || estimate.softCutoffMinutes <= 0) {
    throw new Error(`${label} soft cutoff must be positive and finite`);
  }
  if (estimate.softCutoffMinutes < estimate.firstMeaningfulInsightMinutes.max) {
    throw new Error(
      `${label} soft cutoff cannot precede the upper first-meaningful-insight estimate`
    );
  }
  if (
    estimate.independentCompletionMinutes.min < estimate.firstMeaningfulInsightMinutes.min
    || estimate.promptedCompletionMinutes.min < estimate.firstMeaningfulInsightMinutes.min
  ) {
    throw new Error(`${label} completion cannot begin before first meaningful insight`);
  }
  if (!["low", "medium", "high"].includes(estimate.confidence)) {
    throw new Error(`Invalid ${label} confidence "${estimate.confidence}"`);
  }
}

function assertMinutesRange(
  range: { readonly min: number; readonly max: number },
  label: string
): void {
  if (
    !Number.isFinite(range.min)
    || !Number.isFinite(range.max)
    || range.min < 0
    || range.max <= 0
    || range.min > range.max
  ) {
    throw new Error(`${label} must satisfy 0 <= min <= max with max > 0`);
  }
}

function assertEvidenceSupportsClaim(
  status: OxfordCalibrationStatus,
  confidence: Exclude<OxfordEstimateConfidence, "unknown">,
  evidence: OxfordCalibrationEvidence,
  label: string
): void {
  if (!CALIBRATION_STATUS_SET.has(status)) {
    throw new Error(`Invalid Oxford ${label} calibration status "${status}"`);
  }
  if (!EVIDENCE_BASIS_SET.has(evidence.basis)) {
    throw new Error(`Invalid Oxford ${label} calibration evidence basis "${evidence.basis}"`);
  }
  if (!Number.isInteger(evidence.reviewerCount) || evidence.reviewerCount < 1) {
    throw new Error(`Oxford ${label} calibration evidence requires at least one reviewer`);
  }
  assertNonBlank(evidence.notes, `Oxford ${label} calibration evidence notes`);

  if (
    evidence.basis === "independent-expert-agreement"
    && evidence.reviewerCount < 2
  ) {
    throw new Error(
      `Oxford ${label} independent-expert agreement requires at least two reviewers`
    );
  }

  if (evidence.basis === "empirical-distribution") {
    if (
      evidence.sampleSize === undefined
      || !Number.isInteger(evidence.sampleSize)
      || evidence.sampleSize < 1
    ) {
      throw new Error(
        `Oxford ${label} empirical calibration requires a positive sample size`
      );
    }
    if (evidence.conditionedOn === undefined || evidence.conditionedOn.length === 0) {
      throw new Error(
        `Oxford ${label} empirical calibration must record conditioning axes`
      );
    }
    assertCanonicalMembers(
      evidence.conditionedOn,
      CONDITIONING_AXIS_SET,
      `Oxford ${label} empirical conditioning axis`
    );
    if (evidence.distributionSummary === undefined) {
      throw new Error(
        `Oxford ${label} empirical calibration requires a distribution summary`
      );
    }
    assertNonBlank(
      evidence.distributionSummary,
      `Oxford ${label} empirical distribution summary`
    );
  }

  if (status === "empirically-calibrated" && evidence.basis !== "empirical-distribution") {
    throw new Error(
      `Oxford ${label} cannot be empirically calibrated from expert-only evidence`
    );
  }
  if (confidence === "high" && evidence.basis === "expert-judgment") {
    throw new Error(
      `Oxford ${label} high confidence requires independent agreement or empirical evidence`
    );
  }
}

function assertCalibrationStatusCovered(
  metadataStatus: OxfordCalibrationStatus,
  reviewedStatus: OxfordCalibrationStatus,
  label: string
): void {
  const metadataRank = CALIBRATION_RANK.get(metadataStatus);
  const reviewedRank = CALIBRATION_RANK.get(reviewedStatus);
  if (metadataRank === undefined || reviewedRank === undefined || reviewedRank < metadataRank) {
    throw new Error(
      `Oxford ${label} metadata calibration "${metadataStatus}" exceeds independent review "${reviewedStatus}"`
    );
  }
}

function assertStageDifficultyMatchesMetadata(
  metadata: OxfordAdaptiveMetadata,
  review: OxfordCalibrationReviewRecord
): void {
  const reviewedById = new Map(
    review.difficulty.stageAssessments.map((stage) => [stage.stageId, stage] as const)
  );
  if (reviewedById.size !== metadata.stages.length) {
    throw new Error(
      "Oxford difficulty calibration approval requires review of every authored stage"
    );
  }
  for (const stage of metadata.stages) {
    const reviewed = reviewedById.get(stage.id);
    if (
      reviewed === undefined
      || reviewed.role !== stage.role
      || reviewed.difficulty !== stage.difficulty
    ) {
      throw new Error(
        `Oxford difficulty calibration stage review does not match authored stage "${stage.id}"`
      );
    }
  }
}

function assertStageTimingMatchesMetadata(
  metadata: OxfordAdaptiveMetadata,
  review: OxfordCalibrationReviewRecord
): void {
  const reviewedById = new Map(
    review.timing.stageAssessments.map((stage) => [stage.stageId, stage] as const)
  );
  if (reviewedById.size !== metadata.stages.length) {
    throw new Error(
      "Oxford timing calibration approval requires review of every authored stage"
    );
  }
  for (const stage of metadata.stages) {
    const reviewed = reviewedById.get(stage.id);
    if (reviewed === undefined || !sameTimingEstimate(reviewed.timing, stage.timing)) {
      throw new Error(
        `Oxford timing calibration stage review does not match authored stage "${stage.id}"`
      );
    }
  }
}

function sameTimingEstimate(
  left: OxfordTimingEstimate,
  right: OxfordTimingEstimate
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function difficultyRank(band: OxfordDifficultyBand): number {
  const rank = DIFFICULTY_RANK.get(band);
  if (rank === undefined) throw new Error(`Invalid Oxford difficulty band "${band}"`);
  return rank;
}

function assertCanonicalMembers(
  values: readonly string[],
  allowed: ReadonlySet<string>,
  label: string
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(`${label} "${value}" is outside the frozen Oxford taxonomy`);
    }
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label} "${value}"`);
    }
    seen.add(value);
  }
}

function assertCanonicalId(value: string, label: string): void {
  if (!CANONICAL_ID.test(value)) {
    throw new Error(`${label} "${value}" must be a lowercase kebab-case identifier`);
  }
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty after trimming`);
  }
}

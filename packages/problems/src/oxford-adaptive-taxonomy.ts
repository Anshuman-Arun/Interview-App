import type { InterviewProblem } from "../../domain/src/index.js";

export const OXFORD_TAXONOMY_VERSION = "1.0.0" as const;
export const OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION = 1 as const;

export const OXFORD_MATH_DOMAINS = [
  "algebra",
  "functions",
  "graph-sketching",
  "sequences-recurrences",
  "trigonometry",
  "coordinate-geometry",
  "euclidean-geometry",
  "calculus",
  "elementary-analysis",
  "probability",
  "combinatorics",
  "number-theory",
  "graph-theory",
  "logic-proof",
  "functional-equations",
  "set-theory"
] as const;
export type OxfordMathDomain = (typeof OXFORD_MATH_DOMAINS)[number];

export const OXFORD_REASONING_SKILLS = [
  "technique",
  "visualization",
  "graph-sketching",
  "small-case-exploration",
  "pattern-recognition",
  "conjecture-formation",
  "proof-construction",
  "counterexample-construction",
  "invariants",
  "abstraction",
  "modelling",
  "definition-exploration",
  "generalization",
  "transfer",
  "representation-switching",
  "error-recovery",
  "case-analysis",
  "strategic-simplification"
] as const;
export type OxfordReasoningSkill = (typeof OXFORD_REASONING_SKILLS)[number];

export const OXFORD_PREREQUISITE_CONCEPTS = [
  "arithmetic",
  "algebraic-manipulation",
  "equations-inequalities",
  "polynomial-factorization",
  "functions-graphs",
  "sequences-series",
  "exponentials-logarithms",
  "trigonometric-identities",
  "coordinate-geometry-basics",
  "euclidean-geometry-basics",
  "differentiation",
  "integration",
  "limits-continuity",
  "induction",
  "contradiction",
  "divisibility",
  "modular-arithmetic",
  "prime-factorization",
  "counting-principles",
  "binomial-coefficients",
  "basic-probability",
  "conditional-probability",
  "expectation",
  "graph-basics",
  "set-notation",
  "logical-quantifiers"
] as const;
export type OxfordPrerequisiteConcept = (typeof OXFORD_PREREQUISITE_CONCEPTS)[number];

export const OXFORD_STAGE_ROLES = [
  "warm-up",
  "technique-check",
  "core",
  "deep-dive",
  "transfer",
  "stretch"
] as const;
export type OxfordStageRole = (typeof OXFORD_STAGE_ROLES)[number];

export const OXFORD_DIFFICULTY_BANDS = [
  "warm-up",
  "introductory",
  "introductory-plus",
  "standard",
  "strong",
  "stretch"
] as const;
export type OxfordDifficultyBand = (typeof OXFORD_DIFFICULTY_BANDS)[number];

export const OXFORD_SKILL_EVIDENCE_WEIGHTS = [
  "secondary",
  "supporting",
  "primary"
] as const;
export type OxfordSkillEvidenceWeight = (typeof OXFORD_SKILL_EVIDENCE_WEIGHTS)[number];

export const OXFORD_ESTIMATE_CONFIDENCE = [
  "unknown",
  "low",
  "medium",
  "high"
] as const;
export type OxfordEstimateConfidence = (typeof OXFORD_ESTIMATE_CONFIDENCE)[number];

export const OXFORD_REVIEW_STATUSES = [
  "unreviewed",
  "in-review",
  "approved",
  "changes-required"
] as const;
export type OxfordReviewStatus = (typeof OXFORD_REVIEW_STATUSES)[number];

export const OXFORD_CALIBRATION_STATUSES = [
  "unreviewed",
  "expert-estimate",
  "empirically-calibrated"
] as const;
export type OxfordCalibrationStatus = (typeof OXFORD_CALIBRATION_STATUSES)[number];

export const OXFORD_ORIGIN_TYPES = [
  "original",
  "structural-adaptation",
  "classic-problem",
  "legacy-unknown"
] as const;
export type OxfordOriginType = (typeof OXFORD_ORIGIN_TYPES)[number];

export const OXFORD_SOURCE_CATEGORIES = [
  "independent-original",
  "official-interview-pattern",
  "official-preparation-material",
  "classic-mathematics",
  "secondary-reference",
  "unknown"
] as const;
export type OxfordSourceCategory = (typeof OXFORD_SOURCE_CATEGORIES)[number];

export type OxfordQualitativeLevel = "low" | "moderate" | "high";
export type OxfordAdaptiveMetadataStatus = "authored" | "provisional-legacy";

export interface OxfordSkillEvidence {
  readonly skill: OxfordReasoningSkill;
  readonly weight: OxfordSkillEvidenceWeight;
}

export interface OxfordMinutesRange {
  readonly min: number;
  readonly max: number;
}

export interface OxfordTimingEstimate {
  readonly firstMeaningfulInsightMinutes: OxfordMinutesRange;
  readonly independentCompletionMinutes: OxfordMinutesRange;
  readonly promptedCompletionMinutes: OxfordMinutesRange;
  readonly optionalExtensionMinutes?: OxfordMinutesRange;
  readonly softCutoffMinutes: number;
  readonly confidence: Exclude<OxfordEstimateConfidence, "unknown">;
}

export interface OxfordDifficultyProfile {
  readonly entry: OxfordDifficultyBand;
  readonly core: OxfordDifficultyBand;
  readonly ceiling: OxfordDifficultyBand;
  readonly confidence: Exclude<OxfordEstimateConfidence, "unknown">;
}

export interface OxfordMilestoneEvidence {
  readonly milestoneId: string;
  readonly skillEvidence: readonly OxfordSkillEvidence[];
}

export interface OxfordStageMetadata {
  readonly id: string;
  readonly role: OxfordStageRole;
  readonly prerequisiteStageIds: readonly string[];
  readonly domains: readonly OxfordMathDomain[];
  readonly skillEvidence: readonly OxfordSkillEvidence[];
  readonly milestones: readonly OxfordMilestoneEvidence[];
  readonly difficulty: OxfordDifficultyBand;
  readonly timing: OxfordTimingEstimate;
  readonly novelty: OxfordQualitativeLevel;
  readonly abstraction: OxfordQualitativeLevel;
  readonly introducesNewDefinition: boolean;
}

export interface OxfordProvenanceMetadata {
  readonly originType: OxfordOriginType;
  readonly sourceCategory: OxfordSourceCategory;
  /**
   * Optional internal identifier for a benchmark/reference family.
   * Store only a canonical identifier here, never copied source wording.
   */
  readonly referenceFamilyId?: string;
}

export interface OxfordReviewMetadata {
  readonly taxonomyClassification: OxfordReviewStatus;
  readonly originality: OxfordReviewStatus;
  readonly fidelity: OxfordReviewStatus;
  readonly mathematicalCorrectness: OxfordReviewStatus;
  readonly difficultyCalibration: OxfordCalibrationStatus;
  readonly timingCalibration: OxfordCalibrationStatus;
}

export interface OxfordAdaptiveMetadata {
  readonly schemaVersion: typeof OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION;
  readonly taxonomyVersion: typeof OXFORD_TAXONOMY_VERSION;
  readonly status: OxfordAdaptiveMetadataStatus;
  readonly familyId: string;
  readonly similarityClusterId?: string;
  readonly domains: readonly OxfordMathDomain[];
  readonly prerequisiteConcepts: readonly OxfordPrerequisiteConcept[];
  readonly skillEvidence: readonly OxfordSkillEvidence[];
  readonly difficulty?: OxfordDifficultyProfile;
  readonly timing?: OxfordTimingEstimate;
  readonly novelty: OxfordQualitativeLevel | "unknown";
  readonly abstraction: OxfordQualitativeLevel | "unknown";
  readonly introducesNewDefinition: boolean | "unknown";
  readonly stages: readonly OxfordStageMetadata[];
  readonly provenance: OxfordProvenanceMetadata;
  readonly review: OxfordReviewMetadata;
}

const DOMAIN_SET = new Set<string>(OXFORD_MATH_DOMAINS);
const SKILL_SET = new Set<string>(OXFORD_REASONING_SKILLS);
const PREREQUISITE_SET = new Set<string>(OXFORD_PREREQUISITE_CONCEPTS);
const STAGE_ROLE_SET = new Set<string>(OXFORD_STAGE_ROLES);
const DIFFICULTY_SET = new Set<string>(OXFORD_DIFFICULTY_BANDS);
const EVIDENCE_WEIGHT_SET = new Set<string>(OXFORD_SKILL_EVIDENCE_WEIGHTS);
const ESTIMATE_CONFIDENCE_SET = new Set<string>(OXFORD_ESTIMATE_CONFIDENCE);
const REVIEW_STATUS_SET = new Set<string>(OXFORD_REVIEW_STATUSES);
const CALIBRATION_STATUS_SET = new Set<string>(OXFORD_CALIBRATION_STATUSES);
const ORIGIN_TYPE_SET = new Set<string>(OXFORD_ORIGIN_TYPES);
const SOURCE_CATEGORY_SET = new Set<string>(OXFORD_SOURCE_CATEGORIES);
const DIFFICULTY_RANK = new Map<OxfordDifficultyBand, number>(
  OXFORD_DIFFICULTY_BANDS.map((band, index) => [band, index])
);
const CANONICAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function createProvisionalLegacyOxfordMetadata(
  problemId: string
): OxfordAdaptiveMetadata {
  assertCanonicalId(problemId, "Problem id");
  return deepFreeze({
    schemaVersion: OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION,
    taxonomyVersion: OXFORD_TAXONOMY_VERSION,
    status: "provisional-legacy",
    familyId: problemId,
    domains: [],
    prerequisiteConcepts: [],
    skillEvidence: [],
    novelty: "unknown",
    abstraction: "unknown",
    introducesNewDefinition: "unknown",
    stages: [],
    provenance: {
      originType: "legacy-unknown",
      sourceCategory: "unknown"
    },
    review: {
      taxonomyClassification: "unreviewed",
      originality: "unreviewed",
      fidelity: "unreviewed",
      mathematicalCorrectness: "unreviewed",
      difficultyCalibration: "unreviewed",
      timingCalibration: "unreviewed"
    }
  });
}

export function assertOxfordAdaptiveMetadataIntegrity(
  metadata: OxfordAdaptiveMetadata,
  problem?: InterviewProblem
): void {
  if (metadata.schemaVersion !== OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION) {
    throw new Error(`Unsupported Oxford adaptive metadata schema version "${String(metadata.schemaVersion)}"`);
  }
  if (metadata.taxonomyVersion !== OXFORD_TAXONOMY_VERSION) {
    throw new Error(`Unsupported Oxford taxonomy version "${String(metadata.taxonomyVersion)}"`);
  }

  assertCanonicalId(metadata.familyId, "Oxford problem family id");
  if (metadata.similarityClusterId !== undefined) {
    assertCanonicalId(metadata.similarityClusterId, "Oxford similarity cluster id");
  }

  assertCanonicalMembers(metadata.domains, DOMAIN_SET, "Oxford mathematical domain");
  assertCanonicalMembers(
    metadata.prerequisiteConcepts,
    PREREQUISITE_SET,
    "Oxford prerequisite concept"
  );
  assertSkillEvidence(metadata.skillEvidence, "Oxford problem");

  if (!ORIGIN_TYPE_SET.has(metadata.provenance.originType)) {
    throw new Error(`Invalid Oxford provenance origin type "${String(metadata.provenance.originType)}"`);
  }
  if (!SOURCE_CATEGORY_SET.has(metadata.provenance.sourceCategory)) {
    throw new Error(`Invalid Oxford provenance source category "${String(metadata.provenance.sourceCategory)}"`);
  }
  if (metadata.provenance.referenceFamilyId !== undefined) {
    assertCanonicalId(metadata.provenance.referenceFamilyId, "Oxford reference family id");
  }
  assertReviewMetadata(metadata.review);

  if (metadata.status === "provisional-legacy") {
    assertProvisionalLegacyMetadata(metadata);
    return;
  }
  if (metadata.status !== "authored") {
    throw new Error(`Invalid Oxford adaptive metadata status "${String(metadata.status)}"`);
  }

  if (metadata.domains.length === 0) {
    throw new Error("Authored Oxford metadata must define at least one mathematical domain");
  }
  if (metadata.skillEvidence.length === 0) {
    throw new Error("Authored Oxford metadata must define at least one problem-level reasoning skill");
  }
  if (metadata.difficulty === undefined) {
    throw new Error("Authored Oxford metadata must define a difficulty profile");
  }
  if (metadata.timing === undefined) {
    throw new Error("Authored Oxford metadata must define a problem-level timing estimate");
  }
  if (metadata.stages.length === 0) {
    throw new Error("Authored Oxford metadata must define at least one interview stage");
  }
  if (metadata.novelty === "unknown" || metadata.abstraction === "unknown") {
    throw new Error("Authored Oxford metadata must classify novelty and abstraction");
  }
  if (metadata.introducesNewDefinition === "unknown") {
    throw new Error("Authored Oxford metadata must state whether it introduces a new definition");
  }
  if (
    metadata.provenance.originType === "legacy-unknown"
    || metadata.provenance.sourceCategory === "unknown"
  ) {
    throw new Error("Authored Oxford metadata cannot use legacy/unknown provenance");
  }

  assertDifficultyProfile(metadata.difficulty);
  assertTimingEstimate(metadata.timing, "Oxford problem");
  assertAuthoredStages(metadata, problem);
}

function assertProvisionalLegacyMetadata(metadata: OxfordAdaptiveMetadata): void {
  if (
    metadata.domains.length !== 0
    || metadata.prerequisiteConcepts.length !== 0
    || metadata.skillEvidence.length !== 0
    || metadata.stages.length !== 0
    || metadata.difficulty !== undefined
    || metadata.timing !== undefined
    || metadata.novelty !== "unknown"
    || metadata.abstraction !== "unknown"
    || metadata.introducesNewDefinition !== "unknown"
  ) {
    throw new Error("Provisional legacy Oxford metadata must not contain inferred calibration or taxonomy claims");
  }
  if (
    metadata.provenance.originType !== "legacy-unknown"
    || metadata.provenance.sourceCategory !== "unknown"
    || metadata.provenance.referenceFamilyId !== undefined
  ) {
    throw new Error("Provisional legacy Oxford metadata must retain unknown provenance");
  }
  if (
    metadata.review.taxonomyClassification !== "unreviewed"
    || metadata.review.originality !== "unreviewed"
    || metadata.review.fidelity !== "unreviewed"
    || metadata.review.mathematicalCorrectness !== "unreviewed"
    || metadata.review.difficultyCalibration !== "unreviewed"
    || metadata.review.timingCalibration !== "unreviewed"
  ) {
    throw new Error("Provisional legacy Oxford metadata must remain explicitly unreviewed");
  }
}

function assertAuthoredStages(
  metadata: OxfordAdaptiveMetadata,
  problem?: InterviewProblem
): void {
  const stageIds = new Set<string>();
  const familyDomains = new Set<string>(metadata.domains);
  const problemSkills = new Set<string>(metadata.skillEvidence.map((item) => item.skill));
  const milestoneOwners = new Map<string, string>();
  const milestoneIds = problem === undefined
    ? undefined
    : new Set(problem.interviewer.reasoningGraph.milestones.map((milestone) => milestone.id));

  for (const stage of metadata.stages) {
    assertCanonicalId(stage.id, "Oxford stage id");
    if (stageIds.has(stage.id)) {
      throw new Error(`Duplicate Oxford stage id "${stage.id}"`);
    }
    stageIds.add(stage.id);

    if (!STAGE_ROLE_SET.has(stage.role)) {
      throw new Error(`Invalid Oxford stage role "${String(stage.role)}"`);
    }
    assertCanonicalMembers(stage.domains, DOMAIN_SET, `Oxford stage "${stage.id}" domain`);
    if (stage.domains.length === 0) {
      throw new Error(`Oxford stage "${stage.id}" must define at least one domain`);
    }
    for (const domain of stage.domains) {
      if (!familyDomains.has(domain)) {
        throw new Error(`Oxford stage "${stage.id}" domain "${domain}" is not declared at problem level`);
      }
    }

    assertSkillEvidence(stage.skillEvidence, `Oxford stage "${stage.id}"`);
    if (stage.skillEvidence.length === 0) {
      throw new Error(`Oxford stage "${stage.id}" must define at least one reasoning skill`);
    }
    const stageSkills = new Set<string>(stage.skillEvidence.map((item) => item.skill));
    for (const skill of stageSkills) {
      if (!problemSkills.has(skill)) {
        throw new Error(`Oxford stage "${stage.id}" skill "${skill}" is not declared at problem level`);
      }
    }

    if (!DIFFICULTY_SET.has(stage.difficulty)) {
      throw new Error(`Invalid Oxford stage difficulty "${String(stage.difficulty)}"`);
    }
    const entryRank = difficultyRank(metadata.difficulty?.entry);
    const ceilingRank = difficultyRank(metadata.difficulty?.ceiling);
    const stageRank = difficultyRank(stage.difficulty);
    if (stageRank < entryRank || stageRank > ceilingRank) {
      throw new Error(`Oxford stage "${stage.id}" difficulty must lie between family entry and ceiling`);
    }

    assertTimingEstimate(stage.timing, `Oxford stage "${stage.id}"`);
    if (!["low", "moderate", "high"].includes(stage.novelty)) {
      throw new Error(`Invalid Oxford stage novelty "${String(stage.novelty)}"`);
    }
    if (!["low", "moderate", "high"].includes(stage.abstraction)) {
      throw new Error(`Invalid Oxford stage abstraction "${String(stage.abstraction)}"`);
    }

    if (stage.milestones.length === 0) {
      throw new Error(`Oxford stage "${stage.id}" must map at least one reasoning milestone`);
    }
    for (const milestone of stage.milestones) {
      assertCanonicalId(milestone.milestoneId, `Oxford stage "${stage.id}" milestone id`);
      if (milestoneOwners.has(milestone.milestoneId)) {
        throw new Error(
          `Reasoning milestone "${milestone.milestoneId}" is assigned to multiple Oxford stages`
        );
      }
      milestoneOwners.set(milestone.milestoneId, stage.id);
      if (milestoneIds !== undefined && !milestoneIds.has(milestone.milestoneId)) {
        throw new Error(
          `Oxford stage "${stage.id}" references unknown reasoning milestone "${milestone.milestoneId}"`
        );
      }
      assertSkillEvidence(
        milestone.skillEvidence,
        `Oxford milestone "${milestone.milestoneId}"`
      );
      if (milestone.skillEvidence.length === 0) {
        throw new Error(
          `Oxford milestone "${milestone.milestoneId}" must define at least one reasoning skill`
        );
      }
      for (const item of milestone.skillEvidence) {
        if (!stageSkills.has(item.skill)) {
          throw new Error(
            `Oxford milestone "${milestone.milestoneId}" skill "${item.skill}" is not declared at stage level`
          );
        }
      }
    }
  }

  if (!metadata.stages.some((stage) => stage.role === "core")) {
    throw new Error("Authored Oxford metadata must contain at least one core stage");
  }
  if (
    metadata.difficulty !== undefined
    && !metadata.stages.some(
      (stage) => stage.role === "core" && stage.difficulty === metadata.difficulty?.core
    )
  ) {
    throw new Error("Oxford family core difficulty must match at least one core stage");
  }

  for (const stage of metadata.stages) {
    assertUniqueCanonicalIds(stage.prerequisiteStageIds, `Oxford stage "${stage.id}" prerequisite`);
    for (const prerequisiteId of stage.prerequisiteStageIds) {
      if (prerequisiteId === stage.id) {
        throw new Error(`Oxford stage "${stage.id}" cannot require itself`);
      }
      if (!stageIds.has(prerequisiteId)) {
        throw new Error(
          `Oxford stage "${stage.id}" references unknown prerequisite stage "${prerequisiteId}"`
        );
      }
    }
  }

  const stageReachability = assertStageGraphIsDag(metadata.stages);

  if (problem !== undefined && milestoneIds !== undefined) {
    for (const milestoneId of milestoneIds) {
      if (!milestoneOwners.has(milestoneId)) {
        throw new Error(
          `Authored Oxford metadata does not assign reasoning milestone "${milestoneId}" to a stage`
        );
      }
    }

    for (const milestone of problem.interviewer.reasoningGraph.milestones) {
      const targetStage = milestoneOwners.get(milestone.id);
      if (targetStage === undefined) continue;
      for (const prerequisiteId of milestone.optionalPrerequisiteIds) {
        const sourceStage = milestoneOwners.get(prerequisiteId);
        if (sourceStage === undefined || sourceStage === targetStage) continue;
        if (!(stageReachability.get(sourceStage)?.has(targetStage) ?? false)) {
          throw new Error(
            `Oxford stage graph does not preserve reasoning dependency "${prerequisiteId}" -> "${milestone.id}"`
          );
        }
      }
    }
  }

  const anyStageIntroducesDefinition = metadata.stages.some(
    (stage) => stage.introducesNewDefinition
  );
  if (
    metadata.introducesNewDefinition !== "unknown"
    && metadata.introducesNewDefinition !== anyStageIntroducesDefinition
  ) {
    throw new Error(
      "Problem-level introducesNewDefinition must agree with stage-level metadata"
    );
  }
}

function assertStageGraphIsDag(
  stages: readonly OxfordStageMetadata[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const stage of stages) {
    indegree.set(stage.id, 0);
    adjacency.set(stage.id, []);
  }
  for (const stage of stages) {
    for (const prerequisiteId of stage.prerequisiteStageIds) {
      adjacency.get(prerequisiteId)?.push(stage.id);
      indegree.set(stage.id, (indegree.get(stage.id) ?? 0) + 1);
    }
  }

  const queue = stages
    .map((stage) => stage.id)
    .filter((stageId) => (indegree.get(stageId) ?? 0) === 0);
  let cursor = 0;
  let visited = 0;
  while (cursor < queue.length) {
    const stageId = queue[cursor];
    cursor += 1;
    if (stageId === undefined) continue;
    visited += 1;
    for (const next of adjacency.get(stageId) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (visited !== stages.length) {
    throw new Error("Oxford stage graph must be acyclic");
  }

  const reachability = new Map<string, ReadonlySet<string>>();
  for (const stage of stages) {
    const reached = new Set<string>();
    const pending = [...(adjacency.get(stage.id) ?? [])];
    let index = 0;
    while (index < pending.length) {
      const current = pending[index];
      index += 1;
      if (current === undefined || reached.has(current)) continue;
      reached.add(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
    reachability.set(stage.id, reached);
  }
  return reachability;
}

function assertDifficultyProfile(profile: OxfordDifficultyProfile): void {
  for (const [label, band] of [
    ["entry", profile.entry],
    ["core", profile.core],
    ["ceiling", profile.ceiling]
  ] as const) {
    if (!DIFFICULTY_SET.has(band)) {
      throw new Error(`Invalid Oxford ${label} difficulty "${String(band)}"`);
    }
  }
  if (!ESTIMATE_CONFIDENCE_SET.has(profile.confidence) || profile.confidence === "unknown") {
    throw new Error(`Invalid Oxford difficulty confidence "${String(profile.confidence)}"`);
  }
  if (
    difficultyRank(profile.entry) > difficultyRank(profile.core)
    || difficultyRank(profile.core) > difficultyRank(profile.ceiling)
  ) {
    throw new Error("Oxford difficulty must satisfy entry <= core <= ceiling");
  }
}

function assertTimingEstimate(estimate: OxfordTimingEstimate, label: string): void {
  assertMinutesRange(estimate.firstMeaningfulInsightMinutes, `${label} first-insight time`);
  assertMinutesRange(estimate.independentCompletionMinutes, `${label} independent completion time`);
  assertMinutesRange(estimate.promptedCompletionMinutes, `${label} prompted completion time`);
  if (estimate.optionalExtensionMinutes !== undefined) {
    assertMinutesRange(estimate.optionalExtensionMinutes, `${label} extension time`);
  }
  if (!Number.isFinite(estimate.softCutoffMinutes) || estimate.softCutoffMinutes <= 0) {
    throw new Error(`${label} soft cutoff must be a positive finite number`);
  }
  if (estimate.softCutoffMinutes < estimate.firstMeaningfulInsightMinutes.min) {
    throw new Error(`${label} soft cutoff cannot precede the earliest first-insight estimate`);
  }
  if (!ESTIMATE_CONFIDENCE_SET.has(estimate.confidence) || estimate.confidence === "unknown") {
    throw new Error(`Invalid ${label} timing confidence "${String(estimate.confidence)}"`);
  }
}

function assertMinutesRange(range: OxfordMinutesRange, label: string): void {
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

function assertSkillEvidence(
  evidence: readonly OxfordSkillEvidence[],
  label: string
): void {
  const seen = new Set<string>();
  for (const item of evidence) {
    if (!SKILL_SET.has(item.skill)) {
      throw new Error(`${label} has illegal reasoning skill "${String(item.skill)}"`);
    }
    if (!EVIDENCE_WEIGHT_SET.has(item.weight)) {
      throw new Error(`${label} has invalid skill evidence weight "${String(item.weight)}"`);
    }
    if (seen.has(item.skill)) {
      throw new Error(`${label} repeats reasoning skill "${item.skill}"`);
    }
    seen.add(item.skill);
  }
}

function assertReviewMetadata(review: OxfordReviewMetadata): void {
  for (const [label, value] of [
    ["taxonomy classification", review.taxonomyClassification],
    ["originality", review.originality],
    ["fidelity", review.fidelity],
    ["mathematical correctness", review.mathematicalCorrectness]
  ] as const) {
    if (!REVIEW_STATUS_SET.has(value)) {
      throw new Error(`Invalid Oxford ${label} review status "${String(value)}"`);
    }
  }
  if (!CALIBRATION_STATUS_SET.has(review.difficultyCalibration)) {
    throw new Error(
      `Invalid Oxford difficulty calibration status "${String(review.difficultyCalibration)}"`
    );
  }
  if (!CALIBRATION_STATUS_SET.has(review.timingCalibration)) {
    throw new Error(
      `Invalid Oxford timing calibration status "${String(review.timingCalibration)}"`
    );
  }
}

function assertCanonicalMembers(
  values: readonly string[],
  allowed: ReadonlySet<string>,
  label: string
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(`${label} "${String(value)}" is not part of taxonomy ${OXFORD_TAXONOMY_VERSION}`);
    }
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label} "${value}"`);
    }
    seen.add(value);
  }
}

function assertUniqueCanonicalIds(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    assertCanonicalId(value, label);
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label} "${value}"`);
    }
    seen.add(value);
  }
}

function assertCanonicalId(value: string, label: string): void {
  if (!CANONICAL_ID.test(value)) {
    throw new Error(`${label} "${String(value)}" must be a lowercase kebab-case identifier`);
  }
}

function difficultyRank(band: OxfordDifficultyBand | undefined): number {
  if (band === undefined) {
    throw new Error("Oxford difficulty profile is required before stage validation");
  }
  const rank = DIFFICULTY_RANK.get(band);
  if (rank === undefined) {
    throw new Error(`Invalid Oxford difficulty "${String(band)}"`);
  }
  return rank;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

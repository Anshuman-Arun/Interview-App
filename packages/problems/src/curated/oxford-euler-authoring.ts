import type { CuratedProblemSpec } from "../curated-authoring.js";
import {
  OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION,
  OXFORD_TAXONOMY_VERSION,
  getOxfordSkillEvidenceBasis,
  type OxfordAdaptiveMetadata,
  type OxfordContentConcept,
  type OxfordDifficultyBand,
  type OxfordMathDomain,
  type OxfordPrerequisiteConcept,
  type OxfordQualitativeLevel,
  type OxfordReasoningSkill,
  type OxfordSkillEvidence,
  type OxfordStageRole,
  type OxfordTimingEstimate
} from "../oxford-adaptive-taxonomy.js";

export interface EulerStageDefinition {
  readonly id: string;
  readonly description: string;
  readonly contentConcepts: readonly OxfordContentConcept[];
  readonly skills: readonly OxfordReasoningSkill[];
  readonly difficulty: OxfordDifficultyBand;
  readonly novelty: OxfordQualitativeLevel;
  readonly abstraction: OxfordQualitativeLevel;
}

export interface EulerFamilyDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly topics: readonly string[];
  readonly prompt: string;
  readonly givenInformation: readonly string[];
  readonly domains: readonly OxfordMathDomain[];
  readonly contentConcepts: readonly OxfordContentConcept[];
  readonly prerequisiteConcepts: readonly OxfordPrerequisiteConcept[];
  readonly skills: readonly OxfordReasoningSkill[];
  readonly difficulty: {
    readonly entry: OxfordDifficultyBand;
    readonly core: OxfordDifficultyBand;
    readonly ceiling: OxfordDifficultyBand;
  };
  readonly novelty: OxfordQualitativeLevel;
  readonly abstraction: OxfordQualitativeLevel;
  readonly introducesNewDefinition: boolean;
  readonly stages: readonly [
    EulerStageDefinition,
    EulerStageDefinition,
    EulerStageDefinition,
    EulerStageDefinition,
    EulerStageDefinition
  ];
  readonly commonErrors: readonly { readonly id: string; readonly description: string }[];
  readonly followUps: readonly string[];
  readonly extensions: readonly { readonly id: string; readonly prompt: string }[];
  readonly hints: readonly [
    { readonly text: string; readonly formulations: readonly string[] },
    { readonly text: string; readonly formulations: readonly string[] },
    { readonly text: string; readonly formulations: readonly string[] },
    { readonly text: string; readonly formulations: readonly string[] },
    { readonly text: string; readonly formulations: readonly string[] }
  ];
  readonly canonicalSolution: string;
  readonly verificationNotes: string;
}

const STAGE_TIMING: readonly OxfordTimingEstimate[] = [
  {
    firstMeaningfulInsightMinutes: { min: 0.5, max: 1.5 },
    independentCompletionMinutes: { min: 2, max: 4 },
    promptedCompletionMinutes: { min: 1.5, max: 3 },
    softCutoffMinutes: 4,
    confidence: "low"
  },
  {
    firstMeaningfulInsightMinutes: { min: 1, max: 2.5 },
    independentCompletionMinutes: { min: 4, max: 7 },
    promptedCompletionMinutes: { min: 3, max: 6 },
    softCutoffMinutes: 7,
    confidence: "low"
  },
  {
    firstMeaningfulInsightMinutes: { min: 1, max: 3 },
    independentCompletionMinutes: { min: 5, max: 9 },
    promptedCompletionMinutes: { min: 4, max: 8 },
    softCutoffMinutes: 9,
    confidence: "low"
  },
  {
    firstMeaningfulInsightMinutes: { min: 0.5, max: 2 },
    independentCompletionMinutes: { min: 3, max: 6 },
    promptedCompletionMinutes: { min: 2, max: 5 },
    softCutoffMinutes: 6,
    confidence: "low"
  },
  {
    firstMeaningfulInsightMinutes: { min: 1, max: 3 },
    independentCompletionMinutes: { min: 5, max: 10 },
    promptedCompletionMinutes: { min: 4, max: 8 },
    optionalExtensionMinutes: { min: 3, max: 7 },
    softCutoffMinutes: 9,
    confidence: "low"
  }
];

const FAMILY_TIMING: OxfordTimingEstimate = {
  firstMeaningfulInsightMinutes: { min: 1, max: 4 },
  independentCompletionMinutes: { min: 18, max: 30 },
  promptedCompletionMinutes: { min: 14, max: 25 },
  optionalExtensionMinutes: { min: 5, max: 12 },
  softCutoffMinutes: 25,
  confidence: "low"
};

const EULER_REVIEW: OxfordAdaptiveMetadata["review"] = {
  taxonomyClassification: "in-review",
  originality: "in-review",
  fidelity: "in-review",
  mathematicalCorrectness: "in-review",
  difficultyCalibration: "unreviewed",
  timingCalibration: "unreviewed"
};

const EULER_REVIEW_NOTES =
  "Agent E — Euler candidate; independent calibration, originality/fidelity, and correctness gates remain pending for Agents G, H, and I.";

const EULER_SIMILARITY_CLUSTERS: Readonly<Record<string, string>> = Object.freeze({
  "oxford-euler-quadrilateral-balance": "euler-distance-loci",
  "oxford-euler-circle-sweep": "euler-distance-loci",
  "oxford-euler-triangle-midpoint-cycle": "euler-affine-dynamics",
  "oxford-euler-diagonal-blend-transform": "euler-affine-dynamics",
  "oxford-euler-locally-balanced-labels": "euler-local-balance",
  "oxford-euler-corner-balanced-tables": "euler-local-balance",
  "oxford-euler-periodic-queue-model": "euler-discrete-dynamics-model",
  "oxford-euler-cooling-data-model": "euler-discrete-dynamics-model",
  "oxford-euler-random-adjacent-consecutives": "euler-local-indicator-expectation",
  "oxford-euler-random-subset-blocks": "euler-local-indicator-expectation"
});

function evidenceFor(
  skills: readonly OxfordReasoningSkill[]
): readonly OxfordSkillEvidence[] {
  return skills.map((skill, index) => ({
    skill,
    weight: index === 0 ? "primary" : "supporting"
  }));
}

function milestoneEvidenceFor(
  skills: readonly OxfordReasoningSkill[]
): readonly OxfordSkillEvidence[] {
  return evidenceFor(
    skills.filter((skill) => getOxfordSkillEvidenceBasis(skill) === "milestone-grounded")
  );
}

function stageRoleFor(
  family: EulerFamilyDefinition,
  index: number
): OxfordStageRole {
  if (index === 0) return "warm-up";
  if (index === family.stages.length - 1) return "transfer";
  const firstCoreIndex = family.stages.findIndex(
    (stage, stageIndex) =>
      stageIndex > 0
      && stageIndex < family.stages.length - 1
      && stage.difficulty === family.difficulty.core
  );
  if (firstCoreIndex < 0) {
    throw new Error(`Euler family "${family.id}" has no interior stage at its core difficulty`);
  }
  return index === firstCoreIndex ? "core" : "deep-dive";
}

export function makeEulerCandidateSpec(family: EulerFamilyDefinition): CuratedProblemSpec {
  const approaches = [{
    id: "primary",
    label: "Develop and justify the family structure"
  }] as const;

  const milestones = family.stages.map((stage, index) => ({
    id: stage.id,
    description: stage.description,
    approachIds: ["primary"],
    ...(index === 0 ? {} : { prerequisiteIds: [family.stages[index - 1]!.id] }),
    hintLevels: [index + 1 as 1 | 2 | 3 | 4 | 5]
  }));

  const edges = family.stages.slice(1).map((stage, index) => ({
    from: family.stages[index]!.id,
    to: stage.id
  }));

  const oxfordAdaptive: OxfordAdaptiveMetadata = {
    schemaVersion: OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION,
    taxonomyVersion: OXFORD_TAXONOMY_VERSION,
    status: "authored",
    familyId: family.id,
    ...(EULER_SIMILARITY_CLUSTERS[family.id] === undefined
      ? {}
      : { similarityClusterId: EULER_SIMILARITY_CLUSTERS[family.id] }),
    domains: family.domains,
    contentConcepts: family.contentConcepts,
    prerequisiteConcepts: family.prerequisiteConcepts,
    skillEvidence: evidenceFor(family.skills),
    difficulty: {
      ...family.difficulty,
      confidence: "low"
    },
    timing: FAMILY_TIMING,
    novelty: family.novelty,
    abstraction: family.abstraction,
    introducesNewDefinition: family.introducesNewDefinition,
    stages: family.stages.map((stage, index) => ({
      id: stage.id,
      role: stageRoleFor(family, index),
      prerequisiteStageIds: index === 0 ? [] : [family.stages[index - 1]!.id],
      domains: family.domains,
      contentConcepts: stage.contentConcepts,
      skillEvidence: evidenceFor(stage.skills),
      milestones: [{
        milestoneId: stage.id,
        skillEvidence: milestoneEvidenceFor(stage.skills),
        contentConcepts: stage.contentConcepts
      }],
      extensionIds: index === family.stages.length - 1
        ? family.extensions.map((extension) => extension.id)
        : [],
      difficulty: stage.difficulty,
      timing: STAGE_TIMING[index]!,
      novelty: stage.novelty,
      abstraction: stage.abstraction,
      introducesNewDefinition: family.introducesNewDefinition && index === 0
    })),
    provenance: {
      originType: "original",
      sourceCategory: "independent-original"
    },
    review: EULER_REVIEW
  };

  return {
    id: family.id,
    title: family.title,
    mode: "OXFORD_MATHEMATICS",
    category: family.category,
    topics: family.topics,
    difficulty: "pending-independent-calibration",
    prompt: family.prompt,
    givenInformation: family.givenInformation,
    approaches,
    milestones,
    edges,
    commonErrors: family.commonErrors,
    followUps: family.followUps,
    extensions: family.extensions,
    hints: family.hints.map((hint, index) => ({
      level: index + 1 as 1 | 2 | 3 | 4 | 5,
      text: hint.text,
      formulations: hint.formulations
    })),
    canonicalSolution: family.canonicalSolution,
    verificationNotes: family.verificationNotes,
    reviewStatus: "expert-review",
    reviewNotes: EULER_REVIEW_NOTES,
    oxfordAdaptive
  };
}


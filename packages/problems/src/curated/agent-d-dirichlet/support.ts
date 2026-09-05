import type { OxfordAdaptiveMetadata, OxfordDifficultyBand, OxfordMathDomain, OxfordContentConcept, OxfordPrerequisiteConcept, OxfordReasoningSkill, OxfordSkillEvidence, OxfordSkillEvidenceWeight, OxfordStageRole, OxfordProvenanceMetadata, OxfordQualitativeLevel } from "../../oxford-adaptive-taxonomy.js";
import { OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION, OXFORD_TAXONOMY_VERSION } from "../../oxford-adaptive-taxonomy.js";

export const DIRICHLET_CANDIDATE_REVIEW_NOTES =
  "Agent D — Dirichlet candidate family. Keep in expert review until Agent G independently calibrates difficulty/timing and reviews fidelity/taxonomy, Agent H independently clears originality, and Agent I independently audits mathematical correctness.";

const PENDING_REVIEW = Object.freeze({
  taxonomyClassification: "unreviewed",
  originality: "unreviewed",
  fidelity: "unreviewed",
  mathematicalCorrectness: "unreviewed",
  difficultyCalibration: "unreviewed",
  timingCalibration: "unreviewed"
} as const);

const WHOLE_TIMING = Object.freeze({
  firstMeaningfulInsightMinutes: { min: 2, max: 6 },
  independentCompletionMinutes: { min: 14, max: 24 },
  promptedCompletionMinutes: { min: 10, max: 20 },
  optionalExtensionMinutes: { min: 4, max: 9 },
  softCutoffMinutes: 27,
  confidence: "low"
} as const);

const STAGE_TIMING = Object.freeze({
  opening: Object.freeze({
    firstMeaningfulInsightMinutes: { min: 1, max: 3 },
    independentCompletionMinutes: { min: 2, max: 5 },
    promptedCompletionMinutes: { min: 2, max: 4 },
    softCutoffMinutes: 6,
    confidence: "low"
  }),
  core: Object.freeze({
    firstMeaningfulInsightMinutes: { min: 2, max: 5 },
    independentCompletionMinutes: { min: 7, max: 13 },
    promptedCompletionMinutes: { min: 5, max: 11 },
    softCutoffMinutes: 15,
    confidence: "low"
  }),
  transfer: Object.freeze({
    firstMeaningfulInsightMinutes: { min: 1, max: 4 },
    independentCompletionMinutes: { min: 5, max: 10 },
    promptedCompletionMinutes: { min: 4, max: 9 },
    optionalExtensionMinutes: { min: 3, max: 8 },
    softCutoffMinutes: 11,
    confidence: "low"
  })
} as const);

export interface DirichletStageInput {
  readonly id: string;
  readonly role: OxfordStageRole;
  readonly prerequisiteStageIds: readonly string[];
  readonly domains: readonly OxfordMathDomain[];
  readonly contentConcepts: readonly OxfordContentConcept[];
  readonly skillEvidence: readonly OxfordSkillEvidence[];
  readonly milestones: readonly {
    readonly milestoneId: string;
    readonly skillEvidence: readonly OxfordSkillEvidence[];
    readonly contentConcepts: readonly OxfordContentConcept[];
  }[];
  readonly extensionIds: readonly string[];
  readonly difficulty: OxfordDifficultyBand;
  readonly introducesNewDefinition?: boolean;
  readonly novelty?: OxfordQualitativeLevel;
  readonly abstraction?: OxfordQualitativeLevel;
  readonly timingKind: "opening" | "core" | "transfer";
}

export interface DirichletAdaptiveInput {
  readonly familyId: string;
  readonly similarityClusterId?: string;
  readonly domains: readonly OxfordMathDomain[];
  readonly contentConcepts: readonly OxfordContentConcept[];
  readonly prerequisiteConcepts: readonly OxfordPrerequisiteConcept[];
  readonly skillEvidence: readonly OxfordSkillEvidence[];
  readonly difficulty: {
    readonly entry: OxfordDifficultyBand;
    readonly core: OxfordDifficultyBand;
    readonly ceiling: OxfordDifficultyBand;
  };
  readonly novelty: OxfordQualitativeLevel;
  readonly abstraction: OxfordQualitativeLevel;
  readonly introducesNewDefinition: boolean;
  readonly stages: readonly DirichletStageInput[];
  readonly provenance?: OxfordProvenanceMetadata;
}

export function evidence(
  skill: OxfordReasoningSkill,
  weight: OxfordSkillEvidenceWeight
): OxfordSkillEvidence {
  return { skill, weight };
}

export function makeDirichletAdaptive(input: DirichletAdaptiveInput): OxfordAdaptiveMetadata {
  return {
    schemaVersion: OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION,
    taxonomyVersion: OXFORD_TAXONOMY_VERSION,
    status: "authored",
    familyId: input.familyId,
    ...(input.similarityClusterId === undefined
      ? {}
      : { similarityClusterId: input.similarityClusterId }),
    domains: input.domains,
    contentConcepts: input.contentConcepts,
    prerequisiteConcepts: input.prerequisiteConcepts,
    skillEvidence: input.skillEvidence,
    difficulty: {
      ...input.difficulty,
      confidence: "low"
    },
    timing: WHOLE_TIMING,
    novelty: input.novelty,
    abstraction: input.abstraction,
    introducesNewDefinition: input.introducesNewDefinition,
    stages: input.stages.map((stage) => ({
      id: stage.id,
      role: stage.role,
      prerequisiteStageIds: stage.prerequisiteStageIds,
      domains: stage.domains,
      contentConcepts: stage.contentConcepts,
      skillEvidence: stage.skillEvidence,
      milestones: stage.milestones,
      extensionIds: stage.extensionIds,
      difficulty: stage.difficulty,
      timing: STAGE_TIMING[stage.timingKind],
      novelty: stage.novelty ?? input.novelty,
      abstraction: stage.abstraction ?? input.abstraction,
      introducesNewDefinition: stage.introducesNewDefinition ?? false
    })),
    provenance: input.provenance ?? {
      originType: "original",
      sourceCategory: "independent-original"
    },
    review: PENDING_REVIEW
  };
}

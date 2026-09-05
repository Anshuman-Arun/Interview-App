import type {
  OxfordAdaptiveMetadata,
  OxfordContentConcept,
  OxfordDifficultyBand,
  OxfordMathDomain,
  OxfordPrerequisiteConcept,
  OxfordProvenanceMetadata,
  OxfordQualitativeLevel,
  OxfordReasoningSkill,
  OxfordReviewMetadata,
  OxfordSkillEvidence,
  OxfordSkillEvidenceWeight,
  OxfordStageRole,
  OxfordTimingEstimate
} from "../../oxford-adaptive-taxonomy.js";
import {
  OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION,
  OXFORD_TAXONOMY_VERSION
} from "../../oxford-adaptive-taxonomy.js";

export const DIRICHLET_CANDIDATE_REVIEW_NOTES =
  "Agent D — Dirichlet completion-pass candidate. Keep in expert review until every outstanding Agent G calibration/taxonomy field, Agent H originality/fidelity field, and Agent I mathematical-correctness field has been independently reviewed.";

const PENDING_REVIEW = Object.freeze({
  taxonomyClassification: "unreviewed",
  originality: "unreviewed",
  fidelity: "unreviewed",
  mathematicalCorrectness: "unreviewed",
  difficultyCalibration: "unreviewed",
  timingCalibration: "unreviewed"
} as const);

function timing(
  insightMin: number,
  insightMax: number,
  independentMin: number,
  independentMax: number,
  promptedMin: number,
  promptedMax: number,
  softCutoffMinutes: number,
  extensionMin?: number,
  extensionMax?: number
): OxfordTimingEstimate {
  return Object.freeze({
    firstMeaningfulInsightMinutes: { min: insightMin, max: insightMax },
    independentCompletionMinutes: { min: independentMin, max: independentMax },
    promptedCompletionMinutes: { min: promptedMin, max: promptedMax },
    ...(extensionMin === undefined || extensionMax === undefined
      ? {}
      : {
          optionalExtensionMinutes: {
            min: extensionMin,
            max: extensionMax
          }
        }),
    softCutoffMinutes,
    confidence: "low"
  });
}

interface DirichletFamilyTiming {
  readonly whole: OxfordTimingEstimate;
  readonly stages: Readonly<Record<string, OxfordTimingEstimate>>;
}

/**
 * Low-confidence author estimates only. These are intentionally family-specific;
 * Agent G must independently calibrate every surviving family.
 */
const DIRICHLET_FAMILY_TIMING: Readonly<Record<string, DirichletFamilyTiming>> =
  Object.freeze({
    "oxford-d-gcd-descent-network": {
      whole: timing(1, 3, 10, 16, 7, 12, 18, 3, 6),
      stages: {
        "network-opening": timing(1, 2, 2, 4, 1, 3, 5),
        "network-core": timing(2, 4, 6, 10, 4, 8, 12),
        "network-transfer": timing(1, 2, 3, 5, 2, 4, 7, 2, 5)
      }
    },
    "oxford-d-thirds-closed-integers": {
      whole: timing(3, 6, 17, 28, 13, 22, 25, 5, 9),
      stages: {
        "thirds-opening": timing(2, 4, 3, 6, 2, 4, 7),
        "thirds-core": timing(3, 6, 8, 14, 6, 11, 15),
        "thirds-transfer": timing(2, 5, 6, 8, 5, 7, 10, 5, 9)
      }
    },
    "oxford-d-balancing-transfers": {
      whole: timing(2, 5, 14, 22, 10, 17, 25, 4, 8),
      stages: {
        "balancing-opening": timing(1, 3, 3, 5, 2, 4, 6),
        "balancing-core": timing(2, 5, 7, 12, 5, 9, 14),
        "balancing-transfer": timing(2, 4, 5, 8, 3, 6, 10, 4, 7)
      }
    },
    "oxford-d-cube-twist-equivalence": {
      whole: timing(2, 5, 14, 23, 10, 18, 22, 4, 7),
      stages: {
        "cube-opening": timing(1, 3, 3, 5, 2, 4, 6),
        "cube-core": timing(2, 5, 7, 11, 5, 9, 12),
        "cube-transfer": timing(2, 4, 4, 7, 3, 5, 8, 4, 7)
      }
    },
    "oxford-d-sliding-window-parity": {
      whole: timing(1, 4, 12, 20, 9, 16, 20, 4, 7),
      stages: {
        "window-opening": timing(1, 2, 2, 4, 1, 3, 5),
        "window-core": timing(1, 4, 6, 10, 5, 8, 11),
        "window-transfer": timing(1, 3, 4, 6, 3, 5, 7, 4, 7)
      }
    },
    "oxford-d-weighted-cycle-readings": {
      whole: timing(2, 5, 15, 24, 11, 20, 23, 4, 8),
      stages: {
        "weighted-cycle-opening": timing(1, 3, 3, 5, 2, 4, 6),
        "weighted-cycle-core": timing(2, 5, 8, 13, 6, 11, 14),
        "weighted-cycle-transfer": timing(2, 4, 4, 6, 3, 5, 8, 4, 8)
      }
    },
    "oxford-d-midpoint-closed-residues": {
      whole: timing(3, 6, 17, 28, 13, 22, 25, 5, 9),
      stages: {
        "midpoint-opening": timing(2, 4, 4, 6, 3, 5, 7),
        "midpoint-core": timing(3, 6, 8, 14, 6, 11, 15),
        "midpoint-transfer": timing(2, 5, 5, 8, 4, 6, 10, 5, 9)
      }
    },
    "oxford-d-odd-symmetric-difference": {
      whole: timing(1, 4, 10, 17, 7, 13, 20, 3, 6),
      stages: {
        "symdiff-opening": timing(1, 2, 2, 4, 1, 3, 5),
        "symdiff-core": timing(1, 4, 5, 8, 3, 6, 10),
        "symdiff-transfer": timing(1, 3, 4, 7, 3, 5, 8, 3, 6)
      }
    },
    "oxford-d-three-reversal-permutations": {
      whole: timing(2, 5, 14, 23, 10, 19, 22, 4, 8),
      stages: {
        "three-reversal-opening": timing(1, 3, 3, 5, 2, 4, 6),
        "three-reversal-core": timing(2, 5, 7, 11, 5, 9, 12),
        "three-reversal-transfer": timing(2, 4, 4, 7, 3, 6, 8, 4, 8)
      }
    },
    "oxford-d-divisor-step-geometry": {
      whole: timing(2, 5, 15, 25, 11, 20, 23, 4, 8),
      stages: {
        "divisor-geometry-opening": timing(1, 3, 3, 5, 2, 4, 6),
        "divisor-geometry-core": timing(2, 5, 8, 13, 6, 11, 14),
        "divisor-geometry-transfer": timing(2, 4, 4, 7, 3, 5, 8, 4, 8)
      }
    },
    "oxford-d-triple-flip-circle": {
      whole: timing(3, 6, 17, 28, 13, 22, 25, 5, 9),
      stages: {
        "triple-flip-opening": timing(2, 4, 4, 6, 3, 5, 7),
        "triple-flip-core": timing(3, 6, 9, 15, 7, 12, 16),
        "triple-flip-transfer": timing(2, 5, 4, 7, 3, 5, 9, 5, 9)
      }
    }
  });

const REVIEW_OVERRIDES: Readonly<
  Record<string, Partial<OxfordReviewMetadata>>
> = Object.freeze({
  "oxford-d-gcd-descent-network": {
    taxonomyClassification: "approved",
    originality: "approved",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-thirds-closed-integers": {
    taxonomyClassification: "approved",
    originality: "approved",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-balancing-transfers": {
    taxonomyClassification: "approved",
    originality: "approved",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-cube-twist-equivalence": {
    taxonomyClassification: "approved",
    originality: "approved",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-sliding-window-parity": {
    taxonomyClassification: "approved",
    originality: "approved",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-weighted-cycle-readings": {
    taxonomyClassification: "in-review",
    originality: "approved",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-midpoint-closed-residues": {
    taxonomyClassification: "approved",
    originality: "approved",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-odd-symmetric-difference": {
    taxonomyClassification: "approved",
    originality: "approved",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-three-reversal-permutations": {
    taxonomyClassification: "approved",
    originality: "changes-required",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-divisor-step-geometry": {
    taxonomyClassification: "approved",
    originality: "changes-required",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  },
  "oxford-d-triple-flip-circle": {
    taxonomyClassification: "approved",
    originality: "approved",
    fidelity: "approved",
    mathematicalCorrectness: "approved",
    difficultyCalibration: "expert-estimate"
  }
});

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

function reviewForFamily(familyId: string): OxfordReviewMetadata {
  return Object.freeze({
    ...PENDING_REVIEW,
    ...(REVIEW_OVERRIDES[familyId] ?? {})
  });
}

export function makeDirichletAdaptive(input: DirichletAdaptiveInput): OxfordAdaptiveMetadata {
  const familyTiming = DIRICHLET_FAMILY_TIMING[input.familyId];
  if (familyTiming === undefined) {
    throw new Error(
      `Missing family-specific Agent D timing estimates for "${input.familyId}"`
    );
  }

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
    timing: familyTiming.whole,
    novelty: input.novelty,
    abstraction: input.abstraction,
    introducesNewDefinition: input.introducesNewDefinition,
    stages: input.stages.map((stage) => {
      const stageTiming = familyTiming.stages[stage.id];
      if (stageTiming === undefined) {
        throw new Error(
          `Missing family-specific Agent D stage timing for "${input.familyId}/${stage.id}"`
        );
      }
      return {
        id: stage.id,
        role: stage.role,
        prerequisiteStageIds: stage.prerequisiteStageIds,
        domains: stage.domains,
        contentConcepts: stage.contentConcepts,
        skillEvidence: stage.skillEvidence,
        milestones: stage.milestones,
        extensionIds: stage.extensionIds,
        difficulty: stage.difficulty,
        timing: stageTiming,
        novelty: stage.novelty ?? input.novelty,
        abstraction: stage.abstraction ?? input.abstraction,
        introducesNewDefinition: stage.introducesNewDefinition ?? false
      };
    }),
    provenance: input.provenance ?? {
      originType: "original",
      sourceCategory: "independent-original"
    },
    review: reviewForFamily(input.familyId)
  };
}

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

interface EulerStageAuthoringProfile {
  readonly role: OxfordStageRole;
  readonly timing: OxfordTimingEstimate;
}

interface EulerFamilyAuthoringProfile {
  readonly familyTiming: OxfordTimingEstimate;
  readonly stages: Readonly<Record<string, EulerStageAuthoringProfile>>;
}

function timing(
  firstMeaningfulInsightMinutes: readonly [number, number],
  independentCompletionMinutes: readonly [number, number],
  promptedCompletionMinutes: readonly [number, number],
  softCutoffMinutes: number,
  optionalExtensionMinutes?: readonly [number, number]
): OxfordTimingEstimate {
  return Object.freeze({
    firstMeaningfulInsightMinutes: {
      min: firstMeaningfulInsightMinutes[0],
      max: firstMeaningfulInsightMinutes[1]
    },
    independentCompletionMinutes: {
      min: independentCompletionMinutes[0],
      max: independentCompletionMinutes[1]
    },
    promptedCompletionMinutes: {
      min: promptedCompletionMinutes[0],
      max: promptedCompletionMinutes[1]
    },
    ...(optionalExtensionMinutes === undefined
      ? {}
      : {
          optionalExtensionMinutes: {
            min: optionalExtensionMinutes[0],
            max: optionalExtensionMinutes[1]
          }
        }),
    softCutoffMinutes,
    confidence: "low"
  });
}

/**
 * Explicit author-side calibration hypotheses for Agent E.
 *
 * These are family-specific low-confidence estimates, not G approvals. Both
 * stage role and timing are keyed by the mathematical stage id so neither can
 * move merely because a difficulty band happens to match another stage.
 */
const EULER_AUTHORING_PROFILES: Readonly<Record<string, EulerFamilyAuthoringProfile>> =
  Object.freeze({
  "oxford-euler-quadrilateral-balance": Object.freeze({
    familyTiming: timing([1, 3], [16, 26], [12, 22], 23, [4, 8]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1.5], [2, 4], [1, 3], 4) }),
      "structure": Object.freeze({ role: "technique-check", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "classification": Object.freeze({ role: "core", timing: timing([1.5, 3], [5, 8], [4, 7], 8) }),
      "boundary": Object.freeze({ role: "deep-dive", timing: timing([1, 2.5], [4, 7], [3, 6], 7) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2], [3, 6], [2, 5], 6, [3, 5]) }),
    })
  }),
  "oxford-euler-random-chord-midpoint": Object.freeze({
    familyTiming: timing([0.5, 2], [14, 22], [10, 18], 20, [4, 7]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1.5], [2, 3], [1, 2.5], 3.5) }),
      "local-formula": Object.freeze({ role: "technique-check", timing: timing([0.5, 1.5], [2, 4], [1.5, 3], 4) }),
      "symmetry-sum": Object.freeze({ role: "core", timing: timing([1, 2.5], [4, 7], [3, 6], 7) }),
      "expectation": Object.freeze({ role: "deep-dive", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2], [3, 6], [2, 5], 6, [3, 5]) }),
    })
  }),
  "oxford-euler-circle-sweep": Object.freeze({
    familyTiming: timing([1, 3], [16, 26], [12, 22], 25, [5, 9]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1.5], [2, 4], [1.5, 3], 4) }),
      "circle-equation": Object.freeze({ role: "technique-check", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "parameter-test": Object.freeze({ role: "core", timing: timing([1.5, 3.5], [6, 9], [4.5, 8], 9) }),
      "topology": Object.freeze({ role: "deep-dive", timing: timing([1.5, 3], [5, 9], [4, 7], 9) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 3], [4, 8], [3, 6], 8, [4, 7]) }),
    })
  }),
  "oxford-euler-triangle-midpoint-cycle": Object.freeze({
    familyTiming: timing([1, 2.5], [16, 26], [12, 22], 24, [5, 8]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1.5], [2, 4], [1, 3], 4) }),
      "structure": Object.freeze({ role: "technique-check", timing: timing([1, 2], [4, 6], [3, 5], 6) }),
      "fixed-point": Object.freeze({ role: "core", timing: timing([1, 2.5], [4, 7], [3, 6], 7) }),
      "convergence": Object.freeze({ role: "deep-dive", timing: timing([1, 2.5], [4, 7], [3, 6], 7) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2], [4, 7], [3, 6], 7, [4, 6]) }),
    })
  }),
  "oxford-euler-box-diagonal-bisector": Object.freeze({
    familyTiming: timing([1, 3], [17, 28], [13, 23], 25, [5, 9]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1.5], [2, 4], [1.5, 3], 4) }),
      "plane": Object.freeze({ role: "technique-check", timing: timing([1, 2], [4, 6], [3, 5], 6) }),
      "edge-test": Object.freeze({ role: "core", timing: timing([1.5, 3.5], [6, 10], [5, 8], 10) }),
      "classification": Object.freeze({ role: "deep-dive", timing: timing([1.5, 3], [6, 9], [4.5, 8], 9) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2.5], [4, 8], [3, 6], 8, [5, 8]) }),
    })
  }),
  "oxford-euler-diagonal-blend-transform": Object.freeze({
    familyTiming: timing([0.5, 2], [15, 24], [11, 20], 22, [5, 8]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1], [2, 3], [1, 2], 3) }),
      "structure": Object.freeze({ role: "technique-check", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "metric": Object.freeze({ role: "core", timing: timing([1, 2], [4, 6], [3, 5], 6) }),
      "invariant-lines": Object.freeze({ role: "deep-dive", timing: timing([1, 2.5], [5, 8], [4, 7], 8) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2], [4, 7], [3, 6], 7, [4, 6]) }),
    })
  }),
  "oxford-euler-self-averaging-sets": Object.freeze({
    familyTiming: timing([0.5, 2], [17, 28], [13, 23], 25, [4, 7]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1], [2, 4], [1.5, 3], 4) }),
      "structure": Object.freeze({ role: "technique-check", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "finite-orbit": Object.freeze({ role: "core", timing: timing([1.5, 3], [6, 9], [5, 8], 9) }),
      "classification": Object.freeze({ role: "deep-dive", timing: timing([1, 2.5], [4, 7], [3, 6], 7) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2], [4, 7], [3, 6], 7, [3, 5]) }),
    })
  }),
  "oxford-euler-corner-balanced-tables": Object.freeze({
    familyTiming: timing([0.5, 2], [15, 25], [11, 20], 22, [4, 8]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1], [2, 4], [1, 3], 4) }),
      "structure": Object.freeze({ role: "technique-check", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "classification": Object.freeze({ role: "core", timing: timing([1, 2.5], [5, 8], [4, 7], 8) }),
      "converse": Object.freeze({ role: "deep-dive", timing: timing([1, 2], [4, 7], [3, 6], 7) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2], [4, 7], [3, 6], 7, [4, 6]) }),
    })
  }),
  "oxford-euler-tank-gauge-model": Object.freeze({
    familyTiming: timing([1, 3], [17, 27], [13, 22], 24, [6, 10]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "structure": Object.freeze({ role: "core", timing: timing([1, 2.5], [5, 8], [4, 7], 8) }),
      "identifiability": Object.freeze({ role: "deep-dive", timing: timing([1, 2], [4, 7], [3, 6], 7) }),
      "model-check": Object.freeze({ role: "deep-dive", timing: timing([1, 2.5], [4, 7], [3, 6], 7) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2], [4, 7], [3, 6], 7, [5, 8]) }),
    })
  }),
  "oxford-euler-periodic-queue-model": Object.freeze({
    familyTiming: timing([1, 3], [15, 24], [11, 20], 23, [5, 8]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "structure": Object.freeze({ role: "technique-check", timing: timing([1, 2], [4, 6], [3, 5], 6) }),
      "classification": Object.freeze({ role: "core", timing: timing([1, 2.5], [5, 8], [4, 7], 8) }),
      "emptying": Object.freeze({ role: "deep-dive", timing: timing([1.5, 3], [6, 9], [5, 8], 9) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2.5], [4, 8], [3, 7], 8, [5, 8]) }),
    })
  }),
  "oxford-euler-kiosk-grid-model": Object.freeze({
    familyTiming: timing([1, 3], [15, 24], [11, 20], 23, [5, 8]),
    stages: Object.freeze({
      "quantities": Object.freeze({ role: "warm-up", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "walking": Object.freeze({ role: "technique-check", timing: timing([1, 2.5], [4, 7], [3, 6], 7) }),
      "objective": Object.freeze({ role: "core", timing: timing([1, 2], [4, 7], [3, 6], 7) }),
      "optimize": Object.freeze({ role: "deep-dive", timing: timing([1, 2], [4, 7], [3, 6], 7) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2.5], [4, 8], [3, 7], 8, [5, 8]) }),
    })
  }),
  "oxford-euler-cooling-data-model": Object.freeze({
    familyTiming: timing([0.5, 1.5], [12, 20], [9, 16], 18, [4, 7]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.25, 0.75], [1.5, 3], [1, 2.5], 3) }),
      "structure": Object.freeze({ role: "core", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "prediction": Object.freeze({ role: "deep-dive", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "sanity": Object.freeze({ role: "deep-dive", timing: timing([0.5, 1.5], [3, 5], [2, 4], 5) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([0.5, 1.5], [3, 6], [2, 5], 6, [3, 5]) }),
    })
  }),
  "oxford-euler-random-halving-interval": Object.freeze({
    familyTiming: timing([0.5, 2], [15, 25], [11, 20], 22, [5, 8]),
    stages: Object.freeze({
      "opening": Object.freeze({ role: "warm-up", timing: timing([0.5, 1], [2, 4], [1, 3], 4) }),
      "encoding": Object.freeze({ role: "technique-check", timing: timing([0.75, 1.5], [3, 5], [2, 4], 5) }),
      "distribution": Object.freeze({ role: "core", timing: timing([1, 2], [4, 7], [3, 6], 7) }),
      "moments": Object.freeze({ role: "deep-dive", timing: timing([1, 2.5], [5, 8], [4, 7], 8) }),
      "transfer": Object.freeze({ role: "transfer", timing: timing([1, 2], [4, 7], [3, 6], 7, [4, 6]) }),
    })
  }),
  });

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
  "oxford-euler-corner-balanced-tables": "euler-local-balance",
  "oxford-euler-periodic-queue-model": "euler-discrete-dynamics-model",
  "oxford-euler-cooling-data-model": "euler-discrete-dynamics-model",
  "oxford-euler-random-subset-blocks": "euler-local-indicator-expectation"
});

const EULER_PROVENANCE_OVERRIDES: Readonly<
  Record<string, OxfordAdaptiveMetadata["provenance"]>
> = Object.freeze({
  "oxford-euler-quadrilateral-balance": Object.freeze({
    originType: "structural-adaptation",
    sourceCategory: "classic-mathematics",
    referenceFamilyId: "british-flag-theorem"
  }),
  "oxford-euler-corner-balanced-tables": Object.freeze({
    originType: "structural-adaptation",
    sourceCategory: "classic-mathematics",
    referenceFamilyId: "additive-matrix-row-column-decomposition"
  }),
  "oxford-euler-periodic-queue-model": Object.freeze({
    originType: "structural-adaptation",
    sourceCategory: "classic-mathematics",
    referenceFamilyId: "lindley-reflected-queue"
  }),
  "oxford-euler-cooling-data-model": Object.freeze({
    originType: "structural-adaptation",
    sourceCategory: "classic-mathematics",
    referenceFamilyId: "newton-cooling-gap-decay"
  }),
  "oxford-euler-random-halving-interval": Object.freeze({
    originType: "structural-adaptation",
    sourceCategory: "classic-mathematics",
    referenceFamilyId: "dyadic-binary-coin-encoding"
  })
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

function stageIdAt(
  family: EulerFamilyDefinition,
  index: number
): string {
  const stage = family.stages[index];
  if (stage === undefined) {
    throw new Error(`Euler family "${family.id}" has no stage at index ${String(index)}`);
  }
  return stage.id;
}

function profileFor(family: EulerFamilyDefinition): EulerFamilyAuthoringProfile {
  const profile = EULER_AUTHORING_PROFILES[family.id];
  if (profile === undefined) {
    throw new Error(`Euler family "${family.id}" is missing an explicit authoring profile`);
  }
  const stageIds = family.stages.map((stage) => stage.id).sort();
  const profileStageIds = Object.keys(profile.stages).sort();
  if (JSON.stringify(stageIds) !== JSON.stringify(profileStageIds)) {
    throw new Error(
      `Euler family "${family.id}" authoring profile must name exactly its five stages`
    );
  }
  const coreStages = family.stages.filter(
    (stage) => profile.stages[stage.id]?.role === "core"
  );
  if (coreStages.length !== 1) {
    throw new Error(`Euler family "${family.id}" must explicitly assign exactly one core stage`);
  }
  if (coreStages[0]?.difficulty !== family.difficulty.core) {
    throw new Error(
      `Euler family "${family.id}" explicit core stage difficulty must match family core`
    );
  }
  return profile;
}

export function makeEulerCandidateSpec(family: EulerFamilyDefinition): CuratedProblemSpec {
  const profile = profileFor(family);
  const approaches = [{
    id: "primary",
    label: "Develop and justify the family structure"
  }] as const;

  const milestones = family.stages.map((stage, index) => ({
    id: stage.id,
    description: stage.description,
    approachIds: ["primary"],
    ...(index === 0 ? {} : { prerequisiteIds: [stageIdAt(family, index - 1)] }),
    hintLevels: [index + 1 as 1 | 2 | 3 | 4 | 5]
  }));

  const edges = family.stages.slice(1).map((stage, index) => ({
    from: stageIdAt(family, index),
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
    timing: profile.familyTiming,
    novelty: family.novelty,
    abstraction: family.abstraction,
    introducesNewDefinition: family.introducesNewDefinition,
    stages: family.stages.map((stage, index) => {
      const stageProfile = profile.stages[stage.id];
      if (stageProfile === undefined) {
        throw new Error(
          `Euler family "${family.id}" has no role/timing profile for stage "${stage.id}"`
        );
      }
      return {
        id: stage.id,
        role: stageProfile.role,
        prerequisiteStageIds: index === 0 ? [] : [stageIdAt(family, index - 1)],
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
        timing: stageProfile.timing,
        novelty: stage.novelty,
        abstraction: stage.abstraction,
        introducesNewDefinition: family.introducesNewDefinition && index === 0
      };
    }),
    provenance: EULER_PROVENANCE_OVERRIDES[family.id] ?? {
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

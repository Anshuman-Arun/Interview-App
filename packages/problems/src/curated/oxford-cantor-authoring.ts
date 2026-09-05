import { authorCuratedProblem, type CuratedProblemEntry, type CuratedProblemSpec } from "../curated-authoring.js";
import {
  OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION,
  OXFORD_TAXONOMY_VERSION,
  getOxfordSkillEvidenceBasis,
  type OxfordContentConcept,
  type OxfordDifficultyBand,
  type OxfordMathDomain,
  type OxfordPrerequisiteConcept,
  type OxfordProvenanceMetadata,
  type OxfordReasoningSkill,
  type OxfordSkillEvidence,
  type OxfordSkillEvidenceWeight,
  type OxfordStageRole,
  type OxfordTimingEstimate
} from "../oxford-adaptive-taxonomy.js";

export type CantorRisk = "low" | "medium" | "high";

export interface CantorMilestone {
  readonly id: string;
  readonly description: string;
  readonly skills: readonly OxfordSkillEvidence[];
  readonly concepts: readonly OxfordContentConcept[];
}

export interface CantorApproach {
  readonly id: string;
  readonly label: string;
}

export interface CantorFamilyAuthoring {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly topics: readonly string[];
  readonly prompt: string;
  readonly givenInformation: readonly string[];
  readonly approaches: readonly CantorApproach[];
  readonly milestones: readonly CantorMilestone[];
  readonly commonErrors: readonly { readonly id: string; readonly description: string }[];
  readonly followUps: readonly string[];
  readonly extensions: readonly { readonly id: string; readonly prompt: string }[];
  readonly hints: readonly {
    readonly text: string;
    readonly formulations: readonly string[];
  }[];
  readonly canonicalSolution: string;
  readonly verificationNotes: string;
  readonly domains: readonly OxfordMathDomain[];
  readonly contentConcepts: readonly OxfordContentConcept[];
  readonly prerequisiteConcepts: readonly OxfordPrerequisiteConcept[];
  readonly skills: readonly OxfordSkillEvidence[];
  readonly difficulty: {
    readonly entry: OxfordDifficultyBand;
    readonly core: OxfordDifficultyBand;
    readonly ceiling: OxfordDifficultyBand;
  };
  readonly timing: OxfordTimingEstimate;
  readonly stageTiming: readonly [OxfordTimingEstimate, OxfordTimingEstimate, OxfordTimingEstimate];
  readonly openingRole: Extract<OxfordStageRole, "warm-up" | "technique-check">;
  readonly finalRole: Extract<OxfordStageRole, "transfer" | "stretch">;
  readonly novelty: "low" | "moderate" | "high";
  readonly abstraction: "low" | "moderate" | "high";
  readonly similarityClusterId?: string;
  readonly provenance?: OxfordProvenanceMetadata;
  readonly originalityRisk: CantorRisk;
  readonly correctnessRisk: CantorRisk;
  readonly calibrationRisk: CantorRisk;
}

export function cantorTiming(
  firstMeaningfulInsightMinutes: readonly [number, number],
  independentCompletionMinutes: readonly [number, number],
  promptedCompletionMinutes: readonly [number, number],
  optionalExtensionMinutes: readonly [number, number] | undefined,
  softCutoffMinutes: number
): OxfordTimingEstimate {
  return {
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
  };
}

export function cantorSkills(
  ...skills: readonly (readonly [OxfordReasoningSkill, OxfordSkillEvidenceWeight])[]
): readonly OxfordSkillEvidence[] {
  return skills.map(([skill, weight]) => ({ skill, weight }));
}

export function buildCantorEntry(family: CantorFamilyAuthoring): CuratedProblemEntry {
  if (family.milestones.length !== 5) {
    throw new Error(`Cantor family "${family.id}" must define exactly five reasoning milestones`);
  }
  if (family.hints.length !== 5) {
    throw new Error(`Cantor family "${family.id}" must define exactly five staged hints`);
  }
  if (family.extensions.length !== 2) {
    throw new Error(`Cantor family "${family.id}" must define exactly two authored extensions`);
  }
  if (family.approaches.length === 0) {
    throw new Error(`Cantor family "${family.id}" must define at least one approach`);
  }

  const approachIds = family.approaches.map((approach) => approach.id);
  const milestones = family.milestones.map((milestone, index) => {
    for (const evidence of milestone.skills) {
      if (getOxfordSkillEvidenceBasis(evidence.skill) === "process-grounded") {
        throw new Error(
          `Cantor family "${family.id}" milestone "${milestone.id}" cannot use process-grounded skill "${evidence.skill}"`
        );
      }
    }
    return {
      id: milestone.id,
      description: milestone.description,
      approachIds,
      ...(index === 0 ? {} : { prerequisiteIds: [family.milestones[index - 1]!.id] }),
      hintLevels: [(index + 1) as 1 | 2 | 3 | 4 | 5]
    };
  });

  const edges = family.milestones.slice(1).map((milestone, index) => ({
    from: family.milestones[index]!.id,
    to: milestone.id
  }));

  const processSkills = family.skills.filter(
    (evidence) => getOxfordSkillEvidenceBasis(evidence.skill) === "process-grounded"
  );
  const openingMilestones = family.milestones.slice(0, 2);
  const coreMilestones = family.milestones.slice(2, 4);
  const finalMilestones = family.milestones.slice(4);

  const spec: CuratedProblemSpec = {
    id: family.id,
    title: family.title,
    mode: "OXFORD_MATHEMATICS",
    category: family.category,
    topics: family.topics,
    difficulty: "oxford-interview",
    prompt: family.prompt,
    givenInformation: family.givenInformation,
    approaches: family.approaches,
    milestones,
    edges,
    commonErrors: family.commonErrors,
    followUps: family.followUps,
    extensions: family.extensions,
    hints: family.hints.map((hint, index) => ({
      level: (index + 1) as 1 | 2 | 3 | 4 | 5,
      text: hint.text,
      formulations: hint.formulations
    })),
    canonicalSolution: family.canonicalSolution,
    verificationNotes: family.verificationNotes,
    reviewStatus: "expert-review",
    reviewNotes:
      "Agent C — Cantor authored candidate; keep outside the default bank pending independent taxonomy/calibration (G), originality/fidelity (H), and mathematical correctness (I) review.",
    oxfordAdaptive: {
      schemaVersion: OXFORD_ADAPTIVE_METADATA_SCHEMA_VERSION,
      taxonomyVersion: OXFORD_TAXONOMY_VERSION,
      status: "authored",
      familyId: family.id,
      ...(family.similarityClusterId === undefined
        ? {}
        : { similarityClusterId: family.similarityClusterId }),
      domains: family.domains,
      contentConcepts: family.contentConcepts,
      prerequisiteConcepts: family.prerequisiteConcepts,
      skillEvidence: family.skills,
      difficulty: {
        ...family.difficulty,
        confidence: "low"
      },
      timing: family.timing,
      novelty: family.novelty,
      abstraction: family.abstraction,
      introducesNewDefinition: false,
      stages: [
        {
          id: "opening",
          role: family.openingRole,
          prerequisiteStageIds: [],
          domains: family.domains,
          contentConcepts: unionConcepts(openingMilestones),
          skillEvidence: unionSkills(openingMilestones),
          milestones: openingMilestones.map(toMilestoneEvidence),
          extensionIds: [],
          difficulty: family.difficulty.entry,
          timing: family.stageTiming[0],
          novelty: family.novelty === "high" ? "moderate" : family.novelty,
          abstraction: family.abstraction === "high" ? "moderate" : family.abstraction,
          introducesNewDefinition: false
        },
        {
          id: "core",
          role: "core",
          prerequisiteStageIds: ["opening"],
          domains: family.domains,
          contentConcepts: unionConcepts(coreMilestones),
          skillEvidence: mergeSkillEvidence(unionSkills(coreMilestones), processSkills),
          milestones: coreMilestones.map(toMilestoneEvidence),
          extensionIds: [],
          difficulty: family.difficulty.core,
          timing: family.stageTiming[1],
          novelty: family.novelty,
          abstraction: family.abstraction,
          introducesNewDefinition: false
        },
        {
          id: "extension",
          role: family.finalRole,
          prerequisiteStageIds: ["core"],
          domains: family.domains,
          contentConcepts: family.contentConcepts,
          skillEvidence: mergeSkillEvidence(unionSkills(finalMilestones), processSkills),
          milestones: finalMilestones.map(toMilestoneEvidence),
          extensionIds: family.extensions.map((extension) => extension.id),
          difficulty: family.difficulty.ceiling,
          timing: family.stageTiming[2],
          novelty: family.novelty,
          abstraction: family.abstraction,
          introducesNewDefinition: false
        }
      ],
      provenance: family.provenance ?? {
        originType: "original",
        sourceCategory: "independent-original"
      },
      review: {
        taxonomyClassification: "unreviewed",
        originality: "unreviewed",
        fidelity: "unreviewed",
        mathematicalCorrectness: "unreviewed",
        difficultyCalibration: "unreviewed",
        timingCalibration: "unreviewed"
      }
    }
  };

  return authorCuratedProblem(spec);
}

function toMilestoneEvidence(milestone: CantorMilestone) {
  return {
    milestoneId: milestone.id,
    skillEvidence: milestone.skills,
    contentConcepts: milestone.concepts
  };
}

function unionConcepts(milestones: readonly CantorMilestone[]): readonly OxfordContentConcept[] {
  const seen = new Set<OxfordContentConcept>();
  const result: OxfordContentConcept[] = [];
  for (const milestone of milestones) {
    for (const concept of milestone.concepts) {
      if (seen.has(concept)) continue;
      seen.add(concept);
      result.push(concept);
    }
  }
  return result;
}

function unionSkills(milestones: readonly CantorMilestone[]): readonly OxfordSkillEvidence[] {
  return mergeSkillEvidence(
    ...milestones.map((milestone) => milestone.skills)
  );
}

function mergeSkillEvidence(
  ...groups: readonly (readonly OxfordSkillEvidence[])[]
): readonly OxfordSkillEvidence[] {
  const weightRank: Record<OxfordSkillEvidenceWeight, number> = {
    secondary: 0,
    supporting: 1,
    primary: 2
  };
  const bySkill = new Map<OxfordReasoningSkill, OxfordSkillEvidenceWeight>();
  for (const group of groups) {
    for (const evidence of group) {
      const current = bySkill.get(evidence.skill);
      if (current === undefined || weightRank[evidence.weight] > weightRank[current]) {
        bySkill.set(evidence.skill, evidence.weight);
      }
    }
  }
  return [...bySkill].map(([skill, weight]) => ({ skill, weight }));
}

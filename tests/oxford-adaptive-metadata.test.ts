import { describe, expect, it } from "vitest";
import { InterviewProblemPublicViewSchema } from "../packages/domain/src/index.js";
import {
  OXFORD_DIFFICULTY_BANDS,
  OXFORD_MATH_DOMAINS,
  OXFORD_PREREQUISITE_CONCEPTS,
  OXFORD_REASONING_SKILLS,
  OXFORD_STAGE_ROLES,
  PROBLEM_METADATA,
  assertOxfordAdaptiveMetadataIntegrity,
  authorCuratedProblem,
  createProvisionalLegacyOxfordMetadata,
  type CuratedProblemSpec,
  type OxfordAdaptiveMetadata
} from "../packages/problems/src/index.js";

describe("Oxford adaptive metadata contract", () => {
  it("publishes a bounded, duplicate-free v1 taxonomy", () => {
    expect(new Set(OXFORD_MATH_DOMAINS).size).toBe(OXFORD_MATH_DOMAINS.length);
    expect(new Set(OXFORD_REASONING_SKILLS).size).toBe(OXFORD_REASONING_SKILLS.length);
    expect(new Set(OXFORD_PREREQUISITE_CONCEPTS).size).toBe(
      OXFORD_PREREQUISITE_CONCEPTS.length
    );
    expect(new Set(OXFORD_STAGE_ROLES).size).toBe(OXFORD_STAGE_ROLES.length);
    expect(new Set(OXFORD_DIFFICULTY_BANDS).size).toBe(OXFORD_DIFFICULTY_BANDS.length);

    expect(OXFORD_MATH_DOMAINS).toEqual(expect.arrayContaining([
      "algebra",
      "functions",
      "graph-sketching",
      "sequences-recurrences",
      "euclidean-geometry",
      "calculus",
      "elementary-analysis",
      "probability",
      "combinatorics",
      "number-theory",
      "graph-theory",
      "logic-proof",
      "functional-equations"
    ]));
    expect(OXFORD_REASONING_SKILLS).toEqual(expect.arrayContaining([
      "small-case-exploration",
      "conjecture-formation",
      "proof-construction",
      "counterexample-construction",
      "invariants",
      "generalization",
      "transfer",
      "representation-switching",
      "error-recovery"
    ]));
    expect(OXFORD_STAGE_ROLES).toEqual([
      "warm-up",
      "technique-check",
      "core",
      "deep-dive",
      "transfer",
      "stretch"
    ]);
    expect(OXFORD_DIFFICULTY_BANDS).toEqual([
      "warm-up",
      "introductory",
      "introductory-plus",
      "standard",
      "strong",
      "stretch"
    ]);
  });

  it("migrates existing Oxford entries without inventing calibration claims", () => {
    const oxford = PROBLEM_METADATA.filter(
      (metadata) => metadata.mode === "OXFORD_MATHEMATICS"
    );
    expect(oxford.length).toBeGreaterThan(0);
    for (const metadata of oxford) {
      expect(metadata.oxfordAdaptive).toBeDefined();
      if (metadata.oxfordAdaptive?.status !== "provisional-legacy") continue;
      expect(metadata.oxfordAdaptive.domains).toEqual([]);
      expect(metadata.oxfordAdaptive.skillEvidence).toEqual([]);
      expect(metadata.oxfordAdaptive.stages).toEqual([]);
      expect(metadata.oxfordAdaptive.difficulty).toBeUndefined();
      expect(metadata.oxfordAdaptive.timing).toBeUndefined();
      expect(metadata.oxfordAdaptive.review.difficultyCalibration).toBe("unreviewed");
      expect(metadata.oxfordAdaptive.review.timingCalibration).toBe("unreviewed");
    }
  });

  it("keeps adaptive metadata backend-only while authoring the existing problem contract", () => {
    const entry = authorCuratedProblem(validSpec());
    expect(entry.metadata.oxfordAdaptive?.status).toBe("authored");
    expect(() => assertOxfordAdaptiveMetadataIntegrity(
      entry.metadata.oxfordAdaptive as OxfordAdaptiveMetadata,
      entry.problem
    )).not.toThrow();

    expect(entry.problem).not.toHaveProperty("oxfordAdaptive");
    expect(entry.problem.public).not.toHaveProperty("familyId");
    expect(JSON.stringify(entry.problem.public)).not.toContain("skillEvidence");

    const publicView = {
      id: entry.problem.id,
      version: entry.problem.version,
      title: entry.metadata.title,
      category: entry.metadata.category,
      difficulty: entry.problem.interviewer.difficulty,
      prompt: entry.problem.public.prompt,
      givenInformation: entry.problem.public.givenInformation,
      topics: entry.problem.interviewer.topics
    };
    expect(() => InterviewProblemPublicViewSchema.parse(publicView)).not.toThrow();
    expect(() => InterviewProblemPublicViewSchema.parse({
      ...publicView,
      oxfordAdaptive: entry.metadata.oxfordAdaptive
    })).toThrow();
  });

  it("rejects illegal taxonomy tags and invalid skill weights", () => {
    const illegalDomain = cloneMetadata();
    (illegalDomain.domains as unknown as string[])[0] = "free-form-math";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(illegalDomain)).toThrow(
      /not part of taxonomy/
    );

    const illegalSkill = cloneMetadata();
    (illegalSkill.skillEvidence as unknown as Array<{ skill: string; weight: string }>)[0] = {
      skill: "cleverness",
      weight: "primary"
    };
    expect(() => assertOxfordAdaptiveMetadataIntegrity(illegalSkill)).toThrow(
      /illegal reasoning skill/
    );

    const illegalWeight = cloneMetadata();
    (illegalWeight.skillEvidence as unknown as Array<{ skill: string; weight: string }>)[0] = {
      skill: "proof-construction",
      weight: "0.73"
    };
    expect(() => assertOxfordAdaptiveMetadataIntegrity(illegalWeight)).toThrow(
      /invalid skill evidence weight/
    );
  });

  it("rejects impossible timing and invalid difficulty ordering", () => {
    const badTiming = cloneMetadata();
    const timing = badTiming.timing as NonNullable<OxfordAdaptiveMetadata["timing"]>;
    (timing.independentCompletionMinutes as { min: number; max: number }).min = 20;
    (timing.independentCompletionMinutes as { min: number; max: number }).max = 10;
    expect(() => assertOxfordAdaptiveMetadataIntegrity(badTiming)).toThrow(
      /must satisfy 0 <= min <= max/
    );

    const badDifficulty = cloneMetadata();
    const difficulty = badDifficulty.difficulty as NonNullable<OxfordAdaptiveMetadata["difficulty"]>;
    (difficulty as { entry: string }).entry = "strong";
    (difficulty as { core: string }).core = "standard";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(badDifficulty)).toThrow(
      /entry <= core <= ceiling/
    );
  });

  it("rejects duplicate stages, broken prerequisites, and stage cycles", () => {
    const duplicate = cloneMetadata();
    (duplicate.stages as unknown as Array<{ id: string }>)[1]!.id = "opening";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(duplicate)).toThrow(
      /Duplicate Oxford stage id/
    );

    const broken = cloneMetadata();
    (
      broken.stages[1]!.prerequisiteStageIds as unknown as string[]
    )[0] = "missing-stage";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(broken)).toThrow(
      /unknown prerequisite stage/
    );

    const cyclic = cloneMetadata();
    (cyclic.stages[0]!.prerequisiteStageIds as unknown as string[]).push("core-proof");
    expect(() => assertOxfordAdaptiveMetadataIntegrity(cyclic)).toThrow(
      /stage graph must be acyclic/
    );
  });

  it("rejects unknown or multiply assigned reasoning milestones", () => {
    const entry = authorCuratedProblem(validSpec());
    const unknown = cloneMetadata();
    (
      unknown.stages[1]!.milestones as unknown as Array<{ milestoneId: string }>
    )[0]!.milestoneId = "not-a-real-milestone";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(unknown, entry.problem)).toThrow(
      /unknown reasoning milestone/
    );

    const duplicate = cloneMetadata();
    (
      duplicate.stages[1]!.milestones as unknown as Array<{ milestoneId: string }>
    )[0]!.milestoneId = "explore";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(duplicate, entry.problem)).toThrow(
      /assigned to multiple Oxford stages/
    );
  });

  it("requires authored metadata to preserve cross-stage reasoning dependencies", () => {
    const entry = authorCuratedProblem(validSpec());
    const disconnected = cloneMetadata();
    (
      disconnected.stages[1]!.prerequisiteStageIds as unknown as string[]
    ).splice(0);
    expect(() => assertOxfordAdaptiveMetadataIntegrity(disconnected, entry.problem)).toThrow(
      /does not preserve reasoning dependency/
    );
  });

  it("rejects inconsistent authored provenance and review states", () => {
    const structural = cloneMetadata();
    (
      structural.provenance as unknown as {
        originType: string;
        sourceCategory: string;
        referenceFamilyId?: string;
      }
    ).originType = "structural-adaptation";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(structural)).toThrow(
      /requires a reference family id/
    );

    const invalidReview = cloneMetadata();
    (
      invalidReview.review as unknown as { originality: string }
    ).originality = "probably-fine";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(invalidReview)).toThrow(
      /Invalid Oxford originality review status/
    );
  });

  it("keeps provisional legacy metadata explicitly empty and unreviewed", () => {
    const provisional = createProvisionalLegacyOxfordMetadata("legacy-fixture");
    expect(() => assertOxfordAdaptiveMetadataIntegrity(provisional)).not.toThrow();

    const fabricated = structuredClone(provisional) as OxfordAdaptiveMetadata;
    (
      fabricated.review as unknown as { difficultyCalibration: string }
    ).difficultyCalibration = "expert-estimate";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(fabricated)).toThrow(
      /must remain explicitly unreviewed/
    );
  });
});

function cloneMetadata(): OxfordAdaptiveMetadata {
  return structuredClone(validAdaptiveMetadata()) as OxfordAdaptiveMetadata;
}

function validSpec(): CuratedProblemSpec {
  return {
    id: "oxford-adaptive-fixture",
    title: "Adaptive Contract Fixture",
    mode: "OXFORD_MATHEMATICS",
    category: "number theory",
    topics: ["divisibility"],
    difficulty: "standard-oxford",
    prompt: "Investigate a simple divisibility pattern and prove the pattern you find.",
    givenInformation: [],
    approaches: [
      { id: "direct", label: "Direct exploration and proof" }
    ],
    milestones: [
      {
        id: "explore",
        description: "Test small cases and formulate the relevant pattern.",
        approachIds: ["direct"],
        hintLevels: [1, 2]
      },
      {
        id: "prove",
        description: "Prove the pattern and explain why the argument generalizes.",
        approachIds: ["direct"],
        prerequisiteIds: ["explore"],
        hintLevels: [3, 4, 5]
      }
    ],
    edges: [
      { from: "explore", to: "prove" }
    ],
    commonErrors: [
      { id: "examples-only", description: "Stops after examples without proving the claim." }
    ],
    followUps: ["What changes if the numerical parameter is varied?"],
    extensions: [
      { id: "generalize", prompt: "Generalize the claim to a wider class of integers." }
    ],
    hints: [
      { level: 1, text: "Try the smallest few cases.", formulations: ["test small cases"] },
      { level: 2, text: "Record what remains unchanged.", formulations: ["look for a stable pattern"] },
      { level: 3, text: "State the pattern as a precise claim.", formulations: ["formulate the claim"] },
      { level: 4, text: "Use the divisibility definition directly.", formulations: ["apply divisibility directly"] },
      { level: 5, text: "Close the argument for an arbitrary case.", formulations: ["finish for a general case"] }
    ],
    canonicalSolution: "A complete fixture solution establishes the observed divisibility pattern for an arbitrary input.",
    verificationNotes: "Examples are insufficient; the final response must include a general proof.",
    reviewStatus: "expert-review",
    reviewNotes: "Synthetic fixture used only to exercise metadata validation.",
    oxfordAdaptive: validAdaptiveMetadata()
  };
}

function validAdaptiveMetadata(): OxfordAdaptiveMetadata {
  return {
    schemaVersion: 1,
    taxonomyVersion: "1.0.0",
    status: "authored",
    familyId: "adaptive-fixture-family",
    similarityClusterId: "adaptive-fixture-cluster",
    domains: ["number-theory"],
    prerequisiteConcepts: ["divisibility"],
    skillEvidence: [
      { skill: "small-case-exploration", weight: "primary" },
      { skill: "proof-construction", weight: "primary" },
      { skill: "generalization", weight: "supporting" }
    ],
    difficulty: {
      entry: "introductory",
      core: "standard",
      ceiling: "stretch",
      confidence: "low"
    },
    timing: {
      firstMeaningfulInsightMinutes: { min: 1, max: 4 },
      independentCompletionMinutes: { min: 8, max: 15 },
      promptedCompletionMinutes: { min: 6, max: 12 },
      optionalExtensionMinutes: { min: 4, max: 10 },
      softCutoffMinutes: 12,
      confidence: "low"
    },
    novelty: "low",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      {
        id: "opening",
        role: "warm-up",
        prerequisiteStageIds: [],
        domains: ["number-theory"],
        skillEvidence: [
          { skill: "small-case-exploration", weight: "primary" },
          { skill: "proof-construction", weight: "secondary" }
        ],
        milestones: [
          {
            milestoneId: "explore",
            skillEvidence: [
              { skill: "small-case-exploration", weight: "primary" }
            ]
          }
        ],
        difficulty: "introductory",
        timing: {
          firstMeaningfulInsightMinutes: { min: 0.5, max: 2 },
          independentCompletionMinutes: { min: 2, max: 5 },
          promptedCompletionMinutes: { min: 1.5, max: 4 },
          softCutoffMinutes: 4,
          confidence: "low"
        },
        novelty: "low",
        abstraction: "low",
        introducesNewDefinition: false
      },
      {
        id: "core-proof",
        role: "core",
        prerequisiteStageIds: ["opening"],
        domains: ["number-theory"],
        skillEvidence: [
          { skill: "proof-construction", weight: "primary" },
          { skill: "generalization", weight: "supporting" }
        ],
        milestones: [
          {
            milestoneId: "prove",
            skillEvidence: [
              { skill: "proof-construction", weight: "primary" },
              { skill: "generalization", weight: "supporting" }
            ]
          }
        ],
        difficulty: "standard",
        timing: {
          firstMeaningfulInsightMinutes: { min: 1, max: 4 },
          independentCompletionMinutes: { min: 5, max: 10 },
          promptedCompletionMinutes: { min: 4, max: 8 },
          optionalExtensionMinutes: { min: 4, max: 10 },
          softCutoffMinutes: 8,
          confidence: "low"
        },
        novelty: "low",
        abstraction: "moderate",
        introducesNewDefinition: false
      }
    ],
    provenance: {
      originType: "original",
      sourceCategory: "independent-original"
    },
    review: {
      taxonomyClassification: "unreviewed",
      originality: "unreviewed",
      fidelity: "unreviewed",
      mathematicalCorrectness: "unreviewed",
      difficultyCalibration: "expert-estimate",
      timingCalibration: "expert-estimate"
    }
  };
}

import { describe, expect, it } from "vitest";
import {
  InterviewProblemPublicViewSchema,
  type InterviewProblem
} from "../packages/domain/src/index.js";
import { oxfordDivisorsSquareParitySpec } from "../packages/problems/src/curated/oxford-divisors-square-parity.js";
import {
  OXFORD_CONTENT_CONCEPTS,
  OXFORD_DIFFICULTY_BANDS,
  OXFORD_MATH_DOMAINS,
  OXFORD_PREREQUISITE_CONCEPTS,
  OXFORD_REASONING_SKILLS,
  OXFORD_STAGE_ROLES,
  PROBLEM_METADATA,
  assertOxfordAdaptiveMetadataIntegrity,
  authorCuratedProblem,
  createProvisionalLegacyOxfordMetadata,
  getOxfordSkillEvidenceBasis,
  isOxfordRecommendationReady,
  type OxfordAdaptiveMetadata,
  type OxfordStageMetadata
} from "../packages/problems/src/index.js";

describe("Oxford adaptive metadata contract", () => {
  it("publishes a bounded, duplicate-free v1 taxonomy", () => {
    expect(new Set(OXFORD_MATH_DOMAINS).size).toBe(OXFORD_MATH_DOMAINS.length);
    expect(new Set(OXFORD_CONTENT_CONCEPTS).size).toBe(OXFORD_CONTENT_CONCEPTS.length);
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
      "error-recovery",
      "guided-adaptation",
      "precision-checking"
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
    expect(getOxfordSkillEvidenceBasis("guided-adaptation")).toBe("process-grounded");
    expect(getOxfordSkillEvidenceBasis("error-recovery")).toBe("process-grounded");
    expect(getOxfordSkillEvidenceBasis("precision-checking")).toBe("milestone-grounded");
    expect(OXFORD_CONTENT_CONCEPTS).toEqual(expect.arrayContaining([
      "divisibility",
      "modular-reasoning",
      "parity",
      "prime-structure",
      "function-transformations",
      "asymptotic-behavior",
      "parameter-dependent-curves",
      "roots-intersections"
    ]));
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
      expect(metadata.oxfordAdaptive.contentConcepts).toEqual([]);
      expect(metadata.oxfordAdaptive.skillEvidence).toEqual([]);
      expect(metadata.oxfordAdaptive.stages).toEqual([]);
      expect(metadata.oxfordAdaptive.difficulty).toBeUndefined();
      expect(metadata.oxfordAdaptive.timing).toBeUndefined();
      expect(metadata.oxfordAdaptive.review.difficultyCalibration).toBe("unreviewed");
      expect(metadata.oxfordAdaptive.review.timingCalibration).toBe("unreviewed");
    }
  });

  it("keeps adaptive metadata backend-only while authoring the existing problem contract", () => {
    const entry = authorCuratedProblem({
      ...oxfordDivisorsSquareParitySpec,
      oxfordAdaptive: reviewedFixtureAdaptiveMetadata()
    });
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
    (requireStage(duplicate, 1) as unknown as { id: string }).id = "opening";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(duplicate)).toThrow(
      /Duplicate Oxford stage id/
    );

    const broken = cloneMetadata();
    (
      requireStage(broken, 1).prerequisiteStageIds as unknown as string[]
    )[0] = "missing-stage";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(broken)).toThrow(
      /unknown prerequisite stage/
    );

    const cyclic = cloneMetadata();
    (
      requireStage(cyclic, 0).prerequisiteStageIds as unknown as string[]
    ).push("core-proof");
    expect(() => assertOxfordAdaptiveMetadataIntegrity(cyclic)).toThrow(
      /stage graph must be acyclic/
    );
  });

  it("rejects unknown or multiply assigned reasoning milestones", () => {
    const problem = fixtureProblem();
    const unknown = cloneMetadata();
    (
      requireMilestone(requireStage(unknown, 1), 0) as unknown as { milestoneId: string }
    ).milestoneId = "not-a-real-milestone";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(unknown, problem)).toThrow(
      /unknown reasoning milestone/
    );

    const duplicate = cloneMetadata();
    (
      requireMilestone(requireStage(duplicate, 1), 0) as unknown as { milestoneId: string }
    ).milestoneId = "explore";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(duplicate, problem)).toThrow(
      /assigned to multiple Oxford stages/
    );
  });

  it("requires authored metadata to preserve cross-stage reasoning dependencies", () => {
    const problem = fixtureProblem();
    const disconnected = cloneMetadata();
    (
      requireStage(disconnected, 1).prerequisiteStageIds as unknown as string[]
    ).splice(0);
    expect(() => assertOxfordAdaptiveMetadataIntegrity(disconnected, problem)).toThrow(
      /does not preserve reasoning dependency/
    );
  });

  it("rejects unknown and multiply assigned reasoning extensions", () => {
    const problem = fixtureProblem();

    const unknown = cloneMetadata();
    (
      requireStage(unknown, 1).extensionIds as unknown as string[]
    )[0] = "missing-extension";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(unknown, problem)).toThrow(
      /unknown reasoning extension/
    );

    const duplicate = cloneMetadata();
    (
      requireStage(duplicate, 0).extensionIds as unknown as string[]
    ).push("generalize");
    expect(() => assertOxfordAdaptiveMetadataIntegrity(duplicate, problem)).toThrow(
      /assigned to multiple Oxford stages/
    );
  });

  it("prevents milestone completion from proving process-grounded skills", () => {
    const processTarget = cloneMetadata();
    (processTarget.skillEvidence as unknown as Array<{ skill: string; weight: string }>).push({
      skill: "guided-adaptation",
      weight: "supporting"
    });
    (
      requireStage(processTarget, 1).skillEvidence
      as unknown as Array<{ skill: string; weight: string }>
    ).push({
      skill: "guided-adaptation",
      weight: "supporting"
    });
    expect(() => assertOxfordAdaptiveMetadataIntegrity(processTarget)).not.toThrow();

    (
      requireMilestone(requireStage(processTarget, 1), 0).skillEvidence
      as unknown as Array<{ skill: string; weight: string }>
    ).push({
      skill: "guided-adaptation",
      weight: "supporting"
    });
    expect(() => assertOxfordAdaptiveMetadataIntegrity(processTarget)).toThrow(
      /cannot treat process-grounded skill "guided-adaptation" as milestone-completion evidence/
    );
  });

  it("validates fine-content hierarchy separately from prerequisites", () => {
    const illegal = cloneMetadata();
    (illegal.contentConcepts as unknown as string[])[0] = "made-up-subtopic";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(illegal)).toThrow(
      /Oxford content concept "made-up-subtopic" is not part of taxonomy/
    );

    const wrongDomain = cloneMetadata();
    (wrongDomain.contentConcepts as unknown as string[])[0] = "graph-coloring";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(wrongDomain)).toThrow(
      /content concept "graph-coloring" requires one of parent domains/
    );

    const missingAtStage = cloneMetadata();
    (
      requireMilestone(requireStage(missingAtStage, 0), 0).contentConcepts
      as unknown as string[]
    ).push("parity");
    expect(() => assertOxfordAdaptiveMetadataIntegrity(missingAtStage)).toThrow(
      /content concept "parity" is not declared at stage level/
    );
  });

  it("uses one authoritative recommendation-readiness gate", () => {
    const ready = recommendationReadyMetadata();
    expect(isOxfordRecommendationReady(ready)).toBe(true);

    for (const reviewField of [
      "taxonomyClassification",
      "originality",
      "fidelity",
      "mathematicalCorrectness"
    ] as const) {
      const blocked = recommendationReadyMetadata();
      (
        blocked.review as unknown as Record<string, string>
      )[reviewField] = "in-review";
      expect(isOxfordRecommendationReady(blocked)).toBe(false);
    }

    const noDifficultyCalibration = recommendationReadyMetadata();
    (
      noDifficultyCalibration.review as unknown as { difficultyCalibration: string }
    ).difficultyCalibration = "unreviewed";
    expect(isOxfordRecommendationReady(noDifficultyCalibration)).toBe(false);

    const noTimingCalibration = recommendationReadyMetadata();
    (
      noTimingCalibration.review as unknown as { timingCalibration: string }
    ).timingCalibration = "unreviewed";
    expect(isOxfordRecommendationReady(noTimingCalibration)).toBe(false);

    expect(
      isOxfordRecommendationReady(createProvisionalLegacyOxfordMetadata("legacy-fixture"))
    ).toBe(false);
  });

  it("allows a reviewed classic problem to be recommendation-ready without calling it original", () => {
    const classic = recommendationReadyMetadata();
    (
      classic.provenance as unknown as {
        originType: string;
        sourceCategory: string;
      }
    ).originType = "classic-problem";
    (
      classic.provenance as unknown as {
        originType: string;
        sourceCategory: string;
      }
    ).sourceCategory = "classic-mathematics";

    expect(classic.review.originality).toBe("approved");
    expect(isOxfordRecommendationReady(classic)).toBe(true);
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

    const fabricated = structuredClone(provisional);
    (
      fabricated.review as unknown as { difficultyCalibration: string }
    ).difficultyCalibration = "expert-estimate";
    expect(() => assertOxfordAdaptiveMetadataIntegrity(fabricated)).toThrow(
      /must remain explicitly unreviewed/
    );
  });
});

function cloneMetadata(): OxfordAdaptiveMetadata {
  return structuredClone(validAdaptiveMetadata());
}

function requireStage(
  metadata: OxfordAdaptiveMetadata,
  index: number
): OxfordStageMetadata {
  const stage = metadata.stages[index];
  if (stage === undefined) {
    throw new Error(`Missing Oxford metadata fixture stage at index ${String(index)}`);
  }
  return stage;
}

function requireMilestone(
  stage: OxfordStageMetadata,
  index: number
): OxfordStageMetadata["milestones"][number] {
  const milestone = stage.milestones[index];
  if (milestone === undefined) {
    throw new Error(`Missing Oxford metadata fixture milestone at index ${String(index)}`);
  }
  return milestone;
}

function fixtureProblem(): InterviewProblem {
  return {
    id: "oxford-adaptive-fixture",
    version: "1.0.0",
    public: {
      prompt: "Investigate a simple pattern and justify it.",
      givenInformation: []
    },
    interviewer: {
      topics: ["fixture"],
      difficulty: "fixture",
      reasoningGraph: {
        version: "1.0.0",
        approaches: [
          { id: "direct", label: "Direct exploration and proof" }
        ],
        milestones: [
          {
            id: "explore",
            description: "Explore small cases.",
            approachIds: ["direct"],
            optionalPrerequisiteIds: [],
            protectedDisclosureIds: []
          },
          {
            id: "prove",
            description: "Prove the observed pattern.",
            approachIds: ["direct"],
            optionalPrerequisiteIds: ["explore"],
            protectedDisclosureIds: []
          }
        ],
        edges: [
          { from: "explore", to: "prove" }
        ],
        commonErrors: [],
        extensions: [
          { id: "generalize", prompt: "Generalize the pattern." }
        ]
      },
      protectedDisclosures: []
    },
    private: {
      canonicalSolution: "Fixture solution.",
      verificationNotes: "Fixture verification notes."
    }
  };
}

function reviewedFixtureAdaptiveMetadata(): OxfordAdaptiveMetadata {
  return {
    schemaVersion: 1,
    taxonomyVersion: "1.0.0",
    status: "authored",
    familyId: "divisor-parity-fixture-family",
    domains: ["number-theory"],
    prerequisiteConcepts: ["divisibility", "prime-factorization"],
    skillEvidence: [
      { skill: "proof-construction", weight: "primary" }
    ],
    difficulty: {
      entry: "introductory-plus",
      core: "standard",
      ceiling: "stretch",
      confidence: "low"
    },
    timing: {
      firstMeaningfulInsightMinutes: { min: 1, max: 4 },
      independentCompletionMinutes: { min: 8, max: 16 },
      promptedCompletionMinutes: { min: 6, max: 14 },
      optionalExtensionMinutes: { min: 4, max: 10 },
      softCutoffMinutes: 12,
      confidence: "low"
    },
    novelty: "low",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      {
        id: "core",
        role: "core",
        prerequisiteStageIds: [],
        domains: ["number-theory"],
        skillEvidence: [
          { skill: "proof-construction", weight: "primary" }
        ],
        milestones: [
          "test-pairing",
          "identify-fixed-point",
          "pairing-conclusion",
          "factorization-route",
          "iff-finish"
        ].map((milestoneId) => ({
          milestoneId,
          skillEvidence: [
            { skill: "proof-construction" as const, weight: "primary" as const }
          ]
        })),
        extensionIds: ["exactly-three", "divisor-count-formula"],
        difficulty: "standard",
        timing: {
          firstMeaningfulInsightMinutes: { min: 1, max: 4 },
          independentCompletionMinutes: { min: 8, max: 16 },
          promptedCompletionMinutes: { min: 6, max: 14 },
          optionalExtensionMinutes: { min: 4, max: 10 },
          softCutoffMinutes: 12,
          confidence: "low"
        },
        novelty: "low",
        abstraction: "moderate",
        introducesNewDefinition: false
      }
    ],
    provenance: {
      originType: "classic-problem",
      sourceCategory: "classic-mathematics"
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
        extensionIds: [],
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
        extensionIds: ["generalize"],
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

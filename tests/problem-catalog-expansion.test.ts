import { describe, expect, it } from "vitest";
import type { InterviewProblem } from "../packages/domain/src/index.js";
import {
  ALL_PROBLEMS,
  EXPERT_REVIEW_METADATA,
  EXPERT_REVIEW_PROBLEMS,
  PROBLEM_METADATA,
  assertInterviewProblemIntegrity,
  assertProblemBankIntegrity,
  assertReasoningGraphFixtureIntegrity,
  authorCuratedProblem,
  createProblemCatalog,
  getExpertReviewMetadataById,
  getExpertReviewProblemById,
  getProblemById,
  getProblemMetadataById,
  getProblemsByCategory,
  getProblemsByDifficulty,
  getProblemsByMode,
  getProblemsByTopic,
  oxfordCuratedEntries,
  oxfordCuratedReviewEntries,
  problemCatalog,
  quantCuratedEntries,
  quantCuratedReviewEntries
} from "../packages/problems/src/index.js";
import { quantMontyHallSpec } from "../packages/problems/src/curated/quant-monty-hall.js";

const NEW_PROBLEM_IDS = [
  "oxford-domino-chessboard",
  "oxford-divisors-square-parity",
  "oxford-euclid-primes",
  "oxford-nested-radical-sequence",
  "oxford-monotone-cauchy",
  "oxford-even-odd-degrees",
  "oxford-catalan-paths",
  "oxford-divisibility-chain",
  "oxford-continuous-fixed-point",
  "oxford-prefix-sums-mod-n",
  "oxford-triangle-medians",
  "quant-monty-hall",
  "quant-hidden-coin-bayes",
  "quant-waiting-time-hh",
  "quant-poisson-arrival-conditioning",
  "quant-uniform-endpoint-estimation",
  "quant-matching-pennies",
  "quant-kelly-bet",
  "quant-birthday-collision",
  "quant-three-cards-bayes",
  "quant-random-walk-drawdown"
] as const;

const EXPERT_REVIEW_IDS = new Set([
  "oxford-catalan-paths",
  "quant-random-walk-drawdown"
]);

describe("curated problem bank", () => {
  it("admits 24 reviewed problems while keeping two expert-review fixtures isolated", () => {
    expect(problemCatalog).toHaveLength(24);
    expect(ALL_PROBLEMS).toHaveLength(24);
    expect(Object.isFrozen(problemCatalog)).toBe(true);

    const ids = new Set(problemCatalog.map((problem) => problem.id));
    expect(ids.size).toBe(24);
    for (const id of NEW_PROBLEM_IDS) {
      expect(ids.has(id)).toBe(!EXPERT_REVIEW_IDS.has(id));
    }

    for (const problem of problemCatalog) {
      expect(() => assertInterviewProblemIntegrity(problem)).not.toThrow();
      expect(problem.public.prompt.trim().length).toBeGreaterThan(20);
      expect(problem.interviewer.topics.length).toBeGreaterThan(0);
      expect(problem.interviewer.reasoningGraph.milestones.length).toBeGreaterThanOrEqual(4);
      expect(problem.private.canonicalSolution.trim().length).toBeGreaterThan(20);
    }
  });

  it("runtime-freezes every exported default and curated collection", () => {
    expect(Object.isFrozen(ALL_PROBLEMS)).toBe(true);
    expect(Object.isFrozen(problemCatalog)).toBe(true);
    expect(Object.isFrozen(PROBLEM_METADATA)).toBe(true);
    expect(Object.isFrozen(oxfordCuratedEntries)).toBe(true);
    expect(Object.isFrozen(quantCuratedEntries)).toBe(true);
    expect(Object.isFrozen(oxfordCuratedReviewEntries)).toBe(true);
    expect(Object.isFrozen(quantCuratedReviewEntries)).toBe(true);
    expect(Object.isFrozen(ALL_PROBLEMS[0])).toBe(true);
    expect(Object.isFrozen(PROBLEM_METADATA[0])).toBe(true);
  });

  it("maintains complete authoring metadata for every built-in problem", () => {
    expect(PROBLEM_METADATA).toHaveLength(problemCatalog.length);
    expect(() => assertProblemBankIntegrity(problemCatalog, PROBLEM_METADATA)).not.toThrow();

    const metadataIds = new Set(PROBLEM_METADATA.map((metadata) => metadata.id));
    expect(metadataIds.size).toBe(problemCatalog.length);
    for (const problem of problemCatalog) {
      const metadata = getProblemMetadataById(problem.id);
      expect(metadata).toBeDefined();
      expect(metadata?.title.trim().length).toBeGreaterThan(0);
      expect(metadata?.category.trim().length).toBeGreaterThan(0);
    }
  });

  it("has the intended Oxford and Quant distribution", () => {
    const oxford = getProblemsByMode("OXFORD_MATHEMATICS");
    const quant = getProblemsByMode("QUANT");
    expect(oxford).toHaveLength(13);
    expect(quant).toHaveLength(11);
    expect(oxford.every((problem) => problem.id.startsWith("oxford-"))).toBe(true);
    expect(quant.every((problem) => problem.id.startsWith("quant-"))).toBe(true);
  });

  it("supports ID, topic, difficulty, category, and mode lookup without runtime conditionals", () => {
    expect(getProblemById("oxford-triangle-medians")?.id).toBe("oxford-triangle-medians");
    expect(getProblemById("quant-poisson-arrival-conditioning")?.id)
      .toBe("quant-poisson-arrival-conditioning");
    expect(getProblemById("missing-problem")).toBeUndefined();

    const numberTheory = getProblemsByCategory("number theory").map((problem) => problem.id);
    expect(numberTheory).toEqual(expect.arrayContaining([
      "oxford-divisors-square-parity",
      "oxford-euclid-primes",
      "oxford-divisibility-chain",
      "oxford-prefix-sums-mod-n"
    ]));

    const probability = getProblemsByTopic("probability").map((problem) => problem.id);
    expect(probability).toEqual(expect.arrayContaining([
      "quant-von-neumann-coin",
      "quant-gamblers-ruin",
      "quant-birthday-collision"
    ]));

    expect(getProblemsByDifficulty("quant-stretch").map((problem) => problem.id))
      .toContain("quant-kelly-bet");
    expect(getProblemsByTopic("   ")).toEqual([]);
    expect(getProblemsByDifficulty("   ")).toEqual([]);
    expect(getProblemsByCategory("   ")).toEqual([]);
  });

  it("compiles all 21 authored fixtures to five protected disclosures without assuming stage equals severity", () => {
    const curatedEntries = [
      ...oxfordCuratedEntries,
      ...quantCuratedEntries,
      ...oxfordCuratedReviewEntries,
      ...quantCuratedReviewEntries
    ];
    expect(curatedEntries).toHaveLength(21);

    for (const entry of curatedEntries) {
      const disclosures = entry.problem.interviewer.protectedDisclosures;
      expect(disclosures).toHaveLength(5);
      expect(disclosures.every((disclosure) =>
        disclosure.minimumDisclosureLevel >= 0 && disclosure.minimumDisclosureLevel <= 5
      )).toBe(true);

      const referenced = new Set(
        entry.problem.interviewer.reasoningGraph.milestones.flatMap(
          (milestone) => milestone.protectedDisclosureIds
        )
      );
      expect(referenced.size).toBe(5);
      for (const disclosure of disclosures) expect(referenced.has(disclosure.id)).toBe(true);
    }
  });

  it("exposes expert-review fixtures only through the isolated review tooling surface", () => {
    expect(EXPERT_REVIEW_PROBLEMS.map((problem) => problem.id).sort()).toEqual([
      "oxford-catalan-paths",
      "quant-random-walk-drawdown"
    ]);
    expect(EXPERT_REVIEW_METADATA.map((metadata) => metadata.id).sort()).toEqual([
      "oxford-catalan-paths",
      "quant-random-walk-drawdown"
    ]);
    expect(Object.isFrozen(EXPERT_REVIEW_PROBLEMS)).toBe(true);
    expect(Object.isFrozen(EXPERT_REVIEW_METADATA)).toBe(true);

    for (const problem of EXPERT_REVIEW_PROBLEMS) {
      expect(getExpertReviewProblemById(problem.id)?.id).toBe(problem.id);
      expect(getProblemById(problem.id)).toBeUndefined();
      expect(Object.isFrozen(problem)).toBe(true);
    }
    for (const metadata of EXPERT_REVIEW_METADATA) {
      expect(metadata.reviewStatus).toBe("expert-review");
      expect(metadata.reviewNotes?.trim().length).toBeGreaterThan(0);
      expect(getExpertReviewMetadataById(metadata.id)?.id).toBe(metadata.id);
      expect(getProblemMetadataById(metadata.id)).toBeUndefined();
      expect(Object.isFrozen(metadata)).toBe(true);
    }

    expect(getExpertReviewProblemById("missing-review-problem")).toBeUndefined();
    expect(getExpertReviewMetadataById("missing-review-problem")).toBeUndefined();
  });

  it("keeps protected disclosure identities unique across approved and review catalogs", () => {
    const owners = new Map<string, string>();
    for (const problem of [...ALL_PROBLEMS, ...EXPERT_REVIEW_PROBLEMS]) {
      for (const disclosure of problem.interviewer.protectedDisclosures) {
        expect(owners.has(disclosure.id)).toBe(false);
        owners.set(disclosure.id, problem.id);
      }
    }
  });

  it("keeps expert-review fixtures explicit, documented, and absent from default lookup", () => {
    const reviewEntries = [...oxfordCuratedReviewEntries, ...quantCuratedReviewEntries];
    const reviewIds = reviewEntries.map((entry) => entry.problem.id).sort();

    expect(reviewIds).toEqual([
      "oxford-catalan-paths",
      "quant-random-walk-drawdown"
    ]);
    expect(PROBLEM_METADATA.every((metadata) => metadata.reviewStatus === "ready")).toBe(true);
    for (const entry of reviewEntries) {
      expect(entry.metadata.reviewStatus).toBe("expert-review");
      expect(entry.metadata.reviewNotes?.trim().length).toBeGreaterThan(20);
      expect(getProblemById(entry.problem.id)).toBeUndefined();
      expect(getProblemMetadataById(entry.problem.id)).toBeUndefined();
    }
  });

  it("deep-freezes authored entries after validation", () => {
    const entry = authorCuratedProblem(structuredClone(quantMontyHallSpec));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.problem)).toBe(true);
    expect(Object.isFrozen(entry.problem.interviewer.reasoningGraph.milestones)).toBe(true);
    expect(Object.isFrozen(entry.problem.interviewer.protectedDisclosures[0]?.equivalentFormulations)).toBe(true);
    expect(Object.isFrozen(entry.metadata)).toBe(true);
    expect(Object.isFrozen(entry.metadata.followUps)).toBe(true);

    const originalPrompt = entry.problem.public.prompt;
    expect(() => {
      (entry.problem.public as { prompt: string }).prompt = "MUTATED";
    }).toThrow();
    expect(entry.problem.public.prompt).toBe(originalPrompt);
  });

  it("snapshots and freezes caller-owned problems at generic catalog admission", () => {
    const original = problemCatalog[0];
    if (original === undefined) throw new Error("Expected problem fixture");
    const mutable = structuredClone(original) as unknown as {
      id: string;
      version: string;
      public: { prompt: string; givenInformation: string[] };
      interviewer: {
        topics: string[];
        difficulty: string;
        reasoningGraph: {
          version: string;
          approaches: Array<{ id: string; label: string }>;
          milestones: Array<{
            id: string;
            description: string;
            approachIds: string[];
            optionalPrerequisiteIds: string[];
            protectedDisclosureIds: string[];
          }>;
          edges: Array<{ from: string; to: string }>;
          commonErrors: Array<{ id: string; description: string }>;
          extensions: Array<{ id: string; prompt: string }>;
        };
        protectedDisclosures: Array<{
          id: string;
          fact: string;
          minimumDisclosureLevel: 0 | 1 | 2 | 3 | 4 | 5;
          equivalentFormulations: string[];
        }>;
      };
      private: { canonicalSolution: string; verificationNotes: string };
    };
    const catalog = createProblemCatalog([mutable as unknown as InterviewProblem]);

    const firstMutableMilestone = mutable.interviewer.reasoningGraph.milestones[0];
    if (firstMutableMilestone === undefined) throw new Error("Expected milestone fixture");

    mutable.public.prompt = "MUTATED AFTER ADMISSION";
    firstMutableMilestone.description = "MUTATED AFTER ADMISSION";

    expect(catalog[0]?.public.prompt).not.toBe("MUTATED AFTER ADMISSION");
    expect(catalog[0]?.interviewer.reasoningGraph.milestones[0]?.description)
      .not.toBe("MUTATED AFTER ADMISSION");
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(Object.isFrozen(catalog[0]?.interviewer.reasoningGraph.milestones)).toBe(true);
  });

  it("snapshots caller-owned authoring structures before integrity validation returns", () => {
    const mutableSpec = structuredClone(quantMontyHallSpec) as unknown as {
      id: string;
      title: string;
      mode: "QUANT";
      category: string;
      topics: string[];
      difficulty: string;
      prompt: string;
      givenInformation: string[];
      approaches: Array<{ id: string; label: string }>;
      milestones: Array<{
        id: string;
        description: string;
        approachIds: string[];
        prerequisiteIds?: string[];
        hintLevels?: Array<1 | 2 | 3 | 4 | 5>;
      }>;
      edges: Array<{ from: string; to: string }>;
      commonErrors: Array<{ id: string; description: string }>;
      followUps: string[];
      extensions: Array<{ id: string; prompt: string }>;
      hints: Array<{ level: 1 | 2 | 3 | 4 | 5; text: string; formulations: string[] }>;
      canonicalSolution: string;
      verificationNotes: string;
    };
    const entry = authorCuratedProblem(mutableSpec);
    const firstApproach = mutableSpec.approaches[0];
    const firstMilestone = mutableSpec.milestones[0];
    const firstEdge = mutableSpec.edges[0];
    const firstCommonError = mutableSpec.commonErrors[0];
    const firstExtension = mutableSpec.extensions[0];
    const firstHint = mutableSpec.hints[0];
    if (
      firstApproach === undefined
      || firstMilestone === undefined
      || firstEdge === undefined
      || firstCommonError === undefined
      || firstExtension === undefined
      || firstHint === undefined
    ) {
      throw new Error("Expected mutable authoring fixture entries");
    }

    mutableSpec.givenInformation[0] = "MUTATED";
    firstApproach.label = "MUTATED";
    firstMilestone.approachIds[0] = "MUTATED";
    firstEdge.from = "MUTATED";
    firstCommonError.description = "MUTATED";
    mutableSpec.followUps[0] = "MUTATED";
    firstExtension.prompt = "MUTATED";
    firstHint.formulations[0] = "MUTATED";

    expect(entry.problem.public.givenInformation).not.toContain("MUTATED");
    expect(entry.problem.interviewer.reasoningGraph.approaches[0]?.label).not.toBe("MUTATED");
    expect(entry.problem.interviewer.reasoningGraph.milestones[0]?.approachIds).not.toContain("MUTATED");
    expect(entry.problem.interviewer.reasoningGraph.edges[0]?.from).not.toBe("MUTATED");
    expect(entry.problem.interviewer.reasoningGraph.commonErrors[0]?.description).not.toBe("MUTATED");
    expect(entry.metadata.followUps).not.toContain("MUTATED");
    expect(entry.problem.interviewer.reasoningGraph.extensions[0]?.prompt).not.toBe("MUTATED");
    expect(entry.problem.interviewer.protectedDisclosures[0]?.equivalentFormulations)
      .not.toContain("MUTATED");
    expect(() => assertInterviewProblemIntegrity(entry.problem)).not.toThrow();
  });

  it("canonicalizes catalog metadata while rejecting hidden duplicate authoring entries", () => {
    const canonicalized = structuredClone(quantMontyHallSpec) as typeof quantMontyHallSpec & {
      category: string;
      title: string;
      followUps: string[];
      topics: string[];
    };
    canonicalized.category = "  conditional   probability  ";
    canonicalized.title = "  Monty Hall   with a Specified Host Policy  ";
    canonicalized.followUps = canonicalized.followUps.map((value) => `  ${value}  `);
    const entry = authorCuratedProblem(canonicalized);

    expect(entry.metadata.category).toBe("conditional probability");
    expect(entry.metadata.title).toBe("Monty Hall with a Specified Host Policy");
    expect(entry.metadata.followUps.every((value) => value === value.trim())).toBe(true);
    expect(entry.problem.interviewer.topics[0]).toBe("conditional probability");

    const duplicateFollowUps = structuredClone(quantMontyHallSpec) as typeof quantMontyHallSpec & {
      followUps: string[];
    };
    duplicateFollowUps.followUps = ["Same   follow-up", " same follow-up "];
    expect(() => authorCuratedProblem(duplicateFollowUps))
      .toThrow(/duplicate entry "same follow-up"/iu);

    const duplicateTopics = structuredClone(quantMontyHallSpec) as typeof quantMontyHallSpec & {
      topics: string[];
    };
    duplicateTopics.topics = ["Bayesian reasoning", " bayesian   reasoning "];
    expect(() => authorCuratedProblem(duplicateTopics))
      .toThrow(/duplicate entry "bayesian reasoning"/iu);

    const categoryRepeated = structuredClone(quantMontyHallSpec) as unknown as {
      -readonly [K in keyof typeof quantMontyHallSpec]: K extends "topics"
        ? string[]
        : typeof quantMontyHallSpec[K]
    };
    categoryRepeated.topics = [
      ...categoryRepeated.topics,
      "  CONDITIONAL   PROBABILITY "
    ];
    expect(() => authorCuratedProblem(categoryRepeated))
      .toThrow(/topic list contains duplicate entry "conditional probability"/iu);

    const paddedId = structuredClone(quantMontyHallSpec) as unknown as {
      -readonly [K in keyof typeof quantMontyHallSpec]: K extends "id"
        ? string
        : typeof quantMontyHallSpec[K]
    };
    paddedId.id = " quant-monty-hall ";
    expect(() => authorCuratedProblem(paddedId))
      .toThrow(/must not contain leading or trailing whitespace/u);
  });

  it("rejects contradictory review metadata and canonicalizes expert-review notes", () => {
    const readyWithNotes = structuredClone(quantMontyHallSpec) as typeof quantMontyHallSpec & {
      reviewStatus?: "ready" | "expert-review";
      reviewNotes?: string;
    };
    readyWithNotes.reviewStatus = "ready";
    readyWithNotes.reviewNotes = "should not be present";
    expect(() => authorCuratedProblem(readyWithNotes))
      .toThrow(/cannot include review notes unless marked expert-review/u);

    const expertWithoutNotes = structuredClone(quantMontyHallSpec) as typeof quantMontyHallSpec & {
      reviewStatus?: "ready" | "expert-review";
      reviewNotes?: string;
    };
    expertWithoutNotes.reviewStatus = "expert-review";
    delete expertWithoutNotes.reviewNotes;
    expect(() => authorCuratedProblem(expertWithoutNotes))
      .toThrow(/must include review notes/u);

    const expert = structuredClone(quantMontyHallSpec) as typeof quantMontyHallSpec & {
      reviewStatus?: "ready" | "expert-review";
      reviewNotes?: string;
    };
    expert.reviewStatus = "expert-review";
    expert.reviewNotes = "  Needs   focused   mathematical review.  ";
    const entry = authorCuratedProblem(expert);
    expect(entry.metadata.reviewStatus).toBe("expert-review");
    expect(entry.metadata.reviewNotes).toBe("Needs focused mathematical review.");
  });

  it("fails closed on malformed runtime authoring enums and extra hint stages", () => {
    expect(() => authorCuratedProblem({
      id: "runtime-invalid-mode",
      title: "Runtime invalid mode",
      mode: "NOT_A_MODE",
      hints: []
    } as never)).toThrow(/invalid mode/u);

    expect(() => authorCuratedProblem({
      id: "runtime-invalid-review",
      title: "Runtime invalid review",
      mode: "QUANT",
      reviewStatus: "approved",
      hints: []
    } as never)).toThrow(/invalid review status/u);

    expect(() => authorCuratedProblem({
      id: "runtime-extra-hint",
      title: "Runtime extra hint",
      mode: "QUANT",
      hints: [
        { level: 1, text: "a", formulations: ["a"] },
        { level: 2, text: "b", formulations: ["b"] },
        { level: 3, text: "c", formulations: ["c"] },
        { level: 4, text: "d", formulations: ["d"] },
        { level: 5, text: "e", formulations: ["e"] },
        { level: 6, text: "f", formulations: ["f"] }
      ]
    } as never)).toThrow(/exactly five hint stages/u);

    expect(() => authorCuratedProblem({
      id: "runtime-invalid-hint",
      title: "Runtime invalid hint",
      mode: "QUANT",
      followUps: [],
      hints: [
        { level: 1, text: "a", formulations: ["a"] },
        { level: 2, text: "b", formulations: ["b"] },
        { level: 3, text: "c", formulations: ["c"] },
        { level: 4, text: "d", formulations: ["d"] },
        { level: 6, text: "f", formulations: ["f"] }
      ]
    } as never)).toThrow(/invalid hint stage 6/u);
  });

  it("rejects the same normalized protected phrase under two disclosure identities", () => {
    const original = problemCatalog.find(
      (problem) => problem.interviewer.protectedDisclosures.length >= 2
    );
    if (original === undefined) throw new Error("Expected problem with two disclosures");
    const first = original.interviewer.protectedDisclosures[0];
    const second = original.interviewer.protectedDisclosures[1];
    if (first === undefined || second === undefined) {
      throw new Error("Expected two protected disclosures");
    }

    expect(() => assertInterviewProblemIntegrity({
      ...original,
      interviewer: {
        ...original.interviewer,
        protectedDisclosures: [
          first,
          {
            ...second,
            equivalentFormulations: [
              ...second.equivalentFormulations,
              `  ${first.fact.toUpperCase()}  `
            ]
          },
          ...original.interviewer.protectedDisclosures.slice(2)
        ]
      }
    })).toThrow(/protected disclosure phrase .* shared by/iu);
  });

  it("uses parsed reasoning-graph defaults instead of reading missing arrays from raw input", () => {
    const original = problemCatalog.find(
      (problem) => problem.interviewer.protectedDisclosures.length > 0
    );
    if (original === undefined) throw new Error("Expected problem with disclosures");

    const graph = structuredClone(original.interviewer.reasoningGraph) as unknown as {
      version: string;
      approaches: Array<{ id: string; label: string }>;
      milestones: Array<{
        id: string;
        description: string;
        approachIds: string[];
        optionalPrerequisiteIds?: string[];
        protectedDisclosureIds?: string[];
      }>;
      edges: Array<{ from: string; to: string }>;
      commonErrors: Array<{ id: string; description: string }>;
      extensions: Array<{ id: string; prompt: string }>;
    };
    const incomingTargets = new Set(graph.edges.map((edge) => edge.to));
    const root = graph.milestones.find((milestone) => !incomingTargets.has(milestone.id));
    if (root === undefined) throw new Error("Expected graph root");
    delete root.optionalPrerequisiteIds;

    const disclosureReferenceCounts = new Map<string, number>();
    for (const milestone of graph.milestones) {
      for (const disclosureId of milestone.protectedDisclosureIds ?? []) {
        disclosureReferenceCounts.set(
          disclosureId,
          (disclosureReferenceCounts.get(disclosureId) ?? 0) + 1
        );
      }
    }
    const disclosureMilestone = graph.milestones.find((milestone) =>
      (milestone.protectedDisclosureIds ?? []).some(
        (disclosureId) => disclosureReferenceCounts.get(disclosureId) === 1
      )
    );
    if (disclosureMilestone === undefined) {
      throw new Error("Expected singly referenced disclosure fixture");
    }
    delete disclosureMilestone.protectedDisclosureIds;

    expect(() => assertReasoningGraphFixtureIntegrity(graph as never)).not.toThrow();

    const problem = structuredClone(original) as unknown as {
      id: string;
      version: string;
      public: { prompt: string; givenInformation: string[] };
      interviewer: {
        topics: string[];
        difficulty: string;
        reasoningGraph: typeof graph;
        protectedDisclosures: typeof original.interviewer.protectedDisclosures;
      };
      private: { canonicalSolution: string; verificationNotes: string };
    };
    problem.interviewer.reasoningGraph = graph;
    expect(() => assertInterviewProblemIntegrity(problem as never))
      .toThrow(/unreferenced protected disclosure/u);
  });

  it("rejects runtime-invalid disclosure and reasoning-graph schema shapes", () => {
    const original = problemCatalog[0];
    if (original === undefined) throw new Error("Expected problem fixture");
    const disclosure = original.interviewer.protectedDisclosures[0];
    if (disclosure === undefined) throw new Error("Expected protected disclosure");

    expect(() => assertInterviewProblemIntegrity({
      ...original,
      interviewer: {
        ...original.interviewer,
        protectedDisclosures: [{
          ...disclosure,
          minimumDisclosureLevel: 99
        }, ...original.interviewer.protectedDisclosures.slice(1)]
      }
    } as never)).toThrow();

    expect(() => assertInterviewProblemIntegrity({
      ...original,
      interviewer: {
        ...original.interviewer,
        protectedDisclosures: [{
          ...disclosure,
          id: ""
        }, ...original.interviewer.protectedDisclosures.slice(1)]
      }
    } as never)).toThrow();

    expect(() => assertInterviewProblemIntegrity({
      ...original,
      interviewer: {
        ...original.interviewer,
        reasoningGraph: {
          ...original.interviewer.reasoningGraph,
          unexpectedRuntimeField: true
        }
      }
    } as never)).toThrow();
  });

  it("rejects malformed versions and malformed metadata structures", () => {
    const original = problemCatalog[0];
    if (original === undefined) throw new Error("Expected problem fixture");

    expect(() => assertInterviewProblemIntegrity({ ...original, version: "v1" }))
      .toThrow(/MAJOR\.MINOR\.PATCH/);

    expect(() => assertInterviewProblemIntegrity({
      ...original,
      interviewer: { ...original.interviewer, topics: [] }
    })).toThrow(/topic list/i);

    expect(() => assertProblemBankIntegrity(problemCatalog, PROBLEM_METADATA.slice(1)))
      .toThrow(/missing catalog metadata/i);

    const firstMetadata = PROBLEM_METADATA[0];
    if (firstMetadata === undefined) throw new Error("Expected problem metadata");
    expect(() => assertProblemBankIntegrity(
      problemCatalog,
      [{ ...firstMetadata, reviewStatus: "expert-review", reviewNotes: "needs review" }, ...PROBLEM_METADATA.slice(1)]
    )).toThrow(/non-ready problem/i);
  });

  it("rejects duplicate built-in IDs even when generic versioned catalogs allow them", () => {
    const original = problemCatalog[0];
    if (original === undefined) throw new Error("Expected problem fixture");
    const secondVersion = { ...original, version: "2.0.0" };

    expect(createProblemCatalog([original, secondVersion])).toHaveLength(2);
    const firstMetadata = PROBLEM_METADATA[0];
    if (firstMetadata === undefined) throw new Error("Expected problem metadata fixture");
    expect(() => assertProblemBankIntegrity(
      [original, secondVersion],
      [firstMetadata, { ...firstMetadata, title: "Second version" }]
    )).toThrow(/duplicate problem ID/i);
  });

  it("rejects disclosure identities shared across distinct built-in problems", () => {
    const original = problemCatalog[0];
    const metadata = PROBLEM_METADATA[0];
    if (original === undefined || metadata === undefined) {
      throw new Error("Expected built-in problem fixture");
    }

    const collidingProblem = {
      ...original,
      id: `${original.id}-distinct-problem`
    };
    const collidingMetadata = {
      ...metadata,
      id: collidingProblem.id,
      title: "Distinct problem with colliding disclosure identities"
    };

    expect(() => createProblemCatalog([original, collidingProblem]))
      .toThrow(/protected disclosure ID .* shared by problems/iu);
    expect(() => assertProblemBankIntegrity(
      [original, collidingProblem],
      [metadata, collidingMetadata]
    )).toThrow(/protected disclosure ID .* shared by problems/iu);
  });

  it("rejects duplicate metadata follow-ups after normalization", () => {
    const original = problemCatalog[0];
    const metadata = PROBLEM_METADATA[0];
    if (original === undefined || metadata === undefined) {
      throw new Error("Expected built-in problem fixture");
    }

    expect(() => assertProblemBankIntegrity(
      [original],
      [{
        ...metadata,
        followUps: [
          "What changes if the assumption is removed?",
          "  WHAT   CHANGES IF THE ASSUMPTION IS REMOVED?  "
        ]
      }]
    )).toThrow(/duplicate follow-up/iu);
  });

});

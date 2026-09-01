import { describe, expect, it } from "vitest";
import {
  ALL_PROBLEMS,
  PROBLEM_METADATA,
  assertInterviewProblemIntegrity,
  problemCatalog
} from "../packages/problems/src/index.js";
import { CURATED_DISCLOSURE_LEVELS } from "../packages/problems/src/curated-disclosure-levels.js";
import { oxfordCuratedReviewEntries } from "../packages/problems/src/oxford-curated.js";
import { quantCuratedReviewEntries } from "../packages/problems/src/quant-curated.js";

function disclosure(problemId: string, stage: number) {
  const problem = [...ALL_PROBLEMS, ...oxfordCuratedReviewEntries.map((entry) => entry.problem), ...quantCuratedReviewEntries.map((entry) => entry.problem)]
    .find((candidate) => candidate.id === problemId);
  if (problem === undefined) throw new Error(`Missing fixture ${problemId}`);
  const suffix = `_hint_${String(stage)}`;
  const item = problem.interviewer.protectedDisclosures.find((candidate) => candidate.id.endsWith(suffix));
  if (item === undefined) throw new Error(`Missing disclosure ${problemId} stage ${String(stage)}`);
  return item;
}

describe("curated semantic disclosure review", () => {
  it("freezes the manual semantic review registry against runtime reclassification", () => {
    expect(Object.isFrozen(CURATED_DISCLOSURE_LEVELS)).toBe(true);
    const monty = CURATED_DISCLOSURE_LEVELS["quant-monty-hall"];
    expect(monty).toBeDefined();
    expect(Object.isFrozen(monty)).toBe(true);
    const before = monty?.[2];

    expect(() => {
      (monty as Record<number, number>)[2] = 0;
    }).toThrow();

    expect(CURATED_DISCLOSURE_LEVELS["quant-monty-hall"]?.[2]).toBe(before);
    expect(disclosure("quant-monty-hall", 2).minimumDisclosureLevel).toBe(before);
  });

  it("covers every curated problem with five explicit reviewed semantic levels", () => {
    expect(Object.keys(CURATED_DISCLOSURE_LEVELS)).toHaveLength(21);
    for (const [problemId, levels] of Object.entries(CURATED_DISCLOSURE_LEVELS)) {
      expect(Object.keys(levels)).toEqual(["1", "2", "3", "4", "5"]);
      for (const stage of [1, 2, 3, 4, 5] as const) {
        expect(levels[stage]).toBeGreaterThanOrEqual(0);
        expect(levels[stage]).toBeLessThanOrEqual(5);
        expect(disclosure(problemId, stage).minimumDisclosureLevel).toBe(levels[stage]);
      }
    }
  });

  it("proves pedagogical stage and semantic severity are independent", () => {
    const endpointSigns = disclosure("oxford-continuous-fixed-point", 2);
    const technique = disclosure("oxford-continuous-fixed-point", 3);
    expect(endpointSigns.minimumDisclosureLevel).toBe(4);
    expect(technique.minimumDisclosureLevel).toBe(3);
    expect(endpointSigns.minimumDisclosureLevel).toBeGreaterThan(technique.minimumDisclosureLevel);
  });

  it("classifies Monty Hall exact likelihoods and posterior arithmetic above structure ceilings", () => {
    expect(disclosure("quant-monty-hall", 1).minimumDisclosureLevel).toBe(2);
    expect(disclosure("quant-monty-hall", 2)).toMatchObject({ minimumDisclosureLevel: 4 });
    expect(disclosure("quant-monty-hall", 3)).toMatchObject({ minimumDisclosureLevel: 4 });
    expect(disclosure("quant-monty-hall", 4)).toMatchObject({ minimumDisclosureLevel: 5 });
    expect(disclosure("quant-monty-hall", 5)).toMatchObject({ minimumDisclosureLevel: 5 });

    for (const stage of [2, 3] as const) {
      const item = disclosure("quant-monty-hall", stage);
      expect(item.minimumDisclosureLevel).toBeGreaterThan(3);
      expect(item.equivalentFormulations.length).toBeGreaterThan(0);
    }
  });

  it("classifies exact equations and near-solutions conservatively across modes", () => {
    expect(disclosure("oxford-continuous-fixed-point", 4).minimumDisclosureLevel).toBe(5);
    expect(disclosure("oxford-divisibility-chain", 4).minimumDisclosureLevel).toBe(5);
    expect(disclosure("oxford-domino-chessboard", 4).minimumDisclosureLevel).toBe(5);

    expect(disclosure("quant-kelly-bet", 1).minimumDisclosureLevel).toBe(4);
    expect(disclosure("quant-kelly-bet", 2).minimumDisclosureLevel).toBe(4);
    expect(disclosure("quant-kelly-bet", 4).minimumDisclosureLevel).toBe(5);

    expect(disclosure("quant-uniform-endpoint-estimation", 1).minimumDisclosureLevel).toBe(4);
    expect(disclosure("quant-uniform-endpoint-estimation", 2).minimumDisclosureLevel).toBe(5);
    expect(disclosure("quant-uniform-endpoint-estimation", 3).minimumDisclosureLevel).toBe(5);

    expect(disclosure("quant-three-cards-bayes", 2).minimumDisclosureLevel).toBe(5);
    expect(disclosure("quant-waiting-time-hh", 2).minimumDisclosureLevel).toBe(4);
  });

  it("keeps every equivalent formulation at its fact's effective semantic level", () => {
    for (const problemId of Object.keys(CURATED_DISCLOSURE_LEVELS)) {
      for (const stage of [1, 2, 3, 4, 5] as const) {
        const item = disclosure(problemId, stage);
        expect(item.equivalentFormulations.length).toBeGreaterThan(0);
        // Runtime representation deliberately stores one level on the protected fact;
        // every equivalent phrase is therefore guarded by that same fact-level ceiling.
        for (const formulation of item.equivalentFormulations) {
          expect(formulation.trim().length).toBeGreaterThan(0);
          expect(item.minimumDisclosureLevel).toBe(CURATED_DISCLOSURE_LEVELS[problemId]?.[stage]);
        }
      }
    }
  });

  it("classifies every final curated formulation as level 5", () => {
    for (const problemId of Object.keys(CURATED_DISCLOSURE_LEVELS)) {
      expect(disclosure(problemId, 5).minimumDisclosureLevel).toBe(5);
    }
  });

  it("keeps expert-review fixtures out of every default catalog surface", () => {
    const reviewIds = new Set([
      ...oxfordCuratedReviewEntries.map((entry) => entry.problem.id),
      ...quantCuratedReviewEntries.map((entry) => entry.problem.id)
    ]);
    expect(reviewIds).toEqual(new Set(["oxford-catalan-paths", "quant-random-walk-drawdown"]));
    expect(problemCatalog.some((problem) => reviewIds.has(problem.id))).toBe(false);
    expect(PROBLEM_METADATA.some((metadata) => reviewIds.has(metadata.id))).toBe(false);
  });

  it("keeps all default catalog entries mechanically valid", () => {
    for (const problem of problemCatalog) {
      expect(() => assertInterviewProblemIntegrity(problem)).not.toThrow();
    }
  });
});

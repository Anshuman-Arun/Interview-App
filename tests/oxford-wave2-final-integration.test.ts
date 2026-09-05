import { describe, expect, it } from "vitest";
import {
  EXPERT_REVIEW_METADATA,
  EXPERT_REVIEW_PROBLEMS,
  OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS,
  PROBLEM_METADATA,
  getProblemById,
  getProblemMetadataById,
  isOxfordRecommendationReady,
  projectOxfordStudentProfile,
  recommendNextOxfordProblem
} from "../packages/problems/src/index.js";

describe("final Wave 2 certified Oxford integration", () => {
  it("promotes exactly the 41 independently certified families into the live bank", () => {
    expect(OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS).toHaveLength(41);
    expect(new Set(OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS).size).toBe(41);

    const reviewIds = new Set(EXPERT_REVIEW_PROBLEMS.map((problem) => problem.id));
    const reviewMetadataIds = new Set(EXPERT_REVIEW_METADATA.map((metadata) => metadata.id));

    for (const id of OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS) {
      const problem = getProblemById(id);
      const metadata = getProblemMetadataById(id);
      expect(problem?.id).toBe(id);
      expect(metadata?.id).toBe(id);
      expect(metadata?.reviewStatus).toBe("ready");
      expect(metadata?.oxfordAdaptive?.review).toEqual({
        taxonomyClassification: "approved",
        originality: "approved",
        fidelity: "approved",
        mathematicalCorrectness: "approved",
        difficultyCalibration: "expert-estimate",
        timingCalibration: "expert-estimate"
      });
      expect(isOxfordRecommendationReady(metadata?.oxfordAdaptive)).toBe(true);
      expect(reviewIds.has(id)).toBe(false);
      expect(reviewMetadataIds.has(id)).toBe(false);
    }

    const certifiedIdSet = new Set<string>(OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS);
    expect(PROBLEM_METADATA.filter((metadata) => certifiedIdSet.has(metadata.id))).toHaveLength(41);
  });

  it("keeps every pruned Wave 2 family out of live and expert-review catalogs", () => {
    const pruned = [
      "oxford-cantor-tangent-intersection-locus",
      "oxford-cantor-line-envelope",
      "oxford-cantor-reciprocal-implicit-curve",
      "oxford-d-switching-cuts",
      "oxford-d-laminar-family",
      "oxford-d-orientation-parities",
      "oxford-d-prime-divisor-three-cycles",
      "oxford-d-discrete-maximum-principle",
      "oxford-d-finite-map-cycles",
      "oxford-d-spanning-tree-exchange",
      "oxford-d-stable-binary-words",
      "oxford-d-directed-flow-decomposition",
      "oxford-d-idempotent-maps",
      "oxford-d-mirror-orbits",
      "oxford-euler-rectangle-area-table",
      "oxford-euler-difference-closed-sets",
      "oxford-euler-locally-balanced-labels",
      "oxford-euler-random-adjacent-consecutives",
      "oxford-euler-stop-on-change",
      "oxford-euler-random-subset-blocks"
    ] as const;

    const reviewIds = new Set(EXPERT_REVIEW_PROBLEMS.map((problem) => problem.id));
    for (const id of pruned) {
      expect(getProblemById(id)).toBeUndefined();
      expect(getProblemMetadataById(id)).toBeUndefined();
      expect(reviewIds.has(id)).toBe(false);
    }
  });

  it("runs Fourier cold-start recommendation against all 41 real certified families", () => {
    const profile = projectOxfordStudentProfile([], {
      asOf: "2026-09-05T00:00:00.000Z"
    });
    const candidates = OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS.map((id) => {
      const problem = getProblemById(id);
      const metadata = getProblemMetadataById(id);
      if (problem === undefined || metadata === undefined) {
        throw new Error(`Missing promoted Wave 2 family "${id}"`);
      }
      return {
        problemId: problem.id,
        problemVersion: problem.version,
        metadata
      };
    });

    const result = recommendNextOxfordProblem(profile, candidates, {
      availableMinutes: 25,
      topK: 5
    });

    expect(result.recommendationReadyCandidateCount).toBe(41);
    expect(result.outcome).toBe("RECOMMENDATION_SELECTED");
    expect(result.selected).toBeDefined();
    expect(OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS).toContain(result.selected?.problemId);
    expect(result.alternatives.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  EXPERT_REVIEW_METADATA,
  EXPERT_REVIEW_PROBLEMS,
  assertOxfordAdaptiveMetadataIntegrity,
  getOxfordSkillEvidenceBasis,
  isOxfordRecommendationReady
} from "../packages/problems/src/index.js";
import {
  oxfordCantorFamilies,
  oxfordCantorReviewEntries
} from "../packages/problems/src/oxford-cantor.js";

describe("Agent C — Cantor Wave 2 Oxford candidates", () => {
  it("authors exactly 20 unique candidate families and keeps them isolated in expert review", () => {
    expect(oxfordCantorFamilies).toHaveLength(20);
    expect(oxfordCantorReviewEntries).toHaveLength(20);

    const ids = oxfordCantorReviewEntries.map((entry) => entry.problem.id);
    expect(new Set(ids).size).toBe(20);

    const reviewProblemIds = new Set(EXPERT_REVIEW_PROBLEMS.map((problem) => problem.id));
    const reviewMetadataIds = new Set(EXPERT_REVIEW_METADATA.map((metadata) => metadata.id));

    for (const entry of oxfordCantorReviewEntries) {
      expect(entry.metadata.reviewStatus).toBe("expert-review");
      expect(reviewProblemIds.has(entry.problem.id)).toBe(true);
      expect(reviewMetadataIds.has(entry.problem.id)).toBe(true);
    }
  });

  it("validates every authored family against the frozen Oxford adaptive contract", () => {
    for (const entry of oxfordCantorReviewEntries) {
      const adaptive = entry.metadata.oxfordAdaptive;
      expect(adaptive?.status).toBe("authored");
      if (adaptive === undefined) throw new Error(`Missing adaptive metadata for ${entry.problem.id}`);
      expect(() => assertOxfordAdaptiveMetadataIntegrity(adaptive, entry.problem)).not.toThrow();
      expect(adaptive.familyId).toBe(entry.problem.id);
      expect(adaptive.difficulty?.confidence).toBe("low");
      expect(adaptive.timing?.confidence).toBe("low");
      for (const stage of adaptive.stages) {
        expect(stage.timing.confidence).toBe("low");
      }
    }
  });

  it("keeps all independent review and calibration gates pending and recommendation-ineligible", () => {
    for (const entry of oxfordCantorReviewEntries) {
      const adaptive = entry.metadata.oxfordAdaptive;
      if (adaptive === undefined) throw new Error(`Missing adaptive metadata for ${entry.problem.id}`);
      expect(adaptive.review).toEqual({
        taxonomyClassification: "unreviewed",
        originality: "unreviewed",
        fidelity: "unreviewed",
        mathematicalCorrectness: "unreviewed",
        difficultyCalibration: "unreviewed",
        timingCalibration: "unreviewed"
      });
      expect(isOxfordRecommendationReady(adaptive)).toBe(false);
    }
  });

  it("preserves the five-stage protected disclosure mechanism for every family", () => {
    for (const entry of oxfordCantorReviewEntries) {
      const disclosures = entry.problem.interviewer.protectedDisclosures;
      expect(disclosures).toHaveLength(5);
      const referenced = new Set(
        entry.problem.interviewer.reasoningGraph.milestones.flatMap(
          (milestone) => milestone.protectedDisclosureIds
        )
      );
      expect(referenced.size).toBe(5);
      for (const disclosure of disclosures) {
        expect(referenced.has(disclosure.id)).toBe(true);
      }
    }
  });

  it("never treats process-grounded skills as milestone-completion evidence", () => {
    for (const entry of oxfordCantorReviewEntries) {
      const adaptive = entry.metadata.oxfordAdaptive;
      if (adaptive === undefined) throw new Error(`Missing adaptive metadata for ${entry.problem.id}`);
      for (const stage of adaptive.stages) {
        for (const milestone of stage.milestones) {
          for (const evidence of milestone.skillEvidence) {
            expect(getOxfordSkillEvidenceBasis(evidence.skill)).toBe("milestone-grounded");
          }
        }
      }
    }
  });

  it("keeps candidate-visible problem content free of adaptive and review metadata", () => {
    for (const entry of oxfordCantorReviewEntries) {
      const serializedPublic = JSON.stringify(entry.problem.public);
      expect(serializedPublic).not.toContain("contentConcepts");
      expect(serializedPublic).not.toContain("skillEvidence");
      expect(serializedPublic).not.toContain("difficultyCalibration");
      expect(serializedPublic).not.toContain("timingCalibration");
      expect(serializedPublic).not.toContain("provenance");
      expect(entry.problem).not.toHaveProperty("oxfordAdaptive");
    }
  });

  it("fills the graph-heavy remit while spanning the requested analytical concepts", () => {
    const adaptive = oxfordCantorReviewEntries.map((entry) => {
      const value = entry.metadata.oxfordAdaptive;
      if (value === undefined) throw new Error(`Missing adaptive metadata for ${entry.problem.id}`);
      return value;
    });

    const graphHeavy = adaptive.filter((metadata) => metadata.domains.includes("graph-sketching"));
    expect(graphHeavy.length).toBeGreaterThanOrEqual(14);
    expect(graphHeavy.length).toBeLessThanOrEqual(18);

    const concepts = new Set(adaptive.flatMap((metadata) => metadata.contentConcepts));
    expect(concepts).toEqual(expect.objectContaining({ size: expect.any(Number) }));
    for (const required of [
      "qualitative-function-behavior",
      "function-transformations",
      "roots-intersections",
      "asymptotic-behavior",
      "turning-points-extrema",
      "parameter-dependent-curves",
      "composition-iteration",
      "inverse-functions",
      "recurrence-structure",
      "monotonicity-boundedness",
      "sequence-convergence",
      "equations-inequalities",
      "inequalities-bounds",
      "derivative-structure",
      "integral-accumulation",
      "optimization-extrema"
    ] as const) {
      expect(concepts.has(required)).toBe(true);
    }

    const skills = new Set(adaptive.flatMap((metadata) => metadata.skillEvidence.map((item) => item.skill)));
    for (const required of [
      "graph-sketching",
      "visualization",
      "strategic-simplification",
      "conjecture-formation",
      "proof-construction",
      "representation-switching",
      "precision-checking",
      "transfer",
      "generalization"
    ] as const) {
      expect(skills.has(required)).toBe(true);
    }
  });

  it("labels intentionally related families with shared similarity clusters", () => {
    const clusterCounts = new Map<string, number>();
    for (const entry of oxfordCantorReviewEntries) {
      const cluster = entry.metadata.oxfordAdaptive?.similarityClusterId;
      if (cluster === undefined) continue;
      clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1);
    }
    expect(clusterCounts.get("parameter-envelope")).toBe(2);
    expect(clusterCounts.get("mobius-iteration")).toBe(2);
  });
});

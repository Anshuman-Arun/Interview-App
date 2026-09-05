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

function family(id: string) {
  const value = oxfordCantorFamilies.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`Missing Cantor family ${id}`);
  return value;
}

function entry(id: string) {
  const value = oxfordCantorReviewEntries.find((candidate) => candidate.problem.id === id);
  if (value === undefined) throw new Error(`Missing Cantor entry ${id}`);
  return value;
}

describe("Agent C — Cantor Wave 2 Oxford candidates", () => {
  it("keeps exactly 18 surviving candidate families isolated in expert review", () => {
    expect(oxfordCantorFamilies).toHaveLength(18);
    expect(oxfordCantorReviewEntries).toHaveLength(18);

    const ids = oxfordCantorReviewEntries.map((candidate) => candidate.problem.id);
    expect(new Set(ids).size).toBe(18);
    expect(ids).not.toContain("oxford-cantor-tangent-intersection-locus");
    expect(ids).not.toContain("oxford-cantor-line-envelope");

    const reviewProblemIds = new Set(EXPERT_REVIEW_PROBLEMS.map((problem) => problem.id));
    const reviewMetadataIds = new Set(EXPERT_REVIEW_METADATA.map((metadata) => metadata.id));
    for (const candidate of oxfordCantorReviewEntries) {
      expect(candidate.metadata.reviewStatus).toBe("expert-review");
      expect(reviewProblemIds.has(candidate.problem.id)).toBe(true);
      expect(reviewMetadataIds.has(candidate.problem.id)).toBe(true);
    }
  });

  it("validates every surviving family against the frozen Oxford adaptive contract", () => {
    for (const candidate of oxfordCantorReviewEntries) {
      const adaptive = candidate.metadata.oxfordAdaptive;
      expect(adaptive?.status).toBe("authored");
      if (adaptive === undefined) throw new Error(`Missing adaptive metadata for ${candidate.problem.id}`);
      expect(() => assertOxfordAdaptiveMetadataIntegrity(adaptive, candidate.problem)).not.toThrow();
      expect(adaptive.familyId).toBe(candidate.problem.id);
      expect(adaptive.difficulty?.confidence).toBe("low");
      expect(adaptive.timing?.confidence).toBe("low");
      for (const stage of adaptive.stages) expect(stage.timing.confidence).toBe("low");
    }
  });

  it("keeps all independent review and calibration gates pending and recommendation-ineligible", () => {
    for (const candidate of oxfordCantorReviewEntries) {
      const adaptive = candidate.metadata.oxfordAdaptive;
      if (adaptive === undefined) throw new Error(`Missing adaptive metadata for ${candidate.problem.id}`);
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
    for (const candidate of oxfordCantorReviewEntries) {
      const disclosures = candidate.problem.interviewer.protectedDisclosures;
      expect(disclosures).toHaveLength(5);
      const referenced = new Set(
        candidate.problem.interviewer.reasoningGraph.milestones.flatMap(
          (milestone) => milestone.protectedDisclosureIds
        )
      );
      expect(referenced.size).toBe(5);
      for (const disclosure of disclosures) expect(referenced.has(disclosure.id)).toBe(true);
    }
  });

  it("never treats process-grounded skills as milestone-completion evidence", () => {
    for (const candidate of oxfordCantorReviewEntries) {
      const adaptive = candidate.metadata.oxfordAdaptive;
      if (adaptive === undefined) throw new Error(`Missing adaptive metadata for ${candidate.problem.id}`);
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
    for (const candidate of oxfordCantorReviewEntries) {
      const serializedPublic = JSON.stringify(candidate.problem.public);
      expect(serializedPublic).not.toContain("contentConcepts");
      expect(serializedPublic).not.toContain("skillEvidence");
      expect(serializedPublic).not.toContain("difficultyCalibration");
      expect(serializedPublic).not.toContain("timingCalibration");
      expect(serializedPublic).not.toContain("provenance");
      expect(candidate.problem).not.toHaveProperty("oxfordAdaptive");
    }
  });

  it("fills the graph-heavy remit after removing Hilbert hard rejects", () => {
    const adaptive = oxfordCantorReviewEntries.map((candidate) => {
      const value = candidate.metadata.oxfordAdaptive;
      if (value === undefined) throw new Error(`Missing adaptive metadata for ${candidate.problem.id}`);
      return value;
    });

    const graphHeavy = adaptive.filter((metadata) => metadata.domains.includes("graph-sketching"));
    expect(graphHeavy).toHaveLength(14);

    const concepts = new Set(adaptive.flatMap((metadata) => metadata.contentConcepts));
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
    ] as const) expect(concepts.has(required)).toBe(true);

    const skills = new Set(
      adaptive.flatMap((metadata) => metadata.skillEvidence.map((item) => item.skill))
    );
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
    ] as const) expect(skills.has(required)).toBe(true);
  });

  it("applies Hilbert and Gauss findings without self-certifying them", () => {
    expect(entry("oxford-cantor-moving-v-envelope").metadata.oxfordAdaptive?.provenance).toEqual({
      originType: "classic-problem",
      sourceCategory: "classic-mathematics"
    });
    expect(entry("oxford-cantor-moving-v-envelope").metadata.oxfordAdaptive?.similarityClusterId)
      .toBe("parameter-envelope");

    for (const id of [
      "oxford-cantor-cubic-divided-difference",
      "oxford-cantor-exponential-rotating-line",
      "oxford-cantor-mobius-recurrence",
      "oxford-cantor-squared-error-recurrence",
      "oxford-cantor-three-cycle-map",
      "oxford-cantor-reciprocal-increment-recurrence"
    ]) {
      expect(entry(id).metadata.oxfordAdaptive?.provenance).toEqual({
        originType: "classic-problem",
        sourceCategory: "secondary-reference"
      });
    }

    expect(entry("oxford-cantor-cubic-divided-difference").metadata.oxfordAdaptive?.difficulty)
      .toMatchObject({ entry: "introductory-plus", core: "strong", ceiling: "strong" });
    expect(entry("oxford-cantor-reciprocal-increment-recurrence").metadata.oxfordAdaptive?.difficulty)
      .toMatchObject({ entry: "introductory-plus", core: "strong", ceiling: "stretch" });
  });

  it("uses family-specific low-confidence interview-planning timings", () => {
    const softCutoffs = new Set<number>();
    for (const candidate of oxfordCantorReviewEntries) {
      const timing = candidate.metadata.oxfordAdaptive?.timing;
      if (timing === undefined) throw new Error(`Missing timing for ${candidate.problem.id}`);
      expect(timing.confidence).toBe("low");
      expect(timing.softCutoffMinutes).toBeGreaterThanOrEqual(20);
      expect(timing.softCutoffMinutes).toBeLessThanOrEqual(25);
      softCutoffs.add(timing.softCutoffMinutes);

      const stages = candidate.metadata.oxfordAdaptive?.stages;
      if (stages === undefined) throw new Error(`Missing stages for ${candidate.problem.id}`);
      expect(stages[0]?.timing.softCutoffMinutes).toBeLessThanOrEqual(7);
      expect(stages[1]?.timing.softCutoffMinutes).toBeLessThanOrEqual(18);
      expect(stages[2]?.timing.softCutoffMinutes).toBeLessThanOrEqual(11);
    }
    expect(softCutoffs.size).toBeGreaterThanOrEqual(4);

    expect(entry("oxford-cantor-cubic-divided-difference").metadata.oxfordAdaptive?.timing)
      .toMatchObject({
        firstMeaningfulInsightMinutes: { min: 2, max: 5 },
        independentCompletionMinutes: { min: 14, max: 24 },
        promptedCompletionMinutes: { min: 10, max: 20 },
        optionalExtensionMinutes: { min: 4, max: 8 },
        softCutoffMinutes: 24,
        confidence: "low"
      });
    expect(entry("oxford-cantor-reciprocal-increment-recurrence").metadata.oxfordAdaptive?.timing)
      .toMatchObject({
        firstMeaningfulInsightMinutes: { min: 2, max: 5 },
        independentCompletionMinutes: { min: 17, max: 28 },
        promptedCompletionMinutes: { min: 13, max: 23 },
        optionalExtensionMinutes: { min: 5, max: 10 },
        softCutoffMinutes: 25,
        confidence: "low"
      });
  });

  it("keeps main prompt mathematics in core and reserves milestone five for transfer", () => {
    const expectedCoreMilestones: Record<string, string> = {
      "oxford-cantor-moving-v-envelope": "validity-and-envelope",
      "oxford-cantor-reciprocal-root-parabolas": "vertex-locus",
      "oxford-cantor-cubic-two-thresholds": "full-regime-classification",
      "oxford-cantor-integral-sign-landscape": "zero-count-and-locations",
      "oxford-cantor-mobius-recurrence": "explicit-form-and-limit",
      "oxford-cantor-squared-error-recurrence": "error-square-and-exact-rate",
      "oxford-cantor-radical-asymptote": "strict-decrease-and-range",
      "oxford-cantor-shifted-cubic-intersections": "transition-and-small-shift",
      "oxford-cantor-reciprocal-implicit-curve": "asymptotes-and-closest",
      "oxford-cantor-three-cycle-map": "exact-period-three",
      "oxford-cantor-reciprocal-increment-recurrence": "error-sum-and-limit",
      "oxford-cantor-mobius-involution": "fixed-points-and-exception"
    };

    for (const [id, milestoneId] of Object.entries(expectedCoreMilestones)) {
      const stages = entry(id).metadata.oxfordAdaptive?.stages;
      const core = stages?.find((stage) => stage.id === "core");
      const extension = stages?.find((stage) => stage.id === "extension");
      expect(core?.milestones.map((milestone) => milestone.milestoneId)).toContain(milestoneId);
      expect(extension?.milestones.map((milestone) => milestone.milestoneId)).not.toContain(
        milestoneId
      );
    }
  });

  it("preserves the Itô implicit-curve correction and removes vocabulary-only prerequisites", () => {
    const implicit = family("oxford-cantor-reciprocal-implicit-curve");
    expect(implicit.prompt).toContain("nonzero branches");
    expect(implicit.commonErrors.find((error) => error.id === "include-axis-points")?.description)
      .toContain("deleting the isolated solution (0,0)");
    expect(implicit.canonicalSolution)
      .toContain("globally the isolated origin itself is of course the closest point");
    expect(implicit.canonicalSolution).toContain("closest nonzero branch points");

    const recurrence = family("oxford-cantor-reciprocal-increment-recurrence");
    expect(recurrence.givenInformation.join(" ")).toContain("positive decreasing function h");
    expect(recurrence.givenInformation.join(" ")).toContain("integral");

    const selfInverse = family("oxford-cantor-mobius-involution");
    const shifted = selfInverse.extensions.find(
      (extension) => extension.id === "shifted-scaled-involution"
    );
    expect(shifted?.prompt).toContain("S(S(x))=x");
  });

  it("retains the surviving similarity/repetition signals", () => {
    expect(entry("oxford-cantor-moving-v-envelope").metadata.oxfordAdaptive?.similarityClusterId)
      .toBe("parameter-envelope");
    const mobius = oxfordCantorReviewEntries.filter(
      (candidate) => candidate.metadata.oxfordAdaptive?.similarityClusterId === "mobius-iteration"
    );
    expect(mobius).toHaveLength(2);
  });
});

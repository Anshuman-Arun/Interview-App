import { describe, expect, it } from "vitest";
import {
  dirichletCandidateEntries
} from "../packages/problems/src/curated/agent-d-dirichlet/index.js";
import { CURATED_DISCLOSURE_LEVELS } from "../packages/problems/src/curated-disclosure-levels.js";
import {
  assertOxfordAdaptiveMetadataIntegrity,
  isOxfordRecommendationReady,
  OXFORD_SKILL_EVIDENCE_BASIS
} from "../packages/problems/src/oxford-adaptive-taxonomy.js";

describe("Agent D — Dirichlet Oxford candidate bank", () => {
  it("contains exactly 11 distinct final-synchronization candidates", () => {
    expect(dirichletCandidateEntries).toHaveLength(11);
    const ids = dirichletCandidateEntries.map((entry) => entry.problem.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("oxford-d-"))).toBe(true);
    expect(
      dirichletCandidateEntries.every(
        (entry) => entry.metadata.reviewStatus === "expert-review"
      )
    ).toBe(true);
  });

  it("keeps every survivor outside recommendation-ready status while preserving latest H/I findings", () => {
    const reviewById = new Map(
      dirichletCandidateEntries.map((entry) => [
        entry.problem.id,
        entry.metadata.oxfordAdaptive?.review
      ])
    );

    for (const entry of dirichletCandidateEntries) {
      const metadata = entry.metadata.oxfordAdaptive;
      expect(metadata?.status).toBe("authored");
      expect(isOxfordRecommendationReady(metadata)).toBe(false);
      expect(metadata?.review.mathematicalCorrectness).toBe("approved");
      expect(metadata?.review.timingCalibration).toBe("unreviewed");
    }

    for (const id of [
      "oxford-d-gcd-descent-network",
      "oxford-d-thirds-closed-integers",
      "oxford-d-balancing-transfers",
      "oxford-d-cube-twist-equivalence",
      "oxford-d-sliding-window-parity",
      "oxford-d-weighted-cycle-readings",
      "oxford-d-midpoint-closed-residues",
      "oxford-d-odd-symmetric-difference",
      "oxford-d-triple-flip-circle"
    ] as const) {
      expect(reviewById.get(id)).toMatchObject({
        originality: "approved",
        fidelity: "approved",
        mathematicalCorrectness: "approved"
      });
    }

    for (const id of [
      "oxford-d-three-reversal-permutations",
      "oxford-d-divisor-step-geometry"
    ] as const) {
      expect(reviewById.get(id)).toMatchObject({
        originality: "changes-required",
        fidelity: "approved",
        mathematicalCorrectness: "approved"
      });
    }

    expect(reviewById.get("oxford-d-weighted-cycle-readings")).toMatchObject({
      taxonomyClassification: "in-review",
      difficultyCalibration: "expert-estimate"
    });
  });

  it("uses family-specific low-confidence timing estimates", () => {
    const wholeTimingSignatures: string[] = [];
    const familyStageSignatures: string[] = [];

    for (const entry of dirichletCandidateEntries) {
      const metadata = entry.metadata.oxfordAdaptive;
      expect(metadata?.timing).toBeDefined();
      if (metadata?.timing === undefined) {
        throw new Error(`Missing family timing for ${entry.problem.id}`);
      }

      expect(metadata.timing.confidence).toBe("low");
      expect(metadata.timing.firstMeaningfulInsightMinutes.min).toBeLessThanOrEqual(
        metadata.timing.firstMeaningfulInsightMinutes.max
      );
      expect(metadata.timing.promptedCompletionMinutes.max).toBeLessThanOrEqual(
        metadata.timing.independentCompletionMinutes.max
      );
      expect(metadata.timing.softCutoffMinutes).toBeGreaterThanOrEqual(
        metadata.timing.promptedCompletionMinutes.max
      );
      expect(metadata.timing.softCutoffMinutes).toBeGreaterThanOrEqual(
        metadata.timing.independentCompletionMinutes.min
      );
      wholeTimingSignatures.push(JSON.stringify(metadata.timing));

      const stageSignature: string[] = [];
      for (const stage of metadata.stages) {
        expect(stage.timing.confidence).toBe("low");
        expect(stage.timing.firstMeaningfulInsightMinutes.min).toBeLessThanOrEqual(
          stage.timing.firstMeaningfulInsightMinutes.max
        );
        expect(stage.timing.promptedCompletionMinutes.max).toBeLessThanOrEqual(
          stage.timing.independentCompletionMinutes.max
        );
        expect(stage.timing.softCutoffMinutes).toBeGreaterThanOrEqual(
          stage.timing.independentCompletionMinutes.max
        );
        stageSignature.push(JSON.stringify(stage.timing));
      }
      familyStageSignatures.push(stageSignature.join("|"));
    }

    expect(new Set(wholeTimingSignatures).size).toBe(dirichletCandidateEntries.length);
    expect(new Set(familyStageSignatures).size).toBe(dirichletCandidateEntries.length);
  });

  it("matches Gauss whole-family timing estimates for all eight revised profiles", () => {
    const expected = {
      "oxford-d-thirds-closed-integers": [3, 6, 17, 28, 13, 22, 5, 9, 25],
      "oxford-d-cube-twist-equivalence": [2, 5, 14, 23, 10, 18, 4, 7, 22],
      "oxford-d-sliding-window-parity": [1, 4, 12, 20, 9, 16, 4, 7, 20],
      "oxford-d-weighted-cycle-readings": [2, 5, 15, 24, 11, 20, 4, 8, 23],
      "oxford-d-midpoint-closed-residues": [3, 6, 17, 28, 13, 22, 5, 9, 25],
      "oxford-d-three-reversal-permutations": [2, 5, 14, 23, 10, 19, 4, 8, 22],
      "oxford-d-divisor-step-geometry": [2, 5, 15, 25, 11, 20, 4, 8, 23],
      "oxford-d-triple-flip-circle": [3, 6, 17, 28, 13, 22, 5, 9, 25]
    } as const;

    const byId = new Map(
      dirichletCandidateEntries.map((entry) => [
        entry.problem.id,
        entry.metadata.oxfordAdaptive?.timing
      ])
    );

    for (const [id, values] of Object.entries(expected)) {
      const timing = byId.get(id);
      expect(timing).toBeDefined();
      if (timing === undefined) {
        throw new Error(`Missing timing for ${id}`);
      }
      expect([
        timing.firstMeaningfulInsightMinutes.min,
        timing.firstMeaningfulInsightMinutes.max,
        timing.independentCompletionMinutes.min,
        timing.independentCompletionMinutes.max,
        timing.promptedCompletionMinutes.min,
        timing.promptedCompletionMinutes.max,
        timing.optionalExtensionMinutes?.min,
        timing.optionalExtensionMinutes?.max,
        timing.softCutoffMinutes
      ]).toEqual(values);
    }
  });

  it("applies the final Gauss taxonomy/difficulty and Hilbert provenance revisions", () => {
    const byId = new Map(
      dirichletCandidateEntries.map((entry) => [
        entry.problem.id,
        entry.metadata.oxfordAdaptive
      ])
    );

    const thirds = byId.get("oxford-d-thirds-closed-integers");
    expect(thirds?.difficulty).toMatchObject({
      entry: "introductory-plus",
      core: "strong",
      ceiling: "strong"
    });

    const weighted = byId.get("oxford-d-weighted-cycle-readings");
    expect(weighted?.domains).toContain("sequences-recurrences");
    expect(weighted?.contentConcepts).toContain("recurrence-structure");
    expect(weighted?.difficulty).toMatchObject({
      entry: "introductory-plus",
      core: "strong",
      ceiling: "strong"
    });
    const weightedCore = weighted?.stages.find(
      (stage) => stage.id === "weighted-cycle-core"
    );
    expect(weightedCore?.domains).toContain("sequences-recurrences");
    expect(weightedCore?.contentConcepts).toContain("recurrence-structure");
    for (const milestoneId of [
      "derive-one-step-recurrence",
      "close-after-n-steps"
    ]) {
      expect(
        weightedCore?.milestones.find(
          (milestone) => milestone.milestoneId === milestoneId
        )?.contentConcepts
      ).toContain("recurrence-structure");
    }

    const midpoint = byId.get("oxford-d-midpoint-closed-residues");
    expect(midpoint?.difficulty).toMatchObject({
      entry: "introductory-plus",
      core: "strong",
      ceiling: "stretch"
    });

    for (const id of [
      "oxford-d-three-reversal-permutations",
      "oxford-d-divisor-step-geometry"
    ] as const) {
      expect(byId.get(id)?.provenance).toEqual({
        originType: "classic-problem",
        sourceCategory: "classic-mathematics"
      });
    }
  });

  it("does not expose any completion-pass pruned family", () => {
    const prunedIds = [
      "oxford-d-switching-cuts",
      "oxford-d-orientation-parities",
      "oxford-d-prime-divisor-three-cycles",
      "oxford-d-laminar-family",
      "oxford-d-discrete-maximum-principle",
      "oxford-d-finite-map-cycles",
      "oxford-d-spanning-tree-exchange",
      "oxford-d-stable-binary-words",
      "oxford-d-directed-flow-decomposition",
      "oxford-d-idempotent-maps",
      "oxford-d-mirror-orbits"
    ] as const;
    const survivingIds = new Set(
      dirichletCandidateEntries.map((entry) => entry.problem.id)
    );
    for (const id of prunedIds) {
      expect(survivingIds.has(id)).toBe(false);
      expect(CURATED_DISCLOSURE_LEVELS[id]).toBeUndefined();
    }
  });

  it("owns explicit semantic disclosure levels for every candidate hint", () => {
    for (const entry of dirichletCandidateEntries) {
      const levels = CURATED_DISCLOSURE_LEVELS[entry.problem.id];
      expect(levels).toBeDefined();
      if (levels === undefined) {
        throw new Error(`Missing disclosure levels for ${entry.problem.id}`);
      }
      expect(Object.keys(levels)).toEqual(["1", "2", "3", "4", "5"]);
      for (const stage of [1, 2, 3, 4, 5] as const) {
        const suffix = `_hint_${String(stage)}`;
        const disclosure = entry.problem.interviewer.protectedDisclosures.find(
          (candidate) => candidate.id.endsWith(suffix)
        );
        expect(disclosure).toBeDefined();
        if (disclosure === undefined) {
          throw new Error(
            `Missing protected disclosure ${entry.problem.id} stage ${String(stage)}`
          );
        }
        expect(disclosure.minimumDisclosureLevel).toBe(levels[stage]);
        expect(disclosure.equivalentFormulations.length).toBeGreaterThan(0);
      }
      expect(levels[5]).toBe(5);
    }
  });

  it("passes the frozen Oxford metadata and reasoning-graph integrity validators", () => {
    for (const entry of dirichletCandidateEntries) {
      const metadata = entry.metadata.oxfordAdaptive;
      expect(metadata).toBeDefined();
      if (metadata === undefined) {
        throw new Error(`Missing Oxford adaptive metadata for ${entry.problem.id}`);
      }
      assertOxfordAdaptiveMetadataIntegrity(metadata, entry.problem);
      expect(entry.problem.interviewer.protectedDisclosures).toHaveLength(5);
    }
  });

  it("never uses process-grounded skills as milestone-completion evidence", () => {
    for (const entry of dirichletCandidateEntries) {
      const metadata = entry.metadata.oxfordAdaptive;
      expect(metadata).toBeDefined();
      if (metadata === undefined) {
        throw new Error(`Missing Oxford adaptive metadata for ${entry.problem.id}`);
      }
      for (const stage of metadata.stages) {
        for (const milestone of stage.milestones) {
          for (const evidence of milestone.skillEvidence) {
            expect(OXFORD_SKILL_EVIDENCE_BASIS[evidence.skill]).toBe(
              "milestone-grounded"
            );
          }
        }
      }
    }
  });

  it("clusters the two intentionally related closure-classification families", () => {
    const closureIds = new Set([
      "oxford-d-thirds-closed-integers",
      "oxford-d-midpoint-closed-residues"
    ]);
    const clusterIds = dirichletCandidateEntries
      .filter((entry) => closureIds.has(entry.problem.id))
      .map((entry) => entry.metadata.oxfordAdaptive?.similarityClusterId);
    expect(clusterIds).toEqual([
      "closure-classification-residue-affine",
      "closure-classification-residue-affine"
    ]);
  });

  it("assigns every reasoning milestone and extension to exactly one Oxford stage", () => {
    for (const entry of dirichletCandidateEntries) {
      const metadata = entry.metadata.oxfordAdaptive;
      expect(metadata).toBeDefined();
      if (metadata === undefined) {
        throw new Error(`Missing Oxford adaptive metadata for ${entry.problem.id}`);
      }
      const stagedMilestones = metadata.stages.flatMap((stage) =>
        stage.milestones.map((milestone) => milestone.milestoneId)
      );
      const stagedExtensions = metadata.stages.flatMap(
        (stage) => stage.extensionIds
      );
      expect(new Set(stagedMilestones).size).toBe(stagedMilestones.length);
      expect(new Set(stagedExtensions).size).toBe(stagedExtensions.length);
      expect(new Set(stagedMilestones)).toEqual(
        new Set(
          entry.problem.interviewer.reasoningGraph.milestones.map(
            (milestone) => milestone.id
          )
        )
      );
      expect(new Set(stagedExtensions)).toEqual(
        new Set(
          entry.problem.interviewer.reasoningGraph.extensions.map(
            (extension) => extension.id
          )
        )
      );
    }
  });
});

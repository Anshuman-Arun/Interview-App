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
  it("contains exactly 12 distinct completion-pass candidates", () => {
    expect(dirichletCandidateEntries).toHaveLength(12);
    const ids = dirichletCandidateEntries.map((entry) => entry.problem.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("oxford-d-"))).toBe(true);
    expect(
      dirichletCandidateEntries.every(
        (entry) => entry.metadata.reviewStatus === "expert-review"
      )
    ).toBe(true);
  });

  it("keeps every survivor outside recommendation-ready status while preserving completed reviews", () => {
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
      expect(metadata?.review.timingCalibration).toBe("unreviewed");
    }

    expect(reviewById.get("oxford-d-gcd-descent-network")).toMatchObject({
      taxonomyClassification: "approved",
      originality: "approved",
      fidelity: "approved",
      mathematicalCorrectness: "unreviewed",
      difficultyCalibration: "expert-estimate",
      timingCalibration: "unreviewed"
    });
    expect(reviewById.get("oxford-d-thirds-closed-integers")).toMatchObject({
      originality: "approved",
      fidelity: "approved"
    });
    expect(reviewById.get("oxford-d-midpoint-closed-residues")).toMatchObject({
      mathematicalCorrectness: "approved"
    });
    expect(reviewById.get("oxford-d-triple-flip-circle")).toMatchObject({
      taxonomyClassification: "approved",
      mathematicalCorrectness: "approved",
      difficultyCalibration: "expert-estimate",
      timingCalibration: "unreviewed"
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
        metadata.timing.independentCompletionMinutes.max
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
      "oxford-d-idempotent-maps"
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

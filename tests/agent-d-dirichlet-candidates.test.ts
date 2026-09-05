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
  it("contains exactly 22 distinct expert-review candidates", () => {
    expect(dirichletCandidateEntries).toHaveLength(22);
    const ids = dirichletCandidateEntries.map((entry) => entry.problem.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("oxford-d-"))).toBe(true);
    expect(
      dirichletCandidateEntries.every(
        (entry) => entry.metadata.reviewStatus === "expert-review"
      )
    ).toBe(true);
  });

  it("keeps every candidate outside recommendation-ready status", () => {
    for (const entry of dirichletCandidateEntries) {
      const metadata = entry.metadata.oxfordAdaptive;
      expect(metadata?.status).toBe("authored");
      expect(isOxfordRecommendationReady(metadata)).toBe(false);
      expect(metadata?.review.taxonomyClassification).toBe("unreviewed");
      expect(metadata?.review.originality).toBe("unreviewed");
      expect(metadata?.review.fidelity).toBe("unreviewed");
      expect(metadata?.review.mathematicalCorrectness).toBe("unreviewed");
      expect(metadata?.review.difficultyCalibration).toBe("unreviewed");
      expect(metadata?.review.timingCalibration).toBe("unreviewed");
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

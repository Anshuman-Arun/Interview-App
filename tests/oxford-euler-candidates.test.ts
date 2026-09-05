import { describe, expect, it } from "vitest";
import {
  EXPERT_REVIEW_METADATA,
  EXPERT_REVIEW_PROBLEMS,
  oxfordCuratedEntries
} from "../packages/problems/src/index.js";
import {
  assertOxfordAdaptiveMetadataIntegrity,
  getOxfordSkillEvidenceBasis,
  isOxfordRecommendationReady
} from "../packages/problems/src/oxford-adaptive-taxonomy.js";
import {
  eulerOxfordCandidateEntries,
  eulerOxfordCandidateSpecs
} from "../packages/problems/src/curated/oxford-euler-candidates.js";

describe("Agent E — Euler Oxford candidate batch", () => {
  it("authors exactly 19 unique candidate families in the expert-review quarantine", () => {
    expect(eulerOxfordCandidateSpecs).toHaveLength(19);
    expect(eulerOxfordCandidateEntries).toHaveLength(19);
    const ids = eulerOxfordCandidateSpecs.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    const liveIds = new Set(oxfordCuratedEntries.map((entry) => entry.problem.id));
    const reviewProblemIds = new Set(EXPERT_REVIEW_PROBLEMS.map((problem) => problem.id));
    const reviewMetadataIds = new Set(EXPERT_REVIEW_METADATA.map((metadata) => metadata.id));
    for (const id of ids) {
      expect(liveIds.has(id)).toBe(false);
      expect(reviewProblemIds.has(id)).toBe(true);
      expect(reviewMetadataIds.has(id)).toBe(true);
    }
  });

  it("keeps all independent review and calibration gates pending", () => {
    for (const entry of eulerOxfordCandidateEntries) {
      expect(entry.metadata.reviewStatus).toBe("expert-review");
      const adaptive = entry.metadata.oxfordAdaptive;
      expect(adaptive).toBeDefined();
      if (adaptive === undefined) throw new Error("Euler candidate missing Oxford metadata");
      expect(adaptive.status).toBe("authored");
      expect(adaptive.review).toEqual({
        taxonomyClassification: "in-review",
        originality: "in-review",
        fidelity: "in-review",
        mathematicalCorrectness: "in-review",
        difficultyCalibration: "unreviewed",
        timingCalibration: "unreviewed"
      });
      expect(isOxfordRecommendationReady(adaptive)).toBe(false);
      expect(() => assertOxfordAdaptiveMetadataIntegrity(adaptive, entry.problem)).not.toThrow();
    }
  });

  it("maps every family to five coherent stages, milestones, and protected disclosures", () => {
    for (const entry of eulerOxfordCandidateEntries) {
      const adaptive = entry.metadata.oxfordAdaptive;
      if (adaptive === undefined) throw new Error("Euler candidate missing Oxford metadata");
      expect(adaptive.stages).toHaveLength(5);
      expect(entry.problem.interviewer.reasoningGraph.milestones).toHaveLength(5);
      expect(entry.problem.interviewer.protectedDisclosures).toHaveLength(5);
      expect(adaptive.stages.map((stage) => stage.role)).toEqual([
        "warm-up", "core", "deep-dive", "transfer", "stretch"
      ]);
      const extensionIds = entry.problem.interviewer.reasoningGraph.extensions.map((extension) => extension.id);
      expect(adaptive.stages.flatMap((stage) => stage.extensionIds).sort()).toEqual([...extensionIds].sort());
    }
  });

  it("never uses milestone completion as evidence for process-grounded skills", () => {
    for (const entry of eulerOxfordCandidateEntries) {
      const adaptive = entry.metadata.oxfordAdaptive;
      if (adaptive === undefined) throw new Error("Euler candidate missing Oxford metadata");
      for (const stage of adaptive.stages) for (const milestone of stage.milestones) for (const evidence of milestone.skillEvidence) {
        expect(getOxfordSkillEvidenceBasis(evidence.skill)).toBe("milestone-grounded");
      }
    }
  });

  it("keeps backend-only adaptive, calibration, provenance, and solution fields out of public views", () => {
    for (const entry of eulerOxfordCandidateEntries) {
      const publicJson = JSON.stringify(entry.problem.public);
      for (const forbidden of ["oxfordAdaptive","skillEvidence","difficulty","timing","provenance","review","canonicalSolution","verificationNotes"]) {
        expect(publicJson).not.toContain(forbidden);
      }
    }
  });

  it("hits the Euler portfolio targets without extending the frozen taxonomy", () => {
    const metadata = eulerOxfordCandidateEntries.map((entry) => {
      const adaptive = entry.metadata.oxfordAdaptive;
      if (adaptive === undefined) throw new Error("Euler candidate missing Oxford metadata");
      return adaptive;
    });
    expect(metadata.filter((item) => item.introducesNewDefinition).length).toBeGreaterThanOrEqual(5);
    expect(metadata.filter((item) => item.skillEvidence.some((e) => e.skill === "modelling")).length).toBeGreaterThanOrEqual(4);
    expect(metadata.filter((item) => item.domains.includes("probability")).length).toBeGreaterThanOrEqual(5);
    expect(metadata.filter((item) => item.skillEvidence.some((e) => e.skill === "visualization")).length).toBeGreaterThanOrEqual(8);
    expect(metadata.filter((item) => item.skillEvidence.some((e) => e.skill === "representation-switching")).length).toBeGreaterThanOrEqual(17);
    expect(metadata.filter((item) => item.skillEvidence.some((e) => e.skill === "transfer")).length).toBeGreaterThanOrEqual(17);
  });

  it("uses similarity clusters only for clear same-wave near-neighbor mechanisms", () => {
    const clustered = eulerOxfordCandidateEntries.map((entry) => entry.metadata.oxfordAdaptive).filter((adaptive) => adaptive?.similarityClusterId !== undefined);
    expect(clustered.length).toBeGreaterThanOrEqual(8);
    expect(new Set(clustered.map((adaptive) => adaptive?.similarityClusterId))).toEqual(new Set([
      "euler-distance-loci", "euler-affine-dynamics", "euler-local-balance", "euler-discrete-dynamics-model", "euler-local-indicator-expectation"
    ]));
  });
});

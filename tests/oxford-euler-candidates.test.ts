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

const EXPECTED_CORE_STAGE = Object.freeze({
  "oxford-euler-quadrilateral-balance": "classification",
  "oxford-euler-random-chord-midpoint": "symmetry-sum",
  "oxford-euler-circle-sweep": "parameter-test",
  "oxford-euler-triangle-midpoint-cycle": "fixed-point",
  "oxford-euler-box-diagonal-bisector": "edge-test",
  "oxford-euler-diagonal-blend-transform": "metric",
  "oxford-euler-self-averaging-sets": "finite-orbit",
  "oxford-euler-corner-balanced-tables": "classification",
  "oxford-euler-tank-gauge-model": "structure",
  "oxford-euler-periodic-queue-model": "classification",
  "oxford-euler-kiosk-grid-model": "objective",
  "oxford-euler-cooling-data-model": "structure",
  "oxford-euler-random-halving-interval": "distribution"
} as const);

describe("Agent E — Euler Oxford candidate batch", () => {
  it("authors exactly 13 unique surviving candidate families in the expert-review quarantine", () => {
    expect(eulerOxfordCandidateSpecs).toHaveLength(13);
    expect(eulerOxfordCandidateEntries).toHaveLength(13);
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
      expect(adaptive.stages[0]?.role).toBe("warm-up");
      expect(adaptive.stages.at(-1)?.role).toBe("transfer");
      const coreStages = adaptive.stages.filter((stage) => stage.role === "core");
      expect(coreStages).toHaveLength(1);
      expect(coreStages[0]?.difficulty).toBe(adaptive.difficulty?.core);
      expect(coreStages[0]?.id).toBe(
        EXPECTED_CORE_STAGE[entry.problem.id as keyof typeof EXPECTED_CORE_STAGE]
      );
      const extensionIds = entry.problem.interviewer.reasoningGraph.extensions.map((extension) => extension.id);
      expect(adaptive.stages.flatMap((stage) => stage.extensionIds).sort()).toEqual([...extensionIds].sort());
    }
  });


  it("keeps explicit family and stage timing on every surviving family", () => {
    for (const entry of eulerOxfordCandidateEntries) {
      const adaptive = entry.metadata.oxfordAdaptive;
      if (adaptive?.timing === undefined) throw new Error("Euler candidate missing family timing");
      expect(adaptive.timing.softCutoffMinutes).toBeGreaterThan(0);
      expect(adaptive.stages.every((stage) => stage.timing.softCutoffMinutes > 0)).toBe(true);
    }
  });

  it("applies the four final Gauss family timing corrections exactly", () => {
    const expected = {
      "oxford-euler-circle-sweep": {
        firstMeaningfulInsightMinutes: { min: 1, max: 3 },
        independentCompletionMinutes: { min: 16, max: 26 },
        promptedCompletionMinutes: { min: 12, max: 22 },
        optionalExtensionMinutes: { min: 5, max: 9 },
        softCutoffMinutes: 25,
        confidence: "low"
      },
      "oxford-euler-box-diagonal-bisector": {
        firstMeaningfulInsightMinutes: { min: 1, max: 3 },
        independentCompletionMinutes: { min: 17, max: 28 },
        promptedCompletionMinutes: { min: 13, max: 23 },
        optionalExtensionMinutes: { min: 5, max: 9 },
        softCutoffMinutes: 25,
        confidence: "low"
      },
      "oxford-euler-periodic-queue-model": {
        firstMeaningfulInsightMinutes: { min: 1, max: 3 },
        independentCompletionMinutes: { min: 15, max: 24 },
        promptedCompletionMinutes: { min: 11, max: 20 },
        optionalExtensionMinutes: { min: 5, max: 8 },
        softCutoffMinutes: 23,
        confidence: "low"
      },
      "oxford-euler-kiosk-grid-model": {
        firstMeaningfulInsightMinutes: { min: 1, max: 3 },
        independentCompletionMinutes: { min: 15, max: 24 },
        promptedCompletionMinutes: { min: 11, max: 20 },
        optionalExtensionMinutes: { min: 5, max: 8 },
        softCutoffMinutes: 23,
        confidence: "low"
      }
    } as const;

    for (const [familyId, timing] of Object.entries(expected)) {
      const adaptive = eulerOxfordCandidateEntries.find(
        (entry) => entry.problem.id === familyId
      )?.metadata.oxfordAdaptive;
      expect(adaptive?.timing).toEqual(timing);
    }
  });

  it("applies the Gauss circle-sweep calibration findings without self-approving calibration", () => {
    const entry = eulerOxfordCandidateEntries.find(
      (candidate) => candidate.problem.id === "oxford-euler-circle-sweep"
    );
    const adaptive = entry?.metadata.oxfordAdaptive;
    expect(adaptive?.difficulty).toMatchObject({
      entry: "introductory",
      core: "strong",
      ceiling: "stretch"
    });
    expect(adaptive?.stages.find((stage) => stage.id === "circle-equation")).toMatchObject({
      role: "technique-check",
      difficulty: "introductory-plus"
    });
    expect(adaptive?.stages.find((stage) => stage.id === "parameter-test")).toMatchObject({
      role: "core",
      difficulty: "strong"
    });
    expect(adaptive?.review.difficultyCalibration).toBe("unreviewed");
    expect(adaptive?.review.timingCalibration).toBe("unreviewed");
  });

  it("applies the Gauss self-averaging taxonomy and core findings", () => {
    const entry = eulerOxfordCandidateEntries.find(
      (candidate) => candidate.problem.id === "oxford-euler-self-averaging-sets"
    );
    const adaptive = entry?.metadata.oxfordAdaptive;
    expect(adaptive?.domains).toContain("set-theory");
    expect(adaptive?.domains).not.toContain("combinatorics");
    expect(adaptive?.contentConcepts).toContain("set-maps");
    expect(adaptive?.contentConcepts).not.toContain("counting-structure");
    expect(adaptive?.prerequisiteConcepts).toContain("set-notation");
    expect(adaptive?.prerequisiteConcepts).not.toContain("counting-principles");
    expect(adaptive?.difficulty).toMatchObject({
      entry: "warm-up",
      core: "strong",
      ceiling: "strong"
    });
    expect(adaptive?.stages.find((stage) => stage.id === "finite-orbit")).toMatchObject({
      role: "core",
      difficulty: "strong"
    });
  });

  it("removes all Hilbert hard rejects and records truthful structural provenance", () => {
    const ids = new Set(eulerOxfordCandidateEntries.map((entry) => entry.problem.id));
    for (const rejected of [
      "oxford-euler-rectangle-area-table",
      "oxford-euler-difference-closed-sets",
      "oxford-euler-locally-balanced-labels",
      "oxford-euler-random-adjacent-consecutives",
      "oxford-euler-stop-on-change",
      "oxford-euler-random-subset-blocks"
    ]) {
      expect(ids.has(rejected)).toBe(false);
    }

    const expectedProvenance = {
      "oxford-euler-quadrilateral-balance": "british-flag-theorem",
      "oxford-euler-corner-balanced-tables": "additive-matrix-row-column-decomposition",
      "oxford-euler-periodic-queue-model": "lindley-reflected-queue",
      "oxford-euler-cooling-data-model": "newton-cooling-gap-decay",
      "oxford-euler-random-halving-interval": "dyadic-binary-coin-encoding"
    } as const;

    for (const [familyId, referenceFamilyId] of Object.entries(expectedProvenance)) {
      const adaptive = eulerOxfordCandidateEntries.find(
        (entry) => entry.problem.id === familyId
      )?.metadata.oxfordAdaptive;
      expect(adaptive?.provenance).toEqual({
        originType: "structural-adaptation",
        sourceCategory: "classic-mathematics",
        referenceFamilyId
      });
      expect(adaptive?.review.originality).toBe("in-review");
      expect(adaptive?.review.fidelity).toBe("in-review");
    }
  });

  it("makes the periodic queue initial state, domains, phase, and event order candidate-visible", () => {
    const queue = eulerOxfordCandidateEntries.find(
      (candidate) => candidate.problem.id === "oxford-euler-periodic-queue-model"
    )?.problem;
    const visible = JSON.stringify(queue?.public);
    expect(visible).toContain("q_0");
    expect(visible).toContain("nonnegative integers");
    expect(visible).toContain("positive integer");
    expect(visible).toContain("minute 1");
    expect(visible).toContain("arrivals join");
    expect(visible).toContain("served");
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
    expect(metadata.filter((item) => item.introducesNewDefinition).length).toBeGreaterThanOrEqual(4);
    expect(metadata.filter((item) => item.skillEvidence.some((e) => e.skill === "modelling")).length).toBeGreaterThanOrEqual(4);
    expect(metadata.filter((item) => item.domains.includes("probability")).length).toBeGreaterThanOrEqual(2);
    expect(metadata.filter((item) => item.skillEvidence.some((e) => e.skill === "visualization")).length).toBeGreaterThanOrEqual(7);
    expect(metadata.filter((item) => item.skillEvidence.some((e) => e.skill === "representation-switching")).length).toBeGreaterThanOrEqual(13);
    expect(metadata.filter((item) => item.skillEvidence.some((e) => e.skill === "transfer")).length).toBeGreaterThanOrEqual(12);
  });

  it("uses similarity clusters only for clear same-wave near-neighbor mechanisms", () => {
    const clustered = eulerOxfordCandidateEntries.map((entry) => entry.metadata.oxfordAdaptive).filter((adaptive) => adaptive?.similarityClusterId !== undefined);
    expect(clustered).toHaveLength(6);
    expect(new Set(clustered.map((adaptive) => adaptive?.similarityClusterId))).toEqual(new Set([
      "euler-distance-loci", "euler-affine-dynamics", "euler-discrete-dynamics-model"
    ]));
  });
});

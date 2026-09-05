import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertOxfordCalibrationClaimSupport,
  assertOxfordCalibrationReviewRecord,
  getOxfordCalibrationReviewState,
  isOxfordCalibrationReviewSupported,
  summarizeOxfordCalibrationReviews,
  type OxfordAdaptiveMetadata,
  type OxfordCalibrationReviewRecord,
  type OxfordTimingEstimate
} from "../packages/problems/src/index.js";

describe("Oxford independent calibration review", () => {
  it("accepts a low-confidence expert review using only frozen taxonomy", () => {
    const review = validReview();
    expect(() => assertOxfordCalibrationReviewRecord(review)).not.toThrow();
  });

  it("keeps prerequisite and assessed-content semantics distinct even when a concept overlaps", () => {
    const review = validReview();
    expect(review.taxonomy.prerequisiteConcepts).toContain("divisibility");
    expect(review.taxonomy.contentConcepts).toContain("divisibility");
    expect(() => assertOxfordCalibrationReviewRecord(review)).not.toThrow();
  });

  it("rejects review content concepts without a declared canonical parent domain", () => {
    const base = validReview();
    const bad = {
      ...base,
      taxonomy: {
        ...base.taxonomy,
        domains: ["set-theory"],
        rationale: {
          ...base.taxonomy.rationale,
          domains: "Deliberately invalid test domain."
        }
      }
    } as unknown as OxfordCalibrationReviewRecord;

    expect(() => assertOxfordCalibrationReviewRecord(bad)).toThrow(
      /requires one of parent domains/iu
    );
  });

  it("rejects process-grounded skills as milestone evidence", () => {
    const base = validReview();
    const bad = {
      ...base,
      taxonomy: {
        ...base.taxonomy,
        reasoningSkills: [...base.taxonomy.reasoningSkills, "guided-adaptation"],
        milestoneSkillClaims: base.taxonomy.milestoneSkillClaims.map((claim) =>
          claim.milestoneId === "explore"
            ? { ...claim, skills: [...claim.skills, "guided-adaptation"] }
            : claim
        )
      }
    } as OxfordCalibrationReviewRecord;

    expect(() => assertOxfordCalibrationReviewRecord(bad)).toThrow(
      /cannot claim process-grounded skill "guided-adaptation"/iu
    );
  });

  it("rejects invalid entry/core/ceiling ordering", () => {
    const base = validReview();
    const bad = {
      ...base,
      difficulty: {
        ...base.difficulty,
        entry: "strong",
        core: "standard"
      }
    } as OxfordCalibrationReviewRecord;

    expect(() => assertOxfordCalibrationReviewRecord(bad)).toThrow(
      /entry <= core <= ceiling/iu
    );
  });

  it("rejects incoherent stage difficulty", () => {
    const base = validReview();
    const first = base.difficulty.stageAssessments[0];
    if (first === undefined) throw new Error("Expected fixture stage");
    const bad = {
      ...base,
      difficulty: {
        ...base.difficulty,
        stageAssessments: [
          { ...first, difficulty: "warm-up" },
          ...base.difficulty.stageAssessments.slice(1)
        ]
      }
    } as OxfordCalibrationReviewRecord;

    expect(() => assertOxfordCalibrationReviewRecord(bad)).toThrow(
      /must lie between family entry and ceiling/iu
    );
  });

  it("rejects impossible timing ranges and premature soft cutoffs", () => {
    const base = validReview();
    const impossible = {
      ...base,
      timing: {
        ...base.timing,
        estimate: {
          ...base.timing.estimate,
          independentCompletionMinutes: { min: 0.5, max: 8 }
        }
      }
    } as OxfordCalibrationReviewRecord;
    expect(() => assertOxfordCalibrationReviewRecord(impossible)).toThrow(
      /completion cannot begin before first meaningful insight/iu
    );

    const cutoff = {
      ...base,
      timing: {
        ...base.timing,
        estimate: {
          ...base.timing.estimate,
          softCutoffMinutes: 3
        }
      }
    } as OxfordCalibrationReviewRecord;
    expect(() => assertOxfordCalibrationReviewRecord(cutoff)).toThrow(
      /soft cutoff cannot precede the upper first-meaningful-insight estimate/iu
    );
  });

  it("rejects empirical calibration status without actual distribution evidence", () => {
    const base = validReview();
    const bad = {
      ...base,
      difficulty: {
        ...base.difficulty,
        recommendedStatus: "empirically-calibrated"
      }
    } as OxfordCalibrationReviewRecord;

    expect(() => assertOxfordCalibrationReviewRecord(bad)).toThrow(
      /cannot be empirically calibrated from expert-only evidence/iu
    );
  });

  it("rejects high confidence supported only by one expert judgment", () => {
    const base = validReview();
    const bad = {
      ...base,
      difficulty: {
        ...base.difficulty,
        confidence: "high"
      }
    } as OxfordCalibrationReviewRecord;

    expect(() => assertOxfordCalibrationReviewRecord(bad)).toThrow(
      /high confidence requires independent agreement or empirical evidence/iu
    );
  });

  it("accepts empirical status only with usage distributions and conditioning axes", () => {
    const base = validReview();
    const empiricalEvidence = {
      basis: "empirical-distribution" as const,
      reviewerCount: 1,
      sampleSize: 48,
      conditionedOn: [
        "candidate-strength" as const,
        "assistance-history" as const,
        "stage-reached" as const
      ],
      distributionSummary: "Retained family/stage quantiles and censored observations by conditioning stratum.",
      notes: "Fixture represents actual usage-distribution evidence."
    };
    const empirical = {
      ...base,
      difficulty: {
        ...base.difficulty,
        recommendedStatus: "empirically-calibrated" as const,
        confidence: "high" as const,
        evidence: empiricalEvidence
      },
      timing: {
        ...base.timing,
        recommendedStatus: "empirically-calibrated" as const,
        estimate: {
          ...base.timing.estimate,
          confidence: "high" as const
        },
        stageAssessments: base.timing.stageAssessments.map((stage) => ({
          ...stage,
          timing: { ...stage.timing, confidence: "high" as const }
        })),
        evidence: empiricalEvidence
      }
    };

    expect(() => assertOxfordCalibrationReviewRecord(empirical)).not.toThrow();
  });

  it("requires calibrated authored claims to match the independent family and stage review", () => {
    const metadata = calibratedMetadata();
    const review = validReview();

    expect(() => assertOxfordCalibrationClaimSupport(metadata, review)).not.toThrow();

    const wrongCore = {
      ...review,
      difficulty: {
        ...review.difficulty,
        core: "strong",
        stageAssessments: review.difficulty.stageAssessments.map((stage) =>
          stage.role === "core" ? { ...stage, difficulty: "strong" as const } : stage
        )
      }
    } as OxfordCalibrationReviewRecord;

    expect(() => assertOxfordCalibrationClaimSupport(metadata, wrongCore)).toThrow(
      /must match the independently reviewed profile/iu
    );
  });

  it("requires approved taxonomy and milestone attributions to match independent review", () => {
    const metadata = recommendationReadyMetadata();
    const review = validReview();
    expect(isOxfordCalibrationReviewSupported(metadata, review)).toBe(true);

    const wrongTaxonomy = {
      ...review,
      taxonomy: {
        ...review.taxonomy,
        prerequisiteConcepts: []
      }
    } as OxfordCalibrationReviewRecord;
    expect(() => assertOxfordCalibrationClaimSupport(metadata, wrongTaxonomy)).toThrow(
      /approved Oxford taxonomy metadata must match/iu
    );

    const wrongMilestone = {
      ...review,
      taxonomy: {
        ...review.taxonomy,
        milestoneSkillClaims: review.taxonomy.milestoneSkillClaims.map((claim) =>
          claim.milestoneId === "prove"
            ? { ...claim, contentConcepts: ["divisibility" as const] }
            : claim
        )
      }
    } as OxfordCalibrationReviewRecord;
    expect(() => assertOxfordCalibrationClaimSupport(metadata, wrongMilestone)).toThrow(
      /milestone attribution "prove" does not match/iu
    );
  });

  it("keeps calibration state separate from the authoritative recommendation-readiness gate", () => {
    const uncalibrated = uncalibratedMetadata();
    const uncalibratedState = getOxfordCalibrationReviewState(uncalibrated, validReview());
    expect(uncalibratedState).toMatchObject({
      difficultyCalibrated: false,
      timingCalibrated: false,
      recommendationReady: false
    });

    const calibrated = calibratedMetadata();
    const calibratedState = getOxfordCalibrationReviewState(calibrated, validReview());
    expect(calibratedState).toMatchObject({
      difficultyCalibrated: true,
      timingCalibrated: true,
      recommendationReady: false,
      independentReviewSupported: true
    });

    const ready = recommendationReadyMetadata();
    const readyState = getOxfordCalibrationReviewState(ready, validReview());
    expect(readyState).toEqual({
      difficultyCalibrated: true,
      timingCalibrated: true,
      recommendationReady: true,
      independentReviewSupported: true
    });
  });

  it("rejects metadata that upgrades beyond the independent calibration evidence", () => {
    const metadata = calibratedMetadata();
    const empiricalMetadata = {
      ...metadata,
      review: {
        ...metadata.review,
        difficultyCalibration: "empirically-calibrated" as const
      }
    };
    expect(() => assertOxfordCalibrationClaimSupport(empiricalMetadata, validReview())).toThrow(
      /exceeds independent review/iu
    );
  });

  it("validates every retained existing-bank audit record and summarizes dispositions", () => {
    const auditPath = new URL(
      "../docs/oxford-research/gauss-existing-bank-audit.json",
      import.meta.url
    );
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
      readonly agent: string;
      readonly records: readonly OxfordCalibrationReviewRecord[];
    };

    expect(audit.agent).toBe("G — Gauss");
    expect(audit.records).toHaveLength(14);
    for (const record of audit.records) {
      expect(() => assertOxfordCalibrationReviewRecord(record)).not.toThrow();
      expect(record.ownershipBoundaries).toEqual({
        originality: "pending-agent-h",
        fidelity: "pending-agent-h",
        mathematicalCorrectness: "pending-agent-i"
      });
    }

    const summary = summarizeOxfordCalibrationReviews(audit.records);
    expect(summary.total).toBe(14);
    expect(summary.byDisposition).toEqual({
      "safe-for-later-calibration": 2,
      "needs-revision": 7,
      "retain-legacy": 5
    });
    expect(summary.byDomain["graph-sketching"]).toBe(0);
  });
});

function validReview(): OxfordCalibrationReviewRecord {
  const metadata = baseMetadata();
  const opening = metadata.stages[0];
  const core = metadata.stages[1];
  if (opening === undefined || core === undefined || metadata.difficulty === undefined || metadata.timing === undefined) {
    throw new Error("Expected complete metadata fixture");
  }

  return {
    schemaVersion: 1,
    familyId: metadata.familyId,
    source: "agent-c",
    reviewedMetadataStatus: "author-proposal",
    taxonomy: {
      domains: ["number-theory"],
      contentConcepts: ["divisibility", "parity"],
      prerequisiteConcepts: ["divisibility"],
      reasoningSkills: [
        "small-case-exploration",
        "proof-construction",
        "generalization"
      ],
      milestoneSkillClaims: [
        {
          milestoneId: "explore",
          skills: ["small-case-exploration"],
          contentConcepts: ["divisibility"]
        },
        {
          milestoneId: "prove",
          skills: ["proof-construction", "generalization"],
          contentConcepts: ["divisibility", "parity"]
        }
      ],
      rationale: {
        domains: "The mathematical object and target are number theoretic.",
        contentConcepts: "Divisibility and parity are both explicitly exercised.",
        prerequisiteConcepts: "Basic divisibility is assumed without teaching even though it is also exercised.",
        reasoningSkills: "The family elicits exploration followed by proof and extension."
      }
    },
    difficulty: {
      recommendedStatus: "expert-estimate",
      entry: metadata.difficulty.entry,
      core: metadata.difficulty.core,
      ceiling: metadata.difficulty.ceiling,
      confidence: metadata.difficulty.confidence,
      factors: {
        "prerequisite-burden": 1,
        "initial-insight-barrier": 1,
        "conceptual-jumps": 2,
        "abstraction": 1,
        "proof-rigor-burden": 2,
        "representation-changes": 1,
        "productive-prompt-dependency": 1,
        "extension-ceiling": 3
      },
      stageAssessments: [
        {
          stageId: opening.id,
          role: opening.role,
          difficulty: opening.difficulty,
          rationale: "Accessible exploration stage."
        },
        {
          stageId: core.id,
          role: core.role,
          difficulty: core.difficulty,
          rationale: "Core proof matches the family standard band."
        }
      ],
      evidence: {
        basis: "expert-judgment",
        reviewerCount: 1,
        notes: "Independent reviewer estimate with no usage distribution."
      },
      rationale: "Accessible entry, meaningful proof core, and optional stretch ceiling."
    },
    timing: {
      recommendedStatus: "expert-estimate",
      estimate: metadata.timing,
      stageAssessments: [
        {
          stageId: opening.id,
          timing: opening.timing,
          rationale: "Short exploratory opening."
        },
        {
          stageId: core.id,
          timing: core.timing,
          rationale: "Core proof can occupy most of the mathematical discussion."
        }
      ],
      evidence: {
        basis: "expert-judgment",
        reviewerCount: 1,
        notes: "Independent reviewer estimate with no usage distribution."
      },
      rationale: "Backend-only soft timing estimate anchored only to whole-interview scale."
    },
    disposition: "safe-for-later-calibration",
    migration: {
      worthMigrating: true,
      recommendation: "migrate",
      rationale: "Fixture is suitable for later reviewed migration."
    },
    blockers: [],
    ownershipBoundaries: {
      originality: "pending-agent-h",
      fidelity: "pending-agent-h",
      mathematicalCorrectness: "pending-agent-i"
    },
    reviewNotes: []
  };
}

function recommendationReadyMetadata(): OxfordAdaptiveMetadata {
  const metadata = calibratedMetadata();
  return {
    ...metadata,
    review: {
      ...metadata.review,
      taxonomyClassification: "approved",
      originality: "approved",
      fidelity: "approved",
      mathematicalCorrectness: "approved"
    }
  };
}

function calibratedMetadata(): OxfordAdaptiveMetadata {
  const metadata = baseMetadata();
  return {
    ...metadata,
    review: {
      ...metadata.review,
      difficultyCalibration: "expert-estimate",
      timingCalibration: "expert-estimate"
    }
  };
}

function uncalibratedMetadata(): OxfordAdaptiveMetadata {
  const metadata = baseMetadata();
  return {
    ...metadata,
    review: {
      ...metadata.review,
      difficultyCalibration: "unreviewed",
      timingCalibration: "unreviewed"
    }
  };
}

function baseMetadata(): OxfordAdaptiveMetadata {
  const familyTiming = timing(
    { min: 1, max: 4 },
    { min: 8, max: 15 },
    { min: 6, max: 12 },
    { min: 4, max: 10 },
    12
  );
  const openingTiming = timing(
    { min: 0.5, max: 2 },
    { min: 2, max: 5 },
    { min: 1.5, max: 4 },
    undefined,
    4
  );
  const coreTiming = timing(
    { min: 1, max: 4 },
    { min: 5, max: 10 },
    { min: 4, max: 8 },
    { min: 4, max: 10 },
    8
  );

  return {
    schemaVersion: 1,
    taxonomyVersion: "1.0.0",
    status: "authored",
    familyId: "adaptive-fixture-family",
    similarityClusterId: "adaptive-fixture-cluster",
    domains: ["number-theory"],
    contentConcepts: ["divisibility", "parity"],
    prerequisiteConcepts: ["divisibility"],
    skillEvidence: [
      { skill: "small-case-exploration", weight: "primary" },
      { skill: "proof-construction", weight: "primary" },
      { skill: "generalization", weight: "supporting" }
    ],
    difficulty: {
      entry: "introductory",
      core: "standard",
      ceiling: "stretch",
      confidence: "low"
    },
    timing: familyTiming,
    novelty: "low",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      {
        id: "opening",
        role: "warm-up",
        prerequisiteStageIds: [],
        domains: ["number-theory"],
        contentConcepts: ["divisibility"],
        skillEvidence: [
          { skill: "small-case-exploration", weight: "primary" }
        ],
        milestones: [
          {
            milestoneId: "explore",
            skillEvidence: [
              { skill: "small-case-exploration", weight: "primary" }
            ],
            contentConcepts: ["divisibility"]
          }
        ],
        extensionIds: [],
        difficulty: "introductory",
        timing: openingTiming,
        novelty: "low",
        abstraction: "low",
        introducesNewDefinition: false
      },
      {
        id: "core-proof",
        role: "core",
        prerequisiteStageIds: ["opening"],
        domains: ["number-theory"],
        contentConcepts: ["divisibility", "parity"],
        skillEvidence: [
          { skill: "proof-construction", weight: "primary" },
          { skill: "generalization", weight: "supporting" }
        ],
        milestones: [
          {
            milestoneId: "prove",
            skillEvidence: [
              { skill: "proof-construction", weight: "primary" },
              { skill: "generalization", weight: "supporting" }
            ],
            contentConcepts: ["divisibility", "parity"]
          }
        ],
        extensionIds: ["generalize"],
        difficulty: "standard",
        timing: coreTiming,
        novelty: "low",
        abstraction: "moderate",
        introducesNewDefinition: false
      }
    ],
    provenance: {
      originType: "original",
      sourceCategory: "independent-original"
    },
    review: {
      taxonomyClassification: "unreviewed",
      originality: "unreviewed",
      fidelity: "unreviewed",
      mathematicalCorrectness: "unreviewed",
      difficultyCalibration: "unreviewed",
      timingCalibration: "unreviewed"
    }
  };
}

function timing(
  firstMeaningfulInsightMinutes: OxfordTimingEstimate["firstMeaningfulInsightMinutes"],
  independentCompletionMinutes: OxfordTimingEstimate["independentCompletionMinutes"],
  promptedCompletionMinutes: OxfordTimingEstimate["promptedCompletionMinutes"],
  optionalExtensionMinutes: OxfordTimingEstimate["optionalExtensionMinutes"],
  softCutoffMinutes: number
): OxfordTimingEstimate {
  return {
    firstMeaningfulInsightMinutes,
    independentCompletionMinutes,
    promptedCompletionMinutes,
    ...(optionalExtensionMinutes === undefined ? {} : { optionalExtensionMinutes }),
    softCutoffMinutes,
    confidence: "low"
  };
}

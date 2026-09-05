import { describe, expect, it } from "vitest";
import {
  DeliveryIdSchema,
  DisclosureIdSchema,
  GenerationIdSchema,
  SessionIdSchema,
  type DisclosureLevel,
  type EvaluationDimensionResult,
  type SessionEvaluation
} from "../packages/domain/src/index.js";
import {
  createProvisionalLegacyOxfordMetadata,
  projectOxfordStudentProfile,
  recommendNextOxfordProblem,
  type CuratedProblemMetadata,
  isOxfordRecommendationReady,
  type OxfordAdaptiveMetadata,
  type OxfordCalibrationStatus,
  type OxfordContentConcept,
  type OxfordDifficultyBand,
  type OxfordMathDomain,
  type OxfordOriginType,
  type OxfordPrerequisiteConcept,
  type OxfordProfileSessionEvidence,
  type OxfordRecommendationCandidate,
  type OxfordRecommendationOptions,
  type OxfordReviewStatus,
  type OxfordSourceCategory
} from "../packages/problems/src/index.js";

const AS_OF = "2026-09-05T12:00:00.000Z";

describe("Oxford between-interview adaptation", () => {
  it("keeps unknown competency distinct from weakness", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const numberTheory = profile.domains.find((item) => item.id === "number-theory");
    expect(numberTheory).toMatchObject({
      estimatedStrength: null,
      confidence: 0,
      uncertainty: 1,
      evidenceCount: 0,
      exposureCount: 0
    });
  });

  it("cold-start selection is deterministic and favors accessible reviewed diagnostics", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const accessible = candidate("a-accessible", {
      familyId: "family-a",
      entry: "introductory",
      core: "standard",
      ceiling: "strong",
      calibration: "empirically-calibrated"
    });
    const hard = candidate("z-hard", {
      familyId: "family-z",
      entry: "strong",
      core: "stretch",
      ceiling: "stretch",
      calibration: "expert-estimate"
    });

    const result = recommendNextOxfordProblem(profile, [hard, accessible]);
    expect(result.coldStart).toBe(true);
    expect(result.selected?.problemId).toBe("a-accessible");
    expect(result.selected?.reasonCodes).toContain("COLD_START_DIAGNOSTIC");
  });

  it("weights independent achievement more strongly than assisted achievement", () => {
    const meta = readyMetadata("skill-weight", {});
    const independent = projectOxfordStudentProfile([
      source("session-independent", meta, {
        achieved: true,
        assistanceLevel: 0
      })
    ], { asOf: AS_OF });
    const assisted = projectOxfordStudentProfile([
      source("session-assisted", meta, {
        achieved: true,
        assistanceLevel: 3
      })
    ], { asOf: AS_OF });

    expect(strength(independent, "modular-reasoning"))
      .toBeGreaterThan(strength(assisted, "modular-reasoning"));
    expect(independent.process.sessionsWithAssistance).toBe(0);
    expect(assisted.process.sessionsWithAssistance).toBe(1);
  });

  it("does not convert unsupported milestone non-completion into negative evidence", () => {
    const meta = readyMetadata("unsupported", {});
    const profile = projectOxfordStudentProfile([
      source("session-unsupported", meta, {
        achieved: false,
        supportLevel: "INSUFFICIENT",
        includeEvidenceRef: false
      })
    ], { asOf: AS_OF });

    const modular = profile.contentConcepts.find((item) => item.id === "modular-reasoning");
    expect(modular?.estimatedStrength).toBeNull();
    expect(modular?.evidenceCount).toBe(0);
    expect(modular?.exposureCount).toBe(1);
    expect(profile.diagnostics.unsupportedMilestoneCount).toBe(1);
  });

  it("deweights a stretch failure so it does not erase grounded core competence", () => {
    const meta = readyMetadata("stretch-safe", {});
    const profile = projectOxfordStudentProfile([
      source("session-core", meta, {
        achieved: true,
        milestoneId: "core-milestone",
        practicedAt: "2026-08-01T12:00:00.000Z"
      }),
      source("session-stretch", meta, {
        achieved: false,
        milestoneId: "stretch-milestone",
        practicedAt: "2026-09-01T12:00:00.000Z"
      })
    ], { asOf: AS_OF });

    expect(strength(profile, "modular-reasoning")).toBeGreaterThan(0.58);
  });

  it("requires intervention -> later incorporated progress for guided adaptation", () => {
    const meta = readyMetadata("guided", {
      includeGuidedAdaptation: true
    });
    const noRelationship = projectOxfordStudentProfile([
      source("session-guided-none", meta, {
        achieved: true,
        hintResponsivenessScore: 100
      })
    ], { asOf: AS_OF });
    expect(
      noRelationship.reasoningSkills.find((item) => item.id === "guided-adaptation")
        ?.estimatedStrength
    ).toBeNull();

    const grounded = projectOxfordStudentProfile([
      source("session-guided-grounded", meta, {
        achieved: true,
        processEvidence: [{
          kind: "guided-adaptation",
          id: "guided-1",
          interventionDeliveryId: "delivery-hint",
          interventionSequence: 10,
          subsequentProgressEventId: "event-progress",
          subsequentProgressSequence: 12,
          incorporatedIntervention: true,
          outcome: "PRODUCTIVE",
          supportLevel: "STRONG"
        }]
      })
    ], { asOf: AS_OF });

    expect(
      grounded.reasoningSkills.find((item) => item.id === "guided-adaptation")
        ?.estimatedStrength
    ).not.toBeNull();
    expect(grounded.process.guidedAdaptationEvidenceCount).toBe(1);
  });

  it("requires error -> later recovery ordering for explicit error-recovery evidence", () => {
    const meta = readyMetadata("recovery", {
      includeErrorRecovery: true
    });
    const invalid = projectOxfordStudentProfile([
      source("session-recovery-invalid", meta, {
        processEvidence: [{
          kind: "error-recovery",
          id: "bad-order",
          errorEventId: "event-error",
          errorSequence: 10,
          outcome: "RECOVERED",
          recoveryEventId: "event-recovery",
          recoverySequence: 9,
          supportLevel: "STRONG"
        }]
      })
    ], { asOf: AS_OF });
    expect(
      invalid.reasoningSkills.find((item) => item.id === "error-recovery")
        ?.estimatedStrength
    ).toBeNull();

    const valid = projectOxfordStudentProfile([
      source("session-recovery-valid", meta, {
        processEvidence: [{
          kind: "error-recovery",
          id: "good-order",
          errorEventId: "event-error",
          errorSequence: 10,
          outcome: "RECOVERED",
          recoveryEventId: "event-recovery",
          recoverySequence: 11,
          supportLevel: "STRONG"
        }]
      })
    ], { asOf: AS_OF });

    expect(
      valid.reasoningSkills.find((item) => item.id === "error-recovery")
        ?.estimatedStrength
    ).not.toBeNull();
    expect(valid.process.errorRecoveryEvidenceCount).toBe(1);
  });

  it("does not double-count the same historical session and is replay-order stable", () => {
    const meta = readyMetadata("replay", {});
    const first = source("session-replay-a", meta, {
      practicedAt: "2026-08-01T12:00:00.000Z"
    });
    const second = source("session-replay-b", meta, {
      practicedAt: "2026-08-15T12:00:00.000Z"
    });

    const withDuplicate = projectOxfordStudentProfile(
      [first, second, first],
      { asOf: AS_OF }
    );
    const reversed = projectOxfordStudentProfile(
      [second, first],
      { asOf: AS_OF }
    );

    expect(withDuplicate.diagnostics.duplicateSessionCount).toBe(1);
    expect(withDuplicate.contentConcepts).toEqual(reversed.contentConcepts);
    expect(withDuplicate.reasoningSkills).toEqual(reversed.reasoningSkills);
  });

  it("hard-filters exact/family/similarity cooldowns and known-unmet prerequisites", () => {
    const previousMeta = readyMetadata("previous", {
      familyId: "family-recent",
      clusterId: "cluster-recent"
    });
    const profile = projectOxfordStudentProfile([
      source("session-previous", previousMeta, {})
    ], { asOf: AS_OF });

    const sameExact = candidate("previous", {
      familyId: "family-recent",
      clusterId: "cluster-recent"
    });
    const sameFamily = candidate("same-family", {
      familyId: "family-recent",
      clusterId: "cluster-fresh"
    });
    const sameCluster = candidate("same-cluster", {
      familyId: "family-fresh-a",
      clusterId: "cluster-recent"
    });
    const unmet = candidate("unmet", {
      familyId: "family-fresh-b",
      clusterId: "cluster-fresh-b",
      prerequisites: ["divisibility"]
    });
    const fresh = candidate("fresh", {
      familyId: "family-fresh-c",
      clusterId: "cluster-fresh-c"
    });

    const result = recommendNextOxfordProblem(
      profile,
      [sameExact, sameFamily, sameCluster, unmet, fresh],
      { prerequisites: { divisibility: "UNMET" } }
    );

    expect(result.selected?.problemId).toBe("fresh");
    expect(exclusion(result, "previous")).toContain("EXACT_REPEAT_COOLDOWN");
    expect(exclusion(result, "same-family")).toContain("FAMILY_COOLDOWN");
    expect(exclusion(result, "same-cluster")).toContain("SIMILARITY_CLUSTER_COOLDOWN");
    expect(exclusion(result, "unmet")).toContain("PREREQUISITE_UNMET");
  });

  it("excludes provisional/unreviewed entries through the canonical readiness gate", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const provisional: OxfordRecommendationCandidate = {
      problemId: "legacy",
      problemVersion: "1.0.0",
      metadata: {
        id: "legacy",
        title: "Legacy",
        mode: "OXFORD_MATHEMATICS",
        category: "number theory",
        followUps: [],
        reviewStatus: "ready",
        oxfordAdaptive: createProvisionalLegacyOxfordMetadata("legacy")
      }
    };

    const unreviewed = candidate("unreviewed", {
      familyId: "family-unreviewed",
      reviewOriginality: "unreviewed"
    });
    const result = recommendNextOxfordProblem(profile, [provisional, unreviewed]);

    expect(exclusion(result, "legacy")).toContain("PROVISIONAL_LEGACY");
    expect(exclusion(result, "legacy")).toContain("NOT_RECOMMENDATION_READY");
    expect(exclusion(result, "unreviewed")).toContain("NOT_RECOMMENDATION_READY");
  });

  it("filters high-confidence difficulty mismatch and impossible session duration", () => {
    const meta = readyMetadata("ability-source", {});
    const history = Array.from({ length: 10 }, (_, index) =>
      source(`ability-${String(index)}`, meta, {
        practicedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`
      })
    );
    const profile = projectOxfordStudentProfile(history, { asOf: AS_OF });
    const tooEasy = candidate("too-easy", {
      familyId: "family-easy",
      entry: "warm-up",
      core: "introductory",
      ceiling: "introductory"
    });
    const tooLong = candidate("too-long", {
      familyId: "family-long",
      promptedMin: 25,
      promptedMax: 35,
      softCutoff: 30
    });
    const fit = candidate("fit", {
      familyId: "family-fit",
      entry: "introductory-plus",
      core: "standard",
      ceiling: "strong",
      promptedMin: 8,
      promptedMax: 15,
      softCutoff: 12
    });

    const result = recommendNextOxfordProblem(
      profile,
      [tooEasy, tooLong, fit],
      {
        availableMinutes: 20,
        cooldowns: {
          exactProblemSessions: 0,
          familySessions: 0,
          similarityClusterSessions: 0
        }
      }
    );

    expect(result.selected?.problemId).toBe("fit");
    expect(exclusion(result, "too-easy")).toContain("DIFFICULTY_MISMATCH");
    expect(exclusion(result, "too-long")).toContain("SESSION_TOO_LONG");
  });

  it("values information gain without always hammering the weakest known topic", () => {
    const knownMeta = readyMetadata("known-source", {});
    const history = Array.from({ length: 8 }, (_, index) =>
      source(`known-${String(index)}`, knownMeta, {
        practicedAt: `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`
      })
    );
    const profile = projectOxfordStudentProfile(history, { asOf: AS_OF });
    const known = candidate("known-candidate", {
      familyId: "known-family"
    });
    const uncertain = candidate("uncertain-candidate", {
      familyId: "uncertain-family",
      domain: "functions",
      concept: "function-transformations"
    });

    const result = recommendNextOxfordProblem(profile, [known, uncertain], {
      cooldowns: {
        exactProblemSessions: 0,
        familySessions: 0,
        similarityClusterSessions: 0
      },
      recentDomainWindowSessions: 0
    });

    expect(result.selected?.problemId).toBe("uncertain-candidate");
    expect(result.selected?.reasonCodes).toContain("INFORMATION_GAIN");
  });

  it("uses stable lexical tie-breaking and ignores extraneous portfolio counts", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const a = candidate("a-tie", { familyId: "family-a-tie" });
    const b = candidate("b-tie", { familyId: "family-b-tie" });

    const baseline = recommendNextOxfordProblem(profile, [b, a], {
      cooldowns: {
        exactProblemSessions: 0,
        familySessions: 0,
        similarityClusterSessions: 0
      }
    });
    const pollutedOptions = {
      cooldowns: {
        exactProblemSessions: 0,
        familySessions: 0,
        similarityClusterSessions: 0
      },
      portfolioCounts: {
        "family-a-tie": 1,
        "family-b-tie": 999
      }
    };
    const polluted = recommendNextOxfordProblem(profile, [b, a], pollutedOptions);

    expect(baseline.selected?.problemId).toBe("a-tie");
    expect(polluted.selected).toEqual(baseline.selected);
  });

  it("returns an explicit safe outcome when the recommendation-ready pool is empty", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const empty = recommendNextOxfordProblem(profile, []);

    expect(empty.outcome).toBe("NO_RECOMMENDATION_READY_CANDIDATES");
    expect(empty.recommendationReadyCandidateCount).toBe(0);
    expect(empty.eligibleCandidateCount).toBe(0);
    expect(empty.selected).toBeUndefined();
    expect(empty.alternatives).toEqual([]);
  });

  it("keeps all 61 author expert-review candidates out until canonical readiness passes", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const expertReviewCandidates = Array.from({ length: 61 }, (_, index) =>
      candidate(`expert-review-${String(index).padStart(2, "0")}`, {
        familyId: `expert-review-family-${String(index).padStart(2, "0")}`,
        reviewTaxonomy: "in-review",
        reviewOriginality: "in-review",
        reviewFidelity: "in-review",
        reviewCorrectness: "in-review",
        difficultyCalibration: "unreviewed",
        timingCalibration: "unreviewed"
      })
    );

    const result = recommendNextOxfordProblem(profile, expertReviewCandidates);

    expect(result.outcome).toBe("NO_RECOMMENDATION_READY_CANDIDATES");
    expect(result.recommendationReadyCandidateCount).toBe(0);
    expect(result.eligibleCandidateCount).toBe(0);
    expect(result.selected).toBeUndefined();
    expect(result.exclusions).toHaveLength(61);
    expect(result.exclusions.every((item) =>
      item.codes.includes("NOT_RECOMMENDATION_READY")
    )).toBe(true);
  });

  it("does not let external reviewer records promote unapproved canonical metadata", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const unapproved = candidate("externally-reviewed-only", {
      familyId: "externally-reviewed-only-family",
      reviewTaxonomy: "in-review",
      reviewOriginality: "in-review",
      reviewFidelity: "in-review",
      reviewCorrectness: "in-review",
      difficultyCalibration: "unreviewed",
      timingCalibration: "unreviewed"
    });
    const optionsWithExternalRecords: OxfordRecommendationOptions & {
      readonly externalReviewerRecords: readonly {
        readonly agent: string;
        readonly decision: string;
      }[];
    } = {
      topK: 3,
      externalReviewerRecords: [
        { agent: "G — Gauss", decision: "approve" },
        { agent: "H — Hilbert", decision: "approve" },
        { agent: "I — Itô", decision: "approve" }
      ]
    };

    const result = recommendNextOxfordProblem(
      profile,
      [unapproved],
      optionsWithExternalRecords
    );

    expect(result.outcome).toBe("NO_RECOMMENDATION_READY_CANDIDATES");
    expect(result.selected).toBeUndefined();
    expect(exclusion(result, "externally-reviewed-only"))
      .toContain("NOT_RECOMMENDATION_READY");
  });

  it("ranks only canonical-ready candidates while H/G/I changes-required remain excluded", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const hRejected = candidate("h-rejected", {
      familyId: "h-rejected-family",
      reviewOriginality: "changes-required"
    });
    const gChangesRequired = candidate("g-changes-required", {
      familyId: "g-changes-required-family",
      reviewTaxonomy: "changes-required"
    });
    const iChangesRequired = candidate("i-changes-required", {
      familyId: "i-changes-required-family",
      reviewCorrectness: "changes-required"
    });
    const ready = candidate("canonical-ready", {
      familyId: "canonical-ready-family"
    });

    expect(isOxfordRecommendationReady(hRejected.metadata.oxfordAdaptive)).toBe(false);
    expect(isOxfordRecommendationReady(gChangesRequired.metadata.oxfordAdaptive)).toBe(false);
    expect(isOxfordRecommendationReady(iChangesRequired.metadata.oxfordAdaptive)).toBe(false);
    expect(isOxfordRecommendationReady(ready.metadata.oxfordAdaptive)).toBe(true);

    const result = recommendNextOxfordProblem(
      profile,
      [hRejected, gChangesRequired, iChangesRequired, ready]
    );

    expect(result.outcome).toBe("RECOMMENDATION_SELECTED");
    expect(result.recommendationReadyCandidateCount).toBe(1);
    expect(result.selected?.problemId).toBe("canonical-ready");
    expect(exclusion(result, "h-rejected")).toContain("NOT_RECOMMENDATION_READY");
    expect(exclusion(result, "g-changes-required")).toContain("NOT_RECOMMENDATION_READY");
    expect(exclusion(result, "i-changes-required")).toContain("NOT_RECOMMENDATION_READY");
  });

  it("allows truthful classic provenance after every canonical gate approves it", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const classic = candidate("classic-ready", {
      familyId: "classic-ready-family",
      originType: "classic-problem",
      sourceCategory: "classic-mathematics"
    });

    expect(isOxfordRecommendationReady(classic.metadata.oxfordAdaptive)).toBe(true);
    const result = recommendNextOxfordProblem(profile, [classic]);

    expect(result.outcome).toBe("RECOMMENDATION_SELECTED");
    expect(result.selected?.problemId).toBe("classic-ready");
  });

  it("reports ready-but-filtered separately from a zero-ready certification pool", () => {
    const previousMeta = readyMetadata("filtered-source", {
      familyId: "filtered-family"
    });
    const profile = projectOxfordStudentProfile([
      source("session-filtered-source", previousMeta, {})
    ], { asOf: AS_OF });
    const cooling = candidate("filtered-next", {
      familyId: "filtered-family"
    });

    const result = recommendNextOxfordProblem(profile, [cooling]);

    expect(result.recommendationReadyCandidateCount).toBe(1);
    expect(result.eligibleCandidateCount).toBe(0);
    expect(result.outcome).toBe("NO_ELIGIBLE_CANDIDATES");
    expect(result.selected).toBeUndefined();
  });

  it("still returns a useful cold-start result when only one ready problem exists", () => {
    const profile = projectOxfordStudentProfile([], { asOf: AS_OF });
    const only = candidate("only-ready", { familyId: "only-family" });
    const result = recommendNextOxfordProblem(profile, [only]);
    expect(result.outcome).toBe("RECOMMENDATION_SELECTED");
    expect(result.recommendationReadyCandidateCount).toBe(1);
    expect(result.selected?.problemId).toBe("only-ready");
    expect(result.alternatives).toEqual([]);
  });
});

interface MetadataOptions {
  readonly familyId?: string;
  readonly clusterId?: string;
  readonly domain?: OxfordMathDomain;
  readonly concept?: OxfordContentConcept;
  readonly prerequisites?: readonly OxfordPrerequisiteConcept[];
  readonly entry?: OxfordDifficultyBand;
  readonly core?: OxfordDifficultyBand;
  readonly ceiling?: OxfordDifficultyBand;
  readonly calibration?: "expert-estimate" | "empirically-calibrated";
  readonly reviewTaxonomy?: OxfordReviewStatus;
  readonly reviewOriginality?: OxfordReviewStatus;
  readonly reviewFidelity?: OxfordReviewStatus;
  readonly reviewCorrectness?: OxfordReviewStatus;
  readonly difficultyCalibration?: OxfordCalibrationStatus;
  readonly timingCalibration?: OxfordCalibrationStatus;
  readonly originType?: OxfordOriginType;
  readonly sourceCategory?: OxfordSourceCategory;
  readonly promptedMin?: number;
  readonly promptedMax?: number;
  readonly softCutoff?: number;
  readonly includeGuidedAdaptation?: boolean;
  readonly includeErrorRecovery?: boolean;
}

function candidate(
  problemId: string,
  options: MetadataOptions
): OxfordRecommendationCandidate {
  return {
    problemId,
    problemVersion: "1.0.0",
    metadata: readyMetadata(problemId, options)
  };
}

function readyMetadata(
  problemId: string,
  options: MetadataOptions
): CuratedProblemMetadata {
  const domain = options.domain ?? "number-theory";
  const concept = options.concept ?? "modular-reasoning";
  const entry = options.entry ?? "introductory";
  const core = options.core ?? "standard";
  const ceiling = options.ceiling ?? "strong";
  const promptedMin = options.promptedMin ?? 7;
  const promptedMax = options.promptedMax ?? 14;
  const softCutoff = options.softCutoff ?? 12;
  const processSkills = [
    ...(options.includeGuidedAdaptation
      ? [{ skill: "guided-adaptation" as const, weight: "supporting" as const }]
      : []),
    ...(options.includeErrorRecovery
      ? [{ skill: "error-recovery" as const, weight: "supporting" as const }]
      : [])
  ];
  const timing = {
    firstMeaningfulInsightMinutes: { min: 1, max: 4 },
    independentCompletionMinutes: {
      min: Math.max(promptedMin, 8),
      max: Math.max(promptedMax, 16)
    },
    promptedCompletionMinutes: { min: promptedMin, max: promptedMax },
    optionalExtensionMinutes: { min: 4, max: 8 },
    softCutoffMinutes: softCutoff,
    confidence: "medium" as const
  };

  const adaptive: OxfordAdaptiveMetadata = {
    schemaVersion: 1,
    taxonomyVersion: "1.0.0",
    status: "authored",
    familyId: options.familyId ?? `${problemId}-family`,
    ...(options.clusterId === undefined ? {} : { similarityClusterId: options.clusterId }),
    domains: [domain],
    contentConcepts: [concept],
    prerequisiteConcepts: options.prerequisites ?? [],
    skillEvidence: [
      { skill: "proof-construction", weight: "primary" },
      ...processSkills
    ],
    difficulty: {
      entry,
      core,
      ceiling,
      confidence: "medium"
    },
    timing,
    novelty: "moderate",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      {
        id: "core-stage",
        role: "core",
        prerequisiteStageIds: [],
        domains: [domain],
        contentConcepts: [concept],
        skillEvidence: [
          { skill: "proof-construction", weight: "primary" },
          ...processSkills
        ],
        milestones: [{
          milestoneId: "core-milestone",
          skillEvidence: [{
            skill: "proof-construction",
            weight: "primary"
          }],
          contentConcepts: [concept]
        }],
        extensionIds: [],
        difficulty: core,
        timing,
        novelty: "moderate",
        abstraction: "moderate",
        introducesNewDefinition: false
      },
      {
        id: "stretch-stage",
        role: "stretch",
        prerequisiteStageIds: ["core-stage"],
        domains: [domain],
        contentConcepts: [concept],
        skillEvidence: [
          { skill: "proof-construction", weight: "primary" },
          ...processSkills
        ],
        milestones: [{
          milestoneId: "stretch-milestone",
          skillEvidence: [{
            skill: "proof-construction",
            weight: "primary"
          }],
          contentConcepts: [concept]
        }],
        extensionIds: [],
        difficulty: ceiling,
        timing,
        novelty: "moderate",
        abstraction: "moderate",
        introducesNewDefinition: false
      }
    ],
    provenance: {
      originType: options.originType ?? "original",
      sourceCategory: options.sourceCategory ?? "independent-original"
    },
    review: {
      taxonomyClassification: options.reviewTaxonomy ?? "approved",
      originality: options.reviewOriginality ?? "approved",
      fidelity: options.reviewFidelity ?? "approved",
      mathematicalCorrectness: options.reviewCorrectness ?? "approved",
      difficultyCalibration:
        options.difficultyCalibration ?? options.calibration ?? "expert-estimate",
      timingCalibration:
        options.timingCalibration ?? options.calibration ?? "expert-estimate"
    }
  };

  return {
    id: problemId,
    title: problemId,
    mode: "OXFORD_MATHEMATICS",
    category: domain,
    followUps: [],
    reviewStatus: "ready",
    oxfordAdaptive: adaptive
  };
}

interface SourceOptions {
  readonly achieved?: boolean;
  readonly assistanceLevel?: DisclosureLevel;
  readonly supportLevel?: "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";
  readonly includeEvidenceRef?: boolean;
  readonly milestoneId?: "core-milestone" | "stretch-milestone";
  readonly practicedAt?: string;
  readonly hintResponsivenessScore?: number;
  readonly processEvidence?: OxfordProfileSessionEvidence["processEvidence"];
}

function source(
  sessionName: string,
  metadata: CuratedProblemMetadata,
  options: SourceOptions
): OxfordProfileSessionEvidence {
  const practicedAt = options.practicedAt ?? "2026-08-20T12:00:00.000Z";
  return {
    evaluation: evaluation(sessionName, metadata.id, options),
    metadata,
    practicedAt,
    ...(options.processEvidence === undefined
      ? {}
      : { processEvidence: options.processEvidence })
  };
}

function evaluation(
  sessionName: string,
  problemId: string,
  options: SourceOptions
): SessionEvaluation {
  const achieved = options.achieved ?? true;
  const assistanceLevel = options.assistanceLevel ?? 0;
  const supportLevel = options.supportLevel ?? "STRONG";
  const includeEvidenceRef = options.includeEvidenceRef ?? supportLevel !== "INSUFFICIENT";
  const milestoneId = options.milestoneId ?? "core-milestone";
  const evidenceRefs = includeEvidenceRef
    ? [{ kind: "MILESTONE" as const, id: milestoneId }]
    : [];
  const disclosureId = DisclosureIdSchema.parse(`disclosure-${sessionName}`);
  const interventions = assistanceLevel > 0
    ? [{
        deliveryId: DeliveryIdSchema.parse(`delivery-${sessionName}`),
        generationId: GenerationIdSchema.parse(`generation-${sessionName}`),
        disclosureLevel: assistanceLevel,
        disclosureIds: [disclosureId],
        relatedMilestoneIds: [milestoneId],
        deliveryStatus: "COMPLETED" as const,
        summary: "Grounded assistance exposure"
      }]
    : [];

  const hint = options.hintResponsivenessScore === undefined
    ? dimension()
    : dimension(options.hintResponsivenessScore, "STRONG");

  return {
    sessionId: SessionIdSchema.parse(sessionName),
    problemId,
    problemVersion: "1.0.0",
    evaluatedAt: options.practicedAt ?? "2026-08-20T12:00:00.000Z",
    rubric: {
      correctnessWeight: 0.35,
      rigorWeight: 0.2,
      independenceWeight: 0.2,
      communicationWeight: 0.15,
      errorRecoveryWeight: 0.1
    },
    lifecycle: {
      sessionStatus: "COMPLETED",
      completionState: "COMPLETED",
      totalTurns: 1
    },
    scores: {
      technicalCorrectness: null,
      rigor: null,
      independence: null,
      communication: null,
      hintResponsiveness: hint.score,
      errorRecovery: null,
      compositeScore: null
    },
    dimensionResults: {
      technicalCorrectness: dimension(),
      rigor: dimension(),
      independence: dimension(),
      communication: dimension(),
      hintResponsiveness: hint,
      errorRecovery: dimension()
    },
    composite: {
      status: "NOT_SCORED",
      supportLevel: "INSUFFICIENT",
      includedDimensions: [],
      omittedDimensions: [
        "technicalCorrectness",
        "rigor",
        "independence",
        "communication",
        "errorRecovery"
      ]
    },
    milestones: [{
      milestoneId,
      description: milestoneId,
      achieved,
      ...(achieved
        ? {}
        : { notAchievedReason: "Grounded milestone not achieved" }),
      assistanceLevel,
      supportLevel,
      evidenceRefs,
      assistanceDisclosureIds: assistanceLevel > 0 ? [disclosureId] : [],
      approachIds: []
    }],
    disclosedInterventions: interventions,
    unassistedMilestoneCount: achieved && assistanceLevel === 0 ? 1 : 0,
    assistedMilestoneCount: achieved && assistanceLevel > 0 ? 1 : 0,
    totalTurns: 1,
    keyStrengths: [],
    areasForImprovement: [],
    summaryAssessment: "Synthetic grounded evaluation"
  };
}

function dimension(
  score: number | null = null,
  supportLevel: "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT" =
    score === null ? "INSUFFICIENT" : "STRONG"
): EvaluationDimensionResult {
  return {
    score,
    supportLevel,
    evidenceRefs: score === null ? [] : [{ kind: "TURN", id: "turn-evidence" }],
    ...(score === null ? { notScoredReason: "No grounded evidence" } : {})
  };
}

function strength(
  profile: ReturnType<typeof projectOxfordStudentProfile>,
  concept: OxfordContentConcept
): number {
  return profile.contentConcepts.find((item) => item.id === concept)
    ?.estimatedStrength ?? 0;
}

function exclusion(
  result: ReturnType<typeof recommendNextOxfordProblem>,
  problemId: string
): readonly string[] {
  return result.exclusions.find((item) => item.problemId === problemId)?.codes ?? [];
}

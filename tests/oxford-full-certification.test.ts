import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OXFORD_DIFFICULTY_BANDS } from "../packages/problems/src/oxford-adaptive-taxonomy.js";

type Decision = "approved" | "changes-required";
interface Range { min: number; max: number }
interface RecordShape {
  agent: string;
  authorAgent: string;
  prNumber: number;
  familyId: string;
  authorHeadReviewed: string;
  taxonomy: {
    decision: Decision;
    author: {
      domains: readonly string[];
      contentConcepts: readonly string[];
      prerequisiteConcepts: readonly string[];
      reasoningSkills: readonly string[];
    };
    recommended: {
      domains: readonly string[];
      contentConcepts: readonly string[];
      prerequisiteConcepts: readonly string[];
      reasoningSkills: readonly string[];
    };
    stageRoles: readonly { stageId: string; recommendedRole: string; decision: Decision }[];
    milestoneContentSkillAttribution: readonly {
      milestoneId: string;
      skills: readonly string[];
      contentConcepts: readonly string[];
      decision: Decision;
    }[];
    processGroundedSemantics: { decision: Decision };
  };
  difficulty: {
    decision: Decision;
    recommended: { entry: string; core: string; ceiling: string };
    stageBands: readonly {
      stageId: string;
      role: string;
      recommendedDifficulty: string;
      decision: Decision;
    }[];
  };
  timing: {
    decision: Decision;
    recommended: {
      firstMeaningfulInsightMinutes: Range;
      independentCompletionMinutes: Range;
      promptedCompletionMinutes: Range;
      optionalExtensionMinutes?: Range;
      softCutoffMinutes: number;
      confidence: string;
    };
  };
  requestedChanges: readonly string[];
  ownershipBoundaries: {
    originality: string;
    fidelity: string;
    mathematicalCorrectness: string;
  };
}
interface Artifact {
  agent: string;
  authorPullRequests: readonly {
    agent: string;
    prNumber: number;
    headSha: string;
    survivingFamilyCount: number;
    familiesReviewed: readonly string[];
  }[];
  systemicVerification: {
    cantor: Record<string, unknown>;
    dirichlet: Record<string, unknown>;
    euler: Record<string, unknown>;
  };
  summary: {
    reviewed: number;
    surviving: number;
    byAuthor: { cantor: number; dirichlet: number; euler: number };
    taxonomy: { approved: number; changesRequired: number };
    difficulty: { approved: number; changesRequired: number };
    timing: { approved: number; changesRequired: number };
  };
  records: readonly RecordShape[];
}

const artifactPath = new URL(
  "../docs/oxford-research/gauss-full-certification.json",
  import.meta.url
);
const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Artifact;
const difficultyRank = new Map(
  OXFORD_DIFFICULTY_BANDS.map((band, index) => [band, index])
);

function countDecision(
  key: "taxonomy" | "difficulty" | "timing",
  decision: Decision
): number {
  return artifact.records.filter((record) => record[key].decision === decision).length;
}

function assertRange(range: Range): void {
  expect(Number.isFinite(range.min)).toBe(true);
  expect(Number.isFinite(range.max)).toBe(true);
  expect(range.min).toBeGreaterThanOrEqual(0);
  expect(range.max).toBeGreaterThanOrEqual(range.min);
}

describe("Agent G full C/D/E certification", () => {
  it("covers every current survivor exactly once at the reviewed author heads", () => {
    expect(artifact.agent).toBe("G — Gauss");
    expect(artifact.summary).toEqual({
      reviewed: 41,
      surviving: 41,
      byAuthor: { cantor: 17, dirichlet: 11, euler: 13 },
      taxonomy: { approved: 41, changesRequired: 0 },
      difficulty: { approved: 41, changesRequired: 0 },
      timing: { approved: 41, changesRequired: 0 }
    });

    expect(artifact.authorPullRequests).toEqual([
      expect.objectContaining({
        agent: "C — Cantor",
        prNumber: 132,
        headSha: "8b22dc5df99111fb95e27a2c006d5e74544dd385",
        survivingFamilyCount: 17
      }),
      expect.objectContaining({
        agent: "D — Dirichlet",
        prNumber: 133,
        headSha: "1d9222ed89895f643b4f25429b0a5dbe1dac0a4c",
        survivingFamilyCount: 11
      }),
      expect.objectContaining({
        agent: "E — Euler",
        prNumber: 134,
        headSha: "8846c612825d2b8ae53a81f6f8861fd851f452c6",
        survivingFamilyCount: 13
      })
    ]);

    const ids = artifact.records.map((record) => record.familyId);
    expect(new Set(ids).size).toBe(41);
    const listedIds = artifact.authorPullRequests.flatMap((entry) => entry.familiesReviewed);
    expect(new Set(listedIds)).toEqual(new Set(ids));

    for (const author of artifact.authorPullRequests) {
      const records = artifact.records.filter((record) => record.prNumber === author.prNumber);
      expect(records).toHaveLength(author.survivingFamilyCount);
      for (const record of records) {
        expect(record.agent).toBe("G — Gauss");
        expect(record.authorHeadReviewed).toBe(author.headSha);
      }
    }
  });

  it("keeps decision summary counts derived from the records", () => {
    expect(countDecision("taxonomy", "approved")).toBe(41);
    expect(countDecision("taxonomy", "changes-required")).toBe(0);
    expect(countDecision("difficulty", "approved")).toBe(41);
    expect(countDecision("difficulty", "changes-required")).toBe(0);
    expect(countDecision("timing", "approved")).toBe(41);
    expect(countDecision("timing", "changes-required")).toBe(0);
  });

  it("requires coherent family and stage difficulty for every survivor", () => {
    for (const record of artifact.records) {
      const { entry, core, ceiling } = record.difficulty.recommended;
      const entryRank = difficultyRank.get(entry as never);
      const coreRank = difficultyRank.get(core as never);
      const ceilingRank = difficultyRank.get(ceiling as never);
      expect(entryRank, record.familyId).toBeDefined();
      expect(coreRank, record.familyId).toBeDefined();
      expect(ceilingRank, record.familyId).toBeDefined();
      if (entryRank === undefined || coreRank === undefined || ceilingRank === undefined) {
        throw new Error(`Unknown difficulty band in ${record.familyId}`);
      }
      expect(entryRank).toBeLessThanOrEqual(coreRank);
      expect(coreRank).toBeLessThanOrEqual(ceilingRank);

      expect(record.difficulty.stageBands.length).toBeGreaterThan(0);
      let sawCore = false;
      for (const stage of record.difficulty.stageBands) {
        const stageRank = difficultyRank.get(stage.recommendedDifficulty as never);
        expect(stageRank, `${record.familyId}/${stage.stageId}`).toBeDefined();
        if (stageRank === undefined) {
          throw new Error(`Unknown stage difficulty in ${record.familyId}/${stage.stageId}`);
        }
        expect(stageRank).toBeGreaterThanOrEqual(entryRank);
        expect(stageRank).toBeLessThanOrEqual(ceilingRank);
        if (stage.role === "core") {
          sawCore = true;
          expect(stage.recommendedDifficulty).toBe(core);
        }
      }
      expect(sawCore, record.familyId).toBe(true);
    }
  });

  it("requires a sane family-specific timing estimate for every survivor", () => {
    const timingFingerprints = new Set<string>();
    for (const record of artifact.records) {
      const timing = record.timing.recommended;
      assertRange(timing.firstMeaningfulInsightMinutes);
      assertRange(timing.independentCompletionMinutes);
      assertRange(timing.promptedCompletionMinutes);
      if (timing.optionalExtensionMinutes !== undefined) {
        assertRange(timing.optionalExtensionMinutes);
      }
      expect(timing.independentCompletionMinutes.min)
        .toBeGreaterThanOrEqual(timing.firstMeaningfulInsightMinutes.min);
      expect(timing.promptedCompletionMinutes.min)
        .toBeGreaterThanOrEqual(timing.firstMeaningfulInsightMinutes.min);
      expect(timing.softCutoffMinutes)
        .toBeGreaterThanOrEqual(timing.firstMeaningfulInsightMinutes.max);
      expect(timing.confidence).toBe("low");

      timingFingerprints.add(JSON.stringify(timing));
    }
    expect(timingFingerprints.size).toBeGreaterThan(20);
  });

  it("certifies stage/milestone semantics without taking H/I ownership", () => {
    for (const record of artifact.records) {
      expect(record.taxonomy.stageRoles.length).toBeGreaterThan(0);
      expect(record.taxonomy.milestoneContentSkillAttribution.length).toBeGreaterThan(0);
      expect(record.taxonomy.processGroundedSemantics.decision).toBe("approved");

      for (const milestone of record.taxonomy.milestoneContentSkillAttribution) {
        expect(milestone.skills).not.toContain("guided-adaptation");
        expect(milestone.skills).not.toContain("error-recovery");
      }

      expect(record.ownershipBoundaries).toEqual({
        originality: "pending-agent-h",
        fidelity: "pending-agent-h",
        mathematicalCorrectness: "pending-agent-i"
      });
    }
  });

  it("locks the requested systemic fixes and remaining Cantor blockers", () => {
    expect(artifact.systemicVerification.cantor).toMatchObject({
      overlongCutoffsCorrected: true,
      cubicDividedDifferenceCeilingCorrected: true,
      prerequisiteWordingImproved: true
    });
    expect(artifact.systemicVerification.dirichlet).toMatchObject({
      genericTimingTemplateRemoved: true,
      tripleFlipRecurrenceTaxonomyCorrected: true,
      knownDifficultyChangesApplied: true
    });
    expect(artifact.systemicVerification.euler).toMatchObject({
      genericTimingTableRemoved: true,
      mechanicalCoreAssignmentRemoved: true,
      circleSweepCoreCorrected: true,
      selfAveragingSetTaxonomyCorrected: true,
      allStageRolesMathematicallyKeyed: true
    });

    expect(artifact.records.some((record) => record.familyId === "oxford-d-mirror-orbits")).toBe(false);

    const weighted = artifact.records.find(
      (record) => record.familyId === "oxford-d-weighted-cycle-readings"
    );
    expect(weighted?.taxonomy.decision).toBe("approved");
    expect(weighted?.taxonomy.recommended.domains).toContain("sequences-recurrences");
    expect(weighted?.taxonomy.recommended.contentConcepts).toContain("recurrence-structure");

    for (const record of artifact.records) {
      expect(record.taxonomy.decision).toBe("approved");
      expect(record.difficulty.decision).toBe("approved");
      expect(record.timing.decision).toBe("approved");
      expect(record.requestedChanges).toEqual([]);
    }
  });
});

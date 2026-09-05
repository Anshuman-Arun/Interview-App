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
      reviewed: 49,
      surviving: 49,
      byAuthor: { cantor: 20, dirichlet: 12, euler: 17 },
      taxonomy: { approved: 47, changesRequired: 2 },
      difficulty: { approved: 42, changesRequired: 7 },
      timing: { approved: 22, changesRequired: 27 }
    });

    expect(artifact.authorPullRequests).toEqual([
      expect.objectContaining({
        agent: "C — Cantor",
        prNumber: 132,
        headSha: "c0140b480ca3d40e7bdc9e9ee6fdddbb18b201c9",
        survivingFamilyCount: 20
      }),
      expect.objectContaining({
        agent: "D — Dirichlet",
        prNumber: 133,
        headSha: "ecece22058c997d37c4b352fa5ed32bd1daf5243",
        survivingFamilyCount: 12
      }),
      expect.objectContaining({
        agent: "E — Euler",
        prNumber: 134,
        headSha: "e5f5b431a5dea843d69e6451b1114c7aa0c76532",
        survivingFamilyCount: 17
      })
    ]);

    const ids = artifact.records.map((record) => record.familyId);
    expect(new Set(ids).size).toBe(49);
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
    expect(countDecision("taxonomy", "approved")).toBe(47);
    expect(countDecision("taxonomy", "changes-required")).toBe(2);
    expect(countDecision("difficulty", "approved")).toBe(42);
    expect(countDecision("difficulty", "changes-required")).toBe(7);
    expect(countDecision("timing", "approved")).toBe(22);
    expect(countDecision("timing", "changes-required")).toBe(27);
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
      expect(entryRank!).toBeLessThanOrEqual(coreRank!);
      expect(coreRank!).toBeLessThanOrEqual(ceilingRank!);

      expect(record.difficulty.stageBands.length).toBeGreaterThan(0);
      let sawCore = false;
      for (const stage of record.difficulty.stageBands) {
        const stageRank = difficultyRank.get(stage.recommendedDifficulty as never);
        expect(stageRank, `${record.familyId}/${stage.stageId}`).toBeDefined();
        expect(stageRank!).toBeGreaterThanOrEqual(entryRank!);
        expect(stageRank!).toBeLessThanOrEqual(ceilingRank!);
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
      overlongCutoffsCorrected: false,
      cubicDividedDifferenceCeilingCorrected: false
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

    const weighted = artifact.records.find(
      (record) => record.familyId === "oxford-d-weighted-cycle-readings"
    );
    expect(weighted?.taxonomy.decision).toBe("changes-required");
    expect(weighted?.taxonomy.recommended.contentConcepts).toContain("recurrence-structure");

    const mirror = artifact.records.find(
      (record) => record.familyId === "oxford-d-mirror-orbits"
    );
    expect(mirror?.taxonomy.decision).toBe("changes-required");
    expect(mirror?.taxonomy.recommended.contentConcepts).toContain("divisibility");
  });
});

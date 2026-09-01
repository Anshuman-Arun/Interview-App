import type { InterviewProblem } from "../../domain/src/index.js";
import { biasedCoinProblem } from "./biased-coin.js";
import type { CuratedProblemMetadata, CuratedProblemMode } from "./curated-authoring.js";
import { gamblersRuinProblem } from "./gamblers-ruin.js";
import { hilbertHotelProblem } from "./hilbert-hotel.js";
import {
  oxfordCuratedMetadata,
  oxfordCuratedProblems,
  oxfordCuratedReviewEntries
} from "./oxford-curated.js";
import { prisonerHatsProblem } from "./prisoner-hats.js";
import { assertInterviewProblemIntegrity } from "./problem-integrity.js";
import {
  quantCuratedMetadata,
  quantCuratedProblems,
  quantCuratedReviewEntries
} from "./quant-curated.js";
import { sixPeopleProblem } from "./six-people.js";

export type ProblemCatalogMetadata = CuratedProblemMetadata;

const LEGACY_PROBLEM_METADATA: readonly ProblemCatalogMetadata[] = [
  {
    id: sixPeopleProblem.id,
    title: "Six People: Friends or Strangers",
    mode: "OXFORD_MATHEMATICS",
    category: "combinatorics",
    followUps: ["Why is five people not enough?"],
    reviewStatus: "ready"
  },
  {
    id: hilbertHotelProblem.id,
    title: "Hilbert's Hotel",
    mode: "OXFORD_MATHEMATICS",
    category: "set theory",
    followUps: ["How would you accommodate countably many infinite buses?"],
    reviewStatus: "ready"
  },
  {
    id: prisonerHatsProblem.id,
    title: "One Hundred Prisoners and Two Hat Colours",
    mode: "OXFORD_MATHEMATICS",
    category: "combinatorics",
    followUps: ["How does the strategy generalize to three hat colours?"],
    reviewStatus: "ready"
  },
  {
    id: gamblersRuinProblem.id,
    title: "Gambler's Ruin",
    mode: "QUANT",
    category: "stochastic processes",
    followUps: ["How would you find the expected absorption time?"],
    reviewStatus: "ready"
  },
  {
    id: biasedCoinProblem.id,
    title: "Extracting a Fair Coin from a Biased Coin",
    mode: "QUANT",
    category: "probability",
    followUps: ["Can the discarded outcomes be recycled for greater efficiency?"],
    reviewStatus: "ready"
  }
] as const;

export function createProblemCatalog(
  problems: readonly InterviewProblem[]
): readonly InterviewProblem[] {
  const identities = new Set<string>();
  const snapshots: InterviewProblem[] = [];

  for (const problem of problems) {
    assertInterviewProblemIntegrity(problem);
    const identity = JSON.stringify([problem.id, problem.version]);
    if (identities.has(identity)) {
      throw new Error(
        `Duplicate problem catalog identity "${problem.id}" version "${problem.version}"`
      );
    }
    identities.add(identity);
    snapshots.push(deepFreeze(structuredClone(problem)));
  }

  assertUniqueDisclosureOwnership(snapshots);
  return Object.freeze(snapshots);
}

export function assertProblemBankIntegrity(
  problems: readonly InterviewProblem[],
  metadata: readonly ProblemCatalogMetadata[]
): void {
  createProblemCatalog(problems);

  const problemIds = new Set<string>();
  for (const problem of problems) {
    if (problemIds.has(problem.id)) {
      throw new Error(`Built-in problem bank contains duplicate problem ID "${problem.id}"`);
    }
    problemIds.add(problem.id);
  }
  assertUniqueDisclosureOwnership(problems);

  const metadataIds = new Set<string>();
  for (const item of metadata) {
    assertMetadataStructure(item);
    if (item.reviewStatus !== "ready") {
      throw new Error(`Default problem bank cannot include non-ready problem "${item.id}"`);
    }
    if (metadataIds.has(item.id)) {
      throw new Error(`Duplicate problem metadata ID "${item.id}"`);
    }
    metadataIds.add(item.id);
    if (!problemIds.has(item.id)) {
      throw new Error(`Problem metadata references unknown problem "${item.id}"`);
    }
  }

  for (const problemId of problemIds) {
    if (!metadataIds.has(problemId)) {
      throw new Error(`Problem "${problemId}" is missing catalog metadata`);
    }
  }
}

const BUILT_IN_PROBLEM_INPUTS: readonly InterviewProblem[] = [
  sixPeopleProblem,
  hilbertHotelProblem,
  prisonerHatsProblem,
  gamblersRuinProblem,
  biasedCoinProblem,
  ...oxfordCuratedProblems,
  ...quantCuratedProblems
] as const;

export const ALL_PROBLEMS = createProblemCatalog(BUILT_IN_PROBLEM_INPUTS);

export const PROBLEM_METADATA: readonly ProblemCatalogMetadata[] = Object.freeze([
  ...LEGACY_PROBLEM_METADATA,
  ...oxfordCuratedMetadata,
  ...quantCuratedMetadata
].map((metadata) => deepFreeze(structuredClone(metadata))));

assertProblemBankIntegrity(ALL_PROBLEMS, PROBLEM_METADATA);

const EXPERT_REVIEW_ENTRIES = [
  ...oxfordCuratedReviewEntries,
  ...quantCuratedReviewEntries
] as const;

export const EXPERT_REVIEW_PROBLEMS: readonly InterviewProblem[] = createProblemCatalog(
  EXPERT_REVIEW_ENTRIES.map((entry) => entry.problem)
);

export const EXPERT_REVIEW_METADATA: readonly ProblemCatalogMetadata[] = Object.freeze(
  EXPERT_REVIEW_ENTRIES.map((entry) => deepFreeze(structuredClone(entry.metadata)))
);

assertExpertReviewCatalogIntegrity(EXPERT_REVIEW_PROBLEMS, EXPERT_REVIEW_METADATA);
assertReviewCatalogIsolated(ALL_PROBLEMS, EXPERT_REVIEW_PROBLEMS);

export const problemCatalog = ALL_PROBLEMS;

export function getProblemById(id: string): InterviewProblem | undefined {
  return problemCatalog.find((problem) => problem.id === id);
}

export function getProblemByIdentity(
  id: string,
  version: string
): InterviewProblem | undefined {
  return problemCatalog.find(
    (problem) => problem.id === id && problem.version === version
  );
}

export function getExpertReviewProblemById(id: string): InterviewProblem | undefined {
  return EXPERT_REVIEW_PROBLEMS.find((problem) => problem.id === id);
}

export function getExpertReviewMetadataById(id: string): ProblemCatalogMetadata | undefined {
  return EXPERT_REVIEW_METADATA.find((metadata) => metadata.id === id);
}

export function getProblemMetadataById(id: string): ProblemCatalogMetadata | undefined {
  return PROBLEM_METADATA.find((metadata) => metadata.id === id);
}

export function getProblemsByTopic(topic: string): readonly InterviewProblem[] {
  const normalized = topic.toLowerCase().trim();
  if (normalized.length === 0) return [];
  return problemCatalog.filter((problem) =>
    problem.interviewer.topics.some((candidate) => candidate.toLowerCase().includes(normalized))
  );
}

export function getProblemsByDifficulty(difficulty: string): readonly InterviewProblem[] {
  const normalized = difficulty.toLowerCase().trim();
  if (normalized.length === 0) return [];
  return problemCatalog.filter(
    (problem) => problem.interviewer.difficulty.toLowerCase() === normalized
  );
}

export function getProblemsByMode(mode: CuratedProblemMode): readonly InterviewProblem[] {
  const ids = new Set(
    PROBLEM_METADATA.filter((metadata) => metadata.mode === mode).map((metadata) => metadata.id)
  );
  return problemCatalog.filter((problem) => ids.has(problem.id));
}

export function getProblemsByCategory(category: string): readonly InterviewProblem[] {
  const normalized = category.toLowerCase().trim();
  if (normalized.length === 0) return [];
  const ids = new Set(
    PROBLEM_METADATA
      .filter((metadata) => metadata.category.toLowerCase() === normalized)
      .map((metadata) => metadata.id)
  );
  return problemCatalog.filter((problem) => ids.has(problem.id));
}

function assertReviewCatalogIsolated(
  approved: readonly InterviewProblem[],
  review: readonly InterviewProblem[]
): void {
  const approvedIds = new Set(approved.map((problem) => problem.id));
  for (const problem of review) {
    if (approvedIds.has(problem.id)) {
      throw new Error(
        `Expert-review problem "${problem.id}" must not appear in the default catalog`
      );
    }
  }
  assertUniqueDisclosureOwnership([...approved, ...review]);
}

function assertExpertReviewCatalogIntegrity(
  problems: readonly InterviewProblem[],
  metadata: readonly ProblemCatalogMetadata[]
): void {
  assertUniqueDisclosureOwnership(problems);
  const problemIds = new Set(problems.map((problem) => problem.id));
  const metadataIds = new Set<string>();

  if (problemIds.size !== problems.length) {
    throw new Error("Expert-review catalog contains duplicate problem IDs");
  }

  for (const item of metadata) {
    assertMetadataStructure(item);
    if (item.reviewStatus !== "expert-review") {
      throw new Error(`Expert-review metadata for "${item.id}" must be marked expert-review`);
    }
    if (item.reviewNotes === undefined || item.reviewNotes.trim().length === 0) {
      throw new Error(`Expert-review metadata for "${item.id}" must include review notes`);
    }
    if (!problemIds.has(item.id)) {
      throw new Error(`Expert-review metadata references unknown problem "${item.id}"`);
    }
    if (metadataIds.has(item.id)) {
      throw new Error(`Duplicate expert-review metadata ID "${item.id}"`);
    }
    metadataIds.add(item.id);
  }

  for (const problemId of problemIds) {
    if (!metadataIds.has(problemId)) {
      throw new Error(`Expert-review problem "${problemId}" is missing metadata`);
    }
  }
}

function assertUniqueDisclosureOwnership(
  problems: readonly InterviewProblem[]
): void {
  const disclosureOwners = new Map<string, string>();
  for (const problem of problems) {
    for (const disclosure of problem.interviewer.protectedDisclosures) {
      const existingOwner = disclosureOwners.get(disclosure.id);
      if (existingOwner !== undefined && existingOwner !== problem.id) {
        throw new Error(
          `Protected disclosure ID "${disclosure.id}" is shared by problems "${existingOwner}" and "${problem.id}"`
        );
      }
      disclosureOwners.set(disclosure.id, problem.id);
    }
  }
}

function assertMetadataStructure(item: ProblemCatalogMetadata): void {
  assertNonBlank(item.id, "Problem metadata id");
  assertNonBlank(item.title, `Problem metadata title for "${item.id}"`);
  assertNonBlank(item.category, `Problem metadata category for "${item.id}"`);
  const mode: unknown = item.mode;
  if (mode !== "OXFORD_MATHEMATICS" && mode !== "QUANT") {
    throw new Error(
      `Problem metadata for "${item.id}" has invalid mode "${String(mode)}"`
    );
  }

  const normalizedFollowUps = new Set<string>();
  for (const followUp of item.followUps) {
    assertNonBlank(followUp, `Follow-up for "${item.id}"`);
    const normalized = followUp
      .normalize("NFKC")
      .trim()
      .replace(/\s+/gu, " ")
      .toLowerCase();
    if (normalizedFollowUps.has(normalized)) {
      throw new Error(
        `Problem metadata for "${item.id}" contains duplicate follow-up "${followUp.trim()}"`
      );
    }
    normalizedFollowUps.add(normalized);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty after trimming`);
}

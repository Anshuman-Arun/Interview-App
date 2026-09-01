import {
  DisclosureIdSchema,
  type DisclosureLevel,
  type InterviewProblem
} from "../../domain/src/index.js";
import { reviewedDisclosureLevelFor } from "./curated-disclosure-levels.js";
import { assertInterviewProblemIntegrity } from "./problem-integrity.js";

export type CuratedProblemMode = "OXFORD_MATHEMATICS" | "QUANT";
export type CuratedHintLevel = 1 | 2 | 3 | 4 | 5;
export type CuratedReviewStatus = "ready" | "expert-review";

export interface CuratedHintSpec {
  /** Pedagogical sequence position only; never interpreted as disclosure severity. */
  readonly level: CuratedHintLevel;
  readonly text: string;
  readonly formulations: readonly string[];
}

export interface CuratedMilestoneSpec {
  readonly id: string;
  readonly description: string;
  readonly approachIds: readonly string[];
  readonly prerequisiteIds?: readonly string[];
  readonly hintLevels?: readonly CuratedHintLevel[];
}

export interface CuratedProblemSpec {
  readonly id: string;
  readonly title: string;
  readonly version?: string;
  readonly mode: CuratedProblemMode;
  readonly category: string;
  readonly topics: readonly string[];
  readonly difficulty: string;
  readonly prompt: string;
  readonly givenInformation: readonly string[];
  readonly approaches: readonly { readonly id: string; readonly label: string }[];
  readonly milestones: readonly CuratedMilestoneSpec[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly commonErrors: readonly { readonly id: string; readonly description: string }[];
  readonly followUps: readonly string[];
  readonly extensions: readonly { readonly id: string; readonly prompt: string }[];
  readonly hints: readonly CuratedHintSpec[];
  readonly canonicalSolution: string;
  readonly verificationNotes: string;
  readonly reviewStatus?: CuratedReviewStatus;
  readonly reviewNotes?: string;
}

export interface CuratedProblemMetadata {
  readonly id: string;
  readonly title: string;
  readonly mode: CuratedProblemMode;
  readonly category: string;
  readonly followUps: readonly string[];
  readonly reviewStatus: CuratedReviewStatus;
  readonly reviewNotes?: string;
}

export interface CuratedProblemEntry {
  readonly problem: InterviewProblem;
  readonly metadata: CuratedProblemMetadata;
}

const HINT_LEVELS: readonly CuratedHintLevel[] = [1, 2, 3, 4, 5];

export function authorCuratedProblem(spec: CuratedProblemSpec): CuratedProblemEntry {
  assertCanonicalIdentifier(spec.id, "Problem id");
  const title = canonicalMetadata(spec.title, `Problem "${spec.id}" title`);
  const category = canonicalMetadata(spec.category, `Problem "${spec.id}" category`);
  const followUps = canonicalUniqueMetadataList(
    spec.followUps,
    `Problem "${spec.id}" follow-up`
  );
  const topics = compileTopics(category, spec.topics);
  if (spec.mode !== "OXFORD_MATHEMATICS" && spec.mode !== "QUANT") {
    throw new Error(`Problem "${spec.id}" has invalid mode "${String(spec.mode)}"`);
  }
  if (
    spec.reviewStatus !== undefined
    && spec.reviewStatus !== "ready"
    && spec.reviewStatus !== "expert-review"
  ) {
    throw new Error(`Problem "${spec.id}" has invalid review status "${String(spec.reviewStatus)}"`);
  }
  if (spec.hints.length !== HINT_LEVELS.length) {
    throw new Error(`Problem "${spec.id}" must define exactly five hint stages`);
  }
  const reviewStatus = spec.reviewStatus ?? "ready";
  let reviewNotes: string | undefined;
  if (reviewStatus === "expert-review") {
    if (spec.reviewNotes === undefined) {
      throw new Error(`Problem "${spec.id}" marked expert-review must include review notes`);
    }
    reviewNotes = canonicalMetadata(
      spec.reviewNotes,
      `Problem "${spec.id}" expert-review notes`
    );
  } else if (spec.reviewNotes !== undefined) {
    throw new Error(
      `Problem "${spec.id}" cannot include review notes unless marked expert-review`
    );
  }

  const hintByLevel = new Map<CuratedHintLevel, CuratedHintSpec>();
  for (const hint of spec.hints) {
    if (!HINT_LEVELS.includes(hint.level)) {
      throw new Error(`Problem "${spec.id}" defines invalid hint stage ${String(hint.level)}`);
    }
    if (hintByLevel.has(hint.level)) {
      throw new Error(`Problem "${spec.id}" defines duplicate hint level ${hint.level}`);
    }
    hintByLevel.set(hint.level, hint);
  }
  for (const level of HINT_LEVELS) {
    if (!hintByLevel.has(level)) {
      throw new Error(`Problem "${spec.id}" must define hint level ${level}`);
    }
  }

  const disclosureIds = new Map(
    HINT_LEVELS.map((level) => [level, disclosureIdFor(spec.id, level)] as const)
  );
  const usedHintLevels = new Set<CuratedHintLevel>();

  const milestones = spec.milestones.map((milestone) => {
    const protectedDisclosureIds = (milestone.hintLevels ?? []).map((level) => {
      const id = disclosureIds.get(level);
      if (id === undefined) throw new Error(`Missing generated hint disclosure for level ${level}`);
      usedHintLevels.add(level);
      return id;
    });
    return {
      id: milestone.id,
      description: milestone.description,
      approachIds: [...milestone.approachIds],
      optionalPrerequisiteIds: [...(milestone.prerequisiteIds ?? [])],
      protectedDisclosureIds
    };
  });

  for (const level of HINT_LEVELS) {
    if (!usedHintLevels.has(level)) {
      throw new Error(`Problem "${spec.id}" defines hint level ${level} but no milestone references it`);
    }
  }

  const protectedDisclosures = HINT_LEVELS.map((stage) => {
    const hint = hintByLevel.get(stage);
    const id = disclosureIds.get(stage);
    if (hint === undefined || id === undefined) throw new Error(`Missing hint material for level ${stage}`);
    const minimumDisclosureLevel = reviewedDisclosureLevelFor(spec.id, stage) as DisclosureLevel;
    return {
      id,
      fact: hint.text,
      minimumDisclosureLevel,
      equivalentFormulations: [...hint.formulations]
    };
  });

  const problem: InterviewProblem = {
    id: spec.id,
    version: spec.version ?? "1.0.0",
    public: {
      prompt: spec.prompt,
      givenInformation: [...spec.givenInformation]
    },
    interviewer: {
      topics,
      difficulty: spec.difficulty,
      reasoningGraph: {
        version: spec.version ?? "1.0.0",
        approaches: spec.approaches.map((approach) => ({ ...approach })),
        milestones,
        edges: spec.edges.map((edge) => ({ ...edge })),
        commonErrors: spec.commonErrors.map((commonError) => ({ ...commonError })),
        extensions: spec.extensions.map((extension) => ({ ...extension }))
      },
      protectedDisclosures
    },
    private: {
      canonicalSolution: spec.canonicalSolution,
      verificationNotes: spec.verificationNotes
    }
  };

  assertInterviewProblemIntegrity(problem);
  const metadata: CuratedProblemMetadata = {
    id: spec.id,
    title,
    mode: spec.mode,
    category,
    followUps,
    reviewStatus,
    ...(reviewNotes === undefined ? {} : { reviewNotes })
  };

  return deepFreeze({
    problem,
    metadata
  });
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

function disclosureIdFor(problemId: string, level: CuratedHintLevel) {
  const safe = problemId.replace(/[^a-z0-9]+/giu, "_").replace(/^_+|_+$/gu, "");
  return DisclosureIdSchema.parse(`disclosure_${safe}_hint_${level}`);
}

function assertCanonicalIdentifier(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty after trimming`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not contain leading or trailing whitespace`);
  }
}

function canonicalMetadata(value: string, label: string): string {
  const canonical = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (canonical.length === 0) {
    throw new Error(`${label} must be non-empty after trimming`);
  }
  return canonical;
}

function canonicalUniqueMetadataList(
  values: readonly string[],
  label: string
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const canonical = canonicalMetadata(value, label);
    const key = canonical.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${label} list contains duplicate entry "${canonical}"`);
    }
    seen.add(key);
    result.push(canonical);
  }
  return result;
}

function compileTopics(category: string, topics: readonly string[]): readonly string[] {
  const canonicalTopics = canonicalUniqueMetadataList(topics, "Curated problem topic");
  const result = [category];
  const seen = new Set([category.toLowerCase()]);
  for (const topic of canonicalTopics) {
    const key = topic.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Curated problem topic list contains duplicate entry "${topic}"`);
    }
    seen.add(key);
    result.push(topic);
  }
  return result;
}

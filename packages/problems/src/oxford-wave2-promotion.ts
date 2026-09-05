import type {
  CuratedProblemEntry,
  CuratedProblemMetadata
} from "./curated-authoring.js";
import {
  assertOxfordAdaptiveMetadataIntegrity,
  isOxfordRecommendationReady,
  type OxfordAdaptiveMetadata
} from "./oxford-adaptive-taxonomy.js";

export const OXFORD_WAVE2_CERTIFIED_AUTHOR_HEADS = Object.freeze({
  cantor: "8b22dc5df99111fb95e27a2c006d5e74544dd385",
  dirichlet: "44b13bab28e315d3c76a177904bec47c884ef470",
  euler: "8846c612825d2b8ae53a81f6f8861fd851f452c6"
} as const);

export const OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS = Object.freeze([
  "oxford-cantor-moving-v-envelope",
  "oxford-cantor-reciprocal-root-parabolas",
  "oxford-cantor-cubic-two-thresholds",
  "oxford-cantor-cubic-divided-difference",
  "oxford-cantor-integral-sign-landscape",
  "oxford-cantor-reciprocal-paired-inputs",
  "oxford-cantor-exponential-rotating-line",
  "oxford-cantor-mobius-recurrence",
  "oxford-cantor-squared-error-recurrence",
  "oxford-cantor-absolute-quadratic-crossings",
  "oxford-cantor-radical-asymptote",
  "oxford-cantor-shifted-cubic-intersections",
  "oxford-cantor-moving-integral-window",
  "oxford-cantor-three-cycle-map",
  "oxford-cantor-quartic-horizontal-levels",
  "oxford-cantor-reciprocal-increment-recurrence",
  "oxford-cantor-mobius-involution",
  "oxford-d-gcd-descent-network",
  "oxford-d-thirds-closed-integers",
  "oxford-d-balancing-transfers",
  "oxford-d-cube-twist-equivalence",
  "oxford-d-sliding-window-parity",
  "oxford-d-weighted-cycle-readings",
  "oxford-d-midpoint-closed-residues",
  "oxford-d-odd-symmetric-difference",
  "oxford-d-three-reversal-permutations",
  "oxford-d-divisor-step-geometry",
  "oxford-d-triple-flip-circle",
  "oxford-euler-box-diagonal-bisector",
  "oxford-euler-circle-sweep",
  "oxford-euler-cooling-data-model",
  "oxford-euler-corner-balanced-tables",
  "oxford-euler-diagonal-blend-transform",
  "oxford-euler-kiosk-grid-model",
  "oxford-euler-periodic-queue-model",
  "oxford-euler-quadrilateral-balance",
  "oxford-euler-random-chord-midpoint",
  "oxford-euler-random-halving-interval",
  "oxford-euler-self-averaging-sets",
  "oxford-euler-tank-gauge-model",
  "oxford-euler-triangle-midpoint-cycle"
] as const);

const CERTIFIED_IDS = new Set<string>(OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS);

const FINAL_REVIEW: OxfordAdaptiveMetadata["review"] = Object.freeze({
  taxonomyClassification: "approved",
  originality: "approved",
  fidelity: "approved",
  mathematicalCorrectness: "approved",
  difficultyCalibration: "expert-estimate",
  timingCalibration: "expert-estimate"
});

export function promoteCertifiedWave2OxfordEntries(
  entries: readonly CuratedProblemEntry[]
): readonly CuratedProblemEntry[] {
  const ids = entries.map((entry) => entry.problem.id);
  if (ids.length !== OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS.length) {
    throw new Error(
      `Wave 2 promotion expected ${String(OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS.length)} families, received ${String(ids.length)}`
    );
  }

  const inputIds = new Set(ids);
  if (inputIds.size !== ids.length) {
    throw new Error("Wave 2 promotion input contains duplicate problem IDs");
  }

  for (const id of OXFORD_WAVE2_CERTIFIED_PROBLEM_IDS) {
    if (!inputIds.has(id)) {
      throw new Error(`Wave 2 promotion is missing certified family "${id}"`);
    }
  }
  for (const id of inputIds) {
    if (!CERTIFIED_IDS.has(id)) {
      throw new Error(`Wave 2 promotion contains uncertified family "${id}"`);
    }
  }

  return deepFreeze(entries.map(promoteCertifiedWave2OxfordEntry));
}

export function promoteCertifiedWave2OxfordEntry(
  entry: CuratedProblemEntry
): CuratedProblemEntry {
  const id = entry.problem.id;
  if (!CERTIFIED_IDS.has(id)) {
    throw new Error(`Problem "${id}" is not in the final Wave 2 certification set`);
  }
  if (entry.metadata.id !== id) {
    throw new Error(`Wave 2 problem/metadata identity mismatch for "${id}"`);
  }
  if (entry.metadata.mode !== "OXFORD_MATHEMATICS") {
    throw new Error(`Wave 2 certified family "${id}" must be Oxford Mathematics`);
  }
  if (entry.metadata.reviewStatus !== "expert-review") {
    throw new Error(
      `Wave 2 certified family "${id}" must enter promotion from expert review`
    );
  }

  const adaptive = entry.metadata.oxfordAdaptive;
  if (adaptive === undefined || adaptive.status !== "authored") {
    throw new Error(`Wave 2 certified family "${id}" lacks authored adaptive metadata`);
  }
  if (adaptive.familyId !== id) {
    throw new Error(`Wave 2 certified family "${id}" has mismatched familyId`);
  }

  const promotedAdaptive: OxfordAdaptiveMetadata = {
    ...adaptive,
    review: FINAL_REVIEW
  };
  assertOxfordAdaptiveMetadataIntegrity(promotedAdaptive, entry.problem);
  if (!isOxfordRecommendationReady(promotedAdaptive)) {
    throw new Error(`Wave 2 certified family "${id}" failed recommendation readiness`);
  }

  const {
    reviewNotes: _discardedReviewNotes,
    ...metadataWithoutReviewNotes
  } = entry.metadata;
  const promotedMetadata: CuratedProblemMetadata = {
    ...metadataWithoutReviewNotes,
    reviewStatus: "ready",
    oxfordAdaptive: promotedAdaptive
  };

  return deepFreeze({
    problem: entry.problem,
    metadata: promotedMetadata
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

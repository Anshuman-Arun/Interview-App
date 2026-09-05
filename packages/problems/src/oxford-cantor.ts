import { cantorFunctionEntriesA, cantorFunctionFamiliesA } from "./curated/oxford-cantor-functions-a.js";
import { cantorFunctionEntriesB, cantorFunctionFamiliesB } from "./curated/oxford-cantor-functions-b.js";
import { cantorGraphEntriesA, cantorGraphFamiliesA } from "./curated/oxford-cantor-graphs-a.js";
import { cantorGraphEntriesB, cantorGraphFamiliesB } from "./curated/oxford-cantor-graphs-b.js";

export const oxfordCantorFamilies = Object.freeze([
  ...cantorGraphFamiliesA,
  ...cantorFunctionFamiliesA,
  ...cantorGraphFamiliesB,
  ...cantorFunctionFamiliesB
] as const);

export const oxfordCantorReviewEntries = Object.freeze([
  ...cantorGraphEntriesA,
  ...cantorFunctionEntriesA,
  ...cantorGraphEntriesB,
  ...cantorFunctionEntriesB
] as const);

if (oxfordCantorFamilies.length !== 17 || oxfordCantorReviewEntries.length !== 17) {
  throw new Error("Agent C — Cantor Wave 2 completion portfolio must contain exactly 17 surviving candidate families");
}

for (const entry of oxfordCantorReviewEntries) {
  if (entry.metadata.reviewStatus !== "expert-review") {
    throw new Error(`Cantor candidate "${entry.problem.id}" must remain in expert review`);
  }
  const adaptive = entry.metadata.oxfordAdaptive;
  if (adaptive?.status !== "authored") {
    throw new Error(`Cantor candidate "${entry.problem.id}" must carry authored Oxford adaptive metadata`);
  }
  if (
    adaptive.review.originality !== "unreviewed"
    || adaptive.review.fidelity !== "unreviewed"
    || adaptive.review.mathematicalCorrectness !== "unreviewed"
    || adaptive.review.taxonomyClassification !== "unreviewed"
    || adaptive.review.difficultyCalibration !== "unreviewed"
    || adaptive.review.timingCalibration !== "unreviewed"
  ) {
    throw new Error(`Cantor candidate "${entry.problem.id}" must not self-approve independent reviews`);
  }
}

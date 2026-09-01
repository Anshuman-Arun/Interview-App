import { oxfordDominoChessboardEntry } from "./curated/oxford-domino-chessboard.js";
import { oxfordDivisorsSquareParityEntry } from "./curated/oxford-divisors-square-parity.js";
import { oxfordEuclidPrimesEntry } from "./curated/oxford-euclid-primes.js";
import { oxfordNestedRadicalSequenceEntry } from "./curated/oxford-nested-radical-sequence.js";
import { oxfordMonotoneCauchyEntry } from "./curated/oxford-monotone-cauchy.js";
import { oxfordEvenOddDegreesEntry } from "./curated/oxford-even-odd-degrees.js";
import { oxfordCatalanPathsEntry } from "./curated/oxford-catalan-paths.js";
import { oxfordDivisibilityChainEntry } from "./curated/oxford-divisibility-chain.js";
import { oxfordContinuousFixedPointEntry } from "./curated/oxford-continuous-fixed-point.js";
import { oxfordPrefixSumsModNEntry } from "./curated/oxford-prefix-sums-mod-n.js";
import { oxfordTriangleMediansEntry } from "./curated/oxford-triangle-medians.js";

export const oxfordCuratedReviewEntries = Object.freeze([
  oxfordCatalanPathsEntry
] as const);

export const oxfordCuratedEntries = Object.freeze([
  oxfordDominoChessboardEntry,
  oxfordDivisorsSquareParityEntry,
  oxfordEuclidPrimesEntry,
  oxfordNestedRadicalSequenceEntry,
  oxfordMonotoneCauchyEntry,
  oxfordEvenOddDegreesEntry,
  oxfordDivisibilityChainEntry,
  oxfordContinuousFixedPointEntry,
  oxfordPrefixSumsModNEntry,
  oxfordTriangleMediansEntry
] as const);

export const oxfordCuratedProblems = Object.freeze(
  oxfordCuratedEntries.map((entry) => entry.problem)
);
export const oxfordCuratedMetadata = Object.freeze(
  oxfordCuratedEntries.map((entry) => entry.metadata)
);

export type CuratedDisclosureStage = 1 | 2 | 3 | 4 | 5;
export type SemanticDisclosureLevel = 0 | 1 | 2 | 3 | 4 | 5;

type ReviewedLevels = Readonly<Record<CuratedDisclosureStage, SemanticDisclosureLevel>>;

/**
 * Manual semantic disclosure review for every curated protected disclosure.
 *
 * These values are intentionally independent of pedagogical hint order. A later
 * hint can have the same or even lower semantic severity than an earlier hint;
 * the authoring compiler must never infer severity from array position/stage.
 */
function reviewedLevels(levels: ReviewedLevels): ReviewedLevels {
  return Object.freeze({ ...levels });
}

export const CURATED_DISCLOSURE_LEVELS: Readonly<Record<string, ReviewedLevels>> = Object.freeze(
  Object.fromEntries(
    Object.entries(Object.freeze({
  "oxford-catalan-paths": reviewedLevels({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "oxford-continuous-fixed-point": reviewedLevels({ 1: 1, 2: 4, 3: 3, 4: 5, 5: 5 }),
  "oxford-divisibility-chain": reviewedLevels({ 1: 3, 2: 4, 3: 4, 4: 5, 5: 5 }),
  "oxford-divisors-square-parity": reviewedLevels({ 1: 1, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "oxford-domino-chessboard": reviewedLevels({ 1: 1, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "oxford-euclid-primes": reviewedLevels({ 1: 1, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "oxford-even-odd-degrees": reviewedLevels({ 1: 2, 2: 4, 3: 4, 4: 5, 5: 5 }),
  "oxford-monotone-cauchy": reviewedLevels({ 1: 2, 2: 4, 3: 4, 4: 5, 5: 5 }),
  "oxford-nested-radical-sequence": reviewedLevels({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "oxford-prefix-sums-mod-n": reviewedLevels({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "oxford-triangle-medians": reviewedLevels({ 1: 2, 2: 4, 3: 4, 4: 5, 5: 5 }),
  "quant-birthday-collision": reviewedLevels({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "quant-hidden-coin-bayes": reviewedLevels({ 1: 2, 2: 4, 3: 5, 4: 5, 5: 5 }),
  "quant-kelly-bet": reviewedLevels({ 1: 4, 2: 4, 3: 4, 4: 5, 5: 5 }),
  "quant-matching-pennies": reviewedLevels({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "quant-monty-hall": reviewedLevels({ 1: 2, 2: 4, 3: 4, 4: 5, 5: 5 }),
  "quant-poisson-arrival-conditioning": reviewedLevels({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "quant-random-walk-drawdown": reviewedLevels({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }),
  "quant-three-cards-bayes": reviewedLevels({ 1: 2, 2: 5, 3: 4, 4: 5, 5: 5 }),
  "quant-uniform-endpoint-estimation": reviewedLevels({ 1: 4, 2: 5, 3: 5, 4: 5, 5: 5 }),
  "quant-waiting-time-hh": reviewedLevels({ 1: 2, 2: 4, 3: 4, 4: 5, 5: 5 })
})).map(([problemId, levels]) => [
      problemId,
      Object.freeze({ ...levels })
    ])
  )
);

export function reviewedDisclosureLevelFor(
  problemId: string,
  stage: CuratedDisclosureStage
): SemanticDisclosureLevel {
  const levels = CURATED_DISCLOSURE_LEVELS[problemId];
  if (levels === undefined) {
    throw new Error(`Problem "${problemId}" has no manual semantic disclosure review`);
  }
  const level = (levels as Partial<ReviewedLevels>)[stage];
  if (level === undefined) {
    throw new Error(`Problem "${problemId}" has no semantic classification for hint stage ${String(stage)}`);
  }
  return level;
}

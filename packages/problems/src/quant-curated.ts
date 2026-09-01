import { quantMontyHallEntry } from "./curated/quant-monty-hall.js";
import { quantHiddenCoinBayesEntry } from "./curated/quant-hidden-coin-bayes.js";
import { quantWaitingTimeHhEntry } from "./curated/quant-waiting-time-hh.js";
import { quantPoissonArrivalConditioningEntry } from "./curated/quant-poisson-arrival-conditioning.js";
import { quantUniformEndpointEstimationEntry } from "./curated/quant-uniform-endpoint-estimation.js";
import { quantMatchingPenniesEntry } from "./curated/quant-matching-pennies.js";
import { quantKellyBetEntry } from "./curated/quant-kelly-bet.js";
import { quantBirthdayCollisionEntry } from "./curated/quant-birthday-collision.js";
import { quantThreeCardsBayesEntry } from "./curated/quant-three-cards-bayes.js";
import { quantRandomWalkDrawdownEntry } from "./curated/quant-random-walk-drawdown.js";

export const quantCuratedReviewEntries = Object.freeze([
  quantRandomWalkDrawdownEntry
] as const);

export const quantCuratedEntries = Object.freeze([
  quantMontyHallEntry,
  quantHiddenCoinBayesEntry,
  quantWaitingTimeHhEntry,
  quantPoissonArrivalConditioningEntry,
  quantUniformEndpointEstimationEntry,
  quantMatchingPenniesEntry,
  quantKellyBetEntry,
  quantBirthdayCollisionEntry,
  quantThreeCardsBayesEntry
] as const);

export const quantCuratedProblems = Object.freeze(
  quantCuratedEntries.map((entry) => entry.problem)
);
export const quantCuratedMetadata = Object.freeze(
  quantCuratedEntries.map((entry) => entry.metadata)
);

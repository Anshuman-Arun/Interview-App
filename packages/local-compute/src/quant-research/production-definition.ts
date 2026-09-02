import {
  QUANT_RESEARCH_GENERATOR_VERSION,
  QUANT_RESEARCH_RNG_VERSION,
  QUANT_RESEARCH_VERSION,
  parseQuantResearchDefinition,
  type QuantResearchFamily,
  type QuantResearchScenarioDefinition
} from "./types.js";
import { QuantResearchEngine, QuantResearchError } from "./engine.js";

function definitionForSeed(
  family: QuantResearchFamily,
  seed: number
): QuantResearchScenarioDefinition {
  const common = {
    family,
    version: QUANT_RESEARCH_VERSION,
    generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
    rngVersion: QUANT_RESEARCH_RNG_VERSION,
    seed
  } as const;

  switch (family) {
    case "BAYESIAN_UPDATING":
      return parseQuantResearchDefinition({
        ...common,
        family,
        config: {
          priorAlpha: 2,
          priorBeta: 3,
          observationCount: 8,
          perturbedPriorAlpha: 5,
          perturbedPriorBeta: 2
        }
      });
    case "SAMPLING_ESTIMATION":
      return parseQuantResearchDefinition({
        ...common,
        family,
        config: {
          maxSamples: 10,
          populationSize: 32,
          centerMin: -20,
          centerMax: 20,
          noiseRadius: 4,
          outlierShift: 25
        }
      });
    case "EXPERIMENTAL_ALLOCATION":
      return parseQuantResearchDefinition({
        ...common,
        family,
        config: {
          totalBudget: 20,
          costA: 2,
          costB: 4,
          perturbedCostA: 5,
          perturbedCostB: 2,
          noiseA: 2,
          noiseB: 5
        }
      });
    case "MODEL_COMPARISON":
      return parseQuantResearchDefinition({
        ...common,
        family,
        config: {
          observationCount: 10,
          noiseRadius: 2,
          outlierShift: 30
        }
      });
    case "CONSTRAINED_OPTIMIZATION":
      return parseQuantResearchDefinition({
        ...common,
        family,
        config: {
          budget: 30,
          perturbedBudget: 24,
          maxX: 15,
          maxY: 10,
          perturbedPenalty: 5
        }
      });
  }
}


const MAX_PRODUCTION_SEED_PROBES = 1_024;

export function createProductionQuantResearchDefinition(
  family: QuantResearchFamily,
  initialSeed: number
): QuantResearchScenarioDefinition {
  if (!Number.isSafeInteger(initialSeed) || initialSeed < 0 || initialSeed > 0xffff_ffff) {
    throw new RangeError("Quant Research production seed must be a uint32");
  }

  for (let offset = 0; offset < MAX_PRODUCTION_SEED_PROBES; offset += 1) {
    const candidateSeed = (initialSeed + offset) >>> 0;
    const definition = definitionForSeed(family, candidateSeed);
    try {
      // Production definitions are admitted only if their generated deterministic
      // variant passes the engine's semantic non-degeneracy checks.
      new QuantResearchEngine(definition);
      return definition;
    } catch (error) {
      if (!(error instanceof QuantResearchError) || error.code !== "INVALID_DEFINITION") {
        throw error;
      }
    }
  }

  throw new QuantResearchError(
    "INVALID_DEFINITION",
    "No runnable deterministic production scenario was found in the bounded seed probe"
  );
}

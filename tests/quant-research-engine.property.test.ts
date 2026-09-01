import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  QUANT_RESEARCH_RNG_VERSION,
  QUANT_RESEARCH_VERSION,
  QuantResearchEngine,
  replayQuantResearch,
  type QuantResearchScenarioDefinition
} from "../packages/local-compute/src/index.js";

const modelDefinition = (seed: number): QuantResearchScenarioDefinition => ({
  family: "MODEL_COMPARISON",
  version: QUANT_RESEARCH_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed,
  config: { observationCount: 12, noiseRadius: 3, outlierShift: 20 }
});

const samplingDefinition = (seed: number): QuantResearchScenarioDefinition => ({
  family: "SAMPLING_ESTIMATION",
  version: QUANT_RESEARCH_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed,
  config: { maxSamples: 12, populationSize: 48, centerMin: -50, centerMax: 50, noiseRadius: 6, outlierShift: 30 }
});

const experimentalDefinition = (seed: number): QuantResearchScenarioDefinition => ({
  family: "EXPERIMENTAL_ALLOCATION",
  version: QUANT_RESEARCH_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed,
  config: { totalBudget: 20, costA: 2, costB: 4, perturbedCostA: 5, perturbedCostB: 2, noiseA: 2, noiseB: 5 }
});

const optimizationDefinition = (seed: number): QuantResearchScenarioDefinition => ({
  family: "CONSTRAINED_OPTIMIZATION",
  version: QUANT_RESEARCH_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed,
  config: { budget: 30, perturbedBudget: 24, maxX: 15, maxY: 10, perturbedPenalty: 5 }
});

describe("Quant Research property invariants", () => {
  it("same seed always yields identical model observations and perturbations", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), (seed) => {
      const left = new QuantResearchEngine(modelDefinition(seed));
      const right = new QuantResearchEngine(modelDefinition(seed));
      expect(left.getState()).toEqual(right.getState());
      left.applyAction({ actionId: "m1", kind: "CHOOSE_OPTION", option: "LINEAR" });
      right.applyAction({ actionId: "m1", kind: "CHOOSE_OPTION", option: "LINEAR" });
      expect(left.getState()).toEqual(right.getState());
    }), { numRuns: 100 });
  });

  it("inspection count cannot change a future sampling trajectory", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.integer({ min: 0, max: 20 }),
      (seed, inspections) => {
        const left = new QuantResearchEngine(samplingDefinition(seed));
        const right = new QuantResearchEngine(samplingDefinition(seed));
        for (let index = 0; index < inspections; index += 1) {
          left.getState();
          left.getResult();
          left.getDiagnostics();
        }
        left.applyAction({ actionId: "s1", kind: "REQUEST_OBSERVATION", count: 5 });
        right.applyAction({ actionId: "s1", kind: "REQUEST_OBSERVATION", count: 5 });
        expect(left.getState()).toEqual(right.getState());
      }
    ), { numRuns: 100 });
  });

  it("replay equality holds across arbitrary safe model choices", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.constantFrom("CONSTANT" as const, "LINEAR" as const),
      fc.constantFrom("CONSTANT" as const, "LINEAR" as const),
      (seed, first, second) => {
        const definition = modelDefinition(seed);
        const engine = new QuantResearchEngine(definition);
        engine.applyAction({ actionId: "a1", kind: "CHOOSE_OPTION", option: first });
        engine.applyAction({ actionId: "a2", kind: "CHOOSE_OPTION", option: second });
        const replayed = replayQuantResearch(definition, engine.getAcceptedActions());
        expect(replayed.state).toEqual(engine.getState());
        expect(replayed.result).toEqual(engine.getResult());
      }
    ), { numRuns: 100 });
  });

  it("accepted sampling transitions never produce a negative sample count or unbounded score", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.integer({ min: 2, max: 12 }),
      fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
      (seed, count, estimate) => {
        const engine = new QuantResearchEngine(samplingDefinition(seed));
        engine.applyAction({ actionId: "q1", kind: "REQUEST_OBSERVATION", count });
        engine.applyAction({ actionId: "q2", kind: "SUBMIT_NUMERIC_ESTIMATE", value: estimate });
        engine.applyAction({ actionId: "q3", kind: "SUBMIT_NUMERIC_ESTIMATE", value: estimate });
        const state = engine.getState();
        const result = engine.getResult();
        expect(state.acceptedActionCount).toBe(3);
        expect(result.evidence.every((item) => item.score >= 0 && item.score <= 100)).toBe(true);
        const observations = state.visibleData.find((item) => item.key === "observations")?.value as readonly number[];
        expect(observations.length).toBeGreaterThanOrEqual(count);
        expect(observations.length).toBeLessThanOrEqual(13);
      }
    ), { numRuns: 100 });
  });

  it("never exposes intermediate scoring through public state or result", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.constantFrom("CONSTANT" as const, "LINEAR" as const),
      (seed, choice) => {
        const engine = new QuantResearchEngine(modelDefinition(seed));
        engine.applyAction({ actionId: "live", kind: "CHOOSE_OPTION", option: choice });
        expect("evidence" in engine.getState()).toBe(false);
        expect(engine.getResult().evidence).toEqual([]);
        expect(engine.getResult().metrics).toEqual({});
        expect(engine.getResult().overallScore).toBe(0);
      }
    ), { numRuns: 100 });
  });

  it("sampling replay remains exact across arbitrary bounded requests and estimates", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.integer({ min: 2, max: 12 }),
      fc.double({ min: -1_000, max: 1_000, noNaN: true, noDefaultInfinity: true }),
      (seed, count, estimate) => {
        const definition = samplingDefinition(seed);
        const engine = new QuantResearchEngine(definition);
        engine.applyAction({ actionId: "sample", kind: "REQUEST_OBSERVATION", count });
        engine.applyAction({ actionId: "estimate", kind: "SUBMIT_NUMERIC_ESTIMATE", value: estimate });
        engine.applyAction({ actionId: "revised", kind: "SUBMIT_NUMERIC_ESTIMATE", value: estimate });
        const replayed = replayQuantResearch(definition, engine.getAcceptedActions());
        expect(replayed.state).toEqual(engine.getState());
        expect(replayed.result).toEqual(engine.getResult());
      }
    ), { numRuns: 100 });
  });


  it("experimental summaries cannot contradict the application-owned latent ordering", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), (seed) => {
      const engine = new QuantResearchEngine(experimentalDefinition(seed));
      engine.applyAction({ actionId: "e1", kind: "ALLOCATE_SAMPLE", a: 1, b: 1 });
      const state = engine.getState();
      const meanA = state.visibleData.find((item) => item.key === "sampleMeanA")?.value as number;
      const meanB = state.visibleData.find((item) => item.key === "sampleMeanB")?.value as number;
      const inferred = meanA > meanB ? "A" : "B";
      engine.applyAction({ actionId: "e2", kind: "CHOOSE_OPTION", option: inferred });
      engine.applyAction({ actionId: "e3", kind: "ALLOCATE_SAMPLE", a: 2, b: 5 });
      expect(engine.getResult().metrics.NUMERICAL_CORRECTNESS).toBe(100);
    }), { numRuns: 100 });
  });

  it("optimization replay remains exact for every seed that passes generated-variant validation", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      (seed) => {
        let engine: QuantResearchEngine;
        try {
          engine = new QuantResearchEngine(optimizationDefinition(seed));
        } catch {
          return;
        }
        engine.applyAction({ actionId: "o1", kind: "SUBMIT_PARAMETERS", values: [0, 0] });
        engine.applyAction({ actionId: "o2", kind: "SUBMIT_PARAMETERS", values: [0, 0] });
        const replayed = replayQuantResearch(optimizationDefinition(seed), engine.getAcceptedActions());
        expect(replayed.state).toEqual(engine.getState());
        expect(replayed.result).toEqual(engine.getResult());
      }
    ), { numRuns: 100 });
  });

  it("generated model families are identifiable from the disclosed noise/slope assumptions", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), (seed) => {
      const definition = modelDefinition(seed);
      const probe = new QuantResearchEngine(definition);
      const state = probe.getState();
      const y = state.visibleData.find((item) => item.key === "y")?.value as readonly number[];
      const noiseRadius = state.visibleData.find((item) => item.key === "noiseRadius")?.value as number;
      const first = y[0];
      const last = y[y.length - 1];
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      if (first === undefined || last === undefined) return;
      const inferred = Math.abs(last - first) > 2 * noiseRadius ? "LINEAR" : "CONSTANT";

      probe.applyAction({ actionId: "model-1", kind: "CHOOSE_OPTION", option: inferred });
      const perturbed = probe.getState();
      expect(perturbed.visibleData.find((item) => item.key === "baselineY")?.value).toEqual(y);
      probe.applyAction({ actionId: "model-2", kind: "CHOOSE_OPTION", option: inferred });
      expect(probe.getResult().metrics.NUMERICAL_CORRECTNESS).toBe(100);
      expect(probe.getResult().metrics.ROBUSTNESS).toBe(100);
    }), { numRuns: 100 });
  });

});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  QUANT_RESEARCH_VERSION,
  QuantResearchEngine,
  replayQuantResearch,
  type QuantResearchScenarioDefinition
} from "../packages/local-compute/src/index.js";

const modelDefinition = (seed: number): QuantResearchScenarioDefinition => ({
  family: "MODEL_COMPARISON",
  version: QUANT_RESEARCH_VERSION,
  seed,
  config: { observationCount: 12, noiseRadius: 3, outlierShift: 20 }
});

const samplingDefinition = (seed: number): QuantResearchScenarioDefinition => ({
  family: "SAMPLING_ESTIMATION",
  version: QUANT_RESEARCH_VERSION,
  seed,
  config: { maxSamples: 12, populationSize: 48, centerMin: -50, centerMax: 50, noiseRadius: 6, outlierShift: 30 }
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
        expect(state.acceptedActionCount).toBe(3);
        expect(state.evidence.every((item) => item.score >= 0 && item.score <= 100)).toBe(true);
        const observations = state.visibleData.find((item) => item.key === "observations")?.value as readonly number[];
        expect(observations.length).toBeGreaterThanOrEqual(count);
        expect(observations.length).toBeLessThanOrEqual(13);
      }
    ), { numRuns: 100 });
  });
});

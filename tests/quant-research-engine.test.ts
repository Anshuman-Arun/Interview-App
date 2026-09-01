import { describe, expect, it } from "vitest";
import { DeterministicRng } from "../packages/local-compute/src/quant-research/deterministic-rng.js";
import {
  QUANT_RESEARCH_FAMILIES,
  QUANT_RESEARCH_GENERATOR_VERSION,
  QUANT_RESEARCH_RNG_VERSION,
  QUANT_RESEARCH_VERSION,
  QuantResearchEngine,
  QuantResearchError,
  assertUniqueQuantResearchRegistrations,
  getQuantResearchRegistry,
  parseQuantResearchAction,
  parseQuantResearchDefinition,
  replayQuantResearch,
  type QuantResearchScenarioDefinition
} from "../packages/local-compute/src/index.js";

const bayesian: QuantResearchScenarioDefinition = {
  family: "BAYESIAN_UPDATING",
  version: QUANT_RESEARCH_VERSION,
  generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed: 17,
  config: { priorAlpha: 2, priorBeta: 3, observationCount: 8, perturbedPriorAlpha: 5, perturbedPriorBeta: 2 }
};

const sampling: QuantResearchScenarioDefinition = {
  family: "SAMPLING_ESTIMATION",
  version: QUANT_RESEARCH_VERSION,
  generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed: 91,
  config: { maxSamples: 10, populationSize: 32, centerMin: -20, centerMax: 20, noiseRadius: 4, outlierShift: 25 }
};

const experimental: QuantResearchScenarioDefinition = {
  family: "EXPERIMENTAL_ALLOCATION",
  version: QUANT_RESEARCH_VERSION,
  generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed: 808,
  config: { totalBudget: 20, costA: 2, costB: 4, perturbedCostA: 5, perturbedCostB: 2, noiseA: 2, noiseB: 5 }
};

const model: QuantResearchScenarioDefinition = {
  family: "MODEL_COMPARISON",
  version: QUANT_RESEARCH_VERSION,
  generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed: 1234,
  config: { observationCount: 10, noiseRadius: 2, outlierShift: 30 }
};

const optimization: QuantResearchScenarioDefinition = {
  family: "CONSTRAINED_OPTIMIZATION",
  version: QUANT_RESEARCH_VERSION,
  generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION,
  seed: 42,
  config: { budget: 30, perturbedBudget: 24, maxX: 15, maxY: 10, perturbedPenalty: 5 }
};

function expectCode(fn: () => unknown, code: QuantResearchError["code"]): void {
  try {
    fn();
    throw new Error("Expected QuantResearchError");
  } catch (error) {
    expect(error).toBeInstanceOf(QuantResearchError);
    expect((error as QuantResearchError).code).toBe(code);
  }
}

function visibleNumber(state: ReturnType<QuantResearchEngine["getState"]>, key: string): number {
  const item = state.visibleData.find((entry) => entry.key === key);
  expect(item).toBeDefined();
  expect(typeof item?.value).toBe("number");
  return item?.value as number;
}

describe("deterministic Quant Research interview engine", () => {
  it("shuffles undefined-valued elements according to deterministic Fisher-Yates draws", () => {
    const rng = new DeterministicRng(0, "test");
    expect(rng.shuffle([undefined, 1, 2])).toEqual([1, 2, undefined]);
  });

  it("registers exactly the five supported compatibility tuples", () => {
    expect(getQuantResearchRegistry()).toHaveLength(5);
    expect(new Set(getQuantResearchRegistry().map((item) => item.family)).size).toBe(5);
    for (const item of getQuantResearchRegistry()) {
      expect(item.version).toBe(QUANT_RESEARCH_VERSION);
      expect(item.generatorVersion).toBe(QUANT_RESEARCH_GENERATOR_VERSION);
      expect(item.rngVersion).toBe(QUANT_RESEARCH_RNG_VERSION);
    }
  });

  it("keeps the exported family whitelist immutable at runtime", () => {
    expect(Object.isFrozen(QUANT_RESEARCH_FAMILIES)).toBe(true);
    expect(() => (QUANT_RESEARCH_FAMILIES as unknown as string[]).push("MUTATED")).toThrow();
    expect(QUANT_RESEARCH_FAMILIES).toEqual([
      "BAYESIAN_UPDATING",
      "SAMPLING_ESTIMATION",
      "EXPERIMENTAL_ALLOCATION",
      "MODEL_COMPARISON",
      "CONSTRAINED_OPTIMIZATION"
    ]);
  });

  it("rejects duplicate compatibility registrations but permits multiple historical versions", () => {
    const current = {
      family: "BAYESIAN_UPDATING",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION
    } as const;
    expect(() => assertUniqueQuantResearchRegistrations([current, current])).toThrow(/Duplicate/);

    expect(() => assertUniqueQuantResearchRegistrations([
      current,
      { ...current, version: "0.9.0" },
      { ...current, version: "0.8.0" },
      { ...current, version: "0.7.0" },
      { ...current, generatorVersion: "quant-research-generator-v0" },
      { ...current, rngVersion: "xorshift32-rejection-v0" }
    ])).not.toThrow();
  });

  it.each([
    { ...bayesian, generatorVersion: "wrong-generator-version" },
    { ...bayesian, rngVersion: "wrong-rng-version" },
    { ...bayesian, seed: Number.MAX_SAFE_INTEGER + 1 },
    { ...bayesian, seed: -1 },
    { ...bayesian, config: { ...bayesian.config, observationCount: 0 } },
    { ...bayesian, config: { ...bayesian.config, perturbedPriorAlpha: bayesian.config.priorAlpha, perturbedPriorBeta: bayesian.config.priorBeta } },
    { ...sampling, config: { ...sampling.config, maxSamples: 33 } },
    { ...sampling, config: { ...sampling.config, maxSamples: 2 } },
    { ...sampling, config: { ...sampling.config, outlierShift: sampling.config.noiseRadius } },
    { ...sampling, config: { ...sampling.config, centerMin: 5, centerMax: 5, noiseRadius: 0 } },
    { ...experimental, config: { ...experimental.config, totalBudget: 5, costA: 2, costB: 3, perturbedCostA: 1, perturbedCostB: 1 } },
    { ...experimental, config: { ...experimental.config, totalBudget: 8, costA: 1, costB: 2, perturbedCostA: 3, perturbedCostB: 5 } },
    { ...experimental, config: { ...experimental.config, totalBudget: 10, costA: 4, costB: 4, perturbedCostA: 11, perturbedCostB: 12 } },
    { ...experimental, config: { ...experimental.config, perturbedCostA: experimental.config.costA, perturbedCostB: experimental.config.costB } },
    { ...model, config: { ...model.config, noiseRadius: 0 } },
    { ...model, config: { ...model.config, outlierShift: 2 * model.config.noiseRadius } },
    { ...model, config: { ...model.config, extra: true } },
    { ...optimization, extra: true }
  ] as const)("rejects malformed or degenerate definition %#", (definition) => {
    expectCode(() => new QuantResearchEngine(definition), "INVALID_DEFINITION");
  });

  it("rejects generated variants whose advertised perturbation or inference step is vacuous", () => {
    expectCode(() => new QuantResearchEngine({
      family: "BAYESIAN_UPDATING",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      seed: 3,
      config: { priorAlpha: 1, priorBeta: 1, observationCount: 2, perturbedPriorAlpha: 2, perturbedPriorBeta: 2 }
    }), "INVALID_DEFINITION");

    expectCode(() => new QuantResearchEngine({
      family: "BAYESIAN_UPDATING",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      seed: 0,
      config: { priorAlpha: 1, priorBeta: 1, observationCount: 2, perturbedPriorAlpha: 1, perturbedPriorBeta: 2 }
    }), "INVALID_DEFINITION");

    expectCode(() => new QuantResearchEngine({
      family: "SAMPLING_ESTIMATION",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      seed: 33,
      config: { maxSamples: 3, populationSize: 8, centerMin: 0, centerMax: 0, noiseRadius: 1, outlierShift: 2 }
    }), "INVALID_DEFINITION");
  });

  it("rejects perturbations whose exact optimal action does not change", () => {
    expectCode(() => new QuantResearchEngine({
      family: "EXPERIMENTAL_ALLOCATION",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      seed: 12,
      config: { totalBudget: 5, costA: 1, costB: 2, perturbedCostA: 3, perturbedCostB: 1, noiseA: 1, noiseB: 2 }
    }), "INVALID_DEFINITION");

    expectCode(() => new QuantResearchEngine({
      family: "CONSTRAINED_OPTIMIZATION",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      seed: 0,
      config: { budget: 5, perturbedBudget: 6, maxX: 1, maxY: 1, perturbedPenalty: 1 }
    }), "INVALID_DEFINITION");

  });

  it("reserves perfect scores for exact optima instead of rounded near-optima", () => {
    const experimentDefinition: QuantResearchScenarioDefinition = {
      family: "EXPERIMENTAL_ALLOCATION",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      seed: 22,
      config: { totalBudget: 34, costA: 5, costB: 2, perturbedCostA: 3, perturbedCostB: 3, noiseA: 2, noiseB: 3 }
    };
    const experimentEngine = new QuantResearchEngine(experimentDefinition);
    experimentEngine.applyAction({ actionId: "near-e1", kind: "ALLOCATE_SAMPLE", a: 4, b: 7 });
    const experimentState = experimentEngine.getState();
    const meanA = visibleNumber(experimentState, "sampleMeanA");
    const meanB = visibleNumber(experimentState, "sampleMeanB");
    experimentEngine.applyAction({ actionId: "near-e2", kind: "CHOOSE_OPTION", option: meanA > meanB ? "A" : "B" });
    experimentEngine.applyAction({ actionId: "near-e3", kind: "ALLOCATE_SAMPLE", a: 4, b: 7 });
    expect(experimentEngine.getResult().metrics.ADAPTATION).toBe(99);
    expect(experimentEngine.getResult().overallScore).toBeLessThan(100);

    const optimizationDefinition: QuantResearchScenarioDefinition = {
      family: "CONSTRAINED_OPTIMIZATION",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      seed: 10,
      config: { budget: 52, perturbedBudget: 49, maxX: 24, maxY: 55, perturbedPenalty: 0 }
    };
    const optimizationEngine = new QuantResearchEngine(optimizationDefinition);
    optimizationEngine.applyAction({ actionId: "near-o1", kind: "SUBMIT_PARAMETERS", values: [24, 0] });
    optimizationEngine.applyAction({ actionId: "near-o2", kind: "SUBMIT_PARAMETERS", values: [24, 0] });
    expect(optimizationEngine.getResult().metrics.ADAPTATION).toBe(99);
    expect(optimizationEngine.getResult().metrics.OBJECTIVE_QUALITY).toBe(99);
    expect(optimizationEngine.getResult().overallScore).toBeLessThan(100);
  });

  it("does not give full posterior-update credit for repeating a prior after evidence changes the target", () => {
    const engine = new QuantResearchEngine(bayesian);
    const prior = bayesian.config.priorAlpha / (bayesian.config.priorAlpha + bayesian.config.priorBeta);
    engine.applyAction({ actionId: "change-b1", kind: "SUBMIT_PROBABILITY", value: prior });
    const successes = visibleNumber(engine.getState(), "successes");
    const failures = visibleNumber(engine.getState(), "failures");
    engine.applyAction({ actionId: "change-b2", kind: "SUBMIT_PROBABILITY", value: prior });
    engine.applyAction({
      actionId: "change-b3",
      kind: "SUBMIT_PROBABILITY",
      value: (bayesian.config.perturbedPriorAlpha + successes) /
        (bayesian.config.perturbedPriorAlpha + bayesian.config.perturbedPriorBeta + successes + failures)
    });
    expect(engine.getResult().metrics.NUMERICAL_CORRECTNESS).toBeLessThan(100);

    const exact = new QuantResearchEngine(bayesian);
    exact.applyAction({ actionId: "exact-b1", kind: "SUBMIT_PROBABILITY", value: prior });
    const exactSuccesses = visibleNumber(exact.getState(), "successes");
    const exactFailures = visibleNumber(exact.getState(), "failures");
    exact.applyAction({
      actionId: "exact-b2",
      kind: "SUBMIT_PROBABILITY",
      value: (bayesian.config.priorAlpha + exactSuccesses) /
        (bayesian.config.priorAlpha + bayesian.config.priorBeta + exactSuccesses + exactFailures)
    });
    exact.applyAction({
      actionId: "exact-b3",
      kind: "SUBMIT_PROBABILITY",
      value: (bayesian.config.perturbedPriorAlpha + exactSuccesses) /
        (bayesian.config.perturbedPriorAlpha + bayesian.config.perturbedPriorBeta + exactSuccesses + exactFailures)
    });
    expect(exact.getResult().metrics.NUMERICAL_CORRECTNESS).toBe(100);
  });

  it.each([
    { actionId: "a", kind: "SUBMIT_PROBABILITY", value: Number.NaN },
    { actionId: "a", kind: "SUBMIT_PROBABILITY", value: Number.POSITIVE_INFINITY },
    { actionId: "a", kind: "SUBMIT_PROBABILITY", value: 1.1 },
    { actionId: "a", kind: "REQUEST_OBSERVATION", count: -1 },
    { actionId: "a", kind: "ALLOCATE_SAMPLE", a: 1.5, b: 2 },
    { actionId: "a", kind: "SUBMIT_PARAMETERS", values: Array.from({ length: 9 }, () => 1) },
    { actionId: "a", kind: "SUBMIT_PARAMETERS", values: [Number.MAX_VALUE, 0] },
    { actionId: "a", kind: "SUBMIT_NUMERIC_ESTIMATE", value: Number.MAX_VALUE },
    { actionId: "a", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 1, extra: "reject me" }
  ])("strictly rejects malformed actions %#", (action) => {
    expectCode(() => new QuantResearchEngine(bayesian).applyAction(action), "INVALID_ACTION");
  });

  it("pins version-1 deterministic generation with golden instances", () => {
    const bayesEngine = new QuantResearchEngine(bayesian);
    bayesEngine.applyAction({ actionId: "gold-b", kind: "SUBMIT_PROBABILITY", value: 0.4 });
    expect(visibleNumber(bayesEngine.getState(), "successes")).toBe(6);
    expect(visibleNumber(bayesEngine.getState(), "failures")).toBe(2);

    const samplingEngine = new QuantResearchEngine(sampling);
    samplingEngine.applyAction({ actionId: "gold-s", kind: "REQUEST_OBSERVATION", count: 4 });
    expect(samplingEngine.getState().visibleData.find((item) => item.key === "observations")?.value)
      .toEqual([-18, -21, -15, -18]);

    const experimentEngine = new QuantResearchEngine(experimental);
    experimentEngine.applyAction({ actionId: "gold-e", kind: "ALLOCATE_SAMPLE", a: 2, b: 4 });
    expect(visibleNumber(experimentEngine.getState(), "sampleMeanA")).toBe(57.5);
    expect(visibleNumber(experimentEngine.getState(), "sampleMeanB")).toBe(44.75);

    const modelEngine = new QuantResearchEngine(model);
    expect(modelEngine.getState().visibleData.find((item) => item.key === "y")?.value)
      .toEqual([11, 15, 18, 24, 29, 33, 39, 45, 49, 52]);

    const optimizationEngine = new QuantResearchEngine(optimization);
    expect(optimizationEngine.getState().visibleData.find((item) => item.key === "objective")?.value)
      .toBe("8*x + 8*y - 3*x*y");
  });

  it("same seed/config produces identical public progression and result", () => {
    const left = new QuantResearchEngine(bayesian);
    const right = new QuantResearchEngine(bayesian);
    const actions = [
      { actionId: "b1", kind: "SUBMIT_PROBABILITY", value: 0.4 },
      { actionId: "b2", kind: "SUBMIT_PROBABILITY", value: 0.5 },
      { actionId: "b3", kind: "SUBMIT_PROBABILITY", value: 0.6 }
    ];
    for (const action of actions) {
      expect(left.applyAction(action).state).toEqual(right.applyAction(action).state);
    }
    expect(left.getResult()).toEqual(right.getResult());
  });

  it("different seeds produce deterministic observable variation after reveal", () => {
    const first = new QuantResearchEngine(bayesian);
    const second = new QuantResearchEngine({ ...bayesian, seed: bayesian.seed + 1 });
    first.applyAction({ actionId: "a", kind: "SUBMIT_PROBABILITY", value: 0.4 });
    second.applyAction({ actionId: "a", kind: "SUBMIT_PROBABILITY", value: 0.4 });
    expect(first.getState().visibleData).not.toEqual(second.getState().visibleData);
  });

  it("inspection is pure and returned state is detached from authoritative state", () => {
    const engine = new QuantResearchEngine(model);
    const first = engine.getState();
    const second = engine.getState();
    expect(second).toEqual(first);
    const mutable = first.visibleData as unknown as Array<{ key: string }>;
    mutable.splice(0, mutable.length);
    expect(engine.getState()).toEqual(second);
    expect(engine.getResult()).toEqual(engine.getResult());
  });

  it("public state and diagnostics omit seed, latent truth, hidden arrays, and exact optima", () => {
    for (const definition of [bayesian, sampling, experimental, model, optimization]) {
      const engine = new QuantResearchEngine(definition);
      const serialized = JSON.stringify({ state: engine.getState(), diagnostics: engine.getDiagnostics(), result: engine.getResult() });
      expect(serialized).not.toContain('"seed"');
      expect(serialized).not.toMatch(/"(?:hiddenCenter|hiddenPopulation|hiddenMeanA|hiddenMeanB|hiddenModel|sequenceA|sequenceB|points|perturbedPoints|baseBestObjective|perturbedBestObjective|sampleOrder|observations|successes)":/u);
    }
  });

  it("keeps authoritative hidden state runtime-private, not merely TypeScript-private", () => {
    for (const definition of [bayesian, sampling, experimental, model, optimization]) {
      const engine = new QuantResearchEngine(definition);
      expect(Reflect.ownKeys(engine)).not.toContain("state");
      expect(Reflect.ownKeys(engine)).not.toContain("applyingAction");
      expect((engine as unknown as Record<string, unknown>).state).toBeUndefined();
      expect(JSON.stringify(engine)).toBe("{}");
    }
  });

  it("rejected actions do not reveal hidden answers in errors or mutate state", () => {
    const engine = new QuantResearchEngine(sampling);
    const before = engine.getState();
    try {
      engine.applyAction({ actionId: "bad-stage", kind: "CHOOSE_OPTION", option: "A" });
    } catch (error) {
      const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      expect(rendered).not.toMatch(/center|population|seed|hidden/iu);
    }
    expect(engine.getState()).toEqual(before);
    expect(engine.getAcceptedActions()).toHaveLength(0);
  });

  it("blocks reentrant action application triggered by validation traps", () => {
    const engine = new QuantResearchEngine(sampling);
    let nestedCode: QuantResearchError["code"] | undefined;
    const target = { actionId: "outer", kind: "REQUEST_OBSERVATION", count: 2 };
    const proxy = new Proxy(target, {
      ownKeys(value) {
        try {
          engine.applyAction({ actionId: "nested", kind: "REQUEST_OBSERVATION", count: 2 });
        } catch (error) {
          if (error instanceof QuantResearchError) nestedCode = error.code;
          else throw error;
        }
        return Reflect.ownKeys(value);
      }
    });

    engine.applyAction(proxy);
    expect(nestedCode).toBe("ACTION_NOT_ALLOWED");
    expect(engine.getAcceptedActions().map((action) => action.actionId)).toEqual(["outer"]);
    expect(engine.getState().acceptedActionCount).toBe(1);
  });

  it("bounds reentrant parser, registry, and replay traps with domain errors", () => {
    let nestedDefinitionCode: QuantResearchError["code"] | undefined;
    const definitionTarget = { ...sampling, config: { ...sampling.config } };
    let definitionProxy: unknown;
    definitionProxy = new Proxy(definitionTarget, {
      getPrototypeOf(value) {
        try {
          parseQuantResearchDefinition(definitionProxy);
        } catch (error) {
          if (error instanceof QuantResearchError) nestedDefinitionCode = error.code;
          else throw error;
        }
        return Reflect.getPrototypeOf(value);
      }
    });
    expect(parseQuantResearchDefinition(definitionProxy)).toEqual(sampling);
    expect(nestedDefinitionCode).toBe("INVALID_DEFINITION");

    let nestedActionCode: QuantResearchError["code"] | undefined;
    const actionTarget = { actionId: "reentrant-parser", kind: "REQUEST_OBSERVATION", count: 2 } as const;
    let actionProxy: unknown;
    actionProxy = new Proxy(actionTarget, {
      ownKeys(value) {
        try {
          parseQuantResearchAction(actionProxy);
        } catch (error) {
          if (error instanceof QuantResearchError) nestedActionCode = error.code;
          else throw error;
        }
        return Reflect.ownKeys(value);
      }
    });
    expect(parseQuantResearchAction(actionProxy)).toEqual(actionTarget);
    expect(nestedActionCode).toBe("INVALID_ACTION");

    const registration = {
      family: "BAYESIAN_UPDATING",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION
    } as const;
    let nestedRegistryCode: QuantResearchError["code"] | undefined;
    let registryProxy: unknown;
    const registryTarget = [registration];
    registryProxy = new Proxy(registryTarget, {
      ownKeys(value) {
        try {
          assertUniqueQuantResearchRegistrations(registryProxy);
        } catch (error) {
          if (error instanceof QuantResearchError) nestedRegistryCode = error.code;
          else throw error;
        }
        return Reflect.ownKeys(value);
      }
    });
    expect(() => assertUniqueQuantResearchRegistrations(registryProxy)).not.toThrow();
    expect(nestedRegistryCode).toBe("INVALID_REGISTRY");

    let nestedReplayCode: QuantResearchError["code"] | undefined;
    let replayProxy: unknown;
    const replayTarget: unknown[] = [];
    replayProxy = new Proxy(replayTarget, {
      ownKeys(value) {
        try {
          replayQuantResearch(bayesian, replayProxy);
        } catch (error) {
          if (error instanceof QuantResearchError) nestedReplayCode = error.code;
          else throw error;
        }
        return Reflect.ownKeys(value);
      }
    });
    expect(replayQuantResearch(bayesian, replayProxy).acceptedActions).toEqual([]);
    expect(nestedReplayCode).toBe("INVALID_REPLAY");
  });

  it("returns a runtime-frozen canonical definition for authoritative replay persistence", () => {
    const canonical = parseQuantResearchDefinition({
      ...sampling,
      config: { ...sampling.config }
    });
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.config)).toBe(true);

    const mutableCanonical = canonical as unknown as {
      seed: number;
      config: { maxSamples: number };
    };
    expect(() => {
      mutableCanonical.seed = 999;
    }).toThrow();
    expect(() => {
      mutableCanonical.config.maxSamples = 32;
    }).toThrow();

    const engine = new QuantResearchEngine(canonical);
    engine.applyAction({ actionId: "canonical-sample", kind: "REQUEST_OBSERVATION", count: 2 });
    expect(replayQuantResearch(canonical, engine.getAcceptedActions()).state).toEqual(engine.getState());
  });

  it("does not retain mutable caller aliases for definitions, actions, or returned snapshots", () => {
    const mutableDefinition = {
      family: "SAMPLING_ESTIMATION",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      seed: 91,
      config: { ...sampling.config }
    };
    const engine = new QuantResearchEngine(mutableDefinition);
    const initial = engine.getState();
    mutableDefinition.config.maxSamples = 32;
    mutableDefinition.seed = 999;
    expect(engine.getState()).toEqual(initial);

    const action = { actionId: "alias-action", kind: "REQUEST_OBSERVATION", count: 2 };
    engine.applyAction(action);
    action.actionId = "mutated";
    action.count = 10;
    expect(engine.getAcceptedActions()).toEqual([{ actionId: "alias-action", kind: "REQUEST_OBSERVATION", count: 2 }]);

    const accepted = engine.getAcceptedActions() as unknown as Array<{ actionId: string }>;
    const acceptedFirst = accepted[0];
    expect(acceptedFirst).toBeDefined();
    if (acceptedFirst === undefined) throw new Error("Expected one accepted action");
    acceptedFirst.actionId = "external-mutation";
    expect(engine.getAcceptedActions()[0]?.actionId).toBe("alias-action");

    const state = engine.getState();
    const observations = state.visibleData.find((item) => item.key === "observations")?.value as number[];
    observations[0] = 999_999;
    expect(engine.getState().visibleData.find((item) => item.key === "observations")?.value).not.toContain(999_999);

    const registry = getQuantResearchRegistry() as unknown as Array<{ family: string; version: string }>;
    const registryFirst = registry[0];
    expect(registryFirst).toBeDefined();
    if (registryFirst === undefined) throw new Error("Expected a registry entry");
    registryFirst.family = "tampered";
    expect(getQuantResearchRegistry()[0]?.family).not.toBe("tampered");
  });

  it("does not virtual-dispatch public projection after committing a transition", () => {
    class ThrowingProjectionEngine extends QuantResearchEngine {
      public override getState(): ReturnType<QuantResearchEngine["getState"]> {
        throw new Error("subclass projection must not run inside applyAction");
      }
    }

    const engine = new ThrowingProjectionEngine(sampling);
    const transition = engine.applyAction({ actionId: "atomic-projection", kind: "REQUEST_OBSERVATION", count: 2 });
    expect(transition.state.acceptedActionCount).toBe(1);
    expect(engine.getAcceptedActions().map((action) => action.actionId)).toEqual(["atomic-projection"]);
  });

  it("duplicate action IDs fail closed without partial mutation", () => {
    const engine = new QuantResearchEngine(sampling);
    engine.applyAction({ actionId: "sample", kind: "REQUEST_OBSERVATION", count: 2 });
    const before = engine.getState();
    expectCode(() => engine.applyAction({ actionId: "sample", kind: "REQUEST_OBSERVATION", count: 1 }), "DUPLICATE_ACTION_ID");
    expect(engine.getState()).toEqual(before);
  });

  it("out-of-order actions fail closed", () => {
    const engine = new QuantResearchEngine(experimental);
    const before = engine.getState();
    expectCode(() => engine.applyAction({ actionId: "wrong", kind: "CHOOSE_OPTION", option: "A" }), "ACTION_NOT_ALLOWED");
    expect(engine.getState()).toEqual(before);
  });

  it("actions after completion are rejected", () => {
    const engine = new QuantResearchEngine(model);
    engine.applyAction({ actionId: "m1", kind: "CHOOSE_OPTION", option: "LINEAR" });
    engine.applyAction({ actionId: "m2", kind: "CHOOSE_OPTION", option: "LINEAR" });
    expect(engine.getResult().status).toBe("COMPLETE");
    expectCode(() => engine.applyAction({ actionId: "m3", kind: "CHOOSE_OPTION", option: "LINEAR" }), "SCENARIO_COMPLETE");
  });

  it("Bayesian scenario reveals data only after the prior estimate and supports prior perturbation", () => {
    const engine = new QuantResearchEngine(bayesian);
    expect(engine.getState().visibleData.map((item) => item.key)).not.toContain("successes");
    engine.applyAction({ actionId: "p1", kind: "SUBMIT_PROBABILITY", value: 2 / 5 });
    expect(engine.getState().visibleData.map((item) => item.key)).toContain("successes");
    const successes = visibleNumber(engine.getState(), "successes");
    const failures = visibleNumber(engine.getState(), "failures");
    engine.applyAction({ actionId: "p2", kind: "SUBMIT_PROBABILITY", value: (2 + successes) / (5 + successes + failures) });
    expect(engine.getState().stage).toBe("PRIOR_PERTURBATION");
    engine.applyAction({ actionId: "p3", kind: "SUBMIT_PROBABILITY", value: (5 + successes) / (7 + successes + failures) });
    expect(engine.getResult()).toMatchObject({ status: "COMPLETE", overallScore: 100 });
  });

  it("gives stale Bayesian references zero update/adaptation credit", () => {
    const engine = new QuantResearchEngine(bayesian);
    const prior = bayesian.config.priorAlpha / (bayesian.config.priorAlpha + bayesian.config.priorBeta);
    engine.applyAction({ actionId: "stale-b1", kind: "SUBMIT_PROBABILITY", value: prior });
    const successes = visibleNumber(engine.getState(), "successes");
    const failures = visibleNumber(engine.getState(), "failures");
    const basePosterior = (bayesian.config.priorAlpha + successes) /
      (bayesian.config.priorAlpha + bayesian.config.priorBeta + successes + failures);

    engine.applyAction({ actionId: "stale-b2", kind: "SUBMIT_PROBABILITY", value: prior });
    engine.applyAction({ actionId: "stale-b3", kind: "SUBMIT_PROBABILITY", value: basePosterior });

    expect(engine.getResult().metrics.NUMERICAL_CORRECTNESS).toBe(0);
    expect(engine.getResult().metrics.ADAPTATION).toBe(0);
    expect(engine.getResult().metrics.CONSISTENCY).toBe(0);
  });

  it("does not call a corrected Bayesian answer consistent with a wrong prior posterior", () => {
    const engine = new QuantResearchEngine(bayesian);
    const prior = bayesian.config.priorAlpha / (bayesian.config.priorAlpha + bayesian.config.priorBeta);
    engine.applyAction({ actionId: "inconsistent-b1", kind: "SUBMIT_PROBABILITY", value: prior });
    const successes = visibleNumber(engine.getState(), "successes");
    const failures = visibleNumber(engine.getState(), "failures");

    engine.applyAction({ actionId: "inconsistent-b2", kind: "SUBMIT_PROBABILITY", value: 0 });
    engine.applyAction({
      actionId: "inconsistent-b3",
      kind: "SUBMIT_PROBABILITY",
      value: (bayesian.config.perturbedPriorAlpha + successes) /
        (bayesian.config.perturbedPriorAlpha + bayesian.config.perturbedPriorBeta + successes + failures)
    });

    expect(engine.getResult().metrics.NUMERICAL_CORRECTNESS).toBe(0);
    expect(engine.getResult().metrics.ADAPTATION).toBe(100);
    expect(engine.getResult().metrics.CONSISTENCY).toBe(0);
  });

  it("sampling enforces observation budget and supports contamination adaptation", () => {
    const engine = new QuantResearchEngine(sampling);
    engine.applyAction({ actionId: "s1", kind: "REQUEST_OBSERVATION", count: 4 });
    expectCode(() => engine.applyAction({ actionId: "s2", kind: "REQUEST_OBSERVATION", count: 7 }), "RESOURCE_LIMIT_EXCEEDED");
    const observations = engine.getState().visibleData.find((item) => item.key === "observations")?.value;
    expect(Array.isArray(observations)).toBe(true);
    const sampleMean = (observations as readonly number[]).reduce((sum, value) => sum + value, 0) / (observations as readonly number[]).length;
    engine.applyAction({ actionId: "s3", kind: "SUBMIT_NUMERIC_ESTIMATE", value: sampleMean });
    expect(engine.getState().stage).toBe("OUTLIER_PERTURBATION");
    engine.applyAction({ actionId: "s4", kind: "SUBMIT_NUMERIC_ESTIMATE", value: sampleMean });
    expect(engine.getResult().status).toBe("COMPLETE");
  });

  it("experimental allocation enforces cost constraints and deterministic perturbation", () => {
    const engine = new QuantResearchEngine(experimental);
    expectCode(() => engine.applyAction({ actionId: "x", kind: "ALLOCATE_SAMPLE", a: 10, b: 10 }), "RESOURCE_LIMIT_EXCEEDED");
    engine.applyAction({ actionId: "e1", kind: "ALLOCATE_SAMPLE", a: 6, b: 2 });
    expect(engine.getState().stage).toBe("EXPERIMENT_DECISION");
    engine.applyAction({ actionId: "e2", kind: "CHOOSE_OPTION", option: "A" });
    expect(engine.getState().stage).toBe("PERTURBED_ALLOCATION");
    engine.applyAction({ actionId: "e3", kind: "ALLOCATE_SAMPLE", a: 2, b: 5 });
    expect(engine.getResult().status).toBe("COMPLETE");
  });

  it("model comparison introduces exactly one deterministic outlier perturbation", () => {
    const engine = new QuantResearchEngine(model);
    const beforeY = engine.getState().visibleData.find((item) => item.key === "y")?.value as readonly number[];
    engine.applyAction({ actionId: "mc1", kind: "CHOOSE_OPTION", option: "CONSTANT" });
    const afterY = engine.getState().visibleData.find((item) => item.key === "y")?.value as readonly number[];
    const changed = beforeY.filter((value, index) => value !== afterY[index]);
    expect(changed).toHaveLength(1);
    engine.applyAction({ actionId: "mc2", kind: "CHOOSE_OPTION", option: "CONSTANT" });
    expect(engine.getResult().metrics.ROBUSTNESS).toBeGreaterThanOrEqual(0);
  });

  it("classifies optimization domain violations as scenario-level inadmissibility", () => {
    const engine = new QuantResearchEngine(optimization);
    expectCode(
      () => engine.applyAction({ actionId: "wrong-arity", kind: "SUBMIT_PARAMETERS", values: [1] }),
      "ACTION_NOT_ALLOWED"
    );
    expectCode(
      () => engine.applyAction({ actionId: "fractional", kind: "SUBMIT_PARAMETERS", values: [1.5, 2] }),
      "ACTION_NOT_ALLOWED"
    );
    expect(engine.getAcceptedActions()).toHaveLength(0);
  });

  it("optimization checks constraints, objective quality, and adaptation", () => {
    const engine = new QuantResearchEngine(optimization);
    engine.applyAction({ actionId: "o1", kind: "SUBMIT_PARAMETERS", values: [0, 0] });
    expect(engine.getState().stage).toBe("PERTURBED_OPTIMIZATION");
    engine.applyAction({ actionId: "o2", kind: "SUBMIT_PARAMETERS", values: [100, 100] });
    expect(engine.getResult().metrics.CONSTRAINT_DISCIPLINE).toBe(50);
    expect(engine.getResult().status).toBe("COMPLETE");
  });

  it("snapshots the authoritative replay definition before action-container traps can mutate caller input", () => {
    const mutableDefinition = {
      ...sampling,
      seed: sampling.seed,
      config: { ...sampling.config }
    };
    const expected = new QuantResearchEngine(sampling).getState();

    const actionTarget: unknown[] = [];
    const maliciousActions = new Proxy(actionTarget, {
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") mutableDefinition.seed = sampling.seed + 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
    });

    const replayed = replayQuantResearch(mutableDefinition, maliciousActions);
    expect(mutableDefinition.seed).toBe(sampling.seed + 1);
    expect(replayed.state).toEqual(expected);
  });

  it("replays Bayesian updates with identical versioned evidence", () => {
    const engine = new QuantResearchEngine(bayesian);
    const prior = bayesian.config.priorAlpha / (bayesian.config.priorAlpha + bayesian.config.priorBeta);
    engine.applyAction({ actionId: "rb1", kind: "SUBMIT_PROBABILITY", value: prior });
    const successes = visibleNumber(engine.getState(), "successes");
    const failures = visibleNumber(engine.getState(), "failures");
    engine.applyAction({
      actionId: "rb2",
      kind: "SUBMIT_PROBABILITY",
      value: (bayesian.config.priorAlpha + successes) /
        (bayesian.config.priorAlpha + bayesian.config.priorBeta + successes + failures)
    });
    engine.applyAction({
      actionId: "rb3",
      kind: "SUBMIT_PROBABILITY",
      value: (bayesian.config.perturbedPriorAlpha + successes) /
        (bayesian.config.perturbedPriorAlpha + bayesian.config.perturbedPriorBeta + successes + failures)
    });

    const replayed = replayQuantResearch(bayesian, engine.getAcceptedActions());
    expect(replayed.state).toEqual(engine.getState());
    expect(replayed.result).toEqual(engine.getResult());
    expect(replayed.acceptedActions).toEqual(engine.getAcceptedActions());
  });

  it("replay reconstructs byte-for-byte equivalent public state and result", () => {
    const engine = new QuantResearchEngine(experimental);
    engine.applyAction({ actionId: "r1", kind: "ALLOCATE_SAMPLE", a: 6, b: 2 });
    engine.applyAction({ actionId: "r2", kind: "CHOOSE_OPTION", option: "B" });
    engine.applyAction({ actionId: "r3", kind: "ALLOCATE_SAMPLE", a: 2, b: 5 });
    const replayed = replayQuantResearch(experimental, engine.getAcceptedActions());
    expect(replayed.state).toEqual(engine.getState());
    expect(replayed.result).toEqual(engine.getResult());
    expect(replayed.acceptedActions).toEqual(engine.getAcceptedActions());
  });

  it("replay rejects maliciously large action vectors before work", () => {
    expectCode(() => replayQuantResearch(bayesian, Array.from({ length: 65 }, (_value, index) => ({
      actionId: `a${String(index)}`,
      kind: "SUBMIT_PROBABILITY",
      value: 0.5
    }))), "RESOURCE_LIMIT_EXCEEDED");
  });

  it("all evidence and aggregate metrics remain bounded", () => {
    const engine = new QuantResearchEngine(optimization);
    engine.applyAction({ actionId: "b1", kind: "SUBMIT_PARAMETERS", values: [0, 0] });
    engine.applyAction({ actionId: "b2", kind: "SUBMIT_PARAMETERS", values: [0, 0] });
    const result = engine.getResult();
    for (const item of result.evidence) expect(item.score).toBeGreaterThanOrEqual(0);
    for (const item of result.evidence) expect(item.score).toBeLessThanOrEqual(100);
    for (const value of Object.values(result.metrics)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
  });

  it("withholds scoring evidence until the scenario is complete", () => {
    const engine = new QuantResearchEngine(model);
    engine.applyAction({ actionId: "live-1", kind: "CHOOSE_OPTION", option: "CONSTANT" });

    const publicState = engine.getState();
    expect("evidence" in publicState).toBe(false);
    expect(engine.getResult()).toEqual({
      status: "IN_PROGRESS",
      family: "MODEL_COMPARISON",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION,
      acceptedActionCount: 1,
      overallScore: 0,
      metrics: {},
      evidence: []
    });

    engine.applyAction({ actionId: "live-2", kind: "CHOOSE_OPTION", option: "LINEAR" });
    expect(engine.getResult().status).toBe("COMPLETE");
    expect(engine.getResult().evidence.length).toBeGreaterThan(0);
  });

  it("rejects accessor-backed candidate/config values without invoking them", () => {
    let actionGetterInvoked = false;
    const accessorAction: Record<string, unknown> = {
      actionId: "accessor-action",
      kind: "SUBMIT_NUMERIC_ESTIMATE"
    };
    Object.defineProperty(accessorAction, "value", {
      enumerable: true,
      get() {
        actionGetterInvoked = true;
        return 0;
      }
    });
    expectCode(() => new QuantResearchEngine(sampling).applyAction(accessorAction), "INVALID_ACTION");
    expect(actionGetterInvoked).toBe(false);

    let configGetterInvoked = false;
    const accessorConfig: Record<string, unknown> = { ...sampling.config };
    Object.defineProperty(accessorConfig, "noiseRadius", {
      enumerable: true,
      get() {
        configGetterInvoked = true;
        return sampling.config.noiseRadius;
      }
    });
    expectCode(() => new QuantResearchEngine({ ...sampling, config: accessorConfig }), "INVALID_DEFINITION");
    expect(configGetterInvoked).toBe(false);
  });

  it("maps revoked proxies to bounded validation errors", () => {
    const actionProxy = Proxy.revocable({ actionId: "revoked", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 0 }, {});
    actionProxy.revoke();
    expectCode(() => new QuantResearchEngine(sampling).applyAction(actionProxy.proxy), "INVALID_ACTION");

    const registryProxy = Proxy.revocable([{ family: "BAYESIAN_UPDATING", version: QUANT_RESEARCH_VERSION }], {});
    registryProxy.revoke();
    expectCode(() => assertUniqueQuantResearchRegistrations(registryProxy.proxy), "INVALID_REGISTRY");

    const replayProxy = Proxy.revocable([], {});
    replayProxy.revoke();
    expectCode(() => replayQuantResearch(bayesian, replayProxy.proxy), "INVALID_REPLAY");
  });

  it("checks bounded array lengths before invoking own-key enumeration", () => {
    let vectorKeysInvoked = false;
    const oversizedVector = new Proxy(new Array<number>(9), {
      ownKeys() {
        vectorKeysInvoked = true;
        throw new Error("vector ownKeys should not run");
      }
    });
    expectCode(
      () => new QuantResearchEngine(optimization).applyAction({
        actionId: "oversized-vector",
        kind: "SUBMIT_PARAMETERS",
        values: oversizedVector
      }),
      "INVALID_ACTION"
    );
    expect(vectorKeysInvoked).toBe(false);

    let replayKeysInvoked = false;
    const oversizedReplay = new Proxy(new Array<unknown>(65), {
      ownKeys() {
        replayKeysInvoked = true;
        throw new Error("replay ownKeys should not run");
      }
    });
    expectCode(() => replayQuantResearch(bayesian, oversizedReplay), "RESOURCE_LIMIT_EXCEEDED");
    expect(replayKeysInvoked).toBe(false);

    let registryKeysInvoked = false;
    const oversizedRegistry = new Proxy(new Array<unknown>(65), {
      ownKeys() {
        registryKeysInvoked = true;
        throw new Error("registry ownKeys should not run");
      }
    });
    expectCode(() => assertUniqueQuantResearchRegistrations(oversizedRegistry), "INVALID_REGISTRY");
    expect(registryKeysInvoked).toBe(false);
  });

  it("rejects sparse and accessor-backed parameter vectors", () => {
    const sparse = new Array<number>(2);
    sparse[1] = 0;
    expectCode(
      () => new QuantResearchEngine(optimization).applyAction({ actionId: "sparse", kind: "SUBMIT_PARAMETERS", values: sparse }),
      "INVALID_ACTION"
    );

    let vectorGetterInvoked = false;
    const accessorVector = [0, 0];
    Object.defineProperty(accessorVector, "1", {
      enumerable: true,
      get() {
        vectorGetterInvoked = true;
        return 0;
      }
    });
    expectCode(
      () => new QuantResearchEngine(optimization).applyAction({ actionId: "vector-accessor", kind: "SUBMIT_PARAMETERS", values: accessorVector }),
      "INVALID_ACTION"
    );
    expect(vectorGetterInvoked).toBe(false);
  });

  it("runtime-validates registry entries rather than trusting TypeScript types", () => {
    const validRegistration = {
      family: "BAYESIAN_UPDATING",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION
    } as const;
    expectCode(
      () => assertUniqueQuantResearchRegistrations([{ ...validRegistration, version: 1 }]),
      "INVALID_REGISTRY"
    );
    expectCode(
      () => assertUniqueQuantResearchRegistrations([{ ...validRegistration, generatorVersion: 1 }]),
      "INVALID_REGISTRY"
    );
    expectCode(
      () => assertUniqueQuantResearchRegistrations([{ ...validRegistration, rngVersion: 1 }]),
      "INVALID_REGISTRY"
    );
    expectCode(
      () => assertUniqueQuantResearchRegistrations([{ ...validRegistration, extra: true }]),
      "INVALID_REGISTRY"
    );

    let versionGetterInvoked = false;
    const registration: Record<string, unknown> = {
      family: "BAYESIAN_UPDATING",
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION
    };
    Object.defineProperty(registration, "version", {
      enumerable: true,
      get() {
        versionGetterInvoked = true;
        return QUANT_RESEARCH_VERSION;
      }
    });
    expectCode(() => assertUniqueQuantResearchRegistrations([registration]), "INVALID_REGISTRY");
    expect(versionGetterInvoked).toBe(false);

    let iteratorInvoked = false;
    const registryWithIterator: unknown[] = [{
      family: "BAYESIAN_UPDATING",
      version: QUANT_RESEARCH_VERSION,
      generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
      rngVersion: QUANT_RESEARCH_RNG_VERSION
    }];
    Object.defineProperty(registryWithIterator, Symbol.iterator, {
      value: function* () {
        iteratorInvoked = true;
        yield {
          family: "MODEL_COMPARISON",
          version: QUANT_RESEARCH_VERSION,
          generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
          rngVersion: QUANT_RESEARCH_RNG_VERSION
        };
      }
    });
    expectCode(() => assertUniqueQuantResearchRegistrations(registryWithIterator), "INVALID_REGISTRY");
    expect(iteratorInvoked).toBe(false);
  });

  it("treats symmetric floating-point tolerance boundaries identically", () => {
    const complete = (firstProbability: number) => {
      const engine = new QuantResearchEngine(bayesian);
      engine.applyAction({ actionId: "t1", kind: "SUBMIT_PROBABILITY", value: firstProbability });
      const successes = visibleNumber(engine.getState(), "successes");
      const failures = visibleNumber(engine.getState(), "failures");
      engine.applyAction({
        actionId: "t2",
        kind: "SUBMIT_PROBABILITY",
        value: (bayesian.config.priorAlpha + successes) /
          (bayesian.config.priorAlpha + bayesian.config.priorBeta + successes + failures)
      });
      engine.applyAction({
        actionId: "t3",
        kind: "SUBMIT_PROBABILITY",
        value: (bayesian.config.perturbedPriorAlpha + successes) /
          (bayesian.config.perturbedPriorAlpha + bayesian.config.perturbedPriorBeta + successes + failures)
      });
      return engine.getResult();
    };

    expect(complete(0.375).metrics.CALIBRATION).toBe(100);
    expect(complete(0.425).metrics.CALIBRATION).toBe(100);
  });

  it("preserves previously visible baselines after perturbations", () => {
    const samplingEngine = new QuantResearchEngine(sampling);
    samplingEngine.applyAction({ actionId: "baseline-sample", kind: "REQUEST_OBSERVATION", count: 3 });
    const baselineObservations = samplingEngine.getState().visibleData.find((item) => item.key === "observations")?.value;
    samplingEngine.applyAction({ actionId: "baseline-estimate", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 0 });
    expect(samplingEngine.getState().visibleData.find((item) => item.key === "baselineObservations")?.value)
      .toEqual(baselineObservations);
    expect(typeof samplingEngine.getState().visibleData.find((item) => item.key === "contaminatedObservation")?.value)
      .toBe("number");

    const experimentEngine = new QuantResearchEngine(experimental);
    experimentEngine.applyAction({ actionId: "baseline-exp-1", kind: "ALLOCATE_SAMPLE", a: 2, b: 4 });
    experimentEngine.applyAction({ actionId: "baseline-exp-2", kind: "CHOOSE_OPTION", option: "A" });
    expect(visibleNumber(experimentEngine.getState(), "baselineCostA")).toBe(experimental.config.costA);
    expect(visibleNumber(experimentEngine.getState(), "baselineCostB")).toBe(experimental.config.costB);

    const optimizationEngine = new QuantResearchEngine(optimization);
    const baselineObjective = optimizationEngine.getState().visibleData.find((item) => item.key === "objective")?.value;
    optimizationEngine.applyAction({ actionId: "baseline-opt", kind: "SUBMIT_PARAMETERS", values: [0, 0] });
    expect(optimizationEngine.getState().visibleData.find((item) => item.key === "baselineObjective")?.value)
      .toBe(baselineObjective);
    expect(visibleNumber(optimizationEngine.getState(), "baselineBudget")).toBe(optimization.config.budget);
  });

  it("does not award perfect sampling adaptation for preserving a very bad estimate", () => {
    const engine = new QuantResearchEngine(sampling);
    engine.applyAction({ actionId: "poor-sample", kind: "REQUEST_OBSERVATION", count: 2 });
    engine.applyAction({ actionId: "poor-before", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 1_000_000 });
    engine.applyAction({ actionId: "poor-after", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 1_000_000 });

    expect(engine.getResult().metrics.ADAPTATION).toBe(0);
    expect(engine.getResult().metrics.ROBUSTNESS).toBe(0);
  });

  it("does not treat a useless early estimate as sample-efficient", () => {
    const engine = new QuantResearchEngine(sampling);
    engine.applyAction({ actionId: "inefficient-s1", kind: "REQUEST_OBSERVATION", count: 2 });
    engine.applyAction({ actionId: "inefficient-s2", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 1_000_000 });
    engine.applyAction({ actionId: "inefficient-s3", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 1_000_000 });
    expect(engine.getResult().metrics.NUMERICAL_CORRECTNESS).toBe(0);
    expect(engine.getResult().metrics.SAMPLE_EFFICIENCY).toBe(0);
  });

  it("requires both experiments in the initial comparison and scores against the same feasible frontier", () => {
    const rejected = new QuantResearchEngine(experimental);
    const before = rejected.getState();
    expectCode(
      () => rejected.applyAction({ actionId: "one-arm", kind: "ALLOCATE_SAMPLE", a: 8, b: 0 }),
      "ACTION_NOT_ALLOWED"
    );
    expect(rejected.getState()).toEqual(before);

    const engine = new QuantResearchEngine(experimental);
    engine.applyAction({ actionId: "frontier-1", kind: "ALLOCATE_SAMPLE", a: 2, b: 4 });
    engine.applyAction({ actionId: "frontier-2", kind: "CHOOSE_OPTION", option: "A" });
    expectCode(
      () => engine.applyAction({ actionId: "one-arm-perturbed", kind: "ALLOCATE_SAMPLE", a: 4, b: 0 }),
      "ACTION_NOT_ALLOWED"
    );
    engine.applyAction({ actionId: "frontier-3", kind: "ALLOCATE_SAMPLE", a: 2, b: 5 });
    const efficiencyEvidence = engine.getResult().evidence.filter((item) => item.category === "SAMPLE_EFFICIENCY");
    expect(efficiencyEvidence.map((item) => item.score)).toEqual([100, 100]);
    expect(engine.getResult().metrics.SAMPLE_EFFICIENCY).toBe(100);
    expect(engine.getResult().metrics.ADAPTATION).toBe(100);
  });

  it("does not assign arbitrary partial consistency credit to a corrected model choice", () => {
    const engine = new QuantResearchEngine(model);
    const y = engine.getState().visibleData.find((item) => item.key === "y")?.value as readonly number[];
    const noiseRadius = visibleNumber(engine.getState(), "noiseRadius");
    const first = y[0];
    const last = y[y.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) throw new Error("Model fixture is missing endpoints");
    const correct = Math.abs(last - first) > 2 * noiseRadius ? "LINEAR" : "CONSTANT";
    const wrong = correct === "LINEAR" ? "CONSTANT" : "LINEAR";

    engine.applyAction({ actionId: "recover-m1", kind: "CHOOSE_OPTION", option: wrong });
    engine.applyAction({ actionId: "recover-m2", kind: "CHOOSE_OPTION", option: correct });
    expect(engine.getResult().metrics.NUMERICAL_CORRECTNESS).toBe(0);
    expect(engine.getResult().metrics.ROBUSTNESS).toBe(100);
    expect(engine.getResult().metrics.CONSISTENCY).toBe(0);
  });

  it("does not reward a consistently wrong model conclusion", () => {
    const engine = new QuantResearchEngine(model);
    engine.applyAction({ actionId: "wrong-model-1", kind: "CHOOSE_OPTION", option: "CONSTANT" });
    engine.applyAction({ actionId: "wrong-model-2", kind: "CHOOSE_OPTION", option: "CONSTANT" });
    expect(engine.getResult().metrics.NUMERICAL_CORRECTNESS).toBe(0);
    expect(engine.getResult().metrics.ROBUSTNESS).toBe(0);
    expect(engine.getResult().metrics.CONSISTENCY).toBe(0);
  });

  it("uses category-level metrics for the composite and never grants false optimization adaptation", () => {
    const engine = new QuantResearchEngine(optimization);
    engine.applyAction({ actionId: "zero-base", kind: "SUBMIT_PARAMETERS", values: [0, 0] });
    engine.applyAction({ actionId: "zero-perturbed", kind: "SUBMIT_PARAMETERS", values: [0, 0] });
    expect(engine.getResult().metrics).toMatchObject({
      CONSTRAINT_DISCIPLINE: 100,
      OBJECTIVE_QUALITY: 0,
      ADAPTATION: 0
    });
    expect(engine.getResult().overallScore).toBe(33);
  });

  it("canonicalizes negative zero so JSON-style replay cannot change numeric identity", () => {
    const engine = new QuantResearchEngine(optimization);
    engine.applyAction({ actionId: "negzero-1", kind: "SUBMIT_PARAMETERS", values: [-0, 0] });
    engine.applyAction({ actionId: "negzero-2", kind: "SUBMIT_PARAMETERS", values: [0, -0] });
    const accepted = engine.getAcceptedActions();
    const first = accepted[0];
    const second = accepted[1];
    expect(first?.kind).toBe("SUBMIT_PARAMETERS");
    expect(second?.kind).toBe("SUBMIT_PARAMETERS");
    if (first?.kind !== "SUBMIT_PARAMETERS" || second?.kind !== "SUBMIT_PARAMETERS") {
      throw new Error("Expected parameter actions");
    }
    expect(Object.is(first.values[0], -0)).toBe(false);
    expect(Object.is(second.values[1], -0)).toBe(false);

    const jsonRoundTrip = JSON.parse(JSON.stringify(accepted)) as unknown;
    const replayed = replayQuantResearch(optimization, jsonRoundTrip);
    expect(replayed.acceptedActions).toEqual(accepted);
    expect(replayed.result).toEqual(engine.getResult());
  });

  it("distinguishes malformed replay input from an oversized replay", () => {
    expectCode(() => replayQuantResearch(bayesian, "not-an-array"), "INVALID_REPLAY");
    expectCode(() => replayQuantResearch(bayesian, Array.from({ length: 65 }, () => null)), "RESOURCE_LIMIT_EXCEEDED");

    const sparseReplay = new Array<unknown>(1);
    expectCode(() => replayQuantResearch(bayesian, sparseReplay), "INVALID_REPLAY");

    let iteratorInvoked = false;
    const customIteratorReplay: unknown[] = [];
    Object.defineProperty(customIteratorReplay, Symbol.iterator, {
      value: function* () {
        iteratorInvoked = true;
        yield null;
      }
    });
    expectCode(() => replayQuantResearch(bayesian, customIteratorReplay), "INVALID_REPLAY");
    expect(iteratorInvoked).toBe(false);
  });

  it("returns detached final results as well as detached public state", () => {
    const engine = new QuantResearchEngine(model);
    engine.applyAction({ actionId: "detach-1", kind: "CHOOSE_OPTION", option: "LINEAR" });
    engine.applyAction({ actionId: "detach-2", kind: "CHOOSE_OPTION", option: "LINEAR" });
    const baseline = engine.getResult();
    const mutated = engine.getResult();
    (mutated.evidence as unknown as unknown[]).splice(0, mutated.evidence.length);
    const metrics = mutated.metrics as Record<string, number>;
    metrics.ROBUSTNESS = -999;
    expect(engine.getResult()).toEqual(baseline);
  });

});

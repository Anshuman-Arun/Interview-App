import { describe, expect, it } from "vitest";
import {
  QUANT_RESEARCH_VERSION,
  QuantResearchEngine,
  QuantResearchError,
  assertUniqueQuantResearchRegistrations,
  getQuantResearchRegistry,
  replayQuantResearch,
  type QuantResearchScenarioDefinition
} from "../packages/local-compute/src/index.js";

const bayesian: QuantResearchScenarioDefinition = {
  family: "BAYESIAN_UPDATING",
  version: QUANT_RESEARCH_VERSION,
  seed: 17,
  config: { priorAlpha: 2, priorBeta: 3, observationCount: 8, perturbedPriorAlpha: 5, perturbedPriorBeta: 2 }
};

const sampling: QuantResearchScenarioDefinition = {
  family: "SAMPLING_ESTIMATION",
  version: QUANT_RESEARCH_VERSION,
  seed: 91,
  config: { maxSamples: 10, populationSize: 32, centerMin: -20, centerMax: 20, noiseRadius: 4, outlierShift: 25 }
};

const experimental: QuantResearchScenarioDefinition = {
  family: "EXPERIMENTAL_ALLOCATION",
  version: QUANT_RESEARCH_VERSION,
  seed: 808,
  config: { totalBudget: 20, costA: 2, costB: 4, perturbedCostA: 5, perturbedCostB: 2, noiseA: 2, noiseB: 5 }
};

const model: QuantResearchScenarioDefinition = {
  family: "MODEL_COMPARISON",
  version: QUANT_RESEARCH_VERSION,
  seed: 1234,
  config: { observationCount: 10, noiseRadius: 2, outlierShift: 30 }
};

const optimization: QuantResearchScenarioDefinition = {
  family: "CONSTRAINED_OPTIMIZATION",
  version: QUANT_RESEARCH_VERSION,
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
  it("registers exactly the five supported family/version pairs", () => {
    expect(getQuantResearchRegistry()).toHaveLength(5);
    expect(new Set(getQuantResearchRegistry().map((item) => item.family)).size).toBe(5);
  });

  it("rejects duplicate family/version registrations", () => {
    expect(() => assertUniqueQuantResearchRegistrations([
      { family: "BAYESIAN_UPDATING", version: QUANT_RESEARCH_VERSION },
      { family: "BAYESIAN_UPDATING", version: QUANT_RESEARCH_VERSION }
    ])).toThrow(/Duplicate/);
  });

  it.each([
    { ...bayesian, seed: Number.MAX_SAFE_INTEGER + 1 },
    { ...bayesian, seed: -1 },
    { ...bayesian, config: { ...bayesian.config, observationCount: 0 } },
    { ...bayesian, config: { ...bayesian.config, perturbedPriorAlpha: bayesian.config.priorAlpha, perturbedPriorBeta: bayesian.config.priorBeta } },
    { ...sampling, config: { ...sampling.config, maxSamples: 33 } },
    { ...sampling, config: { ...sampling.config, outlierShift: sampling.config.noiseRadius } },
    { ...sampling, config: { ...sampling.config, centerMin: 5, centerMax: 5, noiseRadius: 0 } },
    { ...experimental, config: { ...experimental.config, totalBudget: 20, costA: 11, costB: 10 } },
    { ...experimental, config: { ...experimental.config, totalBudget: 10, costA: 4, costB: 4, perturbedCostA: 11, perturbedCostB: 12 } },
    { ...experimental, config: { ...experimental.config, perturbedCostA: experimental.config.costA, perturbedCostB: experimental.config.costB } },
    { ...model, config: { ...model.config, outlierShift: 2 * model.config.noiseRadius } },
    { ...model, config: { ...model.config, extra: true } },
    { ...optimization, extra: true }
  ] as const)("rejects malformed or degenerate definition %#", (definition) => {
    expectCode(() => new QuantResearchEngine(definition), "INVALID_DEFINITION");
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

  it("rejected actions do not reveal hidden answers in errors or mutate state", () => {
    const engine = new QuantResearchEngine(sampling);
    const before = engine.getState();
    try {
      engine.applyAction({ actionId: "bad-stage", kind: "CHOOSE_OPTION", option: "A" });
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toMatch(/center|population|seed|hidden/iu);
    }
    expect(engine.getState()).toEqual(before);
    expect(engine.getAcceptedActions()).toHaveLength(0);
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

  it("optimization checks constraints, objective quality, and adaptation", () => {
    const engine = new QuantResearchEngine(optimization);
    engine.applyAction({ actionId: "o1", kind: "SUBMIT_PARAMETERS", values: [0, 0] });
    expect(engine.getState().stage).toBe("PERTURBED_OPTIMIZATION");
    engine.applyAction({ actionId: "o2", kind: "SUBMIT_PARAMETERS", values: [100, 100] });
    expect(engine.getResult().metrics.CONSTRAINT_DISCIPLINE).toBe(50);
    expect(engine.getResult().status).toBe("COMPLETE");
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
    expectCode(
      () => assertUniqueQuantResearchRegistrations([{ family: "BAYESIAN_UPDATING", version: 1 }]),
      "INVALID_REGISTRY"
    );
    expectCode(
      () => assertUniqueQuantResearchRegistrations([{ family: "BAYESIAN_UPDATING", version: QUANT_RESEARCH_VERSION, extra: true }]),
      "INVALID_REGISTRY"
    );

    let versionGetterInvoked = false;
    const registration: Record<string, unknown> = { family: "BAYESIAN_UPDATING" };
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
    const registryWithIterator: unknown[] = [{ family: "BAYESIAN_UPDATING", version: QUANT_RESEARCH_VERSION }];
    Object.defineProperty(registryWithIterator, Symbol.iterator, {
      value: function* () {
        iteratorInvoked = true;
        yield { family: "MODEL_COMPARISON", version: QUANT_RESEARCH_VERSION };
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

  it("does not award perfect sampling adaptation for preserving a very bad estimate", () => {
    const engine = new QuantResearchEngine(sampling);
    engine.applyAction({ actionId: "poor-sample", kind: "REQUEST_OBSERVATION", count: 2 });
    engine.applyAction({ actionId: "poor-before", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 1_000_000 });
    engine.applyAction({ actionId: "poor-after", kind: "SUBMIT_NUMERIC_ESTIMATE", value: 1_000_000 });

    expect(engine.getResult().metrics.ADAPTATION).toBe(0);
    expect(engine.getResult().metrics.ROBUSTNESS).toBe(0);
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

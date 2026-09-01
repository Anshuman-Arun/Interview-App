import { DeterministicRng } from "./deterministic-rng.js";
import {
  QUANT_RESEARCH_FAMILIES,
  QUANT_RESEARCH_GENERATOR_VERSION,
  QUANT_RESEARCH_RNG_VERSION,
  QUANT_RESEARCH_VERSION,
  QuantResearchError,
  assertUniqueQuantResearchRegistrations,
  parseQuantResearchAction,
  parseQuantResearchDefinition,
  type BayesianUpdatingConfig,
  type ConstrainedOptimizationConfig,
  type ExperimentalAllocationConfig,
  type ModelComparisonConfig,
  type QuantResearchAction,
  type QuantResearchDiagnostics,
  type QuantResearchEvidence,
  type QuantResearchEvidenceCategory,
  type QuantResearchPublicDatum,
  type QuantResearchPublicState,
  type QuantResearchResult,
  type QuantResearchScenarioDefinition,
  type QuantResearchTransition,
  type SamplingEstimationConfig
} from "./types.js";

const MAX_ACTIONS = 64;
const REGISTRY = QUANT_RESEARCH_FAMILIES.map((family) => ({
  family,
  version: QUANT_RESEARCH_VERSION,
  generatorVersion: QUANT_RESEARCH_GENERATOR_VERSION,
  rngVersion: QUANT_RESEARCH_RNG_VERSION
}));
assertUniqueQuantResearchRegistrations(REGISTRY);

type ScenarioStatus = "IN_PROGRESS" | "COMPLETE";

interface CommonState {
  readonly family: QuantResearchScenarioDefinition["family"];
  readonly version: typeof QUANT_RESEARCH_VERSION;
  readonly generatorVersion: QuantResearchScenarioDefinition["generatorVersion"];
  readonly rngVersion: QuantResearchScenarioDefinition["rngVersion"];
  readonly status: ScenarioStatus;
  readonly stage: string;
  readonly acceptedActions: readonly QuantResearchAction[];
  readonly evidence: readonly QuantResearchEvidence[];
}

interface BayesianState extends CommonState {
  readonly family: "BAYESIAN_UPDATING";
  readonly config: BayesianUpdatingConfig;
  readonly observations: readonly boolean[];
  readonly successes: number;
}

interface SamplingState extends CommonState {
  readonly family: "SAMPLING_ESTIMATION";
  readonly config: SamplingEstimationConfig;
  readonly hiddenCenter: number;
  readonly hiddenPopulation: readonly number[];
  readonly sampleOrder: readonly number[];
  readonly revealed: readonly number[];
  readonly outlier?: number;
}

interface ExperimentalState extends CommonState {
  readonly family: "EXPERIMENTAL_ALLOCATION";
  readonly config: ExperimentalAllocationConfig;
  readonly hiddenMeanA: number;
  readonly hiddenMeanB: number;
  readonly sequenceA: readonly number[];
  readonly sequenceB: readonly number[];
  readonly initialAllocation?: Readonly<{ a: number; b: number }>;
  readonly summaryA?: number;
  readonly summaryB?: number;
}

interface ModelState extends CommonState {
  readonly family: "MODEL_COMPARISON";
  readonly config: ModelComparisonConfig;
  readonly hiddenModel: "CONSTANT" | "LINEAR";
  readonly hiddenIntercept: number;
  readonly hiddenSlope: number;
  readonly points: readonly Readonly<{ x: number; y: number }>[];
  readonly perturbedPoints: readonly Readonly<{ x: number; y: number }>[];
  readonly firstChoice?: "CONSTANT" | "LINEAR";
}

interface OptimizationState extends CommonState {
  readonly family: "CONSTRAINED_OPTIMIZATION";
  readonly config: ConstrainedOptimizationConfig;
  readonly coefficientX: number;
  readonly coefficientY: number;
  readonly basePenalty: number;
  readonly baseBestObjective: number;
  readonly perturbedBestObjective: number;
}

type InternalState = BayesianState | SamplingState | ExperimentalState | ModelState | OptimizationState;

interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0 ? 1 : a;
}

function rational(numerator: number, denominator: number): Rational {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) throw new Error("Unsafe rational arithmetic");
  const sign = denominator < 0 ? -1 : 1;
  const divisor = gcd(numerator, denominator);
  return { numerator: sign * (numerator / divisor), denominator: Math.abs(denominator) / divisor };
}

function rationalToNumber(value: Rational): number {
  return value.numerator / value.denominator;
}

function compareRational(left: Rational, right: Rational): number {
  const leftScaled = left.numerator * right.denominator;
  const rightScaled = right.numerator * left.denominator;
  if (!Number.isSafeInteger(leftScaled) || !Number.isSafeInteger(rightScaled)) {
    throw new Error("Unsafe rational comparison");
  }
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

function rationalRatioToNumber(numerator: Rational, denominator: Rational): number {
  if (denominator.numerator === 0) throw new Error("Rational ratio denominator is zero");
  const top = numerator.numerator * denominator.denominator;
  const bottom = numerator.denominator * denominator.numerator;
  return rationalToNumber(rational(top, bottom));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function boundedScore(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Non-finite evidence score");
  return Math.max(0, Math.min(100, Math.round(value)));
}

function boundedRelativeScore(ratio: number, exact: boolean): number {
  if (!Number.isFinite(ratio)) throw new Error("Non-finite relative score");
  if (exact) return 100;
  return Math.min(99, boundedScore(ratio * 100));
}

function aggregateScores(values: readonly number[]): number {
  if (values.length === 0) return 0;
  if (values.every((value) => value === 100)) return 100;
  return Math.min(99, boundedScore(values.reduce((sum, value) => sum + value, 0) / values.length));
}

function distanceWithin(error: number, threshold: number): boolean {
  const tolerance = Number.EPSILON * 8 * Math.max(1, Math.abs(error), Math.abs(threshold));
  return error <= threshold + tolerance;
}

function distanceScore(error: number, scale: number): number {
  if (distanceWithin(error, scale)) return 100;
  if (distanceWithin(error, scale * 2)) return 80;
  if (distanceWithin(error, scale * 4)) return 50;
  if (distanceWithin(error, scale * 8)) return 20;
  return 0;
}

function shiftedReferenceScore(submitted: number, target: number, baseline: number, absoluteScale: number): number {
  const shift = Math.abs(target - baseline);
  if (shift === 0) throw new Error("Shifted reference score requires a changed target");
  const error = Math.abs(submitted - target);
  const progress = Math.max(0, Math.min(1, 1 - error / shift));
  return Math.min(distanceScore(error, absoluteScale), boundedScore(progress * 100));
}

function evidence(category: QuantResearchEvidenceCategory, stage: string, score: number, summary: string): QuantResearchEvidence {
  return { category, stage, score: boundedScore(score), summary };
}

function appendAction<T extends InternalState>(state: T, action: QuantResearchAction, patch?: Omit<Partial<T>, "acceptedActions">): T {
  return {
    ...state,
    ...(patch ?? {}),
    acceptedActions: [...state.acceptedActions, clone(action)]
  };
}

function appendEvidence<T extends InternalState>(state: T, additions: readonly QuantResearchEvidence[]): T {
  return { ...state, evidence: [...state.evidence, ...additions] };
}

function notAllowed(state: InternalState, action: QuantResearchAction): never {
  throw new QuantResearchError("ACTION_NOT_ALLOWED", `Action ${action.kind} is not allowed during stage ${state.stage}`);
}

function requireAction<T extends QuantResearchAction["kind"]>(state: InternalState, action: QuantResearchAction, kind: T): Extract<QuantResearchAction, { kind: T }> {
  if (action.kind !== kind) notAllowed(state, action);
  return action as Extract<QuantResearchAction, { kind: T }>;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Mean requires at least one value");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function initialize(definition: QuantResearchScenarioDefinition): InternalState {
  const rng = new DeterministicRng(
    definition.seed,
    definition.family + "@" + definition.version + "@" + definition.generatorVersion + "@" + definition.rngVersion
  );
  const common = {
    family: definition.family,
    version: definition.version,
    generatorVersion: definition.generatorVersion,
    rngVersion: definition.rngVersion,
    status: "IN_PROGRESS" as const,
    acceptedActions: [] as readonly QuantResearchAction[],
    evidence: [] as readonly QuantResearchEvidence[]
  };
  switch (definition.family) {
    case "BAYESIAN_UPDATING": {
      const hiddenSuccessThreshold = rng.nextInt(2, 8);
      const observations = Array.from({ length: definition.config.observationCount }, () => rng.nextInt(1, 10) <= hiddenSuccessThreshold);
      return {
        ...common,
        family: definition.family,
        stage: "PRIOR_ESTIMATE",
        config: definition.config,
        observations,
        successes: observations.filter(Boolean).length
      };
    }
    case "SAMPLING_ESTIMATION": {
      const hiddenCenter = rng.nextInt(definition.config.centerMin, definition.config.centerMax);
      const hiddenPopulation = Array.from(
        { length: definition.config.populationSize },
        () => hiddenCenter + rng.nextInt(-definition.config.noiseRadius, definition.config.noiseRadius)
      );
      return {
        ...common,
        family: definition.family,
        stage: "SAMPLING",
        config: definition.config,
        hiddenCenter,
        hiddenPopulation,
        sampleOrder: rng.shuffle(hiddenPopulation.map((_value, index) => index)),
        revealed: []
      };
    }
    case "EXPERIMENTAL_ALLOCATION": {
      const midpoint = rng.nextInt(35, 65);
      const direction = rng.nextInt(0, 1) === 0 ? -1 : 1;
      const gap = definition.config.noiseA + definition.config.noiseB + rng.nextInt(1, 6);
      const hiddenMeanA = midpoint;
      const hiddenMeanB = midpoint + direction * gap;
      const sequenceLength = Math.min(100, definition.config.totalBudget);
      const sequenceA = Array.from({ length: sequenceLength }, () => hiddenMeanA + rng.nextInt(-definition.config.noiseA, definition.config.noiseA));
      const sequenceB = Array.from({ length: sequenceLength }, () => hiddenMeanB + rng.nextInt(-definition.config.noiseB, definition.config.noiseB));
      return {
        ...common,
        family: definition.family,
        stage: "INITIAL_ALLOCATION",
        config: definition.config,
        hiddenMeanA,
        hiddenMeanB,
        sequenceA,
        sequenceB
      };
    }
    case "MODEL_COMPARISON": {
      const hiddenModel = rng.nextInt(0, 1) === 0 ? "CONSTANT" : "LINEAR";
      const intercept = rng.nextInt(-10, 10);
      const slope = hiddenModel === "LINEAR"
        ? rng.nextInt(definition.config.noiseRadius + 2, definition.config.noiseRadius + 5) * (rng.nextInt(0, 1) === 0 ? -1 : 1)
        : 0;
      const points = Array.from({ length: definition.config.observationCount }, (_value, index) => ({
        x: index,
        y: intercept + slope * index + rng.nextInt(-definition.config.noiseRadius, definition.config.noiseRadius)
      }));
      const outlierDirection = rng.nextInt(0, 1) === 0 ? -1 : 1;
      const perturbedPoints = points.map((point, index) => index === points.length - 1 ? { ...point, y: point.y + outlierDirection * definition.config.outlierShift } : point);
      return {
        ...common,
        family: definition.family,
        stage: "INITIAL_MODEL_CHOICE",
        config: definition.config,
        hiddenModel,
        hiddenIntercept: intercept,
        hiddenSlope: slope,
        points,
        perturbedPoints
      };
    }
    case "CONSTRAINED_OPTIMIZATION": {
      const coefficientX = rng.nextInt(4, 12);
      const coefficientY = rng.nextInt(4, 12);
      const basePenaltyCandidates = [0, 1, 2, 3, 4].filter((value) => value !== definition.config.perturbedPenalty);
      const basePenaltyIndex = rng.nextInt(0, basePenaltyCandidates.length - 1);
      const basePenalty = basePenaltyCandidates[basePenaltyIndex];
      if (basePenalty === undefined) throw new Error("Optimization penalty generation failed");
      const baseBestObjective = bestObjective(definition.config.budget, definition.config.maxX, definition.config.maxY, coefficientX, coefficientY, basePenalty);
      const perturbedBestObjective = bestObjective(definition.config.perturbedBudget, definition.config.maxX, definition.config.maxY, coefficientX, coefficientY, definition.config.perturbedPenalty);
      return {
        ...common,
        family: definition.family,
        stage: "BASE_OPTIMIZATION",
        config: definition.config,
        coefficientX,
        coefficientY,
        basePenalty,
        baseBestObjective,
        perturbedBestObjective
      };
    }
  }
}

function bestObjective(budget: number, maxX: number, maxY: number, coefficientX: number, coefficientY: number, penalty: number): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let x = 0; x <= maxX; x += 1) {
    for (let y = 0; y <= maxY; y += 1) {
      if (2 * x + 3 * y > budget) continue;
      best = Math.max(best, objective(x, y, coefficientX, coefficientY, penalty));
    }
  }
  if (!Number.isFinite(best)) throw new Error("Optimization scenario has no feasible point");
  return best;
}

function optimalOptimizationPoints(
  budget: number,
  maxX: number,
  maxY: number,
  coefficientX: number,
  coefficientY: number,
  penalty: number
): readonly Readonly<{ x: number; y: number }>[] {
  const best = bestObjective(budget, maxX, maxY, coefficientX, coefficientY, penalty);
  const points: Array<Readonly<{ x: number; y: number }>> = [];
  for (let x = 0; x <= maxX; x += 1) {
    for (let y = 0; y <= maxY; y += 1) {
      if (2 * x + 3 * y > budget) continue;
      if (objective(x, y, coefficientX, coefficientY, penalty) === best) points.push({ x, y });
    }
  }
  if (points.length === 0) throw new Error("Optimization optimum set is empty");
  return points;
}

function hasSharedPair(
  left: readonly Readonly<{ a: number; b: number }>[],
  right: readonly Readonly<{ a: number; b: number }>[]
): boolean {
  const keys = new Set(left.map((item) => `${String(item.a)}:${String(item.b)}`));
  return right.some((item) => keys.has(`${String(item.a)}:${String(item.b)}`));
}

function hasSharedOptimizationPoint(
  left: readonly Readonly<{ x: number; y: number }>[],
  right: readonly Readonly<{ x: number; y: number }>[]
): boolean {
  const keys = new Set(left.map((item) => `${String(item.x)}:${String(item.y)}`));
  return right.some((item) => keys.has(`${String(item.x)}:${String(item.y)}`));
}

function objective(x: number, y: number, coefficientX: number, coefficientY: number, penalty: number): number {
  return coefficientX * x + coefficientY * y - penalty * x * y;
}

interface ExperimentalOptimum {
  readonly variance: Rational;
  readonly allocations: readonly Readonly<{ a: number; b: number }>[];
}

function allocationVariance(a: number, b: number, noiseA: number, noiseB: number): Rational {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a <= 0 || b <= 0) {
    throw new Error("Allocation variance requires positive integer sample counts");
  }
  const varianceFactorA = noiseA * (noiseA + 1);
  const varianceFactorB = noiseB * (noiseB + 1);
  return rational(varianceFactorA * b + varianceFactorB * a, 3 * a * b);
}

function experimentalOptimum(costA: number, costB: number, noiseA: number, noiseB: number, budget: number): ExperimentalOptimum {
  let bestVariance: Rational | undefined;
  let allocations: Array<Readonly<{ a: number; b: number }>> = [];
  for (let candidateA = 1; candidateA <= budget; candidateA += 1) {
    for (let candidateB = 1; candidateB <= budget; candidateB += 1) {
      if (candidateA * costA + candidateB * costB > budget) continue;
      const variance = allocationVariance(candidateA, candidateB, noiseA, noiseB);
      if (bestVariance === undefined || compareRational(variance, bestVariance) < 0) {
        bestVariance = variance;
        allocations = [{ a: candidateA, b: candidateB }];
      } else if (compareRational(variance, bestVariance) === 0) {
        allocations.push({ a: candidateA, b: candidateB });
      }
    }
  }
  if (bestVariance === undefined || allocations.length === 0) {
    throw new Error("Experimental allocation scenario has no feasible two-arm allocation");
  }
  return { variance: bestVariance, allocations };
}

interface AllocationQuality {
  readonly ratio: number;
  readonly score: number;
}

function allocationQuality(
  a: number,
  b: number,
  costA: number,
  costB: number,
  noiseA: number,
  noiseB: number,
  budget: number
): AllocationQuality {
  const candidateVariance = allocationVariance(a, b, noiseA, noiseB);
  const optimum = experimentalOptimum(costA, costB, noiseA, noiseB, budget);
  const ratio = Math.max(0, Math.min(1, rationalRatioToNumber(optimum.variance, candidateVariance)));
  return {
    ratio,
    score: boundedRelativeScore(ratio, compareRational(candidateVariance, optimum.variance) === 0)
  };
}

function transition(state: InternalState, action: QuantResearchAction): InternalState {
  switch (state.family) {
    case "BAYESIAN_UPDATING":
      return transitionBayesian(state, action);
    case "SAMPLING_ESTIMATION":
      return transitionSampling(state, action);
    case "EXPERIMENTAL_ALLOCATION":
      return transitionExperimental(state, action);
    case "MODEL_COMPARISON":
      return transitionModel(state, action);
    case "CONSTRAINED_OPTIMIZATION":
      return transitionOptimization(state, action);
  }
}

function transitionBayesian(state: BayesianState, action: QuantResearchAction): BayesianState {
  if (state.stage === "PRIOR_ESTIMATE") {
    const submitted = requireAction(state, action, "SUBMIT_PROBABILITY");
    const target = rationalToNumber(rational(state.config.priorAlpha, state.config.priorAlpha + state.config.priorBeta));
    let next = appendAction(state, action, { stage: "POSTERIOR_UPDATE" });
    next = appendEvidence(next, [evidence("CALIBRATION", state.stage, distanceScore(Math.abs(submitted.value - target), 0.025), "Prior predictive probability was evaluated against the exact application-owned reference.")]);
    return next;
  }
  if (state.stage === "POSTERIOR_UPDATE") {
    const submitted = requireAction(state, action, "SUBMIT_PROBABILITY");
    const priorTarget = rationalToNumber(rational(state.config.priorAlpha, state.config.priorAlpha + state.config.priorBeta));
    const target = rationalToNumber(rational(state.config.priorAlpha + state.successes, state.config.priorAlpha + state.config.priorBeta + state.observations.length));
    let next = appendAction(state, action, { stage: "PRIOR_PERTURBATION" });
    next = appendEvidence(next, [evidence(
      "NUMERICAL_CORRECTNESS",
      state.stage,
      shiftedReferenceScore(submitted.value, target, priorTarget, 0.025),
      "Posterior update was checked against the exact reference and capped by progress away from the stale prior."
    )]);
    return next;
  }
  if (state.stage === "PRIOR_PERTURBATION") {
    const submitted = requireAction(state, action, "SUBMIT_PROBABILITY");
    const baseline = rationalToNumber(rational(
      state.config.priorAlpha + state.successes,
      state.config.priorAlpha + state.config.priorBeta + state.observations.length
    ));
    const target = rationalToNumber(rational(
      state.config.perturbedPriorAlpha + state.successes,
      state.config.perturbedPriorAlpha + state.config.perturbedPriorBeta + state.observations.length
    ));
    let next = appendAction(state, action, { stage: "COMPLETE", status: "COMPLETE" });
    const correctness = shiftedReferenceScore(submitted.value, target, baseline, 0.025);
    const previousUpdate = state.evidence.find((item) => item.category === "NUMERICAL_CORRECTNESS" && item.stage === "POSTERIOR_UPDATE");
    if (previousUpdate === undefined) throw new Error("Bayesian posterior evidence invariant violated");
    const consistency = Math.min(previousUpdate.score, correctness);
    next = appendEvidence(next, [
      evidence("ADAPTATION", state.stage, correctness, "The revised prior was incorporated into the candidate's update."),
      evidence("CONSISTENCY", state.stage, consistency, "Consistency requires both posterior computations to agree with their respective revealed assumptions.")
    ]);
    return next;
  }
  return notAllowed(state, action);
}

function transitionSampling(state: SamplingState, action: QuantResearchAction): SamplingState {
  if (state.stage === "SAMPLING") {
    if (action.kind === "REQUEST_OBSERVATION") {
      const remaining = state.config.maxSamples - state.revealed.length;
      if (action.count > remaining) throw new QuantResearchError("RESOURCE_LIMIT_EXCEEDED", "Observation request exceeds the remaining sample budget");
      const newValues: number[] = [];
      for (let offset = 0; offset < action.count; offset += 1) {
        const orderIndex = state.revealed.length + offset;
        const populationIndex = state.sampleOrder[orderIndex];
        if (populationIndex === undefined) throw new Error("Deterministic sample order exhausted unexpectedly");
        const value = state.hiddenPopulation[populationIndex];
        if (value === undefined) throw new Error("Deterministic population index was invalid");
        newValues.push(value);
      }
      return appendAction(state, action, { revealed: [...state.revealed, ...newValues] });
    }
    if (action.kind === "SUBMIT_NUMERIC_ESTIMATE") {
      if (state.revealed.length < 2) throw new QuantResearchError("ACTION_NOT_ALLOWED", "At least two observations must be revealed before an estimate");
      const score = distanceScore(Math.abs(action.value - state.hiddenCenter), Math.max(1, state.config.noiseRadius / 2));
      const observationEconomy = 100 - ((state.revealed.length - 2) / Math.max(1, state.config.maxSamples - 2)) * 40;
      const efficiency = Math.min(score, boundedScore(observationEconomy));
      const outlierDirection = state.hiddenCenter % 2 === 0 ? 1 : -1;
      let next = appendAction(state, action, {
        stage: "OUTLIER_PERTURBATION",
        outlier: state.hiddenCenter + outlierDirection * state.config.outlierShift
      });
      next = appendEvidence(next, [
        evidence("NUMERICAL_CORRECTNESS", state.stage, score, "The estimate was evaluated against the latent population center."),
        evidence("SAMPLE_EFFICIENCY", state.stage, efficiency, "Sampling efficiency reflects observation use before the first committed estimate.")
      ]);
      return next;
    }
    return notAllowed(state, action);
  }
  if (state.stage === "OUTLIER_PERTURBATION") {
    const submitted = requireAction(state, action, "SUBMIT_NUMERIC_ESTIMATE");
    const afterError = Math.abs(submitted.value - state.hiddenCenter);
    const correctness = distanceScore(afterError, Math.max(1, state.config.noiseRadius / 2));
    let next = appendAction(state, action, { stage: "COMPLETE", status: "COMPLETE" });
    next = appendEvidence(next, [
      evidence("ADAPTATION", state.stage, correctness, "Adaptation quality reflects estimation quality under the disclosed contamination perturbation."),
      evidence("ROBUSTNESS", state.stage, correctness, "The final estimate was checked for robustness to the introduced outlier.")
    ]);
    return next;
  }
  return notAllowed(state, action);
}

function transitionExperimental(state: ExperimentalState, action: QuantResearchAction): ExperimentalState {
  if (state.stage === "INITIAL_ALLOCATION") {
    const allocation = requireAction(state, action, "ALLOCATE_SAMPLE");
    validateExperimentalAllocation(allocation.a, allocation.b, state.config.costA, state.config.costB, state.config.totalBudget);
    const summaryA = mean(state.sequenceA.slice(0, allocation.a));
    const summaryB = mean(state.sequenceB.slice(0, allocation.b));
    const quality = allocationQuality(allocation.a, allocation.b, state.config.costA, state.config.costB, state.config.noiseA, state.config.noiseB, state.config.totalBudget);
    let next = appendAction(state, action, {
      stage: "EXPERIMENT_DECISION",
      initialAllocation: { a: allocation.a, b: allocation.b },
      summaryA,
      summaryB
    });
    next = appendEvidence(next, [evidence("SAMPLE_EFFICIENCY", state.stage, quality.score, "Initial sample allocation was scored against the best feasible information allocation.")]);
    return next;
  }
  if (state.stage === "EXPERIMENT_DECISION") {
    const choice = requireAction(state, action, "CHOOSE_OPTION");
    if (choice.option !== "A" && choice.option !== "B") return notAllowed(state, action);
    const correct = state.hiddenMeanA > state.hiddenMeanB ? "A" : "B";
    let next = appendAction(state, action, { stage: "PERTURBED_ALLOCATION" });
    next = appendEvidence(next, [evidence("NUMERICAL_CORRECTNESS", state.stage, choice.option === correct ? 100 : 0, "Experiment choice was checked against application-owned latent means.")]);
    return next;
  }
  if (state.stage === "PERTURBED_ALLOCATION") {
    const allocation = requireAction(state, action, "ALLOCATE_SAMPLE");
    validateExperimentalAllocation(allocation.a, allocation.b, state.config.perturbedCostA, state.config.perturbedCostB, state.config.totalBudget);
    const quality = allocationQuality(allocation.a, allocation.b, state.config.perturbedCostA, state.config.perturbedCostB, state.config.noiseA, state.config.noiseB, state.config.totalBudget);
    let next = appendAction(state, action, { stage: "COMPLETE", status: "COMPLETE" });
    next = appendEvidence(next, [
      evidence("ADAPTATION", state.stage, quality.score, "Adaptation quality reflects allocation efficiency under the changed experiment costs."),
      evidence("SAMPLE_EFFICIENCY", state.stage, quality.score, "Perturbed allocation was scored against the new feasible information frontier.")
    ]);
    return next;
  }
  return notAllowed(state, action);
}

function validateExperimentalAllocation(a: number, b: number, costA: number, costB: number, budget: number): void {
  if (a === 0 || b === 0) {
    throw new QuantResearchError("ACTION_NOT_ALLOWED", "Allocation must sample both experiments for a mean comparison");
  }
  if (a * costA + b * costB > budget) throw new QuantResearchError("RESOURCE_LIMIT_EXCEEDED", "Sample allocation exceeds the public experiment budget");
}

function transitionModel(state: ModelState, action: QuantResearchAction): ModelState {
  if (state.stage === "INITIAL_MODEL_CHOICE") {
    const choice = requireAction(state, action, "CHOOSE_OPTION");
    if (choice.option !== "CONSTANT" && choice.option !== "LINEAR") return notAllowed(state, action);
    let next = appendAction(state, action, { stage: "OUTLIER_MODEL_CHOICE", firstChoice: choice.option });
    next = appendEvidence(next, [evidence("NUMERICAL_CORRECTNESS", state.stage, choice.option === state.hiddenModel ? 100 : 0, "Initial model selection was checked against the generated latent model family.")]);
    return next;
  }
  if (state.stage === "OUTLIER_MODEL_CHOICE") {
    const choice = requireAction(state, action, "CHOOSE_OPTION");
    if (choice.option !== "CONSTANT" && choice.option !== "LINEAR") return notAllowed(state, action);
    const correct = choice.option === state.hiddenModel;
    let next = appendAction(state, action, { stage: "COMPLETE", status: "COMPLETE" });
    next = appendEvidence(next, [
      evidence("ROBUSTNESS", state.stage, correct ? 100 : 0, "Model selection was re-evaluated after a disclosed outlier perturbation."),
      evidence("CONSISTENCY", state.stage, correct && state.firstChoice === state.hiddenModel ? 100 : 0, "Consistency requires the same latent-family conclusion to be correct before and after the perturbation.")
    ]);
    return next;
  }
  return notAllowed(state, action);
}

function transitionOptimization(state: OptimizationState, action: QuantResearchAction): OptimizationState {
  if (state.stage === "BASE_OPTIMIZATION") {
    const parameters = requireAction(state, action, "SUBMIT_PARAMETERS");
    const [x, y] = parseOptimizationParameters(parameters.values);
    const feasible = isFeasible(x, y, state.config.budget, state.config.maxX, state.config.maxY);
    const value = feasible ? objective(x, y, state.coefficientX, state.coefficientY, state.basePenalty) : 0;
    const quality = feasible ? objectiveQuality(value, state.baseBestObjective) : 0;
    const qualityScore = feasible ? boundedRelativeScore(quality, value === state.baseBestObjective) : 0;
    let next = appendAction(state, action, { stage: "PERTURBED_OPTIMIZATION" });
    next = appendEvidence(next, [
      evidence("CONSTRAINT_DISCIPLINE", state.stage, feasible ? 100 : 0, "Submitted parameters were checked against all stated constraints."),
      evidence("OBJECTIVE_QUALITY", state.stage, qualityScore, "Objective quality was measured against the exact best feasible application-owned objective.")
    ]);
    return next;
  }
  if (state.stage === "PERTURBED_OPTIMIZATION") {
    const parameters = requireAction(state, action, "SUBMIT_PARAMETERS");
    const [x, y] = parseOptimizationParameters(parameters.values);
    const feasible = isFeasible(x, y, state.config.perturbedBudget, state.config.maxX, state.config.maxY);
    const value = feasible ? objective(x, y, state.coefficientX, state.coefficientY, state.config.perturbedPenalty) : 0;
    const quality = feasible ? objectiveQuality(value, state.perturbedBestObjective) : 0;
    const qualityScore = feasible ? boundedRelativeScore(quality, value === state.perturbedBestObjective) : 0;
    let next = appendAction(state, action, { stage: "COMPLETE", status: "COMPLETE" });
    next = appendEvidence(next, [
      evidence("CONSTRAINT_DISCIPLINE", state.stage, feasible ? 100 : 0, "Revised parameters were checked against the perturbed constraints."),
      evidence("OBJECTIVE_QUALITY", state.stage, qualityScore, "Perturbed objective quality was compared with the new exact optimum."),
      evidence("ADAPTATION", state.stage, qualityScore, "Adaptation quality reflects objective quality under the changed constraint and loss function.")
    ]);
    return next;
  }
  return notAllowed(state, action);
}

function parseOptimizationParameters(values: readonly number[]): readonly [number, number] {
  if (values.length !== 2) throw new QuantResearchError("ACTION_NOT_ALLOWED", "Optimization scenarios require exactly two parameters");
  const x = values[0];
  const y = values[1];
  if (x === undefined || y === undefined || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) {
    throw new QuantResearchError("ACTION_NOT_ALLOWED", "Optimization parameters must be nonnegative safe integers");
  }
  return [x, y];
}

function isFeasible(x: number, y: number, budget: number, maxX: number, maxY: number): boolean {
  return x <= maxX && y <= maxY && 2 * x + 3 * y <= budget;
}

function objectiveQuality(value: number, best: number): number {
  if (best <= 0) return value === best ? 1 : 0;
  return Math.max(0, Math.min(1, value / best));
}

function publicState(state: InternalState): QuantResearchPublicState {
  return {
    family: state.family,
    version: state.version,
    generatorVersion: state.generatorVersion,
    rngVersion: state.rngVersion,
    status: state.status,
    stage: state.stage,
    prompt: publicPrompt(state),
    visibleData: publicData(state),
    acceptedActionCount: state.acceptedActions.length,
    actionLimit: MAX_ACTIONS
  };
}

function publicPrompt(state: InternalState): string {
  switch (state.family) {
    case "BAYESIAN_UPDATING":
      if (state.stage === "PRIOR_ESTIMATE") return "Submit the prior predictive probability of success.";
      if (state.stage === "POSTERIOR_UPDATE") return "Update the success probability after the revealed Bernoulli observations.";
      if (state.stage === "PRIOR_PERTURBATION") return "Recompute the posterior probability using the changed prior and the same revealed observations.";
      return "Scenario complete.";
    case "SAMPLING_ESTIMATION":
      if (state.stage === "SAMPLING") return "Observations come from a finite population built from an unknown integer center plus bounded symmetric integer noise. Request observations, then estimate the center.";
      if (state.stage === "OUTLIER_PERTURBATION") return "One contaminated observation has been introduced. Submit a revised estimate of the unchanged latent center.";
      return "Scenario complete.";
    case "EXPERIMENTAL_ALLOCATION":
      if (state.stage === "INITIAL_ALLOCATION") return "Allocate samples across experiments A and B to minimize the variance of the estimated mean difference under the stated budget.";
      if (state.stage === "EXPERIMENT_DECISION") return "Choose the experiment with the larger latent mean using the revealed summaries.";
      if (state.stage === "PERTURBED_ALLOCATION") return "Experiment costs changed. Reallocate samples to minimize mean-difference variance under the same total budget.";
      return "Scenario complete.";
    case "MODEL_COMPARISON":
      if (state.stage === "INITIAL_MODEL_CHOICE") return "Choose which generating family is more plausible: a constant mean or a linear trend whose slope magnitude is at least the stated minimum.";
      if (state.stage === "OUTLIER_MODEL_CHOICE") return "One disclosed point has been perturbed as an outlier. Reassess the generating family using the baseline and perturbed observations.";
      return "Scenario complete.";
    case "CONSTRAINED_OPTIMIZATION":
      if (state.stage === "BASE_OPTIMIZATION") return "Choose nonnegative integer x and y to maximize the stated objective under the public constraints.";
      if (state.stage === "PERTURBED_OPTIMIZATION") return "The budget/interaction penalty changed. Submit revised integer parameters.";
      return "Scenario complete.";
  }
}

function datum(key: string, label: string, value: QuantResearchPublicDatum["value"]): QuantResearchPublicDatum {
  return { key, label, value };
}

function publicData(state: InternalState): readonly QuantResearchPublicDatum[] {
  switch (state.family) {
    case "BAYESIAN_UPDATING": {
      const base: QuantResearchPublicDatum[] = [
        datum("priorAlpha", "Prior alpha", state.config.priorAlpha),
        datum("priorBeta", "Prior beta", state.config.priorBeta)
      ];
      if (state.stage !== "PRIOR_ESTIMATE") {
        base.push(datum("successes", "Observed successes", state.successes));
        base.push(datum("failures", "Observed failures", state.observations.length - state.successes));
      }
      if (state.stage === "PRIOR_PERTURBATION" || state.status === "COMPLETE") {
        base.push(datum("perturbedPriorAlpha", "Changed prior alpha", state.config.perturbedPriorAlpha));
        base.push(datum("perturbedPriorBeta", "Changed prior beta", state.config.perturbedPriorBeta));
      }
      return base;
    }
    case "SAMPLING_ESTIMATION": {
      const values = [...state.revealed];
      if ((state.stage === "OUTLIER_PERTURBATION" || state.status === "COMPLETE") && state.outlier !== undefined) values.push(state.outlier);
      const perturbed = state.stage === "OUTLIER_PERTURBATION" || state.status === "COMPLETE";
      const data: QuantResearchPublicDatum[] = [
        datum("maxSamples", "Maximum observation budget", state.config.maxSamples),
        datum("populationSize", "Finite population size", state.config.populationSize),
        datum("noiseRadius", "Ordinary symmetric integer-noise radius", state.config.noiseRadius),
        datum("samplingWithoutReplacement", "Sampling without replacement", true),
        datum("observations", "Revealed observations", values),
        datum("contaminationIntroduced", "Contamination introduced", perturbed)
      ];
      if (perturbed && state.outlier !== undefined) {
        data.push(datum("baselineObservations", "Baseline observations before contamination", state.revealed));
        data.push(datum("contaminatedObservation", "Newly introduced contaminated observation", state.outlier));
      }
      return data;
    }
    case "EXPERIMENTAL_ALLOCATION": {
      const perturbed = state.stage === "PERTURBED_ALLOCATION" || state.status === "COMPLETE";
      const data: QuantResearchPublicDatum[] = [
        datum("totalBudget", "Total sample budget", state.config.totalBudget),
        datum("costA", "Current cost per A sample", perturbed ? state.config.perturbedCostA : state.config.costA),
        datum("costB", "Current cost per B sample", perturbed ? state.config.perturbedCostB : state.config.costB),
        datum("noiseA", "A discrete-uniform integer-noise radius", state.config.noiseA),
        datum("noiseB", "B discrete-uniform integer-noise radius", state.config.noiseB),
        datum("noiseModel", "Observation noise model", "INDEPENDENT_DISCRETE_UNIFORM_INTEGER"),
        datum("allocationObjective", "Allocation objective", "MINIMIZE_VARIANCE_OF_ESTIMATED_MEAN_DIFFERENCE")
      ];
      if (perturbed) {
        data.push(datum("baselineCostA", "Baseline cost per A sample", state.config.costA));
        data.push(datum("baselineCostB", "Baseline cost per B sample", state.config.costB));
      }
      if (state.summaryA !== undefined && state.summaryB !== undefined && state.initialAllocation !== undefined) {
        data.push(datum("sampleCountA", "Observed A sample count", state.initialAllocation.a));
        data.push(datum("sampleCountB", "Observed B sample count", state.initialAllocation.b));
        data.push(datum("sampleMeanA", "Observed A sample mean", state.summaryA));
        data.push(datum("sampleMeanB", "Observed B sample mean", state.summaryB));
      }
      return data;
    }
    case "MODEL_COMPARISON": {
      const perturbed = state.stage === "OUTLIER_MODEL_CHOICE" || state.status === "COMPLETE";
      const data: QuantResearchPublicDatum[] = [
        datum("x", "x observations", state.points.map((point) => point.x)),
        datum("y", perturbed ? "Perturbed y observations" : "y observations", (perturbed ? state.perturbedPoints : state.points).map((point) => point.y)),
        datum("noiseRadius", "Ordinary additive-noise radius", state.config.noiseRadius),
        datum("minimumLinearSlopeMagnitude", "Minimum linear-trend slope magnitude", state.config.noiseRadius + 2),
        datum("outlierIntroduced", "Outlier introduced", perturbed)
      ];
      if (perturbed) data.push(datum("baselineY", "Baseline y observations", state.points.map((point) => point.y)));
      return data;
    }
    case "CONSTRAINED_OPTIMIZATION": {
      const perturbed = state.stage === "PERTURBED_OPTIMIZATION" || state.status === "COMPLETE";
      const baseObjective = `${String(state.coefficientX)}*x + ${String(state.coefficientY)}*y - ${String(state.basePenalty)}*x*y`;
      const currentObjective = perturbed
        ? `${String(state.coefficientX)}*x + ${String(state.coefficientY)}*y - ${String(state.config.perturbedPenalty)}*x*y`
        : baseObjective;
      const data: QuantResearchPublicDatum[] = [
        datum("objective", "Current objective", currentObjective),
        datum("budget", "Current budget in 2*x + 3*y <= budget", perturbed ? state.config.perturbedBudget : state.config.budget),
        datum("maxX", "Maximum x", state.config.maxX),
        datum("maxY", "Maximum y", state.config.maxY)
      ];
      if (perturbed) {
        data.push(datum("baselineObjective", "Baseline objective", baseObjective));
        data.push(datum("baselineBudget", "Baseline budget", state.config.budget));
      }
      return data;
    }
  }
}

function resultFor(state: InternalState): QuantResearchResult {
  if (state.status !== "COMPLETE") {
    return {
      status: state.status,
      family: state.family,
      version: state.version,
      generatorVersion: state.generatorVersion,
      rngVersion: state.rngVersion,
      acceptedActionCount: state.acceptedActions.length,
      overallScore: 0,
      metrics: {},
      evidence: []
    };
  }
  const sums = new Map<QuantResearchEvidenceCategory, { total: number; count: number }>();
  for (const item of state.evidence) {
    const current = sums.get(item.category) ?? { total: 0, count: 0 };
    sums.set(item.category, { total: current.total + item.score, count: current.count + 1 });
  }
  const metrics: Partial<Record<QuantResearchEvidenceCategory, number>> = {};
  for (const [category, aggregate] of sums) {
    const categoryScores = state.evidence.filter((item) => item.category === category).map((item) => item.score);
    if (categoryScores.length !== aggregate.count) throw new Error("Evidence aggregation invariant violated");
    metrics[category] = aggregateScores(categoryScores);
  }
  const metricValues = Object.values(metrics);
  const overallScore = aggregateScores(metricValues);
  return {
    status: state.status,
    family: state.family,
    version: state.version,
    generatorVersion: state.generatorVersion,
    rngVersion: state.rngVersion,
    acceptedActionCount: state.acceptedActions.length,
    overallScore,
    metrics,
    evidence: clone(state.evidence)
  };
}

function validateGeneratedScenario(state: InternalState): void {
  switch (state.family) {
    case "BAYESIAN_UPDATING": {
      const prior = rational(state.config.priorAlpha, state.config.priorAlpha + state.config.priorBeta);
      const posterior = rational(
        state.config.priorAlpha + state.successes,
        state.config.priorAlpha + state.config.priorBeta + state.observations.length
      );
      const perturbedPosterior = rational(
        state.config.perturbedPriorAlpha + state.successes,
        state.config.perturbedPriorAlpha + state.config.perturbedPriorBeta + state.observations.length
      );
      if (compareRational(prior, posterior) === 0) {
        throw new QuantResearchError("INVALID_DEFINITION", "Generated Bayesian observations produce a vacuous posterior update");
      }
      const perturbationDistance = Math.abs(rationalToNumber(posterior) - rationalToNumber(perturbedPosterior));
      if (distanceWithin(perturbationDistance, 0.05)) {
        throw new QuantResearchError("INVALID_DEFINITION", "Generated Bayesian prior perturbation is not meaningfully score-separable");
      }
      break;
    }
    case "SAMPLING_ESTIMATION": {
      const reachable = state.sampleOrder
        .slice(0, state.config.maxSamples)
        .map((index) => state.hiddenPopulation[index])
        .filter((value): value is number => value !== undefined);
      if (reachable.length !== state.config.maxSamples || new Set(reachable).size < 2) {
        throw new QuantResearchError("INVALID_DEFINITION", "Generated sampling prefix lacks meaningful observation variation");
      }
      break;
    }
    case "EXPERIMENTAL_ALLOCATION": {
      const base = experimentalOptimum(
        state.config.costA,
        state.config.costB,
        state.config.noiseA,
        state.config.noiseB,
        state.config.totalBudget
      );
      const perturbed = experimentalOptimum(
        state.config.perturbedCostA,
        state.config.perturbedCostB,
        state.config.noiseA,
        state.config.noiseB,
        state.config.totalBudget
      );
      if (hasSharedPair(base.allocations, perturbed.allocations)) {
        throw new QuantResearchError("INVALID_DEFINITION", "Experiment cost perturbation leaves an optimal allocation unchanged");
      }
      const minA = Math.min(...state.sequenceA);
      const maxA = Math.max(...state.sequenceA);
      const minB = Math.min(...state.sequenceB);
      const maxB = Math.max(...state.sequenceB);
      const orderingIsUnambiguous = state.hiddenMeanA > state.hiddenMeanB ? minA > maxB : minB > maxA;
      if (!orderingIsUnambiguous) {
        throw new Error("Experimental observations can contradict the latent mean ordering");
      }
      break;
    }
    case "MODEL_COMPARISON":
      break;
    case "CONSTRAINED_OPTIMIZATION": {
      const base = optimalOptimizationPoints(
        state.config.budget,
        state.config.maxX,
        state.config.maxY,
        state.coefficientX,
        state.coefficientY,
        state.basePenalty
      );
      const perturbed = optimalOptimizationPoints(
        state.config.perturbedBudget,
        state.config.maxX,
        state.config.maxY,
        state.coefficientX,
        state.coefficientY,
        state.config.perturbedPenalty
      );
      if (hasSharedOptimizationPoint(base, perturbed)) {
        throw new QuantResearchError("INVALID_DEFINITION", "Optimization perturbation leaves an exact optimum unchanged");
      }
      break;
    }
  }
}

function assertExactActionHistory(
  state: InternalState,
  expectedKinds: readonly QuantResearchAction["kind"][],
  context: string
): void {
  if (
    state.acceptedActions.length !== expectedKinds.length ||
    expectedKinds.some((kind, index) => state.acceptedActions[index]?.kind !== kind)
  ) {
    throw new Error(context + " action-history invariant violated");
  }
}

function assertExactEvidenceHistory(
  state: InternalState,
  expected: readonly Readonly<{ category: QuantResearchEvidenceCategory; stage: string }>[],
  context: string
): void {
  if (
    state.evidence.length !== expected.length ||
    expected.some((item, index) => {
      const actual = state.evidence[index];
      return actual?.category !== item.category || actual.stage !== item.stage;
    })
  ) {
    throw new Error(context + " evidence-history invariant violated");
  }
}

function assertStateInvariants(state: InternalState): void {
  if ((state.status === "COMPLETE") !== (state.stage === "COMPLETE")) throw new Error("Scenario completion invariant violated");
  if (state.acceptedActions.length > MAX_ACTIONS) throw new Error("Action limit invariant violated");
  const ids = new Set(state.acceptedActions.map((action) => action.actionId));
  if (ids.size !== state.acceptedActions.length) throw new Error("Accepted action IDs are not unique");
  for (const item of state.evidence) {
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 100) throw new Error("Evidence score invariant violated");
    if (item.stage.length === 0 || item.summary.length === 0) throw new Error("Evidence metadata invariant violated");
  }

  switch (state.family) {
    case "BAYESIAN_UPDATING": {
      if (!["PRIOR_ESTIMATE", "POSTERIOR_UPDATE", "PRIOR_PERTURBATION", "COMPLETE"].includes(state.stage)) {
        throw new Error("Bayesian stage invariant violated");
      }
      if (state.observations.length !== state.config.observationCount) throw new Error("Bayesian observation-count invariant violated");
      if (state.observations.some((value) => typeof value !== "boolean")) throw new Error("Bayesian observation-type invariant violated");
      const successes = state.observations.filter(Boolean).length;
      if (state.successes !== successes) throw new Error("Bayesian success-count invariant violated");
      const bayesianKinds = {
        PRIOR_ESTIMATE: [],
        POSTERIOR_UPDATE: ["SUBMIT_PROBABILITY"],
        PRIOR_PERTURBATION: ["SUBMIT_PROBABILITY", "SUBMIT_PROBABILITY"],
        COMPLETE: ["SUBMIT_PROBABILITY", "SUBMIT_PROBABILITY", "SUBMIT_PROBABILITY"]
      } as const;
      const bayesianEvidence = {
        PRIOR_ESTIMATE: [],
        POSTERIOR_UPDATE: [{ category: "CALIBRATION", stage: "PRIOR_ESTIMATE" }],
        PRIOR_PERTURBATION: [
          { category: "CALIBRATION", stage: "PRIOR_ESTIMATE" },
          { category: "NUMERICAL_CORRECTNESS", stage: "POSTERIOR_UPDATE" }
        ],
        COMPLETE: [
          { category: "CALIBRATION", stage: "PRIOR_ESTIMATE" },
          { category: "NUMERICAL_CORRECTNESS", stage: "POSTERIOR_UPDATE" },
          { category: "ADAPTATION", stage: "PRIOR_PERTURBATION" },
          { category: "CONSISTENCY", stage: "PRIOR_PERTURBATION" }
        ]
      } as const;
      const bayesianStage = state.stage as keyof typeof bayesianKinds;
      assertExactActionHistory(state, bayesianKinds[bayesianStage], "Bayesian");
      assertExactEvidenceHistory(state, bayesianEvidence[bayesianStage], "Bayesian");
      break;
    }
    case "SAMPLING_ESTIMATION": {
      if (!["SAMPLING", "OUTLIER_PERTURBATION", "COMPLETE"].includes(state.stage)) throw new Error("Sampling stage invariant violated");
      if (state.hiddenPopulation.length !== state.config.populationSize || state.sampleOrder.length !== state.config.populationSize) {
        throw new Error("Sampling population-size invariant violated");
      }
      if (
        !Number.isSafeInteger(state.hiddenCenter) ||
        state.hiddenCenter < state.config.centerMin ||
        state.hiddenCenter > state.config.centerMax
      ) {
        throw new Error("Sampling hidden-center invariant violated");
      }
      if (state.hiddenPopulation.some((value) => !Number.isSafeInteger(value))) throw new Error("Sampling population numeric invariant violated");
      if (state.revealed.length > state.config.maxSamples) throw new Error("Sample budget invariant violated");
      const seenIndices = new Set(state.sampleOrder);
      if (
        seenIndices.size !== state.config.populationSize ||
        state.sampleOrder.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= state.config.populationSize)
      ) {
        throw new Error("Sampling permutation invariant violated");
      }
      if (state.hiddenPopulation.some((value) => Math.abs(value - state.hiddenCenter) > state.config.noiseRadius)) {
        throw new Error("Sampling noise-bound invariant violated");
      }
      for (let index = 0; index < state.revealed.length; index += 1) {
        const populationIndex = state.sampleOrder[index];
        if (populationIndex === undefined || state.hiddenPopulation[populationIndex] !== state.revealed[index]) {
          throw new Error("Sampling revealed-prefix invariant violated");
        }
      }
      const expectsOutlier = state.stage === "OUTLIER_PERTURBATION" || state.stage === "COMPLETE";
      if (
        expectsOutlier
          ? state.outlier === undefined || Math.abs(state.outlier - state.hiddenCenter) !== state.config.outlierShift
          : state.outlier !== undefined
      ) {
        throw new Error("Sampling perturbation invariant violated");
      }
      const terminalEstimateCount = state.stage === "SAMPLING" ? 0 : state.stage === "OUTLIER_PERTURBATION" ? 1 : 2;
      const requestCount = state.acceptedActions.length - terminalEstimateCount;
      if (requestCount < 0) throw new Error("Sampling action-history invariant violated");
      for (let index = 0; index < requestCount; index += 1) {
        if (state.acceptedActions[index]?.kind !== "REQUEST_OBSERVATION") {
          throw new Error("Sampling action-history invariant violated");
        }
      }
      for (let index = requestCount; index < state.acceptedActions.length; index += 1) {
        if (state.acceptedActions[index]?.kind !== "SUBMIT_NUMERIC_ESTIMATE") {
          throw new Error("Sampling action-history invariant violated");
        }
      }
      const requestedObservations = state.acceptedActions.slice(0, requestCount).reduce((total, action) => {
        if (action.kind !== "REQUEST_OBSERVATION") throw new Error("Sampling action-history invariant violated");
        return total + action.count;
      }, 0);
      if (requestedObservations !== state.revealed.length) throw new Error("Sampling request-total invariant violated");
      if (state.stage !== "SAMPLING" && state.revealed.length < 2) throw new Error("Sampling estimate-prerequisite invariant violated");
      const samplingEvidence = state.stage === "SAMPLING"
        ? []
        : state.stage === "OUTLIER_PERTURBATION"
          ? [
              { category: "NUMERICAL_CORRECTNESS" as const, stage: "SAMPLING" },
              { category: "SAMPLE_EFFICIENCY" as const, stage: "SAMPLING" }
            ]
          : [
              { category: "NUMERICAL_CORRECTNESS" as const, stage: "SAMPLING" },
              { category: "SAMPLE_EFFICIENCY" as const, stage: "SAMPLING" },
              { category: "ADAPTATION" as const, stage: "OUTLIER_PERTURBATION" },
              { category: "ROBUSTNESS" as const, stage: "OUTLIER_PERTURBATION" }
            ];
      assertExactEvidenceHistory(state, samplingEvidence, "Sampling");
      break;
    }
    case "EXPERIMENTAL_ALLOCATION": {
      if (!["INITIAL_ALLOCATION", "EXPERIMENT_DECISION", "PERTURBED_ALLOCATION", "COMPLETE"].includes(state.stage)) {
        throw new Error("Experimental stage invariant violated");
      }
      if (
        !Number.isSafeInteger(state.hiddenMeanA) ||
        !Number.isSafeInteger(state.hiddenMeanB) ||
        state.hiddenMeanA === state.hiddenMeanB
      ) {
        throw new Error("Experimental hidden-mean invariant violated");
      }
      if (state.sequenceA.length !== state.config.totalBudget || state.sequenceB.length !== state.config.totalBudget) {
        throw new Error("Experimental sequence-length invariant violated");
      }
      if (state.sequenceA.some((value) => !Number.isSafeInteger(value) || Math.abs(value - state.hiddenMeanA) > state.config.noiseA)) {
        throw new Error("Experiment A noise-bound invariant violated");
      }
      if (state.sequenceB.some((value) => !Number.isSafeInteger(value) || Math.abs(value - state.hiddenMeanB) > state.config.noiseB)) {
        throw new Error("Experiment B noise-bound invariant violated");
      }
      const expectsSummary = state.stage !== "INITIAL_ALLOCATION";
      if (
        expectsSummary
          ? state.initialAllocation === undefined || state.summaryA === undefined || state.summaryB === undefined
          : state.initialAllocation !== undefined || state.summaryA !== undefined || state.summaryB !== undefined
      ) {
        throw new Error("Experimental summary invariant violated");
      }
      if (state.initialAllocation !== undefined) {
        if (
          !Number.isSafeInteger(state.initialAllocation.a) ||
          !Number.isSafeInteger(state.initialAllocation.b) ||
          state.initialAllocation.a <= 0 ||
          state.initialAllocation.b <= 0 ||
          state.initialAllocation.a * state.config.costA + state.initialAllocation.b * state.config.costB > state.config.totalBudget ||
          state.initialAllocation.a > state.sequenceA.length ||
          state.initialAllocation.b > state.sequenceB.length
        ) {
          throw new Error("Experimental initial-allocation invariant violated");
        }
        if (
          state.summaryA !== mean(state.sequenceA.slice(0, state.initialAllocation.a)) ||
          state.summaryB !== mean(state.sequenceB.slice(0, state.initialAllocation.b))
        ) {
          throw new Error("Experimental summary-value invariant violated");
        }
      }
      const experimentalKinds = {
        INITIAL_ALLOCATION: [],
        EXPERIMENT_DECISION: ["ALLOCATE_SAMPLE"],
        PERTURBED_ALLOCATION: ["ALLOCATE_SAMPLE", "CHOOSE_OPTION"],
        COMPLETE: ["ALLOCATE_SAMPLE", "CHOOSE_OPTION", "ALLOCATE_SAMPLE"]
      } as const;
      const experimentalEvidence = {
        INITIAL_ALLOCATION: [],
        EXPERIMENT_DECISION: [{ category: "SAMPLE_EFFICIENCY", stage: "INITIAL_ALLOCATION" }],
        PERTURBED_ALLOCATION: [
          { category: "SAMPLE_EFFICIENCY", stage: "INITIAL_ALLOCATION" },
          { category: "NUMERICAL_CORRECTNESS", stage: "EXPERIMENT_DECISION" }
        ],
        COMPLETE: [
          { category: "SAMPLE_EFFICIENCY", stage: "INITIAL_ALLOCATION" },
          { category: "NUMERICAL_CORRECTNESS", stage: "EXPERIMENT_DECISION" },
          { category: "ADAPTATION", stage: "PERTURBED_ALLOCATION" },
          { category: "SAMPLE_EFFICIENCY", stage: "PERTURBED_ALLOCATION" }
        ]
      } as const;
      const experimentalStage = state.stage as keyof typeof experimentalKinds;
      assertExactActionHistory(state, experimentalKinds[experimentalStage], "Experimental");
      assertExactEvidenceHistory(state, experimentalEvidence[experimentalStage], "Experimental");
      break;
    }
    case "MODEL_COMPARISON": {
      if (!["INITIAL_MODEL_CHOICE", "OUTLIER_MODEL_CHOICE", "COMPLETE"].includes(state.stage)) throw new Error("Model stage invariant violated");
      if (
        !Number.isSafeInteger(state.hiddenIntercept) ||
        state.hiddenIntercept < -10 ||
        state.hiddenIntercept > 10 ||
        !Number.isSafeInteger(state.hiddenSlope) ||
        (state.hiddenModel === "CONSTANT"
          ? state.hiddenSlope !== 0
          : Math.abs(state.hiddenSlope) < state.config.noiseRadius + 2 ||
            Math.abs(state.hiddenSlope) > state.config.noiseRadius + 5)
      ) {
        throw new Error("Model generated-parameter invariant violated");
      }
      if (state.points.length !== state.config.observationCount || state.perturbedPoints.length !== state.config.observationCount) {
        throw new Error("Model observation-count invariant violated");
      }
      let changedPoints = 0;
      for (let index = 0; index < state.points.length; index += 1) {
        const original = state.points[index];
        const perturbed = state.perturbedPoints[index];
        if (original === undefined || perturbed === undefined || original.x !== index || perturbed.x !== index) {
          throw new Error("Model observation-index invariant violated");
        }
        if (!Number.isSafeInteger(original.y) || !Number.isSafeInteger(perturbed.y)) throw new Error("Model numeric invariant violated");
        const expectedTrend = state.hiddenIntercept + state.hiddenSlope * original.x;
        if (Math.abs(original.y - expectedTrend) > state.config.noiseRadius) {
          throw new Error("Model baseline noise-bound invariant violated");
        }
        if (original.y !== perturbed.y) {
          changedPoints += 1;
          if (index !== state.points.length - 1 || Math.abs(original.y - perturbed.y) !== state.config.outlierShift) {
            throw new Error("Model perturbation invariant violated");
          }
        }
      }
      if (changedPoints !== 1) throw new Error("Model outlier-count invariant violated");
      const firstPoint = state.points[0];
      const lastPoint = state.points[state.points.length - 1];
      if (firstPoint === undefined || lastPoint === undefined) throw new Error("Model endpoint invariant violated");
      const endpointDifference = Math.abs(lastPoint.y - firstPoint.y);
      if (state.hiddenModel === "CONSTANT" ? endpointDifference > 2 * state.config.noiseRadius : endpointDifference <= 2 * state.config.noiseRadius) {
        throw new Error("Model identifiability invariant violated");
      }
      const expectsChoice = state.stage !== "INITIAL_MODEL_CHOICE";
      if (expectsChoice ? state.firstChoice === undefined : state.firstChoice !== undefined) {
        throw new Error("Model first-choice invariant violated");
      }
      const modelKinds = {
        INITIAL_MODEL_CHOICE: [],
        OUTLIER_MODEL_CHOICE: ["CHOOSE_OPTION"],
        COMPLETE: ["CHOOSE_OPTION", "CHOOSE_OPTION"]
      } as const;
      const modelEvidence = {
        INITIAL_MODEL_CHOICE: [],
        OUTLIER_MODEL_CHOICE: [{ category: "NUMERICAL_CORRECTNESS", stage: "INITIAL_MODEL_CHOICE" }],
        COMPLETE: [
          { category: "NUMERICAL_CORRECTNESS", stage: "INITIAL_MODEL_CHOICE" },
          { category: "ROBUSTNESS", stage: "OUTLIER_MODEL_CHOICE" },
          { category: "CONSISTENCY", stage: "OUTLIER_MODEL_CHOICE" }
        ]
      } as const;
      const modelStage = state.stage as keyof typeof modelKinds;
      assertExactActionHistory(state, modelKinds[modelStage], "Model");
      assertExactEvidenceHistory(state, modelEvidence[modelStage], "Model");
      break;
    }
    case "CONSTRAINED_OPTIMIZATION": {
      if (!["BASE_OPTIMIZATION", "PERTURBED_OPTIMIZATION", "COMPLETE"].includes(state.stage)) throw new Error("Optimization stage invariant violated");
      if (
        !Number.isSafeInteger(state.coefficientX) ||
        !Number.isSafeInteger(state.coefficientY) ||
        state.coefficientX < 4 ||
        state.coefficientX > 12 ||
        state.coefficientY < 4 ||
        state.coefficientY > 12 ||
        !Number.isSafeInteger(state.basePenalty) ||
        state.basePenalty < 0 ||
        state.basePenalty > 4
      ) {
        throw new Error("Optimization generated-parameter invariant violated");
      }
      if (state.basePenalty === state.config.perturbedPenalty) throw new Error("Optimization perturbation invariant violated");
      const expectedBaseBest = bestObjective(
        state.config.budget,
        state.config.maxX,
        state.config.maxY,
        state.coefficientX,
        state.coefficientY,
        state.basePenalty
      );
      const expectedPerturbedBest = bestObjective(
        state.config.perturbedBudget,
        state.config.maxX,
        state.config.maxY,
        state.coefficientX,
        state.coefficientY,
        state.config.perturbedPenalty
      );
      if (
        state.baseBestObjective !== expectedBaseBest ||
        state.perturbedBestObjective !== expectedPerturbedBest ||
        state.baseBestObjective <= 0 ||
        state.perturbedBestObjective <= 0
      ) {
        throw new Error("Optimization optimum invariant violated");
      }
      const optimizationKinds = {
        BASE_OPTIMIZATION: [],
        PERTURBED_OPTIMIZATION: ["SUBMIT_PARAMETERS"],
        COMPLETE: ["SUBMIT_PARAMETERS", "SUBMIT_PARAMETERS"]
      } as const;
      const optimizationEvidence = {
        BASE_OPTIMIZATION: [],
        PERTURBED_OPTIMIZATION: [
          { category: "CONSTRAINT_DISCIPLINE", stage: "BASE_OPTIMIZATION" },
          { category: "OBJECTIVE_QUALITY", stage: "BASE_OPTIMIZATION" }
        ],
        COMPLETE: [
          { category: "CONSTRAINT_DISCIPLINE", stage: "BASE_OPTIMIZATION" },
          { category: "OBJECTIVE_QUALITY", stage: "BASE_OPTIMIZATION" },
          { category: "CONSTRAINT_DISCIPLINE", stage: "PERTURBED_OPTIMIZATION" },
          { category: "OBJECTIVE_QUALITY", stage: "PERTURBED_OPTIMIZATION" },
          { category: "ADAPTATION", stage: "PERTURBED_OPTIMIZATION" }
        ]
      } as const;
      const optimizationStage = state.stage as keyof typeof optimizationKinds;
      assertExactActionHistory(state, optimizationKinds[optimizationStage], "Optimization");
      assertExactEvidenceHistory(state, optimizationEvidence[optimizationStage], "Optimization");
      break;
    }
  }
}

export class QuantResearchEngine {
  #state: InternalState;
  #applyingAction = false;

  public constructor(definitionInput: unknown) {
    const definition = parseQuantResearchDefinition(definitionInput);
    this.#state = initialize(definition);
    assertStateInvariants(this.#state);
    validateGeneratedScenario(this.#state);
  }

  public applyAction(actionInput: unknown): QuantResearchTransition {
    if (this.#applyingAction) throw new QuantResearchError("ACTION_NOT_ALLOWED", "Reentrant candidate action application is not allowed");
    this.#applyingAction = true;
    try {
      if (this.#state.status === "COMPLETE") throw new QuantResearchError("SCENARIO_COMPLETE", "Scenario is already complete");
      if (this.#state.acceptedActions.length >= MAX_ACTIONS) throw new QuantResearchError("RESOURCE_LIMIT_EXCEEDED", "Maximum candidate action count reached");
      const action = parseQuantResearchAction(actionInput);
      if (this.#state.acceptedActions.some((accepted) => accepted.actionId === action.actionId)) {
        throw new QuantResearchError("DUPLICATE_ACTION_ID", "Candidate action ID has already been accepted");
      }
      const next = transition(this.#state, action);
      assertStateInvariants(next);
      const transitionState = clone(publicState(next));
      this.#state = next;
      return { accepted: true, actionId: action.actionId, state: transitionState };
    } finally {
      this.#applyingAction = false;
    }
  }

  public getState(): QuantResearchPublicState {
    return clone(publicState(this.#state));
  }

  public getResult(): QuantResearchResult {
    return clone(resultFor(this.#state));
  }

  public getDiagnostics(): QuantResearchDiagnostics {
    return {
      family: this.#state.family,
      version: this.#state.version,
      generatorVersion: this.#state.generatorVersion,
      rngVersion: this.#state.rngVersion,
      status: this.#state.status,
      stage: this.#state.stage,
      acceptedActionCount: this.#state.acceptedActions.length,
      evidenceCount: this.#state.evidence.length
    };
  }

  public getAcceptedActions(): readonly QuantResearchAction[] {
    return clone(this.#state.acceptedActions);
  }

}

export interface QuantResearchReplayOutput {
  readonly state: QuantResearchPublicState;
  readonly result: QuantResearchResult;
  readonly acceptedActions: readonly QuantResearchAction[];
}

function snapshotReplayActions(actionsInput: unknown): readonly QuantResearchAction[] {
  let isArray: boolean;
  try {
    isArray = Array.isArray(actionsInput);
  } catch {
    throw new QuantResearchError("INVALID_REPLAY", "Replay actions could not be safely inspected");
  }
  if (!isArray) throw new QuantResearchError("INVALID_REPLAY", "Replay actions must be an array");
  const replayActions = actionsInput as unknown[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(replayActions, "length");
  } catch {
    throw new QuantResearchError("INVALID_REPLAY", "Replay actions could not be safely inspected");
  }
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new QuantResearchError("INVALID_REPLAY", "Replay action length is invalid");
  }
  const length = lengthDescriptor.value as number;
  if (length > MAX_ACTIONS) throw new QuantResearchError("RESOURCE_LIMIT_EXCEEDED", "Replay action list exceeds the maximum size");
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(replayActions);
  } catch {
    throw new QuantResearchError("INVALID_REPLAY", "Replay actions could not be safely inspected");
  }
  if (keys.length !== length + 1) throw new QuantResearchError("INVALID_REPLAY", "Replay actions must be dense without extra properties");
  const allowedKeys = new Set(["length", ...Array.from({ length }, (_item, index) => String(index))]);
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new QuantResearchError("INVALID_REPLAY", "Replay actions contains unsupported properties");
    }
  }
  const snapshot: QuantResearchAction[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(replayActions, String(index));
    } catch {
      throw new QuantResearchError("INVALID_REPLAY", "Replay actions could not be safely inspected");
    }
    if (descriptor === undefined) throw new QuantResearchError("INVALID_REPLAY", "Replay actions must be dense");
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new QuantResearchError("INVALID_REPLAY", "Replay actions must contain only data properties");
    }
    snapshot.push(parseQuantResearchAction(descriptor.value));
  }
  return snapshot;
}

let replayingQuantResearch = false;

export function replayQuantResearch(definitionInput: unknown, actionsInput: unknown): QuantResearchReplayOutput {
  if (replayingQuantResearch) throw new QuantResearchError("INVALID_REPLAY", "Reentrant Quant Research replay is not allowed");
  replayingQuantResearch = true;
  try {
    const definition = parseQuantResearchDefinition(definitionInput);
    const engine = new QuantResearchEngine(definition);
    const actions = snapshotReplayActions(actionsInput);
    for (const action of actions) engine.applyAction(action);
    return { state: engine.getState(), result: engine.getResult(), acceptedActions: engine.getAcceptedActions() };
  } finally {
    replayingQuantResearch = false;
  }
}

export function getQuantResearchRegistry(): readonly Readonly<{
  family: QuantResearchScenarioDefinition["family"];
  version: typeof QUANT_RESEARCH_VERSION;
  generatorVersion: typeof QUANT_RESEARCH_GENERATOR_VERSION;
  rngVersion: typeof QUANT_RESEARCH_RNG_VERSION;
}>[] {
  return clone(REGISTRY);
}

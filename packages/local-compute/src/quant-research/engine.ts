import { DeterministicRng } from "./deterministic-rng.js";
import {
  QUANT_RESEARCH_FAMILIES,
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
const REGISTRY = QUANT_RESEARCH_FAMILIES.map((family) => ({ family, version: QUANT_RESEARCH_VERSION }));
assertUniqueQuantResearchRegistrations(REGISTRY);

type ScenarioStatus = "IN_PROGRESS" | "COMPLETE";

interface CommonState {
  readonly family: QuantResearchScenarioDefinition["family"];
  readonly version: typeof QUANT_RESEARCH_VERSION;
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function boundedScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
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
  const rng = new DeterministicRng(definition.seed, definition.family + "@" + definition.version);
  const common = {
    family: definition.family,
    version: definition.version,
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
      const gap = rng.nextInt(2, 8);
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
      const slope = hiddenModel === "LINEAR" ? rng.nextInt(2, 5) * (rng.nextInt(0, 1) === 0 ? -1 : 1) : 0;
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

function objective(x: number, y: number, coefficientX: number, coefficientY: number, penalty: number): number {
  return coefficientX * x + coefficientY * y - penalty * x * y;
}

function allocationEfficiency(
  a: number,
  b: number,
  costA: number,
  costB: number,
  noiseA: number,
  noiseB: number,
  budget: number,
  requireBothExperiments: boolean
): number {
  const information = a / (noiseA * noiseA) + b / (noiseB * noiseB);
  let best = 0;
  for (let candidateA = 0; candidateA <= 100; candidateA += 1) {
    for (let candidateB = 0; candidateB <= 100; candidateB += 1) {
      if (requireBothExperiments ? candidateA === 0 || candidateB === 0 : candidateA === 0 && candidateB === 0) continue;
      if (candidateA * costA + candidateB * costB > budget) continue;
      best = Math.max(best, candidateA / (noiseA * noiseA) + candidateB / (noiseB * noiseB));
    }
  }
  return best === 0 ? 0 : Math.min(1, information / best);
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
    const target = rationalToNumber(rational(state.config.priorAlpha + state.successes, state.config.priorAlpha + state.config.priorBeta + state.observations.length));
    let next = appendAction(state, action, { stage: "PRIOR_PERTURBATION" });
    next = appendEvidence(next, [evidence("NUMERICAL_CORRECTNESS", state.stage, distanceScore(Math.abs(submitted.value - target), 0.025), "Posterior update was checked with exact count arithmetic.")]);
    return next;
  }
  if (state.stage === "PRIOR_PERTURBATION") {
    const submitted = requireAction(state, action, "SUBMIT_PROBABILITY");
    const target = rationalToNumber(rational(state.config.perturbedPriorAlpha + state.successes, state.config.perturbedPriorAlpha + state.config.perturbedPriorBeta + state.observations.length));
    let next = appendAction(state, action, { stage: "COMPLETE", status: "COMPLETE" });
    const correctness = distanceScore(Math.abs(submitted.value - target), 0.025);
    next = appendEvidence(next, [
      evidence("ADAPTATION", state.stage, correctness, "The revised prior was incorporated into the candidate's update."),
      evidence("CONSISTENCY", state.stage, correctness, "The final probability remained internally consistent with the revealed evidence and changed assumption.")
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
      const efficiency = 100 - ((state.revealed.length - 2) / Math.max(1, state.config.maxSamples - 2)) * 40;
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
    validateExperimentalAllocation(allocation.a, allocation.b, state.config.costA, state.config.costB, state.config.totalBudget, true);
    const summaryA = allocation.a === 0 ? 0 : mean(state.sequenceA.slice(0, allocation.a));
    const summaryB = allocation.b === 0 ? 0 : mean(state.sequenceB.slice(0, allocation.b));
    const efficiency = allocationEfficiency(allocation.a, allocation.b, state.config.costA, state.config.costB, state.config.noiseA, state.config.noiseB, state.config.totalBudget, true);
    let next = appendAction(state, action, {
      stage: "EXPERIMENT_DECISION",
      initialAllocation: { a: allocation.a, b: allocation.b },
      summaryA,
      summaryB
    });
    next = appendEvidence(next, [evidence("SAMPLE_EFFICIENCY", state.stage, efficiency * 100, "Initial sample allocation was scored against the best feasible information allocation.")]);
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
    validateExperimentalAllocation(allocation.a, allocation.b, state.config.perturbedCostA, state.config.perturbedCostB, state.config.totalBudget, false);
    const efficiency = allocationEfficiency(allocation.a, allocation.b, state.config.perturbedCostA, state.config.perturbedCostB, state.config.noiseA, state.config.noiseB, state.config.totalBudget, false);
    let next = appendAction(state, action, { stage: "COMPLETE", status: "COMPLETE" });
    next = appendEvidence(next, [
      evidence("ADAPTATION", state.stage, efficiency * 100, "Adaptation quality reflects allocation efficiency under the changed experiment costs."),
      evidence("SAMPLE_EFFICIENCY", state.stage, efficiency * 100, "Perturbed allocation was scored against the new feasible information frontier.")
    ]);
    return next;
  }
  return notAllowed(state, action);
}

function validateExperimentalAllocation(a: number, b: number, costA: number, costB: number, budget: number, requireBothExperiments: boolean): void {
  if (requireBothExperiments && (a === 0 || b === 0)) {
    throw new QuantResearchError("ACTION_NOT_ALLOWED", "Initial allocation must sample both experiments before experiment comparison");
  }
  if (!requireBothExperiments && a === 0 && b === 0) {
    throw new QuantResearchError("ACTION_NOT_ALLOWED", "At least one experiment must receive samples");
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
      evidence("CONSISTENCY", state.stage, choice.option === state.firstChoice ? 100 : correct ? 80 : 20, "The second model choice was checked for coherent response to the perturbation.")
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
    let next = appendAction(state, action, { stage: "PERTURBED_OPTIMIZATION" });
    next = appendEvidence(next, [
      evidence("CONSTRAINT_DISCIPLINE", state.stage, feasible ? 100 : 0, "Submitted parameters were checked against all stated constraints."),
      evidence("OBJECTIVE_QUALITY", state.stage, quality * 100, "Objective quality was measured against the exact best feasible application-owned objective.")
    ]);
    return next;
  }
  if (state.stage === "PERTURBED_OPTIMIZATION") {
    const parameters = requireAction(state, action, "SUBMIT_PARAMETERS");
    const [x, y] = parseOptimizationParameters(parameters.values);
    const feasible = isFeasible(x, y, state.config.perturbedBudget, state.config.maxX, state.config.maxY);
    const value = feasible ? objective(x, y, state.coefficientX, state.coefficientY, state.config.perturbedPenalty) : 0;
    const quality = feasible ? objectiveQuality(value, state.perturbedBestObjective) : 0;
    let next = appendAction(state, action, { stage: "COMPLETE", status: "COMPLETE" });
    next = appendEvidence(next, [
      evidence("CONSTRAINT_DISCIPLINE", state.stage, feasible ? 100 : 0, "Revised parameters were checked against the perturbed constraints."),
      evidence("OBJECTIVE_QUALITY", state.stage, quality * 100, "Perturbed objective quality was compared with the new exact optimum."),
      evidence("ADAPTATION", state.stage, quality * 100, "Adaptation quality reflects objective quality under the changed constraint and loss function.")
    ]);
    return next;
  }
  return notAllowed(state, action);
}

function parseOptimizationParameters(values: readonly number[]): readonly [number, number] {
  if (values.length !== 2) throw new QuantResearchError("INVALID_ACTION", "Optimization scenarios require exactly two parameters");
  const x = values[0];
  const y = values[1];
  if (x === undefined || y === undefined || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) {
    throw new QuantResearchError("INVALID_ACTION", "Optimization parameters must be nonnegative safe integers");
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
      if (state.stage === "SAMPLING") return "Request a bounded number of observations, then submit an estimate of the latent population center.";
      if (state.stage === "OUTLIER_PERTURBATION") return "One contaminated observation has been introduced. Submit a revised estimate of the unchanged latent center.";
      return "Scenario complete.";
    case "EXPERIMENTAL_ALLOCATION":
      if (state.stage === "INITIAL_ALLOCATION") return "Allocate samples across experiments A and B under the stated budget.";
      if (state.stage === "EXPERIMENT_DECISION") return "Choose the experiment with the larger latent mean using the revealed summaries.";
      if (state.stage === "PERTURBED_ALLOCATION") return "Experiment costs changed. Reallocate samples under the same total budget.";
      return "Scenario complete.";
    case "MODEL_COMPARISON":
      if (state.stage === "INITIAL_MODEL_CHOICE") return "Choose whether a constant or linear model better explains the observations.";
      if (state.stage === "OUTLIER_MODEL_CHOICE") return "An outlier has been introduced. Reassess the model family.";
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
      return [
        datum("maxSamples", "Maximum observation budget", state.config.maxSamples),
        datum("observations", "Revealed observations", values),
        datum("contaminationIntroduced", "Contamination introduced", state.stage === "OUTLIER_PERTURBATION" || state.status === "COMPLETE")
      ];
    }
    case "EXPERIMENTAL_ALLOCATION": {
      const perturbed = state.stage === "PERTURBED_ALLOCATION" || state.status === "COMPLETE";
      const data: QuantResearchPublicDatum[] = [
        datum("totalBudget", "Total sample budget", state.config.totalBudget),
        datum("costA", "Current cost per A sample", perturbed ? state.config.perturbedCostA : state.config.costA),
        datum("costB", "Current cost per B sample", perturbed ? state.config.perturbedCostB : state.config.costB),
        datum("noiseA", "A noise bound", state.config.noiseA),
        datum("noiseB", "B noise bound", state.config.noiseB)
      ];
      if (state.summaryA !== undefined && state.summaryB !== undefined && state.initialAllocation !== undefined) {
        data.push(datum("sampleCountA", "Observed A sample count", state.initialAllocation.a));
        data.push(datum("sampleCountB", "Observed B sample count", state.initialAllocation.b));
        data.push(datum("sampleMeanA", "Observed A sample mean", state.summaryA));
        data.push(datum("sampleMeanB", "Observed B sample mean", state.summaryB));
      }
      return data;
    }
    case "MODEL_COMPARISON": {
      const points = state.stage === "OUTLIER_MODEL_CHOICE" || state.status === "COMPLETE" ? state.perturbedPoints : state.points;
      return [
        datum("x", "x observations", points.map((point) => point.x)),
        datum("y", "y observations", points.map((point) => point.y)),
        datum("outlierIntroduced", "Outlier introduced", state.stage === "OUTLIER_MODEL_CHOICE" || state.status === "COMPLETE")
      ];
    }
    case "CONSTRAINED_OPTIMIZATION": {
      const perturbed = state.stage === "PERTURBED_OPTIMIZATION" || state.status === "COMPLETE";
      return [
        datum("objective", "Objective", `${String(state.coefficientX)}*x + ${String(state.coefficientY)}*y - ${String(perturbed ? state.config.perturbedPenalty : state.basePenalty)}*x*y`),
        datum("budget", "Current budget in 2*x + 3*y <= budget", perturbed ? state.config.perturbedBudget : state.config.budget),
        datum("maxX", "Maximum x", state.config.maxX),
        datum("maxY", "Maximum y", state.config.maxY)
      ];
    }
  }
}

function resultFor(state: InternalState): QuantResearchResult {
  if (state.status !== "COMPLETE") {
    return {
      status: state.status,
      family: state.family,
      version: state.version,
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
  for (const [category, aggregate] of sums) metrics[category] = boundedScore(aggregate.total / aggregate.count);
  const overallScore = state.evidence.length === 0 ? 0 : boundedScore(state.evidence.reduce((sum, item) => sum + item.score, 0) / state.evidence.length);
  return {
    status: state.status,
    family: state.family,
    version: state.version,
    acceptedActionCount: state.acceptedActions.length,
    overallScore,
    metrics,
    evidence: clone(state.evidence)
  };
}

function assertStateInvariants(state: InternalState): void {
  if ((state.status === "COMPLETE") !== (state.stage === "COMPLETE")) throw new Error("Scenario completion invariant violated");
  if (state.acceptedActions.length > MAX_ACTIONS) throw new Error("Action limit invariant violated");
  const ids = new Set(state.acceptedActions.map((action) => action.actionId));
  if (ids.size !== state.acceptedActions.length) throw new Error("Accepted action IDs are not unique");
  for (const item of state.evidence) {
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 100) throw new Error("Evidence score invariant violated");
  }
  if (state.family === "SAMPLING_ESTIMATION" && state.revealed.length > state.config.maxSamples) throw new Error("Sample budget invariant violated");
}

export class QuantResearchEngine {
  private state: InternalState;
  public constructor(definitionInput: unknown) {
    const definition = parseQuantResearchDefinition(definitionInput);
    this.state = initialize(definition);
    assertStateInvariants(this.state);
  }

  public applyAction(actionInput: unknown): QuantResearchTransition {
    if (this.state.status === "COMPLETE") throw new QuantResearchError("SCENARIO_COMPLETE", "Scenario is already complete");
    if (this.state.acceptedActions.length >= MAX_ACTIONS) throw new QuantResearchError("RESOURCE_LIMIT_EXCEEDED", "Maximum candidate action count reached");
    const action = parseQuantResearchAction(actionInput);
    if (this.state.acceptedActions.some((accepted) => accepted.actionId === action.actionId)) {
      throw new QuantResearchError("DUPLICATE_ACTION_ID", "Candidate action ID has already been accepted");
    }
    const next = transition(this.state, action);
    assertStateInvariants(next);
    this.state = next;
    return { accepted: true, actionId: action.actionId, state: this.getState() };
  }

  public getState(): QuantResearchPublicState {
    return clone(publicState(this.state));
  }

  public getResult(): QuantResearchResult {
    return clone(resultFor(this.state));
  }

  public getDiagnostics(): QuantResearchDiagnostics {
    return {
      family: this.state.family,
      version: this.state.version,
      status: this.state.status,
      stage: this.state.stage,
      acceptedActionCount: this.state.acceptedActions.length,
      evidenceCount: this.state.evidence.length
    };
  }

  public getAcceptedActions(): readonly QuantResearchAction[] {
    return clone(this.state.acceptedActions);
  }

}

export interface QuantResearchReplayOutput {
  readonly state: QuantResearchPublicState;
  readonly result: QuantResearchResult;
  readonly acceptedActions: readonly QuantResearchAction[];
}

export function replayQuantResearch(definitionInput: unknown, actionsInput: readonly unknown[]): QuantResearchReplayOutput {
  if (!Array.isArray(actionsInput) || actionsInput.length > MAX_ACTIONS) {
    throw new QuantResearchError("RESOURCE_LIMIT_EXCEEDED", "Replay action list exceeds the maximum size");
  }
  const engine = new QuantResearchEngine(definitionInput);
  for (const action of actionsInput) engine.applyAction(action);
  return { state: engine.getState(), result: engine.getResult(), acceptedActions: engine.getAcceptedActions() };
}

export function getQuantResearchRegistry(): readonly Readonly<{ family: QuantResearchScenarioDefinition["family"]; version: typeof QUANT_RESEARCH_VERSION }>[] {
  return clone(REGISTRY);
}

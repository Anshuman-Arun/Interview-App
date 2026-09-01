export const QUANT_RESEARCH_VERSION = "1.0.0" as const;

export const QUANT_RESEARCH_FAMILIES = [
  "BAYESIAN_UPDATING",
  "SAMPLING_ESTIMATION",
  "EXPERIMENTAL_ALLOCATION",
  "MODEL_COMPARISON",
  "CONSTRAINED_OPTIMIZATION"
] as const;

export type QuantResearchFamily = (typeof QUANT_RESEARCH_FAMILIES)[number];

export interface BayesianUpdatingConfig {
  readonly priorAlpha: number;
  readonly priorBeta: number;
  readonly observationCount: number;
  readonly perturbedPriorAlpha: number;
  readonly perturbedPriorBeta: number;
}

export interface SamplingEstimationConfig {
  readonly maxSamples: number;
  readonly populationSize: number;
  readonly centerMin: number;
  readonly centerMax: number;
  readonly noiseRadius: number;
  readonly outlierShift: number;
}

export interface ExperimentalAllocationConfig {
  readonly totalBudget: number;
  readonly costA: number;
  readonly costB: number;
  readonly perturbedCostA: number;
  readonly perturbedCostB: number;
  readonly noiseA: number;
  readonly noiseB: number;
}

export interface ModelComparisonConfig {
  readonly observationCount: number;
  readonly noiseRadius: number;
  readonly outlierShift: number;
}

export interface ConstrainedOptimizationConfig {
  readonly budget: number;
  readonly perturbedBudget: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly perturbedPenalty: number;
}

export type QuantResearchScenarioDefinition =
  | Readonly<{ family: "BAYESIAN_UPDATING"; version: typeof QUANT_RESEARCH_VERSION; seed: number; config: BayesianUpdatingConfig }>
  | Readonly<{ family: "SAMPLING_ESTIMATION"; version: typeof QUANT_RESEARCH_VERSION; seed: number; config: SamplingEstimationConfig }>
  | Readonly<{ family: "EXPERIMENTAL_ALLOCATION"; version: typeof QUANT_RESEARCH_VERSION; seed: number; config: ExperimentalAllocationConfig }>
  | Readonly<{ family: "MODEL_COMPARISON"; version: typeof QUANT_RESEARCH_VERSION; seed: number; config: ModelComparisonConfig }>
  | Readonly<{ family: "CONSTRAINED_OPTIMIZATION"; version: typeof QUANT_RESEARCH_VERSION; seed: number; config: ConstrainedOptimizationConfig }>;

interface ActionBase {
  readonly actionId: string;
}

export type QuantResearchAction =
  | Readonly<ActionBase & { kind: "SUBMIT_PROBABILITY"; value: number }>
  | Readonly<ActionBase & { kind: "REQUEST_OBSERVATION"; count: number }>
  | Readonly<ActionBase & { kind: "SUBMIT_NUMERIC_ESTIMATE"; value: number }>
  | Readonly<ActionBase & { kind: "ALLOCATE_SAMPLE"; a: number; b: number }>
  | Readonly<ActionBase & { kind: "CHOOSE_OPTION"; option: "A" | "B" | "CONSTANT" | "LINEAR" }>
  | Readonly<ActionBase & { kind: "SUBMIT_PARAMETERS"; values: readonly number[] }>;

export type QuantResearchEvidenceCategory =
  | "NUMERICAL_CORRECTNESS"
  | "CALIBRATION"
  | "ADAPTATION"
  | "SAMPLE_EFFICIENCY"
  | "CONSISTENCY"
  | "OBJECTIVE_QUALITY"
  | "CONSTRAINT_DISCIPLINE"
  | "ROBUSTNESS";

export interface QuantResearchEvidence {
  readonly category: QuantResearchEvidenceCategory;
  readonly stage: string;
  readonly score: number;
  readonly summary: string;
}

export type QuantResearchPublicValue = number | string | boolean | readonly number[] | readonly string[];

export interface QuantResearchPublicDatum {
  readonly key: string;
  readonly label: string;
  readonly value: QuantResearchPublicValue;
}

export interface QuantResearchPublicState {
  readonly family: QuantResearchFamily;
  readonly version: typeof QUANT_RESEARCH_VERSION;
  readonly status: "IN_PROGRESS" | "COMPLETE";
  readonly stage: string;
  readonly prompt: string;
  readonly visibleData: readonly QuantResearchPublicDatum[];
  readonly acceptedActionCount: number;
  readonly actionLimit: number;
}

export interface QuantResearchResult {
  readonly status: "IN_PROGRESS" | "COMPLETE";
  readonly family: QuantResearchFamily;
  readonly version: typeof QUANT_RESEARCH_VERSION;
  readonly acceptedActionCount: number;
  readonly overallScore: number;
  readonly metrics: Readonly<Partial<Record<QuantResearchEvidenceCategory, number>>>;
  readonly evidence: readonly QuantResearchEvidence[];
}

export interface QuantResearchDiagnostics {
  readonly family: QuantResearchFamily;
  readonly version: typeof QUANT_RESEARCH_VERSION;
  readonly status: "IN_PROGRESS" | "COMPLETE";
  readonly stage: string;
  readonly acceptedActionCount: number;
  readonly evidenceCount: number;
}

export interface QuantResearchTransition {
  readonly accepted: true;
  readonly actionId: string;
  readonly state: QuantResearchPublicState;
}

export type QuantResearchErrorCode =
  | "INVALID_DEFINITION"
  | "INVALID_ACTION"
  | "ACTION_NOT_ALLOWED"
  | "DUPLICATE_ACTION_ID"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "SCENARIO_COMPLETE"
  | "INVALID_REGISTRY";

export class QuantResearchError extends Error {
  public readonly code: QuantResearchErrorCode;

  public constructor(code: QuantResearchErrorCode, message: string) {
    super(message);
    this.name = "QuantResearchError";
    this.code = code;
  }
}

const MAX_SEED = 0xffff_ffff;
const MAX_ACTION_VECTOR = 8;
const MAX_ABS_NUMERIC_INPUT = 1_000_000;
const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const REGISTRY_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/u;

function failDefinition(message: string): never {
  throw new QuantResearchError("INVALID_DEFINITION", message);
}

function failAction(message: string): never {
  throw new QuantResearchError("INVALID_ACTION", message);
}

function asRecord(value: unknown, context: string, fail: (message: string) => never): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(context + " must be an object");
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(context + " could not be safely inspected");
  }
  if (prototype !== Object.prototype && prototype !== null) fail(context + " must be a plain object");
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) fail(context + " must not contain accessor properties");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], context: string, fail: (message: string) => never): void {
  let actual: readonly PropertyKey[];
  try {
    actual = Reflect.ownKeys(record);
  } catch {
    fail(context + " could not be safely inspected");
  }
  if (actual.some((key) => typeof key !== "string")) fail(context + " contains an unsupported property key");
  const actualStrings = actual as readonly string[];
  if (actualStrings.length !== expected.length || expected.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
    fail(context + " contains missing or unknown fields");
  }
}

function finiteNumber(value: unknown, context: string, fail: (message: string) => never): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(context + " must be a finite number");
  return value;
}

function boundedFiniteNumber(value: unknown, min: number, max: number, context: string, fail: (message: string) => never): number {
  const number = finiteNumber(value, context, fail);
  if (number < min || number > max) fail(context + " is outside the allowed numeric range");
  return number;
}

function finiteNumberVector(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACTION_VECTOR) {
    failAction("values must contain between 1 and 8 entries");
  }
  const allowedKeys = new Set(["length", ...Array.from({ length: value.length }, (_item, index) => String(index))]);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    failAction("values could not be safely inspected");
  }
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) failAction("values contains unsupported properties");
  }
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) failAction("values must be a dense array");
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      failAction("values could not be safely inspected");
    }
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      failAction("values must contain only data properties");
    }
    result.push(boundedFiniteNumber(descriptor.value, -MAX_ABS_NUMERIC_INPUT, MAX_ABS_NUMERIC_INPUT, `values[${String(index)}]`, failAction));
  }
  return result;
}

function boundedInteger(value: unknown, min: number, max: number, context: string, fail: (message: string) => never): number {
  const number = finiteNumber(value, context, fail);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(context + " is outside the allowed integer range");
  return number;
}

function parseBayesianConfig(value: unknown): BayesianUpdatingConfig {
  const record = asRecord(value, "Bayesian config", failDefinition);
  assertExactKeys(record, ["priorAlpha", "priorBeta", "observationCount", "perturbedPriorAlpha", "perturbedPriorBeta"], "Bayesian config", failDefinition);
  const priorAlpha = boundedInteger(record.priorAlpha, 1, 100, "priorAlpha", failDefinition);
  const priorBeta = boundedInteger(record.priorBeta, 1, 100, "priorBeta", failDefinition);
  const perturbedPriorAlpha = boundedInteger(record.perturbedPriorAlpha, 1, 100, "perturbedPriorAlpha", failDefinition);
  const perturbedPriorBeta = boundedInteger(record.perturbedPriorBeta, 1, 100, "perturbedPriorBeta", failDefinition);
  if (priorAlpha === perturbedPriorAlpha && priorBeta === perturbedPriorBeta) {
    failDefinition("Perturbed Bayesian prior must differ from the initial prior");
  }
  return {
    priorAlpha,
    priorBeta,
    observationCount: boundedInteger(record.observationCount, 2, 32, "observationCount", failDefinition),
    perturbedPriorAlpha,
    perturbedPriorBeta
  };
}

function parseSamplingConfig(value: unknown): SamplingEstimationConfig {
  const record = asRecord(value, "Sampling config", failDefinition);
  assertExactKeys(record, ["maxSamples", "populationSize", "centerMin", "centerMax", "noiseRadius", "outlierShift"], "Sampling config", failDefinition);
  const maxSamples = boundedInteger(record.maxSamples, 2, 32, "maxSamples", failDefinition);
  const populationSize = boundedInteger(record.populationSize, 8, 128, "populationSize", failDefinition);
  if (maxSamples > populationSize) failDefinition("maxSamples cannot exceed populationSize");
  const centerMin = boundedInteger(record.centerMin, -100, 100, "centerMin", failDefinition);
  const centerMax = boundedInteger(record.centerMax, -100, 100, "centerMax", failDefinition);
  if (centerMin > centerMax) failDefinition("centerMin cannot exceed centerMax");
  const noiseRadius = boundedInteger(record.noiseRadius, 0, 20, "noiseRadius", failDefinition);
  const outlierShift = boundedInteger(record.outlierShift, 1, 50, "outlierShift", failDefinition);
  if (outlierShift <= noiseRadius) failDefinition("outlierShift must exceed the ordinary sampling noise radius");
  return {
    maxSamples,
    populationSize,
    centerMin,
    centerMax,
    noiseRadius,
    outlierShift
  };
}

function parseExperimentalConfig(value: unknown): ExperimentalAllocationConfig {
  const record = asRecord(value, "Experimental allocation config", failDefinition);
  assertExactKeys(record, ["totalBudget", "costA", "costB", "perturbedCostA", "perturbedCostB", "noiseA", "noiseB"], "Experimental allocation config", failDefinition);
  const totalBudget = boundedInteger(record.totalBudget, 4, 100, "totalBudget", failDefinition);
  const costA = boundedInteger(record.costA, 1, 20, "costA", failDefinition);
  const costB = boundedInteger(record.costB, 1, 20, "costB", failDefinition);
  const perturbedCostA = boundedInteger(record.perturbedCostA, 1, 20, "perturbedCostA", failDefinition);
  const perturbedCostB = boundedInteger(record.perturbedCostB, 1, 20, "perturbedCostB", failDefinition);
  if (costA + costB > totalBudget) failDefinition("Initial budget must allow at least one sample from each experiment");
  if (Math.min(perturbedCostA, perturbedCostB) > totalBudget) failDefinition("Perturbed costs leave no feasible sample allocation");
  if (costA === perturbedCostA && costB === perturbedCostB) failDefinition("Perturbed experiment costs must differ from the initial costs");
  return {
    totalBudget,
    costA,
    costB,
    perturbedCostA,
    perturbedCostB,
    noiseA: boundedInteger(record.noiseA, 1, 10, "noiseA", failDefinition),
    noiseB: boundedInteger(record.noiseB, 1, 10, "noiseB", failDefinition)
  };
}

function parseModelConfig(value: unknown): ModelComparisonConfig {
  const record = asRecord(value, "Model comparison config", failDefinition);
  assertExactKeys(record, ["observationCount", "noiseRadius", "outlierShift"], "Model comparison config", failDefinition);
  const noiseRadius = boundedInteger(record.noiseRadius, 0, 10, "noiseRadius", failDefinition);
  const outlierShift = boundedInteger(record.outlierShift, 1, 50, "outlierShift", failDefinition);
  if (outlierShift <= 2 * noiseRadius) failDefinition("outlierShift must move the perturbed point outside the ordinary model-noise envelope");
  return {
    observationCount: boundedInteger(record.observationCount, 6, 30, "observationCount", failDefinition),
    noiseRadius,
    outlierShift
  };
}

function parseOptimizationConfig(value: unknown): ConstrainedOptimizationConfig {
  const record = asRecord(value, "Optimization config", failDefinition);
  assertExactKeys(record, ["budget", "perturbedBudget", "maxX", "maxY", "perturbedPenalty"], "Optimization config", failDefinition);
  return {
    budget: boundedInteger(record.budget, 5, 60, "budget", failDefinition),
    perturbedBudget: boundedInteger(record.perturbedBudget, 5, 60, "perturbedBudget", failDefinition),
    maxX: boundedInteger(record.maxX, 1, 60, "maxX", failDefinition),
    maxY: boundedInteger(record.maxY, 1, 60, "maxY", failDefinition),
    perturbedPenalty: boundedInteger(record.perturbedPenalty, 0, 20, "perturbedPenalty", failDefinition)
  };
}

export function parseQuantResearchDefinition(input: unknown): QuantResearchScenarioDefinition {
  const record = asRecord(input, "Scenario definition", failDefinition);
  assertExactKeys(record, ["family", "version", "seed", "config"], "Scenario definition", failDefinition);
  if (record.version !== QUANT_RESEARCH_VERSION) failDefinition("Unsupported scenario version");
  const seed = boundedInteger(record.seed, 0, MAX_SEED, "seed", failDefinition);
  switch (record.family) {
    case "BAYESIAN_UPDATING":
      return { family: record.family, version: QUANT_RESEARCH_VERSION, seed, config: parseBayesianConfig(record.config) };
    case "SAMPLING_ESTIMATION":
      return { family: record.family, version: QUANT_RESEARCH_VERSION, seed, config: parseSamplingConfig(record.config) };
    case "EXPERIMENTAL_ALLOCATION":
      return { family: record.family, version: QUANT_RESEARCH_VERSION, seed, config: parseExperimentalConfig(record.config) };
    case "MODEL_COMPARISON":
      return { family: record.family, version: QUANT_RESEARCH_VERSION, seed, config: parseModelConfig(record.config) };
    case "CONSTRAINED_OPTIMIZATION":
      return { family: record.family, version: QUANT_RESEARCH_VERSION, seed, config: parseOptimizationConfig(record.config) };
    default:
      failDefinition("Unknown scenario family");
  }
}

function parseActionId(value: unknown): string {
  if (typeof value !== "string" || !ACTION_ID_PATTERN.test(value)) failAction("actionId must be 1-64 safe identifier characters");
  return value;
}

export function parseQuantResearchAction(input: unknown): QuantResearchAction {
  const record = asRecord(input, "Candidate action", failAction);
  if (typeof record.kind !== "string") failAction("Candidate action kind is required");
  switch (record.kind) {
    case "SUBMIT_PROBABILITY": {
      assertExactKeys(record, ["actionId", "kind", "value"], "Candidate action", failAction);
      const value = finiteNumber(record.value, "probability", failAction);
      if (value < 0 || value > 1) failAction("probability must be between 0 and 1");
      return { actionId: parseActionId(record.actionId), kind: record.kind, value };
    }
    case "REQUEST_OBSERVATION":
      assertExactKeys(record, ["actionId", "kind", "count"], "Candidate action", failAction);
      return { actionId: parseActionId(record.actionId), kind: record.kind, count: boundedInteger(record.count, 1, 32, "count", failAction) };
    case "SUBMIT_NUMERIC_ESTIMATE":
      assertExactKeys(record, ["actionId", "kind", "value"], "Candidate action", failAction);
      return {
        actionId: parseActionId(record.actionId),
        kind: record.kind,
        value: boundedFiniteNumber(record.value, -MAX_ABS_NUMERIC_INPUT, MAX_ABS_NUMERIC_INPUT, "estimate", failAction)
      };
    case "ALLOCATE_SAMPLE":
      assertExactKeys(record, ["actionId", "kind", "a", "b"], "Candidate action", failAction);
      return {
        actionId: parseActionId(record.actionId),
        kind: record.kind,
        a: boundedInteger(record.a, 0, 100, "allocation a", failAction),
        b: boundedInteger(record.b, 0, 100, "allocation b", failAction)
      };
    case "CHOOSE_OPTION":
      assertExactKeys(record, ["actionId", "kind", "option"], "Candidate action", failAction);
      if (record.option !== "A" && record.option !== "B" && record.option !== "CONSTANT" && record.option !== "LINEAR") {
        failAction("option is not recognized");
      }
      return { actionId: parseActionId(record.actionId), kind: record.kind, option: record.option };
    case "SUBMIT_PARAMETERS": {
      assertExactKeys(record, ["actionId", "kind", "values"], "Candidate action", failAction);
      return { actionId: parseActionId(record.actionId), kind: record.kind, values: finiteNumberVector(record.values) };
    }
    default:
      failAction("Unknown candidate action kind");
  }
}

export interface QuantResearchFamilyRegistration {
  readonly family: QuantResearchFamily;
  readonly version: string;
}

export function assertUniqueQuantResearchRegistrations(registrationsInput: unknown): void {
  if (!Array.isArray(registrationsInput) || registrationsInput.length === 0 || registrationsInput.length > QUANT_RESEARCH_FAMILIES.length) {
    throw new QuantResearchError("INVALID_REGISTRY", "Scenario registry size is invalid");
  }
  const seen = new Set<string>();
  for (const entry of registrationsInput) {
    let registration: Record<string, unknown>;
    try {
      registration = asRecord(entry, "Scenario registry entry", (message) => {
        throw new QuantResearchError("INVALID_REGISTRY", message);
      });
      assertExactKeys(registration, ["family", "version"], "Scenario registry entry", (message) => {
        throw new QuantResearchError("INVALID_REGISTRY", message);
      });
    } catch (error) {
      if (error instanceof QuantResearchError) throw error;
      throw new QuantResearchError("INVALID_REGISTRY", "Scenario registry entry is invalid");
    }
    if (
      typeof registration.family !== "string" ||
      !QUANT_RESEARCH_FAMILIES.includes(registration.family as QuantResearchFamily) ||
      typeof registration.version !== "string" ||
      !REGISTRY_VERSION_PATTERN.test(registration.version)
    ) {
      throw new QuantResearchError("INVALID_REGISTRY", "Scenario registry entry is invalid");
    }
    const key = registration.family + "@" + registration.version;
    if (seen.has(key)) throw new QuantResearchError("INVALID_REGISTRY", "Duplicate scenario family/version registration");
    seen.add(key);
  }
}

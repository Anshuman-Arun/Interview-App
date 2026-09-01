import { z } from "zod";
import {
  type MarketState,
  type OrderFill,
  type PositionRiskLimits,
  type QuotePair,
  PositionRiskLimitsSchema,
  QuotePairSchema
} from "../../domain/src/index.js";
import { calculateMarketMakingScore } from "./market-maker.js";
import { LimitOrderBook } from "./order-book.js";
import { type PortfolioSnapshot, PortfolioTracker } from "./portfolio-tracker.js";
import { SeededRandom } from "./seeded-random.js";

export const QuantTraderScenarioFamilySchema = z.enum([
  "BASIC_MARKET_MAKING",
  "FAIR_VALUE_UPDATES",
  "INVENTORY_PRESSURE",
  "ADVERSE_SELECTION",
  "RISK_MANAGEMENT"
]);
export type QuantTraderScenarioFamily = z.infer<typeof QuantTraderScenarioFamilySchema>;

function positiveSafeIntegerSchema(message: string) {
  return z.number().refine(
    (value) => Number.isSafeInteger(value) && value > 0,
    { message }
  );
}

function finitePositiveNumberSchema(message: string) {
  return z.number().refine(
    (value) => Number.isFinite(value) && value > 0,
    { message }
  );
}

const PositiveSafeIntegerSchema = positiveSafeIntegerSchema(
  "Expected a positive safe integer"
);
const FinitePositiveNumberSchema = finitePositiveNumberSchema(
  "Expected a finite positive number"
);
const FiniteNonnegativeNumberSchema = z.number().refine(
  (value) => Number.isFinite(value) && value >= 0,
  { message: "Expected a finite non-negative number" }
);
const ProbabilitySchema = z.number().refine(
  (value) => Number.isFinite(value) && value >= 0 && value <= 1,
  { message: "Expected a probability between 0 and 1" }
);

export const QuantFairValueUpdateSchema = z.object({
  round: PositiveSafeIntegerSchema,
  fairValue: FinitePositiveNumberSchema,
  label: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: "Update label must contain non-whitespace text"
  }).optional()
}).strict();
export type QuantFairValueUpdate = z.infer<typeof QuantFairValueUpdateSchema>;

const QuantRiskLimitOverridesSchema = z.object({
  maxPosition: PositiveSafeIntegerSchema.optional(),
  maxDrawdown: FinitePositiveNumberSchema.optional(),
  stopLossThreshold: FinitePositiveNumberSchema.optional()
}).strict();

export const QuantTraderScenarioConfigSchema = z.object({
  family: QuantTraderScenarioFamilySchema,
  seed: z.number().int().refine(Number.isSafeInteger, { message: "seed must be a safe integer" }),
  rounds: positiveSafeIntegerSchema("rounds must be a positive safe integer").optional(),
  initialCash: FiniteNonnegativeNumberSchema.optional(),
  fairValue: finitePositiveNumberSchema("fairValue must be a finite positive number").optional(),
  tickSize: finitePositiveNumberSchema("tickSize must be a finite positive number").optional(),
  maxQuoteSize: positiveSafeIntegerSchema("maxQuoteSize must be a positive safe integer").optional(),
  noiseTraderProbability: ProbabilitySchema.optional(),
  informedTraderProbability: ProbabilitySchema.optional(),
  noiseBuyProbability: ProbabilitySchema.optional(),
  noiseTradeSize: positiveSafeIntegerSchema("noiseTradeSize must be a positive safe integer").optional(),
  maxNoiseSpread: finitePositiveNumberSchema("maxNoiseSpread must be a finite positive number").optional(),
  hardPositionLimit: z.boolean().optional(),
  stopOnRiskBreach: z.boolean().optional(),
  riskLimits: QuantRiskLimitOverridesSchema.optional(),
  fairValueUpdates: z.array(QuantFairValueUpdateSchema).optional()
}).strict().superRefine((config, context) => {
  const defaults = familyDefaults(config.family);
  const noiseProbability = config.noiseTraderProbability ?? defaults.noiseTraderProbability;
  const informedProbability = config.informedTraderProbability ?? defaults.informedTraderProbability;
  if (noiseProbability + informedProbability > 1) {
    context.addIssue({
      code: "custom",
      path: ["noiseTraderProbability"],
      message: "noiseTraderProbability + informedTraderProbability must be <= 1"
    });
  }

  const resolvedRisk: PositionRiskLimits = {
    maxPosition: config.riskLimits?.maxPosition ?? defaults.riskLimits.maxPosition,
    maxDrawdown: config.riskLimits?.maxDrawdown ?? defaults.riskLimits.maxDrawdown,
    stopLossThreshold:
      config.riskLimits?.stopLossThreshold ?? defaults.riskLimits.stopLossThreshold
  };
  if (resolvedRisk.stopLossThreshold > resolvedRisk.maxDrawdown) {
    context.addIssue({
      code: "custom",
      path: ["riskLimits", "stopLossThreshold"],
      message: "stopLossThreshold must not exceed maxDrawdown"
    });
  }

  const rounds = config.rounds ?? defaults.rounds;
  const seenRounds = new Set<number>();
  for (const update of config.fairValueUpdates ?? []) {
    if (update.round > rounds) {
      context.addIssue({
        code: "custom",
        path: ["fairValueUpdates"],
        message: "fairValueUpdates rounds must fall within the scenario"
      });
    }
    if (seenRounds.has(update.round)) {
      context.addIssue({
        code: "custom",
        path: ["fairValueUpdates"],
        message: "Only one fairValueUpdate is allowed per round"
      });
    }
    seenRounds.add(update.round);
  }
});
export type QuantTraderScenarioConfig = z.infer<typeof QuantTraderScenarioConfigSchema>;

interface ResolvedQuantTraderScenarioConfig {
  readonly family: QuantTraderScenarioFamily;
  readonly seed: number;
  readonly rounds: number;
  readonly initialCash: number;
  readonly fairValue: number;
  readonly tickSize: number;
  readonly maxQuoteSize: number;
  readonly noiseTraderProbability: number;
  readonly informedTraderProbability: number;
  readonly noiseBuyProbability: number;
  readonly noiseTradeSize: number;
  readonly maxNoiseSpread: number;
  readonly hardPositionLimit: boolean;
  readonly stopOnRiskBreach: boolean;
  readonly riskLimits: PositionRiskLimits;
  readonly fairValueUpdates: readonly QuantFairValueUpdate[];
}

export const QuantStudentActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("QUOTE"),
    quote: QuotePairSchema
  }).strict(),
  z.object({
    type: z.literal("PASS")
  }).strict()
]);
export type QuantStudentAction = z.infer<typeof QuantStudentActionSchema>;

export type QuantOrderFlowType = "INFORMED" | "NOISE" | "NO_TRADE";
export type QuantScenarioStatus = "ACTIVE" | "COMPLETED" | "RISK_STOPPED";
export type QuantScenarioPhase = "AWAITING_ACTION" | "READY_TO_ADVANCE" | "COMPLETE";

export interface QuantMarketEvent {
  readonly type: "FAIR_VALUE_UPDATE";
  readonly round: number;
  readonly previousFairValue: number;
  readonly fairValue: number;
  readonly label: string;
}

export interface QuantRiskBreach {
  readonly round: number;
  readonly source: "POST_ROUND" | "FAIR_VALUE_UPDATE";
  readonly reason: string;
}

export interface QuantRoundEvidence {
  readonly round: number;
  readonly fairValue: number;
  readonly marketEvents: readonly QuantMarketEvent[];
  readonly studentAction: QuantStudentAction;
  readonly orderFlowType: QuantOrderFlowType;
  readonly incomingMarketSide?: "BUY" | "SELL";
  readonly studentFills: readonly OrderFill[];
  readonly marketStateAfterAction: MarketState;
  readonly portfolio: PortfolioSnapshot;
  readonly riskBreached: boolean;
  readonly riskReason?: string;
  readonly accountingInvariantHolds: boolean;
  readonly rngDrawCount: number;
}

export interface QuantQuoteRequest {
  readonly round: number;
  readonly fairValue: number;
  readonly tickSize: number;
  readonly maxQuoteSize: number;
  readonly hardPositionLimit: boolean;
  readonly maxPosition: number;
}

export interface QuantTraderScenarioState {
  readonly family: QuantTraderScenarioFamily;
  readonly seed: number;
  readonly status: QuantScenarioStatus;
  readonly phase: QuantScenarioPhase;
  readonly currentRound: number;
  readonly plannedRounds: number;
  readonly fairValue: number;
  readonly marketState: MarketState;
  readonly portfolio: PortfolioSnapshot;
  readonly currentRoundEvents: readonly QuantMarketEvent[];
  readonly quoteRequest?: QuantQuoteRequest;
  readonly pendingAction?: QuantStudentAction;
  readonly riskBreaches: readonly QuantRiskBreach[];
  readonly history: readonly QuantRoundEvidence[];
}

export interface QuantTraderScenarioResult {
  readonly family: QuantTraderScenarioFamily;
  readonly seed: number;
  readonly completionStatus: "COMPLETED" | "RISK_STOPPED";
  readonly plannedRounds: number;
  readonly roundsCompleted: number;
  readonly completionRate: number;
  readonly finalFairValue: number;
  readonly finalPortfolio: PortfolioSnapshot;
  readonly tradeCount: number;
  readonly fillVolume: number;
  readonly averageSpread: number;
  readonly quoteParticipationRate: number;
  readonly riskBreaches: readonly QuantRiskBreach[];
  readonly informedFlowCount: number;
  readonly noiseFlowCount: number;
  readonly adverseSelectionPnL: number;
  readonly accountingInvariantHolds: boolean;
  readonly objectiveScore: number;
  readonly history: readonly QuantRoundEvidence[];
}

export type QuantTraderActionErrorCode =
  | "SCENARIO_COMPLETE"
  | "ACTION_ALREADY_SUBMITTED"
  | "ACTION_REQUIRED"
  | "RESULT_NOT_READY"
  | "INVALID_ACTION"
  | "INVALID_QUOTE"
  | "INVALID_TICK"
  | "QUOTE_SIZE_LIMIT"
  | "HARD_POSITION_LIMIT";

export class QuantTraderActionError extends Error {
  public readonly code: QuantTraderActionErrorCode;

  public constructor(code: QuantTraderActionErrorCode, message: string) {
    super(message);
    this.name = "QuantTraderActionError";
    this.code = code;
  }
}

const DEFAULT_RISK_LIMITS: PositionRiskLimits = {
  maxPosition: 20,
  maxDrawdown: 250,
  stopLossThreshold: 150
};

function assertFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a finite positive number`);
}

function assertProbability(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function familyDefaults(family: QuantTraderScenarioFamily): Omit<ResolvedQuantTraderScenarioConfig, "seed" | "fairValueUpdates"> {
  const base = {
    family,
    rounds: 8,
    initialCash: 1_000,
    fairValue: 100,
    tickSize: 0.5,
    maxQuoteSize: 10,
    noiseTraderProbability: 0.75,
    informedTraderProbability: 0.15,
    noiseBuyProbability: 0.5,
    noiseTradeSize: 1,
    maxNoiseSpread: 8,
    hardPositionLimit: false,
    stopOnRiskBreach: false,
    riskLimits: DEFAULT_RISK_LIMITS
  } as const;

  switch (family) {
    case "BASIC_MARKET_MAKING":
      return base;
    case "FAIR_VALUE_UPDATES":
      return { ...base, noiseTraderProbability: 0.7, informedTraderProbability: 0.2 };
    case "INVENTORY_PRESSURE":
      return { ...base, noiseTraderProbability: 0.9, informedTraderProbability: 0.05, noiseBuyProbability: 0.15 };
    case "ADVERSE_SELECTION":
      return { ...base, noiseTraderProbability: 0.3, informedTraderProbability: 0.6 };
    case "RISK_MANAGEMENT":
      return {
        ...base,
        rounds: 6,
        maxQuoteSize: 4,
        noiseTraderProbability: 0.85,
        informedTraderProbability: 0.1,
        hardPositionLimit: true,
        stopOnRiskBreach: true,
        riskLimits: { maxPosition: 4, maxDrawdown: 60, stopLossThreshold: 40 }
      };
  }
}

function generateFairValueUpdates(seed: number, rounds: number, initialFairValue: number): readonly QuantFairValueUpdate[] {
  const random = new SeededRandom(seed ^ 0x51f15e5d);
  const updates: QuantFairValueUpdate[] = [];
  let fairValue = initialFairValue;
  for (let round = 2; round <= rounds; round += 2) {
    const direction = random.next() < 0.5 ? -1 : 1;
    const magnitude = random.next() < 0.5 ? 1 : 2;
    const preferred = fairValue + direction * magnitude;
    const alternate = fairValue - direction * magnitude;
    if (Number.isFinite(preferred) && preferred > 0) {
      fairValue = preferred;
    } else if (Number.isFinite(alternate) && alternate > 0) {
      fairValue = alternate;
    }
    updates.push({ round, fairValue, label: "PUBLIC_INFORMATION_UPDATE" });
  }
  return updates;
}

function resolveConfig(input: QuantTraderScenarioConfig): ResolvedQuantTraderScenarioConfig {
  const parsedResult = QuantTraderScenarioConfigSchema.safeParse(input);
  if (!parsedResult.success) {
    const familyIssue = parsedResult.error.issues.some((issue) => issue.path[0] === "family");
    if (familyIssue) {
      const rawInput: unknown = input;
      const rawFamily = typeof rawInput === "object" && rawInput !== null && "family" in rawInput
        ? String((rawInput as { readonly family?: unknown }).family)
        : "undefined";
      throw new Error(`Invalid scenario family: ${rawFamily}`);
    }
    throw parsedResult.error;
  }
  const parsed = parsedResult.data;
  const family = parsed.family;

  if (!Number.isSafeInteger(parsed.seed)) throw new Error("seed must be a safe integer");
  const defaults = familyDefaults(family);
  const rounds = parsed.rounds ?? defaults.rounds;
  assertPositiveSafeInteger(rounds, "rounds");
  const initialCash = parsed.initialCash ?? defaults.initialCash;
  if (!Number.isFinite(initialCash) || initialCash < 0) throw new Error("initialCash must be a non-negative finite number");
  const fairValue = parsed.fairValue ?? defaults.fairValue;
  assertFinitePositive(fairValue, "fairValue");
  const tickSize = parsed.tickSize ?? defaults.tickSize;
  assertFinitePositive(tickSize, "tickSize");
  const maxQuoteSize = parsed.maxQuoteSize ?? defaults.maxQuoteSize;
  assertPositiveSafeInteger(maxQuoteSize, "maxQuoteSize");
  const noiseTraderProbability = parsed.noiseTraderProbability ?? defaults.noiseTraderProbability;
  const informedTraderProbability = parsed.informedTraderProbability ?? defaults.informedTraderProbability;
  const noiseBuyProbability = parsed.noiseBuyProbability ?? defaults.noiseBuyProbability;
  assertProbability(noiseTraderProbability, "noiseTraderProbability");
  assertProbability(informedTraderProbability, "informedTraderProbability");
  assertProbability(noiseBuyProbability, "noiseBuyProbability");
  if (noiseTraderProbability + informedTraderProbability > 1) {
    throw new Error("noiseTraderProbability + informedTraderProbability must be <= 1");
  }
  const noiseTradeSize = parsed.noiseTradeSize ?? defaults.noiseTradeSize;
  assertPositiveSafeInteger(noiseTradeSize, "noiseTradeSize");
  const maxNoiseSpread = parsed.maxNoiseSpread ?? defaults.maxNoiseSpread;
  assertFinitePositive(maxNoiseSpread, "maxNoiseSpread");
  const riskLimits = PositionRiskLimitsSchema.parse({ ...defaults.riskLimits, ...parsed.riskLimits });
  assertPositiveSafeInteger(riskLimits.maxPosition, "maxPosition");
  if (!Number.isFinite(riskLimits.maxDrawdown) || riskLimits.maxDrawdown <= 0) {
    throw new Error("maxDrawdown must be a positive finite number");
  }
  if (!Number.isFinite(riskLimits.stopLossThreshold) || riskLimits.stopLossThreshold <= 0) {
    throw new Error("stopLossThreshold must be a positive finite number");
  }
  if (riskLimits.stopLossThreshold > riskLimits.maxDrawdown) {
    throw new Error("stopLossThreshold must not exceed maxDrawdown");
  }
  const fairValueUpdates = parsed.fairValueUpdates ?? (
    parsed.family === "FAIR_VALUE_UPDATES" ? generateFairValueUpdates(parsed.seed, rounds, fairValue) : []
  );
  const seenRounds = new Set<number>();
  for (const update of fairValueUpdates) {
    if (!Number.isInteger(update.round) || update.round < 1 || update.round > rounds) {
      throw new Error("fairValueUpdates rounds must fall within the scenario");
    }
    assertFinitePositive(update.fairValue, "fairValueUpdates fairValue");
    if (seenRounds.has(update.round)) throw new Error("Only one fairValueUpdate is allowed per round");
    seenRounds.add(update.round);
  }

  return {
    family,
    seed: parsed.seed,
    rounds,
    initialCash,
    fairValue,
    tickSize,
    maxQuoteSize,
    noiseTraderProbability,
    informedTraderProbability,
    noiseBuyProbability,
    noiseTradeSize,
    maxNoiseSpread,
    hardPositionLimit: parsed.hardPositionLimit ?? defaults.hardPositionLimit,
    stopOnRiskBreach: parsed.stopOnRiskBreach ?? defaults.stopOnRiskBreach,
    riskLimits,
    fairValueUpdates: fairValueUpdates
      .map((update) => ({ ...update }))
      .sort((a, b) => a.round - b.round)
  };
}

function cloneQuote(quote: QuotePair): QuotePair {
  return { bidPrice: quote.bidPrice, bidSize: quote.bidSize, askPrice: quote.askPrice, askSize: quote.askSize };
}

function cloneAction(action: QuantStudentAction): QuantStudentAction {
  return action.type === "QUOTE" ? { type: "QUOTE", quote: cloneQuote(action.quote) } : { type: "PASS" };
}

function cloneFill(fill: OrderFill): OrderFill {
  return { ...fill };
}

function cloneSnapshot(snapshot: PortfolioSnapshot): PortfolioSnapshot {
  return { ...snapshot };
}

function cloneMarketState(state: MarketState): MarketState {
  return { ...state };
}

function cloneEvent(event: QuantMarketEvent): QuantMarketEvent {
  return { ...event };
}

function cloneEvidence(evidence: QuantRoundEvidence): QuantRoundEvidence {
  return {
    ...evidence,
    marketEvents: evidence.marketEvents.map(cloneEvent),
    studentAction: cloneAction(evidence.studentAction),
    studentFills: evidence.studentFills.map(cloneFill),
    marketStateAfterAction: cloneMarketState(evidence.marketStateAfterAction),
    portfolio: cloneSnapshot(evidence.portfolio)
  };
}

function isOnTick(price: number, tickSize: number): boolean {
  const ticks = price / tickSize;
  return Number.isFinite(ticks) && Math.abs(ticks - Math.round(ticks)) <= 1e-9;
}

function markFillPnL(fill: OrderFill, fairValue: number): number {
  return fill.side === "BUY"
    ? (fairValue - fill.price) * fill.size
    : (fill.price - fairValue) * fill.size;
}

export class QuantTraderInterviewEngine {
  private readonly config: ResolvedQuantTraderScenarioConfig;
  private readonly random: SeededRandom;
  private readonly orderBook: LimitOrderBook;
  private readonly portfolio: PortfolioTracker;
  private statusValue: QuantScenarioStatus = "ACTIVE";
  private currentRoundValue = 1;
  private fairValueValue: number;
  private pendingActionValue: QuantStudentAction | undefined;
  private roundEvents: QuantMarketEvent[] = [];
  private readonly historyValue: QuantRoundEvidence[] = [];
  private readonly riskBreachesValue: QuantRiskBreach[] = [];
  private idSequence = 0;
  private logicalTime = 0;
  private quoteRounds = 0;
  private totalSpread = 0;
  private informedFlowCount = 0;
  private noiseFlowCount = 0;
  private adverseSelectionPnL = 0;

  public constructor(configInput: QuantTraderScenarioConfig) {
    this.config = resolveConfig(configInput);
    this.random = new SeededRandom(this.config.seed);
    this.fairValueValue = this.config.fairValue;
    this.portfolio = new PortfolioTracker(this.config.initialCash, this.config.riskLimits);
    this.orderBook = new LimitOrderBook({
      now: () => {
        const nextLogicalTime = this.logicalTime + 1;
        if (!Number.isSafeInteger(nextLogicalTime)) {
          throw new RangeError("Scenario logical time must remain a safe integer");
        }
        this.logicalTime = nextLogicalTime;
        return this.logicalTime;
      },
      createId: (prefix) => {
        const nextIdSequence = this.idSequence + 1;
        if (!Number.isSafeInteger(nextIdSequence)) {
          throw new RangeError("Scenario id sequence must remain a safe integer");
        }
        this.idSequence = nextIdSequence;
        return `${prefix}_${String(this.idSequence)}`;
      }
    });
    this.portfolio.updateMarkPrice(this.fairValueValue);
    this.applyFairValueUpdateForCurrentRound();
  }

  public getState(): QuantTraderScenarioState {
    const portfolio = this.portfolio.getSnapshot(this.fairValueValue);
    const phase: QuantScenarioPhase = this.statusValue !== "ACTIVE"
      ? "COMPLETE"
      : this.pendingActionValue === undefined ? "AWAITING_ACTION" : "READY_TO_ADVANCE";
    const quoteRequest: QuantQuoteRequest | undefined = phase === "AWAITING_ACTION" ? {
      round: this.currentRoundValue,
      fairValue: this.fairValueValue,
      tickSize: this.config.tickSize,
      maxQuoteSize: this.config.maxQuoteSize,
      hardPositionLimit: this.config.hardPositionLimit,
      maxPosition: this.config.riskLimits.maxPosition
    } : undefined;

    return {
      family: this.config.family,
      seed: this.config.seed,
      status: this.statusValue,
      phase,
      currentRound: this.currentRoundValue,
      plannedRounds: this.config.rounds,
      fairValue: this.fairValueValue,
      marketState: cloneMarketState(this.orderBook.getMarketState()),
      portfolio: cloneSnapshot(portfolio),
      currentRoundEvents: this.roundEvents.map(cloneEvent),
      ...(quoteRequest !== undefined ? { quoteRequest } : {}),
      ...(this.pendingActionValue !== undefined ? { pendingAction: cloneAction(this.pendingActionValue) } : {}),
      riskBreaches: this.riskBreachesValue.map((breach) => ({ ...breach })),
      history: this.historyValue.map(cloneEvidence)
    };
  }

  public submitQuote(quoteInput: QuotePair): QuantTraderScenarioState {
    return this.submitAction({ type: "QUOTE", quote: quoteInput });
  }

  public submitAction(actionInput: unknown): QuantTraderScenarioState {
    this.assertCanSubmit();

    const parsed = QuantStudentActionSchema.safeParse(actionInput);
    if (!parsed.success) {
      const rawType = typeof actionInput === "object" && actionInput !== null && "type" in actionInput
        ? (actionInput as { readonly type?: unknown }).type
        : undefined;
      const quotePayloadOnly = rawType === "QUOTE"
        && parsed.error.issues.every((issue) => issue.path[0] === "quote");
      throw new QuantTraderActionError(
        quotePayloadOnly ? "INVALID_QUOTE" : "INVALID_ACTION",
        quotePayloadOnly ? "Quote action payload is malformed" : "Student action is malformed"
      );
    }

    if (parsed.data.type === "QUOTE") {
      const quote = this.validateQuote(parsed.data.quote);
      this.pendingActionValue = { type: "QUOTE", quote };
    } else {
      this.pendingActionValue = { type: "PASS" };
    }
    return this.getState();
  }

  public advance(): QuantRoundEvidence {
    if (this.statusValue !== "ACTIVE") {
      throw new QuantTraderActionError("SCENARIO_COMPLETE", "Cannot advance a completed scenario");
    }
    const action = this.pendingActionValue;
    if (action === undefined) {
      throw new QuantTraderActionError("ACTION_REQUIRED", "Submit a student action before advancing the round");
    }

    const randomCheckpoint = this.random.checkpoint();
    const orderBookCheckpoint = this.orderBook.checkpoint();
    const portfolioCheckpoint = this.portfolio.checkpoint();
    const scalarCheckpoint = {
      status: this.statusValue,
      currentRound: this.currentRoundValue,
      fairValue: this.fairValueValue,
      pendingAction: cloneAction(action),
      roundEvents: this.roundEvents.map(cloneEvent),
      historyLength: this.historyValue.length,
      riskBreachesLength: this.riskBreachesValue.length,
      idSequence: this.idSequence,
      logicalTime: this.logicalTime,
      quoteRounds: this.quoteRounds,
      totalSpread: this.totalSpread,
      informedFlowCount: this.informedFlowCount,
      noiseFlowCount: this.noiseFlowCount,
      adverseSelectionPnL: this.adverseSelectionPnL
    };

    try {
      return this.advanceCommittedRound(action);
    } catch (error) {
      this.random.restore(randomCheckpoint);
      this.orderBook.restore(orderBookCheckpoint);
      this.portfolio.restore(portfolioCheckpoint);
      this.statusValue = scalarCheckpoint.status;
      this.currentRoundValue = scalarCheckpoint.currentRound;
      this.fairValueValue = scalarCheckpoint.fairValue;
      this.pendingActionValue = cloneAction(scalarCheckpoint.pendingAction);
      this.roundEvents = scalarCheckpoint.roundEvents.map(cloneEvent);
      this.historyValue.splice(scalarCheckpoint.historyLength);
      this.riskBreachesValue.splice(scalarCheckpoint.riskBreachesLength);
      this.idSequence = scalarCheckpoint.idSequence;
      this.logicalTime = scalarCheckpoint.logicalTime;
      this.quoteRounds = scalarCheckpoint.quoteRounds;
      this.totalSpread = scalarCheckpoint.totalSpread;
      this.informedFlowCount = scalarCheckpoint.informedFlowCount;
      this.noiseFlowCount = scalarCheckpoint.noiseFlowCount;
      this.adverseSelectionPnL = scalarCheckpoint.adverseSelectionPnL;
      throw error;
    }
  }

  private advanceCommittedRound(action: QuantStudentAction): QuantRoundEvidence {
    let studentQuote: QuotePair | undefined;
    if (action.type === "QUOTE") {
      studentQuote = action.quote;
      const nextQuoteRounds = this.quoteRounds + 1;
      const nextTotalSpread = this.totalSpread + studentQuote.askPrice - studentQuote.bidPrice;
      if (!Number.isSafeInteger(nextQuoteRounds)) {
        throw new RangeError("Quote-round count must remain a safe integer");
      }
      if (!Number.isFinite(nextTotalSpread)) {
        throw new RangeError("Accumulated quote spread must remain finite");
      }
      this.quoteRounds = nextQuoteRounds;
      this.totalSpread = nextTotalSpread;
      this.orderBook.setQuotes("STUDENT", studentQuote);
    } else {
      this.orderBook.cancelMakerQuotes("STUDENT");
    }

    const flow = this.simulateOrderFlow(studentQuote);
    const studentFills = flow.studentFills;
    for (const fill of studentFills) {
      this.portfolio.applyFill(fill);
      if (flow.orderFlowType === "INFORMED") {
        const nextAdverseSelectionPnL =
          this.adverseSelectionPnL + markFillPnL(fill, this.fairValueValue);
        if (!Number.isFinite(nextAdverseSelectionPnL)) {
          throw new RangeError("Adverse-selection PnL must remain finite");
        }
        this.adverseSelectionPnL = nextAdverseSelectionPnL;
      }
    }

    const marketStateAfterAction = this.orderBook.getMarketState();
    const portfolio = this.portfolio.updateMarkPrice(this.fairValueValue);
    const risk = this.portfolio.checkRiskLimits(this.fairValueValue);
    if (risk.breached && risk.reason !== undefined) {
      this.recordRiskBreach("POST_ROUND", risk.reason);
    }
    const evidence: QuantRoundEvidence = {
      round: this.currentRoundValue,
      fairValue: this.fairValueValue,
      marketEvents: this.roundEvents.map(cloneEvent),
      studentAction: cloneAction(action),
      orderFlowType: flow.orderFlowType,
      ...(flow.incomingMarketSide !== undefined ? { incomingMarketSide: flow.incomingMarketSide } : {}),
      studentFills: studentFills.map(cloneFill),
      marketStateAfterAction: cloneMarketState(marketStateAfterAction),
      portfolio: cloneSnapshot(portfolio),
      riskBreached: risk.breached,
      ...(risk.reason !== undefined ? { riskReason: risk.reason } : {}),
      accountingInvariantHolds: this.accountingInvariantHolds(portfolio),
      rngDrawCount: this.random.drawCount
    };
    this.historyValue.push(evidence);
    this.pendingActionValue = undefined;
    this.orderBook.cancelMakerQuotes("STUDENT");

    if (risk.breached && this.config.stopOnRiskBreach) {
      this.statusValue = "RISK_STOPPED";
    } else if (this.currentRoundValue >= this.config.rounds) {
      this.statusValue = "COMPLETED";
    } else {
      this.currentRoundValue += 1;
      this.roundEvents = [];
      this.applyFairValueUpdateForCurrentRound();
    }

    return cloneEvidence(evidence);
  }

  public getResult(): QuantTraderScenarioResult {
    if (this.statusValue === "ACTIVE") {
      throw new QuantTraderActionError("RESULT_NOT_READY", "Scenario result is available only after completion");
    }
    const finalPortfolio = this.portfolio.getSnapshot(this.fairValueValue);
    const roundsCompleted = this.historyValue.length;
    const fillVolume = this.historyValue.reduce(
      (sum, evidence) => sum + evidence.studentFills.reduce((fillSum, fill) => fillSum + fill.size, 0),
      0
    );
    const averageSpread = this.quoteRounds > 0 ? this.totalSpread / this.quoteRounds : 0;
    const quoteParticipationRate = roundsCompleted > 0 ? this.quoteRounds / roundsCompleted : 0;
    const objectiveScore = calculateMarketMakingScore({
      totalPnL: finalPortfolio.totalPnL,
      averageSpread,
      maxDrawdown: finalPortfolio.maxDrawdown,
      riskBreaches: this.riskBreachesValue.length,
      quoteParticipationRate
    });
    return {
      family: this.config.family,
      seed: this.config.seed,
      completionStatus: this.statusValue,
      plannedRounds: this.config.rounds,
      roundsCompleted,
      completionRate: roundsCompleted / this.config.rounds,
      finalFairValue: this.fairValueValue,
      finalPortfolio: cloneSnapshot(finalPortfolio),
      tradeCount: finalPortfolio.tradeCount,
      fillVolume,
      averageSpread,
      quoteParticipationRate,
      riskBreaches: this.riskBreachesValue.map((breach) => ({ ...breach })),
      informedFlowCount: this.informedFlowCount,
      noiseFlowCount: this.noiseFlowCount,
      adverseSelectionPnL: this.adverseSelectionPnL,
      accountingInvariantHolds: this.historyValue.every((item) => item.accountingInvariantHolds) && this.accountingInvariantHolds(finalPortfolio),
      objectiveScore,
      history: this.historyValue.map(cloneEvidence)
    };
  }

  private assertCanSubmit(): void {
    if (this.statusValue !== "ACTIVE") {
      throw new QuantTraderActionError("SCENARIO_COMPLETE", "Cannot submit an action to a completed scenario");
    }
    if (this.pendingActionValue !== undefined) {
      throw new QuantTraderActionError("ACTION_ALREADY_SUBMITTED", "Advance the current round before submitting another action");
    }
  }

  private validateQuote(input: QuotePair): QuotePair {
    let quote: QuotePair;
    try {
      quote = QuotePairSchema.parse(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Quote is malformed";
      throw new QuantTraderActionError("INVALID_QUOTE", `Invalid quote: ${message}`);
    }

    if (!isOnTick(quote.bidPrice, this.config.tickSize) || !isOnTick(quote.askPrice, this.config.tickSize)) {
      throw new QuantTraderActionError("INVALID_TICK", "Quote prices must lie on the scenario tick grid");
    }
    if (quote.bidSize > this.config.maxQuoteSize || quote.askSize > this.config.maxQuoteSize) {
      throw new QuantTraderActionError("QUOTE_SIZE_LIMIT", "Quote size exceeds the scenario maximum");
    }
    if (this.config.hardPositionLimit) {
      const position = this.portfolio.position;
      if (
        position + quote.bidSize > this.config.riskLimits.maxPosition
        || position - quote.askSize < -this.config.riskLimits.maxPosition
      ) {
        throw new QuantTraderActionError("HARD_POSITION_LIMIT", "Quote could breach the hard position limit");
      }
    }
    return cloneQuote(quote);
  }

  private simulateOrderFlow(studentQuote: QuotePair | undefined): {
    readonly orderFlowType: QuantOrderFlowType;
    readonly incomingMarketSide?: "BUY" | "SELL";
    readonly studentFills: readonly OrderFill[];
  } {
    const flowRoll = this.random.next();
    if (flowRoll < this.config.informedTraderProbability) {
      this.informedFlowCount = incrementSafeCount(
        this.informedFlowCount,
        "Informed-flow count"
      );
      return this.simulateInformedFlow(studentQuote);
    }
    if (flowRoll < this.config.informedTraderProbability + this.config.noiseTraderProbability) {
      this.noiseFlowCount = incrementSafeCount(
        this.noiseFlowCount,
        "Noise-flow count"
      );
      return this.simulateNoiseFlow();
    }
    return { orderFlowType: "NO_TRADE", studentFills: [] };
  }

  private simulateInformedFlow(studentQuote: QuotePair | undefined): {
    readonly orderFlowType: "INFORMED";
    readonly incomingMarketSide?: "BUY" | "SELL";
    readonly studentFills: readonly OrderFill[];
  } {
    if (studentQuote === undefined) return { orderFlowType: "INFORMED", studentFills: [] };

    const askEdge = this.fairValueValue - studentQuote.askPrice;
    const bidEdge = studentQuote.bidPrice - this.fairValueValue;
    if (askEdge <= 0 && bidEdge <= 0) return { orderFlowType: "INFORMED", studentFills: [] };

    const incomingMarketSide = askEdge >= bidEdge ? "BUY" as const : "SELL" as const;
    const size = incomingMarketSide === "BUY" ? studentQuote.askSize : studentQuote.bidSize;
    const fills = this.orderBook.executeMarketOrder(incomingMarketSide, size, "INFORMED_TRADER");
    return {
      orderFlowType: "INFORMED",
      incomingMarketSide,
      studentFills: this.attributeStudentFills(fills, incomingMarketSide)
    };
  }

  private simulateNoiseFlow(): {
    readonly orderFlowType: "NOISE";
    readonly incomingMarketSide: "BUY" | "SELL";
    readonly studentFills: readonly OrderFill[];
  } {
    const incomingMarketSide = this.random.next() < this.config.noiseBuyProbability ? "BUY" as const : "SELL" as const;
    const spreadOffset = Math.max(this.config.tickSize, this.random.next() * this.config.maxNoiseSpread);
    const passiveBid = Math.max(
      this.fairValueValue / 2,
      this.fairValueValue - this.config.maxNoiseSpread
    );
    const passiveAsk = this.fairValueValue + spreadOffset;
    const wideAsk = this.fairValueValue + this.config.maxNoiseSpread;
    if (!Number.isFinite(passiveAsk) || !Number.isFinite(wideAsk)) {
      throw new Error("Scenario price arithmetic overflowed while constructing noise liquidity");
    }
    const passiveQuote: QuotePair = incomingMarketSide === "BUY"
      ? {
          bidPrice: passiveBid,
          bidSize: this.config.noiseTradeSize,
          askPrice: wideAsk,
          askSize: this.config.noiseTradeSize
        }
      : {
          bidPrice: passiveBid,
          bidSize: this.config.noiseTradeSize,
          askPrice: passiveAsk,
          askSize: this.config.noiseTradeSize
        };
    this.orderBook.setQuotes("NOISE_MARKET_MAKER", passiveQuote);
    const fills = this.orderBook.executeMarketOrder(incomingMarketSide, this.config.noiseTradeSize, "NOISE_TRADER");
    this.orderBook.cancelMakerQuotes("NOISE_MARKET_MAKER");
    return {
      orderFlowType: "NOISE",
      incomingMarketSide,
      studentFills: this.attributeStudentFills(fills, incomingMarketSide)
    };
  }

  private attributeStudentFills(
    fills: readonly OrderFill[],
    incomingMarketSide: "BUY" | "SELL"
  ): readonly OrderFill[] {
    const makerPrefix = incomingMarketSide === "BUY"
      ? "quote_ask_STUDENT_"
      : "quote_bid_STUDENT_";
    const studentSide = incomingMarketSide === "BUY" ? "SELL" as const : "BUY" as const;

    return fills.flatMap((fill) => {
      const matchedOrderId = fill.matchedOrderId;
      if (matchedOrderId?.startsWith(makerPrefix) !== true) return [];
      return [{
        ...fill,
        orderId: matchedOrderId,
        matchedOrderId: fill.orderId,
        side: studentSide
      }];
    });
  }

  private applyFairValueUpdateForCurrentRound(): void {
    const update = this.config.fairValueUpdates.find((candidate) => candidate.round === this.currentRoundValue);
    if (update === undefined) return;
    const previousFairValue = this.fairValueValue;
    this.fairValueValue = update.fairValue;
    this.roundEvents.push({
      type: "FAIR_VALUE_UPDATE",
      round: this.currentRoundValue,
      previousFairValue,
      fairValue: update.fairValue,
      label: update.label ?? "PUBLIC_INFORMATION_UPDATE"
    });
    this.portfolio.updateMarkPrice(this.fairValueValue);
    const risk = this.portfolio.checkRiskLimits(this.fairValueValue);
    if (risk.breached && risk.reason !== undefined) {
      this.recordRiskBreach("FAIR_VALUE_UPDATE", risk.reason);
      if (this.config.stopOnRiskBreach) this.statusValue = "RISK_STOPPED";
    }
  }

  private recordRiskBreach(source: QuantRiskBreach["source"], reason: string): void {
    this.riskBreachesValue.push({ round: this.currentRoundValue, source, reason });
  }

  private accountingInvariantHolds(snapshot: PortfolioSnapshot): boolean {
    return Math.abs(snapshot.portfolioValue - (this.config.initialCash + snapshot.totalPnL)) <= 1e-8;
  }
}

function incrementSafeCount(value: number, label: string): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError(`${label} must remain a safe integer`);
  }
  return next;
}

export function createQuantTraderScenario(config: QuantTraderScenarioConfig): QuantTraderInterviewEngine {
  return new QuantTraderInterviewEngine(config);
}

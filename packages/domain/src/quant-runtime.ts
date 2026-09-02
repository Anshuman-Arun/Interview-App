import { z } from "zod";
import { SessionTargetIdentitySchema } from "./session-configuration.js";
import { QuotePairSchema } from "./trading.js";

const PositiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "Expected a positive safe integer" }
);
const NonnegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);
const SafeIntegerSchema = z.number().refine(Number.isSafeInteger, {
  message: "Expected a safe integer"
});
const FiniteNumberSchema = z.number().refine(Number.isFinite, {
  message: "Expected a finite number"
});
const FinitePositiveNumberSchema = z.number().refine(
  (value) => Number.isFinite(value) && value > 0,
  { message: "Expected a finite positive number" }
);

export const QuantTradingCandidateActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("QUOTE"),
    quote: QuotePairSchema
  }).strict(),
  z.object({
    type: z.literal("PASS")
  }).strict()
]);
export type QuantTradingCandidateAction = z.infer<typeof QuantTradingCandidateActionSchema>;

export const QuantResearchCandidateActionSchema = z.discriminatedUnion("kind", [
  z.object({
    actionId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    kind: z.literal("SUBMIT_PROBABILITY"),
    value: z.number().min(0).max(1)
  }).strict(),
  z.object({
    actionId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    kind: z.literal("REQUEST_OBSERVATION"),
    count: z.number().int().min(1).max(32)
  }).strict(),
  z.object({
    actionId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    kind: z.literal("SUBMIT_NUMERIC_ESTIMATE"),
    value: z.number().min(-1_000_000).max(1_000_000)
  }).strict(),
  z.object({
    actionId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    kind: z.literal("ALLOCATE_SAMPLE"),
    a: z.number().int().min(0).max(100),
    b: z.number().int().min(0).max(100)
  }).strict(),
  z.object({
    actionId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    kind: z.literal("CHOOSE_OPTION"),
    option: z.enum(["A", "B", "CONSTANT", "LINEAR"])
  }).strict(),
  z.object({
    actionId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
    kind: z.literal("SUBMIT_PARAMETERS"),
    values: z.array(z.number().min(-1_000_000).max(1_000_000)).min(1).max(8)
  }).strict()
]);
export type QuantResearchCandidateAction = z.infer<typeof QuantResearchCandidateActionSchema>;

export const QuantTradingPortfolioPublicSchema = z.object({
  cash: FiniteNumberSchema,
  position: SafeIntegerSchema,
  realizedPnL: FiniteNumberSchema,
  unrealizedPnL: FiniteNumberSchema,
  totalPnL: FiniteNumberSchema,
  portfolioValue: FiniteNumberSchema,
  averageCostBasis: FiniteNumberSchema,
  maxDrawdown: z.number().refine((value) => Number.isFinite(value) && value >= 0),
  tradeCount: NonnegativeSafeIntegerSchema
}).strict();

export const QuantTradingMarketUpdatePublicSchema = z.object({
  type: z.literal("FAIR_VALUE_UPDATE"),
  round: PositiveSafeIntegerSchema.max(256),
  previousFairValue: FinitePositiveNumberSchema,
  fairValue: FinitePositiveNumberSchema,
  label: z.string().min(1).max(128)
}).strict();

export const QuantTradingFillPublicSchema = z.object({
  side: z.enum(["BUY", "SELL"]),
  price: FinitePositiveNumberSchema,
  size: PositiveSafeIntegerSchema
}).strict();

export const QuantTradingRoundPublicSchema = z.object({
  round: PositiveSafeIntegerSchema.max(256),
  fairValue: FinitePositiveNumberSchema,
  marketUpdates: z.array(QuantTradingMarketUpdatePublicSchema).max(16),
  fills: z.array(QuantTradingFillPublicSchema).max(64),
  portfolio: QuantTradingPortfolioPublicSchema,
  riskBreached: z.boolean(),
  riskReason: z.string().min(1).max(240).optional(),
  accountingInvariantHolds: z.boolean()
}).strict();

export const QuantTradingQuoteRequestPublicSchema = z.object({
  round: PositiveSafeIntegerSchema.max(256),
  fairValue: FinitePositiveNumberSchema,
  tickSize: FinitePositiveNumberSchema,
  maxQuoteSize: PositiveSafeIntegerSchema,
  hardPositionLimit: z.boolean(),
  maxPosition: PositiveSafeIntegerSchema
}).strict();

export const QuantTradingTerminalMetricsSchema = z.object({
  completionStatus: z.enum(["COMPLETED", "RISK_STOPPED"]),
  plannedRounds: PositiveSafeIntegerSchema.max(256),
  roundsCompleted: PositiveSafeIntegerSchema.max(256),
  completionRate: z.number().min(0).max(1),
  tradeCount: NonnegativeSafeIntegerSchema,
  fillVolume: NonnegativeSafeIntegerSchema,
  averageSpread: z.number().refine((value) => Number.isFinite(value) && value >= 0),
  quoteParticipationRate: z.number().min(0).max(1),
  riskBreachCount: NonnegativeSafeIntegerSchema,
  adverseSelectionPnL: FiniteNumberSchema,
  accountingInvariantHolds: z.boolean(),
  objectiveScore: FiniteNumberSchema
}).strict();

export const QuantTradingPublicStateSchema = z.object({
  mode: z.literal("QUANT_TRADING"),
  scenario: SessionTargetIdentitySchema,
  status: z.enum(["ACTIVE", "COMPLETED", "RISK_STOPPED"]),
  currentRound: PositiveSafeIntegerSchema.max(256),
  plannedRounds: PositiveSafeIntegerSchema.max(256),
  fairValue: FinitePositiveNumberSchema,
  tickSize: FinitePositiveNumberSchema,
  maxQuoteSize: PositiveSafeIntegerSchema,
  hardPositionLimit: z.boolean(),
  maxPosition: PositiveSafeIntegerSchema,
  portfolio: QuantTradingPortfolioPublicSchema,
  marketUpdates: z.array(QuantTradingMarketUpdatePublicSchema).max(16),
  quoteRequest: QuantTradingQuoteRequestPublicSchema.optional(),
  actionRequired: z.boolean(),
  lastRound: QuantTradingRoundPublicSchema.optional(),
  completion: QuantTradingTerminalMetricsSchema.optional()
}).strict().superRefine((value, context) => {
  const active = value.status === "ACTIVE";
  if (active !== value.actionRequired) {
    context.addIssue({
      code: "custom",
      path: ["actionRequired"],
      message: "Quant Trading action requirement must match scenario activity"
    });
  }
  if (active !== (value.quoteRequest !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["quoteRequest"],
      message: "Active Quant Trading state requires exactly one quote request"
    });
  }
  if (active === (value.completion !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["completion"],
      message: "Quant Trading completion metrics must exist only for terminal state"
    });
  }
});
export type QuantTradingPublicState = z.infer<typeof QuantTradingPublicStateSchema>;

const QuantResearchVersionSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/u);
const QuantResearchPublicValueSchema = z.union([
  FiniteNumberSchema,
  z.string().max(4_000),
  z.boolean(),
  z.array(FiniteNumberSchema).max(128),
  z.array(z.string().max(1_000)).max(128)
]);

export const QuantResearchPublicStateSchema = z.object({
  family: z.enum([
    "BAYESIAN_UPDATING",
    "SAMPLING_ESTIMATION",
    "EXPERIMENTAL_ALLOCATION",
    "MODEL_COMPARISON",
    "CONSTRAINED_OPTIMIZATION"
  ]),
  version: QuantResearchVersionSchema,
  generatorVersion: QuantResearchVersionSchema,
  rngVersion: QuantResearchVersionSchema,
  status: z.enum(["IN_PROGRESS", "COMPLETE"]),
  stage: z.string().min(1).max(128),
  prompt: z.string().min(1).max(20_000),
  visibleData: z.array(z.object({
    key: z.string().min(1).max(128),
    label: z.string().min(1).max(256),
    value: QuantResearchPublicValueSchema
  }).strict()).max(128),
  acceptedActionCount: NonnegativeSafeIntegerSchema.max(64),
  actionLimit: PositiveSafeIntegerSchema.max(64)
}).strict();
export type QuantResearchPublicState = z.infer<typeof QuantResearchPublicStateSchema>;

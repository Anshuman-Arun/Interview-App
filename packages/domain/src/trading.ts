import { z } from "zod";

const NonBlankStringSchema = z.string().refine(
  (value) => value.trim().length > 0,
  { message: "Expected non-blank text" }
);
const PositiveFiniteNumberSchema = z.number().positive();
const NonnegativeFiniteNumberSchema = z.number().nonnegative();
const PositiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "Expected a positive safe integer" }
);
const NonnegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);
const ProbabilitySchema = z.number().min(0).max(1);

export const OrderSideSchema = z.enum(["BUY", "SELL"]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(["LIMIT", "MARKET"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const LimitOrderSchema = z.object({
  id: NonBlankStringSchema,
  side: OrderSideSchema,
  price: PositiveFiniteNumberSchema,
  size: PositiveSafeIntegerSchema,
  timestamp: NonnegativeFiniteNumberSchema
}).strict().refine(
  (order) => Number.isFinite(order.price * order.size),
  { message: "Limit-order notional must remain finite" }
);
export type LimitOrder = z.infer<typeof LimitOrderSchema>;

export const QuotePairSchema = z.object({
  bidPrice: PositiveFiniteNumberSchema,
  bidSize: PositiveSafeIntegerSchema,
  askPrice: PositiveFiniteNumberSchema,
  askSize: PositiveSafeIntegerSchema
}).strict()
  .refine((q) => q.bidPrice < q.askPrice, {
    message: "Bid price must be strictly less than ask price"
  })
  .refine(
    (q) => Number.isFinite(q.bidPrice * q.bidSize)
      && Number.isFinite(q.askPrice * q.askSize),
    { message: "Quote notionals must remain finite" }
  );
export type QuotePair = z.infer<typeof QuotePairSchema>;

export const OrderFillSchema = z.object({
  fillId: NonBlankStringSchema,
  orderId: NonBlankStringSchema,
  matchedOrderId: NonBlankStringSchema.optional(),
  side: OrderSideSchema,
  price: PositiveFiniteNumberSchema,
  size: PositiveSafeIntegerSchema,
  counterparty: NonBlankStringSchema,
  timestamp: NonnegativeFiniteNumberSchema
}).strict().refine(
  (fill) => Number.isFinite(fill.price * fill.size),
  { message: "Fill notional must remain finite" }
);
export type OrderFill = z.infer<typeof OrderFillSchema>;

export const PositionRiskLimitsSchema = z.object({
  maxPosition: PositiveSafeIntegerSchema.default(100),
  maxDrawdown: PositiveFiniteNumberSchema.default(500),
  stopLossThreshold: PositiveFiniteNumberSchema.default(300)
}).strict();
export type PositionRiskLimits = z.infer<typeof PositionRiskLimitsSchema>;

export const MarketStateSchema = z.object({
  bestBid: PositiveFiniteNumberSchema.optional(),
  bestAsk: PositiveFiniteNumberSchema.optional(),
  midPrice: PositiveFiniteNumberSchema.optional(),
  spread: NonnegativeFiniteNumberSchema.optional(),
  lastTradePrice: PositiveFiniteNumberSchema.optional(),
  totalVolume: NonnegativeSafeIntegerSchema.default(0)
}).strict();
export type MarketState = z.infer<typeof MarketStateSchema>;

export const TradingGameTypeSchema = z.enum(["DICE_MARKET", "OPTION_PAYOFF", "ADVERSE_SELECTION"]);
export type TradingGameType = z.infer<typeof TradingGameTypeSchema>;

export const TradingGameConfigSchema = z.object({
  gameType: TradingGameTypeSchema,
  rounds: PositiveSafeIntegerSchema.default(10),
  initialCash: NonnegativeFiniteNumberSchema.default(1000),
  fairValue: PositiveFiniteNumberSchema,
  noiseTraderProbability: ProbabilitySchema.default(0.7),
  informedTraderProbability: ProbabilitySchema.default(0.3),
  riskLimits: PositionRiskLimitsSchema.optional()
}).strict().refine(
  (config) => config.noiseTraderProbability + config.informedTraderProbability <= 1,
  {
    path: ["noiseTraderProbability"],
    message: "noiseTraderProbability + informedTraderProbability must be <= 1"
  }
);
export type TradingGameConfig = z.infer<typeof TradingGameConfigSchema>;

export const TradingGameResultSchema = z.object({
  gameType: TradingGameTypeSchema,
  totalPnL: z.number(),
  realizedPnL: z.number(),
  unrealizedPnL: z.number(),
  finalPosition: z.number().refine(Number.isSafeInteger, {
    message: "finalPosition must be a safe integer"
  }),
  finalCash: z.number(),
  tradeCount: NonnegativeSafeIntegerSchema,
  maxDrawdown: NonnegativeFiniteNumberSchema,
  averageSpread: NonnegativeFiniteNumberSchema,
  quoteComplianceRate: ProbabilitySchema,
  score: z.number().min(0).max(100)
}).strict();
export type TradingGameResult = z.infer<typeof TradingGameResultSchema>;

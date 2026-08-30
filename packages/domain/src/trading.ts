import { z } from "zod";

export const OrderSideSchema = z.enum(["BUY", "SELL"]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(["LIMIT", "MARKET"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const LimitOrderSchema = z.object({
  id: z.string().min(1),
  side: OrderSideSchema,
  price: z.number(),
  size: z.number().positive().int(),
  timestamp: z.number().nonnegative()
}).strict();
export type LimitOrder = z.infer<typeof LimitOrderSchema>;

export const QuotePairSchema = z.object({
  bidPrice: z.number(),
  bidSize: z.number().positive().int(),
  askPrice: z.number(),
  askSize: z.number().positive().int()
}).strict().refine((q) => q.bidPrice < q.askPrice, {
  message: "Bid price must be strictly less than ask price"
});
export type QuotePair = z.infer<typeof QuotePairSchema>;

export const OrderFillSchema = z.object({
  fillId: z.string().min(1),
  orderId: z.string().min(1),
  side: OrderSideSchema,
  price: z.number(),
  size: z.number().positive().int(),
  counterparty: z.string().min(1),
  timestamp: z.number().nonnegative()
}).strict();
export type OrderFill = z.infer<typeof OrderFillSchema>;

export const PositionRiskLimitsSchema = z.object({
  maxPosition: z.number().positive().int().default(100),
  maxDrawdown: z.number().positive().default(500),
  stopLossThreshold: z.number().positive().default(300)
}).strict();
export type PositionRiskLimits = z.infer<typeof PositionRiskLimitsSchema>;

export const MarketStateSchema = z.object({
  bestBid: z.number().optional(),
  bestAsk: z.number().optional(),
  midPrice: z.number().optional(),
  spread: z.number().nonnegative().optional(),
  lastTradePrice: z.number().optional(),
  totalVolume: z.number().int().nonnegative().default(0)
}).strict();
export type MarketState = z.infer<typeof MarketStateSchema>;

export const TradingGameTypeSchema = z.enum(["DICE_MARKET", "OPTION_PAYOFF", "ADVERSE_SELECTION"]);
export type TradingGameType = z.infer<typeof TradingGameTypeSchema>;

export const TradingGameConfigSchema = z.object({
  gameType: TradingGameTypeSchema,
  rounds: z.number().int().positive().default(10),
  initialCash: z.number().default(1000),
  fairValue: z.number(),
  noiseTraderProbability: z.number().min(0).max(1).default(0.7),
  informedTraderProbability: z.number().min(0).max(1).default(0.3),
  riskLimits: PositionRiskLimitsSchema.optional()
}).strict();
export type TradingGameConfig = z.infer<typeof TradingGameConfigSchema>;

export const TradingGameResultSchema = z.object({
  gameType: TradingGameTypeSchema,
  totalPnL: z.number(),
  realizedPnL: z.number(),
  unrealizedPnL: z.number(),
  finalPosition: z.number().int(),
  finalCash: z.number(),
  tradeCount: z.number().int().nonnegative(),
  maxDrawdown: z.number().nonnegative(),
  averageSpread: z.number().nonnegative(),
  quoteComplianceRate: z.number().min(0).max(1),
  score: z.number().min(0).max(100)
}).strict();
export type TradingGameResult = z.infer<typeof TradingGameResultSchema>;

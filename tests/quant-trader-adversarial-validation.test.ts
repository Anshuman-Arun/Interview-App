import { describe, expect, it } from "vitest";
import {
  QuantTraderActionError,
  QuantTraderScenarioConfigSchema,
  createQuantTraderScenario
} from "../packages/local-compute/src/index.js";
import {
  LimitOrderSchema,
  MarketStateSchema,
  OrderFillSchema,
  PositionRiskLimitsSchema,
  QuotePairSchema,
  TradingGameConfigSchema,
  TradingGameResultSchema
} from "../packages/domain/src/index.js";

function create(input: unknown) {
  return createQuantTraderScenario(input as Parameters<typeof createQuantTraderScenario>[0]);
}

describe("Quant Trader adversarial runtime validation", () => {
  it("rejects extra action fields at every level without mutating the caller", () => {
    const engine = create({ family: "BASIC_MARKET_MAKING", seed: 1 });
    const pass = { type: "PASS", ignored: true };
    const quote = {
      type: "QUOTE",
      quote: { bidPrice: 99, bidSize: 1, askPrice: 101, askSize: 1 },
      ignored: true
    };
    const nested = {
      type: "QUOTE",
      quote: { bidPrice: 99, bidSize: 1, askPrice: 101, askSize: 1, ignored: true }
    };

    for (const action of [pass, quote, nested]) {
      const before = JSON.stringify(action);
      expect(() => engine.submitAction(action)).toThrow(QuantTraderActionError);
      expect(JSON.stringify(action)).toBe(before);
      expect(engine.getState().phase).toBe("AWAITING_ACTION");
    }
  });

  it("makes the exported scenario schema itself enforce the runtime contract", () => {
    const invalidConfigs: readonly unknown[] = [
      { family: "BASIC_MARKET_MAKING", seed: 1.5 },
      { family: "BASIC_MARKET_MAKING", seed: Number.MAX_SAFE_INTEGER + 1 },
      { family: "BASIC_MARKET_MAKING", seed: 1, rounds: 0 },
      { family: "BASIC_MARKET_MAKING", seed: 1, initialCash: Number.POSITIVE_INFINITY },
      { family: "BASIC_MARKET_MAKING", seed: 1, fairValue: 0 },
      { family: "BASIC_MARKET_MAKING", seed: 1, tickSize: -1 },
      { family: "BASIC_MARKET_MAKING", seed: 1, maxQuoteSize: 1.5 },
      { family: "BASIC_MARKET_MAKING", seed: 1, noiseTraderProbability: 0.8, informedTraderProbability: 0.3 },
      {
        family: "RISK_MANAGEMENT",
        seed: 1,
        riskLimits: { maxDrawdown: 40, stopLossThreshold: 60 }
      },
      {
        family: "FAIR_VALUE_UPDATES",
        seed: 1,
        rounds: 2,
        fairValueUpdates: [{ round: 2, fairValue: 101 }, { round: 2, fairValue: 102 }]
      },
      {
        family: "FAIR_VALUE_UPDATES",
        seed: 1,
        rounds: 2,
        fairValueUpdates: [{ round: 3, fairValue: 101 }]
      }
    ];

    for (const config of invalidConfigs) {
      expect(QuantTraderScenarioConfigSchema.safeParse(config).success).toBe(false);
    }

    expect(QuantTraderScenarioConfigSchema.safeParse({
      family: "RISK_MANAGEMENT",
      seed: 1,
      rounds: 2,
      initialCash: 0,
      fairValue: 100,
      tickSize: 0.5,
      maxQuoteSize: 2,
      noiseTraderProbability: 0.7,
      informedTraderProbability: 0.2,
      noiseBuyProbability: 0.5,
      noiseTradeSize: 1,
      maxNoiseSpread: 8,
      hardPositionLimit: true,
      stopOnRiskBreach: true,
      riskLimits: { maxPosition: 4, maxDrawdown: 60, stopLossThreshold: 40 },
      fairValueUpdates: [{ round: 2, fairValue: 101, label: "PUBLIC_NEWS" }]
    }).success).toBe(true);
  });

  it("enforces safe finite trading primitives below the scenario wrapper", () => {
    for (const order of [
      { id: "   ", side: "BUY", price: 100, size: 1, timestamp: 0 },
      { id: "o", side: "BUY", price: 100, size: Number.MAX_SAFE_INTEGER + 1, timestamp: 0 },
      { id: "o", side: "BUY", price: Number.MAX_VALUE, size: 2, timestamp: 0 }
    ]) {
      expect(LimitOrderSchema.safeParse(order).success).toBe(false);
    }

    for (const quote of [
      { bidPrice: 99, bidSize: Number.MAX_SAFE_INTEGER + 1, askPrice: 101, askSize: 1 },
      { bidPrice: Number.MAX_VALUE / 2, bidSize: 1, askPrice: Number.MAX_VALUE, askSize: 2 }
    ]) {
      expect(QuotePairSchema.safeParse(quote).success).toBe(false);
    }

    expect(OrderFillSchema.safeParse({
      fillId: "fill",
      orderId: "order",
      side: "BUY",
      price: Number.MAX_VALUE,
      size: 2,
      counterparty: "TEST",
      timestamp: 0
    }).success).toBe(false);

    expect(PositionRiskLimitsSchema.safeParse({
      maxPosition: Number.MAX_SAFE_INTEGER + 1,
      maxDrawdown: 100,
      stopLossThreshold: 50
    }).success).toBe(false);

    expect(MarketStateSchema.safeParse({
      bestBid: -1,
      totalVolume: Number.MAX_SAFE_INTEGER + 1
    }).success).toBe(false);
  });

  it("makes the generic market-maker config enforce simulator assumptions", () => {
    for (const config of [
      { gameType: "DICE_MARKET", rounds: 0, initialCash: 1000, fairValue: 100 },
      { gameType: "DICE_MARKET", rounds: Number.MAX_SAFE_INTEGER + 1, initialCash: 1000, fairValue: 100 },
      { gameType: "DICE_MARKET", rounds: 1, initialCash: -1, fairValue: 100 },
      { gameType: "DICE_MARKET", rounds: 1, initialCash: Number.POSITIVE_INFINITY, fairValue: 100 },
      { gameType: "DICE_MARKET", rounds: 1, initialCash: 1000, fairValue: 0 },
      {
        gameType: "DICE_MARKET",
        rounds: 1,
        initialCash: 1000,
        fairValue: 100,
        noiseTraderProbability: 0.8,
        informedTraderProbability: 0.3
      }
    ]) {
      expect(TradingGameConfigSchema.safeParse(config).success).toBe(false);
    }

    expect(TradingGameConfigSchema.safeParse({
      gameType: "DICE_MARKET",
      rounds: 1,
      initialCash: 0,
      fairValue: 100,
      noiseTraderProbability: 0.7,
      informedTraderProbability: 0.3
    }).success).toBe(true);
  });

  it("rejects non-finite or unsafe generic trading results", () => {
    const valid = {
      gameType: "DICE_MARKET",
      totalPnL: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      finalPosition: 0,
      finalCash: 1000,
      tradeCount: 0,
      maxDrawdown: 0,
      averageSpread: 0,
      quoteComplianceRate: 0,
      score: 50
    } as const;
    expect(TradingGameResultSchema.safeParse(valid).success).toBe(true);
    expect(TradingGameResultSchema.safeParse({
      ...valid,
      totalPnL: Number.POSITIVE_INFINITY
    }).success).toBe(false);
    expect(TradingGameResultSchema.safeParse({
      ...valid,
      finalPosition: Number.MAX_SAFE_INTEGER + 1
    }).success).toBe(false);
    expect(TradingGameResultSchema.safeParse({
      ...valid,
      tradeCount: Number.MAX_SAFE_INTEGER + 1
    }).success).toBe(false);
  });

  it("rejects non-boolean flag substitutes and unknown configuration keys", () => {
    for (const config of [
      { family: "BASIC_MARKET_MAKING", seed: 1, hardPositionLimit: 1 },
      { family: "BASIC_MARKET_MAKING", seed: 1, stopOnRiskBreach: "false" },
      { family: "BASIC_MARKET_MAKING", seed: 1, unknownSetting: true }
    ]) {
      expect(() => create(config)).toThrow();
    }
  });

  it("rejects malformed, duplicate, and out-of-range fair-value updates", () => {
    for (const fairValueUpdates of [
      [{ round: 0, fairValue: 101 }],
      [{ round: 3, fairValue: 101 }],
      [{ round: 1.5, fairValue: 101 }],
      [{ round: 1, fairValue: 0 }],
      [{ round: 1, fairValue: Number.POSITIVE_INFINITY }],
      [{ round: 1, fairValue: 101, extra: true }],
      [{ round: 1, fairValue: 101 }, { round: 1, fairValue: 102 }]
    ]) {
      expect(() => create({
        family: "FAIR_VALUE_UPDATES",
        seed: 1,
        rounds: 2,
        fairValueUpdates
      })).toThrow();
    }
  });

  it("rejects risk limits whose stop-loss can never be the tighter loss boundary", () => {
    expect(() => create({
      family: "RISK_MANAGEMENT",
      seed: 1,
      riskLimits: {
        maxPosition: 4,
        maxDrawdown: 40,
        stopLossThreshold: 60
      }
    })).toThrow(/stopLossThreshold must not exceed maxDrawdown/u);

    expect(() => create({
      family: "RISK_MANAGEMENT",
      seed: 1,
      riskLimits: {
        maxPosition: 4,
        maxDrawdown: 60,
        stopLossThreshold: 40
      }
    })).not.toThrow();
  });

  it("rejects unsafe integer counts before they can corrupt deterministic iteration", () => {
    for (const config of [
      { family: "BASIC_MARKET_MAKING", seed: 1, rounds: Number.MAX_SAFE_INTEGER + 1 },
      { family: "BASIC_MARKET_MAKING", seed: 1, maxQuoteSize: Number.MAX_SAFE_INTEGER + 1 },
      { family: "BASIC_MARKET_MAKING", seed: 1, noiseTradeSize: Number.MAX_SAFE_INTEGER + 1 },
      {
        family: "BASIC_MARKET_MAKING",
        seed: 1,
        riskLimits: { maxPosition: Number.MAX_SAFE_INTEGER + 1 }
      }
    ]) {
      expect(() => create(config)).toThrow(/positive safe integer/u);
    }
  });

  it("keeps generated fair-value updates positive even from a very small starting fair value", () => {
    const engine = createQuantTraderScenario({
      family: "FAIR_VALUE_UPDATES",
      seed: 3,
      rounds: 4,
      fairValue: 0.25
    });

    for (let round = 0; round < 4; round += 1) {
      expect(engine.getState().fairValue).toBeGreaterThan(0);
      engine.submitAction({ type: "PASS" });
      engine.advance();
    }
    expect(engine.getResult().finalFairValue).toBeGreaterThan(0);
  });

  it("does not construct invalid synthetic noise quotes when spread exceeds fair value", () => {
    const engine = createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 11,
      rounds: 1,
      fairValue: 1,
      tickSize: 2,
      maxNoiseSpread: 100,
      noiseTraderProbability: 1,
      informedTraderProbability: 0,
      noiseBuyProbability: 1
    });

    engine.submitAction({ type: "PASS" });
    expect(() => engine.advance()).not.toThrow();
    expect(engine.getResult().completionStatus).toBe("COMPLETED");
  });

  it("does not mutate scenario configuration while normalizing update order", () => {
    const config = {
      family: "FAIR_VALUE_UPDATES" as const,
      seed: 7,
      rounds: 3,
      fairValueUpdates: [
        { round: 3, fairValue: 103, label: "late" },
        { round: 2, fairValue: 102, label: "early" }
      ]
    };
    const before = JSON.stringify(config);
    const engine = createQuantTraderScenario(config);
    expect(JSON.stringify(config)).toBe(before);

    engine.submitAction({ type: "PASS" });
    engine.advance();
    expect(engine.getState().currentRoundEvents[0]).toMatchObject({ round: 2, fairValue: 102 });
    expect(JSON.stringify(config)).toBe(before);
  });

  it("retains deterministic results under different observation schedules", () => {
    const config = {
      family: "BASIC_MARKET_MAKING" as const,
      seed: 20260830,
      rounds: 4,
      fairValue: 100,
      tickSize: 1
    };
    const observed = createQuantTraderScenario(config);
    const unobserved = createQuantTraderScenario(config);

    for (let round = 0; round < 4; round += 1) {
      for (let read = 0; read < 25; read += 1) observed.getState();
      observed.submitAction({ type: "PASS" });
      unobserved.submitAction({ type: "PASS" });
      expect(observed.advance()).toEqual(unobserved.advance());
    }
    expect(observed.getResult()).toEqual(unobserved.getResult());
  });
});

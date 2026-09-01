import { describe, expect, it, vi } from "vitest";
import {
  calculateMarketMakingScore,
  createQuantTraderScenario,
  LimitOrderBook,
  MarketMakerSimulator,
  PortfolioTracker,
  QuantTraderActionError,
  type QuantTraderScenarioConfig
} from "../packages/local-compute/src/index.js";

const centeredQuote = { bidPrice: 99, bidSize: 2, askPrice: 101, askSize: 2 } as const;

function expectActionError(action: () => unknown, code: QuantTraderActionError["code"]): void {
  try {
    action();
    throw new Error("Expected QuantTraderActionError");
  } catch (error) {
    expect(error).toBeInstanceOf(QuantTraderActionError);
    expect((error as QuantTraderActionError).code).toBe(code);
  }
}

function runQuotedScenario(config: QuantTraderScenarioConfig, rounds: number) {
  const engine = createQuantTraderScenario(config);
  for (let round = 0; round < rounds && engine.getState().status === "ACTIVE"; round += 1) {
    engine.submitQuote(centeredQuote);
    engine.advance();
  }
  return engine.getResult();
}

describe("standalone Quant Trader interview engine", () => {
  it("exposes a deterministic quote request and advances only after a validated action", () => {
    const engine = createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 42,
      rounds: 2,
      fairValue: 100,
      tickSize: 1
    });

    const initial = engine.getState();
    expect(initial.status).toBe("ACTIVE");
    expect(initial.phase).toBe("AWAITING_ACTION");
    expect(initial.currentRound).toBe(1);
    expect(initial.quoteRequest).toEqual({
      round: 1,
      fairValue: 100,
      tickSize: 1,
      maxQuoteSize: 10,
      hardPositionLimit: false,
      maxPosition: 20
    });

    expectActionError(() => engine.advance(), "ACTION_REQUIRED");
    engine.submitQuote(centeredQuote);
    expect(engine.getState().phase).toBe("READY_TO_ADVANCE");
    expectActionError(() => engine.submitAction({ type: "PASS" }), "ACTION_ALREADY_SUBMITTED");

    const evidence = engine.advance();
    expect(evidence.round).toBe(1);
    expect(engine.getState().currentRound).toBe(2);
    expect(engine.getState().phase).toBe("AWAITING_ACTION");
  });

  it("rejects crossed, malformed, off-tick, oversized, and hard-risk quotes instead of clipping them", () => {
    const engine = createQuantTraderScenario({
      family: "RISK_MANAGEMENT",
      seed: 7,
      rounds: 2,
      fairValue: 100,
      tickSize: 0.5,
      maxQuoteSize: 3,
      riskLimits: { maxPosition: 2, maxDrawdown: 60, stopLossThreshold: 40 }
    });

    expectActionError(
      () => engine.submitQuote({ bidPrice: 101, bidSize: 1, askPrice: 100, askSize: 1 }),
      "INVALID_QUOTE"
    );
    expectActionError(
      () => engine.submitQuote({ bidPrice: 99, bidSize: 0, askPrice: 101, askSize: 1 }),
      "INVALID_QUOTE"
    );
    expectActionError(
      () => engine.submitQuote({ bidPrice: 99.25, bidSize: 1, askPrice: 101, askSize: 1 }),
      "INVALID_TICK"
    );
    expectActionError(
      () => engine.submitQuote({ bidPrice: 99, bidSize: 4, askPrice: 101, askSize: 1 }),
      "QUOTE_SIZE_LIMIT"
    );
    expectActionError(
      () => engine.submitQuote({ bidPrice: 99, bidSize: 3, askPrice: 101, askSize: 1 }),
      "HARD_POSITION_LIMIT"
    );
  });

  it("validates injected market-maker randomness before mutating round state", () => {
    const invalidRolls = [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1];
    for (const invalidRoll of invalidRolls) {
      const simulator = new MarketMakerSimulator({
        gameType: "DICE_MARKET",
        rounds: 2,
        initialCash: 1_000,
        fairValue: 100,
        noiseTraderProbability: 1,
        informedTraderProbability: 0
      }, {
        random: () => invalidRoll
      });

      expect(() => simulator.playRound(centeredQuote)).toThrow(/random source/u);
      expect(simulator.currentRound).toBe(1);
      expect(simulator.finishGame()).toMatchObject({
        tradeCount: 0,
        averageSpread: 0,
        quoteComplianceRate: 0
      });
    }
  });

  it("validates a noise-side random draw before mutating the market-maker round", () => {
    const rolls = [0.5, Number.NaN];
    const simulator = new MarketMakerSimulator({
      gameType: "DICE_MARKET",
      rounds: 2,
      initialCash: 1_000,
      fairValue: 100,
      noiseTraderProbability: 1,
      informedTraderProbability: 0
    }, {
      random: () => {
        const value = rolls.shift();
        if (value === undefined) throw new Error("random fixture exhausted");
        return value;
      }
    });

    expect(() => simulator.playRound(centeredQuote)).toThrow(/random source/u);
    expect(simulator.currentRound).toBe(1);
    expect(simulator.finishGame()).toMatchObject({
      tradeCount: 0,
      averageSpread: 0,
      quoteComplianceRate: 0
    });
  });

  it("rejects non-finite or out-of-contract scoring metrics", () => {
    for (const input of [
      { totalPnL: Number.NaN, averageSpread: 1, maxDrawdown: 0 },
      { totalPnL: 0, averageSpread: -1, maxDrawdown: 0 },
      { totalPnL: 0, averageSpread: 1, maxDrawdown: Number.POSITIVE_INFINITY },
      { totalPnL: 0, averageSpread: 1, maxDrawdown: 0, riskBreaches: -1 },
      { totalPnL: 0, averageSpread: 1, maxDrawdown: 0, quoteParticipationRate: 1.1 }
    ]) {
      expect(() => calculateMarketMakingScore(input)).toThrow();
    }
    expect(calculateMarketMakingScore({
      totalPnL: 0,
      averageSpread: 2,
      maxDrawdown: 0,
      riskBreaches: 0,
      quoteParticipationRate: 1
    })).toBeGreaterThanOrEqual(0);
  });

  it("keeps order-book matching price-time ordered while allowing deterministic IDs and timestamps", () => {
    let id = 0;
    let time = 100;
    const book = new LimitOrderBook({
      createId: (prefix) => `${prefix}_${String(++id)}`,
      now: () => ++time
    });

    book.placeLimitOrder({ id: "ask_early", side: "SELL", price: 100, size: 2, timestamp: 1 });
    book.placeLimitOrder({ id: "ask_late", side: "SELL", price: 100, size: 3, timestamp: 2 });
    const match = book.placeLimitOrder({ id: "buyer", side: "BUY", price: 100, size: 4, timestamp: 3 });

    expect(match.fills.map((fill) => [fill.price, fill.size])).toEqual([[100, 2], [100, 2]]);
    expect(match.fills.map((fill) => fill.fillId)).toEqual(["fill_1", "fill_2"]);
    expect(match.fills.map((fill) => fill.timestamp)).toEqual([101, 102]);
    expect(book.getMarketState()).toMatchObject({ bestAsk: 100, totalVolume: 4, lastTradePrice: 100 });
  });

  it("rolls back all resting-order mutations if a later fill cannot be built", () => {
    let nowCall = 0;
    let failOnSecondFill = true;
    let id = 0;
    const book = new LimitOrderBook({
      createId: (prefix) => `${prefix}_${String(++id)}`,
      now: () => {
        nowCall += 1;
        if (failOnSecondFill && nowCall === 2) {
          throw new Error("second fill clock failed");
        }
        return nowCall;
      }
    });

    book.placeLimitOrder({ id: "ask_one", side: "SELL", price: 100, size: 1, timestamp: 1 });
    book.placeLimitOrder({ id: "ask_two", side: "SELL", price: 101, size: 1, timestamp: 2 });
    const before = book.getMarketState();

    expect(() => book.placeLimitOrder({
      id: "crossing_buy",
      side: "BUY",
      price: 101,
      size: 2,
      timestamp: 3
    })).toThrow(/second fill clock failed/u);
    expect(book.getMarketState()).toEqual(before);

    failOnSecondFill = false;
    nowCall = 0;
    const retry = book.placeLimitOrder({
      id: "crossing_buy",
      side: "BUY",
      price: 101,
      size: 2,
      timestamp: 3
    });
    expect(retry.fills.map((fill) => [fill.price, fill.size]))
      .toEqual([[100, 1], [101, 1]]);
    expect(book.getMarketState()).toMatchObject({
      totalVolume: 2,
      lastTradePrice: 101
    });
  });

  it("rejects blank order-book ownership and counterparty metadata before mutation", () => {
    const book = new LimitOrderBook({
      createId: (prefix) => `${prefix}_id`,
      now: () => 1
    });

    expect(() => book.setQuotes("   ", centeredQuote)).toThrow(/ownerId must be non-blank/u);
    expect(() => book.executeMarketOrder("BUY", 1, "   ")).toThrow(/counterparty must be non-blank/u);
    expect(() => book.placeLimitOrder(
      { id: "resting", side: "BUY", price: 99, size: 1, timestamp: 1 },
      "   "
    )).toThrow(/counterparty must be non-blank/u);
    expect(book.getMarketState()).toEqual({ totalVolume: 0 });
  });

  it("computes a finite midpoint for large valid prices without addition overflow", () => {
    const book = new LimitOrderBook({
      createId: (prefix) => `${prefix}_${globalThis.crypto.randomUUID()}`,
      now: () => 1
    });
    const bidPrice = Number.MAX_VALUE * 0.75;
    const askPrice = Number.MAX_VALUE * 0.9;
    expect(Number.isFinite(bidPrice + askPrice)).toBe(false);

    book.setQuotes("LARGE", {
      bidPrice,
      bidSize: 1,
      askPrice,
      askSize: 1
    });
    const state = book.getMarketState();
    expect(state.bestBid).toBe(bidPrice);
    expect(state.bestAsk).toBe(askPrice);
    expect(Number.isFinite(state.midPrice)).toBe(true);
    expect(state.midPrice).toBeGreaterThan(bidPrice);
    expect(state.midPrice).toBeLessThan(askPrice);
  });

  it("rejects active order-id collisions before mutating the book", () => {
    const book = new LimitOrderBook({
      createId: () => "generated-collision",
      now: () => 1
    });

    book.placeLimitOrder({
      id: "existing",
      side: "SELL",
      price: 101,
      size: 1,
      timestamp: 1
    });
    expect(() => book.placeLimitOrder({
      id: "existing",
      side: "BUY",
      price: 99,
      size: 1,
      timestamp: 2
    })).toThrow(/already exists/u);
    expect(book.getMarketState()).toMatchObject({ bestAsk: 101, totalVolume: 0 });

    expect(() => book.setQuotes("STUDENT", centeredQuote)).toThrow(/generated order-book id was reused/iu);
    expect(book.getMarketState()).toMatchObject({ bestAsk: 101, totalVolume: 0 });
  });

  it("keeps an existing maker quote intact when replacement ids collide with another owner", () => {
    const ids = [
      "student-bid",
      "student-ask",
      "other-bid",
      "other-ask",
      "other-bid",
      "replacement-ask"
    ];
    const book = new LimitOrderBook({
      createId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error("id fixture exhausted");
        return id;
      },
      now: () => 1
    });

    book.setQuotes("STUDENT", centeredQuote);
    book.setQuotes("OTHER", {
      bidPrice: 98,
      bidSize: 1,
      askPrice: 102,
      askSize: 1
    });

    expect(() => book.setQuotes("STUDENT", {
      bidPrice: 97,
      bidSize: 1,
      askPrice: 103,
      askSize: 1
    })).toThrow(/generated order-book id was reused/iu);

    expect(book.getMarketState()).toMatchObject({
      bestBid: 99,
      bestAsk: 101,
      totalVolume: 0
    });
  });

  it("updates inventory, cash, unrealized P&L, and mark-to-market after deterministic noise fills", () => {
    const engine = createQuantTraderScenario({
      family: "INVENTORY_PRESSURE",
      seed: 11,
      rounds: 2,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 1,
      informedTraderProbability: 0,
      noiseBuyProbability: 0,
      noiseTradeSize: 1,
      fairValueUpdates: [{ round: 2, fairValue: 105, label: "PUBLIC_NEWS" }]
    });

    engine.submitQuote(centeredQuote);
    const roundOne = engine.advance();
    expect(roundOne.orderFlowType).toBe("NOISE");
    expect(roundOne.incomingMarketSide).toBe("SELL");
    expect(roundOne.studentFills).toHaveLength(1);
    expect(roundOne.studentFills[0]).toMatchObject({ side: "BUY", price: 99, size: 1 });
    expect(roundOne.portfolio).toMatchObject({ cash: 901, position: 1, unrealizedPnL: 1, totalPnL: 1, portfolioValue: 1001 });

    const marked = engine.getState();
    expect(marked.fairValue).toBe(105);
    expect(marked.currentRoundEvents).toEqual([
      { type: "FAIR_VALUE_UPDATE", round: 2, previousFairValue: 100, fairValue: 105, label: "PUBLIC_NEWS" }
    ]);
    expect(marked.portfolio).toMatchObject({ position: 1, unrealizedPnL: 6, totalPnL: 6, portfolioValue: 1006 });
  });

  it("preserves exact realized/unrealized accounting when inventory is opened and partially closed", () => {
    const portfolio = new PortfolioTracker(1_000);
    portfolio.applyFill({
      fillId: "buy", orderId: "buy", side: "BUY", price: 50, size: 4, counterparty: "TEST", timestamp: 1
    });
    portfolio.applyFill({
      fillId: "sell", orderId: "sell", side: "SELL", price: 55, size: 3, counterparty: "TEST", timestamp: 2
    });

    const snapshot = portfolio.updateMarkPrice(60);
    expect(snapshot.cash).toBe(965);
    expect(snapshot.position).toBe(1);
    expect(snapshot.realizedPnL).toBe(15);
    expect(snapshot.unrealizedPnL).toBe(10);
    expect(snapshot.totalPnL).toBe(25);
    expect(snapshot.portfolioValue).toBe(1025);
    expect(snapshot.portfolioValue).toBe(1_000 + snapshot.totalPnL);
  });

  it("rolls back a failed round so retry matches a clean deterministic engine exactly", () => {
    const config: QuantTraderScenarioConfig = {
      family: "BASIC_MARKET_MAKING",
      seed: 314159,
      rounds: 1,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 1,
      informedTraderProbability: 0,
      noiseBuyProbability: 1,
      noiseTradeSize: 1
    };
    const retried = createQuantTraderScenario(config);
    const clean = createQuantTraderScenario(config);
    retried.submitQuote(centeredQuote);
    clean.submitQuote(centeredQuote);

    const beforeFailure = retried.getState();
    const orderBook = (retried as unknown as { orderBook: LimitOrderBook }).orderBook;
    const executeSpy = vi.spyOn(orderBook, "executeMarketOrder")
      .mockImplementationOnce(() => {
        throw new Error("synthetic execution failure");
      });

    expect(() => retried.advance()).toThrow(/synthetic execution failure/u);
    expect(retried.getState()).toEqual(beforeFailure);
    expect(retried.getState().phase).toBe("READY_TO_ADVANCE");

    const retriedRound = retried.advance();
    const cleanRound = clean.advance();
    expect(retriedRound).toEqual(cleanRound);
    expect(retried.getResult()).toEqual(clean.getResult());

    executeSpy.mockRestore();
  });

  it("is reproducible for the same config, seed, and student action sequence", () => {
    const config: QuantTraderScenarioConfig = {
      family: "BASIC_MARKET_MAKING",
      seed: 12_345,
      rounds: 6,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 0.8,
      informedTraderProbability: 0.2
    };

    const first = runQuotedScenario(config, 6);
    const second = runQuotedScenario(config, 6);
    expect(second).toEqual(first);
    expect(first.history.map((round) => round.rngDrawCount)).toEqual(
      second.history.map((round) => round.rngDrawCount)
    );
  });

  it("uses the seed to control order-flow paths rather than global randomness", () => {
    const base = {
      family: "BASIC_MARKET_MAKING" as const,
      rounds: 6,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 1,
      informedTraderProbability: 0,
      noiseBuyProbability: 0.5
    };
    const first = runQuotedScenario({ ...base, seed: 1 }, 6);
    const second = runQuotedScenario({ ...base, seed: 2 }, 6);

    expect(first.history.map((round) => round.incomingMarketSide)).not.toEqual(
      second.history.map((round) => round.incomingMarketSide)
    );
  });

  it("generates reproducible public fair-value updates for the fair-value scenario family", () => {
    const config = {
      family: "FAIR_VALUE_UPDATES" as const,
      seed: 99,
      rounds: 4,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 0,
      informedTraderProbability: 0
    };
    const first = createQuantTraderScenario(config);
    const second = createQuantTraderScenario(config);

    for (let round = 1; round <= 4; round += 1) {
      expect(second.getState().fairValue).toBe(first.getState().fairValue);
      expect(second.getState().currentRoundEvents).toEqual(first.getState().currentRoundEvents);
      first.submitAction({ type: "PASS" });
      second.submitAction({ type: "PASS" });
      first.advance();
      second.advance();
    }
    expect(second.getResult()).toEqual(first.getResult());
  });

  it("creates inventory pressure through configured directional noise flow", () => {
    const result = runQuotedScenario({
      family: "INVENTORY_PRESSURE",
      seed: 4,
      rounds: 3,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 1,
      informedTraderProbability: 0,
      noiseBuyProbability: 0,
      noiseTradeSize: 1
    }, 3);

    expect(result.finalPortfolio.position).toBe(3);
    expect(result.tradeCount).toBe(3);
    expect(result.noiseFlowCount).toBe(3);
    expect(result.fillVolume).toBe(3);
  });

  it("models adverse selection by allowing informed flow to pick off mispriced quotes", () => {
    const engine = createQuantTraderScenario({
      family: "ADVERSE_SELECTION",
      seed: 1,
      rounds: 1,
      fairValue: 100,
      tickSize: 1,
      informedTraderProbability: 1,
      noiseTraderProbability: 0
    });

    engine.submitQuote({ bidPrice: 95, bidSize: 2, askPrice: 99, askSize: 2 });
    const evidence = engine.advance();
    const result = engine.getResult();

    expect(evidence.orderFlowType).toBe("INFORMED");
    expect(evidence.incomingMarketSide).toBe("BUY");
    expect(evidence.studentFills[0]).toMatchObject({ side: "SELL", price: 99, size: 2, counterparty: "INFORMED_TRADER" });
    expect(result.finalPortfolio).toMatchObject({ cash: 1198, position: -2, unrealizedPnL: -2, totalPnL: -2 });
    expect(result.adverseSelectionPnL).toBe(-2);
    expect(result.informedFlowCount).toBe(1);
  });

  it("enforces risk constraints and stops a risk scenario on a post-trade stop-loss breach", () => {
    const engine = createQuantTraderScenario({
      family: "RISK_MANAGEMENT",
      seed: 1,
      rounds: 4,
      fairValue: 100,
      tickSize: 1,
      informedTraderProbability: 1,
      noiseTraderProbability: 0,
      riskLimits: { maxPosition: 4, maxDrawdown: 50, stopLossThreshold: 1 }
    });

    engine.submitQuote({ bidPrice: 95, bidSize: 2, askPrice: 99, askSize: 2 });
    const evidence = engine.advance();
    expect(evidence.riskBreached).toBe(true);
    expect(evidence.riskReason).toContain("stop-loss");
    expect(engine.getState().status).toBe("RISK_STOPPED");

    const result = engine.getResult();
    expect(result.completionStatus).toBe("RISK_STOPPED");
    expect(result.roundsCompleted).toBe(1);
    expect(result.riskBreaches).toHaveLength(1);
    expectActionError(() => engine.submitAction({ type: "PASS" }), "SCENARIO_COMPLETE");
  });

  it("tracks round progression, normal completion, PASS actions, and final deterministic scoring data", () => {
    const engine = createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 123,
      rounds: 3,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 0,
      informedTraderProbability: 0
    });

    expectActionError(() => engine.getResult(), "RESULT_NOT_READY");
    for (let round = 1; round <= 3; round += 1) {
      engine.submitAction({ type: "PASS" });
      expect(engine.advance().round).toBe(round);
    }

    const state = engine.getState();
    expect(state.status).toBe("COMPLETED");
    expect(state.phase).toBe("COMPLETE");
    const result = engine.getResult();
    expect(result).toMatchObject({
      completionStatus: "COMPLETED",
      plannedRounds: 3,
      roundsCompleted: 3,
      completionRate: 1,
      tradeCount: 0,
      fillVolume: 0,
      averageSpread: 0,
      quoteParticipationRate: 0,
      accountingInvariantHolds: true
    });
    expect(result.objectiveScore).toBeGreaterThanOrEqual(0);
    expect(result.objectiveScore).toBeLessThanOrEqual(100);
  });

  it("maintains the portfolio-value accounting invariant over a multi-round mixed-flow scenario", () => {
    const result = runQuotedScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 2026,
      rounds: 8,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 0.7,
      informedTraderProbability: 0.3
    }, 8);

    expect(result.history.every((round) => round.accountingInvariantHolds)).toBe(true);
    expect(result.accountingInvariantHolds).toBe(true);
    expect(result.finalPortfolio.portfolioValue).toBeCloseTo(1_000 + result.finalPortfolio.totalPnL, 10);
  });

  it("is observationally pure under repeated getState calls and different observation schedules", () => {
    const config: QuantTraderScenarioConfig = {
      family: "BASIC_MARKET_MAKING",
      seed: 777,
      rounds: 5,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 0.8,
      informedTraderProbability: 0.2
    };

    const enginePolled = createQuantTraderScenario(config);
    const engineUnpolled = createQuantTraderScenario(config);

    for (let round = 1; round <= 5; round += 1) {
      // Poll getState 20 times on the polled engine before submitting
      for (let i = 0; i < 20; i += 1) {
        const state = enginePolled.getState();
        expect(state.currentRound).toBe(round);
      }

      enginePolled.submitQuote(centeredQuote);
      engineUnpolled.submitQuote(centeredQuote);

      // Poll getState 20 times after submitting
      for (let i = 0; i < 20; i += 1) {
        const state = enginePolled.getState();
        expect(state.phase).toBe("READY_TO_ADVANCE");
      }

      const evidencePolled = enginePolled.advance();
      const evidenceUnpolled = engineUnpolled.advance();

      expect(evidencePolled).toEqual(evidenceUnpolled);
    }

    const resultPolled = enginePolled.getResult();
    const resultUnpolled = engineUnpolled.getResult();
    expect(resultPolled).toEqual(resultUnpolled);
  });

  it("rejects unknown action types and malformed action payloads without coercing them to PASS", () => {
    const engine = createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 10,
      rounds: 2,
      fairValue: 100,
      tickSize: 1
    });

    expectActionError(() => engine.submitAction({ type: "UNKNOWN_TYPE" }), "INVALID_ACTION");
    expectActionError(() => engine.submitAction({}), "INVALID_ACTION");
    expectActionError(() => engine.submitAction(null), "INVALID_ACTION");
    expectActionError(() => engine.submitAction("PASS"), "INVALID_ACTION");
    expectActionError(() => engine.submitAction({ type: "QUOTE" }), "INVALID_QUOTE");
    expectActionError(() => engine.submitAction({ type: "QUOTE", quote: null }), "INVALID_QUOTE");
    expectActionError(
      () => engine.submitAction({ type: "QUOTE", quote: { bidPrice: "not-a-number" } }),
      "INVALID_QUOTE"
    );

    // Valid PASS still works
    expect(engine.getState().phase).toBe("AWAITING_ACTION");
    engine.submitAction({ type: "PASS" });
    expect(engine.getState().phase).toBe("READY_TO_ADVANCE");
    const evidence = engine.advance();
    expect(evidence.studentAction).toEqual({ type: "PASS" });
  });

  it("rejects zero, negative, and non-finite quote prices", () => {
    const engine = createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 10,
      rounds: 2,
      fairValue: 100,
      tickSize: 1
    });

    expectActionError(
      () => engine.submitQuote({ bidPrice: 0, bidSize: 1, askPrice: 101, askSize: 1 }),
      "INVALID_QUOTE"
    );
    expectActionError(
      () => engine.submitQuote({ bidPrice: -10, bidSize: 1, askPrice: 101, askSize: 1 }),
      "INVALID_QUOTE"
    );
    expectActionError(
      () => engine.submitQuote({ bidPrice: 99, bidSize: 1, askPrice: 0, askSize: 1 }),
      "INVALID_QUOTE"
    );
    expectActionError(
      () => engine.submitQuote({ bidPrice: 99, bidSize: 1, askPrice: -5, askSize: 1 }),
      "INVALID_QUOTE"
    );
    expectActionError(
      () => engine.submitQuote({ bidPrice: Number.NaN, bidSize: 1, askPrice: 101, askSize: 1 }),
      "INVALID_QUOTE"
    );
    expectActionError(
      () => engine.submitQuote({ bidPrice: 99, bidSize: 1, askPrice: Number.POSITIVE_INFINITY, askSize: 1 }),
      "INVALID_QUOTE"
    );
  });

  it("validates scenario configuration at runtime and fails closed on invalid parameters", () => {
    const invalidConfig = { family: "UNKNOWN_FAMILY", seed: 1 } as unknown as QuantTraderScenarioConfig;
    expect(() => createQuantTraderScenario(invalidConfig)).toThrow(
      /Invalid scenario family/
    );
    expect(() => createQuantTraderScenario({ family: "BASIC_MARKET_MAKING", seed: 1, fairValue: -100 })).toThrow(
      /fairValue must be a finite positive number/
    );
    expect(() => createQuantTraderScenario({ family: "BASIC_MARKET_MAKING", seed: 1, fairValue: 0 })).toThrow(
      /fairValue must be a finite positive number/
    );
    expect(() => createQuantTraderScenario({ family: "BASIC_MARKET_MAKING", seed: 1, tickSize: 0 })).toThrow(
      /tickSize must be a finite positive number/
    );
    expect(() => createQuantTraderScenario({ family: "BASIC_MARKET_MAKING", seed: 1, tickSize: -1 })).toThrow(
      /tickSize must be a finite positive number/
    );
    expect(() => createQuantTraderScenario({ family: "BASIC_MARKET_MAKING", seed: 1, rounds: 0 })).toThrow(
      /rounds must be a positive safe integer/
    );
    expect(() => createQuantTraderScenario({ family: "BASIC_MARKET_MAKING", seed: 1, maxQuoteSize: -1 })).toThrow(
      /maxQuoteSize must be a positive safe integer/
    );
    expect(() =>
      createQuantTraderScenario({
        family: "BASIC_MARKET_MAKING",
        seed: 1,
        noiseTraderProbability: 0.8,
        informedTraderProbability: 0.5
      })
    ).toThrow(/noiseTraderProbability \+ informedTraderProbability must be <= 1/);
    expect(() =>
      createQuantTraderScenario({
        family: "BASIC_MARKET_MAKING",
        seed: 1,
        riskLimits: { maxPosition: -5 }
      })
    ).toThrow();
  });

  it("attributes student fills clearly to the student quote order and counterparty market order", () => {
    const engine = createQuantTraderScenario({
      family: "ADVERSE_SELECTION",
      seed: 1,
      rounds: 1,
      fairValue: 100,
      tickSize: 1,
      informedTraderProbability: 1,
      noiseTraderProbability: 0
    });

    engine.submitQuote({ bidPrice: 95, bidSize: 2, askPrice: 99, askSize: 2 });
    const evidence = engine.advance();

    expect(evidence.studentFills).toHaveLength(1);
    const fill = evidence.studentFills[0];
    expect(fill).toBeDefined();
    if (fill === undefined) throw new Error("Expected student fill");
    expect(fill.orderId).toMatch(/^quote_ask_STUDENT/);
    expect(fill.matchedOrderId).toMatch(/^mkt_/);
    expect(fill.side).toBe("SELL");
    expect(fill.price).toBe(99);
    expect(fill.size).toBe(2);
    expect(fill.counterparty).toBe("INFORMED_TRADER");
  });

  it("rejects extra fields at every student-action layer through the strict union", () => {
    const engine = createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 314,
      rounds: 2
    });

    expectActionError(
      () => engine.submitAction({ type: "PASS", quote: centeredQuote }),
      "INVALID_ACTION"
    );
    expectActionError(
      () => engine.submitAction({ type: "QUOTE", quote: centeredQuote, extra: true }),
      "INVALID_ACTION"
    );
    expectActionError(
      () => engine.submitAction({
        type: "QUOTE",
        quote: { ...centeredQuote, hidden: "unexpected" }
      }),
      "INVALID_QUOTE"
    );
  });

  it("rejects non-boolean substitutes and unknown scenario configuration keys without coercion", () => {
    expect(() => createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 1,
      hardPositionLimit: "false"
    } as unknown as QuantTraderScenarioConfig)).toThrow();

    expect(() => createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 1,
      stopOnRiskBreach: 1
    } as unknown as QuantTraderScenarioConfig)).toThrow();

    expect(() => createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 1,
      arbitrary: true
    } as unknown as QuantTraderScenarioConfig)).toThrow();

    expect(() => createQuantTraderScenario({
      family: "BASIC_MARKET_MAKING",
      seed: 1,
      riskLimits: { maxPosition: 5, arbitrary: 1 }
    } as unknown as QuantTraderScenarioConfig)).toThrow();
  });

  it("rejects malformed fair-value updates and unsafe numeric configuration", () => {
    expect(() => createQuantTraderScenario({
      family: "FAIR_VALUE_UPDATES",
      seed: Number.MAX_SAFE_INTEGER + 1
    })).toThrow(/seed must be a safe integer/u);

    expect(() => createQuantTraderScenario({
      family: "FAIR_VALUE_UPDATES",
      seed: 1,
      initialCash: Number.POSITIVE_INFINITY
    })).toThrow();

    expect(() => createQuantTraderScenario({
      family: "FAIR_VALUE_UPDATES",
      seed: 1,
      rounds: 3,
      fairValueUpdates: [{ round: 2, fairValue: 101 }, { round: 2, fairValue: 102 }]
    })).toThrow(/Only one fairValueUpdate/u);

    expect(() => createQuantTraderScenario({
      family: "FAIR_VALUE_UPDATES",
      seed: 1,
      rounds: 3,
      fairValueUpdates: [{ round: 4, fairValue: 101 }]
    })).toThrow(/rounds must fall within/u);

    expect(() => createQuantTraderScenario({
      family: "FAIR_VALUE_UPDATES",
      seed: 1,
      fairValueUpdates: [{ round: 2, fairValue: 101, label: "" }]
    })).toThrow();

    expect(() => createQuantTraderScenario({
      family: "FAIR_VALUE_UPDATES",
      seed: 1,
      fairValueUpdates: [{ round: 2, fairValue: 101, hidden: true }]
    } as unknown as QuantTraderScenarioConfig)).toThrow();
  });

  it("copies caller configuration and actions so later mutation cannot change scenario behavior", () => {
    const mutableConfig = {
      family: "FAIR_VALUE_UPDATES" as const,
      seed: 44,
      rounds: 2,
      fairValue: 100,
      tickSize: 1,
      noiseTraderProbability: 0,
      informedTraderProbability: 0,
      fairValueUpdates: [{ round: 2, fairValue: 105, label: "PUBLIC_NEWS" }]
    };
    const engine = createQuantTraderScenario(mutableConfig);
    const mutableUpdate = mutableConfig.fairValueUpdates[0];
    if (mutableUpdate === undefined) throw new Error("Expected fair-value update fixture");
    mutableUpdate.fairValue = 999;
    mutableUpdate.label = "MUTATED";

    const mutableQuote = { bidPrice: 99, bidSize: 1, askPrice: 101, askSize: 1 };
    engine.submitAction({ type: "QUOTE", quote: mutableQuote });
    mutableQuote.bidPrice = 1;
    mutableQuote.askPrice = 2;

    const first = engine.advance();
    expect(first.studentAction).toEqual({
      type: "QUOTE",
      quote: { bidPrice: 99, bidSize: 1, askPrice: 101, askSize: 1 }
    });
    expect(engine.getState().fairValue).toBe(105);
    expect(engine.getState().currentRoundEvents[0]?.label).toBe("PUBLIC_NEWS");
  });

  it("validates public order-book runtime inputs and fully resets market state on clear", () => {
    const book = new LimitOrderBook({
      createId: (prefix) => `${prefix}_id`,
      now: () => 1
    });

    expect(() => book.executeMarketOrder("INVALID" as unknown as "BUY", 1)).toThrow();
    expect(() => book.setQuotes("STUDENT", {
      ...centeredQuote,
      extra: true
    } as unknown as typeof centeredQuote)).toThrow();

    book.setQuotes("STUDENT", centeredQuote);
    book.executeMarketOrder("BUY", 1, "TEST");
    expect(book.getMarketState().totalVolume).toBe(1);
    expect(book.getMarketState().lastTradePrice).toBe(101);

    book.clear();
    expect(book.getMarketState()).toEqual({ totalVolume: 0 });
  });

  it("rejects overflowing portfolio arithmetic without partial mutation or audit history", () => {
    const portfolio = new PortfolioTracker(1_000);
    const before = portfolio.getSnapshot(100);

    expect(() => portfolio.applyFill({
      fillId: "overflow",
      orderId: "overflow",
      side: "BUY",
      price: Number.MAX_VALUE,
      size: 2,
      counterparty: "TEST",
      timestamp: 1
    })).toThrow(/notional must remain finite/u);

    expect(portfolio.getSnapshot(100)).toEqual(before);
    expect(portfolio.fills).toEqual([]);
  });

  it("rejects non-finite portfolio roots and marks before they corrupt risk state", () => {
    expect(() => new PortfolioTracker(Number.POSITIVE_INFINITY)).toThrow(/Initial cash must be finite/u);

    const portfolio = new PortfolioTracker(1_000);
    expect(() => portfolio.getSnapshot(Number.NaN)).toThrow(/Mark price must be finite/u);
    expect(() => portfolio.updateMarkPrice(Number.POSITIVE_INFINITY)).toThrow(/Mark price must be finite/u);
    expect(() => portfolio.checkRiskLimits(Number.NEGATIVE_INFINITY)).toThrow(/Mark price must be finite/u);
    expect(portfolio.getSnapshot(100)).toMatchObject({
      cash: 1_000,
      position: 0,
      maxDrawdown: 0,
      tradeCount: 0
    });
  });

  it("rejects non-finite derived PnL instead of exposing corrupt accounting", () => {
    const portfolio = new PortfolioTracker(10_000_000_000_000_000);
    portfolio.applyFill({
      fillId: "huge_position",
      orderId: "huge_position",
      side: "BUY",
      price: 1,
      size: Number.MAX_SAFE_INTEGER,
      counterparty: "TEST",
      timestamp: 1
    });

    expect(() => portfolio.getUnrealizedPnL(Number.MAX_VALUE))
      .toThrow(/Unrealized PnL must remain finite/u);
    expect(() => portfolio.getTotalPnL(Number.MAX_VALUE))
      .toThrow(/Unrealized PnL must remain finite/u);
    expect(() => portfolio.getSnapshot(Number.MAX_VALUE))
      .toThrow(/Portfolio value must remain finite/u);
  });

  it("copies and validates portfolio fills so external mutation cannot corrupt audit history", () => {
    const portfolio = new PortfolioTracker(1_000);
    const fill = {
      fillId: "fill_immutable",
      orderId: "order_immutable",
      side: "BUY" as const,
      price: 50,
      size: 2,
      counterparty: "TEST",
      timestamp: 1
    };

    portfolio.applyFill(fill);
    fill.price = 999;
    const exposed = portfolio.fills[0];
    expect(exposed?.price).toBe(50);

    if (exposed !== undefined) {
      (exposed as { price: number }).price = 777;
    }
    expect(portfolio.fills[0]?.price).toBe(50);

    expect(() => portfolio.applyFill({
      ...fill,
      fillId: "bad",
      size: -1
    })).toThrow();
  });


  it("rolls back a market-maker round if portfolio accounting fails after book execution", () => {
    const config = {
      gameType: "DICE_MARKET" as const,
      rounds: 1,
      initialCash: 1_000,
      fairValue: 100,
      noiseTraderProbability: 0,
      informedTraderProbability: 1
    };
    const retried = new MarketMakerSimulator(config, { random: () => 0 });
    const clean = new MarketMakerSimulator(config, { random: () => 0 });
    const portfolio = (retried as unknown as { portfolio: PortfolioTracker }).portfolio;
    const applySpy = vi.spyOn(portfolio, "applyFill").mockImplementationOnce(() => {
      throw new Error("synthetic portfolio failure");
    });

    const mispricedQuote = { bidPrice: 95, bidSize: 1, askPrice: 99, askSize: 1 };
    expect(() => retried.playRound(mispricedQuote)).toThrow(/synthetic portfolio failure/u);
    expect(retried.currentRound).toBe(1);
    expect(retried.finishGame()).toMatchObject({
      tradeCount: 0,
      averageSpread: 0,
      quoteComplianceRate: 0
    });

    expect(retried.playRound(mispricedQuote)).toEqual(clean.playRound(mispricedQuote));
    expect(retried.finishGame()).toEqual(clean.finishGame());
    applySpy.mockRestore();
  });

  it("rejects market-maker rounds past the configured horizon before consuming randomness", () => {
    let randomCalls = 0;
    const simulator = new MarketMakerSimulator({
      gameType: "DICE_MARKET",
      rounds: 1,
      initialCash: 1000,
      fairValue: 100,
      noiseTraderProbability: 0,
      informedTraderProbability: 0,
      riskLimits: {
        maxPosition: 10,
        maxDrawdown: 100,
        stopLossThreshold: 100
      }
    }, {
      random: () => {
        randomCalls += 1;
        return 0.9;
      }
    });

    simulator.playRound(centeredQuote);
    expect(randomCalls).toBe(1);
    expect(() => simulator.playRound(centeredQuote)).toThrow(/configured rounds/u);
    expect(randomCalls).toBe(1);
    expect(simulator.currentRound).toBe(2);
    expect(simulator.finishGame().quoteComplianceRate).toBe(1);
  });

});

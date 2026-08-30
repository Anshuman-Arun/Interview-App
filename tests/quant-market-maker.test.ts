import { describe, expect, it } from "vitest";
import {
  LimitOrderBook,
  MarketMakerSimulator,
  PortfolioTracker
} from "../packages/local-compute/src/index.js";
import {
  type LimitOrder,
  type OrderFill,
  type QuotePair
} from "../packages/domain/src/index.js";

describe("Quantitative Trading & Market-Making Engine", () => {
  describe("1. Limit Order Book Mechanics & Price-Time Priority", () => {
    it("places non-crossing limit orders and computes market spread", () => {
      const book = new LimitOrderBook();

      const bid1: LimitOrder = { id: "bid_1", side: "BUY", price: 100, size: 5, timestamp: 1000 };
      const bid2: LimitOrder = { id: "bid_2", side: "BUY", price: 102, size: 3, timestamp: 1005 };
      const ask1: LimitOrder = { id: "ask_1", side: "SELL", price: 105, size: 4, timestamp: 1010 };
      const ask2: LimitOrder = { id: "ask_2", side: "SELL", price: 108, size: 6, timestamp: 1015 };

      const res1 = book.placeLimitOrder(bid1);
      const res2 = book.placeLimitOrder(bid2);
      const res3 = book.placeLimitOrder(ask1);
      const res4 = book.placeLimitOrder(ask2);

      expect(res1.fills).toHaveLength(0);
      expect(res2.fills).toHaveLength(0);
      expect(res3.fills).toHaveLength(0);
      expect(res4.fills).toHaveLength(0);

      const state = book.getMarketState();
      expect(state.bestBid).toBe(102);
      expect(state.bestAsk).toBe(105);
      expect(state.midPrice).toBe(103.5);
      expect(state.spread).toBe(3);
    });

    it("matches crossing limit orders with price-time priority", () => {
      const book = new LimitOrderBook();

      book.placeLimitOrder({ id: "ask_1", side: "SELL", price: 100, size: 2, timestamp: 1000 });
      book.placeLimitOrder({ id: "ask_2", side: "SELL", price: 100, size: 5, timestamp: 1005 }); // Same price, later timestamp
      book.placeLimitOrder({ id: "ask_3", side: "SELL", price: 102, size: 10, timestamp: 1010 });

      // Aggressive BUY order crossing at 101 for size 4
      const crossBuy = book.placeLimitOrder({ id: "buy_cross", side: "BUY", price: 101, size: 4, timestamp: 2000 });

      expect(crossBuy.fills).toHaveLength(2);
      // First fill: 2 units at 100 from ask_1
      expect(crossBuy.fills[0]?.size).toBe(2);
      expect(crossBuy.fills[0]?.price).toBe(100);
      // Second fill: 2 units at 100 from ask_2 (price-time priority)
      expect(crossBuy.fills[1]?.size).toBe(2);
      expect(crossBuy.fills[1]?.price).toBe(100);

      const state = book.getMarketState();
      expect(state.bestAsk).toBe(100); // ask_2 has 3 units left at 100
      expect(state.totalVolume).toBe(4);
    });

    it("sets and updates two-sided maker quotes cleanly", () => {
      const book = new LimitOrderBook();
      const quotes: QuotePair = { bidPrice: 99, bidSize: 10, askPrice: 101, askSize: 10 };

      book.setQuotes("MAKER_A", quotes);
      let state = book.getMarketState();
      expect(state.bestBid).toBe(99);
      expect(state.bestAsk).toBe(101);
      expect(state.spread).toBe(2);

      // Update quote to tighter spread
      book.setQuotes("MAKER_A", { bidPrice: 99.5, bidSize: 5, askPrice: 100.5, askSize: 5 });
      state = book.getMarketState();
      expect(state.bestBid).toBe(99.5);
      expect(state.bestAsk).toBe(100.5);
      expect(state.spread).toBe(1);
    });
  });

  describe("2. Portfolio P&L and Risk Bounds", () => {
    it("tracks exact realized and unrealized P&L across buy and sell cycles", () => {
      const portfolio = new PortfolioTracker(1000);

      // Buy 10 units at 50 -> Cash = 500, Position = +10, Avg Cost = 50
      const buyFill: OrderFill = {
        fillId: "fill_1",
        orderId: "ord_1",
        side: "BUY",
        price: 50,
        size: 10,
        counterparty: "EXCHANGE",
        timestamp: 1000
      };
      portfolio.applyFill(buyFill);

      expect(portfolio.cash).toBe(500);
      expect(portfolio.position).toBe(10);
      expect(portfolio.realizedPnL).toBe(0);

      // Mark price moves to 55 -> Unrealized = +50, Total PnL = +50, Portfolio Value = 1050
      let snapshot = portfolio.updateMarkPrice(55);
      expect(snapshot.unrealizedPnL).toBe(50);
      expect(snapshot.totalPnL).toBe(50);
      expect(snapshot.portfolioValue).toBe(1050);

      // Sell 6 units at 55 -> Realized = +30, Remaining Position = +4, Cash = 830
      const sellFill: OrderFill = {
        fillId: "fill_2",
        orderId: "ord_2",
        side: "SELL",
        price: 55,
        size: 6,
        counterparty: "EXCHANGE",
        timestamp: 2000
      };
      portfolio.applyFill(sellFill);

      expect(portfolio.cash).toBe(830);
      expect(portfolio.position).toBe(4);
      expect(portfolio.realizedPnL).toBe(30);

      snapshot = portfolio.updateMarkPrice(55);
      expect(snapshot.realizedPnL).toBe(30);
      expect(snapshot.unrealizedPnL).toBe(20);
      expect(snapshot.totalPnL).toBe(50);
    });

    it("detects risk limit breaches (max position and stop-loss)", () => {
      const positionPortfolio = new PortfolioTracker(1000, {
        maxPosition: 5,
        stopLossThreshold: 500,
        maxDrawdown: 500
      });

      // Buy 6 units (exceeds maxPosition = 5)
      positionPortfolio.applyFill({
        fillId: "fill_1",
        orderId: "ord_1",
        side: "BUY",
        price: 100,
        size: 6,
        counterparty: "EXCHANGE",
        timestamp: 1000
      });

      const positionCheck = positionPortfolio.checkRiskLimits(100);
      expect(positionCheck.breached).toBe(true);
      expect(positionCheck.reason).toContain("maximum limit");

      const stopLossPortfolio = new PortfolioTracker(1000, {
        maxPosition: 100,
        stopLossThreshold: 100,
        maxDrawdown: 500
      });

      // Buy 4 units at 100
      stopLossPortfolio.applyFill({
        fillId: "fill_2",
        orderId: "ord_2",
        side: "BUY",
        price: 100,
        size: 4,
        counterparty: "EXCHANGE",
        timestamp: 1000
      });

      // Price drops to 70 (Loss = 4 * 30 = 120 > stopLossThreshold 100)
      const stopLossCheck = stopLossPortfolio.checkRiskLimits(70);
      expect(stopLossCheck.breached).toBe(true);
      expect(stopLossCheck.reason).toContain("stop-loss");
    });
  });

  describe("3. Market-Making Simulation Games", () => {
    it("simulates 2-Dice Market Making game with informed and noise order flow", () => {
      const sim = new MarketMakerSimulator({
        gameType: "DICE_MARKET",
        rounds: 5,
        initialCash: 1000,
        fairValue: 7.0, // Expected sum of 2 fair dice
        noiseTraderProbability: 0.8,
        informedTraderProbability: 0.2
      });

      expect(sim.fairValue).toBe(7.0);

      // Student quotes around fair value 7.0 (Bid 6.5, Ask 7.5, spread 1.0)
      for (let r = 1; r <= 5; r++) {
        const action = sim.playRound({
          bidPrice: 6.5,
          bidSize: 5,
          askPrice: 7.5,
          askSize: 5
        });
        expect(action.round).toBe(r);
        expect(action.studentQuote.bidPrice).toBe(6.5);
        expect(action.studentQuote.askPrice).toBe(7.5);
      }

      const result = sim.finishGame();
      expect(result.gameType).toBe("DICE_MARKET");
      expect(result.averageSpread).toBe(1.0);
      expect(result.quoteComplianceRate).toBe(1.0);
      expect(result.score).toBeGreaterThanOrEqual(50);
    });

    it("penalizes student when informed trader picks off mispriced quotes", () => {
      const sim = new MarketMakerSimulator({
        gameType: "DICE_MARKET",
        rounds: 3,
        initialCash: 1000,
        fairValue: 7.0,
        noiseTraderProbability: 0,
        informedTraderProbability: 1.0 // 100% informed trader
      });

      // Student posts mispriced quote: Ask 6.0 when fair value is 7.0
      // Informed trader will buy from student at 6.0
      const round1 = sim.playRound({
        bidPrice: 5.0,
        bidSize: 2,
        askPrice: 6.0, // Underpriced ask!
        askSize: 2
      });

      expect(round1.orderFlowType).toBe("INFORMED");
      expect(round1.tradeSide).toBe("SELL");
      expect(round1.tradePrice).toBe(6.0);

      const result = sim.finishGame();
      // Student is short at 6.0 while fair value is 7.0 -> Loss = -2.0
      expect(result.totalPnL).toBeLessThan(0);
    });
  });
});

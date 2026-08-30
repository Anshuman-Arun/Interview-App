import {
  type QuotePair,
  type TradingGameConfig,
  type TradingGameResult,
  QuotePairSchema,
  TradingGameConfigSchema,
  TradingGameResultSchema
} from "../../domain/src/index.js";
import { LimitOrderBook } from "./order-book.js";
import { PortfolioTracker } from "./portfolio-tracker.js";

export interface SimulatedRoundAction {
  readonly round: number;
  readonly studentQuote: QuotePair;
  readonly orderFlowType: "INFORMED" | "NOISE" | "NO_TRADE";
  readonly tradeSide?: "BUY" | "SELL";
  readonly tradePrice?: number;
  readonly tradeSize?: number;
}

export class MarketMakerSimulator {
  private readonly config: TradingGameConfig;
  private readonly orderBook = new LimitOrderBook();
  private readonly portfolio: PortfolioTracker;
  private roundsHistory: SimulatedRoundAction[] = [];
  private totalSpreadSum = 0;
  private validQuoteRounds = 0;

  public constructor(configInput: TradingGameConfig) {
    this.config = TradingGameConfigSchema.parse(configInput);
    this.portfolio = new PortfolioTracker(this.config.initialCash, this.config.riskLimits);
  }

  public get fairValue(): number {
    return this.config.fairValue;
  }

  public get currentRound(): number {
    return this.roundsHistory.length + 1;
  }

  public playRound(studentQuoteInput: QuotePair): SimulatedRoundAction {
    const studentQuote = QuotePairSchema.parse(studentQuoteInput);
    const roundNumber = this.currentRound;

    this.validQuoteRounds += 1;
    const currentSpread = studentQuote.askPrice - studentQuote.bidPrice;
    this.totalSpreadSum += currentSpread;

    // Set student quotes on order book
    this.orderBook.setQuotes("STUDENT", studentQuote);

    // Simulate order arrival based on probabilities
    const random = Math.random();
    let orderFlowType: "INFORMED" | "NOISE" | "NO_TRADE" = "NO_TRADE";
    let tradeSide: "BUY" | "SELL" | undefined;
    let tradePrice: number | undefined;
    let tradeSize: number | undefined;

    if (random < this.config.informedTraderProbability) {
      // Informed trader knows true fair value and picks off mispriced quotes
      orderFlowType = "INFORMED";
      if (studentQuote.askPrice < this.config.fairValue) {
        // Student ask is too low -> Informed trader buys from student
        const fills = this.orderBook.executeMarketOrder("BUY", studentQuote.askSize, "INFORMED_TRADER");
        if (fills[0] !== undefined) {
          tradeSide = "SELL"; // Student sold to buyer
          tradePrice = fills[0].price;
          tradeSize = fills[0].size;
          this.portfolio.applyFill({ ...fills[0], side: "SELL" });
        }
      } else if (studentQuote.bidPrice > this.config.fairValue) {
        // Student bid is too high -> Informed trader sells to student
        const fills = this.orderBook.executeMarketOrder("SELL", studentQuote.bidSize, "INFORMED_TRADER");
        if (fills[0] !== undefined) {
          tradeSide = "BUY"; // Student bought from seller
          tradePrice = fills[0].price;
          tradeSize = fills[0].size;
          this.portfolio.applyFill({ ...fills[0], side: "BUY" });
        }
      } else {
        // Quote straddles fair value cleanly -> Informed trader sees no edge
        orderFlowType = "NO_TRADE";
      }
    } else if (random < this.config.informedTraderProbability + this.config.noiseTraderProbability) {
      // Noise trader executes randomly with equal probability if spread is reasonable
      orderFlowType = "NOISE";
      const noiseBuy = Math.random() < 0.5;

      if (noiseBuy && currentSpread <= 10) {
        const fills = this.orderBook.executeMarketOrder("BUY", 1, "NOISE_TRADER");
        if (fills[0] !== undefined) {
          tradeSide = "SELL";
          tradePrice = fills[0].price;
          tradeSize = fills[0].size;
          this.portfolio.applyFill({ ...fills[0], side: "SELL" });
        }
      } else if (!noiseBuy && currentSpread <= 10) {
        const fills = this.orderBook.executeMarketOrder("SELL", 1, "NOISE_TRADER");
        if (fills[0] !== undefined) {
          tradeSide = "BUY";
          tradePrice = fills[0].price;
          tradeSize = fills[0].size;
          this.portfolio.applyFill({ ...fills[0], side: "BUY" });
        }
      }
    }

    this.portfolio.updateMarkPrice(this.config.fairValue);

    const roundAction: SimulatedRoundAction = {
      round: roundNumber,
      studentQuote,
      orderFlowType,
      ...(tradeSide ? { tradeSide } : {}),
      ...(tradePrice !== undefined ? { tradePrice } : {}),
      ...(tradeSize !== undefined ? { tradeSize } : {})
    };

    this.roundsHistory.push(roundAction);
    return roundAction;
  }

  public finishGame(): TradingGameResult {
    const markSnapshot = this.portfolio.updateMarkPrice(this.config.fairValue);
    const avgSpread = this.validQuoteRounds > 0 ? this.totalSpreadSum / this.validQuoteRounds : 0;
    const complianceRate = this.validQuoteRounds / this.config.rounds;

    // Calculate score (0-100):
    // - Profitability: +50 base for positive total PnL
    // - Spread discipline: +25 for maintaining reasonable tight spreads (<= 4.0)
    // - Risk limit discipline: +25 for zero stop-loss breaches and low drawdown
    let score = 50;

    if (markSnapshot.totalPnL > 0) {
      score += Math.min(25, Math.round(markSnapshot.totalPnL * 2));
    } else {
      score -= Math.min(30, Math.round(Math.abs(markSnapshot.totalPnL) * 2));
    }

    if (avgSpread > 0 && avgSpread <= 4.0) {
      score += 15;
    } else if (avgSpread > 10.0) {
      score -= 20; // Penalize excessively wide non-competitive quotes
    }

    if (markSnapshot.maxDrawdown < 50) {
      score += 10;
    } else {
      score -= Math.min(20, Math.round(markSnapshot.maxDrawdown / 10));
    }

    const boundedScore = Math.max(0, Math.min(100, score));

    return TradingGameResultSchema.parse({
      gameType: this.config.gameType,
      totalPnL: markSnapshot.totalPnL,
      realizedPnL: markSnapshot.realizedPnL,
      unrealizedPnL: markSnapshot.unrealizedPnL,
      finalPosition: markSnapshot.position,
      finalCash: markSnapshot.cash,
      tradeCount: markSnapshot.tradeCount,
      maxDrawdown: markSnapshot.maxDrawdown,
      averageSpread: avgSpread,
      quoteComplianceRate: Math.min(1, complianceRate),
      score: boundedScore
    });
  }
}

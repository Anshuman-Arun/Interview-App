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

export interface MarketMakerSimulatorRuntime {
  readonly random?: () => number;
}

export interface MarketMakingScoreInput {
  readonly totalPnL: number;
  readonly averageSpread: number;
  readonly maxDrawdown: number;
  readonly riskBreaches?: number;
  readonly quoteParticipationRate?: number;
}

export function calculateMarketMakingScore(input: MarketMakingScoreInput): number {
  for (const [name, value] of [
    ["totalPnL", input.totalPnL],
    ["averageSpread", input.averageSpread],
    ["maxDrawdown", input.maxDrawdown]
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${name} must be finite`);
    }
  }
  if (input.averageSpread < 0 || input.maxDrawdown < 0) {
    throw new RangeError("averageSpread and maxDrawdown must be non-negative");
  }
  if (
    input.riskBreaches !== undefined
    && (!Number.isSafeInteger(input.riskBreaches) || input.riskBreaches < 0)
  ) {
    throw new RangeError("riskBreaches must be a non-negative safe integer");
  }
  if (
    input.quoteParticipationRate !== undefined
    && (
      !Number.isFinite(input.quoteParticipationRate)
      || input.quoteParticipationRate < 0
      || input.quoteParticipationRate > 1
    )
  ) {
    throw new RangeError("quoteParticipationRate must be between 0 and 1");
  }

  let score = 50;

  if (input.totalPnL > 0) score += Math.min(25, Math.round(input.totalPnL * 2));
  else score -= Math.min(30, Math.round(Math.abs(input.totalPnL) * 2));

  if (input.averageSpread > 0 && input.averageSpread <= 4.0) score += 15;
  else if (input.averageSpread > 10.0) score -= 20;

  if (input.maxDrawdown < 50) score += 10;
  else score -= Math.min(20, Math.round(input.maxDrawdown / 10));

  score -= Math.min(30, (input.riskBreaches ?? 0) * 15);
  score -= Math.round(Math.max(0, 1 - (input.quoteParticipationRate ?? 1)) * 20);
  return Math.max(0, Math.min(100, score));
}

export class MarketMakerSimulator {
  private readonly config: TradingGameConfig;
  private readonly orderBook = new LimitOrderBook();
  private readonly portfolio: PortfolioTracker;
  private roundsHistory: SimulatedRoundAction[] = [];
  private totalSpreadSum = 0;
  private validQuoteRounds = 0;
  private readonly random: () => number;

  public constructor(configInput: TradingGameConfig, runtime: MarketMakerSimulatorRuntime = {}) {
    this.config = TradingGameConfigSchema.parse(configInput);
    this.portfolio = new PortfolioTracker(this.config.initialCash, this.config.riskLimits);
    this.random = runtime.random ?? (() => Math.random());
  }

  public get fairValue(): number {
    return this.config.fairValue;
  }

  public get currentRound(): number {
    return this.roundsHistory.length + 1;
  }

  public playRound(studentQuoteInput: QuotePair): SimulatedRoundAction {
    if (this.roundsHistory.length >= this.config.rounds) {
      throw new Error("Market-making game has already completed its configured rounds");
    }
    const studentQuote = QuotePairSchema.parse(studentQuoteInput);
    const roundNumber = this.currentRound;
    const orderBookCheckpoint = this.orderBook.checkpoint();
    const portfolioCheckpoint = this.portfolio.checkpoint();
    const historyLength = this.roundsHistory.length;
    const totalSpreadBefore = this.totalSpreadSum;
    const validQuoteRoundsBefore = this.validQuoteRounds;

    try {
    // Validate all randomness required by this path before mutating round state.
    const random = this.nextRandom();
    const noiseBuyRoll = random >= this.config.informedTraderProbability
      && random < this.config.informedTraderProbability + this.config.noiseTraderProbability
      ? this.nextRandom()
      : undefined;

    this.validQuoteRounds += 1;
    const currentSpread = studentQuote.askPrice - studentQuote.bidPrice;
    this.totalSpreadSum += currentSpread;

    // Set student quotes on order book
    this.orderBook.setQuotes("STUDENT", studentQuote);

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
      if (noiseBuyRoll === undefined) throw new Error("Noise flow is missing its validated random draw");
      const noiseBuy = noiseBuyRoll < 0.5;

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
    } catch (error) {
      this.orderBook.restore(orderBookCheckpoint);
      this.portfolio.restore(portfolioCheckpoint);
      this.roundsHistory.splice(historyLength);
      this.totalSpreadSum = totalSpreadBefore;
      this.validQuoteRounds = validQuoteRoundsBefore;
      throw error;
    }
  }

  private nextRandom(): number {
    const value = this.random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError("Market-maker random source must return a finite value in [0, 1)");
    }
    return value;
  }

  public finishGame(): TradingGameResult {
    const markSnapshot = this.portfolio.updateMarkPrice(this.config.fairValue);
    const avgSpread = this.validQuoteRounds > 0 ? this.totalSpreadSum / this.validQuoteRounds : 0;
    const complianceRate = this.validQuoteRounds / this.config.rounds;

    const boundedScore = calculateMarketMakingScore({
      totalPnL: markSnapshot.totalPnL,
      averageSpread: avgSpread,
      maxDrawdown: markSnapshot.maxDrawdown
    });

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

import {
  type OrderFill,
  type PositionRiskLimits,
  PositionRiskLimitsSchema
} from "../../domain/src/index.js";

export interface PortfolioSnapshot {
  readonly cash: number;
  readonly position: number;
  readonly realizedPnL: number;
  readonly unrealizedPnL: number;
  readonly totalPnL: number;
  readonly portfolioValue: number;
  readonly averageCostBasis: number;
  readonly maxDrawdown: number;
  readonly tradeCount: number;
}

export class PortfolioTracker {
  private currentCash: number;
  private currentPosition = 0;
  private totalCostBasis = 0;
  private currentRealizedPnL = 0;
  private peakPortfolioValue: number;
  private currentMaxDrawdown = 0;
  private fillsHistory: OrderFill[] = [];
  private readonly riskLimits: PositionRiskLimits;

  public constructor(initialCash = 1000, riskLimits?: Partial<PositionRiskLimits>) {
    this.currentCash = initialCash;
    this.peakPortfolioValue = initialCash;
    this.riskLimits = PositionRiskLimitsSchema.parse({
      ...riskLimits
    });
  }

  public get cash(): number {
    return this.currentCash;
  }

  public get position(): number {
    return this.currentPosition;
  }

  public get realizedPnL(): number {
    return this.currentRealizedPnL;
  }

  public get fills(): readonly OrderFill[] {
    return [...this.fillsHistory];
  }

  public applyFill(fill: OrderFill): void {
    this.fillsHistory.push(fill);

    if (fill.side === "BUY") {
      this.currentCash -= fill.price * fill.size;

      if (this.currentPosition >= 0) {
        // Adding to long position
        this.totalCostBasis += fill.price * fill.size;
        this.currentPosition += fill.size;
      } else {
        // Covering short position
        const coverSize = Math.min(fill.size, Math.abs(this.currentPosition));
        const avgShortPrice = this.totalCostBasis / Math.abs(this.currentPosition);
        const pnl = (avgShortPrice - fill.price) * coverSize;
        this.currentRealizedPnL += pnl;

        this.currentPosition += fill.size;
        if (this.currentPosition < 0) {
          this.totalCostBasis = avgShortPrice * Math.abs(this.currentPosition);
        } else {
          const remainder = fill.size - coverSize;
          this.totalCostBasis = remainder * fill.price;
        }
      }
    } else {
      // SELL fill
      this.currentCash += fill.price * fill.size;

      if (this.currentPosition <= 0) {
        // Adding to short position
        this.totalCostBasis += fill.price * fill.size;
        this.currentPosition -= fill.size;
      } else {
        // Closing long position
        const closeSize = Math.min(fill.size, this.currentPosition);
        const avgLongPrice = this.totalCostBasis / this.currentPosition;
        const pnl = (fill.price - avgLongPrice) * closeSize;
        this.currentRealizedPnL += pnl;

        this.currentPosition -= fill.size;
        if (this.currentPosition > 0) {
          this.totalCostBasis = avgLongPrice * this.currentPosition;
        } else {
          const remainder = fill.size - closeSize;
          this.totalCostBasis = remainder * fill.price;
        }
      }
    }
  }

  public getUnrealizedPnL(markPrice: number): number {
    if (this.currentPosition === 0) return 0;
    const avgCost = this.totalCostBasis / Math.abs(this.currentPosition);
    return this.currentPosition > 0
      ? (markPrice - avgCost) * this.currentPosition
      : (avgCost - markPrice) * Math.abs(this.currentPosition);
  }

  public getTotalPnL(markPrice: number): number {
    return this.currentRealizedPnL + this.getUnrealizedPnL(markPrice);
  }

  public getPortfolioValue(markPrice: number): number {
    return this.currentCash + this.currentPosition * markPrice;
  }

  public updateMarkPrice(markPrice: number): PortfolioSnapshot {
    const portfolioVal = this.getPortfolioValue(markPrice);
    if (portfolioVal > this.peakPortfolioValue) {
      this.peakPortfolioValue = portfolioVal;
    }

    const drawdown = Math.max(0, this.peakPortfolioValue - portfolioVal);
    if (drawdown > this.currentMaxDrawdown) {
      this.currentMaxDrawdown = drawdown;
    }

    const unrealized = this.getUnrealizedPnL(markPrice);
    const avgCost =
      this.currentPosition !== 0 ? this.totalCostBasis / Math.abs(this.currentPosition) : 0;

    return {
      cash: this.currentCash,
      position: this.currentPosition,
      realizedPnL: this.currentRealizedPnL,
      unrealizedPnL: unrealized,
      totalPnL: this.currentRealizedPnL + unrealized,
      portfolioValue: portfolioVal,
      averageCostBasis: avgCost,
      maxDrawdown: this.currentMaxDrawdown,
      tradeCount: this.fillsHistory.length
    };
  }

  public checkRiskLimits(markPrice: number): { readonly breached: boolean; readonly reason?: string } {
    if (Math.abs(this.currentPosition) > this.riskLimits.maxPosition) {
      return {
        breached: true,
        reason: `Position ${String(this.currentPosition)} exceeds maximum limit ${String(this.riskLimits.maxPosition)}`
      };
    }

    const totalPnL = this.getTotalPnL(markPrice);
    if (totalPnL < -this.riskLimits.stopLossThreshold) {
      return {
        breached: true,
        reason: `Loss ${String(totalPnL)} breached stop-loss threshold ${String(this.riskLimits.stopLossThreshold)}`
      };
    }

    const drawdown = Math.max(0, this.peakPortfolioValue - this.getPortfolioValue(markPrice));
    if (drawdown > this.riskLimits.maxDrawdown) {
      return {
        breached: true,
        reason: `Drawdown ${String(drawdown)} breached max drawdown limit ${String(this.riskLimits.maxDrawdown)}`
      };
    }

    return { breached: false };
  }
}

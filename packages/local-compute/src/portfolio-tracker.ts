import {
  type OrderFill,
  type PositionRiskLimits,
  OrderFillSchema,
  PositionRiskLimitsSchema
} from "../../domain/src/index.js";

interface PortfolioTrackerCheckpoint {
  readonly cash: number;
  readonly position: number;
  readonly totalCostBasis: number;
  readonly realizedPnL: number;
  readonly peakPortfolioValue: number;
  readonly maxDrawdown: number;
  readonly fills: readonly OrderFill[];
}

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
    if (!Number.isFinite(initialCash)) {
      throw new RangeError("Initial cash must be finite");
    }
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
    return this.fillsHistory.map((fill) => ({ ...fill }));
  }

  /** @internal Transaction rollback support for scenario orchestration. */
  public checkpoint(): PortfolioTrackerCheckpoint {
    return {
      cash: this.currentCash,
      position: this.currentPosition,
      totalCostBasis: this.totalCostBasis,
      realizedPnL: this.currentRealizedPnL,
      peakPortfolioValue: this.peakPortfolioValue,
      maxDrawdown: this.currentMaxDrawdown,
      fills: this.fillsHistory.map((fill) => ({ ...fill }))
    };
  }

  /** @internal Transaction rollback support for scenario orchestration. */
  public restore(checkpoint: PortfolioTrackerCheckpoint): void {
    for (const [name, value] of [
      ["cash", checkpoint.cash],
      ["total cost basis", checkpoint.totalCostBasis],
      ["realized PnL", checkpoint.realizedPnL],
      ["peak portfolio value", checkpoint.peakPortfolioValue],
      ["max drawdown", checkpoint.maxDrawdown]
    ] as const) {
      if (!Number.isFinite(value)) throw new Error(`Invalid portfolio checkpoint ${name}`);
    }
    if (!Number.isSafeInteger(checkpoint.position)) {
      throw new Error("Invalid portfolio checkpoint position");
    }
    if (checkpoint.maxDrawdown < 0) {
      throw new Error("Invalid portfolio checkpoint max drawdown");
    }

    this.currentCash = checkpoint.cash;
    this.currentPosition = checkpoint.position;
    this.totalCostBasis = checkpoint.totalCostBasis;
    this.currentRealizedPnL = checkpoint.realizedPnL;
    this.peakPortfolioValue = checkpoint.peakPortfolioValue;
    this.currentMaxDrawdown = checkpoint.maxDrawdown;
    this.fillsHistory = checkpoint.fills.map((fill) => OrderFillSchema.parse({ ...fill }));
  }

  /**
   * @internal Quote-admission preview. Exercises the exact fill + mark-price
   * accounting path and restores all state even when arithmetic fails.
   */
  public assertPotentialFillArithmetic(
    fillInput: OrderFill,
    markPrice: number
  ): void {
    const checkpoint = this.checkpoint();
    try {
      this.applyFill(fillInput);
      this.updateMarkPrice(markPrice);
    } finally {
      this.restore(checkpoint);
    }
  }

  public applyFill(fillInput: OrderFill): void {
    const fill = OrderFillSchema.parse(fillInput);
    const notional = fill.price * fill.size;
    if (!Number.isFinite(notional)) {
      throw new RangeError("Fill notional must remain finite");
    }

    let nextCash = this.currentCash;
    let nextPosition = this.currentPosition;
    let nextCostBasis = this.totalCostBasis;
    let nextRealizedPnL = this.currentRealizedPnL;

    if (fill.side === "BUY") {
      nextCash -= notional;

      if (this.currentPosition >= 0) {
        nextCostBasis += notional;
        nextPosition += fill.size;
      } else {
        const coverSize = Math.min(fill.size, Math.abs(this.currentPosition));
        const avgShortPrice = this.totalCostBasis / Math.abs(this.currentPosition);
        const pnl = (avgShortPrice - fill.price) * coverSize;
        nextRealizedPnL += pnl;

        nextPosition += fill.size;
        if (nextPosition < 0) {
          nextCostBasis = avgShortPrice * Math.abs(nextPosition);
        } else {
          const remainder = fill.size - coverSize;
          nextCostBasis = remainder * fill.price;
        }
      }
    } else {
      nextCash += notional;

      if (this.currentPosition <= 0) {
        nextCostBasis += notional;
        nextPosition -= fill.size;
      } else {
        const closeSize = Math.min(fill.size, this.currentPosition);
        const avgLongPrice = this.totalCostBasis / this.currentPosition;
        const pnl = (fill.price - avgLongPrice) * closeSize;
        nextRealizedPnL += pnl;

        nextPosition -= fill.size;
        if (nextPosition > 0) {
          nextCostBasis = avgLongPrice * nextPosition;
        } else {
          const remainder = fill.size - closeSize;
          nextCostBasis = remainder * fill.price;
        }
      }
    }

    if (!Number.isSafeInteger(nextPosition)) {
      throw new RangeError("Portfolio position must remain a safe integer");
    }
    for (const [name, value] of [
      ["cash", nextCash],
      ["cost basis", nextCostBasis],
      ["realized PnL", nextRealizedPnL]
    ] as const) {
      if (!Number.isFinite(value)) {
        throw new RangeError(`Portfolio ${name} must remain finite`);
      }
    }

    this.currentCash = nextCash;
    this.currentPosition = nextPosition;
    this.totalCostBasis = nextCostBasis;
    this.currentRealizedPnL = nextRealizedPnL;
    this.fillsHistory.push({ ...fill });
  }

  public getUnrealizedPnL(markPrice: number): number {
    assertFiniteMarkPrice(markPrice);
    if (this.currentPosition === 0) return 0;
    const avgCost = this.totalCostBasis / Math.abs(this.currentPosition);
    const unrealized = this.currentPosition > 0
      ? (markPrice - avgCost) * this.currentPosition
      : (avgCost - markPrice) * Math.abs(this.currentPosition);
    if (!Number.isFinite(unrealized)) {
      throw new RangeError("Unrealized PnL must remain finite");
    }
    return unrealized;
  }

  public getTotalPnL(markPrice: number): number {
    const total = this.currentRealizedPnL + this.getUnrealizedPnL(markPrice);
    if (!Number.isFinite(total)) {
      throw new RangeError("Total PnL must remain finite");
    }
    return total;
  }

  public getPortfolioValue(markPrice: number): number {
    assertFiniteMarkPrice(markPrice);
    const value = this.currentCash + this.currentPosition * markPrice;
    if (!Number.isFinite(value)) {
      throw new RangeError("Portfolio value must remain finite");
    }
    return value;
  }

  public getSnapshot(markPrice: number): PortfolioSnapshot {
    const portfolioVal = this.getPortfolioValue(markPrice);
    const unrealized = this.getUnrealizedPnL(markPrice);
    const avgCost =
      this.currentPosition !== 0 ? this.totalCostBasis / Math.abs(this.currentPosition) : 0;
    const totalPnL = this.currentRealizedPnL + unrealized;
    if (!Number.isFinite(avgCost) || !Number.isFinite(totalPnL)) {
      throw new RangeError("Portfolio snapshot accounting must remain finite");
    }

    return {
      cash: this.currentCash,
      position: this.currentPosition,
      realizedPnL: this.currentRealizedPnL,
      unrealizedPnL: unrealized,
      totalPnL,
      portfolioValue: portfolioVal,
      averageCostBasis: avgCost,
      maxDrawdown: this.currentMaxDrawdown,
      tradeCount: this.fillsHistory.length
    };
  }

  public updateMarkPrice(markPrice: number): PortfolioSnapshot {
    const portfolioVal = this.getPortfolioValue(markPrice);
    if (portfolioVal > this.peakPortfolioValue) {
      this.peakPortfolioValue = portfolioVal;
    }

    const drawdown = Math.max(0, this.peakPortfolioValue - portfolioVal);
    if (!Number.isFinite(drawdown)) {
      throw new RangeError("Portfolio drawdown must remain finite");
    }
    if (drawdown > this.currentMaxDrawdown) {
      this.currentMaxDrawdown = drawdown;
    }

    return this.getSnapshot(markPrice);
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
    if (!Number.isFinite(drawdown)) {
      throw new RangeError("Portfolio drawdown must remain finite");
    }
    if (drawdown > this.riskLimits.maxDrawdown) {
      return {
        breached: true,
        reason: `Drawdown ${String(drawdown)} breached max drawdown limit ${String(this.riskLimits.maxDrawdown)}`
      };
    }

    return { breached: false };
  }
}


function assertFiniteMarkPrice(markPrice: number): void {
  if (!Number.isFinite(markPrice)) {
    throw new RangeError("Mark price must be finite");
  }
}

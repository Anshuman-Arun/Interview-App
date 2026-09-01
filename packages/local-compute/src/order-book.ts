import {
  type LimitOrder,
  type MarketState,
  type OrderFill,
  type OrderSide,
  type QuotePair,
  LimitOrderSchema,
  MarketStateSchema,
  OrderFillSchema,
  OrderSideSchema,
  QuotePairSchema
} from "../../domain/src/index.js";

export interface OrderPlacementResult {
  readonly placedOrder?: LimitOrder;
  readonly fills: readonly OrderFill[];
}

export interface LimitOrderBookRuntime {
  readonly now?: () => number;
  readonly createId?: (prefix: string) => string;
}

interface LimitOrderBookCheckpoint {
  readonly bids: readonly LimitOrder[];
  readonly asks: readonly LimitOrder[];
  readonly lastTradePrice: number | undefined;
  readonly totalVolume: number;
  readonly activeMakerQuotes: ReadonlyMap<string, { readonly bidId?: string; readonly askId?: string }>;
  readonly generatedIds: ReadonlySet<string>;
}

interface PlannedRestingMutation {
  readonly orderId: string;
  readonly remainingSize: number;
}

interface MatchPlan {
  readonly fills: readonly OrderFill[];
  readonly restingMutations: readonly PlannedRestingMutation[];
  readonly remainingSize: number;
  readonly totalMatchedSize: number;
  readonly lastTradePrice: number | undefined;
}

export class LimitOrderBook {
  private bids: LimitOrder[] = []; // sorted descending by price, then ascending by timestamp
  private asks: LimitOrder[] = []; // sorted ascending by price, then ascending by timestamp
  private lastTradePrice: number | undefined;
  private totalVolume = 0;
  private activeMakerQuotes = new Map<string, { bidId?: string; askId?: string }>();
  private readonly generatedIds = new Set<string>();
  private readonly now: () => number;
  private readonly createId: (prefix: string) => string;

  public constructor(runtime: LimitOrderBookRuntime = {}) {
    this.now = runtime.now ?? (() => Date.now());
    const createId = runtime.createId ?? ((prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`);
    this.createId = (prefix: string) => {
      const id = createId(prefix);
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new Error("Generated order-book id must be a non-empty string");
      }
      if (this.generatedIds.has(id)) {
        throw new Error(`Generated order-book id was reused: ${id}`);
      }
      this.generatedIds.add(id);
      return id;
    };
  }

  public placeLimitOrder(orderInput: LimitOrder, counterparty = "TRADER"): OrderPlacementResult {
    return this.withRollback(() => {
    const order = LimitOrderSchema.parse(orderInput);
    assertNonBlank(counterparty, "counterparty");
    if (this.hasActiveOrderId(order.id)) {
      throw new Error(`Active order id already exists: ${order.id}`);
    }

    const plan = this.planMatch(order.side, order.size, order.price, order.id, counterparty);
    this.commitMatchPlan(plan);

    if (plan.remainingSize > 0) {
      const remainingOrder: LimitOrder = { ...order, size: plan.remainingSize };
      if (order.side === "BUY") this.insertBid(remainingOrder);
      else this.insertAsk(remainingOrder);
      return { placedOrder: remainingOrder, fills: plan.fills };
    }
    return { fills: plan.fills };
    });
  }

  public executeMarketOrder(
    sideInput: OrderSide,
    size: number,
    counterparty = "MARKET_TAKER"
  ): readonly OrderFill[] {
    return this.withRollback(() => {
    const side = OrderSideSchema.parse(sideInput);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error("Market order size must be a positive safe integer");
    }
    assertNonBlank(counterparty, "counterparty");

    const marketOrderId = this.createId("mkt");
    if (this.hasActiveOrderId(marketOrderId)) {
      throw new Error(`Generated market order id collides with an active order: ${marketOrderId}`);
    }

    const plan = this.planMatch(side, size, undefined, marketOrderId, counterparty);
    this.commitMatchPlan(plan);
    return plan.fills;
    });
  }

  public setQuotes(ownerId: string, quotesInput: QuotePair): { readonly bidOrder: LimitOrder; readonly askOrder: LimitOrder } {
    return this.withRollback(() => {
    assertNonBlank(ownerId, "ownerId");
    const quotes = QuotePairSchema.parse(quotesInput);
    const now = this.now();
    const bidOrder = LimitOrderSchema.parse({
      id: this.createId(`quote_bid_${ownerId}`),
      side: "BUY",
      price: quotes.bidPrice,
      size: quotes.bidSize,
      timestamp: now
    });
    const askOrder = LimitOrderSchema.parse({
      id: this.createId(`quote_ask_${ownerId}`),
      side: "SELL",
      price: quotes.askPrice,
      size: quotes.askSize,
      timestamp: now
    });
    if (bidOrder.id === askOrder.id) {
      throw new Error("Maker bid and ask ids must be distinct");
    }

    const replacing = this.activeMakerQuotes.get(ownerId);
    const replaceableIds = new Set(
      [replacing?.bidId, replacing?.askId].filter((id): id is string => id !== undefined)
    );
    for (const orderId of [bidOrder.id, askOrder.id]) {
      if (this.hasActiveOrderId(orderId) && !replaceableIds.has(orderId)) {
        throw new Error(`Active order id already exists: ${orderId}`);
      }
    }

    // Validate the complete replacement before removing the old quote pair.
    this.cancelMakerQuotes(ownerId);
    this.insertBid(bidOrder);
    this.insertAsk(askOrder);

    this.activeMakerQuotes.set(ownerId, { bidId: bidOrder.id, askId: askOrder.id });
    return { bidOrder, askOrder };
    });
  }

  public cancelMakerQuotes(ownerId: string): void {
    const existing = this.activeMakerQuotes.get(ownerId);
    if (existing === undefined) return;

    if (existing.bidId) this.cancelOrder(existing.bidId);
    if (existing.askId) this.cancelOrder(existing.askId);

    this.activeMakerQuotes.delete(ownerId);
  }

  public cancelOrder(orderId: string): boolean {
    const bidIndex = this.bids.findIndex((o) => o.id === orderId);
    if (bidIndex !== -1) {
      this.bids.splice(bidIndex, 1);
      return true;
    }

    const askIndex = this.asks.findIndex((o) => o.id === orderId);
    if (askIndex !== -1) {
      this.asks.splice(askIndex, 1);
      return true;
    }

    return false;
  }

  public getMarketState(): MarketState {
    const bestBid = this.bids[0]?.price;
    const bestAsk = this.asks[0]?.price;
    const midPrice =
      bestBid !== undefined && bestAsk !== undefined
        ? bestBid + (bestAsk - bestBid) / 2
        : undefined;
    const spread =
      bestBid !== undefined && bestAsk !== undefined ? Math.max(0, bestAsk - bestBid) : undefined;

    return MarketStateSchema.parse({
      ...(bestBid !== undefined ? { bestBid } : {}),
      ...(bestAsk !== undefined ? { bestAsk } : {}),
      ...(midPrice !== undefined ? { midPrice } : {}),
      ...(spread !== undefined ? { spread } : {}),
      ...(this.lastTradePrice !== undefined ? { lastTradePrice: this.lastTradePrice } : {}),
      totalVolume: this.totalVolume
    });
  }

  /** @internal Transaction rollback support for scenario orchestration. */
  public checkpoint(): LimitOrderBookCheckpoint {
    return {
      bids: this.bids.map((order) => ({ ...order })),
      asks: this.asks.map((order) => ({ ...order })),
      lastTradePrice: this.lastTradePrice,
      totalVolume: this.totalVolume,
      activeMakerQuotes: new Map(
        [...this.activeMakerQuotes].map(([ownerId, quoteIds]) => [ownerId, { ...quoteIds }])
      ),
      generatedIds: new Set(this.generatedIds)
    };
  }

  /** @internal Transaction rollback support for scenario orchestration. */
  public restore(checkpoint: LimitOrderBookCheckpoint): void {
    this.bids = checkpoint.bids.map((order) => LimitOrderSchema.parse({ ...order }));
    this.asks = checkpoint.asks.map((order) => LimitOrderSchema.parse({ ...order }));
    if (
      checkpoint.lastTradePrice !== undefined
      && (!Number.isFinite(checkpoint.lastTradePrice) || checkpoint.lastTradePrice <= 0)
    ) {
      throw new Error("Invalid order-book checkpoint last trade price");
    }
    if (!Number.isSafeInteger(checkpoint.totalVolume) || checkpoint.totalVolume < 0) {
      throw new Error("Invalid order-book checkpoint total volume");
    }
    this.lastTradePrice = checkpoint.lastTradePrice;
    this.totalVolume = checkpoint.totalVolume;
    this.activeMakerQuotes = new Map(
      [...checkpoint.activeMakerQuotes].map(([ownerId, quoteIds]) => [ownerId, { ...quoteIds }])
    );
    this.generatedIds.clear();
    for (const id of checkpoint.generatedIds) this.generatedIds.add(id);
  }

  public clear(): void {
    this.bids = [];
    this.asks = [];
    this.lastTradePrice = undefined;
    this.totalVolume = 0;
    this.activeMakerQuotes.clear();
  }

  private withRollback<TResult>(operation: () => TResult): TResult {
    const snapshot = this.checkpoint();
    try {
      return operation();
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  private planMatch(
    side: OrderSide,
    requestedSize: number,
    limitPrice: number | undefined,
    orderId: string,
    counterparty: string
  ): MatchPlan {
    const resting = side === "BUY" ? this.asks : this.bids;
    let remainingSize = requestedSize;
    let totalMatchedSize = 0;
    let lastTradePrice: number | undefined;
    const fills: OrderFill[] = [];
    const restingMutations: PlannedRestingMutation[] = [];

    for (const restingOrder of resting) {
      if (remainingSize <= 0) break;
      if (
        limitPrice !== undefined
        && (
          (side === "BUY" && limitPrice < restingOrder.price)
          || (side === "SELL" && limitPrice > restingOrder.price)
        )
      ) {
        break;
      }

      const matchSize = Math.min(remainingSize, restingOrder.size);
      const fill = OrderFillSchema.parse({
        fillId: this.createId("fill"),
        orderId,
        matchedOrderId: restingOrder.id,
        side,
        price: restingOrder.price,
        size: matchSize,
        counterparty,
        timestamp: this.now()
      });
      fills.push(fill);
      remainingSize -= matchSize;
      totalMatchedSize += matchSize;
      if (!Number.isSafeInteger(totalMatchedSize)) {
        throw new RangeError("Matched order volume must remain a safe integer");
      }
      lastTradePrice = restingOrder.price;
      restingMutations.push({
        orderId: restingOrder.id,
        remainingSize: restingOrder.size - matchSize
      });
    }

    const nextTotalVolume = this.totalVolume + totalMatchedSize;
    if (!Number.isSafeInteger(nextTotalVolume) || nextTotalVolume < 0) {
      throw new RangeError("Order-book total volume must remain a non-negative safe integer");
    }

    return {
      fills,
      restingMutations,
      remainingSize,
      totalMatchedSize,
      lastTradePrice
    };
  }

  private commitMatchPlan(plan: MatchPlan): void {
    for (const mutation of plan.restingMutations) {
      const side = this.bids.some((order) => order.id === mutation.orderId)
        ? this.bids
        : this.asks;
      const index = side.findIndex((order) => order.id === mutation.orderId);
      if (index < 0) {
        throw new Error(`Resting order disappeared before match commit: ${mutation.orderId}`);
      }
      const current = side[index];
      if (current === undefined) {
        throw new Error(`Resting order disappeared before match commit: ${mutation.orderId}`);
      }
      if (mutation.remainingSize === 0) side.splice(index, 1);
      else current.size = mutation.remainingSize;
    }
    this.totalVolume += plan.totalMatchedSize;
    if (plan.lastTradePrice !== undefined) {
      this.lastTradePrice = plan.lastTradePrice;
    }
  }

  private hasActiveOrderId(orderId: string): boolean {
    return this.bids.some((order) => order.id === orderId)
      || this.asks.some((order) => order.id === orderId);
  }

  private insertBid(order: LimitOrder): void {
    // Descending price, then ascending timestamp
    let i = 0;
    while (i < this.bids.length) {
      const current = this.bids[i];
      if (
        current !== undefined &&
        (current.price > order.price ||
          (current.price === order.price && current.timestamp <= order.timestamp))
      ) {
        i++;
      } else {
        break;
      }
    }
    this.bids.splice(i, 0, order);
  }

  private insertAsk(order: LimitOrder): void {
    // Ascending price, then ascending timestamp
    let i = 0;
    while (i < this.asks.length) {
      const current = this.asks[i];
      if (
        current !== undefined &&
        (current.price < order.price ||
          (current.price === order.price && current.timestamp <= order.timestamp))
      ) {
        i++;
      } else {
        break;
      }
    }
    this.asks.splice(i, 0, order);
  }
}


function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-blank`);
  }
}

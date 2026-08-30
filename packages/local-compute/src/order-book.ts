import {
  type LimitOrder,
  type MarketState,
  type OrderFill,
  type OrderSide,
  type QuotePair,
  LimitOrderSchema,
  MarketStateSchema,
  OrderFillSchema
} from "../../domain/src/index.js";

export interface OrderPlacementResult {
  readonly placedOrder?: LimitOrder;
  readonly fills: readonly OrderFill[];
}

export class LimitOrderBook {
  private bids: LimitOrder[] = []; // sorted descending by price, then ascending by timestamp
  private asks: LimitOrder[] = []; // sorted ascending by price, then ascending by timestamp
  private lastTradePrice?: number;
  private totalVolume = 0;
  private activeMakerQuotes = new Map<string, { bidId?: string; askId?: string }>();

  public placeLimitOrder(orderInput: LimitOrder, counterparty = "TRADER"): OrderPlacementResult {
    const order = LimitOrderSchema.parse(orderInput);
    const fills: OrderFill[] = [];
    let remainingSize = order.size;

    if (order.side === "BUY") {
      // Cross with lowest asks if order.price >= best ask
      while (remainingSize > 0 && this.asks.length > 0) {
        const bestAsk = this.asks[0];
        if (bestAsk === undefined || order.price < bestAsk.price) break;

        const matchSize = Math.min(remainingSize, bestAsk.size);
        const matchPrice = bestAsk.price;

        fills.push(
          OrderFillSchema.parse({
            fillId: `fill_${globalThis.crypto.randomUUID()}`,
            orderId: order.id,
            side: "BUY",
            price: matchPrice,
            size: matchSize,
            counterparty,
            timestamp: Date.now()
          })
        );

        remainingSize -= matchSize;
        this.totalVolume += matchSize;
        this.lastTradePrice = matchPrice;

        if (bestAsk.size === matchSize) {
          this.asks.shift();
        } else {
          bestAsk.size -= matchSize;
        }
      }

      if (remainingSize > 0) {
        const remainingOrder: LimitOrder = { ...order, size: remainingSize };
        this.insertBid(remainingOrder);
        return { placedOrder: remainingOrder, fills };
      }
    } else {
      // Cross with highest bids if order.price <= best bid
      while (remainingSize > 0 && this.bids.length > 0) {
        const bestBid = this.bids[0];
        if (bestBid === undefined || order.price > bestBid.price) break;

        const matchSize = Math.min(remainingSize, bestBid.size);
        const matchPrice = bestBid.price;

        fills.push(
          OrderFillSchema.parse({
            fillId: `fill_${globalThis.crypto.randomUUID()}`,
            orderId: order.id,
            side: "SELL",
            price: matchPrice,
            size: matchSize,
            counterparty,
            timestamp: Date.now()
          })
        );

        remainingSize -= matchSize;
        this.totalVolume += matchSize;
        this.lastTradePrice = matchPrice;

        if (bestBid.size === matchSize) {
          this.bids.shift();
        } else {
          bestBid.size -= matchSize;
        }
      }

      if (remainingSize > 0) {
        const remainingOrder: LimitOrder = { ...order, size: remainingSize };
        this.insertAsk(remainingOrder);
        return { placedOrder: remainingOrder, fills };
      }
    }

    return { fills };
  }

  public executeMarketOrder(side: OrderSide, size: number, counterparty = "MARKET_TAKER"): readonly OrderFill[] {
    const fills: OrderFill[] = [];
    let remainingSize = size;

    if (side === "BUY") {
      while (remainingSize > 0 && this.asks.length > 0) {
        const bestAsk = this.asks[0];
        if (bestAsk === undefined) break;

        const matchSize = Math.min(remainingSize, bestAsk.size);
        const matchPrice = bestAsk.price;

        fills.push(
          OrderFillSchema.parse({
            fillId: `fill_${globalThis.crypto.randomUUID()}`,
            orderId: `mkt_${globalThis.crypto.randomUUID()}`,
            side: "BUY",
            price: matchPrice,
            size: matchSize,
            counterparty,
            timestamp: Date.now()
          })
        );

        remainingSize -= matchSize;
        this.totalVolume += matchSize;
        this.lastTradePrice = matchPrice;

        if (bestAsk.size === matchSize) {
          this.asks.shift();
        } else {
          bestAsk.size -= matchSize;
        }
      }
    } else {
      while (remainingSize > 0 && this.bids.length > 0) {
        const bestBid = this.bids[0];
        if (bestBid === undefined) break;

        const matchSize = Math.min(remainingSize, bestBid.size);
        const matchPrice = bestBid.price;

        fills.push(
          OrderFillSchema.parse({
            fillId: `fill_${globalThis.crypto.randomUUID()}`,
            orderId: `mkt_${globalThis.crypto.randomUUID()}`,
            side: "SELL",
            price: matchPrice,
            size: matchSize,
            counterparty,
            timestamp: Date.now()
          })
        );

        remainingSize -= matchSize;
        this.totalVolume += matchSize;
        this.lastTradePrice = matchPrice;

        if (bestBid.size === matchSize) {
          this.bids.shift();
        } else {
          bestBid.size -= matchSize;
        }
      }
    }

    return fills;
  }

  public setQuotes(ownerId: string, quotes: QuotePair): { readonly bidOrder: LimitOrder; readonly askOrder: LimitOrder } {
    this.cancelMakerQuotes(ownerId);

    const now = Date.now();
    const bidOrder: LimitOrder = {
      id: `quote_bid_${ownerId}_${String(now)}`,
      side: "BUY",
      price: quotes.bidPrice,
      size: quotes.bidSize,
      timestamp: now
    };
    const askOrder: LimitOrder = {
      id: `quote_ask_${ownerId}_${String(now)}`,
      side: "SELL",
      price: quotes.askPrice,
      size: quotes.askSize,
      timestamp: now
    };

    this.insertBid(bidOrder);
    this.insertAsk(askOrder);

    this.activeMakerQuotes.set(ownerId, { bidId: bidOrder.id, askId: askOrder.id });
    return { bidOrder, askOrder };
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
      bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined;
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

  public clear(): void {
    this.bids = [];
    this.asks = [];
    this.activeMakerQuotes.clear();
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

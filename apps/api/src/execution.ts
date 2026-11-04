import { randomUUID } from "node:crypto";
import { BinanceFuturesTradingAdapter } from "@of/exchange";
import { validateOrderRisk } from "@of/orderflow";
import type {
  ExecutionMode,
  OrderRecord,
  PlaceOrderRequest,
  Position,
  RiskConfig,
} from "@of/shared";
import { DEFAULT_RISK_CONFIG } from "@of/shared";
import { config } from "./config.js";
import { getMeta, listOrders, saveOrder, setMeta } from "./db.js";
import { marketHub } from "./marketHub.js";

const FEE_BPS = 4; // 0.04% taker assumption for paper

export class ExecutionService {
  private mode: ExecutionMode = config.executionMode === "LIVE" ? "PAPER" : config.executionMode;
  private liveConfirmed = false;
  private risk: RiskConfig = getMeta("risk", { ...DEFAULT_RISK_CONFIG });
  private positions = new Map<string, Position>();
  private dayPnl = 0;
  private peakEquity = this.risk.accountEquity;

  getMode(): ExecutionMode {
    return this.mode;
  }

  getRisk(): RiskConfig {
    return { ...this.risk };
  }

  setRisk(patch: Partial<RiskConfig>): RiskConfig {
    this.risk = { ...this.risk, ...patch };
    setMeta("risk", this.risk);
    this.peakEquity = Math.max(this.peakEquity, this.risk.accountEquity);
    return this.getRisk();
  }

  setMode(mode: ExecutionMode, confirmLiveTrading = false): ExecutionMode {
    if (mode === "LIVE") {
      if (!confirmLiveTrading) {
        throw new Error("LIVE mode requires confirmLiveTrading=true");
      }
      if (!config.binanceApiKey || !config.binanceApiSecret) {
        throw new Error("LIVE mode requires BINANCE_API_KEY and BINANCE_API_SECRET on server");
      }
      this.liveConfirmed = true;
    } else {
      this.liveConfirmed = false;
    }
    this.mode = mode;
    setMeta("executionMode", mode);
    return this.mode;
  }

  emergencyShutdown(): void {
    this.risk = { ...this.risk, emergencyShutdown: true, tradingEnabled: false };
    setMeta("risk", this.risk);
  }

  clearEmergency(): void {
    this.risk = { ...this.risk, emergencyShutdown: false, tradingEnabled: true };
    setMeta("risk", this.risk);
  }

  listPositions(): Position[] {
    // mark-to-market
    for (const pos of this.positions.values()) {
      const snap = marketHub.getSnapshot(pos.symbol);
      if (!snap) continue;
      const dir = pos.side === "BUY" ? 1 : -1;
      pos.unrealizedPnl = (snap.lastPrice - pos.entryPrice) * pos.quantity * dir;
      pos.updatedAt = Date.now();
    }
    return [...this.positions.values()];
  }

  listOrders(limit = 100): OrderRecord[] {
    return listOrders(limit) as OrderRecord[];
  }

  async placeOrder(request: PlaceOrderRequest): Promise<OrderRecord> {
    if (this.mode === "ANALYSIS_ONLY") {
      return this.reject(request, "ANALYSIS_ONLY mode — order blocked");
    }
    if (this.mode === "LIVE" && !request.confirmLiveTrading && !this.liveConfirmed) {
      return this.reject(request, "Live trading not confirmed");
    }

    const snap = marketHub.getSnapshot(request.symbol);
    if (!snap?.lastPrice) {
      return this.reject(request, "No market data for symbol");
    }

    const entry =
      request.type === "LIMIT" && request.price != null ? request.price : snap.lastPrice;
    const stop = request.stopPrice;
    const tp = undefined;

    const decision = validateOrderRisk({
      config: this.risk,
      request,
      entry,
      stop,
      takeProfit: tp,
      openPositions: this.listPositions(),
      dayPnl: this.dayPnl,
      peakEquity: this.peakEquity,
    });

    if (!decision.allowed) {
      return this.reject(request, decision.reason ?? "Risk rejected");
    }

    const quantity = decision.quantity;
    const now = Date.now();
    const order: OrderRecord = {
      id: randomUUID(),
      clientOrderId: request.clientOrderId,
      mode: this.mode,
      symbol: request.symbol.toUpperCase(),
      side: request.side,
      type: request.type,
      quantity,
      filledQuantity: 0,
      price: request.price,
      stopPrice: request.stopPrice,
      status: "NEW",
      fees: 0,
      createdAt: now,
      updatedAt: now,
    };

    if (this.mode === "PAPER") {
      return this.fillPaper(order, entry);
    }

    // LIVE
    const trading = new BinanceFuturesTradingAdapter({
      apiKey: config.binanceApiKey,
      apiSecret: config.binanceApiSecret,
    });
    try {
      const balances = await trading.getBalance();
      const usdt = balances.find((b) => b.asset === "USDT");
      const notional = entry * quantity;
      if (!usdt || usdt.free < notional * 0.05) {
        // rough margin check — futures margin varies; block if nearly empty
        return this.reject(request, "Insufficient available balance (pre-trade check)");
      }

      const result =
        request.type === "LIMIT" && request.price != null
          ? await trading.placeLimitOrder(order.symbol, order.side, quantity, request.price)
          : await trading.placeMarketOrder(order.symbol, order.side, quantity);

      order.exchangeOrderId = result.orderId;
      order.status = "FILLED";
      order.filledQuantity = quantity;
      order.avgFillPrice = entry;
      order.fees = (entry * quantity * FEE_BPS) / 10_000;
      order.updatedAt = Date.now();
      this.applyFillToPosition(order);
      saveOrder(order);
      return order;
    } catch (err) {
      return this.reject(request, (err as Error).message);
    }
  }

  async cancelOrder(orderId: string): Promise<OrderRecord | null> {
    const orders = this.listOrders(500);
    const order = orders.find((o) => o.id === orderId);
    if (!order) return null;
    if (order.status === "FILLED" || order.status === "CANCELED") return order;
    if (order.mode === "LIVE" && order.exchangeOrderId) {
      const trading = new BinanceFuturesTradingAdapter({
        apiKey: config.binanceApiKey,
        apiSecret: config.binanceApiSecret,
      });
      await trading.cancelOrder(order.symbol, order.exchangeOrderId);
    }
    order.status = "CANCELED";
    order.updatedAt = Date.now();
    saveOrder(order);
    return order;
  }

  private fillPaper(order: OrderRecord, fillPrice: number): OrderRecord {
    const fee = (fillPrice * order.quantity * FEE_BPS) / 10_000;
    order.status = "FILLED";
    order.filledQuantity = order.quantity;
    order.avgFillPrice = fillPrice;
    order.fees = fee;
    order.updatedAt = Date.now();
    this.applyFillToPosition(order);
    saveOrder(order);
    return order;
  }

  private applyFillToPosition(order: OrderRecord): void {
    if (!order.avgFillPrice) return;
    const key = `${order.mode}:${order.symbol}`;
    const existing = this.positions.get(key);
    if (!existing) {
      this.positions.set(key, {
        symbol: order.symbol,
        mode: order.mode,
        side: order.side,
        quantity: order.filledQuantity,
        entryPrice: order.avgFillPrice,
        unrealizedPnl: 0,
        realizedPnl: 0,
        fees: order.fees,
        updatedAt: Date.now(),
      });
      this.risk.accountEquity -= order.fees;
      return;
    }

    // simplify: same-side adds, opposite reduces / flips
    if (existing.side === order.side) {
      const totalQty = existing.quantity + order.filledQuantity;
      existing.entryPrice =
        (existing.entryPrice * existing.quantity + order.avgFillPrice * order.filledQuantity) /
        totalQty;
      existing.quantity = totalQty;
      existing.fees += order.fees;
    } else {
      const closed = Math.min(existing.quantity, order.filledQuantity);
      const dir = existing.side === "BUY" ? 1 : -1;
      const pnl = (order.avgFillPrice - existing.entryPrice) * closed * dir;
      existing.realizedPnl += pnl;
      this.dayPnl += pnl - order.fees;
      this.risk.accountEquity += pnl - order.fees;
      this.peakEquity = Math.max(this.peakEquity, this.risk.accountEquity);
      existing.quantity -= closed;
      existing.fees += order.fees;
      if (existing.quantity === 0) {
        this.positions.delete(key);
      } else if (order.filledQuantity > closed) {
        existing.side = order.side;
        existing.quantity = order.filledQuantity - closed;
        existing.entryPrice = order.avgFillPrice;
      }
    }
    existing.updatedAt = Date.now();
    setMeta("risk", this.risk);
  }

  private reject(request: PlaceOrderRequest, reason: string): OrderRecord {
    const order: OrderRecord = {
      id: randomUUID(),
      clientOrderId: request.clientOrderId,
      mode: this.mode,
      symbol: request.symbol.toUpperCase(),
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      filledQuantity: 0,
      price: request.price,
      stopPrice: request.stopPrice,
      status: "REJECTED",
      fees: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rejectReason: reason,
    };
    saveOrder(order);
    return order;
  }
}

export const executionService = new ExecutionService();

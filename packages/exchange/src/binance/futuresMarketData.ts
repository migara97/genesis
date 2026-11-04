import WebSocket from "ws";
import type { Candle, ConnectionHealth, OrderBookSnapshot, TradeTick } from "@of/shared";
import type { ExchangeMarketDataAdapter, MarketDataHandlers } from "../types.js";

const REST = "https://fapi.binance.com";
const WS = "wss://fstream.binance.com";

interface DepthEvent {
  e: string;
  E: number;
  T: number;
  s: string;
  U: number;
  u: number;
  pu: number;
  b: [string, string][];
  a: [string, string][];
}

interface AggTradeEvent {
  e: string;
  E: number;
  a: number;
  s: string;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

/**
 * Binance USD-M Futures public market data adapter.
 * Aggressor side is exchange-reported via aggTrade.m (buyer is maker => seller aggressor).
 */
export class BinanceFuturesMarketDataAdapter implements ExchangeMarketDataAdapter {
  readonly id = "binance-futures";
  private ws: WebSocket | null = null;
  private handlers: MarketDataHandlers | null = null;
  private symbols: string[] = [];
  private reconnectAttempts = 0;
  private shouldRun = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private books = new Map<string, LocalBook>();
  private connId = 0;
  private health: ConnectionHealth = {
    exchange: this.id,
    connected: false,
    reconnectAttempts: 0,
    symbols: [],
  };

  async connect(symbols: string[], handlers: MarketDataHandlers): Promise<void> {
    this.symbols = symbols.map((s) => s.toUpperCase());
    this.handlers = handlers;
    this.shouldRun = true;
    await this.openSocket();
  }

  async disconnect(): Promise<void> {
    this.connId += 1;
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.health = { ...this.health, connected: false };
    this.emitHealth();
  }

  getHealth(): ConnectionHealth {
    return { ...this.health };
  }

  async fetchKlines(symbol: string, interval: string, limit = 200): Promise<Candle[]> {
    const url = `${REST}/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance klines failed: ${res.status}`);
    const raw = (await res.json()) as (string | number)[][];
    return raw.map((k) => ({
      symbol: symbol.toUpperCase(),
      interval,
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6]),
    }));
  }

  async fetchOrderBookSnapshot(symbol: string, limit = 1000): Promise<OrderBookSnapshot> {
    const url = `${REST}/fapi/v1/depth?symbol=${symbol.toUpperCase()}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance depth failed: ${res.status}`);
    const raw = (await res.json()) as {
      lastUpdateId: number;
      bids: [string, string][];
      asks: [string, string][];
    };
    return {
      exchange: this.id,
      symbol: symbol.toUpperCase(),
      lastUpdateId: raw.lastUpdateId,
      timestamp: Date.now(),
      bids: raw.bids.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
      asks: raw.asks.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
    };
  }

  private async openSocket(): Promise<void> {
    const connId = ++this.connId;
    const streams = this.symbols
      .flatMap((s) => {
        const id = s.toLowerCase();
        return [`${id}@aggTrade`, `${id}@depth@100ms`];
      })
      .join("/");
    const url = `${WS}/stream?streams=${streams}`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;

      ws.on("open", () => {
        if (connId !== this.connId) {
          ws.close();
          return;
        }
        this.health = {
          ...this.health,
          connected: true,
          lastError: undefined,
          reconnectAttempts: this.reconnectAttempts,
          symbols: this.symbols,
          lastMessageAt: Date.now(),
        };
        this.emitHealth();
        void this.bootstrapBooks().catch((err) => this.handlers?.onError?.(err as Error));
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on("message", (data) => {
        if (connId === this.connId) this.onMessage(data.toString());
      });

      ws.on("error", (err) => {
        if (connId !== this.connId) return;
        this.health = { ...this.health, lastError: err.message };
        this.emitHealth();
        this.handlers?.onError?.(err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on("close", () => {
        if (connId !== this.connId) return;
        this.health = { ...this.health, connected: false };
        this.emitHealth();
        if (this.shouldRun) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.health = { ...this.health, reconnectAttempts: this.reconnectAttempts };
    this.emitHealth();
    this.reconnectTimer = setTimeout(() => {
      void this.openSocket().catch((err) => this.handlers?.onError?.(err as Error));
    }, delay);
  }

  private async bootstrapBooks(): Promise<void> {
    for (const symbol of this.symbols) {
      const snap = await this.fetchOrderBookSnapshot(symbol, 1000);
      const book = new LocalBook(symbol);
      book.resetFromSnapshot(snap);
      this.books.set(symbol, book);
      this.handlers?.onBook(book.toSnapshot(this.id));
    }
  }

  private onMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as { stream?: string; data?: unknown };
      const data = (msg.data ?? msg) as Record<string, unknown>;
      this.health = { ...this.health, lastMessageAt: Date.now(), connected: true };
      if (data.e === "aggTrade") {
        this.handleTrade(data as unknown as AggTradeEvent);
      } else if (data.e === "depthUpdate") {
        this.handleDepth(data as unknown as DepthEvent);
      }
    } catch (err) {
      this.handlers?.onError?.(err as Error);
    }
  }

  private handleTrade(ev: AggTradeEvent): void {
    // m = buyer is maker => seller was aggressor
    const buyerAggressor = !ev.m;
    const trade: TradeTick = {
      exchange: this.id,
      symbol: ev.s,
      tradeId: String(ev.a),
      price: Number(ev.p),
      quantity: Number(ev.q),
      buyerAggressor,
      aggressorSource: "exchange_flag",
      timestamp: ev.T,
    };
    this.handlers?.onTrade(trade);
  }

  private handleDepth(ev: DepthEvent): void {
    let book = this.books.get(ev.s);
    if (!book) {
      book = new LocalBook(ev.s);
      this.books.set(ev.s, book);
    }
    const ok = book.applyDiff(ev);
    if (!ok) {
      void this.resyncBook(ev.s);
      return;
    }
    this.handlers?.onBook(book.toSnapshot(this.id));
  }

  private async resyncBook(symbol: string): Promise<void> {
    try {
      const snap = await this.fetchOrderBookSnapshot(symbol, 1000);
      const book = this.books.get(symbol) ?? new LocalBook(symbol);
      book.resetFromSnapshot(snap);
      this.books.set(symbol, book);
      this.handlers?.onBook(book.toSnapshot(this.id));
    } catch (err) {
      this.handlers?.onError?.(err as Error);
    }
  }

  private emitHealth(): void {
    this.handlers?.onHealth?.(this.getHealth());
  }
}

class LocalBook {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  lastUpdateId = 0;
  private buffer: DepthEvent[] = [];
  private synced = false;

  constructor(readonly symbol: string) {}

  resetFromSnapshot(snap: OrderBookSnapshot): void {
    this.bids.clear();
    this.asks.clear();
    for (const l of snap.bids) this.bids.set(l.price, l.quantity);
    for (const l of snap.asks) this.asks.set(l.price, l.quantity);
    this.lastUpdateId = snap.lastUpdateId;
    this.synced = true;
    this.buffer = [];
  }

  applyDiff(ev: DepthEvent): boolean {
    if (!this.synced) {
      this.buffer.push(ev);
      return true;
    }
    // Drop old events
    if (ev.u <= this.lastUpdateId) return true;
    // Detect gap (Binance futures uses pu previous final update id)
    if (ev.pu !== this.lastUpdateId && ev.U > this.lastUpdateId + 1) {
      this.synced = false;
      return false;
    }
    for (const [p, q] of ev.b) this.setLevel(this.bids, Number(p), Number(q));
    for (const [p, q] of ev.a) this.setLevel(this.asks, Number(p), Number(q));
    this.lastUpdateId = ev.u;
    return true;
  }

  private setLevel(side: Map<number, number>, price: number, qty: number): void {
    if (qty === 0) side.delete(price);
    else side.set(price, qty);
  }

  toSnapshot(exchange: string): OrderBookSnapshot {
    const bids = [...this.bids.entries()]
      .map(([price, quantity]) => ({ price, quantity }))
      .sort((a, b) => b.price - a.price)
      .slice(0, 50);
    const asks = [...this.asks.entries()]
      .map(([price, quantity]) => ({ price, quantity }))
      .sort((a, b) => a.price - b.price)
      .slice(0, 50);
    return {
      exchange,
      symbol: this.symbol,
      bids,
      asks,
      lastUpdateId: this.lastUpdateId,
      timestamp: Date.now(),
    };
  }
}

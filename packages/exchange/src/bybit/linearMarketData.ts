import WebSocket from "ws";
import type { Candle, ConnectionHealth, OrderBookSnapshot, TradeTick } from "@of/shared";
import type { ExchangeMarketDataAdapter, MarketDataHandlers } from "../types.js";

const REST = "https://api.bybit.com";
const WS_URL = "wss://stream.bybit.com/v5/public/linear";

/**
 * Bybit USDT perpetual (linear) public market-data adapter.
 * Aggressor side is exchange-reported via trade `S` (Buy = buyer aggressor).
 */
export class BybitLinearMarketDataAdapter implements ExchangeMarketDataAdapter {
  readonly id = "bybit-linear";
  private ws: WebSocket | null = null;
  private handlers: MarketDataHandlers | null = null;
  private symbols: string[] = [];
  private reconnectAttempts = 0;
  private shouldRun = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private books = new Map<string, LocalBook>();
  private connId = 0;
  private health: ConnectionHealth = {
    exchange: this.id,
    connected: false,
    reconnectAttempts: 0,
    symbols: [],
  };

  async connect(symbols: string[], handlers: MarketDataHandlers): Promise<void> {
    this.symbols = symbols.map(normalizeBybitSymbol);
    this.handlers = handlers;
    this.shouldRun = true;
    await this.openSocket();
  }

  async disconnect(): Promise<void> {
    this.connId += 1;
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.health = { ...this.health, connected: false };
    this.emitHealth();
  }

  getHealth(): ConnectionHealth {
    return { ...this.health };
  }

  async fetchKlines(symbol: string, interval: string, limit = 200): Promise<Candle[]> {
    const sym = normalizeBybitSymbol(symbol);
    const bybitInterval = mapInterval(interval);
    const url = `${REST}/v5/market/kline?category=linear&symbol=${encodeURIComponent(sym)}&interval=${bybitInterval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bybit klines failed: ${res.status}`);
    const json = (await res.json()) as {
      retCode: number;
      retMsg: string;
      result?: { list?: string[][] };
    };
    if (json.retCode !== 0) throw new Error(`Bybit klines error: ${json.retMsg}`);
    const list = json.result?.list ?? [];
    // Newest first
    return list
      .map((k) => ({
        symbol: sym,
        interval,
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: Number(k[0]) + intervalMs(interval) - 1,
      }))
      .reverse();
  }

  async fetchOrderBookSnapshot(symbol: string, limit = 50): Promise<OrderBookSnapshot> {
    const sym = normalizeBybitSymbol(symbol);
    const sz = Math.min(Math.max(limit, 1), 200);
    const url = `${REST}/v5/market/orderbook?category=linear&symbol=${encodeURIComponent(sym)}&limit=${sz}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bybit books failed: ${res.status}`);
    const json = (await res.json()) as {
      retCode: number;
      retMsg: string;
      result?: { b?: string[][]; a?: string[][]; ts?: number; u?: number; s?: string };
    };
    if (json.retCode !== 0 || !json.result) throw new Error(`Bybit books error: ${json.retMsg}`);
    const raw = json.result;
    return {
      exchange: this.id,
      symbol: sym,
      lastUpdateId: Number(raw.u ?? raw.ts ?? Date.now()),
      timestamp: Number(raw.ts ?? Date.now()),
      bids: (raw.b ?? []).map((r) => ({ price: Number(r[0]), quantity: Number(r[1]) })),
      asks: (raw.a ?? []).map((r) => ({ price: Number(r[0]), quantity: Number(r[1]) })),
    };
  }

  private async openSocket(): Promise<void> {
    const connId = ++this.connId;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      let settled = false;

      ws.on("open", () => {
        if (connId !== this.connId) {
          ws.close();
          return;
        }
        const args = this.symbols.flatMap((sym) => [
          `publicTrade.${sym}`,
          `orderbook.50.${sym}`,
        ]);
        // Bybit allows up to ~10 args per subscribe; chunk if needed.
        for (let i = 0; i < args.length; i += 10) {
          ws.send(JSON.stringify({ op: "subscribe", args: args.slice(i, i + 10) }));
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
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: "ping" }));
          }
        }, 20_000);
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
        if (this.pingTimer) clearInterval(this.pingTimer);
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
      const snap = await this.fetchOrderBookSnapshot(symbol, 50);
      const book = new LocalBook(symbol);
      book.resetFromSnapshot(snap);
      this.books.set(symbol, book);
      this.handlers?.onBook(book.toSnapshot(this.id));
    }
  }

  private onMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as {
        topic?: string;
        type?: string;
        ts?: number;
        data?: unknown;
        op?: string;
        success?: boolean;
      };
      if (msg.op === "pong" || msg.op === "ping") return;
      this.health = { ...this.health, lastMessageAt: Date.now(), connected: true };
      if (!msg.topic || msg.data == null) return;
      if (msg.topic.startsWith("publicTrade.")) {
        const rows = Array.isArray(msg.data) ? (msg.data as BybitTrade[]) : [msg.data as BybitTrade];
        for (const row of rows) this.handleTrade(row);
      } else if (msg.topic.startsWith("orderbook.")) {
        this.handleBook(msg.data as BybitBook, msg.topic, msg.type, msg.ts);
      }
    } catch (err) {
      this.handlers?.onError?.(err as Error);
    }
  }

  private handleTrade(row: BybitTrade): void {
    const symbol = normalizeBybitSymbol(row.s);
    const buyerAggressor = row.S === "Buy";
    const trade: TradeTick = {
      exchange: this.id,
      symbol,
      tradeId: String(row.i ?? row.T ?? `${row.s}-${row.p}-${row.v}`),
      price: Number(row.p),
      quantity: Number(row.v),
      buyerAggressor,
      aggressorSource: "exchange_flag",
      timestamp: Number(row.T ?? Date.now()),
    };
    this.handlers?.onTrade(trade);
  }

  private handleBook(
    row: BybitBook,
    topic: string,
    type?: string,
    ts?: number,
  ): void {
    const symbol =
      normalizeBybitSymbol(row.s ?? "") ||
      normalizeBybitSymbol(topic.split(".").pop() ?? "");
    if (!symbol) return;
    const book = this.books.get(symbol) ?? new LocalBook(symbol);
    if (type === "snapshot" || !this.books.has(symbol)) {
      book.resetFromLevels(row.b ?? [], row.a ?? [], Number(row.u ?? ts ?? Date.now()));
    } else {
      book.applyDelta(row.b ?? [], row.a ?? [], Number(row.u ?? ts ?? Date.now()));
    }
    this.books.set(symbol, book);
    this.handlers?.onBook(book.toSnapshot(this.id));
  }

  private emitHealth(): void {
    this.handlers?.onHealth?.(this.getHealth());
  }
}

interface BybitTrade {
  s: string;
  i?: string;
  p: string;
  v: string;
  S: "Buy" | "Sell";
  T?: number;
}

interface BybitBook {
  s?: string;
  b?: string[][];
  a?: string[][];
  u?: number;
}

class LocalBook {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  lastUpdateId = 0;

  constructor(readonly symbol: string) {}

  resetFromSnapshot(snap: OrderBookSnapshot): void {
    this.bids.clear();
    this.asks.clear();
    for (const l of snap.bids) this.bids.set(l.price, l.quantity);
    for (const l of snap.asks) this.asks.set(l.price, l.quantity);
    this.lastUpdateId = snap.lastUpdateId;
  }

  resetFromLevels(bids: string[][], asks: string[][], updateId: number): void {
    this.bids.clear();
    this.asks.clear();
    for (const r of bids) this.bids.set(Number(r[0]), Number(r[1]));
    for (const r of asks) this.asks.set(Number(r[0]), Number(r[1]));
    this.lastUpdateId = updateId;
  }

  applyDelta(bids: string[][], asks: string[][], updateId: number): void {
    for (const r of bids) {
      const price = Number(r[0]);
      const qty = Number(r[1]);
      if (qty === 0) this.bids.delete(price);
      else this.bids.set(price, qty);
    }
    for (const r of asks) {
      const price = Number(r[0]);
      const qty = Number(r[1]);
      if (qty === 0) this.asks.delete(price);
      else this.asks.set(price, qty);
    }
    this.lastUpdateId = updateId;
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

/** Normalize to Bybit linear symbol (BTCUSDT). Accepts OKX-style BTC-USDT-SWAP. */
export function normalizeBybitSymbol(symbol: string): string {
  const s = symbol.toUpperCase().replace(/_/g, "-");
  if (s.endsWith("-USDT-SWAP")) return `${s.slice(0, -"-USDT-SWAP".length)}USDT`;
  if (s.endsWith("-USDT")) return `${s.slice(0, -5)}USDT`;
  return s.replace(/-/g, "");
}

function mapInterval(interval: string): string {
  const map: Record<string, string> = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "1h": "60",
    "4h": "240",
    "1d": "D",
  };
  return map[interval] ?? "15";
}

function intervalMs(interval: string): number {
  const map: Record<string, number> = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
  };
  return map[interval] ?? 900_000;
}

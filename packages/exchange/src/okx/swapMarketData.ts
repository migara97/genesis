import WebSocket from "ws";
import type { Candle, ConnectionHealth, OrderBookSnapshot, TradeTick } from "@of/shared";
import type { ExchangeMarketDataAdapter, MarketDataHandlers } from "../types.js";

const REST = "https://www.okx.com";
const WS_URL = "wss://ws.okx.com:8443/ws/v5/public";

/**
 * OKX perpetual swap public market-data adapter.
 * Aggressor side is exchange-reported via trade `side` (taker side).
 */
export class OkxSwapMarketDataAdapter implements ExchangeMarketDataAdapter {
  readonly id = "okx-swap";
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
    this.symbols = symbols.map(normalizeOkxSymbol);
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
    const instId = normalizeOkxSymbol(symbol);
    const bar = mapInterval(interval);
    const url = `${REST}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OKX candles failed: ${res.status}`);
    const json = (await res.json()) as { code: string; data: string[][]; msg: string };
    if (json.code !== "0") throw new Error(`OKX candles error: ${json.msg}`);
    // OKX returns newest first
    return json.data
      .map((k) => ({
        symbol: instId,
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
    const instId = normalizeOkxSymbol(symbol);
    const sz = Math.min(Math.max(limit, 1), 400);
    const url = `${REST}/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=${sz}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OKX books failed: ${res.status}`);
    const json = (await res.json()) as {
      code: string;
      data: { asks: string[][]; bids: string[][]; ts: string; seqId?: number }[];
      msg: string;
    };
    if (json.code !== "0" || !json.data[0]) throw new Error(`OKX books error: ${json.msg}`);
    const raw = json.data[0];
    return {
      exchange: this.id,
      symbol: instId,
      lastUpdateId: Number(raw.seqId ?? raw.ts),
      timestamp: Number(raw.ts),
      bids: raw.bids.map((r) => ({ price: Number(r[0]), quantity: Number(r[1]) })),
      asks: raw.asks.map((r) => ({ price: Number(r[0]), quantity: Number(r[1]) })),
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
        const args = this.symbols.flatMap((instId) => [
          { channel: "trades", instId },
          { channel: "books5", instId },
        ]);
        ws.send(JSON.stringify({ op: "subscribe", args }));
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
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
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
    if (raw === "pong") return;
    try {
      const msg = JSON.parse(raw) as {
        arg?: { channel?: string; instId?: string };
        data?: unknown[];
        event?: string;
        action?: string;
      };
      this.health = { ...this.health, lastMessageAt: Date.now(), connected: true };
      if (msg.event) return;
      const channel = msg.arg?.channel;
      if (channel === "trades" && Array.isArray(msg.data)) {
        for (const row of msg.data as OkxTrade[]) this.handleTrade(row);
      } else if (channel === "books5" && Array.isArray(msg.data)) {
        for (const row of msg.data as OkxBook[]) this.handleBook(row, msg.arg?.instId);
      }
    } catch (err) {
      this.handlers?.onError?.(err as Error);
    }
  }

  private handleTrade(row: OkxTrade): void {
    const buyerAggressor = row.side === "buy";
    const trade: TradeTick = {
      exchange: this.id,
      symbol: row.instId,
      tradeId: row.tradeId,
      price: Number(row.px),
      quantity: Number(row.sz),
      buyerAggressor,
      aggressorSource: "exchange_flag",
      timestamp: Number(row.ts),
    };
    this.handlers?.onTrade(trade);
  }

  private handleBook(row: OkxBook, instId?: string): void {
    const symbol = instId ?? row.instId;
    if (!symbol) return;
    const snap: OrderBookSnapshot = {
      exchange: this.id,
      symbol,
      lastUpdateId: Number(row.ts),
      timestamp: Number(row.ts),
      bids: (row.bids ?? []).map((r) => ({ price: Number(r[0]), quantity: Number(r[1]) })),
      asks: (row.asks ?? []).map((r) => ({ price: Number(r[0]), quantity: Number(r[1]) })),
    };
    const book = this.books.get(symbol) ?? new LocalBook(symbol);
    book.resetFromSnapshot(snap);
    this.books.set(symbol, book);
    this.handlers?.onBook(book.toSnapshot(this.id));
  }

  private emitHealth(): void {
    this.handlers?.onHealth?.(this.getHealth());
  }
}

interface OkxTrade {
  instId: string;
  tradeId: string;
  px: string;
  sz: string;
  side: "buy" | "sell";
  ts: string;
}

interface OkxBook {
  instId?: string;
  asks?: string[][];
  bids?: string[][];
  ts: string;
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

export function normalizeOkxSymbol(symbol: string): string {
  const s = symbol.toUpperCase().replace(/_/g, "-");
  if (s.includes("-")) return s;
  // BTCUSDT -> BTC-USDT-SWAP
  if (s.endsWith("USDT")) return `${s.slice(0, -4)}-USDT-SWAP`;
  return s;
}

function mapInterval(interval: string): string {
  const map: Record<string, string> = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1H",
    "4h": "4H",
    "1d": "1D",
  };
  return map[interval] ?? "15m";
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

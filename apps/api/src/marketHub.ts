import { EventEmitter } from "node:events";
import {
  BinanceFuturesMarketDataAdapter,
  OkxSwapMarketDataAdapter,
  type ExchangeMarketDataAdapter,
} from "@of/exchange";
import {
  applyTradeToCvd,
  analyzeMarketStructure,
  buildFootprintBar,
  buildVolumeProfile,
  computeDomMetrics,
  createCvdState,
  generateSignal,
} from "@of/orderflow";
import type {
  Candle,
  ConnectionHealth,
  CvdState,
  DomMetrics,
  FootprintBar,
  MarketSnapshot,
  MarketStructureState,
  OrderBookSnapshot,
  TradeTick,
  TradingSignal,
  VolumeProfile,
} from "@of/shared";
import { config } from "./config.js";

function createMarketAdapter(): ExchangeMarketDataAdapter {
  if (config.exchange === "binance") return new BinanceFuturesMarketDataAdapter();
  return new OkxSwapMarketDataAdapter();
}

interface SymbolState {
  trades: TradeTick[];
  sessionTrades: TradeTick[];
  book?: OrderBookSnapshot;
  dom?: DomMetrics;
  cvd: CvdState;
  footprint?: FootprintBar;
  footprintBuffer: TradeTick[];
  footprintOpen: number;
  volumeProfile?: VolumeProfile;
  structure?: MarketStructureState;
  candles: Candle[];
  signal?: TradingSignal;
  lastPrice: number;
  health: ConnectionHealth;
}

/**
 * In-memory market data hub: ingests exchange feeds and runs order-flow engines.
 */
export class MarketHub extends EventEmitter {
  private adapter: ExchangeMarketDataAdapter = createMarketAdapter();
  private states = new Map<string, SymbolState>();
  private started = false;
  private connecting = false;
  private generation = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private tickSizes = new Map<string, number>();
  /** Coalesce high-frequency trade/book updates so each symbol publishes at most ~5 Hz. */
  private snapshotTimers = new Map<string, NodeJS.Timeout>();

  /** Prepare empty symbol slots so the API can serve before exchange is up. */
  bootstrapSymbols(symbols = config.symbols): void {
    const sessionStart = Date.now();
    for (const symbol of symbols) {
      if (this.states.has(symbol)) continue;
      this.states.set(symbol, {
        trades: [],
        sessionTrades: [],
        cvd: createCvdState(symbol, sessionStart),
        footprintBuffer: [],
        footprintOpen: Date.now(),
        candles: [],
        lastPrice: 0,
        health: {
          exchange: this.adapter.id,
          connected: false,
          reconnectAttempts: 0,
          symbols,
          lastError: "Connecting to exchange…",
        },
      });
    }
  }

  streamingSymbols(): string[] {
    return [...this.states.keys()];
  }

  setTickSize(symbol: string, tickSize: number): void {
    if (tickSize > 0) this.tickSizes.set(symbol.toUpperCase(), tickSize);
  }

  /**
   * Stream order-flow for one symbol. Other catalog rows stay on the ticker feed.
   */
  async focus(symbol: string): Promise<void> {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return;
    const gen = ++this.generation;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.started = false;
    this.connecting = false;
    try {
      await this.adapter.disconnect();
    } catch {
      // The next connect replaces the socket.
    }
    if (gen !== this.generation) return;
    for (const key of [...this.states.keys()]) {
      if (key !== normalized) this.states.delete(key);
    }
    for (const key of [...this.snapshotTimers.keys()]) {
      if (key !== normalized) {
        const timer = this.snapshotTimers.get(key);
        if (timer) clearTimeout(timer);
        this.snapshotTimers.delete(key);
      }
    }
    await this.start([normalized], gen);
  }

  /**
   * Connect to the exchange with retries. Safe to call after HTTP server is up.
   * Does not throw after exhausting a single attempt — schedules retries instead.
   */
  async start(symbols = config.symbols, gen = this.generation): Promise<void> {
    if (gen !== this.generation) return;
    this.bootstrapSymbols(symbols);
    if (this.started || this.connecting) return;
    this.connecting = true;

    try {
      for (const symbol of symbols) {
        if (gen !== this.generation) return;
        try {
          const candles = await this.adapter.fetchKlines(symbol, "15m", 200);
          const prevDay = await this.adapter.fetchKlines(symbol, "1d", 2);
          const prev = prevDay[0];
          const state = this.states.get(symbol)!;
          state.candles = candles;
          state.lastPrice = candles[candles.length - 1]?.close ?? 0;
          state.structure = analyzeMarketStructure(
            symbol,
            candles,
            3,
            prev?.high,
            prev?.low,
          );
          state.health = {
            ...state.health,
            lastError: undefined,
          };
          this.recomputeProfile(symbol);
          this.recomputeSignal(symbol);
        } catch (err) {
          const state = this.states.get(symbol);
          if (state) {
            state.health = {
              ...state.health,
              connected: false,
              lastError: (err as Error).message,
            };
          }
          this.emit("error", err);
          throw err;
        }
      }

      if (gen !== this.generation) return;
      await this.adapter.connect(symbols, {
        onTrade: (t) => this.onTrade(t),
        onBook: (b) => this.onBook(b),
        onHealth: (h) => this.onHealth(h),
        onError: (e) => this.emit("error", e),
      });
      if (gen !== this.generation) return;
      this.started = true;
    } catch (err) {
      if (gen !== this.generation) return;
      this.emit("error", err);
      // Retry in background so a transient TLS/network blip does not kill the API.
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connecting = false;
        void this.start(symbols, gen);
      }, 5_000);
      return;
    } finally {
      if (this.started) this.connecting = false;
    }
  }

  getSnapshot(symbol: string): MarketSnapshot | null {
    const s = this.states.get(symbol.toUpperCase());
    if (!s) return null;
    return {
      symbol: symbol.toUpperCase(),
      lastPrice: s.lastPrice,
      timestamp: Date.now(),
      book: s.book,
      dom: s.dom,
      cvd: summarizeCvd(s.cvd),
      footprint: s.footprint,
      volumeProfile: s.volumeProfile,
      structure: s.structure,
      signal: s.signal,
      recentTrades: s.trades.slice(-80),
      health: s.health,
    };
  }

  listSnapshots(): MarketSnapshot[] {
    return [...this.states.keys()]
      .map((s) => this.getSnapshot(s))
      .filter((x): x is MarketSnapshot => !!x);
  }

  private onTrade(trade: TradeTick): void {
    const state = this.states.get(trade.symbol);
    if (!state) return;
    state.lastPrice = trade.price;
    state.trades.push(trade);
    if (state.trades.length > 500) state.trades.splice(0, state.trades.length - 500);
    state.sessionTrades.push(trade);
    if (state.sessionTrades.length > 50_000) {
      state.sessionTrades.splice(0, state.sessionTrades.length - 50_000);
    }

    state.cvd = applyTradeToCvd(state.cvd, trade);
    state.footprintBuffer.push(trade);

    const now = trade.timestamp || Date.now();
    if (now - state.footprintOpen >= config.footprintIntervalMs) {
      const bar = buildFootprintBar(
        trade.symbol,
        state.footprintBuffer,
        state.footprintOpen,
        now,
        { tickSize: this.tickSize(trade.symbol) },
      );
      if (bar) state.footprint = bar;
      state.footprintBuffer = [];
      state.footprintOpen = now;
      this.recomputeProfile(trade.symbol);
      // Refresh structure periodically from candles + last price proxy candle
      this.refreshStructure(trade.symbol);
    }

    this.recomputeSignal(trade.symbol);
    this.publish(trade.symbol);
  }

  private onBook(book: OrderBookSnapshot): void {
    const state = this.states.get(book.symbol);
    if (!state) return;
    state.book = book;
    state.dom = computeDomMetrics(book);
    if (state.dom.mid) state.lastPrice = state.dom.mid;
    this.recomputeSignal(book.symbol);
    this.publish(book.symbol);
  }

  private onHealth(health: ConnectionHealth): void {
    for (const state of this.states.values()) {
      state.health = health;
    }
    this.emit("health", health);
  }

  private publish(symbol: string): void {
    if (this.snapshotTimers.has(symbol)) return;
    this.snapshotTimers.set(
      symbol,
      setTimeout(() => {
        this.snapshotTimers.delete(symbol);
        const snap = this.getSnapshot(symbol);
        if (snap) this.emit("snapshot", snap);
      }, 200),
    );
  }

  private tickSize(symbol: string): number {
    return this.tickSizes.get(symbol.toUpperCase()) ?? config.tickSizeFor(symbol);
  }

  private recomputeProfile(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    state.volumeProfile =
      buildVolumeProfile(symbol, state.sessionTrades, this.tickSize(symbol)) ??
      undefined;
  }

  private refreshStructure(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    state.structure = analyzeMarketStructure(
      symbol,
      state.candles,
      3,
      state.structure?.previousSessionHigh,
      state.structure?.previousSessionLow,
    );
  }

  private recomputeSignal(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state || !state.lastPrice) return;
    state.signal = generateSignal({
      symbol,
      lastPrice: state.lastPrice,
      timestamp: Date.now(),
      footprint: state.footprint,
      cvd: state.cvd,
      dom: state.dom,
      volumeProfile: state.volumeProfile,
      structure: state.structure,
    });
  }
}

function summarizeCvd(cvd: CvdState): CvdState {
  return {
    ...cvd,
    points: cvd.points.slice(-300),
  };
}

export const marketHub = new MarketHub();

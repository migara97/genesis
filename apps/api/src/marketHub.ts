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

  /**
   * Connect to the exchange with retries. Safe to call after HTTP server is up.
   * Does not throw after exhausting a single attempt — schedules retries instead.
   */
  async start(symbols = config.symbols): Promise<void> {
    this.bootstrapSymbols(symbols);
    if (this.started || this.connecting) return;
    this.connecting = true;

    try {
      for (const symbol of symbols) {
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

      await this.adapter.connect(symbols, {
        onTrade: (t) => this.onTrade(t),
        onBook: (b) => this.onBook(b),
        onHealth: (h) => this.onHealth(h),
        onError: (e) => this.emit("error", e),
      });
      this.started = true;
    } catch (err) {
      this.emit("error", err);
      // Retry in background so a transient TLS/network blip does not kill the API.
      setTimeout(() => {
        this.connecting = false;
        void this.start(symbols);
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
        { tickSize: config.tickSizeFor(trade.symbol) },
      );
      if (bar) state.footprint = bar;
      state.footprintBuffer = [];
      state.footprintOpen = now;
      this.recomputeProfile(trade.symbol);
      // Refresh structure periodically from candles + last price proxy candle
      this.refreshStructure(trade.symbol);
    }

    this.recomputeSignal(trade.symbol);
    this.emit("snapshot", this.getSnapshot(trade.symbol));
  }

  private onBook(book: OrderBookSnapshot): void {
    const state = this.states.get(book.symbol);
    if (!state) return;
    state.book = book;
    state.dom = computeDomMetrics(book);
    if (state.dom.mid) state.lastPrice = state.dom.mid;
    this.recomputeSignal(book.symbol);
    this.emit("snapshot", this.getSnapshot(book.symbol));
  }

  private onHealth(health: ConnectionHealth): void {
    for (const state of this.states.values()) {
      state.health = health;
    }
    this.emit("health", health);
  }

  private recomputeProfile(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    state.volumeProfile =
      buildVolumeProfile(symbol, state.sessionTrades, config.tickSizeFor(symbol)) ??
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

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
  buildMultiTimeframeContext,
  buildVolumeProfile,
  computeDomMetrics,
  createCvdState,
  advanceBreakRetest,
  advanceScenarioTree,
  applySignalLifecycle,
  buildChartOverlay,
  detectStructureZones,
  generateSignal,
  MTF_INTERVALS,
  PRIMARY_INTERVAL,
  resolvePrimaryInterval,
  summarizeTimeframeStructure,
  type DeskPrimaryInterval,
} from "@of/orderflow";
import type {
  BreakRetestState,
  Candle,
  ChartOverlayState,
  ConnectionHealth,
  CvdState,
  DomMetrics,
  FootprintBar,
  MarketSnapshot,
  MarketStructureState,
  MultiTimeframeContext,
  OrderBookSnapshot,
  ScenarioTreeState,
  StructureZonesState,
  TradeTick,
  TradingSignal,
  VolumeProfile,
} from "@of/shared";
import { config } from "./config.js";
import { getTickerStats } from "./markets/store.js";
import { recordSignalLifecycle } from "./signals/journal.js";
import { syncPaperTradeFromLifecycle } from "./validation/paperLedger.js";
import { archiveTradeTick } from "./validation/tapeArchive.js";

/** Candle limits per TF — keep HTF lighter to limit REST load. */
const MTF_CANDLE_LIMITS: Record<string, number> = {
  "1d": 120,
  "4h": 120,
  "1h": 150,
  "15m": 200,
  "5m": 200,
  "1m": 150,
};
/** Re-fetch MTF klines on this interval (not on every trade). */
const MTF_REFRESH_MS = 5 * 60_000;

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
  /** Candles keyed by interval for Phase-4 MTF. */
  candlesByInterval: Map<string, Candle[]>;
  mtf?: MultiTimeframeContext;
  zones?: StructureZonesState;
  chartOverlay?: ChartOverlayState;
  breakRetest?: BreakRetestState;
  scenarios?: ScenarioTreeState;
  signal?: TradingSignal;
  lastPrice: number;
  primaryInterval: DeskPrimaryInterval;
  health: ConnectionHealth;
  mtfRefreshTimer?: NodeJS.Timeout;
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
  /** Desk primary TF for the focused stream (default 5m). */
  private primaryInterval: DeskPrimaryInterval = resolvePrimaryInterval(PRIMARY_INTERVAL);
  /** Coalesce high-frequency trade/book updates so each symbol publishes at most ~5 Hz. */
  private snapshotTimers = new Map<string, NodeJS.Timeout>();

  getPrimaryInterval(): DeskPrimaryInterval {
    return this.primaryInterval;
  }

  setPrimaryInterval(interval?: string | null): DeskPrimaryInterval {
    this.primaryInterval = resolvePrimaryInterval(interval);
    for (const state of this.states.values()) {
      state.primaryInterval = this.primaryInterval;
    }
    return this.primaryInterval;
  }

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
        candlesByInterval: new Map(),
        lastPrice: 0,
        primaryInterval: this.primaryInterval,
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
  async focus(symbol: string, primaryInterval?: string | null): Promise<void> {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return;
    if (primaryInterval != null) this.setPrimaryInterval(primaryInterval);
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
      if (key !== normalized) {
        const stale = this.states.get(key);
        if (stale?.mtfRefreshTimer) clearInterval(stale.mtfRefreshTimer);
        this.states.delete(key);
      }
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
          await this.loadMultiTimeframe(symbol);
          const state = this.states.get(symbol)!;
          state.health = {
            ...state.health,
            lastError: undefined,
          };
          this.scheduleMtfRefresh(symbol);
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
      primaryInterval: s.primaryInterval ?? this.primaryInterval,
      book: s.book,
      dom: s.dom,
      cvd: summarizeCvd(s.cvd),
      footprint: s.footprint,
      volumeProfile: s.volumeProfile,
      structure: s.structure,
      mtf: s.mtf,
      zones: s.zones,
      chartOverlay: s.chartOverlay,
      breakRetest: s.breakRetest,
      scenarios: s.scenarios,
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
    archiveTradeTick(trade);
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
    this.recomputeChartOverlay(symbol);
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
    state.zones = detectStructureZones(symbol, state.candles);
    this.recomputeMtfFromCache(symbol);
    this.recomputeChartOverlay(symbol);
  }

  private recomputeChartOverlay(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    state.chartOverlay = buildChartOverlay({
      symbol,
      lastPrice: state.lastPrice,
      tickSize: this.tickSize(symbol),
      trades: state.sessionTrades,
      candles: state.candles,
      sessionProfile: state.volumeProfile,
      structure: state.structure,
      zones: state.zones,
    });
    this.recomputeBreakRetest(symbol);
  }

  private recomputeBreakRetest(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    state.breakRetest = advanceBreakRetest(state.breakRetest, {
      symbol,
      lastPrice: state.lastPrice,
      candles: state.candles,
      chartOverlay: state.chartOverlay,
      footprint: state.footprint,
      cvd: state.cvd,
    });
    this.recomputeScenarios(symbol);
  }

  private recomputeScenarios(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    state.scenarios = advanceScenarioTree(state.scenarios, {
      symbol,
      lastPrice: state.lastPrice,
      candles: state.candles,
      chartOverlay: state.chartOverlay,
      breakRetest: state.breakRetest,
      structure: state.structure,
      cvd: state.cvd,
    });
  }

  private async loadMultiTimeframe(symbol: string): Promise<void> {
    const state = this.states.get(symbol);
    if (!state) return;
    const primary = state.primaryInterval ?? this.primaryInterval;
    state.primaryInterval = primary;
    const frames = [];
    for (const interval of MTF_INTERVALS) {
      const limit = MTF_CANDLE_LIMITS[interval] ?? 150;
      const candles = await this.adapter.fetchKlines(symbol, interval, limit);
      state.candlesByInterval.set(interval, candles);
      if (interval === primary) {
        state.candles = candles;
        state.lastPrice = candles[candles.length - 1]?.close ?? state.lastPrice;
      }
      const structure = analyzeMarketStructure(symbol, candles, 3);
      frames.push(summarizeTimeframeStructure(interval, structure));
    }
    const dayCandles = state.candlesByInterval.get("1d") ?? [];
    const prev = dayCandles.length >= 2 ? dayCandles[dayCandles.length - 2] : dayCandles[0];
    state.structure = analyzeMarketStructure(
      symbol,
      state.candles,
      3,
      prev?.high,
      prev?.low,
    );
    // Refresh primary frame with session levels attached to structure trend.
    const primaryIdx = frames.findIndex((f) => f.interval === primary);
    if (primaryIdx >= 0 && state.structure) {
      frames[primaryIdx] = summarizeTimeframeStructure(primary, state.structure);
    }
    state.mtf = buildMultiTimeframeContext(frames, primary, Date.now());
    state.zones = detectStructureZones(symbol, state.candles);
    this.recomputeChartOverlay(symbol);
  }

  private recomputeMtfFromCache(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state || state.candlesByInterval.size === 0) return;
    const primary = state.primaryInterval ?? this.primaryInterval;
    const frames = [];
    for (const interval of MTF_INTERVALS) {
      const candles = state.candlesByInterval.get(interval);
      if (!candles?.length) continue;
      if (interval === primary) {
        frames.push(
          summarizeTimeframeStructure(
            interval,
            state.structure ?? analyzeMarketStructure(symbol, candles, 3),
          ),
        );
      } else {
        frames.push(
          summarizeTimeframeStructure(interval, analyzeMarketStructure(symbol, candles, 3)),
        );
      }
    }
    if (frames.length === 0) return;
    state.mtf = buildMultiTimeframeContext(frames, primary, Date.now());
  }

  private scheduleMtfRefresh(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    if (state.mtfRefreshTimer) clearInterval(state.mtfRefreshTimer);
    state.mtfRefreshTimer = setInterval(() => {
      void this.loadMultiTimeframe(symbol)
        .then(() => {
          this.recomputeSignal(symbol);
          this.publish(symbol);
        })
        .catch((err) => this.emit("error", err));
    }, MTF_REFRESH_MS);
  }

  private recomputeSignal(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state || !state.lastPrice) return;
    const now = Date.now();
    // Advance playbook on each signal pass so OF updates can accept/fail retests.
    this.recomputeBreakRetest(symbol);
    const previous = state.signal;
    const candidate = generateSignal({
      symbol,
      lastPrice: state.lastPrice,
      timestamp: now,
      footprint: state.footprint,
      cvd: state.cvd,
      dom: state.dom,
      volumeProfile: state.volumeProfile,
      structure: state.structure,
      mtf: state.mtf,
      zones: state.zones,
      chartOverlay: state.chartOverlay,
      breakRetest: state.breakRetest,
    });
    state.signal = applySignalLifecycle(previous, candidate, state.lastPrice, now);
    try {
      recordSignalLifecycle(previous, state.signal, state.lastPrice, config.exchange);
      const ticker = getTickerStats(config.exchange, symbol);
      syncPaperTradeFromLifecycle({
        previous,
        next: state.signal,
        price: state.lastPrice,
        exchange: config.exchange,
        candles: state.candles,
        structureTrend: state.structure?.trend,
        primaryTimeframe: state.primaryInterval ?? this.primaryInterval,
        quoteVolume24h: ticker?.volume24h,
        changePct24h: ticker?.changePct24h,
        ofSnapshot: {
          cvd: state.cvd?.cvd,
          footprintDelta: state.footprint?.totalDelta,
          domImbalance: state.dom?.imbalance,
          poc: state.volumeProfile?.poc,
          vah: state.volumeProfile?.vah,
          val: state.volumeProfile?.val,
          mtfSummary: state.mtf
            ? `${state.mtf.higherTfBullish}b/${state.mtf.higherTfBearish}s conf=${state.mtf.conflictWithPrimary}`
            : undefined,
          structureTargets: state.signal?.structureTargets,
          breakRetest: state.breakRetest
            ? {
                phase: state.breakRetest.phase,
                side: state.breakRetest.side,
                bandId: state.breakRetest.bandId,
              }
            : undefined,
          quoteVolume24h: ticker?.volume24h ?? undefined,
        },
      });
    } catch (err) {
      this.emit("error", err);
    }
  }
}

function summarizeCvd(cvd: CvdState): CvdState {
  return {
    ...cvd,
    points: cvd.points.slice(-300),
  };
}

export const marketHub = new MarketHub();

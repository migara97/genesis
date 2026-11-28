import { EventEmitter } from "node:events";
import { createMarketDataAdapter, type ExchangeMarketDataAdapter } from "@of/exchange";
import {
  applyTradeToCvd,
  analyzeMarketStructure,
  buildCommentary,
  buildFootprintBar,
  buildMultiTimeframeContext,
  buildVolumeProfile,
  computeAuctionShadow,
  computeAxiaQualityShadow,
  computeDomMetrics,
  computeLeaderLagger,
  createCvdState,
  advanceBreakRetest,
  advanceScenarioTree,
  applySignalLifecycle,
  buildChartOverlay,
  detectIcebergRefill,
  detectStructureZones,
  generateSignal,
  MTF_INTERVALS,
  PRIMARY_INTERVAL,
  resolvePrimaryInterval,
  summarizeTimeframeStructure,
  type DeskPrimaryInterval,
  type IcebergRefillSignal,
  type LeaderLaggerReport,
} from "@of/orderflow";
import type {
  AuctionShadowSnapshot,
  AxiaQualityShadowSnapshot,
  BreakRetestState,
  Candle,
  ChartOverlayState,
  ConnectionHealth,
  CvdState,
  DomMetrics,
  FootprintBar,
  MarketSnapshot,
  MarketStructureState,
  MicrostructureSnapshot,
  MultiTimeframeContext,
  OrderBookSnapshot,
  ScenarioTreeState,
  StructureZonesState,
  TradeTick,
  TradingSignal,
  VolumeProfile,
} from "@of/shared";
import { config } from "./config.js";
import { evaluateAlerts } from "./alerts/store.js";
import { getTickerStats, listMarkets } from "./markets/store.js";
import { evaluateSignalNotifications } from "./notifications/evaluateSignalNotifications.js";
import { recordSignalLifecycle } from "./signals/journal.js";
import { recordSignalRejections } from "./signals/rejectionTelemetry.js";
import {
  listOpenPaperTradeSymbols,
  syncPaperTradeFromLifecycle,
  updateOpenPaperTradesByPrice,
} from "./validation/paperLedger.js";
import { archiveTradeTick } from "./validation/tapeArchive.js";

/** Candle limits per TF — keep HTF lighter to limit REST load. */
const MTF_CANDLE_LIMITS: Record<string, number> = {
  "4h": 120,
  "1h": 150,
  "15m": 200,
  "5m": 200,
  "1m": 150,
};
/** Daily bars are fetched only for previous-session high/low — not HTF voting. */
const SESSION_DAY_CANDLE_LIMIT = 5;
/** Re-fetch MTF klines on this interval (not on every trade). */
const MTF_REFRESH_MS = 5 * 60_000;
/** Re-fetch primary TF klines so the desk chart / structure stay near live. */
const PRIMARY_CANDLE_REFRESH_MS = 30_000;
/** REST poll for OPEN paper symbols that are not currently OF-focused. */
const ORPHAN_PAPER_POLL_MS = 60_000;

function createMarketAdapter(): ExchangeMarketDataAdapter {
  return createMarketDataAdapter(config.exchange);
}

interface SymbolState {
  trades: TradeTick[];
  sessionTrades: TradeTick[];
  book?: OrderBookSnapshot;
  dom?: DomMetrics;
  cvd: CvdState;
  /** Last closed footprint interval — used by signal / playbook logic. */
  footprint?: FootprintBar;
  /** In-progress interval rebuilt on the publish cadence for real-time UI. */
  liveFootprint?: FootprintBar;
  /** Recent closed footprints for Axia hang/absorb persistence (observational). */
  footprintHistory: FootprintBar[];
  footprintBuffer: TradeTick[];
  footprintOpen: number;
  footprintCloseTimer?: NodeJS.Timeout;
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
  iceberg?: IcebergRefillSignal;
  leaderLagger?: LeaderLaggerReport;
  auctionShadow?: AuctionShadowSnapshot;
  axiaQuality?: AxiaQualityShadowSnapshot;
  microstructure?: MicrostructureSnapshot;
  lastPrice: number;
  primaryInterval: DeskPrimaryInterval;
  health: ConnectionHealth;
  mtfRefreshTimer?: NodeJS.Timeout;
  primaryCandleTimer?: NodeJS.Timeout;
  leaderLaggerAt?: number;
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
  /** Phase 8: rotate OF focus across DEFAULT_SYMBOLS. */
  private rotationTimer: NodeJS.Timeout | null = null;
  private rotationIndex = 0;
  /** Price-only maintenance for OPEN paper trades on non-focused symbols. */
  private orphanPaperTimer: NodeJS.Timeout | null = null;
  /**
   * Desk pin from a UI subscribe. While set, Phase 8 rotation must not steal
   * focus — otherwise the UI stays on e.g. XAUUSDT (chart via REST) while the
   * server streams ETHUSDT and Footprint/CVD/VP stay empty.
   */
  private deskPinnedSymbol: string | null = null;
  /**
   * Coalesce rapid focus switches (multi-tab subscribe fights). Without this the
   * exchange socket tears down every few hundred ms → perpetual "… down".
   */
  private focusDebounceTimer: NodeJS.Timeout | null = null;
  private pendingFocus: {
    symbol: string;
    primaryInterval?: string | null;
    source: "user" | "rotation" | "boot";
  } | null = null;
  /** While reconnecting the exchange adapter for a focus switch. */
  private focusApplying = false;
  /** Previous focused symbol — used to ignore multi-tab "revert" thrash. */
  private previousDeskSymbol: string | null = null;
  /** Ignore reverts to previousDeskSymbol until this time. */
  private deskPinLockUntil = 0;
  /** Phase 12: throttle favorites alert evaluation per symbol. */
  private alertEvalAt = new Map<string, number>();

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
        footprintHistory: [],
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

  /**
   * Phase 8 sample growth: rotate focus across DEFAULT_SYMBOLS on an interval.
   * Only the focused symbol gets live OF / TP-SL updates; others wait until rotated back.
   */
  startFocusRotation(log?: { info: (obj: object, msg: string) => void }): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    const ms = config.focusRotationMs;
    if (!ms || ms <= 0 || config.symbols.length < 2) {
      log?.info(
        { focusRotationMs: ms, symbols: config.symbols.length },
        "focus rotation disabled",
      );
      return;
    }
    log?.info(
      { focusRotationMs: ms, symbols: config.symbols },
      "Phase 8 focus rotation enabled",
    );
    this.rotationTimer = setInterval(() => {
      if (this.deskPinnedSymbol) {
        log?.info(
          { deskPinnedSymbol: this.deskPinnedSymbol },
          "focus rotation skipped — desk pin active",
        );
        return;
      }
      this.rotationIndex = (this.rotationIndex + 1) % config.symbols.length;
      const next = config.symbols[this.rotationIndex];
      if (next) void this.focus(next, null, { source: "rotation" });
    }, ms);
  }

  stopFocusRotation(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  /**
   * Keep OPEN paper trades resolvable when focus rotation leaves their symbol.
   * REST last-price poll → TP/SL/timeout without regenerating signals.
   */
  startOrphanPaperWatcher(log?: { info: (obj: object, msg: string) => void }): void {
    if (this.orphanPaperTimer) {
      clearInterval(this.orphanPaperTimer);
      this.orphanPaperTimer = null;
    }
    log?.info({ intervalMs: ORPHAN_PAPER_POLL_MS }, "orphan paper price watcher enabled");
    this.orphanPaperTimer = setInterval(() => {
      void this.pollOrphanPaperTrades().catch((err) => this.emit("error", err));
    }, ORPHAN_PAPER_POLL_MS);
  }

  stopOrphanPaperWatcher(): void {
    if (this.orphanPaperTimer) {
      clearInterval(this.orphanPaperTimer);
      this.orphanPaperTimer = null;
    }
  }

  private async pollOrphanPaperTrades(): Promise<void> {
    const focused = [...this.states.keys()];
    const openSymbols = listOpenPaperTradeSymbols().filter((s) => !focused.includes(s));
    for (const symbol of openSymbols) {
      try {
        const candles = await this.adapter.fetchKlines(symbol, "1m", 1);
        const price = candles[candles.length - 1]?.close;
        if (price != null && price > 0) {
          updateOpenPaperTradesByPrice({ symbol, price });
        }
      } catch (err) {
        this.emit("error", err);
      }
    }
  }

  setTickSize(symbol: string, tickSize: number): void {
    if (tickSize > 0) this.tickSizes.set(symbol.toUpperCase(), tickSize);
  }

  /**
   * Stream order-flow for one symbol. Other catalog rows stay on the ticker feed.
   * Rapid user subscribes are debounced so multi-tab fights do not thrash the exchange WS.
   */
  async focus(
    symbol: string,
    primaryInterval?: string | null,
    opts?: { source?: "user" | "rotation" | "boot" },
  ): Promise<void> {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return;
    const source = opts?.source ?? "user";
    // boot / rotation must not override an active desk pin
    if (
      (source === "rotation" || source === "boot") &&
      this.deskPinnedSymbol &&
      this.deskPinnedSymbol !== normalized
    ) {
      return;
    }
    // Multi-tab thrash: Tab A pins XAU, Tab B still asserts old BTC — ignore the revert.
    // Intentional new symbols (e.g. ETH) are still allowed.
    if (
      source === "user" &&
      this.deskPinnedSymbol &&
      normalized !== this.deskPinnedSymbol &&
      (this.focusApplying ||
        (normalized === this.previousDeskSymbol && Date.now() < this.deskPinLockUntil))
    ) {
      this.publish(this.deskPinnedSymbol);
      return;
    }
    if (source === "user") {
      if (this.deskPinnedSymbol && this.deskPinnedSymbol !== normalized) {
        this.previousDeskSymbol = this.deskPinnedSymbol;
        this.deskPinLockUntil = Date.now() + 12_000;
      }
      this.deskPinnedSymbol = normalized;
    }

    const nextPrimary =
      primaryInterval != null ? resolvePrimaryInterval(primaryInterval) : this.primaryInterval;
    const keys = [...this.states.keys()];
    const sameSymbol =
      keys.length === 1 && keys[0] === normalized && this.states.has(normalized);
    const samePrimary = this.primaryInterval === nextPrimary;

    // Duplicate WS subscribe / hello must NOT reconnect — that reloads footprint + churns Signal Engine.
    if (sameSymbol && samePrimary && (this.started || this.connecting)) {
      this.pendingFocus = null;
      if (this.focusDebounceTimer) {
        clearTimeout(this.focusDebounceTimer);
        this.focusDebounceTimer = null;
      }
      this.publish(normalized);
      return;
    }

    // Primary TF-only change: refresh candles in place. Keep tape/CVD/footprint/signal memory.
    if (sameSymbol && !samePrimary && this.started) {
      this.setPrimaryInterval(primaryInterval);
      const rotIdx = config.symbols.indexOf(normalized);
      if (rotIdx >= 0) this.rotationIndex = rotIdx;
      void this.loadMultiTimeframe(normalized)
        .then(() => {
          this.scheduleMtfRefresh(normalized);
          this.recomputeSignal(normalized);
          this.publish(normalized);
        })
        .catch((err) => this.emit("error", err));
      return;
    }

    // Boot connects immediately; user/rotation coalesce so BTC↔XAU tab fights settle.
    if (source === "boot") {
      await this.applyFocus(normalized, primaryInterval);
      return;
    }
    this.pendingFocus = { symbol: normalized, primaryInterval, source };
    if (this.focusDebounceTimer) clearTimeout(this.focusDebounceTimer);
    this.focusDebounceTimer = setTimeout(() => {
      this.focusDebounceTimer = null;
      const pending = this.pendingFocus;
      this.pendingFocus = null;
      if (!pending) return;
      void this.applyFocus(pending.symbol, pending.primaryInterval);
    }, 1_000);
  }

  /** Actually tear down / reconnect the exchange adapter for a symbol. */
  private async applyFocus(
    normalized: string,
    primaryInterval?: string | null,
  ): Promise<void> {
    this.focusApplying = true;
    try {
      if (primaryInterval != null) this.setPrimaryInterval(primaryInterval);
      const rotIdx = config.symbols.indexOf(normalized);
      if (rotIdx >= 0) this.rotationIndex = rotIdx;
      const gen = ++this.generation;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.started = false;
      this.connecting = false;
      try {
        await this.adapter.disconnect({ quiet: true });
      } catch {
        // The next connect replaces the socket.
      }
      if (gen !== this.generation) return;
      for (const key of [...this.states.keys()]) {
        if (key !== normalized) {
          const stale = this.states.get(key);
          if (stale?.mtfRefreshTimer) clearInterval(stale.mtfRefreshTimer);
          if (stale?.primaryCandleTimer) clearInterval(stale.primaryCandleTimer);
          if (stale?.footprintCloseTimer) clearTimeout(stale.footprintCloseTimer);
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
      this.bootstrapSymbols([normalized]);
      // Keep desk health green during the brief reconnect gap.
      for (const state of this.states.values()) {
        state.health = {
          ...state.health,
          connected: true,
          lastError: `Switching to ${normalized}…`,
        };
      }
      this.emit("health", {
        exchange: this.adapter.id,
        connected: true,
        reconnectAttempts: 0,
        symbols: [normalized],
        lastError: `Switching to ${normalized}…`,
      });
      await this.start([normalized], gen);
    } finally {
      this.focusApplying = false;
    }
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
      // Live trade/book stream first so footprint / tape are not blocked by REST klines.
      if (gen !== this.generation) return;
      for (const symbol of symbols) this.scheduleFootprintClose(symbol);
      await this.adapter.connect(symbols, {
        onTrade: (t) => this.onTrade(t),
        onBook: (b) => this.onBook(b),
        onHealth: (h) => this.onHealth(h),
        onError: (e) => this.emit("error", e),
      });
      if (gen !== this.generation) return;
      this.started = true;

      // Seed tape from REST so Footprint/CVD/VP are not empty until the first live tick.
      // Signal Engine code is untouched — this only supplies the same trade inputs earlier.
      void this.seedRecentTrades(symbols, gen);

      // Hydrate candles in the background; failures must not tear down the live feed.
      void Promise.all(
        symbols.map(async (symbol) => {
          if (gen !== this.generation) return;
          try {
            await this.loadMultiTimeframe(symbol);
            if (gen !== this.generation) return;
            const state = this.states.get(symbol);
            if (state) {
              state.health = {
                ...state.health,
                lastError: undefined,
              };
            }
            this.recomputeProfile(symbol);
            this.recomputeSignal(symbol);
            this.publish(symbol);
          } catch (err) {
            const state = this.states.get(symbol);
            if (state) {
              state.health = {
                ...state.health,
                lastError: (err as Error).message,
              };
            }
            this.emit("error", err);
          } finally {
            if (gen === this.generation) this.scheduleMtfRefresh(symbol);
          }
        }),
      );
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
      // Always release the connecting gate; `started` covers success, gen mismatch covers focus swaps.
      this.connecting = false;
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
      // Closed bar only — Signal Engine and playbooks must not see forming intervals.
      footprint: s.footprint,
      liveFootprint: s.liveFootprint,
      volumeProfile: s.volumeProfile,
      structure: s.structure,
      mtf: s.mtf,
      zones: s.zones,
      chartOverlay: s.chartOverlay,
      breakRetest: s.breakRetest,
      scenarios: s.scenarios,
      microstructure: s.microstructure,
      signal: s.signal,
      recentTrades: s.trades.slice(-80),
      health: s.health,
    };
  }

  getMicrostructure(symbol: string): MicrostructureSnapshot | null {
    const s = this.states.get(symbol.toUpperCase());
    return s?.microstructure ?? null;
  }

  /** Cached klines for the focused symbol (primary or named interval). */
  getCandles(symbol: string, interval?: string): Candle[] | null {
    const s = this.states.get(symbol.toUpperCase());
    if (!s) return null;
    const key = (interval ?? s.primaryInterval ?? this.primaryInterval).toLowerCase();
    const fromMap = s.candlesByInterval.get(key);
    if (fromMap?.length) return fromMap;
    if (!interval || key === (s.primaryInterval ?? this.primaryInterval).toLowerCase()) {
      return s.candles.length ? s.candles : null;
    }
    return null;
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
    this.applyTradeTick(trade, state, { live: true });
    this.recomputeSignal(trade.symbol);
    this.publish(trade.symbol);
  }

  /**
   * REST tape backfill for desk panels. Does not change Signal Engine logic —
   * only feeds existing trade → CVD / footprint / VP paths once up front.
   */
  private async seedRecentTrades(symbols: string[], gen: number): Promise<void> {
    const fetchRecent = this.adapter.fetchRecentTrades?.bind(this.adapter);
    if (!fetchRecent) return;
    for (const symbol of symbols) {
      if (gen !== this.generation) return;
      try {
        const trades = await fetchRecent(symbol, 500);
        if (gen !== this.generation) return;
        const state = this.states.get(symbol);
        if (!state || state.sessionTrades.length > 0) continue;
        for (const trade of trades) {
          archiveTradeTick(trade);
          this.applyTradeTick(trade, state, { live: false });
        }
        this.refreshLiveFootprint(symbol);
        this.recomputeProfile(symbol);
        this.recomputeSignal(symbol);
        this.publish(symbol);
      } catch (err) {
        const state = this.states.get(symbol);
        if (state) {
          state.health = {
            ...state.health,
            lastError: (err as Error).message,
          };
          this.publish(symbol);
        }
        this.emit("error", err);
      }
    }
  }

  private applyTradeTick(
    trade: TradeTick,
    state: SymbolState,
    opts: { live: boolean },
  ): void {
    state.lastPrice = trade.price;
    state.trades.push(trade);
    if (state.trades.length > 500) state.trades.splice(0, state.trades.length - 500);
    state.sessionTrades.push(trade);
    if (state.sessionTrades.length > 50_000) {
      state.sessionTrades.splice(0, state.sessionTrades.length - 50_000);
    }

    state.cvd = applyTradeToCvd(state.cvd, trade);
    state.footprintBuffer.push(trade);

    if (!opts.live) return;
    const now = trade.timestamp || Date.now();
    if (now - state.footprintOpen >= config.footprintIntervalMs) {
      this.closeFootprintInterval(trade.symbol, now);
    }
  }

  private onBook(book: OrderBookSnapshot): void {
    const state = this.states.get(book.symbol);
    if (!state) return;
    state.book = book;
    state.dom = computeDomMetrics(book);
    const iceberg = detectIcebergRefill(book);
    state.iceberg = iceberg;
    if (state.dom) {
      state.dom = {
        ...state.dom,
        iceberg: {
          side: iceberg.side,
          price: iceberg.price,
          refillCount: iceberg.refillCount,
          confidence: iceberg.confidence,
          note: iceberg.note,
        },
        evidence: [...state.dom.evidence, ...iceberg.evidence],
      };
    }
    if (state.dom.mid) state.lastPrice = state.dom.mid;
    this.recomputeMicrostructure(book.symbol);
    this.recomputeSignal(book.symbol);
    this.publish(book.symbol);
  }

  private refreshLeaderLagger(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    const now = Date.now();
    if (state.leaderLaggerAt && now - state.leaderLaggerAt < 30_000) return;
    try {
      const page = listMarkets({
        exchange: config.exchange,
        status: "live",
        sort: "volume",
        limit: 80,
      });
      state.leaderLagger = computeLeaderLagger({
        focus: symbol,
        peers: page.items.map((item) => ({
          symbol: item.symbol,
          changePct24h: item.changePct24h,
          volume24h: item.volume24h,
        })),
      });
      state.leaderLaggerAt = now;
    } catch {
      // Catalog may be empty during first boot.
    }
  }

  private recomputeMicrostructure(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    this.refreshLeaderLagger(symbol);
    state.auctionShadow = computeAuctionShadow({
      symbol,
      lastPrice: state.lastPrice,
      volumeProfile: state.volumeProfile,
      footprint: state.footprint,
      cvd: state.cvd,
      breakRetest: state.breakRetest,
    });
    state.axiaQuality = computeAxiaQualityShadow({
      symbol,
      lastPrice: state.lastPrice,
      footprint: state.footprint,
      footprintHistory: state.footprintHistory,
      breakRetest: state.breakRetest,
      barIndex: Math.max(0, state.candles.length - 1),
    });
    const commentary = buildCommentary({
      signal: state.signal,
      iceberg: state.iceberg,
      leaderLagger: state.leaderLagger,
      auctionShadow: state.auctionShadow,
      axiaQuality: state.axiaQuality,
      lastPrice: state.lastPrice,
    });
    state.microstructure = {
      iceberg: state.iceberg
        ? {
            side: state.iceberg.side,
            price: state.iceberg.price,
            refillCount: state.iceberg.refillCount,
            confidence: state.iceberg.confidence,
            note: state.iceberg.note,
          }
        : undefined,
      leaderLagger: state.leaderLagger
        ? {
            role: state.leaderLagger.role,
            confidence: state.leaderLagger.confidence,
            note: state.leaderLagger.note,
            focusChangePct24h: state.leaderLagger.focusChangePct24h,
          }
        : undefined,
      auctionShadow: state.auctionShadow,
      axiaQuality: state.axiaQuality,
      commentary: {
        text: commentary.text,
        source: "template",
        mutatesScores: false,
      },
    };
    if (state.signal) {
      state.signal = {
        ...state.signal,
        commentary: state.microstructure.commentary,
      };
    }
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
        this.refreshLiveFootprint(symbol);
        const snap = this.getSnapshot(symbol);
        if (snap) this.emit("snapshot", snap);
      }, 200),
    );
  }

  /** Rebuild the in-progress footprint for UI without mutating closed-bar signal inputs. */
  private refreshLiveFootprint(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    if (state.footprintBuffer.length === 0) {
      state.liveFootprint = undefined;
      return;
    }
    const now = Date.now();
    const bar = buildFootprintBar(
      symbol,
      state.footprintBuffer,
      state.footprintOpen,
      now,
      { tickSize: this.tickSize(symbol) },
    );
    state.liveFootprint = bar ? { ...bar, forming: true } : undefined;
  }

  /** Ensure intervals close on schedule even when the tape goes quiet. */
  private scheduleFootprintClose(symbol: string): void {
    const state = this.states.get(symbol);
    if (!state) return;
    if (state.footprintCloseTimer) clearTimeout(state.footprintCloseTimer);
    const elapsed = Date.now() - state.footprintOpen;
    const remaining = Math.max(1, config.footprintIntervalMs - elapsed);
    state.footprintCloseTimer = setTimeout(() => {
      state.footprintCloseTimer = undefined;
      // Only touch Signal Engine when a closed bar was actually produced (same as trade-close path).
      const closed = this.closeFootprintInterval(symbol, Date.now());
      if (closed) this.recomputeSignal(symbol);
      this.publish(symbol);
    }, remaining);
  }

  /** @returns true when a closed footprint bar was committed for signal consumers. */
  private closeFootprintInterval(symbol: string, closeTime: number): boolean {
    const state = this.states.get(symbol);
    if (!state) return false;
    if (state.footprintCloseTimer) {
      clearTimeout(state.footprintCloseTimer);
      state.footprintCloseTimer = undefined;
    }
    let closed = false;
    if (state.footprintBuffer.length > 0) {
      const bar = buildFootprintBar(
        symbol,
        state.footprintBuffer,
        state.footprintOpen,
        closeTime,
        { tickSize: this.tickSize(symbol) },
      );
      if (bar) {
        state.footprint = { ...bar, forming: false };
        state.footprintHistory = [...state.footprintHistory, state.footprint].slice(-12);
        // Keep showing the closed bar in the Footprint panel until the next interval has trades.
        state.liveFootprint = undefined;
        closed = true;
      }
      this.recomputeProfile(symbol);
      // Refresh structure periodically from candles + last price proxy candle
      this.refreshStructure(symbol);
    }
    state.footprintBuffer = [];
    state.footprintOpen = closeTime;
    this.scheduleFootprintClose(symbol);
    return closed;
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
    const loaded = await Promise.all(
      MTF_INTERVALS.map(async (interval) => {
        const limit = MTF_CANDLE_LIMITS[interval] ?? 150;
        const candles = await this.adapter.fetchKlines(symbol, interval, limit);
        return { interval, candles };
      }),
    );
    const frames = [];
    for (const { interval, candles } of loaded) {
      state.candlesByInterval.set(interval, candles);
      if (interval === primary) {
        state.candles = candles;
        state.lastPrice = candles[candles.length - 1]?.close ?? state.lastPrice;
      }
      const structure = analyzeMarketStructure(symbol, candles, 3);
      frames.push(summarizeTimeframeStructure(interval, structure));
    }
    let dayCandles = state.candlesByInterval.get("1d") ?? [];
    if (dayCandles.length === 0) {
      try {
        dayCandles = await this.adapter.fetchKlines(symbol, "1d", SESSION_DAY_CANDLE_LIMIT);
        state.candlesByInterval.set("1d", dayCandles);
      } catch {
        dayCandles = [];
      }
    }
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
    if (state.primaryCandleTimer) clearInterval(state.primaryCandleTimer);
    state.mtfRefreshTimer = setInterval(() => {
      void this.loadMultiTimeframe(symbol)
        .then(() => {
          this.recomputeSignal(symbol);
          this.publish(symbol);
        })
        .catch((err) => this.emit("error", err));
    }, MTF_REFRESH_MS);
    state.primaryCandleTimer = setInterval(() => {
      void this.refreshPrimaryCandles(symbol)
        .then(() => {
          this.refreshStructure(symbol);
          this.recomputeSignal(symbol);
          this.publish(symbol);
        })
        .catch((err) => this.emit("error", err));
    }, PRIMARY_CANDLE_REFRESH_MS);
  }

  /** Light REST refresh of the desk primary TF only (keeps OHLCV chart current). */
  private async refreshPrimaryCandles(symbol: string): Promise<void> {
    const state = this.states.get(symbol);
    if (!state) return;
    const primary = state.primaryInterval ?? this.primaryInterval;
    const limit = MTF_CANDLE_LIMITS[primary] ?? 200;
    const candles = await this.adapter.fetchKlines(symbol, primary, limit);
    state.candlesByInterval.set(primary, candles);
    state.candles = candles;
    if (!state.lastPrice && candles.length) {
      state.lastPrice = candles[candles.length - 1]?.close ?? state.lastPrice;
    }
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
      recordSignalRejections(state.signal);
    } catch {
      // Telemetry must never break the signal path.
    }
    // Refresh observational shadows before paper freeze (no score mutation).
    state.auctionShadow = computeAuctionShadow({
      symbol,
      lastPrice: state.lastPrice,
      volumeProfile: state.volumeProfile,
      footprint: state.footprint,
      cvd: state.cvd,
      breakRetest: state.breakRetest,
    });
    state.axiaQuality = computeAxiaQualityShadow({
      symbol,
      lastPrice: state.lastPrice,
      footprint: state.footprint,
      footprintHistory: state.footprintHistory,
      breakRetest: state.breakRetest,
      barIndex: Math.max(0, state.candles.length - 1),
    });
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
          auctionShadow: state.auctionShadow
            ? {
                state: state.auctionShadow.state,
                modelMode: state.auctionShadow.modelMode,
                priceVsValue: state.auctionShadow.priceVsValue,
                nearLvn: state.auctionShadow.nearLvn,
                aggressionSide: state.auctionShadow.aggressionSide,
                aggressionScore: state.auctionShadow.aggressionScore,
                followThrough: state.auctionShadow.followThrough,
                failedAuction: state.auctionShadow.failedAuction,
              }
            : undefined,
          axiaQuality: state.axiaQuality
            ? {
                deltaEfficiency: state.axiaQuality.deltaEfficiency,
                breakQuality: state.axiaQuality.breakQuality,
                hangBars: state.axiaQuality.hangBars,
                hangDetected: state.axiaQuality.hangDetected,
                highLowFormation: state.axiaQuality.highLowFormation,
                absorptionPersistence: state.axiaQuality.absorptionPersistence,
              }
            : undefined,
        },
      });
      const lifecycleChanged =
        previous?.lifecycle !== state.signal.lifecycle ||
        (previous?.tpHits ?? 0) !== (state.signal.tpHits ?? 0);
      const lastEval = this.alertEvalAt.get(symbol) ?? 0;
      const due = now - lastEval >= 5_000;
      if (lifecycleChanged || previous == null || due) {
        this.alertEvalAt.set(symbol, now);
        const fires = evaluateAlerts({
          symbol,
          price: state.lastPrice,
          lifecycle: lifecycleChanged || previous == null ? state.signal.lifecycle : undefined,
          setupId: state.signal.setupId,
        });
        for (const fire of fires) this.emit("alert", fire);
      }
      // High-quality signal notifications (A+ / lifecycle transitions) — async Telegram via outbox
      if (lifecycleChanged || previous == null) {
        try {
          const notifyFires = evaluateSignalNotifications({
            previous,
            next: state.signal,
            price: state.lastPrice,
            exchange: config.exchange,
            primaryInterval: state.primaryInterval ?? this.primaryInterval,
          });
          for (const fire of notifyFires) this.emit("alert", fire);
        } catch (notifyErr) {
          this.emit("error", notifyErr);
        }
      }
    } catch (err) {
      this.emit("error", err);
    }
    this.recomputeMicrostructure(symbol);
  }
}

function summarizeCvd(cvd: CvdState): CvdState {
  return {
    ...cvd,
    points: cvd.points.slice(-300),
  };
}

export const marketHub = new MarketHub();

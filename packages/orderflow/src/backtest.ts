import type { Candle, MultiTimeframeContext, TradingSignal } from "@of/shared";
import {
  analyzeMarketStructure,
  buildMultiTimeframeContext,
  PRIMARY_INTERVAL,
  softIntervalForPrimary,
  summarizeTimeframeStructure,
} from "./structure.js";
import { applySignalLifecycle } from "./signalLifecycle.js";
import { DEFAULT_SIGNAL_CONFIG, generateSignal, type SignalEngineConfig } from "./signals.js";

export interface BacktestTrade {
  setupId: string;
  entryTime: number;
  exitTime: number;
  side: "LONG" | "SHORT";
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  outcome: "HIT_TP" | "HIT_SL" | "INVALIDATED" | "EXPIRED" | "TIMEOUT" | "TIME";
  lifecycleNote?: string;
}

export interface BacktestConfig {
  feeBps: number;
  slippageBps: number;
  /** Bars of primary history required before scoring. */
  warmupBars: number;
  /** Max bars to hold a directional setup before force TIME exit. */
  maxHoldBars: number;
  primaryInterval: string;
  /**
   * Historical tape lacks CVD/footprint/DOM. When true, relax minIndependent to 1
   * so structure/MTF-only history can open trades. Always disclosed in `limitation`.
   */
  structureOnlyMode: boolean;
  signalConfig?: Partial<SignalEngineConfig>;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  feeBps: 4,
  slippageBps: 1,
  warmupBars: 60,
  maxHoldBars: 48,
  primaryInterval: PRIMARY_INTERVAL,
  structureOnlyMode: true,
};

export interface BacktestSeries {
  interval: string;
  candles: Candle[];
}

export interface BacktestResult {
  trades: BacktestTrade[];
  signalsEvaluated: number;
  directionalSignals: number;
  waitSignals: number;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  averageRr: number | null;
  expectancy: number | null;
  totalPnl: number;
  sampleSignals: TradingSignal[];
  limitation: string;
  config: BacktestConfig;
}

/**
 * Replay the live signal + lifecycle path over historical candles.
 * Order-flow (CVD/footprint/DOM) is absent unless provided later — metrics
 * reflect structure/MTF-only conditions and must not be marketed as full-engine edge.
 */
export function backtestSignalEngine(
  symbol: string,
  primaryCandles: Candle[],
  higherTimeframes: BacktestSeries[] = [],
  softTimeframe?: Candle[],
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): BacktestResult {
  const trades: BacktestTrade[] = [];
  const sampleSignals: TradingSignal[] = [];
  let previous: TradingSignal | undefined;
  let signalsEvaluated = 0;
  let directionalSignals = 0;
  let waitSignals = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let openEntryBar: number | undefined;

  const signalConfig: SignalEngineConfig = {
    ...DEFAULT_SIGNAL_CONFIG,
    ...config.signalConfig,
    weights: {
      ...DEFAULT_SIGNAL_CONFIG.weights,
      ...(config.signalConfig?.weights ?? {}),
    },
    minIndependent: config.structureOnlyMode
      ? (config.signalConfig?.minIndependent ?? 1)
      : (config.signalConfig?.minIndependent ?? DEFAULT_SIGNAL_CONFIG.minIndependent),
    // Structure/MTF alone rarely reaches live minScore=2 without OF; disclose via limitation.
    minScore: config.structureOnlyMode
      ? (config.signalConfig?.minScore ?? 1)
      : (config.signalConfig?.minScore ?? DEFAULT_SIGNAL_CONFIG.minScore),
    // A+ requires OF+location — structure-only proxy must use standard gates.
    entryQuality: config.structureOnlyMode
      ? (config.signalConfig?.entryQuality ?? "standard")
      : (config.signalConfig?.entryQuality ?? DEFAULT_SIGNAL_CONFIG.entryQuality),
  };

  const limitation = [
    "Historical tape/order-flow (CVD, footprint, DOM) is not stored; this replay scores structure + multi-timeframe candle swings only.",
    config.structureOnlyMode
      ? `structureOnlyMode=true (minIndependent=${signalConfig.minIndependent}) because OF confirmations are unavailable historically.`
      : `structureOnlyMode=false (minIndependent=${signalConfig.minIndependent}).`,
    "Metrics are sample statistics for this limited input set — not a proven live edge.",
  ].join(" ");

  for (let i = config.warmupBars; i < primaryCandles.length; i++) {
    const window = primaryCandles.slice(0, i + 1);
    const bar = window[window.length - 1]!;
    const structure = analyzeMarketStructure(symbol, window, 3);
    const mtf = buildMtfAt(
      symbol,
      bar.closeTime,
      structure,
      config.primaryInterval,
      higherTimeframes,
      softTimeframe,
    );

    const candidate = generateSignal(
      {
        symbol,
        lastPrice: bar.close,
        timestamp: bar.closeTime,
        structure,
        mtf,
      },
      signalConfig,
    );
    signalsEvaluated += 1;
    if (candidate.direction === "WAIT") waitSignals += 1;
    else directionalSignals += 1;

    let next = applySignalLifecycle(previous, candidate, bar.close, bar.closeTime);

    // Force time exit if a directional setup has been open too long.
    if (
      openEntryBar != null &&
      (next.lifecycle === "CONFIRMED" || next.lifecycle === "ACTIVE") &&
      i - openEntryBar >= config.maxHoldBars &&
      next.entry != null &&
      (next.direction === "LONG" || next.direction === "SHORT")
    ) {
      next = {
        ...next,
        lifecycle: "TIMEOUT",
        lifecycleUpdatedAt: bar.closeTime,
        lifecycleNote: `Backtest max hold (${config.maxHoldBars} bars) reached.`,
      };
    }

    if (
      (next.lifecycle === "CONFIRMED" || next.lifecycle === "ACTIVE") &&
      (!previous || previous.setupId !== next.setupId || previous.direction === "WAIT")
    ) {
      openEntryBar = i;
    }

    if (isTerminal(next.lifecycle) && next.entry != null && (next.direction === "LONG" || next.direction === "SHORT")) {
      const side = next.direction;
      const rawEntry = applySlippage(next.entry, side, "entry", config.slippageBps);
      const rawExit = applySlippage(bar.close, side, "exit", config.slippageBps);
      const dir = side === "LONG" ? 1 : -1;
      const gross = (rawExit - rawEntry) * dir;
      const fees = ((rawEntry + rawExit) * config.feeBps) / 10_000;
      const pnl = gross - fees;
      const outcome: BacktestTrade["outcome"] =
        next.lifecycle === "HIT_TP" ||
        next.lifecycle === "HIT_SL" ||
        next.lifecycle === "INVALIDATED" ||
        next.lifecycle === "EXPIRED"
          ? next.lifecycle
          : next.lifecycle === "TIMEOUT"
            ? "TIMEOUT"
            : "TIME";
      trades.push({
        setupId: next.setupId,
        entryTime: next.setupOpenedAt ?? bar.closeTime,
        exitTime: bar.closeTime,
        side,
        entry: rawEntry,
        exit: rawExit,
        pnl,
        fees,
        outcome,
        lifecycleNote: next.lifecycleNote,
      });
      equity += pnl;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
      openEntryBar = undefined;
    }

    previous = next;
    if (sampleSignals.length < 30) sampleSignals.push(next);
    else sampleSignals[sampleSignals.length - 1] = next;
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const decided = trades.filter((t) => t.outcome === "HIT_TP" || t.outcome === "HIT_SL");
  const rrSamples = trades
    .filter((t) => t.entry !== t.exit)
    .map((t) => {
      // Crude R vs 0.5% stop proxy used by the engine when VP is absent.
      const risk = Math.abs(t.entry) * 0.005;
      return risk > 0 ? t.pnl / risk : 0;
    });

  return {
    trades,
    signalsEvaluated,
    directionalSignals,
    waitSignals,
    winRate: decided.length ? decided.filter((t) => t.outcome === "HIT_TP").length / decided.length : null,
    profitFactor:
      trades.length === 0
        ? null
        : grossLoss === 0
          ? grossWin > 0
            ? Number.POSITIVE_INFINITY
            : 0
          : grossWin / grossLoss,
    maxDrawdown,
    averageRr: rrSamples.length ? rrSamples.reduce((a, b) => a + b, 0) / rrSamples.length : null,
    expectancy: trades.length ? totalPnl / trades.length : null,
    totalPnl,
    sampleSignals: sampleSignals.slice(-20),
    limitation,
    config,
  };
}

/** @deprecated Prefer backtestSignalEngine. Kept for older API imports. */
export function backtestFromCandles(
  symbol: string,
  candles: Candle[],
  feeBps = 4,
): BacktestResult {
  return backtestSignalEngine(symbol, candles, [], undefined, {
    ...DEFAULT_BACKTEST_CONFIG,
    feeBps,
  });
}

function isTerminal(lifecycle: string): boolean {
  return (
    lifecycle === "HIT_TP" ||
    lifecycle === "HIT_SL" ||
    lifecycle === "INVALIDATED" ||
    lifecycle === "EXPIRED" ||
    lifecycle === "TIMEOUT"
  );
}

function applySlippage(
  price: number,
  side: "LONG" | "SHORT",
  leg: "entry" | "exit",
  slippageBps: number,
): number {
  const slip = (price * slippageBps) / 10_000;
  if (side === "LONG") {
    return leg === "entry" ? price + slip : price - slip;
  }
  return leg === "entry" ? price - slip : price + slip;
}

function buildMtfAt(
  symbol: string,
  asOf: number,
  primaryStructure: ReturnType<typeof analyzeMarketStructure>,
  primaryInterval: string,
  higherTimeframes: BacktestSeries[],
  softTimeframe?: Candle[],
): MultiTimeframeContext {
  const frames = [
    summarizeTimeframeStructure(primaryInterval, primaryStructure),
  ];
  for (const series of higherTimeframes) {
    const window = series.candles.filter((c) => c.closeTime <= asOf);
    if (window.length < 20) continue;
    const structure = analyzeMarketStructure(symbol, window, 3);
    frames.push(summarizeTimeframeStructure(series.interval, structure));
  }
  if (softTimeframe?.length) {
    const window = softTimeframe.filter((c) => c.closeTime <= asOf);
    if (window.length >= 20) {
      const structure = analyzeMarketStructure(symbol, window, 3);
      frames.push(
        summarizeTimeframeStructure(softIntervalForPrimary(primaryInterval), structure),
      );
    }
  }
  return buildMultiTimeframeContext(frames, primaryInterval, asOf);
}

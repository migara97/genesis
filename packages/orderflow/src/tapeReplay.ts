import type {
  Candle,
  FootprintBar,
  MultiTimeframeContext,
  TradeTick,
  TradingSignal,
  VolumeProfile,
} from "@of/shared";
import { advanceBreakRetest } from "./breakoutRetest.js";
import { applyTradeToCvd, createCvdState } from "./cvd.js";
import { buildFootprintBar } from "./footprint.js";
import { detectStructureZones } from "./priceZones.js";
import { applySignalLifecycle, DEFAULT_LIFECYCLE_CONFIG } from "./signalLifecycle.js";
import {
  DEFAULT_SIGNAL_CONFIG,
  generateSignal,
  type SignalEngineConfig,
} from "./signals.js";
import {
  analyzeMarketStructure,
  buildMultiTimeframeContext,
  MTF_INTERVALS,
  PRIMARY_INTERVAL,
  resolvePrimaryInterval,
  summarizeTimeframeStructure,
  type DeskPrimaryInterval,
} from "./structure.js";
import { buildVolumeProfile } from "./volumeProfile.js";

export interface TapeReplayTrade {
  setupId: string;
  entryTime: number;
  exitTime: number;
  side: "LONG" | "SHORT";
  entry: number;
  exit: number;
  outcome: "HIT_TP" | "HIT_SL" | "INVALIDATED" | "EXPIRED" | "TIMEOUT";
  confirmations: string[];
  confidence: number;
  ofSnapshot: {
    cvd: number | null;
    footprintDelta: number | null;
    poc: number | null;
  };
}

export interface TapeReplaySeries {
  interval: string;
  candles: Candle[];
}

export interface TapeReplayConfig {
  footprintIntervalMs: number;
  tickSize: number;
  /** Re-run generateSignal every N trades (lifecycle still ticks every trade). */
  signalRescoreEveryTrades: number;
  primaryInterval: DeskPrimaryInterval;
  maxTrades?: number;
  signalConfig?: Partial<SignalEngineConfig>;
}

export const DEFAULT_TAPE_REPLAY_CONFIG: TapeReplayConfig = {
  footprintIntervalMs: 60_000,
  tickSize: 0.1,
  signalRescoreEveryTrades: 10,
  primaryInterval: PRIMARY_INTERVAL,
};

export interface TapeReplayResult {
  trades: TapeReplayTrade[];
  signalsEvaluated: number;
  directionalSignals: number;
  waitSignals: number;
  ticksProcessed: number;
  sampleSignals: TradingSignal[];
  limitation: string;
  inputsUsed: string[];
  inputsMissing: string[];
  config: TapeReplayConfig;
}

function candlesUpTo(candles: Candle[], ts: number): Candle[] {
  // Prefer closeTime when set; fall back to openTime for sparse caches.
  return candles.filter((c) => (c.closeTime || c.openTime) <= ts);
}

/**
 * Replay full order-flow path from archived trade tape + candle series.
 * DOM / L2 is never reconstructed (not archived) — disclosed in `limitation`.
 * Uses live DEFAULT_SIGNAL_CONFIG gates (not structureOnlyMode).
 */
export function replayTapeOrderFlow(
  symbol: string,
  ticks: TradeTick[],
  candleSeries: TapeReplaySeries[],
  config: Partial<TapeReplayConfig> = {},
): TapeReplayResult {
  const cfg: TapeReplayConfig = {
    ...DEFAULT_TAPE_REPLAY_CONFIG,
    ...config,
    primaryInterval: resolvePrimaryInterval(
      config.primaryInterval ?? DEFAULT_TAPE_REPLAY_CONFIG.primaryInterval,
    ),
  };

  const signalConfig: SignalEngineConfig = {
    ...DEFAULT_SIGNAL_CONFIG,
    ...cfg.signalConfig,
    weights: {
      ...DEFAULT_SIGNAL_CONFIG.weights,
      ...(cfg.signalConfig?.weights ?? {}),
    },
  };

  const limitation = [
    "Phase 9 tape replay reconstructs footprint, CVD, and volume profile from archived aggressor trades.",
    "DOM/L2 is not archived — DOM family cannot participate (same as live when book is empty).",
    "Structure/MTF/zones use candle series sliced to each tick time.",
    "Lifecycle uses tick lastPrice with SL-before-TP (live policy), not OHLC sl_first.",
    "This is partial-OF parity — not a claim of bit-identical live engine output when DOM mattered.",
  ].join(" ");

  const inputsUsed = [
    "trade_tape",
    "footprint",
    "cvd",
    "volumeProfile",
    "structure",
    "mtf",
    "zones",
    "breakRetest",
  ];
  const inputsMissing = ["dom"];

  const byInterval = new Map<string, Candle[]>();
  for (const series of candleSeries) {
    byInterval.set(series.interval, [...series.candles].sort((a, b) => a.openTime - b.openTime));
  }

  const limited =
    cfg.maxTrades != null && cfg.maxTrades > 0 ? ticks.slice(0, cfg.maxTrades) : ticks;
  if (limited.length === 0) {
    return {
      trades: [],
      signalsEvaluated: 0,
      directionalSignals: 0,
      waitSignals: 0,
      ticksProcessed: 0,
      sampleSignals: [],
      limitation: `${limitation} No ticks provided.`,
      inputsUsed,
      inputsMissing,
      config: cfg,
    };
  }

  const sessionStart = limited[0]!.timestamp;
  let cvd = createCvdState(symbol, sessionStart);
  let footprintBuffer: TradeTick[] = [];
  let footprintOpen = sessionStart;
  let footprint: FootprintBar | undefined;
  let volumeProfile: VolumeProfile | undefined;
  let sessionTrades: TradeTick[] = [];
  let previous: TradingSignal | undefined;
  let breakRetest = undefined as ReturnType<typeof advanceBreakRetest> | undefined;

  const closed: TapeReplayTrade[] = [];
  const sampleSignals: TradingSignal[] = [];
  let signalsEvaluated = 0;
  let directionalSignals = 0;
  let waitSignals = 0;
  let tradeIndex = 0;

  const refreshContext = (ts: number, lastPrice: number) => {
    const primary = candlesUpTo(byInterval.get(cfg.primaryInterval) ?? [], ts);
    const frames = [];
    for (const interval of MTF_INTERVALS) {
      const series = candlesUpTo(byInterval.get(interval) ?? [], ts);
      if (!series.length) continue;
      const structure = analyzeMarketStructure(symbol, series, 3);
      frames.push(summarizeTimeframeStructure(interval, structure));
    }
    const structure =
      primary.length > 0 ? analyzeMarketStructure(symbol, primary, 3) : undefined;
    const mtf: MultiTimeframeContext | undefined =
      frames.length > 0
        ? buildMultiTimeframeContext(frames, cfg.primaryInterval, ts)
        : undefined;
    const zones = primary.length > 0 ? detectStructureZones(symbol, primary) : undefined;
    breakRetest = advanceBreakRetest(breakRetest, {
      symbol,
      lastPrice,
      candles: primary,
      footprint,
      cvd,
    });
    return { structure, mtf, zones, primary };
  };

  for (const trade of limited) {
    tradeIndex += 1;
    cvd = applyTradeToCvd(cvd, trade);
    footprintBuffer.push(trade);
    sessionTrades.push(trade);
    if (sessionTrades.length > 50_000) {
      sessionTrades = sessionTrades.slice(-50_000);
    }

    const now = trade.timestamp;
    const barDue = now - footprintOpen >= cfg.footprintIntervalMs;
    if (barDue) {
      const bar = buildFootprintBar(symbol, footprintBuffer, footprintOpen, now, {
        tickSize: cfg.tickSize,
      });
      if (bar) footprint = bar;
      footprintBuffer = [];
      footprintOpen = now;
      volumeProfile = buildVolumeProfile(symbol, sessionTrades, cfg.tickSize) ?? volumeProfile;
    }

    const rescore =
      barDue ||
      tradeIndex === 1 ||
      tradeIndex % Math.max(1, cfg.signalRescoreEveryTrades) === 0;

    let candidate: TradingSignal;
    if (rescore) {
      const ctx = refreshContext(now, trade.price);
      candidate = generateSignal(
        {
          symbol,
          lastPrice: trade.price,
          timestamp: now,
          footprint,
          cvd,
          volumeProfile,
          structure: ctx.structure,
          mtf: ctx.mtf,
          zones: ctx.zones,
          breakRetest,
          dom: null,
        },
        signalConfig,
      );
      signalsEvaluated += 1;
      if (candidate.direction === "WAIT") waitSignals += 1;
      else directionalSignals += 1;
    } else if (previous) {
      // Hold prior score; lifecycle still sees fresh tick price for TP/SL.
      candidate = { ...previous, timestamp: now };
    } else {
      candidate = generateSignal(
        {
          symbol,
          lastPrice: trade.price,
          timestamp: now,
          footprint,
          cvd,
          volumeProfile,
          dom: null,
        },
        signalConfig,
      );
      signalsEvaluated += 1;
      waitSignals += 1;
    }

    const priorLifecycle = previous?.lifecycle;
    const next = applySignalLifecycle(
      previous,
      candidate,
      trade.price,
      now,
      DEFAULT_LIFECYCLE_CONFIG,
    );

    if (
      previous &&
      priorLifecycle &&
      !["HIT_TP", "HIT_SL", "INVALIDATED", "EXPIRED", "TIMEOUT"].includes(priorLifecycle) &&
      ["HIT_TP", "HIT_SL", "INVALIDATED", "EXPIRED", "TIMEOUT"].includes(next.lifecycle) &&
      previous.direction !== "WAIT" &&
      previous.entry != null
    ) {
      closed.push({
        setupId: previous.setupId,
        entryTime: previous.setupOpenedAt ?? previous.timestamp,
        exitTime: now,
        side: previous.direction as "LONG" | "SHORT",
        entry: previous.entry,
        exit: trade.price,
        outcome: next.lifecycle as TapeReplayTrade["outcome"],
        confirmations: previous.confirmations ?? [],
        confidence: previous.confidence,
        ofSnapshot: {
          cvd: cvd.cvd,
          footprintDelta: footprint?.totalDelta ?? null,
          poc: volumeProfile?.poc ?? null,
        },
      });
    }

    previous = next;
    if (sampleSignals.length < 12 && (rescore || next.direction !== "WAIT")) {
      sampleSignals.push(next);
    }
  }

  return {
    trades: closed,
    signalsEvaluated,
    directionalSignals,
    waitSignals,
    ticksProcessed: limited.length,
    sampleSignals,
    limitation,
    inputsUsed,
    inputsMissing,
    config: cfg,
  };
}

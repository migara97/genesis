import {
  computeCalibration,
  computePerformance,
  groupByKey,
  groupByRegime,
  type ClosedTradeSample,
  type PerformanceReport,
} from "@of/orderflow";
import type { PaperSetupClass } from "@of/shared";
import { listPaperTrades } from "./paperLedger.js";
import { tapeCoverageNote } from "./tapeArchive.js";
import { config } from "../config.js";

const PHASE_F_NOTE =
  "Phase F scoreboard — falsify RANGE_BREAK_RETEST with fee-aware expectancy. Expectancy/win rate are not permission to raise live size on thin samples.";

function sanitizePerf(p: PerformanceReport) {
  return {
    ...p,
    profitFactor:
      p.profitFactor == null
        ? null
        : Number.isFinite(p.profitFactor)
          ? p.profitFactor
          : null,
    profitFactorUnbounded: p.profitFactor === Number.POSITIVE_INFINITY,
  };
}

function sanitizeMap(map: Record<string, PerformanceReport>) {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, sanitizePerf(v)]));
}

export function buildValidationReport(
  symbol?: string,
  opts?: { setupClass?: PaperSetupClass },
) {
  const trades = listPaperTrades({
    symbol,
    limit: 500,
    setupClass: opts?.setupClass,
  });
  const open = trades.filter((t) => t.outcome === "OPEN");
  const samples: ClosedTradeSample[] = trades
    .filter((t) => t.outcome !== "OPEN")
    .map((t) => {
      const resolved = t.outcome === "HIT_TP" || t.outcome === "HIT_SL";
      return {
        setupId: t.setupId,
        symbol: t.symbol,
        side: t.direction as "LONG" | "SHORT",
        outcome: t.outcome,
        isResolvedWinLoss: resolved,
        won: resolved ? t.outcome === "HIT_TP" : null,
        netPnl: t.netPnl ?? 0,
        grossPnl: t.grossPnl ?? t.netPnl ?? 0,
        fees: t.fees ?? 0,
        funding: t.funding ?? 0,
        rMultiple: t.rMultiple,
        confidence: t.confidence,
        holdMs: t.holdMs ?? 0,
        mfe: t.mfe,
        mae: t.mae,
        regimeTags: t.regimeTags,
        setupClass: t.setupClass,
        primaryTimeframe: t.primaryTimeframe,
      };
    });

  // Full universe for strata (ignore setupClass query filter for overall vs BR slice).
  const allTrades = opts?.setupClass
    ? listPaperTrades({ symbol, limit: 500 })
    : trades;
  const allOpen = allTrades.filter((t) => t.outcome === "OPEN");
  const allSamples: ClosedTradeSample[] = allTrades
    .filter((t) => t.outcome !== "OPEN")
    .map((t) => {
      const resolved = t.outcome === "HIT_TP" || t.outcome === "HIT_SL";
      return {
        setupId: t.setupId,
        symbol: t.symbol,
        side: t.direction as "LONG" | "SHORT",
        outcome: t.outcome,
        isResolvedWinLoss: resolved,
        won: resolved ? t.outcome === "HIT_TP" : null,
        netPnl: t.netPnl ?? 0,
        grossPnl: t.grossPnl ?? t.netPnl ?? 0,
        fees: t.fees ?? 0,
        funding: t.funding ?? 0,
        rMultiple: t.rMultiple,
        confidence: t.confidence,
        holdMs: t.holdMs ?? 0,
        mfe: t.mfe,
        mae: t.mae,
        regimeTags: t.regimeTags,
        setupClass: t.setupClass,
        primaryTimeframe: t.primaryTimeframe,
      };
    });

  const performance = computePerformance(
    opts?.setupClass ? samples : allSamples,
    opts?.setupClass ? open.length : allOpen.length,
  );
  const breakRetestSamples = allSamples.filter((s) => s.setupClass === "RANGE_BREAK_RETEST");
  const breakRetestOpen = allOpen.filter((t) => t.setupClass === "RANGE_BREAK_RETEST").length;
  const breakRetestPerformance = computePerformance(breakRetestSamples, breakRetestOpen);

  const byPrimaryTimeframe = groupByKey(allSamples, (s) => s.primaryTimeframe ?? "unknown");
  const byLiquidity = groupByKey(allSamples, (s) =>
    s.regimeTags.filter((t) => t === "liq_high" || t === "liq_mid" || t === "liq_low"),
  );
  const byRangeContext = groupByKey(allSamples, (s) =>
    s.regimeTags.filter((t) => t === "post_pump_compression" || t === "clean_range"),
  );
  const bySetupClass = groupByKey(allSamples, (s) => s.setupClass ?? "OTHER");

  const calibration = computeCalibration(opts?.setupClass ? samples : allSamples);
  const byRegime = groupByRegime(allSamples);
  const sym = symbol ?? config.symbols[0] ?? "BTCUSDT";

  const avgFees =
    breakRetestSamples.filter((s) => s.isResolvedWinLoss).length > 0
      ? breakRetestSamples
          .filter((s) => s.isResolvedWinLoss)
          .reduce((a, s) => a + s.fees, 0) /
        breakRetestSamples.filter((s) => s.isResolvedWinLoss).length
      : null;

  return {
    symbol: sym,
    exchange: config.exchange,
    marketType: "futures_perp",
    phaseFNote: PHASE_F_NOTE,
    performance: sanitizePerf(performance),
    breakRetestPerformance: {
      ...sanitizePerf(breakRetestPerformance),
      averageFees: avgFees,
    },
    bySetupClass: sanitizeMap(bySetupClass),
    byPrimaryTimeframe: sanitizeMap(byPrimaryTimeframe),
    byLiquidity: sanitizeMap(byLiquidity),
    byRangeContext: sanitizeMap(byRangeContext),
    calibration,
    byRegime: sanitizeMap(byRegime),
    openTrades: opts?.setupClass ? open.length : allOpen.length,
    paperTrades: (opts?.setupClass ? trades : allTrades).slice(0, 50),
    parity: {
      liveGates: "minIndependent=2, minScore=2, full OF+MTF+zones when streaming",
      historicalDefault:
        "structureOnlyMode=true candle replay — NOT live parity. See limitation on /api/backtest.",
      tape: tapeCoverageNote(sym, config.exchange),
      sameBarPolicy: "sl_first (conservative) for OHLC validation helpers; live path uses tick lastPrice with SL before TP",
      partialTpPolicy:
        "100% close at TP1. TP2/TP3 informational until scale-out is explicitly enabled.",
      confidencePolicy:
        "Confidence remains a model score. Calibrated probabilities only after sufficient OOS resolved trades (see calibration.sufficient).",
    },
  };
}

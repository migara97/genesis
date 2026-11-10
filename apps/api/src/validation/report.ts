import {
  computeCalibration,
  computePerformance,
  groupByRegime,
  type ClosedTradeSample,
} from "@of/orderflow";
import { listPaperTrades } from "./paperLedger.js";
import { tapeCoverageNote } from "./tapeArchive.js";
import { config } from "../config.js";

export function buildValidationReport(symbol?: string) {
  const trades = listPaperTrades({ symbol, limit: 500 });
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
      };
    });

  const performance = computePerformance(samples, open.length);
  const calibration = computeCalibration(samples);
  const byRegime = groupByRegime(samples);
  const sym = symbol ?? config.symbols[0] ?? "BTCUSDT";

  return {
    symbol: sym,
    exchange: config.exchange,
    marketType: "futures_perp",
    performance: {
      ...performance,
      profitFactor:
        performance.profitFactor == null
          ? null
          : Number.isFinite(performance.profitFactor)
            ? performance.profitFactor
            : null,
      profitFactorUnbounded: performance.profitFactor === Number.POSITIVE_INFINITY,
    },
    calibration,
    byRegime: Object.fromEntries(
      Object.entries(byRegime).map(([k, v]) => [
        k,
        {
          ...v,
          profitFactor:
            v.profitFactor == null
              ? null
              : Number.isFinite(v.profitFactor)
                ? v.profitFactor
                : null,
        },
      ]),
    ),
    openTrades: open.length,
    paperTrades: trades.slice(0, 50),
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

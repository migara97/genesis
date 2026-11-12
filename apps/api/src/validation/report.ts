import {
  DEFAULT_CONFIG_VERSION,
  SIGNAL_ENGINE_VERSION,
  computeCalibration,
  computePerformance,
  evaluateAccuracyGates,
  groupByKey,
  groupByRegime,
  type ClosedTradeSample,
  type PerformanceReport,
} from "@of/orderflow";
import type { PaperSetupClass } from "@of/shared";
import { listPaperTrades } from "./paperLedger.js";
import { tapeCoverageNote } from "./tapeArchive.js";
import { config } from "../config.js";

const PHASE8_NOTE =
  "Phase 8 accuracy freeze — metrics default to the locked config fingerprint. Expectancy/win rate are not permission to raise live size until gates.overallClaimable.";

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

function toSample(t: ReturnType<typeof listPaperTrades>[number]): ClosedTradeSample {
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
    configVersion: t.configVersion,
  };
}

export function buildValidationReport(
  symbol?: string,
  opts?: { setupClass?: PaperSetupClass; allConfigs?: boolean },
) {
  const trades = listPaperTrades({
    symbol,
    limit: 10_000,
    setupClass: opts?.setupClass,
  });
  const allTrades = opts?.setupClass
    ? listPaperTrades({ symbol, limit: 10_000 })
    : trades;

  const activeConfig = DEFAULT_CONFIG_VERSION;
  const locked = config.validationLockConfig;
  // Primary metrics use the locked fingerprint only (unless allConfigs=true).
  const scopedTrades =
    opts?.allConfigs || !locked
      ? allTrades
      : allTrades.filter((t) => t.configVersion === activeConfig);
  const scopedFiltered = opts?.setupClass
    ? (opts?.allConfigs || !locked
        ? trades
        : trades.filter((t) => t.configVersion === activeConfig))
    : scopedTrades;

  const open = scopedFiltered.filter((t) => t.outcome === "OPEN");
  const samples = scopedFiltered.filter((t) => t.outcome !== "OPEN").map(toSample);

  const allOpen = scopedTrades.filter((t) => t.outcome === "OPEN");
  const allSamples = scopedTrades.filter((t) => t.outcome !== "OPEN").map(toSample);

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
  const byRegime = groupByRegime(allSamples);

  const calibration = computeCalibration(opts?.setupClass ? samples : allSamples);

  const performanceByConfigVersion: Record<string, ReturnType<typeof sanitizePerf>> = {};
  const byConfig = new Map<string, { samples: ClosedTradeSample[]; open: number }>();
  for (const t of allTrades) {
    const key = t.configVersion || "unknown";
    const bucket = byConfig.get(key) ?? { samples: [], open: 0 };
    if (t.outcome === "OPEN") bucket.open += 1;
    else bucket.samples.push(toSample(t));
    byConfig.set(key, bucket);
  }
  for (const [key, bucket] of byConfig) {
    performanceByConfigVersion[key] = sanitizePerf(
      computePerformance(bucket.samples, bucket.open),
    );
  }

  const gates = evaluateAccuracyGates({
    performance,
    calibration,
    byRegime,
    bySetupClass,
    activeConfigVersion: activeConfig,
    locked,
  });

  const sym = symbol ?? config.symbols[0] ?? "BTCUSDT";

  const avgFees =
    breakRetestSamples.filter((s) => s.isResolvedWinLoss).length > 0
      ? breakRetestSamples
          .filter((s) => s.isResolvedWinLoss)
          .reduce((a, s) => a + s.fees, 0) /
        breakRetestSamples.filter((s) => s.isResolvedWinLoss).length
      : null;

  const annotateClaimable = (
    map: Record<string, PerformanceReport>,
    claimable: Record<string, boolean>,
  ) =>
    Object.fromEntries(
      Object.entries(map).map(([k, v]) => [
        k,
        {
          ...sanitizePerf(v),
          claimable: claimable[k] === true,
        },
      ]),
    );

  return {
    symbol: sym,
    exchange: config.exchange,
    marketType: "futures_perp",
    phase8Note: PHASE8_NOTE,
    phaseFNote: PHASE8_NOTE,
    engineVersion: SIGNAL_ENGINE_VERSION,
    activeConfigVersion: activeConfig,
    gates,
    performance: {
      ...sanitizePerf(performance),
      claimable: gates.overallClaimable,
    },
    breakRetestPerformance: {
      ...sanitizePerf(breakRetestPerformance),
      averageFees: avgFees,
      claimable: gates.bySetupClassClaimable.RANGE_BREAK_RETEST === true,
    },
    bySetupClass: annotateClaimable(bySetupClass, gates.bySetupClassClaimable),
    byRegime: annotateClaimable(byRegime, gates.byRegimeClaimable),
    byPrimaryTimeframe: sanitizeMap(byPrimaryTimeframe),
    byLiquidity: sanitizeMap(byLiquidity),
    byRangeContext: sanitizeMap(byRangeContext),
    performanceByConfigVersion,
    calibration,
    openTrades: opts?.setupClass ? open.length : allOpen.length,
    paperTrades: scopedFiltered.slice(0, 50),
    sampleScope: locked && !opts?.allConfigs ? "active_config_only" : "all_configs",
    parity: {
      liveGates: "minIndependent=2, minScore=2, full OF+MTF+zones when streaming",
      historicalDefault:
        "structureOnlyMode=true candle replay — NOT live parity. See limitation on /api/backtest.",
      tape: tapeCoverageNote(sym, config.exchange),
      sameBarPolicy:
        "sl_first (conservative) for OHLC validation helpers; live path uses tick lastPrice with SL before TP",
      partialTpPolicy:
        "Tick lifecycle scale-out default 50/30/20 at TP1/TP2/TP3; HIT_TP when remainder 0. fullCloseAtTp1 restores legacy. Bar pathExit remains TP1-only.",
      confidencePolicy:
        "Confidence remains a model score. Calibrated probabilities only after sufficient OOS resolved trades (see calibration.sufficient / gates).",
      configLock: locked
        ? `VALIDATION_LOCK_CONFIG — primary metrics filtered to ${activeConfig}`
        : "Config lock off — primary metrics mix all fingerprints",
      phase9:
        "GET /api/validation/parity?run=1 runs tape OF replay (footprint/CVD/VP + structure/MTF/zones). DOM absent. /api/backtest remains structure/MTF proxy.",
      phase11:
        "Iceberg/refill + leader/lagger are heuristics with confidence bands. Strategy plugins are weight-0. Commentary never mutates scores. See GET /api/microstructure.",
      phase12:
        "Scale-out paper ledger + sizing profiles + favorites alerts + LIVE audit. See docs/PHASE12_PRODUCT.md.",
    },
    phase11Note:
      "Phase 11 microstructure — heuristic only; does not unlock weight changes or claim institutional detection.",
  };
}

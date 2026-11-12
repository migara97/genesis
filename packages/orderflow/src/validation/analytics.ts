import type { MarketRegimeTag, PaperOutcome, PaperSetupClass } from "@of/shared";
import { PHASE8_GATES } from "./versions.js";

export interface ClosedTradeSample {
  setupId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  outcome: PaperOutcome;
  /** True only for HIT_TP / HIT_SL (realized directional close). */
  isResolvedWinLoss: boolean;
  won: boolean | null;
  netPnl: number;
  grossPnl: number;
  fees: number;
  funding: number;
  rMultiple: number | null;
  confidence: number;
  holdMs: number;
  mfe: number | null;
  mae: number | null;
  regimeTags: MarketRegimeTag[];
  setupClass?: PaperSetupClass;
  primaryTimeframe?: string;
  configVersion?: string;
}

export interface AccuracyGates {
  overallClaimable: boolean;
  calibrationSufficient: boolean;
  byRegimeClaimable: Record<string, boolean>;
  bySetupClassClaimable: Record<string, boolean>;
  activeConfigVersion: string;
  locked: boolean;
  resolvedCount: number;
  overallMinResolved: number;
  stratumMinResolved: number;
  notes: string[];
}

/** Phase 8 publishing gates — do not claim expectancy/edge until overallClaimable. */
export function evaluateAccuracyGates(args: {
  performance: PerformanceReport;
  calibration: CalibrationReport;
  byRegime: Record<string, PerformanceReport>;
  bySetupClass: Record<string, PerformanceReport>;
  activeConfigVersion: string;
  locked: boolean;
  overallMin?: number;
  stratumMin?: number;
}): AccuracyGates {
  const overallMin = args.overallMin ?? PHASE8_GATES.overallMinResolved;
  const stratumMin = args.stratumMin ?? PHASE8_GATES.stratumMinResolved;
  const resolvedCount = args.performance.closedTrades;
  const overallClaimable = resolvedCount >= overallMin;
  const byRegimeClaimable: Record<string, boolean> = {};
  for (const [key, perf] of Object.entries(args.byRegime)) {
    byRegimeClaimable[key] = perf.closedTrades >= stratumMin;
  }
  const bySetupClassClaimable: Record<string, boolean> = {};
  for (const [key, perf] of Object.entries(args.bySetupClass)) {
    bySetupClassClaimable[key] = perf.closedTrades >= stratumMin;
  }
  const notes: string[] = [];
  if (args.locked) {
    notes.push(`Config locked to fingerprint ${args.activeConfigVersion}.`);
  }
  if (!overallClaimable) {
    notes.push(
      `Overall not claimable (${resolvedCount}/${overallMin} resolved TP/SL). Accuracy undefined.`,
    );
  } else {
    notes.push(`Overall claimable at n=${resolvedCount} (floor ${overallMin}).`);
  }
  if (!args.calibration.sufficient) {
    notes.push("Calibration insufficient — do not treat confidence as win probability.");
  }
  const claimableRegimes = Object.entries(byRegimeClaimable).filter(([, v]) => v).map(([k]) => k);
  if (claimableRegimes.length === 0) {
    notes.push(`No regime stratum claimable yet (need ≥${stratumMin} resolved each).`);
  } else {
    notes.push(`Claimable regimes: ${claimableRegimes.join(", ")}.`);
  }
  return {
    overallClaimable,
    calibrationSufficient: args.calibration.sufficient,
    byRegimeClaimable,
    bySetupClassClaimable,
    activeConfigVersion: args.activeConfigVersion,
    locked: args.locked,
    resolvedCount,
    overallMinResolved: overallMin,
    stratumMinResolved: stratumMin,
    notes,
  };
}

export interface PerformanceReport {
  totalSetups: number;
  openOrUnresolved: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number | null;
  winRateCi95: { low: number; high: number } | null;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  profitFactor: number | null;
  averageR: number | null;
  expectancy: number | null;
  maxDrawdown: number;
  averageHoldMs: number | null;
  averageMfe: number | null;
  averageMae: number | null;
  falsePositiveRate: number | null;
  sampleNote: string;
}

export interface CalibrationBucket {
  label: string;
  minConf: number;
  maxConf: number;
  count: number;
  empiricalWinRate: number | null;
  avgConfidence: number | null;
  gap: number | null;
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  brierScore: number | null;
  logLoss: number | null;
  sampleNote: string;
  sufficient: boolean;
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

export function computePerformance(
  samples: ClosedTradeSample[],
  unresolvedCount = 0,
): PerformanceReport {
  const closed = samples.filter((s) => s.isResolvedWinLoss);
  const wins = closed.filter((s) => s.won === true);
  const losses = closed.filter((s) => s.won === false);
  const grossProfit = wins.reduce((a, s) => a + Math.max(0, s.netPnl), 0);
  const grossLossAbs = Math.abs(losses.reduce((a, s) => a + Math.min(0, s.netPnl), 0));
  const netProfit = closed.reduce((a, s) => a + s.netPnl, 0);
  const rVals = closed.map((s) => s.rMultiple).filter((n): n is number => n != null);
  const holds = closed.map((s) => s.holdMs).filter((n) => n >= 0);
  const mfes = closed.map((s) => s.mfe).filter((n): n is number => n != null);
  const maes = closed.map((s) => s.mae).filter((n): n is number => n != null);

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const s of closed) {
    equity += s.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  // False positive: directional confirm that ended INVALIDATED/TIMEOUT/EXPIRED without TP
  const fps = samples.filter(
    (s) =>
      s.outcome === "INVALIDATED" || s.outcome === "TIMEOUT" || s.outcome === "EXPIRED",
  ).length;
  const confirmedLike = closed.length + fps;

  return {
    totalSetups: samples.length + unresolvedCount,
    openOrUnresolved: unresolvedCount,
    closedTrades: closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    winRateCi95: closed.length ? wilsonInterval(wins.length, closed.length) : null,
    grossProfit,
    grossLoss: grossLossAbs,
    netProfit,
    profitFactor:
      closed.length === 0
        ? null
        : grossLossAbs === 0
          ? grossProfit > 0
            ? Number.POSITIVE_INFINITY
            : 0
          : grossProfit / grossLossAbs,
    averageR: rVals.length ? rVals.reduce((a, b) => a + b, 0) / rVals.length : null,
    expectancy: closed.length ? netProfit / closed.length : null,
    maxDrawdown,
    averageHoldMs: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    averageMfe: mfes.length ? mfes.reduce((a, b) => a + b, 0) / mfes.length : null,
    averageMae: maes.length ? maes.reduce((a, b) => a + b, 0) / maes.length : null,
    falsePositiveRate: confirmedLike ? fps / confirmedLike : null,
    sampleNote:
      closed.length === 0
        ? "No HIT_TP/HIT_SL resolved trades — win rate undefined (not zero edge)."
        : `Win rate and expectancy from ${closed.length} resolved TP/SL trades only. Open/invalidated/timeout excluded from win rate.`,
  };
}

export function computeCalibration(
  samples: ClosedTradeSample[],
  minPerBucket = 20,
): CalibrationReport {
  const resolved = samples.filter((s) => s.isResolvedWinLoss && s.won != null);
  const edges = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0001];
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const minConf = edges[i]!;
    const maxConf = edges[i + 1]!;
    const inBucket = resolved.filter((s) => s.confidence >= minConf && s.confidence < maxConf);
    const wins = inBucket.filter((s) => s.won).length;
    const emp = inBucket.length ? wins / inBucket.length : null;
    const avg =
      inBucket.length > 0
        ? inBucket.reduce((a, s) => a + s.confidence, 0) / inBucket.length
        : null;
    buckets.push({
      label: `${minConf.toFixed(2)}–${Math.min(1, maxConf).toFixed(2)}`,
      minConf,
      maxConf: Math.min(1, maxConf),
      count: inBucket.length,
      empiricalWinRate: emp,
      avgConfidence: avg,
      gap: emp != null && avg != null ? emp - avg : null,
    });
  }

  let brier: number | null = null;
  let logLoss: number | null = null;
  if (resolved.length > 0) {
    let brierSum = 0;
    let llSum = 0;
    for (const s of resolved) {
      const y = s.won ? 1 : 0;
      const p = clamp01(s.confidence);
      brierSum += (p - y) ** 2;
      const eps = 1e-6;
      llSum += -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
    }
    brier = brierSum / resolved.length;
    logLoss = llSum / resolved.length;
  }

  const sufficient = resolved.length >= minPerBucket * 2;
  return {
    buckets,
    brierScore: brier,
    logLoss,
    sufficient,
    sampleNote: sufficient
      ? `Calibration from ${resolved.length} resolved trades. Confidence is still a model score until gap≈0 across buckets.`
      : `Insufficient resolved trades for calibrated probabilities (have ${resolved.length}; want ≥${minPerBucket * 2}). Do not treat confidence as win probability.`,
  };
}

export function groupByRegime(
  samples: ClosedTradeSample[],
): Record<string, PerformanceReport> {
  return groupByKey(samples, (s) => s.regimeTags);
}

/**
 * Group samples by a string key or by each tag in an array of keys.
 */
export function groupByKey(
  samples: ClosedTradeSample[],
  keyFn: (s: ClosedTradeSample) => string | string[] | undefined | null,
): Record<string, PerformanceReport> {
  const buckets = new Map<string, ClosedTradeSample[]>();
  for (const s of samples) {
    const raw = keyFn(s);
    const keys = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    for (const key of keys) {
      if (!key) continue;
      const list = buckets.get(key) ?? [];
      list.push(s);
      buckets.set(key, list);
    }
  }
  const out: Record<string, PerformanceReport> = {};
  for (const key of [...buckets.keys()].sort()) {
    out[key] = computePerformance(buckets.get(key)!, 0);
  }
  return out;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

import type {
  Candle,
  ChartOverlayState,
  ChartZoneBand,
  ScannerHit,
  ScannerRegime,
  ScannerSnapshot,
} from "@of/shared";
import { buildChartOverlay } from "./chartZones.js";
import { analyzeMarketStructure } from "./structure.js";
import { detectStructureZones } from "./priceZones.js";

export interface AltScannerConfig {
  coilBars: number;
  impulseBars: number;
  rvolLookback: number;
  nearBandPct: number;
  minCandles: number;
  maxHits: number;
}

export const DEFAULT_ALT_SCANNER_CONFIG: AltScannerConfig = {
  coilBars: 12,
  impulseBars: 36,
  rvolLookback: 20,
  nearBandPct: 0.004,
  minCandles: 48,
  maxHits: 25,
};

export interface AltScannerInput {
  symbol: string;
  lastPrice: number;
  changePct24h?: number | null;
  quoteVolume24h?: number | null;
  candles5m: Candle[];
  candles15m?: Candle[];
  tickSize?: number;
  now?: number;
}

const RANK_NOTE =
  "rankScore is a REST compression/RVOL heuristic (0–1), not a win rate or executable signal.";

const EVIDENCE = {
  kind: "inferred" as const,
  note: "Alt scanner uses 5m OHLCV + Phase A bands only — no multi-symbol order-flow. Attach OF before treating as executable.",
};

/**
 * Score a single alt for compression near a zone + rising relative volume.
 * Pure function; no exchange I/O.
 */
export function scoreAltSetup(
  input: AltScannerInput,
  config: AltScannerConfig = DEFAULT_ALT_SCANNER_CONFIG,
): ScannerHit | null {
  const symbol = input.symbol.toUpperCase();
  const candles = input.candles5m;
  if (candles.length < config.minCandles || !(input.lastPrice > 0)) return null;

  const now = input.now ?? Date.now();
  const tick = input.tickSize && input.tickSize > 0 ? input.tickSize : guessTick(input.lastPrice);
  const structure = analyzeMarketStructure(symbol, candles, 3);
  const zones = detectStructureZones(symbol, candles);
  const overlay = buildChartOverlay({
    symbol,
    lastPrice: input.lastPrice,
    tickSize: tick,
    trades: [],
    candles,
    structure,
    zones,
    updatedAt: now,
  });

  const compression = computeCompression(candles, config);
  const rvol = computeRvol(candles, config.rvolLookback);
  const nearBand = findNearBand(overlay.bands ?? [], input.lastPrice, config.nearBandPct);
  const regime = detectRegime(candles, input.candles15m, input.changePct24h, config);
  const bias = resolveBias(structure.trend, nearBand, input.changePct24h);

  const rankScore = clamp01(
    0.35 * compression +
      0.35 * clamp01((rvol - 0.8) / 2.2) +
      (nearBand ? 0.2 : 0) +
      (regime !== "none" ? 0.1 : 0),
  );

  if (rankScore < 0.25 && !nearBand) return null;

  const parts: string[] = [];
  parts.push(`compression ${(compression * 100).toFixed(0)}%`);
  parts.push(`rvol ${rvol.toFixed(2)}`);
  if (nearBand) parts.push(`near ${nearBand.kind}`);
  if (regime !== "none") parts.push(regime.replace(/_/g, " "));

  return {
    symbol,
    rankScore,
    rankNote: RANK_NOTE,
    rvol,
    compression,
    nearBand: nearBand
      ? { kind: nearBand.kind, low: nearBand.low, high: nearBand.high, source: nearBand.source }
      : undefined,
    regime,
    bias,
    reason: parts.join(" · "),
    updatedAt: now,
  };
}

export function buildScannerSnapshot(
  hits: ScannerHit[],
  universeSize: number,
  now = Date.now(),
  config: AltScannerConfig = DEFAULT_ALT_SCANNER_CONFIG,
): ScannerSnapshot {
  const ranked = [...hits]
    .sort((a, b) => b.rankScore - a.rankScore || a.symbol.localeCompare(b.symbol))
    .slice(0, config.maxHits);
  return {
    hits: ranked,
    universeSize,
    updatedAt: now,
    evidence: [EVIDENCE],
  };
}

export function computeCompression(
  candles: Candle[],
  config: Pick<AltScannerConfig, "coilBars" | "impulseBars">,
): number {
  const coil = rangeOf(candles.slice(-config.coilBars));
  const impulseWindow = candles.slice(
    Math.max(0, candles.length - config.coilBars - config.impulseBars),
    Math.max(0, candles.length - config.coilBars),
  );
  const impulse = rangeOf(impulseWindow.length ? impulseWindow : candles.slice(-config.impulseBars));
  if (!(impulse > 0) || !(coil >= 0)) return 0;
  // Higher when recent range is tight vs prior impulse.
  const ratio = coil / impulse;
  return clamp01(1 - ratio);
}

export function computeRvol(candles: Candle[], lookback: number): number {
  if (candles.length < 2) return 0;
  const last = candles[candles.length - 1]!;
  const prior = candles.slice(Math.max(0, candles.length - 1 - lookback), -1);
  if (!prior.length) return 0;
  const vols = prior.map((c) => c.volume).sort((a, b) => a - b);
  const mid = vols[Math.floor(vols.length / 2)] ?? 0;
  if (!(mid > 0)) return last.volume > 0 ? 3 : 0;
  return last.volume / mid;
}

export function detectRegime(
  candles5m: Candle[],
  candles15m: Candle[] | undefined,
  changePct24h: number | null | undefined,
  config: Pick<AltScannerConfig, "coilBars" | "impulseBars">,
): ScannerRegime {
  const compression = computeCompression(candles5m, config);
  const series = candles15m && candles15m.length >= 20 ? candles15m : candles5m;
  if (series.length < 12) return "none";

  const coilBars = Math.min(config.coilBars, series.length);
  const impulseBars = Math.min(config.impulseBars, Math.max(0, series.length - coilBars));
  const coil = series.slice(-coilBars);
  const impulse =
    impulseBars > 0
      ? series.slice(series.length - coilBars - impulseBars, series.length - coilBars)
      : series.slice(0, Math.max(1, series.length - coilBars));
  const last = series[series.length - 1]!;

  const impulseFirst = impulse[0] ?? coil[0]!;
  const impulseHi = Math.max(...impulse.map((c) => c.high), impulseFirst.high);
  const impulseLo = Math.min(...impulse.map((c) => c.low), impulseFirst.low);
  const mid = (impulseHi + impulseLo) / 2 || last.close;
  const upMove = (impulseHi - impulseFirst.close) / mid;
  const downMove = (impulseFirst.close - impulseLo) / mid;

  const recent = series.slice(-24);
  const hi = Math.max(...recent.map((c) => c.high));
  const lo = Math.min(...recent.map((c) => c.low));
  const recentMid = (hi + lo) / 2 || last.close;
  const reclaim = last.close > recentMid && last.close > recent[0]!.close;
  const salvage =
    last.close > lo * 1.01 && last.close < recent[0]!.close && downMove > 0.04;

  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const earlySpan = Math.max(...highs.slice(0, 6)) - Math.min(...lows.slice(0, 6)) || 1;
  const lateSpan = Math.max(...highs.slice(-6)) - Math.min(...lows.slice(-6));
  const narrowing = lateSpan < 0.7 * earlySpan;

  // Pump = strong impulse into a tight coil (24h change optional boost).
  if (compression > 0.45 && upMove > 0.08 && (changePct24h == null || changePct24h > 5)) {
    return "post_pump_compression";
  }
  if (salvage && compression > 0.3) return "salvage_after_flush";
  if (narrowing && reclaim && compression > 0.35) return "wedge_reclaim";
  return "none";
}

function findNearBand(
  bands: ChartZoneBand[],
  price: number,
  nearBandPct: number,
): ChartZoneBand | undefined {
  let best: ChartZoneBand | undefined;
  let bestDist = Infinity;
  for (const band of bands) {
    const mid = (band.low + band.high) / 2;
    const half = Math.max((band.high - band.low) / 2, price * nearBandPct);
    const dist = Math.abs(price - mid) / (price || 1);
    const near = price >= band.low - half * 0.15 && price <= band.high + half * 0.15;
    if (!near) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = band;
    }
  }
  return best;
}

function resolveBias(
  trend: "bullish" | "bearish" | "range",
  nearBand: ChartZoneBand | undefined,
  changePct24h: number | null | undefined,
): ScannerHit["bias"] {
  if (nearBand?.kind === "demand") return "bullish";
  if (nearBand?.kind === "supply") return "bearish";
  if (trend === "bullish" || trend === "bearish") return trend;
  if ((changePct24h ?? 0) > 3) return "bullish";
  if ((changePct24h ?? 0) < -3) return "bearish";
  return "none";
}

function rangeOf(candles: Candle[]): number {
  if (!candles.length) return 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of candles) {
    hi = Math.max(hi, c.high);
    lo = Math.min(lo, c.low);
  }
  return hi - lo;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function guessTick(price: number): number {
  if (price >= 1000) return 0.1;
  if (price >= 100) return 0.01;
  if (price >= 1) return 0.0001;
  return 0.000001;
}

/** @internal test helper — expose overlay builder path */
export function overlayForScan(input: AltScannerInput): ChartOverlayState {
  const symbol = input.symbol.toUpperCase();
  const tick = input.tickSize && input.tickSize > 0 ? input.tickSize : guessTick(input.lastPrice);
  const structure = analyzeMarketStructure(symbol, input.candles5m, 3);
  const zones = detectStructureZones(symbol, input.candles5m);
  return buildChartOverlay({
    symbol,
    lastPrice: input.lastPrice,
    tickSize: tick,
    trades: [],
    candles: input.candles5m,
    structure,
    zones,
  });
}

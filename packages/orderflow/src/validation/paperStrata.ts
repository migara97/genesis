import type {
  AxiaQualityShadowSnapshot,
  Candle,
  MarketRegimeTag,
  MarketStructureState,
  PaperSetupClass,
} from "@of/shared";
import { axiaQualityRegimeHints } from "../axiaQualityShadow.js";
import { detectRegime } from "../altScanner.js";
import { tagMarketRegimes } from "./regime.js";

const AXIA_REGIME_TAGS = new Set<MarketRegimeTag>([
  "break_q_high",
  "break_q_low",
  "delta_eff_high",
  "delta_eff_low",
  "break_hang",
  "hl_exhaustion",
  "hl_absorption",
  "hl_v_reversal",
]);

/** Quote-volume thresholds (USD notional approx) for liquidity strata. */
export const LIQ_HIGH_USD = 50_000_000;
export const LIQ_MID_USD = 5_000_000;

export function deriveSetupClass(confirmations?: string[] | null): PaperSetupClass {
  const ids = confirmations ?? [];
  if (ids.some((c) => c === "break_retest_bullish" || c === "break_retest_bearish")) {
    return "RANGE_BREAK_RETEST";
  }
  return "OTHER";
}

export function tagLiquidityBucket(quoteVolume24h?: number | null): MarketRegimeTag | null {
  if (quoteVolume24h == null || !Number.isFinite(quoteVolume24h) || quoteVolume24h < 0) {
    return null;
  }
  if (quoteVolume24h >= LIQ_HIGH_USD) return "liq_high";
  if (quoteVolume24h >= LIQ_MID_USD) return "liq_mid";
  return "liq_low";
}

export function tagRangeContext(
  candles?: Candle[] | null,
  changePct24h?: number | null,
): MarketRegimeTag | null {
  if (!candles || candles.length < 48) return null;
  const regime = detectRegime(candles, undefined, changePct24h, {
    coilBars: 12,
    impulseBars: 36,
  });
  if (regime === "post_pump_compression") return "post_pump_compression";
  // Clean range: sideways coil without pump/salvage/wedge labels.
  if (regime === "none") {
    const compression = coilTight(candles);
    if (compression > 0.4) return "clean_range";
  }
  return null;
}

/**
 * Full paper-open regime tag set: structure/vol + liquidity + range context
 * + optional Axia-quality observational strata.
 */
export function tagPaperRegimes(args: {
  structure?: Pick<MarketStructureState, "trend"> | null;
  candles?: Candle[];
  quoteVolume24h?: number | null;
  changePct24h?: number | null;
  lookback?: number;
  axiaQuality?: AxiaQualityShadowSnapshot | null;
}): MarketRegimeTag[] {
  const tags = tagMarketRegimes({
    structure: args.structure,
    candles: args.candles,
    lookback: args.lookback,
  });
  const liq = tagLiquidityBucket(args.quoteVolume24h);
  if (liq) tags.push(liq);
  const range = tagRangeContext(args.candles, args.changePct24h);
  if (range) tags.push(range);
  if (args.axiaQuality) {
    for (const hint of axiaQualityRegimeHints(args.axiaQuality)) {
      if (AXIA_REGIME_TAGS.has(hint as MarketRegimeTag)) {
        tags.push(hint as MarketRegimeTag);
      }
    }
  }
  return [...new Set(tags)];
}

export function rangeContextFromTags(
  tags: MarketRegimeTag[],
): "post_pump_compression" | "clean_range" | "none" {
  if (tags.includes("post_pump_compression")) return "post_pump_compression";
  if (tags.includes("clean_range")) return "clean_range";
  return "none";
}

function coilTight(candles: Candle[]): number {
  const coilBars = 12;
  const impulseBars = 36;
  const coil = rangeOf(candles.slice(-coilBars));
  const impulseWindow = candles.slice(
    Math.max(0, candles.length - coilBars - impulseBars),
    Math.max(0, candles.length - coilBars),
  );
  const impulse = rangeOf(impulseWindow.length ? impulseWindow : candles.slice(-impulseBars));
  if (!(impulse > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - coil / impulse));
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

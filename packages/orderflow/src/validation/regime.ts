import type { Candle, MarketRegimeTag, MarketStructureState } from "@of/shared";

/**
 * Tag regimes from structure + recent candle stats. Heuristic labels for
 * stratified reporting — not predictive features inside generateSignal.
 */
export function tagMarketRegimes(args: {
  structure?: Pick<MarketStructureState, "trend"> | null;
  candles?: Candle[];
  lookback?: number;
}): MarketRegimeTag[] {
  const tags: MarketRegimeTag[] = [];
  const trend = args.structure?.trend;
  if (trend === "bullish") tags.push("bullish_trend");
  else if (trend === "bearish") tags.push("bearish_trend");
  else if (trend === "range") tags.push("sideways");

  const candles = args.candles ?? [];
  const lb = Math.min(args.lookback ?? 48, candles.length);
  if (lb >= 10) {
    const window = candles.slice(-lb);
    const rets: number[] = [];
    const vols: number[] = [];
    for (const c of window) {
      if (c.open > 0) rets.push((c.close - c.open) / c.open);
      vols.push(c.volume);
    }
    const absMean = rets.reduce((a, b) => a + Math.abs(b), 0) / rets.length;
    const volMean = vols.reduce((a, b) => a + b, 0) / vols.length;
    const volSorted = [...vols].sort((a, b) => a - b);
    const volMed = volSorted[Math.floor(volSorted.length / 2)] ?? volMean;

    if (absMean >= 0.004) tags.push("high_volatility");
    else tags.push("low_volatility");
    if (volMean >= volMed * 1.25) tags.push("high_volume");
    else tags.push("low_volume");
  }

  if (tags.length === 0) tags.push("unknown");
  return [...new Set(tags)];
}

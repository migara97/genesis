import type {
  Candle,
  MarketStructureState,
  MultiTimeframeContext,
  SwingPoint,
  TimeframeStructureSummary,
} from "@of/shared";

/** Higher timeframes used for Phase-4 confirmation (excludes primary 15m and 5m). */
export const HIGHER_TIMEFRAMES = ["1d", "4h", "1h"] as const;
/** Full MTF set: HTF + primary + soft LTF confirm. */
export const MTF_INTERVALS = ["1d", "4h", "1h", "15m", "5m"] as const;
export const PRIMARY_INTERVAL = "15m";

export function analyzeMarketStructure(
  symbol: string,
  candles: Candle[],
  lookback = 3,
  previousSessionHigh?: number,
  previousSessionLow?: number,
): MarketStructureState {
  const swings = findSwings(candles, lookback);
  const classified = classifySwings(swings);
  const { lastBos, lastChoch, trend } = detectBosChoch(classified);
  const highs = classified.filter((s) => s.kind === "high").map((s) => s.price);
  const lows = classified.filter((s) => s.kind === "low").map((s) => s.price);

  const resistance = uniqueSorted(highs).slice(-5);
  const support = uniqueSorted(lows).slice(-5);

  const liquidityPools: MarketStructureState["liquidityPools"] = [];
  for (const p of resistance.slice(-2)) {
    liquidityPools.push({ side: "BSL", price: p, label: "swing high liquidity" });
  }
  for (const p of support.slice(-2)) {
    liquidityPools.push({ side: "SSL", price: p, label: "swing low liquidity" });
  }
  if (previousSessionHigh != null) {
    liquidityPools.push({ side: "BSL", price: previousSessionHigh, label: "previous session high" });
  }
  if (previousSessionLow != null) {
    liquidityPools.push({ side: "SSL", price: previousSessionLow, label: "previous session low" });
  }

  return {
    symbol,
    trend,
    swings: classified,
    lastBos,
    lastChoch,
    support,
    resistance,
    liquidityPools,
    previousSessionHigh,
    previousSessionLow,
    evidence: [
      {
        kind: "inferred",
        note: "BOS/CHoCH and liquidity pools are price-structure inferences, not order-flow proof of smart money.",
      },
    ],
  };
}

function findSwings(candles: Candle[], lb: number): { price: number; timestamp: number; kind: "high" | "low" }[] {
  const out: { price: number; timestamp: number; kind: "high" | "low" }[] = [];
  for (let i = lb; i < candles.length - lb; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lb; j++) {
      if (candles[i - j]!.high >= c.high || candles[i + j]!.high >= c.high) isHigh = false;
      if (candles[i - j]!.low <= c.low || candles[i + j]!.low <= c.low) isLow = false;
    }
    if (isHigh) out.push({ price: c.high, timestamp: c.closeTime, kind: "high" });
    if (isLow) out.push({ price: c.low, timestamp: c.closeTime, kind: "low" });
  }
  return out;
}

function classifySwings(
  swings: { price: number; timestamp: number; kind: "high" | "low" }[],
): SwingPoint[] {
  const out: SwingPoint[] = [];
  let lastHigh: number | undefined;
  let lastLow: number | undefined;
  for (const s of swings) {
    if (s.kind === "high") {
      const type = lastHigh == null ? "HH" : s.price > lastHigh ? "HH" : "LH";
      out.push({ ...s, type });
      lastHigh = s.price;
    } else {
      const type = lastLow == null ? "HL" : s.price > lastLow ? "HL" : "LL";
      out.push({ ...s, type });
      lastLow = s.price;
    }
  }
  return out;
}

function detectBosChoch(swings: SwingPoint[]): Pick<
  MarketStructureState,
  "lastBos" | "lastChoch" | "trend"
> {
  let trend: MarketStructureState["trend"] = "range";
  let lastBos: MarketStructureState["lastBos"];
  let lastChoch: MarketStructureState["lastChoch"];

  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  if (highs.length >= 2 && lows.length >= 2) {
    const h1 = highs[highs.length - 2]!;
    const h2 = highs[highs.length - 1]!;
    const l1 = lows[lows.length - 2]!;
    const l2 = lows[lows.length - 1]!;
    if (h2.price > h1.price && l2.price > l1.price) {
      trend = "bullish";
      lastBos = { direction: "bullish", price: h2.price, timestamp: h2.timestamp };
    } else if (h2.price < h1.price && l2.price < l1.price) {
      trend = "bearish";
      lastBos = { direction: "bearish", price: l2.price, timestamp: l2.timestamp };
    }
  }

  // CHoCH: break against prior trend using last opposite swing
  if (trend === "bullish" && lows.length >= 1) {
    const lastLow = lows[lows.length - 1]!;
    const prevLow = lows[lows.length - 2];
    if (prevLow && lastLow.price < prevLow.price) {
      lastChoch = { direction: "bearish", price: lastLow.price, timestamp: lastLow.timestamp };
      trend = "range";
    }
  } else if (trend === "bearish" && highs.length >= 1) {
    const lastHigh = highs[highs.length - 1]!;
    const prevHigh = highs[highs.length - 2];
    if (prevHigh && lastHigh.price > prevHigh.price) {
      lastChoch = { direction: "bullish", price: lastHigh.price, timestamp: lastHigh.timestamp };
      trend = "range";
    }
  }

  return { lastBos, lastChoch, trend };
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((v) => Number(v.toPrecision(10))))].sort((a, b) => a - b);
}

export function summarizeTimeframeStructure(
  interval: string,
  structure: Pick<MarketStructureState, "trend" | "lastBos" | "lastChoch">,
): TimeframeStructureSummary {
  return {
    interval,
    trend: structure.trend,
    lastBos: structure.lastBos,
    lastChoch: structure.lastChoch,
  };
}

/**
 * Build multi-timeframe alignment context from per-interval structure summaries.
 * Conflict = primary is directional and a majority of non-range HTFs oppose it.
 */
export function buildMultiTimeframeContext(
  frames: TimeframeStructureSummary[],
  primaryInterval = PRIMARY_INTERVAL,
  updatedAt = Date.now(),
): MultiTimeframeContext {
  const primary = frames.find((f) => f.interval === primaryInterval);
  const higher = frames.filter((f) => (HIGHER_TIMEFRAMES as readonly string[]).includes(f.interval));
  let higherTfBullish = 0;
  let higherTfBearish = 0;
  let higherTfRange = 0;
  for (const frame of higher) {
    if (frame.trend === "bullish") higherTfBullish += 1;
    else if (frame.trend === "bearish") higherTfBearish += 1;
    else higherTfRange += 1;
  }

  const directionalHtf = higherTfBullish + higherTfBearish;
  let conflictWithPrimary = false;
  if (primary?.trend === "bullish" && directionalHtf > 0 && higherTfBearish > higherTfBullish) {
    conflictWithPrimary = true;
  } else if (primary?.trend === "bearish" && directionalHtf > 0 && higherTfBullish > higherTfBearish) {
    conflictWithPrimary = true;
  }

  return {
    primaryInterval,
    frames: [...frames].sort((a, b) => intervalRank(a.interval) - intervalRank(b.interval)),
    higherTfBullish,
    higherTfBearish,
    higherTfRange,
    conflictWithPrimary,
    updatedAt,
  };
}

function intervalRank(interval: string): number {
  const order = ["1d", "4h", "1h", "15m", "5m", "1m"];
  const idx = order.indexOf(interval);
  return idx >= 0 ? idx : 99;
}

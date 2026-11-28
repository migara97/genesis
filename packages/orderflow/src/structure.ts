import type {
  Candle,
  MarketStructureState,
  MultiTimeframeContext,
  SwingPoint,
  TimeframeStructureSummary,
} from "@of/shared";

/** Higher timeframes used for HTF confirmation (excludes primary and soft LTF). */
export const HIGHER_TIMEFRAMES = ["4h", "1h"] as const;
/** Full MTF set: HTF + mid + primary + soft LTF. (1d is not used for HTF voting.) */
export const MTF_INTERVALS = ["4h", "1h", "15m", "5m", "1m"] as const;
/** Desk default primary (alt 5m workflow). Selectable at runtime via hub. */
export const PRIMARY_INTERVAL = "5m";

export const ALLOWED_PRIMARY_INTERVALS = ["5m", "15m"] as const;
export type DeskPrimaryInterval = (typeof ALLOWED_PRIMARY_INTERVALS)[number];

/** Soft LTF one step below primary. */
export const SOFT_INTERVAL_FOR_PRIMARY: Record<DeskPrimaryInterval, string> = {
  "5m": "1m",
  "15m": "5m",
};

/** Mid-TF soft confirm when primary is 5m (15m bridge). */
export const MID_INTERVAL_FOR_PRIMARY: Partial<Record<DeskPrimaryInterval, string>> = {
  "5m": "15m",
};

export function resolvePrimaryInterval(value?: string | null): DeskPrimaryInterval {
  const v = (value ?? PRIMARY_INTERVAL).toLowerCase();
  if ((ALLOWED_PRIMARY_INTERVALS as readonly string[]).includes(v)) {
    return v as DeskPrimaryInterval;
  }
  return PRIMARY_INTERVAL;
}

export function softIntervalForPrimary(primary: string = PRIMARY_INTERVAL): string {
  const p = resolvePrimaryInterval(primary);
  return SOFT_INTERVAL_FOR_PRIMARY[p];
}

export function midIntervalForPrimary(primary: string = PRIMARY_INTERVAL): string | undefined {
  const p = resolvePrimaryInterval(primary);
  return MID_INTERVAL_FOR_PRIMARY[p];
}

export function mtfIntervalsFor(_primary: string = PRIMARY_INTERVAL): readonly string[] {
  return MTF_INTERVALS;
}

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
  const refPrice = candles.length > 0 ? candles[candles.length - 1]!.close : Number.NaN;

  // Price-relative: support below ref, resistance above ref (nearest first).
  const supportAll = uniqueSorted(lows.filter((p) => Number.isFinite(refPrice) && p < refPrice));
  const resistanceAll = uniqueSorted(highs.filter((p) => Number.isFinite(refPrice) && p > refPrice));
  const support = supportAll.slice(-5);
  const resistance = resistanceAll.slice(0, 5);

  const liquidityPools: MarketStructureState["liquidityPools"] = [];
  for (const p of resistance.slice(0, 2)) {
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

/**
 * Sequential BOS/CHoCH from classified swings.
 * Walks chronologically so a later LL after an established HH/HL bullish trend
 * can fire bearish CHoCH (the prior last-two-pair check made that unreachable).
 * After CHoCH, trend flips to the new direction (aligned CHoCH path).
 */
export function detectBosChoch(swings: SwingPoint[]): Pick<
  MarketStructureState,
  "lastBos" | "lastChoch" | "trend"
> {
  let trend: MarketStructureState["trend"] = "range";
  let lastBos: MarketStructureState["lastBos"];
  let lastChoch: MarketStructureState["lastChoch"];

  let prevHigh: SwingPoint | undefined;
  let lastHigh: SwingPoint | undefined;
  let prevLow: SwingPoint | undefined;
  let lastLow: SwingPoint | undefined;

  for (const s of swings) {
    if (s.kind === "high") {
      prevHigh = lastHigh;
      lastHigh = s;
      if (!prevHigh) continue;

      if (s.price > prevHigh.price) {
        // Higher high
        if (trend === "bearish") {
          lastChoch = { direction: "bullish", price: s.price, timestamp: s.timestamp };
          trend = "bullish";
        } else if (trend === "bullish") {
          lastBos = { direction: "bullish", price: s.price, timestamp: s.timestamp };
        } else if (lastLow && prevLow && lastLow.price > prevLow.price) {
          // HH + prior HL → establish bullish with BOS at the HH
          trend = "bullish";
          lastBos = { direction: "bullish", price: s.price, timestamp: s.timestamp };
        }
      }
      // LH while ranging stays range; LH in bullish without LL is pullback (no event)
    } else {
      prevLow = lastLow;
      lastLow = s;
      if (!prevLow) continue;

      if (s.price < prevLow.price) {
        // Lower low
        if (trend === "bullish") {
          lastChoch = { direction: "bearish", price: s.price, timestamp: s.timestamp };
          trend = "bearish";
        } else if (trend === "bearish") {
          lastBos = { direction: "bearish", price: s.price, timestamp: s.timestamp };
        } else if (lastHigh && prevHigh && lastHigh.price < prevHigh.price) {
          // LL + prior LH → establish bearish with BOS at the LL
          trend = "bearish";
          lastBos = { direction: "bearish", price: s.price, timestamp: s.timestamp };
        }
      }
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
  const order = ["4h", "1h", "15m", "5m", "1m"];
  const idx = order.indexOf(interval);
  return idx >= 0 ? idx : 99;
}

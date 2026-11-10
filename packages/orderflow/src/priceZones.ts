import { createHash } from "node:crypto";
import type {
  Candle,
  FairValueGap,
  LiquiditySweepEvent,
  OrderBlock,
  StructureZonesState,
} from "@of/shared";

export interface PriceZonesConfig {
  /** Max unmitigated FVGs to retain (most recent). */
  maxFvgs: number;
  /** Max active order blocks to retain. */
  maxOrderBlocks: number;
  /** Look ahead this many bars for OB displacement confirmation. */
  obConfirmBars: number;
  /** Max recent sweep events to retain. */
  maxSweeps: number;
  /** Swing lookback for sweep level detection. */
  swingLookback: number;
}

export const DEFAULT_PRICE_ZONES_CONFIG: PriceZonesConfig = {
  maxFvgs: 8,
  maxOrderBlocks: 6,
  obConfirmBars: 5,
  maxSweeps: 6,
  swingLookback: 3,
};

const FVG_BULL_DEF =
  "Bullish FVG: for candles i-2,i-1,i — high[i-2] < low[i]; zone = [high[i-2], low[i]]. Mitigated when a later low <= zone.low.";
const FVG_BEAR_DEF =
  "Bearish FVG: for candles i-2,i-1,i — low[i-2] > high[i]; zone = [high[i], low[i-2]]. Mitigated when a later high >= zone.high.";
const OB_BULL_DEF =
  "Bullish OB: last down-candle (close < open) before a later close above that candle's high within N bars; zone = [low, high] of that candle. Invalidated on close < zone.low.";
const OB_BEAR_DEF =
  "Bearish OB: last up-candle (close > open) before a later close below that candle's low within N bars; zone = [low, high] of that candle. Invalidated on close > zone.high.";
const SWEEP_SSL_DEF =
  "SSL sweep: bar low pierces a prior swing-low level, then close reclaims above that level on the same bar.";
const SWEEP_BSL_DEF =
  "BSL sweep: bar high pierces a prior swing-high level, then close reclaims below that level on the same bar.";

/**
 * Detect rule-based FVGs, order blocks, and liquidity sweeps from OHLC.
 * No institutional / smart-money claims — pure candle geometry.
 */
export function detectStructureZones(
  symbol: string,
  candles: Candle[],
  config: PriceZonesConfig = DEFAULT_PRICE_ZONES_CONFIG,
  updatedAt = Date.now(),
): StructureZonesState {
  const fairValueGaps = detectFairValueGaps(candles, config.maxFvgs);
  const orderBlocks = detectOrderBlocks(candles, config);
  const recentSweeps = detectLiquiditySweeps(candles, config);

  return {
    symbol,
    orderBlocks,
    fairValueGaps,
    recentSweeps,
    evidence: [
      {
        kind: "inferred",
        note: "Order blocks, FVGs, and liquidity sweeps are mechanical OHLC heuristics with explicit rules — not exchange labels and not proof of institutional activity.",
      },
    ],
    updatedAt,
  };
}

export function detectFairValueGaps(candles: Candle[], maxKeep = 8): FairValueGap[] {
  const gaps: FairValueGap[] = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2]!;
    const c = candles[i]!;
    if (a.high < c.low) {
      gaps.push({
        id: zoneId("fvg", "bull", a.closeTime, a.high, c.low),
        direction: "bullish",
        low: a.high,
        high: c.low,
        createdAt: c.closeTime,
        mitigated: false,
        definition: FVG_BULL_DEF,
      });
    } else if (a.low > c.high) {
      gaps.push({
        id: zoneId("fvg", "bear", a.closeTime, c.high, a.low),
        direction: "bearish",
        low: c.high,
        high: a.low,
        createdAt: c.closeTime,
        mitigated: false,
        definition: FVG_BEAR_DEF,
      });
    }
  }

  // Mark mitigation against subsequent candles.
  for (const gap of gaps) {
    const start = candles.findIndex((c) => c.closeTime > gap.createdAt);
    if (start < 0) continue;
    for (let i = start; i < candles.length; i++) {
      const bar = candles[i]!;
      if (gap.direction === "bullish" && bar.low <= gap.low) {
        gap.mitigated = true;
        break;
      }
      if (gap.direction === "bearish" && bar.high >= gap.high) {
        gap.mitigated = true;
        break;
      }
    }
  }

  return gaps.filter((g) => !g.mitigated).slice(-maxKeep);
}

export function detectOrderBlocks(
  candles: Candle[],
  config: PriceZonesConfig = DEFAULT_PRICE_ZONES_CONFIG,
): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const candle = candles[i]!;
    const isDown = candle.close < candle.open;
    const isUp = candle.close > candle.open;
    if (!isDown && !isUp) continue;

    let confirmed = false;
    for (let j = i + 1; j <= Math.min(candles.length - 1, i + config.obConfirmBars); j++) {
      const later = candles[j]!;
      if (isDown && later.close > candle.high) {
        confirmed = true;
        break;
      }
      if (isUp && later.close < candle.low) {
        confirmed = true;
        break;
      }
    }
    if (!confirmed) continue;

    blocks.push({
      id: zoneId("ob", isDown ? "bull" : "bear", candle.closeTime, candle.low, candle.high),
      direction: isDown ? "bullish" : "bearish",
      low: candle.low,
      high: candle.high,
      createdAt: candle.closeTime,
      invalidated: false,
      definition: isDown ? OB_BULL_DEF : OB_BEAR_DEF,
    });
  }

  for (const block of blocks) {
    const start = candles.findIndex((c) => c.closeTime > block.createdAt);
    if (start < 0) continue;
    for (let i = start; i < candles.length; i++) {
      const bar = candles[i]!;
      if (block.direction === "bullish" && bar.close < block.low) {
        block.invalidated = true;
        break;
      }
      if (block.direction === "bearish" && bar.close > block.high) {
        block.invalidated = true;
        break;
      }
    }
  }

  return blocks.filter((b) => !b.invalidated).slice(-config.maxOrderBlocks);
}

export function detectLiquiditySweeps(
  candles: Candle[],
  config: PriceZonesConfig = DEFAULT_PRICE_ZONES_CONFIG,
): LiquiditySweepEvent[] {
  const swings = findSwingLevels(candles, config.swingLookback);
  const sweeps: LiquiditySweepEvent[] = [];

  for (let i = config.swingLookback * 2 + 1; i < candles.length; i++) {
    const bar = candles[i]!;
    const priorLows = swings.lows.filter((s) => s.timestamp < bar.openTime);
    const priorHighs = swings.highs.filter((s) => s.timestamp < bar.openTime);
    const ssl = priorLows[priorLows.length - 1];
    const bsl = priorHighs[priorHighs.length - 1];

    if (ssl && bar.low < ssl.price && bar.close > ssl.price) {
      sweeps.push({
        id: zoneId("sweep", "ssl", bar.closeTime, ssl.price, bar.low),
        side: "SSL",
        level: ssl.price,
        sweepPrice: bar.low,
        closePrice: bar.close,
        timestamp: bar.closeTime,
        bias: "bullish",
        definition: SWEEP_SSL_DEF,
      });
    }
    if (bsl && bar.high > bsl.price && bar.close < bsl.price) {
      sweeps.push({
        id: zoneId("sweep", "bsl", bar.closeTime, bsl.price, bar.high),
        side: "BSL",
        level: bsl.price,
        sweepPrice: bar.high,
        closePrice: bar.close,
        timestamp: bar.closeTime,
        bias: "bearish",
        definition: SWEEP_BSL_DEF,
      });
    }
  }

  return sweeps.slice(-config.maxSweeps);
}

/** True when lastPrice sits inside [low, high] inclusive. */
export function priceInZone(lastPrice: number, low: number, high: number): boolean {
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  return lastPrice >= lo && lastPrice <= hi;
}

function findSwingLevels(
  candles: Candle[],
  lb: number,
): { highs: { price: number; timestamp: number }[]; lows: { price: number; timestamp: number }[] } {
  const highs: { price: number; timestamp: number }[] = [];
  const lows: { price: number; timestamp: number }[] = [];
  for (let i = lb; i < candles.length - lb; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lb; j++) {
      if (candles[i - j]!.high >= c.high || candles[i + j]!.high >= c.high) isHigh = false;
      if (candles[i - j]!.low <= c.low || candles[i + j]!.low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ price: c.high, timestamp: c.closeTime });
    if (isLow) lows.push({ price: c.low, timestamp: c.closeTime });
  }
  return { highs, lows };
}

function zoneId(
  kind: string,
  side: string,
  t: number,
  a: number,
  b: number,
): string {
  return createHash("sha1")
    .update(`${kind}|${side}|${t}|${a}|${b}`)
    .digest("hex")
    .slice(0, 12);
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "@of/shared";
import {
  LIQ_HIGH_USD,
  LIQ_MID_USD,
  deriveSetupClass,
  tagLiquidityBucket,
  tagPaperRegimes,
  tagRangeContext,
} from "./paperStrata.js";

function candle(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): Candle {
  const openTime = 1_700_000_000_000 + i * 5 * 60_000;
  return {
    symbol: "TESTUSDT",
    interval: "5m",
    openTime,
    closeTime: openTime + 5 * 60_000 - 1,
    open,
    high,
    low,
    close,
    volume,
  };
}

function coiledSeries(): Candle[] {
  const out: Candle[] = [];
  let px = 100;
  for (let i = 0; i < 36; i++) {
    const next = px + 1.2;
    out.push(candle(i, px, next + 0.3, px - 0.2, next));
    px = next;
  }
  for (let i = 36; i < 60; i++) {
    out.push(candle(i, px, px + 0.15, px - 0.15, px + 0.02));
  }
  return out;
}

describe("paperStrata", () => {
  it("deriveSetupClass from break_retest confirmations", () => {
    assert.equal(deriveSetupClass(["break_retest_bullish"]), "RANGE_BREAK_RETEST");
    assert.equal(deriveSetupClass(["break_retest_bearish", "cvd"]), "RANGE_BREAK_RETEST");
    assert.equal(deriveSetupClass(["mtf_htf_bullish"]), "OTHER");
    assert.equal(deriveSetupClass(undefined), "OTHER");
  });

  it("tags liquidity buckets by quote volume", () => {
    assert.equal(tagLiquidityBucket(LIQ_HIGH_USD), "liq_high");
    assert.equal(tagLiquidityBucket(LIQ_MID_USD), "liq_mid");
    assert.equal(tagLiquidityBucket(LIQ_MID_USD - 1), "liq_low");
    assert.equal(tagLiquidityBucket(null), null);
  });

  it("tags post_pump_compression after impulse coil", () => {
    const candles = coiledSeries();
    assert.equal(tagRangeContext(candles, 12), "post_pump_compression");
  });

  it("tagPaperRegimes merges structure + liquidity + range", () => {
    const tags = tagPaperRegimes({
      structure: { trend: "range" },
      candles: coiledSeries(),
      quoteVolume24h: LIQ_HIGH_USD,
      changePct24h: 12,
    });
    assert.ok(tags.includes("sideways"));
    assert.ok(tags.includes("liq_high"));
    assert.ok(tags.includes("post_pump_compression"));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "@of/shared";
import {
  PRIMARY_INTERVAL,
  analyzeMarketStructure,
  buildMultiTimeframeContext,
  midIntervalForPrimary,
  resolvePrimaryInterval,
  softIntervalForPrimary,
} from "./structure.js";

function candle(partial: Partial<Candle> & { openTime: number; high: number; low: number; close: number }): Candle {
  return {
    symbol: "BTCUSDT",
    interval: "5m",
    open: partial.close,
    volume: 1,
    closeTime: partial.openTime + 299_999,
    ...partial,
  };
}

describe("buildMultiTimeframeContext", () => {
  it("defaults primary to 5m desk interval", () => {
    assert.equal(PRIMARY_INTERVAL, "5m");
    assert.equal(resolvePrimaryInterval("bogus"), "5m");
    assert.equal(softIntervalForPrimary("5m"), "1m");
    assert.equal(softIntervalForPrimary("15m"), "5m");
    assert.equal(midIntervalForPrimary("5m"), "15m");
    assert.equal(midIntervalForPrimary("15m"), undefined);
  });

  it("counts higher-TF trends and detects conflict with primary", () => {
    const mtf = buildMultiTimeframeContext(
      [
        { interval: "1d", trend: "bearish" },
        { interval: "4h", trend: "bearish" },
        { interval: "1h", trend: "range" },
        { interval: "15m", trend: "bullish" },
        { interval: "5m", trend: "bullish" },
        { interval: "1m", trend: "bullish" },
      ],
      "15m",
    );
    assert.equal(mtf.primaryInterval, "15m");
    assert.equal(mtf.higherTfBullish, 0);
    assert.equal(mtf.higherTfBearish, 2);
    assert.equal(mtf.higherTfRange, 1);
    assert.equal(mtf.conflictWithPrimary, true);
    assert.deepEqual(
      mtf.frames.map((f) => f.interval),
      ["1d", "4h", "1h", "15m", "5m", "1m"],
    );
  });

  it("does not conflict when HTF majority agrees with primary", () => {
    const mtf = buildMultiTimeframeContext(
      [
        { interval: "1d", trend: "bullish" },
        { interval: "4h", trend: "bullish" },
        { interval: "1h", trend: "bullish" },
        { interval: "5m", trend: "bullish" },
      ],
      "5m",
    );
    assert.equal(mtf.conflictWithPrimary, false);
    assert.equal(mtf.higherTfBullish, 3);
    assert.equal(mtf.primaryInterval, "5m");
  });
});

describe("analyzeMarketStructure support/resistance", () => {
  it("keeps support below and resistance above last close", () => {
    // Zigzag with lookback=1: swing highs ~110/105/100, lows ~90/85/80; last close 88.
    const candles: Candle[] = [
      candle({ openTime: 0, high: 92, low: 89, close: 91 }),
      candle({ openTime: 1, high: 110, low: 90, close: 100 }), // high pivot
      candle({ openTime: 2, high: 101, low: 90, close: 92 }),
      candle({ openTime: 3, high: 95, low: 80, close: 85 }), // low pivot
      candle({ openTime: 4, high: 96, low: 84, close: 94 }),
      candle({ openTime: 5, high: 105, low: 93, close: 98 }), // high pivot
      candle({ openTime: 6, high: 99, low: 86, close: 88 }),
      candle({ openTime: 7, high: 94, low: 85, close: 87 }), // low pivot
      candle({ openTime: 8, high: 93, low: 86, close: 90 }),
      candle({ openTime: 9, high: 100, low: 89, close: 95 }), // high pivot
      candle({ openTime: 10, high: 96, low: 87, close: 88 }), // ref close 88
    ];
    const structure = analyzeMarketStructure("BTCUSDT", candles, 1);
    assert.ok(structure.support.length > 0, "expected supports below close");
    assert.ok(structure.resistance.length > 0, "expected resistance above close");
    for (const s of structure.support) {
      assert.ok(s < 88, `support ${s} must be < close 88`);
    }
    for (const r of structure.resistance) {
      assert.ok(r > 88, `resistance ${r} must be > close 88`);
    }
    const ssl = structure.liquidityPools.filter((p) => p.side === "SSL" && p.label === "swing low liquidity");
    const bsl = structure.liquidityPools.filter((p) => p.side === "BSL" && p.label === "swing high liquidity");
    for (const p of ssl) assert.ok(p.price < 88);
    for (const p of bsl) assert.ok(p.price > 88);
  });
});

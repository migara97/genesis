import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "@of/shared";
import {
  detectFairValueGaps,
  detectLiquiditySweeps,
  detectOrderBlocks,
  detectStructureZones,
  priceInZone,
} from "./priceZones.js";

function c(
  open: number,
  high: number,
  low: number,
  close: number,
  i: number,
): Candle {
  const t0 = Date.UTC(2024, 0, 1);
  return {
    symbol: "BTCUSDT",
    interval: "15m",
    openTime: t0 + i * 900_000,
    open,
    high,
    low,
    close,
    volume: 1,
    closeTime: t0 + i * 900_000 + 899_999,
  };
}

describe("priceZones", () => {
  it("detects an unmitigated bullish FVG from a 3-candle gap", () => {
    // a.high=10, impulse, c.low=12 → gap [10,12]; keep following bar overlapping so no 2nd gap.
    const candles = [
      c(9, 10, 8, 9.5, 0),
      c(9.5, 11, 9.4, 10.8, 1),
      c(10.8, 13, 12, 12.5, 2),
      c(12.5, 13, 10.5, 12.8, 3), // low overlaps prior impulse → no new FVG vs candle 1
    ];
    const gaps = detectFairValueGaps(candles);
    const bull = gaps.find((g) => g.direction === "bullish" && g.low === 10 && g.high === 12);
    assert.ok(bull, `expected bullish FVG [10,12], got ${JSON.stringify(gaps)}`);
    assert.equal(bull!.mitigated, false);
    assert.ok(bull!.definition.includes("high[i-2] < low[i]"));
  });

  it("marks bullish FVG mitigated when later low fills the gap", () => {
    const candles = [
      c(9, 10, 8, 9.5, 0),
      c(9.5, 11, 9.4, 10.8, 1),
      c(10.8, 13, 12, 12.5, 2),
      c(12.5, 12.6, 9.5, 10, 3), // low 9.5 <= gap.low 10
    ];
    const gaps = detectFairValueGaps(candles);
    assert.equal(gaps.length, 0);
  });

  it("detects bullish order block on down-candle then displacement", () => {
    const candles = [
      c(10, 10.5, 9.5, 9.6, 0), // down candle → OB
      c(9.6, 9.8, 9.4, 9.7, 1),
      c(9.7, 11.2, 9.6, 11, 2), // close above OB high
      c(11, 11.3, 10.8, 11.1, 3),
    ];
    const blocks = detectOrderBlocks(candles);
    assert.ok(blocks.some((b) => b.direction === "bullish" && b.low === 9.5 && b.high === 10.5));
    assert.ok(blocks[0]!.definition.includes("down-candle"));
  });

  it("detects SSL sweep: pierce swing low then reclaim", () => {
    // Build a clear swing low in the middle, then sweep it.
    const candles: Candle[] = [];
    // descending into a low, then bounce, then sweep
    for (let i = 0; i < 10; i++) candles.push(c(20 - i * 0.5, 20.2 - i * 0.5, 19.7 - i * 0.5, 19.8 - i * 0.5, i));
    // forced swing low bar
    candles.push(c(15, 15.2, 14, 14.5, 10));
    for (let i = 11; i < 14; i++) candles.push(c(14.5 + (i - 10), 15 + (i - 10), 14.4 + (i - 10), 14.8 + (i - 10), i));
    // sweep: low under 14, close back above
    candles.push(c(16, 16.5, 13.5, 15.5, 14));

    const sweeps = detectLiquiditySweeps(candles, {
      maxFvgs: 8,
      maxOrderBlocks: 6,
      obConfirmBars: 5,
      maxSweeps: 6,
      swingLookback: 2,
    });
    assert.ok(sweeps.some((s) => s.side === "SSL" && s.bias === "bullish"));
    assert.ok(sweeps.some((s) => s.definition.includes("swing-low")));
  });

  it("priceInZone is inclusive", () => {
    assert.equal(priceInZone(10, 9, 11), true);
    assert.equal(priceInZone(9, 9, 11), true);
    assert.equal(priceInZone(11, 9, 11), true);
    assert.equal(priceInZone(8.9, 9, 11), false);
  });

  it("detectStructureZones returns evidence disclaimer", () => {
    const zones = detectStructureZones("BTCUSDT", [
      c(9, 10, 8, 9.5, 0),
      c(9.5, 11, 9.4, 10.8, 1),
      c(10.8, 13, 12, 12.5, 2),
    ]);
    assert.equal(zones.symbol, "BTCUSDT");
    assert.ok(zones.evidence.some((e) => /not proof of institutional/i.test(e.note)));
  });
});

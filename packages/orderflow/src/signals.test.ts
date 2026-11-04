import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSignal } from "./signals.js";

describe("generateSignal", () => {
  it("returns WAIT without multi-confirmations", () => {
    const signal = generateSignal({
      symbol: "BTCUSDT",
      lastPrice: 100,
      timestamp: Date.now(),
    });
    assert.equal(signal.direction, "WAIT");
  });

  it("can produce LONG with structure + CVD + footprint confirmations", () => {
    const signal = generateSignal({
      symbol: "BTCUSDT",
      lastPrice: 95,
      timestamp: Date.now(),
      structure: {
        symbol: "BTCUSDT",
        trend: "bullish",
        swings: [],
        support: [90],
        resistance: [110],
        liquidityPools: [],
        evidence: [],
      },
      cvd: {
        symbol: "BTCUSDT",
        sessionStart: Date.now(),
        cvd: 500,
        points: [],
        divergence: "bullish",
        exhaustion: false,
        evidence: [],
      },
      footprint: {
        symbol: "BTCUSDT",
        openTime: 0,
        closeTime: 1,
        open: 94,
        high: 96,
        low: 93,
        close: 95,
        cells: [],
        totalDelta: 200,
        totalVolume: 400,
        imbalances: [
          { price: 94, side: "ask", ratio: 4, stacked: true, diagonal: false },
          { price: 94.5, side: "ask", ratio: 4, stacked: true, diagonal: false },
          { price: 95, side: "ask", ratio: 4, stacked: true, diagonal: false },
        ],
        absorption: false,
        exhaustion: false,
        unfinishedAuction: false,
        evidence: [],
      },
      volumeProfile: {
        symbol: "BTCUSDT",
        from: 0,
        to: 1,
        tickSize: 0.1,
        levels: [],
        poc: 100,
        vah: 105,
        val: 96,
        hvn: [],
        lvn: [],
        totalVolume: 1,
      },
    });
    assert.equal(signal.direction, "LONG");
    assert.ok(signal.confirmations.length >= 2);
  });
});

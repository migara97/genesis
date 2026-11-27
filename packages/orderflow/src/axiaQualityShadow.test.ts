import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  axiaQualityRegimeHints,
  computeAxiaQualityShadow,
  formatAxiaQualitySummary,
} from "./axiaQualityShadow.js";
import type { BreakRetestState, FootprintBar } from "@of/shared";

function fp(partial: Partial<FootprintBar> = {}): FootprintBar {
  return {
    symbol: "BTCUSDT",
    openTime: 0,
    closeTime: 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    cells: [
      { price: 101, bidVolume: 10, askVolume: 10, delta: 0, trades: 2 },
      { price: 100, bidVolume: 20, askVolume: 20, delta: 0, trades: 2 },
      { price: 99, bidVolume: 10, askVolume: 10, delta: 0, trades: 2 },
    ],
    totalDelta: 200,
    totalVolume: 400,
    imbalances: [],
    absorption: false,
    exhaustion: false,
    unfinishedAuction: false,
    evidence: [],
    ...partial,
  };
}

function broken(partial: Partial<BreakRetestState> = {}): BreakRetestState {
  return {
    symbol: "BTCUSDT",
    phase: "broken",
    side: "bullish",
    brokenAt: Date.now() - 5 * 60_000,
    brokenBarIndex: 10,
    breakPrice: 100,
    reason: "test",
    evidence: [],
    updatedAt: Date.now(),
    ...partial,
  };
}

describe("computeAxiaQualityShadow", () => {
  it("never mutates scores and tags low efficiency on high delta / flat range", () => {
    const shadow = computeAxiaQualityShadow({
      symbol: "BTCUSDT",
      lastPrice: 100.01,
      footprint: fp({
        open: 100,
        high: 100.05,
        low: 99.95,
        close: 100.01,
        totalDelta: -500,
        totalVolume: 1000,
        absorption: true,
      }),
    });
    assert.equal(shadow.mutatesScores, false);
    assert.ok(shadow.deltaEfficiency < 0.5);
    assert.equal(shadow.highLowFormation, "absorption");
    assert.ok(shadow.evidence.some((e) => /never mutates/i.test(e.note)));
  });

  it("scores higher delta efficiency when range expands with imbalance", () => {
    const shadow = computeAxiaQualityShadow({
      symbol: "BTCUSDT",
      lastPrice: 102,
      footprint: fp({
        open: 100,
        high: 103,
        low: 99.5,
        close: 102.5,
        totalDelta: 400,
        totalVolume: 800,
      }),
    });
    assert.ok(shadow.deltaEfficiency >= 0.5);
  });

  it("detects hang / low break quality after break with absorb history", () => {
    const history = [
      fp({ totalDelta: -800, totalVolume: 1000, high: 100.05, low: 99.95, close: 100, absorption: true }),
      fp({ totalDelta: -700, totalVolume: 900, high: 100.04, low: 99.96, close: 100, absorption: true }),
      fp({ totalDelta: -600, totalVolume: 850, high: 100.03, low: 99.97, close: 100, absorption: true }),
    ];
    const shadow = computeAxiaQualityShadow({
      symbol: "BTCUSDT",
      lastPrice: 100.05,
      footprint: history[2],
      footprintHistory: history,
      breakRetest: broken(),
      barIndex: 16,
    });
    assert.equal(shadow.hangDetected, true);
    assert.ok(shadow.hangBars >= 3);
    assert.ok(shadow.breakQuality < 0.5);
    assert.ok(shadow.absorptionPersistence >= 0.66);
  });

  it("marks accepted break as high quality", () => {
    const shadow = computeAxiaQualityShadow({
      symbol: "BTCUSDT",
      lastPrice: 101.5,
      footprint: fp({ totalDelta: 300, totalVolume: 500, high: 102, low: 100, close: 101.5 }),
      breakRetest: broken({ phase: "accepted", acceptedAt: Date.now() }),
      barIndex: 12,
    });
    assert.ok(shadow.breakQuality >= 0.8);
    assert.equal(shadow.hangDetected, false);
  });

  it("classifies classic V-reversal footprint", () => {
    const shadow = computeAxiaQualityShadow({
      symbol: "BTCUSDT",
      lastPrice: 101.8,
      footprint: fp({
        open: 99.2,
        high: 102,
        low: 99,
        close: 101.8,
        totalDelta: 500,
        totalVolume: 900,
      }),
    });
    assert.equal(shadow.highLowFormation, "v_reversal");
  });

  it("emits regime hints and summary without claiming edge", () => {
    const shadow = computeAxiaQualityShadow({
      symbol: "BTCUSDT",
      lastPrice: 100,
      footprint: fp({ absorption: true, totalDelta: -400, totalVolume: 500, high: 100.02, low: 99.98 }),
      breakRetest: broken({ phase: "failed" }),
      barIndex: 20,
    });
    const hints = axiaQualityRegimeHints(shadow);
    assert.ok(hints.includes("hl_absorption") || hints.includes("break_q_low"));
    const summary = formatAxiaQualitySummary(shadow);
    assert.match(summary, /no score mutation/i);
  });
});

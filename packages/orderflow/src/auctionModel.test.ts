import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeAuctionShadow,
  formatAuctionShadowSummary,
} from "./auctionModel.js";
import type { BreakRetestState, FootprintBar, VolumeProfile } from "@of/shared";

function vp(partial: Partial<VolumeProfile> = {}): VolumeProfile {
  return {
    symbol: "BTCUSDT",
    from: 0,
    to: 1,
    tickSize: 0.1,
    levels: [],
    poc: 100,
    vah: 102,
    val: 98,
    hvn: [100],
    lvn: [99, 101],
    totalVolume: 1000,
    ...partial,
  };
}

function fp(partial: Partial<FootprintBar> = {}): FootprintBar {
  return {
    symbol: "BTCUSDT",
    openTime: 0,
    closeTime: 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    cells: [],
    totalDelta: 200,
    totalVolume: 400,
    imbalances: [
      { price: 100, side: "ask", ratio: 4, stacked: true, diagonal: false },
      { price: 100.1, side: "ask", ratio: 4, stacked: true, diagonal: false },
      { price: 100.2, side: "ask", ratio: 4, stacked: true, diagonal: false },
    ],
    absorption: false,
    exhaustion: false,
    unfinishedAuction: false,
    evidence: [],
    ...partial,
  };
}

describe("computeAuctionShadow", () => {
  it("marks BALANCE inside value and never claims score mutation", () => {
    const shadow = computeAuctionShadow({
      symbol: "BTCUSDT",
      lastPrice: 100,
      volumeProfile: vp(),
      footprint: fp(),
    });
    assert.equal(shadow.state, "BALANCE");
    assert.equal(shadow.priceVsValue, "inside");
    assert.equal(shadow.mutatesScores, false);
    assert.equal(shadow.aggressionSide, "buy");
    assert.ok(shadow.aggressionScore > 0);
    assert.ok(shadow.evidence.some((e) => /never mutates/i.test(e.note)));
  });

  it("marks IMBALANCE above VAH with trend-continuation shadow mode", () => {
    const shadow = computeAuctionShadow({
      symbol: "BTCUSDT",
      lastPrice: 105,
      volumeProfile: vp(),
      footprint: fp({ totalDelta: 300, totalVolume: 500 }),
    });
    assert.equal(shadow.state, "IMBALANCE");
    assert.equal(shadow.priceVsValue, "above_vah");
    assert.equal(shadow.modelMode, "TREND_CONTINUATION");
    assert.equal(shadow.followThrough, "supportive");
  });

  it("marks MEAN_REVERSION when break/retest failed", () => {
    const breakRetest: BreakRetestState = {
      symbol: "BTCUSDT",
      phase: "failed",
      side: "bullish",
      bandId: "x",
      brokenAt: 1,
      reason: "failed reclaim",
      evidence: [],
      updatedAt: 3,
    };
    const shadow = computeAuctionShadow({
      symbol: "BTCUSDT",
      lastPrice: 100,
      volumeProfile: vp(),
      footprint: fp({ absorption: true, totalDelta: -10 }),
      breakRetest,
    });
    assert.equal(shadow.failedAuction, "failed_high");
    assert.equal(shadow.modelMode, "MEAN_REVERSION");
    assert.equal(shadow.followThrough, "absorbing");
  });

  it("returns UNKNOWN without volume profile", () => {
    const shadow = computeAuctionShadow({
      symbol: "BTCUSDT",
      lastPrice: 100,
    });
    assert.equal(shadow.state, "UNKNOWN");
    assert.equal(shadow.modelMode, "OFF");
    assert.equal(shadow.priceVsValue, "unknown");
  });

  it("formats summary without implying execution", () => {
    const shadow = computeAuctionShadow({
      symbol: "BTCUSDT",
      lastPrice: 100,
      volumeProfile: vp(),
    });
    const text = formatAuctionShadowSummary(shadow);
    assert.ok(/observational/i.test(text));
    assert.ok(/no score mutation/i.test(text));
  });
});

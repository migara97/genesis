import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "@of/shared";
import {
  PRIMARY_INTERVAL,
  softIntervalForPrimary,
} from "./structure.js";
import {
  buildScannerSnapshot,
  computeCompression,
  computeRvol,
  detectRegime,
  scoreAltSetup,
} from "./altScanner.js";

function candle(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
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

/** Impulse then tight coil near last price. */
function coiledSeries(): Candle[] {
  const out: Candle[] = [];
  let px = 100;
  for (let i = 0; i < 36; i++) {
    const next = px + 1.2;
    out.push(candle(i, px, next + 0.3, px - 0.2, next, 100 + i));
    px = next;
  }
  for (let i = 36; i < 60; i++) {
    out.push(candle(i, px, px + 0.15, px - 0.15, px + 0.02, i === 59 ? 400 : 90));
  }
  return out;
}

describe("altScanner", () => {
  it("desk primary defaults to 5m with 1m soft", () => {
    assert.equal(PRIMARY_INTERVAL, "5m");
    assert.equal(softIntervalForPrimary("5m"), "1m");
  });

  it("compression rises when recent range tightens vs impulse", () => {
    const candles = coiledSeries();
    const score = computeCompression(candles, { coilBars: 12, impulseBars: 36 });
    assert.ok(score > 0.5, `expected tight coil, got ${score}`);
  });

  it("rvol spikes on last bar volume vs median", () => {
    const candles = coiledSeries();
    const rvol = computeRvol(candles, 20);
    assert.ok(rvol > 2, `expected elevated rvol, got ${rvol}`);
  });

  it("tags post_pump_compression after large advance then coil", () => {
    const candles = coiledSeries();
    const regime = detectRegime(candles, undefined, 12, { coilBars: 12, impulseBars: 36 });
    assert.equal(regime, "post_pump_compression");
  });

  it("scores coiled name with rankScore and rankNote disclaimer", () => {
    const candles = coiledSeries();
    const last = candles[candles.length - 1]!;
    const hit = scoreAltSetup({
      symbol: "TESTUSDT",
      lastPrice: last.close,
      changePct24h: 12,
      candles5m: candles,
      now: last.closeTime,
    });
    assert.ok(hit);
    assert.ok(hit!.rankScore > 0.25);
    assert.match(hit!.rankNote, /not a win rate/i);
    assert.equal(hit!.regime, "post_pump_compression");
  });

  it("returns null for empty / short history", () => {
    assert.equal(
      scoreAltSetup({ symbol: "X", lastPrice: 1, candles5m: [] }),
      null,
    );
  });

  it("buildScannerSnapshot ranks and caps hits", () => {
    const snap = buildScannerSnapshot(
      [
        {
          symbol: "B",
          rankScore: 0.4,
          rankNote: "n",
          rvol: 1,
          compression: 0.5,
          regime: "none",
          bias: "none",
          reason: "b",
          updatedAt: 1,
        },
        {
          symbol: "A",
          rankScore: 0.9,
          rankNote: "n",
          rvol: 2,
          compression: 0.8,
          regime: "none",
          bias: "bullish",
          reason: "a",
          updatedAt: 1,
        },
      ],
      10,
      2,
      { ...{ coilBars: 12, impulseBars: 36, rvolLookback: 20, nearBandPct: 0.004, minCandles: 48, maxHits: 1 } },
    );
    assert.equal(snap.hits.length, 1);
    assert.equal(snap.hits[0]!.symbol, "A");
    assert.equal(snap.universeSize, 10);
    assert.ok(snap.evidence.length > 0);
  });
});

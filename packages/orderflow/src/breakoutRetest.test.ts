import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  BreakRetestState,
  Candle,
  ChartOverlayState,
  ChartZoneBand,
  CvdState,
  FootprintBar,
} from "@of/shared";
import {
  DEFAULT_BREAK_RETEST_CONFIG,
  advanceBreakRetest,
  ofSupports,
} from "./breakoutRetest.js";

function band(
  id: string,
  kind: ChartZoneBand["kind"],
  low: number,
  high: number,
): ChartZoneBand {
  return { id, kind, low, high, source: "swing_cluster", strength: 0.7, createdAt: 1 };
}

function overlay(bands: ChartZoneBand[]): ChartOverlayState {
  return {
    symbol: "BTCUSDT",
    bands,
    evidence: [],
    updatedAt: 1,
  };
}

function candlesBetween(floor: number, ceiling: number, n: number, startClose = (floor + ceiling) / 2): Candle[] {
  const out: Candle[] = [];
  const t0 = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const close = startClose;
    out.push({
      symbol: "BTCUSDT",
      interval: "15m",
      openTime: t0 + i * 900_000,
      open: close,
      high: Math.min(ceiling, close + 1),
      low: Math.max(floor, close - 1),
      close,
      volume: 10,
      closeTime: t0 + i * 900_000 + 899_999,
    });
  }
  return out;
}

function pushCandle(list: Candle[], close: number, high?: number, low?: number): Candle[] {
  const prev = list[list.length - 1]!;
  return [
    ...list,
    {
      ...prev,
      openTime: prev.closeTime + 1,
      closeTime: prev.closeTime + 900_000,
      open: prev.close,
      close,
      high: high ?? Math.max(prev.close, close),
      low: low ?? Math.min(prev.close, close),
    },
  ];
}

function bullFp(): FootprintBar {
  return {
    symbol: "BTCUSDT",
    openTime: 1,
    closeTime: 2,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    cells: [],
    totalDelta: 50,
    totalVolume: 100,
    imbalances: [],
    absorption: false,
    unfinishedAuction: false,
    exhaustion: false,
    evidence: [],
  };
}

function bearFp(): FootprintBar {
  return { ...bullFp(), totalDelta: -50 };
}

function risingCvd(): CvdState {
  const points = [];
  for (let i = 0; i < 20; i++) {
    points.push({ timestamp: i, price: 100 + i, delta: 1, cvd: i });
  }
  return {
    symbol: "BTCUSDT",
    sessionStart: 0,
    cvd: 19,
    points,
    divergence: "none",
    exhaustion: false,
    evidence: [],
  };
}

function fallingCvd(): CvdState {
  const points = [];
  for (let i = 0; i < 20; i++) {
    points.push({ timestamp: i, price: 120 - i, delta: -1, cvd: -i });
  }
  return {
    symbol: "BTCUSDT",
    sessionStart: 0,
    cvd: -19,
    points,
    divergence: "none",
    exhaustion: false,
    evidence: [],
  };
}

// Corridor height (supply.low - demand.high) / mid ≈ 4% — within maxRangePct.
const demand = band("d1", "demand", 96, 98);
const supply = band("s1", "supply", 102, 104);
const chart = overlay([demand, supply]);

describe("breakoutRetest", () => {
  it("enters balance when candles sit between demand and supply", () => {
    const cs = candlesBetween(98, 102, 8, 100);
    const state = advanceBreakRetest(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
    });
    assert.equal(state.phase, "balance", state.reason);
  });

  it("breaks supply with OF then retests and accepts", () => {
    let cs = candlesBetween(98, 102, 8, 100);
    let state: BreakRetestState = advanceBreakRetest(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 1000,
    });
    assert.equal(state.phase, "balance");

    cs = pushCandle(cs, 105, 106, 101);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 105,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 2000,
    });
    assert.equal(state.phase, "broken", state.reason);
    assert.equal(state.side, "bullish");

    cs = pushCandle(cs, 103, 105, 102.5);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 103,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 3000,
    });
    assert.equal(state.phase, "retesting", state.reason);

    cs = pushCandle(cs, 104.5, 105, 103);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 104.5,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 4000,
    });
    assert.equal(state.phase, "accepted", state.reason);
  });

  it("does not accept reclaim without OF", () => {
    let cs = candlesBetween(98, 102, 8, 100);
    let state = advanceBreakRetest(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 1000,
    });
    cs = pushCandle(cs, 105);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 105,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 2000,
    });
    cs = pushCandle(cs, 103, 105, 102.5);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 103,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 3000,
    });
    assert.equal(state.phase, "retesting", state.reason);

    // Flat / opposing OF
    const flatCvd: CvdState = {
      symbol: "BTCUSDT",
      sessionStart: 0,
      cvd: 0,
      points: [
        { timestamp: 1, price: 100, delta: 0, cvd: 0 },
        { timestamp: 2, price: 100, delta: 0, cvd: 0 },
        { timestamp: 3, price: 100, delta: 0, cvd: 0 },
        { timestamp: 4, price: 100, delta: 0, cvd: 0 },
      ],
      divergence: "none",
      exhaustion: false,
      evidence: [],
    };
    cs = pushCandle(cs, 104.5);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 104.5,
      candles: cs,
      chartOverlay: chart,
      footprint: { ...bullFp(), totalDelta: 0 },
      cvd: flatCvd,
      now: 4000,
    });
    assert.equal(state.phase, "retesting");
    assert.match(state.reason, /OF/);
  });

  it("fails when retest is lost back through range mid", () => {
    let cs = candlesBetween(98, 102, 8, 100);
    let state = advanceBreakRetest(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 1000,
    });
    cs = pushCandle(cs, 105);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 105,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 2000,
    });
    cs = pushCandle(cs, 103, 105, 102.5);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 103,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 3000,
    });
    assert.equal(state.phase, "retesting", state.reason);

    cs = pushCandle(cs, 97, 103, 96.5);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 97,
      candles: cs,
      chartOverlay: chart,
      footprint: bearFp(),
      cvd: fallingCvd(),
      now: 4000,
    });
    assert.ok(state.phase === "failed" || state.phase === "invalidated", state.phase);
  });

  it("invalidates bullish playbook on close through opposite demand", () => {
    let cs = candlesBetween(98, 102, 8, 100);
    let state = advanceBreakRetest(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 1000,
    });
    cs = pushCandle(cs, 105);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 105,
      candles: cs,
      chartOverlay: chart,
      footprint: bullFp(),
      cvd: risingCvd(),
      now: 2000,
    });
    assert.equal(state.phase, "broken", state.reason);

    cs = pushCandle(cs, 95, 105, 94.5);
    state = advanceBreakRetest(state, {
      symbol: "BTCUSDT",
      lastPrice: 95,
      candles: cs,
      chartOverlay: chart,
      footprint: bearFp(),
      cvd: fallingCvd(),
      now: 3000,
    });
    assert.equal(state.phase, "invalidated", state.reason);
  });

  it("ofSupports requires aligned footprint or CVD slope", () => {
    assert.equal(ofSupports("bullish", bullFp(), fallingCvd(), DEFAULT_BREAK_RETEST_CONFIG), true);
    assert.equal(ofSupports("bearish", bearFp(), risingCvd(), DEFAULT_BREAK_RETEST_CONFIG), true);
    assert.equal(
      ofSupports(
        "bullish",
        { ...bullFp(), totalDelta: 0 },
        fallingCvd(),
        DEFAULT_BREAK_RETEST_CONFIG,
      ),
      false,
    );
  });
});

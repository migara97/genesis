import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  BreakRetestState,
  Candle,
  ChartOverlayState,
  ChartZoneBand,
  CvdState,
  MarketStructureState,
} from "@of/shared";
import { advanceScenarioTree, resolveScenarioBias } from "./scenarioTree.js";

function band(id: string, kind: ChartZoneBand["kind"], low: number, high: number): ChartZoneBand {
  return { id, kind, low, high, source: "swing_cluster", strength: 0.7, createdAt: 1 };
}

const demand = band("d1", "demand", 96, 98);
const supply = band("s1", "supply", 102, 104);

function overlay(): ChartOverlayState {
  return { symbol: "BTCUSDT", bands: [demand, supply], evidence: [], updatedAt: 1 };
}

function candlesAt(close: number, n = 8): Candle[] {
  const t0 = Date.UTC(2024, 0, 1);
  return Array.from({ length: n }, (_, i) => ({
    symbol: "BTCUSDT",
    interval: "15m",
    openTime: t0 + i * 900_000,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 10,
    closeTime: t0 + i * 900_000 + 899_999,
  }));
}

function bullStructure(): MarketStructureState {
  return {
    symbol: "BTCUSDT",
    trend: "bullish",
    swings: [],
    support: [96],
    resistance: [104],
    liquidityPools: [],
    evidence: [],
  };
}

function risingCvd(): CvdState {
  const points = Array.from({ length: 20 }, (_, i) => ({
    timestamp: i,
    price: 100 + i * 0.1,
    delta: 1,
    cvd: i,
  }));
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

describe("scenarioTree", () => {
  it("resolves bias from structure then CVD", () => {
    assert.equal(resolveScenarioBias(bullStructure(), null), "bullish");
    assert.equal(resolveScenarioBias({ ...bullStructure(), trend: "range" }, risingCvd()), "bullish");
    assert.equal(resolveScenarioBias({ ...bullStructure(), trend: "range" }, null), "none");
  });

  it("creates bullish break_now + dip_to_demand pair", () => {
    const tree = advanceScenarioTree(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: candlesAt(100),
      chartOverlay: overlay(),
      structure: bullStructure(),
      cvd: risingCvd(),
      now: 1000,
    });
    assert.equal(tree.bias, "bullish");
    assert.equal(tree.scenarios.length, 2);
    assert.ok(tree.scenarios.some((s) => s.kind === "break_now_long"));
    assert.ok(tree.scenarios.some((s) => s.kind === "dip_to_demand_long"));
    assert.ok(tree.scenarios.every((s) => s.rankNote.includes("not a historical win rate")));
  });

  it("withholds scenarios when bias is none", () => {
    const tree = advanceScenarioTree(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: candlesAt(100),
      chartOverlay: overlay(),
      structure: { ...bullStructure(), trend: "range" },
      cvd: null,
      now: 1000,
    });
    assert.equal(tree.bias, "none");
    assert.equal(tree.scenarios.length, 0);
  });

  it("triggers dip_to_demand when price tags demand band", () => {
    let tree = advanceScenarioTree(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: candlesAt(100),
      chartOverlay: overlay(),
      structure: bullStructure(),
      now: 1000,
    });
    const cs = candlesAt(97.5);
    cs[cs.length - 1] = {
      ...cs[cs.length - 1]!,
      low: 97,
      high: 98,
      close: 97.5,
    };
    tree = advanceScenarioTree(tree, {
      symbol: "BTCUSDT",
      lastPrice: 97.5,
      candles: cs,
      chartOverlay: overlay(),
      structure: bullStructure(),
      now: 2000,
    });
    const dip = tree.scenarios.find((s) => s.kind === "dip_to_demand_long");
    assert.equal(dip?.status, "triggered");
  });

  it("triggers break_now_long when Phase B is broken bullish", () => {
    let tree = advanceScenarioTree(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: candlesAt(100),
      chartOverlay: overlay(),
      structure: bullStructure(),
      now: 1000,
    });
    const br: BreakRetestState = {
      symbol: "BTCUSDT",
      phase: "broken",
      side: "bullish",
      bandLow: 102,
      bandHigh: 104,
      oppositeLow: 96,
      oppositeHigh: 98,
      reason: "broken",
      evidence: [],
      updatedAt: 2000,
    };
    tree = advanceScenarioTree(tree, {
      symbol: "BTCUSDT",
      lastPrice: 105,
      candles: candlesAt(105),
      chartOverlay: overlay(),
      breakRetest: br,
      structure: bullStructure(),
      now: 2000,
    });
    const brk = tree.scenarios.find((s) => s.kind === "break_now_long");
    assert.equal(brk?.status, "triggered");
  });

  it("invalidates bullish scenarios on close through demand low", () => {
    let tree = advanceScenarioTree(null, {
      symbol: "BTCUSDT",
      lastPrice: 100,
      candles: candlesAt(100),
      chartOverlay: overlay(),
      structure: bullStructure(),
      now: 1000,
    });
    tree = advanceScenarioTree(tree, {
      symbol: "BTCUSDT",
      lastPrice: 95,
      candles: candlesAt(95),
      chartOverlay: overlay(),
      structure: bullStructure(),
      now: 2000,
    });
    assert.ok(tree.scenarios.every((s) => s.status === "invalidated"));
  });
});

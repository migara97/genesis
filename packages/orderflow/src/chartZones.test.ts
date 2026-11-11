import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  Candle,
  MarketStructureState,
  StructureZonesState,
  TradeTick,
  VolumeProfile,
} from "@of/shared";
import {
  DEFAULT_CHART_ZONES_CONFIG,
  buildChartOverlay,
  detectChartBands,
  mergeOverlappingBands,
  selectNearestBands,
} from "./chartZones.js";

function trade(price: number, qty: number, ts: number): TradeTick {
  return {
    exchange: "binance",
    symbol: "BTCUSDT",
    tradeId: `${ts}-${price}`,
    price,
    quantity: qty,
    buyerAggressor: true,
    aggressorSource: "exchange_flag",
    timestamp: ts,
  };
}

function candle(i: number, open: number, high: number, low: number, close: number): Candle {
  const t0 = Date.UTC(2024, 0, 1);
  return {
    symbol: "BTCUSDT",
    interval: "15m",
    openTime: t0 + i * 900_000,
    open,
    high,
    low,
    close,
    volume: 10,
    closeTime: t0 + i * 900_000 + 899_999,
  };
}

function profileWithHvn(hvn: number[], levels: { price: number; volume: number }[]): VolumeProfile {
  return {
    symbol: "BTCUSDT",
    from: 1,
    to: 2,
    tickSize: 1,
    levels: levels.map((l) => ({ ...l, buyVolume: l.volume, sellVolume: 0 })),
    poc: levels.reduce((b, l) => (l.volume > b.volume ? l : b), levels[0]!).price,
    vah: Math.max(...levels.map((l) => l.price)),
    val: Math.min(...levels.map((l) => l.price)),
    hvn,
    lvn: [],
    totalVolume: levels.reduce((s, l) => s + l.volume, 0),
  };
}

describe("chartZones", () => {
  it("merges adjacent HVN prices into one band", () => {
    const profile = profileWithHvn(
      [100, 101, 102, 110],
      [
        { price: 100, volume: 50 },
        { price: 101, volume: 40 },
        { price: 102, volume: 30 },
        { price: 110, volume: 20 },
      ],
    );
    const bands = detectChartBands({
      lastPrice: 105,
      tickSize: 1,
      profile,
      config: { ...DEFAULT_CHART_ZONES_CONFIG, hvnMergeTicks: 2 },
    });
    const hvn = bands.filter((b) => b.source === "hvn_cluster");
    assert.ok(hvn.some((b) => b.low === 100 && b.high === 102));
    assert.ok(hvn.some((b) => b.low === 110));
  });

  it("clusters equal swing highs into a supply band", () => {
    const structure: MarketStructureState = {
      symbol: "BTCUSDT",
      trend: "range",
      swings: [
        { price: 120, timestamp: 1, type: "HH", kind: "high" },
        { price: 120.1, timestamp: 2, type: "HH", kind: "high" },
        { price: 100, timestamp: 3, type: "LL", kind: "low" },
        { price: 100.05, timestamp: 4, type: "HL", kind: "low" },
      ],
      support: [100],
      resistance: [120],
      liquidityPools: [],
      evidence: [],
    };
    const bands = detectChartBands({
      lastPrice: 110,
      tickSize: 0.01,
      structure,
      config: DEFAULT_CHART_ZONES_CONFIG,
    });
    assert.ok(bands.some((b) => b.source === "swing_cluster" && b.kind === "supply"));
    assert.ok(bands.some((b) => b.source === "swing_cluster" && b.kind === "demand"));
  });

  it("keeps active order blocks and drops invalidated ones", () => {
    const zones: StructureZonesState = {
      symbol: "BTCUSDT",
      orderBlocks: [
        {
          id: "ob1",
          direction: "bullish",
          low: 95,
          high: 97,
          createdAt: 10,
          invalidated: false,
          definition: "test",
        },
        {
          id: "ob2",
          direction: "bearish",
          low: 130,
          high: 132,
          createdAt: 11,
          invalidated: true,
          definition: "test",
        },
      ],
      fairValueGaps: [],
      recentSweeps: [],
      evidence: [],
      updatedAt: 1,
    };
    const bands = detectChartBands({
      lastPrice: 110,
      tickSize: 0.01,
      zones,
      config: DEFAULT_CHART_ZONES_CONFIG,
    });
    assert.equal(bands.filter((b) => b.source === "order_block").length, 1);
    assert.equal(bands[0]!.kind, "demand");
  });

  it("merges overlapping bands preferring higher-priority source", () => {
    const merged = mergeOverlappingBands(
      [
        {
          id: "a",
          low: 100,
          high: 102,
          kind: "demand",
          source: "swing_cluster",
          strength: 0.4,
          createdAt: 1,
        },
        {
          id: "b",
          low: 101,
          high: 103,
          kind: "demand",
          source: "order_block",
          strength: 0.7,
          createdAt: 2,
        },
      ],
      0.01,
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.source, "order_block");
    assert.equal(merged[0]!.low, 100);
    assert.equal(merged[0]!.high, 103);
  });

  it("selects at most 2 demand and 2 supply nearest price", () => {
    const bands = [
      band(90, 91, "demand", 0.5),
      band(95, 96, "demand", 0.6),
      band(98, 99, "demand", 0.9),
      band(101, 102, "supply", 0.9),
      band(105, 106, "supply", 0.6),
      band(110, 111, "supply", 0.5),
    ];
    const picked = selectNearestBands(bands, 100, 2, 2);
    assert.equal(picked.filter((b) => b.kind === "demand").length, 2);
    assert.equal(picked.filter((b) => b.kind === "supply").length, 2);
    assert.ok(picked.some((b) => b.low === 98));
    assert.ok(picked.some((b) => b.low === 101));
  });

  it("buildChartOverlay uses window trades when coverage is rich", () => {
    const candles = [candle(0, 100, 101, 99, 100.5), candle(1, 100.5, 110, 100, 105)];
    const trades: TradeTick[] = [];
    for (let i = 0; i < 24; i++) {
      trades.push(trade(100 + (i % 12), 2, candles[0]!.openTime + i * 1000));
    }
    const overlay = buildChartOverlay({
      symbol: "BTCUSDT",
      lastPrice: 105,
      tickSize: 1,
      trades,
      candles,
      sessionProfile: null,
      structure: null,
      zones: null,
      config: { minWindowTradeLevels: 8, minWindowVolume: 1 },
    });
    assert.ok(overlay.poc != null, `expected poc, got ${overlay.poc}`);
    assert.ok(overlay.profileFrom != null);
    assert.ok(overlay.evidence.length > 0);
  });
});

function band(low: number, high: number, kind: "demand" | "supply", strength: number) {
  return {
    id: `${low}-${high}`,
    low,
    high,
    kind,
    source: "hvn_cluster" as const,
    strength,
    createdAt: 1,
  };
}

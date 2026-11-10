import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "@of/shared";
import { backtestSignalEngine } from "./backtest.js";

function candleSeries(count: number, start = 100, step = 0.4): Candle[] {
  const out: Candle[] = [];
  let price = start;
  const t0 = Date.UTC(2024, 0, 1);
  for (let i = 0; i < count; i++) {
    const open = price;
    price = price + step;
    const high = Math.max(open, price) + 0.2;
    const low = Math.min(open, price) - 0.2;
    out.push({
      symbol: "BTCUSDT",
      interval: "15m",
      openTime: t0 + i * 900_000,
      open,
      high,
      low,
      close: price,
      volume: 10 + i,
      closeTime: t0 + i * 900_000 + 899_999,
    });
  }
  return out;
}

describe("backtestSignalEngine", () => {
  it("returns null winRate when no closed TP/SL trades", () => {
    const candles = candleSeries(80, 100, 0);
    const result = backtestSignalEngine("BTCUSDT", candles, [], undefined, {
      feeBps: 4,
      slippageBps: 1,
      warmupBars: 60,
      maxHoldBars: 5,
      primaryInterval: "15m",
      structureOnlyMode: true,
    });
    assert.equal(result.signalsEvaluated > 0, true);
    assert.ok(result.limitation.includes("structureOnlyMode=true"));
    if (result.trades.filter((t) => t.outcome === "HIT_TP" || t.outcome === "HIT_SL").length === 0) {
      assert.equal(result.winRate, null);
    }
  });

  it("applies fees/slippage and never fabricates a positive edge claim", () => {
    const primary = candleSeries(120, 100, 0.5);
    const h1 = candleSeries(120, 100, 0.5).map((c) => ({
      ...c,
      interval: "1h",
      symbol: "BTCUSDT",
    }));
    const result = backtestSignalEngine(
      "BTCUSDT",
      primary,
      [{ interval: "1h", candles: h1 }],
      undefined,
      {
        feeBps: 4,
        slippageBps: 1,
        warmupBars: 60,
        maxHoldBars: 12,
        primaryInterval: "15m",
        structureOnlyMode: true,
      },
    );
    assert.ok(result.limitation.includes("not a proven live edge"));
    for (const trade of result.trades) {
      assert.ok(trade.fees >= 0);
      assert.ok(trade.entry > 0 && trade.exit > 0);
    }
    // Infinity is allowed mathematically; API layer nulls it for JSON.
    if (result.trades.length === 0) {
      assert.equal(result.expectancy, null);
      assert.equal(result.winRate, null);
    }
  });
});

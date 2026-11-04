import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TradeTick } from "@of/shared";
import { buildFootprintBar } from "./footprint.js";

function trade(
  price: number,
  quantity: number,
  buyerAggressor: boolean,
  i: number,
): TradeTick {
  return {
    exchange: "binance",
    symbol: "BTCUSDT",
    tradeId: String(i),
    price,
    quantity,
    buyerAggressor,
    aggressorSource: "exchange_flag",
    timestamp: 1_000 + i,
  };
}

describe("buildFootprintBar", () => {
  it("aggregates bid/ask volume and delta by tick", () => {
    const trades = [
      trade(100, 2, true, 1),
      trade(100, 1, false, 2),
      trade(101, 3, true, 3),
    ];
    const bar = buildFootprintBar("BTCUSDT", trades, 0, 10, { tickSize: 1 });
    assert.ok(bar);
    assert.equal(bar!.totalVolume, 6);
    assert.equal(bar!.totalDelta, 2 - 1 + 3);
    const cell100 = bar!.cells.find((c) => c.price === 100);
    assert.ok(cell100);
    assert.equal(cell100!.askVolume, 2);
    assert.equal(cell100!.bidVolume, 1);
  });

  it("returns null for empty trades", () => {
    assert.equal(buildFootprintBar("BTCUSDT", [], 0, 1, { tickSize: 0.1 }), null);
  });
});

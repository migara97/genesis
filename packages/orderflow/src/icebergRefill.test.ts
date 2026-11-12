import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OrderBookSnapshot } from "@of/shared";
import { detectIcebergRefill, resetIcebergHistory } from "./icebergRefill.js";

function book(
  symbol: string,
  bids: [number, number][],
  asks: [number, number][],
  ts: number,
): OrderBookSnapshot {
  return {
    exchange: "test",
    symbol,
    timestamp: ts,
    lastUpdateId: ts,
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    asks: asks.map(([price, quantity]) => ({ price, quantity })),
  };
}

describe("detectIcebergRefill", () => {
  it("flags repeated refill at same bid price with confidence band", () => {
    resetIcebergHistory();
    const sym = "BTCUSDT";
    // Seed
    detectIcebergRefill(book(sym, [[100, 10]], [[101, 5]], 1));
    // Pull
    detectIcebergRefill(book(sym, [[100, 2]], [[101, 5]], 2));
    // Refill #1
    detectIcebergRefill(book(sym, [[100, 9]], [[101, 5]], 3));
    // Pull again
    detectIcebergRefill(book(sym, [[100, 2]], [[101, 5]], 4));
    // Refill #2
    const out = detectIcebergRefill(book(sym, [[100, 10]], [[101, 5]], 5));
    assert.equal(out.side, "bid");
    assert.ok(out.refillCount >= 2);
    assert.ok(out.confidence > 0);
    assert.equal(out.evidence[0]?.kind, "heuristic");
  });

  it("returns none when history is empty", () => {
    resetIcebergHistory();
    const out = detectIcebergRefill(book("ETHUSDT", [[1, 1]], [[2, 1]], 1));
    assert.equal(out.side, "none");
    assert.equal(out.confidence, 0);
  });
});

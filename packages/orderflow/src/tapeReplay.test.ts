import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Candle, TradeTick } from "@of/shared";
import { replayTapeOrderFlow } from "./tapeReplay.js";
import { compareLiveToReplay } from "./validation/parity.js";

function tick(
  i: number,
  price: number,
  buyer: boolean,
  ts: number,
): TradeTick {
  return {
    exchange: "okx",
    symbol: "BTC-USDT-SWAP",
    tradeId: `t${i}`,
    price,
    quantity: 1,
    buyerAggressor: buyer,
    aggressorSource: "exchange_flag",
    timestamp: ts,
  };
}

function candles(start: number, n: number, step: number, base = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const openTime = start + i * step;
    const open = base + i * 0.1;
    out.push({
      symbol: "BTC-USDT-SWAP",
      interval: "5m",
      openTime,
      open,
      high: open + 1,
      low: open - 1,
      close: open + 0.2,
      volume: 10,
      closeTime: openTime + step - 1,
    });
  }
  return out;
}

describe("tapeReplayOrderFlow", () => {
  it("processes ticks into CVD/footprint path without throwing", () => {
    const start = Date.UTC(2024, 0, 1);
    const ticks: TradeTick[] = [];
    for (let i = 0; i < 80; i++) {
      ticks.push(tick(i, 100 + (i % 5) * 0.1, i % 2 === 0, start + i * 1000));
    }
    const primary = candles(start - 60 * 60_000, 80, 5 * 60_000);
    const result = replayTapeOrderFlow(
      "BTC-USDT-SWAP",
      ticks,
      [
        { interval: "5m", candles: primary },
        { interval: "1m", candles: candles(start - 60 * 60_000, 120, 60_000) },
        { interval: "1h", candles: candles(start - 7 * 24 * 60_000, 40, 60 * 60_000) },
        { interval: "4h", candles: candles(start - 14 * 24 * 60_000, 30, 4 * 60 * 60_000) },
        { interval: "1d", candles: candles(start - 60 * 24 * 60_000, 40, 24 * 60 * 60_000) },
        { interval: "15m", candles: candles(start - 3 * 24 * 60_000, 80, 15 * 60_000) },
      ],
      { tickSize: 0.1, footprintIntervalMs: 10_000, signalRescoreEveryTrades: 5 },
    );
    assert.equal(result.ticksProcessed, 80);
    assert.ok(result.signalsEvaluated > 0);
    assert.ok(result.inputsMissing.includes("dom"));
    assert.ok(/DOM/i.test(result.limitation));
    assert.equal(result.inputsUsed.includes("footprint"), true);
  });

  it("returns empty result for empty tape", () => {
    const result = replayTapeOrderFlow("BTC-USDT-SWAP", [], []);
    assert.equal(result.ticksProcessed, 0);
    assert.equal(result.trades.length, 0);
  });
});

describe("compareLiveToReplay", () => {
  it("matches by setupId and reports outcome agreement", () => {
    const report = compareLiveToReplay(
      [
        {
          setupId: "abc",
          direction: "LONG",
          outcome: "HIT_TP",
          openedAt: 1000,
          closedAt: 2000,
          entry: 100,
          confidence: 0.6,
        },
      ],
      [
        {
          setupId: "abc",
          entryTime: 1000,
          exitTime: 2000,
          side: "LONG",
          entry: 100.1,
          exit: 101,
          outcome: "HIT_TP",
          confirmations: [],
          confidence: 0.6,
          ofSnapshot: { cvd: 1, footprintDelta: 1, poc: 100 },
        },
      ],
    );
    assert.equal(report.matched, 1);
    assert.equal(report.outcomeAgree, 1);
    assert.equal(report.outcomeAgreeRate, 1);
  });

  it("leaves unmatched live when no replay overlap", () => {
    const report = compareLiveToReplay(
      [
        {
          setupId: "only-live",
          direction: "SHORT",
          outcome: "HIT_SL",
          openedAt: 1,
          closedAt: 2,
          entry: 50,
          confidence: 0.4,
        },
      ],
      [],
    );
    assert.equal(report.matched, 0);
    assert.equal(report.unmatchedLive, 1);
    assert.ok(/No matched/i.test(report.sampleNote));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCalibration,
  computePerformance,
  groupByKey,
  wilsonInterval,
} from "./analytics.js";
import { computeCostedPnl } from "./costModel.js";
import { resolvePathExit } from "./pathExit.js";
import type { ClosedTradeSample } from "./analytics.js";

function sample(partial: Partial<ClosedTradeSample> & { setupId: string }): ClosedTradeSample {
  return {
    symbol: "BTCUSDT",
    side: "LONG",
    outcome: "HIT_TP",
    isResolvedWinLoss: true,
    won: true,
    netPnl: 1,
    grossPnl: 1.1,
    fees: 0.1,
    funding: 0,
    rMultiple: 1,
    confidence: 0.6,
    holdMs: 1000,
    mfe: 1,
    mae: -0.2,
    regimeTags: [],
    setupClass: "OTHER",
    primaryTimeframe: "5m",
    ...partial,
  };
}

describe("validation analytics", () => {
  it("wilson interval is undefined for n=0 and narrows with n", () => {
    assert.equal(wilsonInterval(0, 0), null);
    const small = wilsonInterval(1, 1)!;
    const large = wilsonInterval(50, 100)!;
    assert.ok(small.high - small.low > large.high - large.low);
  });

  it("does not treat unresolved as wins or losses", () => {
    const samples: ClosedTradeSample[] = [
      {
        setupId: "a",
        symbol: "BTCUSDT",
        side: "LONG",
        outcome: "HIT_TP",
        isResolvedWinLoss: true,
        won: true,
        netPnl: 1,
        grossPnl: 1.1,
        fees: 0.1,
        funding: 0,
        rMultiple: 1.5,
        confidence: 0.6,
        holdMs: 1000,
        mfe: 1.2,
        mae: -0.2,
        regimeTags: ["bullish_trend"],
      },
      {
        setupId: "b",
        symbol: "BTCUSDT",
        side: "LONG",
        outcome: "TIMEOUT",
        isResolvedWinLoss: false,
        won: null,
        netPnl: -0.5,
        grossPnl: -0.4,
        fees: 0.1,
        funding: 0,
        rMultiple: -0.5,
        confidence: 0.55,
        holdMs: 2000,
        mfe: 0.1,
        mae: -0.6,
        regimeTags: ["sideways"],
      },
    ];
    const report = computePerformance(samples, 3);
    assert.equal(report.closedTrades, 1);
    assert.equal(report.winningTrades, 1);
    assert.equal(report.winRate, 1);
    assert.equal(report.openOrUnresolved, 3);
    assert.ok(report.sampleNote.includes("resolved TP/SL"));
  });

  it("calibration refuses sufficiency on tiny samples", () => {
    const cal = computeCalibration([]);
    assert.equal(cal.sufficient, false);
    assert.ok(/Insufficient/i.test(cal.sampleNote));
  });

  it("groupByKey stratifies break/retest and TF", () => {
    const samples = [
      sample({
        setupId: "br",
        setupClass: "RANGE_BREAK_RETEST",
        primaryTimeframe: "5m",
        netPnl: 2,
        fees: 0.2,
      }),
      sample({
        setupId: "ot",
        setupClass: "OTHER",
        primaryTimeframe: "15m",
        netPnl: -1,
        won: false,
        outcome: "HIT_SL",
      }),
    ];
    const byClass = groupByKey(samples, (s) => s.setupClass);
    assert.equal(byClass.RANGE_BREAK_RETEST?.closedTrades, 1);
    assert.equal(byClass.RANGE_BREAK_RETEST?.expectancy, 2);
    assert.equal(byClass.OTHER?.closedTrades, 1);
    const byTf = groupByKey(samples, (s) => s.primaryTimeframe);
    assert.equal(byTf["5m"]?.closedTrades, 1);
    assert.equal(byTf["15m"]?.closedTrades, 1);
  });
});

describe("cost + path exit", () => {
  it("applies fees and adverse slippage", () => {
    const c = computeCostedPnl({
      side: "LONG",
      entry: 100,
      exit: 101,
      stopLoss: 99,
      openedAt: 0,
      closedAt: 3_600_000,
      config: { feeBps: 10, slippageBps: 10, fundingRatePer8h: 0 },
    });
    assert.ok(c.entryFill > 100);
    assert.ok(c.exitFill < 101);
    assert.ok(c.feesPerUnit > 0);
    assert.ok(c.netPnlPerUnit < c.grossPnlPerUnit);
  });

  it("uses sl_first on same-bar ambiguity", () => {
    const r = resolvePathExit({
      side: "LONG",
      entry: 100,
      stopLoss: 99,
      takeProfit1: 101,
      bar: { open: 100, high: 102, low: 98, close: 100.5, openTime: 1, closeTime: 2 },
      policy: "sl_first",
    });
    assert.equal(r.hit, "HIT_SL");
    assert.equal(r.ambiguousSameBar, true);
  });
});

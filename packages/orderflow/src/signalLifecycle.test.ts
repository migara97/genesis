import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSignal, STANDARD_SIGNAL_CONFIG } from "./signals.js";
import { applySignalLifecycle, DEFAULT_LIFECYCLE_CONFIG } from "./signalLifecycle.js";
import type { SignalInput } from "./signals.js";
import type { TradingSignal } from "@of/shared";

const std = STANDARD_SIGNAL_CONFIG;

function longInput(price = 95): SignalInput {
  return {
    symbol: "BTCUSDT",
    lastPrice: price,
    timestamp: 1_000,
    structure: {
      symbol: "BTCUSDT",
      trend: "bullish",
      swings: [],
      support: [90],
      resistance: [110],
      liquidityPools: [],
      evidence: [],
    },
    cvd: {
      symbol: "BTCUSDT",
      sessionStart: 1,
      cvd: 500,
      points: [],
      divergence: "bullish",
      exhaustion: false,
      evidence: [],
    },
    footprint: {
      symbol: "BTCUSDT",
      openTime: 0,
      closeTime: 1,
      open: 94,
      high: 96,
      low: 93,
      close: price,
      cells: [],
      totalDelta: 200,
      totalVolume: 400,
      imbalances: [
        { price: 94, side: "ask", ratio: 4, stacked: true, diagonal: false },
        { price: 94.5, side: "ask", ratio: 4, stacked: true, diagonal: false },
        { price: 95, side: "ask", ratio: 4, stacked: true, diagonal: false },
      ],
      absorption: false,
      exhaustion: false,
      unfinishedAuction: false,
      evidence: [],
    },
    volumeProfile: {
      symbol: "BTCUSDT",
      from: 0,
      to: 1,
      tickSize: 0.1,
      levels: [],
      poc: 100,
      vah: 105,
      val: 96,
      hvn: [],
      lvn: [],
      totalVolume: 1,
    },
  };
}

describe("applySignalLifecycle", () => {
  it("marks first directional print as CONFIRMED then suppresses duplicate as ACTIVE", () => {
    const first = generateSignal({ ...longInput(95), timestamp: 1_000 }, std);
    assert.equal(first.direction, "LONG");
    const confirmed = applySignalLifecycle(undefined, first, 95, 1_000);
    assert.equal(confirmed.lifecycle, "CONFIRMED");

    const second = generateSignal({ ...longInput(95.2), timestamp: 2_000 }, std);
    const active = applySignalLifecycle(confirmed, second, 95.2, 2_000);
    assert.equal(active.setupId, confirmed.setupId);
    assert.equal(active.lifecycle, "ACTIVE");
    assert.equal(active.entry, confirmed.entry);
  });

  it("marks HIT_SL when price crosses stop", () => {
    const signal = generateSignal({ ...longInput(95), timestamp: 1_000 }, std);
    const confirmed = applySignalLifecycle(undefined, signal, 95, 1_000);
    const stopped = applySignalLifecycle(confirmed, signal, confirmed.stopLoss! - 0.01, 2_000);
    assert.equal(stopped.lifecycle, "HIT_SL");
  });

  it("marks HIT_TP when price reaches first take-profit (legacy fullCloseAtTp1)", () => {
    const signal = generateSignal({ ...longInput(95), timestamp: 1_000 }, std);
    const confirmed = applySignalLifecycle(undefined, signal, 95, 1_000);
    const tp = confirmed.takeProfit![0]!;
    const hit = applySignalLifecycle(confirmed, signal, tp + 0.01, 2_000, {
      ...DEFAULT_LIFECYCLE_CONFIG,
      scaleOut: { enabled: true, fractions: [0.5, 0.3, 0.2], fullCloseAtTp1: true },
    });
    assert.equal(hit.lifecycle, "HIT_TP");
  });

  it("scales out at TP1/TP2 then HIT_TP at TP3", () => {
    const signal = generateSignal({ ...longInput(95), timestamp: 1_000 }, std);
    let state = applySignalLifecycle(undefined, signal, 95, 1_000);
    const tps = state.takeProfit ?? [];
    assert.ok(tps.length >= 3, "fixture needs 3 TPs");

    state = applySignalLifecycle(state, signal, tps[0]! + 0.01, 2_000);
    assert.equal(state.lifecycle, "ACTIVE");
    assert.equal(state.tpHits, 1);
    assert.ok((state.scaleRemainingFrac ?? 1) < 1);
    assert.match(state.lifecycleNote ?? "", /SCALE_TP1/);

    state = applySignalLifecycle(state, signal, tps[1]! + 0.01, 3_000);
    assert.equal(state.lifecycle, "ACTIVE");
    assert.equal(state.tpHits, 2);

    state = applySignalLifecycle(state, signal, tps[2]! + 0.01, 4_000);
    assert.equal(state.lifecycle, "HIT_TP");
    assert.equal(state.tpHits, 3);
    assert.equal(state.scaleRemainingFrac, 0);
  });

  it("tags structure target hits without forcing HIT_TP", () => {
    const signal = generateSignal({ ...longInput(95), timestamp: 1_000 }, std);
    const confirmed = applySignalLifecycle(undefined, signal, 95, 1_000);
    const tp1 = confirmed.takeProfit![0]!;
    // Place structure target between entry and TP1 so a touch is not a risk-TP exit.
    const mid = (confirmed.entry! + tp1) / 2;
    const withTargets: TradingSignal = {
      ...confirmed,
      structureTargets: [
        {
          id: "t1",
          kind: "prior_swing",
          price: mid,
          label: `swing ${mid}`,
          distancePct: (mid - confirmed.entry!) / confirmed.entry!,
        },
      ],
    };
    const active = applySignalLifecycle(withTargets, withTargets, mid + 0.001, 1_500);
    assert.equal(active.lifecycle, "ACTIVE");
    assert.ok(active.structureTargets?.[0]?.hitAt === 1_500);
    assert.match(active.lifecycleNote ?? "", /Structure swing touched/);
    assert.ok(mid + 0.001 < tp1, "fixture must stay below TP1");
  });

  it("invalidates when confirmations drop to WAIT", () => {
    const signal = generateSignal({ ...longInput(95), timestamp: 1_000 }, std);
    const confirmed = applySignalLifecycle(undefined, signal, 95, 1_000);
    const wait = generateSignal(
      {
        symbol: "BTCUSDT",
        lastPrice: 95,
        timestamp: 2_000,
      },
      std,
    );
    const invalidated = applySignalLifecycle(confirmed, wait, 95, 2_000);
    assert.equal(invalidated.lifecycle, "INVALIDATED");
    assert.equal(invalidated.setupId, confirmed.setupId);
  });

  it("holds terminal state to suppress immediate duplicate re-alerts", () => {
    const signal = generateSignal({ ...longInput(95), timestamp: 1_000 }, std);
    const confirmed = applySignalLifecycle(undefined, signal, 95, 1_000);
    const stopped = applySignalLifecycle(confirmed, signal, confirmed.stopLoss! - 1, 2_000);
    assert.equal(stopped.lifecycle, "HIT_SL");

    const again = generateSignal({ ...longInput(95), timestamp: 2_500 }, std);
    const held = applySignalLifecycle(
      stopped,
      again,
      95,
      2_500,
      DEFAULT_LIFECYCLE_CONFIG,
    );
    assert.equal(held.lifecycle, "HIT_SL");
    assert.equal(held.setupId, stopped.setupId);
  });

  it("invalidates on opposing CHoCH warning while ACTIVE", () => {
    const signal = generateSignal({ ...longInput(95), timestamp: 1_000 }, std);
    let state: TradingSignal = applySignalLifecycle(undefined, signal, 95, 1_000);
    state = applySignalLifecycle(state, signal, 95.1, 1_500);
    assert.equal(state.lifecycle, "ACTIVE");

    const withChoch = generateSignal(
      {
        ...longInput(95.2),
        timestamp: 2_000,
        structure: {
          ...longInput().structure!,
          trend: "bullish",
          lastChoch: { direction: "bearish", price: 94, timestamp: 1_900 },
        },
      },
      std,
    );
    // Force same setupId path by copying setup id onto a directional candidate with choch against
    const candidate: TradingSignal = {
      ...withChoch,
      setupId: state.setupId,
      id: state.setupId,
      direction: "LONG",
      entry: state.entry,
      stopLoss: state.stopLoss,
      takeProfit: state.takeProfit,
    };
    const invalidated = applySignalLifecycle(state, candidate, 95.2, 2_000);
    assert.equal(invalidated.lifecycle, "INVALIDATED");
  });
});

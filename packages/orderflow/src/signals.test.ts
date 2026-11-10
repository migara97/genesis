import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SIGNAL_CONFIG, STANDARD_SIGNAL_CONFIG, generateSignal } from "./signals.js";
import type { SignalInput } from "./signals.js";

const std = STANDARD_SIGNAL_CONFIG;

function baseLongInput(): SignalInput {
  return {
    symbol: "BTCUSDT",
    lastPrice: 95,
    timestamp: Date.now(),
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
      sessionStart: Date.now(),
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
      close: 95,
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

describe("generateSignal", () => {
  it("returns WAIT without multi-confirmations", () => {
    const signal = generateSignal({
      symbol: "BTCUSDT",
      lastPrice: 100,
      timestamp: Date.now(),
    }, std);
    assert.equal(signal.direction, "WAIT");
    assert.equal(signal.entryGrade, "WAIT");
    assert.ok(signal.score.longScore === 0);
    assert.ok(signal.setupId.length === 16);
    assert.equal(signal.id, signal.setupId);
  });

  it("can produce LONG with structure + CVD + footprint confirmations", () => {
    const signal = generateSignal(baseLongInput(), std);
    assert.equal(signal.direction, "LONG");
    assert.equal(signal.entryGrade, "STANDARD");
    assert.ok(signal.confirmations.length >= 2);
    assert.ok(signal.score.longScore >= signal.score.shortScore + 1);
    assert.ok(signal.score.independentFamilies.includes("structure"));
    assert.ok(signal.score.factors.some((f) => f.id === "structure_bullish"));
    assert.ok(signal.score.modelNote.includes("not a calibrated win probability"));
  });

  it("can produce SHORT with mirrored bearish inputs", () => {
    const input = baseLongInput();
    input.lastPrice = 110;
    input.structure = {
      ...input.structure!,
      trend: "bearish",
    };
    input.cvd = {
      ...input.cvd!,
      cvd: -500,
      divergence: "bearish",
    };
    input.footprint = {
      ...input.footprint!,
      totalDelta: -200,
      imbalances: [
        { price: 109, side: "bid", ratio: 4, stacked: true, diagonal: false },
        { price: 109.5, side: "bid", ratio: 4, stacked: true, diagonal: false },
        { price: 110, side: "bid", ratio: 4, stacked: true, diagonal: false },
      ],
    };
    input.volumeProfile = {
      ...input.volumeProfile!,
      val: 90,
      vah: 108,
      poc: 100,
    };
    const signal = generateSignal(input, std);
    assert.equal(signal.direction, "SHORT");
    assert.ok(signal.score.shortScore >= signal.score.longScore + 1);
  });

  it("keeps setupId stable for identical decision inputs", () => {
    const a = generateSignal({ ...baseLongInput(), timestamp: 1 }, std);
    const b = generateSignal({ ...baseLongInput(), timestamp: 2 }, std);
    assert.equal(a.setupId, b.setupId);
    assert.equal(a.direction, b.direction);
  });

  it("does not promote DOM-only pressure to LONG/SHORT", () => {
    const signal = generateSignal({
      symbol: "BTCUSDT",
      lastPrice: 100,
      timestamp: Date.now(),
      dom: {
        symbol: "BTCUSDT",
        timestamp: Date.now(),
        bestBid: 99.9,
        bestAsk: 100.1,
        mid: 100,
        spread: 0.2,
        imbalance: 0.5,
        bidLiquidity: 10,
        askLiquidity: 1,
        largeBidLevels: [],
        largeAskLevels: [],
        pullStackHint: "none",
        spoofingRisk: "low",
        evidence: [],
      },
    }, std);
    assert.equal(signal.direction, "WAIT");
    // Phase 3: DOM without trade delta does not confirm order flow.
    assert.equal(signal.orderFlowOk, false);
    assert.ok(signal.score.factors.some((f) => f.id === "dom_bid_unconfirmed"));
    assert.ok(signal.score.independentFamilies.length < DEFAULT_SIGNAL_CONFIG.minIndependent);
  });

  it("counts DOM only when trade delta supports the same side", () => {
    const signal = generateSignal({
      symbol: "BTCUSDT",
      lastPrice: 95,
      timestamp: Date.now(),
      structure: {
        symbol: "BTCUSDT",
        trend: "bullish",
        swings: [],
        support: [],
        resistance: [],
        liquidityPools: [],
        evidence: [],
      },
      footprint: {
        symbol: "BTCUSDT",
        openTime: 0,
        closeTime: 1,
        open: 94,
        high: 96,
        low: 93,
        close: 95,
        cells: [],
        totalDelta: 50,
        totalVolume: 100,
        imbalances: [],
        absorption: false,
        exhaustion: false,
        unfinishedAuction: false,
        evidence: [],
      },
      dom: {
        symbol: "BTCUSDT",
        timestamp: Date.now(),
        bestBid: 94.9,
        bestAsk: 95.1,
        mid: 95,
        spread: 0.2,
        imbalance: 0.4,
        bidLiquidity: 20,
        askLiquidity: 5,
        largeBidLevels: [],
        largeAskLevels: [],
        pullStackHint: "none",
        spoofingRisk: "low",
        evidence: [],
      },
    }, std);
    assert.ok(signal.score.factors.some((f) => f.id === "dom_bid_pressure"));
    assert.equal(signal.orderFlowOk, true);
  });

  it("scores aligned BOS and warns on conflicting CHoCH", () => {
    const aligned = generateSignal(
      {
        ...baseLongInput(),
        structure: {
          ...baseLongInput().structure!,
          lastBos: { direction: "bullish", price: 94, timestamp: 1 },
        },
      },
      std,
    );
    assert.ok(aligned.score.factors.some((f) => f.id === "structure_bos_bullish"));

    const conflict = generateSignal(
      {
        ...baseLongInput(),
        structure: {
          ...baseLongInput().structure!,
          lastChoch: { direction: "bearish", price: 96, timestamp: 2 },
        },
      },
      std,
    );
    assert.ok(conflict.score.factors.some((f) => f.id === "structure_choch_warning"));
  });

  it("adds LVN continuation when structure agrees", () => {
    const signal = generateSignal(
      {
        ...baseLongInput(),
        lastPrice: 100,
        volumeProfile: {
          ...baseLongInput().volumeProfile!,
          poc: 99,
          vah: 110,
          val: 90,
          hvn: [99],
          lvn: [100],
        },
      },
      std,
    );
    assert.ok(signal.score.factors.some((f) => f.id === "lvn_bullish_continuation"));
    assert.equal(signal.volumeOk, true);
  });

  it("exposes evidence tags distinguishing heuristic vs derived inputs", () => {
    const signal = generateSignal(baseLongInput(), std);
    assert.ok(signal.evidence.length > 0);
    assert.ok(signal.evidence.some((e) => e.kind === "inferred" || e.kind === "heuristic"));
    assert.ok(signal.score.factors.every((f) => f.source && f.family && f.reason));
  });

  it("still WAITs when scores exist but independent families are insufficient", () => {
    const signal = generateSignal({
      symbol: "BTCUSDT",
      lastPrice: 100,
      timestamp: Date.now(),
      structure: {
        symbol: "BTCUSDT",
        trend: "bullish",
        swings: [],
        support: [],
        resistance: [],
        liquidityPools: [],
        evidence: [],
      },
    }, std);
    assert.equal(signal.direction, "WAIT");
    assert.equal(signal.structureOk, true);
    assert.ok(signal.confidence <= DEFAULT_SIGNAL_CONFIG.waitConfidenceCap + 1e-9);
  });

  it("scores higher-TF bullish alignment and 5m soft confirm", () => {
    const signal = generateSignal(
      {
        ...baseLongInput(),
        mtf: {
          primaryInterval: "15m",
          frames: [
            { interval: "1d", trend: "bullish" },
            { interval: "4h", trend: "bullish" },
            { interval: "1h", trend: "range" },
            { interval: "15m", trend: "bullish" },
            { interval: "5m", trend: "bullish" },
          ],
          higherTfBullish: 2,
          higherTfBearish: 0,
          higherTfRange: 1,
          conflictWithPrimary: false,
          updatedAt: 1,
        },
      },
      std,
    );
    assert.ok(signal.score.factors.some((f) => f.id === "mtf_htf_bullish"));
    assert.ok(signal.score.factors.some((f) => f.id === "mtf_ltf_bullish"));
    assert.equal(signal.structureOk, true);
  });

  it("flags MTF conflict when higher TFs oppose primary", () => {
    const signal = generateSignal(
      {
        ...baseLongInput(),
        mtf: {
          primaryInterval: "15m",
          frames: [
            { interval: "1d", trend: "bearish" },
            { interval: "4h", trend: "bearish" },
            { interval: "1h", trend: "bearish" },
            { interval: "15m", trend: "bullish" },
            { interval: "5m", trend: "range" },
          ],
          higherTfBullish: 0,
          higherTfBearish: 3,
          higherTfRange: 0,
          conflictWithPrimary: true,
          updatedAt: 1,
        },
      },
      std,
    );
    assert.ok(signal.score.factors.some((f) => f.id === "mtf_htf_conflict"));
    assert.ok(signal.score.factors.some((f) => f.id === "mtf_htf_bearish"));
    assert.ok(signal.reasonsAgainst.some((r) => /conflict/i.test(r)));
  });

  it("scores price inside bullish OB/FVG and recent SSL sweep", () => {
    const signal = generateSignal(
      {
        ...baseLongInput(),
        lastPrice: 100,
        zones: {
          symbol: "BTCUSDT",
          orderBlocks: [
            {
              id: "ob1",
              direction: "bullish",
              low: 99,
              high: 101,
              createdAt: 1,
              invalidated: false,
              definition: "Bullish OB test rule",
            },
          ],
          fairValueGaps: [
            {
              id: "fvg1",
              direction: "bullish",
              low: 99.5,
              high: 100.5,
              createdAt: 1,
              mitigated: false,
              definition: "Bullish FVG test rule",
            },
          ],
          recentSweeps: [
            {
              id: "sw1",
              side: "SSL",
              level: 98,
              sweepPrice: 97.5,
              closePrice: 99,
              timestamp: Date.now(),
              bias: "bullish",
              definition: "SSL sweep test rule",
            },
          ],
          evidence: [],
          updatedAt: Date.now(),
        },
      },
      std,
    );
    assert.ok(signal.score.factors.some((f) => f.id === "ob_bullish_zone" && f.source === "heuristic"));
    assert.ok(signal.score.factors.some((f) => f.id === "fvg_bullish_zone" && f.source === "heuristic"));
    assert.ok(signal.score.factors.some((f) => f.id === "sweep_ssl_reclaim" && f.source === "heuristic"));
  });

  it("A+ demotes standard LONG without HTF/location to WAIT", () => {
    const signal = generateSignal(baseLongInput()); // default a_plus
    assert.equal(signal.direction, "WAIT");
    assert.equal(signal.entryGrade, "WAIT");
    assert.ok(signal.score.factors.some((f) => f.id === "a_plus_gate_failed"));
    assert.ok((signal.entryQualityNotes ?? []).some((n) => /MTF|Location|HTF/i.test(n)));
  });

  it("A+ confirms LONG when HTF + OF + location align", () => {
    const signal = generateSignal({
      ...baseLongInput(),
      lastPrice: 95.2,
      mtf: {
        primaryInterval: "15m",
        frames: [
          { interval: "1d", trend: "bullish" },
          { interval: "4h", trend: "bullish" },
          { interval: "1h", trend: "bullish" },
          { interval: "15m", trend: "bullish" },
          { interval: "5m", trend: "bullish" },
        ],
        higherTfBullish: 3,
        higherTfBearish: 0,
        higherTfRange: 0,
        conflictWithPrimary: false,
        updatedAt: 1,
      },
      zones: {
        symbol: "BTCUSDT",
        orderBlocks: [
          {
            id: "ob1",
            direction: "bullish",
            low: 94.5,
            high: 95.5,
            createdAt: 1,
            invalidated: false,
            definition: "Bullish OB",
          },
        ],
        fairValueGaps: [],
        recentSweeps: [],
        evidence: [],
        updatedAt: 1,
      },
    });
    assert.equal(signal.direction, "LONG");
    assert.equal(signal.entryGrade, "A+");
    assert.ok((signal.entryQualityNotes ?? []).some((n) => /HTF permission OK/i.test(n)));
    assert.ok((signal.entryQualityNotes ?? []).some((n) => /Location OK/i.test(n)));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BreakRetestState, MarketStructureState, VolumeProfile } from "@of/shared";
import { buildStructureTargets, tagStructureTargetHits } from "./structureTargets.js";

function brAccepted(): BreakRetestState {
  return {
    symbol: "BTCUSDT",
    phase: "accepted",
    side: "bullish",
    bandId: "s1",
    bandLow: 102,
    bandHigh: 104,
    oppositeBandId: "d1",
    oppositeLow: 96,
    oppositeHigh: 98,
    reason: "accepted",
    evidence: [],
    updatedAt: 1,
  };
}

function structure(): MarketStructureState {
  return {
    symbol: "BTCUSDT",
    trend: "bullish",
    swings: [
      { price: 108, timestamp: 1, type: "HH", kind: "high" },
      { price: 112, timestamp: 2, type: "HH", kind: "high" },
      { price: 95, timestamp: 3, type: "LL", kind: "low" },
    ],
    support: [95],
    resistance: [108, 112],
    liquidityPools: [],
    previousSessionHigh: 115,
    previousSessionLow: 90,
    evidence: [],
  };
}

function profile(): VolumeProfile {
  return {
    symbol: "BTCUSDT",
    from: 1,
    to: 2,
    tickSize: 0.1,
    levels: [],
    poc: 100,
    vah: 106,
    val: 94,
    hvn: [106, 110],
    lvn: [99],
    totalVolume: 1,
  };
}

describe("structureTargets", () => {
  it("projects measured move from accepted break/retest corridor", () => {
    const targets = buildStructureTargets({
      side: "LONG",
      entry: 104.5,
      breakRetest: brAccepted(),
      tickSize: 0.1,
    });
    const mm = targets.find((t) => t.kind === "measured_move");
    assert.ok(mm, JSON.stringify(targets));
    // height = 104-96 = 8; project 104+8 = 112
    assert.equal(mm!.price, 112);
  });

  it("adds prior swing and session extreme beyond entry", () => {
    const targets = buildStructureTargets({
      side: "LONG",
      entry: 105,
      structure: structure(),
      tickSize: 0.1,
      config: { maxTargets: 3 },
    });
    assert.ok(targets.some((t) => t.kind === "prior_swing" && t.price === 108));
    assert.ok(targets.some((t) => t.kind === "session_extreme" && t.price === 115));
  });

  it("uses VAH as vp_node for longs when above entry", () => {
    const targets = buildStructureTargets({
      side: "LONG",
      entry: 100,
      volumeProfile: profile(),
      tickSize: 0.1,
    });
    assert.ok(targets.some((t) => t.kind === "vp_node" && t.price === 106));
  });

  it("filters wrong-side and far targets; caps at 3", () => {
    const targets = buildStructureTargets({
      side: "LONG",
      entry: 100,
      breakRetest: brAccepted(),
      structure: structure(),
      volumeProfile: profile(),
      tickSize: 0.1,
    });
    assert.ok(targets.length <= 3);
    assert.ok(targets.every((t) => t.price > 100));
    assert.ok(targets.every((t) => t.distancePct <= 0.15 + 1e-9));
  });

  it("dedupes near-identical prices keeping higher priority kind", () => {
    const targets = buildStructureTargets({
      side: "LONG",
      entry: 100,
      breakRetest: {
        ...brAccepted(),
        // Force MM to land near VAH 106: height 2 → 104+2=106
        bandLow: 103,
        bandHigh: 104,
        oppositeLow: 102,
        oppositeHigh: 102.5,
      },
      volumeProfile: { ...profile(), vah: 106.02, hvn: [106.02] },
      tickSize: 0.1,
      config: { dedupePct: 0.001 },
    });
    const near106 = targets.filter((t) => Math.abs(t.price - 106) < 0.2);
    assert.ok(near106.length <= 1);
    if (near106[0]) assert.equal(near106[0].kind, "measured_move");
  });

  it("tags structure hits without requiring caller to flip lifecycle", () => {
    const built = buildStructureTargets({
      side: "LONG",
      entry: 100,
      structure: structure(),
      tickSize: 0.1,
    });
    const { targets, newlyHit } = tagStructureTargetHits(built, "LONG", 108, 5_000);
    assert.ok(newlyHit.length >= 1);
    assert.ok(targets.some((t) => t.price === 108 && t.hitAt === 5_000));
    const again = tagStructureTargetHits(targets, "LONG", 108, 6_000);
    assert.equal(again.newlyHit.length, 0);
  });
});

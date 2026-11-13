import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCommentary } from "./commentary.js";
import type { TradingSignal } from "@of/shared";

function baseSignal(partial: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: "1",
    setupId: "1",
    symbol: "BTC",
    timestamp: 1,
    direction: "WAIT",
    confidence: 0.2,
    confirmations: [],
    reasonsFor: [],
    reasonsAgainst: ["Need more confirms"],
    invalidation: [],
    orderFlowOk: false,
    structureOk: false,
    volumeOk: false,
    deltaOk: false,
    score: {
      longScore: 0,
      shortScore: 0,
      neutralScore: 1,
      independentFamilies: [],
      factors: [],
      modelNote: "x",
    },
    evidence: [],
    entryGrade: "WAIT",
    lifecycle: "WATCHING",
    lifecycleUpdatedAt: 1,
    setupOpenedAt: 1,
    ...partial,
  };
}

describe("buildCommentary", () => {
  it("never claims score mutation and stays template-sourced", () => {
    const out = buildCommentary({
      signal: baseSignal(),
      iceberg: {
        symbol: "BTC",
        timestamp: 1,
        side: "bid",
        price: 100,
        refillCount: 3,
        confidence: 0.5,
        note: "Heuristic bid refill ×3",
        evidence: [],
      },
    });
    assert.equal(out.source, "template");
    assert.equal(out.mutatesScores, false);
    assert.ok(/WAIT/i.test(out.text));
    assert.ok(/Model score/i.test(out.text));
    assert.ok(/refill/i.test(out.text));
    assert.equal(out.evidence[0]?.kind, "heuristic");
  });

  it("cites independent families and up to three Watch reasons", () => {
    const out = buildCommentary({
      signal: baseSignal({
        direction: "SHORT",
        entryGrade: "A+",
        confidence: 0.95,
        confirmations: ["a", "b", "c", "d", "e", "f", "g", "h"],
        reasonsAgainst: ["No footprint", "Bid refill", "Thin room", "Extra ignore"],
        score: {
          longScore: 0,
          shortScore: 4,
          neutralScore: 1,
          independentFamilies: ["structure", "delta"],
          factors: [],
          modelNote: "x",
        },
      }),
    });
    assert.ok(/2 families \(structure, delta\)/.test(out.text));
    assert.ok(/Model score 95%/.test(out.text));
    assert.ok(/uncalibrated — not win probability/.test(out.text));
    assert.ok(!/8 confirmations/.test(out.text));
    assert.ok(/Watch: No footprint \| Bid refill \| Thin room/.test(out.text));
    assert.ok(!/Extra ignore/.test(out.text));
  });
});

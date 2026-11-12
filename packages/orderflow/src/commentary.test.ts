import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCommentary } from "./commentary.js";

describe("buildCommentary", () => {
  it("never claims score mutation and stays template-sourced", () => {
    const out = buildCommentary({
      signal: {
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
      },
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
    assert.ok(/refill/i.test(out.text));
    assert.equal(out.evidence[0]?.kind, "heuristic");
  });
});

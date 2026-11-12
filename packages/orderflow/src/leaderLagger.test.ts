import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLeaderLagger } from "./leaderLagger.js";

describe("computeLeaderLagger", () => {
  it("classifies a top mover as leader", () => {
    const report = computeLeaderLagger({
      focus: "FOCUS",
      peers: [
        { symbol: "FOCUS", changePct24h: 12, volume24h: 1e9 },
        { symbol: "A", changePct24h: 2, volume24h: 9e8 },
        { symbol: "B", changePct24h: 1, volume24h: 8e8 },
        { symbol: "C", changePct24h: -1, volume24h: 7e8 },
        { symbol: "D", changePct24h: -3, volume24h: 6e8 },
      ],
    });
    assert.equal(report.role, "leader");
    assert.ok(report.confidence > 0);
    assert.equal(report.evidence[0]?.kind, "heuristic");
  });

  it("returns unknown without peers", () => {
    const report = computeLeaderLagger({
      focus: "X",
      peers: [{ symbol: "X", changePct24h: 1, volume24h: 1 }],
    });
    assert.equal(report.role, "unknown");
  });
});

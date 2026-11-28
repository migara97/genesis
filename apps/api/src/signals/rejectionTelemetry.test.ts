import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TradingSignal } from "@of/shared";
import { classifyRejectionReasons } from "./rejectionTelemetry.js";

function waitSignal(partial: Partial<TradingSignal> & { reasonsAgainst?: string[]; entryQualityNotes?: string[] }): TradingSignal {
  return {
    id: "abc",
    setupId: "abc",
    symbol: "BTCUSDT",
    timestamp: Date.now(),
    direction: "WAIT",
    confidence: 0.2,
    confirmations: [],
    reasonsFor: [],
    reasonsAgainst: partial.reasonsAgainst ?? [],
    invalidation: [],
    orderFlowOk: false,
    structureOk: true,
    volumeOk: false,
    deltaOk: false,
    score: {
      longScore: 3,
      shortScore: 1,
      neutralScore: 0,
      independentFamilies: ["structure", "orderflow"],
      factors: [
        {
          id: "a_plus_gate_failed",
          family: "structure",
          side: "neutral",
          weight: 0,
          source: "derived",
          reason: "A+ blocked",
        },
      ],
      modelNote: "test",
    },
    evidence: [],
    entryGrade: "WAIT",
    entryQualityNotes: partial.entryQualityNotes ?? [],
    lifecycle: "PENDING_CONFIRM",
    lifecycleUpdatedAt: Date.now(),
    setupOpenedAt: Date.now(),
    ...partial,
  };
}

describe("classifyRejectionReasons", () => {
  it("maps HTF majority and A+ factor ids", () => {
    const reasons = classifyRejectionReasons(
      waitSignal({
        entryQualityNotes: [
          "Structure OK.",
          "HTF majority does not permit this side.",
          "OF trigger OK.",
          "Location OK.",
        ],
        reasonsAgainst: [
          "A+ entry filter blocked LONG: Structure OK. | HTF majority does not permit this side.",
        ],
      }),
    );
    const keys = reasons.map((r) => r.key);
    assert.ok(keys.includes("htf_majority"));
    assert.ok(keys.includes("a_plus_gate_failed"));
  });

  it("maps swing proximity notes", () => {
    const reasons = classifyRejectionReasons(
      waitSignal({
        entryQualityNotes: ["Entry within 0.10% of a recent swing high — no LONG."],
      }),
    );
    assert.ok(reasons.some((r) => r.key === "swing_proximity"));
  });
});

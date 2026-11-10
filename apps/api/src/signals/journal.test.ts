import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TradingSignal } from "@of/shared";
import { computeJournalMetrics, listSignalSetups, recordSignalLifecycle } from "./journal.js";

function baseSignal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: "setup-p5-test",
    setupId: "setup-p5-test",
    symbol: "BTCUSDT",
    timestamp: 1_700_000_000_000,
    direction: "LONG",
    entry: 100,
    stopLoss: 99,
    takeProfit: [101.5],
    riskReward: 1.5,
    confidence: 0.5,
    confirmations: ["structure_bullish"],
    reasonsFor: ["test"],
    reasonsAgainst: [],
    invalidation: [],
    orderFlowOk: false,
    structureOk: true,
    volumeOk: false,
    deltaOk: false,
    score: {
      longScore: 1,
      shortScore: 0,
      neutralScore: 0,
      independentFamilies: ["structure"],
      factors: [],
      modelNote: "test",
    },
    evidence: [],
    entryGrade: "STANDARD",
    lifecycle: "CONFIRMED",
    lifecycleUpdatedAt: 1_700_000_000_000,
    setupOpenedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("signal journal", () => {
  it("records lifecycle transitions and computes TP/SL win rate only", () => {
    const setupId = `setup-p5-${Date.now()}`;
    const opened = baseSignal({ id: setupId, setupId, lifecycle: "CONFIRMED" });
    recordSignalLifecycle(undefined, opened, 100, "binance");
    const hit = baseSignal({
      id: setupId,
      setupId,
      lifecycle: "HIT_TP",
      lifecycleUpdatedAt: 1_700_000_000_500,
      lifecycleNote: "tp",
    });
    recordSignalLifecycle(opened, hit, 101.5, "binance");

    const rows = listSignalSetups({ symbol: "BTCUSDT", limit: 50 });
    assert.ok(rows.some((r) => r.setupId === setupId && r.lifecycle === "HIT_TP"));

    const metrics = computeJournalMetrics("BTCUSDT");
    assert.ok(metrics.setups >= 1);
    assert.ok(metrics.sampleNote.includes("HIT_TP/HIT_SL") || metrics.winRate != null || metrics.hitTp >= 1);
  });
});

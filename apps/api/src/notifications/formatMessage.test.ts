import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TradingSignal } from "@of/shared";
import { formatSignalNotification } from "./formatMessage.js";

function signal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: "setup-fmt",
    setupId: "setup-fmt-abc123",
    symbol: "BTCUSDT",
    timestamp: 1_700_000_000_000,
    direction: "LONG",
    entry: 100,
    stopLoss: 99,
    takeProfit: [102, 104],
    riskReward: 2,
    confidence: 0.42,
    confirmations: ["structure_bullish", "stacked_ask_imbalance"],
    reasonsFor: [
      "Market structure trend is bullish (HH/HL bias).",
      "Stacked ask (buy aggression) imbalances on footprint.",
      "Higher TFs lean bullish (2/2 of 4h/1h).",
    ],
    reasonsAgainst: [],
    invalidation: [],
    orderFlowOk: true,
    structureOk: true,
    volumeOk: true,
    deltaOk: false,
    score: {
      longScore: 4,
      shortScore: 0,
      neutralScore: 0,
      independentFamilies: ["structure", "orderflow"],
      factors: [],
      modelNote: "test",
    },
    evidence: [],
    entryGrade: "A+",
    lifecycle: "CONFIRMED",
    lifecycleUpdatedAt: 1_700_000_000_000,
    setupOpenedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("formatSignalNotification", () => {
  it("includes confirmed entry fields and labels model score", () => {
    const { title, message } = formatSignalNotification(signal(), {
      exchange: "bybit",
      primaryInterval: "5m",
      price: 100.5,
      eventType: "HQ_BUY",
    });
    assert.equal(title, "HIGH-QUALITY BUY SIGNAL");
    assert.match(message, /ENTRY CONFIRMED/);
    assert.match(message, /Entry Price: 100/);
    assert.match(message, /Take Profit 1: 102/);
    assert.match(message, /Take Profit 2: 104/);
    assert.match(message, /Take Profit 3: -/);
    assert.match(message, /model score, not win rate/i);
    assert.match(message, /PAPER TRADING ONLY/);
  });

  it("omits missing entry/TP as dash for approaching", () => {
    const { title, message } = formatSignalNotification(
      signal({
        direction: "WAIT",
        entry: undefined,
        stopLoss: undefined,
        takeProfit: undefined,
        riskReward: undefined,
        entryGrade: "WAIT",
        lifecycle: "PENDING_CONFIRM",
      }),
      {
        exchange: "bybit",
        primaryInterval: "5m",
        price: 100,
        eventType: "ENTRY_ZONE_APPROACHING",
      },
    );
    assert.equal(title, "ENTRY ZONE APPROACHING");
    assert.match(message, /WAITING FOR ENTRY \(not confirmed\)/);
    assert.match(message, /Entry Price: -/);
    assert.match(message, /Stop-Loss: -/);
  });
});

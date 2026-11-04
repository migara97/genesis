import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RISK_CONFIG } from "@of/shared";
import { calculatePositionSize, validateOrderRisk } from "./risk.js";

describe("risk engine", () => {
  it("sizes position from equity and stop distance", () => {
    const { quantity, riskAmount } = calculatePositionSize(100_000, 1, 100, 99);
    assert.equal(riskAmount, 1000);
    assert.equal(quantity, 1000);
  });

  it("rejects when emergency shutdown is on", () => {
    const decision = validateOrderRisk({
      config: { ...DEFAULT_RISK_CONFIG, emergencyShutdown: true },
      request: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 1 },
      entry: 100,
      stop: 99,
      openPositions: [],
      dayPnl: 0,
      peakEquity: 100_000,
    });
    assert.equal(decision.allowed, false);
  });

  it("rejects poor risk-reward", () => {
    const decision = validateOrderRisk({
      config: DEFAULT_RISK_CONFIG,
      request: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 1 },
      entry: 100,
      stop: 99,
      takeProfit: 100.5,
      openPositions: [],
      dayPnl: 0,
      peakEquity: 100_000,
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? "", /Risk-reward/);
  });
});

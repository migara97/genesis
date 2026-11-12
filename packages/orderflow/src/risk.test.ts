import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RISK_CONFIG } from "@of/shared";
import {
  applySizingProfile,
  calculatePositionSize,
  resolveSizingProfile,
  validateOrderRisk,
} from "./risk.js";

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

  it("maps sizing profiles to risk % and min grade", () => {
    assert.deepEqual(resolveSizingProfile("conservative"), {
      riskPercentPerTrade: 0.25,
      minEntryGrade: "A+",
    });
    assert.deepEqual(resolveSizingProfile("aggressive"), {
      riskPercentPerTrade: 1.0,
      minEntryGrade: "STANDARD",
    });
    const cfg = applySizingProfile(DEFAULT_RISK_CONFIG, "conservative");
    assert.equal(cfg.riskPercentPerTrade, 0.25);
    assert.equal(cfg.minEntryGrade, "A+");
  });

  it("rejects STANDARD grade under conservative profile", () => {
    const decision = validateOrderRisk({
      config: applySizingProfile(DEFAULT_RISK_CONFIG, "conservative"),
      request: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 1 },
      entry: 100,
      stop: 99,
      takeProfit: 103,
      openPositions: [],
      dayPnl: 0,
      peakEquity: 100_000,
      entryGrade: "STANDARD",
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? "", /A\+/);
  });

  it("allows A+ under conservative profile", () => {
    const decision = validateOrderRisk({
      config: applySizingProfile(DEFAULT_RISK_CONFIG, "conservative"),
      request: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 1 },
      entry: 100,
      stop: 99,
      takeProfit: 103,
      openPositions: [],
      dayPnl: 0,
      peakEquity: 100_000,
      entryGrade: "A+",
    });
    assert.equal(decision.allowed, true);
  });
});

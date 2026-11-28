import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExecutionService, isBinanceLinearSymbol } from "./execution.js";

describe("ExecutionService mode gating", () => {
  it("defaults away from unconfirmed LIVE", () => {
    const svc = new ExecutionService();
    assert.notEqual(svc.getMode(), "LIVE");
  });

  it("requires confirmation to enable LIVE", async () => {
    const svc = new ExecutionService();
    await assert.rejects(() => svc.setMode("LIVE", false), /confirmLiveTrading/);
  });
});

describe("isBinanceLinearSymbol", () => {
  it("accepts Binance USD-M ids", () => {
    assert.equal(isBinanceLinearSymbol("BTCUSDT"), true);
    assert.equal(isBinanceLinearSymbol("ethusdt"), true);
    assert.equal(isBinanceLinearSymbol("XAUUSDT"), true);
  });

  it("rejects OKX / slash / swap forms", () => {
    assert.equal(isBinanceLinearSymbol("BTC-USDT-SWAP"), false);
    assert.equal(isBinanceLinearSymbol("BTC/USDT"), false);
    assert.equal(isBinanceLinearSymbol("BTC_USDT"), false);
    assert.equal(isBinanceLinearSymbol(""), false);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeBybitSymbol } from "./linearMarketData.js";
import { createMarketDataAdapter } from "../factory.js";

describe("Bybit linear adapter helpers", () => {
  it("normalizes OKX-style and compact symbols to BTCUSDT", () => {
    assert.equal(normalizeBybitSymbol("BTC-USDT-SWAP"), "BTCUSDT");
    assert.equal(normalizeBybitSymbol("btc_usdt"), "BTCUSDT");
    assert.equal(normalizeBybitSymbol("ETHUSDT"), "ETHUSDT");
  });

  it("factory returns bybit-linear id", () => {
    assert.equal(createMarketDataAdapter("bybit").id, "bybit-linear");
    assert.equal(createMarketDataAdapter("okx").id, "okx-swap");
    assert.equal(createMarketDataAdapter("binance").id, "binance-futures");
  });
});

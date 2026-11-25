import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { exchangeSymbolAliases, normalizeExchangeSymbol } from "./symbols.js";

describe("normalizeExchangeSymbol", () => {
  it("maps compact UVXYUSDT to OKX swap id", () => {
    assert.equal(normalizeExchangeSymbol("okx", "UVXYUSDT"), "UVXY-USDT-SWAP");
    assert.equal(normalizeExchangeSymbol("okx", "uvxy-usdt-swap"), "UVXY-USDT-SWAP");
  });

  it("keeps compact ids on Binance/Bybit", () => {
    assert.equal(normalizeExchangeSymbol("binance", "UVXYUSDT"), "UVXYUSDT");
    assert.equal(normalizeExchangeSymbol("bybit", "UVXY-USDT-SWAP"), "UVXYUSDT");
  });
});

describe("exchangeSymbolAliases", () => {
  it("links compact and OKX-native UVXY spellings", () => {
    const aliases = exchangeSymbolAliases("okx", "UVXYUSDT");
    assert.ok(aliases.includes("UVXYUSDT"));
    assert.ok(aliases.includes("UVXY-USDT-SWAP"));
  });
});

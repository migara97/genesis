import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBinanceInstruments,
  parseBinanceTickers,
  parseOkxInstruments,
  parseOkxTickers,
  planInstrumentSync,
} from "./discover.js";

describe("market discovery", () => {
  it("parses OKX swap instruments and skips duplicates", () => {
    const rows = parseOkxInstruments([
      {
        instId: "BTC-USDT-SWAP",
        state: "live",
        settleCcy: "USDT",
        ctValCcy: "BTC",
        tickSz: "0.1",
        lotSz: "0.01",
      },
      {
        instId: "BTC-USDT-SWAP",
        state: "live",
        settleCcy: "USDT",
        ctValCcy: "BTC",
        tickSz: "0.1",
        lotSz: "0.01",
      },
      {
        instId: "ETH-USDC-SWAP",
        state: "suspend",
        settleCcy: "USDC",
        ctValCcy: "ETH",
        tickSz: "0.01",
        lotSz: "0.1",
      },
      { instId: "BTC-USDT", state: "live" },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.baseAsset, "BTC");
    assert.equal(rows[0]?.quoteAsset, "USDT");
    assert.equal(rows[0]?.status, "live");
    assert.equal(rows[1]?.status, "suspended");
    assert.equal(rows[1]?.quoteAsset, "USDC");
    const inverse = parseOkxInstruments([
      { instId: "BTC-USD-SWAP", state: "live", settleCcy: "BTC", ctValCcy: "USD", tickSz: "0.1", lotSz: "1" },
    ]);
    assert.equal(inverse[0]?.baseAsset, "BTC");
    assert.equal(inverse[0]?.quoteAsset, "USD");
  });

  it("derives OKX 24h change from last and open", () => {
    const [ticker] = parseOkxTickers([
      {
        instId: "SOL-USDT-SWAP",
        last: "110",
        open24h: "100",
        high24h: "120",
        low24h: "90",
        volCcy24h: "5000000",
        bidPx: "109.9",
        askPx: "110.1",
      },
    ]);
    assert.equal(ticker?.change24h, 10);
    assert.equal(ticker?.changePct24h, 10);
    assert.equal(ticker?.bid, 109.9);
    assert.equal(ticker?.volume24h, 550_000_000);
  });

  it("parses Binance USD-M instruments and tickers", () => {
    const instruments = parseBinanceInstruments([
      {
        symbol: "BTCUSDT",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        status: "TRADING",
        contractType: "PERPETUAL",
        filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.10" },
          { filterType: "LOT_SIZE", stepSize: "0.001" },
        ],
      },
    ]);
    assert.equal(instruments[0]?.status, "live");
    assert.equal(instruments[0]?.tickSize, 0.1);
    const [ticker] = parseBinanceTickers(
      [
        {
          symbol: "BTCUSDT",
          lastPrice: "80000",
          priceChange: "1000",
          priceChangePercent: "1.2",
          quoteVolume: "900000000",
          highPrice: "81000",
          lowPrice: "79000",
        },
      ],
      [{ symbol: "BTCUSDT", bidPrice: "79999", askPrice: "80001" }],
    );
    assert.equal(ticker?.bid, 79999);
    assert.equal(ticker?.changePct24h, 1.2);
  });

  it("detects new listings and missing markets without duplicates", () => {
    const plan = planInstrumentSync(
      [
        { symbol: "BTC-USDT-SWAP", status: "live" },
        { symbol: "OLD-USDT-SWAP", status: "live" },
        { symbol: "GONE-USDT-SWAP", status: "delisted" },
      ],
      [{ symbol: "BTC-USDT-SWAP" }, { symbol: "NEW-USDT-SWAP" }],
    );
    assert.deepEqual(plan.added, ["NEW-USDT-SWAP"]);
    assert.deepEqual(plan.delisted, ["OLD-USDT-SWAP"]);
  });
});

import { BinanceFuturesMarketDataAdapter } from "./binance/futuresMarketData.js";
import { BybitLinearMarketDataAdapter } from "./bybit/linearMarketData.js";
import { OkxSwapMarketDataAdapter } from "./okx/swapMarketData.js";
import type { ExchangeMarketDataAdapter } from "./types.js";

export type SupportedExchange = "okx" | "binance" | "bybit";

/** Single factory for all API call sites. */
export function createMarketDataAdapter(
  exchange: SupportedExchange | string,
): ExchangeMarketDataAdapter {
  switch (exchange) {
    case "binance":
      return new BinanceFuturesMarketDataAdapter();
    case "bybit":
      return new BybitLinearMarketDataAdapter();
    case "okx":
    default:
      return new OkxSwapMarketDataAdapter();
  }
}

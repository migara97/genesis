import { normalizeBybitSymbol } from "./bybit/linearMarketData.js";
import { normalizeOkxSymbol } from "./okx/swapMarketData.js";

/**
 * Map a user/UI/DEFAULT_SYMBOLS id onto the exchange-native market id.
 * Compact `UVXYUSDT` becomes `UVXY-USDT-SWAP` on OKX so tape/book keys match hub state.
 */
export function normalizeExchangeSymbol(exchange: string, symbol: string): string {
  const raw = symbol.trim().toUpperCase();
  if (!raw) return raw;
  switch (exchange) {
    case "okx":
      return normalizeOkxSymbol(raw);
    case "bybit":
      return normalizeBybitSymbol(raw);
    case "binance":
      return raw.replace(/-/g, "").replace(/_/g, "");
    default:
      return raw;
  }
}

/** Every known spelling that should resolve to the same hub/stream key. */
export function exchangeSymbolAliases(exchange: string, symbol: string): string[] {
  const requested = symbol.trim().toUpperCase();
  const canonical = normalizeExchangeSymbol(exchange, requested);
  const aliases = new Set<string>([requested, canonical]);
  if (exchange === "okx") {
    // UVXYUSDT ↔ UVXY-USDT-SWAP
    if (canonical.endsWith("-USDT-SWAP")) {
      aliases.add(canonical.replace(/-/g, "").replace(/SWAP$/, ""));
    }
    if (/^[A-Z0-9]+USDT$/.test(requested)) {
      aliases.add(normalizeOkxSymbol(requested));
    }
  }
  if (exchange === "bybit" || exchange === "binance") {
    if (requested.endsWith("-USDT-SWAP")) {
      aliases.add(normalizeExchangeSymbol(exchange, requested));
    }
  }
  return [...aliases].filter(Boolean);
}

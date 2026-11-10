import type { TradeTick } from "@of/shared";
import { db } from "../db.js";

/** Persist focused-symbol trades for future full-OF historical parity. */
export function archiveTradeTick(trade: TradeTick): void {
  try {
    db.prepare(
      `
      INSERT OR IGNORE INTO trade_tape (
        exchange, symbol, trade_id, price, quantity, buyer_aggressor, aggressor_source, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      trade.exchange,
      trade.symbol,
      trade.tradeId,
      trade.price,
      trade.quantity,
      trade.buyerAggressor ? 1 : 0,
      trade.aggressorSource,
      trade.timestamp,
    );
  } catch {
    // Archive must never break the live hub.
  }
}

export function countTapeTrades(symbol: string, exchange: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM trade_tape WHERE symbol = ? AND exchange = ?`)
    .get(symbol.toUpperCase(), exchange) as { n: number };
  return Number(row?.n ?? 0);
}

export function tapeCoverageNote(symbol: string, exchange: string): string {
  const n = countTapeTrades(symbol, exchange);
  if (n === 0) {
    return "No archived trade tape yet. Historical full-OF parity backtests are unavailable; structure/MTF-only replay must be labeled as a proxy.";
  }
  return `Archived ${n} trades for ${exchange}:${symbol}. Full-OF historical replay can use this tape once a parity runner is invoked; candle-only backtests remain a limited proxy.`;
}

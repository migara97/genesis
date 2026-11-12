import type { TradeTick } from "@of/shared";
import { db } from "../db.js";

/** Persist focused-symbol trades for Phase 9 full-OF historical parity. */
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
  return `Archived ${n} trades for ${exchange}:${symbol}. Phase 9 tape OF replay is available via GET /api/validation/parity?run=1; candle-only /api/backtest remains a structure/MTF proxy.`;
}

/** Load archived ticks for a symbol (optional time window). */
export function loadTapeTrades(opts: {
  symbol: string;
  exchange: string;
  fromTs?: number;
  toTs?: number;
  limit?: number;
}): TradeTick[] {
  const limit = Math.min(Math.max(opts.limit ?? 50_000, 1), 200_000);
  const symbol = opts.symbol.toUpperCase();
  let rows: Record<string, unknown>[];
  if (opts.fromTs != null && opts.toTs != null) {
    rows = db
      .prepare(
        `SELECT * FROM trade_tape WHERE exchange = ? AND symbol = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC LIMIT ?`,
      )
      .all(opts.exchange, symbol, opts.fromTs, opts.toTs, limit) as Record<string, unknown>[];
  } else if (opts.fromTs != null) {
    rows = db
      .prepare(
        `SELECT * FROM trade_tape WHERE exchange = ? AND symbol = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT ?`,
      )
      .all(opts.exchange, symbol, opts.fromTs, limit) as Record<string, unknown>[];
  } else {
    rows = db
      .prepare(
        `SELECT * FROM trade_tape WHERE exchange = ? AND symbol = ? ORDER BY timestamp ASC LIMIT ?`,
      )
      .all(opts.exchange, symbol, limit) as Record<string, unknown>[];
  }
  return rows.map((row) => ({
    exchange: String(row.exchange),
    symbol: String(row.symbol),
    tradeId: String(row.trade_id),
    price: Number(row.price),
    quantity: Number(row.quantity),
    buyerAggressor: Number(row.buyer_aggressor) === 1,
    aggressorSource: String(row.aggressor_source) as TradeTick["aggressorSource"],
    timestamp: Number(row.timestamp),
  }));
}

export function tapeTimeBounds(
  symbol: string,
  exchange: string,
): { minTs: number | null; maxTs: number | null; count: number } {
  const row = db
    .prepare(
      `SELECT MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts, COUNT(*) AS n FROM trade_tape WHERE exchange = ? AND symbol = ?`,
    )
    .get(exchange, symbol.toUpperCase()) as {
    min_ts: number | null;
    max_ts: number | null;
    n: number;
  };
  return {
    minTs: row?.min_ts == null ? null : Number(row.min_ts),
    maxTs: row?.max_ts == null ? null : Number(row.max_ts),
    count: Number(row?.n ?? 0),
  };
}

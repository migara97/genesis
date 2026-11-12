import type { Candle } from "@of/shared";
import { db } from "../db.js";
import {
  planInstrumentSync,
  type DiscoveredInstrument,
  type DiscoveredTicker,
  type InstrumentStatus,
} from "./discover.js";

export interface MarketListQuery {
  exchange: string;
  q?: string;
  quote?: string;
  status?: string;
  sort?: string;
  favorites?: boolean;
  limit?: number;
  offset?: number;
}

export interface MarketListItem {
  exchange: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: InstrumentStatus;
  tickSize: number;
  lotSize: number;
  contractType: string;
  lastPrice: number | null;
  change24h: number | null;
  changePct24h: number | null;
  volume24h: number | null;
  high24h: number | null;
  low24h: number | null;
  bid: number | null;
  ask: number | null;
  favorite: boolean;
  updatedAt: number | null;
}

const SORTS: Record<string, string> = {
  volume: "t.volume_24h DESC",
  price: "t.last_price DESC",
  change: "t.change_pct_24h DESC",
};

export function syncInstruments(
  exchange: string,
  instruments: DiscoveredInstrument[],
  now = Date.now(),
): { upserted: number; added: string[]; delisted: string[] } {
  const existing = db
    .prepare("SELECT symbol, status FROM instruments WHERE exchange = ?")
    .all(exchange) as { symbol: string; status: string }[];
  const plan = planInstrumentSync(existing, instruments);

  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO exchanges (id, venue, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET venue = excluded.venue, updated_at = excluded.updated_at",
    ).run(exchange, exchange, now);

    const upsertAsset = db.prepare(
      "INSERT INTO cryptocurrencies (symbol, updated_at) VALUES (?, ?) ON CONFLICT(symbol) DO UPDATE SET updated_at = excluded.updated_at",
    );
    const upsert = db.prepare(`
      INSERT INTO instruments (
        exchange, symbol, base_asset, quote_asset, status, tick_size, lot_size,
        contract_type, first_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange, symbol) DO UPDATE SET
        base_asset = excluded.base_asset,
        quote_asset = excluded.quote_asset,
        status = excluded.status,
        tick_size = excluded.tick_size,
        lot_size = excluded.lot_size,
        contract_type = excluded.contract_type,
        updated_at = excluded.updated_at
    `);
    for (const item of instruments) {
      upsertAsset.run(item.baseAsset, now);
      upsertAsset.run(item.quoteAsset, now);
      upsert.run(
        exchange,
        item.symbol,
        item.baseAsset,
        item.quoteAsset,
        item.status,
        item.tickSize,
        item.lotSize,
        item.contractType,
        now,
        now,
      );
    }
    const mark = db.prepare(
      "UPDATE instruments SET status = 'delisted', updated_at = ? WHERE exchange = ? AND symbol = ? AND status != 'delisted'",
    );
    for (const symbol of plan.delisted) mark.run(now, exchange, symbol);
  });
  tx();
  return { upserted: instruments.length, added: plan.added, delisted: plan.delisted };
}

export function syncTickers(
  exchange: string,
  tickers: DiscoveredTicker[],
  now = Date.now(),
): number {
  const known = new Set(
    (
      db.prepare("SELECT symbol FROM instruments WHERE exchange = ?").all(exchange) as {
        symbol: string;
      }[]
    ).map((row) => row.symbol),
  );
  const upsert = db.prepare(`
    INSERT INTO market_tickers (
      exchange, symbol, last_price, change_24h, change_pct_24h, volume_24h,
      high_24h, low_24h, bid, ask, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(exchange, symbol) DO UPDATE SET
      last_price = excluded.last_price,
      change_24h = excluded.change_24h,
      change_pct_24h = excluded.change_pct_24h,
      volume_24h = excluded.volume_24h,
      high_24h = excluded.high_24h,
      low_24h = excluded.low_24h,
      bid = excluded.bid,
      ask = excluded.ask,
      updated_at = excluded.updated_at
  `);
  let written = 0;
  const tx = db.transaction(() => {
    for (const ticker of tickers) {
      if (!known.has(ticker.symbol)) continue;
      upsert.run(
        exchange,
        ticker.symbol,
        ticker.lastPrice,
        ticker.change24h,
        ticker.changePct24h,
        ticker.volume24h,
        ticker.high24h,
        ticker.low24h,
        ticker.bid,
        ticker.ask,
        now,
      );
      written += 1;
    }
  });
  tx();
  return written;
}

export function listQuotes(exchange: string): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT quote_asset AS quote FROM instruments WHERE exchange = ? ORDER BY quote_asset",
    )
    .all(exchange) as { quote: string }[];
  return rows.map((row) => row.quote);
}

export function listMarkets(query: MarketListQuery): { total: number; items: MarketListItem[] } {
  const q = (query.q ?? "").trim().toUpperCase().replace(/[%_]/g, "");
  const quote = (query.quote ?? "").trim().toUpperCase();
  const status = (query.status ?? "").trim().toLowerCase();
  const sort = SORTS[query.sort ?? "volume"] ?? SORTS.volume;
  const requestedLimit = Number(query.limit ?? 300);
  const requestedOffset = Number(query.offset ?? 0);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 300, 1), 1000);
  const offset = Math.max(Number.isFinite(requestedOffset) ? requestedOffset : 0, 0);
  const where = `
    WHERE i.exchange = @exchange
      AND (@quote = '' OR i.quote_asset = @quote)
      AND (@status = '' OR i.status = @status)
      AND (@favorites = 0 OR w.symbol IS NOT NULL)
      AND (
        @q = ''
        OR i.symbol LIKE '%' || @q || '%'
        OR i.base_asset LIKE '%' || @q || '%'
        OR i.quote_asset LIKE '%' || @q || '%'
      )
  `;
  const params = {
    exchange: query.exchange,
    quote,
    status,
    favorites: query.favorites ? 1 : 0,
    q,
  };
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM instruments i LEFT JOIN watchlist w ON w.exchange = i.exchange AND w.symbol = i.symbol ${where}`,
      )
      .get(params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT
        i.exchange, i.symbol, i.base_asset, i.quote_asset, i.status, i.tick_size, i.lot_size, i.contract_type,
        t.last_price, t.change_24h, t.change_pct_24h, t.volume_24h, t.high_24h, t.low_24h, t.bid, t.ask, t.updated_at,
        CASE WHEN w.symbol IS NULL THEN 0 ELSE 1 END AS favorite
      FROM instruments i
      LEFT JOIN market_tickers t ON t.exchange = i.exchange AND t.symbol = i.symbol
      LEFT JOIN watchlist w ON w.exchange = i.exchange AND w.symbol = i.symbol
      ${where}
      ORDER BY ${sort}, i.symbol ASC
      LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as Record<string, unknown>[];
  return {
    total,
    items: rows.map((row) => ({
      exchange: String(row.exchange),
      symbol: String(row.symbol),
      baseAsset: String(row.base_asset),
      quoteAsset: String(row.quote_asset),
      status: String(row.status) as InstrumentStatus,
      tickSize: Number(row.tick_size),
      lotSize: Number(row.lot_size),
      contractType: String(row.contract_type),
      lastPrice: numOrNull(row.last_price),
      change24h: numOrNull(row.change_24h),
      changePct24h: numOrNull(row.change_pct_24h),
      volume24h: numOrNull(row.volume_24h),
      high24h: numOrNull(row.high_24h),
      low24h: numOrNull(row.low_24h),
      bid: numOrNull(row.bid),
      ask: numOrNull(row.ask),
      favorite: Number(row.favorite) === 1,
      updatedAt: numOrNull(row.updated_at),
    })),
  };
}

export function getInstrument(
  exchange: string,
  symbol: string,
): { symbol: string; status: InstrumentStatus; tickSize: number } | null {
  const row = db
    .prepare(
      "SELECT symbol, status, tick_size FROM instruments WHERE exchange = ? AND symbol = ?",
    )
    .get(exchange, symbol.toUpperCase()) as
    | { symbol: string; status: InstrumentStatus; tick_size: number }
    | undefined;
  if (!row) return null;
  return { symbol: row.symbol, status: row.status, tickSize: row.tick_size };
}

export function getTickerStats(
  exchange: string,
  symbol: string,
): { volume24h: number | null; changePct24h: number | null; lastPrice: number | null } | null {
  const row = db
    .prepare(
      `SELECT volume_24h, change_pct_24h, last_price FROM market_tickers WHERE exchange = ? AND symbol = ?`,
    )
    .get(exchange, symbol.toUpperCase()) as
    | { volume_24h: number | null; change_pct_24h: number | null; last_price: number | null }
    | undefined;
  if (!row) return null;
  return {
    volume24h: numOrNull(row.volume_24h),
    changePct24h: numOrNull(row.change_pct_24h),
    lastPrice: numOrNull(row.last_price),
  };
}

export function setFavorite(exchange: string, symbol: string, favorite: boolean): void {
  const normalized = symbol.toUpperCase();
  if (favorite) {
    db.prepare(
      "INSERT OR IGNORE INTO watchlist (exchange, symbol, created_at) VALUES (?, ?, ?)",
    ).run(exchange, normalized, Date.now());
    return;
  }
  db.prepare("DELETE FROM watchlist WHERE exchange = ? AND symbol = ?").run(exchange, normalized);
}

export function isFavorite(exchange: string, symbol: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM watchlist WHERE exchange = ? AND symbol = ?`)
    .get(exchange, symbol.toUpperCase()) as { ok: number } | undefined;
  return Boolean(row);
}

export function replaceCandleCache(
  exchange: string,
  symbol: string,
  interval: string,
  candles: Candle[],
): void {
  const tx = db.transaction(() => {
    db.prepare(
      "DELETE FROM candle_cache WHERE exchange = ? AND symbol = ? AND interval = ?",
    ).run(exchange, symbol, interval);
    const insert = db.prepare(`
      INSERT INTO candle_cache (
        exchange, symbol, interval, open_time, open, high, low, close, volume, close_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const candle of candles) {
      insert.run(
        exchange,
        symbol,
        interval,
        candle.openTime,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.closeTime,
      );
    }
  });
  tx();
}

function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

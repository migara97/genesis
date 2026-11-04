-- Market catalog. Applied on startup with CREATE IF NOT EXISTS.
-- Order books and the trade tape stay in memory for the focused symbol only.
-- Persisting every book update would not survive thousands of pairs.

CREATE TABLE IF NOT EXISTS exchanges (
  id TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cryptocurrencies (
  symbol TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS instruments (
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  base_asset TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  status TEXT NOT NULL,
  tick_size REAL NOT NULL,
  lot_size REAL NOT NULL,
  contract_type TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, symbol)
);

CREATE INDEX IF NOT EXISTS idx_instruments_quote
  ON instruments(exchange, quote_asset, status);

CREATE INDEX IF NOT EXISTS idx_instruments_base
  ON instruments(exchange, base_asset);

CREATE TABLE IF NOT EXISTS market_tickers (
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  last_price REAL NOT NULL,
  change_24h REAL NOT NULL,
  change_pct_24h REAL NOT NULL,
  volume_24h REAL NOT NULL,
  high_24h REAL NOT NULL,
  low_24h REAL NOT NULL,
  bid REAL NOT NULL,
  ask REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, symbol)
);

CREATE INDEX IF NOT EXISTS idx_tickers_volume
  ON market_tickers(exchange, volume_24h);

CREATE TABLE IF NOT EXISTS watchlist (
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, symbol)
);

-- Latest requested OHLCV window only. Replaced on each fetch for that pair.
CREATE TABLE IF NOT EXISTS candle_cache (
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  close_time INTEGER NOT NULL,
  PRIMARY KEY (exchange, symbol, interval, open_time)
);

CREATE INDEX IF NOT EXISTS idx_candles_lookup
  ON candle_cache(exchange, symbol, interval, open_time);

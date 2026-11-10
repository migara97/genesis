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

-- Phase 5: live signal journal (one row per setupId, updated through lifecycle).
CREATE TABLE IF NOT EXISTS signal_setups (
  setup_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  direction TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  entry REAL,
  stop_loss REAL,
  take_profit TEXT,
  exit_price REAL,
  pnl_price REAL,
  confidence REAL,
  long_score REAL,
  short_score REAL,
  families TEXT,
  confirmations TEXT,
  lifecycle_note TEXT,
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signal_setups_symbol
  ON signal_setups(symbol, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_setups_lifecycle
  ON signal_setups(lifecycle, updated_at DESC);

CREATE TABLE IF NOT EXISTS signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  direction TEXT NOT NULL,
  price REAL,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signal_events_setup
  ON signal_events(setup_id, created_at);

-- Phase 7: forward paper-trading ledger (measurement layer; does not alter generateSignal).
CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY,
  setup_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  market_type TEXT NOT NULL,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  outcome TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  primary_timeframe TEXT NOT NULL,
  entry REAL NOT NULL,
  entry_fill REAL,
  stop_loss REAL NOT NULL,
  take_profit TEXT NOT NULL,
  exit_price REAL,
  exit_fill REAL,
  confidence REAL NOT NULL,
  long_score REAL,
  short_score REAL,
  families TEXT,
  confirmations TEXT,
  regime_tags TEXT,
  engine_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  gross_pnl REAL,
  fees REAL,
  funding REAL,
  net_pnl REAL,
  r_multiple REAL,
  mfe REAL,
  mae REAL,
  hold_ms INTEGER,
  ambiguous_same_bar INTEGER NOT NULL DEFAULT 0,
  of_snapshot TEXT,
  signal_payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol
  ON paper_trades(symbol, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_trades_outcome
  ON paper_trades(outcome, closed_at);

-- Append-only trade tape for focused symbol (enables future full-OF replay).
CREATE TABLE IF NOT EXISTS trade_tape (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  price REAL NOT NULL,
  quantity REAL NOT NULL,
  buyer_aggressor INTEGER NOT NULL,
  aggressor_source TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  UNIQUE(exchange, symbol, trade_id)
);

CREATE INDEX IF NOT EXISTS idx_trade_tape_lookup
  ON trade_tape(exchange, symbol, timestamp);

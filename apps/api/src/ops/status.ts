import { config } from "../config.js";
import { marketHub } from "../marketHub.js";
import { getCatalogSyncStatus } from "../markets/sync.js";
import { countTapeTrades } from "../validation/tapeArchive.js";

let tlsInfo: { mode: string; detail: string } = {
  mode: "default",
  detail: "System trust store (no TLS override)",
};

export function setTlsInfo(info: { mode: string; detail: string }): void {
  tlsInfo = info;
}

export function buildHealthPayload(executionMode: string) {
  const streaming = marketHub.streamingSymbols();
  const snap = streaming[0] ? marketHub.getSnapshot(streaming[0]) : null;
  const health = snap?.health;
  const lastMessageAt = health?.lastMessageAt ?? null;
  const wsLagMs = lastMessageAt != null ? Math.max(0, Date.now() - lastMessageAt) : null;
  const catalog = getCatalogSyncStatus();
  const symbol = streaming[0] ?? config.symbols[0] ?? "BTCUSDT";
  const tapeCount = countTapeTrades(symbol, config.exchange);

  return {
    ok: true,
    mode: executionMode,
    symbols: streaming,
    configuredSymbols: config.symbols,
    exchange: config.exchange,
    validationLockConfig: config.validationLockConfig,
    focusRotationMs: config.focusRotationMs,
    ws: {
      connected: health?.connected ?? false,
      lagMs: wsLagMs,
      lastMessageAt,
      lastError: health?.lastError ?? null,
      reconnectAttempts: health?.reconnectAttempts ?? 0,
      adapter: health?.exchange ?? null,
    },
    catalog: {
      lastSuccessAt: catalog.lastSuccessAt,
      lastErrorAt: catalog.lastErrorAt,
      lastError: catalog.lastError,
      ageMs: catalog.lastSuccessAt != null ? Date.now() - catalog.lastSuccessAt : null,
      instruments: catalog.instruments,
      tickers: catalog.tickers,
    },
    tape: { symbol, count: tapeCount },
    tls: tlsInfo,
    dataPolicy:
      "Live public market data via modular exchange adapters (OKX default, Binance/Bybit optional). Aggressor flags are exchange-reported when provided. Institutional identity is never claimed. Secrets never leave the API.",
  };
}

export function buildPrometheusMetrics(mode: string): string {
  const h = buildHealthPayload(mode);
  const lines: string[] = [
    "# HELP of_up Order Flow API process up",
    "# TYPE of_up gauge",
    "of_up 1",
    "# HELP of_ws_connected Exchange WS connected",
    "# TYPE of_ws_connected gauge",
    `of_ws_connected{exchange="${config.exchange}"} ${h.ws.connected ? 1 : 0}`,
    "# HELP of_ws_lag_ms Milliseconds since last WS message",
    "# TYPE of_ws_lag_ms gauge",
    `of_ws_lag_ms{exchange="${config.exchange}"} ${h.ws.lagMs ?? -1}`,
    "# HELP of_catalog_age_ms Age of last successful catalog sync",
    "# TYPE of_catalog_age_ms gauge",
    `of_catalog_age_ms{exchange="${config.exchange}"} ${h.catalog.ageMs ?? -1}`,
    "# HELP of_catalog_sync_errors 1 if last sync failed",
    "# TYPE of_catalog_sync_errors gauge",
    `of_catalog_sync_errors{exchange="${config.exchange}"} ${h.catalog.lastError ? 1 : 0}`,
    "# HELP of_tape_trades Archived trade tape rows for focused symbol",
    "# TYPE of_tape_trades gauge",
    `of_tape_trades{exchange="${config.exchange}",symbol="${h.tape.symbol}"} ${h.tape.count}`,
    "# HELP of_execution_mode Encoded execution mode (0=ANALYSIS 1=PAPER 2=LIVE)",
    "# TYPE of_execution_mode gauge",
    `of_execution_mode ${mode === "LIVE" ? 2 : mode === "PAPER" ? 1 : 0}`,
  ];
  return `${lines.join("\n")}\n`;
}

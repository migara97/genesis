import type {
  BacktestResultView,
  Candle,
  ExecutionMode,
  MarketListing,
  OrderRecord,
  Position,
  RiskConfig,
  ScannerSnapshot,
  SignalJournalMetrics,
  SignalSetupRow,
} from "./types";

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || res.statusText);
  }
  return res.json() as Promise<T>;
};

export async function fetchRisk(): Promise<RiskConfig> {
  return json(await fetch("/api/risk"));
}

export async function fetchPositions(): Promise<Position[]> {
  return json(await fetch("/api/positions"));
}

export async function fetchOrders(): Promise<OrderRecord[]> {
  return json(await fetch("/api/orders"));
}

export async function fetchMode(): Promise<{ mode: ExecutionMode }> {
  return json(await fetch("/api/mode"));
}

export async function setMode(mode: ExecutionMode, confirmLiveTrading = false) {
  return json(
    await fetch("/api/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, confirmLiveTrading }),
    }),
  );
}

export async function placeOrder(body: {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: number;
  price?: number;
  stopPrice?: number;
  confirmLiveTrading?: boolean;
}): Promise<OrderRecord> {
  return json(
    await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function emergencyShutdown() {
  return json(await fetch("/api/emergency-shutdown", { method: "POST" }));
}

export async function fetchMarkets(params: {
  q?: string;
  quote?: string;
  status?: string;
  sort?: string;
  favorites?: boolean;
}): Promise<{ total: number; quotes: string[]; items: MarketListing[]; streaming: string[] }> {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.quote) search.set("quote", params.quote);
  if (params.status) search.set("status", params.status);
  if (params.sort) search.set("sort", params.sort);
  if (params.favorites) search.set("favorites", "1");
  search.set("limit", "500");
  return json(await fetch(`/api/markets?${search.toString()}`));
}

export async function setFavorite(symbol: string, favorite: boolean) {
  return json(
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, favorite }),
    }),
  );
}

export async function fetchCandles(symbol: string, interval = "5m"): Promise<{ candles: Candle[] }> {
  return json(await fetch(`/api/markets/${encodeURIComponent(symbol)}/candles?interval=${interval}`));
}

export async function fetchScanner(): Promise<ScannerSnapshot> {
  return json(await fetch("/api/scanner"));
}

export async function updateRisk(patch: Partial<RiskConfig>) {
  return json(
    await fetch("/api/risk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function fetchAlerts(symbol?: string) {
  const search = new URLSearchParams();
  if (symbol) search.set("symbol", symbol);
  return json<{ alerts: AlertRule[] }>(await fetch(`/api/alerts?${search.toString()}`));
}

export async function fetchAlertFires(limit = 20) {
  return json<{ fires: AlertFire[] }>(
    await fetch(`/api/alerts?fired=1&limit=${limit}`),
  );
}

export async function createAlert(body: {
  symbol: string;
  kind: "price" | "signal";
  op?: "gte" | "lte" | "eq";
  threshold?: number | null;
  lifecycle?: string | null;
}) {
  return json(
    await fetch("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function deleteAlert(id: string) {
  return json(await fetch(`/api/alerts/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export async function fetchLiveAudit(limit = 50) {
  return json<{ entries: LiveAuditEntry[] }>(
    await fetch(`/api/live-audit?limit=${limit}`),
  );
}

export interface AlertRule {
  id: string;
  symbol: string;
  kind: "price" | "signal";
  op: "gte" | "lte" | "eq";
  threshold: number | null;
  lifecycle: string | null;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  fireCount: number;
}

export interface AlertFire {
  id: string;
  alertId: string;
  symbol: string;
  kind: "price" | "signal";
  message: string;
  price: number | null;
  lifecycle: string | null;
  firedAt: number;
}

export interface LiveAuditEntry {
  id: string;
  ts: number;
  action: string;
  mode: string;
  symbol: string | null;
  side: string | null;
  status: string | null;
  reason: string | null;
}

export async function fetchSignalJournal(symbol?: string, limit = 20): Promise<{ setups: SignalSetupRow[] }> {
  const search = new URLSearchParams();
  if (symbol) search.set("symbol", symbol);
  search.set("limit", String(limit));
  return json(await fetch(`/api/signals/journal?${search.toString()}`));
}

export async function fetchSignalMetrics(symbol?: string): Promise<SignalJournalMetrics> {
  const search = new URLSearchParams();
  if (symbol) search.set("symbol", symbol);
  return json(await fetch(`/api/signals/metrics?${search.toString()}`));
}

export async function fetchBacktest(symbol: string): Promise<BacktestResultView> {
  return json(await fetch(`/api/backtest/${encodeURIComponent(symbol)}`));
}

export async function fetchValidationReport(symbol?: string): Promise<Record<string, unknown>> {
  const search = new URLSearchParams();
  if (symbol) search.set("symbol", symbol);
  return json(await fetch(`/api/validation/report?${search.toString()}`));
}

export async function fetchParityReport(
  symbol?: string,
  opts?: { run?: boolean; maxTicks?: number },
): Promise<Record<string, unknown>> {
  const search = new URLSearchParams();
  if (symbol) search.set("symbol", symbol);
  if (opts?.run) search.set("run", "1");
  if (opts?.maxTicks != null) search.set("maxTicks", String(opts.maxTicks));
  return json(await fetch(`/api/validation/parity?${search.toString()}`));
}

export async function fetchHealth(): Promise<Record<string, unknown>> {
  return json(await fetch("/health"));
}

export async function fetchSecrets(): Promise<{
  secrets: { name: string; masked: string; updatedAt: number; present: boolean }[];
  note: string;
}> {
  return json(await fetch("/api/secrets"));
}

export async function putSecret(name: string, value: string): Promise<{ name: string; masked: string }> {
  return json(
    await fetch(`/api/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    }),
  );
}

export async function rotateSecrets(oldEncryptionKey: string): Promise<{ rotated: number }> {
  return json(
    await fetch("/api/secrets/rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldEncryptionKey }),
    }),
  );
}

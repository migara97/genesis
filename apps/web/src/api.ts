import type {
  BacktestResultView,
  Candle,
  ExecutionMode,
  MarketListing,
  OrderRecord,
  Position,
  RiskConfig,
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

export async function fetchCandles(symbol: string, interval = "15m"): Promise<{ candles: Candle[] }> {
  return json(await fetch(`/api/markets/${encodeURIComponent(symbol)}/candles?interval=${interval}`));
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

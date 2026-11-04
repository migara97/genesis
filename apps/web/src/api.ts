import type { ExecutionMode, OrderRecord, Position, RiskConfig } from "./types";

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

export async function updateRisk(patch: Partial<RiskConfig>) {
  return json(
    await fetch("/api/risk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

import { createHmac } from "node:crypto";
import type { ExchangeCredentials, ExchangeTradingAdapter } from "../types.js";

const REST = "https://fapi.binance.com";

/**
 * Live Binance USD-M trading adapter.
 * Must only be used when ExecutionMode=LIVE and confirmLiveTrading=true.
 * Secrets never leave the server process.
 */
export class BinanceFuturesTradingAdapter implements ExchangeTradingAdapter {
  readonly id = "binance-futures";

  constructor(private readonly credentials: ExchangeCredentials) {}

  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
  ): Promise<{ orderId: string }> {
    const params: Record<string, string> = {
      symbol: symbol.toUpperCase(),
      side,
      type: "MARKET",
      quantity: String(quantity),
      timestamp: String(Date.now()),
    };
    const data = (await this.signedRequest("POST", "/fapi/v1/order", params)) as {
      orderId: string | number;
    };
    return { orderId: String(data.orderId) };
  }

  async placeLimitOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    price: number,
  ): Promise<{ orderId: string }> {
    const params: Record<string, string> = {
      symbol: symbol.toUpperCase(),
      side,
      type: "LIMIT",
      timeInForce: "GTC",
      quantity: String(quantity),
      price: String(price),
      timestamp: String(Date.now()),
    };
    const data = (await this.signedRequest("POST", "/fapi/v1/order", params)) as {
      orderId: string | number;
    };
    return { orderId: String(data.orderId) };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.signedRequest("DELETE", "/fapi/v1/order", {
      symbol: symbol.toUpperCase(),
      orderId,
      timestamp: String(Date.now()),
    });
  }

  async getBalance(): Promise<{ asset: string; free: number; locked: number }[]> {
    const data = await this.signedRequest("GET", "/fapi/v2/balance", {
      timestamp: String(Date.now()),
    });
    const rows = data as { asset: string; balance: string; availableBalance: string }[];
    return rows.map((r) => ({
      asset: r.asset,
      free: Number(r.availableBalance),
      locked: Number(r.balance) - Number(r.availableBalance),
    }));
  }

  private async signedRequest(
    method: string,
    path: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown> | unknown[]> {
    const query = new URLSearchParams(params);
    const signature = createHmac("sha256", this.credentials.apiSecret)
      .update(query.toString())
      .digest("hex");
    query.set("signature", signature);
    const url = `${REST}${path}?${query.toString()}`;
    const res = await fetch(url, {
      method,
      headers: { "X-MBX-APIKEY": this.credentials.apiKey },
    });
    if (!res.ok) {
      const body = await res.text();
      // Never include api secret; body may contain order details only
      throw new Error(`Binance trading error ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

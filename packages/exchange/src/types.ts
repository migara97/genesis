import type { Candle, ConnectionHealth, OrderBookSnapshot, TradeTick } from "@of/shared";

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface MarketDataHandlers {
  onTrade: (trade: TradeTick) => void;
  onBook: (book: OrderBookSnapshot) => void;
  onCandle?: (candle: Candle) => void;
  onHealth?: (health: ConnectionHealth) => void;
  onError?: (error: Error) => void;
}

export interface ExchangeMarketDataAdapter {
  readonly id: string;
  connect(symbols: string[], handlers: MarketDataHandlers): Promise<void>;
  disconnect(): Promise<void>;
  getHealth(): ConnectionHealth;
  fetchKlines(symbol: string, interval: string, limit?: number): Promise<Candle[]>;
  fetchOrderBookSnapshot(symbol: string, limit?: number): Promise<OrderBookSnapshot>;
}

export interface ExchangeTradingAdapter {
  readonly id: string;
  placeMarketOrder(symbol: string, side: "BUY" | "SELL", quantity: number): Promise<{ orderId: string }>;
  placeLimitOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    price: number,
  ): Promise<{ orderId: string }>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  getBalance(): Promise<{ asset: string; free: number; locked: number }[]>;
}

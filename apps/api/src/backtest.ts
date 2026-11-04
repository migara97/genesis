import { generateSignal } from "@of/orderflow";
import type { Candle, TradingSignal } from "@of/shared";

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  side: "LONG" | "SHORT";
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  averageRr: number;
  expectancy: number;
  totalPnl: number;
  signals: TradingSignal[];
}

/**
 * Lightweight candle-based replay. Order-flow fields are unavailable historically
 * unless trade tape was stored; structure-only signals are labeled accordingly.
 */
export function backtestFromCandles(
  symbol: string,
  candles: Candle[],
  feeBps = 4,
): BacktestResult {
  const signals: TradingSignal[] = [];
  const trades: BacktestTrade[] = [];
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (let i = 50; i < candles.length - 2; i++) {
    const window = candles.slice(0, i + 1);
    const last = window[window.length - 1]!;
    // Structure-only synthetic inputs — explicitly weak without order flow
    const signal = generateSignal({
      symbol,
      lastPrice: last.close,
      timestamp: last.closeTime,
      structure: {
        symbol,
        trend: last.close >= window[window.length - 20]!.close ? "bullish" : "bearish",
        swings: [],
        support: [Math.min(...window.slice(-20).map((c) => c.low))],
        resistance: [Math.max(...window.slice(-20).map((c) => c.high))],
        liquidityPools: [],
        evidence: [
          {
            kind: "inferred",
            note: "Historical backtest without stored tape — order-flow confirmations absent.",
          },
        ],
      },
    });
    signals.push(signal);

    if (signal.direction === "WAIT" || signal.entry == null || signal.stopLoss == null) continue;
    // Need multi-confirmations — this path usually WAIT; keep for metrics completeness
    const next = candles[i + 1]!;
    const exit = next.close;
    const side = signal.direction;
    const dir = side === "LONG" ? 1 : -1;
    const gross = (exit - signal.entry) * dir;
    const fees = ((signal.entry + exit) * feeBps) / 10_000;
    const pnl = gross - fees;
    trades.push({
      entryTime: last.closeTime,
      exitTime: next.closeTime,
      side,
      entry: signal.entry,
      exit,
      pnl,
      fees,
    });
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  return {
    trades,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss,
    maxDrawdown,
    averageRr: 0,
    expectancy: trades.length ? totalPnl / trades.length : 0,
    totalPnl,
    signals: signals.slice(-20),
  };
}

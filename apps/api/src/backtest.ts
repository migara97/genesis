import {
  backtestSignalEngine,
  DEFAULT_BACKTEST_CONFIG,
  type BacktestConfig,
  type BacktestResult,
  type BacktestSeries,
} from "@of/orderflow";
import type { Candle } from "@of/shared";

export type { BacktestResult, BacktestTrade, BacktestConfig } from "@of/orderflow";

/**
 * API-facing wrapper. Prefers multi-timeframe series when the caller fetched them.
 */
export function runSignalBacktest(
  symbol: string,
  primaryCandles: Candle[],
  higherTimeframes: BacktestSeries[] = [],
  softTimeframe?: Candle[],
  overrides: Partial<BacktestConfig> = {},
): BacktestResult {
  return backtestSignalEngine(symbol, primaryCandles, higherTimeframes, softTimeframe, {
    ...DEFAULT_BACKTEST_CONFIG,
    ...overrides,
  });
}

/** @deprecated Use runSignalBacktest. */
export function backtestFromCandles(
  symbol: string,
  candles: Candle[],
  feeBps = 4,
): BacktestResult {
  return runSignalBacktest(symbol, candles, [], undefined, { feeBps });
}

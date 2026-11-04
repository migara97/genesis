import "dotenv/config";
import { z } from "zod";
import type { ExecutionMode } from "@of/shared";

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  EXCHANGE: z.enum(["okx", "binance"]).default("okx"),
  DEFAULT_SYMBOLS: z.string().default("BTC-USDT-SWAP"),
  EXECUTION_MODE: z.enum(["ANALYSIS_ONLY", "PAPER", "LIVE"]).default("PAPER"),
  FOOTPRINT_INTERVAL_MS: z.coerce.number().default(60_000),
  BINANCE_API_KEY: z.string().optional().default(""),
  BINANCE_API_SECRET: z.string().optional().default(""),
  ENCRYPTION_KEY: z.string().default("dev-only-change-me"),
  LOG_LEVEL: z.string().default("info"),
});

const env = schema.parse(process.env);

export const config = {
  port: env.PORT,
  host: env.HOST,
  exchange: env.EXCHANGE,
  symbols: env.DEFAULT_SYMBOLS.split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  executionMode: env.EXECUTION_MODE as ExecutionMode,
  footprintIntervalMs: env.FOOTPRINT_INTERVAL_MS,
  binanceApiKey: env.BINANCE_API_KEY,
  binanceApiSecret: env.BINANCE_API_SECRET,
  encryptionKey: env.ENCRYPTION_KEY,
  logLevel: env.LOG_LEVEL,
  tickSizeFor(symbol: string): number {
    if (symbol.startsWith("BTC")) return Number(process.env.TICK_SIZE_BTC ?? 0.1);
    if (symbol.startsWith("ETH")) return Number(process.env.TICK_SIZE_ETH ?? 0.01);
    return 0.01;
  },
};

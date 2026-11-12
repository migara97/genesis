import "dotenv/config";
import { z } from "zod";
import type { ExecutionMode } from "@of/shared";

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  EXCHANGE: z.enum(["okx", "binance", "bybit"]).default("okx"),
  DEFAULT_SYMBOLS: z.string().default("BTC-USDT-SWAP"),
  EXECUTION_MODE: z.enum(["ANALYSIS_ONLY", "PAPER", "LIVE"]).default("PAPER"),
  FOOTPRINT_INTERVAL_MS: z.coerce.number().default(60_000),
  /** Phase 8: freeze signal/lifecycle/cost fingerprint (default on in PAPER). */
  VALIDATION_LOCK_CONFIG: z
    .string()
    .optional()
    .transform((v) => {
      if (v == null || v === "") return undefined;
      return v === "1" || v.toLowerCase() === "true";
    }),
  /** Phase 8: rotate OF focus across DEFAULT_SYMBOLS (ms). 0 = off. */
  FOCUS_ROTATION_MS: z.coerce.number().default(900_000),
  BINANCE_API_KEY: z.string().optional().default(""),
  BINANCE_API_SECRET: z.string().optional().default(""),
  ENCRYPTION_KEY: z.string().default("dev-only-change-me"),
  /** Phase 10: path to corporate CA bundle (also sets NODE_EXTRA_CA_CERTS). */
  TLS_CA_FILE: z.string().optional().default(""),
  /** Phase 10: disable TLS verify — local MITM only, never default on. */
  TLS_INSECURE: z.string().optional().default(""),
  LOG_LEVEL: z.string().default("info"),
});

const env = schema.parse(process.env);

const validationLockConfig =
  env.VALIDATION_LOCK_CONFIG ?? env.EXECUTION_MODE === "PAPER";

export const config = {
  port: env.PORT,
  host: env.HOST,
  exchange: env.EXCHANGE,
  symbols: env.DEFAULT_SYMBOLS.split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  executionMode: env.EXECUTION_MODE as ExecutionMode,
  footprintIntervalMs: env.FOOTPRINT_INTERVAL_MS,
  validationLockConfig,
  focusRotationMs: env.FOCUS_ROTATION_MS,
  binanceApiKey: env.BINANCE_API_KEY,
  binanceApiSecret: env.BINANCE_API_SECRET,
  encryptionKey: env.ENCRYPTION_KEY,
  tlsCaFile: env.TLS_CA_FILE,
  tlsInsecure:
    env.TLS_INSECURE === "1" || env.TLS_INSECURE.toLowerCase() === "true",
  logLevel: env.LOG_LEVEL,
  tickSizeFor(symbol: string): number {
    if (symbol.startsWith("BTC")) return Number(process.env.TICK_SIZE_BTC ?? 0.1);
    if (symbol.startsWith("ETH")) return Number(process.env.TICK_SIZE_ETH ?? 0.01);
    return 0.01;
  },
};

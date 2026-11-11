import type { FastifyBaseLogger } from "fastify";
import {
  BinanceFuturesMarketDataAdapter,
  OkxSwapMarketDataAdapter,
  type ExchangeMarketDataAdapter,
} from "@of/exchange";
import {
  buildScannerSnapshot,
  scoreAltSetup,
  DEFAULT_ALT_SCANNER_CONFIG,
} from "@of/orderflow";
import type { ScannerHit, ScannerSnapshot } from "@of/shared";
import { config } from "../config.js";
import { listMarkets } from "../markets/store.js";

const SCAN_MS = 60_000;
const TOP_VOLUME = 40;
const CONCURRENCY = 4;
const KLINE_LIMIT = 80;

let timer: NodeJS.Timeout | null = null;
let running = false;
let cache: ScannerSnapshot = {
  hits: [],
  universeSize: 0,
  updatedAt: 0,
  evidence: [
    {
      kind: "inferred",
      note: "Scanner idle — waiting for first REST pass.",
    },
  ],
};

function createAdapter(): ExchangeMarketDataAdapter {
  if (config.exchange === "binance") return new BinanceFuturesMarketDataAdapter();
  return new OkxSwapMarketDataAdapter();
}

export function getScannerSnapshot(): ScannerSnapshot {
  return cache;
}

export function startAltScanner(log: FastifyBaseLogger): void {
  if (timer) return;
  const run = () => {
    void scanOnce(log);
  };
  run();
  timer = setInterval(run, SCAN_MS);
}

export async function scanOnce(log: FastifyBaseLogger): Promise<ScannerSnapshot> {
  if (running) return cache;
  running = true;
  try {
    const favorites = listMarkets({
      exchange: config.exchange,
      status: "live",
      favorites: true,
      limit: 200,
      sort: "volume",
    }).items;
    const top = listMarkets({
      exchange: config.exchange,
      status: "live",
      limit: TOP_VOLUME,
      sort: "volume",
    }).items;

    const bySymbol = new Map<string, (typeof top)[number]>();
    for (const row of [...favorites, ...top]) {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row);
    }
    const universe = [...bySymbol.values()];
    const adapter = createAdapter();
    const hits: ScannerHit[] = [];

    for (let i = 0; i < universe.length; i += CONCURRENCY) {
      const batch = universe.slice(i, i + CONCURRENCY);
      const scored = await Promise.all(
        batch.map(async (row) => {
          try {
            const candles5m = await adapter.fetchKlines(row.symbol, "5m", KLINE_LIMIT);
            return scoreAltSetup({
              symbol: row.symbol,
              lastPrice: row.lastPrice ?? candles5m[candles5m.length - 1]?.close ?? 0,
              changePct24h: row.changePct24h,
              quoteVolume24h: row.volume24h,
              candles5m,
              tickSize: row.tickSize,
            });
          } catch (err) {
            log.warn({ err, symbol: row.symbol }, "scanner kline fetch failed");
            return null;
          }
        }),
      );
      for (const hit of scored) {
        if (hit) hits.push(hit);
      }
    }

    cache = buildScannerSnapshot(hits, universe.length, Date.now(), DEFAULT_ALT_SCANNER_CONFIG);
    log.info(
      { universe: universe.length, hits: cache.hits.length },
      "alt scanner refreshed",
    );
    return cache;
  } catch (err) {
    log.error({ err }, "alt scanner failed");
    return cache;
  } finally {
    running = false;
  }
}

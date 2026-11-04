import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { marketHub } from "../marketHub.js";
import { discoverMarkets } from "./discover.js";
import { syncInstruments, syncTickers } from "./store.js";

const TICKER_MS = 30_000;
let timer: NodeJS.Timeout | null = null;
let running = false;
let cycles = 0;

export function startMarketSync(log: FastifyBaseLogger): void {
  if (timer) return;
  const run = () => {
    void syncOnce(log);
  };
  run();
  timer = setInterval(run, TICKER_MS);
}

export async function syncOnce(log: FastifyBaseLogger): Promise<void> {
  if (running) return;
  running = true;
  cycles += 1;
  const refreshInstruments = cycles === 1 || cycles % 10 === 0;
  try {
    const discovered = await discoverMarkets(config.exchange);
    if (refreshInstruments) {
      const result = syncInstruments(config.exchange, discovered.instruments);
      for (const item of discovered.instruments) {
        marketHub.setTickSize(item.symbol, item.tickSize);
      }
      log.info(
        {
          exchange: config.exchange,
          instruments: result.upserted,
          added: result.added.length,
          delisted: result.delisted.length,
        },
        "instrument catalog synchronized",
      );
    }
    const tickers = syncTickers(config.exchange, discovered.tickers);
    log.info({ exchange: config.exchange, tickers }, "market tickers synchronized");
  } catch (err) {
    log.error({ err }, "market catalog sync failed");
  } finally {
    running = false;
  }
}

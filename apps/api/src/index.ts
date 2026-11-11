import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { PlaceOrderRequest } from "@of/shared";
import { config } from "./config.js";
import { executionService } from "./execution.js";
import { marketHub } from "./marketHub.js";
import { runSignalBacktest } from "./backtest.js";
import { BinanceFuturesMarketDataAdapter, OkxSwapMarketDataAdapter } from "@of/exchange";
import { startMarketSync } from "./markets/sync.js";
import {
  getInstrument,
  listMarkets,
  listQuotes,
  replaceCandleCache,
  setFavorite,
} from "./markets/store.js";
import { getScannerSnapshot, startAltScanner } from "./scanner/runner.js";
import { computeJournalMetrics, listSignalSetups } from "./signals/journal.js";
import { listPaperTrades } from "./validation/paperLedger.js";
import { buildValidationReport } from "./validation/report.js";
import { tapeCoverageNote } from "./validation/tapeArchive.js";

const app = Fastify({
  logger: { level: config.logLevel },
});

await app.register(cors, { origin: true });
await app.register(websocket);

app.get("/health", async () => ({
  ok: true,
  mode: executionService.getMode(),
  symbols: marketHub.streamingSymbols(),
  configuredSymbols: config.symbols,
  exchange: config.exchange,
  dataPolicy:
    "Live public market data via modular exchange adapters (OKX default, Binance optional). Aggressor flags are exchange-reported when provided. Institutional identity is never claimed.",
}));

app.get("/api/snapshots", async () => marketHub.listSnapshots());
app.get("/api/snapshots/:symbol", async (req, reply) => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const snap = marketHub.getSnapshot(symbol);
  if (!snap) return reply.code(404).send({ error: "Symbol not streaming" });
  return snap;
});

app.get("/api/scanner", async () => getScannerSnapshot());

app.get("/api/risk", async () => executionService.getRisk());
app.put("/api/risk", async (req) => {
  const body = req.body as Record<string, unknown>;
  return executionService.setRisk(body);
});

app.get("/api/mode", async () => ({
  mode: executionService.getMode(),
  defaultMode: "PAPER",
  liveRequiresConfirmation: true,
}));

app.post("/api/mode", async (req, reply) => {
  const schema = z.object({
    mode: z.enum(["ANALYSIS_ONLY", "PAPER", "LIVE"]),
    confirmLiveTrading: z.boolean().optional(),
  });
  const body = schema.parse(req.body);
  try {
    const mode = executionService.setMode(body.mode, body.confirmLiveTrading ?? false);
    return { mode };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post("/api/emergency-shutdown", async () => {
  executionService.emergencyShutdown();
  return { ok: true, emergencyShutdown: true };
});

app.post("/api/emergency-clear", async () => {
  executionService.clearEmergency();
  return { ok: true, emergencyShutdown: false };
});

app.get("/api/positions", async () => executionService.listPositions());
app.get("/api/orders", async () => executionService.listOrders());

app.post("/api/orders", async (req, reply) => {
  const schema = z.object({
    symbol: z.string(),
    side: z.enum(["BUY", "SELL"]),
    type: z.enum(["MARKET", "LIMIT", "STOP", "TAKE_PROFIT"]),
    quantity: z.number().positive(),
    price: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
    reduceOnly: z.boolean().optional(),
    clientOrderId: z.string().optional(),
    confirmLiveTrading: z.boolean().optional(),
  });
  const body = schema.parse(req.body) as PlaceOrderRequest;
  const order = await executionService.placeOrder(body);
  if (order.status === "REJECTED") return reply.code(400).send(order);
  return order;
});

app.delete("/api/orders/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const order = await executionService.cancelOrder(id);
  if (!order) return reply.code(404).send({ error: "Order not found" });
  return order;
});

app.get("/api/markets", async (req) => {
  const query = req.query as Record<string, string | undefined>;
  const result = listMarkets({
    exchange: config.exchange,
    q: query.q,
    quote: query.quote,
    status: query.status,
    sort: query.sort,
    favorites: query.favorites === "1" || query.favorites === "true",
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined,
  });
  return {
    exchange: config.exchange,
    streaming: marketHub.streamingSymbols(),
    quotes: listQuotes(config.exchange),
    total: result.total,
    items: result.items,
    sources: {
      ticker: "exchange_reported",
      marketCap: "unavailable",
      orderFlow: "calculated_for_selected_symbol",
    },
  };
});

app.post("/api/watchlist", async (req, reply) => {
  const body = z
    .object({
      symbol: z.string().min(3).max(40),
      favorite: z.boolean(),
    })
    .parse(req.body);
  const instrument = getInstrument(config.exchange, body.symbol);
  if (!instrument) return reply.code(404).send({ error: "Unknown symbol" });
  setFavorite(config.exchange, instrument.symbol, body.favorite);
  return { symbol: instrument.symbol, favorite: body.favorite };
});

app.get("/api/markets/:symbol/candles", async (req, reply) => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const interval = ((req.query as { interval?: string }).interval ?? "5m").toLowerCase();
  const allowed = new Set(["1m", "3m", "5m", "15m", "1h", "4h", "1d"]);
  if (!allowed.has(interval)) return reply.code(400).send({ error: "Unsupported interval" });
  const adapter =
    config.exchange === "binance"
      ? new BinanceFuturesMarketDataAdapter()
      : new OkxSwapMarketDataAdapter();
  const candles = await adapter.fetchKlines(symbol, interval, 200);
  replaceCandleCache(config.exchange, symbol, interval, candles);
  return { symbol, interval, source: "exchange_reported", candles };
});

app.get("/api/signals/journal", async (req) => {
  const q = req.query as { symbol?: string; limit?: string };
  const limit = q.limit ? Number(q.limit) : 50;
  return {
    setups: listSignalSetups({
      symbol: q.symbol?.toUpperCase(),
      limit: Number.isFinite(limit) ? limit : 50,
    }),
  };
});

app.get("/api/signals/metrics", async (req) => {
  const q = req.query as { symbol?: string };
  return computeJournalMetrics(q.symbol?.toUpperCase());
});

app.get("/api/validation/report", async (req) => {
  const q = req.query as { symbol?: string; setupClass?: string };
  const setupClass =
    q.setupClass === "RANGE_BREAK_RETEST" || q.setupClass === "OTHER"
      ? q.setupClass
      : undefined;
  return buildValidationReport(q.symbol?.toUpperCase(), { setupClass });
});

app.get("/api/validation/paper-trades", async (req) => {
  const q = req.query as { symbol?: string; limit?: string; setupClass?: string };
  const limit = q.limit ? Number(q.limit) : 50;
  const setupClass =
    q.setupClass === "RANGE_BREAK_RETEST" || q.setupClass === "OTHER"
      ? q.setupClass
      : undefined;
  return {
    trades: listPaperTrades({
      symbol: q.symbol?.toUpperCase(),
      limit: Number.isFinite(limit) ? limit : 50,
      setupClass,
    }),
  };
});

app.get("/api/validation/parity", async (req) => {
  const q = req.query as { symbol?: string };
  const symbol = (q.symbol ?? config.symbols[0] ?? "BTCUSDT").toUpperCase();
  return {
    symbol,
    exchange: config.exchange,
    tape: tapeCoverageNote(symbol, config.exchange),
    live: {
      gates: { minIndependent: 2, minScore: 2, domRequiresTradeDelta: true },
      inputs: ["structure", "mtf", "zones", "cvd", "footprint", "dom", "volumeProfile"],
    },
    historicalDefaultBacktest: {
      structureOnlyMode: true,
      inputs: ["structure", "mtf"],
      limitation:
        "Default /api/backtest is a structure/MTF proxy — not full live Order Flow parity. Do not claim complete-engine edge from it.",
    },
  };
});

app.get("/api/backtest/:symbol", async (req) => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const q = req.query as { feeBps?: string; slippageBps?: string };
  const adapter =
    config.exchange === "binance"
      ? new BinanceFuturesMarketDataAdapter()
      : new OkxSwapMarketDataAdapter();
  const [primary, d1, h4, h1, soft] = await Promise.all([
    adapter.fetchKlines(symbol, "5m", 300),
    adapter.fetchKlines(symbol, "1d", 120),
    adapter.fetchKlines(symbol, "4h", 180),
    adapter.fetchKlines(symbol, "1h", 300),
    adapter.fetchKlines(symbol, "1m", 300),
  ]);
  const feeBps = q.feeBps != null && Number.isFinite(Number(q.feeBps)) ? Number(q.feeBps) : 4;
  const slippageBps =
    q.slippageBps != null && Number.isFinite(Number(q.slippageBps)) ? Number(q.slippageBps) : 1;
  const result = runSignalBacktest(
    symbol,
    primary,
    [
      { interval: "1d", candles: d1 },
      { interval: "4h", candles: h4 },
      { interval: "1h", candles: h1 },
    ],
    soft,
    { feeBps, slippageBps, primaryInterval: "5m" },
  );
  return {
    symbol,
    ...result,
    // JSON-safe Infinity
    profitFactor:
      result.profitFactor == null
        ? null
        : Number.isFinite(result.profitFactor)
          ? result.profitFactor
          : null,
    profitFactorUnbounded: result.profitFactor === Number.POSITIVE_INFINITY,
  };
});

app.register(async (instance) => {
  instance.get("/ws", { websocket: true }, (socket) => {
    const send = (type: string, payload: unknown) => {
      if (socket.readyState !== 1) return;
      // Drop updates when the browser is behind so the API cannot buffer itself to OOM.
      if (socket.bufferedAmount > 1_000_000) return;
      socket.send(JSON.stringify({ type, payload, ts: Date.now() }));
    };

    send("hello", {
      mode: executionService.getMode(),
      symbols: marketHub.streamingSymbols(),
      snapshots: marketHub.listSnapshots(),
    });

    const onSnap = (snap: unknown) => send("snapshot", snap);
    const onHealth = (health: unknown) => send("health", health);
    marketHub.on("snapshot", onSnap);
    marketHub.on("health", onHealth);

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          symbol?: string;
          primaryInterval?: string;
        };
        if (msg.type === "ping") send("pong", {});
        if (msg.type === "subscribe" && msg.symbol) {
          const symbol = msg.symbol.toUpperCase();
          if (!/^[A-Z0-9._-]{3,40}$/.test(symbol)) {
            send("error", { error: "Invalid symbol" });
            return;
          }
          const instrument = getInstrument(config.exchange, symbol);
          if (instrument?.status === "delisted") {
            send("error", { error: "Symbol is delisted on this exchange" });
            return;
          }
          if (instrument) marketHub.setTickSize(symbol, instrument.tickSize);
          void marketHub.focus(symbol, msg.primaryInterval);
        }
      } catch {
        // ignore malformed client messages
      }
    });

    socket.on("close", () => {
      marketHub.off("snapshot", onSnap);
      marketHub.off("health", onHealth);
    });
  });
});

marketHub.on("error", (err: Error) => {
  app.log.error({ err }, "market data error (API stays up; retrying)");
});

try {
  // Always bind HTTP/WS first so the UI proxy does not get ECONNREFUSED
  // if the exchange is temporarily unreachable.
  const initialSymbol = config.symbols[0] ?? "BTC-USDT-SWAP";
  marketHub.bootstrapSymbols([initialSymbol]);
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Order Flow API listening on ${config.host}:${config.port} mode=${executionService.getMode()} streaming=${initialSymbol} exchange=${config.exchange}`,
  );
  void marketHub.focus(initialSymbol);
  startMarketSync(app.log);
  startAltScanner(app.log);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

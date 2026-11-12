import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { PlaceOrderRequest } from "@of/shared";
import { createMarketDataAdapter } from "@of/exchange";
import { config } from "./config.js";
import { applyTlsEnv } from "./tls.js";
import { setTlsInfo, buildHealthPayload, buildPrometheusMetrics } from "./ops/status.js";
import { listSecretsMasked, rotateEncryption, upsertSecret } from "./secrets/store.js";
import { executionService } from "./execution.js";
import { marketHub } from "./marketHub.js";
import { runSignalBacktest } from "./backtest.js";
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
import {
  createAlert,
  deleteAlert,
  listAlertFires,
  listAlerts,
} from "./alerts/store.js";
import { listLiveAudit } from "./execution/liveAudit.js";
import { listPaperTrades } from "./validation/paperLedger.js";
import { runParityReport } from "./validation/parityRunner.js";
import { buildValidationReport } from "./validation/report.js";

const tlsBoot = applyTlsEnv();
setTlsInfo(tlsBoot);

const app = Fastify({
  logger: { level: config.logLevel },
});
app.log.info({ tls: tlsBoot }, "TLS bootstrap");

await app.register(cors, { origin: true });
await app.register(websocket);

app.get("/health", async () => buildHealthPayload(executionService.getMode()));

app.get("/metrics", async (_req, reply) => {
  reply.type("text/plain; version=0.0.4");
  return buildPrometheusMetrics(executionService.getMode());
});

app.get("/api/secrets", async () => ({
  secrets: listSecretsMasked(),
  note: "Values are masked. Plaintext never returned to the client.",
}));

app.put("/api/secrets/:name", async (req, reply) => {
  const name = (req.params as { name: string }).name.toUpperCase();
  const body = z.object({ value: z.string().min(1) }).parse(req.body);
  try {
    return upsertSecret(name, body.value);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/secrets/rotate", async (req, reply) => {
  const body = z.object({ oldEncryptionKey: z.string().min(1) }).parse(req.body);
  try {
    return rotateEncryption(body.oldEncryptionKey);
  } catch (err) {
    return reply
      .code(400)
      .send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/snapshots", async () => marketHub.listSnapshots());
app.get("/api/snapshots/:symbol", async (req, reply) => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const snap = marketHub.getSnapshot(symbol);
  if (!snap) return reply.code(404).send({ error: "Symbol not streaming" });
  return snap;
});

app.get("/api/microstructure", async (req, reply) => {
  const q = req.query as { symbol?: string };
  const symbol = (q.symbol ?? config.symbols[0] ?? "BTCUSDT").toUpperCase();
  const micro = marketHub.getMicrostructure(symbol);
  const snap = marketHub.getSnapshot(symbol);
  if (!micro && !snap) {
    return reply.code(404).send({
      error: "Symbol not streaming — focus a market first",
      symbol,
    });
  }
  return {
    symbol,
    exchange: config.exchange,
    microstructure: micro ?? snap?.microstructure ?? null,
    domIceberg: snap?.dom?.iceberg ?? null,
    phase11Note:
      "Iceberg/refill and leader/lagger are heuristics with confidence bands. Commentary never mutates signal scores.",
  };
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

app.get("/api/alerts", async (req) => {
  const q = req.query as { symbol?: string; fired?: string; limit?: string };
  if (q.fired === "1" || q.fired === "true") {
    return { fires: listAlertFires(q.limit ? Number(q.limit) : 50) };
  }
  return {
    alerts: listAlerts({
      symbol: q.symbol,
    }),
  };
});

app.post("/api/alerts", async (req, reply) => {
  const body = z
    .object({
      symbol: z.string().min(3).max(40),
      kind: z.enum(["price", "signal"]),
      op: z.enum(["gte", "lte", "eq"]).optional(),
      threshold: z.number().optional().nullable(),
      lifecycle: z.string().optional().nullable(),
      enabled: z.boolean().optional(),
    })
    .parse(req.body);
  const instrument = getInstrument(config.exchange, body.symbol);
  if (!instrument) return reply.code(404).send({ error: "Unknown symbol" });
  if (body.kind === "price" && body.threshold == null) {
    return reply.code(400).send({ error: "price alerts require threshold" });
  }
  return createAlert({
    symbol: instrument.symbol,
    kind: body.kind,
    op: body.op,
    threshold: body.threshold,
    lifecycle: body.lifecycle,
    enabled: body.enabled,
  });
});

app.delete("/api/alerts/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!deleteAlert(id)) return reply.code(404).send({ error: "Alert not found" });
  return { ok: true };
});

app.get("/api/live-audit", async (req) => {
  const q = req.query as { limit?: string };
  return { entries: listLiveAudit(q.limit ? Number(q.limit) : 100) };
});

app.get("/api/markets/:symbol/candles", async (req, reply) => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const interval = ((req.query as { interval?: string }).interval ?? "5m").toLowerCase();
  const allowed = new Set(["1m", "3m", "5m", "15m", "1h", "4h", "1d"]);
  if (!allowed.has(interval)) return reply.code(400).send({ error: "Unsupported interval" });
  const adapter = createMarketDataAdapter(config.exchange);
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
  const q = req.query as { symbol?: string; setupClass?: string; allConfigs?: string };
  const setupClass =
    q.setupClass === "RANGE_BREAK_RETEST" || q.setupClass === "OTHER"
      ? q.setupClass
      : undefined;
  return buildValidationReport(q.symbol?.toUpperCase(), {
    setupClass,
    allConfigs: q.allConfigs === "1" || q.allConfigs === "true",
  });
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

/** Phase 8: reject runtime signal-weight overrides while the freeze is on. */
app.post("/api/validation/signal-config", async (_req, reply) => {
  if (config.validationLockConfig) {
    return reply.code(403).send({
      error: "VALIDATION_LOCK_CONFIG is enabled — signal weights cannot be changed during Phase 8.",
      locked: true,
    });
  }
  return reply.code(400).send({
    error: "Runtime signal-config overrides are not implemented; edit DEFAULT_SIGNAL_CONFIG in source after unlocking.",
    locked: false,
  });
});

app.get("/api/validation/parity", async (req) => {
  const q = req.query as {
    symbol?: string;
    run?: string;
    from?: string;
    to?: string;
    maxTicks?: string;
  };
  const symbol = (q.symbol ?? config.symbols[0] ?? "BTCUSDT").toUpperCase();
  const fromTs = q.from != null && Number.isFinite(Number(q.from)) ? Number(q.from) : undefined;
  const toTs = q.to != null && Number.isFinite(Number(q.to)) ? Number(q.to) : undefined;
  const maxTicks =
    q.maxTicks != null && Number.isFinite(Number(q.maxTicks)) ? Number(q.maxTicks) : undefined;
  return runParityReport({
    symbol,
    runReplay: q.run === "1" || q.run === "true",
    fromTs,
    toTs,
    maxTicks,
  });
});

app.get("/api/backtest/:symbol", async (req) => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const q = req.query as { feeBps?: string; slippageBps?: string };
  const adapter = createMarketDataAdapter(config.exchange);
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
    const onAlert = (fire: unknown) => send("alert", fire);
    marketHub.on("snapshot", onSnap);
    marketHub.on("health", onHealth);
    marketHub.on("alert", onAlert);

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
      marketHub.off("alert", onAlert);
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
  marketHub.startFocusRotation(app.log);
  startMarketSync(app.log);
  startAltScanner(app.log);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

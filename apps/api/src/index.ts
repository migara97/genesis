import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { PlaceOrderRequest } from "@of/shared";
import { config } from "./config.js";
import { executionService } from "./execution.js";
import { marketHub } from "./marketHub.js";
import { backtestFromCandles } from "./backtest.js";
import { BinanceFuturesMarketDataAdapter, OkxSwapMarketDataAdapter } from "@of/exchange";

const app = Fastify({
  logger: { level: config.logLevel },
});

await app.register(cors, { origin: true });
await app.register(websocket);

app.get("/health", async () => ({
  ok: true,
  mode: executionService.getMode(),
  symbols: config.symbols,
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

app.get("/api/backtest/:symbol", async (req) => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const adapter =
    config.exchange === "binance"
      ? new BinanceFuturesMarketDataAdapter()
      : new OkxSwapMarketDataAdapter();
  const candles = await adapter.fetchKlines(symbol, "15m", 300);
  const result = backtestFromCandles(symbol, candles);
  return {
    ...result,
    limitation:
      "Historical tape/order-flow not stored yet; this backtest is structure-biased and will mostly WAIT without multi-OF confirmations.",
  };
});

app.register(async (instance) => {
  instance.get("/ws", { websocket: true }, (socket) => {
    const send = (type: string, payload: unknown) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type, payload, ts: Date.now() }));
      }
    };

    send("hello", {
      mode: executionService.getMode(),
      symbols: config.symbols,
      snapshots: marketHub.listSnapshots(),
    });

    const onSnap = (snap: unknown) => send("snapshot", snap);
    const onHealth = (health: unknown) => send("health", health);
    marketHub.on("snapshot", onSnap);
    marketHub.on("health", onHealth);

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === "ping") send("pong", {});
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
  marketHub.bootstrapSymbols(config.symbols);
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Order Flow API listening on ${config.host}:${config.port} mode=${executionService.getMode()} symbols=${config.symbols.join(",")} exchange=${config.exchange}`,
  );
  void marketHub.start(config.symbols);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

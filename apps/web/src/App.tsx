import { useEffect, useMemo, useState } from "react";
import {
  emergencyShutdown,
  fetchMode,
  fetchOrders,
  fetchPositions,
  fetchRisk,
  placeOrder,
  setMode,
  updateRisk,
} from "./api";
import type {
  ExecutionMode,
  MarketSnapshot,
  OrderRecord,
  Position,
  RiskConfig,
} from "./types";
import { useMarketSocket } from "./useMarketSocket";

export default function App() {
  const { snapshots, health, connected, error } = useMarketSocket();
  const symbols = Object.keys(snapshots);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [mode, setModeState] = useState<ExecutionMode>("PAPER");
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [qty, setQty] = useState("0.001");
  const [stop, setStop] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const snap: MarketSnapshot | undefined = snapshots[symbol] ?? snapshots[symbols[0] ?? ""];

  useEffect(() => {
    if (!symbols.includes(symbol) && symbols[0]) setSymbol(symbols[0]);
  }, [symbols, symbol]);

  useEffect(() => {
    void (async () => {
      setModeState((await fetchMode()).mode);
      setRisk(await fetchRisk());
      setPositions(await fetchPositions());
      setOrders(await fetchOrders());
    })().catch((e) => setStatusMsg(String(e)));
  }, []);

  const refreshPortfolio = async () => {
    setPositions(await fetchPositions());
    setOrders(await fetchOrders());
    setRisk(await fetchRisk());
  };

  const onModeChange = async (next: ExecutionMode) => {
    try {
      if (next === "LIVE") {
        const ok = window.confirm(
          "Enable LIVE trading? This can place real orders with server-stored API keys. Paper remains recommended.",
        );
        if (!ok) return;
        await setMode("LIVE", true);
      } else {
        await setMode(next, false);
      }
      setModeState(next);
      setStatusMsg(`Mode set to ${next}`);
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  const submit = async (side: "BUY" | "SELL") => {
    if (!snap) return;
    try {
      const order = await placeOrder({
        symbol: snap.symbol,
        side,
        type: "MARKET",
        quantity: Number(qty),
        stopPrice: stop ? Number(stop) : snap.signal?.stopLoss,
        confirmLiveTrading: mode === "LIVE",
      });
      setStatusMsg(
        order.status === "REJECTED"
          ? `Rejected: ${order.rejectReason}`
          : `Order ${order.status} ${order.side} ${order.quantity} @ ${order.avgFillPrice ?? "-"}`,
      );
      await refreshPortfolio();
    } catch (e) {
      setStatusMsg(String(e));
    }
  };

  const cvdPath = useMemo(() => buildCvdPath(snap?.cvd?.points ?? []), [snap?.cvd?.points]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Order Flow Terminal</div>
        <span className={`pill ${connected ? "on" : "off"}`}>
          {connected ? "WS connected" : "WS disconnected"}
        </span>
        <span className={`pill ${health?.connected ? "on" : "off"}`}>
          {health?.exchange ?? "binance-futures"}{" "}
          {health?.connected ? "live" : "down"}
        </span>
        <span className="pill warn">Default: PAPER</span>
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {(symbols.length ? symbols : [symbol]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="price">{fmt(snap?.lastPrice)}</span>
        <div className="spacer" />
        <select value={mode} onChange={(e) => void onModeChange(e.target.value as ExecutionMode)}>
          <option value="ANALYSIS_ONLY">Analysis Only</option>
          <option value="PAPER">Paper Trading</option>
          <option value="LIVE">Live Trading</option>
        </select>
        <button className="danger" onClick={() => void emergencyShutdown().then(refreshPortfolio)}>
          Kill Switch
        </button>
      </header>

      <main className="layout">
        <section className="panel" style={{ gridRow: "1 / 3" }}>
          <h3>Order Book / DOM</h3>
          <div className="panel-body">
            <div className="kv" style={{ marginBottom: 8 }}>
              <span className="muted">Spread</span>
              <span>{fmt(snap?.dom?.spread)}</span>
              <span className="muted">Imbalance</span>
              <span>{((snap?.dom?.imbalance ?? 0) * 100).toFixed(1)}%</span>
              <span className="muted">Pull/Stack</span>
              <span>{snap?.dom?.pullStackHint ?? "-"}</span>
              <span className="muted">Spoof risk</span>
              <span>{snap?.dom?.spoofingRisk ?? "-"} (heuristic)</span>
            </div>
            <div className="dom">
              <div>
                <div className="muted">Asks</div>
                {(snap?.book?.asks ?? []).slice(0, 15).reverse().map((l) => (
                  <div className="row ask" key={`a-${l.price}`}>
                    <span>{fmt(l.price)}</span>
                    <span>{fmtQty(l.quantity)}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="muted">Bids</div>
                {(snap?.book?.bids ?? []).slice(0, 15).map((l) => (
                  <div className="row bid" key={`b-${l.price}`}>
                    <span>{fmt(l.price)}</span>
                    <span>{fmtQty(l.quantity)}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="disclaimer" style={{ marginTop: 8 }}>
              Visible L2 only. Large size ≠ institutional identity.
            </p>
          </div>
        </section>

        <section className="panel">
          <h3>Footprint (session bar)</h3>
          <div className="panel-body footprint">
            {!snap?.footprint ? (
              <div className="muted">Aggregating first footprint interval…</div>
            ) : (
              <>
                <div className="kv" style={{ marginBottom: 8 }}>
                  <span className="muted">Delta</span>
                  <span>{fmtQty(snap.footprint.totalDelta)}</span>
                  <span className="muted">Volume</span>
                  <span>{fmtQty(snap.footprint.totalVolume)}</span>
                  <span className="muted">Absorption</span>
                  <span>{snap.footprint.absorption ? "yes*" : "no"}</span>
                  <span className="muted">Exhaustion</span>
                  <span>{snap.footprint.exhaustion ? "yes*" : "no"}</span>
                </div>
                {snap.footprint.cells.slice(0, 24).map((c) => {
                  const tot = c.bidVolume + c.askVolume || 1;
                  return (
                    <div className="fp-row" key={c.price}>
                      <span className="sell">{fmtQty(c.bidVolume)}</span>
                      <div className="bar">
                        <span className="bid" style={{ width: `${(c.bidVolume / tot) * 50}%` }} />
                        <span className="ask" style={{ width: `${(c.askVolume / tot) * 50}%` }} />
                      </div>
                      <span className="buy">{fmtQty(c.askVolume)}</span>
                      <span>{fmt(c.price)}</span>
                    </div>
                  );
                })}
                <p className="disclaimer">* heuristic flags, not proven institutional activity</p>
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <h3>Signal Engine</h3>
          <div className="panel-body">
            <div className={`signal-${(snap?.signal?.direction ?? "WAIT").toLowerCase()}`}>
              {snap?.signal?.direction ?? "WAIT"}
            </div>
            <div className="kv" style={{ marginTop: 8 }}>
              <span className="muted">Confidence</span>
              <span>{((snap?.signal?.confidence ?? 0) * 100).toFixed(0)}%</span>
              <span className="muted">Entry</span>
              <span>{fmt(snap?.signal?.entry)}</span>
              <span className="muted">Stop</span>
              <span>{fmt(snap?.signal?.stopLoss)}</span>
              <span className="muted">TP</span>
              <span>{(snap?.signal?.takeProfit ?? []).map(fmt).join(" / ") || "-"}</span>
              <span className="muted">R:R</span>
              <span>{snap?.signal?.riskReward ?? "-"}</span>
            </div>
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              Confirmations: {(snap?.signal?.confirmations ?? []).join(", ") || "none"}
            </div>
            <div style={{ marginTop: 8 }}>
              <div className="muted">For</div>
              <ul className="list">
                {(snap?.signal?.reasonsFor ?? []).slice(0, 4).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div className="muted">Against</div>
              <ul className="list">
                {(snap?.signal?.reasonsAgainst ?? []).slice(0, 4).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="panel" style={{ gridRow: "1 / 3" }}>
          <h3>Execution / Risk</h3>
          <div className="panel-body">
            <div className="form-row">
              <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" />
              <input value={stop} onChange={(e) => setStop(e.target.value)} placeholder="stop" />
            </div>
            <div className="form-row">
              <button className="success" onClick={() => void submit("BUY")}>
                Buy / Long
              </button>
              <button className="danger" onClick={() => void submit("SELL")}>
                Sell / Short
              </button>
            </div>
            {statusMsg && <div className="muted">{statusMsg}</div>}
            {error && <div className="signal-short">{error}</div>}
            <div className="kv" style={{ marginTop: 10 }}>
              <span className="muted">Equity</span>
              <span>{fmt(risk?.accountEquity)}</span>
              <span className="muted">Risk %/trade</span>
              <span>{risk?.riskPercentPerTrade}</span>
              <span className="muted">Max daily loss %</span>
              <span>{risk?.maxDailyLossPercent}</span>
              <span className="muted">Emergency</span>
              <span>{risk?.emergencyShutdown ? "ON" : "off"}</span>
            </div>
            <div className="form-row" style={{ marginTop: 8 }}>
              <button
                onClick={() =>
                  void updateRisk({
                    riskPercentPerTrade: Number(
                      prompt("Risk % per trade", String(risk?.riskPercentPerTrade ?? 0.5)),
                    ),
                  }).then(refreshPortfolio)
                }
              >
                Edit Risk %
              </button>
            </div>
            <p className="disclaimer">
              Paper is default. Live requires explicit confirmation and server-side API keys.
              Secrets never ship to the browser.
            </p>
          </div>
        </section>

        <section className="panel">
          <h3>CVD</h3>
          <div className="panel-body">
            <div className="kv">
              <span className="muted">Session CVD</span>
              <span>{fmtQty(snap?.cvd?.cvd)}</span>
              <span className="muted">Divergence</span>
              <span>{snap?.cvd?.divergence ?? "-"}</span>
              <span className="muted">Exhaustion</span>
              <span>{snap?.cvd?.exhaustion ? "yes*" : "no"}</span>
            </div>
            <svg className="cvd-chart" viewBox="0 0 300 120" preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke="#3b82f6"
                strokeWidth="2"
                points={cvdPath}
              />
            </svg>
          </div>
        </section>

        <section className="panel">
          <h3>Volume Profile / Structure</h3>
          <div className="panel-body">
            <div className="kv">
              <span className="muted">POC</span>
              <span>{fmt(snap?.volumeProfile?.poc)}</span>
              <span className="muted">VAH / VAL</span>
              <span>
                {fmt(snap?.volumeProfile?.vah)} / {fmt(snap?.volumeProfile?.val)}
              </span>
              <span className="muted">Trend</span>
              <span>{snap?.structure?.trend ?? "-"}</span>
              <span className="muted">BOS</span>
              <span>
                {snap?.structure?.lastBos
                  ? `${snap.structure.lastBos.direction} @ ${fmt(snap.structure.lastBos.price)}`
                  : "-"}
              </span>
              <span className="muted">CHoCH</span>
              <span>
                {snap?.structure?.lastChoch
                  ? `${snap.structure.lastChoch.direction} @ ${fmt(snap.structure.lastChoch.price)}`
                  : "-"}
              </span>
            </div>
            <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              Liquidity pools:{" "}
              {(snap?.structure?.liquidityPools ?? [])
                .slice(0, 4)
                .map((p) => `${p.side} ${fmt(p.price)}`)
                .join(" · ") || "-"}
            </div>
          </div>
        </section>

        <section className="panel">
          <h3>Time & Sales</h3>
          <div className="panel-body tape">
            {(snap?.recentTrades ?? [])
              .slice()
              .reverse()
              .slice(0, 40)
              .map((t) => (
                <div className="row" key={t.tradeId + t.timestamp}>
                  <span className={t.buyerAggressor ? "buy" : "sell"}>
                    {t.buyerAggressor ? "BUY" : "SELL"}
                  </span>
                  <span>{fmt(t.price)}</span>
                  <span>{fmtQty(t.quantity)}</span>
                </div>
              ))}
          </div>
        </section>

        <section className="panel" style={{ gridColumn: "1 / 3" }}>
          <h3>Open Positions</h3>
          <div className="panel-body">
            <table className="table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Mode</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Entry</th>
                  <th>uPnL</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={`${p.mode}-${p.symbol}`}>
                    <td>{p.symbol}</td>
                    <td>{p.mode}</td>
                    <td>{p.side}</td>
                    <td>{fmtQty(p.quantity)}</td>
                    <td>{fmt(p.entryPrice)}</td>
                    <td className={p.unrealizedPnl >= 0 ? "buy" : "sell"}>
                      {fmt(p.unrealizedPnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel" style={{ gridColumn: "3 / 5" }}>
          <h3>Order History</h3>
          <div className="panel-body">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {orders.slice(0, 30).map((o) => (
                  <tr key={o.id}>
                    <td>{new Date(o.createdAt).toLocaleTimeString()}</td>
                    <td>{o.status}</td>
                    <td>{o.side}</td>
                    <td>{fmtQty(o.quantity)}</td>
                    <td>{fmt(o.avgFillPrice)}</td>
                    <td>{o.rejectReason ?? o.mode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function fmt(n?: number): string {
  if (n == null || Number.isNaN(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

function fmtQty(n?: number): string {
  if (n == null || Number.isNaN(n)) return "-";
  return n.toFixed(4);
}

function buildCvdPath(
  points: { cvd: number }[],
): string {
  if (points.length < 2) return "0,60 300,60";
  const vals = points.map((p) => p.cvd);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  return points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 300;
      const y = 110 - ((p.cvd - min) / span) * 100;
      return `${x},${y}`;
    })
    .join(" ");
}

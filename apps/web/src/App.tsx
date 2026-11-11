import { useEffect, useState, type ReactNode } from "react";
import {
  emergencyShutdown,
  fetchBacktest,
  fetchMode,
  fetchOrders,
  fetchPositions,
  fetchRisk,
  fetchSignalJournal,
  fetchSignalMetrics,
  fetchValidationReport,
  placeOrder,
  setMode,
  updateRisk,
} from "./api";
import type {
  BacktestResultView,
  BreakRetestState,
  ChartOverlayState,
  CvdState,
  ExecutionMode,
  FootprintBar,
  MarketSnapshot,
  MarketStructureState,
  MultiTimeframeContext,
  OrderRecord,
  Position,
  RiskConfig,
  ScenarioTreeState,
  SignalJournalMetrics,
  SignalSetupRow,
  StructureTarget,
  StructureZonesState,
  TradeScenario,
  TradingSignal,
  VolumeProfile,
} from "./types";
import { CandleChart } from "./CandleChart";
import { DepthChart } from "./DepthChart";
import { Markets } from "./Markets";
import { ScannerPanel } from "./ScannerPanel";
import { readStoredPrimaryInterval, useMarketSocket } from "./useMarketSocket";

export default function App() {
  const { snapshots, health, connected, error, subscribe, setPrimaryInterval } = useMarketSocket();
  const symbols = Object.keys(snapshots);
  const [symbol, setSymbol] = useState("");
  const [primaryInterval, setPrimaryLocal] = useState<"5m" | "15m">(readStoredPrimaryInterval());
  const [pinned, setPinned] = useState(false);
  const [mode, setModeState] = useState<ExecutionMode>("PAPER");
  const [risk, setRisk] = useState<RiskConfig | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [qty, setQty] = useState("0.001");
  const [stop, setStop] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const snap: MarketSnapshot | undefined =
    snapshots[symbol] ?? (!pinned ? snapshots[symbols[0] ?? ""] : undefined);

  useEffect(() => {
    if (!pinned && !symbol && symbols[0]) setSymbol(symbols[0]);
  }, [pinned, symbol, symbols]);

  const selectSymbol = (next: string) => {
    setPinned(true);
    setSymbol(next);
    subscribe(next, primaryInterval);
  };

  const onPrimaryChange = (next: "5m" | "15m") => {
    setPrimaryLocal(next);
    setPrimaryInterval(next);
    if (symbol) subscribe(symbol, next);
  };

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
        <span className="pill">{symbol || "select a market"}</span>
        <span className="pill">{snap?.primaryInterval ?? primaryInterval} primary</span>
        <span className="price">{fmt(snap?.lastPrice)}</span>
        <div className="spacer" />
        <select
          value={primaryInterval}
          onChange={(e) => onPrimaryChange(e.target.value as "5m" | "15m")}
          aria-label="Primary timeframe"
          title="Desk primary TF (structure/zones/overlays)"
        >
          <option value="5m">Primary 5m</option>
          <option value="15m">Primary 15m</option>
        </select>
        <select value={mode} onChange={(e) => void onModeChange(e.target.value as ExecutionMode)}>
          <option value="ANALYSIS_ONLY">Analysis Only</option>
          <option value="PAPER">Paper Trading</option>
          <option value="LIVE">Live Trading</option>
        </select>
        <button className="danger" onClick={() => void emergencyShutdown().then(refreshPortfolio)}>
          Kill Switch
        </button>
      </header>

      <Markets selected={symbol} onSelect={selectSymbol} />
      <ScannerPanel selected={symbol} onSelect={selectSymbol} />

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
            <DepthChart bids={snap?.book?.bids ?? []} asks={snap?.book?.asks ?? []} />
            <p className="disclaimer" style={{ marginTop: 8 }}>
              Visible L2 only. Depth is calculated from the exchange book. Large size ≠ institutional identity.
            </p>
          </div>
        </section>

        <section className="panel of-fill">
          <h3>Footprint (session bar)</h3>
          <div className="panel-body">
            <FootprintBoard bar={snap?.footprint} sessionCvd={snap?.cvd?.cvd} />
          </div>
        </section>

        <section className="panel of-fill">
          <h3>Signal Engine</h3>
          <div className="panel-body">
            <SignalBoard signal={snap?.signal} symbol={snap?.symbol} cvd={snap?.cvd} footprint={snap?.footprint} structure={snap?.structure} mtf={snap?.mtf} zones={snap?.zones} breakRetest={snap?.breakRetest} scenarios={snap?.scenarios} />
          </div>
        </section>

        <section className="panel" style={{ gridRow: "1 / 3" }}>
          <h3>Execution / Risk</h3>
          <div className="panel-body">
            <div className="desk-block">
              <div className="desk-kicker">Order ticket</div>
              <div className="ticket">
                <label className="field">
                  <span>Quantity</span>
              <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" />
                </label>
                <label className="field">
                  <span>Stop loss</span>
              <input value={stop} onChange={(e) => setStop(e.target.value)} placeholder="stop" />
                </label>
            </div>
              <div className="trade-actions">
              <button className="success" onClick={() => void submit("BUY")}>
                Buy / Long
              </button>
              <button className="danger" onClick={() => void submit("SELL")}>
                Sell / Short
              </button>
            </div>
            </div>
            {statusMsg && <div className="status-line">{statusMsg}</div>}
            {error && <div className="signal-short">{error}</div>}
            <div className="desk-block">
              <div className="desk-kicker">Signal plan</div>
              <div className="metric-grid">
                <div className="metric">
                  <span>Entry</span>
                  <strong>{fmt(snap?.signal?.entry)}</strong>
                </div>
                <div className="metric">
                  <span>Stop</span>
                  <strong className="sell">{fmt(snap?.signal?.stopLoss)}</strong>
                </div>
                <div className="metric">
                  <span>Risk TP (R)</span>
                  <strong className="buy">{(snap?.signal?.takeProfit ?? []).map(fmt).join(" / ") || "-"}</strong>
                </div>
                <div className="metric">
                  <span>Risk / reward</span>
                  <strong>{snap?.signal?.riskReward ?? "-"}</strong>
                </div>
                <div className="metric" style={{ gridColumn: "1 / -1" }}>
                  <span>Structure TP</span>
                  <strong className="buy">
                    {(snap?.signal?.structureTargets ?? []).length
                      ? (snap?.signal?.structureTargets ?? [])
                          .map((t) => `${shortTargetKind(t.kind)} ${fmt(t.price)}${t.hitAt ? " ✓" : ""}`)
                          .join(" · ")
                      : "-"}
                  </strong>
                </div>
              </div>
            </div>
            <div className="desk-block">
              <div className="desk-kicker">Account risk</div>
              <div className="metric-grid">
                <div className="metric">
                  <span>Equity</span>
                  <strong>{fmt(risk?.accountEquity)}</strong>
                </div>
                <div className="metric">
                  <span>Risk / trade</span>
                  <strong>{risk?.riskPercentPerTrade ?? "-"}%</strong>
                </div>
                <div className="metric">
                  <span>Max daily loss</span>
                  <strong>{risk?.maxDailyLossPercent ?? "-"}%</strong>
                </div>
                <div className="metric">
                  <span>Emergency</span>
                  <strong className={risk?.emergencyShutdown ? "sell" : "buy"}>
                    {risk?.emergencyShutdown ? "ON" : "Off"}
                  </strong>
                </div>
              </div>
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

        <section className="panel of-fill">
          <h3>CVD</h3>
          <div className="panel-body">
            <CvdBoard
              cvd={snap?.cvd}
              symbol={symbol}
              overlay={snap?.chartOverlay}
              breakRetest={snap?.breakRetest}
              structureTargets={snap?.signal?.structureTargets}
              scenarios={snap?.scenarios}
              primaryInterval={snap?.primaryInterval ?? primaryInterval}
            />
          </div>
        </section>

        <section className="panel of-fill">
          <h3>Volume Profile / Structure</h3>
          <div className="panel-body">
            <StructureBoard profile={snap?.volumeProfile} structure={snap?.structure} lastPrice={snap?.lastPrice} />
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

        <section className="panel" style={{ gridColumn: "1 / 3", gridRow: "4", minHeight: 220 }}>
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

        <section className="panel" style={{ gridColumn: "3 / 5", gridRow: "4", minHeight: 220 }}>
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

function FootprintBoard({ bar, sessionCvd }: { bar?: FootprintBar; sessionCvd?: number }) {
  if (!bar) return <div className="muted">Aggregating first footprint interval…</div>;
  const cells = [...bar.cells].sort((a, b) => b.price - a.price);
  const imbalances = bar.imbalances ?? [];
  const maxTotal = Math.max(...cells.map((cell) => cell.bidVolume + cell.askVolume), 0);
  const maxAbsDelta = Math.max(...cells.map((cell) => Math.abs(cell.delta)), 0);
  const trades = cells.reduce((sum, cell) => sum + (cell.trades ?? 0), 0);
  return (
    <div className="detail-board">
      <div className="of-head">
      <div className="stat-row">
        <div className="stat">
          <span>Delta</span>
          <strong className={bar.totalDelta >= 0 ? "buy" : "sell"}>{fmtQty(bar.totalDelta)}</strong>
        </div>
        <div className="stat">
          <span>Volume</span>
          <strong>{fmtQty(bar.totalVolume)}</strong>
        </div>
        <div className="stat">
          <span>High / low</span>
          <strong>{fmt(bar.high)} / {fmt(bar.low)}</strong>
        </div>
      </div>
      <div className="chip-row">
        <span className={bar.absorption ? "chip hot" : "chip"}>Absorption {bar.absorption ? "yes*" : "no"}</span>
        <span className={bar.exhaustion ? "chip hot" : "chip"}>Exhaustion {bar.exhaustion ? "yes*" : "no"}</span>
        <span className={bar.unfinishedAuction ? "chip hot" : "chip"}>
          Unfinished auction {bar.unfinishedAuction ? "yes" : "no"}
        </span>
        {trades > 0 && <span className="chip">{trades} trades</span>}
      </div>
      </div>
      <div className="scroll-box">
        <table className="table fp-table">
          <thead>
            <tr>
              <th>Price</th>
              <th>Bid</th>
              <th>Ask</th>
              <th>Total</th>
              <th>Delta</th>
              <th>Imbalance</th>
            </tr>
          </thead>
          <tbody>
            {cells.map((cell) => {
              const total = cell.bidVolume + cell.askVolume;
              const scale = total || 1;
              const mark = imbalances.find((item) => item.price === cell.price);
              const flags = [
                mark?.stacked ? "stacked" : "",
                mark?.diagonal ? "diagonal" : "",
                mark ? mark.side : "",
              ].filter(Boolean);
              const title = `Price ${fmt(cell.price)}. Bid ${fmtQty(cell.bidVolume)}. Ask ${fmtQty(cell.askVolume)}. Total ${fmtQty(total)}. Delta ${fmtQty(cell.delta)}. ${mark ? `Imbalance ${flags.join(" ")} ${mark.ratio ?? ""}` : "No imbalance flag."}`;
              return (
                <tr
                  key={cell.price}
                  title={title}
                  className={[
                    cell.price === bar.open ? "is-open" : "",
                    cell.price === bar.close ? "is-close" : "",
                    total > 0 && total === maxTotal ? "is-heavy" : "",
                    maxAbsDelta > 0 && Math.abs(cell.delta) === maxAbsDelta ? "is-delta" : "",
                  ].join(" ")}
                >
                  <td>
                    {fmt(cell.price)}
                    {cell.price === bar.open && <em> open</em>}
                    {cell.price === bar.close && <em> close</em>}
                  </td>
                  <td className="sell">
                    <span className="mini-bar sell-swatch" style={{ width: `${(cell.bidVolume / scale) * 100}%` }} />
                    {fmtQty(cell.bidVolume)}
                  </td>
                  <td className="buy">
                    <span className="mini-bar buy-swatch" style={{ width: `${(cell.askVolume / scale) * 100}%` }} />
                    {fmtQty(cell.askVolume)}
                  </td>
                  <td>{fmtQty(total)}</td>
                  <td className={cell.delta >= 0 ? "buy" : "sell"}>{fmtQty(cell.delta)}</td>
                  <td>
                    {mark
                      ? `${mark.side}${mark.ratio != null ? ` ${mark.ratio.toFixed(1)}×` : ""}${mark.stacked ? " stacked" : ""}${mark.diagonal ? " diagonal" : ""}`
                      : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      <div className="stat-row">
        <div className="stat">
          <span>Session</span>
          <strong>{fmtClock(bar.openTime)} – {fmtClock(bar.closeTime)}</strong>
        </div>
        <div className="stat">
          <span>Open / close</span>
          <strong>{fmt(bar.open)} / {fmt(bar.close)}</strong>
        </div>
        <div className="stat">
          <span>Session CVD</span>
          <strong className={(sessionCvd ?? 0) >= 0 ? "buy" : "sell"}>{fmtQty(sessionCvd)}</strong>
        </div>
      </div>
      <p className="disclaimer">* absorption and exhaustion are heuristics, not proven institutional activity. Hover a row for the level detail.</p>
      </div>
    </div>
  );
}

function SignalBoard({
  signal,
  symbol,
  cvd,
  footprint,
  structure,
  mtf,
  zones,
  breakRetest,
  scenarios,
}: {
  signal?: TradingSignal;
  symbol?: string;
  cvd?: CvdState;
  footprint?: FootprintBar;
  structure?: MarketStructureState;
  mtf?: MultiTimeframeContext;
  zones?: StructureZonesState;
  breakRetest?: BreakRetestState;
  scenarios?: ScenarioTreeState;
}) {
  const direction = signal?.direction ?? "WAIT";
  const [metrics, setMetrics] = useState<SignalJournalMetrics | null>(null);
  const [journal, setJournal] = useState<SignalSetupRow[]>([]);
  const [backtest, setBacktest] = useState<BacktestResultView | null>(null);
  const [btBusy, setBtBusy] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [validation, setValidation] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [m, j, v] = await Promise.all([
          fetchSignalMetrics(symbol),
          fetchSignalJournal(symbol, 12),
          fetchValidationReport(symbol),
        ]);
        if (cancelled) return;
        setMetrics(m);
        setJournal(j.setups);
        setValidation(v);
      } catch {
        if (!cancelled) {
          setMetrics(null);
          setJournal([]);
          setValidation(null);
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, signal?.lifecycle, signal?.setupId]);

  const runBacktest = async () => {
    if (!symbol) return;
    setBtBusy(true);
    setBtError(null);
    try {
      setBacktest(await fetchBacktest(symbol));
    } catch (err) {
      setBtError(err instanceof Error ? err.message : String(err));
    } finally {
      setBtBusy(false);
    }
  };

  return (
    <div className="detail-board">
      <div className="of-head">
      <div className={`signal-banner signal-${direction.toLowerCase()}`}>
        <div>
          <span className="desk-kicker">Bias</span>
          <div className="signal-dir">{direction}</div>
        </div>
        <div className="confidence">
          <span className="desk-kicker">Confidence</span>
          <strong>{((signal?.confidence ?? 0) * 100).toFixed(0)}%</strong>
          <div className="confidence-track">
            <span style={{ width: `${Math.min(100, (signal?.confidence ?? 0) * 100)}%` }} />
          </div>
        </div>
      </div>
      <div className="chip-row">
        <span className={`chip ${entryGradeChipClass(signal?.entryGrade)}`} title={(signal?.entryQualityNotes ?? []).join("\n")}>
          Entry {signal?.entryGrade ?? "WAIT"}
        </span>
        <span className={`chip ${lifecycleChipClass(signal?.lifecycle)}`}>
          Lifecycle {signal?.lifecycle ?? "WATCHING"}
        </span>
        {signal?.lifecycleNote ? <span className="chip">{signal.lifecycleNote}</span> : null}
      </div>
      </div>
      <div className="fill-scroll">
      <div className="metric-grid">
        <div className="metric">
          <span>Entry</span>
          <strong>{fmt(signal?.entry)}</strong>
        </div>
        <div className="metric">
          <span>Stop</span>
          <strong className="sell">{fmt(signal?.stopLoss)}</strong>
        </div>
        <div className="metric">
          <span>Risk TP (R)</span>
          <strong className="buy">{(signal?.takeProfit ?? []).map(fmt).join(" / ") || "-"}</strong>
        </div>
        <div className="metric">
          <span>Risk / reward</span>
          <strong>{signal?.riskReward ?? "-"}</strong>
        </div>
      </div>
      <div className="desk-kicker">Structure TP (geometry)</div>
      <div className="chip-row">
        {(signal?.structureTargets ?? []).map((t) => (
          <span key={t.id} className={`chip ${t.hitAt ? "ok" : ""}`} title={t.label}>
            {shortTargetKind(t.kind)} {fmt(t.price)}
            {t.hitAt ? " hit" : ""}
          </span>
        ))}
        {(signal?.structureTargets ?? []).length === 0 && (
          <span className="chip">No structure targets (WAIT or no geometry)</span>
        )}
      </div>
      <div className="desk-kicker">Checks already computed</div>
      <div className="chip-row">
        <span className={signal?.orderFlowOk ? "chip ok" : "chip"}>Order flow {signal?.orderFlowOk ? "confirmed" : "waiting"}</span>
        <span className={signal?.deltaOk ? "chip ok" : "chip"}>Delta {signal?.deltaOk ? "confirmed" : "waiting"}</span>
        <span className={signal?.volumeOk ? "chip ok" : "chip"}>Volume {signal?.volumeOk ? "confirmed" : "waiting"}</span>
        <span className={signal?.structureOk ? "chip ok" : "chip"}>Structure {signal?.structureOk ? "confirmed" : "waiting"}</span>
      </div>
      <div className="metric-grid">
        <div className="metric">
          <span>Long score</span>
          <strong className="buy">{signal?.score?.longScore ?? "-"}</strong>
        </div>
        <div className="metric">
          <span>Short score</span>
          <strong className="sell">{signal?.score?.shortScore ?? "-"}</strong>
        </div>
        <div className="metric">
          <span>Families</span>
          <strong>{(signal?.score?.independentFamilies ?? []).join(", ") || "-"}</strong>
        </div>
        <div className="metric">
          <span>Setup id</span>
          <strong>{signal?.setupId ?? signal?.id ?? "-"}</strong>
        </div>
      </div>
      {signal?.score?.factors?.length ? (
        <>
          <div className="desk-kicker">Score factors</div>
          <ul className="list">
            {signal.score.factors.map((factor) => (
              <li key={`${factor.id}-${factor.side}-${factor.reason}`}>
                {factor.side} · {factor.family} · {factor.weight} · {factor.source} — {factor.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="reason-grid">
        <div>
          <div className="desk-kicker">Order flow context</div>
          <ul className="list">
            <li>CVD {cvd?.cvd == null ? "-" : fmtQty(cvd.cvd)} · divergence {cvd?.divergence ?? "-"}</li>
            <li>Absorption {footprint?.absorption ? "yes*" : "no"} · exhaustion {footprint?.exhaustion ? "yes*" : "no"}</li>
            <li>Footprint delta {footprint ? fmtQty(footprint.totalDelta) : "-"}</li>
          </ul>
        </div>
        <div>
          <div className="desk-kicker">Structure context</div>
          <ul className="list">
            <li>Trend {structure?.trend ?? "-"}</li>
            <li>
              BOS {structure?.lastBos ? `${structure.lastBos.direction} @ ${fmt(structure.lastBos.price)}` : "-"}
            </li>
            <li>
              CHoCH {structure?.lastChoch ? `${structure.lastChoch.direction} @ ${fmt(structure.lastChoch.price)}` : "-"}
            </li>
          </ul>
        </div>
      </div>
      <div className="desk-kicker">Multi-timeframe</div>
      <div className="chip-row">
        {(mtf?.frames ?? []).map((frame) => (
          <span key={frame.interval} className={`chip ${trendClass(frame.trend)}`}>
            {frame.interval} {frame.trend}
          </span>
        ))}
        {(mtf?.frames ?? []).length === 0 && <span className="chip">MTF loading…</span>}
        {mtf?.conflictWithPrimary ? <span className="chip hot">HTF conflict</span> : null}
      </div>
      <div className="desk-kicker">Zones (rule-based)</div>
      <div className="chip-row">
        {(zones?.orderBlocks ?? []).slice(-4).map((block) => (
          <span key={block.id} className={`chip ${trendClass(block.direction)}`}>
            OB {block.direction} {fmt(block.low)}–{fmt(block.high)}
          </span>
        ))}
        {(zones?.fairValueGaps ?? []).slice(-4).map((gap) => (
          <span key={gap.id} className={`chip ${trendClass(gap.direction)}`}>
            FVG {gap.direction} {fmt(gap.low)}–{fmt(gap.high)}
          </span>
        ))}
        {(zones?.recentSweeps ?? []).slice(-3).map((sweep) => (
          <span key={sweep.id} className={`chip ${trendClass(sweep.bias)}`}>
            {sweep.side} sweep → {sweep.bias}
          </span>
        ))}
        {(zones?.orderBlocks?.length ?? 0) +
          (zones?.fairValueGaps?.length ?? 0) +
          (zones?.recentSweeps?.length ?? 0) ===
          0 && <span className="chip">No active OB/FVG/sweeps</span>}
      </div>
      <div className="desk-kicker">Break / retest playbook</div>
      <div className="chip-row">
        <span
          className={`chip ${
            breakRetest?.phase === "accepted"
              ? "ok"
              : breakRetest?.phase === "failed" || breakRetest?.phase === "invalidated"
                ? "hot"
                : ""
          }`}
        >
          {breakRetest?.phase?.toUpperCase() ?? "IDLE"}
          {breakRetest?.side ? ` · ${breakRetest.side}` : ""}
        </span>
        {breakRetest?.bandLow != null && breakRetest?.bandHigh != null ? (
          <span className="chip">
            band {fmt(breakRetest.bandLow)}–{fmt(breakRetest.bandHigh)}
          </span>
        ) : null}
        <span className="muted" style={{ fontSize: 12 }}>
          {breakRetest?.reason ?? "Waiting for demand/supply balance."}
        </span>
      </div>
      <div className="desk-kicker">Scenarios</div>
      <div className="chip-row">
        <span className={`chip ${scenarios?.bias === "bullish" ? "ok" : scenarios?.bias === "bearish" ? "hot" : ""}`}>
          Bias {scenarios?.bias ?? "none"}
        </span>
        {(scenarios?.scenarios ?? []).map((sc) => (
          <span
            key={sc.id}
            className={`chip ${scenarioStatusChipClass(sc.status)}`}
            title={`${sc.reason}\n${sc.rankNote}`}
          >
            {scenarioKindShort(sc.kind)} · {sc.status} · entry {fmt(sc.entryLow)}–{fmt(sc.entryHigh)} · inv{" "}
            {fmt(sc.invalidation)} · rank {(sc.rankScore * 100).toFixed(0)}
          </span>
        ))}
        {(scenarios?.scenarios ?? []).length === 0 && (
          <span className="chip">No live scenarios</span>
        )}
      </div>
      <p className="disclaimer" style={{ marginTop: 4 }}>
        Hypotheses only — rank is not a win rate. Executable path remains the single TradingSignal + break/retest accept.
      </p>
      <div className="desk-kicker">Confirmations</div>
      <ul className="list">
        {(signal?.confirmations ?? []).map((item) => (
          <li key={item}>{item}</li>
        ))}
        {(signal?.confirmations ?? []).length === 0 && <li>None yet</li>}
      </ul>
      <div className="reason-grid">
        <div>
          <div className="desk-kicker buy">Supporting</div>
          <ul className="list">
            {(signal?.reasonsFor ?? []).map((item) => (
              <li key={item}>{item}</li>
            ))}
            {(signal?.reasonsFor ?? []).length === 0 && <li>-</li>}
          </ul>
        </div>
        <div>
          <div className="desk-kicker sell">Against</div>
          <ul className="list">
            {(signal?.reasonsAgainst ?? []).map((item) => (
              <li key={item}>{item}</li>
            ))}
            {(signal?.reasonsAgainst ?? []).length === 0 && <li>-</li>}
          </ul>
        </div>
      </div>
      <div className="desk-kicker">Invalidation</div>
      <ul className="list">
        {(signal?.invalidation ?? []).map((item) => (
          <li key={item}>{item}</li>
        ))}
        {(signal?.invalidation ?? []).length === 0 && <li>-</li>}
      </ul>
      <div className="desk-kicker">Current signal</div>
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Pair</th>
            <th>Direction</th>
            <th>Price</th>
            <th>Strength</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{fmtClock(signal?.timestamp)}</td>
            <td>{symbol ?? "-"}</td>
            <td className={direction === "LONG" ? "buy" : direction === "SHORT" ? "sell" : ""}>{direction}</td>
            <td>{fmt(signal?.entry)}</td>
            <td>{((signal?.confidence ?? 0) * 100).toFixed(0)}%</td>
          </tr>
        </tbody>
      </table>
      <div className="desk-kicker">Live journal metrics</div>
      <div className="metric-grid">
        <div className="metric">
          <span>Setups</span>
          <strong>{metrics?.setups ?? "-"}</strong>
        </div>
        <div className="metric">
          <span>TP / SL</span>
          <strong>
            {metrics ? `${metrics.hitTp} / ${metrics.hitSl}` : "-"}
          </strong>
        </div>
        <div className="metric">
          <span>Win rate</span>
          <strong>
            {metrics?.winRate == null ? "n/a" : `${(metrics.winRate * 100).toFixed(0)}%`}
          </strong>
        </div>
        <div className="metric">
          <span>Open</span>
          <strong>{metrics?.open ?? "-"}</strong>
        </div>
      </div>
      {metrics?.sampleNote ? <p className="disclaimer">{metrics.sampleNote}</p> : null}
      <div className="desk-kicker">Recent setups</div>
      <ul className="list">
        {journal.map((row) => (
          <li key={`${row.setupId}-${row.updatedAt}`}>
            {row.direction} · {row.lifecycle} · entry {fmt(row.entry ?? undefined)} ·{" "}
            {row.pnlPrice == null ? "pnl n/a" : `pnl/u ${fmtQty(row.pnlPrice)}`}
          </li>
        ))}
        {journal.length === 0 && <li>No journal rows yet</li>}
      </ul>
      <div className="desk-kicker">Phase F — RANGE_BREAK_RETEST scoreboard</div>
      {validation?.breakRetestPerformance || validation?.performance ? (
        <>
          <div className="metric-grid">
            <div className="metric">
              <span>BR resolved</span>
              <strong>
                {String(
                  (validation.breakRetestPerformance as { closedTrades?: number } | undefined)
                    ?.closedTrades ?? 0,
                )}
              </strong>
            </div>
            <div className="metric">
              <span>BR win rate (CI)</span>
              <strong>{fmtWinRate(validation.breakRetestPerformance as PerfSlice | undefined)}</strong>
            </div>
            <div className="metric">
              <span>BR expectancy (net)</span>
              <strong>
                {fmtExpectancy(
                  (validation.breakRetestPerformance as { expectancy?: number | null } | undefined)
                    ?.expectancy,
                )}
              </strong>
            </div>
            <div className="metric">
              <span>BR avg fees / u</span>
              <strong>
                {fmtExpectancy(
                  (validation.breakRetestPerformance as { averageFees?: number | null } | undefined)
                    ?.averageFees,
                )}
              </strong>
            </div>
          </div>
          <div className="desk-kicker">Overall paper (all setups)</div>
          <div className="metric-grid">
            <div className="metric">
              <span>Resolved TP/SL</span>
              <strong>
                {String((validation.performance as { closedTrades?: number }).closedTrades ?? "-")}
              </strong>
            </div>
            <div className="metric">
              <span>Win rate (CI)</span>
              <strong>{fmtWinRate(validation.performance as PerfSlice)}</strong>
            </div>
            <div className="metric">
              <span>Expectancy (net)</span>
              <strong>
                {fmtExpectancy(
                  (validation.performance as { expectancy?: number | null }).expectancy,
                )}
              </strong>
            </div>
            <div className="metric">
              <span>Open paper</span>
              <strong>{String(validation.openTrades ?? "-")}</strong>
            </div>
          </div>
          <div className="desk-kicker">Strata</div>
          <div className="chip-row">
            {strataChips(validation.byPrimaryTimeframe as Record<string, PerfSlice> | undefined, "TF")}
            {strataChips(validation.byLiquidity as Record<string, PerfSlice> | undefined, "Liq")}
            {strataChips(validation.byRangeContext as Record<string, PerfSlice> | undefined, "Range")}
            {Object.keys(
              (validation.byPrimaryTimeframe as object | undefined) ?? {},
            ).length +
              Object.keys((validation.byLiquidity as object | undefined) ?? {}).length +
              Object.keys((validation.byRangeContext as object | undefined) ?? {}).length ===
              0 && <span className="chip">No strata yet</span>}
          </div>
        </>
      ) : (
        <p className="disclaimer">Validation report loading…</p>
      )}
      {validation?.phaseFNote ? (
        <p className="disclaimer">{String(validation.phaseFNote)}</p>
      ) : (
        <p className="disclaimer">
          Phase F scoreboard — falsify RANGE_BREAK_RETEST; do not raise live size on thin samples.
        </p>
      )}
      {validation?.calibration ? (
        <p className="disclaimer">
          {String((validation.calibration as { sampleNote?: string }).sampleNote ?? "")}
        </p>
      ) : null}
      {validation?.parity ? (
        <p className="disclaimer">
          Tape: {String((validation.parity as { tape?: string }).tape ?? "")}
        </p>
      ) : null}
      <div className="desk-kicker">Historical backtest (structure proxy)</div>
      <div className="chip-row">
        <button type="button" className="chip" disabled={!symbol || btBusy} onClick={() => void runBacktest()}>
          {btBusy ? "Running…" : "Run structure/MTF proxy backtest"}
        </button>
      </div>
      {btError ? <p className="disclaimer sell">{btError}</p> : null}
      {backtest ? (
        <>
          <div className="metric-grid">
            <div className="metric">
              <span>Trades</span>
              <strong>{backtest.trades.length}</strong>
            </div>
            <div className="metric">
              <span>Win rate</span>
              <strong>
                {backtest.winRate == null ? "n/a" : `${(backtest.winRate * 100).toFixed(0)}%`}
              </strong>
            </div>
            <div className="metric">
              <span>Expectancy</span>
              <strong>{backtest.expectancy == null ? "n/a" : fmtQty(backtest.expectancy)}</strong>
            </div>
            <div className="metric">
              <span>Total pnl</span>
              <strong>{fmtQty(backtest.totalPnl)}</strong>
            </div>
          </div>
          <p className="disclaimer">{backtest.limitation}</p>
        </>
      ) : null}
      <p className="disclaimer">
        Confidence is a model score from configurable rule weights, not a win-rate or statistical probability.
        OB/FVG/sweeps use explicit OHLC rules (heuristic) — not institutional labels. MTF/BOS/CHoCH/VP are derived. DOM needs matching trade delta.
        Journal and backtest report observed samples only — never invented edge.
        {signal?.score?.modelNote ? ` ${signal.score.modelNote}` : ""}
      </p>
      </div>
    </div>
  );
}

function shortTargetKind(kind: string): string {
  switch (kind) {
    case "measured_move":
      return "MM";
    case "prior_swing":
      return "swing";
    case "session_extreme":
      return "session";
    case "vp_node":
      return "VP";
    default:
      return kind;
  }
}

function CvdBoard({
  cvd,
  symbol,
  overlay,
  breakRetest,
  structureTargets,
  scenarios,
  primaryInterval,
}: {
  cvd?: CvdState;
  symbol: string;
  overlay?: ChartOverlayState;
  breakRetest?: BreakRetestState;
  structureTargets?: StructureTarget[];
  scenarios?: ScenarioTreeState;
  primaryInterval?: string;
}) {
  const points = cvd?.points ?? [];
  const first = points[0];
  const last = points[points.length - 1];
  const change = first && last ? last.cvd - first.cvd : undefined;
  const positive = points.reduce((sum, point) => sum + (point.delta > 0 ? point.delta : 0), 0);
  const negative = points.reduce((sum, point) => sum + (point.delta < 0 ? point.delta : 0), 0);
  const priceUp = first && last ? last.price >= first.price : undefined;
  const cvdUp = change != null ? change >= 0 : undefined;
  const relation =
    priceUp == null || cvdUp == null
      ? "Waiting for enough session points."
      : priceUp && cvdUp
        ? "Price and CVD both rose across the plotted points."
        : priceUp && !cvdUp
          ? "Price rose while CVD fell across the plotted points."
          : !priceUp && !cvdUp
            ? "Price and CVD both fell across the plotted points."
            : "Price fell while CVD rose across the plotted points.";
  return (
    <div className="detail-board">
      <div className="of-head">
      <div className="stat-row">
        <div className="stat">
          <span>Current CVD</span>
          <strong className={(cvd?.cvd ?? 0) >= 0 ? "buy" : "sell"}>{fmtQty(cvd?.cvd)}</strong>
        </div>
        <div className="stat">
          <span>Change on chart</span>
          <strong className={(change ?? 0) >= 0 ? "buy" : "sell"}>{fmtQty(change)}</strong>
        </div>
        <div className="stat">
          <span>Latest delta</span>
          <strong className={(last?.delta ?? 0) >= 0 ? "buy" : "sell"}>{fmtQty(last?.delta)}</strong>
        </div>
      </div>
      </div>
      <div className="chart-stage">
        <CvdChart points={points} divergence={cvd?.divergence} />
        <DeltaHist points={points} />
      <div className="chip-row">
        <span className={`chip ${divergenceClass(cvd?.divergence)}`}>Divergence {cvd?.divergence ?? "-"}</span>
        <span className={cvd?.exhaustion ? "chip hot" : "chip"}>Exhaustion {cvd?.exhaustion ? "yes*" : "no"}</span>
        <span className={(cvd?.cvd ?? 0) >= 0 ? "chip ok" : "chip down"}>
          {(cvd?.cvd ?? 0) >= 0 ? "Net buying pressure" : "Net selling pressure"}
        </span>
      </div>
      <div className="cvd-legend">
        <span><i className="swatch buy-swatch" /> CVD</span>
        <span><i className="swatch price-swatch" /> Price</span>
        <span className="muted">Dashed line is zero. Session window.</span>
      </div>
      <div className="stat-row">
        <div className="stat">
          <span>Positive deltas</span>
          <strong className="buy">{fmtQty(points.length ? positive : undefined)}</strong>
        </div>
        <div className="stat">
          <span>Negative deltas</span>
          <strong className="sell">{fmtQty(points.length ? negative : undefined)}</strong>
        </div>
        <div className="stat">
          <span>Session start</span>
          <strong>{fmtClock(cvd?.sessionStart)}</strong>
        </div>
      </div>
      <p className="disclaimer">{relation} * exhaustion is a heuristic.</p>
      <CandleChart
        symbol={symbol}
        interval={primaryInterval ?? "5m"}
        overlay={overlay}
        breakRetest={breakRetest}
        structureTargets={structureTargets}
        scenarios={scenarios}
      />
      </div>
    </div>
  );
}

function DeltaHist({ points }: { points: { delta: number }[] }) {
  const view = points.slice(-80);
  const max = Math.max(...view.map((point) => Math.abs(point.delta)), 1);
  if (view.length < 2) return null;
  return (
    <div className="delta-hist" aria-label="Volume delta histogram">
      {view.map((point, index) => (
        <span
          key={`${point.delta}-${index}`}
          className={point.delta >= 0 ? "up" : "down"}
          style={{ height: `${Math.max(12, (Math.abs(point.delta) / max) * 100)}%` }}
          title={`Delta ${fmtQty(point.delta)}`}
        />
      ))}
    </div>
  );
}

function CvdChart({
  points,
  divergence,
}: {
  points: { cvd: number; price: number }[];
  divergence?: string;
}) {
  if (points.length < 2) return <div className="muted">Waiting for session delta…</div>;
  const width = 320;
  const height = 150;
  const cvdVals = points.map((point) => point.cvd);
  const priceVals = points.map((point) => point.price);
  const cvdMin = Math.min(...cvdVals, 0);
  const cvdMax = Math.max(...cvdVals, 0);
  const priceMin = Math.min(...priceVals);
  const priceMax = Math.max(...priceVals);
  const yCvd = (value: number) => 12 + ((cvdMax - value) / (cvdMax - cvdMin || 1)) * (height - 24);
  const yPrice = (value: number) => 12 + ((priceMax - value) / (priceMax - priceMin || 1)) * (height - 24);
  const line = (pick: (point: (typeof points)[number]) => number, y: (value: number) => number) =>
    points.map((point, index) => `${(index / (points.length - 1)) * width},${y(pick(point))}`).join(" ");
  const zeroY = yCvd(0);
  const last = cvdVals[cvdVals.length - 1] ?? 0;
  const color = last >= 0 ? "#0ecb81" : "#f6465d";
  return (
    <svg className="cvd-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Session price and cumulative volume delta">
      <line x1="0" x2={width} y1={zeroY} y2={zeroY} stroke="#2a3340" strokeDasharray="3 3" />
      <polygon points={`0,${zeroY} ${line((point) => point.cvd, yCvd)} ${width},${zeroY}`} fill={color} opacity="0.14" />
      <polyline fill="none" stroke="#8b98a8" strokeWidth="1.5" points={line((point) => point.price, yPrice)} />
      <polyline fill="none" stroke={color} strokeWidth="2" points={line((point) => point.cvd, yCvd)} />
      {divergence === "bullish" && <text x="8" y="16" fill="#0ecb81" fontSize="11">Bullish divergence</text>}
      {divergence === "bearish" && <text x="8" y="16" fill="#f6465d" fontSize="11">Bearish divergence</text>}
    </svg>
  );
}

function StructureBoard({
  profile,
  structure,
  lastPrice,
}: {
  profile?: VolumeProfile;
  structure?: MarketStructureState;
  lastPrice?: number;
}) {
  const levels = [...(profile?.levels ?? [])].sort((a, b) => b.price - a.price);
  const max = Math.max(...levels.map((level) => level.volume), 1);
  const vah = profile?.vah;
  const val = profile?.val;
  const inValue = (price: number) => vah != null && val != null && price <= Math.max(vah, val) && price >= Math.min(vah, val);
  return (
    <div className="detail-board">
      <div className="of-head">
      <div className="level-row">
        <div className="level poc">
          <span>POC</span>
          <strong>{fmt(profile?.poc)}</strong>
        </div>
        <div className="level vah">
          <span>VAH</span>
          <strong>{fmt(profile?.vah)}</strong>
        </div>
        <div className="level val">
          <span>VAL</span>
          <strong>{fmt(profile?.val)}</strong>
        </div>
      </div>
      </div>
      <div className="scroll-box">
      <div className="desk-kicker">Volume at price</div>
        {levels.length === 0 && <div className="muted">No profile volume yet.</div>}
        {levels.map((level) => {
          const hvn = (profile?.hvn ?? []).includes(level.price);
          const lvn = (profile?.lvn ?? []).includes(level.price);
          const poc = level.price === profile?.poc;
          const buy = level.buyVolume ?? 0;
          const sell = level.sellVolume ?? 0;
          const split = buy + sell;
          return (
            <div
              key={level.price}
              className={`profile-row ${poc ? "is-poc" : ""} ${inValue(level.price) ? "in-value" : ""}`}
              title={`Price ${fmt(level.price)}. Volume ${fmtQty(level.volume)}.${split ? ` Buy ${fmtQty(buy)}. Sell ${fmtQty(sell)}.` : ""} ${poc ? "POC." : ""} ${hvn ? "HVN." : ""} ${lvn ? "LVN." : ""}`}
            >
              <span>
                {fmt(level.price)}
                {poc && <em> POC</em>}
                {hvn && <em> HVN</em>}
                {lvn && <em> LVN</em>}
              </span>
              <div className="profile-track">
                {split > 0 ? (
                  <>
                    <span className="sell-fill" style={{ width: `${(sell / max) * 100}%` }} />
                    <span className="buy-fill" style={{ width: `${(buy / max) * 100}%` }} />
                  </>
                ) : (
                  <span style={{ width: `${(level.volume / max) * 100}%` }} />
                )}
              </div>
            </div>
          );
        })}
      <div className="metric-grid">
        <div className="metric">
          <span>Profile volume</span>
          <strong>{fmtQty(profile?.totalVolume)}</strong>
        </div>
        <div className="metric">
          <span>Window</span>
          <strong>{fmtClock(profile?.from)} – {fmtClock(profile?.to)}</strong>
        </div>
        <div className="metric">
          <span>Nearest support</span>
          <strong className="buy">{fmt(nearest(structure?.support, lastPrice))}</strong>
        </div>
        <div className="metric">
          <span>Nearest resistance</span>
          <strong className="sell">{fmt(nearest(structure?.resistance, lastPrice))}</strong>
        </div>
      </div>
      <div className="chip-row">
        <span className={`chip ${trendClass(structure?.trend)}`}>Trend {structure?.trend ?? "-"}</span>
        <span className="chip">Prev high {fmt(structure?.previousSessionHigh)}</span>
        <span className="chip">Prev low {fmt(structure?.previousSessionLow)}</span>
      </div>
      <div className="desk-kicker">Swings</div>
      <div className="chip-row">
        {(structure?.swings ?? []).slice(-8).map((swing) => (
          <span className={`chip ${swing.type === "HH" || swing.type === "HL" ? "up" : "down"}`} key={`${swing.type}-${swing.timestamp}-${swing.price}`}>
            {swing.type} {fmt(swing.price)}
          </span>
        ))}
        {(structure?.swings ?? []).length === 0 && <span className="muted">-</span>}
      </div>
      <div className="chip-row">
        <span className="chip">
          BOS {structure?.lastBos ? `${structure.lastBos.direction} @ ${fmt(structure.lastBos.price)} ${fmtClock(structure.lastBos.timestamp)}` : "-"}
        </span>
        <span className="chip">
          CHoCH {structure?.lastChoch ? `${structure.lastChoch.direction} @ ${fmt(structure.lastChoch.price)} ${fmtClock(structure.lastChoch.timestamp)}` : "-"}
        </span>
      </div>
      <div className="reason-grid">
        <div>
          <div className="desk-kicker buy">Support</div>
          <ul className="list">
            {(structure?.support ?? []).map((price) => (
              <li key={`s-${price}`}>{fmt(price)}</li>
            ))}
            {(structure?.support ?? []).length === 0 && <li>-</li>}
          </ul>
        </div>
        <div>
          <div className="desk-kicker sell">Resistance</div>
          <ul className="list">
            {(structure?.resistance ?? []).map((price) => (
              <li key={`r-${price}`}>{fmt(price)}</li>
            ))}
            {(structure?.resistance ?? []).length === 0 && <li>-</li>}
          </ul>
        </div>
      </div>
      <div className="desk-kicker">Liquidity pools</div>
      <div className="chip-row">
        {(structure?.liquidityPools ?? []).map((pool) => (
          <span className="chip" key={`${pool.side}-${pool.price}`}>
            {pool.label} {pool.side} {fmt(pool.price)}
          </span>
        ))}
        {(structure?.liquidityPools ?? []).length === 0 && <span className="muted">-</span>}
      </div>
      </div>
    </div>
  );
}

function nearest(prices: number[] | undefined, last?: number): number | undefined {
  if (!prices?.length) return undefined;
  if (last == null) return prices[0];
  return [...prices].sort((a, b) => Math.abs(a - last) - Math.abs(b - last))[0];
}

function fmtClock(value?: number): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "-";
  return new Date(value).toLocaleTimeString();
}

function divergenceClass(value?: string): string {
  if (value === "bullish") return "up";
  if (value === "bearish") return "down";
  return "";
}

function lifecycleChipClass(value?: string): string {
  if (value === "CONFIRMED" || value === "ACTIVE" || value === "HIT_TP") return "ok";
  if (value === "HIT_SL" || value === "INVALIDATED" || value === "EXPIRED" || value === "TIMEOUT") return "hot";
  if (value === "PENDING_CONFIRM") return "up";
  return "";
}

type PerfSlice = {
  closedTrades?: number;
  winRate?: number | null;
  winRateCi95?: { low: number; high: number } | null;
  expectancy?: number | null;
};

function fmtWinRate(p?: PerfSlice): string {
  if (!p || p.winRate == null) return "n/a";
  const ci = p.winRateCi95;
  return ci
    ? `${(p.winRate * 100).toFixed(0)}% [${(ci.low * 100).toFixed(0)}–${(ci.high * 100).toFixed(0)}]`
    : `${(p.winRate * 100).toFixed(0)}%`;
}

function fmtExpectancy(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return fmtQty(value);
}

function strataChips(
  map: Record<string, PerfSlice> | undefined,
  prefix: string,
): ReactNode[] {
  if (!map) return [];
  return Object.entries(map).map(([key, slice]) => (
    <span key={`${prefix}-${key}`} className="chip" title={`n=${slice.closedTrades ?? 0}`}>
      {prefix} {key}: {fmtWinRate(slice)} · E {fmtExpectancy(slice.expectancy)}
    </span>
  ));
}

function scenarioKindShort(kind: TradeScenario["kind"]): string {
  switch (kind) {
    case "break_now_long":
      return "Break-now long";
    case "dip_to_demand_long":
      return "Dip-to-demand";
    case "break_now_short":
      return "Break-now short";
    case "rally_to_supply_short":
      return "Rally-to-supply";
    default:
      return kind;
  }
}

function scenarioStatusChipClass(status: TradeScenario["status"]): string {
  if (status === "triggered" || status === "armed") return "ok";
  if (status === "invalidated") return "hot";
  if (status === "completed") return "up";
  return "";
}

function entryGradeChipClass(value?: string): string {
  if (value === "A+") return "grade-a";
  if (value === "STANDARD") return "up";
  return "hot";
}

function trendClass(value?: string): string {
  const text = (value ?? "").toLowerCase();
  if (text.includes("bull") || text === "up") return "up";
  if (text.includes("bear") || text === "down") return "down";
  return "";
}

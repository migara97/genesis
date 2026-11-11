import type {
  MarketRegimeTag,
  PaperOutcome,
  PaperSetupClass,
  PaperTradeSnapshot,
  TradingSignal,
} from "@of/shared";
import {
  DEFAULT_COST_MODEL,
  SIGNAL_ENGINE_VERSION,
  computeCostedPnl,
  deriveSetupClass,
  fingerprintConfig,
  rangeContextFromTags,
  tagPaperRegimes,
  type CostModelConfig,
} from "@of/orderflow";
import { db } from "../db.js";
import { config } from "../config.js";

const CONFIG_VERSION = fingerprintConfig({});
const TERMINAL = new Set(["HIT_TP", "HIT_SL", "INVALIDATED", "EXPIRED", "TIMEOUT"]);

export interface PaperTradeRow {
  id: string;
  setupId: string;
  symbol: string;
  exchange: string;
  marketType: string;
  pair: string;
  direction: string;
  lifecycle: string;
  outcome: PaperOutcome;
  generatedAt: number;
  openedAt: number;
  closedAt: number | null;
  primaryTimeframe: string;
  setupClass: PaperSetupClass;
  entry: number;
  stopLoss: number;
  takeProfit: number[];
  exitPrice: number | null;
  confidence: number;
  confirmations: string[];
  grossPnl: number | null;
  fees: number | null;
  funding: number | null;
  netPnl: number | null;
  rMultiple: number | null;
  mfe: number | null;
  mae: number | null;
  holdMs: number | null;
  engineVersion: string;
  configVersion: string;
  regimeTags: MarketRegimeTag[];
}

/**
 * Sync paper ledger from lifecycle transitions.
 * Opens on first CONFIRMED/ACTIVE directional; closes on terminal once.
 */
export function syncPaperTradeFromLifecycle(args: {
  previous?: TradingSignal | null;
  next: TradingSignal;
  price: number;
  exchange?: string;
  candles?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    openTime: number;
    closeTime: number;
  }[];
  structureTrend?: string;
  primaryTimeframe?: string;
  quoteVolume24h?: number | null;
  changePct24h?: number | null;
  ofSnapshot?: PaperTradeSnapshot["ofSnapshot"];
  costs?: CostModelConfig;
}): void {
  const next = args.next;
  if (!next.setupId || next.direction === "WAIT") return;
  if (next.entry == null || next.stopLoss == null) return;

  const exchange = args.exchange ?? config.exchange;
  const existing = db
    .prepare("SELECT setup_id, outcome, mfe, mae FROM paper_trades WHERE setup_id = ?")
    .get(next.setupId) as { setup_id: string; outcome: string; mfe: number | null; mae: number | null } | undefined;

  const side = next.direction as "LONG" | "SHORT";
  const now = next.lifecycleUpdatedAt ?? next.timestamp;

  // Track MFE/MAE while open.
  if (existing && existing.outcome === "OPEN") {
    const mfe = updateExtrema(side, next.entry, args.price, existing.mfe, "mfe");
    const mae = updateExtrema(side, next.entry, args.price, existing.mae, "mae");
    db.prepare(
      `UPDATE paper_trades SET mfe = ?, mae = ?, lifecycle = ?, updated_at = ? WHERE setup_id = ? AND outcome = 'OPEN'`,
    ).run(mfe, mae, next.lifecycle, now, next.setupId);
  }

  const opening =
    (next.lifecycle === "CONFIRMED" || next.lifecycle === "ACTIVE") && !existing;
  if (opening) {
    const setupClass = deriveSetupClass(next.confirmations);
    const regimes = tagPaperRegimes({
      structure: args.structureTrend
        ? { trend: args.structureTrend as "bullish" | "bearish" | "range" }
        : null,
      candles: args.candles as never,
      quoteVolume24h: args.quoteVolume24h ?? args.ofSnapshot?.quoteVolume24h,
      changePct24h: args.changePct24h,
    });
    const ofSnapshot: PaperTradeSnapshot["ofSnapshot"] = {
      ...args.ofSnapshot,
      structureTargets: args.ofSnapshot?.structureTargets ?? next.structureTargets,
      quoteVolume24h: args.quoteVolume24h ?? args.ofSnapshot?.quoteVolume24h,
      rangeContext: rangeContextFromTags(regimes),
    };
    const snapshot: PaperTradeSnapshot = {
      signalId: next.id,
      setupId: next.setupId,
      symbol: next.symbol,
      exchange,
      marketType: "futures_perp",
      pair: next.symbol,
      direction: side,
      generatedAt: next.timestamp,
      primaryTimeframe: args.primaryTimeframe ?? "5m",
      setupClass,
      entry: next.entry,
      stopLoss: next.stopLoss,
      takeProfit: next.takeProfit ?? [],
      confidence: next.confidence,
      longScore: next.score?.longScore ?? 0,
      shortScore: next.score?.shortScore ?? 0,
      families: next.score?.independentFamilies ?? [],
      confirmations: next.confirmations ?? [],
      factors: (next.score?.factors ?? []).map((f) => ({
        id: f.id,
        family: f.family,
        side: f.side,
        weight: f.weight,
        source: f.source,
      })),
      orderFlowOk: next.orderFlowOk,
      structureOk: next.structureOk,
      volumeOk: next.volumeOk,
      deltaOk: next.deltaOk,
      regimeTags: regimes,
      engineVersion: SIGNAL_ENGINE_VERSION,
      configVersion: CONFIG_VERSION,
      ofSnapshot,
    };

    db.prepare(
      `
      INSERT OR IGNORE INTO paper_trades (
        id, setup_id, symbol, exchange, market_type, pair, direction, lifecycle, outcome,
        generated_at, opened_at, closed_at, primary_timeframe, setup_class, entry, entry_fill, stop_loss,
        take_profit, exit_price, exit_fill, confidence, long_score, short_score, families,
        confirmations, regime_tags, engine_version, config_version, gross_pnl, fees, funding,
        net_pnl, r_multiple, mfe, mae, hold_ms, ambiguous_same_bar, of_snapshot, signal_payload,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, ?)
      `,
    ).run(
      `paper-${next.setupId}`,
      next.setupId,
      next.symbol,
      exchange,
      "futures_perp",
      next.symbol,
      side,
      next.lifecycle,
      next.timestamp,
      next.setupOpenedAt ?? next.timestamp,
      args.primaryTimeframe ?? "5m",
      setupClass,
      next.entry,
      next.stopLoss,
      JSON.stringify(next.takeProfit ?? []),
      next.confidence,
      next.score?.longScore ?? null,
      next.score?.shortScore ?? null,
      JSON.stringify(next.score?.independentFamilies ?? []),
      JSON.stringify(next.confirmations ?? []),
      JSON.stringify(regimes),
      SIGNAL_ENGINE_VERSION,
      CONFIG_VERSION,
      JSON.stringify(ofSnapshot ?? {}),
      JSON.stringify({ signal: next, snapshot }),
      now,
    );
    return;
  }

  if (!existing || existing.outcome !== "OPEN") return;
  if (!TERMINAL.has(next.lifecycle)) return;

  const outcome = mapOutcome(next.lifecycle);
  const openedAt = next.setupOpenedAt ?? next.timestamp;
  const costs = computeCostedPnl({
    side,
    entry: next.entry,
    exit: args.price,
    stopLoss: next.stopLoss,
    openedAt,
    closedAt: now,
    config: args.costs ?? DEFAULT_COST_MODEL,
  });
  const isResolved = outcome === "HIT_TP" || outcome === "HIT_SL";

  db.prepare(
    `
    UPDATE paper_trades SET
      lifecycle = ?,
      outcome = ?,
      closed_at = ?,
      exit_price = ?,
      entry_fill = ?,
      exit_fill = ?,
      gross_pnl = ?,
      fees = ?,
      funding = ?,
      net_pnl = ?,
      r_multiple = ?,
      hold_ms = ?,
      signal_payload = ?,
      updated_at = ?
    WHERE setup_id = ? AND outcome = 'OPEN'
    `,
  ).run(
    next.lifecycle,
    outcome,
    now,
    args.price,
    costs.entryFill,
    costs.exitFill,
    isResolved || outcome === "TIMEOUT" || outcome === "INVALIDATED" || outcome === "EXPIRED"
      ? costs.grossPnlPerUnit
      : null,
    costs.feesPerUnit,
    costs.fundingPerUnit,
    costs.netPnlPerUnit,
    costs.rMultiple,
    now - openedAt,
    JSON.stringify({ signal: next, costed: costs }),
    now,
    next.setupId,
  );
}

export function listPaperTrades(opts: {
  symbol?: string;
  limit?: number;
  setupClass?: PaperSetupClass;
}): PaperTradeRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  let rows: Record<string, unknown>[];
  if (opts.symbol && opts.setupClass) {
    rows = db
      .prepare(
        `SELECT * FROM paper_trades WHERE symbol = ? AND setup_class = ? ORDER BY opened_at DESC LIMIT ?`,
      )
      .all(opts.symbol.toUpperCase(), opts.setupClass, limit) as Record<string, unknown>[];
  } else if (opts.symbol) {
    rows = db
      .prepare(`SELECT * FROM paper_trades WHERE symbol = ? ORDER BY opened_at DESC LIMIT ?`)
      .all(opts.symbol.toUpperCase(), limit) as Record<string, unknown>[];
  } else if (opts.setupClass) {
    rows = db
      .prepare(`SELECT * FROM paper_trades WHERE setup_class = ? ORDER BY opened_at DESC LIMIT ?`)
      .all(opts.setupClass, limit) as Record<string, unknown>[];
  } else {
    rows = db
      .prepare(`SELECT * FROM paper_trades ORDER BY opened_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
  }
  return rows.map(mapRow);
}

function mapOutcome(lifecycle: string): PaperOutcome {
  if (lifecycle === "HIT_TP") return "HIT_TP";
  if (lifecycle === "HIT_SL") return "HIT_SL";
  if (lifecycle === "INVALIDATED") return "INVALIDATED";
  if (lifecycle === "TIMEOUT") return "TIMEOUT";
  if (lifecycle === "EXPIRED") return "EXPIRED";
  return "OPEN";
}

function updateExtrema(
  side: "LONG" | "SHORT",
  entry: number,
  price: number,
  prev: number | null,
  kind: "mfe" | "mae",
): number {
  const signed = side === "LONG" ? price - entry : entry - price;
  if (kind === "mfe") return prev == null ? signed : Math.max(prev, signed);
  return prev == null ? signed : Math.min(prev, signed);
}

function mapRow(row: Record<string, unknown>): PaperTradeRow {
  const confirmations = JSON.parse(String(row.confirmations || "[]")) as string[];
  const setupClass =
    (row.setup_class as PaperSetupClass | undefined) ??
    deriveSetupClass(confirmations);
  return {
    id: String(row.id),
    setupId: String(row.setup_id),
    symbol: String(row.symbol),
    exchange: String(row.exchange),
    marketType: String(row.market_type),
    pair: String(row.pair),
    direction: String(row.direction),
    lifecycle: String(row.lifecycle),
    outcome: String(row.outcome) as PaperOutcome,
    generatedAt: Number(row.generated_at),
    openedAt: Number(row.opened_at),
    closedAt: row.closed_at == null ? null : Number(row.closed_at),
    primaryTimeframe: String(row.primary_timeframe ?? "5m"),
    setupClass,
    entry: Number(row.entry),
    stopLoss: Number(row.stop_loss),
    takeProfit: JSON.parse(String(row.take_profit || "[]")) as number[],
    exitPrice: row.exit_price == null ? null : Number(row.exit_price),
    confidence: Number(row.confidence),
    confirmations,
    grossPnl: row.gross_pnl == null ? null : Number(row.gross_pnl),
    fees: row.fees == null ? null : Number(row.fees),
    funding: row.funding == null ? null : Number(row.funding),
    netPnl: row.net_pnl == null ? null : Number(row.net_pnl),
    rMultiple: row.r_multiple == null ? null : Number(row.r_multiple),
    mfe: row.mfe == null ? null : Number(row.mfe),
    mae: row.mae == null ? null : Number(row.mae),
    holdMs: row.hold_ms == null ? null : Number(row.hold_ms),
    engineVersion: String(row.engine_version),
    configVersion: String(row.config_version),
    regimeTags: JSON.parse(String(row.regime_tags || "[]")) as MarketRegimeTag[],
  };
}

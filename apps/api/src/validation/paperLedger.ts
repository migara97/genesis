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

export interface ScaleFillLeg {
  tpIndex: number;
  price: number;
  fraction: number;
  at: number;
  grossPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
}

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
  remainingFrac?: number;
  scaleFills?: ScaleFillLeg[];
}

/**
 * Sync paper ledger from lifecycle transitions.
 * Opens on first CONFIRMED/ACTIVE directional; records Phase 12 partial TP legs;
 * closes on terminal once.
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
    .prepare(
      "SELECT setup_id, outcome, mfe, mae, remaining_frac, scale_fills, gross_pnl, fees, funding, net_pnl, opened_at FROM paper_trades WHERE setup_id = ?",
    )
    .get(next.setupId) as
    | {
        setup_id: string;
        outcome: string;
        mfe: number | null;
        mae: number | null;
        remaining_frac: number | null;
        scale_fills: string | null;
        gross_pnl: number | null;
        fees: number | null;
        funding: number | null;
        net_pnl: number | null;
        opened_at: number;
      }
    | undefined;

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
        remaining_frac, scale_fills, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, 1, '[]', ?)
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
    // Fall through — opening tick may also be a scale fill if lifecycle already advanced.
  }

  const openRow =
    existing?.outcome === "OPEN"
      ? existing
      : (db
          .prepare(
            "SELECT setup_id, outcome, mfe, mae, remaining_frac, scale_fills, gross_pnl, fees, funding, net_pnl, opened_at FROM paper_trades WHERE setup_id = ? AND outcome = 'OPEN'",
          )
          .get(next.setupId) as typeof existing);

  if (!openRow || openRow.outcome !== "OPEN") return;

  const prevHits = args.previous?.tpHits ?? 0;
  const nextHits = next.tpHits ?? 0;
  const isPartialScale =
    nextHits > prevHits &&
    (next.lifecycle === "ACTIVE" || next.lifecycle === "CONFIRMED") &&
    !TERMINAL.has(next.lifecycle);

  if (isPartialScale) {
    const fills = parseScaleFills(openRow.scale_fills);
    const remaining = openRow.remaining_frac ?? 1;
    const noteFrac = parseScaleFracFromNote(next.lifecycleNote);
    const frac =
      noteFrac ??
      Math.max(0, remaining - (next.scaleRemainingFrac ?? remaining));
    if (frac > 0) {
      const costs = computeCostedPnl({
        side,
        entry: next.entry,
        exit: args.price,
        stopLoss: next.stopLoss,
        openedAt: openRow.opened_at,
        closedAt: now,
        sizeFraction: frac,
        config: args.costs ?? DEFAULT_COST_MODEL,
      });
      fills.push({
        tpIndex: nextHits,
        price: args.price,
        fraction: frac,
        at: now,
        grossPnl: costs.grossPnlPerUnit,
        fees: costs.feesPerUnit,
        funding: costs.fundingPerUnit,
        netPnl: costs.netPnlPerUnit,
      });
      const nextRemaining = Math.max(0, remaining - frac);
      const gross = (openRow.gross_pnl ?? 0) + costs.grossPnlPerUnit;
      const fees = (openRow.fees ?? 0) + costs.feesPerUnit;
      const funding = (openRow.funding ?? 0) + costs.fundingPerUnit;
      const net = (openRow.net_pnl ?? 0) + costs.netPnlPerUnit;
      const risk = Math.abs(next.entry - next.stopLoss);
      const rMultiple = risk > 0 ? net / risk : null;
      db.prepare(
        `
        UPDATE paper_trades SET
          lifecycle = ?,
          remaining_frac = ?,
          scale_fills = ?,
          gross_pnl = ?,
          fees = ?,
          funding = ?,
          net_pnl = ?,
          r_multiple = ?,
          exit_price = ?,
          signal_payload = ?,
          updated_at = ?
        WHERE setup_id = ? AND outcome = 'OPEN'
        `,
      ).run(
        next.lifecycle,
        nextRemaining,
        JSON.stringify(fills),
        gross,
        fees,
        funding,
        net,
        rMultiple,
        args.price,
        JSON.stringify({ signal: next, scaleFills: fills, costed: costs }),
        now,
        next.setupId,
      );
      // Refresh openRow numbers for a possible same-tick terminal (shouldn't happen).
      openRow.remaining_frac = nextRemaining;
      openRow.scale_fills = JSON.stringify(fills);
      openRow.gross_pnl = gross;
      openRow.fees = fees;
      openRow.funding = funding;
      openRow.net_pnl = net;
    }
  }

  if (!TERMINAL.has(next.lifecycle)) return;

  const outcome = mapOutcome(next.lifecycle);
  const openedAt = next.setupOpenedAt ?? openRow.opened_at ?? next.timestamp;
  const remaining = openRow.remaining_frac ?? 1;
  const fills = parseScaleFills(openRow.scale_fills);
  const costs = computeCostedPnl({
    side,
    entry: next.entry,
    exit: args.price,
    stopLoss: next.stopLoss,
    openedAt,
    closedAt: now,
    sizeFraction: Math.max(0, remaining),
    config: args.costs ?? DEFAULT_COST_MODEL,
  });
  const isResolved = outcome === "HIT_TP" || outcome === "HIT_SL";
  const includePnl =
    isResolved || outcome === "TIMEOUT" || outcome === "INVALIDATED" || outcome === "EXPIRED";

  const gross = includePnl ? (openRow.gross_pnl ?? 0) + costs.grossPnlPerUnit : openRow.gross_pnl;
  const fees = includePnl ? (openRow.fees ?? 0) + costs.feesPerUnit : openRow.fees;
  const funding = includePnl ? (openRow.funding ?? 0) + costs.fundingPerUnit : openRow.funding;
  const net = includePnl ? (openRow.net_pnl ?? 0) + costs.netPnlPerUnit : openRow.net_pnl;
  const risk = Math.abs(next.entry - next.stopLoss);
  const rMultiple = includePnl && net != null && risk > 0 ? net / risk : null;

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
      remaining_frac = 0,
      scale_fills = ?,
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
    gross,
    fees,
    funding,
    net,
    rMultiple,
    now - openedAt,
    JSON.stringify(fills),
    JSON.stringify({ signal: next, scaleFills: fills, costed: costs }),
    now,
    next.setupId,
  );
}

export function listPaperTrades(opts: {
  symbol?: string;
  limit?: number;
  setupClass?: PaperSetupClass;
}): PaperTradeRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 10_000);
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

function parseScaleFills(raw: string | null | undefined): ScaleFillLeg[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ScaleFillLeg[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Note format: `SCALE_TP1:0.5|...` */
function parseScaleFracFromNote(note?: string): number | null {
  if (!note) return null;
  const m = /^SCALE_TP\d+:([0-9.]+)/.exec(note);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
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
    remainingFrac: row.remaining_frac == null ? undefined : Number(row.remaining_frac),
    scaleFills: parseScaleFills(row.scale_fills as string | null),
  };
}

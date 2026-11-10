import type { TradingSignal } from "@of/shared";
import { db } from "../db.js";
import { config } from "../config.js";

const TERMINAL = new Set(["HIT_TP", "HIT_SL", "INVALIDATED", "EXPIRED", "TIMEOUT"]);

export interface SignalSetupRow {
  setupId: string;
  symbol: string;
  exchange: string;
  direction: string;
  lifecycle: string;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number[];
  exitPrice: number | null;
  pnlPrice: number | null;
  confidence: number;
  longScore: number | null;
  shortScore: number | null;
  families: string[];
  confirmations: string[];
  lifecycleNote?: string;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface SignalJournalMetrics {
  setups: number;
  directional: number;
  hitTp: number;
  hitSl: number;
  invalidated: number;
  expired: number;
  timeout: number;
  open: number;
  /** Win rate over HIT_TP + HIT_SL only. null when sample is empty. */
  winRate: number | null;
  avgPnlPerUnit: number | null;
  totalPnlPerUnit: number;
  sampleNote: string;
}

/**
 * Upsert a setup row and append an event when lifecycle changes.
 * WAIT/WATCHING noise is skipped unless transitioning into/out of a named setup.
 */
export function recordSignalLifecycle(
  previous: TradingSignal | null | undefined,
  next: TradingSignal,
  price: number,
  exchange: string = config.exchange,
): void {
  if (!next.setupId) return;
  const lifecycleChanged = !previous || previous.lifecycle !== next.lifecycle;
  const setupChanged = !previous || previous.setupId !== next.setupId;
  if (!lifecycleChanged && !setupChanged) return;

  // Skip pure WAIT watching spam with no directional history.
  if (
    next.direction === "WAIT" &&
    (next.lifecycle === "WATCHING" || next.lifecycle === "PENDING_CONFIRM") &&
    !TERMINAL.has(next.lifecycle) &&
    (!previous || previous.direction === "WAIT")
  ) {
    return;
  }

  const openedAt = next.setupOpenedAt ?? next.lifecycleUpdatedAt ?? next.timestamp;
  const updatedAt = next.lifecycleUpdatedAt ?? next.timestamp;
  const closed = TERMINAL.has(next.lifecycle);
  const exitPrice = closed ? price : null;
  const pnlPrice =
    closed && next.entry != null && next.direction !== "WAIT"
      ? computePnlPerUnit(next.direction, next.entry, price)
      : null;

  db.prepare(
    `
    INSERT INTO signal_setups (
      setup_id, symbol, exchange, direction, lifecycle, entry, stop_loss, take_profit,
      exit_price, pnl_price, confidence, long_score, short_score, families, confirmations,
      lifecycle_note, opened_at, updated_at, closed_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(setup_id) DO UPDATE SET
      direction = excluded.direction,
      lifecycle = excluded.lifecycle,
      entry = COALESCE(excluded.entry, signal_setups.entry),
      stop_loss = COALESCE(excluded.stop_loss, signal_setups.stop_loss),
      take_profit = COALESCE(excluded.take_profit, signal_setups.take_profit),
      exit_price = COALESCE(excluded.exit_price, signal_setups.exit_price),
      pnl_price = COALESCE(excluded.pnl_price, signal_setups.pnl_price),
      confidence = excluded.confidence,
      long_score = excluded.long_score,
      short_score = excluded.short_score,
      families = excluded.families,
      confirmations = excluded.confirmations,
      lifecycle_note = excluded.lifecycle_note,
      updated_at = excluded.updated_at,
      closed_at = COALESCE(excluded.closed_at, signal_setups.closed_at),
      payload = excluded.payload
    `,
  ).run(
    next.setupId,
    next.symbol,
    exchange,
    next.direction,
    next.lifecycle,
    next.entry ?? null,
    next.stopLoss ?? null,
    JSON.stringify(next.takeProfit ?? []),
    exitPrice,
    pnlPrice,
    next.confidence,
    next.score?.longScore ?? null,
    next.score?.shortScore ?? null,
    JSON.stringify(next.score?.independentFamilies ?? []),
    JSON.stringify(next.confirmations ?? []),
    next.lifecycleNote ?? null,
    openedAt,
    updatedAt,
    closed ? updatedAt : null,
    JSON.stringify(next),
  );

  if (lifecycleChanged || setupChanged) {
    db.prepare(
      `
      INSERT INTO signal_events (setup_id, symbol, lifecycle, direction, price, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      next.setupId,
      next.symbol,
      next.lifecycle,
      next.direction,
      price,
      next.lifecycleNote ?? null,
      updatedAt,
    );
  }
}

export function listSignalSetups(opts: {
  symbol?: string;
  limit?: number;
}): SignalSetupRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = opts.symbol
    ? (db
        .prepare(
          `SELECT * FROM signal_setups WHERE symbol = ? ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(opts.symbol.toUpperCase(), limit) as Record<string, unknown>[])
    : (db
        .prepare(`SELECT * FROM signal_setups ORDER BY updated_at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]);
  return rows.map(mapSetupRow);
}

export function computeJournalMetrics(symbol?: string): SignalJournalMetrics {
  const rows = listSignalSetups({ symbol, limit: 500 });
  const directional = rows.filter((r) => r.direction === "LONG" || r.direction === "SHORT");
  const hitTp = rows.filter((r) => r.lifecycle === "HIT_TP");
  const hitSl = rows.filter((r) => r.lifecycle === "HIT_SL");
  const invalidated = rows.filter((r) => r.lifecycle === "INVALIDATED");
  const expired = rows.filter((r) => r.lifecycle === "EXPIRED");
  const timeout = rows.filter((r) => r.lifecycle === "TIMEOUT");
  const open = rows.filter((r) => !TERMINAL.has(r.lifecycle) && r.direction !== "WAIT");
  const decided = [...hitTp, ...hitSl];
  const pnls = decided
    .map((r) => r.pnlPrice)
    .filter((n): n is number => typeof n === "number");
  const totalPnlPerUnit = pnls.reduce((s, n) => s + n, 0);

  return {
    setups: rows.length,
    directional: directional.length,
    hitTp: hitTp.length,
    hitSl: hitSl.length,
    invalidated: invalidated.length,
    expired: expired.length,
    timeout: timeout.length,
    open: open.length,
    winRate: decided.length ? hitTp.length / decided.length : null,
    avgPnlPerUnit: pnls.length ? totalPnlPerUnit / pnls.length : null,
    totalPnlPerUnit,
    sampleNote:
      decided.length === 0
        ? "No HIT_TP/HIT_SL outcomes in the journal yet — win rate is undefined, not zero edge."
        : `Win rate from ${decided.length} closed TP/SL outcomes only (invalidated/expired excluded). Live journal sample, not a backtest.`,
  };
}

function computePnlPerUnit(direction: string, entry: number, exit: number): number {
  return direction === "LONG" ? exit - entry : entry - exit;
}

function mapSetupRow(row: Record<string, unknown>): SignalSetupRow {
  return {
    setupId: String(row.setup_id),
    symbol: String(row.symbol),
    exchange: String(row.exchange),
    direction: String(row.direction),
    lifecycle: String(row.lifecycle),
    entry: row.entry == null ? null : Number(row.entry),
    stopLoss: row.stop_loss == null ? null : Number(row.stop_loss),
    takeProfit: parseJsonNumberArray(row.take_profit),
    exitPrice: row.exit_price == null ? null : Number(row.exit_price),
    pnlPrice: row.pnl_price == null ? null : Number(row.pnl_price),
    confidence: Number(row.confidence ?? 0),
    longScore: row.long_score == null ? null : Number(row.long_score),
    shortScore: row.short_score == null ? null : Number(row.short_score),
    families: parseJsonStringArray(row.families),
    confirmations: parseJsonStringArray(row.confirmations),
    lifecycleNote: row.lifecycle_note == null ? undefined : String(row.lifecycle_note),
    openedAt: Number(row.opened_at),
    updatedAt: Number(row.updated_at),
    closedAt: row.closed_at == null ? null : Number(row.closed_at),
  };
}

function parseJsonNumberArray(value: unknown): number[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((n) => String(n)) : [];
  } catch {
    return [];
  }
}

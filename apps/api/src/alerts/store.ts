import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { isFavorite } from "../markets/store.js";
import { config } from "../config.js";

export type AlertKind = "price" | "signal";
export type AlertOp = "gte" | "lte" | "eq";

export interface AlertRule {
  id: string;
  symbol: string;
  kind: AlertKind;
  /** price: threshold; signal: unused (fires on lifecycle match). */
  op: AlertOp;
  threshold: number | null;
  /** For signal alerts: lifecycle to match (e.g. CONFIRMED, HIT_TP). */
  lifecycle: string | null;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  fireCount: number;
}

export interface AlertFire {
  id: string;
  alertId: string;
  symbol: string;
  kind: AlertKind;
  message: string;
  price: number | null;
  lifecycle: string | null;
  firedAt: number;
}

export function listAlerts(opts?: { symbol?: string; enabled?: boolean }): AlertRule[] {
  let rows: Record<string, unknown>[];
  if (opts?.symbol && opts.enabled != null) {
    rows = db
      .prepare(
        `SELECT * FROM alerts WHERE symbol = ? AND enabled = ? ORDER BY created_at DESC`,
      )
      .all(opts.symbol.toUpperCase(), opts.enabled ? 1 : 0) as Record<string, unknown>[];
  } else if (opts?.symbol) {
    rows = db
      .prepare(`SELECT * FROM alerts WHERE symbol = ? ORDER BY created_at DESC`)
      .all(opts.symbol.toUpperCase()) as Record<string, unknown>[];
  } else if (opts?.enabled != null) {
    rows = db
      .prepare(`SELECT * FROM alerts WHERE enabled = ? ORDER BY created_at DESC`)
      .all(opts.enabled ? 1 : 0) as Record<string, unknown>[];
  } else {
    rows = db
      .prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 200`)
      .all() as Record<string, unknown>[];
  }
  return rows.map(mapRule);
}

export function createAlert(input: {
  symbol: string;
  kind: AlertKind;
  op?: AlertOp;
  threshold?: number | null;
  lifecycle?: string | null;
  enabled?: boolean;
}): AlertRule {
  const id = randomUUID();
  const now = Date.now();
  const symbol = input.symbol.toUpperCase();
  db.prepare(
    `
    INSERT INTO alerts (id, symbol, kind, op, threshold, lifecycle, enabled, created_at, last_fired_at, fire_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
    `,
  ).run(
    id,
    symbol,
    input.kind,
    input.op ?? "gte",
    input.threshold ?? null,
    input.lifecycle ?? null,
    input.enabled === false ? 0 : 1,
    now,
  );
  return {
    id,
    symbol,
    kind: input.kind,
    op: input.op ?? "gte",
    threshold: input.threshold ?? null,
    lifecycle: input.lifecycle ?? null,
    enabled: input.enabled !== false,
    createdAt: now,
    lastFiredAt: null,
    fireCount: 0,
  };
}

export function deleteAlert(id: string): boolean {
  const result = db.prepare(`DELETE FROM alerts WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function listAlertFires(limit = 50): AlertFire[] {
  const rows = db
    .prepare(`SELECT * FROM alert_fires ORDER BY fired_at DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 500)) as Record<string, unknown>[];
  return rows.map(mapFire);
}

/**
 * Evaluate enabled alerts for a symbol. Only fires when the symbol is favorited.
 * Dedupes: price alerts cooldown 60s; signal alerts once per setup lifecycle transition.
 */
export function evaluateAlerts(args: {
  symbol: string;
  price: number;
  lifecycle?: string | null;
  setupId?: string | null;
}): AlertFire[] {
  const symbol = args.symbol.toUpperCase();
  if (!isFavorite(config.exchange, symbol)) return [];

  const rules = listAlerts({ symbol, enabled: true });
  if (!rules.length) return [];

  const fired: AlertFire[] = [];
  const now = Date.now();
  const COOLDOWN_MS = 60_000;

  for (const rule of rules) {
    if (rule.lastFiredAt != null && now - rule.lastFiredAt < COOLDOWN_MS) continue;

    let hit = false;
    let message = "";

    if (rule.kind === "price" && rule.threshold != null) {
      hit = matchOp(args.price, rule.op, rule.threshold);
      if (hit) {
        message = `${symbol} price ${args.price} ${rule.op} ${rule.threshold}`;
      }
    } else if (rule.kind === "signal" && args.lifecycle) {
      const want = (rule.lifecycle ?? "CONFIRMED").toUpperCase();
      hit = args.lifecycle.toUpperCase() === want;
      if (hit) {
        message = `${symbol} signal ${args.lifecycle}${args.setupId ? ` (${args.setupId.slice(0, 8)})` : ""}`;
      }
    }

    if (!hit) continue;

    const id = randomUUID();
    db.prepare(
      `
      INSERT INTO alert_fires (id, alert_id, symbol, kind, message, price, lifecycle, fired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      id,
      rule.id,
      symbol,
      rule.kind,
      message,
      args.price,
      args.lifecycle ?? null,
      now,
    );
    db.prepare(
      `UPDATE alerts SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?`,
    ).run(now, rule.id);

    fired.push({
      id,
      alertId: rule.id,
      symbol,
      kind: rule.kind,
      message,
      price: args.price,
      lifecycle: args.lifecycle ?? null,
      firedAt: now,
    });
  }

  return fired;
}

function matchOp(value: number, op: AlertOp, threshold: number): boolean {
  if (op === "gte") return value >= threshold;
  if (op === "lte") return value <= threshold;
  return Math.abs(value - threshold) < 1e-12;
}

function mapRule(row: Record<string, unknown>): AlertRule {
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    kind: String(row.kind) as AlertKind,
    op: String(row.op ?? "gte") as AlertOp,
    threshold: row.threshold == null ? null : Number(row.threshold),
    lifecycle: row.lifecycle == null ? null : String(row.lifecycle),
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at),
    lastFiredAt: row.last_fired_at == null ? null : Number(row.last_fired_at),
    fireCount: Number(row.fire_count ?? 0),
  };
}

function mapFire(row: Record<string, unknown>): AlertFire {
  return {
    id: String(row.id),
    alertId: String(row.alert_id),
    symbol: String(row.symbol),
    kind: String(row.kind) as AlertKind,
    message: String(row.message),
    price: row.price == null ? null : Number(row.price),
    lifecycle: row.lifecycle == null ? null : String(row.lifecycle),
    firedAt: Number(row.fired_at),
  };
}

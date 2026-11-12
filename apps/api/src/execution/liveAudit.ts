import { randomUUID } from "node:crypto";
import { db } from "../db.js";

export type LiveAuditAction = "place" | "cancel" | "mode" | "reject";

export interface LiveAuditEntry {
  id: string;
  ts: number;
  action: LiveAuditAction;
  mode: string;
  symbol: string | null;
  side: string | null;
  type: string | null;
  quantity: number | null;
  status: string | null;
  exchangeOrderId: string | null;
  reason: string | null;
}

/** Append-only LIVE audit — never store API keys or secrets. */
export function appendLiveAudit(input: {
  action: LiveAuditAction;
  mode: string;
  symbol?: string | null;
  side?: string | null;
  type?: string | null;
  quantity?: number | null;
  status?: string | null;
  exchangeOrderId?: string | null;
  reason?: string | null;
}): LiveAuditEntry {
  const entry: LiveAuditEntry = {
    id: randomUUID(),
    ts: Date.now(),
    action: input.action,
    mode: input.mode,
    symbol: input.symbol ?? null,
    side: input.side ?? null,
    type: input.type ?? null,
    quantity: input.quantity ?? null,
    status: input.status ?? null,
    exchangeOrderId: input.exchangeOrderId ?? null,
    reason: sanitizeReason(input.reason),
  };
  db.prepare(
    `
    INSERT INTO live_audit (
      id, ts, action, mode, symbol, side, type, quantity, status, exchange_order_id, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    entry.id,
    entry.ts,
    entry.action,
    entry.mode,
    entry.symbol,
    entry.side,
    entry.type,
    entry.quantity,
    entry.status,
    entry.exchangeOrderId,
    entry.reason,
  );
  return entry;
}

export function listLiveAudit(limit = 100): LiveAuditEntry[] {
  const rows = db
    .prepare(`SELECT * FROM live_audit ORDER BY ts DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 500)) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    ts: Number(row.ts),
    action: String(row.action) as LiveAuditAction,
    mode: String(row.mode),
    symbol: row.symbol == null ? null : String(row.symbol),
    side: row.side == null ? null : String(row.side),
    type: row.type == null ? null : String(row.type),
    quantity: row.quantity == null ? null : Number(row.quantity),
    status: row.status == null ? null : String(row.status),
    exchangeOrderId: row.exchange_order_id == null ? null : String(row.exchange_order_id),
    reason: row.reason == null ? null : String(row.reason),
  }));
}

function sanitizeReason(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  // Strip anything that looks like a key/secret fragment.
  return reason
    .replace(/api[_-]?key[=:\s]+\S+/gi, "api_key=[redacted]")
    .replace(/secret[=:\s]+\S+/gi, "secret=[redacted]")
    .slice(0, 500);
}

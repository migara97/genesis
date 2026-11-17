import { randomUUID } from "node:crypto";
import { db } from "../db.js";

export type NotificationChannel = "telegram" | "in_app";
export type OutboxStatus = "pending" | "sent" | "failed";

export type SignalNotifyEventType =
  | "HQ_BUY"
  | "HQ_SELL"
  | "ENTRY_ZONE_APPROACHING"
  | "ENTRY_CONFIRMED"
  | "SIGNAL_INVALIDATED"
  | "TAKE_PROFIT_REACHED"
  | "STOP_LOSS_REACHED"
  | "SIGNAL_EXPIRED";

export interface NotificationPayload {
  title: string;
  message: string;
  symbol: string;
  eventType: SignalNotifyEventType;
  setupId: string;
  direction: string;
  lifecycle: string;
  price: number | null;
  entryGrade?: string;
  confidence?: number;
}

export interface OutboxRow {
  id: string;
  setupId: string;
  symbol: string;
  eventType: SignalNotifyEventType;
  channel: NotificationChannel;
  payload: NotificationPayload;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
}

/** Insert if not already queued/sent for (setupId, eventType, channel). Returns row or null if duplicate. */
export function enqueueNotification(args: {
  setupId: string;
  symbol: string;
  eventType: SignalNotifyEventType;
  channel: NotificationChannel;
  payload: NotificationPayload;
}): OutboxRow | null {
  const id = randomUUID();
  const now = Date.now();
  try {
    db.prepare(
      `
      INSERT INTO notification_outbox (
        id, setup_id, symbol, event_type, channel, payload_json,
        status, attempts, last_error, created_at, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, NULL)
      `,
    ).run(
      id,
      args.setupId,
      args.symbol.toUpperCase(),
      args.eventType,
      args.channel,
      JSON.stringify(args.payload),
      now,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|unique/i.test(msg)) return null;
    throw err;
  }
  return {
    id,
    setupId: args.setupId,
    symbol: args.symbol.toUpperCase(),
    eventType: args.eventType,
    channel: args.channel,
    payload: args.payload,
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: now,
    sentAt: null,
  };
}

export function hasOutboxEvent(
  setupId: string,
  eventType: SignalNotifyEventType,
  channel?: NotificationChannel,
): boolean {
  if (channel) {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM notification_outbox WHERE setup_id = ? AND event_type = ? AND channel = ? LIMIT 1`,
      )
      .get(setupId, eventType, channel);
    return Boolean(row);
  }
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM notification_outbox WHERE setup_id = ? AND event_type = ? LIMIT 1`,
    )
    .get(setupId, eventType);
  return Boolean(row);
}

export function listPendingOutbox(limit = 20): OutboxRow[] {
  const rows = db
    .prepare(
      `
      SELECT * FROM notification_outbox
      WHERE status = 'pending' AND attempts < 5
      ORDER BY created_at ASC
      LIMIT ?
      `,
    )
    .all(Math.min(Math.max(limit, 1), 100)) as Record<string, unknown>[];
  return rows.map(mapOutbox);
}

export function markOutboxSent(id: string): void {
  db.prepare(
    `UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`,
  ).run(Date.now(), id);
}

export function markOutboxAttempt(id: string, error: string, failed: boolean): void {
  db.prepare(
    `
    UPDATE notification_outbox
    SET attempts = attempts + 1,
        last_error = ?,
        status = CASE WHEN ? THEN 'failed' ELSE status END
    WHERE id = ?
    `,
  ).run(error.slice(0, 500), failed ? 1 : 0, id);
}

export function listNotificationHistory(limit = 50): OutboxRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM notification_outbox ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 200)) as Record<string, unknown>[];
  return rows.map(mapOutbox);
}

/** Last approaching notify time for cooldown (any channel). */
export function lastApproachingAt(symbol: string): number | null {
  const row = db
    .prepare(
      `
      SELECT created_at FROM notification_outbox
      WHERE symbol = ? AND event_type = 'ENTRY_ZONE_APPROACHING'
      ORDER BY created_at DESC LIMIT 1
      `,
    )
    .get(symbol.toUpperCase()) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

function mapOutbox(row: Record<string, unknown>): OutboxRow {
  let payload: NotificationPayload;
  try {
    payload = JSON.parse(String(row.payload_json)) as NotificationPayload;
  } catch {
    payload = {
      title: "Notification",
      message: String(row.payload_json ?? ""),
      symbol: String(row.symbol),
      eventType: String(row.event_type) as SignalNotifyEventType,
      setupId: String(row.setup_id),
      direction: "-",
      lifecycle: "-",
      price: null,
    };
  }
  return {
    id: String(row.id),
    setupId: String(row.setup_id),
    symbol: String(row.symbol),
    eventType: String(row.event_type) as SignalNotifyEventType,
    channel: String(row.channel) as NotificationChannel,
    payload,
    status: String(row.status) as OutboxStatus,
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: Number(row.created_at),
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
  };
}

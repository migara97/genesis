import { db } from "../db.js";

export interface NotificationPrefs {
  enabled: boolean;
  buyEnabled: boolean;
  sellEnabled: boolean;
  hqOnly: boolean;
  entryConfirmEnabled: boolean;
  tpSlEnabled: boolean;
  approachingEnabled: boolean;
  telegramEnabled: boolean;
  inAppEnabled: boolean;
  cooldownMs: number;
  updatedAt: number;
}

const DEFAULTS: NotificationPrefs = {
  enabled: true,
  buyEnabled: true,
  sellEnabled: true,
  hqOnly: true,
  entryConfirmEnabled: true,
  tpSlEnabled: true,
  approachingEnabled: true,
  telegramEnabled: false,
  inAppEnabled: true,
  cooldownMs: 60_000,
  updatedAt: 0,
};

function ensureRow(): void {
  const row = db.prepare(`SELECT id FROM notification_prefs WHERE id = 1`).get();
  if (row) return;
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO notification_prefs (
      id, enabled, buy_enabled, sell_enabled, hq_only, entry_confirm_enabled,
      tp_sl_enabled, approaching_enabled, telegram_enabled, in_app_enabled,
      cooldown_ms, updated_at
    ) VALUES (1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 60000, ?)
    `,
  ).run(now);
}

export function getNotificationPrefs(): NotificationPrefs {
  ensureRow();
  const row = db.prepare(`SELECT * FROM notification_prefs WHERE id = 1`).get() as
    | Record<string, unknown>
    | undefined;
  if (!row) return { ...DEFAULTS, updatedAt: Date.now() };
  return {
    enabled: Number(row.enabled) === 1,
    buyEnabled: Number(row.buy_enabled) === 1,
    sellEnabled: Number(row.sell_enabled) === 1,
    hqOnly: Number(row.hq_only) === 1,
    entryConfirmEnabled: Number(row.entry_confirm_enabled) === 1,
    tpSlEnabled: Number(row.tp_sl_enabled) === 1,
    approachingEnabled: Number(row.approaching_enabled) === 1,
    telegramEnabled: Number(row.telegram_enabled) === 1,
    inAppEnabled: Number(row.in_app_enabled) === 1,
    cooldownMs: Math.max(0, Number(row.cooldown_ms ?? 60_000)),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export function updateNotificationPrefs(
  patch: Partial<Omit<NotificationPrefs, "updatedAt">>,
): NotificationPrefs {
  ensureRow();
  const cur = getNotificationPrefs();
  const next: NotificationPrefs = {
    enabled: patch.enabled ?? cur.enabled,
    buyEnabled: patch.buyEnabled ?? cur.buyEnabled,
    sellEnabled: patch.sellEnabled ?? cur.sellEnabled,
    hqOnly: patch.hqOnly ?? cur.hqOnly,
    entryConfirmEnabled: patch.entryConfirmEnabled ?? cur.entryConfirmEnabled,
    tpSlEnabled: patch.tpSlEnabled ?? cur.tpSlEnabled,
    approachingEnabled: patch.approachingEnabled ?? cur.approachingEnabled,
    telegramEnabled: patch.telegramEnabled ?? cur.telegramEnabled,
    inAppEnabled: patch.inAppEnabled ?? cur.inAppEnabled,
    cooldownMs:
      patch.cooldownMs != null
        ? Math.max(0, Math.min(3_600_000, Math.floor(patch.cooldownMs)))
        : cur.cooldownMs,
    updatedAt: Date.now(),
  };
  db.prepare(
    `
    UPDATE notification_prefs SET
      enabled = ?, buy_enabled = ?, sell_enabled = ?, hq_only = ?,
      entry_confirm_enabled = ?, tp_sl_enabled = ?, approaching_enabled = ?,
      telegram_enabled = ?, in_app_enabled = ?, cooldown_ms = ?, updated_at = ?
    WHERE id = 1
    `,
  ).run(
    next.enabled ? 1 : 0,
    next.buyEnabled ? 1 : 0,
    next.sellEnabled ? 1 : 0,
    next.hqOnly ? 1 : 0,
    next.entryConfirmEnabled ? 1 : 0,
    next.tpSlEnabled ? 1 : 0,
    next.approachingEnabled ? 1 : 0,
    next.telegramEnabled ? 1 : 0,
    next.inAppEnabled ? 1 : 0,
    next.cooldownMs,
    next.updatedAt,
  );
  return next;
}

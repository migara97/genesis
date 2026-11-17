import type { TradingSignal } from "@of/shared";
import { isFavorite } from "../markets/store.js";
import { config } from "../config.js";
import { getNotificationPrefs } from "./prefs.js";
import {
  enqueueNotification,
  hasOutboxEvent,
  lastApproachingAt,
  markOutboxSent,
  type NotificationPayload,
  type SignalNotifyEventType,
} from "./outbox.js";
import { formatSignalNotification } from "./formatMessage.js";

export interface SignalNotifyFire {
  id: string;
  alertId: string;
  symbol: string;
  kind: "signal";
  message: string;
  price: number | null;
  lifecycle: string | null;
  firedAt: number;
  eventType: SignalNotifyEventType;
  setupId: string;
  channel: "in_app" | "telegram";
}

const LOCATION_IDS = [
  "ob_bullish_zone",
  "ob_bearish_zone",
  "fvg_bullish_zone",
  "fvg_bearish_zone",
  "sweep_ssl_reclaim",
  "sweep_bsl_reclaim",
  "price_at_val_discount",
  "price_at_vah_premium",
  "lvn_bullish_continuation",
  "lvn_bearish_continuation",
  "break_retest_bullish",
  "break_retest_bearish",
];

function hasLocation(signal: TradingSignal): boolean {
  return signal.confirmations.some((c) => LOCATION_IDS.includes(c));
}

/** True when ENTRY DETAILS would show real levels (not all dashes). */
export function hasEntryPlan(signal: TradingSignal): boolean {
  const tp1 = signal.takeProfit?.[0];
  return (
    signal.entry != null &&
    Number.isFinite(signal.entry) &&
    signal.stopLoss != null &&
    Number.isFinite(signal.stopLoss) &&
    tp1 != null &&
    Number.isFinite(tp1) &&
    signal.riskReward != null &&
    Number.isFinite(signal.riskReward)
  );
}

function directionalLean(signal: TradingSignal): "LONG" | "SHORT" | null {
  const { longScore, shortScore } = signal.score;
  if (longScore >= shortScore + 1 && longScore >= 2) return "LONG";
  if (shortScore >= longScore + 1 && shortScore >= 2) return "SHORT";
  return null;
}

function became(prev: TradingSignal | null | undefined, next: TradingSignal, life: string): boolean {
  return next.lifecycle === life && prev?.lifecycle !== life;
}

function detectEvents(
  previous: TradingSignal | null | undefined,
  next: TradingSignal,
): SignalNotifyEventType[] {
  const events: SignalNotifyEventType[] = [];
  const life = next.lifecycle;
  const prevLife = previous?.lifecycle;

  // High-quality confirmed entry (A+ only — plan 2A)
  if (
    (life === "CONFIRMED" || life === "ACTIVE") &&
    prevLife !== "CONFIRMED" &&
    prevLife !== "ACTIVE" &&
    (next.direction === "LONG" || next.direction === "SHORT") &&
    next.entryGrade === "A+"
  ) {
    events.push(next.direction === "LONG" ? "HQ_BUY" : "HQ_SELL");
    events.push("ENTRY_CONFIRMED");
  }

  if (became(previous, next, "PENDING_CONFIRM")) {
    const lean = directionalLean(next);
    if (lean && hasLocation(next)) {
      events.push("ENTRY_ZONE_APPROACHING");
    }
  }

  if (became(previous, next, "INVALIDATED")) events.push("SIGNAL_INVALIDATED");
  if (became(previous, next, "HIT_TP")) events.push("TAKE_PROFIT_REACHED");
  if (became(previous, next, "HIT_SL")) events.push("STOP_LOSS_REACHED");
  if (became(previous, next, "TIMEOUT") || became(previous, next, "EXPIRED")) {
    events.push("SIGNAL_EXPIRED");
  }

  // Partial TP scale-out: still ACTIVE but tpHits increased
  if (
    life === "ACTIVE" &&
    previous?.setupId === next.setupId &&
    (next.tpHits ?? 0) > (previous?.tpHits ?? 0)
  ) {
    if (!events.includes("TAKE_PROFIT_REACHED")) events.push("TAKE_PROFIT_REACHED");
  }

  return events;
}

function allowEvent(
  eventType: SignalNotifyEventType,
  next: TradingSignal,
  prefs: ReturnType<typeof getNotificationPrefs>,
): boolean {
  if (!prefs.enabled) return false;

  if (eventType === "HQ_BUY") {
    if (!prefs.buyEnabled) return false;
    if (prefs.hqOnly && next.entryGrade !== "A+") return false;
    return prefs.entryConfirmEnabled || prefs.buyEnabled;
  }
  if (eventType === "HQ_SELL") {
    if (!prefs.sellEnabled) return false;
    if (prefs.hqOnly && next.entryGrade !== "A+") return false;
    return prefs.entryConfirmEnabled || prefs.sellEnabled;
  }
  if (eventType === "ENTRY_CONFIRMED") {
    // Covered by HQ_* message when A+; only emit standalone if entryConfirm enabled
    // and we will skip duplicate Telegram when HQ already queued — see below.
    return prefs.entryConfirmEnabled && next.entryGrade === "A+";
  }
  if (eventType === "ENTRY_ZONE_APPROACHING") return prefs.approachingEnabled;
  if (
    eventType === "TAKE_PROFIT_REACHED" ||
    eventType === "STOP_LOSS_REACHED" ||
    eventType === "SIGNAL_INVALIDATED" ||
    eventType === "SIGNAL_EXPIRED"
  ) {
    return prefs.tpSlEnabled;
  }
  return true;
}

/**
 * Evaluate lifecycle transitions for high-quality PAPER notifications.
 * Does not mutate signal scores. Favorites-gated. Enqueues Telegram outbox async.
 */
export function evaluateSignalNotifications(args: {
  previous: TradingSignal | null | undefined;
  next: TradingSignal;
  price: number;
  exchange?: string;
  primaryInterval?: string;
}): SignalNotifyFire[] {
  const symbol = args.next.symbol.toUpperCase();
  const exchange = args.exchange ?? config.exchange;
  if (!isFavorite(exchange, symbol)) return [];

  const prefs = getNotificationPrefs();
  if (!prefs.enabled) return [];

  const events = detectEvents(args.previous, args.next);
  if (!events.length) return [];

  const fires: SignalNotifyFire[] = [];
  const now = Date.now();

  for (const eventType of events) {
    if (!allowEvent(eventType, args.next, prefs)) continue;

    // Skip standalone ENTRY_CONFIRMED when HQ_BUY/HQ_SELL already covers this setup
    if (
      eventType === "ENTRY_CONFIRMED" &&
      (events.includes("HQ_BUY") || events.includes("HQ_SELL"))
    ) {
      continue;
    }

    // Approaching cooldown (symbol-level)
    if (eventType === "ENTRY_ZONE_APPROACHING") {
      const last = lastApproachingAt(symbol);
      if (last != null && now - last < prefs.cooldownMs) continue;
    }

    // Global dedupe per setup + event (any channel already sent/queued)
    if (hasOutboxEvent(args.next.setupId, eventType)) continue;

    const { title, message } = formatSignalNotification(args.next, {
      exchange,
      primaryInterval: args.primaryInterval ?? "5m",
      price: args.price,
      eventType,
    });

    const payload: NotificationPayload = {
      title,
      message,
      symbol,
      eventType,
      setupId: args.next.setupId,
      direction: args.next.direction,
      lifecycle: args.next.lifecycle,
      price: args.price,
      entryGrade: args.next.entryGrade,
      confidence: args.next.confidence,
    };

    if (prefs.inAppEnabled) {
      const row = enqueueNotification({
        setupId: args.next.setupId,
        symbol,
        eventType,
        channel: "in_app",
        payload,
      });
      if (row) {
        // WS fan-out is best-effort; treat in_app as delivered when enqueued
        markOutboxSent(row.id);
        fires.push({
          id: row.id,
          alertId: row.id,
          symbol,
          kind: "signal",
          message,
          price: args.price,
          lifecycle: args.next.lifecycle,
          firedAt: now,
          eventType,
          setupId: args.next.setupId,
          channel: "in_app",
        });
      }
    }

    // Never Telegram empty ENTRY DETAILS (Entry/SL/TP/R:R all "-").
    if (prefs.telegramEnabled && hasEntryPlan(args.next)) {
      enqueueNotification({
        setupId: args.next.setupId,
        symbol,
        eventType,
        channel: "telegram",
        payload,
      });
    }
  }

  return fires;
}

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { TradingSignal } from "@of/shared";
import { setFavorite } from "../markets/store.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { evaluateSignalNotifications } from "./evaluateSignalNotifications.js";
import { hasOutboxEvent, listNotificationHistory } from "./outbox.js";
import { updateNotificationPrefs } from "./prefs.js";

function base(overrides: Partial<TradingSignal> = {}): TradingSignal {
  const setupId = overrides.setupId ?? `setup-notify-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return {
    id: setupId,
    setupId,
    symbol: "BTCUSDT",
    timestamp: Date.now(),
    direction: "LONG",
    entry: 100,
    stopLoss: 99,
    takeProfit: [102, 104, 106],
    riskReward: 2,
    confidence: 0.55,
    confirmations: [
      "structure_bullish",
      "ob_bullish_zone",
      "stacked_ask_imbalance",
      "mtf_htf_bullish",
    ],
    reasonsFor: ["Market structure trend is bullish (HH/HL bias)."],
    reasonsAgainst: [],
    invalidation: [],
    orderFlowOk: true,
    structureOk: true,
    volumeOk: true,
    deltaOk: true,
    score: {
      longScore: 5,
      shortScore: 0,
      neutralScore: 0,
      independentFamilies: ["structure", "orderflow", "volume"],
      factors: [],
      modelNote: "test",
    },
    evidence: [],
    entryGrade: "A+",
    entryQualityNotes: ["Structure OK.", "HTF permission OK.", "OF trigger OK.", "Location OK."],
    lifecycle: "CONFIRMED",
    lifecycleUpdatedAt: Date.now(),
    setupOpenedAt: Date.now(),
    ...overrides,
    id: overrides.id ?? setupId,
    setupId,
  };
}

describe("evaluateSignalNotifications", () => {
  before(() => {
    setFavorite(config.exchange, "BTCUSDT", true);
    updateNotificationPrefs({
      enabled: true,
      buyEnabled: true,
      sellEnabled: true,
      hqOnly: true,
      entryConfirmEnabled: true,
      tpSlEnabled: true,
      approachingEnabled: true,
      telegramEnabled: false,
      inAppEnabled: true,
      cooldownMs: 1_000,
    });
  });

  it("fires HQ_BUY on A+ CONFIRMED transition and dedupes", () => {
    const setupId = `hq-buy-${Date.now()}`;
    const prev = base({
      setupId,
      lifecycle: "PENDING_CONFIRM",
      direction: "WAIT",
      entryGrade: "WAIT",
      entry: undefined,
      stopLoss: undefined,
    });
    const next = base({ setupId, lifecycle: "CONFIRMED", direction: "LONG", entryGrade: "A+" });
    const fires = evaluateSignalNotifications({
      previous: prev,
      next,
      price: 100,
      exchange: config.exchange,
      primaryInterval: "5m",
    });
    assert.ok(fires.some((f) => f.eventType === "HQ_BUY"));
    assert.ok(hasOutboxEvent(setupId, "HQ_BUY"));

    const again = evaluateSignalNotifications({
      previous: next,
      next: { ...next, timestamp: Date.now() },
      price: 100.1,
      exchange: config.exchange,
    });
    assert.equal(again.filter((f) => f.eventType === "HQ_BUY").length, 0);
  });

  it("fires HQ_SELL for A+ SHORT", () => {
    const setupId = `hq-sell-${Date.now()}`;
    const prev = base({ setupId, lifecycle: "WATCHING", direction: "WAIT", entryGrade: "WAIT" });
    const next = base({
      setupId,
      lifecycle: "CONFIRMED",
      direction: "SHORT",
      entryGrade: "A+",
      score: {
        longScore: 0,
        shortScore: 5,
        neutralScore: 0,
        independentFamilies: ["structure", "orderflow"],
        factors: [],
        modelNote: "test",
      },
    });
    const fires = evaluateSignalNotifications({
      previous: prev,
      next,
      price: 100,
      exchange: config.exchange,
    });
    assert.ok(fires.some((f) => f.eventType === "HQ_SELL"));
  });

  it("does not fire HQ for STANDARD when hqOnly", () => {
    const setupId = `std-${Date.now()}`;
    const fires = evaluateSignalNotifications({
      previous: base({ setupId, lifecycle: "WATCHING", entryGrade: "WAIT", direction: "WAIT" }),
      next: base({ setupId, lifecycle: "CONFIRMED", entryGrade: "STANDARD", direction: "LONG" }),
      price: 100,
      exchange: config.exchange,
    });
    assert.equal(fires.filter((f) => f.eventType === "HQ_BUY" || f.eventType === "HQ_SELL").length, 0);
  });

  it("fires ENTRY_ZONE_APPROACHING once for PENDING_CONFIRM lean + location", () => {
    const setupId = `approach-${Date.now()}`;
    const prev = base({ setupId, lifecycle: "WATCHING", direction: "WAIT", entryGrade: "WAIT" });
    const next = base({
      setupId,
      lifecycle: "PENDING_CONFIRM",
      direction: "WAIT",
      entryGrade: "WAIT",
      entry: undefined,
      stopLoss: undefined,
      takeProfit: undefined,
      score: {
        longScore: 1,
        shortScore: 4.5,
        neutralScore: 0,
        independentFamilies: ["structure", "orderflow", "volume"],
        factors: [],
        modelNote: "test",
      },
      confirmations: ["structure_bearish", "ob_bearish_zone", "stacked_bid_imbalance"],
    });
    const fires = evaluateSignalNotifications({
      previous: prev,
      next,
      price: 100,
      exchange: config.exchange,
    });
    assert.ok(fires.some((f) => f.eventType === "ENTRY_ZONE_APPROACHING"));
    assert.match(fires[0]!.message, /WAITING FOR ENTRY/);
  });

  it("fires TP / SL / INVALIDATED / EXPIRED transitions", () => {
    for (const [life, event] of [
      ["HIT_TP", "TAKE_PROFIT_REACHED"],
      ["HIT_SL", "STOP_LOSS_REACHED"],
      ["INVALIDATED", "SIGNAL_INVALIDATED"],
      ["TIMEOUT", "SIGNAL_EXPIRED"],
    ] as const) {
      const setupId = `term-${life}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const fires = evaluateSignalNotifications({
        previous: base({ setupId, lifecycle: "ACTIVE", entryGrade: "A+" }),
        next: base({ setupId, lifecycle: life, entryGrade: "A+" }),
        price: 101,
        exchange: config.exchange,
      });
      assert.ok(
        fires.some((f) => f.eventType === event),
        `expected ${event} for ${life}`,
      );
    }
  });

  it("does not Telegram SIGNAL_EXPIRED when Entry/SL/TP/R:R are empty", () => {
    updateNotificationPrefs({ telegramEnabled: true, inAppEnabled: true, tpSlEnabled: true });
    const setupId = `empty-expire-${Date.now()}`;
    const fires = evaluateSignalNotifications({
      previous: base({
        setupId,
        lifecycle: "PENDING_CONFIRM",
        direction: "WAIT",
        entryGrade: "WAIT",
        entry: undefined,
        stopLoss: undefined,
        takeProfit: undefined,
        riskReward: undefined,
      }),
      next: base({
        setupId,
        lifecycle: "TIMEOUT",
        direction: "WAIT",
        entryGrade: "WAIT",
        entry: undefined,
        stopLoss: undefined,
        takeProfit: undefined,
        riskReward: undefined,
      }),
      price: 64017.55,
      exchange: config.exchange,
    });
    assert.ok(fires.some((f) => f.eventType === "SIGNAL_EXPIRED" && f.channel === "in_app"));
    assert.equal(hasOutboxEvent(setupId, "SIGNAL_EXPIRED", "telegram"), false);
    updateNotificationPrefs({ telegramEnabled: false });
  });

  it("does not Telegram SIGNAL_EXPIRED even when entry plan is present", () => {
    updateNotificationPrefs({ telegramEnabled: true, inAppEnabled: true, tpSlEnabled: true });
    const setupId = `filled-expire-${Date.now()}`;
    evaluateSignalNotifications({
      previous: base({ setupId, lifecycle: "ACTIVE", entryGrade: "A+" }),
      next: base({ setupId, lifecycle: "TIMEOUT", entryGrade: "A+" }),
      price: 101,
      exchange: config.exchange,
    });
    assert.equal(hasOutboxEvent(setupId, "SIGNAL_EXPIRED", "telegram"), false);
    updateNotificationPrefs({ telegramEnabled: false });
  });

  it("Telegrams only ENTRY CONFIRMED (HQ_BUY), not approaching or TP/SL", () => {
    updateNotificationPrefs({
      telegramEnabled: true,
      inAppEnabled: true,
      approachingEnabled: true,
      tpSlEnabled: true,
      entryConfirmEnabled: true,
    });
    const setupId = `tg-confirm-only-${Date.now()}`;

    evaluateSignalNotifications({
      previous: base({
        setupId,
        lifecycle: "WATCHING",
        direction: "WAIT",
        entryGrade: "WAIT",
      }),
      next: base({
        setupId,
        lifecycle: "PENDING_CONFIRM",
        direction: "WAIT",
        entryGrade: "WAIT",
        confirmations: ["ob_bullish_zone", "structure_bullish"],
        score: {
          longScore: 4,
          shortScore: 0,
          neutralScore: 0,
          independentFamilies: ["structure"],
          factors: [],
          modelNote: "test",
        },
      }),
      price: 100,
      exchange: config.exchange,
    });
    assert.equal(hasOutboxEvent(setupId, "ENTRY_ZONE_APPROACHING", "telegram"), false);

    evaluateSignalNotifications({
      previous: base({
        setupId,
        lifecycle: "PENDING_CONFIRM",
        direction: "WAIT",
        entryGrade: "WAIT",
      }),
      next: base({ setupId, lifecycle: "CONFIRMED", direction: "LONG", entryGrade: "A+" }),
      price: 100,
      exchange: config.exchange,
    });
    assert.equal(hasOutboxEvent(setupId, "HQ_BUY", "telegram"), true);

    evaluateSignalNotifications({
      previous: base({ setupId, lifecycle: "ACTIVE", entryGrade: "A+" }),
      next: base({ setupId, lifecycle: "HIT_TP", entryGrade: "A+" }),
      price: 102,
      exchange: config.exchange,
    });
    assert.equal(hasOutboxEvent(setupId, "TAKE_PROFIT_REACHED", "telegram"), false);

    updateNotificationPrefs({ telegramEnabled: false });
  });

  it("skips non-favorite symbols", () => {
    const setupId = `nofav-${Date.now()}`;
    setFavorite(config.exchange, "ETHUSDT", false);
    const fires = evaluateSignalNotifications({
      previous: base({ setupId, symbol: "ETHUSDT", lifecycle: "WATCHING" }),
      next: base({
        setupId,
        symbol: "ETHUSDT",
        lifecycle: "CONFIRMED",
        direction: "LONG",
        entryGrade: "A+",
      }),
      price: 100,
      exchange: config.exchange,
    });
    assert.equal(fires.length, 0);
  });

  it("history lists outbox rows", () => {
    const rows = listNotificationHistory(5);
    assert.ok(Array.isArray(rows));
    assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM notification_outbox`).get());
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { enqueueNotification, listPendingOutbox, markOutboxSent } from "./outbox.js";
import { drainNotificationOutbox } from "./dispatcher.js";
import { updateNotificationPrefs } from "./prefs.js";

describe("notification dispatcher", () => {
  const originalFetch = globalThis.fetch;

  before(() => {
    updateNotificationPrefs({ telegramEnabled: true });
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("marks telegram rows failed after max attempts without throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const setupId = `disp-fail-${Date.now()}`;
    const row = enqueueNotification({
      setupId,
      symbol: "BTCUSDT",
      eventType: "HQ_BUY",
      channel: "telegram",
      payload: {
        title: "TEST",
        message: "test body",
        symbol: "BTCUSDT",
        eventType: "HQ_BUY",
        setupId,
        direction: "LONG",
        lifecycle: "CONFIRMED",
        price: 100,
      },
    });
    assert.ok(row);

    // Without secrets, sendTelegram fails immediately with config error — still shouldn't throw
    for (let i = 0; i < 6; i++) {
      await drainNotificationOutbox();
    }
    const pending = listPendingOutbox(50).filter((r) => r.setupId === setupId);
    assert.equal(pending.length, 0);
  });

  it("marks in_app pending as sent during drain", async () => {
    const setupId = `disp-inapp-${Date.now()}`;
    const row = enqueueNotification({
      setupId,
      symbol: "BTCUSDT",
      eventType: "SIGNAL_EXPIRED",
      channel: "in_app",
      payload: {
        title: "EXPIRED",
        message: "expired",
        symbol: "BTCUSDT",
        eventType: "SIGNAL_EXPIRED",
        setupId,
        direction: "LONG",
        lifecycle: "TIMEOUT",
        price: 100,
      },
    });
    assert.ok(row);
    // Leave as pending intentionally
    await drainNotificationOutbox();
    const still = listPendingOutbox(50).find((r) => r.id === row!.id);
    assert.equal(still, undefined);
    markOutboxSent(row!.id); // idempotent safety
  });
});

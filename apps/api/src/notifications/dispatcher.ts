import {
  listPendingOutbox,
  markOutboxAttempt,
  markOutboxSent,
} from "./outbox.js";
import { sendTelegramMessage } from "./telegram.js";

let timer: ReturnType<typeof setInterval> | null = null;
let draining = false;

const MAX_ATTEMPTS = 5;

/** Drain pending Telegram outbox rows without blocking the market tick loop. */
export async function drainNotificationOutbox(): Promise<{ sent: number; failed: number }> {
  if (draining) return { sent: 0, failed: 0 };
  draining = true;
  let sent = 0;
  let failed = 0;
  try {
    const pending = listPendingOutbox(15);
    for (const row of pending) {
      if (row.channel !== "telegram") {
        // in_app is delivered via WS at enqueue time
        markOutboxSent(row.id);
        sent += 1;
        continue;
      }
      const text = `${row.payload.title}\n\n${row.payload.message}`;
      const result = await sendTelegramMessage(text);
      if (result.ok) {
        markOutboxSent(row.id);
        sent += 1;
      } else {
        const nextAttempts = row.attempts + 1;
        const isFailed = nextAttempts >= MAX_ATTEMPTS;
        markOutboxAttempt(row.id, result.error ?? "send failed", isFailed);
        if (isFailed) failed += 1;
      }
    }
  } finally {
    draining = false;
  }
  return { sent, failed };
}

export function startNotificationDispatcher(intervalMs = 2_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void drainNotificationOutbox().catch(() => {
      // never throw into process
    });
  }, intervalMs);
  // Unref so tests/process can exit; Node Interval has unref
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as NodeJS.Timeout).unref();
  }
}

export function stopNotificationDispatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

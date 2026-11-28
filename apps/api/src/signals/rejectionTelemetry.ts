import type { TradingSignal } from "@of/shared";
import { db } from "../db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS signal_rejection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  reason_key TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  long_score REAL,
  short_score REAL,
  families TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_rejection_created
  ON signal_rejection_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_rejection_reason
  ON signal_rejection_events(reason_key, created_at DESC);
`);

/** Classify WAIT entryQualityNotes / factor ids into stable histogram keys. */
export function classifyRejectionReasons(signal: TradingSignal): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  const seen = new Set<string>();
  const push = (key: string, text: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, text });
  };

  const notes = [...(signal.entryQualityNotes ?? []), ...(signal.reasonsAgainst ?? [])];
  for (const n of notes) {
    if (/HTF majority does not permit/i.test(n)) push("htf_majority", n);
    else if (/HTF conflicts with primary/i.test(n)) push("htf_conflict", n);
    else if (/Location missing/i.test(n)) push("location_missing", n);
    else if (/order-flow trigger|session CVD alone/i.test(n)) push("of_trigger", n);
    else if (/Structure not confirmed/i.test(n)) push("structure", n);
    else if (/Opposing CHoCH/i.test(n)) push("choch_veto", n);
    else if (/Entry within .*swing/i.test(n)) push("swing_proximity", n);
    else if (/Structural R:R below|missing opposing level/i.test(n)) push("room_to_run", n);
    else if (/Data not ready/i.test(n)) push("data_not_ready", n);
    else if (/Fewer than two independent|No directional setup after base/i.test(n))
      push("gate_not_met", n);
    else if (/A\+ entry filter blocked/i.test(n)) push("a_plus_gate_failed", n);
  }

  for (const f of signal.score?.factors ?? []) {
    if (f.side !== "neutral") continue;
    if (
      f.id === "a_plus_gate_failed" ||
      f.id === "gate_not_met" ||
      f.id === "data_not_ready" ||
      f.id === "entry_at_swing_high" ||
      f.id === "entry_at_swing_low" ||
      f.id === "insufficient_room_to_run" ||
      f.id === "dom_iceberg_opposing_veto"
    ) {
      push(f.id, f.reason);
    }
  }

  if (out.length === 0 && signal.direction === "WAIT") {
    push("wait_unclassified", signal.lifecycleNote ?? "WAIT without classified note");
  }
  return out;
}

/**
 * Record WAIT rejection reasons (throttled per symbol+reason to ~1/min).
 * Observational — does not change generateSignal.
 */
export function recordSignalRejections(signal: TradingSignal): void {
  if (signal.direction !== "WAIT") return;
  const reasons = classifyRejectionReasons(signal);
  if (reasons.length === 0) return;

  const now = signal.timestamp || Date.now();
  const throttleMs = 60_000;
  const insert = db.prepare(`
    INSERT INTO signal_rejection_events
      (symbol, reason_key, reason_text, long_score, short_score, families, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const recent = db.prepare(`
    SELECT 1 AS ok FROM signal_rejection_events
    WHERE symbol = ? AND reason_key = ? AND created_at > ?
    LIMIT 1
  `);

  for (const r of reasons) {
    const exists = recent.get(signal.symbol, r.key, now - throttleMs);
    if (exists) continue;
    insert.run(
      signal.symbol,
      r.key,
      r.text.slice(0, 500),
      signal.score?.longScore ?? null,
      signal.score?.shortScore ?? null,
      JSON.stringify(signal.score?.independentFamilies ?? []),
      now,
    );
  }
}

export function getRejectionHistogram(opts?: {
  sinceMs?: number;
  limit?: number;
}): { reasonKey: string; count: number; lastAt: number; sample: string }[] {
  const since = opts?.sinceMs ?? Date.now() - 24 * 60 * 60_000;
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const rows = db
    .prepare(
      `
      SELECT reason_key AS reasonKey, COUNT(*) AS count, MAX(created_at) AS lastAt,
             MAX(reason_text) AS sample
      FROM signal_rejection_events
      WHERE created_at >= ?
      GROUP BY reason_key
      ORDER BY count DESC
      LIMIT ?
      `,
    )
    .all(since, limit) as { reasonKey: string; count: number; lastAt: number; sample: string }[];
  return rows;
}

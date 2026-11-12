import type { PaperOutcome } from "@of/shared";
import type { TapeReplayTrade } from "../tapeReplay.js";

export interface LivePaperParityRow {
  setupId: string;
  direction: string;
  outcome: PaperOutcome | string;
  openedAt: number;
  closedAt: number | null;
  entry: number;
  confidence: number;
}

export interface ParityMatch {
  liveSetupId: string;
  replaySetupId: string | null;
  matched: boolean;
  directionAgree: boolean | null;
  outcomeAgree: boolean | null;
  entryDeltaPct: number | null;
  liveOutcome: string;
  replayOutcome: string | null;
  matchMode: "setup_id" | "time_side" | "unmatched_live" | "unmatched_replay";
}

export interface ParityCompareReport {
  liveTrades: number;
  replayTrades: number;
  matched: number;
  directionAgree: number;
  outcomeAgree: number;
  directionAgreeRate: number | null;
  outcomeAgreeRate: number | null;
  unmatchedLive: number;
  unmatchedReplay: number;
  matches: ParityMatch[];
  sampleNote: string;
}

const TERMINAL_TP_SL = new Set(["HIT_TP", "HIT_SL"]);

/**
 * Compare live paper ledger rows to tape-replay closes.
 * Prefer exact setupId; else nearest same-side open within time+price band.
 */
export function compareLiveToReplay(
  live: LivePaperParityRow[],
  replay: TapeReplayTrade[],
  opts?: { timeTolMs?: number; entryTolPct?: number; maxMatches?: number },
): ParityCompareReport {
  const timeTol = opts?.timeTolMs ?? 15 * 60_000;
  const entryTol = opts?.entryTolPct ?? 0.0025;
  const maxMatches = opts?.maxMatches ?? 100;

  const replayPool = [...replay];
  const usedReplay = new Set<string>();
  const matches: ParityMatch[] = [];

  for (const row of live) {
    const byId = replayPool.find((r) => r.setupId === row.setupId && !usedReplay.has(r.setupId + r.entryTime));
    if (byId) {
      usedReplay.add(byId.setupId + byId.entryTime);
      matches.push(buildMatch(row, byId, "setup_id"));
      continue;
    }

    let best: TapeReplayTrade | null = null;
    let bestScore = Infinity;
    for (const r of replayPool) {
      const key = r.setupId + r.entryTime;
      if (usedReplay.has(key)) continue;
      if (r.side !== row.direction) continue;
      const dt = Math.abs(r.entryTime - row.openedAt);
      if (dt > timeTol) continue;
      const entryDelta = Math.abs(r.entry - row.entry) / Math.max(row.entry, 1e-9);
      if (entryDelta > entryTol) continue;
      const score = dt / timeTol + entryDelta / entryTol;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (best) {
      usedReplay.add(best.setupId + best.entryTime);
      matches.push(buildMatch(row, best, "time_side"));
    } else {
      matches.push({
        liveSetupId: row.setupId,
        replaySetupId: null,
        matched: false,
        directionAgree: null,
        outcomeAgree: null,
        entryDeltaPct: null,
        liveOutcome: row.outcome,
        replayOutcome: null,
        matchMode: "unmatched_live",
      });
    }
  }

  for (const r of replayPool) {
    const key = r.setupId + r.entryTime;
    if (usedReplay.has(key)) continue;
    matches.push({
      liveSetupId: "",
      replaySetupId: r.setupId,
      matched: false,
      directionAgree: null,
      outcomeAgree: null,
      entryDeltaPct: null,
      liveOutcome: "",
      replayOutcome: r.outcome,
      matchMode: "unmatched_replay",
    });
  }

  const paired = matches.filter((m) => m.matched);
  const directionAgree = paired.filter((m) => m.directionAgree).length;
  const outcomeAgree = paired.filter((m) => m.outcomeAgree).length;
  const unmatchedLive = matches.filter((m) => m.matchMode === "unmatched_live").length;
  const unmatchedReplay = matches.filter((m) => m.matchMode === "unmatched_replay").length;

  return {
    liveTrades: live.length,
    replayTrades: replay.length,
    matched: paired.length,
    directionAgree,
    outcomeAgree,
    directionAgreeRate: paired.length ? directionAgree / paired.length : null,
    outcomeAgreeRate: paired.length ? outcomeAgree / paired.length : null,
    unmatchedLive,
    unmatchedReplay,
    matches: matches.slice(0, maxMatches),
    sampleNote:
      paired.length === 0
        ? live.length === 0 && replay.length === 0
          ? "No live paper or replay closes in window — overlap undefined."
          : "No matched setups between live paper and tape replay (check tape window vs paper opened_at)."
        : `Matched ${paired.length} setups; outcome agree ${outcomeAgree}/${paired.length}. DOM-absent replay is partial-OF.`,
  };
}

function buildMatch(
  live: LivePaperParityRow,
  replay: TapeReplayTrade,
  mode: "setup_id" | "time_side",
): ParityMatch {
  const entryDeltaPct = Math.abs(replay.entry - live.entry) / Math.max(live.entry, 1e-9);
  const directionAgree = live.direction === replay.side;
  const outcomeAgree = normalizeOutcome(live.outcome) === normalizeOutcome(replay.outcome);
  return {
    liveSetupId: live.setupId,
    replaySetupId: replay.setupId,
    matched: true,
    directionAgree,
    outcomeAgree,
    entryDeltaPct,
    liveOutcome: String(live.outcome),
    replayOutcome: replay.outcome,
    matchMode: mode,
  };
}

function normalizeOutcome(outcome: string): string {
  if (TERMINAL_TP_SL.has(outcome)) return outcome;
  if (outcome === "TIMEOUT" || outcome === "EXPIRED") return "TIMEOUT";
  return outcome;
}

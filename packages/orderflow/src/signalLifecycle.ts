import type { SignalLifecycle, TradingSignal } from "@of/shared";
import { tagStructureTargetHits } from "./structureTargets.js";

export interface ScaleOutConfig {
  enabled: boolean;
  /** Fractions closed at TP1/TP2/TP3 (should sum ≈ 1). */
  fractions: number[];
  /** When true, ignore fractions and full-close at TP1 (legacy). */
  fullCloseAtTp1?: boolean;
}

export interface LifecycleConfig {
  /** Max age for PENDING_CONFIRM without becoming LONG/SHORT. */
  pendingMaxAgeMs: number;
  /** Max age for CONFIRMED/ACTIVE without TP/SL before TIMEOUT. */
  activeMaxAgeMs: number;
  /** Hold terminal states to suppress duplicate re-alerts. */
  terminalHoldMs: number;
  /** Phase 12 partial scale-out. */
  scaleOut?: ScaleOutConfig;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  pendingMaxAgeMs: 5 * 60_000,
  activeMaxAgeMs: 30 * 60_000,
  terminalHoldMs: 60_000,
  scaleOut: {
    enabled: true,
    fractions: [0.5, 0.3, 0.2],
    fullCloseAtTp1: false,
  },
};

const TERMINAL: ReadonlySet<SignalLifecycle> = new Set([
  "HIT_TP",
  "HIT_SL",
  "INVALIDATED",
  "EXPIRED",
  "TIMEOUT",
]);

/**
 * Merge a fresh generateSignal() candidate with the previous published signal.
 * Preserves setup continuity, applies TP/SL/CHoCH invalidation, and suppresses
 * duplicate CONFIRMED alerts for the same setupId.
 */
export function applySignalLifecycle(
  previous: TradingSignal | null | undefined,
  candidate: TradingSignal,
  price: number,
  now: number = Date.now(),
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): TradingSignal {
  if (!previous) {
    return withLifecycle(candidate, candidate.lifecycle, now, candidate.setupOpenedAt);
  }

  // Hold terminal outcomes briefly so the same setup does not immediately re-fire.
  if (TERMINAL.has(previous.lifecycle)) {
    const age = now - previous.lifecycleUpdatedAt;
    if (age < config.terminalHoldMs && previous.setupId === candidate.setupId) {
      return {
        ...previous,
        timestamp: now,
      };
    }
    if (age < config.terminalHoldMs && candidate.direction === previous.direction) {
      // Same side new score during hold — keep terminal until hold ends.
      return {
        ...previous,
        timestamp: now,
      };
    }
  }

  // Same setup continuing: promote CONFIRMED → ACTIVE, check exits / invalidation.
  if (previous.setupId === candidate.setupId) {
    return continueSetup(previous, candidate, price, now, config);
  }

  // New setup id while an old non-terminal directional setup was live.
  if (!TERMINAL.has(previous.lifecycle) && previous.direction !== "WAIT" && candidate.direction !== "WAIT") {
    return withLifecycle(
      candidate,
      "CONFIRMED",
      now,
      now,
      `Replaced prior setup ${previous.setupId} (${previous.lifecycle}).`,
    );
  }

  if (!TERMINAL.has(previous.lifecycle) && previous.direction !== "WAIT" && candidate.direction === "WAIT") {
    // Lost the prior directional setup.
    return withLifecycle(
      {
        ...previous,
        ...pickLiveFields(candidate),
        direction: previous.direction,
        entry: previous.entry,
        stopLoss: previous.stopLoss,
        takeProfit: previous.takeProfit,
        riskReward: previous.riskReward,
        structureTargets: previous.structureTargets,
        setupId: previous.setupId,
        id: previous.setupId,
      },
      "INVALIDATED",
      now,
      previous.setupOpenedAt,
      invalidateReason(previous, candidate),
    );
  }

  return withLifecycle(
    candidate,
    candidate.lifecycle,
    now,
    candidate.direction === "WAIT" ? candidate.setupOpenedAt : now,
  );
}

function continueSetup(
  previous: TradingSignal,
  candidate: TradingSignal,
  price: number,
  now: number,
  config: LifecycleConfig,
): TradingSignal {
  const openedAt = previous.setupOpenedAt || previous.lifecycleUpdatedAt || now;
  const age = now - openedAt;

  // Directional setup lost confirmations → invalidate.
  if (
    (previous.lifecycle === "CONFIRMED" || previous.lifecycle === "ACTIVE") &&
    candidate.direction === "WAIT"
  ) {
    return withLifecycle(
      {
        ...previous,
        ...pickLiveFields(candidate),
        direction: previous.direction,
        entry: previous.entry,
        stopLoss: previous.stopLoss,
        takeProfit: previous.takeProfit,
        riskReward: previous.riskReward,
        structureTargets: previous.structureTargets,
        setupId: previous.setupId,
        id: previous.setupId,
      },
      "INVALIDATED",
      now,
      openedAt,
      invalidateReason(previous, candidate),
    );
  }

  if (candidate.direction === "WAIT") {
    if (candidate.lifecycle === "PENDING_CONFIRM" && age > config.pendingMaxAgeMs) {
      return withLifecycle(candidate, "TIMEOUT", now, openedAt, "Pending confirmation timed out.");
    }
    return withLifecycle(
      candidate,
      candidate.lifecycle,
      previous.lifecycle === candidate.lifecycle ? previous.lifecycleUpdatedAt : now,
      openedAt,
    );
  }

  // Still LONG/SHORT for same setup.
  const stop = candidate.stopLoss ?? previous.stopLoss;
  const tps = candidate.takeProfit ?? previous.takeProfit ?? [];
  const side = candidate.direction;
  const preservedTargets = previous.structureTargets ?? candidate.structureTargets;
  const { targets: taggedTargets, newlyHit } = tagStructureTargetHits(
    preservedTargets,
    side,
    price,
    now,
  );
  const structureHitNote =
    newlyHit.length > 0
      ? newlyHit.map((t) => `Structure ${shortKind(t.kind)} touched @ ${t.price}`).join("; ")
      : undefined;

  if (stop != null) {
    if (side === "LONG" && price <= stop) {
      return withLifecycle(
        mergeDirectional(previous, candidate, openedAt, taggedTargets),
        "HIT_SL",
        now,
        openedAt,
        `Price ${price} hit stop ${stop}.`,
      );
    }
    if (side === "SHORT" && price >= stop) {
      return withLifecycle(
        mergeDirectional(previous, candidate, openedAt, taggedTargets),
        "HIT_SL",
        now,
        openedAt,
        `Price ${price} hit stop ${stop}.`,
      );
    }
  }
  const scale = config.scaleOut;
  const scaleEnabled = Boolean(scale?.enabled) && !scale?.fullCloseAtTp1;
  const fractions = scale?.fractions?.length ? scale.fractions : [0.5, 0.3, 0.2];
  const tpHits = previous.tpHits ?? 0;
  const remaining =
    previous.scaleRemainingFrac ??
    (fractions.slice(tpHits).reduce((a, b) => a + b, 0) || 1);

  if (tps.length > 0 && tpHits < tps.length) {
    const nextTp = tps[tpHits];
    if (nextTp != null) {
      const hit =
        (side === "LONG" && price >= nextTp) || (side === "SHORT" && price <= nextTp);
      if (hit) {
        const frac = fractions[tpHits] ?? remaining;
        const nextHits = tpHits + 1;
        const nextRemaining = Math.max(0, remaining - frac);
        const lastTp = nextHits >= tps.length || nextHits >= fractions.length || nextRemaining <= 1e-9;
        if (!scaleEnabled || lastTp) {
          return withLifecycle(
            {
              ...mergeDirectional(previous, candidate, openedAt, taggedTargets),
              tpHits: nextHits,
              scaleRemainingFrac: 0,
            },
            "HIT_TP",
            now,
            openedAt,
            scaleEnabled
              ? `Price ${price} reached TP${nextHits} ${nextTp}; scale-out complete.`
              : `Price ${price} reached TP1 ${nextTp}.`,
          );
        }
        // Partial: stay ACTIVE with updated scale state.
        return {
          ...mergeDirectional(previous, candidate, openedAt, taggedTargets),
          lifecycle: previous.lifecycle === "CONFIRMED" ? "ACTIVE" : previous.lifecycle,
          lifecycleUpdatedAt: now,
          setupOpenedAt: openedAt,
          tpHits: nextHits,
          scaleRemainingFrac: nextRemaining,
          lifecycleNote: `SCALE_TP${nextHits}:${frac}|Price ${price} filled TP${nextHits} ${nextTp}; remaining ${(nextRemaining * 100).toFixed(0)}%.`,
        };
      }
    }
  }

  // Opposing CHoCH while active/confirmed.
  if (
    (previous.lifecycle === "CONFIRMED" || previous.lifecycle === "ACTIVE") &&
    hasOpposingChoch(candidate, side)
  ) {
    return withLifecycle(
      mergeDirectional(previous, candidate, openedAt, taggedTargets),
      "INVALIDATED",
      now,
      openedAt,
      "Opposing CHoCH invalidated the setup.",
    );
  }

  if (age > config.activeMaxAgeMs) {
    return withLifecycle(
      mergeDirectional(previous, candidate, openedAt, taggedTargets),
      "TIMEOUT",
      now,
      openedAt,
      "Active setup exceeded max age without TP/SL.",
    );
  }

  // Duplicate suppression: first tick CONFIRMED, later ticks ACTIVE (same setupId).
  if (previous.lifecycle === "CONFIRMED" || previous.lifecycle === "ACTIVE") {
    const note =
      structureHitNote ??
      (previous.lifecycle === "CONFIRMED"
        ? "Setup remains valid; monitoring TP/SL."
        : previous.lifecycleNote);
    return withLifecycle(
      mergeDirectional(previous, candidate, openedAt, taggedTargets),
      "ACTIVE",
      previous.lifecycle === "ACTIVE" ? previous.lifecycleUpdatedAt : now,
      openedAt,
      note,
    );
  }

  // PENDING/WATCHING → first directional print
  return withLifecycle(mergeDirectional(previous, candidate, now), "CONFIRMED", now, now);
}

function mergeDirectional(
  previous: TradingSignal,
  candidate: TradingSignal,
  openedAt: number,
  structureTargets?: TradingSignal["structureTargets"],
): TradingSignal {
  return {
    ...candidate,
    id: previous.setupId,
    setupId: previous.setupId,
    setupOpenedAt: openedAt,
    // Keep original entry/stop from first confirmation unless candidate improves them.
    entry: previous.entry ?? candidate.entry,
    stopLoss: previous.stopLoss ?? candidate.stopLoss,
    takeProfit: previous.takeProfit ?? candidate.takeProfit,
    riskReward: previous.riskReward ?? candidate.riskReward,
    structureTargets:
      structureTargets ?? previous.structureTargets ?? candidate.structureTargets,
    // Phase 12 scale-out state must survive ACTIVE ticks that rebuild from candidate.
    tpHits: previous.tpHits,
    scaleRemainingFrac: previous.scaleRemainingFrac,
  };
}

function shortKind(kind: string): string {
  switch (kind) {
    case "measured_move":
      return "MM";
    case "prior_swing":
      return "swing";
    case "session_extreme":
      return "session";
    case "vp_node":
      return "VP";
    default:
      return kind;
  }
}

function pickLiveFields(candidate: TradingSignal): Partial<TradingSignal> {
  return {
    confidence: candidate.confidence,
    confirmations: candidate.confirmations,
    reasonsFor: candidate.reasonsFor,
    reasonsAgainst: candidate.reasonsAgainst,
    invalidation: candidate.invalidation,
    orderFlowOk: candidate.orderFlowOk,
    structureOk: candidate.structureOk,
    volumeOk: candidate.volumeOk,
    deltaOk: candidate.deltaOk,
    score: candidate.score,
    evidence: candidate.evidence,
    entryGrade: candidate.entryGrade,
    entryQualityNotes: candidate.entryQualityNotes,
  };
}

function hasOpposingChoch(signal: TradingSignal, side: "LONG" | "SHORT"): boolean {
  // Only live reasonsAgainst — not the static invalidation template that mentions CHoCH.
  const hits = signal.reasonsAgainst
    .map((line) => line.toLowerCase())
    .filter((line) => line.includes("choch"));
  if (hits.length === 0) return false;
  const text = hits.join(" ");
  if (side === "LONG" && (text.includes("bearish") || text.includes("(bear"))) return true;
  if (side === "SHORT" && (text.includes("bullish") || text.includes("(bull"))) return true;
  return false;
}

function invalidateReason(previous: TradingSignal, candidate: TradingSignal): string {
  if (hasOpposingChoch(candidate, previous.direction === "SHORT" ? "SHORT" : "LONG")) {
    return "Opposing CHoCH invalidated the setup.";
  }
  return "Confirmations dropped below gate; setup invalidated.";
}

function withLifecycle(
  signal: TradingSignal,
  lifecycle: SignalLifecycle,
  at: number,
  openedAt: number,
  note?: string,
): TradingSignal {
  return {
    ...signal,
    lifecycle,
    lifecycleUpdatedAt: at,
    setupOpenedAt: openedAt,
    lifecycleNote: note,
  };
}

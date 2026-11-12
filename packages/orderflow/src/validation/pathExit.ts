/**
 * Same-bar / path exit resolution for validation & historical replay.
 * Policy is explicit and conservative — does not change live tick lifecycle.
 */

export type SameBarPolicy = "sl_first" | "tp_first" | "skip_ambiguous";

export interface PathBar {
  open: number;
  high: number;
  low: number;
  close: number;
  openTime: number;
  closeTime: number;
}

export interface PathExitResult {
  hit: "HIT_TP" | "HIT_SL" | "NONE";
  exitPrice: number | null;
  ambiguousSameBar: boolean;
  note: string;
}

/**
 * Resolve TP1 / SL against an OHLC bar.
 * If both stop and TP1 are touched in the same bar, apply `policy`
 * (default SL-first — conservative for long validation).
 */
export function resolvePathExit(args: {
  side: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  bar: PathBar;
  policy?: SameBarPolicy;
}): PathExitResult {
  const policy = args.policy ?? "sl_first";
  const { side, stopLoss, takeProfit1, bar } = args;

  let stopHit = false;
  let tpHit = false;
  if (side === "LONG") {
    stopHit = bar.low <= stopLoss;
    tpHit = bar.high >= takeProfit1;
  } else {
    stopHit = bar.high >= stopLoss;
    tpHit = bar.low <= takeProfit1;
  }

  if (stopHit && tpHit) {
    if (policy === "skip_ambiguous") {
      return {
        hit: "NONE",
        exitPrice: null,
        ambiguousSameBar: true,
        note: "Same-bar TP and SL both touched — skipped under skip_ambiguous policy.",
      };
    }
    if (policy === "tp_first") {
      return {
        hit: "HIT_TP",
        exitPrice: takeProfit1,
        ambiguousSameBar: true,
        note: "Same-bar TP+SL — tp_first policy.",
      };
    }
    return {
      hit: "HIT_SL",
      exitPrice: stopLoss,
      ambiguousSameBar: true,
      note: "Same-bar TP+SL — sl_first (conservative) policy.",
    };
  }
  if (stopHit) {
    return {
      hit: "HIT_SL",
      exitPrice: stopLoss,
      ambiguousSameBar: false,
      note: "Stop touched intra-bar.",
    };
  }
  if (tpHit) {
    return {
      hit: "HIT_TP",
      exitPrice: takeProfit1,
      ambiguousSameBar: false,
      note: "TP1 touched intra-bar.",
    };
  }
  return {
    hit: "NONE",
    exitPrice: null,
    ambiguousSameBar: false,
    note: "Neither TP1 nor SL touched.",
  };
}

/**
 * Partial TP policy for metrics (Phase 12):
 * - Tick lifecycle scale-out (default): 50% TP1 / 30% TP2 / 20% TP3; stay ACTIVE until remainder 0.
 * - `fullCloseAtTp1: true` restores legacy 100% close at TP1.
 * - Bar `resolvePathExit` remains TP1-only (same-bar validation path unchanged).
 */
export const PARTIAL_TP_POLICY =
  "Tick lifecycle scale-out default 50/30/20 at TP1/TP2/TP3 (HIT_TP when remainder 0). Set scaleOut.fullCloseAtTp1 for legacy 100% TP1 close. Bar pathExit remains TP1-only.";

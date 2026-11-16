import type {
  AuctionShadowSnapshot,
  BreakRetestState,
  CvdState,
  EvidenceTag,
  FootprintBar,
  VolumeProfile,
} from "@of/shared";

export interface AuctionShadowConfig {
  /** Max |price-POC|/price to treat as near POC while inside value. */
  nearPocPct: number;
  /** Treat price as near an LVN within this relative distance. */
  lvnProximityPct: number;
  /** |bar delta| / volume above this counts as aggression. */
  aggressionDeltaRatio: number;
  /** Minimum stacked imbalance count for aggression side. */
  minStackedImbalances: number;
}

export const DEFAULT_AUCTION_SHADOW_CONFIG: AuctionShadowConfig = {
  nearPocPct: 0.0025,
  lvnProximityPct: 0.0015,
  aggressionDeltaRatio: 0.15,
  minStackedImbalances: 2,
};

export interface AuctionShadowInput {
  symbol: string;
  lastPrice: number;
  volumeProfile?: VolumeProfile | null;
  footprint?: FootprintBar | null;
  cvd?: CvdState | null;
  breakRetest?: BreakRetestState | null;
}

const EVIDENCE: EvidenceTag = {
  kind: "heuristic",
  note: "R4 auction shadow is observational only — never mutates generateSignal scores, gates, or A+.",
};

/**
 * Fabio-style AMT/VP/OF shadow features for paper observability.
 * Deterministic heuristics — not a trade signal and not institutional identity.
 */
export function computeAuctionShadow(
  input: AuctionShadowInput,
  config: AuctionShadowConfig = DEFAULT_AUCTION_SHADOW_CONFIG,
): AuctionShadowSnapshot {
  const notes: string[] = [];
  const vp = input.volumeProfile;
  const price = input.lastPrice;

  let priceVsValue: AuctionShadowSnapshot["priceVsValue"] = "unknown";
  let state: AuctionShadowSnapshot["state"] = "UNKNOWN";
  let poc: number | null = null;
  let vah: number | null = null;
  let val: number | null = null;

  if (vp && vp.totalVolume > 0 && vp.vah > 0 && vp.val > 0 && price > 0) {
    poc = vp.poc;
    vah = vp.vah;
    val = vp.val;
    if (price > vp.vah) priceVsValue = "above_vah";
    else if (price < vp.val) priceVsValue = "below_val";
    else priceVsValue = "inside";

    if (priceVsValue === "inside") {
      state = "BALANCE";
      notes.push("Price inside session value area — shadow balance.");
    } else {
      state = "IMBALANCE";
      notes.push(`Price ${priceVsValue.replace("_", " ")} — shadow imbalance.`);
    }
  } else {
    notes.push("Volume profile not ready — auction state UNKNOWN.");
  }

  let nearestLvn: number | null = null;
  let nearestLvnDistPct: number | null = null;
  let nearLvn = false;
  if (vp && vp.lvn.length > 0 && price > 0) {
    let best = vp.lvn[0]!;
    let bestDist = Math.abs(price - best) / price;
    for (const level of vp.lvn) {
      const d = Math.abs(price - level) / price;
      if (d < bestDist) {
        best = level;
        bestDist = d;
      }
    }
    nearestLvn = best;
    nearestLvnDistPct = bestDist;
    nearLvn = bestDist <= config.lvnProximityPct;
    if (nearLvn) notes.push(`Near LVN ${best} (dist ${(bestDist * 100).toFixed(3)}%).`);
  }

  const { aggressionSide, aggressionScore } = scoreAggression(input.footprint, config);
  if (aggressionSide !== "none") {
    notes.push(`Footprint aggression lean ${aggressionSide} (score ${aggressionScore.toFixed(2)}).`);
  }

  const followThrough = scoreFollowThrough(input.footprint, input.cvd, aggressionSide);
  if (followThrough === "absorbing") {
    notes.push("Absorption / weak follow-through heuristic active.");
  } else if (followThrough === "supportive") {
    notes.push("Delta/CVD roughly supportive of aggression side.");
  }

  const failedAuction = detectFailedAuction(input.breakRetest, priceVsValue);
  if (failedAuction !== "none") {
    notes.push(`Failed-auction shadow: ${failedAuction}.`);
  }

  let modelMode: AuctionShadowSnapshot["modelMode"] = "OFF";
  if (state === "IMBALANCE" && aggressionSide !== "none" && followThrough !== "absorbing") {
    modelMode = "TREND_CONTINUATION";
    notes.push("Shadow mode TREND_CONTINUATION (observational).");
  } else if (
    (state === "BALANCE" || failedAuction !== "none") &&
    (failedAuction !== "none" || input.breakRetest?.phase === "failed")
  ) {
    modelMode = "MEAN_REVERSION";
    notes.push("Shadow mode MEAN_REVERSION (observational).");
  } else if (state === "BALANCE") {
    notes.push("In balance without failed-auction reclaim — shadow mode OFF.");
  }

  // near-POC note for MR targets
  if (poc != null && price > 0) {
    const pocDist = Math.abs(price - poc) / price;
    if (pocDist <= config.nearPocPct) {
      notes.push("Price near POC magnet.");
    }
  }

  return {
    state,
    modelMode,
    poc,
    vah,
    val,
    priceVsValue,
    nearestLvn,
    nearestLvnDistPct,
    nearLvn,
    aggressionSide,
    aggressionScore,
    followThrough,
    failedAuction,
    notes,
    evidence: [EVIDENCE],
    mutatesScores: false,
  };
}

function scoreAggression(
  footprint: FootprintBar | null | undefined,
  config: AuctionShadowConfig,
): { aggressionSide: AuctionShadowSnapshot["aggressionSide"]; aggressionScore: number } {
  if (!footprint || footprint.totalVolume <= 0) {
    return { aggressionSide: "none", aggressionScore: 0 };
  }
  const stackedAsk = footprint.imbalances.filter((i) => i.side === "ask" && i.stacked).length;
  const stackedBid = footprint.imbalances.filter((i) => i.side === "bid" && i.stacked).length;
  const deltaRatio = Math.abs(footprint.totalDelta) / Math.max(footprint.totalVolume, 1e-12);

  let side: AuctionShadowSnapshot["aggressionSide"] = "none";
  if (stackedAsk >= config.minStackedImbalances && stackedAsk > stackedBid) side = "buy";
  else if (stackedBid >= config.minStackedImbalances && stackedBid > stackedAsk) side = "sell";
  else if (deltaRatio >= config.aggressionDeltaRatio) {
    side = footprint.totalDelta > 0 ? "buy" : footprint.totalDelta < 0 ? "sell" : "none";
  }

  const stackScore = Math.min(1, Math.max(stackedAsk, stackedBid) / 4);
  const score = Math.min(1, 0.55 * Math.min(1, deltaRatio / 0.35) + 0.45 * stackScore);
  if (side === "none") return { aggressionSide: "none", aggressionScore: 0 };
  return { aggressionSide: side, aggressionScore: Number(score.toFixed(3)) };
}

function scoreFollowThrough(
  footprint: FootprintBar | null | undefined,
  cvd: CvdState | null | undefined,
  aggressionSide: AuctionShadowSnapshot["aggressionSide"],
): AuctionShadowSnapshot["followThrough"] {
  if (!footprint || aggressionSide === "none") return "unknown";
  if (footprint.absorption) return "absorbing";

  const deltaSupports =
    (aggressionSide === "buy" && footprint.totalDelta > 0) ||
    (aggressionSide === "sell" && footprint.totalDelta < 0);

  let cvdSupports = true;
  if (cvd && cvd.points.length >= 8) {
    const recent = cvd.points.slice(-8);
    const slope = recent[recent.length - 1]!.cvd - recent[0]!.cvd;
    cvdSupports =
      (aggressionSide === "buy" && slope >= 0) || (aggressionSide === "sell" && slope <= 0);
    if (cvd.exhaustion) return "absorbing";
  }

  if (deltaSupports && cvdSupports) return "supportive";
  if (!deltaSupports) return "absorbing";
  return "unknown";
}

function detectFailedAuction(
  breakRetest: BreakRetestState | null | undefined,
  priceVsValue: AuctionShadowSnapshot["priceVsValue"],
): AuctionShadowSnapshot["failedAuction"] {
  if (breakRetest?.phase === "failed" || breakRetest?.phase === "invalidated") {
    if (breakRetest.side === "bullish") return "failed_high";
    if (breakRetest.side === "bearish") return "failed_low";
  }
  // Soft hint only when reclaim context is missing — keep conservative.
  if (priceVsValue === "above_vah" && breakRetest?.phase === "retesting") return "none";
  return "none";
}

/** Compact one-line label for UI / commentary. */
export function formatAuctionShadowSummary(shadow: AuctionShadowSnapshot): string {
  return `Auction shadow: ${shadow.state} · mode ${shadow.modelMode} · ${shadow.priceVsValue} · aggr ${shadow.aggressionSide}/${shadow.aggressionScore.toFixed(2)} · FT ${shadow.followThrough} (observational, no score mutation)`;
}

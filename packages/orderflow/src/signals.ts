import { createHash } from "node:crypto";
import type {
  BreakRetestState,
  ChartOverlayState,
  CvdState,
  DomMetrics,
  EvidenceTag,
  FootprintBar,
  MarketStructureState,
  MultiTimeframeContext,
  SignalFactor,
  SignalFactorFamily,
  SignalScoreBreakdown,
  StructureZonesState,
  TradingSignal,
  VolumeProfile,
} from "@of/shared";
import { priceInZone } from "./priceZones.js";
import { applyConfirmationPacks } from "./strategyPlugins.js";
import { buildStructureTargets } from "./structureTargets.js";

export interface SignalInput {
  symbol: string;
  lastPrice: number;
  timestamp: number;
  footprint?: FootprintBar | null;
  cvd?: CvdState | null;
  dom?: DomMetrics | null;
  volumeProfile?: VolumeProfile | null;
  structure?: MarketStructureState | null;
  /** Phase 4 multi-timeframe structure context. */
  mtf?: MultiTimeframeContext | null;
  /** Phase 6 OB / FVG / sweep zones. */
  zones?: StructureZonesState | null;
  /** Phase A chart overlay (optional context). */
  chartOverlay?: ChartOverlayState | null;
  /** Phase B breakout + retest playbook. */
  breakRetest?: BreakRetestState | null;
}

/** Configurable signal weights. Phase-6 adds OB/FVG/sweep heuristics. */
export interface SignalEngineConfig {
  weights: {
    structureTrend: number;
    structureBos: number;
    structureChochAlign: number;
    mtfHigherAlign: number;
    mtfSoftAlign: number;
    orderBlock: number;
    fairValueGap: number;
    liquiditySweep: number;
    cvdDivergence: number;
    cvdAligned: number;
    stackedImbalance: number;
    barDelta: number;
    domImbalance: number;
    volumeProfileExtreme: number;
    lvnContinuation: number;
    /** Phase B: accepted break + retest location weight. */
    breakRetestAccept: number;
  };
  /** Relative distance to treat price as "near" POC/HVN/LVN. */
  levelProximityPct: number;
  /** Phase 3: DOM L2 pressure only scores when trade delta supports the same side. */
  domRequiresTradeDelta: boolean;
  /** Minimum directional higher-TF frames (1d/4h/1h) needed to score MTF align. */
  mtfMinHigherAgree: number;
  /** Max age (ms) for a sweep to count as recent confirmation. */
  sweepMaxAgeMs: number;
  /**
   * Entry selectivity profile.
   * - standard: legacy ≥2 independent families + score gates
   * - a_plus: also requires HTF permission, real OF trigger, location, no conflict
   * A+ is selectivity — not a promise of 100% win rate.
   */
  entryQuality: "standard" | "a_plus";
  minIndependent: number;
  minScore: number;
  minLead: number;
  confidenceDivisor: number;
  multiConfirmBonus: number;
  waitConfidenceCap: number;
  /**
   * Phase 11: merge registered strategy packs as weight-0 neutrals.
   * Default false — does not change confirmation gates or A+.
   */
  enableStrategyPlugins?: boolean;
  /** Require footprint + volume profile before LONG/SHORT. */
  requireDataReady: boolean;
  /** Minimum VP totalVolume for data readiness. */
  minVpTotalVolume: number;
  /** Veto direction when opposing iceberg/refill is near entry. */
  icebergVetoEnabled: boolean;
  icebergVetoMinConfidence: number;
  icebergVetoProximityPct: number;
  /** Reject entries within this pct of a recent swing high (LONG) / low (SHORT). */
  swingProximityPct: number;
  /** Require nearest opposing S/R at least this many R from entry. */
  minRoomToRunR: number;
  /** Buffer beyond protective swing/S/R when placing structure stop. */
  stopBufferPct: number;
  /** Minimum reward/risk using TP1 at first opposing structure level. */
  minStructuralRR: number;
}

export const DEFAULT_SIGNAL_CONFIG: SignalEngineConfig = {
  weights: {
    structureTrend: 1,
    structureBos: 0.75,
    structureChochAlign: 0.5,
    mtfHigherAlign: 0.75,
    mtfSoftAlign: 0.25,
    orderBlock: 0.5,
    fairValueGap: 0.5,
    liquiditySweep: 0.5,
    cvdDivergence: 1,
    cvdAligned: 0.5,
    stackedImbalance: 1,
    barDelta: 0.5,
    domImbalance: 0.5,
    volumeProfileExtreme: 0.5,
    lvnContinuation: 0.5,
    breakRetestAccept: 0.85,
  },
  levelProximityPct: 0.0015,
  domRequiresTradeDelta: true,
  mtfMinHigherAgree: 2,
  sweepMaxAgeMs: 4 * 60 * 60_000,
  entryQuality: "a_plus",
  minIndependent: 2,
  minScore: 2,
  minLead: 1,
  confidenceDivisor: 5,
  multiConfirmBonus: 0.15,
  waitConfidenceCap: 0.35,
  enableStrategyPlugins: false,
  requireDataReady: true,
  minVpTotalVolume: 1,
  icebergVetoEnabled: true,
  icebergVetoMinConfidence: 0.4,
  icebergVetoProximityPct: 0.0015,
  swingProximityPct: 0.001,
  minRoomToRunR: 1.5,
  stopBufferPct: 0.001,
  minStructuralRR: 1.5,
};

/** Legacy multi-confirm gates only (used by tests / opt-out). */
export const STANDARD_SIGNAL_CONFIG: SignalEngineConfig = {
  ...DEFAULT_SIGNAL_CONFIG,
  entryQuality: "standard",
};

const MODEL_NOTE =
  "Scores use configurable rule weights (A+ entry profile when enabled: HTF permission + OF trigger + location; BOS/CHoCH/VP/zones/break-retest; DOM needs trade-delta). Confidence is a model score, not a calibrated win probability. A+ ≠ 100% accuracy.";

/**
 * Rule-based multi-confirmation signal engine.
 * Requires at least two independent confirmations or returns WAIT.
 */
export function generateSignal(
  input: SignalInput,
  config: SignalEngineConfig = DEFAULT_SIGNAL_CONFIG,
): TradingSignal {
  const reasonsFor: string[] = [];
  const reasonsAgainst: string[] = [];
  const confirmations: string[] = [];
  const factors: SignalFactor[] = [];
  const evidence: EvidenceTag[] = [];
  let longScore = 0;
  let shortScore = 0;
  let neutralScore = 0;

  const { footprint, cvd, dom, volumeProfile, structure, mtf, zones, breakRetest, lastPrice } =
    input;
  const w = config.weights;

  const addLong = (factor: Omit<SignalFactor, "side">) => {
    longScore += factor.weight;
    factors.push({ ...factor, side: "long" });
    confirmations.push(factor.id);
    reasonsFor.push(factor.reason);
  };
  const addShort = (factor: Omit<SignalFactor, "side">) => {
    shortScore += factor.weight;
    factors.push({ ...factor, side: "short" });
    confirmations.push(factor.id);
    reasonsFor.push(factor.reason);
  };
  const addNeutral = (factor: Omit<SignalFactor, "side" | "weight"> & { weight?: number }) => {
    const weight = factor.weight ?? 0;
    neutralScore += weight;
    factors.push({ ...factor, side: "neutral", weight });
    reasonsAgainst.push(factor.reason);
  };

  // Structure
  let structureOk = false;
  if (structure) {
    evidence.push({
      kind: "inferred",
      note: "Market structure (swings/BOS/CHoCH) is derived from candle swings, not exchange-labeled.",
    });
    if (structure.trend === "bullish") {
      addLong({
        id: "structure_bullish",
        family: "structure",
        weight: w.structureTrend,
        source: "derived",
        reason: "Market structure trend is bullish (HH/HL bias).",
      });
      structureOk = true;
    } else if (structure.trend === "bearish") {
      addShort({
        id: "structure_bearish",
        family: "structure",
        weight: w.structureTrend,
        source: "derived",
        reason: "Market structure trend is bearish (LH/LL bias).",
      });
      structureOk = true;
    } else {
      addNeutral({
        id: "structure_range",
        family: "structure",
        source: "derived",
        reason: "Structure is ranging / unclear.",
      });
    }
    if (structure.lastBos?.direction === "bullish" && structure.trend !== "bearish") {
      addLong({
        id: "structure_bos_bullish",
        family: "structure",
        weight: w.structureBos,
        source: "derived",
        reason: `Bullish BOS @ ${structure.lastBos.price} supports continuation.`,
      });
      structureOk = true;
    } else if (structure.lastBos?.direction === "bearish" && structure.trend !== "bullish") {
      addShort({
        id: "structure_bos_bearish",
        family: "structure",
        weight: w.structureBos,
        source: "derived",
        reason: `Bearish BOS @ ${structure.lastBos.price} supports continuation.`,
      });
      structureOk = true;
    }
    if (structure.lastChoch) {
      if (structure.lastChoch.direction === "bullish" && structure.trend === "bullish") {
        addLong({
          id: "structure_choch_bullish",
          family: "structure",
          weight: w.structureChochAlign,
          source: "derived",
          reason: `Bullish CHoCH @ ${structure.lastChoch.price} aligns with bullish structure.`,
        });
        structureOk = true;
      } else if (structure.lastChoch.direction === "bearish" && structure.trend === "bearish") {
        addShort({
          id: "structure_choch_bearish",
          family: "structure",
          weight: w.structureChochAlign,
          source: "derived",
          reason: `Bearish CHoCH @ ${structure.lastChoch.price} aligns with bearish structure.`,
        });
        structureOk = true;
      } else {
        addNeutral({
          id: "structure_choch_warning",
          family: "structure",
          source: "derived",
          reason: `Recent CHoCH (${structure.lastChoch.direction}) warns against chasing prior trend.`,
        });
      }
    }
  } else {
    addNeutral({
      id: "structure_missing",
      family: "structure",
      source: "derived",
      reason: "No market structure input.",
    });
  }

  // Multi-timeframe structure (Phase 4)
  if (mtf && mtf.frames.length > 0) {
    evidence.push({
      kind: "inferred",
      note: "Multi-timeframe trends are derived from per-interval candle swings (1d/4h/1h/15m/5m/1m), not exchange-labeled bias.",
    });
    const softInterval =
      mtf.primaryInterval === "5m" ? "1m" : mtf.primaryInterval === "15m" ? "5m" : "5m";
    const midInterval = mtf.primaryInterval === "5m" ? "15m" : undefined;
    const soft = mtf.frames.find((f) => f.interval === softInterval);
    const mid = midInterval ? mtf.frames.find((f) => f.interval === midInterval) : undefined;
    const primaryTrend =
      mtf.frames.find((f) => f.interval === mtf.primaryInterval)?.trend ?? structure?.trend;

    if (
      mtf.higherTfBullish >= config.mtfMinHigherAgree &&
      mtf.higherTfBullish > mtf.higherTfBearish
    ) {
      addLong({
        id: "mtf_htf_bullish",
        family: "structure",
        weight: w.mtfHigherAlign,
        source: "derived",
        reason: `Higher TFs lean bullish (${mtf.higherTfBullish}/${mtf.higherTfBullish + mtf.higherTfBearish + mtf.higherTfRange} of 1d/4h/1h).`,
      });
      structureOk = true;
    } else if (
      mtf.higherTfBearish >= config.mtfMinHigherAgree &&
      mtf.higherTfBearish > mtf.higherTfBullish
    ) {
      addShort({
        id: "mtf_htf_bearish",
        family: "structure",
        weight: w.mtfHigherAlign,
        source: "derived",
        reason: `Higher TFs lean bearish (${mtf.higherTfBearish}/${mtf.higherTfBullish + mtf.higherTfBearish + mtf.higherTfRange} of 1d/4h/1h).`,
      });
      structureOk = true;
    }

    if (soft?.trend === "bullish" && (primaryTrend === "bullish" || mtf.higherTfBullish > mtf.higherTfBearish)) {
      addLong({
        id: "mtf_ltf_bullish",
        family: "structure",
        weight: w.mtfSoftAlign,
        source: "derived",
        reason: `${softInterval} structure soft-confirms bullish bias.`,
      });
    } else if (
      soft?.trend === "bearish" &&
      (primaryTrend === "bearish" || mtf.higherTfBearish > mtf.higherTfBullish)
    ) {
      addShort({
        id: "mtf_ltf_bearish",
        family: "structure",
        weight: w.mtfSoftAlign,
        source: "derived",
        reason: `${softInterval} structure soft-confirms bearish bias.`,
      });
    }

    if (mid?.trend === "bullish" && (primaryTrend === "bullish" || mtf.higherTfBullish > mtf.higherTfBearish)) {
      addLong({
        id: "mtf_mid_bullish",
        family: "structure",
        weight: w.mtfSoftAlign,
        source: "derived",
        reason: `${midInterval} mid-TF soft-confirms bullish bias.`,
      });
    } else if (
      mid?.trend === "bearish" &&
      (primaryTrend === "bearish" || mtf.higherTfBearish > mtf.higherTfBullish)
    ) {
      addShort({
        id: "mtf_mid_bearish",
        family: "structure",
        weight: w.mtfSoftAlign,
        source: "derived",
        reason: `${midInterval} mid-TF soft-confirms bearish bias.`,
      });
    }

    if (mtf.conflictWithPrimary) {
      addNeutral({
        id: "mtf_htf_conflict",
        family: "structure",
        source: "derived",
        reason: `Higher TFs conflict with ${mtf.primaryInterval} primary trend (${primaryTrend ?? "unknown"}).`,
      });
    }
  }

  // Phase 6: OB / FVG / liquidity sweeps (explicit OHLC heuristics)
  if (zones) {
    evidence.push({
      kind: "inferred",
      note: "OB/FVG/sweep factors use documented candle rules only — not institutional identity.",
    });

    const activeBullOb = zones.orderBlocks.find(
      (b) => b.direction === "bullish" && !b.invalidated && priceInZone(lastPrice, b.low, b.high),
    );
    const activeBearOb = zones.orderBlocks.find(
      (b) => b.direction === "bearish" && !b.invalidated && priceInZone(lastPrice, b.low, b.high),
    );
    if (activeBullOb) {
      addLong({
        id: "ob_bullish_zone",
        family: "structure",
        weight: w.orderBlock,
        source: "heuristic",
        reason: `Price inside bullish OB [${activeBullOb.low}, ${activeBullOb.high}] (${activeBullOb.definition})`,
      });
      structureOk = true;
    } else if (activeBearOb) {
      addShort({
        id: "ob_bearish_zone",
        family: "structure",
        weight: w.orderBlock,
        source: "heuristic",
        reason: `Price inside bearish OB [${activeBearOb.low}, ${activeBearOb.high}] (${activeBearOb.definition})`,
      });
      structureOk = true;
    }

    const activeBullFvg = zones.fairValueGaps.find(
      (g) => g.direction === "bullish" && !g.mitigated && priceInZone(lastPrice, g.low, g.high),
    );
    const activeBearFvg = zones.fairValueGaps.find(
      (g) => g.direction === "bearish" && !g.mitigated && priceInZone(lastPrice, g.low, g.high),
    );
    if (activeBullFvg) {
      addLong({
        id: "fvg_bullish_zone",
        family: "structure",
        weight: w.fairValueGap,
        source: "heuristic",
        reason: `Price inside bullish FVG [${activeBullFvg.low}, ${activeBullFvg.high}] (${activeBullFvg.definition})`,
      });
      structureOk = true;
    } else if (activeBearFvg) {
      addShort({
        id: "fvg_bearish_zone",
        family: "structure",
        weight: w.fairValueGap,
        source: "heuristic",
        reason: `Price inside bearish FVG [${activeBearFvg.low}, ${activeBearFvg.high}] (${activeBearFvg.definition})`,
      });
      structureOk = true;
    }

    const recentSweep = zones.recentSweeps
      .filter((s) => input.timestamp - s.timestamp <= config.sweepMaxAgeMs)
      .at(-1);
    if (recentSweep?.bias === "bullish") {
      addLong({
        id: "sweep_ssl_reclaim",
        family: "structure",
        weight: w.liquiditySweep,
        source: "heuristic",
        reason: `Recent SSL sweep/reclaim @ ${recentSweep.level} (${recentSweep.definition})`,
      });
      structureOk = true;
    } else if (recentSweep?.bias === "bearish") {
      addShort({
        id: "sweep_bsl_reclaim",
        family: "structure",
        weight: w.liquiditySweep,
        source: "heuristic",
        reason: `Recent BSL sweep/reclaim @ ${recentSweep.level} (${recentSweep.definition})`,
      });
      structureOk = true;
    }
  }

  // Delta / CVD
  let deltaOk = false;
  if (cvd) {
    evidence.push({
      kind: "inferred",
      note: "CVD and divergence are derived from aggressor-signed trades; divergence is a heuristic.",
    });
    if (cvd.divergence === "bullish") {
      addLong({
        id: "cvd_bullish_divergence",
        family: "delta",
        weight: w.cvdDivergence,
        source: "heuristic",
        reason: "CVD bullish divergence vs price.",
      });
      deltaOk = true;
    } else if (cvd.divergence === "bearish") {
      addShort({
        id: "cvd_bearish_divergence",
        family: "delta",
        weight: w.cvdDivergence,
        source: "heuristic",
        reason: "CVD bearish divergence vs price.",
      });
      deltaOk = true;
    }
    if (cvd.cvd > 0 && structure?.trend === "bullish") {
      addLong({
        id: "cvd_positive",
        family: "delta",
        weight: w.cvdAligned,
        source: "derived",
        reason: "Session CVD is positive while structure is bullish.",
      });
      // Soft score only — session CVD sign does not set deltaOk / unlock A+ OF.
    }
    if (cvd.cvd < 0 && structure?.trend === "bearish") {
      addShort({
        id: "cvd_negative",
        family: "delta",
        weight: w.cvdAligned,
        source: "derived",
        reason: "Session CVD is negative while structure is bearish.",
      });
      // Soft score only — session CVD sign does not set deltaOk / unlock A+ OF.
    }
    if (cvd.exhaustion) {
      addNeutral({
        id: "cvd_exhaustion",
        family: "delta",
        source: "heuristic",
        reason: "Delta exhaustion heuristic active.",
      });
    }
  } else {
    addNeutral({
      id: "cvd_missing",
      family: "delta",
      source: "derived",
      reason: "No CVD input.",
    });
  }

  // Order flow / footprint
  let orderFlowOk = false;
  if (footprint) {
    evidence.push({
      kind: "inferred",
      note: "Footprint cells use exchange aggressor flags when present; absorption/exhaustion are heuristics.",
    });
    const askImbalances = footprint.imbalances.filter((i) => i.side === "ask" && i.stacked);
    const bidImbalances = footprint.imbalances.filter((i) => i.side === "bid" && i.stacked);
    if (askImbalances.length > 0) {
      addLong({
        id: "stacked_ask_imbalance",
        family: "orderflow",
        weight: w.stackedImbalance,
        source: "derived",
        reason: "Stacked ask (buy aggression) imbalances on footprint.",
      });
      orderFlowOk = true;
    }
    if (bidImbalances.length > 0) {
      addShort({
        id: "stacked_bid_imbalance",
        family: "orderflow",
        weight: w.stackedImbalance,
        source: "derived",
        reason: "Stacked bid (sell aggression) imbalances on footprint.",
      });
      orderFlowOk = true;
    }
    if (footprint.absorption) {
      addNeutral({
        id: "footprint_absorption",
        family: "orderflow",
        source: "heuristic",
        reason: "Absorption heuristic — aggression may not move price cleanly.",
      });
    }
    if (footprint.totalDelta > 0 && longScore >= shortScore) {
      addLong({
        id: "bar_delta_positive",
        family: "orderflow",
        weight: w.barDelta,
        source: "derived",
        reason: "Footprint bar delta is positive with non-bearish score lead.",
      });
      orderFlowOk = true;
    }
    if (footprint.totalDelta < 0 && shortScore >= longScore) {
      addShort({
        id: "bar_delta_negative",
        family: "orderflow",
        weight: w.barDelta,
        source: "derived",
        reason: "Footprint bar delta is negative with non-bullish score lead.",
      });
      orderFlowOk = true;
    }
  } else {
    addNeutral({
      id: "footprint_missing",
      family: "orderflow",
      source: "derived",
      reason: "No footprint bar yet.",
    });
  }

  // Trade-delta support used to gate DOM (Phase 3).
  const tradeDeltaLong =
    (footprint != null && footprint.totalDelta > 0) ||
    (cvd != null && cvd.cvd > 0) ||
    (footprint?.imbalances.some((i) => i.side === "ask" && i.stacked) ?? false);
  const tradeDeltaShort =
    (footprint != null && footprint.totalDelta < 0) ||
    (cvd != null && cvd.cvd < 0) ||
    (footprint?.imbalances.some((i) => i.side === "bid" && i.stacked) ?? false);

  // DOM pressure
  if (dom) {
    evidence.push({
      kind: "exchange_reported",
      note: "DOM imbalance uses visible L2 sizes from the exchange book; Phase 3 requires trade-delta support before DOM scores. Spoof risk is a heuristic.",
    });
    if (dom.imbalance > 0.25) {
      if (!config.domRequiresTradeDelta || tradeDeltaLong) {
        addLong({
          id: "dom_bid_pressure",
          family: "orderflow",
          weight: w.domImbalance,
          source: "exchange_reported",
          reason: "Visible bid liquidity exceeds ask (L2 imbalance) with trade-delta support.",
        });
        orderFlowOk = true;
      } else {
        addNeutral({
          id: "dom_bid_unconfirmed",
          family: "orderflow",
          source: "exchange_reported",
          reason: "DOM bid pressure without trade-delta support — not counted toward gates.",
        });
      }
    } else if (dom.imbalance < -0.25) {
      if (!config.domRequiresTradeDelta || tradeDeltaShort) {
        addShort({
          id: "dom_ask_pressure",
          family: "orderflow",
          weight: w.domImbalance,
          source: "exchange_reported",
          reason: "Visible ask liquidity exceeds bid (L2 imbalance) with trade-delta support.",
        });
        orderFlowOk = true;
      } else {
        addNeutral({
          id: "dom_ask_unconfirmed",
          family: "orderflow",
          source: "exchange_reported",
          reason: "DOM ask pressure without trade-delta support — not counted toward gates.",
        });
      }
    }
    if (dom.spoofingRisk === "elevated") {
      addNeutral({
        id: "dom_spoof_risk",
        family: "orderflow",
        source: "heuristic",
        reason: "Elevated spoofing-risk heuristic on DOM — treat walls cautiously.",
      });
    }
    if (dom.iceberg && dom.iceberg.side !== "none" && dom.iceberg.confidence >= 0.4) {
      addNeutral({
        id: "dom_iceberg_refill",
        family: "orderflow",
        source: "heuristic",
        reason: dom.iceberg.note,
      });
      evidence.push({
        kind: "heuristic",
        note: "Iceberg/refill confidence is a heuristic band — not exchange iceberg tags.",
      });
    }
  }

  // Volume profile location + nodes
  let volumeOk = false;
  if (volumeProfile) {
    evidence.push({
      kind: "inferred",
      note: "Volume profile POC/VAH/VAL/HVN/LVN are derived from session trades, not exchange-published levels.",
    });
    if (lastPrice <= volumeProfile.val) {
      addLong({
        id: "price_at_val_discount",
        family: "volume",
        weight: w.volumeProfileExtreme,
        source: "derived",
        reason: "Price at/below value area low (discount vs session profile).",
      });
      volumeOk = true;
    } else if (lastPrice >= volumeProfile.vah) {
      addShort({
        id: "price_at_vah_premium",
        family: "volume",
        weight: w.volumeProfileExtreme,
        source: "derived",
        reason: "Price at/above value area high (premium vs session profile).",
      });
      volumeOk = true;
    } else {
      addNeutral({
        id: "price_inside_value",
        family: "volume",
        source: "derived",
        reason: "Price inside value area — mean-reversion edge weaker.",
      });
    }

    const near = (level: number) =>
      lastPrice > 0 && Math.abs(lastPrice - level) / lastPrice <= config.levelProximityPct;

    if (near(volumeProfile.poc)) {
      addNeutral({
        id: "price_at_poc",
        family: "volume",
        source: "derived",
        reason: "Price at POC — expect balance until acceptance beyond the value area.",
      });
    }
    if ((volumeProfile.hvn ?? []).some((level) => near(level))) {
      addNeutral({
        id: "price_near_hvn",
        family: "volume",
        source: "derived",
        reason: "Price near HVN — high-volume balance node; breakout needs strong continuation.",
      });
    }
    if ((volumeProfile.lvn ?? []).some((level) => near(level))) {
      if (structure?.trend === "bullish") {
        addLong({
          id: "lvn_bullish_continuation",
          family: "volume",
          weight: w.lvnContinuation,
          source: "derived",
          reason: "Price near LVN with bullish structure — thin liquidity favors continuation if held.",
        });
        volumeOk = true;
      } else if (structure?.trend === "bearish") {
        addShort({
          id: "lvn_bearish_continuation",
          family: "volume",
          weight: w.lvnContinuation,
          source: "derived",
          reason: "Price near LVN with bearish structure — thin liquidity favors continuation if held.",
        });
        volumeOk = true;
      } else {
        addNeutral({
          id: "price_near_lvn",
          family: "volume",
          source: "derived",
          reason: "Price near LVN without clear structure — treat as unstable.",
        });
      }
    }
  } else {
    addNeutral({
      id: "volume_profile_missing",
      family: "volume",
      source: "derived",
      reason: "No volume profile input.",
    });
  }

  // Phase B: accepted break + retest is a location confirmation (not a solo entry).
  if (breakRetest) {
    evidence.push({
      kind: "inferred",
      note: "Break/retest factors are mechanical band+OF heuristics — not path forecasts.",
    });
    if (breakRetest.phase === "accepted" && breakRetest.side === "bullish") {
      addLong({
        id: "break_retest_bullish",
        family: "structure",
        weight: w.breakRetestAccept,
        source: "heuristic",
        reason:
          breakRetest.reason ||
          "Bullish range break + retest accepted with order-flow continuation.",
      });
      structureOk = true;
    } else if (breakRetest.phase === "accepted" && breakRetest.side === "bearish") {
      addShort({
        id: "break_retest_bearish",
        family: "structure",
        weight: w.breakRetestAccept,
        source: "heuristic",
        reason:
          breakRetest.reason ||
          "Bearish range break + retest accepted with order-flow continuation.",
      });
      structureOk = true;
    } else if (
      (breakRetest.phase === "failed" || breakRetest.phase === "invalidated") &&
      breakRetest.side
    ) {
      addNeutral({
        id: "break_retest_failed",
        family: "structure",
        source: "heuristic",
        reason: `Break/retest playbook ${breakRetest.phase}: ${breakRetest.reason}`,
      });
    }
  }

  const independent = new Set<SignalFactorFamily>(
    confirmations.map((c) => {
      if (
        c.startsWith("structure") ||
        c.startsWith("mtf_") ||
        c.startsWith("ob_") ||
        c.startsWith("fvg_") ||
        c.startsWith("sweep_") ||
        c.startsWith("break_retest") ||
        c.includes("bos") ||
        c.includes("choch")
      )
        return "structure";
      if (c.startsWith("cvd") || (c.includes("delta") && !c.startsWith("dom"))) return "delta";
      if (
        c.includes("imbalance") ||
        c.startsWith("dom") ||
        c.startsWith("bar_delta") ||
        c.startsWith("stacked_")
      )
        return "orderflow";
      if (
        c.includes("val") ||
        c.includes("vah") ||
        c.includes("volume") ||
        c.includes("poc") ||
        c.includes("hvn") ||
        c.includes("lvn")
      )
        return "volume";
      return "orderflow";
    }),
  );

  let direction: TradingSignal["direction"] = "WAIT";
  if (
    independent.size >= config.minIndependent &&
    longScore >= shortScore + config.minLead &&
    longScore >= config.minScore
  ) {
    direction = "LONG";
  } else if (
    independent.size >= config.minIndependent &&
    shortScore >= longScore + config.minLead &&
    shortScore >= config.minScore
  ) {
    direction = "SHORT";
  } else {
    addNeutral({
      id: "gate_not_met",
      family: "structure",
      source: "derived",
      reason: "Fewer than two independent confirmations or scores not decisive.",
    });
  }

  const entryQualityNotes: string[] = [];
  let entryGrade: TradingSignal["entryGrade"] = "WAIT";

  if (direction !== "WAIT" && config.entryQuality === "a_plus") {
    const aPlus = evaluateAPlusEntry({
      side: direction,
      structureOk,
      deltaOk,
      orderFlowOk,
      volumeOk,
      confirmations,
      factors,
      mtf,
      config,
    });
    entryQualityNotes.push(...aPlus.notes);
    if (!aPlus.pass) {
      addNeutral({
        id: "a_plus_gate_failed",
        family: "structure",
        source: "derived",
        reason: `A+ entry filter blocked ${direction}: ${aPlus.notes.join(" | ")}`,
      });
      direction = "WAIT";
      entryGrade = "WAIT";
    } else {
      entryGrade = "A+";
      reasonsFor.push("A+ entry checklist passed (selective profile — not a win-rate claim).");
    }
  } else if (direction !== "WAIT") {
    entryGrade = "STANDARD";
    entryQualityNotes.push("Standard multi-confirm gates only (A+ profile disabled).");
  } else {
    entryQualityNotes.push("No directional setup after base gates.");
  }

  // Safety gates: hard WAIT for LONG/SHORT (readiness, opposing DOM, swing, room).
  if (direction !== "WAIT") {
    const demote = (id: string, family: SignalFactorFamily, reason: string) => {
      addNeutral({ id, family, source: "derived", reason });
      direction = "WAIT";
      entryGrade = "WAIT";
      entryQualityNotes.push(reason);
    };

    if (config.requireDataReady) {
      const vpReady =
        volumeProfile != null &&
        Number.isFinite(volumeProfile.totalVolume) &&
        volumeProfile.totalVolume >= config.minVpTotalVolume;
      if (!footprint || !vpReady) {
        demote(
          "data_not_ready",
          "orderflow",
          !footprint
            ? "Data not ready: no footprint bar yet."
            : "Data not ready: volume profile missing or empty.",
        );
      }
    }

    if (direction !== "WAIT" && config.icebergVetoEnabled && dom?.iceberg) {
      const ice = dom.iceberg;
      const opposing =
        (direction === "SHORT" && ice.side === "bid") ||
        (direction === "LONG" && ice.side === "ask");
      const near =
        ice.price != null &&
        lastPrice > 0 &&
        Math.abs(ice.price - lastPrice) / lastPrice <= config.icebergVetoProximityPct;
      if (opposing && near && ice.confidence >= config.icebergVetoMinConfidence) {
        demote(
          "dom_iceberg_opposing_veto",
          "orderflow",
          `Opposing ${ice.side} iceberg/refill near entry — veto ${direction}.`,
        );
      }
    }

    if (direction !== "WAIT" && structure && config.swingProximityPct > 0 && lastPrice > 0) {
      const swings = structure.swings ?? [];
      if (direction === "SHORT") {
        const hit = swings.some(
          (s) =>
            s.kind === "low" &&
            Math.abs(s.price - lastPrice) / lastPrice <= config.swingProximityPct,
        );
        if (hit) {
          demote(
            "entry_at_swing_low",
            "structure",
            `Entry within ${(config.swingProximityPct * 100).toFixed(2)}% of a swing low — no SHORT.`,
          );
        }
      } else if (direction === "LONG") {
        const hit = swings.some(
          (s) =>
            s.kind === "high" &&
            Math.abs(s.price - lastPrice) / lastPrice <= config.swingProximityPct,
        );
        if (hit) {
          demote(
            "entry_at_swing_high",
            "structure",
            `Entry within ${(config.swingProximityPct * 100).toFixed(2)}% of a swing high — no LONG.`,
          );
        }
      }
    }

    if (direction !== "WAIT" && config.minRoomToRunR > 0 && lastPrice > 0) {
      const provisionalStop = resolveProtectiveStop({
        side: direction,
        entry: lastPrice,
        structure,
        volumeProfile,
        stopBufferPct: config.stopBufferPct,
      });
      const rewards = resolveRewardTargets({
        side: direction,
        entry: lastPrice,
        stop: provisionalStop,
        structure,
        minStructuralRR: Math.max(config.minRoomToRunR, config.minStructuralRR),
      });
      if (!rewards) {
        demote(
          "insufficient_room_to_run",
          "structure",
          `Structural R:R below ${Math.max(config.minRoomToRunR, config.minStructuralRR)}R or missing opposing level — veto ${direction}.`,
        );
      }
    }
  }

  // Phase 11 plugins: weight-0 neutrals only — never bump long/short or A+ flags.
  if (config.enableStrategyPlugins) {
    const pack = applyConfirmationPacks(input);
    for (const f of pack.factors) {
      factors.push(f);
      if (f.side === "neutral") reasonsAgainst.push(f.reason);
    }
    evidence.push(...pack.evidence);
    reasonsAgainst.push(...pack.reasonsAgainst);
  }

  const confidenceRaw =
    Math.max(longScore, shortScore) / config.confidenceDivisor +
    (independent.size >= config.minIndependent ? config.multiConfirmBonus : 0) +
    (entryGrade === "A+" ? 0.05 : 0);
  const confidence = Math.min(
    0.95,
    direction === "WAIT" ? Math.min(confidenceRaw, config.waitConfidenceCap) : confidenceRaw,
  );

  let entry: number | undefined;
  let stopLoss: number | undefined;
  let takeProfit: number[] | undefined;
  let riskReward: number | undefined;
  let structureTargets: TradingSignal["structureTargets"];
  const invalidation: string[] = [];

  if (direction === "LONG" || direction === "SHORT") {
    entry = lastPrice;
    stopLoss = resolveProtectiveStop({
      side: direction,
      entry,
      structure,
      volumeProfile,
      stopBufferPct: config.stopBufferPct,
    });
    const rewards = resolveRewardTargets({
      side: direction,
      entry,
      stop: stopLoss,
      structure,
      minStructuralRR: config.minStructuralRR,
    })!;
    takeProfit = rewards.takeProfit;
    riskReward = rewards.riskReward;
    structureTargets = buildStructureTargets({
      side: direction,
      entry,
      breakRetest,
      structure,
      volumeProfile,
    });
    invalidation.push(
      direction === "LONG"
        ? "Close below stop or bearish CHoCH with negative CVD confirmation."
        : "Close above stop or bullish CHoCH with positive CVD confirmation.",
    );
    if (breakRetest?.phase === "invalidated" || breakRetest?.phase === "failed") {
      invalidation.push(`Break/retest playbook ${breakRetest.phase}: ${breakRetest.reason}`);
    }
  } else {
    invalidation.push(
      config.entryQuality === "a_plus"
        ? "WAIT until A+ checklist passes (HTF permission + OF trigger + location + no conflict)."
        : "WAIT until ≥2 independent confirmations align.",
    );
    if (breakRetest?.phase === "broken" || breakRetest?.phase === "retesting") {
      invalidation.push(`Break/retest still ${breakRetest.phase} — wait for accepted reclaim + OF.`);
    }
  }

  const score: SignalScoreBreakdown = {
    longScore: round2(longScore),
    shortScore: round2(shortScore),
    neutralScore: round2(neutralScore),
    independentFamilies: [...independent].sort(),
    factors,
    modelNote: MODEL_NOTE,
  };

  const setupId = buildSetupId({
    symbol: input.symbol,
    direction,
    families: score.independentFamilies,
    trend: structure?.trend,
    bos: structure?.lastBos?.price,
    choch: structure?.lastChoch?.price,
    mtf: mtf
      ? `${mtf.higherTfBullish}b${mtf.higherTfBearish}s${mtf.conflictWithPrimary ? "x" : ""}`
      : undefined,
    grade: entryGrade,
    breakBand:
      breakRetest?.phase === "accepted" && breakRetest.bandId
        ? `${breakRetest.side}:${breakRetest.bandId}`
        : undefined,
  });

  const lifecycle =
    direction === "WAIT"
      ? independent.size > 0 || entryQualityNotes.some((n) => n.includes("A+"))
        ? ("PENDING_CONFIRM" as const)
        : ("WATCHING" as const)
      : ("CONFIRMED" as const);

  return {
    id: setupId,
    setupId,
    symbol: input.symbol,
    timestamp: input.timestamp,
    direction,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    structureTargets,
    confidence,
    confirmations,
    reasonsFor,
    reasonsAgainst,
    invalidation,
    orderFlowOk,
    structureOk,
    volumeOk,
    deltaOk,
    score,
    evidence,
    entryGrade,
    entryQualityNotes,
    lifecycle,
    lifecycleUpdatedAt: input.timestamp,
    setupOpenedAt: input.timestamp,
  };
}

/** A+ selective entry checklist. Failures demote LONG/SHORT → WAIT. */
export function evaluateAPlusEntry(args: {
  side: "LONG" | "SHORT";
  structureOk: boolean;
  deltaOk: boolean;
  orderFlowOk: boolean;
  volumeOk: boolean;
  confirmations: string[];
  factors: SignalFactor[];
  mtf?: MultiTimeframeContext | null;
  config: SignalEngineConfig;
}): { pass: boolean; notes: string[] } {
  const notes: string[] = [];
  let pass = true;
  const bull = args.side === "LONG";

  if (!args.structureOk) {
    pass = false;
    notes.push("Structure not confirmed.");
  } else {
    notes.push("Structure OK.");
  }

  if (!args.mtf || args.mtf.frames.length === 0) {
    pass = false;
    notes.push("MTF context required for A+.");
  } else if (args.mtf.conflictWithPrimary) {
    pass = false;
    notes.push("HTF conflicts with primary trend — no A+ entry.");
  } else {
    const htfOk = bull
      ? args.mtf.higherTfBullish >= args.config.mtfMinHigherAgree &&
        args.mtf.higherTfBullish > args.mtf.higherTfBearish
      : args.mtf.higherTfBearish >= args.config.mtfMinHigherAgree &&
        args.mtf.higherTfBearish > args.mtf.higherTfBullish;
    if (!htfOk) {
      pass = false;
      notes.push("HTF majority does not permit this side.");
    } else {
      notes.push("HTF permission OK.");
    }
  }

  if (!args.orderFlowOk) {
    pass = false;
    notes.push("Need footprint/DOM order-flow trigger (session CVD alone is not enough).");
  } else {
    notes.push("OF trigger OK.");
  }

  const locationIds = bull
    ? [
        "ob_bullish_zone",
        "fvg_bullish_zone",
        "sweep_ssl_reclaim",
        "price_at_val_discount",
        "lvn_bullish_continuation",
        "break_retest_bullish",
      ]
    : [
        "ob_bearish_zone",
        "fvg_bearish_zone",
        "sweep_bsl_reclaim",
        "price_at_vah_premium",
        "lvn_bearish_continuation",
        "break_retest_bearish",
      ];
  const hasLocation = locationIds.some((id) => args.confirmations.includes(id));
  if (!hasLocation) {
    pass = false;
    notes.push("Location missing (need OB/FVG/sweep reclaim, VP extreme/LVN, or accepted break/retest).");
  } else {
    notes.push("Location OK.");
  }

  if (args.factors.some((f) => f.id === "structure_choch_warning")) {
    pass = false;
    notes.push("Opposing CHoCH warning present — veto.");
  } else {
    notes.push("No opposing CHoCH warning.");
  }

  return { pass, notes };
}

/** Protective stop: nearest swing/S/R beyond entry + buffer, else VP, else fixed pct. */
export function resolveProtectiveStop(args: {
  side: "LONG" | "SHORT";
  entry: number;
  structure?: MarketStructureState | null;
  volumeProfile?: VolumeProfile | null;
  stopBufferPct: number;
}): number {
  const { side, entry, structure, volumeProfile, stopBufferPct } = args;
  const buffer = Math.max(0, stopBufferPct);

  if (side === "SHORT") {
    const above: number[] = [
      ...(structure?.resistance ?? []).filter((p) => p > entry),
      ...(structure?.swings ?? [])
        .filter((s) => s.kind === "high" && s.price > entry)
        .map((s) => s.price),
    ];
    if (above.length > 0) {
      const level = Math.min(...above);
      return level * (1 + buffer);
    }
    if (volumeProfile?.vah != null) {
      return Math.max(volumeProfile.vah, entry) * 1.002;
    }
    return entry * 1.005;
  }

  const below: number[] = [
    ...(structure?.support ?? []).filter((p) => p < entry),
    ...(structure?.swings ?? [])
      .filter((s) => s.kind === "low" && s.price < entry)
      .map((s) => s.price),
  ];
  if (below.length > 0) {
    const level = Math.max(...below);
    return level * (1 - buffer);
  }
  if (volumeProfile?.val != null) {
    return Math.min(volumeProfile.val, entry) * 0.998;
  }
  return entry * 0.995;
}

/** TP1 at first opposing S/R; TP2/TP3 extend by 1R/2R. Null when R:R too low. */
export function resolveRewardTargets(args: {
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  structure?: MarketStructureState | null;
  minStructuralRR: number;
}): { takeProfit: number[]; riskReward: number } | null {
  const risk = Math.abs(args.entry - args.stop);
  if (!(risk > 0)) return null;

  let tp1: number | undefined;
  if (args.side === "SHORT") {
    const supports = (args.structure?.support ?? []).filter((p) => p < args.entry);
    tp1 = supports.length ? Math.max(...supports) : undefined;
  } else {
    const resistances = (args.structure?.resistance ?? []).filter((p) => p > args.entry);
    tp1 = resistances.length ? Math.min(...resistances) : undefined;
  }
  if (tp1 == null) return null;

  const reward = Math.abs(args.entry - tp1);
  const rr = reward / risk;
  if (rr < args.minStructuralRR) return null;

  const takeProfit =
    args.side === "SHORT"
      ? [tp1, tp1 - risk, tp1 - risk * 2]
      : [tp1, tp1 + risk, tp1 + risk * 2];
  return { takeProfit, riskReward: round2(rr) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildSetupId(parts: {
  symbol: string;
  direction: string;
  families: string[];
  trend?: string;
  bos?: number;
  choch?: number;
  mtf?: string;
  grade?: string;
  breakBand?: string;
}): string {
  const raw = [
    parts.symbol.toUpperCase(),
    parts.direction,
    parts.trend ?? "none",
    parts.families.join("+") || "none",
    parts.bos != null ? String(parts.bos) : "",
    parts.choch != null ? String(parts.choch) : "",
    parts.mtf ?? "",
    parts.grade ?? "",
    parts.breakBand ?? "",
  ].join("|");
  return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

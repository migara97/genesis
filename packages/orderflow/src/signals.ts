import { createHash } from "node:crypto";
import type {
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
};

/** Legacy multi-confirm gates only (used by tests / opt-out). */
export const STANDARD_SIGNAL_CONFIG: SignalEngineConfig = {
  ...DEFAULT_SIGNAL_CONFIG,
  entryQuality: "standard",
};

const MODEL_NOTE =
  "Scores use configurable rule weights (A+ entry profile when enabled: HTF permission + OF trigger + location; BOS/CHoCH/VP/zones; DOM needs trade-delta). Confidence is a model score, not a calibrated win probability. A+ ≠ 100% accuracy.";

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

  const { footprint, cvd, dom, volumeProfile, structure, mtf, zones, lastPrice } = input;
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
      note: "Multi-timeframe trends are derived from per-interval candle swings (1d/4h/1h/15m/5m), not exchange-labeled bias.",
    });
    const soft = mtf.frames.find((f) => f.interval === "5m");
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
        reason: "5m structure soft-confirms bullish bias.",
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
        reason: "5m structure soft-confirms bearish bias.",
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
      deltaOk = true;
    }
    if (cvd.cvd < 0 && structure?.trend === "bearish") {
      addShort({
        id: "cvd_negative",
        family: "delta",
        weight: w.cvdAligned,
        source: "derived",
        reason: "Session CVD is negative while structure is bearish.",
      });
      deltaOk = true;
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

  const independent = new Set<SignalFactorFamily>(
    confirmations.map((c) => {
      if (
        c.startsWith("structure") ||
        c.startsWith("mtf_") ||
        c.startsWith("ob_") ||
        c.startsWith("fvg_") ||
        c.startsWith("sweep_") ||
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
  const invalidation: string[] = [];

  if (direction === "LONG") {
    entry = lastPrice;
    stopLoss = volumeProfile?.val
      ? Math.min(volumeProfile.val, lastPrice) * 0.998
      : lastPrice * 0.995;
    const risk = entry - stopLoss;
    takeProfit = [entry + risk * 1.5, entry + risk * 2.5, entry + risk * 3.5];
    riskReward = 1.5;
    invalidation.push("Close below stop or bearish CHoCH with negative CVD confirmation.");
  } else if (direction === "SHORT") {
    entry = lastPrice;
    stopLoss = volumeProfile?.vah
      ? Math.max(volumeProfile.vah, lastPrice) * 1.002
      : lastPrice * 1.005;
    const risk = stopLoss - entry;
    takeProfit = [entry - risk * 1.5, entry - risk * 2.5, entry - risk * 3.5];
    riskReward = 1.5;
    invalidation.push("Close above stop or bullish CHoCH with positive CVD confirmation.");
  } else {
    invalidation.push(
      config.entryQuality === "a_plus"
        ? "WAIT until A+ checklist passes (HTF permission + OF trigger + location + no conflict)."
        : "WAIT until ≥2 independent confirmations align.",
    );
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

  if (!(args.deltaOk || args.orderFlowOk)) {
    pass = false;
    notes.push("Need real order-flow trigger (delta and/or footprint/DOM+delta).");
  } else {
    notes.push("OF trigger OK.");
  }

  const locationIds = bull
    ? ["ob_bullish_zone", "fvg_bullish_zone", "sweep_ssl_reclaim", "price_at_val_discount", "lvn_bullish_continuation"]
    : ["ob_bearish_zone", "fvg_bearish_zone", "sweep_bsl_reclaim", "price_at_vah_premium", "lvn_bearish_continuation"];
  const hasLocation = locationIds.some((id) => args.confirmations.includes(id));
  if (!hasLocation) {
    pass = false;
    notes.push("Location missing (need OB/FVG/sweep reclaim or VP extreme/LVN).");
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
  ].join("|");
  return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

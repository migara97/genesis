import type {
  CvdState,
  DomMetrics,
  FootprintBar,
  MarketStructureState,
  TradingSignal,
  VolumeProfile,
} from "@of/shared";
import { randomUUID } from "node:crypto";

export interface SignalInput {
  symbol: string;
  lastPrice: number;
  timestamp: number;
  footprint?: FootprintBar | null;
  cvd?: CvdState | null;
  dom?: DomMetrics | null;
  volumeProfile?: VolumeProfile | null;
  structure?: MarketStructureState | null;
}

/**
 * Rule-based multi-confirmation signal engine.
 * Requires at least two independent confirmations or returns WAIT.
 */
export function generateSignal(input: SignalInput): TradingSignal {
  const reasonsFor: string[] = [];
  const reasonsAgainst: string[] = [];
  const confirmations: string[] = [];
  let longScore = 0;
  let shortScore = 0;

  const { footprint, cvd, dom, volumeProfile, structure, lastPrice } = input;

  // Structure
  let structureOk = false;
  if (structure) {
    if (structure.trend === "bullish") {
      longScore += 1;
      confirmations.push("structure_bullish");
      reasonsFor.push("Market structure trend is bullish (HH/HL bias).");
      structureOk = true;
    } else if (structure.trend === "bearish") {
      shortScore += 1;
      confirmations.push("structure_bearish");
      reasonsFor.push("Market structure trend is bearish (LH/LL bias).");
      structureOk = true;
    } else {
      reasonsAgainst.push("Structure is ranging / unclear.");
    }
    if (structure.lastChoch) {
      reasonsAgainst.push(
        `Recent CHoCH (${structure.lastChoch.direction}) warns against chasing prior trend.`,
      );
    }
  } else {
    reasonsAgainst.push("No market structure input.");
  }

  // Delta / CVD
  let deltaOk = false;
  if (cvd) {
    if (cvd.divergence === "bullish") {
      longScore += 1;
      confirmations.push("cvd_bullish_divergence");
      reasonsFor.push("CVD bullish divergence vs price.");
      deltaOk = true;
    } else if (cvd.divergence === "bearish") {
      shortScore += 1;
      confirmations.push("cvd_bearish_divergence");
      reasonsFor.push("CVD bearish divergence vs price.");
      deltaOk = true;
    }
    if (cvd.cvd > 0 && structure?.trend === "bullish") {
      longScore += 0.5;
      confirmations.push("cvd_positive");
      deltaOk = true;
    }
    if (cvd.cvd < 0 && structure?.trend === "bearish") {
      shortScore += 0.5;
      confirmations.push("cvd_negative");
      deltaOk = true;
    }
    if (cvd.exhaustion) {
      reasonsAgainst.push("Delta exhaustion heuristic active.");
    }
  } else {
    reasonsAgainst.push("No CVD input.");
  }

  // Order flow / footprint
  let orderFlowOk = false;
  if (footprint) {
    const askImbalances = footprint.imbalances.filter((i) => i.side === "ask" && i.stacked);
    const bidImbalances = footprint.imbalances.filter((i) => i.side === "bid" && i.stacked);
    if (askImbalances.length > 0) {
      longScore += 1;
      confirmations.push("stacked_ask_imbalance");
      reasonsFor.push("Stacked ask (buy aggression) imbalances on footprint.");
      orderFlowOk = true;
    }
    if (bidImbalances.length > 0) {
      shortScore += 1;
      confirmations.push("stacked_bid_imbalance");
      reasonsFor.push("Stacked bid (sell aggression) imbalances on footprint.");
      orderFlowOk = true;
    }
    if (footprint.absorption) {
      reasonsAgainst.push("Absorption heuristic — aggression may not move price cleanly.");
    }
    if (footprint.totalDelta > 0 && longScore >= shortScore) {
      longScore += 0.5;
      confirmations.push("bar_delta_positive");
      orderFlowOk = true;
    }
    if (footprint.totalDelta < 0 && shortScore >= longScore) {
      shortScore += 0.5;
      confirmations.push("bar_delta_negative");
      orderFlowOk = true;
    }
  } else {
    reasonsAgainst.push("No footprint bar yet.");
  }

  // DOM pressure
  if (dom) {
    if (dom.imbalance > 0.25) {
      longScore += 0.5;
      confirmations.push("dom_bid_pressure");
      reasonsFor.push("Visible bid liquidity exceeds ask (L2 imbalance).");
      orderFlowOk = true;
    } else if (dom.imbalance < -0.25) {
      shortScore += 0.5;
      confirmations.push("dom_ask_pressure");
      reasonsFor.push("Visible ask liquidity exceeds bid (L2 imbalance).");
      orderFlowOk = true;
    }
    if (dom.spoofingRisk === "elevated") {
      reasonsAgainst.push("Elevated spoofing-risk heuristic on DOM — treat walls cautiously.");
    }
  }

  // Volume profile location
  let volumeOk = false;
  if (volumeProfile) {
    if (lastPrice <= volumeProfile.val) {
      longScore += 0.5;
      confirmations.push("price_at_val_discount");
      reasonsFor.push("Price at/below value area low (discount vs session profile).");
      volumeOk = true;
    } else if (lastPrice >= volumeProfile.vah) {
      shortScore += 0.5;
      confirmations.push("price_at_vah_premium");
      reasonsFor.push("Price at/above value area high (premium vs session profile).");
      volumeOk = true;
    } else {
      reasonsAgainst.push("Price inside value area — mean-reversion edge weaker.");
    }
  } else {
    reasonsAgainst.push("No volume profile input.");
  }

  const independent = new Set(
    confirmations.map((c) => {
      if (c.startsWith("structure")) return "structure";
      if (c.startsWith("cvd") || c.includes("delta")) return "delta";
      if (c.includes("imbalance") || c.startsWith("dom") || c.startsWith("bar_delta"))
        return "orderflow";
      if (c.includes("val") || c.includes("vah") || c.includes("volume")) return "volume";
      return c;
    }),
  );

  let direction: TradingSignal["direction"] = "WAIT";
  if (independent.size >= 2 && longScore >= shortScore + 1 && longScore >= 2) {
    direction = "LONG";
  } else if (independent.size >= 2 && shortScore >= longScore + 1 && shortScore >= 2) {
    direction = "SHORT";
  } else {
    reasonsAgainst.push("Fewer than two independent confirmations or scores not decisive.");
  }

  const confidence = Math.min(
    0.95,
    Math.max(longScore, shortScore) / 5 + (independent.size >= 2 ? 0.15 : 0),
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
    invalidation.push("WAIT until ≥2 independent confirmations align.");
  }

  return {
    id: randomUUID(),
    symbol: input.symbol,
    timestamp: input.timestamp,
    direction,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    confidence: direction === "WAIT" ? Math.min(confidence, 0.35) : confidence,
    confirmations,
    reasonsFor,
    reasonsAgainst,
    invalidation,
    orderFlowOk,
    structureOk,
    volumeOk,
    deltaOk,
  };
}

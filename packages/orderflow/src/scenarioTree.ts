import { createHash } from "node:crypto";
import type {
  BreakRetestPhase,
  BreakRetestState,
  Candle,
  ChartOverlayState,
  ChartZoneBand,
  CvdState,
  MarketStructureState,
  ScenarioKind,
  ScenarioStatus,
  ScenarioTreeState,
  TradeScenario,
} from "@of/shared";

export interface ScenarioTreeConfig {
  /** Arm when price is within this fraction of the trigger edge. */
  armProximityPct: number;
  /** Max corridor height / mid. */
  maxRangePct: number;
  /** Hold invalidated/completed briefly before clearing. */
  terminalHoldMs: number;
}

export const DEFAULT_SCENARIO_TREE_CONFIG: ScenarioTreeConfig = {
  armProximityPct: 0.0015,
  maxRangePct: 0.08,
  terminalHoldMs: 60_000,
};

export interface ScenarioTreeInput {
  symbol: string;
  lastPrice: number;
  candles: Candle[];
  chartOverlay?: ChartOverlayState | null;
  breakRetest?: BreakRetestState | null;
  structure?: MarketStructureState | null;
  cvd?: CvdState | null;
  now?: number;
}

const EVIDENCE = {
  kind: "inferred" as const,
  note: "Scenario tree paths are heuristic hypotheses on chart bands — not calibrated win rates and not executable orders.",
};

const RANK_NOTE =
  "rankScore is a model ranking heuristic (0–1), not a historical win rate or probability.";

/**
 * Advance dual scenario tree. Pure function; caller persists prior state.
 */
export function advanceScenarioTree(
  previous: ScenarioTreeState | null | undefined,
  input: ScenarioTreeInput,
  config: ScenarioTreeConfig = DEFAULT_SCENARIO_TREE_CONFIG,
): ScenarioTreeState {
  const now = input.now ?? Date.now();
  const symbol = input.symbol.toUpperCase();
  const empty = emptyTree(symbol, now);

  const corridor = resolveCorridor(input.chartOverlay?.bands ?? [], input.lastPrice, config);
  const bias = resolveScenarioBias(input.structure, input.cvd);

  if (!corridor || bias === "none") {
    return completeOrClear(
      previous,
      empty,
      now,
      config,
      !corridor
        ? "No demand/supply corridor for scenarios."
        : "No directional bias (structure/CVD) — scenarios withheld.",
    );
  }

  const seeded = seedPair(symbol, bias, corridor, input, now);
  const priorByKind = new Map((previous?.scenarios ?? []).map((s) => [s.kind, s]));

  const advanced = seeded.map((fresh) => {
    const prior = priorByKind.get(fresh.kind);
    return advanceOne(prior ?? fresh, fresh, input, now, config);
  });

  const liveKinds = new Set(advanced.map((s) => s.kind));
  const leftovers = (previous?.scenarios ?? [])
    .filter((s) => !liveKinds.has(s.kind) && !isTerminal(s.status))
    .map((s) => ({
      ...s,
      status: "completed" as const,
      reason: "Corridor or bias changed — scenario retired.",
      updatedAt: now,
    }));

  const scenarios = [...advanced, ...leftovers].filter((s) => {
    if (!isTerminal(s.status)) return true;
    return now - s.updatedAt < config.terminalHoldMs;
  });

  return {
    symbol,
    bias,
    scenarios,
    evidence: [EVIDENCE],
    updatedAt: now,
  };
}

export function resolveScenarioBias(
  structure?: MarketStructureState | null,
  cvd?: CvdState | null,
): "bullish" | "bearish" | "none" {
  if (structure?.trend === "bullish") return "bullish";
  if (structure?.trend === "bearish") return "bearish";
  const slope = cvdSlope(cvd);
  if (slope === "up") return "bullish";
  if (slope === "down") return "bearish";
  return "none";
}

function emptyTree(symbol: string, now: number): ScenarioTreeState {
  return {
    symbol,
    bias: "none",
    scenarios: [],
    evidence: [EVIDENCE],
    updatedAt: now,
  };
}

function completeOrClear(
  previous: ScenarioTreeState | null | undefined,
  empty: ScenarioTreeState,
  now: number,
  config: ScenarioTreeConfig,
  reason: string,
): ScenarioTreeState {
  if (!previous?.scenarios.length) {
    return { ...empty, updatedAt: now };
  }
  const held = previous.scenarios
    .map((s) =>
      isTerminal(s.status)
        ? s
        : {
            ...s,
            status: "completed" as const,
            reason,
            updatedAt: now,
          },
    )
    .filter((s) => now - s.updatedAt < config.terminalHoldMs);
  return {
    symbol: empty.symbol,
    bias: "none",
    scenarios: held,
    evidence: [EVIDENCE],
    updatedAt: now,
  };
}

function cvdSlope(cvd?: CvdState | null): "up" | "down" | "flat" {
  const pts = cvd?.points ?? [];
  if (pts.length < 8) return "flat";
  const window = pts.slice(-20);
  const first = window[0]!.cvd;
  const last = window[window.length - 1]!.cvd;
  const diff = last - first;
  const scale = Math.max(Math.abs(first), Math.abs(last), 1);
  if (diff / scale > 0.02) return "up";
  if (diff / scale < -0.02) return "down";
  return "flat";
}

function resolveCorridor(
  bands: ChartZoneBand[],
  lastPrice: number,
  config: ScenarioTreeConfig,
): { demand: ChartZoneBand; supply: ChartZoneBand } | null {
  const demand = nearestBand(bands, "demand", lastPrice);
  const supply = nearestBand(bands, "supply", lastPrice);
  if (!demand || !supply) return null;
  if (!(supply.low > demand.high)) return null;
  const mid = (demand.high + supply.low) / 2;
  const height = supply.low - demand.high;
  if (mid <= 0 || height / mid > config.maxRangePct) return null;
  return { demand, supply };
}

function nearestBand(
  bands: ChartZoneBand[],
  kind: "demand" | "supply",
  lastPrice: number,
): ChartZoneBand | null {
  const pool = bands.filter(
    (b) => b.kind === kind || (b.kind === "balance" && sideOfBalance(b, lastPrice) === kind),
  );
  if (pool.length === 0) return null;
  return pool.reduce((best, b) =>
    distanceToBand(lastPrice, b) < distanceToBand(lastPrice, best) ? b : best,
  );
}

function sideOfBalance(band: ChartZoneBand, lastPrice: number): "demand" | "supply" {
  const mid = (band.low + band.high) / 2;
  return lastPrice <= mid ? "demand" : "supply";
}

function distanceToBand(price: number, band: ChartZoneBand): number {
  if (price < band.low) return band.low - price;
  if (price > band.high) return price - band.high;
  return 0;
}

function seedPair(
  symbol: string,
  bias: "bullish" | "bearish",
  corridor: { demand: ChartZoneBand; supply: ChartZoneBand },
  input: ScenarioTreeInput,
  now: number,
): TradeScenario[] {
  const { demand, supply } = corridor;
  const ofAligned = ofAlignedWithBias(bias, input.cvd);
  const mid = (demand.high + supply.low) / 2;
  const range = supply.low - demand.high;
  const inMid =
    range > 0 &&
    input.lastPrice >= demand.high &&
    input.lastPrice <= supply.low &&
    Math.abs(input.lastPrice - mid) <= range * 0.35;
  const brActive =
    input.breakRetest?.phase === "broken" ||
    input.breakRetest?.phase === "retesting" ||
    input.breakRetest?.phase === "accepted";

  if (bias === "bullish") {
    return [
      makeScenario({
        symbol,
        kind: "break_now_long",
        side: "bullish",
        triggerPrice: supply.high,
        entryLow: supply.low,
        entryHigh: supply.high,
        invalidation: demand.low,
        rankScore: clamp01(0.45 + (ofAligned ? 0.25 : 0) + (brActive && input.breakRetest?.side === "bullish" ? 0.15 : 0)),
        reason: "Hypothesis: break supply now (Phase-B aligned when broken/accepted).",
        now,
      }),
      makeScenario({
        symbol,
        kind: "dip_to_demand_long",
        side: "bullish",
        triggerPrice: demand.high,
        entryLow: demand.low,
        entryHigh: demand.high,
        invalidation: demand.low,
        rankScore: clamp01(0.4 + (inMid && !ofAligned ? 0.2 : 0) + (ofAligned ? 0.05 : 0.1)),
        reason: "Hypothesis: dip into demand then long.",
        now,
      }),
    ];
  }

  return [
    makeScenario({
      symbol,
      kind: "break_now_short",
      side: "bearish",
      triggerPrice: demand.low,
      entryLow: demand.low,
      entryHigh: demand.high,
      invalidation: supply.high,
      rankScore: clamp01(0.45 + (ofAligned ? 0.25 : 0) + (brActive && input.breakRetest?.side === "bearish" ? 0.15 : 0)),
      reason: "Hypothesis: break demand now (Phase-B aligned when broken/accepted).",
      now,
    }),
    makeScenario({
      symbol,
      kind: "rally_to_supply_short",
      side: "bearish",
      triggerPrice: supply.low,
      entryLow: supply.low,
      entryHigh: supply.high,
      invalidation: supply.high,
      rankScore: clamp01(0.4 + (inMid && !ofAligned ? 0.2 : 0) + (ofAligned ? 0.05 : 0.1)),
      reason: "Hypothesis: rally into supply then short.",
      now,
    }),
  ];
}

function advanceOne(
  prior: TradeScenario,
  fresh: TradeScenario,
  input: ScenarioTreeInput,
  now: number,
  config: ScenarioTreeConfig,
): TradeScenario {
  if (isTerminal(prior.status)) {
    return { ...prior };
  }

  const last = input.candles[input.candles.length - 1];
  const close = last?.close ?? input.lastPrice;
  const price = input.lastPrice;
  const merged: TradeScenario = {
    ...prior,
    triggerPrice: fresh.triggerPrice,
    entryLow: fresh.entryLow,
    entryHigh: fresh.entryHigh,
    invalidation: fresh.invalidation,
    rankScore: fresh.rankScore,
    rankNote: RANK_NOTE,
  };

  if (isInvalidated(merged, close)) {
    return {
      ...merged,
      status: "invalidated",
      reason: `Invalidated: close through ${merged.invalidation}.`,
      linkedBreakRetestPhase: input.breakRetest?.phase,
      updatedAt: now,
    };
  }

  let status: ScenarioStatus = prior.status === "triggered" ? "triggered" : "open";
  let reason = fresh.reason;

  if (status !== "triggered" && isTriggered(merged, price, last, input.breakRetest)) {
    status = "triggered";
    reason = triggerReason(fresh.kind, input.breakRetest?.phase);
  } else if (status !== "triggered" && isArmed(merged, price, config.armProximityPct)) {
    status = "armed";
    reason = `Armed: price near trigger ${merged.triggerPrice}.`;
  }

  return {
    ...merged,
    status,
    reason,
    linkedBreakRetestPhase: input.breakRetest?.phase,
    updatedAt: now,
  };
}

function isInvalidated(scenario: TradeScenario, close: number): boolean {
  if (scenario.side === "bullish") return close < scenario.invalidation;
  return close > scenario.invalidation;
}

function isArmed(scenario: TradeScenario, price: number, proximityPct: number): boolean {
  const prox = Math.max(Math.abs(scenario.triggerPrice) * proximityPct, 1e-12);
  return Math.abs(price - scenario.triggerPrice) <= prox;
}

function isTriggered(
  scenario: TradeScenario,
  price: number,
  last: Candle | undefined,
  breakRetest?: BreakRetestState | null,
): boolean {
  if (scenario.kind === "break_now_long") {
    if (
      breakRetest?.side === "bullish" &&
      (breakRetest.phase === "broken" ||
        breakRetest.phase === "retesting" ||
        breakRetest.phase === "accepted")
    ) {
      return true;
    }
    return (last?.close ?? price) > scenario.triggerPrice;
  }
  if (scenario.kind === "break_now_short") {
    if (
      breakRetest?.side === "bearish" &&
      (breakRetest.phase === "broken" ||
        breakRetest.phase === "retesting" ||
        breakRetest.phase === "accepted")
    ) {
      return true;
    }
    return (last?.close ?? price) < scenario.triggerPrice;
  }
  if (scenario.kind === "dip_to_demand_long" || scenario.kind === "rally_to_supply_short") {
    if (price >= scenario.entryLow && price <= scenario.entryHigh) return true;
    if (last && last.low <= scenario.entryHigh && last.high >= scenario.entryLow) return true;
    return false;
  }
  return false;
}

function triggerReason(kind: ScenarioKind, phase?: BreakRetestPhase): string {
  if (kind.startsWith("break_now")) {
    return phase
      ? `Triggered: break/retest phase=${phase}.`
      : "Triggered: close beyond break trigger.";
  }
  if (kind === "dip_to_demand_long") return "Triggered: price tagged demand band.";
  return "Triggered: price tagged supply band.";
}

function ofAlignedWithBias(bias: "bullish" | "bearish", cvd?: CvdState | null): boolean {
  const slope = cvdSlope(cvd);
  if (bias === "bullish") return slope === "up";
  return slope === "down";
}

function makeScenario(args: {
  symbol: string;
  kind: ScenarioKind;
  side: "bullish" | "bearish";
  triggerPrice: number;
  entryLow: number;
  entryHigh: number;
  invalidation: number;
  rankScore: number;
  reason: string;
  now: number;
}): TradeScenario {
  return {
    id: scenarioId(args.symbol, args.kind, args.triggerPrice, args.invalidation),
    kind: args.kind,
    status: "open",
    side: args.side,
    triggerPrice: args.triggerPrice,
    entryLow: Math.min(args.entryLow, args.entryHigh),
    entryHigh: Math.max(args.entryLow, args.entryHigh),
    invalidation: args.invalidation,
    rankScore: clamp01(args.rankScore),
    rankNote: RANK_NOTE,
    reason: args.reason,
    updatedAt: args.now,
  };
}

function scenarioId(symbol: string, kind: ScenarioKind, trigger: number, inv: number): string {
  return createHash("sha1")
    .update(`${symbol}|${kind}|${trigger}|${inv}`)
    .digest("hex")
    .slice(0, 12);
}

function isTerminal(status: ScenarioStatus): boolean {
  return status === "invalidated" || status === "completed";
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

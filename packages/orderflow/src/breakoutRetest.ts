import type {
  BreakRetestPhase,
  BreakRetestState,
  Candle,
  ChartOverlayState,
  ChartZoneBand,
  CvdState,
  FootprintBar,
} from "@of/shared";

export interface BreakRetestConfig {
  /** Candles required inside the demand/supply corridor for balance. */
  balanceBars: number;
  /** Max (supplyLow - demandHigh) / mid as a fraction for a valid balance range. */
  maxRangePct: number;
  /** Bars after break allowed before retest times out → failed. */
  retestMaxBars: number;
  /** Hold accepted/failed/invalidated briefly before returning to idle. */
  terminalHoldMs: number;
  /** Minimum |footprint.totalDelta| to count as OF continuation. */
  minDeltaAbs: number;
  /** CVD lookback points for slope confirmation. */
  cvdSlopePoints: number;
}

export const DEFAULT_BREAK_RETEST_CONFIG: BreakRetestConfig = {
  balanceBars: 8,
  maxRangePct: 0.08,
  retestMaxBars: 12,
  terminalHoldMs: 60_000,
  minDeltaAbs: 0,
  cvdSlopePoints: 20,
};

export interface BreakRetestInput {
  symbol: string;
  lastPrice: number;
  candles: Candle[];
  chartOverlay?: ChartOverlayState | null;
  footprint?: FootprintBar | null;
  cvd?: CvdState | null;
  now?: number;
}

const EVIDENCE = {
  kind: "inferred" as const,
  note: "Break/retest phases are mechanical heuristics on chart bands + order-flow deltas — not path predictions or institutional labels.",
};

/**
 * Advance RANGE_BREAK_RETEST playbook. Pure function; caller persists prior state.
 */
export function advanceBreakRetest(
  previous: BreakRetestState | null | undefined,
  input: BreakRetestInput,
  config: BreakRetestConfig = DEFAULT_BREAK_RETEST_CONFIG,
): BreakRetestState {
  const now = input.now ?? Date.now();
  const symbol = input.symbol.toUpperCase();
  const base = emptyState(symbol, now);

  if (!previous) {
    return enterBalanceOrIdle(base, input, config, now);
  }

  // Terminal hold then reset.
  if (previous.phase === "accepted" || previous.phase === "failed" || previous.phase === "invalidated") {
    if (now - previous.updatedAt < config.terminalHoldMs) {
      return { ...previous, updatedAt: now };
    }
    return enterBalanceOrIdle(base, input, config, now);
  }

  const bands = input.chartOverlay?.bands ?? [];
  const demand = nearestBand(bands, "demand", input.lastPrice);
  const supply = nearestBand(bands, "supply", input.lastPrice);
  const last = input.candles[input.candles.length - 1];
  const barIndex = Math.max(0, input.candles.length - 1);

  if (previous.phase === "idle") {
    return enterBalanceOrIdle(previous, input, config, now);
  }

  if (previous.phase === "balance") {
    // Refresh corridor from current nearest bands while still balanced.
    const corridor = resolveCorridor(demand, supply, config);
    if (!corridor) {
      return {
        ...previous,
        phase: "idle",
        reason: "Lost demand/supply corridor.",
        updatedAt: now,
        evidence: [EVIDENCE],
      };
    }

    if (!isBalanced(input.candles, corridor.demand, corridor.supply, config)) {
      // May already be a break on this bar — check before dropping to idle.
      const breakAttempt = tryBreak(previous, input, corridor, config, now, barIndex);
      if (breakAttempt) return breakAttempt;
      return {
        ...previous,
        phase: "idle",
        bandId: undefined,
        bandLow: undefined,
        bandHigh: undefined,
        oppositeBandId: undefined,
        oppositeLow: undefined,
        oppositeHigh: undefined,
        side: undefined,
        reason: "Price left balance corridor without OF-confirmed break.",
        updatedAt: now,
        evidence: [EVIDENCE],
      };
    }

    const breakAttempt = tryBreak(previous, input, corridor, config, now, barIndex);
    if (breakAttempt) return breakAttempt;

    return {
      ...previous,
      phase: "balance",
      bandId: corridor.supply.id,
      bandLow: corridor.supply.low,
      bandHigh: corridor.supply.high,
      oppositeBandId: corridor.demand.id,
      oppositeLow: corridor.demand.low,
      oppositeHigh: corridor.demand.high,
      reason: "Balanced between demand and supply bands.",
      updatedAt: now,
      evidence: [EVIDENCE],
    };
  }

  // Active break / retest path — use stored bands.
  if (
    previous.bandLow == null ||
    previous.bandHigh == null ||
    previous.oppositeLow == null ||
    previous.oppositeHigh == null ||
    !previous.side
  ) {
    return enterBalanceOrIdle(base, input, config, now);
  }

  const brokenBand = { low: previous.bandLow, high: previous.bandHigh };
  const opposite = { low: previous.oppositeLow, high: previous.oppositeHigh };
  const close = last?.close ?? input.lastPrice;

  if (isThroughOpposite(previous.side, close, opposite)) {
    return {
      ...previous,
      phase: "invalidated",
      reason:
        previous.side === "bullish"
          ? "Close accepted through opposite demand band (LSK-style invalidation)."
          : "Close accepted through opposite supply band (LSK-style invalidation).",
      updatedAt: now,
      evidence: [EVIDENCE],
    };
  }

  if (previous.phase === "broken") {
    const barsSince = barIndex - (previous.brokenBarIndex ?? barIndex);
    if (barsSince > config.retestMaxBars) {
      return {
        ...previous,
        phase: "failed",
        reason: "Retest window expired without return to broken band.",
        updatedAt: now,
        evidence: [EVIDENCE],
      };
    }

    if (touchesBand(input.lastPrice, last, brokenBand)) {
      return {
        ...previous,
        phase: "retesting",
        retestAt: now,
        reason: "Price returned to broken band — awaiting reclaim hold + OF.",
        updatedAt: now,
        evidence: [EVIDENCE],
      };
    }

    return {
      ...previous,
      reason: "Waiting for retest of broken band.",
      updatedAt: now,
      evidence: [EVIDENCE],
    };
  }

  if (previous.phase === "retesting") {
    const barsSince = barIndex - (previous.brokenBarIndex ?? barIndex);
    if (barsSince > config.retestMaxBars) {
      return {
        ...previous,
        phase: "failed",
        reason: "Retest window expired without accepted reclaim.",
        updatedAt: now,
        evidence: [EVIDENCE],
      };
    }

    const midRange = (brokenBand.low + opposite.high) / 2;
    // Lost reclaim: closed back through range mid without holding break side.
    if (previous.side === "bullish" && close < midRange && close < brokenBand.low) {
      return {
        ...previous,
        phase: "failed",
        reason: "Lost bullish retest — close back through range mid.",
        updatedAt: now,
        evidence: [EVIDENCE],
      };
    }
    if (previous.side === "bearish" && close > midRange && close > brokenBand.high) {
      return {
        ...previous,
        phase: "failed",
        reason: "Lost bearish retest — close back through range mid.",
        updatedAt: now,
        evidence: [EVIDENCE],
      };
    }

    const reclaimed =
      previous.side === "bullish"
        ? close > brokenBand.high
        : close < brokenBand.low;
    const ofOk = ofSupports(previous.side, input.footprint, input.cvd, config);

    if (reclaimed && ofOk) {
      return {
        ...previous,
        phase: "accepted",
        acceptedAt: now,
        reason:
          previous.side === "bullish"
            ? "Bullish break + retest accepted with OF continuation."
            : "Bearish break + retest accepted with OF continuation.",
        updatedAt: now,
        evidence: [EVIDENCE],
      };
    }

    if (reclaimed && !ofOk) {
      return {
        ...previous,
        reason: "Reclaim close seen but OF continuation missing — still retesting.",
        updatedAt: now,
        evidence: [EVIDENCE],
      };
    }

    return {
      ...previous,
      reason: "Retesting broken band — waiting for reclaim close + OF.",
      updatedAt: now,
      evidence: [EVIDENCE],
    };
  }

  return enterBalanceOrIdle(base, input, config, now);
}

export function emptyBreakRetestState(symbol: string, now = Date.now()): BreakRetestState {
  return emptyState(symbol, now);
}

function emptyState(symbol: string, now: number): BreakRetestState {
  return {
    symbol: symbol.toUpperCase(),
    phase: "idle",
    reason: "No active break/retest playbook.",
    evidence: [EVIDENCE],
    updatedAt: now,
  };
}

function enterBalanceOrIdle(
  base: BreakRetestState,
  input: BreakRetestInput,
  config: BreakRetestConfig,
  now: number,
): BreakRetestState {
  const bands = input.chartOverlay?.bands ?? [];
  const demand = nearestBand(bands, "demand", input.lastPrice);
  const supply = nearestBand(bands, "supply", input.lastPrice);
  const corridor = resolveCorridor(demand, supply, config);
  if (!corridor || !isBalanced(input.candles, corridor.demand, corridor.supply, config)) {
    return {
      ...base,
      phase: "idle",
      reason: corridor
        ? "Demand/supply present but candles not balanced in corridor."
        : "Need nearest demand and supply bands for balance.",
      updatedAt: now,
      evidence: [EVIDENCE],
    };
  }
  return {
    ...base,
    phase: "balance",
    bandId: corridor.supply.id,
    bandLow: corridor.supply.low,
    bandHigh: corridor.supply.high,
    oppositeBandId: corridor.demand.id,
    oppositeLow: corridor.demand.low,
    oppositeHigh: corridor.demand.high,
    reason: "Balanced between demand and supply bands.",
    updatedAt: now,
    evidence: [EVIDENCE],
  };
}

function tryBreak(
  previous: BreakRetestState,
  input: BreakRetestInput,
  corridor: { demand: ChartZoneBand; supply: ChartZoneBand },
  config: BreakRetestConfig,
  now: number,
  barIndex: number,
): BreakRetestState | null {
  const last = input.candles[input.candles.length - 1];
  if (!last) return null;
  const close = last.close;

  if (close > corridor.supply.high && ofSupports("bullish", input.footprint, input.cvd, config)) {
    return {
      ...previous,
      phase: "broken",
      side: "bullish",
      bandId: corridor.supply.id,
      bandLow: corridor.supply.low,
      bandHigh: corridor.supply.high,
      oppositeBandId: corridor.demand.id,
      oppositeLow: corridor.demand.low,
      oppositeHigh: corridor.demand.high,
      brokenAt: now,
      brokenBarIndex: barIndex,
      breakPrice: close,
      reason: "Bullish close beyond supply with OF continuation.",
      updatedAt: now,
      evidence: [EVIDENCE],
    };
  }

  if (close < corridor.demand.low && ofSupports("bearish", input.footprint, input.cvd, config)) {
    return {
      ...previous,
      phase: "broken",
      side: "bearish",
      bandId: corridor.demand.id,
      bandLow: corridor.demand.low,
      bandHigh: corridor.demand.high,
      oppositeBandId: corridor.supply.id,
      oppositeLow: corridor.supply.low,
      oppositeHigh: corridor.supply.high,
      brokenAt: now,
      brokenBarIndex: barIndex,
      breakPrice: close,
      reason: "Bearish close beyond demand with OF continuation.",
      updatedAt: now,
      evidence: [EVIDENCE],
    };
  }

  return null;
}

function resolveCorridor(
  demand: ChartZoneBand | null,
  supply: ChartZoneBand | null,
  config: BreakRetestConfig,
): { demand: ChartZoneBand; supply: ChartZoneBand } | null {
  if (!demand || !supply) return null;
  if (!(supply.low > demand.high)) return null;
  const mid = (demand.high + supply.low) / 2;
  const height = supply.low - demand.high;
  if (mid <= 0 || height / mid > config.maxRangePct) return null;
  return { demand, supply };
}

function isBalanced(
  candles: Candle[],
  demand: ChartZoneBand,
  supply: ChartZoneBand,
  config: BreakRetestConfig,
): boolean {
  if (candles.length < config.balanceBars) return false;
  const window = candles.slice(-config.balanceBars);
  const floor = demand.high;
  const ceiling = supply.low;
  if (!(ceiling > floor)) return false;
  return window.every((c) => c.close >= floor && c.close <= ceiling);
}

function nearestBand(
  bands: ChartZoneBand[],
  kind: "demand" | "supply",
  lastPrice: number,
): ChartZoneBand | null {
  const pool = bands.filter((b) => b.kind === kind || (b.kind === "balance" && sideOfBalance(b, lastPrice) === kind));
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

function touchesBand(
  lastPrice: number,
  last: Candle | undefined,
  band: { low: number; high: number },
): boolean {
  if (lastPrice >= band.low && lastPrice <= band.high) return true;
  if (!last) return false;
  return last.low <= band.high && last.high >= band.low;
}

function isThroughOpposite(
  side: "bullish" | "bearish",
  close: number,
  opposite: { low: number; high: number },
): boolean {
  if (side === "bullish") return close < opposite.low;
  return close > opposite.high;
}

export function ofSupports(
  side: "bullish" | "bearish",
  footprint: FootprintBar | null | undefined,
  cvd: CvdState | null | undefined,
  config: BreakRetestConfig,
): boolean {
  const delta = footprint?.totalDelta;
  if (delta != null && Math.abs(delta) >= config.minDeltaAbs) {
    if (side === "bullish" && delta > 0) return true;
    if (side === "bearish" && delta < 0) return true;
  }
  return cvdSlopeSupports(side, cvd, config.cvdSlopePoints);
}

function cvdSlopeSupports(
  side: "bullish" | "bearish",
  cvd: CvdState | null | undefined,
  points: number,
): boolean {
  const pts = cvd?.points ?? [];
  if (pts.length < Math.max(4, Math.floor(points / 2))) return false;
  const window = pts.slice(-points);
  const first = window[0]!.cvd;
  const last = window[window.length - 1]!.cvd;
  const diff = last - first;
  if (side === "bullish") return diff > 0;
  return diff < 0;
}

/** Short UI label for playbook phase. */
export function breakRetestPhaseLabel(phase: BreakRetestPhase): string {
  switch (phase) {
    case "balance":
      return "BAL";
    case "broken":
      return "BRK";
    case "retesting":
      return "RT";
    case "accepted":
      return "ACC";
    case "failed":
      return "FAIL";
    case "invalidated":
      return "INV";
    default:
      return "IDLE";
  }
}

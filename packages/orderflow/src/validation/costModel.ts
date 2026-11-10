export interface CostModelConfig {
  /** Round-trip fee in basis points applied to notional of entry+exit. */
  feeBps: number;
  /** One-way slippage in basis points. */
  slippageBps: number;
  /**
   * Funding rate per 8h interval (decimal, e.g. 0.0001 = 1 bp).
   * Applied as |rate| * holdIntervals for perpetual paper PnL.
   * Sign: positive rate costs longs / pays shorts (typical when rate > 0).
   */
  fundingRatePer8h: number;
}

export const DEFAULT_COST_MODEL: CostModelConfig = {
  feeBps: 4,
  slippageBps: 1,
  fundingRatePer8h: 0,
};

export interface CostedFill {
  entryFill: number;
  exitFill: number;
  grossPnlPerUnit: number;
  feesPerUnit: number;
  fundingPerUnit: number;
  netPnlPerUnit: number;
  /** R multiple vs initial stop distance (null if stop missing/zero). */
  rMultiple: number | null;
}

/** Apply adverse slippage to entry/exit for the side. */
export function applySlippage(
  price: number,
  side: "LONG" | "SHORT",
  leg: "entry" | "exit",
  slippageBps: number,
): number {
  const slip = (price * slippageBps) / 10_000;
  if (side === "LONG") return leg === "entry" ? price + slip : price - slip;
  return leg === "entry" ? price - slip : price + slip;
}

/**
 * Net PnL per 1 unit of base after fees, slippage, and optional funding.
 * Partial TP: pass the fraction of size closed (0–1); funding uses full hold.
 */
export function computeCostedPnl(args: {
  side: "LONG" | "SHORT";
  entry: number;
  exit: number;
  stopLoss?: number | null;
  openedAt: number;
  closedAt: number;
  sizeFraction?: number;
  config?: CostModelConfig;
}): CostedFill {
  const config = args.config ?? DEFAULT_COST_MODEL;
  const frac = args.sizeFraction ?? 1;
  const entryFill = applySlippage(args.entry, args.side, "entry", config.slippageBps);
  const exitFill = applySlippage(args.exit, args.side, "exit", config.slippageBps);
  const dir = args.side === "LONG" ? 1 : -1;
  const grossPnlPerUnit = (exitFill - entryFill) * dir * frac;
  const feesPerUnit = ((entryFill + exitFill) * config.feeBps) / 10_000 * frac;
  const holdMs = Math.max(0, args.closedAt - args.openedAt);
  const intervals = holdMs / (8 * 60 * 60_000);
  // Positive funding rate: longs pay; shorts receive.
  const fundingSign = args.side === "LONG" ? -1 : 1;
  const fundingPerUnit =
    fundingSign * config.fundingRatePer8h * intervals * ((entryFill + exitFill) / 2) * frac;
  const netPnlPerUnit = grossPnlPerUnit - feesPerUnit + fundingPerUnit;

  let rMultiple: number | null = null;
  if (args.stopLoss != null && args.stopLoss !== args.entry) {
    const risk = Math.abs(args.entry - args.stopLoss);
    if (risk > 0) rMultiple = netPnlPerUnit / risk;
  }

  return {
    entryFill,
    exitFill,
    grossPnlPerUnit,
    feesPerUnit,
    fundingPerUnit,
    netPnlPerUnit,
    rMultiple,
  };
}

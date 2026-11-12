import type {
  PlaceOrderRequest,
  Position,
  RiskConfig,
  Side,
  SizingProfile,
} from "@of/shared";

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
  quantity: number;
  riskAmount: number;
}

export interface SizingProfileResolved {
  riskPercentPerTrade: number;
  minEntryGrade: "A+" | "STANDARD";
}

/** Phase 12: map sizing profile → risk % + minimum entry grade. */
export function resolveSizingProfile(
  profile: SizingProfile = "standard",
): SizingProfileResolved {
  switch (profile) {
    case "conservative":
      return { riskPercentPerTrade: 0.25, minEntryGrade: "A+" };
    case "aggressive":
      return { riskPercentPerTrade: 1.0, minEntryGrade: "STANDARD" };
    default:
      return { riskPercentPerTrade: 0.5, minEntryGrade: "STANDARD" };
  }
}

/** Apply profile defaults onto a risk config (keeps explicit overrides). */
export function applySizingProfile(
  config: RiskConfig,
  profile: SizingProfile,
): RiskConfig {
  const resolved = resolveSizingProfile(profile);
  return {
    ...config,
    sizingProfile: profile,
    riskPercentPerTrade: resolved.riskPercentPerTrade,
    minEntryGrade: resolved.minEntryGrade,
  };
}

export function calculatePositionSize(
  equity: number,
  riskPercent: number,
  entry: number,
  stop: number,
  contractValuePerPriceUnit = 1,
): { quantity: number; riskAmount: number } {
  const riskAmount = equity * (riskPercent / 100);
  const stopDistance = Math.abs(entry - stop);
  if (stopDistance <= 0) return { quantity: 0, riskAmount };
  const quantity = riskAmount / (stopDistance * contractValuePerPriceUnit);
  return { quantity: floorQty(quantity), riskAmount };
}

export function validateOrderRisk(params: {
  config: RiskConfig;
  request: PlaceOrderRequest;
  entry: number;
  stop?: number;
  takeProfit?: number;
  openPositions: Position[];
  dayPnl: number;
  peakEquity: number;
  /** Signal entry grade when placing from a setup. */
  entryGrade?: "A+" | "STANDARD" | "WAIT";
}): RiskDecision {
  const { config, request, entry, stop, takeProfit, openPositions, dayPnl, peakEquity } = params;

  if (config.emergencyShutdown) {
    return { allowed: false, reason: "Emergency shutdown is active.", quantity: 0, riskAmount: 0 };
  }
  if (!config.tradingEnabled) {
    return { allowed: false, reason: "Trading disabled in risk config.", quantity: 0, riskAmount: 0 };
  }
  if (openPositions.length >= config.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max open positions (${config.maxOpenPositions}) reached.`,
      quantity: 0,
      riskAmount: 0,
    };
  }

  const dayLossPct = (-dayPnl / Math.max(config.accountEquity, 1)) * 100;
  if (dayPnl < 0 && dayLossPct >= config.maxDailyLossPercent) {
    return {
      allowed: false,
      reason: `Max daily loss ${config.maxDailyLossPercent}% breached.`,
      quantity: 0,
      riskAmount: 0,
    };
  }

  const dd = ((peakEquity - config.accountEquity) / Math.max(peakEquity, 1)) * 100;
  if (dd >= config.maxDrawdownPercent) {
    return {
      allowed: false,
      reason: `Max drawdown ${config.maxDrawdownPercent}% breached.`,
      quantity: 0,
      riskAmount: 0,
    };
  }

  if (config.allowedSessionsUtc?.length) {
    const hour = new Date().getUTCHours();
    const ok = config.allowedSessionsUtc.some((s) => hour >= s.startHour && hour < s.endHour);
    if (!ok) {
      return { allowed: false, reason: "Outside allowed trading session (UTC).", quantity: 0, riskAmount: 0 };
    }
  }

  const profile = resolveSizingProfile(config.sizingProfile ?? "standard");
  const minGrade = config.minEntryGrade ?? profile.minEntryGrade;
  const grade = params.entryGrade;
  if (grade === "WAIT") {
    return {
      allowed: false,
      reason: "WAIT entry grade — no executable setup.",
      quantity: 0,
      riskAmount: 0,
    };
  }
  if (minGrade === "A+" && grade != null && grade !== "A+") {
    return {
      allowed: false,
      reason: "Sizing profile requires A+ entry grade.",
      quantity: 0,
      riskAmount: 0,
    };
  }
  if (minGrade === "A+" && grade == null) {
    return {
      allowed: false,
      reason: "Conservative sizing requires A+ entry grade on the signal.",
      quantity: 0,
      riskAmount: 0,
    };
  }

  if (stop == null || stop <= 0) {
    return { allowed: false, reason: "Stop-loss is required.", quantity: 0, riskAmount: 0 };
  }

  const side: Side = request.side;
  if (side === "BUY" && stop >= entry) {
    return { allowed: false, reason: "BUY stop must be below entry.", quantity: 0, riskAmount: 0 };
  }
  if (side === "SELL" && stop <= entry) {
    return { allowed: false, reason: "SELL stop must be above entry.", quantity: 0, riskAmount: 0 };
  }

  if (takeProfit != null) {
    const reward = Math.abs(takeProfit - entry);
    const risk = Math.abs(entry - stop);
    const rr = risk === 0 ? 0 : reward / risk;
    if (rr < config.minRiskReward) {
      return {
        allowed: false,
        reason: `Risk-reward ${rr.toFixed(2)} below minimum ${config.minRiskReward}.`,
        quantity: 0,
        riskAmount: 0,
      };
    }
  }

  const riskPct =
    config.riskPercentPerTrade > 0
      ? config.riskPercentPerTrade
      : profile.riskPercentPerTrade;

  const sized = calculatePositionSize(config.accountEquity, riskPct, entry, stop);

  const qty =
    request.quantity > 0 ? Math.min(request.quantity, sized.quantity || request.quantity) : sized.quantity;
  if (qty <= 0) {
    return { allowed: false, reason: "Calculated quantity is zero.", quantity: 0, riskAmount: sized.riskAmount };
  }

  return { allowed: true, quantity: qty, riskAmount: sized.riskAmount };
}

function floorQty(q: number): number {
  if (q <= 0) return 0;
  if (q >= 1) return Math.floor(q * 1000) / 1000;
  // small crypto sizes
  return Math.floor(q * 1_000_000) / 1_000_000;
}

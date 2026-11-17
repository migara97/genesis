import type { TradingSignal } from "@of/shared";
import type { SignalNotifyEventType } from "./outbox.js";

export interface FormatContext {
  exchange: string;
  primaryInterval: string;
  price: number;
  eventType: SignalNotifyEventType;
}

function fmt(n: number | undefined | null, digits = 6): string {
  if (n == null || !Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 100) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(digits);
}

function pickReasons(signal: TradingSignal, needles: string[], limit = 3): string[] {
  const pool = [...signal.reasonsFor, ...(signal.entryQualityNotes ?? [])];
  const hits = pool.filter((r) => needles.some((n) => r.toLowerCase().includes(n)));
  return (hits.length ? hits : pool).slice(0, limit);
}

function mtfLine(signal: TradingSignal): string {
  const mtfNotes = signal.reasonsFor.filter((r) => /HTF|TF|timeframe|15m|1h|4h|1d|5m|1m/i.test(r));
  const conf = signal.confirmations.filter((c) => c.startsWith("mtf_"));
  if (mtfNotes.length) return mtfNotes.slice(0, 2).join(" | ");
  if (conf.length) return conf.join(", ");
  return "-";
}

function ofLine(signal: TradingSignal): string {
  const parts: string[] = [];
  if (signal.orderFlowOk) parts.push("OF trigger OK");
  if (signal.deltaOk) parts.push("Delta confirmed");
  else parts.push("Delta waiting");
  const fp = pickReasons(signal, ["footprint", "stacked", "imbalance", "bar delta"]);
  if (fp.length) parts.push(fp[0]!);
  return parts.join(" · ") || "-";
}

function structureLine(signal: TradingSignal): string {
  const s = pickReasons(signal, ["structure", "bos", "choch", "trend", "fvg", "ob", "sweep"]);
  return s[0] ?? (signal.structureOk ? "Structure confirmed" : "-");
}

function volumeLine(signal: TradingSignal): string {
  const v = pickReasons(signal, ["poc", "vah", "val", "hvn", "lvn", "value area", "volume"]);
  return v[0] ?? (signal.volumeOk ? "Volume confirmed" : "-");
}

function headerFor(eventType: SignalNotifyEventType, direction: string): string {
  switch (eventType) {
    case "HQ_BUY":
      return "HIGH-QUALITY BUY SIGNAL";
    case "HQ_SELL":
      return "HIGH-QUALITY SELL SIGNAL";
    case "ENTRY_ZONE_APPROACHING":
      return "ENTRY ZONE APPROACHING";
    case "ENTRY_CONFIRMED":
      return direction === "SHORT"
        ? "ENTRY CONFIRMED — SELL"
        : "ENTRY CONFIRMED — BUY";
    case "SIGNAL_INVALIDATED":
      return "SIGNAL INVALIDATED";
    case "TAKE_PROFIT_REACHED":
      return "TAKE-PROFIT REACHED";
    case "STOP_LOSS_REACHED":
      return "STOP-LOSS REACHED";
    case "SIGNAL_EXPIRED":
      return "SIGNAL EXPIRED";
    default:
      return "SIGNAL ALERT";
  }
}

function statusFor(eventType: SignalNotifyEventType): string {
  if (eventType === "ENTRY_ZONE_APPROACHING") return "WAITING FOR ENTRY (not confirmed)";
  if (eventType === "HQ_BUY" || eventType === "HQ_SELL" || eventType === "ENTRY_CONFIRMED") {
    return "ENTRY CONFIRMED";
  }
  if (eventType === "TAKE_PROFIT_REACHED") return "TP HIT";
  if (eventType === "STOP_LOSS_REACHED") return "SL HIT";
  if (eventType === "SIGNAL_INVALIDATED") return "INVALIDATED";
  if (eventType === "SIGNAL_EXPIRED") return "EXPIRED / TIMEOUT";
  return eventType;
}

/** Build human-readable alert body from actual signal fields only. */
export function formatSignalNotification(
  signal: TradingSignal,
  ctx: FormatContext,
): { title: string; message: string } {
  const title = headerFor(ctx.eventType, signal.direction);
  const tps = signal.takeProfit ?? [];
  const lines: string[] = [
    title,
    "",
    `Coin: ${signal.symbol}`,
    `Exchange: ${ctx.exchange}`,
    `Direction: ${signal.direction}`,
    `Signal Time: ${new Date(signal.timestamp).toISOString()}`,
    `Primary Timeframe: ${ctx.primaryInterval}`,
    `Setup: ${signal.setupId.slice(0, 12)}`,
    "",
    "ENTRY DETAILS:",
    `- Entry Price: ${signal.entry != null ? fmt(signal.entry) : "-"}`,
    `- Stop-Loss: ${signal.stopLoss != null ? fmt(signal.stopLoss) : "-"}`,
    `- Take Profit 1: ${tps[0] != null ? fmt(tps[0]) : "-"}`,
    `- Take Profit 2: ${tps[1] != null ? fmt(tps[1]) : "-"}`,
    `- Take Profit 3: ${tps[2] != null ? fmt(tps[2]) : "-"}`,
    `- Risk/Reward: ${signal.riskReward != null ? `${signal.riskReward.toFixed(2)}R` : "-"}`,
    `- Last Price: ${fmt(ctx.price)}`,
    "",
    "ORDER FLOW CONFIRMATION:",
    `- Footprint / OF: ${ofLine(signal)}`,
    `- CVD / Delta: ${signal.deltaOk ? "confirmed" : "waiting (no CVD divergence)"}`,
    `- Volume Profile: ${volumeLine(signal)}`,
    `- Market Structure: ${structureLine(signal)}`,
    `- MTF: ${mtfLine(signal)}`,
    "",
    "SIGNAL QUALITY:",
    `- Entry Grade: ${signal.entryGrade}`,
    `- Model score: ${(signal.confidence * 100).toFixed(0)}% (model score, not win rate)`,
    `- Long/Short scores: ${signal.score.longScore} / ${signal.score.shortScore}`,
    `- Families: ${signal.score.independentFamilies.join(", ") || "-"}`,
    `- Lifecycle: ${signal.lifecycle}`,
    signal.tpHits != null && signal.tpHits > 0 ? `- TP hits: ${signal.tpHits}` : null,
    "",
    `STATUS: ${statusFor(ctx.eventType)}`,
    "",
    "PAPER TRADING ONLY — no automatic real-money execution.",
  ].filter((x): x is string => x != null);

  return { title, message: lines.join("\n") };
}

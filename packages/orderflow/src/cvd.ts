import type { CvdPoint, CvdState, TradeTick } from "@of/shared";

export function createCvdState(symbol: string, sessionStart: number): CvdState {
  return {
    symbol,
    sessionStart,
    cvd: 0,
    points: [],
    divergence: "none",
    exhaustion: false,
    evidence: [
      {
        kind: "exchange_reported",
        note: "Delta uses exchange aggressor flags when available; otherwise tick-rule inference is labeled.",
      },
    ],
  };
}

export function applyTradeToCvd(state: CvdState, trade: TradeTick, maxPoints = 2000): CvdState {
  const delta = trade.buyerAggressor ? trade.quantity : -trade.quantity;
  const cvd = state.cvd + delta;
  const point: CvdPoint = {
    timestamp: trade.timestamp,
    price: trade.price,
    delta,
    cvd,
  };
  const points = [...state.points, point];
  if (points.length > maxPoints) points.splice(0, points.length - maxPoints);
  const divergence = detectDivergence(points);
  const exhaustion = detectDeltaExhaustion(points);
  return { ...state, cvd, points, divergence, exhaustion };
}

function detectDivergence(points: CvdPoint[]): "bullish" | "bearish" | "none" {
  if (points.length < 40) return "none";
  const window = points.slice(-40);
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const priceUp = last.price > first.price * 1.0005;
  const priceDown = last.price < first.price * 0.9995;
  const cvdUp = last.cvd > first.cvd;
  const cvdDown = last.cvd < first.cvd;
  if (priceUp && cvdDown) return "bearish";
  if (priceDown && cvdUp) return "bullish";
  return "none";
}

function detectDeltaExhaustion(points: CvdPoint[]): boolean {
  if (points.length < 20) return false;
  const recent = points.slice(-20);
  const early = recent.slice(0, 10).reduce((s, p) => s + Math.abs(p.delta), 0);
  const late = recent.slice(10).reduce((s, p) => s + Math.abs(p.delta), 0);
  const net = recent.reduce((s, p) => s + p.delta, 0);
  // Absolute activity fades while net delta stalls
  return early > 0 && late / early < 0.45 && Math.abs(net) / Math.max(early + late, 1e-12) < 0.1;
}

export function sessionCvdTrend(state: CvdState): "up" | "down" | "flat" {
  if (state.points.length < 2) return "flat";
  const first = state.points[0]!.cvd;
  const last = state.points[state.points.length - 1]!.cvd;
  const diff = last - first;
  const scale = Math.max(Math.abs(first), Math.abs(last), 1);
  if (diff / scale > 0.02) return "up";
  if (diff / scale < -0.02) return "down";
  return "flat";
}

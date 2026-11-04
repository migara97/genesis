import type { BookLevel, DomMetrics, OrderBookSnapshot } from "@of/shared";
import { safeDiv } from "./math.js";

export interface DomOptions {
  largeLiquidityMultiple?: number;
  topLevels?: number;
}

let priorBidLiq = new Map<string, number>();
let priorAskLiq = new Map<string, number>();

export function computeDomMetrics(
  book: OrderBookSnapshot,
  options: DomOptions = {},
): DomMetrics {
  const topN = options.topLevels ?? 20;
  const multiple = options.largeLiquidityMultiple ?? 4;
  const bids = book.bids.slice(0, topN);
  const asks = book.asks.slice(0, topN);
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const bidLiquidity = bids.reduce((s, l) => s + l.quantity, 0);
  const askLiquidity = asks.reduce((s, l) => s + l.quantity, 0);
  const imbalance = safeDiv(bidLiquidity - askLiquidity, bidLiquidity + askLiquidity);
  const avgBid = safeDiv(bidLiquidity, Math.max(bids.length, 1));
  const avgAsk = safeDiv(askLiquidity, Math.max(asks.length, 1));

  const largeBidLevels = bids.filter((l) => l.quantity >= avgBid * multiple);
  const largeAskLevels = asks.filter((l) => l.quantity >= avgAsk * multiple);

  const prevBid = priorBidLiq.get(book.symbol) ?? bidLiquidity;
  const prevAsk = priorAskLiq.get(book.symbol) ?? askLiquidity;
  priorBidLiq.set(book.symbol, bidLiquidity);
  priorAskLiq.set(book.symbol, askLiquidity);

  const bidChange = safeDiv(bidLiquidity - prevBid, Math.max(prevBid, 1e-12));
  const askChange = safeDiv(askLiquidity - prevAsk, Math.max(prevAsk, 1e-12));

  let pullStackHint: DomMetrics["pullStackHint"] = "none";
  if (bidChange > 0.15) pullStackHint = "bid_stack";
  else if (bidChange < -0.15) pullStackHint = "bid_pull";
  else if (askChange > 0.15) pullStackHint = "ask_stack";
  else if (askChange < -0.15) pullStackHint = "ask_pull";

  const spoofingRisk = estimateSpoofingRisk(largeBidLevels, largeAskLevels, pullStackHint);

  return {
    symbol: book.symbol,
    timestamp: book.timestamp,
    bestBid,
    bestAsk,
    mid: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0,
    spread: bestAsk && bestBid ? bestAsk - bestBid : 0,
    bidLiquidity,
    askLiquidity,
    imbalance,
    largeBidLevels,
    largeAskLevels,
    pullStackHint,
    spoofingRisk,
    evidence: [
      {
        kind: "exchange_reported",
        note: "Depth quantities are exchange-visible L2 only.",
      },
      {
        kind: "heuristic",
        note: "Pull/stack and spoofingRisk are uncertain heuristics — not proof of spoofing or institutional intent.",
      },
    ],
  };
}

function estimateSpoofingRisk(
  largeBids: BookLevel[],
  largeAsks: BookLevel[],
  hint: DomMetrics["pullStackHint"],
): DomMetrics["spoofingRisk"] {
  const farWall =
    largeBids.some((_, i) => i >= 5) || largeAsks.some((_, i) => i >= 5);
  if (farWall && (hint === "bid_pull" || hint === "ask_pull")) return "elevated";
  if (farWall) return "unknown";
  return "low";
}

/** Reset DOM prior liquidity (useful in tests). */
export function resetDomPriors(): void {
  priorBidLiq = new Map();
  priorAskLiq = new Map();
}

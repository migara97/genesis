import type { BookLevel, EvidenceTag, OrderBookSnapshot } from "@of/shared";

export interface IcebergRefillSignal {
  symbol: string;
  timestamp: number;
  side: "bid" | "ask" | "none";
  price: number | null;
  refillCount: number;
  confidence: number;
  note: string;
  evidence: EvidenceTag[];
}

interface LevelHist {
  qty: number;
  refillCount: number;
  lastSeen: number;
}

/** Per-symbol price→level history for refill detection. */
const histories = new Map<string, Map<number, LevelHist>>();

export interface IcebergOptions {
  /** Min consecutive refill events at same price to flag. */
  minRefills?: number;
  /** Qty must recover to this fraction of prior after a pull. */
  refillRatio?: number;
  /** Max levels from touch to consider. */
  topLevels?: number;
}

/**
 * Heuristic iceberg/refill detector from successive L2 snapshots.
 * Visible size disappearing then reappearing at the same price is labeled
 * heuristic — never exchange iceberg flags or institutional identity.
 */
export function detectIcebergRefill(
  book: OrderBookSnapshot,
  options: IcebergOptions = {},
): IcebergRefillSignal {
  const minRefills = options.minRefills ?? 2;
  const refillRatio = options.refillRatio ?? 0.7;
  const topN = options.topLevels ?? 10;
  const evidence: EvidenceTag[] = [
    {
      kind: "heuristic",
      note: "Iceberg/refill uses visible L2 size changes only — not exchange iceberg flags and not institutional identity.",
    },
  ];

  let map = histories.get(book.symbol);
  if (!map) {
    map = new Map();
    histories.set(book.symbol, map);
  }

  const now = book.timestamp || Date.now();
  type BestHit = { side: "bid" | "ask"; price: number; refillCount: number; score: number };
  const hits: BestHit[] = [];

  const scan = (levels: BookLevel[], side: "bid" | "ask") => {
    for (const level of levels.slice(0, topN)) {
      const key = level.price;
      const prev = map!.get(key);
      if (!prev) {
        map!.set(key, { qty: level.quantity, refillCount: 0, lastSeen: now });
        continue;
      }
      let refillCount = prev.refillCount;
      // Pull then refill: prior size drops sharply, then recovers.
      if (prev.qty > 0 && level.quantity < prev.qty * 0.35) {
        // pulled — keep refillCount, record low watermark via qty
        map!.set(key, { qty: level.quantity, refillCount, lastSeen: now });
        continue;
      }
      if (
        prev.qty > 0 &&
        level.quantity >= prev.qty * refillRatio &&
        level.quantity > prev.qty * 1.05
      ) {
        refillCount += 1;
      }
      map!.set(key, { qty: level.quantity, refillCount, lastSeen: now });
      if (refillCount >= minRefills) {
        hits.push({
          side,
          price: key,
          refillCount,
          score: Math.min(1, refillCount / (minRefills + 3)),
        });
      }
    }
  };

  scan(book.bids, "bid");
  scan(book.asks, "ask");

  // Prune stale prices
  for (const [price, hist] of map) {
    if (now - hist.lastSeen > 120_000) map.delete(price);
  }

  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];
  if (!best) {
    return {
      symbol: book.symbol,
      timestamp: now,
      side: "none",
      price: null,
      refillCount: 0,
      confidence: 0,
      note: "No refill pattern meeting heuristic thresholds.",
      evidence,
    };
  }

  return {
    symbol: book.symbol,
    timestamp: now,
    side: best.side,
    price: best.price,
    refillCount: best.refillCount,
    confidence: Number(best.score.toFixed(3)),
    note: `Heuristic ${best.side} refill ×${best.refillCount} near ${best.price} (confidence band ${best.score.toFixed(2)}).`,
    evidence,
  };
}

export function resetIcebergHistory(): void {
  histories.clear();
}

import type { FootprintBar, FootprintCell, FootprintImbalance, TradeTick } from "@of/shared";
import { roundToTick, safeDiv } from "./math.js";

export interface FootprintOptions {
  tickSize: number;
  imbalanceRatio?: number;
  stackedCount?: number;
}

interface MutableCell {
  price: number;
  bidVolume: number;
  askVolume: number;
  trades: number;
}

/**
 * Builds a footprint bar from aggressor-classified trades.
 * Bid volume = seller-initiated (hit bid). Ask volume = buyer-initiated (lifted ask).
 */
export function buildFootprintBar(
  symbol: string,
  trades: TradeTick[],
  openTime: number,
  closeTime: number,
  options: FootprintOptions,
): FootprintBar | null {
  if (trades.length === 0) return null;
  const imbalanceRatio = options.imbalanceRatio ?? 3;
  const stackedCount = options.stackedCount ?? 3;
  const map = new Map<number, MutableCell>();

  let open = trades[0]!.price;
  let high = trades[0]!.price;
  let low = trades[0]!.price;
  let close = trades[0]!.price;
  let totalDelta = 0;
  let totalVolume = 0;

  for (const t of trades) {
    const px = roundToTick(t.price, options.tickSize);
    high = Math.max(high, t.price);
    low = Math.min(low, t.price);
    close = t.price;
    totalVolume += t.quantity;
    const delta = t.buyerAggressor ? t.quantity : -t.quantity;
    totalDelta += delta;
    const cell = map.get(px) ?? { price: px, bidVolume: 0, askVolume: 0, trades: 0 };
    if (t.buyerAggressor) cell.askVolume += t.quantity;
    else cell.bidVolume += t.quantity;
    cell.trades += 1;
    map.set(px, cell);
  }

  const cells: FootprintCell[] = [...map.values()]
    .sort((a, b) => b.price - a.price)
    .map((c) => ({
      price: c.price,
      bidVolume: c.bidVolume,
      askVolume: c.askVolume,
      delta: c.askVolume - c.bidVolume,
      trades: c.trades,
    }));

  const imbalances = detectImbalances(cells, imbalanceRatio, stackedCount);
  const absorption = detectAbsorption(cells, totalDelta);
  const exhaustion = detectExhaustion(cells, close, high, low);
  const unfinishedAuction = detectUnfinishedAuction(cells, high, low);

  return {
    symbol,
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    cells,
    totalDelta,
    totalVolume,
    imbalances,
    absorption,
    exhaustion,
    unfinishedAuction,
    evidence: [
      {
        kind: "exchange_reported",
        note: "Aggressor side uses exchange trade flags when provided by the adapter.",
      },
      {
        kind: "heuristic",
        note: "Absorption/exhaustion/unfinished auction are pattern heuristics, not institutional identity.",
      },
    ],
  };
}

function detectImbalances(
  cells: FootprintCell[],
  ratio: number,
  stackedCount: number,
): FootprintImbalance[] {
  const out: FootprintImbalance[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const askRatio = safeDiv(cell.askVolume, Math.max(cell.bidVolume, 1e-12));
    const bidRatio = safeDiv(cell.bidVolume, Math.max(cell.askVolume, 1e-12));
    if (askRatio >= ratio) {
      out.push({
        price: cell.price,
        side: "ask",
        ratio: askRatio,
        stacked: false,
        diagonal: isDiagonal(cells, i, "ask", ratio),
      });
    } else if (bidRatio >= ratio) {
      out.push({
        price: cell.price,
        side: "bid",
        ratio: bidRatio,
        stacked: false,
        diagonal: isDiagonal(cells, i, "bid", ratio),
      });
    }
  }

  // Mark stacked imbalances (consecutive same-side)
  for (let i = 0; i < out.length; i++) {
    let run = 1;
    for (let j = i + 1; j < out.length; j++) {
      if (out[j]!.side === out[i]!.side) run += 1;
      else break;
    }
    if (run >= stackedCount) {
      for (let k = i; k < i + run; k++) out[k]!.stacked = true;
    }
  }
  return out;
}

function isDiagonal(
  cells: FootprintCell[],
  index: number,
  side: "bid" | "ask",
  ratio: number,
): boolean {
  // Diagonal: compare ask at price vs bid at price below (or reverse)
  const next = cells[index + 1];
  if (!next) return false;
  if (side === "ask") {
    return safeDiv(cells[index]!.askVolume, Math.max(next.bidVolume, 1e-12)) >= ratio;
  }
  return safeDiv(cells[index]!.bidVolume, Math.max(next.askVolume, 1e-12)) >= ratio;
}

function detectAbsorption(cells: FootprintCell[], totalDelta: number): boolean {
  if (cells.length < 3) return false;
  const top = [...cells].sort((a, b) => b.bidVolume + b.askVolume - (a.bidVolume + a.askVolume))[0];
  if (!top) return false;
  const nodeVol = top.bidVolume + top.askVolume;
  const total = cells.reduce((s, c) => s + c.bidVolume + c.askVolume, 0);
  // High volume node with muted net delta → possible absorption
  return nodeVol / Math.max(total, 1e-12) > 0.25 && Math.abs(totalDelta) / Math.max(total, 1e-12) < 0.15;
}

function detectExhaustion(
  cells: FootprintCell[],
  close: number,
  high: number,
  low: number,
): boolean {
  if (cells.length === 0) return false;
  const range = high - low;
  if (range <= 0) return false;
  const nearHigh = close > high - range * 0.15;
  const nearLow = close < low + range * 0.15;
  const extreme = cells.find((c) =>
    nearHigh ? c.price >= high - range * 0.1 : nearLow ? c.price <= low + range * 0.1 : false,
  );
  if (!extreme) return false;
  const vol = extreme.bidVolume + extreme.askVolume;
  const avg =
    cells.reduce((s, c) => s + c.bidVolume + c.askVolume, 0) / Math.max(cells.length, 1);
  // Thin volume at extremes after directional push
  return vol < avg * 0.4 && (nearHigh || nearLow);
}

function detectUnfinishedAuction(cells: FootprintCell[], high: number, low: number): boolean {
  const atHigh = cells.find((c) => c.price === high || Math.abs(c.price - high) < 1e-12);
  const atLow = cells.find((c) => c.price === low || Math.abs(c.price - low) < 1e-12);
  // Unfinished auction heuristic: zero opposing volume at extreme
  const highUnfinished = !!atHigh && atHigh.bidVolume === 0 && atHigh.askVolume > 0;
  const lowUnfinished = !!atLow && atLow.askVolume === 0 && atLow.bidVolume > 0;
  return highUnfinished || lowUnfinished;
}

export function highLowVolumePrices(cells: FootprintCell[]): {
  highVolume: number[];
  lowVolume: number[];
} {
  if (cells.length === 0) return { highVolume: [], lowVolume: [] };
  const vols = cells.map((c) => c.bidVolume + c.askVolume).sort((a, b) => a - b);
  const hiThresh = vols[Math.floor(vols.length * 0.8)] ?? 0;
  const loThresh = vols[Math.floor(vols.length * 0.2)] ?? 0;
  return {
    highVolume: cells.filter((c) => c.bidVolume + c.askVolume >= hiThresh).map((c) => c.price),
    lowVolume: cells.filter((c) => c.bidVolume + c.askVolume <= loThresh).map((c) => c.price),
  };
}

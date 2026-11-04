import type { TradeTick, VolumeProfile, VolumeProfileLevel } from "@of/shared";
import { percentile, roundToTick, safeDiv } from "./math.js";

export function buildVolumeProfile(
  symbol: string,
  trades: TradeTick[],
  tickSize: number,
  from?: number,
  to?: number,
): VolumeProfile | null {
  if (trades.length === 0) return null;
  const start = from ?? trades[0]!.timestamp;
  const end = to ?? trades[trades.length - 1]!.timestamp;
  const map = new Map<number, VolumeProfileLevel>();

  for (const t of trades) {
    if (t.timestamp < start || t.timestamp > end) continue;
    const price = roundToTick(t.price, tickSize);
    const level = map.get(price) ?? { price, volume: 0, buyVolume: 0, sellVolume: 0 };
    level.volume += t.quantity;
    if (t.buyerAggressor) level.buyVolume += t.quantity;
    else level.sellVolume += t.quantity;
    map.set(price, level);
  }

  const levels = [...map.values()].sort((a, b) => a.price - b.price);
  if (levels.length === 0) return null;

  const totalVolume = levels.reduce((s, l) => s + l.volume, 0);
  const pocLevel = levels.reduce((best, l) => (l.volume > best.volume ? l : best), levels[0]!);
  const { vah, val } = valueArea(levels, totalVolume, 0.7);
  const volumes = levels.map((l) => l.volume).sort((a, b) => a - b);
  const hvnThresh = percentile(volumes, 0.8);
  const lvnThresh = percentile(volumes, 0.2);

  return {
    symbol,
    from: start,
    to: end,
    tickSize,
    levels,
    poc: pocLevel.price,
    vah,
    val,
    hvn: levels.filter((l) => l.volume >= hvnThresh).map((l) => l.price),
    lvn: levels.filter((l) => l.volume <= lvnThresh).map((l) => l.price),
    totalVolume,
  };
}

function valueArea(
  levels: VolumeProfileLevel[],
  totalVolume: number,
  pct: number,
): { vah: number; val: number } {
  if (levels.length === 0) return { vah: 0, val: 0 };
  const pocIdx = levels.reduce(
    (bestIdx, l, i, arr) => (l.volume > arr[bestIdx]!.volume ? i : bestIdx),
    0,
  );
  let vol = levels[pocIdx]!.volume;
  let lo = pocIdx;
  let hi = pocIdx;
  const target = totalVolume * pct;

  while (vol < target && (lo > 0 || hi < levels.length - 1)) {
    const nextLo = lo > 0 ? levels[lo - 1]!.volume : -1;
    const nextHi = hi < levels.length - 1 ? levels[hi + 1]!.volume : -1;
    if (nextHi >= nextLo) {
      hi += 1;
      vol += levels[hi]!.volume;
    } else {
      lo -= 1;
      vol += levels[lo]!.volume;
    }
  }

  return { vah: levels[hi]!.price, val: levels[lo]!.price };
}

export function fixedRangeVolumeProfile(
  symbol: string,
  trades: TradeTick[],
  tickSize: number,
  fromPrice: number,
  toPrice: number,
): VolumeProfile | null {
  const filtered = trades.filter((t) => t.price >= fromPrice && t.price <= toPrice);
  const profile = buildVolumeProfile(symbol, filtered, tickSize);
  if (!profile) return null;
  // Keep only levels inside range (already filtered by trades) — annotate via total
  void safeDiv;
  return profile;
}

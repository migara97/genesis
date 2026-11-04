export function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

export function safeDiv(n: number, d: number): number {
  if (d === 0) return 0;
  return n / d;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[idx]!;
}

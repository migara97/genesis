import type { BookLevel } from "./types";

export function DepthChart({ bids, asks }: { bids: BookLevel[]; asks: BookLevel[] }) {
  const bid = cumulative(bids);
  const ask = cumulative(asks);
  const max = Math.max(bid[bid.length - 1]?.cum ?? 0, ask[ask.length - 1]?.cum ?? 0, 1);
  return (
    <svg className="depth-chart" viewBox="0 0 200 48" preserveAspectRatio="none" aria-label="Market depth">
      <polyline fill="none" stroke="#0ecb81" strokeWidth="1.5" points={path(bid, max, true)} />
      <polyline fill="none" stroke="#f6465d" strokeWidth="1.5" points={path(ask, max, false)} />
    </svg>
  );
}

function cumulative(levels: BookLevel[]): { cum: number }[] {
  let cum = 0;
  return levels.slice(0, 15).map((level) => {
    cum += level.quantity;
    return { cum };
  });
}

function path(levels: { cum: number }[], max: number, fromLeft: boolean): string {
  if (!levels.length) return "";
  return levels
    .map((level, index) => {
      const t = levels.length === 1 ? 1 : index / (levels.length - 1);
      const x = fromLeft ? t * 100 : 100 + t * 100;
      const y = 46 - (level.cum / max) * 44;
      return `${x},${y}`;
    })
    .join(" ");
}

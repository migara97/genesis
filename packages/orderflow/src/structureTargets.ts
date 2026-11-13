import { createHash } from "node:crypto";
import type {
  BreakRetestState,
  MarketStructureState,
  StructureTarget,
  StructureTargetKind,
  VolumeProfile,
} from "@of/shared";

export interface StructureTargetsConfig {
  maxTargets: number;
  /** Drop targets farther than this fraction of entry. */
  maxDistancePct: number;
  /** Drop targets closer than this fraction of entry (avoids near-entry auto-hits). */
  minDistancePct: number;
  /** Merge targets closer than max(tickSize, entry * this). */
  dedupePct: number;
}

export const DEFAULT_STRUCTURE_TARGETS_CONFIG: StructureTargetsConfig = {
  maxTargets: 3,
  maxDistancePct: 0.15,
  minDistancePct: 0.001,
  dedupePct: 0.0005,
};

const KIND_PRIORITY: Record<StructureTargetKind, number> = {
  measured_move: 4,
  prior_swing: 3,
  vp_node: 2,
  session_extreme: 1,
};

/**
 * Build Phase-C geometry structure targets beyond entry.
 * Informational only — R-multiple takeProfit remains the exit path.
 */
export function buildStructureTargets(args: {
  side: "LONG" | "SHORT";
  entry: number;
  breakRetest?: BreakRetestState | null;
  structure?: MarketStructureState | null;
  volumeProfile?: VolumeProfile | null;
  tickSize?: number;
  config?: Partial<StructureTargetsConfig>;
}): StructureTarget[] {
  const config = { ...DEFAULT_STRUCTURE_TARGETS_CONFIG, ...args.config };
  const entry = args.entry;
  if (!(entry > 0) || !Number.isFinite(entry)) return [];

  const tick = args.tickSize && args.tickSize > 0 ? args.tickSize : entry * 1e-6;
  const candidates: StructureTarget[] = [];

  const mm = measuredMoveTarget(args.side, entry, args.breakRetest);
  if (mm) candidates.push(mm);

  const swing = priorSwingTarget(args.side, entry, args.structure, config.minDistancePct);
  if (swing) candidates.push(swing);

  const session = sessionExtremeTarget(args.side, entry, args.structure);
  if (session) candidates.push(session);

  const vp = vpNodeTarget(args.side, entry, args.volumeProfile);
  if (vp) candidates.push(vp);

  const filtered = candidates.filter((t) => {
    if (args.side === "LONG" && !(t.price > entry)) return false;
    if (args.side === "SHORT" && !(t.price < entry)) return false;
    if (t.distancePct < config.minDistancePct) return false;
    if (t.distancePct > config.maxDistancePct) return false;
    return Number.isFinite(t.price);
  });

  const deduped = dedupeTargets(filtered, entry, tick, config.dedupePct);
  deduped.sort((a, b) => a.distancePct - b.distancePct || KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind]);
  return deduped.slice(0, config.maxTargets);
}

function measuredMoveTarget(
  side: "LONG" | "SHORT",
  entry: number,
  breakRetest?: BreakRetestState | null,
): StructureTarget | null {
  if (!breakRetest?.side) return null;
  if (breakRetest.bandLow == null || breakRetest.bandHigh == null) return null;
  if (breakRetest.oppositeLow == null || breakRetest.oppositeHigh == null) return null;

  // Bull break of supply: range = supply high − demand low; project above supply.
  // Bear break of demand: range = supply high − demand low; project below demand.
  const bullish = breakRetest.side === "bullish";
  if (side === "LONG" && !bullish) return null;
  if (side === "SHORT" && bullish) return null;

  const rangeHigh = Math.max(breakRetest.bandHigh, breakRetest.oppositeHigh);
  const rangeLow = Math.min(breakRetest.bandLow, breakRetest.oppositeLow);
  const height = rangeHigh - rangeLow;
  if (!(height > 0)) return null;

  const price = bullish ? breakRetest.bandHigh + height : breakRetest.bandLow - height;
  return makeTarget("measured_move", price, entry, `MM ${fmtPx(height)} range projection`);
}

function priorSwingTarget(
  side: "LONG" | "SHORT",
  entry: number,
  structure?: MarketStructureState | null,
  minDistancePct = 0,
): StructureTarget | null {
  const swings = structure?.swings ?? [];
  if (swings.length === 0) return null;
  const farEnough = (price: number) => Math.abs(price - entry) / entry >= minDistancePct;

  if (side === "LONG") {
    const highs = swings
      .filter((s) => s.kind === "high" && s.price > entry && farEnough(s.price))
      .sort((a, b) => a.price - b.price);
    const hit = highs[0];
    if (!hit) return null;
    return makeTarget("prior_swing", hit.price, entry, `Prior swing high ${fmtPx(hit.price)}`);
  }

  const lows = swings
    .filter((s) => s.kind === "low" && s.price < entry && farEnough(s.price))
    .sort((a, b) => b.price - a.price);
  const hit = lows[0];
  if (!hit) return null;
  return makeTarget("prior_swing", hit.price, entry, `Prior swing low ${fmtPx(hit.price)}`);
}

function sessionExtremeTarget(
  side: "LONG" | "SHORT",
  entry: number,
  structure?: MarketStructureState | null,
): StructureTarget | null {
  if (side === "LONG") {
    const hi = structure?.previousSessionHigh;
    if (hi == null || !(hi > entry)) return null;
    return makeTarget("session_extreme", hi, entry, `Prev session high ${fmtPx(hi)}`);
  }
  const lo = structure?.previousSessionLow;
  if (lo == null || !(lo < entry)) return null;
  return makeTarget("session_extreme", lo, entry, `Prev session low ${fmtPx(lo)}`);
}

function vpNodeTarget(
  side: "LONG" | "SHORT",
  entry: number,
  profile?: VolumeProfile | null,
): StructureTarget | null {
  if (!profile) return null;

  if (side === "LONG") {
    if (profile.vah != null && profile.vah > entry) {
      return makeTarget("vp_node", profile.vah, entry, `VAH ${fmtPx(profile.vah)}`);
    }
    const hvn = (profile.hvn ?? [])
      .filter((p) => p > entry)
      .sort((a, b) => a - b)[0];
    if (hvn == null) return null;
    return makeTarget("vp_node", hvn, entry, `HVN ${fmtPx(hvn)}`);
  }

  if (profile.val != null && profile.val < entry) {
    return makeTarget("vp_node", profile.val, entry, `VAL ${fmtPx(profile.val)}`);
  }
  const hvn = (profile.hvn ?? [])
    .filter((p) => p < entry)
    .sort((a, b) => b - a)[0];
  if (hvn == null) return null;
  return makeTarget("vp_node", hvn, entry, `HVN ${fmtPx(hvn)}`);
}

function dedupeTargets(
  targets: StructureTarget[],
  entry: number,
  tickSize: number,
  dedupePct: number,
): StructureTarget[] {
  const sorted = [...targets].sort(
    (a, b) => KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] || a.distancePct - b.distancePct,
  );
  const kept: StructureTarget[] = [];
  const threshold = Math.max(tickSize, entry * dedupePct);

  for (const t of sorted) {
    if (kept.some((k) => Math.abs(k.price - t.price) <= threshold)) continue;
    kept.push(t);
  }
  return kept;
}

function makeTarget(
  kind: StructureTargetKind,
  price: number,
  entry: number,
  label: string,
): StructureTarget {
  const distancePct = Math.abs(price - entry) / entry;
  return {
    id: targetId(kind, price),
    kind,
    price,
    label,
    distancePct,
  };
}

function targetId(kind: StructureTargetKind, price: number): string {
  return createHash("sha1").update(`${kind}|${price}`).digest("hex").slice(0, 12);
}

function fmtPx(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1000) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (Math.abs(n) >= 0.01) return n.toFixed(4);
  return n.toPrecision(4);
}

/** Mark structure targets touched by price without changing lifecycle exit. */
export function tagStructureTargetHits(
  targets: StructureTarget[] | undefined,
  side: "LONG" | "SHORT",
  price: number,
  now: number,
): { targets: StructureTarget[]; newlyHit: StructureTarget[] } {
  if (!targets?.length) return { targets: targets ?? [], newlyHit: [] };
  const newlyHit: StructureTarget[] = [];
  const next = targets.map((t) => {
    if (t.hitAt != null) return t;
    const hit = side === "LONG" ? price >= t.price : price <= t.price;
    if (!hit) return t;
    const tagged = { ...t, hitAt: now };
    newlyHit.push(tagged);
    return tagged;
  });
  return { targets: next, newlyHit };
}

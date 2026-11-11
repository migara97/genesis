import { createHash } from "node:crypto";
import type {
  Candle,
  ChartOverlayState,
  ChartZoneBand,
  ChartZoneKind,
  ChartZoneSource,
  MarketStructureState,
  StructureZonesState,
  TradeTick,
  VolumeProfile,
} from "@of/shared";
import { buildVolumeProfile } from "./volumeProfile.js";

export interface ChartZonesConfig {
  /** Merge HVN prices within this many ticks into one band. */
  hvnMergeTicks: number;
  /** Cluster swings whose prices are within this relative distance. */
  swingProximityPct: number;
  /** Thin band half-width around previous session H/L as % of price. */
  sessionExtremeBandPct: number;
  /** Minimum distinct VP levels in the candle window before accepting window VP. */
  minWindowTradeLevels: number;
  /** Minimum total volume in the candle window before accepting window VP. */
  minWindowVolume: number;
  maxDemand: number;
  maxSupply: number;
}

export const DEFAULT_CHART_ZONES_CONFIG: ChartZonesConfig = {
  hvnMergeTicks: 3,
  swingProximityPct: 0.0015,
  sessionExtremeBandPct: 0.0008,
  minWindowTradeLevels: 8,
  minWindowVolume: 1,
  maxDemand: 2,
  maxSupply: 2,
};

const SOURCE_PRIORITY: Record<ChartZoneSource, number> = {
  order_block: 4,
  hvn_cluster: 3,
  swing_cluster: 2,
  session_extreme: 1,
};

/**
 * Build Phase-A chart overlay: POC/VAH/VAL lines + gray SR/VP bands.
 * Heuristic only — not exchange drawings.
 */
export function buildChartOverlay(args: {
  symbol: string;
  lastPrice: number;
  tickSize: number;
  trades: TradeTick[];
  candles: Candle[];
  sessionProfile?: VolumeProfile | null;
  structure?: MarketStructureState | null;
  zones?: StructureZonesState | null;
  updatedAt?: number;
  config?: Partial<ChartZonesConfig>;
}): ChartOverlayState {
  const config = { ...DEFAULT_CHART_ZONES_CONFIG, ...args.config };
  const updatedAt = args.updatedAt ?? Date.now();
  const tick = args.tickSize > 0 ? args.tickSize : 0.01;

  const { profile, profileFrom, profileTo } = selectChartProfile({
    symbol: args.symbol,
    trades: args.trades,
    candles: args.candles,
    tickSize: tick,
    sessionProfile: args.sessionProfile,
    config,
  });

  const rawBands = detectChartBands({
    lastPrice: args.lastPrice,
    tickSize: tick,
    profile,
    structure: args.structure,
    zones: args.zones,
    config,
  });

  const bands = selectNearestBands(rawBands, args.lastPrice, config.maxDemand, config.maxSupply);

  return {
    symbol: args.symbol,
    poc: profile?.poc,
    vah: profile?.vah,
    val: profile?.val,
    bands,
    lastBos: args.structure?.lastBos,
    lastChoch: args.structure?.lastChoch,
    profileFrom,
    profileTo,
    evidence: [
      {
        kind: "inferred",
        note: "Chart zones merge HVN clusters, swing clusters, active order blocks, and session extremes. POC/VAH/VAL are app-calculated volume-profile levels — not exchange drawings.",
      },
    ],
    updatedAt,
  };
}

export function selectChartProfile(args: {
  symbol: string;
  trades: TradeTick[];
  candles: Candle[];
  tickSize: number;
  sessionProfile?: VolumeProfile | null;
  config: ChartZonesConfig;
}): { profile: VolumeProfile | null; profileFrom?: number; profileTo?: number } {
  const window = candleTimeWindow(args.candles);
  if (window) {
    const windowProfile = buildVolumeProfile(
      args.symbol,
      args.trades,
      args.tickSize,
      window.from,
      window.to,
    );
    if (
      windowProfile &&
      windowProfile.levels.length >= args.config.minWindowTradeLevels &&
      windowProfile.totalVolume >= args.config.minWindowVolume
    ) {
      return {
        profile: windowProfile,
        profileFrom: windowProfile.from,
        profileTo: windowProfile.to,
      };
    }
  }

  const session = args.sessionProfile ?? null;
  return {
    profile: session,
    profileFrom: session?.from,
    profileTo: session?.to,
  };
}

export function detectChartBands(args: {
  lastPrice: number;
  tickSize: number;
  profile?: VolumeProfile | null;
  structure?: MarketStructureState | null;
  zones?: StructureZonesState | null;
  config: ChartZonesConfig;
}): ChartZoneBand[] {
  const bands: ChartZoneBand[] = [];
  bands.push(...hvnClusterBands(args.profile, args.lastPrice, args.tickSize, args.config));
  bands.push(...swingClusterBands(args.structure, args.lastPrice, args.config));
  bands.push(...orderBlockBands(args.zones, args.lastPrice));
  bands.push(...sessionExtremeBands(args.structure, args.lastPrice, args.config));
  return mergeOverlappingBands(bands, args.tickSize);
}

export function selectNearestBands(
  bands: ChartZoneBand[],
  lastPrice: number,
  maxDemand: number,
  maxSupply: number,
): ChartZoneBand[] {
  const demand: ChartZoneBand[] = [];
  const supply: ChartZoneBand[] = [];

  const ranked = [...bands].sort((a, b) => {
    const da = distanceToBand(lastPrice, a);
    const db = distanceToBand(lastPrice, b);
    if (da !== db) return da - db;
    if (b.strength !== a.strength) return b.strength - a.strength;
    return SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
  });

  for (const band of ranked) {
    const side = selectionSide(band, lastPrice);
    if (side === "demand" && demand.length < maxDemand) {
      demand.push(band);
    } else if (side === "supply" && supply.length < maxSupply) {
      supply.push(band);
    }
  }

  return [...demand, ...supply].sort((a, b) => a.low - b.low);
}

function candleTimeWindow(candles: Candle[]): { from: number; to: number } | null {
  if (candles.length === 0) return null;
  const from = candles[0]!.openTime;
  const to = candles[candles.length - 1]!.closeTime;
  if (!(to > from)) return null;
  return { from, to };
}

function hvnClusterBands(
  profile: VolumeProfile | null | undefined,
  lastPrice: number,
  tickSize: number,
  config: ChartZonesConfig,
): ChartZoneBand[] {
  if (!profile?.hvn?.length) return [];
  const mergeDist = Math.max(tickSize, config.hvnMergeTicks * tickSize);
  const sorted = [...profile.hvn].sort((a, b) => a - b);
  const clusters: { low: number; high: number; volume: number; createdAt: number }[] = [];

  for (const price of sorted) {
    const level = profile.levels.find((l) => l.price === price);
    const vol = level?.volume ?? 0;
    const last = clusters[clusters.length - 1];
    if (last && price - last.high <= mergeDist) {
      last.high = price;
      last.volume += vol;
    } else {
      clusters.push({ low: price, high: price, volume: vol, createdAt: profile.to });
    }
  }

  const maxVol = Math.max(...clusters.map((c) => c.volume), 1);
  return clusters.map((c) => {
    // Ensure a visible band height of at least one tick when HVN is a single price.
    const low = c.low;
    const high = c.high <= c.low ? c.low + tickSize : c.high;
    return makeBand({
      low,
      high,
      kind: classifyKind(low, high, lastPrice),
      source: "hvn_cluster",
      strength: clamp01(c.volume / maxVol),
      createdAt: c.createdAt,
    });
  });
}

function swingClusterBands(
  structure: MarketStructureState | null | undefined,
  lastPrice: number,
  config: ChartZonesConfig,
): ChartZoneBand[] {
  const swings = structure?.swings ?? [];
  if (swings.length === 0) return [];

  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  return [
    ...clusterSwingPrices(highs, "supply", lastPrice, config.swingProximityPct),
    ...clusterSwingPrices(lows, "demand", lastPrice, config.swingProximityPct),
  ];
}

function clusterSwingPrices(
  swings: { price: number; timestamp: number }[],
  preferredKind: "demand" | "supply",
  lastPrice: number,
  proximityPct: number,
): ChartZoneBand[] {
  if (swings.length === 0) return [];
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters: { low: number; high: number; count: number; createdAt: number }[] = [];

  for (const swing of sorted) {
    const last = clusters[clusters.length - 1];
    const ref = last ? (last.low + last.high) / 2 : swing.price;
    const near = Math.abs(swing.price - ref) <= Math.max(ref, lastPrice) * proximityPct;
    if (last && near) {
      last.low = Math.min(last.low, swing.price);
      last.high = Math.max(last.high, swing.price);
      last.count += 1;
      last.createdAt = Math.max(last.createdAt, swing.timestamp);
    } else {
      clusters.push({
        low: swing.price,
        high: swing.price,
        count: 1,
        createdAt: swing.timestamp,
      });
    }
  }

  // Prefer true clusters (2+ touches); still keep strongest singles near price as thin bands.
  return clusters
    .filter((c) => c.count >= 2 || distanceToRange(lastPrice, c.low, c.high) / Math.max(lastPrice, 1) < 0.01)
    .map((c) => {
      const pad = Math.max((c.high - c.low) * 0.05, lastPrice * proximityPct);
      const low = c.low - pad;
      const high = c.high + pad;
      return makeBand({
        low,
        high,
        kind: c.count >= 2 ? preferredKind : classifyKind(low, high, lastPrice),
        source: "swing_cluster",
        strength: clamp01(0.35 + 0.2 * Math.min(c.count, 4)),
        createdAt: c.createdAt,
      });
    });
}

function orderBlockBands(
  zones: StructureZonesState | null | undefined,
  lastPrice: number,
): ChartZoneBand[] {
  const blocks = (zones?.orderBlocks ?? []).filter((b) => !b.invalidated);
  if (blocks.length === 0) return [];
  const newest = Math.max(...blocks.map((b) => b.createdAt), 1);
  return blocks.map((block) =>
    makeBand({
      low: block.low,
      high: block.high,
      kind:
        block.direction === "bullish"
          ? "demand"
          : block.direction === "bearish"
            ? "supply"
            : classifyKind(block.low, block.high, lastPrice),
      source: "order_block",
      strength: clamp01(0.55 + 0.45 * (block.createdAt / newest)),
      createdAt: block.createdAt,
    }),
  );
}

function sessionExtremeBands(
  structure: MarketStructureState | null | undefined,
  lastPrice: number,
  config: ChartZonesConfig,
): ChartZoneBand[] {
  const out: ChartZoneBand[] = [];
  const half = Math.max(lastPrice * config.sessionExtremeBandPct, lastPrice * 1e-6);
  if (structure?.previousSessionHigh != null) {
    const mid = structure.previousSessionHigh;
    out.push(
      makeBand({
        low: mid - half,
        high: mid + half,
        kind: classifyKind(mid - half, mid + half, lastPrice),
        source: "session_extreme",
        strength: 0.45,
        createdAt: 0,
      }),
    );
  }
  if (structure?.previousSessionLow != null) {
    const mid = structure.previousSessionLow;
    out.push(
      makeBand({
        low: mid - half,
        high: mid + half,
        kind: classifyKind(mid - half, mid + half, lastPrice),
        source: "session_extreme",
        strength: 0.45,
        createdAt: 0,
      }),
    );
  }
  return out;
}

export function mergeOverlappingBands(bands: ChartZoneBand[], tickSize: number): ChartZoneBand[] {
  if (bands.length <= 1) return bands;
  const sorted = [...bands].sort((a, b) => a.low - b.low || a.high - b.high);
  const merged: ChartZoneBand[] = [];
  const gap = Math.max(tickSize, 0);

  for (const band of sorted) {
    const last = merged[merged.length - 1];
    if (last && band.low <= last.high + gap) {
      const low = Math.min(last.low, band.low);
      const high = Math.max(last.high, band.high);
      const prefer =
        SOURCE_PRIORITY[band.source] > SOURCE_PRIORITY[last.source]
          ? band
          : SOURCE_PRIORITY[band.source] < SOURCE_PRIORITY[last.source]
            ? last
            : band.strength >= last.strength
              ? band
              : last;
      merged[merged.length - 1] = makeBand({
        low,
        high,
        kind: prefer.kind,
        source: prefer.source,
        strength: Math.max(last.strength, band.strength),
        createdAt: Math.max(last.createdAt, band.createdAt),
      });
    } else {
      merged.push(band);
    }
  }
  return merged;
}

function classifyKind(low: number, high: number, lastPrice: number): ChartZoneKind {
  if (lastPrice < low) return "supply";
  if (lastPrice > high) return "demand";
  return "balance";
}

function selectionSide(band: ChartZoneBand, lastPrice: number): "demand" | "supply" {
  if (band.kind === "demand") return "demand";
  if (band.kind === "supply") return "supply";
  const mid = (band.low + band.high) / 2;
  return lastPrice <= mid ? "demand" : "supply";
}

function distanceToBand(price: number, band: ChartZoneBand): number {
  return distanceToRange(price, band.low, band.high);
}

function distanceToRange(price: number, low: number, high: number): number {
  if (price < low) return low - price;
  if (price > high) return price - high;
  return 0;
}

function makeBand(args: {
  low: number;
  high: number;
  kind: ChartZoneKind;
  source: ChartZoneSource;
  strength: number;
  createdAt: number;
}): ChartZoneBand {
  const low = Math.min(args.low, args.high);
  const high = Math.max(args.low, args.high);
  return {
    id: bandId(args.source, args.kind, low, high, args.createdAt),
    low,
    high,
    kind: args.kind,
    source: args.source,
    strength: clamp01(args.strength),
    createdAt: args.createdAt,
  };
}

function bandId(
  source: ChartZoneSource,
  kind: ChartZoneKind,
  low: number,
  high: number,
  createdAt: number,
): string {
  return createHash("sha1")
    .update(`${source}|${kind}|${low}|${high}|${createdAt}`)
    .digest("hex")
    .slice(0, 12);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

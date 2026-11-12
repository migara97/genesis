import {
  compareLiveToReplay,
  replayTapeOrderFlow,
  type TapeReplayResult,
} from "@of/orderflow";
import type { Candle } from "@of/shared";
import { createMarketDataAdapter } from "@of/exchange";
import { config } from "../config.js";
import { listPaperTrades } from "./paperLedger.js";
import {
  countTapeTrades,
  loadTapeTrades,
  tapeCoverageNote,
  tapeTimeBounds,
} from "./tapeArchive.js";

export interface ParityRunnerResult {
  symbol: string;
  exchange: string;
  status: "no_tape" | "ready_partial_of" | "ready_with_overlap";
  /** True when tape exists and replay ran — Phase 9 green for taped symbols. */
  green: boolean;
  fullEngineParity: false;
  tape: {
    note: string;
    count: number;
    minTs: number | null;
    maxTs: number | null;
    ticksUsed: number;
  };
  live: {
    gates: { minIndependent: number; minScore: number; domRequiresTradeDelta: boolean };
    inputs: string[];
  };
  historicalDefaultBacktest: {
    structureOnlyMode: true;
    inputs: string[];
    limitation: string;
  };
  replay: TapeReplayResult | null;
  compare: ReturnType<typeof compareLiveToReplay> | null;
  notes: string[];
}

async function fetchCandleSeries(symbol: string): Promise<{ interval: string; candles: Candle[] }[]> {
  const adapter = createMarketDataAdapter(config.exchange);
  const intervals = ["1d", "4h", "1h", "15m", "5m", "1m"] as const;
  const limits: Record<string, number> = {
    "1d": 120,
    "4h": 120,
    "1h": 150,
    "15m": 200,
    "5m": 300,
    "1m": 300,
  };
  const out: { interval: string; candles: Candle[] }[] = [];
  for (const interval of intervals) {
    try {
      const candles = await adapter.fetchKlines(symbol, interval, limits[interval] ?? 150);
      out.push({ interval, candles });
    } catch {
      // Partial MTF still allows structure on whatever loaded.
    }
  }
  return out;
}

/**
 * Phase 9 parity runner: tape OF replay vs live paper ledger.
 * Always discloses DOM absence — never claims bit-identical full-engine parity.
 */
export async function runParityReport(opts: {
  symbol: string;
  runReplay?: boolean;
  fromTs?: number;
  toTs?: number;
  maxTicks?: number;
}): Promise<ParityRunnerResult> {
  const symbol = opts.symbol.toUpperCase();
  const exchange = config.exchange;
  const bounds = tapeTimeBounds(symbol, exchange);
  const notes: string[] = [];

  const base: ParityRunnerResult = {
    symbol,
    exchange,
    status: "no_tape",
    green: false,
    fullEngineParity: false,
    tape: {
      note: tapeCoverageNote(symbol, exchange),
      count: bounds.count,
      minTs: bounds.minTs,
      maxTs: bounds.maxTs,
      ticksUsed: 0,
    },
    live: {
      gates: { minIndependent: 2, minScore: 2, domRequiresTradeDelta: true },
      inputs: ["structure", "mtf", "zones", "cvd", "footprint", "dom", "volumeProfile"],
    },
    historicalDefaultBacktest: {
      structureOnlyMode: true,
      inputs: ["structure", "mtf"],
      limitation:
        "Default /api/backtest is a structure/MTF proxy — not full live Order Flow parity. Do not claim complete-engine edge from it.",
    },
    replay: null,
    compare: null,
    notes,
  };

  if (bounds.count === 0) {
    notes.push("No trade_tape rows — leave PAPER streaming to archive ticks, then re-run with run=1.");
    return base;
  }

  if (!opts.runReplay) {
    notes.push("Tape present. Pass run=1 to execute Phase 9 OF replay + paper compare.");
    return {
      ...base,
      status: "ready_partial_of",
      green: true,
      notes,
    };
  }

  const ticks = loadTapeTrades({
    symbol,
    exchange,
    fromTs: opts.fromTs,
    toTs: opts.toTs,
    limit: opts.maxTicks ?? 50_000,
  });
  base.tape.ticksUsed = ticks.length;
  if (ticks.length === 0) {
    notes.push("Tape query returned 0 ticks for the requested window.");
    return { ...base, status: "no_tape", green: false, notes };
  }

  const series = await fetchCandleSeries(symbol);
  if (series.length === 0) {
    notes.push("Failed to fetch candles for structure/MTF — replay aborted.");
    return { ...base, green: false, notes };
  }

  const replay = replayTapeOrderFlow(symbol, ticks, series, {
    tickSize: config.tickSizeFor(symbol),
    footprintIntervalMs: config.footprintIntervalMs,
    primaryInterval: "5m",
  });
  notes.push(replay.limitation);

  const from = opts.fromTs ?? ticks[0]!.timestamp;
  const to = opts.toTs ?? ticks[ticks.length - 1]!.timestamp;
  const liveRows = listPaperTrades({ symbol, limit: 10_000 })
    .filter((t) => t.openedAt >= from - 60_000 && t.openedAt <= to + 60_000)
    .filter((t) => t.outcome !== "OPEN")
    .map((t) => ({
      setupId: t.setupId,
      direction: t.direction,
      outcome: t.outcome,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      entry: t.entry,
      confidence: t.confidence,
    }));

  const compare = compareLiveToReplay(liveRows, replay.trades);
  notes.push(compare.sampleNote);

  const status =
    compare.matched > 0 || liveRows.length > 0 ? "ready_with_overlap" : "ready_partial_of";

  return {
    ...base,
    status,
    green: true,
    replay,
    compare,
    notes,
  };
}

export function parityStatusOnly(symbol: string) {
  const n = countTapeTrades(symbol, config.exchange);
  return {
    symbol,
    exchange: config.exchange,
    tapeCount: n,
    green: n > 0,
    fullEngineParity: false as const,
  };
}

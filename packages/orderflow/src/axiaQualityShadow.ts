import type {
  AxiaQualityShadowSnapshot,
  BreakRetestState,
  EvidenceTag,
  FootprintBar,
} from "@of/shared";

export interface AxiaQualityShadowConfig {
  /** Min |delta|/volume to treat aggression as meaningful. */
  minDeltaRatio: number;
  /** Range/price below this with high |delta| ⇒ absorbing (low efficiency). */
  lowEfficiencyRangePct: number;
  /** Hang bars after break before quality is penalized. */
  hangBarsWarn: number;
  /** Max recent closed footprints kept for hang / multi-bar absorption. */
  historyBars: number;
  /** Relative price progress after break below this ⇒ hang. */
  hangProgressPct: number;
  /** High |delta| ratio with muted range ⇒ absorption-like. */
  absorbDeltaRatio: number;
  /** Thin extreme volume vs avg for exhaustion. */
  exhaustionVolRatio: number;
}

export const DEFAULT_AXIA_QUALITY_CONFIG: AxiaQualityShadowConfig = {
  minDeltaRatio: 0.12,
  lowEfficiencyRangePct: 0.0008,
  hangBarsWarn: 3,
  historyBars: 12,
  hangProgressPct: 0.0012,
  absorbDeltaRatio: 0.2,
  exhaustionVolRatio: 0.4,
};

export interface AxiaQualityShadowInput {
  symbol: string;
  lastPrice: number;
  footprint?: FootprintBar | null;
  /** Recent closed footprint bars, oldest→newest (optional). */
  footprintHistory?: FootprintBar[] | null;
  breakRetest?: BreakRetestState | null;
  /** Approximate bar index from candle count for hang duration. */
  barIndex?: number | null;
}

const EVIDENCE: EvidenceTag = {
  kind: "heuristic",
  note: "Axia-quality shadow is observational only — never mutates generateSignal scores, gates, or A+.",
};

/**
 * Axia-inspired Actual-vs-Expected quality tags for paper observability.
 * Deterministic heuristics — not trade signals and not institutional identity.
 */
export function computeAxiaQualityShadow(
  input: AxiaQualityShadowInput,
  config: AxiaQualityShadowConfig = DEFAULT_AXIA_QUALITY_CONFIG,
): AxiaQualityShadowSnapshot {
  const notes: string[] = [];
  const fp = input.footprint;
  const history = (input.footprintHistory ?? []).slice(-config.historyBars);

  const deltaEfficiency = scoreDeltaEfficiency(fp, config, notes);
  const { breakQuality, hangBars, hangDetected } = scoreBreakQuality(
    input,
    history,
    config,
    notes,
  );
  const highLowFormation = classifyHighLow(fp, config, notes);
  const absorptionPersistence = scoreAbsorptionPersistence(fp, history, config, notes);

  return {
    deltaEfficiency,
    breakQuality,
    hangBars,
    hangDetected,
    highLowFormation,
    absorptionPersistence,
    notes,
    evidence: [EVIDENCE],
    mutatesScores: false,
  };
}

export function formatAxiaQualitySummary(shadow: AxiaQualityShadowSnapshot): string {
  return `Axia quality: Δeff ${shadow.deltaEfficiency.toFixed(2)} · breakQ ${shadow.breakQuality.toFixed(2)} · hang ${shadow.hangDetected ? shadow.hangBars : 0} · HL ${shadow.highLowFormation} · absorbPers ${shadow.absorptionPersistence.toFixed(2)} (observational, no score mutation)`;
}

/** Compact tags for paper regime strata (optional append). */
export function axiaQualityRegimeHints(shadow: AxiaQualityShadowSnapshot): string[] {
  const tags: string[] = [];
  if (shadow.breakQuality >= 0.66) tags.push("break_q_high");
  else if (shadow.breakQuality > 0 && shadow.breakQuality <= 0.34) tags.push("break_q_low");
  if (shadow.deltaEfficiency >= 0.66) tags.push("delta_eff_high");
  else if (shadow.deltaEfficiency > 0 && shadow.deltaEfficiency <= 0.34) tags.push("delta_eff_low");
  if (shadow.hangDetected) tags.push("break_hang");
  if (shadow.highLowFormation === "exhaustion") tags.push("hl_exhaustion");
  if (shadow.highLowFormation === "absorption") tags.push("hl_absorption");
  if (shadow.highLowFormation === "v_reversal") tags.push("hl_v_reversal");
  return tags;
}

function scoreDeltaEfficiency(
  fp: FootprintBar | null | undefined,
  config: AxiaQualityShadowConfig,
  notes: string[],
): number {
  if (!fp || fp.totalVolume <= 0 || !(fp.open > 0)) {
    notes.push("Delta efficiency unknown — footprint not ready.");
    return 0;
  }
  const mid = (fp.high + fp.low) / 2 || fp.close || fp.open;
  const rangePct = Math.abs(fp.high - fp.low) / Math.max(mid, 1e-12);
  const deltaRatio = Math.abs(fp.totalDelta) / Math.max(fp.totalVolume, 1e-12);

  // Efficiency: price travel per unit aggressor imbalance.
  // Low range + high |delta| ⇒ absorption / weak follow-through (Axia hang clue).
  if (deltaRatio < config.minDeltaRatio) {
    notes.push("Delta efficiency muted — low aggressor imbalance.");
    return Number(Math.min(0.5, rangePct / Math.max(config.lowEfficiencyRangePct, 1e-12) * 0.25).toFixed(3));
  }

  const raw = rangePct / Math.max(deltaRatio, 1e-12);
  // Normalize: ~lowEfficiencyRangePct / 0.35 delta ⇒ mid; scale into 0..1
  const score = Math.max(0, Math.min(1, raw / Math.max(config.lowEfficiencyRangePct * 8, 1e-12)));
  if (score < 0.35) {
    notes.push("Low delta efficiency — volume/aggression without price progress (absorb-like).");
  } else if (score >= 0.66) {
    notes.push("High delta efficiency — aggression accompanied by price travel.");
  }
  return Number(score.toFixed(3));
}

function scoreBreakQuality(
  input: AxiaQualityShadowInput,
  history: FootprintBar[],
  config: AxiaQualityShadowConfig,
  notes: string[],
): { breakQuality: number; hangBars: number; hangDetected: boolean } {
  const br = input.breakRetest;
  if (!br || br.phase === "idle" || br.phase === "balance") {
    notes.push("Break quality idle — no active break/retest playbook.");
    return { breakQuality: 0, hangBars: 0, hangDetected: false };
  }

  if (br.phase === "failed" || br.phase === "invalidated") {
    notes.push("Break quality low — playbook failed/invalidated.");
    return { breakQuality: 0.15, hangBars: hangBarsSinceBreak(br, input.barIndex), hangDetected: true };
  }

  if (br.phase === "accepted") {
    notes.push("Break quality high — retest accepted (observational).");
    return { breakQuality: 0.85, hangBars: 0, hangDetected: false };
  }

  // broken / retesting — measure hang + opposing absorption in recent bars
  const hangBars = hangBarsSinceBreak(br, input.barIndex);
  const breakPx = br.breakPrice ?? input.lastPrice;
  const progressPct =
    breakPx > 0 ? Math.abs(input.lastPrice - breakPx) / breakPx : 0;

  const recent = history.length ? history.slice(-Math.max(hangBars, 3)) : input.footprint ? [input.footprint] : [];
  const absorbish = recent.filter((b) => {
    const mid = (b.high + b.low) / 2 || b.close;
    const rangePct = Math.abs(b.high - b.low) / Math.max(mid, 1e-12);
    const deltaRatio = Math.abs(b.totalDelta) / Math.max(b.totalVolume, 1e-12);
    return b.absorption || (deltaRatio >= config.absorbDeltaRatio && rangePct <= config.lowEfficiencyRangePct * 2);
  }).length;

  const hanging =
    hangBars >= config.hangBarsWarn && progressPct < config.hangProgressPct;

  let quality = 0.55;
  if (hanging) {
    quality -= 0.25;
    notes.push(
      `Hang-time after break: ~${hangBars} bars with progress ${(progressPct * 100).toFixed(3)}% (Actual≠Expected risk).`,
    );
  }
  if (absorbish >= 2) {
    quality -= 0.2;
    notes.push(`Multi-bar absorb-like prints after break (${absorbish}) — failed-break fingerprint.`);
  }
  if (!hanging && progressPct >= config.hangProgressPct && absorbish === 0) {
    quality += 0.2;
    notes.push("Break showing follow-through without hang/absorb cluster.");
  }

  quality = Math.max(0.05, Math.min(0.95, quality));
  return {
    breakQuality: Number(quality.toFixed(3)),
    hangBars,
    hangDetected: hanging || absorbish >= 2,
  };
}

function hangBarsSinceBreak(
  br: BreakRetestState,
  barIndex?: number | null,
): number {
  if (
    br.brokenBarIndex != null &&
    barIndex != null &&
    Number.isFinite(barIndex) &&
    Number.isFinite(br.brokenBarIndex)
  ) {
    return Math.max(0, Math.floor(barIndex - br.brokenBarIndex));
  }
  if (br.brokenAt != null) {
    // Footprint intervals are typically ~minutes; use ~60s as coarse proxy when bar index missing.
    return Math.max(0, Math.floor((Date.now() - br.brokenAt) / 60_000));
  }
  return 0;
}

function classifyHighLow(
  fp: FootprintBar | null | undefined,
  config: AxiaQualityShadowConfig,
  notes: string[],
): AxiaQualityShadowSnapshot["highLowFormation"] {
  if (!fp || fp.totalVolume <= 0) {
    notes.push("High/low formation unknown — no footprint.");
    return "unknown";
  }

  if (fp.absorption) {
    notes.push("HL class absorption — footprint absorption heuristic.");
    return "absorption";
  }

  const mid = (fp.high + fp.low) / 2 || fp.close;
  const rangePct = Math.abs(fp.high - fp.low) / Math.max(mid, 1e-12);
  const deltaRatio = Math.abs(fp.totalDelta) / Math.max(fp.totalVolume, 1e-12);
  if (deltaRatio >= config.absorbDeltaRatio && rangePct <= config.lowEfficiencyRangePct * 2) {
    notes.push("HL class absorption — high |delta| with muted range.");
    return "absorption";
  }

  if (fp.exhaustion) {
    notes.push("HL class exhaustion — footprint exhaustion heuristic.");
    return "exhaustion";
  }

  // V-reversal proxy: wide range, close near opposite extreme of open, unfinished or strong delta flip vs open direction
  const openToClose = fp.close - fp.open;
  const nearHigh = fp.close >= fp.high - (fp.high - fp.low) * 0.2;
  const nearLow = fp.close <= fp.low + (fp.high - fp.low) * 0.2;
  const bullishV = openToClose > 0 && nearHigh && fp.totalDelta > 0 && rangePct > config.lowEfficiencyRangePct * 3;
  const bearishV = openToClose < 0 && nearLow && fp.totalDelta < 0 && rangePct > config.lowEfficiencyRangePct * 3;
  // Stronger V: open near one extreme, close near the other with volume
  const openNearLow = fp.open <= fp.low + (fp.high - fp.low) * 0.25;
  const openNearHigh = fp.open >= fp.high - (fp.high - fp.low) * 0.25;
  const classicV =
    (openNearLow && nearHigh && fp.totalDelta > 0) || (openNearHigh && nearLow && fp.totalDelta < 0);

  if (classicV || bullishV || bearishV) {
    notes.push("HL class v_reversal — equal/opposite style footprint rotation.");
    return "v_reversal";
  }

  // Thin extreme after push → exhaustion-like even if flag false
  if (fp.cells.length > 0) {
    const avg =
      fp.cells.reduce((s, c) => s + c.bidVolume + c.askVolume, 0) / Math.max(fp.cells.length, 1);
    const atHigh = fp.cells.find((c) => Math.abs(c.price - fp.high) < 1e-9);
    const atLow = fp.cells.find((c) => Math.abs(c.price - fp.low) < 1e-9);
    const extreme = nearHigh ? atHigh : nearLow ? atLow : undefined;
    if (extreme) {
      const vol = extreme.bidVolume + extreme.askVolume;
      if (vol < avg * config.exhaustionVolRatio && rangePct > config.lowEfficiencyRangePct * 2) {
        notes.push("HL class exhaustion — thin volume at extreme after range expansion.");
        return "exhaustion";
      }
    }
  }

  notes.push("HL class other — no clear exhaustion/absorption/V pattern.");
  return "other";
}

function scoreAbsorptionPersistence(
  fp: FootprintBar | null | undefined,
  history: FootprintBar[],
  config: AxiaQualityShadowConfig,
  notes: string[],
): number {
  const bars = [...history];
  if (fp) bars.push(fp);
  if (bars.length === 0) return 0;

  const window = bars.slice(-5);
  let absorbBars = 0;
  for (const b of window) {
    const mid = (b.high + b.low) / 2 || b.close;
    const rangePct = Math.abs(b.high - b.low) / Math.max(mid, 1e-12);
    const deltaRatio = Math.abs(b.totalDelta) / Math.max(b.totalVolume, 1e-12);
    if (b.absorption || (deltaRatio >= config.absorbDeltaRatio && rangePct <= config.lowEfficiencyRangePct * 2)) {
      absorbBars += 1;
    }
  }
  const score = Math.min(1, absorbBars / 3);
  if (score >= 0.66) {
    notes.push(`Absorption persistence elevated (${absorbBars}/${window.length} recent bars).`);
  }
  return Number(score.toFixed(3));
}

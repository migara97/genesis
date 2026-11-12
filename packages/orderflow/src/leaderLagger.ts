import type { EvidenceTag } from "@of/shared";

export interface LeaderLaggerPeer {
  symbol: string;
  changePct24h: number;
  volume24h: number;
  corrProxy: number;
}

export interface LeaderLaggerReport {
  focus: string;
  focusChangePct24h: number | null;
  role: "leader" | "lagger" | "peer" | "unknown";
  confidence: number;
  leaders: LeaderLaggerPeer[];
  laggers: LeaderLaggerPeer[];
  note: string;
  evidence: EvidenceTag[];
}

export interface LeaderLaggerInput {
  focus: string;
  peers: { symbol: string; changePct24h: number | null; volume24h: number | null }[];
  /** How many peers to keep on each side. */
  topN?: number;
}

/**
 * Cross-sectional leader/lagger from catalog 24h % changes (not live multi-symbol OF).
 * Confidence reflects how extreme focus is vs volume-ranked peers — heuristic only.
 */
export function computeLeaderLagger(input: LeaderLaggerInput): LeaderLaggerReport {
  const topN = input.topN ?? 5;
  const evidence: EvidenceTag[] = [
    {
      kind: "heuristic",
      note: "Leader/lagger uses exchange-reported 24h ticker % among catalog peers — not tick-level lead-lag causality.",
    },
  ];

  const focusRow = input.peers.find((p) => p.symbol.toUpperCase() === input.focus.toUpperCase());
  const focusChg = focusRow?.changePct24h ?? null;

  const ranked = input.peers
    .filter(
      (p) =>
        p.symbol.toUpperCase() !== input.focus.toUpperCase() &&
        p.changePct24h != null &&
        Number.isFinite(p.changePct24h) &&
        (p.volume24h ?? 0) > 0,
    )
    .map((p) => ({
      symbol: p.symbol,
      changePct24h: p.changePct24h as number,
      volume24h: p.volume24h ?? 0,
      corrProxy: 0,
    }))
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 40);

  if (focusChg == null || !Number.isFinite(focusChg) || ranked.length < 3) {
    return {
      focus: input.focus,
      focusChangePct24h: focusChg,
      role: "unknown",
      confidence: 0,
      leaders: [],
      laggers: [],
      note: "Insufficient catalog peers or focus 24h change for leader/lagger heuristic.",
      evidence,
    };
  }

  const withProxy = ranked.map((p) => ({
    ...p,
    // Same-sign magnitude proximity as a crude co-move proxy (not Pearson on a series).
    corrProxy: Number(
      (
        1 -
        Math.min(1, Math.abs(p.changePct24h - focusChg) / Math.max(Math.abs(focusChg) + 0.5, 1))
      ).toFixed(3),
    ),
  }));

  const byChg = [...withProxy].sort((a, b) => b.changePct24h - a.changePct24h);
  const leaders = byChg.slice(0, topN);
  const laggers = byChg.slice(-topN).reverse();

  const maxPeer = byChg[0]?.changePct24h ?? focusChg;
  const minPeer = byChg[byChg.length - 1]?.changePct24h ?? focusChg;
  const span = Math.max(1e-6, maxPeer - minPeer);
  const rank = byChg.filter((p) => p.changePct24h > focusChg).length;
  const pctile = 1 - rank / Math.max(byChg.length, 1);

  let role: LeaderLaggerReport["role"] = "peer";
  if (pctile >= 0.8 || focusChg >= maxPeer - span * 0.1) role = "leader";
  else if (pctile <= 0.2 || focusChg <= minPeer + span * 0.1) role = "lagger";

  const confidence = Number(
    Math.min(0.9, 0.35 + Math.abs(pctile - 0.5) * 1.1 + (span > 2 ? 0.1 : 0)).toFixed(3),
  );

  return {
    focus: input.focus,
    focusChangePct24h: focusChg,
    role,
    confidence,
    leaders,
    laggers,
    note: `Focus ${input.focus} classified as ${role} vs volume peers (24h cross-section, confidence ${confidence}).`,
    evidence,
  };
}

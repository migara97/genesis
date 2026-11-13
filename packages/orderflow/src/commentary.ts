import type { EvidenceTag, TradingSignal } from "@of/shared";
import type { IcebergRefillSignal } from "./icebergRefill.js";
import type { LeaderLaggerReport } from "./leaderLagger.js";

export interface CommentaryInput {
  signal?: TradingSignal | null;
  iceberg?: IcebergRefillSignal | null;
  leaderLagger?: LeaderLaggerReport | null;
  lastPrice?: number | null;
}

export interface CommentaryResult {
  text: string;
  source: "template";
  /** Always false — commentary never mutates scores. */
  mutatesScores: false;
  evidence: EvidenceTag[];
}

/**
 * Rule/template commentary separated from the signal engine.
 * Must never change confidence, direction, or confirmation gates.
 */
export function buildCommentary(input: CommentaryInput): CommentaryResult {
  const parts: string[] = [];
  const evidence: EvidenceTag[] = [
    {
      kind: "heuristic",
      note: "Commentary is template text only — it does not alter generateSignal scores or gates.",
    },
  ];

  const sig = input.signal;
  if (sig) {
    const scorePct = (sig.confidence * 100).toFixed(0);
    if (sig.direction === "WAIT") {
      parts.push(
        `Model is WAIT (grade ${sig.entryGrade}). Model score ${scorePct}% is a score, not a win rate.`,
      );
    } else {
      const families = sig.score.independentFamilies ?? [];
      const familyLabel =
        families.length > 0
          ? `${families.length} families (${families.join(", ")})`
          : "0 families";
      parts.push(
        `${sig.direction} setup (${sig.entryGrade}) · ${familyLabel}. Model score ${scorePct}% (uncalibrated — not win probability).`,
      );
    }
    const against = (sig.reasonsAgainst ?? []).slice(0, 3);
    if (against.length > 0) {
      parts.push(`Watch: ${against.join(" | ")}`);
    }
  } else {
    parts.push("No active signal snapshot — commentary limited to microstructure context.");
  }

  if (input.iceberg && input.iceberg.side !== "none" && input.iceberg.confidence >= 0.35) {
    parts.push(
      `DOM: ${input.iceberg.note} Visible refill ≠ hidden institutional size.`,
    );
  }

  if (input.leaderLagger && input.leaderLagger.role !== "unknown") {
    parts.push(
      `Cross-section: focus looks like a ${input.leaderLagger.role} vs peers (conf ${input.leaderLagger.confidence}). Not tick lead-lag.`,
    );
  }

  return {
    text: parts.join(" "),
    source: "template",
    mutatesScores: false,
    evidence,
  };
}

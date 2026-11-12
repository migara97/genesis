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
    if (sig.direction === "WAIT") {
      parts.push(
        `Model is WAIT (grade ${sig.entryGrade}). Confidence ${(sig.confidence * 100).toFixed(0)}% is a score, not a win rate.`,
      );
    } else {
      parts.push(
        `${sig.direction} setup (${sig.entryGrade}) with ${sig.confirmations.length} confirmations. Confidence ${(sig.confidence * 100).toFixed(0)}% remains uncalibrated until Phase 8 gates pass.`,
      );
    }
    if (sig.reasonsAgainst[0]) {
      parts.push(`Watch: ${sig.reasonsAgainst[0]}`);
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

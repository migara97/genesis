import type { EvidenceTag, SignalFactor } from "@of/shared";
import { computeAuctionShadow } from "./auctionModel.js";
import type { SignalInput } from "./signals.js";

export interface ConfirmationPackResult {
  factors: SignalFactor[];
  evidence: EvidenceTag[];
  reasonsAgainst: string[];
}

export type ConfirmationPack = (
  input: SignalInput,
) => ConfirmationPackResult;

const packs = new Map<string, ConfirmationPack>();

/** Register a confirmation pack. Packs must not bump directional scores (weight 0). */
export function registerConfirmationPack(id: string, pack: ConfirmationPack): void {
  packs.set(id, pack);
}

export function unregisterConfirmationPack(id: string): void {
  packs.delete(id);
}

export function listConfirmationPacks(): string[] {
  return [...packs.keys()];
}

export function clearConfirmationPacks(): void {
  packs.clear();
}

/**
 * Run registered packs. Results are informational / reasonsAgainst only —
 * callers must not treat pack factors as independent confirmation families.
 */
export function applyConfirmationPacks(input: SignalInput): ConfirmationPackResult {
  const factors: SignalFactor[] = [];
  const evidence: EvidenceTag[] = [];
  const reasonsAgainst: string[] = [];
  for (const [id, pack] of packs) {
    try {
      const out = pack(input);
      for (const f of out.factors) {
        factors.push({
          ...f,
          weight: 0,
          source: f.source === "exchange_reported" ? "heuristic" : f.source,
          id: f.id.startsWith("plugin_") ? f.id : `plugin_${id}_${f.id}`,
        });
      }
      evidence.push(...out.evidence);
      reasonsAgainst.push(...out.reasonsAgainst);
    } catch {
      reasonsAgainst.push(`Plugin pack ${id} failed — ignored.`);
    }
  }
  if (factors.length || evidence.length) {
    evidence.push({
      kind: "heuristic",
      note: "Strategy plugin factors are weight-0 and never mutate core confirmation gates.",
    });
  }
  return { factors, evidence, reasonsAgainst };
}

/**
 * R4 auction AMT shadow pack — weight-0 neutrals only.
 * Registered with default microstructure packs; still requires
 * `enableStrategyPlugins: true` to attach to generateSignal factors.
 * Live hub always attaches the same shadow via microstructure (no gate change).
 */
export function registerAuctionShadowPack(): void {
  registerConfirmationPack("auction_amt_shadow", (input) => {
    const shadow = computeAuctionShadow({
      symbol: input.symbol,
      lastPrice: input.lastPrice,
      volumeProfile: input.volumeProfile,
      footprint: input.footprint,
      cvd: input.cvd,
      breakRetest: input.breakRetest,
    });
    return {
      factors: [
        {
          id: "auction_shadow_state",
          family: "volume",
          weight: 0,
          side: "neutral",
          source: "heuristic",
          reason: `Auction shadow ${shadow.state}/${shadow.modelMode} (${shadow.priceVsValue}) — observational only.`,
        },
      ],
      evidence: shadow.evidence,
      reasonsAgainst:
        shadow.state === "BALANCE" && shadow.modelMode === "OFF"
          ? [
              "Auction shadow: price in balance without failed-auction mode — observational caution for trend continuation (does not veto).",
            ]
          : [],
    };
  });
}

/** Built-in example pack: surface iceberg caution if present on DOM extension. */
export function registerDefaultMicrostructurePack(): void {
  registerAuctionShadowPack();
  registerConfirmationPack("iceberg_caution", (input) => {
    const iceberg = (input.dom as { iceberg?: { side?: string; confidence?: number; note?: string } } | null)
      ?.iceberg;
    if (!iceberg || iceberg.side === "none" || !iceberg.confidence || iceberg.confidence < 0.4) {
      return { factors: [], evidence: [], reasonsAgainst: [] };
    }
    return {
      factors: [
        {
          id: "iceberg_refill_caution",
          family: "orderflow",
          weight: 0,
          side: "neutral",
          source: "heuristic",
          reason: iceberg.note ?? `Iceberg/refill heuristic on ${iceberg.side}`,
        },
      ],
      evidence: [
        {
          kind: "heuristic",
          note: "Plugin iceberg_caution — does not score LONG/SHORT.",
        },
      ],
      reasonsAgainst: [
        `Iceberg/refill heuristic active (${iceberg.side}, conf ${iceberg.confidence}) — treat visible size cautiously.`,
      ],
    };
  });
}

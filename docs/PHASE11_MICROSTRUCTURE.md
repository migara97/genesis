# Phase 11 — Advanced Microstructure

## Purpose

Add **heuristic** microstructure analytics and an extensibility surface **without** changing confirmation gates, A+ checklist, or Phase 8 weight locks.

## Modules

| Module | Role | Label |
|--------|------|-------|
| `icebergRefill.ts` | L2 size disappear/reappear at same price | `heuristic` + confidence band |
| `leaderLagger.ts` | Cross-section 24h % vs volume peers | `heuristic` (not tick lead-lag) |
| `strategyPlugins.ts` | `registerConfirmationPack` → weight-0 neutrals | never bumps LONG/SHORT |
| `commentary.ts` | Template narrative | `mutatesScores: false` always |

## Wiring

- `MarketHub.onBook` → `detectIcebergRefill` attached on `dom.iceberg`
- Leader/lagger refreshed ≤ every 30s from `listMarkets` (no extra WS streams)
- Snapshot field `microstructure` + signal `commentary`
- `GET /api/microstructure?symbol=`
- DOM panel chips + commentary disclaimer in UI

## Signal engine rules

- Iceberg → `addNeutral` only (`dom_iceberg_refill`)
- Plugins require `enableStrategyPlugins: true` (default **false**)
- Pack factors forced to `weight: 0` and non-`exchange_reported`
- Commentary never written into confidence / direction / confirmations

## Non-goals

- Claiming institutional / iceberg identity from the exchange  
- Multi-symbol live OF for true tick lead-lag  
- Unlocking Phase 8 weight edits  

## Related

- [PHASE10_HARDENING.md](./PHASE10_HARDENING.md)  
- `packages/orderflow/src/icebergRefill.ts`  
- `packages/orderflow/src/leaderLagger.ts`  
- `packages/orderflow/src/strategyPlugins.ts`  
- `packages/orderflow/src/commentary.ts`

# Phase 13 — Axia Quality Shadow (Actual vs Expected)

## Purpose

Add **observational** Axia-inspired order-flow quality tags to improve false-breakout measurement **without** changing confirmation gates, A+ checklist, signal weights, or Phase 8 fingerprint locks.

## Modules

| Module | Role | Label |
|--------|------|-------|
| `axiaQualityShadow.ts` | deltaEfficiency, breakQuality/hang, highLowFormation, absorptionPersistence | `heuristic` · `mutatesScores: false` |

## Features

| Tag | Meaning |
|-----|---------|
| `deltaEfficiency` | Price travel vs aggressor imbalance (low ⇒ absorb-like) |
| `breakQuality` | Break follow-through vs hang / multi-bar absorb risk |
| `hangDetected` / `hangBars` | Broken/retesting stuck near break with weak progress |
| `highLowFormation` | `exhaustion` \| `absorption` \| `v_reversal` \| `other` \| `unknown` |
| `absorptionPersistence` | Multi-bar absorb-like density |

## Wiring

- `MarketHub` keeps last 12 closed footprints in `footprintHistory`
- `recomputeMicrostructure` + `recomputeSignal` compute `axiaQuality`
- Snapshot: `microstructure.axiaQuality`
- Commentary includes `formatAxiaQualitySummary` (template only)
- Paper open freezes `ofSnapshot.axiaQuality`
- `tagPaperRegimes` may append: `break_q_high/low`, `delta_eff_high/low`, `break_hang`, `hl_exhaustion`, `hl_absorption`, `hl_v_reversal`

## Signal engine rules

- **Never** written into `longScore` / `shortScore` / direction / confidence / A+
- **Does not** bump `SIGNAL_ENGINE_VERSION` or config fingerprint (observational only)
- Not a WAIT veto (future R5 requires separate approval + claimable strata)

## Non-goals

- Claiming institutional identity  
- Auto-live trading  
- Weight retunes from these tags  
- Treating shadow scores as calibrated win probability  

## Related

- [AXIA_FOOTPRINT_PLAYLIST_INTEGRATION.md](./AXIA_FOOTPRINT_PLAYLIST_INTEGRATION.md)  
- [PHASE11_MICROSTRUCTURE.md](./PHASE11_MICROSTRUCTURE.md)  
- [PHASE8_ACCURACY.md](./PHASE8_ACCURACY.md)  
- `packages/orderflow/src/axiaQualityShadow.ts`

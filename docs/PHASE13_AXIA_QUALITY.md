# Phase 13 — Axia Quality Shadow (Actual vs Expected)

## Purpose

Add **observational** Axia-inspired order-flow quality tags to improve false-breakout measurement **without** changing confirmation gates, A+ checklist, signal weights, or Phase 8 fingerprint locks.

## Decision (current)

**WAIT veto for `break_q_low` / `break_hang` is NOT enabled.**  
Measure first in PAPER. Only consider a flagged veto after claimable strata show those tags underperform.

| Step | Action | Status |
|------|--------|--------|
| 1 | Keep `EXECUTION_MODE=PAPER` until Phase 8 ≥100 resolved TP/SL | Required now |
| 2 | Compare `byAxiaQuality` / `axiaVetoReadiness` on validation report | Required now |
| 3 | Optional WAIT veto in `generateSignal` | **Deferred** — `vetoEnabledInEngine: false` |

## Modules

| Module | Role | Label |
|--------|------|-------|
| `axiaQualityShadow.ts` | deltaEfficiency, breakQuality/hang, highLowFormation, absorptionPersistence | `heuristic` · `mutatesScores: false` |
| `analytics.ts` → `groupByAxiaQuality` / `evaluateAxiaVetoReadiness` | Strata compare + readiness (never enables gates) | measurement |

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
- Validation report: `byAxiaQuality`, `axiaVetoReadiness`, `phase13Note`, `paperModeReminder`
- Health: `phase13MeasureFirst` reminder

## PAPER checklist (measure first)

1. `EXECUTION_MODE=PAPER` (default)
2. `VALIDATION_LOCK_CONFIG` on in PAPER (default)
3. Leave API streaming / focus rotation running
4. Open Signal Engine → Phase 8 + Strata (Axia chips)
5. Watch `gates.overallClaimable` and `axiaVetoReadiness.status`
6. Do **not** treat confidence as win rate
7. Do **not** go LIVE on thin samples

## Future veto unlock criteria (human review only)

All must be true before considering a flagged WAIT veto:

1. `gates.overallClaimable === true` (≥100 resolved)
2. `break_q_low` and/or `break_hang` stratum claimable (≥30 resolved each)
3. Weak-tag expectancy **worse** than overall (see `axiaVetoReadiness.notes`)
4. Explicit research unlock PR — default remains **OFF**
5. Still no institutional-identity claims

Until then: `axiaVetoReadiness.vetoEnabledInEngine === false` and `generateSignal` is unchanged.

## Signal engine rules

- **Never** written into `longScore` / `shortScore` / direction / confidence / A+
- **Does not** bump `SIGNAL_ENGINE_VERSION` or config fingerprint (observational only)
- Not a WAIT veto today

## Non-goals

- Claiming institutional identity  
- Auto-live trading  
- Weight retunes from these tags  
- Treating shadow scores as calibrated win probability  
- Auto-enabling WAIT veto from readiness status alone  

## Related

- [AXIA_FOOTPRINT_PLAYLIST_INTEGRATION.md](./AXIA_FOOTPRINT_PLAYLIST_INTEGRATION.md)  
- [PHASE11_MICROSTRUCTURE.md](./PHASE11_MICROSTRUCTURE.md)  
- [PHASE8_ACCURACY.md](./PHASE8_ACCURACY.md)  
- `packages/orderflow/src/axiaQualityShadow.ts`  
- `packages/orderflow/src/validation/analytics.ts`

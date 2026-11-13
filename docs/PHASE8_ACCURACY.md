# Phase 8 — Prove Accuracy (Measurement First)

## Purpose

Grow a **version-locked** forward paper sample and treat accuracy as **undefined** until sample gates pass.

This phase does **not** change `generateSignal` confirmation gates, indicator math, or signal weights.

## Freeze

| Item | Value |
|------|--------|
| Engine label | `0.16.0-rr-ui` (`SIGNAL_ENGINE_VERSION`) |
| Config fingerprint | `DEFAULT_CONFIG_VERSION` (SHA of default signal + lifecycle + costs) |
| Lock | `VALIDATION_LOCK_CONFIG` (defaults **on** when `EXECUTION_MODE=PAPER`) |
| Override API | `POST /api/validation/signal-config` → **403** while locked |

Primary Validation metrics filter to the active fingerprint only. Older rows remain visible under `performanceByConfigVersion`.

**Gate correctness (`0.15.0-gates`):** readiness (footprint+VP), opposing DOM iceberg veto, A+ OF requires `orderFlowOk` (session CVD no longer sets `deltaOk`), swing-proximity and room-to-run hard WAITs, and price-relative support/resistance. These are safety/correctness gates — not weight retunes. The active fingerprint sample restarts when this version ships.

**UI + structure R:R (`0.16.0-rr-ui`):** model-score labeling (not Strength/win%), commentary cites independent families; protective stops from swing/S/R; TP1/R:R from first opposing structure level; structure targets ignore sub-0.1% near-entry levels. Fingerprint sample restarts again.

## Sample gates

| Gate | Floor | Meaning |
|------|-------|---------|
| Overall claimable | **100** resolved HIT_TP+HIT_SL | Publish expectancy / PF claims |
| Regime / setup-class | **30** resolved each | Stratum “claimable” |
| Calibration sufficient | **40** resolved (existing) | Still not confidence → P(win) until bucket gaps reviewed |

Open / INVALIDATED / TIMEOUT / EXPIRED never count as wins or losses.

## Collection

1. `EXECUTION_MODE=PAPER`
2. Leave API streaming — `paper_trades` + `trade_tape` fill automatically
3. `FOCUS_ROTATION_MS` (default `900000` = 15m) rotates OF focus across `DEFAULT_SYMBOLS`
4. Only the **focused** symbol gets live OF / TP–SL updates; others wait until rotated back
5. UI: Signal Engine → **Phase 8 — Accuracy freeze**, or `GET /api/validation/report`

## Decision rule

- Until `gates.overallClaimable === true`: accuracy = **undefined**; **no** weight edits
- When gates pass: record results below (n, Wilson CI, expectancy net, regime table, calibration note), then proceed to Phase 9 (parity) — still no retune unless a later research phase opens under OOS rules

## Results (fill when claimable)

| Field | Value |
|-------|--------|
| Date | _pending_ |
| Active config | _from report.activeConfigVersion_ |
| Resolved n | _pending_ |
| Win rate + Wilson 95% CI | _pending_ |
| Expectancy (net) | _pending_ |
| Claimable regimes | _pending_ |
| Calibration sufficient | _pending_ |
| Notes | Sample still collecting — do not invent edge |

## Non-goals

- Full-OF historical replay / parity runner (Phase 9)
- Weight or gate optimization
- LIVE size increases from thin samples
- TP2/TP3 scale-out product work

## Related

- [PHASE7_VALIDATION.md](./PHASE7_VALIDATION.md) — measurement plumbing
- `packages/orderflow/src/validation/analytics.ts` — `evaluateAccuracyGates`
- `apps/api/src/validation/report.ts` — report + version split
